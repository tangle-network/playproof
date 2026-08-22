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
 * A trivial baseline is not the only way a contract fails to measure. A hash
 * check names one exact game state without saying which state, so a reader
 * cannot judge what it demands. Every milestone is earnable — a hash
 * identifies a STATE, not a trajectory, and many trajectories reach one state
 * — but an opaque milestone cannot carry a separation claim, because "the
 * reference reached it and no baseline did" states nothing a reader can check.
 * The report therefore splits the contract into legible and opaque milestones,
 * and the gate refuses a contract whose opaque checks the author has not
 * declared.
 *
 * The second measurement is how many input logs satisfy an opaque check.
 * `probeOpaqueCollisions` perturbs the reference one input at a time over the
 * prefix that ends where the check first passes, and counts how many
 * perturbed logs still satisfy it. A hash a large family of logs satisfies is
 * a weak check, and the gate reports the measured number.
 *
 * None of this touches replay attestation. The input-log hash chain is the
 * mechanism that proves a replay reproduced a recorded run, and it is
 * unaffected: a milestone hash was never that proof.
 *
 * Everything here is pure and synchronous, and depends only on the runtime,
 * schema, and attestation planes. It imports no adapter and no model provider.
 */
import { attestRun, MilestoneTracker } from './attestation'
import { logFrom } from './runtime'
import type { Game } from './runtime'
import { contractLegibility, formatMilestoneScore, scoreMilestones } from './schema'
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

/**
 * How many distinct input logs satisfy one opaque check, measured by
 * substitution rather than assumed.
 *
 * A hash pins a state. The question a contract author needs answered is how
 * many ways there are into that state: one, and the check is a real pin; many,
 * and the check is a weak restatement of a progression a path check could have
 * named in the open.
 */
export interface OpaqueCollision {
  /** The opaque milestone this row measures. */
  milestone: string
  /** Reference inputs consumed before the check first passed; -1 if it never did. */
  firesAfter: number
  /** Turns of that prefix the sweep probed. */
  probedTurns: number
  /** Single-input substitutions of the reference the sweep replayed. */
  substitutions: number
  /** Substitutions whose log still satisfied the check. */
  collisions: number
  /** Probed turns where at least one substitution still satisfied it. */
  freeTurns: number
  /** Whether one surviving substitution at EVERY free turn at once still satisfies it. */
  jointCollision: boolean
  /**
   * A lower bound on the family of `firesAfter`-input logs that satisfy the
   * check: the product over probed turns of (1 + surviving alternatives).
   *
   * It is a bound and not a count, because the sweep changes one input at a
   * time. `jointCollision` is the evidence that the free turns combine.
   */
  family: number
}

/** Default cap on probed turns, so a check that fires late stays cheap to measure. */
export const DEFAULT_COLLISION_TURNS = 32

/** Turn indices to probe: every turn of the prefix, thinned evenly to `cap`. */
function probePoints(prefixLength: number, cap: number): number[] {
  if (prefixLength <= cap) return Array.from({ length: prefixLength }, (_unused, i) => i)
  return Array.from({ length: cap }, (_unused, i) => Math.floor((i * prefixLength) / cap))
}

/** Reference inputs consumed before each milestone first passed, keyed by id. */
function firstPassTurn<S>(
  game: Game<S>,
  contract: MilestoneContract,
  seed: number,
  reference: readonly string[],
): Map<string, number> {
  const tracker = new MilestoneTracker(contract)
  const at = new Map<string, number>()
  let state = game.init(seed)
  for (const id of tracker.consider(game.evidence(state))) at.set(id, 0)
  for (let i = 0; i < reference.length; i++) {
    state = game.step(state, reference[i]!)
    for (const id of tracker.consider(game.evidence(state))) at.set(id, i + 1)
  }
  return at
}

/**
 * Measure how many perturbations of the reference still satisfy each opaque
 * check of a contract.
 *
 * The sweep is deterministic and needs no independent policy: it replays the
 * reference with one input replaced, over the prefix that ends where the check
 * first passed. Milestones that fire at the same turn share one sweep.
 *
 * Measured on ALE Breakout, whose two hashes fire after 32 inputs over the
 * vocabulary NOOP/FIRE/RIGHT/LEFT: 40 of the 96 single-input substitutions
 * still reproduced both hashes, at 16 of the 32 turns, and all 16 applied at
 * once reproduced them too. `FIRE` while the ball is already in flight is a
 * state no-op, so those logs reach a bit-identical emulator state.
 */
