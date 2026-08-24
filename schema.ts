/**
 * Playproof milestone-contract schema — the game-agnostic progression language.
 *
 * A check is a statement about a game STATE. A state/save/frame path or a log
 * event states it in the open; a hash states the same kind of thing opaquely,
 * naming one exact state without saying which. Both are earnable by playing.
 * Prefer a path or an event, because a reader can then judge what the contract
 * asks for.
 */
import { createHash } from 'node:crypto'

export type EvidenceTier = 'engine-state' | 'save-file' | 'log-event' | 'screen-frame'
export type GlitchLegality = 'legal' | 'forbidden' | 'unclassified'
export type NumericOperator = '>=' | '>' | '=='

export type MilestoneCheck =
  | { kind: 'state-path'; path: string; op: NumericOperator; value: number }
  | { kind: 'save-path'; path: string; op: NumericOperator; value: number }
  | { kind: 'save-hash'; hash: string }
  | { kind: 'log-contains'; event: string }
  | { kind: 'frame-path'; path: string; op: NumericOperator; value: number }
  | { kind: 'frame-hash'; hash: string }

export interface Milestone {
  id: string
  tier: EvidenceTier
  /** Milestones this one depends on (partial order over the contract). */
  requires: string[]
  check: MilestoneCheck
  glitchClass: GlitchLegality
}

export interface MilestoneContract {
  schemaVersion: 1
  gameId: string
  milestones: Milestone[]
}

const TIER_FOR_CHECK: Record<MilestoneCheck['kind'], EvidenceTier> = {
  'state-path': 'engine-state',
  'save-path': 'save-file',
  'save-hash': 'save-file',
  'log-contains': 'log-event',
  'frame-path': 'screen-frame',
  'frame-hash': 'screen-frame',
}

/** Pure validator: returns every violation; empty array means the contract is sound. */
export function validateContract(c: MilestoneContract): string[] {
  const v: string[] = []
  if (c.schemaVersion !== 1) v.push(`schemaVersion must be 1, got ${c.schemaVersion}`)
  const ids = new Set<string>()
  for (const m of c.milestones) {
    if (ids.has(m.id)) v.push(`duplicate milestone id ${m.id}`)
    ids.add(m.id)
    if (TIER_FOR_CHECK[m.check.kind] !== m.tier) {
      v.push(`${m.id}: check kind ${m.check.kind} does not match tier ${m.tier}`)
    }
    if (m.glitchClass === 'unclassified') v.push(`${m.id}: glitch legality must be classified (legal|forbidden)`)
    if (m.glitchClass !== 'legal' && m.glitchClass !== 'forbidden') {
      v.push(`${m.id}: unknown glitchClass ${String(m.glitchClass)}`)
    }
  }
  for (const m of c.milestones) {
    for (const r of m.requires) {
      if (!ids.has(r)) v.push(`${m.id} requires unknown milestone ${r}`)
    }
  }
  if (c.milestones.length === 0) v.push('contract has no milestones')
  const declared = new Set<string>()
  for (const m of c.milestones) {
    for (const r of m.requires) {
      if (!declared.has(r)) v.push(`${m.id} requires ${r}, which is declared later — milestones must be listed in dependency order`)
    }
    declared.add(m.id)
  }
  const WHITE = 0, GREY = 1, BLACK = 2
  const color = new Map<string, number>()
  const hasCycle = (id: string, path: string[]): boolean => {
    const c0 = color.get(id) ?? WHITE
    if (c0 === GREY) { v.push(`milestone graph has a cycle: ${[...path, id].join(' -> ')}`); return true }
    if (c0 === BLACK) return false
    color.set(id, GREY)
    const m = c.milestones.find((x) => x.id === id)
    for (const r of m?.requires ?? []) {
      if (hasCycle(r, [...path, id])) return true
    }
    color.set(id, BLACK)
    return false
  }
  for (const m of c.milestones) {
    if (hasCycle(m.id, [])) break
  }
  return v
}

