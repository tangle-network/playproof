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
 * The third measurement is what a milestone says about the run that earned it.
 * A milestone earned by a monotone-decreasing resource going down marks
 * progress REACHED and never competence shown, because the shortest path to it
 * is to play badly. `measureProgressions` derives that split from the motion of
 * the channels the engine already publishes; it reads no field name, so an
 * adapter that spells its life counter `shields` is classified on the same
 * evidence as one that spells it `lives`. `separating` and `separates` count
 * achievement milestones only, and the rest is recorded in
 * `attritionSeparating`.
 *
 * The fourth is how much of a contract hangs off one milestone. `requires` is a
 * partial order, so a contract can state six progressions and still demand
 * exactly one event. `report.collapse` states the structure with the number,
 * whether a trivial baseline reaches the prerequisite, and how many milestones
 * first pass at one instant of the reference.
 *
 * `PackagedContract` closes the last hole. Running any of this was optional,
 * and an optional gate is a gate nothing has to pass: the packaged Airstriker
 * contract reported `separates: false` with an empty separating set and shipped
 * anyway. `PackagedContract.calibrate` is the only way to build that type, and
 * it runs the whole gate.
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
import type { Evidence, Game } from './runtime'
import { contractGate, contractHash, contractLegibility, formatMilestoneScore, scoreAchievements, scoreMilestones } from './schema'
import type {
  ContractGate,
  MilestoneCheck,
  MilestoneContract,
  MilestoneScore,
  NumericOperator,
  ProgressionKind,
  ProgressionProfile,
} from './schema'

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
 * Measured on a Breakout contract whose two hashes fire after 32 inputs over
 * the vocabulary NOOP/FIRE/RIGHT/LEFT: 56 of the 96 single-input substitutions
 * still reproduced both hashes, at 21 of the 32 turns. `FIRE` while the ball is
 * already in flight is a state no-op, so those logs reach a bit-identical
 * emulator state. That number is why the packaged Breakout contract states no
 * hash at all: the check names a state half a trillion 32-input logs can stand
 * in, and no independent control ever reached it.
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

/**
 * The evidence map each numeric check reads. A check outside this table names
 * no numeric channel, so no resource motion can be measured for it.
 */
const NUMERIC_MAP_FOR_CHECK: Partial<Record<MilestoneCheck['kind'], 'engineState' | 'saveState' | 'frameState'>> = {
  'state-path': 'engineState',
  'save-path': 'saveState',
  'frame-path': 'frameState',
}

/** `<map>.<key>` for a numeric check, or null when the check reads no channel. */
function checkChannel(check: MilestoneCheck): string | null {
  const map = NUMERIC_MAP_FOR_CHECK[check.kind]
  if (map === undefined) return null
  return `${map}.${'path' in check ? check.path : ''}`
}

/** Every numeric channel one evidence snapshot publishes, flattened to `<map>.<key>`. */
function channelValues(evidence: Evidence): Map<string, number> {
  const values = new Map<string, number>()
  for (const map of ['engineState', 'saveState', 'frameState'] as const) {
    const fields = evidence[map]
    if (fields === undefined) continue
    for (const [key, value] of Object.entries(fields)) {
      if (typeof value === 'number' && Number.isFinite(value)) values.set(`${map}.${key}`, value)
    }
  }
  return values
}

interface MutableMotion {
  channel: string
  initial: number | null
  initialSeen: boolean
  rises: number
  falls: number
  min: number
  max: number
  trajectories: number
  samples: number
}

function numericHolds(op: NumericOperator, value: number, expected: number): boolean {
  if (op === '>=') return value >= expected
  if (op === '>') return value > expected
  return value === expected
}

export interface ProgressionOptions {
  /**
   * Input scripts to replay and watch. The useful set is the reference plus
   * every trivial baseline, which is what `calibrateContract` passes: a channel
   * that only falls on the reference but rises under a baseline is not a
   * resource, and one trajectory would not have shown it.
   */
  trajectories: readonly (readonly string[])[]
  /** Replay seed for every trajectory. Default 0. */
  seed?: number
}

