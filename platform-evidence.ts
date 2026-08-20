import { createHash } from 'node:crypto'
import { canonicalJson } from './artifact'

export interface AchievementReceipt {
  unlocked: boolean
  progress: number
  unlockedAt?: string
}

export interface PlatformReceiptSnapshot {
  schemaVersion: 1
  provider: string
  gameId: string
  userId: string
  environment: string
  capturedAt: string
  achievements: Record<string, AchievementReceipt>
  stats: Record<string, number>
  metadata: Record<string, string>
  sourceDigest: string
}

export type PlatformMilestonePolicy =
  | { id: string; kind: 'achievement-unlocked'; key: string }
  | { id: string; kind: 'achievement-progress'; key: string; threshold: number }
  | { id: string; kind: 'stat-threshold'; key: string; threshold: number; monotonic?: boolean }
  | { id: string; kind: 'stat-delta'; key: string; delta: number; monotonic?: boolean }

export interface PlatformTransition {
  id: string
  passed: boolean
  before: number | boolean | null
  after: number | boolean | null
  reason: string
}

export interface PlatformEvidenceBundle {
  schemaVersion: 1
  policies: PlatformMilestonePolicy[]
  baseline: PlatformReceiptSnapshot
  final: PlatformReceiptSnapshot
  transitions: PlatformTransition[]
  verdict: 'clean' | 'rejected'
  reasons: string[]
}

export interface PlatformEvidenceSource {
  capture(): Promise<PlatformReceiptSnapshot>
}

export function evaluatePlatformEvidence(
  baseline: PlatformReceiptSnapshot,
  final: PlatformReceiptSnapshot,
  policies: readonly PlatformMilestonePolicy[],
): PlatformEvidenceBundle {
  const reasons = [...validateSnapshot(baseline, 'baseline'), ...validateSnapshot(final, 'final')]
  for (const key of ['provider', 'gameId', 'userId', 'environment'] as const) {
    if (baseline[key] !== final[key]) reasons.push(`${key} changed during run: ${baseline[key]} -> ${final[key]}`)
  }
  const beforeTime = Date.parse(baseline.capturedAt)
  const afterTime = Date.parse(final.capturedAt)
  if (Number.isFinite(beforeTime) && Number.isFinite(afterTime) && afterTime < beforeTime) {
    reasons.push('final snapshot predates baseline')
  }
  const beforeBuild = baseline.metadata.buildId
  const afterBuild = final.metadata.buildId
  if ((beforeBuild !== undefined || afterBuild !== undefined) && beforeBuild !== afterBuild) {
    reasons.push(`buildId changed during run: ${beforeBuild ?? '<missing>'} -> ${afterBuild ?? '<missing>'}`)
  }

  const seen = new Set<string>()
  const transitions: PlatformTransition[] = []
  for (const policy of policies) {
    reasons.push(...validatePolicy(policy))
    if (seen.has(policy.id)) reasons.push(`duplicate platform policy id ${policy.id}`)
    seen.add(policy.id)
    transitions.push(evaluatePolicy(baseline, final, policy))
  }
  if (policies.length === 0) reasons.push('platform evidence has no milestone policies')
  for (const transition of transitions) {
    if (!transition.passed) reasons.push(`${transition.id}: ${transition.reason}`)
  }
  return {
    schemaVersion: 1,
    policies: policies.map((policy) => ({ ...policy })),
    baseline,
    final,
    transitions,
    verdict: reasons.length === 0 ? 'clean' : 'rejected',
    reasons,
  }
}

export function validatePlatformEvidenceBundle(value: unknown): string[] {
  if (!isRecord(value)) return ['platform evidence bundle must be an object']
  const bundle = value as unknown as PlatformEvidenceBundle
  const reasons: string[] = []
  if (bundle.schemaVersion !== 1) reasons.push(`unsupported platform evidence schema ${bundle.schemaVersion}`)
  let recomputed: PlatformEvidenceBundle
  try {
    recomputed = evaluatePlatformEvidence(bundle.baseline, bundle.final, bundle.policies)
  } catch (error) {
    return [...reasons, `platform evidence structure invalid: ${(error as Error).message}`]
  }
  if (canonicalJson(recomputed.transitions) !== canonicalJson(bundle.transitions)) reasons.push('platform transitions do not match recomputation')
  if (recomputed.verdict !== bundle.verdict) reasons.push('platform verdict does not match recomputation')
  if (canonicalJson(recomputed.reasons) !== canonicalJson(bundle.reasons)) reasons.push('platform reasons do not match recomputation')
  return reasons
}