/** Stable JSON field order so hashes are reproducible across builds. */
export function canonicalContractJson(c: MilestoneContract): string {
  const canon = (m: Milestone): unknown => ({
    id: m.id,
    tier: m.tier,
    requires: [...m.requires].sort(),
    check: m.check,
    glitchClass: m.glitchClass,
  })
  return JSON.stringify({ schemaVersion: c.schemaVersion, gameId: c.gameId, milestones: [...c.milestones].map(canon) })
}

export function contractHash(c: MilestoneContract): string {
  return createHash('sha256').update(canonicalContractJson(c)).digest('hex')
}

/**
 * How a check states its requirement.
 *
 * `legible` — a threshold, a normalized field, or an event. A reader sees what
 * the milestone demands and can judge whether reaching it is progress.
 *
 * `opaque` — a hash. It demands one exact game state, and a reader cannot tell
 * which state, nor how many trajectories reach it. It is an achievement like
 * any other: a hash identifies a STATE, not a trajectory, so an independent
 * policy that reaches that state earns it without ever seeing the reference.
 * Measured on ALE Breakout: of 96 single-input substitutions of the reference
 * over the 32-turn prefix, 40 still reproduced both pinned hashes, at 16 of
 * the 32 turns; all 16 applied at once reproduced them too.
 *
 * Do not confuse an opaque check with replay attestation. The input-log hash
 * chain is what proves a replay reproduced a recorded run. A milestone hash
 * proves only that some run stood in one state.
 */
export type CheckLegibility = 'legible' | 'opaque'

const LEGIBILITY_FOR_CHECK: Record<MilestoneCheck['kind'], CheckLegibility> = {
  'state-path': 'legible',
  'save-path': 'legible',
  'save-hash': 'opaque',
  'log-contains': 'legible',
  'frame-path': 'legible',
  'frame-hash': 'opaque',
}

/**
 * Whether a reader can see what a check demands, derived from its kind.
 *
 * The value is derived rather than declared so that an existing contract keeps
 * its bytes and its hash, and so that an author cannot forget to set it. A
 * hash check is opaque whatever the author intended.
 */
export function checkLegibility(check: MilestoneCheck): CheckLegibility {
  return LEGIBILITY_FOR_CHECK[check.kind]
}

/** Which milestones of a contract state their requirement in the open. */
export interface ContractLegibility {
  /** Milestone ids whose requirement a reader can read off the contract. */
  legible: string[]
  /** Milestone ids whose requirement is a hash, or is gated behind one. */
  opaque: string[]
  /** Why each opaque milestone cannot be read, keyed by milestone id. */
  reasons: Record<string, string>
}

/**
 * Split a contract into the milestones a reader can understand and the ones
 * stated as a hash.
 *
 * Opacity propagates through `requires`: `MilestoneTracker` admits a milestone
 * only after every prerequisite passed, so a legible check gated behind a hash
 * still demands something a reader cannot see. A missing or cyclic requirement
 * is not judged here — `validateContract` reports those.
 */
export function contractLegibility(contract: MilestoneContract): ContractLegibility {
  const byId = new Map(contract.milestones.map((m) => [m.id, m]))
  const decided = new Map<string, string | null>()
  const visiting = new Set<string>()
  const reasonFor = (m: Milestone): string | null => {
    const cached = decided.get(m.id)
    if (cached !== undefined) return cached
    if (visiting.has(m.id)) return null
    visiting.add(m.id)
    let reason: string | null = null
    if (checkLegibility(m.check) === 'opaque') {
      reason = `its ${m.check.kind} check states its requirement as a hash, so a reader cannot see what it demands`
    } else {
      for (const required of m.requires) {
        const prerequisite = byId.get(required)
        if (prerequisite !== undefined && reasonFor(prerequisite) !== null) {
          reason = `requires ${required}, whose requirement is opaque`
          break
        }
      }
    }
    visiting.delete(m.id)
    decided.set(m.id, reason)
    return reason
  }

  const legible: string[] = []
  const opaque: string[] = []
  const reasons: Record<string, string> = {}
  for (const m of contract.milestones) {
    const reason = reasonFor(m)
    if (reason === null) legible.push(m.id)
    else {
      opaque.push(m.id)
      reasons[m.id] = reason
    }
  }
  return { legible, opaque, reasons }
}

