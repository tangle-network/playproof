import { spawn } from 'node:child_process'
import type {
  AgentDecisionContext,
  AgentDriver,
  AgentHistoryEntry,
} from '../episode'

export interface CliAgentRequest {
  schemaVersion: 1
  frame: string
  history: readonly AgentHistoryEntry[]
  /** JSON-safe decision context; cancellation remains process-local. */
  context: Readonly<Omit<AgentDecisionContext, 'signal'>>
}

export interface CliAgentRun {
  request: CliAgentRequest
  stdout: string
  stderr: string
  durationMs: number
}

export interface CliAgentDriverOptions {
  command: string
  args?: readonly string[] | ((request: CliAgentRequest) => readonly string[])
  cwd?: string
  env?: Readonly<Record<string, string>>
  /** `json` is a stable language-neutral stdin protocol. */
  stdin?: 'json' | 'prompt' | 'none'
  /** `json` expects {input,costUsd?}; `first-word` accepts a plain CLI response. */
  output?: 'json' | 'first-word'
  commands?: readonly string[]
  prompt?: (request: CliAgentRequest) => string
  /** Explicitly set 0 only for genuinely free execution. */
  fixedCostUsd?: number
  /** Derive actual cost from the completed process. */
  costUsd?: (run: CliAgentRun) => number
  timeoutMs?: number
  maxOutputBytes?: number
}

/**
 * Run any local coding harness, model CLI, or custom executable as an agent.
 *
 * The process is spawned without a shell. Arguments, stdin, stdout, stderr,
 * wall time, and output bytes are bounded by the caller's explicit contract.
 * Cost must come from JSON output, `costUsd`, or `fixedCostUsd`; unavailable
 * cost is an error rather than a fabricated zero.
 */
export function createCliAgentDriver(options: CliAgentDriverOptions): AgentDriver {
  validateCommand(options.command, options.args)
  const timeoutMs = options.timeoutMs ?? 120_000
  const maxOutputBytes = options.maxOutputBytes ?? (2 << 20)
  const outputMode = options.output ?? 'json'
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('CLI timeoutMs must be positive')
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new Error('CLI maxOutputBytes must be a positive integer')
  }
  if (options.fixedCostUsd !== undefined
    && (!Number.isFinite(options.fixedCostUsd) || options.fixedCostUsd < 0)) {
    throw new Error('CLI fixedCostUsd must be non-negative')
  }
  if (outputMode === 'first-word'
    && options.costUsd === undefined
    && options.fixedCostUsd === undefined) {
    throw new Error('CLI first-word output requires costUsd or fixedCostUsd')
  }

  return {
    act: async (frame, history, context) => {
      const request: CliAgentRequest = {
        schemaVersion: 1,
        frame,
        history: history.map((entry) => ({ ...entry })),
        context: {
          turn: context.turn,
          maxTurns: context.maxTurns,
          seed: context.seed,
          spentUsd: context.spentUsd,
          remainingBudgetUsd: context.remainingBudgetUsd,
          ...(context.guidance === undefined ? {} : { guidance: context.guidance }),
        },
      }
      const rawArgs = typeof options.args === 'function' ? options.args(request) : (options.args ?? [])
      const args = [...rawArgs]
      validateCommand(options.command, args)
      const stdinMode = options.stdin ?? 'json'
      const stdin = stdinMode === 'none'
        ? undefined
        : stdinMode === 'prompt'
          ? (options.prompt ?? defaultPrompt)(request, options.commands)
          : `${JSON.stringify(request)}\n`
      const started = Date.now()
      const result = await runBoundedProcess({
        command: options.command,
        args,
        cwd: options.cwd,
        env: options.env,
        stdin,
        timeoutMs,
        maxOutputBytes,
        signal: context.signal,
      })
      const run: CliAgentRun = {
        request,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: Date.now() - started,
      }

      let input: string
      let reportedCost: number | undefined
      if (outputMode === 'json') {
        let value: unknown
        try {
          value = JSON.parse(result.stdout.trim()) as unknown
        } catch (error) {
          throw new Error(`CLI agent returned invalid JSON: ${(error as Error).message}`)
        }
        if (!isRecord(value) || typeof value.input !== 'string') {
          throw new Error('CLI agent JSON must contain a string input')
        }
        input = value.input
        if (value.costUsd !== undefined) reportedCost = Number(value.costUsd)
      } else {
        input = result.stdout.trim().split(/\s+/u)[0] ?? ''
      }

      input = normalizeInput(input, options.commands)
      const costUsd = options.costUsd?.(run) ?? reportedCost ?? options.fixedCostUsd
      if (costUsd === undefined) {
        throw new Error('CLI agent cost is unavailable; report costUsd or configure explicit pricing')
      }
      if (!Number.isFinite(costUsd) || costUsd < 0) throw new Error('CLI agent returned invalid costUsd')
      return { input, costUsd }
    },
  }
}

