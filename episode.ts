import { attestRun, inputStatistics, MilestoneTracker, type InputStats } from './attestation'
import { InputLog, type Game } from './runtime'
import type { MilestoneContract } from './schema'

/** One prior action and the observation produced by that action. */
export interface AgentHistoryEntry {
  input: string
  frame: string
}

/**
 * Harness-owned context supplied to every agent decision.
 *
 * Drivers may use `remainingBudgetUsd` to set a provider-side hard request cap.
 * Playproof always records the actual reported cost; it never invents missing
 * pricing or silently rewrites an over-budget call to zero.
 */
export interface AgentDecisionContext {
  /** One-based decision index. */
  turn: number
  maxTurns: number
  seed: number
  spentUsd: number
  remainingBudgetUsd: number
  signal?: AbortSignal
}

export interface DriverTurn {
  input: string
  costUsd: number
}

/**
 * The only interface an evaluated agent must implement.
 *
 * It is deliberately independent of any model vendor, agent framework,
 * harness, transport, or programming language. The built-in CLI and
 * OpenAI-compatible drivers are conveniences; a callback is sufficient.
 */
export interface AgentDriver {
  act(
    frame: string,
    history: readonly AgentHistoryEntry[],
    context: Readonly<AgentDecisionContext>,
  ): Promise<DriverTurn>
}

export function scriptedDriver(script: readonly string[]): AgentDriver {
  let index = 0
  return {
    act: async () => ({
      input: index < script.length ? script[index++]! : 'noop',
      costUsd: 0,
    }),
  }
}

export interface MilestoneCostRow {
  id: string
  turn: number
  costUsd: number
}

export interface EpisodeRecord {
  game: string
  turns: number
  spentUsd: number
  budgetUsd: number
  budgetExhausted: boolean
  verified: string[]
  milestones: MilestoneCostRow[]
  replayDivergence: boolean
  latencyMs: number[]
  inputStats: InputStats
  verdict: 'clean' | 'rejected'
  ms: number
}

const MAX_INPUT_BYTES = 64 * 1024

export async function playEpisode<S>(
  game: Game<S>,
  contract: MilestoneContract,
  driver: AgentDriver,
  budgetUsd: number,
  maxTurns: number,
  seed = 0,
  signal?: AbortSignal,
): Promise<{ record: EpisodeRecord; log: InputLog }> {
  if (!Number.isFinite(budgetUsd) || budgetUsd < 0) throw new Error('budgetUsd must be non-negative')
  if (!Number.isInteger(maxTurns) || maxTurns < 0) throw new Error('maxTurns must be a non-negative integer')
  if (!Number.isFinite(seed)) throw new Error('seed must be finite')

  const started = Date.now()
  let state = game.init(seed)
  const log = new InputLog(seed)
  const history: AgentHistoryEntry[] = []
  const tracker = new MilestoneTracker(contract)
  const milestones: MilestoneCostRow[] = []
  for (const id of tracker.consider(game.evidence(state))) milestones.push({ id, turn: 0, costUsd: 0 })
  const observed = milestones.map((row) => row.id)
  let spent = 0
  let turns = 0
  const latencyMs: number[] = []

  while (turns < maxTurns && spent < budgetUsd) {
    signal?.throwIfAborted()
    const frame = game.frame(state)
    const context: AgentDecisionContext = {
      turn: turns + 1,
      maxTurns,
      seed,
      spentUsd: spent,
      remainingBudgetUsd: Math.max(0, budgetUsd - spent),
      ...(signal === undefined ? {} : { signal }),
    }
    // A driver receives an immutable snapshot, never the harness's mutable log.
    const visibleHistory = history.map((entry) => ({ ...entry }))
    const decisionStarted = Date.now()
    const turn = await driver.act(frame, visibleHistory, Object.freeze(context))
    latencyMs.push(Date.now() - decisionStarted)
    signal?.throwIfAborted()

    if (typeof turn.input !== 'string' || turn.input.length === 0) {
      throw new Error(`driver returned an empty input at turn ${turns + 1}`)
    }
    if (Buffer.byteLength(turn.input, 'utf8') > MAX_INPUT_BYTES) {
      throw new Error(`driver input at turn ${turns + 1} exceeds ${MAX_INPUT_BYTES} bytes`)
    }
    if (!Number.isFinite(turn.costUsd) || turn.costUsd < 0) {
      throw new Error(`driver returned invalid cost at turn ${turns + 1}`)
    }

    spent += turn.costUsd
    log.add(turn.input)
    state = game.step(state, turn.input)
    for (const id of tracker.consider(game.evidence(state))) {
      observed.push(id)
      milestones.push({ id, turn: turns + 1, costUsd: round4(spent) })
    }
    history.push({ input: turn.input, frame: game.frame(state) })
    turns += 1
  }

  const attestation = attestRun(game, contract, seed, log, [])
  return {
    record: {
      game: game.id,
      turns,
      spentUsd: round4(spent),
      budgetUsd,
      budgetExhausted: spent >= budgetUsd,
      verified: attestation.verified,
      milestones,
      replayDivergence: JSON.stringify(observed) !== JSON.stringify(attestation.verified),
      latencyMs,
      inputStats: inputStatistics(log.inputs()),
      verdict: attestation.verdict,
      ms: Date.now() - started,
    },
    log,
  }
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}
