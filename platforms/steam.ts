import { readFileSync } from 'node:fs'
import { receiptDigest, type PlatformEvidenceSource, type PlatformReceiptSnapshot } from '../platform-evidence'
import { runJsonBridge, type JsonBridgeSpec } from './bridge'
import { fetchJsonBounded, type FetchLike } from './http'

export interface SteamAppManifest {
  appId: string
  buildId?: string
  installDir?: string
  stateFlags?: string
}

export interface SteamWebApiConfig {
  apiKey: string
  appId: number
  steamId: string
  language?: string
  manifestPath?: string
  baseUrl?: string
  timeoutMs?: number
  maxResponseBytes?: number
  fetchImpl?: FetchLike
}

export class SteamWebApiEvidenceSource implements PlatformEvidenceSource {
  constructor(private readonly config: SteamWebApiConfig) {
    if (!config.apiKey.trim()) throw new Error('Steam Web API key is required')
    if (!Number.isInteger(config.appId) || config.appId <= 0) throw new Error('Steam appId must be a positive integer')
    if (!/^\d{5,20}$/.test(config.steamId)) throw new Error('Steam steamId must be a numeric SteamID64')
  }

  async capture(): Promise<PlatformReceiptSnapshot> {
    const fetchImpl = this.config.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
    if (!fetchImpl) throw new Error('fetch is unavailable')
    const base = this.config.baseUrl ?? 'https://partner.steam-api.com'
    const query = new URLSearchParams({
      key: this.config.apiKey,
      steamid: this.config.steamId,
      appid: String(this.config.appId),
    })
    if (this.config.language) query.set('l', this.config.language)
    const opts = {
      ...(this.config.timeoutMs !== undefined ? { timeoutMs: this.config.timeoutMs } : {}),
      ...(this.config.maxResponseBytes !== undefined ? { maxBytes: this.config.maxResponseBytes } : {}),
    }
    const [achievementResponse, statResponse] = await Promise.all([
      fetchJsonBounded(fetchImpl, `${base}/ISteamUserStats/GetPlayerAchievements/v1/?${query}`, opts),
      fetchJsonBounded(fetchImpl, `${base}/ISteamUserStats/GetUserStatsForGame/v2/?${query}`, opts),
    ])
    const achievements = parseAchievements(achievementResponse.data, this.config.steamId)
    const stats = parseStats(statResponse.data, this.config.steamId)
    const metadata: Record<string, string> = { appId: String(this.config.appId), source: 'steam-web-api' }
    if (this.config.manifestPath) {
      const manifest = parseSteamAppManifest(readFileSync(this.config.manifestPath, 'utf8'))
      if (manifest.appId !== String(this.config.appId)) throw new Error(`Steam manifest appId ${manifest.appId} != configured ${this.config.appId}`)
      if (manifest.buildId) metadata.buildId = manifest.buildId
      if (manifest.installDir) metadata.installDir = manifest.installDir
      if (manifest.stateFlags) metadata.stateFlags = manifest.stateFlags
    }
    return {
      schemaVersion: 1,
      provider: 'steam',
      gameId: `steam:${this.config.appId}`,
      userId: this.config.steamId,
      environment: 'production',
      capturedAt: new Date().toISOString(),
      achievements,
      stats,
      metadata,
      sourceDigest: receiptDigest({ achievements: achievementResponse.data, stats: statResponse.data, metadata }),
    }
  }
}

export interface SteamBridgeConfig {
  appId: number
  steamId: string
  environment?: string
  manifestPath?: string
  bridge: JsonBridgeSpec
}

/** Title-side Steamworks SDK bridge returning normalized API/SDK reads. */
export class SteamBridgeEvidenceSource implements PlatformEvidenceSource {
  constructor(private readonly config: SteamBridgeConfig) {}

  async capture(): Promise<PlatformReceiptSnapshot> {
    const response = runJsonBridge(this.config.bridge, {
      method: 'steam.snapshot',
      appId: this.config.appId,
      steamId: this.config.steamId,
    })
    const root = asRecord(response.data, 'Steam bridge response')
    if (Number(root.appId) !== this.config.appId) throw new Error(`Steam bridge appId ${String(root.appId)} != configured ${this.config.appId}`)
    if (String(root.steamId) !== this.config.steamId) throw new Error(`Steam bridge steamId ${String(root.steamId)} != configured ${this.config.steamId}`)
    const metadata: Record<string, string> = { appId: String(this.config.appId), source: 'steamworks-bridge' }
    if (typeof root.buildId === 'string' && root.buildId) metadata.buildId = root.buildId
    if (this.config.manifestPath) {
      const manifest = parseSteamAppManifest(readFileSync(this.config.manifestPath, 'utf8'))
      if (manifest.appId !== String(this.config.appId)) throw new Error(`Steam manifest appId ${manifest.appId} != configured ${this.config.appId}`)
      if (manifest.buildId) metadata.buildId = manifest.buildId
    }
    return {
      schemaVersion: 1,
      provider: 'steam',
      gameId: `steam:${this.config.appId}`,
      userId: this.config.steamId,
      environment: this.config.environment ?? 'production',
      capturedAt: new Date().toISOString(),
      achievements: normalizeBridgeAchievements(root.achievements),
      stats: normalizeBridgeStats(root.stats),
      metadata,
      sourceDigest: receiptDigest(response.data),
    }
  }
}