/**
 * Classify every milestone of a contract as an achievement or as attrition, by
 * watching how the channels move.
 *
 * The rule reads no field name. A milestone is attrition when all three of
 * these measured statements hold:
 *
 *   1. its check reads a numeric channel of the evidence;
 *   2. that channel never rose and fell at least once, over every snapshot of
 *      every measured trajectory — it is a resource that only runs down;
 *   3. the check does not hold at the initial value of that channel, so the
 *      only way to earn it is to let the resource run down.
 *
 * Anything else is an achievement, including a hash, a log event, and a channel
 * the trajectories never published: attrition is a positive finding, and the
 * absence of one is not evidence of the opposite. Those milestones are listed
 * in `unmeasured` so a reader sees where the measurement stopped.
 *
 * Attrition propagates through `requires`, because `MilestoneTracker` admits a
 * milestone only after every prerequisite passed: a milestone gated behind a
 * lost life needs a lost life, whatever its own check reads.
 *
 * A hardcoded list of names would have missed the same way `over()` once did.
 * ALE spells its terminal flag `terminal`, Gymnasium `terminated`, stable-retro
 * `episodeDone`; a life counter is `lives` on Atari and something else on the
 * next substrate. Motion is the thing every engine has in common.
 */
export function measureProgressions<S>(
  game: Game<S>,
  contract: MilestoneContract,
  options: ProgressionOptions,
): ProgressionProfile {
  const seed = options.seed ?? 0
  const motion = new Map<string, MutableMotion>()
  const see = (channel: string, value: number, first: boolean): MutableMotion => {
    let row = motion.get(channel)
    if (row === undefined) {
      row = {
        channel, initial: null, initialSeen: false, rises: 0, falls: 0,
        min: value, max: value, trajectories: 0, samples: 0,
      }
      motion.set(channel, row)
    }
    row.samples += 1
    row.min = Math.min(row.min, value)
    row.max = Math.max(row.max, value)
    if (first) {
      row.trajectories += 1
      // The initial value must be one number for the classification to mean
      // anything. A game whose init() is not pure disagrees with itself here,
      // and every milestone on that channel falls back to unmeasured.
      if (!row.initialSeen) {
        row.initial = value
        row.initialSeen = true
      } else if (row.initial !== value) {
        row.initial = null
      }
    }
    return row
  }

  for (const inputs of options.trajectories) {
    let state = game.init(seed)
    let previous = channelValues(game.evidence(state))
    for (const [channel, value] of previous) see(channel, value, true)
    for (const input of inputs) {
      state = game.step(state, input)
      const current = channelValues(game.evidence(state))
      for (const [channel, value] of current) {
        const row = see(channel, value, false)
        const before = previous.get(channel)
        if (before === undefined) continue
        if (value > before) row.rises += 1
        if (value < before) row.falls += 1
      }
      previous = current
    }
  }

  const kinds: Record<string, ProgressionKind> = {}
  const reasons: Record<string, string> = {}
  const unmeasured: string[] = []
  const runs = options.trajectories.length
  for (const milestone of contract.milestones) {
    const channel = checkChannel(milestone.check)
    const row = channel === null ? undefined : motion.get(channel)
    if (channel === null) {
      kinds[milestone.id] = 'achievement'
      reasons[milestone.id] = `its ${milestone.check.kind} check reads no numeric channel, so no resource motion could be measured`
      unmeasured.push(milestone.id)
      continue
    }
    if (row === undefined || row.initial === null) {
      kinds[milestone.id] = 'achievement'
      reasons[milestone.id] = row === undefined
        ? `no measured trajectory published ${channel}, so no resource motion could be measured`
        : `${channel} started at a different value on different trajectories, so no resource motion could be measured`
      unmeasured.push(milestone.id)
      continue
    }
    const check = milestone.check
    const expected = 'value' in check ? check.value : 0
    const op: NumericOperator = 'op' in check ? check.op : '>='
    const holdsAtStart = numericHolds(op, row.initial, expected)
    const onlyFalls = row.rises === 0 && row.falls > 0
    if (onlyFalls && !holdsAtStart) {
      kinds[milestone.id] = 'attrition'
      reasons[milestone.id] =
        `its ${check.kind} check reads ${channel}, which fell ${row.falls} time(s) and never rose over ` +
        `${row.trajectories} of ${runs} measured trajectory(ies); "${op} ${expected}" does not hold at its ` +
        `initial value ${row.initial}, so the only way to earn it is to let the resource run down`
      continue
    }
    kinds[milestone.id] = 'achievement'
    reasons[milestone.id] = onlyFalls
      ? `its ${check.kind} check on ${channel} already holds at the initial value ${row.initial}, so it needs no resource to run down`
      : row.rises > 0
        ? `its ${check.kind} check reads ${channel}, which rose ${row.rises} time(s) over ${row.trajectories} of ${runs} measured trajectory(ies)`
        : `its ${check.kind} check reads ${channel}, which never moved over ${row.trajectories} of ${runs} measured trajectory(ies)`
  }

  // Attrition propagates the way opacity does: the tracker admits a milestone
  // only after every prerequisite passed.
  const byId = new Map(contract.milestones.map((m) => [m.id, m]))
  const visiting = new Set<string>()
  const inherit = (id: string): void => {
    if (kinds[id] === 'attrition' || visiting.has(id)) return
    visiting.add(id)
    for (const required of byId.get(id)?.requires ?? []) {
      if (!byId.has(required)) continue
      inherit(required)
      if (kinds[required] === 'attrition') {
        kinds[id] = 'attrition'
        reasons[id] = `requires ${required}, which a resource running down earns`
        break
      }
    }
    visiting.delete(id)
  }
  for (const milestone of contract.milestones) inherit(milestone.id)

  const order = contract.milestones.map((m) => m.id)
  return {
    gameId: contract.gameId,
    kinds,
    achievement: order.filter((id) => kinds[id] === 'achievement'),
    attrition: order.filter((id) => kinds[id] === 'attrition'),
    unmeasured: unmeasured.filter((id) => kinds[id] !== 'attrition'),
    reasons,
    motion: [...motion.values()].map((row) => ({
      channel: row.channel,
      initial: row.initial,
      rises: row.rises,
      falls: row.falls,
      min: row.min,
      max: row.max,
      trajectories: row.trajectories,
      samples: row.samples,
    })),
  }
}

