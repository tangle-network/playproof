import { receiptDigest, type PlatformEvidenceSource, type PlatformReceiptSnapshot } from '../platform-evidence'
import { runJsonBridge, type JsonBridgeSpec } from './bridge'
import { fetchJsonBounded, type FetchLike } from './http'

export interface XboxRestConfig {
  xuid: string
  titleId: number
  serviceConfigurationId: string
  sandbox: string
  authorization: string | (() => Promise<string>)
  baseUrl?: string
  contractVersion?: string
  pageSize?: number
  maxPages?: number
  timeoutMs?: number
  maxResponseBytes?: number
  fetchImpl?: FetchLike
}

export class XboxRestEvidenceSource implements PlatformEvidenceSource {
  constructor(private readonly config: XboxRestConfig) {
    if (!/^\d+$/.test(config.xuid)) throw new Error('Xbox xuid must be numeric')
    if (!Number.isInteger(config.titleId) || config.titleId <= 0) throw new Error('Xbox titleId must be a positive integer')
    if (!config.serviceConfigurationId.trim()) throw new Error('Xbox SCID is required')
    if (!config.sandbox.trim()) throw new Error('Xbox sandbox is required')
    if (config.maxPages !== undefined && (!Number.isInteger(config.maxPages) || config.maxPages <= 0)) {
      throw new Error('Xbox maxPages must be a positive integer')
    }
  }

  async capture(): Promise<PlatformReceiptSnapshot> {
    const fetchImpl = this.config.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
    if (!fetchImpl) throw new Error('fetch is unavailable')
    const authorization = typeof this.config.authorization === 'function'
      ? await this.config.authorization()
      : this.config.authorization
    if (!authorization.trim()) throw new Error('Xbox authorization header is empty')
    const achievements: PlatformReceiptSnapshot['achievements'] = {}
    const pageDigests: string[] = []
    const seenTokens = new Set<string>()
    let continuationToken: string | undefined
    const maxPages = this.config.maxPages ?? 100
    for (let page = 0; page < maxPages; page++) {
      const url = new URL(`${this.config.baseUrl ?? 'https://achievements.xboxlive.com'}/users/xuid(${this.config.xuid})/achievements`)
      url.searchParams.set('titleId', String(this.config.titleId))
      url.searchParams.set('unlockedOnly', 'false')
      url.searchParams.set('maxItems', String(this.config.pageSize ?? 100))
      if (continuationToken) url.searchParams.set('continuationToken', continuationToken)
      const response = await fetchJsonBounded(fetchImpl, url.toString(), {
        headers: {
          Authorization: authorization,
          'x-xbl-contract-version': this.config.contractVersion ?? '2',
          Accept: 'application/json',
        },
        ...(this.config.timeoutMs !== undefined ? { timeoutMs: this.config.timeoutMs } : {}),
        ...(this.config.maxResponseBytes !== undefined ? { maxBytes: this.config.maxResponseBytes } : {}),
      })
      pageDigests.push(receiptDigest(response.data))
      const root = asRecord(response.data, 'Xbox achievement response')
      for (const item of extractAchievements(root)) {
        const row = asRecord(item, 'Xbox achievement')
        validateAchievementIdentity(row, this.config.titleId, this.config.serviceConfigurationId)
        const id = String(row.id ?? '')
        if (!id) throw new Error('Xbox achievement has no id')
        const progressState = String(row.progressState ?? '').toLowerCase()
        const progress = progressFor(row)
        const unlockedAt = unlockedTime(row)
        achievements[id] = {
          unlocked: progressState === 'achieved' || progress >= 100,
          progress,
          ...(unlockedAt ? { unlockedAt } : {}),
        }
      }
      const next = continuationFrom(root)
      if (!next) break
      if (seenTokens.has(next)) throw new Error(`Xbox continuation token repeated: ${next}`)
      seenTokens.add(next)
      continuationToken = next
      if (page === maxPages - 1) throw new Error(`Xbox achievements exceeded ${maxPages} pages`)
    }
    const metadata = {
      titleId: String(this.config.titleId),
      serviceConfigurationId: this.config.serviceConfigurationId,
      sandbox: this.config.sandbox,
      source: 'xbox-achievements-rest',
    }
    return {
      schemaVersion: 1,
      provider: 'xbox',
      gameId: `xbox:${this.config.titleId}:${this.config.serviceConfigurationId}`,
      userId: this.config.xuid,
      environment: this.config.sandbox,
      capturedAt: new Date().toISOString(),
      achievements,
      stats: {},
      metadata,
      sourceDigest: receiptDigest({ pageDigests, metadata }),
    }
  }
}

export interface XboxBridgeConfig {
  xuid: string
  titleId: number
  serviceConfigurationId: string
  sandbox: string
  bridge: JsonBridgeSpec
}

/** Bridge for GDK/XSAPI title-side code returning normalized API reads. */
export class XboxBridgeEvidenceSource implements PlatformEvidenceSource {
  constructor(private readonly config: XboxBridgeConfig) {}

