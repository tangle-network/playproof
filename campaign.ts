/**
 * Long-horizon campaigns: one verifiable run played in segments.
 *
 * A campaign is not a new trust surface. It is the ordinary episode loop,
 * stopped at segment boundaries so a supervisor, an analyst, or a human can
 * read progress and leave a note before the next segment starts. The run stays
 * one hash-chained input log over one seed, so the verifier still recomputes
 * every milestone by replay.
 *
 * Resume is replay: the ledger holds the inputs, the process that resumes
 * replays them from the seed, and the campaign continues from the rebuilt
 * state. Steering is out-of-band context (`AgentDecisionContext.guidance`);
 * it never enters the input log and never grants progress.
 */
import { randomUUID } from 'node:crypto'
import { rename, rm, writeFile, readFile } from 'node:fs/promises'
import {
  advanceRollout,
  applyInput,
  finalizeRecord,
  round4,
  startRollout,
  type Rollout,
} from './episode-loop'
import type {
  AgentDriver,
  AgentHistoryEntry,
  EpisodeRecord,
  MilestoneCostRow,
} from './episode'
import { observationTextOf, type Game, type InputLog } from './runtime'
import { contractHash, scoreMilestones, type MilestoneContract, type MilestoneScore } from './schema'

/**
 * Trajectory entries kept in memory during a campaign.
 *
 * The bound is applied identically to live segments and to replayed prefixes,
 * so a resumed campaign shows a driver exactly the entries a continuous run
 * would have shown it.
 */
const CAMPAIGN_HISTORY_LIMIT = 64

/** Recent trajectory entries put in a segment report. */
const REPORT_HISTORY_LIMIT = 8

export type CampaignStop =
  | 'segmentLimit'
  | 'maxTurns'
  | 'budget'
  | 'steering'
  | 'analyst'
  | 'abort'

export type AnalysisRecommendation = 'continue' | 'steer' | 'stop'

export interface CampaignDecision {
  turn: number
  input: string
  costUsd: number
  latencyMs: number
  segment: number
}

export interface CampaignSegment {
  index: number
  startTurn: number
  endTurn: number
  spentUsd: number
  stoppedBy: CampaignStop
  /** Guidance in effect while the segment ran; null when there was none. */
  guidance: string | null
}

export interface CampaignSteering {
  afterSegment: number
  source: string
  guidance?: string
  stop?: boolean
  note?: string
}

export interface CampaignAnalysis {
  afterSegment: number
  summary: string
  recommendation: AnalysisRecommendation
  guidance?: string
  progressScore?: number
}

/**
 * The complete resumable state of a campaign.
 *
 * It is plain JSON: save it anywhere, load it in another process, and pass it
 * back to `runCampaign` to continue the same verifiable run.
 */
export interface CampaignLedger {
  schemaVersion: 1
  gameId: string
  seed: number
  contractHash: string
  budgetUsd: number
  maxTurns: number
  segmentTurns: number
  inputs: string[]
  decisions: CampaignDecision[]
  segments: CampaignSegment[]
  steering: CampaignSteering[]
  analyses: CampaignAnalysis[]
  spentUsd: number
  verified: string[]
  milestones: MilestoneCostRow[]
  updatedAt: string
}

/** What an analyst or a human sees between two segments. */
export interface SegmentReport {
  segment: number
  turnsSoFar: number
  spentUsd: number
  remainingBudgetUsd: number
  newMilestones: MilestoneCostRow[]
  /** Milestones the live tracker observed so far, in observation order. */
  verifiedSoFar: string[]
  /**
   * Progress so far with the earnable denominator separated from the total, so
   * an analyst reads "3 of 4 earnable" instead of "3 of 6".
   */
  scoreSoFar: MilestoneScore
  lastFrame: string
  recentHistory: AgentHistoryEntry[]
  /** Decision latencies of this segment only. */
  latencyMs: number[]
  /**
   * Validated snapshot of the ledger as of this segment. It is a copy, so an
   * analyst can hold it, serialize it, or fail on it without touching the run.
   */
  ledger: Readonly<CampaignLedger>
}

