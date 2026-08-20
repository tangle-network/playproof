import { strict as assert } from 'node:assert'
import { generateKeyPairSync } from 'node:crypto'
import { attestRun } from './attestation'
import {
  buildDecisionChain,
  makeRunEnvelope,
  sha256,
  signRunEnvelope,
  verifySignedRunEnvelope,
  type SignedRunEnvelope,
} from './artifact'
import { makeNative2048, makeNative2048Explorer, NATIVE_2048_PLATFORM } from './adapters/native-2048'
import { frontierExplore, type ActionMacro } from './exploration/frontier'
import { executeBenchmark } from './execute'
import { logFrom } from './runtime'
import { contractHash, validateContract } from './schema'
import { validatePlatform, verificationGuarantee, type PlatformDescriptor } from './platform'
import { playEpisode, scriptedDriver } from './episode'

const allActions: ActionMacro[] = [
  { id: 'down', inputs: ['down'] },
  { id: 'left', inputs: ['left'] },
  { id: 'right', inputs: ['right'] },
  { id: 'up', inputs: ['up'] },
  { id: 'down-left', inputs: ['down', 'left'] },
  { id: 'down-right', inputs: ['down', 'right'] },
  { id: 'up-left', inputs: ['up', 'left'] },
  { id: 'up-right', inputs: ['up', 'right'] },
]

assert.deepEqual(validatePlatform(NATIVE_2048_PLATFORM), [])
assert.equal(verificationGuarantee(NATIVE_2048_PLATFORM).mode, 'replay')
const badReplay: PlatformDescriptor = {
  ...NATIVE_2048_PLATFORM,
  id: 'bad-replay',
  capabilities: { ...NATIVE_2048_PLATFORM.capabilities, deterministicReplay: false },
}
assert.ok(validatePlatform(badReplay).some((e) => e.includes('deterministicReplay')))
const trustedRecorder: PlatformDescriptor = {
  ...NATIVE_2048_PLATFORM,
  id: 'trusted-recorder-example',
  verificationMode: 'trusted-recorder',
  capabilities: { ...NATIVE_2048_PLATFORM.capabilities, deterministicReplay: false, signedRecorder: true },
}
assert.deepEqual(validatePlatform(trustedRecorder), [])
const platformReceipts: PlatformDescriptor = {
  ...NATIVE_2048_PLATFORM,
  id: 'platform-receipts-example',
  family: 'platform-service',
  verificationMode: 'platform-attested',
  capabilities: { ...NATIVE_2048_PLATFORM.capabilities, deterministicReplay: false, platformReceipts: true },
}
assert.deepEqual(validatePlatform(platformReceipts), [])

const adapter = makeNative2048()
try {
  assert.deepEqual(validateContract(adapter.contract), [])
  const all = adapter.contract.milestones.map((m) => m.id)
  assert.deepEqual(new Set(adapter.contract.milestones.map((m) => m.tier)), new Set(['engine-state', 'save-file', 'log-event', 'screen-frame']))

  const knownGood = attestRun(adapter.game, adapter.contract, adapter.seed, logFrom(adapter.seed, adapter.reference), all)
  assert.equal(knownGood.verdict, 'clean')
  assert.deepEqual(knownGood.verified, all)

  const partial = adapter.reference.slice(0, -1)
  const honestPartial = attestRun(adapter.game, adapter.contract, adapter.seed, logFrom(adapter.seed, partial), [])
  assert.equal(honestPartial.verdict, 'clean')
  assert.ok(!honestPartial.verified.includes('tile-32'))
  const falseClaim = attestRun(adapter.game, adapter.contract, adapter.seed, logFrom(adapter.seed, partial), ['tile-32'])
  assert.equal(falseClaim.verdict, 'rejected')
  assert.ok(falseClaim.reasons.some((r) => r.startsWith('claimed-not-reproduced')))

  const beforeTile16 = adapter.reference.slice(0, 9)
  const dependentEarly = attestRun(adapter.game, adapter.contract, adapter.seed, logFrom(adapter.seed, beforeTile16), ['save-at-tile-16'])
  assert.equal(dependentEarly.verdict, 'rejected')

  const stream = (): string[] => {
    let state = adapter.game.init(adapter.seed)
    const out = [JSON.stringify(adapter.game.evidence(state))]
    for (const input of adapter.reference) {
      state = adapter.game.step(state, input)
      out.push(JSON.stringify(adapter.game.evidence(state)))
    }
    return out
  }
  assert.deepEqual(stream(), stream(), 'native process replay diverged across independent boots')

  const episode = await playEpisode(
    adapter.game,
    adapter.contract,
    scriptedDriver(adapter.reference),
    1,
    adapter.reference.length,
    adapter.seed,
  )
  assert.equal(episode.record.verdict, 'clean')
  assert.equal(episode.record.replayDivergence, false)
  assert.deepEqual(episode.record.verified, all)
  assert.equal(episode.record.spentUsd, 0)
} finally {
  adapter.dispose()
}

