/**
 * Playproof attestation plane.
 *
 * Replay mode never trusts submitted progress: it re-executes the pinned input
 * script against a verifier-owned game. Signed recorder and platform-receipt
 * modes use artifact.ts and platform-specific receipt verification instead;
 * they are explicitly weaker than deterministic replay.
 */
import { logFrom } from './runtime'
import type { Evidence, Game, Input, InputLog } from './runtime'
import { contractHash, earnedMilestones, scoreMilestones } from './schema'
import type { Milestone, MilestoneContract, MilestoneScore, NumericOperator } from './schema'

export interface Attestation {
  gameId: string
  verdict: 'clean' | 'rejected'
  reasons: string[]
  /** Every milestone the replay reproduced, replay-identity checks included. */
  verified: string[]
  /**
   * The subset of `verified` an independent policy can earn by playing.
   *
   * A hash check proves a replay reproduced the recorded run. Counting it as
   * progress inflates the denominator of every reported score, so the two sets
   * are reported apart. `verified` stays the attestation statement.
   */
  earned: string[]
  score: MilestoneScore
  checks: { name: string; passed: boolean }[]
}

function numericHolds(state: Record<string, number> | undefined, path: string, op: NumericOperator, expected: number): boolean {
  const value = state?.[path]
  if (value === undefined) return false
  if (op === '>=') return value >= expected
  if (op === '>') return value > expected
  return value === expected
}

function holds(m: Milestone, e: Evidence): boolean {
  switch (m.check.kind) {
    case 'state-path':
      return numericHolds(e.engineState, m.check.path, m.check.op, m.check.value)
    case 'save-path':
      return numericHolds(e.saveState, m.check.path, m.check.op, m.check.value)
    case 'save-hash':
      return e.saveBlobHash === m.check.hash
    case 'log-contains':
      return (e.logEvents ?? []).includes(m.check.event)
    case 'frame-path':
      return numericHolds(e.frameState, m.check.path, m.check.op, m.check.value)
    case 'frame-hash':
      return e.frameHash === m.check.hash
  }
}

/**
 * A milestone holds if it holds at any snapshot along replay, with requires
 * satisfied by earlier snapshots or earlier declarations in the same snapshot.
 */
export class MilestoneTracker {
  private readonly passed = new Set<string>()
  private readonly order: string[] = []

  constructor(private readonly contract: MilestoneContract) {}

  consider(e: Evidence): string[] {
    const newly: string[] = []
    for (const m of this.contract.milestones) {
      if (this.passed.has(m.id)) continue
      if (m.requires.every((r) => this.passed.has(r)) && holds(m, e)) {
        this.passed.add(m.id)
        this.order.push(m.id)
        newly.push(m.id)
      }
    }
    return newly
  }

  verified(): string[] {
    return [...this.order]
  }
}

export function verifyAlongReplay<S>(game: Game<S>, contract: MilestoneContract, seed: number, log: InputLog): string[] {
  const tracker = new MilestoneTracker(contract)
  let state = game.init(seed)
  tracker.consider(game.evidence(state))
  for (const input of log.inputs()) {
    state = game.step(state, input)
    tracker.consider(game.evidence(state))
  }
  return tracker.verified()
}

export function attestRun<S>(
  game: Game<S>,
  contract: MilestoneContract,
  seed: number,
  log: InputLog,
  claimed: string[],
): Attestation {
  if (game.id !== contract.gameId) {
    throw new Error(`game/contract mismatch: game is "${game.id}" but contract is for "${contract.gameId}"`)
  }
  const reasons: string[] = []
  const chainOk = log.chainValid()
  if (!chainOk) reasons.push('input-log-chain-broken')

  const verified = verifyAlongReplay(game, contract, seed, log)
  const known = new Set(contract.milestones.map((m) => m.id))
  const unknownClaims = claimed.filter((c) => !known.has(c))
  if (unknownClaims.length > 0) reasons.push(`claimed-unknown:${unknownClaims.join(',')}`)
  const notReproduced = claimed.filter((c) => known.has(c) && !verified.includes(c))
  if (notReproduced.length > 0) reasons.push(`claimed-not-reproduced:${notReproduced.join(',')}`)

  return {
    gameId: contract.gameId,
    verdict: reasons.length === 0 ? 'clean' : 'rejected',
    reasons,
    verified,
    earned: earnedMilestones(contract, verified),
    score: scoreMilestones(contract, verified),
    checks: [
      { name: 'input-log-chain', passed: chainOk },
      { name: 'claimed-milestones-reproduced', passed: notReproduced.length === 0 && unknownClaims.length === 0 },
    ],
  }
}

/** Advisory anomaly signal, never a hard cheat verdict by itself. */
export interface InputStats {
  inputs: number
  uniqueRatio: number
  maxAlternationStreak: number
  superhuman: boolean
  reason: string | null
}

export function inputStatistics(inputs: readonly Input[]): InputStats {
  const n = inputs.length
  if (n === 0) return { inputs: 0, uniqueRatio: 0, maxAlternationStreak: 0, superhuman: false, reason: null }
  const unique = new Set(inputs).size
  let alt = 0
  let best = 0
  for (let i = 1; i < n; i++) {
    alt = inputs[i] !== inputs[i - 1] ? alt + 1 : 0
    if (alt > best) best = alt
  }
  const superhuman = best >= 40
  return {
    inputs: n,
    uniqueRatio: unique / n,
    maxAlternationStreak: best,
    superhuman,
    reason: superhuman ? `alternation streak ${best} >= 40 (frame-perfect zigzag signature)` : null,
  }
}

export interface RunArtifact {
  gameId: string
  contractHash: string
  seed: number
  inputs: Input[]
  claimed: string[]
}

export interface ArtifactVerdict {
  verdict: 'clean' | 'rejected'
  reasons: string[]
  recomputed: string[]
}

/** In-memory verification. Remote/published artifacts must first pass artifact.ts signature verification. */
export function verifyRunArtifact<S>(game: Game<S>, contract: MilestoneContract, artifact: RunArtifact): ArtifactVerdict {
  const reasons: string[] = []
  if (artifact.gameId !== contract.gameId) reasons.push(`artifact gameId ${artifact.gameId} != contract ${contract.gameId}`)
  const hash = contractHash(contract)
  if (artifact.contractHash !== hash) {
    reasons.push(`contract hash mismatch: artifact pins ${artifact.contractHash.slice(0, 12)}, verifier computed ${hash.slice(0, 12)} — contract was swapped or doctored`)
  }
  const log = logFrom(artifact.seed, artifact.inputs)
  const attestation = attestRun(game, contract, artifact.seed, log, artifact.claimed)
  for (const r of attestation.reasons) reasons.push(r)
  return { verdict: reasons.length === 0 ? 'clean' : 'rejected', reasons, recomputed: attestation.verified }
}