export function probeOpaqueCollisions<S>(
  game: Game<S>,
  contract: MilestoneContract,
  options: { reference: readonly string[]; seed: number; vocabulary: readonly string[]; collisionTurns?: number },
): OpaqueCollision[] {
  const { opaque } = contractLegibility(contract)
  if (opaque.length === 0) return []
  const cap = options.collisionTurns ?? DEFAULT_COLLISION_TURNS
  if (!Number.isInteger(cap) || cap < 0) throw new Error(`collisionTurns must be a non-negative integer, got ${cap}`)
  const seed = options.seed
  const firesAfter = firstPassTurn(game, contract, seed, options.reference)
  const satisfied = (inputs: readonly string[]): Set<string> => {
    const tracker = new MilestoneTracker(contract)
    let state = game.init(seed)
    tracker.consider(game.evidence(state))
    for (const input of inputs) {
      state = game.step(state, input)
      tracker.consider(game.evidence(state))
    }
    return new Set(tracker.verified())
  }

  // Milestones that fire at the same turn share a prefix, so they share a
  // sweep: one replay answers for every one of them.
  const groups = new Map<number, string[]>()
  for (const id of opaque) {
    const turn = firesAfter.get(id) ?? -1
    groups.set(turn, [...(groups.get(turn) ?? []), id])
  }

  const rows: OpaqueCollision[] = []
  for (const [turn, ids] of groups) {
    if (turn <= 0) {
      for (const id of ids) {
        rows.push({
          milestone: id, firesAfter: turn, probedTurns: 0, substitutions: 0,
          collisions: 0, freeTurns: 0, jointCollision: false, family: 1,
        })
      }
      continue
    }
    const prefix = options.reference.slice(0, turn)
    const points = probePoints(turn, cap)
    const survivors = new Map<string, Map<number, string[]>>(ids.map((id) => [id, new Map()]))
    let substitutions = 0
    for (const i of points) {
      for (const word of options.vocabulary) {
        if (word === prefix[i]) continue
        substitutions++
        const perturbed = [...prefix]
        perturbed[i] = word
        const verified = satisfied(perturbed)
        for (const id of ids) {
          if (!verified.has(id)) continue
          const byTurn = survivors.get(id)!
          byTurn.set(i, [...(byTurn.get(i) ?? []), word])
        }
      }
    }
    for (const id of ids) {
      const byTurn = survivors.get(id)!
      const collisions = [...byTurn.values()].reduce((n, words) => n + words.length, 0)
      let family = 1
      for (const words of byTurn.values()) family *= 1 + words.length
      let jointCollision = false
      if (byTurn.size > 0) {
        const joint = [...prefix]
        for (const [i, words] of byTurn) joint[i] = words[0]!
        jointCollision = satisfied(joint).has(id)
      }
      rows.push({
        milestone: id,
        firesAfter: turn,
        probedTurns: points.length,
        substitutions,
        collisions,
        freeTurns: byTurn.size,
        jointCollision,
        family,
      })
    }
  }
  return rows.sort((a, b) => opaque.indexOf(a.milestone) - opaque.indexOf(b.milestone))
}

export interface CalibrationReport {
  turns: number
  seed: number
  vocabulary: string[]
  reference: BaselineOutcome
  baselines: BaselineOutcome[]
  /**
   * Legible milestones the reference reached and no baseline did — the whole
   * of the contract's discriminating power. An opaque milestone is excluded
   * even when no baseline earned it: a reader cannot see what it demands, so
   * it cannot be the evidence that the contract measures anything.
   */
  separating: string[]
  /** milestones at least one baseline earned */
  trivial: string[]
  /** contract milestones whose requirement a reader can read off the contract */
  legible: string[]
  /** contract milestones stated as a hash, or gated behind one */
  opaque: string[]
  /** why each opaque milestone cannot be read, keyed by milestone id */
  opacityReasons: Record<string, string>
  /**
   * Opaque milestones a trivial baseline reproduced.
   *
   * A non-empty set is a measured finding about the game: the check is
   * satisfied by mashing one button, so it demands nothing. Such a milestone
   * is also listed in `trivial`.
   */
  opaqueReproduced: string[]
  /**
   * How many perturbed logs satisfy each opaque check, one row per opaque
   * milestone. This is the non-trivial prober: it finds the collisions the
   * baseline suite is far too weak to find.
   */
  collisions: OpaqueCollision[]
  /** the strongest baseline's verified count */
  bestBaselineCount: number
  /**
   * The strongest baseline's count over LEGIBLE milestones. This is the number
   * a reference must beat, because an opaque milestone cannot carry the claim.
   */
  bestBaselineLegibleCount: number
  /** the reference's own progress */
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
  /**
   * Cap on the turns the opaque-collision sweep probes per check. Default
   * `DEFAULT_COLLISION_TURNS`. The sweep costs `probedTurns * (vocabulary - 1)`
   * replays of the prefix, so lower it for a check that fires very late.
   */
  collisionTurns?: number
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