const exploreOnce = () => {
  const explorer = makeNative2048Explorer()
  try {
    const result = frontierExplore(explorer.environment, {
      seed: 0,
      rounds: 20,
      beamWidth: 6,
      actions: allActions,
    })
    return { result, evidence: explorer.evidence() }
  } finally {
    explorer.dispose()
  }
}
const first = exploreOnce()
const second = exploreOnce()
assert.deepEqual(first.result.inputs, second.result.inputs)
assert.equal(first.result.terminalFingerprint, second.result.terminalFingerprint)
assert.ok((first.evidence.engineState.maxTile ?? 0) >= 32, `frontier max tile was ${first.evidence.engineState.maxTile}`)
const frontierReplay = makeNative2048()
try {
  const all = frontierReplay.contract.milestones.map((m) => m.id)
  const verdict = attestRun(frontierReplay.game, frontierReplay.contract, 0, logFrom(0, first.result.inputs), all)
  assert.equal(verdict.verdict, 'clean')
  assert.deepEqual(verdict.verified, all)
} finally {
  frontierReplay.dispose()
}

const executedAdapter = makeNative2048()
try {
  const keys = generateKeyPairSync('ed25519')
  const executed = await executeBenchmark(executedAdapter, scriptedDriver(executedAdapter.reference), {
    budgetUsd: 1,
    maxTurns: executedAdapter.reference.length,
    actor: { kind: 'scripted', id: 'native-reference' },
    signer: { privateKey: keys.privateKey, keyId: 'integrated-recorder' },
    createdAt: '2026-08-18T00:00:00.000Z',
  })
  assert.equal(executed.record.verdict, 'clean')
  assert.equal(executed.signed.envelope.decisions.length, executed.record.turns)
  assert.equal(verifySignedRunEnvelope(executed.signed, keys.publicKey, {
    gameId: executedAdapter.game.id,
    gameBuildDigest: executedAdapter.build.digest,
    contractHash: contractHash(executedAdapter.contract),
    platformId: executedAdapter.platform.id,
    keyId: 'integrated-recorder',
  }).valid, true)
} finally {
  executedAdapter.dispose()
}

const signedAdapter = makeNative2048()
try {
  const decisions = signedAdapter.reference.map((input, index) => ({
    turn: index + 1,
    input,
    latencyMs: 10 + (index % 3),
    costUsd: 0,
  }))
  const envelope = makeRunEnvelope({
    gameId: signedAdapter.game.id,
    gameBuild: signedAdapter.build,
    contractHash: contractHash(signedAdapter.contract),
    platform: signedAdapter.platform,
    actor: { kind: 'scripted', id: 'native-reference' },
    seed: signedAdapter.seed,
    decisions,
    limits: { budgetUsd: 1, maxTurns: decisions.length },
    claimed: signedAdapter.contract.milestones.map((m) => m.id),
    createdAt: '2026-08-18T00:00:00.000Z',
  })
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const signed = signRunEnvelope(envelope, privateKey, 'test-recorder')
  assert.equal(verifySignedRunEnvelope(signed, publicKey, {
    gameId: signedAdapter.game.id,
    gameBuildDigest: signedAdapter.build.digest,
    contractHash: contractHash(signedAdapter.contract),
    platformId: signedAdapter.platform.id,
    keyId: 'test-recorder',
  }).valid, true)

  const forged = structuredClone(signed) as SignedRunEnvelope
  const forgedCores = forged.envelope.decisions.map((d) => ({
    turn: d.turn,
    input: d.input,
    latencyMs: d.latencyMs,
    costUsd: d.costUsd,
  }))
  forgedCores[0]!.input = 'right'
  forged.envelope.decisions = buildDecisionChain(forgedCores)
  forged.envelope.inputs = forged.envelope.decisions.map((d) => d.input)
  forged.digest = sha256(forged.envelope)
  assert.equal(verifySignedRunEnvelope(forged, publicKey).valid, false)
  assert.ok(verifySignedRunEnvelope(forged, publicKey).reasons.includes('envelope signature invalid'))

  const forgedKeyId = structuredClone(signed) as SignedRunEnvelope
  forgedKeyId.signature.keyId = 'attacker-key'
  assert.equal(verifySignedRunEnvelope(forgedKeyId, publicKey).valid, false)

  const staleDigest = structuredClone(signed) as SignedRunEnvelope
  staleDigest.envelope.claimed.push('invented-milestone')
  assert.equal(verifySignedRunEnvelope(staleDigest, publicKey).valid, false)
} finally {
  signedAdapter.dispose()
}

console.log('playproof-platform: native process, frontier replay, explicit trust modes, signed execution, and red-team gates green')