/** A run's progress against a contract. Every milestone counts, hashes included. */
export interface MilestoneScore {
  /** Milestones the run verified. */
  verified: number
  /** Milestones of the contract. */
  total: number
}

/** Score a verified milestone set against its contract. */
export function scoreMilestones(contract: MilestoneContract, verified: readonly string[]): MilestoneScore {
  return { verified: verified.length, total: contract.milestones.length }
}

/** One line for a report or a log. */
export function formatMilestoneScore(score: MilestoneScore): string {
  return `${score.verified} of ${score.total}`
}

/**
 * What a milestone says about the run that earned it.
 *
 * `achievement` — the run made something happen. A score threshold, a level
 * reached, a state a player has to play towards.
 *
 * `attrition` — the run let a resource run down. Lives, health, shields, time
 * remaining. Such a milestone marks progress REACHED and never competence
 * shown, because the shortest path to it is to play badly. Measured on ALE
 * Breakout: a `life-lost` milestone is `lives == 4`, so a program that never
 * dies cannot score it, and two hand-written controls that differ only in how
 * well they steer ranked in the wrong order because of it. The packaged
 * Breakout contract states no such milestone for that reason.
 *
 * Recording an attrition milestone is legitimate — "the reference got far
 * enough to lose a life" is a real fact about a trajectory. Scoring it as
 * competence is not, which is why `scoreAchievements` exists next to
 * `scoreMilestones`.
 */
export type ProgressionKind = 'achievement' | 'attrition'

/**
 * How one numeric evidence channel moved across the measured trajectories.
 *
 * A channel is one key of one evidence map, named `engineState.lives` or
 * `frameState.activeCells`. The counts are over every step of every measured
 * trajectory, so `rises` 0 with `falls` above 0 is the measured statement
 * "this channel is a resource that only runs down".
 */
export interface ChannelMotion {
  /** `<map>.<key>`, for example `engineState.lives`. */
  channel: string
  /** Value at the initial state, or null when the trajectories disagreed. */
  initial: number | null
  /** Steps where the value was greater than the step before. */
  rises: number
  /** Steps where the value was less than the step before. */
  falls: number
  min: number
  max: number
  /** Trajectories that published the channel at least once. */
  trajectories: number
  /** Snapshots the counts are over. */
  samples: number
}

/**
 * Every milestone of one contract, split by what earning it demonstrates.
 *
 * The split is MEASURED, never declared in the contract, for the same reason
 * legibility is derived: an existing contract keeps its bytes and its hash, and
 * an author cannot forget to set it. `measureProgressions` in calibration.ts
 * produces this from the motion of the channels the engine already publishes.
 * Nothing here reads a field name, so an adapter that spells its life counter
 * `shields` or `hull` is classified on the same evidence as one that spells it
 * `lives`.
 */
export interface ProgressionProfile {
  gameId: string
  /** Every milestone of the contract, classified. */
  kinds: Record<string, ProgressionKind>
  /** Milestones that demonstrate something, in contract order. */
  achievement: string[]
  /** Milestones earned by a resource going down, in contract order. */
  attrition: string[]
  /**
   * Milestones no numeric channel could speak for — a hash, a log event, or a
   * path the measured trajectories never published. They count as achievements,
   * because attrition is a positive finding and this is the absence of one.
   * The list exists so a reader sees the limit of the measurement.
   */
  unmeasured: string[]
  /** Why each milestone is classified as it is, keyed by milestone id. */
  reasons: Record<string, string>
  /** Every channel the measurement watched, in first-seen order. */
  motion: ChannelMotion[]
}