export function parseSteamAppManifest(text: string): SteamAppManifest {
  const fields = new Map<string, string>()
  for (const match of text.matchAll(/^\s*"([^"]+)"\s+"([^"]*)"\s*$/gm)) fields.set(match[1]!.toLowerCase(), match[2]!)
  const appId = fields.get('appid')
  if (!appId) throw new Error('Steam app manifest has no appid')
  const buildId = fields.get('buildid')
  const installDir = fields.get('installdir')
  const stateFlags = fields.get('stateflags')
  return {
    appId,
    ...(buildId !== undefined ? { buildId } : {}),
    ...(installDir !== undefined ? { installDir } : {}),
    ...(stateFlags !== undefined ? { stateFlags } : {}),
  }
}

function parseAchievements(value: unknown, expectedSteamId: string): PlatformReceiptSnapshot['achievements'] {
  const root = asRecord(value, 'Steam achievements response')
  const playerstats = asRecord(root.playerstats, 'Steam achievements playerstats')
  assertSteamResponse(playerstats, 'achievements', 'achievements')
  const steamId = String(playerstats.steamID ?? playerstats.steamid ?? '')
  if (steamId && steamId !== expectedSteamId) throw new Error(`Steam achievements returned steamId ${steamId}, expected ${expectedSteamId}`)
  const out: PlatformReceiptSnapshot['achievements'] = {}
  for (const item of asArray(playerstats.achievements)) {
    const row = asRecord(item, 'Steam achievement')
    const id = String(row.apiname ?? row.name ?? '')
    if (!id) throw new Error('Steam achievement has no API name')
    const unlocked = Number(row.achieved ?? 0) !== 0
    const unlockEpoch = Number(row.unlocktime ?? 0)
    out[id] = {
      unlocked,
      progress: unlocked ? 100 : 0,
      ...(unlocked && unlockEpoch > 0 ? { unlockedAt: new Date(unlockEpoch * 1000).toISOString() } : {}),
    }
  }
  return out
}

function parseStats(value: unknown, expectedSteamId: string): Record<string, number> {
  const root = asRecord(value, 'Steam stats response')
  const playerstats = asRecord(root.playerstats, 'Steam stats playerstats')
  assertSteamResponse(playerstats, 'stats', 'stats')
  const steamId = String(playerstats.steamID ?? playerstats.steamid ?? '')
  if (steamId && steamId !== expectedSteamId) throw new Error(`Steam stats returned steamId ${steamId}, expected ${expectedSteamId}`)
  const out: Record<string, number> = {}
  for (const item of asArray(playerstats.stats)) {
    const row = asRecord(item, 'Steam stat')
    const name = String(row.name ?? '')
    const statValue = Number(row.value)
    if (!name || !Number.isFinite(statValue)) throw new Error('Steam stat row is invalid')
    out[name] = statValue
  }
  return out
}

function assertSteamResponse(playerstats: Record<string, unknown>, label: string, expectedRows: string): void {
  if (typeof playerstats.error === 'string' && playerstats.error.trim()) {
    throw new Error(`Steam ${label} request failed: ${playerstats.error}`)
  }
  if (playerstats.success === false) throw new Error(`Steam ${label} request failed: unknown error`)
  if (playerstats.success !== true && !Array.isArray(playerstats[expectedRows])) {
    throw new Error(`Steam ${label} response did not contain a successful result`)
  }
}

function normalizeBridgeAchievements(value: unknown): PlatformReceiptSnapshot['achievements'] {
  const out: PlatformReceiptSnapshot['achievements'] = {}
  const root = asRecord(value ?? {}, 'Steam bridge achievements')
  for (const [id, raw] of Object.entries(root)) {
    const row = typeof raw === 'boolean' ? { unlocked: raw, progress: raw ? 100 : 0 } : asRecord(raw, `Steam bridge achievement ${id}`)
    const unlocked = Boolean(row.unlocked)
    const progress = row.progress === undefined ? (unlocked ? 100 : 0) : Number(row.progress)
    if (!Number.isFinite(progress) || progress < 0 || progress > 100) throw new Error(`Steam bridge achievement ${id} progress is invalid`)
    out[id] = { unlocked, progress, ...(typeof row.unlockedAt === 'string' ? { unlockedAt: row.unlockedAt } : {}) }
  }
  return out
}

function normalizeBridgeStats(value: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  const root = asRecord(value ?? {}, 'Steam bridge stats')
  for (const [id, raw] of Object.entries(root)) {
    const number = Number(raw)
    if (!Number.isFinite(number)) throw new Error(`Steam bridge stat ${id} is invalid`)
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
