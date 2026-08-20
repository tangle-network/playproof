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
