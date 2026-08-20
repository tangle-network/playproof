import type { InputStats } from './attestation'
import { advanceRollout, finalizeRecord, startRollout } from './episode-loop'
import type { InputLog, Game } from './runtime'
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
  /**
   * Latest supervisor or analyst note for a long-horizon run. Absent when the
   * run has no steering. It is an out-of-band hint, never privileged evidence
   * and never part of the verified input log.
   */
  guidance?: string
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
