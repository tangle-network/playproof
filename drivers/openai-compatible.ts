import type {
  AgentDecisionContext,
  AgentDriver,
  AgentHistoryEntry,
} from '../episode'
import type { ObservationImage } from '../runtime'

export interface OpenAICompatibleTokenPricing {
  inputPerMillionUsd: number
  outputPerMillionUsd: number
  cachedInputPerMillionUsd?: number
}

export interface OpenAICompatibleDriverOptions {
  model: string
  apiKey?: string
  baseUrl?: string
  headers?: Readonly<Record<string, string>>
  fetch?: typeof globalThis.fetch
  commands?: readonly string[]
  systemPrompt?: string
  historyLimit?: number
  maxTokens?: number
  temperature?: number
  timeoutMs?: number
  maxResponseBytes?: number
  extraBody?: Readonly<Record<string, unknown>>
  parseInput?: (content: string) => string
  pricing?: OpenAICompatibleTokenPricing
  /**
   * Send the observation's images as content parts.
   *
   * Off by default. Images are billed as tokens, often several hundred per
   * frame per turn, so an existing caller must opt in before its bill changes.
   * With it on, a turn whose observation has no images sends the same plain
   * string request it sends today.
   */
  vision?: boolean
  /** OpenAI `image_url.detail`. Left unset unless the caller names one. */
  imageDetail?: 'auto' | 'low' | 'high'
}

type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } }

interface ChatMessage {
  role: 'system' | 'user'
  content: string | ChatContentPart[]
}

/**
 * Create a driver for OpenAI Chat Completions-compatible endpoints.
 *
 * This works with OpenAI, local servers, routing gateways, and any service that
 * implements `POST /chat/completions`. Authentication, URL, model, pricing,
 * extra request fields, and response parsing are all caller-owned.
 */
export function createOpenAICompatibleDriver(
  options: OpenAICompatibleDriverOptions,
): AgentDriver {
  if (!options.model.trim()) throw new Error('OpenAI-compatible model is required')
  const baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/u, '')
  const timeoutMs = options.timeoutMs ?? 120_000
  const maxResponseBytes = options.maxResponseBytes ?? (2 << 20)
  const historyLimit = options.historyLimit ?? 8
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be positive')
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new Error('maxResponseBytes must be a positive integer')
  }
  if (!Number.isInteger(historyLimit) || historyLimit < 0) {
    throw new Error('historyLimit must be a non-negative integer')
  }
  validatePricing(options.pricing)

  return {
    act: async (frame, history, context) => {
      const fetchImpl = options.fetch ?? globalThis.fetch
      if (!fetchImpl) throw new Error('global fetch is unavailable')
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), timeoutMs)
      const relayAbort = (): void => controller.abort(context.signal?.reason)
      context.signal?.addEventListener('abort', relayAbort, { once: true })
      try {
        const messages = buildMessages(frame, history, context, options)
        const body: Record<string, unknown> = {
          ...(options.extraBody ?? {}),
          model: options.model,
          messages,
          ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
          ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
        }
        const headers: Record<string, string> = {
          'content-type': 'application/json',
          ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
          ...(options.headers ?? {}),
        }
        const response = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        })
        const text = await readResponseTextBounded(response, maxResponseBytes)
        if (!response.ok) throw new Error(`OpenAI-compatible HTTP ${response.status}: ${text.slice(0, 500)}`)

        let parsed: unknown
        try {
          parsed = JSON.parse(text) as unknown
        } catch (error) {
          throw new Error(`OpenAI-compatible response was not JSON: ${(error as Error).message}`)
        }
        const root = asRecord(parsed, 'OpenAI-compatible response')
        const content = responseContent(root)
        const rawInput = options.parseInput?.(content) ?? content.trim().split(/\s+/u)[0] ?? ''
        const input = normalizeInput(rawInput, options.commands)
        const costUsd = responseCost(root, options.pricing)
        return { input, costUsd }
      } finally {
        clearTimeout(timeout)
        context.signal?.removeEventListener('abort', relayAbort)
      }
    },
  }
}

