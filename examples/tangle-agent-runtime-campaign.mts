import { pathToFileURL } from 'node:url'
import { readFile } from 'node:fs/promises'
import {
  runAgentTaskStream,
  type AgentExecutionBackend,
  type RuntimeStreamEvent,
} from '@tangle-network/agent-runtime'
import {
  loadLedger,
  runCampaign,
  saveLedger,
  type Analysis,
  type BenchmarkTarget,
  type CampaignLedger,
  type CampaignResult,
  type SegmentReport,
  type Steering,
} from '../index'
import { createTangleRuntimeDriver } from './tangle-agent-runtime.mts'

/**
 * A long-horizon run driven by Tangle Agent Runtime.
 *
 * Two agent roles share one backend and one budget. The player decides one
 * game input per turn. The analyst reads a segment report between segments and
 * answers with JSON. A human can outrank the analyst by writing a steering
 * file. The ledger is saved after every segment, so a killed process resumes
 * the same verifiable run instead of starting a new one.
 */
export interface TangleRuntimeCampaignOptions<S> {
  target: BenchmarkTarget<S>
  backend: AgentExecutionBackend
  commands: readonly string[]
  budgetUsd: number
  maxTurns: number
  segmentTurns: number
  seed?: number
  /** Measured cost of one runtime task. Defaults to the reported model spend. */
  costUsd?: (events: readonly RuntimeStreamEvent[]) => number
  /** Ledger file. Loaded when it exists, saved after every segment. */
  ledgerPath?: string
  /** JSON file a human writes to steer or stop the run: {guidance?, stop?}. */
  steerPath?: string
  signal?: AbortSignal
}

