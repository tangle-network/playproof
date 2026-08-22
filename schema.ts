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
