import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { makeNativeDesktopAdapter, validateDesktopSpec, type DesktopGameSpec } from './adapters/native-desktop'
import { attestRun } from './attestation'
import { verifySignedRunEnvelope } from './artifact'
import { executeBenchmark } from './execute'
import { executePlatformBenchmark, verifySignedPlatformRun } from './platform-execute'
import {
  evaluatePlatformEvidence,
  receiptDigest,
  type PlatformEvidenceSource,
  type PlatformReceiptSnapshot,
} from './platform-evidence'
import { logFrom } from './runtime'
import { contractHash, type MilestoneContract } from './schema'
import { scriptedDriver } from './episode'
import { parseSteamAppManifest, SteamWebApiEvidenceSource } from './platforms/steam'
import { XboxRestEvidenceSource } from './platforms/xbox'
import { fetchJsonBounded, type FetchLike, type HttpResponseLike } from './platforms/http'

const FIXTURE = fileURLToPath(new URL('./desktop/fixture_game.py', import.meta.url))
const LAUNCHER_FIXTURE = fileURLToPath(new URL('./desktop/fixture_launcher.py', import.meta.url))
const WORKER = fileURLToPath(new URL('./desktop/worker.py', import.meta.url))
const PYTHON = process.env.PLAYPROOF_PYTHON ?? 'python3'
const encoder = new TextEncoder()

function response(value: unknown, options: { status?: number; chunkSize?: number; contentLength?: number } = {}): HttpResponseLike {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  const bytes = encoder.encode(text)
  let offset = 0
  let cancelled = false
  return {
    ok: (options.status ?? 200) >= 200 && (options.status ?? 200) < 300,
    status: options.status ?? 200,
    headers: {
      get: (name) => name.toLowerCase() === 'content-length'
        ? String(options.contentLength ?? bytes.byteLength)
        : null,
    },
    body: {
      getReader: () => ({
        read: async () => {
          if (cancelled || offset >= bytes.length) return { done: true }
          const size = options.chunkSize ?? bytes.length
          const value = bytes.slice(offset, Math.min(offset + size, bytes.length))
          offset += value.length
          return { done: false, value }
        },
        cancel: async () => { cancelled = true },
      }),
    },
  }
}

function snapshot(
  args: Partial<PlatformReceiptSnapshot>
    & Pick<PlatformReceiptSnapshot, 'provider' | 'gameId' | 'userId' | 'environment'>,
): PlatformReceiptSnapshot {
  const base = {
    schemaVersion: 1 as const,
    capturedAt: args.capturedAt ?? '2026-08-19T00:00:00.000Z',
    achievements: args.achievements ?? {},
    stats: args.stats ?? {},
    metadata: args.metadata ?? {},
    ...args,
  }
  return { ...base, sourceDigest: args.sourceDigest ?? receiptDigest(base) }
}

// Baseline-to-final semantics and identity/build invariants.
{
  const baseline = snapshot({
    provider: 'steam', gameId: 'steam:480', userId: '76561198000000000', environment: 'production',
    achievements: {
      NEW: { unlocked: false, progress: 20 },
      OLD: { unlocked: true, progress: 100 },
    },
    stats: { wins: 4, temperature: 10 }, metadata: { buildId: '10' },
  })
  const final = snapshot({
    provider: 'steam', gameId: 'steam:480', userId: '76561198000000000', environment: 'production',
    capturedAt: '2026-08-19T00:01:00.000Z',
    achievements: {
      NEW: { unlocked: true, progress: 100 },
      OLD: { unlocked: true, progress: 100 },
    },
    stats: { wins: 5, temperature: 5 }, metadata: { buildId: '10' },
  })
  const clean = evaluatePlatformEvidence(baseline, final, [
    { id: 'new-achievement', kind: 'achievement-unlocked', key: 'NEW' },
    { id: 'achievement-progress', kind: 'achievement-progress', key: 'NEW', threshold: 75 },
    { id: 'five-wins', kind: 'stat-threshold', key: 'wins', threshold: 5 },
    { id: 'one-more-win', kind: 'stat-delta', key: 'wins', delta: 1 },
    { id: 'non-monotonic-temperature', kind: 'stat-delta', key: 'temperature', delta: -5, monotonic: false },
  ])
  assert.equal(clean.verdict, 'clean')
  assert.ok(clean.transitions.every((row) => row.passed))

  const preexisting = evaluatePlatformEvidence(baseline, final, [
    { id: 'old-achievement', kind: 'achievement-unlocked', key: 'OLD' },
  ])
  assert.equal(preexisting.verdict, 'rejected')

  const wrongUser = evaluatePlatformEvidence(baseline, { ...final, userId: 'attacker' }, [
    { id: 'new-achievement', kind: 'achievement-unlocked', key: 'NEW' },
  ])
  assert.ok(wrongUser.reasons.some((reason) => reason.includes('userId changed')))

  const missingBuild = evaluatePlatformEvidence(baseline, { ...final, metadata: {} }, [
    { id: 'new-achievement', kind: 'achievement-unlocked', key: 'NEW' },
  ])
  assert.ok(missingBuild.reasons.some((reason) => reason.includes('buildId changed')))
}