function buildMessages(
  frame: string,
  history: readonly AgentHistoryEntry[],
  context: Readonly<AgentDecisionContext>,
  options: OpenAICompatibleDriverOptions,
): ChatMessage[] {
  const commandText = options.commands && options.commands.length > 0
    ? `Valid game inputs: ${options.commands.join(', ')}. `
    : ''
  const system = options.systemPrompt ?? [
    'You are an agent controlling a game through a benchmark harness.',
    commandText,
    'Return exactly one game input and no explanation.',
  ].join(' ').trim()
  const recent = history
    .slice(-Math.max(0, options.historyLimit ?? 8))
    .map((entry) => `> ${entry.input}\n${entry.frame}`)
    .join('\n\n')
  const user = [
    `Decision ${context.turn} of ${context.maxTurns}.`,
    `Remaining measured budget: $${context.remainingBudgetUsd.toFixed(6)}.`,
    context.guidance ? `Supervisor guidance:\n${context.guidance}` : '',
    recent ? `Recent trajectory:\n${recent}` : '',
    `Current observation:\n${frame}`,
    'Next input:',
  ].filter(Boolean).join('\n\n')
  const images = options.vision === true ? (context.observation?.images ?? []) : []
  return [
    { role: 'system', content: system },
    { role: 'user', content: images.length === 0 ? user : contentParts(user, images, options.imageDetail) },
  ]
}

/**
 * The OpenAI content-part shape for a text prompt plus rendered screens.
 *
 * Images follow the text so the model reads the task before the picture, and
 * each one is a self-contained data URL: nothing is fetched over the network
 * and no image outlives the request.
 */
function contentParts(
  text: string,
  images: readonly ObservationImage[],
  detail: 'auto' | 'low' | 'high' | undefined,
): ChatContentPart[] {
  const parts: ChatContentPart[] = [{ type: 'text', text }]
  for (const image of images) {
    if (image.label) parts.push({ type: 'text', text: image.label })
    parts.push({
      type: 'image_url',
      image_url: {
        url: `data:${image.mediaType};base64,${image.base64}`,
        ...(detail === undefined ? {} : { detail }),
      },
    })
  }
  return parts
}

async function readResponseTextBounded(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declared = response.headers.get('content-length')
  if (declared !== null) {
    const bytes = Number(declared)
    if (Number.isFinite(bytes) && bytes > maxBytes) {
      throw new Error(`OpenAI-compatible response exceeded ${maxBytes} bytes`)
    }
  }
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      bytes += value.byteLength
      if (bytes > maxBytes) {
        await reader.cancel(`response exceeded ${maxBytes} bytes`)
        throw new Error(`OpenAI-compatible response exceeded ${maxBytes} bytes`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const all = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    all.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(all)
}

function responseContent(root: Record<string, unknown>): string {
  const choices = root.choices
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error('OpenAI-compatible response has no choices')
  }
  const choice = asRecord(choices[0], 'OpenAI-compatible choice')
  const message = asRecord(choice.message, 'OpenAI-compatible message')
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = content.flatMap((part) => {
      if (!isRecord(part)) return []
      return typeof part.text === 'string' ? [part.text] : []
    })
    if (parts.length > 0) return parts.join('')
  }
  throw new Error('OpenAI-compatible response message has no text content')
}

function responseCost(
  root: Record<string, unknown>,
  pricing?: OpenAICompatibleTokenPricing,
): number {
  const usage = isRecord(root.usage) ? root.usage : {}
  for (const candidate of [root.costUsd, root.cost, usage.costUsd, usage.cost_usd, usage.cost]) {
    const value = Number(candidate)
    if (Number.isFinite(value) && value >= 0) return value
  }
  if (!pricing) return 0
  const promptTokens = finiteNonNegative(usage.prompt_tokens)
  const completionTokens = finiteNonNegative(usage.completion_tokens)
  const details = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {}
  const cachedTokens = Math.min(promptTokens, finiteNonNegative(details.cached_tokens))
  const uncachedTokens = Math.max(0, promptTokens - cachedTokens)
  const input = (uncachedTokens / 1_000_000) * pricing.inputPerMillionUsd
  const cached = (cachedTokens / 1_000_000) * (pricing.cachedInputPerMillionUsd ?? pricing.inputPerMillionUsd)
  const output = (completionTokens / 1_000_000) * pricing.outputPerMillionUsd
  return input + cached + output
}

function normalizeInput(input: string, commands?: readonly string[]): string {
  const normalized = input.trim()
  if (!normalized || /[\0\r\n]/u.test(normalized)) return 'noop'
  if (commands && commands.length > 0 && !commands.includes(normalized)) return 'noop'
  return normalized
}

function validatePricing(pricing: OpenAICompatibleTokenPricing | undefined): void {
  if (!pricing) return
  for (const [key, value] of Object.entries(pricing)) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`pricing.${key} must be non-negative`)
  }
}

function finiteNonNegative(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : 0
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