export function receiptDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function validatePolicy(policy: PlatformMilestonePolicy): string[] {
  const reasons: string[] = []
  if (!policy.id.trim()) reasons.push('platform policy id is required')
  if (!policy.key.trim()) reasons.push(`${policy.id || '<unnamed>'}: platform policy key is required`)
  if (policy.kind === 'achievement-progress' || policy.kind === 'stat-threshold') {
    if (!Number.isFinite(policy.threshold)) reasons.push(`${policy.id}: threshold must be finite`)
  }
  if (policy.kind === 'achievement-progress' && (policy.threshold < 0 || policy.threshold > 100)) {
    reasons.push(`${policy.id}: achievement threshold must be within 0..100`)
  }
  if (policy.kind === 'stat-delta' && !Number.isFinite(policy.delta)) reasons.push(`${policy.id}: delta must be finite`)
  return reasons
}

function evaluatePolicy(
  baseline: PlatformReceiptSnapshot,
  final: PlatformReceiptSnapshot,
  policy: PlatformMilestonePolicy,
): PlatformTransition {
  switch (policy.kind) {
    case 'achievement-unlocked': {
      const before = baseline.achievements[policy.key]?.unlocked ?? false
      const after = final.achievements[policy.key]?.unlocked ?? false
      const passed = !before && after
      return { id: policy.id, passed, before, after, reason: passed ? 'achievement unlocked during run' : before ? 'achievement was already unlocked before the run' : 'achievement did not unlock' }
    }
    case 'achievement-progress': {
      const before = baseline.achievements[policy.key]?.progress ?? 0
      const after = final.achievements[policy.key]?.progress ?? 0
      const passed = before < policy.threshold && after >= policy.threshold
      return { id: policy.id, passed, before, after, reason: passed ? `achievement progress crossed ${policy.threshold}` : `achievement progress did not cross ${policy.threshold}` }
    }
    case 'stat-threshold': {
      const before = baseline.stats[policy.key]
      const after = final.stats[policy.key]
      if (before === undefined || after === undefined) {
        return { id: policy.id, passed: false, before: before ?? null, after: after ?? null, reason: `stat ${policy.key} missing from ${before === undefined ? 'baseline' : 'final'} snapshot` }
      }
      if ((policy.monotonic ?? true) && after < before) {
        return { id: policy.id, passed: false, before, after, reason: `monotonic stat ${policy.key} regressed` }
      }
      const passed = before < policy.threshold && after >= policy.threshold
      return { id: policy.id, passed, before, after, reason: passed ? `stat crossed ${policy.threshold}` : `stat did not cross ${policy.threshold}` }
    }
    case 'stat-delta': {
      const before = baseline.stats[policy.key]
      const after = final.stats[policy.key]
      if (before === undefined || after === undefined) {
        return { id: policy.id, passed: false, before: before ?? null, after: after ?? null, reason: `stat ${policy.key} missing from ${before === undefined ? 'baseline' : 'final'} snapshot` }
      }
      if ((policy.monotonic ?? true) && after < before) {
        return { id: policy.id, passed: false, before, after, reason: `monotonic stat ${policy.key} regressed` }
      }
      const passed = after - before >= policy.delta
      return { id: policy.id, passed, before, after, reason: passed ? `stat increased by at least ${policy.delta}` : `stat increased by ${after - before}, below ${policy.delta}` }
    }
  }
}

function validateSnapshot(snapshot: PlatformReceiptSnapshot, label: string): string[] {
  const reasons: string[] = []
  if (snapshot.schemaVersion !== 1) reasons.push(`${label}: unsupported snapshot schema ${snapshot.schemaVersion}`)
  for (const key of ['provider', 'gameId', 'userId', 'environment'] as const) {
    if (!snapshot[key].trim()) reasons.push(`${label}: ${key} is required`)
  }
  if (!Number.isFinite(Date.parse(snapshot.capturedAt))) reasons.push(`${label}: capturedAt must be an ISO timestamp`)
  if (!/^[0-9a-f]{64}$/i.test(snapshot.sourceDigest)) reasons.push(`${label}: sourceDigest must be sha256 hex`)
  for (const [key, achievement] of Object.entries(snapshot.achievements)) {
    if (!key.trim()) reasons.push(`${label}: achievement id is empty`)
    if (!Number.isFinite(achievement.progress) || achievement.progress < 0 || achievement.progress > 100) reasons.push(`${label}: achievement ${key} progress must be within 0..100`)
    if (achievement.unlockedAt && !Number.isFinite(Date.parse(achievement.unlockedAt))) reasons.push(`${label}: achievement ${key} unlockedAt is invalid`)
  }
  for (const [key, value] of Object.entries(snapshot.stats)) {
    if (!key.trim()) reasons.push(`${label}: stat id is empty`)
    if (!Number.isFinite(value)) reasons.push(`${label}: stat ${key} is not finite`)
  }
  for (const [key, value] of Object.entries(snapshot.metadata)) {
    if (!key.trim()) reasons.push(`${label}: metadata key is empty`)
    if (typeof value !== 'string') reasons.push(`${label}: metadata ${key} must be a string`)
  }
  return reasons
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