// True streaming bounds: content-length and chunked overflows are rejected
// before an unbounded response can be materialized.
{
  const declaredTooLarge: FetchLike = async () => response('{}', { contentLength: 1000 })
  await assert.rejects(() => fetchJsonBounded(declaredTooLarge, 'https://example.invalid', { maxBytes: 8 }), /exceeded 8/)

  const chunkedTooLarge: FetchLike = async () => response('x'.repeat(64), { chunkSize: 5, contentLength: Number.NaN })
  await assert.rejects(() => fetchJsonBounded(chunkedTooLarge, 'https://example.invalid', { maxBytes: 16 }), /exceeded 16/)

  const nonOk: FetchLike = async () => response({ error: 'denied' }, { status: 403 })
  await assert.rejects(() => fetchJsonBounded(nonOk, 'https://example.invalid'), /HTTP 403/)

  const timeout: FetchLike = async (_url, init) => await new Promise<HttpResponseLike>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  })
  await assert.rejects(() => fetchJsonBounded(timeout, 'https://example.invalid', { timeoutMs: 5 }), /aborted/)
}

// Steam Web API parsing and explicit API-error rejection.
{
  const manifest = parseSteamAppManifest(
    `"AppState"\n{\n "appid" "480"\n "buildid" "12345"\n "installdir" "Spacewar"\n}`,
  )
  assert.deepEqual(manifest, {
    appId: '480', buildId: '12345', installDir: 'Spacewar',
  })
  const calls: string[] = []
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url)
    const body = url.includes('GetPlayerAchievements')
      ? {
          playerstats: {
            steamID: '76561198000000000', success: true,
            achievements: [{ apiname: 'WIN', achieved: 1, unlocktime: 1_700_000_000 }],
          },
        }
      : {
          playerstats: {
            steamID: '76561198000000000',
            stats: [{ name: 'wins', value: 7 }],
          },
        }
    return response(body)
  }
  const source = new SteamWebApiEvidenceSource({
    apiKey: 'not-a-real-key', appId: 480, steamId: '76561198000000000', fetchImpl,
  })
  const value = await source.capture()
  assert.equal(value.achievements.WIN?.unlocked, true)
  assert.equal(value.stats.wins, 7)
  assert.equal(calls.length, 2)

  const errorFetch: FetchLike = async (url) => response({
    playerstats: url.includes('GetPlayerAchievements')
      ? { error: 'Profile is private' }
      : { stats: [] },
  })
  const errorSource = new SteamWebApiEvidenceSource({
    apiKey: 'not-a-real-key', appId: 480, steamId: '76561198000000000', fetchImpl: errorFetch,
  })
  await assert.rejects(() => errorSource.capture(), /Profile is private/)
}