export async function runCampaignWithTangleRuntime<S>(
  options: TangleRuntimeCampaignOptions<S>,
): Promise<CampaignResult> {
  const costUsd = options.costUsd ?? reportedCostUsd
  const driver = createTangleRuntimeDriver({
    backend: options.backend,
    commands: options.commands,
    costUsd,
  })
  const resumed = options.ledgerPath === undefined ? null : await readLedger(options.ledgerPath)

  return runCampaign(options.target.game, options.target.contract, driver, {
    budgetUsd: options.budgetUsd,
    maxTurns: options.maxTurns,
    segmentTurns: options.segmentTurns,
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    ...(resumed === null ? {} : { ledger: resumed }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    analyst: async (report) => analyzeSegment(report, options),
    steer: async () => readSteering(options.steerPath),
    onLedger: async (ledger) => {
      if (options.ledgerPath !== undefined) await saveLedger(options.ledgerPath, ledger)
    },
  })
}

/** One runtime task per segment. Its only job is to judge progress. */
async function analyzeSegment<S>(
  report: SegmentReport,
  options: TangleRuntimeCampaignOptions<S>,
): Promise<Analysis> {
  const prompt = renderSegmentPrompt(report, options.commands)
  let text = ''
  for await (const event of runAgentTaskStream({
    task: {
      id: `playproof-analysis-${report.segment}`,
      intent: prompt,
      domain: 'game-benchmark',
      metadata: {
        playproofSegment: report.segment,
        playproofTurns: report.turnsSoFar,
        remainingBudgetUsd: report.remainingBudgetUsd,
      },
    },
    backend: options.backend,
    input: { message: prompt },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })) {
    if (event.type === 'text_delta') text += event.text
    if (event.type === 'backend_error') throw new Error(event.message)
    if (event.type === 'final' && event.status !== 'completed') {
      throw new Error(`analyst task failed: ${event.reason}`)
    }
  }
  return parseAnalysis(text)
}

function renderSegmentPrompt(report: SegmentReport, commands: readonly string[]): string {
  const trajectory = report.recentHistory
    .map((entry) => `> ${entry.input}\n${entry.frame}`)
    .join('\n\n')
  return [
    'You supervise an agent playing a game under a measured budget.',
    `Valid game inputs: ${commands.join(', ')}.`,
    `Segment ${report.segment} ended at turn ${report.turnsSoFar}.`,
    `Spent so far: $${report.spentUsd.toFixed(6)}. Remaining: $${report.remainingBudgetUsd.toFixed(6)}.`,
    `Verified milestones: ${report.verifiedSoFar.join(', ') || 'none'}.`,
    `New this segment: ${report.newMilestones.map((row) => row.id).join(', ') || 'none'}.`,
    trajectory ? `Recent trajectory:\n${trajectory}` : '',
    `Current observation:\n${report.lastFrame}`,
    'Answer with one JSON object and no other text:',
    '{"summary": string, "recommendation": "continue" | "steer" | "stop", "guidance": string}',
    'Use "stop" only when more spending cannot produce more verified progress.',
  ].filter(Boolean).join('\n\n')
}

/**
 * Parse fail-closed. An analyst that cannot answer in the agreed format never
 * stops a paid run and never injects unreadable guidance into the next segment.
 */
export function parseAnalysis(text: string): Analysis {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return unparseable()
  let value: unknown
  try {
    value = JSON.parse(text.slice(start, end + 1)) as unknown
  } catch {
    return unparseable()
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return unparseable()
  const record = value as Record<string, unknown>
  const recommendation = record.recommendation
  if (recommendation !== 'continue' && recommendation !== 'steer' && recommendation !== 'stop') {
    return unparseable()
  }
  if (typeof record.summary !== 'string') return unparseable()
  const guidance = typeof record.guidance === 'string' && record.guidance.trim() !== ''
    ? record.guidance
    : undefined
  return {
    summary: record.summary,
    recommendation,
    ...(guidance === undefined ? {} : { guidance }),
  }
}

function unparseable(): Analysis {
  return { summary: 'analyst output unparseable', recommendation: 'continue' }
}

/**
 * Optional human override. When the file is absent the campaign keeps the
 * analyst's guidance, because explicit steering outranks analysis only when a
 * human actually wrote something.
 */
async function readSteering(path: string | undefined): Promise<Steering | null> {
  if (path === undefined) return null
  const text = await readOptionalFile(path)
  if (text === null) return null
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch (error) {
    throw new Error(`steering file ${path} is not JSON: ${(error as Error).message}`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`steering file ${path} must contain a JSON object`)
  }
  const record = value as Record<string, unknown>
  if (record.guidance !== undefined && typeof record.guidance !== 'string') {
    throw new Error(`steering file ${path}: guidance must be a string`)
  }
  if (record.stop !== undefined && typeof record.stop !== 'boolean') {
    throw new Error(`steering file ${path}: stop must be a boolean`)
  }
  return {
    source: `human:${path}`,
    ...(record.guidance === undefined ? {} : { guidance: record.guidance }),
    ...(record.stop === undefined ? {} : { stop: record.stop }),
  }
}

async function readLedger(path: string): Promise<CampaignLedger | null> {
  try {
    return await loadLedger(path)
  } catch (error) {
    if (isMissingFile(error)) return null
    throw error
  }
}

async function readOptionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (isMissingFile(error)) return null
    throw error
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && (error as { code?: string }).code === 'ENOENT'
}

/**
 * Measured spend reported by the runtime. Cost that the provider never
 * reported is an error, not a silent zero.
 */
function reportedCostUsd(events: readonly RuntimeStreamEvent[]): number {
  let total = 0
  let known = false
  for (const event of events) {
    if (event.type !== 'llm_call') continue
    if (event.usdKnown === false || typeof event.costUsd !== 'number') continue
    total += event.costUsd
    known = true
  }
  if (!known) {
    throw new Error('runtime reported no known cost; supply costUsd for this backend')
  }
  return total
}

/**
 * Runnable wiring. Point PLAYPROOF_BACKEND_MODULE at a module that exports
 * `createBackend(): AgentExecutionBackend` and `createTarget(): BenchmarkTarget`.
 */
async function main(): Promise<void> {
  const specifier = process.env.PLAYPROOF_BACKEND_MODULE
  if (specifier === undefined) {
    throw new Error('set PLAYPROOF_BACKEND_MODULE to a module exporting createBackend and createTarget')
  }
  const module = await import(specifier) as {
    createBackend?: () => AgentExecutionBackend
    createTarget?: () => BenchmarkTarget<unknown>
  }
  if (typeof module.createBackend !== 'function' || typeof module.createTarget !== 'function') {
    throw new Error(`${specifier} must export createBackend() and createTarget()`)
  }
  const target = module.createTarget()
  try {
    const { record, ledger } = await runCampaignWithTangleRuntime({
      target,
      backend: module.createBackend(),
      commands: target.reference.length > 0 ? [...new Set(target.reference)] : ['noop'],
      budgetUsd: Number(process.env.PLAYPROOF_BUDGET_USD ?? '1'),
      maxTurns: Number(process.env.PLAYPROOF_MAX_TURNS ?? '200'),
      segmentTurns: Number(process.env.PLAYPROOF_SEGMENT_TURNS ?? '25'),
      ...(process.env.PLAYPROOF_LEDGER === undefined ? {} : { ledgerPath: process.env.PLAYPROOF_LEDGER }),
      ...(process.env.PLAYPROOF_STEER_FILE === undefined
        ? {}
        : { steerPath: process.env.PLAYPROOF_STEER_FILE }),
    })
    console.log(JSON.stringify({
      turns: record.turns,
      spentUsd: record.spentUsd,
      verified: record.verified,
      verdict: record.verdict,
      segments: ledger.segments.length,
    }, null, 2))
  } finally {
    target.dispose?.()
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