  const referenceInputs = options.reference.slice(0, turns)
  const reference = play('reference', referenceInputs)
  const baselines = policies.map((policy) => {
    const inputs = policy.inputs(vocabulary, turns, seed)
    if (inputs.length !== turns) {
      throw new Error(`baseline ${policy.id} produced ${inputs.length} inputs for ${turns} turns`)
    }
    return play(policy.id, inputs)
  })

  const earnedByBaseline = new Set(baselines.flatMap((b) => b.verified))
  const order = contract.milestones.map((m) => m.id)
  const { legible, opaque, reasons } = contractLegibility(contract)
  const legibleSet = new Set(legible)
  const separating = reference.verified.filter((id) => !earnedByBaseline.has(id) && legibleSet.has(id))
  const trivial = order.filter((id) => earnedByBaseline.has(id))
  const bestBaselineCount = baselines.reduce((best, b) => Math.max(best, b.verified.length), 0)
  const legibleCount = (outcome: BaselineOutcome): number => outcome.verified.filter((id) => legibleSet.has(id)).length
  const bestBaselineLegibleCount = baselines.reduce((best, b) => Math.max(best, legibleCount(b)), 0)
  const referenceScore = scoreMilestones(contract, reference.verified)
  const referenceLegible = legibleCount(reference)

  return {
    turns,
    seed,
    vocabulary,
    reference,
    baselines,
    separating,
    trivial,
    legible,
    opaque,
    opacityReasons: reasons,
    opaqueReproduced: opaque.filter((id) => earnedByBaseline.has(id)),
    collisions: probeOpaqueCollisions(game, contract, {
      reference: referenceInputs,
      seed,
      vocabulary,
      ...(options.collisionTurns === undefined ? {} : { collisionTurns: options.collisionTurns }),
    }),
    bestBaselineCount,
    bestBaselineLegibleCount,
    referenceScore,
    separates: separating.length > 0 && referenceLegible > bestBaselineLegibleCount,
  }
}

/**
 * The opaque checks a contract is allowed to carry, and which of them the
 * author accepts as weak.
 *
 * A declaration is an exact set, not a switch. An author who pins a hash
 * writes the id down, so a hash milestone that a later derivation adds cannot
 * enter a published contract unnoticed.
 */
export interface OpacityDeclaration {
  /** Milestone ids the author accepts as opaque: stated as a hash, or gated behind one. */
  opaqueChecks?: readonly string[]
  /**
   * Opaque milestone ids the author accepts as WEAK, having read the measured
   * number: the substitution sweep found other input logs that satisfy them,
   * so the hash names a state many trajectories reach rather than one.
   */
  weakChecks?: readonly string[]
}

function earners(report: CalibrationReport, milestone: string): string {
  return report.baselines.filter((b) => b.verified.includes(milestone)).map((b) => b.id).join(', ')
}

/** One measured line about an opaque check, with every number the sweep produced. */
function collisionLine(row: OpaqueCollision): string {
  return (
    `  ${row.milestone} — ${row.collisions} of ${row.substitutions} single-input substitutions of the ` +
    `reference still satisfy it, at ${row.freeTurns} of ${row.probedTurns} probed turn(s) before it fires ` +
    `(after ${row.firesAfter} input(s)); applying one at every free turn at once ` +
    `${row.jointCollision ? 'also satisfies it' : 'does not'}, so at least ${row.family} distinct ` +
    `${row.firesAfter}-input log(s) satisfy it`
  )
}

/**
 * Every way a contract's legible/opaque split can be wrong, as message blocks.
 * An empty array means the split is sound and declared.
 */