function assertProfileMatches(contract: MilestoneContract, profile: ProgressionProfile): void {
  if (profile.gameId !== contract.gameId) {
    throw new Error(`progression profile is for "${profile.gameId}" but the contract is for "${contract.gameId}"`)
  }
  const missing = contract.milestones.filter((m) => profile.kinds[m.id] === undefined).map((m) => m.id)
  if (missing.length > 0) {
    throw new Error(`progression profile does not classify ${missing.join(', ')} — re-measure it against this contract`)
  }
}

/**
 * Score a run over the achievement milestones alone.
 *
 * Both the numerator and the denominator drop the attrition milestones, so two
 * runs compared on this number are compared on what they made happen. A run
 * that also lost a life is neither rewarded nor punished for it. Read
 * `scoreMilestones` for the whole contract when the question is how far the run
 * got rather than how well it played.
 */
export function scoreAchievements(
  contract: MilestoneContract,
  profile: ProgressionProfile,
  verified: readonly string[],
): MilestoneScore {
  assertProfileMatches(contract, profile)
  const achievement = new Set(contract.milestones.map((m) => m.id).filter((id) => profile.kinds[id] === 'achievement'))
  return { verified: verified.filter((id) => achievement.has(id)).length, total: achievement.size }
}

/**
 * How much of a contract hangs off one milestone.
 *
 * `requires` is a partial order, so a contract can state five progressions and
 * still demand exactly one event: if every other milestone requires the first,
 * a run that misses the first scores zero however well it played. That is one
 * bit of resolution wearing five milestones. Measured on the packaged
 * contracts: stable-retro Airstriker gates 5 of 5 milestones behind its
 * `score-opened`. The packaged ALE Breakout contract gated 6 of 6 behind its
 * own and now chains nothing: its checks read a counter that never falls, so a
 * `requires` edge would restate the check and report a collapse that a
 * seven-rung ladder does not have.
 *
 * This structure says nothing about how hard the prerequisite is. Whether a
 * trivial baseline earns it is a measurement, and `calibrateContract` reports
 * that as `collapse`.
 */
export interface ContractGate {
  /** The milestone the largest share of the contract requires, transitively. */
  prerequisite: string | null
  /** Milestones that require it, transitively, counting the prerequisite itself. */
  gated: number
  /** Those milestone ids, in contract order. */
  gatedMilestones: string[]
  total: number
}

/**
 * The milestone the largest share of a contract depends on.
 *
 * Ties are broken by contract order, so the answer is stable. A contract where
 * no milestone requires another has no prerequisite and `gated` 0: nothing is
 * chained, so nothing can collapse. A missing or cyclic requirement is not
 * judged here — `validateContract` reports those, and the walk below stops on a
 * cycle instead of looping.
 */
export function contractGate(contract: MilestoneContract): ContractGate {
  const total = contract.milestones.length
  const byId = new Map(contract.milestones.map((m) => [m.id, m]))
  const closure = new Map<string, Set<string>>()
  const requiredBy = (id: string, seen: Set<string>): Set<string> => {
    const cached = closure.get(id)
    if (cached !== undefined) return cached
    if (seen.has(id)) return new Set()
    seen.add(id)
    const all = new Set<string>()
    for (const required of byId.get(id)?.requires ?? []) {
      if (!byId.has(required)) continue
      all.add(required)
      for (const deeper of requiredBy(required, seen)) all.add(deeper)
    }
    seen.delete(id)
    closure.set(id, all)
    return all
  }

  let best: ContractGate = { prerequisite: null, gated: 0, gatedMilestones: [], total }
  for (const candidate of contract.milestones) {
    const dependents = contract.milestones
      .filter((m) => m.id === candidate.id || requiredBy(m.id, new Set()).has(candidate.id))
      .map((m) => m.id)
    if (dependents.length > best.gated && dependents.length > 1) {
      best = { prerequisite: candidate.id, gated: dependents.length, gatedMilestones: dependents, total }
    }
  }
  return best
}