// Xbox pagination, row identity, repeated-token and page-limit guards.
{
  const calls: string[] = []
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url)
    const second = url.includes('continuationToken=next-page')
    return response(second
      ? {
          achievements: [{
            id: 'B', serviceConfigurationId: 'SCID', titleAssociations: [{ id: 1234 }],
            progressState: 'Achieved', progression: { timeUnlocked: '2026-08-19T00:00:00Z' },
          }],
        }
      : {
          achievements: [{
            id: 'A', serviceConfigurationId: 'SCID', titleAssociations: [{ id: 1234 }],
            progressState: 'InProgress', progression: { requirements: [{ current: '5', target: '10' }] },
          }],
          pagingInfo: { continuationToken: 'next-page' },
        })
  }
  const source = new XboxRestEvidenceSource({
    xuid: '2810000000000000', titleId: 1234,
    serviceConfigurationId: 'SCID', sandbox: 'RETAIL',
    authorization: 'XBL3.0 x=test;token', fetchImpl,
  })
  const value = await source.capture()
  assert.equal(value.achievements.A?.progress, 50)
  assert.equal(value.achievements.B?.unlocked, true)
  assert.equal(calls.length, 2)

  const missingIdentity = new XboxRestEvidenceSource({
    xuid: '2810000000000000', titleId: 1234, serviceConfigurationId: 'SCID', sandbox: 'RETAIL',
    authorization: 'token', fetchImpl: async () => response({ achievements: [{ id: 'A', progressState: 'Achieved' }] }),
  })
  await assert.rejects(() => missingIdentity.capture(), /no SCID or title association/)

  const repeated = new XboxRestEvidenceSource({
    xuid: '2810000000000000', titleId: 1234, serviceConfigurationId: 'SCID', sandbox: 'RETAIL',
    authorization: 'token', fetchImpl: async () => response({ achievements: [], continuationToken: 'same' }),
  })
  await assert.rejects(() => repeated.capture(), /continuation token repeated/)

  const pageLimit = new XboxRestEvidenceSource({
    xuid: '2810000000000000', titleId: 1234, serviceConfigurationId: 'SCID', sandbox: 'RETAIL',
    authorization: 'token', maxPages: 1,
    fetchImpl: async () => response({ achievements: [], continuationToken: 'more' }),
  })
  await assert.rejects(() => pageLimit.capture(), /exceeded 1 pages/)
}

const contract: MilestoneContract = {
  schemaVersion: 1,
  gameId: 'desktop-fixture',
  milestones: [
    {
      id: 'first-step', tier: 'engine-state', requires: [], glitchClass: 'legal',
      check: { kind: 'state-path', path: 'game.steps', op: '>=', value: 1 },
    },
    {
      id: 'score-two-save', tier: 'save-file', requires: ['first-step'], glitchClass: 'legal',
      check: { kind: 'save-path', path: 'game.score', op: '>=', value: 2 },
    },
    {
      id: 'score-two-frame', tier: 'screen-frame', requires: ['score-two-save'], glitchClass: 'legal',
      check: { kind: 'frame-path', path: 'score', op: '>=', value: 2 },
    },
    {
      id: 'finished-event', tier: 'log-event', requires: ['score-two-frame'], glitchClass: 'legal',
      check: { kind: 'log-contains', event: 'events:finished' },
    },
  ],
}
const reference = ['step', 'step', 'finish']

function spec(deterministicReplay: boolean): DesktopGameSpec {
  return {
    id: 'desktop-fixture',
    launch: {
      command: PYTHON,
      args: [FIXTURE],
      env: {
        PLAYPROOF_SAVE_PATH: '{runDir}/save.json',
        PLAYPROOF_EVENT_PATH: '{runDir}/events.log',
      },
    },
    process: { kind: 'spawned' },
    ready: { stdoutPattern: 'READY', timeoutMs: 10_000 },
    input: { kind: 'stdin-line' },
    observation: { kind: 'stdout' },
    evidence: {
      saveFiles: [{ id: 'game', path: '{runDir}/save.json', format: 'json', maxBytes: 64 << 10 }],
      eventFiles: [{ id: 'events', path: '{runDir}/events.log', maxBytes: 64 << 10 }],
      promoteSaveToEngine: true,
      framePatterns: { score: 'score=(\\d+)', finished: 'finished=(\\d+)' },
    },
    allowedInputs: ['step', 'bonus', 'finish'],
    settleMs: 200,
    deterministicReplay,
  }
}

assert.throws(
  () => validateDesktopSpec({ ...spec(true), launch: { command: 'bad\0command' } }),
  /invalid/,
)
assert.throws(
  () => validateDesktopSpec({ ...spec(true), evidence: {
    saveFiles: [{ id: 'same', path: 'a', format: 'json' }],
    eventFiles: [{ id: 'same', path: 'b' }],
  } }),
  /duplicate desktop evidence probe id/,
)
assert.throws(
  () => validateDesktopSpec({ ...spec(true), allowedInputs: ['step\nfinish'] }),
  /invalid input/,
)