function opacityProblems(report: CalibrationReport, declaration: OpacityDeclaration): string[] {
  const problems: string[] = []
  const { total } = report.referenceScore
  const declared = declaration.opaqueChecks
  const share = total === 0 ? 0 : Math.round((report.opaque.length / total) * 100)
  const detail = report.opaque.map((id) => `  opaque: ${id} — ${report.opacityReasons[id]}`)

  if (declared === undefined) {
    if (report.opaque.length > 0) {
      problems.push(
        [
          `contract states ${report.opaque.length} of ${total} milestone(s) as a hash ` +
            `(${report.legible.length} legible, ${share}% opaque)`,
          ...detail,
          `  the reference itself scored ${formatMilestoneScore(report.referenceScore)}, and a reader cannot ` +
            'tell what the opaque points asked for',
          'A hash check identifies a state, not a trajectory, so it is earnable — but nobody can read it.',
          `Keep it and declare it — assertContractSeparates(report, { opaqueChecks: ` +
            `[${report.opaque.map((id) => `'${id}'`).join(', ')}] }) — or state the progression with a ` +
            'state-path, save-path, frame-path, or log-contains check.',
        ].join('\n'),
      )
    }
  } else {
    const accepted = new Set(declared)
    const pinned = new Set(report.opaque)
    const undeclared = report.opaque.filter((id) => !accepted.has(id))
    const stale = [...accepted].filter((id) => !pinned.has(id))
    if (undeclared.length > 0) {
      problems.push(
        [
          `contract has ${undeclared.length} undeclared opaque milestone(s): ${undeclared.join(', ')}`,
          ...detail,
          'Declare every opaque check, or state the progression with a legible check.',
        ].join('\n'),
      )
    }
    if (stale.length > 0) {
      problems.push(
        `opaqueChecks names ${stale.length} milestone(s) the contract does not state as a hash: ${stale.join(', ')} — ` +
          'the declaration is stale, and it would hide a hash milestone added later',
      )
    }
  }

  if (report.opaqueReproduced.length > 0) {
    problems.push(
      [
        `${report.opaqueReproduced.length} opaque milestone(s) were reproduced by a trivial baseline:`,
        ...report.opaqueReproduced.map((id) => `  ${id} — reproduced by ${earners(report, id)}`),
        'A hash one constant button press satisfies demands nothing. Remove it or hash more state.',
      ].join('\n'),
    )
  }

  const acceptedWeak = new Set(declaration.weakChecks ?? [])
  const weak = report.collisions.filter((row) => row.collisions > 0)
  const undeclaredWeak = weak.filter((row) => !acceptedWeak.has(row.milestone))
  if (undeclaredWeak.length > 0) {
    problems.push(
      [
        `${undeclaredWeak.length} opaque milestone(s) are satisfied by input logs other than the reference:`,
        ...undeclaredWeak.map(collisionLine),
        'A hash a large family of logs satisfies is a weak check: it names a state many trajectories reach, ' +
          'and says so where no reader can see it. State the progression with a legible check, or accept the ' +
          `measured weakness — { weakChecks: [${undeclaredWeak.map((row) => `'${row.milestone}'`).join(', ')}] }.`,
      ].join('\n'),
    )
  }
  const staleWeak = [...acceptedWeak].filter((id) => !weak.some((row) => row.milestone === id))
  if (staleWeak.length > 0) {
    problems.push(
      `weakChecks names ${staleWeak.length} milestone(s) the sweep found no colliding log for: ${staleWeak.join(', ')} — ` +
        'the declaration is stale, and it would hide a collision measured later',
    )
  }
  return problems
}

/**
 * Fail closed on a contract whose milestones a reader cannot understand.
 *
 * Opaque checks are legitimate: a hash names an exact game state, an
 * independent policy that reaches that state earns it, and replay attestation
 * keeps its own input-log hash chain either way. They must be declared,
 * because a point nobody can read is a point nobody can audit, and a hash that
 * many logs satisfy must be declared with its measured number.
 *
 * Call this for a contract that is not meant to separate — a demonstration
 * target — where `assertContractSeparates` would fail for the other reason.
 */
export function assertOpaqueChecksDeclared(
  report: CalibrationReport,
  declaration: OpacityDeclaration = {},
): void {
  const problems = opacityProblems(report, declaration)
  if (problems.length > 0) throw new Error(problems.join('\n'))
}

/**
 * Fail closed on a contract that a trivial policy satisfies, and on one that
 * carries undeclared opaque milestones.
 *
 * Call this wherever a target is published. A contract that does not separate
 * still produces scores; those scores report how many frames elapsed, and
 * comparing two agents on them compares nothing. A contract whose points are
 * partly opaque still produces scores too, and no reader can tell what those
 * points were awarded for.
 *
 * Both failures are reported together, so one run of the gate names everything
 * an author must fix.
 */
export function assertContractSeparates(
  report: CalibrationReport,
  declaration: OpacityDeclaration = {},
): void {
  const problems = opacityProblems(report, declaration)
  if (!report.separates) {
    const best = report.baselines.filter((b) => b.verified.length === report.bestBaselineCount).map((b) => b.id)
    const referenceLegible = report.reference.verified.filter((id) => report.legible.includes(id)).length
    problems.push(
      [
        `contract does not separate: the reference verified ${report.reference.verified.length} milestone(s) ` +
          `and the best trivial baseline verified ${report.bestBaselineCount} over ${report.turns} turns ` +
          `(seed ${report.seed}, strongest: ${best.join(', ') || 'none'})`,
        `  on legible milestones alone: reference ${referenceLegible}, ` +
          `best baseline ${report.bestBaselineLegibleCount}, of ${report.legible.length} legible`,
        ...report.trivial.map((id) => `  trivial: ${id} — earned by ${earners(report, id)}`),
        `  legible and out of reach of every baseline: ${report.separating.join(', ') || 'nothing'}`,
        'A derived contract is a hypothesis until it separates. Pin a progression a trivial policy cannot reach.',
      ].join('\n'),
    )
  }
  if (problems.length > 0) throw new Error(problems.join('\n'))
}
