/**
 * Shared rollout mechanics for single episodes and segmented campaigns.
 *
 * The framework contains exactly one decision loop. `playEpisode` runs it once
 * to completion; `runCampaign` runs it in bounded segments, possibly across
 * processes. Input validation, cost accounting, milestone bookkeeping,
 * trajectory history, and latency therefore cannot drift between the two
 * entrypoints.
 *
 * This module is internal. It is not exported from `index.ts`.
 */
import { attestRun, inputStatistics, MilestoneTracker } from './attestation'
import { InputLog, isGameOver, observationOf, observationTextOf, type Game } from './runtime'
import type { MilestoneContract } from './schema'
import type {
  AgentDecisionContext,
  AgentDriver,
  AgentHistoryEntry,
  EpisodeRecord,
  EpisodeStop,
  MilestoneCostRow,
} from './episode'

export const MAX_INPUT_BYTES = 64 * 1024

export function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

/** Mutable state of one rollout, whether it runs in one pass or in segments. */
export interface Rollout<S> {
  state: S
  log: InputLog
  history: AgentHistoryEntry[]
  tracker: MilestoneTracker
  milestones: MilestoneCostRow[]
  /** Milestone ids in the order the live tracker observed them. */
  observed: string[]
  costUsd: number[]
  latencyMs: number[]
  spent: number
  turns: number
  /**
   * Retained trajectory entries. Undefined keeps the full trajectory.
   * A bounded history keeps a resumed rollout byte-identical to a continuous
   * one, because the driver sees the same entries in both cases.
   */
  historyLimit?: number
}

export function startRollout<S>(
  game: Game<S>,
  contract: MilestoneContract,
  seed: number,
  historyLimit?: number,
): Rollout<S> {
  const state = game.init(seed)
  const tracker = new MilestoneTracker(contract)
  const milestones: MilestoneCostRow[] = []
  for (const id of tracker.consider(game.evidence(state))) milestones.push({ id, turn: 0, costUsd: 0 })
  return {
    state,
    log: new InputLog(seed),
    history: [],
    tracker,
    milestones,
    observed: milestones.map((row) => row.id),
    costUsd: [],
    latencyMs: [],
    spent: 0,
    turns: 0,
    ...(historyLimit === undefined ? {} : { historyLimit }),
  }
}

/**
 * Apply one decided input to a rollout.
 *
 * Live turns and ledger replay both go through this function, so a resumed
 * campaign reconstructs the same log, milestone rows, and history a continuous
 * run produces.
 */
export function applyInput<S>(
  game: Game<S>,
  rollout: Rollout<S>,
  input: string,
  costUsd: number,
  latencyMs: number,
): void {
  rollout.spent += costUsd
  rollout.log.add(input)
  rollout.state = game.step(rollout.state, input)
  for (const id of rollout.tracker.consider(game.evidence(rollout.state))) {
    rollout.observed.push(id)
    rollout.milestones.push({ id, turn: rollout.turns + 1, costUsd: round4(rollout.spent) })
  }
  // History keeps the observation text only; see AgentHistoryEntry. It reads
  // the text alone so that appending a row, on a live turn or on a ledger
  // replay, cannot fail on a bound that governs pixels nobody records.
  rollout.history.push({ input, frame: observationTextOf(game, rollout.state) })
  if (rollout.historyLimit !== undefined && rollout.history.length > rollout.historyLimit) {
    rollout.history.splice(0, rollout.history.length - rollout.historyLimit)
  }
  rollout.costUsd.push(costUsd)
  rollout.latencyMs.push(latencyMs)
  rollout.turns += 1
}

export type RolloutStop = 'segmentLimit' | 'maxTurns' | 'budget' | 'gameOver'

export interface RolloutLimits {
  budgetUsd: number
  maxTurns: number
  /** Decisions this call may take before it yields control to the caller. */
  maxDecisions?: number
  /** Latest supervisor or analyst note, passed to every decision in this call. */
  guidance?: string
  /** Stop as soon as the game declares itself over. Off by default. */
  stopAtGameOver?: boolean
  signal?: AbortSignal
}