// Deterministic process covers all evidence tiers; unknown/control-character
// inputs are strict no-ops rather than multi-command injection or crashes.
{
  const adapter = makeNativeDesktopAdapter({
    spec: spec(true), contract, reference,
    build: { id: 'desktop-fixture-v1', files: [FIXTURE] }, python: PYTHON,
  })
  try {
    const state = adapter.game.init(0)
    const before = structuredClone(adapter.game.evidence(state))
    const afterState = adapter.game.step(state, 'step\nfinish')
    assert.equal(afterState.frame, state.frame)
    assert.deepEqual(adapter.game.evidence(afterState), before)

    const all = contract.milestones.map((milestone) => milestone.id)
    const attestation = attestRun(adapter.game, contract, 0, logFrom(0, reference), all)
    assert.equal(attestation.verdict, 'clean')
    assert.deepEqual(attestation.verified, all)
  } finally {
    adapter.dispose()
  }
}

// Trusted-recorder mode records exactly one live pass. Second, third, and all
// later verifier passes restart the immutable transcript and never re-launch.
{
  const adapter = makeNativeDesktopAdapter({
    spec: spec(false), contract, reference,
    build: { id: 'desktop-fixture-v1', files: [FIXTURE] }, python: PYTHON,
  })
  try {
    const keys = generateKeyPairSync('ed25519')
    const first = adapter.game.init(0)
    const livePid = first.evidence.engineState?.pid
    let state = first
    for (const input of reference) state = adapter.game.step(state, input)

    for (let pass = 0; pass < 3; pass++) {
      const verified = attestRun(adapter.game, contract, 0, logFrom(0, reference), contract.milestones.map((m) => m.id))
      assert.equal(verified.verdict, 'clean')
      const replayInitial = adapter.game.init(0)
      assert.equal(replayInitial.evidence.engineState?.pid, livePid)
      let replayState = replayInitial
      for (const input of reference) replayState = adapter.game.step(replayState, input)
      assert.throws(() => adapter.game.step(replayState, 'step'), /replay exceeded/)
    }

    const executed = await executeBenchmark(adapter, scriptedDriver(reference), {
      budgetUsd: 1,
      maxTurns: reference.length,
      actor: { kind: 'scripted', id: 'desktop-fixture-policy' },
      signer: { privateKey: keys.privateKey, keyId: 'desktop-recorder' },
      createdAt: '2026-08-19T00:00:00.000Z',
    })
    assert.equal(verifySignedRunEnvelope(executed.signed, keys.publicKey, {
      gameId: adapter.game.id,
      gameBuildDigest: adapter.build.digest,
      contractHash: contractHash(adapter.contract),
      platformId: adapter.platform.id,
      keyId: 'desktop-recorder',
    }).valid, true)
  } finally {
    adapter.dispose()
  }
}