/**
 * How much of a contract hangs off one milestone, and who reaches that
 * milestone.
 *
 * `ContractGate` states the structure; these fields add the measurement that
 * says what the structure costs. A contract every milestone of which requires
 * one event resolves runs into two classes and no more: those that reached the
 * event, and those that scored zero.
 */
export interface ContractCollapse extends ContractGate {
  /** Baseline ids that earned the prerequisite. Empty means no trivial policy reached it. */
  earnedByBaseline: string[]
  /** Whether the reference itself earned the prerequisite. */
  earnedByReference: boolean
  /** Reference inputs consumed before each milestone first passed; -1 when it never passed. */
  firstPassAt: Record<string, number>
  /**
   * The largest set of milestones that first passed at the SAME reference
   * input, in contract order.
   *
   * This is the second way a contract counts one event more than once, and it
   * is independent of `requires`. Measured on stable-retro Airstriker: three of
   * its five milestones open at one input. Three milestone ids for one moment of
   * play is three points of a score that a run either has all of or none of.
   * The packaged ALE Breakout contract used to open three at input 32 and now
   * opens its seven rungs at seven distinct inputs.
   */
  simultaneous: string[]
  /** The input index those milestones share, or -1 when no two share one. */
  simultaneousAfter: number
  /**
   * Whether every milestone of the contract requires one milestone. A contract
   * of one milestone cannot collapse, because there is nothing to chain.
   */
  collapses: boolean
}

