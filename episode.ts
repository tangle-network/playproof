import type { InputStats } from './attestation'
import { advanceRollout, finalizeRecord, startRollout } from './episode-loop'
import type { InputLog, Game, Observation } from './runtime'
import type { MilestoneContract } from './schema'

/**
 * One prior action and the observation text produced by that action.
 *
 * History is text only, deliberately. A driver replays the retained trajectory
 * into every prompt, so keeping N turns of images would multiply the paid image
 * tokens by the history depth on each decision and would grow the request with
 * the run. The current turn carries the pixels; history carries what happened.
 */
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
  /**
   * Latest supervisor or analyst note for a long-horizon run. Absent when the
   * run has no steering. It is an out-of-band hint, never privileged evidence
   * and never part of the verified input log.
   */
  guidance?: string
  /**
   * The full observation for this decision, computed once by the harness.
   *
   * `observation.text` is exactly the driver's `frame` argument, so a text-only
   * driver can ignore this field entirely. `observation.images` carries the
   * rendered screen when the game publishes one and is absent otherwise.
   *
   * It is optional in the type because a caller may build a context by hand —
   * a driver unit test does — and the text is already the first argument. Every
   * harness-driven decision sets it.
   */
  observation?: Readonly<Observation>
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

/**
 * Replays a fixed input script. The script is indexed by the harness turn, not
 * by call count, so a driver created in a fresh process resumes a campaign at
 * the right position instead of restarting the script.
 */
export function scriptedDriver(script: readonly string[]): AgentDriver {
  return {
    act: async (_frame, _history, context) => ({
      input: script[context.turn - 1] ?? 'noop',
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
  const rollout = startRollout(game, contract, seed)
  await advanceRollout(game, driver, rollout, seed, {
    budgetUsd,
    maxTurns,
    ...(signal === undefined ? {} : { signal }),
  })
  return {
    record: finalizeRecord(game, contract, seed, rollout, budgetUsd, started),
    log: rollout.log,
  }
}
