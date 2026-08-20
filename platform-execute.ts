import { sign, verify, type KeyLike } from 'node:crypto'
import { canonicalJson, sha256, verifySignedRunEnvelope, type SignedRunEnvelope } from './artifact'
import { executeBenchmark, type ExecuteBenchmarkOptions, type ExecutedBenchmark } from './execute'
import {
  evaluatePlatformEvidence,
  validatePlatformEvidenceBundle,
  type PlatformEvidenceBundle,
  type PlatformEvidenceSource,
  type PlatformMilestonePolicy,
} from './platform-evidence'
import type { BenchmarkTarget } from './platform'
import type { AgentDriver } from './episode'

export interface PlatformRunEnvelope {
  schemaVersion: 1
  run: SignedRunEnvelope
  platformEvidence: PlatformEvidenceBundle
  createdAt: string
}

export interface SignedPlatformRun {
  envelope: PlatformRunEnvelope
  digest: string
  signature: {
    algorithm: 'ed25519'
    keyId: string
    value: string
  }
}

export interface ExecutePlatformBenchmarkOptions extends ExecuteBenchmarkOptions {
  evidenceSource: PlatformEvidenceSource
  policies: readonly PlatformMilestonePolicy[]
}

export interface ExecutedPlatformBenchmark extends ExecutedBenchmark {
  platformSigned: SignedPlatformRun
}

export async function executePlatformBenchmark<S>(
  target: BenchmarkTarget<S>,
  driver: AgentDriver,
  options: ExecutePlatformBenchmarkOptions,
): Promise<ExecutedPlatformBenchmark> {
  const baseline = await options.evidenceSource.capture()
  const executed = await executeBenchmark(target, driver, options)
  const final = await options.evidenceSource.capture()
  const platformEvidence = evaluatePlatformEvidence(baseline, final, options.policies)
  if (platformEvidence.verdict !== 'clean') {
    throw new Error(`platform evidence rejected: ${platformEvidence.reasons.join('; ')}`)
  }
  const envelope: PlatformRunEnvelope = {
    schemaVersion: 1,
    run: executed.signed,
    platformEvidence,
    createdAt: options.createdAt ?? new Date().toISOString(),
  }
  const digest = sha256(envelope)
  const value = sign(null, signaturePayload(digest, options.signer.keyId), options.signer.privateKey).toString('base64')
  return {
    ...executed,
    platformSigned: {
      envelope,
      digest,
      signature: { algorithm: 'ed25519', keyId: options.signer.keyId, value },
    },
  }
}

/**
 * Total verifier for untrusted published bytes. It never throws for malformed
 * structure; every failure becomes a reason. The outer signature authenticates
 * the configured recorder, not Steam/Xbox themselves. Provider authenticity is
 * limited to the recorder's authorized API/SDK capture unless a future adapter
 * includes a provider-signed token.
 */
export function verifySignedPlatformRun(
  value: unknown,
  publicKey: KeyLike,
  expected: {
    gameId?: string
    gameBuildDigest?: string
    contractHash?: string
    platformId?: string
    keyId?: string
    provider?: string
    receiptGameId?: string
    userId?: string
    environment?: string
  } = {},
): { valid: boolean; reasons: string[]; digest: string } {
  const reasons: string[] = []
  let digest = ''
  try {
    if (!isRecord(value)) return invalid('platform run must be an object')
    const envelope = value.envelope
    const signature = value.signature
    const claimedDigest = value.digest
    if (!isRecord(envelope) || !isRecord(signature) || typeof claimedDigest !== 'string') {
      return invalid('platform envelope structure invalid')
    }
    if (envelope.schemaVersion !== 1) reasons.push(`unsupported platform run schema ${String(envelope.schemaVersion)}`)
    if (typeof envelope.createdAt !== 'string' || !Number.isFinite(Date.parse(envelope.createdAt))) {
      reasons.push('platform run createdAt is invalid')
    }
    if (!isRecord(envelope.run) || !isRecord(envelope.platformEvidence)) {
      return invalid('platform envelope structure invalid')
    }
    digest = sha256(envelope)
    if (claimedDigest !== digest) reasons.push('platform run digest mismatch')
    if (signature.algorithm !== 'ed25519') reasons.push(`unsupported platform signature ${String(signature.algorithm)}`)
    if (typeof signature.keyId !== 'string' || !signature.keyId.trim()) reasons.push('platform signature keyId is invalid')
    if (typeof signature.value !== 'string') reasons.push('platform signature value is invalid')
    let signatureValid = false
    if (typeof signature.keyId === 'string' && typeof signature.value === 'string') {
      try {
        signatureValid = verify(null, signaturePayload(digest, signature.keyId), publicKey, Buffer.from(signature.value, 'base64'))
      } catch {
        signatureValid = false
      }
    }
    if (!signatureValid) reasons.push('platform run signature invalid')
    if (expected.keyId && signature.keyId !== expected.keyId) reasons.push(`expected keyId ${expected.keyId}`)

    const inner = verifySignedRunEnvelope(envelope.run as unknown as SignedRunEnvelope, publicKey, {
      ...(expected.gameId !== undefined ? { gameId: expected.gameId } : {}),
      ...(expected.gameBuildDigest !== undefined ? { gameBuildDigest: expected.gameBuildDigest } : {}),
      ...(expected.contractHash !== undefined ? { contractHash: expected.contractHash } : {}),
      ...(expected.platformId !== undefined ? { platformId: expected.platformId } : {}),
      ...(expected.keyId !== undefined ? { keyId: expected.keyId } : {}),
    })
    reasons.push(...inner.reasons.map((reason) => `run: ${reason}`))

    const platformEvidence = envelope.platformEvidence
    reasons.push(...validatePlatformEvidenceBundle(platformEvidence).map((reason) => `platform evidence: ${reason}`))
    const baseline = isRecord(platformEvidence.baseline) ? platformEvidence.baseline : null
    if (!baseline) {
      reasons.push('platform evidence: baseline structure invalid')
    } else {
      if (expected.provider && baseline.provider !== expected.provider) reasons.push(`expected receipt provider ${expected.provider}`)
      if (expected.receiptGameId && baseline.gameId !== expected.receiptGameId) reasons.push(`expected receipt gameId ${expected.receiptGameId}`)
      if (expected.userId && baseline.userId !== expected.userId) reasons.push(`expected receipt user ${expected.userId}`)
      if (expected.environment && baseline.environment !== expected.environment) reasons.push(`expected receipt environment ${expected.environment}`)
    }
  } catch (error) {
    reasons.push(`platform envelope structure invalid: ${(error as Error).message}`)
  }
  return { valid: reasons.length === 0, reasons, digest }

  function invalid(reason: string): { valid: false; reasons: string[]; digest: string } {
    return { valid: false, reasons: [reason], digest: '' }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function signaturePayload(digest: string, keyId: string): Buffer {
  return Buffer.from(canonicalJson({ domain: 'playproof-platform-run-v1', algorithm: 'ed25519', digest, keyId }))
}
