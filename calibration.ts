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
 * A trivial baseline is not the only way a contract fails to measure. A
 * milestone can also be out of reach of EVERY policy, because a hash check
 * pins the reference run's exact bytes. Such a milestone is never earned by a
 * baseline, so the separation test alone reads it as the contract's strongest
 * evidence, when in fact nothing but a replay of the reference reproduces it.
 * The report therefore splits the contract into earnable and unearnable
 * milestones, and the gate refuses a contract whose unearnable milestones the
 * author has not declared.
 *
 * Everything here is pure and synchronous, and depends only on the runtime,
 * schema, and attestation planes. It imports no adapter and no model provider.
 */
import { attestRun } from './attestation'
import { logFrom } from './runtime'
import type { Game } from './runtime'
import { contractEarnability, formatMilestoneScore, scoreMilestones } from './schema'
import type { MilestoneContract, MilestoneScore } from './schema'

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
  /**
   * Earnable milestones the reference reached and no baseline did — the whole
   * of the contract's discriminating power. A replay-identity milestone is
   * excluded even though no baseline earned it, because being out of reach of
   * every policy is not separation.
   */
  separating: string[]
  /** milestones at least one baseline earned */
  trivial: string[]
  /** contract milestones an independent policy can earn by playing */
  earnable: string[]
  /**
   * Contract milestones only a replay of the reference earns: a hash check on
   * the reference run's exact bytes, or a milestone gated behind one.
   */
  unearnable: string[]
  /** why each unearnable milestone is out of reach, keyed by milestone id */
  unearnableReasons: Record<string, string>
  /**
   * Unearnable milestones a trivial baseline reproduced anyway.
   *
   * A non-empty set is a measured finding about the game, not about the
   * policy: the hash covers so little entropy that another trajectory collides
   * with it, so it identifies nothing. Such a milestone is also listed in
   * `trivial`.
   */
  unearnableReproduced: string[]
  /** the strongest baseline's verified count */
  bestBaselineCount: number
  /**
   * The strongest baseline's EARNABLE count. This is the number a reference
   * must beat: a raw verified count flatters the reference, which reproduces
   * every replay-identity check by construction.
   */
  bestBaselineEarnedCount: number
  /** the reference's own progress, with the earnable denominator separated */
  referenceScore: MilestoneScore
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
  const { earnable, unearnable, reasons } = contractEarnability(contract)
  const earnableSet = new Set(earnable)
  const separating = reference.verified.filter((id) => !earnedByBaseline.has(id) && earnableSet.has(id))
  const trivial = order.filter((id) => earnedByBaseline.has(id))
  const bestBaselineCount = baselines.reduce((best, b) => Math.max(best, b.verified.length), 0)
  const earnedCount = (outcome: BaselineOutcome): number => outcome.verified.filter((id) => earnableSet.has(id)).length
  const bestBaselineEarnedCount = baselines.reduce((best, b) => Math.max(best, earnedCount(b)), 0)
  const referenceScore = scoreMilestones(contract, reference.verified)

  return {
    turns,
    seed,
    vocabulary,
    reference,
    baselines,
    separating,
    trivial,
    earnable,
    unearnable,
    unearnableReasons: reasons,
    unearnableReproduced: unearnable.filter((id) => earnedByBaseline.has(id)),
    bestBaselineCount,
    bestBaselineEarnedCount,
    referenceScore,
    separates: separating.length > 0 && referenceScore.earned > bestBaselineEarnedCount,
  }
}

/**
 * The replay-identity checks a contract is allowed to carry.
 *
 * The declaration is an exact set, not a switch. An author who pins a hash
 * writes the id down, so a hash milestone that a later derivation adds cannot
 * enter a published contract unnoticed.
 */
export interface EarnabilityDeclaration {
  /** Milestone ids the author accepts as replay-identity pins. */
  identityChecks?: readonly string[]
}

function earners(report: CalibrationReport, milestone: string): string {
  return report.baselines.filter((b) => b.verified.includes(milestone)).map((b) => b.id).join(', ')
}

/**
 * Every way a contract's earnable/unearnable split can be wrong, as message
 * blocks. An empty array means the split is sound and declared.
 */