export interface Analysis {
  summary: string
  recommendation: AnalysisRecommendation
  guidance?: string
  progressScore?: number
}

export interface Steering {
  guidance?: string
  stop?: boolean
  note?: string
  source?: string
}

export interface CampaignOptions {
  budgetUsd: number
  maxTurns: number
  /** Decisions per segment. The campaign pauses for the hooks after each one. */
  segmentTurns: number
  seed?: number
  /** Ledger of an earlier campaign to continue. */
  ledger?: CampaignLedger
  analyst?: (report: SegmentReport) => Promise<Analysis | null>
  steer?: (report: SegmentReport, analysis: Analysis | null) => Promise<Steering | null>
  /** Persistence hook. Save the ledger here so a killed process can resume. */
  onLedger?: (ledger: CampaignLedger) => void | Promise<void>
  signal?: AbortSignal
}

export interface CampaignResult {
  record: EpisodeRecord
  ledger: CampaignLedger
  log: InputLog
}

/**
 * Run one campaign, fresh or resumed, and return the whole-run record.
 *
 * The record covers the complete campaign, not the last segment: turns,
 * spend, verified milestones, and replay divergence are computed over the
 * full input log by the same attestation path a single episode uses.
 */
export async function runCampaign<S>(
  game: Game<S>,
  contract: MilestoneContract,
  driver: AgentDriver,
  options: CampaignOptions,
): Promise<CampaignResult> {
  const { budgetUsd, maxTurns, segmentTurns } = options
  if (!Number.isFinite(budgetUsd) || budgetUsd < 0) throw new Error('budgetUsd must be non-negative')
  if (!Number.isInteger(maxTurns) || maxTurns < 0) throw new Error('maxTurns must be a non-negative integer')
  if (!Number.isInteger(segmentTurns) || segmentTurns < 1) {
    throw new Error('segmentTurns must be an integer of at least 1')
  }
  if (options.seed !== undefined && !Number.isFinite(options.seed)) throw new Error('seed must be finite')

  const started = Date.now()
  const hash = contractHash(contract)
  const prior = options.ledger === undefined ? null : parseCampaignLedger(options.ledger)
  if (prior !== null) assertResumable(prior, game, hash, options)
  const seed = prior?.seed ?? options.seed ?? 0
  const ledger = prior ?? freshLedger(game.id, seed, hash, budgetUsd, maxTurns, segmentTurns)
  ledger.segmentTurns = segmentTurns

  const rollout = startRollout(game, contract, seed, CAMPAIGN_HISTORY_LIMIT)
  if (prior !== null) {
    for (const decision of prior.decisions) {
      applyInput(game, rollout, decision.input, decision.costUsd, decision.latencyMs)
    }
  }

  let guidance = resumeGuidance(ledger)
  let stopped = false
  while (!stopped && rollout.turns < maxTurns && rollout.spent < budgetUsd) {
    options.signal?.throwIfAborted()
    const segment = ledger.segments.length
    const startTurn = rollout.turns + 1
    const guidanceInEffect = guidance
    const decisionsBefore = rollout.turns
    const spentBefore = rollout.spent
    const milestonesBefore = rollout.milestones.length
    const latencyBefore = rollout.latencyMs.length

    let stoppedBy: CampaignStop
    let abortError: unknown
    try {
      stoppedBy = await advanceRollout(game, driver, rollout, seed, {
        budgetUsd,
        maxTurns,
        maxDecisions: segmentTurns,
        ...(guidance === undefined ? {} : { guidance }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    } catch (error) {
      if (options.signal?.aborted !== true) throw error
      stoppedBy = 'abort'
      abortError = error
    }

    for (let turn = decisionsBefore; turn < rollout.turns; turn++) {
      ledger.decisions.push({
        turn: turn + 1,
        input: rollout.log.inputs()[turn]!,
        costUsd: rollout.costUsd[turn]!,
        latencyMs: rollout.latencyMs[turn]!,
        segment,
      })
    }
    // The segment is recorded before the hooks run, so the report they read is
    // a complete ledger. A hook may still refine why the segment stopped.
    const played = rollout.turns > decisionsBefore
    const segmentRecord: CampaignSegment = {
      index: segment,
      startTurn,
      endTurn: rollout.turns,
      spentUsd: round4(rollout.spent - spentBefore),
      stoppedBy,
      guidance: guidanceInEffect ?? null,
    }
    if (played) ledger.segments.push(segmentRecord)
    syncLedger(ledger, rollout)

    try {
      if (stoppedBy !== 'abort') {
        const report: SegmentReport = {
          segment,
          turnsSoFar: rollout.turns,
          spentUsd: round4(rollout.spent),
          remainingBudgetUsd: Math.max(0, budgetUsd - rollout.spent),
          newMilestones: rollout.milestones.slice(milestonesBefore),
          verifiedSoFar: rollout.tracker.verified(),
          scoreSoFar: scoreMilestones(contract, rollout.tracker.verified()),
          // The segment report is a text ledger read by an analyst and written
          // to disk, so it carries the observation text and never its pixels.
          lastFrame: observationTextOf(game, rollout.state),
          recentHistory: rollout.history.slice(-REPORT_HISTORY_LIMIT).map((entry) => ({ ...entry })),
          latencyMs: rollout.latencyMs.slice(latencyBefore),
          // Re-validating every segment keeps ledger integrity a live
          // invariant instead of a load-time check.
          ledger: parseCampaignLedger(ledger),
        }
        const analysis = options.analyst === undefined
          ? null
          : validateAnalysis(await options.analyst(report))
        if (analysis !== null) {
          ledger.analyses.push({
            afterSegment: segment,
            summary: analysis.summary,
            recommendation: analysis.recommendation,
            ...(analysis.guidance === undefined ? {} : { guidance: analysis.guidance }),
            ...(analysis.progressScore === undefined ? {} : { progressScore: analysis.progressScore }),
          })
        }
        const steering = options.steer === undefined
          ? null
          : validateSteering(await options.steer(report, analysis))
        if (steering !== null) {
          ledger.steering.push({
            afterSegment: segment,
            source: steering.source ?? 'steer',
            ...(steering.guidance === undefined ? {} : { guidance: steering.guidance }),
            ...(steering.stop === undefined ? {} : { stop: steering.stop }),
            ...(steering.note === undefined ? {} : { note: steering.note }),
          })
        }
        // Explicit steering outranks the analyst; a stop from either ends the run.
        guidance = nextGuidance(guidance, steering, analysis)
        stopped = steering?.stop === true || analysis?.recommendation === 'stop'
        // A hard limit that already ended the segment keeps its own reason.
        if (stopped && stoppedBy === 'segmentLimit') {
          stoppedBy = steering?.stop === true ? 'steering' : 'analyst'
          segmentRecord.stoppedBy = stoppedBy
        }
      }
    } finally {
      ledger.updatedAt = new Date().toISOString()
      await options.onLedger?.(ledger)
    }
    if (abortError !== undefined) throw abortError
  }

  const record = finalizeRecord(game, contract, seed, rollout, budgetUsd, started)
  syncLedger(ledger, rollout)
  // Replay-verified progress supersedes the live tracker once the run is over.
  ledger.verified = [...record.verified]
  ledger.updatedAt = new Date().toISOString()
  await options.onLedger?.(ledger)
  return { record, ledger, log: rollout.log }
}

/** Write a ledger through a temporary file so a crash cannot truncate it. */
export async function saveLedger(path: string, ledger: CampaignLedger): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(parseCampaignLedger(ledger), null, 2)}\n`, 'utf8')
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

/** Read a ledger and validate it. An unreadable or malformed ledger throws. */
export async function loadLedger(path: string): Promise<CampaignLedger> {
  const text = await readFile(path, 'utf8')
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch (error) {
    throw new Error(`campaign ledger at ${path} is not JSON: ${(error as Error).message}`)
  }
  return parseCampaignLedger(value)
}

function freshLedger(
  gameId: string,
  seed: number,
  hash: string,
  budgetUsd: number,
  maxTurns: number,
  segmentTurns: number,
): CampaignLedger {
  return {
    schemaVersion: 1,
    gameId,
    seed,
    contractHash: hash,
    budgetUsd,
    maxTurns,
    segmentTurns,
    inputs: [],
    decisions: [],
    segments: [],
    steering: [],
    analyses: [],
    spentUsd: 0,
    verified: [],
    milestones: [],
    updatedAt: new Date().toISOString(),
  }
}

function assertResumable<S>(
  ledger: CampaignLedger,
  game: Game<S>,
  hash: string,
  options: CampaignOptions,
): void {
  if (ledger.gameId !== game.id) {
    throw new Error(`campaign ledger is for game ${ledger.gameId}, not ${game.id}`)
  }
  if (ledger.contractHash !== hash) {
    throw new Error(
      `campaign ledger pins contract ${ledger.contractHash.slice(0, 12)}, verifier computed ${hash.slice(0, 12)}`,
    )
  }
  if (options.seed !== undefined && options.seed !== ledger.seed) {
    throw new Error(`campaign ledger seed ${ledger.seed} does not match requested seed ${options.seed}`)
  }
  if (ledger.budgetUsd !== options.budgetUsd) {
    throw new Error(`campaign ledger budget ${ledger.budgetUsd} does not match requested budget ${options.budgetUsd}`)
  }
  if (ledger.maxTurns !== options.maxTurns) {
    throw new Error(`campaign ledger maxTurns ${ledger.maxTurns} does not match requested maxTurns ${options.maxTurns}`)
  }
}

function syncLedger<S>(ledger: CampaignLedger, rollout: Rollout<S>): void {
  ledger.inputs = [...rollout.log.inputs()]
  ledger.spentUsd = round4(rollout.spent)
  ledger.verified = rollout.tracker.verified()
  ledger.milestones = [...rollout.milestones]
}

function nextGuidance(
  current: string | undefined,
  steering: Steering | null,
  analysis: Analysis | null,
): string | undefined {
  const supplied = steering?.guidance ?? analysis?.guidance
  if (supplied === undefined) return current
  return supplied.trim() === '' ? undefined : supplied
}

function lastGuidanceAfter(ledger: CampaignLedger, segment: number): string | undefined {
  for (let i = ledger.steering.length - 1; i >= 0; i--) {
    const entry = ledger.steering[i]!
    if (entry.afterSegment === segment && entry.guidance !== undefined) return entry.guidance
  }
  for (let i = ledger.analyses.length - 1; i >= 0; i--) {
    const entry = ledger.analyses[i]!
    if (entry.afterSegment === segment && entry.guidance !== undefined) return entry.guidance
  }
  return undefined
}

/** Note a resumed campaign carries into its next segment. */
function resumeGuidance(ledger: CampaignLedger): string | undefined {
  const last = ledger.segments.length - 1
  if (last < 0) return undefined
  const supplied = lastGuidanceAfter(ledger, last)
  if (supplied !== undefined) return supplied.trim() === '' ? undefined : supplied
  return ledger.segments[last]?.guidance ?? undefined
}

function validateAnalysis(analysis: Analysis | null | undefined): Analysis | null {
  if (analysis === null || analysis === undefined) return null
  if (typeof analysis.summary !== 'string') throw new Error('analysis summary must be a string')
  if (!isRecommendation(analysis.recommendation)) {
    throw new Error(`analysis recommendation must be continue, steer, or stop; got ${String(analysis.recommendation)}`)
  }
  if (analysis.guidance !== undefined && typeof analysis.guidance !== 'string') {
    throw new Error('analysis guidance must be a string')
  }
  if (analysis.progressScore !== undefined && !Number.isFinite(analysis.progressScore)) {
    throw new Error('analysis progressScore must be finite')
  }
  return analysis
}

function validateSteering(steering: Steering | null | undefined): Steering | null {
  if (steering === null || steering === undefined) return null
  if (steering.guidance !== undefined && typeof steering.guidance !== 'string') {
    throw new Error('steering guidance must be a string')
  }
  if (steering.stop !== undefined && typeof steering.stop !== 'boolean') {
    throw new Error('steering stop must be a boolean')
  }
  if (steering.note !== undefined && typeof steering.note !== 'string') {
    throw new Error('steering note must be a string')
  }
  if (steering.source !== undefined && typeof steering.source !== 'string') {
    throw new Error('steering source must be a string')
  }
  return steering
}

function isRecommendation(value: unknown): value is AnalysisRecommendation {
  return value === 'continue' || value === 'steer' || value === 'stop'
}

function isStop(value: unknown): value is CampaignStop {
  return value === 'segmentLimit'
    || value === 'maxTurns'
    || value === 'budget'
    || value === 'steering'
    || value === 'analyst'
    || value === 'abort'
}

/**
 * Validate an untrusted ledger. Every shape and integrity error throws, so a
 * doctored or partially written ledger can never silently resume a run.
 */
export function parseCampaignLedger(value: unknown): CampaignLedger {
  const root = record(value, 'campaign ledger')
  if (root.schemaVersion !== 1) fail(`schemaVersion must be 1, got ${String(root.schemaVersion)}`)
  const gameId = text(root.gameId, 'gameId')
  if (gameId.length === 0) fail('gameId must not be empty')
  const seed = finite(root.seed, 'seed')
  const hash = text(root.contractHash, 'contractHash')
  if (!/^[0-9a-f]{64}$/u.test(hash)) fail('contractHash must be a sha256 hex digest')
  const budgetUsd = nonNegative(root.budgetUsd, 'budgetUsd')
  const maxTurns = wholeNumber(root.maxTurns, 'maxTurns', 0)
  const segmentTurns = wholeNumber(root.segmentTurns, 'segmentTurns', 1)
  const inputs = list(root.inputs, 'inputs').map((entry, index) => text(entry, `inputs[${index}]`))
  const spentUsd = nonNegative(root.spentUsd, 'spentUsd')
  const updatedAt = text(root.updatedAt, 'updatedAt')
  if (Number.isNaN(Date.parse(updatedAt))) fail('updatedAt must be an ISO timestamp')

  const decisions = list(root.decisions, 'decisions').map((entry, index) => {
    const decision = record(entry, `decisions[${index}]`)
    return {
      turn: wholeNumber(decision.turn, `decisions[${index}].turn`, 1),
      input: text(decision.input, `decisions[${index}].input`),
      costUsd: nonNegative(decision.costUsd, `decisions[${index}].costUsd`),
      latencyMs: nonNegative(decision.latencyMs, `decisions[${index}].latencyMs`),
      segment: wholeNumber(decision.segment, `decisions[${index}].segment`, 0),
    }
  })
  const segments = list(root.segments, 'segments').map((entry, index) => {
    const segment = record(entry, `segments[${index}]`)
    if (!isStop(segment.stoppedBy)) fail(`segments[${index}].stoppedBy is not a known stop reason`)
    const guidance = segment.guidance
    if (guidance !== null && typeof guidance !== 'string') fail(`segments[${index}].guidance must be a string or null`)
    return {
      index: wholeNumber(segment.index, `segments[${index}].index`, 0),
      startTurn: wholeNumber(segment.startTurn, `segments[${index}].startTurn`, 1),
      endTurn: wholeNumber(segment.endTurn, `segments[${index}].endTurn`, 1),
      spentUsd: nonNegative(segment.spentUsd, `segments[${index}].spentUsd`),
      stoppedBy: segment.stoppedBy,
      guidance,
    }
  })
  const steering = list(root.steering, 'steering').map((entry, index) => {
    const item = record(entry, `steering[${index}]`)
    if (item.stop !== undefined && typeof item.stop !== 'boolean') fail(`steering[${index}].stop must be a boolean`)
    return {
      afterSegment: wholeNumber(item.afterSegment, `steering[${index}].afterSegment`, 0),
      source: text(item.source, `steering[${index}].source`),
      ...(item.guidance === undefined ? {} : { guidance: text(item.guidance, `steering[${index}].guidance`) }),
      ...(item.stop === undefined ? {} : { stop: item.stop }),
      ...(item.note === undefined ? {} : { note: text(item.note, `steering[${index}].note`) }),
    }
  })
  const analyses = list(root.analyses, 'analyses').map((entry, index) => {
    const item = record(entry, `analyses[${index}]`)
    if (!isRecommendation(item.recommendation)) fail(`analyses[${index}].recommendation is not a known recommendation`)
    return {
      afterSegment: wholeNumber(item.afterSegment, `analyses[${index}].afterSegment`, 0),
      summary: text(item.summary, `analyses[${index}].summary`),
      recommendation: item.recommendation,
      ...(item.guidance === undefined ? {} : { guidance: text(item.guidance, `analyses[${index}].guidance`) }),
      ...(item.progressScore === undefined
        ? {}
        : { progressScore: finite(item.progressScore, `analyses[${index}].progressScore`) }),
    }
  })
  const verified = list(root.verified, 'verified').map((entry, index) => text(entry, `verified[${index}]`))
  const milestones = list(root.milestones, 'milestones').map((entry, index) => {
    const row = record(entry, `milestones[${index}]`)
    return {
      id: text(row.id, `milestones[${index}].id`),
      turn: wholeNumber(row.turn, `milestones[${index}].turn`, 0),
      costUsd: nonNegative(row.costUsd, `milestones[${index}].costUsd`),
    }
  })

  // Integrity: the decision list and the input log must describe one run.
  if (decisions.length !== inputs.length) {
    fail(`decisions (${decisions.length}) and inputs (${inputs.length}) disagree on the number of turns`)
  }
  let sum = 0
  for (const [index, decision] of decisions.entries()) {
    if (decision.turn !== index + 1) fail(`decisions[${index}].turn must be ${index + 1}`)
    if (decision.input !== inputs[index]) fail(`decisions[${index}].input does not match inputs[${index}]`)
    sum += decision.costUsd
  }
  if (Math.abs(sum - spentUsd) > 1e-4) {
    fail(`spentUsd ${spentUsd} does not match the recorded decision costs ${round4(sum)}`)
  }
  let covered = 0
  for (const [index, segment] of segments.entries()) {
    if (segment.index !== index) fail(`segments[${index}].index must be ${index}`)
    if (segment.startTurn !== covered + 1) fail(`segments[${index}] must start at turn ${covered + 1}`)
    if (segment.endTurn < segment.startTurn) fail(`segments[${index}] ends before it starts`)
    for (let turn = segment.startTurn; turn <= segment.endTurn; turn++) {
      if (decisions[turn - 1]?.segment !== index) fail(`decisions[${turn - 1}] is not attributed to segment ${index}`)
    }
    covered = segment.endTurn
  }
  if (covered !== decisions.length) {
    fail(`segments cover ${covered} turns but the ledger holds ${decisions.length} decisions`)
  }

  return {
    schemaVersion: 1,
    gameId,
    seed,
    contractHash: hash,
    budgetUsd,
    maxTurns,
    segmentTurns,
    inputs,
    decisions,
    segments,
    steering,
    analyses,
    spentUsd,
    verified,
    milestones,
    updatedAt,
  }
}

function fail(reason: string): never {
  throw new Error(`campaign ledger: ${reason}`)
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${label} must be an object`)
  return value as Record<string, unknown>
}

function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`)
  return value
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string') fail(`${label} must be a string`)
  return value
}

function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} must be a finite number`)
  return value
}

function nonNegative(value: unknown, label: string): number {
  const number = finite(value, label)
  if (number < 0) fail(`${label} must not be negative`)
  return number
}

function wholeNumber(value: unknown, label: string, minimum: number): number {
  const number = finite(value, label)
  if (!Number.isInteger(number) || number < minimum) fail(`${label} must be an integer of at least ${minimum}`)
  return number
}
