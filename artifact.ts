/**
 * Cryptographic run envelopes.
 *
 * The legacy InputLog chain is a deterministic mutation detector, not an
 * adversarial signature. This envelope is the publication boundary: it pins
 * the contract, game build, platform, actor, limits, decisions, accounting,
 * inputs, and claims; an Ed25519 signature prevents an attacker from rebuilding
 * a public hash chain after editing those fields.
 */
import { createHash, sign, timingSafeEqual, verify, type KeyLike } from 'node:crypto'
import { validatePlatform, type PlatformDescriptor } from './platform'

export type ActorKind = 'agent' | 'human' | 'scripted'

export interface DecisionCore {
  turn: number
  input: string
  latencyMs: number
  costUsd: number
}

export interface DecisionReceipt extends DecisionCore {
  previousHash: string
  hash: string
}

export interface RunEnvelope {
  schemaVersion: 1
  gameId: string
  gameBuild: { id: string; digest: string }
  contractHash: string
  platform: PlatformDescriptor
  actor: { kind: ActorKind; id: string }
  seed: number
  inputs: string[]
  decisions: DecisionReceipt[]
  claimed: string[]
  limits: {
    budgetUsd: number
    maxTurns: number
  }
  accounting: {
    spentUsd: number
    totalLatencyMs: number
  }
  createdAt: string
}

export interface SignedRunEnvelope {
  envelope: RunEnvelope
  digest: string
  signature: {
    algorithm: 'ed25519'
    keyId: string
    value: string
  }
}

export interface IntegrityVerdict {
  valid: boolean
  reasons: string[]
  digest: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** RFC-8785-like canonical JSON for the value types used by run envelopes. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON rejects non-finite numbers')
    return Object.is(value, -0) ? '0' : JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isPlainObject(value)) {
    const fields = Object.keys(value).sort().map((key) => {
      const child = value[key]
      if (child === undefined) throw new Error(`canonical JSON rejects undefined at ${key}`)
      return `${JSON.stringify(key)}:${canonicalJson(child)}`
    })
    return `{${fields.join(',')}}`
  }
  throw new Error(`canonical JSON rejects ${typeof value}`)
}

export function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

export function buildDecisionChain(decisions: readonly DecisionCore[]): DecisionReceipt[] {
  let previousHash = sha256({ domain: 'playproof-decision-chain-v1' })
  return decisions.map((decision, index) => {
    if (decision.turn !== index + 1) throw new Error(`decision turn ${decision.turn} must equal ${index + 1}`)
    if (!decision.input) throw new Error(`decision ${decision.turn} has empty input`)
    if (!Number.isFinite(decision.latencyMs) || decision.latencyMs < 0) throw new Error(`decision ${decision.turn} has invalid latency`)
    if (!Number.isFinite(decision.costUsd) || decision.costUsd < 0) throw new Error(`decision ${decision.turn} has invalid cost`)
    const core: DecisionCore = {
      turn: decision.turn,
      input: decision.input,
      latencyMs: decision.latencyMs,
      costUsd: decision.costUsd,
    }
    const hash = sha256({ previousHash, decision: core })
    const receipt = { ...core, previousHash, hash }
    previousHash = hash
    return receipt
  })
}

export function makeRunEnvelope(args: {
  gameId: string
  gameBuild: { id: string; digest: string }
  contractHash: string
  platform: PlatformDescriptor
  actor: RunEnvelope['actor']
  seed: number
  decisions: readonly DecisionCore[]
  limits: RunEnvelope['limits']
  claimed?: readonly string[]
  createdAt?: string
}): RunEnvelope {
  const decisions = buildDecisionChain(args.decisions)
  return {
    schemaVersion: 1,
    gameId: args.gameId,
    gameBuild: args.gameBuild,
    contractHash: args.contractHash,
    platform: args.platform,
    actor: args.actor,
    seed: args.seed,
    inputs: decisions.map((d) => d.input),
    decisions,
    claimed: [...(args.claimed ?? [])],
    limits: args.limits,
    accounting: {
      spentUsd: round(decisions.reduce((sum, d) => sum + d.costUsd, 0), 8),
      totalLatencyMs: decisions.reduce((sum, d) => sum + d.latencyMs, 0),
    },
    createdAt: args.createdAt ?? new Date().toISOString(),
  }
}

export function signRunEnvelope(envelope: RunEnvelope, privateKey: KeyLike, keyId: string): SignedRunEnvelope {
  if (!keyId.trim()) throw new Error('keyId is required')
  const digest = sha256(envelope)
  const signature = sign(null, signaturePayload(digest, keyId), privateKey).toString('base64')
  return {
    envelope,
    digest,
    signature: { algorithm: 'ed25519', keyId, value: signature },
  }
}