  async capture(): Promise<PlatformReceiptSnapshot> {
    const response = runJsonBridge(this.config.bridge, {
      method: 'xbox.snapshot',
      xuid: this.config.xuid,
      titleId: this.config.titleId,
      serviceConfigurationId: this.config.serviceConfigurationId,
      sandbox: this.config.sandbox,
    })
    const root = asRecord(response.data, 'Xbox bridge response')
    if (String(root.xuid) !== this.config.xuid) throw new Error(`Xbox bridge xuid ${String(root.xuid)} != configured ${this.config.xuid}`)
    if (Number(root.titleId) !== this.config.titleId) throw new Error(`Xbox bridge titleId ${String(root.titleId)} != configured ${this.config.titleId}`)
    if (String(root.serviceConfigurationId) !== this.config.serviceConfigurationId) throw new Error('Xbox bridge SCID mismatch')
    if (String(root.sandbox) !== this.config.sandbox) throw new Error('Xbox bridge sandbox mismatch')
    const achievements: PlatformReceiptSnapshot['achievements'] = {}
    for (const item of asArray(root.achievements)) {
      const row = asRecord(item, 'Xbox bridge achievement')
      const id = String(row.id ?? '')
      const progress = Number(row.progress ?? (row.unlocked ? 100 : 0))
      if (!id || !Number.isFinite(progress) || progress < 0 || progress > 100) throw new Error('Xbox bridge achievement is invalid')
      achievements[id] = {
        unlocked: Boolean(row.unlocked) || progress >= 100,
        progress,
        ...(typeof row.unlockedAt === 'string' ? { unlockedAt: row.unlockedAt } : {}),
      }
    }
    const metadata = {
      titleId: String(this.config.titleId),
      serviceConfigurationId: this.config.serviceConfigurationId,
      sandbox: this.config.sandbox,
      source: 'xbox-gdk-bridge',
    }
    return {
      schemaVersion: 1,
      provider: 'xbox',
      gameId: `xbox:${this.config.titleId}:${this.config.serviceConfigurationId}`,
      userId: this.config.xuid,
      environment: this.config.sandbox,
      capturedAt: new Date().toISOString(),
      achievements,
      stats: normalizeStats(root.stats),
      metadata,
      sourceDigest: receiptDigest(response.data),
    }
  }
}

function extractAchievements(root: Record<string, unknown>): unknown[] {
  if (Array.isArray(root.achievements)) return root.achievements
  const inner = root.achievements
  if (typeof inner === 'object' && inner !== null && !Array.isArray(inner)) {
    const record = inner as Record<string, unknown>
    if (Array.isArray(record.items)) return record.items
  }
  return []
}

function validateAchievementIdentity(row: Record<string, unknown>, expectedTitleId: number, expectedScid: string): void {
  const hasScid = typeof row.serviceConfigurationId === 'string' && row.serviceConfigurationId.length > 0
  const hasAssociations = Array.isArray(row.titleAssociations) && row.titleAssociations.length > 0
  if (!hasScid && !hasAssociations) throw new Error('Xbox achievement has no SCID or title association')
  if (hasScid && row.serviceConfigurationId !== expectedScid) {
    throw new Error(`Xbox achievement SCID ${String(row.serviceConfigurationId)} != configured ${expectedScid}`)
  }
  if (hasAssociations) {
    const ids = (row.titleAssociations as unknown[]).map((value) => {
      const association = asRecord(value, 'Xbox title association')
      return Number(association.id ?? association.titleId)
    })
    if (!ids.includes(expectedTitleId)) throw new Error(`Xbox achievement is not associated with title ${expectedTitleId}`)
  }
}

function progressFor(row: Record<string, unknown>): number {
  if (String(row.progressState ?? '').toLowerCase() === 'achieved') return 100
  const progression = typeof row.progression === 'object' && row.progression !== null && !Array.isArray(row.progression)
    ? row.progression as Record<string, unknown>
    : {}
  const direct = Number(progression.percentComplete ?? progression.progressPercentage)
  if (Number.isFinite(direct)) return clamp(direct, 0, 100)
  const requirements = asArray(progression.requirements)
  if (requirements.length === 0) return 0
  const ratios: number[] = []
  for (const requirement of requirements) {
    const req = asRecord(requirement, 'Xbox achievement requirement')
    const current = Number(req.current ?? 0)
    const target = Number(req.target ?? 0)
    if (Number.isFinite(current) && Number.isFinite(target) && target > 0) ratios.push(clamp((current / target) * 100, 0, 100))
  }
  return ratios.length === 0 ? 0 : Math.min(...ratios)
}

function unlockedTime(row: Record<string, unknown>): string | undefined {
  const progression = typeof row.progression === 'object' && row.progression !== null && !Array.isArray(row.progression)
    ? row.progression as Record<string, unknown>
    : {}
  const raw = progression.timeUnlocked ?? row.timeUnlocked
  if (typeof raw !== 'string' || !Number.isFinite(Date.parse(raw))) return undefined
  return new Date(raw).toISOString()
}

function continuationFrom(root: Record<string, unknown>): string | undefined {
  if (typeof root.continuationToken === 'string' && root.continuationToken) return root.continuationToken
  const paging = root.pagingInfo
  if (typeof paging === 'object' && paging !== null && !Array.isArray(paging)) {
    const token = (paging as Record<string, unknown>).continuationToken
    if (typeof token === 'string' && token) return token
  }
  return undefined
}

function normalizeStats(value: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (value === undefined) return out
  const root = asRecord(value, 'Xbox bridge stats')
  for (const [id, raw] of Object.entries(root)) {
    const number = Number(raw)
    if (!Number.isFinite(number)) throw new Error(`Xbox bridge stat ${id} is invalid`)
    out[id] = number
  }
  return out
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
