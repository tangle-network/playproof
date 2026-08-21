/**
 * Contract calibration — does this contract measure skill, or elapsed frames?
 *
 * A milestone contract says which progressions count. It does not say that
 * reaching them is hard. A contract derived from one demonstrated trajectory
 * can pin a memory channel that moves whenever the game runs at all, so a
 * constant button press earns the same milestones an evaluated agent earns.
 * Such a contract is not a benchmark: it separates nothing.
 *
 * This module replays the reference trajectory and a suite of trivial policies
 * through the same `attestRun` path, then reports which milestones survive the
 * comparison. `assertContractSeparates` is the fail-closed gate a target author
 * calls before publishing a contract.
 *
 * Everything here is pure and synchronous, and depends only on the runtime,
 * schema, and attestation planes. It imports no adapter and no model provider.
 */
import { attestRun } from './attestation'
import { logFrom } from './runtime'
import type { Game } from './runtime'
import type { MilestoneContract } from './schema'

/**
 * A deterministic input policy that needs no observation of the game.
 *
 * `inputs` must be a pure function of its three arguments: the same
 * vocabulary, turn count, and seed must always produce the same script, so a
 * calibration report is reproducible by anyone holding the contract.
 */
export interface BaselinePolicy {
  id: string
  inputs(vocabulary: readonly string[], turns: number, seed: number): readonly string[]
}

/**
 * A word outside every adapter vocabulary. Unknown inputs are no-ops by the
 * `Game` contract, so this policy measures what mere elapsed time earns.
 */
export const UNKNOWN_BASELINE_WORD = 'playproof-unknown-word'

const constant = (word: string): BaselinePolicy => ({
  id: `constant:${word}`,
  inputs: (_vocabulary, turns) => Array.from({ length: turns }, () => word),
})

/**
 * Linear congruential generator (Numerical Recipes constants) over 32 bits.
 * The seed is mixed once so seed 0 is not a degenerate starting state. Not a
 * statistically strong generator; it only has to be unpredictable to the
 * contract and identical on every machine.
 */
function lcg(seed: number): () => number {
  let state = ((seed >>> 0) ^ 0x9e3779b9) >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state
  }
}

/**
 * The standard suite: one constant policy per input word, a word the game
 * cannot interpret, a fixed cycle through the vocabulary, and a seeded
 * pseudo-random walk over it.
 *
 * The per-word constants are load-bearing. On Libbet, only `constant:a` and
 * `constant:start` reach the milestones the evaluated agent reached; a suite
 * that pressed one representative button would have reported the contract
 * healthy.
 *
 * The vocabulary is a required argument because the constant family cannot be
 * built without it. Extra policies can be appended and passed to
 * `calibrateContract` through `options.baselines`.
 */
export function trivialBaselines(vocabulary: readonly string[]): BaselinePolicy[] {
  return [
    ...vocabulary.map(constant),
    constant(UNKNOWN_BASELINE_WORD),
    {
      id: 'round-robin',
      inputs: (words, turns) => Array.from({ length: turns }, (_unused, i) => words[i % words.length]!),
    },
    {
      id: 'pseudo-random',
      inputs: (words, turns, seed) => {
        const next = lcg(seed)
        return Array.from({ length: turns }, () => words[next() % words.length]!)
      },
    },
  ]
}

export interface BaselineOutcome {
  id: string
  verified: string[]
  verdict: 'clean' | 'rejected'
}

export interface CalibrationReport {
  turns: number
  seed: number
  vocabulary: string[]
  reference: BaselineOutcome
  baselines: BaselineOutcome[]
  /** milestones no baseline earned */
  separating: string[]
  /** milestones at least one baseline earned */
  trivial: string[]
  /** the strongest baseline's verified count */
  bestBaselineCount: number
  separates: boolean
}