export function verifySignedRunEnvelope(
  signed: SignedRunEnvelope,
  publicKey: KeyLike,
  expected: { gameId?: string; gameBuildDigest?: string; contractHash?: string; platformId?: string; keyId?: string } = {},
): IntegrityVerdict {
  const reasons = validateEnvelope(signed.envelope)
  const digest = sha256(signed.envelope)
  if (!safeHexEqual(signed.digest, digest)) reasons.push('envelope digest mismatch')
  if (signed.signature.algorithm !== 'ed25519') reasons.push(`unsupported signature algorithm ${signed.signature.algorithm}`)
  let signatureOk = false
  try {
    signatureOk = verify(null, signaturePayload(digest, signed.signature.keyId), publicKey, Buffer.from(signed.signature.value, 'base64'))
  } catch {
    signatureOk = false
  }
  if (!signatureOk) reasons.push('envelope signature invalid')
  if (expected.gameId && signed.envelope.gameId !== expected.gameId) reasons.push(`expected gameId ${expected.gameId}`)
  if (expected.gameBuildDigest && signed.envelope.gameBuild.digest !== expected.gameBuildDigest) reasons.push('expected gameBuild digest mismatch')
  if (expected.contractHash && signed.envelope.contractHash !== expected.contractHash) reasons.push('expected contractHash mismatch')
  if (expected.platformId && signed.envelope.platform.id !== expected.platformId) reasons.push(`expected platform ${expected.platformId}`)
  if (expected.keyId && signed.signature.keyId !== expected.keyId) reasons.push(`expected keyId ${expected.keyId}`)
  return { valid: reasons.length === 0, reasons, digest }
}

export function validateEnvelope(envelope: RunEnvelope): string[] {
  const reasons: string[] = []
  if (envelope.schemaVersion !== 1) reasons.push(`unsupported envelope schema ${envelope.schemaVersion}`)
  if (!envelope.gameId) reasons.push('gameId is required')
  if (!envelope.gameBuild.id.trim()) reasons.push('gameBuild id is required')
  if (!/^[0-9a-f]{64}$/i.test(envelope.gameBuild.digest)) reasons.push('gameBuild digest must be sha256 hex')
  if (!/^[0-9a-f]{64}$/i.test(envelope.contractHash)) reasons.push('contractHash must be sha256 hex')
  if (envelope.inputs.length !== envelope.decisions.length) reasons.push('inputs/decisions length mismatch')
  if (!envelope.actor.id.trim()) reasons.push('actor id is required')
  if (!['agent', 'human', 'scripted'].includes(envelope.actor.kind)) reasons.push(`unsupported actor kind ${String(envelope.actor.kind)}`)
  if (!Number.isFinite(envelope.seed)) reasons.push('seed must be finite')
  if (!Number.isFinite(envelope.limits.budgetUsd) || envelope.limits.budgetUsd < 0) reasons.push('budgetUsd must be non-negative')
  if (!Number.isInteger(envelope.limits.maxTurns) || envelope.limits.maxTurns < 0) reasons.push('maxTurns must be a non-negative integer')
  if (envelope.decisions.length > envelope.limits.maxTurns) reasons.push('decision count exceeds maxTurns')
  if (!Number.isFinite(Date.parse(envelope.createdAt))) reasons.push('createdAt must be an ISO timestamp')
  reasons.push(...validatePlatform(envelope.platform).map((reason) => `platform: ${reason}`))

  let previousHash = sha256({ domain: 'playproof-decision-chain-v1' })
  let spent = 0
  let latency = 0
  for (let i = 0; i < envelope.decisions.length; i++) {
    const decision = envelope.decisions[i]!
    if (decision.turn !== i + 1) reasons.push(`decision ${i + 1} turn is ${decision.turn}`)
    if (envelope.inputs[i] !== decision.input) reasons.push(`decision ${i + 1} input mismatch`)
    if (decision.previousHash !== previousHash) reasons.push(`decision ${i + 1} previousHash mismatch`)
    const core: DecisionCore = {
      turn: decision.turn,
      input: decision.input,
      latencyMs: decision.latencyMs,
      costUsd: decision.costUsd,
    }
    const expectedHash = sha256({ previousHash, decision: core })
    if (decision.hash !== expectedHash) reasons.push(`decision ${i + 1} hash mismatch`)
    if (!Number.isFinite(decision.latencyMs) || decision.latencyMs < 0) reasons.push(`decision ${i + 1} latency invalid`)
    if (!Number.isFinite(decision.costUsd) || decision.costUsd < 0) reasons.push(`decision ${i + 1} cost invalid`)
    previousHash = expectedHash
    spent += decision.costUsd
    latency += decision.latencyMs
  }
  if (Math.abs(envelope.accounting.spentUsd - round(spent, 8)) > 1e-8) reasons.push('accounting spentUsd mismatch')
  if (envelope.accounting.totalLatencyMs !== latency) reasons.push('accounting totalLatencyMs mismatch')
  return reasons
}

function signaturePayload(digest: string, keyId: string): Buffer {
  return Buffer.from(canonicalJson({ algorithm: 'ed25519', digest, keyId }))
}

function safeHexEqual(a: string, b: string): boolean {
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b) || a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
}

function round(value: number, places: number): number {
  const scale = 10 ** places
  return Math.round(value * scale) / scale
}
