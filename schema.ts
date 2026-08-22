/**
 * Playproof milestone-contract schema — the game-agnostic progression language.
 *
 * Exact hashes remain available for identity checkpoints. Semantic milestones
 * should prefer normalized state/save/frame paths so two different valid ways
 * of reaching the same progress do not collapse to one reference trajectory.
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
 * What a milestone's check can prove.
 *
 * `achievement` — a threshold, a normalized field, or an event that an
 * independent policy reaches by playing. Two different valid trajectories can
 * both satisfy it.
 *
 * `identity` — a hash over the exact bytes one recorded run produced. It proves
 * that a replay reproduced that run, which is what replay attestation is for.
 * It is not a progression: earning it means reproducing the reference's frame
 * or save, not playing well.
 */
export type MilestoneRole = 'achievement' | 'identity'

const ROLE_FOR_CHECK: Record<MilestoneCheck['kind'], MilestoneRole> = {
  'state-path': 'achievement',
  'save-path': 'achievement',
  'save-hash': 'identity',
  'log-contains': 'achievement',
  'frame-path': 'achievement',
  'frame-hash': 'identity',
}

/**
 * The role a check carries, derived from its kind.
 *
 * The role is derived rather than declared so that an existing contract keeps
 * its bytes and its hash, and so that an author cannot forget to set it. A
 * hash check is an identity check whatever the author intended.
 */
export function checkRole(check: MilestoneCheck): MilestoneRole {
  return ROLE_FOR_CHECK[check.kind]
}

/** Which milestones of a contract an independent policy can earn. */
export interface ContractEarnability {
  /** Milestone ids an independent policy can earn by playing. */
  earnable: string[]
  /** Milestone ids only a replay of the reference run earns. */
  unearnable: string[]
  /** Why each unearnable milestone is out of reach, keyed by milestone id. */
  reasons: Record<string, string>
}

/**
 * Split a contract into the milestones a policy can earn and the ones it cannot.
 *
 * A milestone is unearnable when its own check pins exact bytes, and also when
 * it depends on one that does: `MilestoneTracker` admits a milestone only after
 * every prerequisite has passed, so an achievement gated behind a hash is as
 * unreachable as the hash. A milestone with a missing or cyclic requirement is
 * unearnable for the same reason — no run ever satisfies it.
 */
export function contractEarnability(contract: MilestoneContract): ContractEarnability {
  const byId = new Map(contract.milestones.map((m) => [m.id, m]))
  const decided = new Map<string, string | null>()
  const visiting = new Set<string>()
  const reasonFor = (m: Milestone): string | null => {
    const cached = decided.get(m.id)
    if (cached !== undefined) return cached
    if (visiting.has(m.id)) return `sits on a dependency cycle, so no run satisfies it`
    visiting.add(m.id)
    let reason: string | null = null
    if (checkRole(m.check) === 'identity') {
      reason = `its ${m.check.kind} check pins the reference run's exact bytes`
    } else {
      for (const required of m.requires) {
        const prerequisite = byId.get(required)
        if (prerequisite === undefined) {
          reason = `requires ${required}, which the contract does not declare`
          break
        }
        if (reasonFor(prerequisite) !== null) {
          reason = `requires ${required}, which no independent policy can earn`
          break
        }
      }
    }
    visiting.delete(m.id)
    decided.set(m.id, reason)
    return reason
  }

  const earnable: string[] = []
  const unearnable: string[] = []
  const reasons: Record<string, string> = {}
  for (const m of contract.milestones) {
    const reason = reasonFor(m)
    if (reason === null) earnable.push(m.id)
    else {
      unearnable.push(m.id)
      reasons[m.id] = reason
    }
  }
  return { earnable, unearnable, reasons }
}

/**
 * A run's progress against a contract, with the earnable denominator separated
 * from the total.
 *
 * `earned` over `earnable` is the score a run may be compared on. `verified`
 * over `total` includes the replay-identity checks, which only a replay of the
 * reference reproduces.
 */
export interface MilestoneScore {
  /** Milestones the run verified, replay-identity checks included. */
  verified: number
  /** Of those, the ones an independent policy can earn. */
  earned: number
  /** Milestones of the contract an independent policy can earn. */
  earnable: number
  /** Milestones of the contract. */
  total: number
}

/** The verified milestones an independent policy can earn, in verified order. */
export function earnedMilestones(contract: MilestoneContract, verified: readonly string[]): string[] {
  const earnable = new Set(contractEarnability(contract).earnable)
  return verified.filter((id) => earnable.has(id))
}

/** Score a verified milestone set against its contract. */
export function scoreMilestones(contract: MilestoneContract, verified: readonly string[]): MilestoneScore {
  const { earnable } = contractEarnability(contract)
  const set = new Set(earnable)
  return {
    verified: verified.length,
    earned: verified.filter((id) => set.has(id)).length,
    earnable: earnable.length,
    total: contract.milestones.length,
  }
}

/** One line for a report or a log. Never states an earned count alone. */
export function formatMilestoneScore(score: MilestoneScore): string {
  const identity = score.total - score.earnable
  if (identity === 0) return `${score.earned} of ${score.earnable} earnable`
  return (
    `${score.earned} of ${score.earnable} earnable ` +
    `(${score.verified} of ${score.total} verified, ${identity} replay-identity)`
  )
}