export interface CalibrateOptions {
  /** The demonstrated trajectory the contract was derived from or claims to describe. */
  reference: readonly string[]
  /** Replay seed for every run, and the seed handed to each policy. Default 0. */
  seed?: number
  /** Every input word the adapter accepts. */
  vocabulary: readonly string[]
  /** Defaults to `trivialBaselines(vocabulary)`. */
  baselines?: readonly BaselinePolicy[]
  /** Inputs per run. Default: the reference length, so the comparison is length-matched. */
  turns?: number
}

/**
 * Replay the reference and every baseline against the same contract and report
 * which milestones the baselines cannot reach.
 *
 * Every run is played at `turns` inputs; the reference is truncated to that
 * length. Raising `turns` above the reference length gives the baselines a
 * larger budget than the reference had, which can only weaken the separating
 * set — useful when the reference is short and the evaluated agent was not.
 *
 * The seed is used twice on purpose: it is the replay seed handed to
 * `attestRun` and the seed each policy derives its script from, so one number
 * reproduces the whole report.
 */
export function calibrateContract<S>(
  game: Game<S>,
  contract: MilestoneContract,
  options: CalibrateOptions,
): CalibrationReport {
  const seed = options.seed ?? 0
  const turns = options.turns ?? options.reference.length
  const vocabulary = [...options.vocabulary]
  if (!Number.isInteger(turns) || turns < 0) throw new Error(`turns must be a non-negative integer, got ${turns}`)
  if (vocabulary.length === 0) throw new Error('a contract cannot be calibrated against an empty input vocabulary')
  const policies = options.baselines ?? trivialBaselines(vocabulary)

  const play = (id: string, inputs: readonly string[]): BaselineOutcome => {
    const attestation = attestRun(game, contract, seed, logFrom(seed, [...inputs]), [])
    return { id, verified: attestation.verified, verdict: attestation.verdict }
  }

  const reference = play('reference', options.reference.slice(0, turns))
  const baselines = policies.map((policy) => {
    const inputs = policy.inputs(vocabulary, turns, seed)
    if (inputs.length !== turns) {
      throw new Error(`baseline ${policy.id} produced ${inputs.length} inputs for ${turns} turns`)
    }
    return play(policy.id, inputs)
  })

  const earnedByBaseline = new Set(baselines.flatMap((b) => b.verified))
  const order = contract.milestones.map((m) => m.id)
  const separating = reference.verified.filter((id) => !earnedByBaseline.has(id))
  const trivial = order.filter((id) => earnedByBaseline.has(id))
  const bestBaselineCount = baselines.reduce((best, b) => Math.max(best, b.verified.length), 0)

  return {
    turns,
    seed,
    vocabulary,
    reference,
    baselines,
    separating,
    trivial,
    bestBaselineCount,
    separates: separating.length > 0 && reference.verified.length > bestBaselineCount,
  }
}

/**
 * Fail closed on a contract that a trivial policy satisfies.
 *
 * Call this wherever a target is published. A contract that does not separate
 * still produces scores; those scores report how many frames elapsed, and
 * comparing two agents on them compares nothing.
 */
export function assertContractSeparates(report: CalibrationReport): void {
  if (report.separates) return
  const best = report.baselines.filter((b) => b.verified.length === report.bestBaselineCount).map((b) => b.id)
  const earners = (milestone: string): string =>
    report.baselines.filter((b) => b.verified.includes(milestone)).map((b) => b.id).join(', ')
  const lines = [
    `contract does not separate: the reference verified ${report.reference.verified.length} milestone(s) ` +
      `and the best trivial baseline verified ${report.bestBaselineCount} over ${report.turns} turns ` +
      `(seed ${report.seed}, strongest: ${best.join(', ') || 'none'})`,
    ...report.trivial.map((id) => `  trivial: ${id} — earned by ${earners(id)}`),
    `  out of reach of every baseline: ${report.separating.join(', ') || 'nothing'}`,
    'A derived contract is a hypothesis until it separates. Pin a progression a trivial policy cannot reach.',
  ]
  throw new Error(lines.join('\n'))
}