/**
 * Drive the agent until a stop condition holds. Returns the one that held.
 *
 * Every stop is an ordinary exit from the loop, so the caller finalizes the
 * rollout the same way whichever one fired. Nothing here throws to end a run:
 * an exception would leave the caller without the record the run is graded on.
 */
export async function advanceRollout<S>(
  game: Game<S>,
  driver: AgentDriver,
  rollout: Rollout<S>,
  seed: number,
  limits: RolloutLimits,
): Promise<RolloutStop> {
  let taken = 0
  // The conditions are asked in one place, before every decision, so game over
  // is seen at the start of the run as well as after the last input. Order is
  // precedence: a finished game outranks the harness limits, and both outrank
  // a segment boundary, which only pauses a campaign.
  while (true) {
    if (limits.stopAtGameOver === true && isGameOver(game, rollout.state)) return 'gameOver'
    if (rollout.turns >= limits.maxTurns) return 'maxTurns'
    if (rollout.spent >= limits.budgetUsd) return 'budget'
    if (limits.maxDecisions !== undefined && taken >= limits.maxDecisions) return 'segmentLimit'
    limits.signal?.throwIfAborted()
    // One observation per decision. An over-cap image throws here, which fails
    // the turn instead of quietly showing the agent a smaller screen.
    const observation = observationOf(game, rollout.state)
    const frame = observation.text
    const context: AgentDecisionContext = {
      turn: rollout.turns + 1,
      maxTurns: limits.maxTurns,
      seed,
      spentUsd: rollout.spent,
      remainingBudgetUsd: Math.max(0, limits.budgetUsd - rollout.spent),
      ...(limits.guidance === undefined ? {} : { guidance: limits.guidance }),
      observation,
      ...(limits.signal === undefined ? {} : { signal: limits.signal }),
    }
    // A driver receives an immutable snapshot, never the harness's mutable log.
    const visibleHistory = rollout.history.map((entry) => ({ ...entry }))
    const decisionStarted = Date.now()
    const turn = await driver.act(frame, visibleHistory, Object.freeze(context))
    const latencyMs = Date.now() - decisionStarted
    limits.signal?.throwIfAborted()

    if (typeof turn.input !== 'string' || turn.input.length === 0) {
      throw new Error(`driver returned an empty input at turn ${rollout.turns + 1}`)
    }
    if (Buffer.byteLength(turn.input, 'utf8') > MAX_INPUT_BYTES) {
      throw new Error(`driver input at turn ${rollout.turns + 1} exceeds ${MAX_INPUT_BYTES} bytes`)
    }
    if (!Number.isFinite(turn.costUsd) || turn.costUsd < 0) {
      throw new Error(`driver returned invalid cost at turn ${rollout.turns + 1}`)
    }

    applyInput(game, rollout, turn.input, turn.costUsd, latencyMs)
    taken += 1
  }
}

/** Attest the whole rollout and build the record both entrypoints return. */
export function finalizeRecord<S>(
  game: Game<S>,
  contract: MilestoneContract,
  seed: number,
  rollout: Rollout<S>,
  budgetUsd: number,
  startedAtMs: number,
  stoppedBy: EpisodeStop,
): EpisodeRecord {
  const attestation = attestRun(game, contract, seed, rollout.log, [])
  return {
    game: game.id,
    turns: rollout.turns,
    spentUsd: round4(rollout.spent),
    budgetUsd,
    budgetExhausted: rollout.spent >= budgetUsd,
    stoppedBy,
    // Asked of every run, not only of a run that stopped for it: a turn-limited
    // episode that reports `gameOver: true` is one that kept paying for
    // decisions the game could no longer act on.
    gameOver: game.over === undefined ? null : isGameOver(game, rollout.state),
    verified: attestation.verified,
    score: attestation.score,
    milestones: [...rollout.milestones],
    replayDivergence: JSON.stringify(rollout.observed) !== JSON.stringify(attestation.verified),
    latencyMs: [...rollout.latencyMs],
    inputStats: inputStatistics(rollout.log.inputs()),
    verdict: attestation.verdict,
    ms: Date.now() - startedAtMs,
  }
}