export interface CalibrationReport {
  turns: number
  seed: number
  vocabulary: string[]
  reference: BaselineOutcome
  baselines: BaselineOutcome[]
  /**
   * Legible ACHIEVEMENT milestones the reference reached and no baseline did —
   * the whole of the contract's discriminating power.
   *
   * Two exclusions, for two different reasons. An opaque milestone is excluded
   * even when no baseline earned it, because a reader cannot see what it
   * demands. An attrition milestone is excluded even when no baseline earned
   * it, because the run that earns it is the run that let a resource run down,
   * and "the reference lost a life and the baselines did not" is not a claim
   * about skill. Attrition milestones that would otherwise have separated are
   * kept in `attritionSeparating`, so nothing measured is thrown away.
   */
  separating: string[]
  /**
   * Milestones the reference reached and no baseline did, that a resource
   * running down earns. They are recorded, never counted as separation.
   */
  attritionSeparating: string[]
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
  /** the reference's own progress over the whole contract */
  referenceScore: MilestoneScore
  /**
   * The strongest baseline's count over LEGIBLE ACHIEVEMENT milestones. This is
   * the number a reference must beat, because neither an opaque milestone nor
   * an attrition milestone can carry the claim.
   */
  bestBaselineAchievementCount: number
  /** the reference's progress over the achievement milestones alone */
  referenceAchievementScore: MilestoneScore
  /**
   * Which milestones demonstrate something and which a resource running down
   * earns, measured over the reference and every baseline.
   */
  progression: ProgressionProfile
  /** How much of the contract hangs off one milestone, and who reaches it. */
  collapse: ContractCollapse
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
  const scripts = policies.map((policy) => {
    const inputs = policy.inputs(vocabulary, turns, seed)
    if (inputs.length !== turns) {
      throw new Error(`baseline ${policy.id} produced ${inputs.length} inputs for ${turns} turns`)
    }
    return { policy, inputs }
  })
  const reference = play('reference', referenceInputs)
  const baselines = scripts.map(({ policy, inputs }) => play(policy.id, inputs))

  // The achievement/attrition split is measured over every trajectory this
  // report already names, not over the reference alone: a channel that only
  // falls under the reference but rises under one baseline is not a resource,
  // and a single trajectory would not have shown it.
  const progression = measureProgressions(game, contract, {
    trajectories: [referenceInputs, ...scripts.map(({ inputs }) => inputs)],
    seed,
  })

  const earnedByBaseline = new Set(baselines.flatMap((b) => b.verified))
  const order = contract.milestones.map((m) => m.id)
  const { legible, opaque, reasons } = contractLegibility(contract)
  const legibleSet = new Set(legible)
  const isAchievement = (id: string): boolean => progression.kinds[id] === 'achievement'
  const outOfReach = reference.verified.filter((id) => !earnedByBaseline.has(id) && legibleSet.has(id))
  const separating = outOfReach.filter(isAchievement)
  const attritionSeparating = reference.verified.filter((id) => !earnedByBaseline.has(id) && !isAchievement(id))
  const trivial = order.filter((id) => earnedByBaseline.has(id))
  const bestBaselineCount = baselines.reduce((best, b) => Math.max(best, b.verified.length), 0)
  const countIn = (outcome: BaselineOutcome, keep: (id: string) => boolean): number => outcome.verified.filter(keep).length
  const isLegible = (id: string): boolean => legibleSet.has(id)
  const isLegibleAchievement = (id: string): boolean => isLegible(id) && isAchievement(id)
  const bestBaselineLegibleCount = baselines.reduce((best, b) => Math.max(best, countIn(b, isLegible)), 0)
  const bestBaselineAchievementCount = baselines.reduce((best, b) => Math.max(best, countIn(b, isLegibleAchievement)), 0)
  const referenceScore = scoreMilestones(contract, reference.verified)
  const referenceAchievementScore = scoreAchievements(contract, progression, reference.verified)
  const referenceAchievement = countIn(reference, isLegibleAchievement)