export function renderCliAgentPrompt(
  request: CliAgentRequest,
  commands?: readonly string[],
): string {
  const prior = request.history
    .slice(-8)
    .map((entry) => `> ${entry.input}\n${entry.frame}`)
    .join('\n\n')
  const vocabulary = commands && commands.length > 0
    ? `Valid inputs: ${commands.join(', ')}.\n`
    : ''
  const guidance = request.context.guidance
  return [
    'You are controlling a game for an agent evaluation.',
    vocabulary.trimEnd(),
    `Decision ${request.context.turn} of ${request.context.maxTurns}.`,
    `Remaining measured budget: $${request.context.remainingBudgetUsd.toFixed(6)}.`,
    guidance ? `Supervisor guidance:\n${guidance}` : '',
    prior ? `Recent trajectory:\n${prior}` : '',
    `Current observation:\n${request.frame}`,
    'Return exactly one game input and no explanation.',
  ].filter(Boolean).join('\n\n')
}

function defaultPrompt(request: CliAgentRequest, commands?: readonly string[]): string {
  return renderCliAgentPrompt(request, commands)
}

function normalizeInput(input: string, commands?: readonly string[]): string {
  const normalized = input.trim()
  if (!normalized || /[\0\r\n]/u.test(normalized)) return 'noop'
  if (commands && commands.length > 0 && !commands.includes(normalized)) return 'noop'
  return normalized
}

function validateCommand(
  command: string,
  args: readonly string[] | ((request: CliAgentRequest) => readonly string[]) | undefined,
): void {
  if (!command.trim() || command.includes('\0')) throw new Error('CLI command is invalid')
  if (typeof args === 'function') return
  for (const arg of args ?? []) {
    if (arg.includes('\0')) throw new Error('CLI argument contains NUL')
  }
}

function runBoundedProcess(options: {
  command: string
  args: readonly string[]
  cwd: string | undefined
  env: Readonly<Record<string, string>> | undefined
  stdin: string | undefined
  timeoutMs: number
  maxOutputBytes: number
  signal: AbortSignal | undefined
}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, [...options.args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: { ...process.env, ...(options.env ?? {}) },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false

    const cleanup = (): void => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      child.kill('SIGKILL')
      reject(error)
    }
    const append = (target: Buffer[], chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
      if (stream === 'stdout') stdoutBytes += chunk.byteLength
      else stderrBytes += chunk.byteLength
      if (stdoutBytes + stderrBytes > options.maxOutputBytes) {
        fail(new Error(`CLI output exceeded ${options.maxOutputBytes} bytes`))
        return
      }
      target.push(chunk)
    }
    const abort = (): void => fail(new Error('CLI agent aborted'))
    const timer = setTimeout(
      () => fail(new Error(`CLI agent exceeded ${options.timeoutMs}ms`)),
      options.timeoutMs,
    )

    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) {
      abort()
      return
    }

    child.stdout.on('data', (chunk: Buffer) => append(stdout, chunk, 'stdout'))
    child.stderr.on('data', (chunk: Buffer) => append(stderr, chunk, 'stderr'))
    child.once('error', (error) => fail(error))
    child.once('close', (code, signal) => {
      if (settled) return
      settled = true
      cleanup()
      const out = Buffer.concat(stdout).toString('utf8')
      const err = Buffer.concat(stderr).toString('utf8')
      if (code !== 0) {
        reject(new Error(`CLI agent exited ${code ?? signal ?? 'unknown'}: ${err.slice(-500)}`))
        return
      }
      resolve({ stdout: out, stderr: err })
    })

    child.stdin.once('error', (error) => fail(error))
    child.stdin.end(options.stdin)
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