// Direct worker regression: reset re-expands the original tokenized spec into
// a new run directory; owned launcher descendants are killed as one group.
{
  const workerScript = String.raw`
import importlib.util, json, os, sys, time
worker_path, fixture, launcher = sys.argv[1:4]
spec_module = importlib.util.spec_from_file_location('playproof_worker', worker_path)
module = importlib.util.module_from_spec(spec_module)
spec_module.loader.exec_module(module)
worker = module.DesktopWorker()
spec = {
  'id': 'fixture',
  'launch': {'command': sys.executable, 'args': [fixture], 'env': {
    'PLAYPROOF_SAVE_PATH': '{runDir}/save.json', 'PLAYPROOF_EVENT_PATH': '{runDir}/events.log'}},
  'process': {'kind': 'spawned'}, 'ready': {'stdoutPattern': 'READY'},
  'input': {'kind': 'stdin-line'}, 'observation': {'kind': 'stdout'},
  'evidence': {'saveFiles': [{'id': 'game', 'path': '{runDir}/save.json', 'format': 'json'}]},
  'allowedInputs': ['step'], 'deterministicReplay': True,
}
worker.boot(spec, 0)
first = worker.run_dir
assert worker.spec['launch']['env']['PLAYPROOF_SAVE_PATH'].startswith(first)
worker.reset()
second = worker.run_dir
assert second != first
assert worker.spec['launch']['env']['PLAYPROOF_SAVE_PATH'].startswith(second)
worker.shutdown()

worker = module.DesktopWorker()
launcher_spec = {
  'id': 'launcher',
  'launch': {'command': sys.executable, 'args': [launcher], 'env': {'PLAYPROOF_CHILD_PID_PATH': '{runDir}/child.pid'}},
  'process': {'kind': 'pid-file', 'path': '{runDir}/child.pid'},
  'ready': {'stdoutPattern': 'READY'}, 'input': {'kind': 'stdin-line'},
  'observation': {'kind': 'stdout'}, 'allowedInputs': [], 'deterministicReplay': True,
}
worker.boot(launcher_spec, 0)
child = worker.target_pid
assert module.DesktopWorker._alive(child)
worker.shutdown()
for _ in range(100):
  if not module.DesktopWorker._alive(child): break
  time.sleep(0.01)
assert not module.DesktopWorker._alive(child), f'child {child} leaked'

worker = module.DesktopWorker()
try:
  worker._run_helper({'command': sys.executable, 'args': ['-c', 'print("x"*10000)'], 'maxBytes': 100}, {})
  raise AssertionError('overflow helper unexpectedly succeeded')
except RuntimeError as error:
  assert 'exceeds 100 bytes' in str(error)
`
  const result = spawnSync(PYTHON, ['-c', workerScript, WORKER, FIXTURE, LAUNCHER_FIXTURE], { encoding: 'utf8', timeout: 30_000 })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
}

// Signed platform composition authenticates the recorder capture and is total
// on malformed/tampered published artifacts.
{
  const captures = [
    snapshot({
      provider: 'steam', gameId: 'steam:480', userId: '76561198000000000',
      environment: 'production', achievements: { WIN: { unlocked: false, progress: 0 } },
      stats: { wins: 0 },
    }),
    snapshot({
      provider: 'steam', gameId: 'steam:480', userId: '76561198000000000',
      environment: 'production', capturedAt: '2026-08-19T00:01:00.000Z',
      achievements: { WIN: { unlocked: true, progress: 100 } }, stats: { wins: 1 },
    }),
  ]
  const source: PlatformEvidenceSource = { capture: async () => captures.shift()! }
  const adapter = makeNativeDesktopAdapter({
    spec: spec(true), contract, reference,
    build: { id: 'desktop-fixture-v1', files: [FIXTURE] }, python: PYTHON,
  })
  try {
    const keys = generateKeyPairSync('ed25519')
    const executed = await executePlatformBenchmark(adapter, scriptedDriver(reference), {
      budgetUsd: 1,
      maxTurns: reference.length,
      actor: { kind: 'scripted', id: 'desktop-fixture-policy' },
      signer: { privateKey: keys.privateKey, keyId: 'platform-recorder' },
      createdAt: '2026-08-19T00:00:00.000Z',
      evidenceSource: source,
      policies: [
        { id: 'steam-win', kind: 'achievement-unlocked', key: 'WIN' },
        { id: 'steam-one-win', kind: 'stat-threshold', key: 'wins', threshold: 1 },
      ],
    })
    assert.equal(verifySignedPlatformRun(executed.platformSigned, keys.publicKey, {
      gameId: adapter.game.id,
      gameBuildDigest: adapter.build.digest,
      contractHash: contractHash(adapter.contract),
      platformId: adapter.platform.id,
      keyId: 'platform-recorder',
      provider: 'steam',
      receiptGameId: 'steam:480',
      userId: '76561198000000000',
      environment: 'production',
    }).valid, true)

    const tampered = structuredClone(executed.platformSigned)
    tampered.envelope.platformEvidence.final.userId = 'attacker'
    assert.equal(verifySignedPlatformRun(tampered, keys.publicKey).valid, false)
    assert.doesNotThrow(() => verifySignedPlatformRun({}, keys.publicKey))
    assert.equal(verifySignedPlatformRun({}, keys.publicKey).valid, false)
  } finally {
    adapter.dispose()
  }
}

console.log('playproof-desktop-platforms: hardened native process, Steam, Xbox, bounded IO, and signed recorder composition green')