  const gate = contractGate(contract)
  const firstPass = firstPassTurn(game, contract, seed, referenceInputs)
  const firstPassAt: Record<string, number> = {}
  const sharing = new Map<number, string[]>()
  for (const id of order) {
    const turn = firstPass.get(id) ?? -1
    firstPassAt[id] = turn
    if (turn >= 0) sharing.set(turn, [...(sharing.get(turn) ?? []), id])
  }
  let simultaneous: string[] = []
  let simultaneousAfter = -1
  for (const [turn, ids] of sharing) {
    if (ids.length > simultaneous.length) {
      simultaneous = ids
      simultaneousAfter = turn
    }
  }
  const collapse: ContractCollapse = {
    ...gate,
    earnedByBaseline: gate.prerequisite === null
      ? []
      : baselines.filter((b) => b.verified.includes(gate.prerequisite!)).map((b) => b.id),
    earnedByReference: gate.prerequisite !== null && reference.verified.includes(gate.prerequisite),
    firstPassAt,
    simultaneous: simultaneous.length > 1 ? simultaneous : [],
    simultaneousAfter: simultaneous.length > 1 ? simultaneousAfter : -1,
    collapses: gate.prerequisite !== null && gate.gated === gate.total && gate.total > 1,
  }

  return {
    turns,
    seed,
    vocabulary,
    reference,
    baselines,
    separating,
    attritionSeparating,
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
    bestBaselineAchievementCount,
    referenceScore,
    referenceAchievementScore,
    progression,
    collapse,
    separates: separating.length > 0 && referenceAchievement > bestBaselineAchievementCount,
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

/**
 * Everything a contract author must have read and accepted before the contract
 * is published, beyond the opaque checks.
 *
 * Every field is an exact set or an exact id, never a switch, for the reason
 * `opaqueChecks` is: a finding that a later derivation introduces must not
 * enter a published contract under a declaration written for an earlier one.
 * A stale declaration fails the gate as loudly as a missing one.
 */
export interface ContractDeclaration extends OpacityDeclaration {
  /**
   * Milestone ids the author accepts as attrition: a resource running down
   * earns them, so they are recorded and never scored as competence.
   */
  attritionChecks?: readonly string[]
  /**
   * The milestone the author accepts the whole contract hangs off. Declaring it
   * states that one event decides whether a run scores anything at all.
   */
  gatedBehind?: string
}

/**
 * What `PackagedContract.calibrate` accepts on top of the contract declaration.
 */
export interface PackageDeclaration extends ContractDeclaration {
  /**
   * Why this target is not meant to separate, in the author's words.
   *
   * A tier demonstration and a smoke fixture exist to exercise the machinery,
   * not to grade an agent, and forcing them to separate would mean inventing a
   * difficulty they do not have. The field is a sentence rather than a boolean
   * so the reason travels with the package, and it is refused when the contract
   * DOES separate, so it cannot sit in a target that outgrew it.
   */
  nonSeparating?: string
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
 * Every way a contract's progression split can be wrong, as message blocks.
 * An empty array means every attrition milestone is declared.
 */
function progressionProblems(report: CalibrationReport, declaration: ContractDeclaration): string[] {
  const problems: string[] = []
  const { attrition, reasons } = report.progression
  const declared = declaration.attritionChecks
  const accepted = new Set(declared ?? [])
  const undeclared = attrition.filter((id) => !accepted.has(id))
  const { total } = report.referenceScore
  if (undeclared.length > 0) {
    problems.push(
      [
        `contract states ${attrition.length} of ${total} milestone(s) that a resource running down earns ` +
          `(${undeclared.length} undeclared):`,
        ...undeclared.map((id) => `  attrition: ${id} — ${reasons[id]}`),
        `  the reference scored ${formatMilestoneScore(report.referenceScore)} over the whole contract and ` +
          `${formatMilestoneScore(report.referenceAchievementScore)} over its achievements alone`,
        ...(report.attritionSeparating.length > 0
          ? [
            `  ${report.attritionSeparating.join(', ')} separated the reference from every baseline, and no ` +
              'longer counts towards separation',
          ]
          : []),
        'Such a milestone marks progress REACHED and never competence shown: the shortest path to it is to play badly.',
        `Keep it and declare it — { attritionChecks: [${undeclared.map((id) => `'${id}'`).join(', ')}] } — so it is ` +
          'recorded and scored by scoreMilestones but not by scoreAchievements, or pin a progression that a ' +
          'better run reaches.',
      ].join('\n'),
    )
  }
  const stale = [...accepted].filter((id) => !attrition.includes(id))
  if (stale.length > 0) {
    problems.push(
      `attritionChecks names ${stale.length} milestone(s) the measurement did not classify as attrition: ` +
        `${stale.join(', ')} — the declaration is stale, and it would hide an attrition milestone measured later`,
    )
  }
  return problems
}

/**
 * Whether the contract resolves runs on one event, as message blocks.
 * An empty array means nothing collapses, or the author declared the structure.
 */
function collapseProblems(report: CalibrationReport, declaration: ContractDeclaration): string[] {
  const problems: string[] = []
  const { collapse } = report
  const declared = declaration.gatedBehind
  if (collapse.collapses && declared !== collapse.prerequisite) {
    const free = collapse.earnedByBaseline
    problems.push(
      [
        `contract collapses to one event: ${collapse.gated} of ${collapse.total} milestone(s) require ` +
          `${collapse.prerequisite}, so the contract resolves a run into two classes and no more`,
        `  gated by ${collapse.prerequisite}: ${collapse.gatedMilestones.filter((id) => id !== collapse.prerequisite).join(', ')}`,
        free.length > 0
          ? `  ${collapse.prerequisite} is earned by ${free.length} of ${report.baselines.length} trivial baseline(s) ` +
            `(${free.join(', ')}), so the whole contract opens for free and grades only what follows a free event`
          : `  ${collapse.prerequisite} is out of reach of all ${report.baselines.length} trivial baseline(s), so a run ` +
            `that misses it scores 0 of ${collapse.total} however well it played`,
        ...(collapse.simultaneous.length > 1
          ? [
            `  ${collapse.simultaneous.length} of ${collapse.total} milestone(s) first pass at the same reference ` +
              `input (after ${collapse.simultaneousAfter}): ${collapse.simultaneous.join(', ')} — one moment of play ` +
              'wearing several milestone ids',
          ]
          : []),
        'A contract that grades on one event has one bit of resolution, whatever its milestone count says.',
        `Pin a progression that does not require ${collapse.prerequisite}, or declare the structure — ` +
          `{ gatedBehind: '${collapse.prerequisite}' }.`,
      ].join('\n'),
    )
  }
  if (declared !== undefined && declared !== collapse.prerequisite) {
    problems.push(
      `gatedBehind names ${declared}, which ${collapse.prerequisite === null
        ? 'no milestone of this contract requires'
        : `is not the milestone the contract hangs off (${collapse.prerequisite} gates ${collapse.gated} of ${collapse.total})`
      } — the declaration is stale`,
    )
  }
  return problems
}

/** Every finding an author must have read, whatever gate they called. */
function contractProblems(report: CalibrationReport, declaration: ContractDeclaration): string[] {
  return [
    ...opacityProblems(report, declaration),
    ...progressionProblems(report, declaration),
    ...collapseProblems(report, declaration),
  ]
}

/** The message block for a contract a trivial policy keeps up with. */
function separationProblem(report: CalibrationReport): string {
  const best = report.baselines.filter((b) => b.verified.length === report.bestBaselineCount).map((b) => b.id)
  const referenceLegible = report.reference.verified.filter((id) => report.legible.includes(id)).length
  const legibleAchievements = report.legible.filter((id) => report.progression.kinds[id] === 'achievement')
  const referenceAchievement = report.reference.verified.filter((id) => legibleAchievements.includes(id)).length
  return [
    `contract does not separate: the reference verified ${report.reference.verified.length} milestone(s) ` +
      `and the best trivial baseline verified ${report.bestBaselineCount} over ${report.turns} turns ` +
      `(seed ${report.seed}, strongest: ${best.join(', ') || 'none'})`,
    `  on legible milestones alone: reference ${referenceLegible}, ` +
      `best baseline ${report.bestBaselineLegibleCount}, of ${report.legible.length} legible`,
    `  on legible achievements alone: reference ${referenceAchievement}, ` +
      `best baseline ${report.bestBaselineAchievementCount}, of ${legibleAchievements.length} legible achievement(s)`,
    ...report.trivial.map((id) => `  trivial: ${id} — earned by ${earners(report, id)}`),
    ...report.attritionSeparating.map(
      (id) => `  out of reach of every baseline but not evidence of skill: ${id} — ${report.progression.reasons[id]}`,
    ),
    `  legible, an achievement, and out of reach of every baseline: ${report.separating.join(', ') || 'nothing'}`,
    'A derived contract is a hypothesis until it separates. Pin a progression a trivial policy cannot reach.',
  ].join('\n')
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
  declaration: ContractDeclaration = {},
): void {
  const problems = contractProblems(report, declaration)
  if (!report.separates) problems.push(separationProblem(report))
  if (problems.length > 0) throw new Error(problems.join('\n'))
}

/**
 * A contract that has passed the gate, with the numbers that let it through.
 *
 * The type exists because running calibration was optional, and an optional
 * gate is a gate nothing has to pass. Measured on stable-retro Airstriker: the
 * packaged contract reported `separates: false` with an empty separating set,
 * and it shipped anyway, because nothing in the path from `deriveContract` to a
 * published target ever asked. A screen-blind `B, NOOP, B, NOOP` program earned
 * all four legible milestones, the same four the reference earned.
 *
 * There is one way to build this value, and it runs the gate. The class carries
 * a private field, so an object literal of the right shape is not assignable to
 * it, and the constructor is private, so `new` is not available either. A
 * target that hands out a `PackagedContract` has been calibrated; a target that
 * hands out a bare `MilestoneContract` has not, and now says so in its type.
 *
 * The report travels with the contract on purpose. A published number should
 * carry the measurement that justified it, and a reader of a target can ask
 * what the baselines scored without re-running an emulator.
 */
export class PackagedContract {
  /**
   * Nominal brand. It has no other purpose: a private field makes an object
   * literal of the same shape unassignable, so this type cannot be forged.
   */
  readonly #calibrated = true

  private constructor(
    /** The contract itself, byte for byte as it was derived. */
    readonly contract: MilestoneContract,
    /** `contractHash(contract)` at the moment the gate passed. */
    readonly hash: string,
    /** Every number the gate read. */
    readonly report: CalibrationReport,
    /** What the author read and accepted. */
    readonly declaration: PackageDeclaration,
  ) {}

  /**
   * Calibrate a contract and refuse to package it unless it is justified.
   *
   * Every finding `assertContractSeparates` reports is refused here too:
   * undeclared opaque checks, an opaque check a baseline reproduced, a hash a
   * family of logs satisfies, an undeclared attrition milestone, and a contract
   * every milestone of which requires one event.
   *
   * `nonSeparating` is the escape hatch, and it is the same shape as
   * `opaqueChecks`: an explicit statement, refused when it is stale. A target
   * that declares itself non-separating and then separates fails, because the
   * declaration would otherwise outlive the reason for it.
   */
  static calibrate<S>(
    game: Game<S>,
    contract: MilestoneContract,
    options: CalibrateOptions & { declare?: PackageDeclaration },
  ): PackagedContract {
    const declaration = options.declare ?? {}
    const report = calibrateContract(game, contract, options)
    const problems = contractProblems(report, declaration)
    const excuse = declaration.nonSeparating
    if (excuse === undefined) {
      if (!report.separates) {
        problems.push(
          `${separationProblem(report)}\n` +
            'A target that is not meant to separate — a tier demonstration, a smoke fixture — says so: ' +
            "{ nonSeparating: '<why>' }.",
        )
      }
    } else if (excuse.trim().length === 0) {
      problems.push('nonSeparating must state why this target is not meant to separate; an empty reason declares nothing')
    } else if (report.separates) {
      problems.push(
        `nonSeparating says "${excuse}", but the contract separates: the reference reached ` +
          `${report.separating.join(', ')} and no trivial baseline did — the declaration is stale, and it ` +
          'would hide a later regression that stopped it separating',
      )
    }
    if (problems.length > 0) throw new Error(problems.join('\n'))
    return new PackagedContract(contract, contractHash(contract), report, declaration)
  }
}