function earnabilityProblems(report: CalibrationReport, declaration: EarnabilityDeclaration): string[] {
  const problems: string[] = []
  const { total } = report.referenceScore
  const declared = declaration.identityChecks
  const share = total === 0 ? 0 : Math.round((report.unearnable.length / total) * 100)
  const detail = report.unearnable.map((id) => `  unearnable: ${id} — ${report.unearnableReasons[id]}`)

  if (declared === undefined) {
    if (report.unearnable.length > 0) {
      problems.push(
        [
          `contract has ${report.unearnable.length} of ${total} milestone(s) no policy can earn ` +
            `(${report.earnable.length} earnable, ${share}% unearnable)`,
          ...detail,
          `  the reference itself scored ${formatMilestoneScore(report.referenceScore)}, so a score out of ` +
            `${total} is not reachable by an independent policy`,
          'A replay-identity check proves that a replay reproduced the recorded run. It is not progress.',
          `Keep it and declare it — assertContractSeparates(report, { identityChecks: ` +
            `[${report.unearnable.map((id) => `'${id}'`).join(', ')}] }) — or state the progression with a ` +
            'state-path, save-path, frame-path, or log-contains check.',
        ].join('\n'),
      )
    }
  } else {
    const accepted = new Set(declared)
    const pinned = new Set(report.unearnable)
    const undeclared = report.unearnable.filter((id) => !accepted.has(id))
    const stale = [...accepted].filter((id) => !pinned.has(id))
    if (undeclared.length > 0) {
      problems.push(
        [
          `contract has ${undeclared.length} undeclared milestone(s) no policy can earn: ${undeclared.join(', ')}`,
          ...detail,
          'Declare every replay-identity check, or state the progression with a semantic check.',
        ].join('\n'),
      )
    }
    if (stale.length > 0) {
      problems.push(
        `identityChecks names ${stale.length} milestone(s) the contract does not pin: ${stale.join(', ')} — ` +
          'the declaration is stale, and it would hide a hash milestone added later',
      )
    }
  }

  if (report.unearnableReproduced.length > 0) {
    problems.push(
      [
        `${report.unearnableReproduced.length} replay-identity milestone(s) were reproduced by a trivial baseline:`,
        ...report.unearnableReproduced.map((id) => `  ${id} — reproduced by ${earners(report, id)}`),
        'A hash that another trajectory reproduces identifies no run. Remove it or hash more state.',
      ].join('\n'),
    )
  }
  return problems
}

/**
 * Fail closed on a contract whose milestones no policy can earn.
 *
 * Identity checks are correct and useful: replay attestation is exactly the
 * claim that one run reproduced another's bytes. They must not be counted as
 * achievements, and an undeclared one must not reach a published contract,
 * because it puts points in the denominator that only the reference can score.
 *
 * Call this for a contract that is not meant to separate — a demonstration
 * target — where `assertContractSeparates` would fail for the other reason.
 */
export function assertMilestonesEarnable(
  report: CalibrationReport,
  declaration: EarnabilityDeclaration = {},
): void {
  const problems = earnabilityProblems(report, declaration)
  if (problems.length > 0) throw new Error(problems.join('\n'))
}

/**
 * Fail closed on a contract that a trivial policy satisfies, and on one that
 * carries milestones no policy can earn.
 *
 * Call this wherever a target is published. A contract that does not separate
 * still produces scores; those scores report how many frames elapsed, and
 * comparing two agents on them compares nothing. A contract whose points are
 * partly unearnable still produces scores too, and every one of them is quoted
 * against a denominator no agent can reach.
 *
 * Both failures are reported together, so one run of the gate names everything
 * an author must fix.
 */
export function assertContractSeparates(
  report: CalibrationReport,
  declaration: EarnabilityDeclaration = {},
): void {
  const problems = earnabilityProblems(report, declaration)
  if (!report.separates) {
    const best = report.baselines.filter((b) => b.verified.length === report.bestBaselineCount).map((b) => b.id)
    problems.push(
      [
        `contract does not separate: the reference verified ${report.reference.verified.length} milestone(s) ` +
          `and the best trivial baseline verified ${report.bestBaselineCount} over ${report.turns} turns ` +
          `(seed ${report.seed}, strongest: ${best.join(', ') || 'none'})`,
        `  on earnable milestones alone: reference ${report.referenceScore.earned}, ` +
          `best baseline ${report.bestBaselineEarnedCount}, of ${report.referenceScore.earnable} earnable`,
        ...report.trivial.map((id) => `  trivial: ${id} — earned by ${earners(report, id)}`),
        `  earnable and out of reach of every baseline: ${report.separating.join(', ') || 'nothing'}`,
        'A derived contract is a hypothesis until it separates. Pin a progression a trivial policy cannot reach.',
      ].join('\n'),
    )
  }
  if (problems.length > 0) throw new Error(problems.join('\n'))
}
