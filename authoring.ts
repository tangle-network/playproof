/** Derive a contract from one demonstrated trajectory without copying constants by hand. */
import type { Evidence, Game, Input } from './runtime'
import { logFrom, replay } from './runtime'
import type { EvidenceTier, GlitchLegality, Milestone, MilestoneCheck, MilestoneContract, NumericOperator } from './schema'
import { validateContract } from './schema'

export interface MarkPoint {
  afterInputs?: number
  when?: (e: Evidence) => boolean
  id: string
  tier: EvidenceTier
  glitchClass: GlitchLegality
  requires?: string[]
  sample: (e: Evidence) => MilestoneCheck
}

function numericHolds(state: Record<string, number> | undefined, path: string, op: NumericOperator, expected: number): boolean {
  const value = state?.[path]
  if (value === undefined) return false
  if (op === '>=') return value >= expected
  if (op === '>') return value > expected
  return value === expected
}

function checkHolds(check: MilestoneCheck, evidence: Evidence): boolean {
  switch (check.kind) {
    case 'state-path': return numericHolds(evidence.engineState, check.path, check.op, check.value)
    case 'save-path': return numericHolds(evidence.saveState, check.path, check.op, check.value)
    case 'save-hash': return evidence.saveBlobHash === check.hash
    case 'log-contains': return (evidence.logEvents ?? []).includes(check.event)
    case 'frame-path': return numericHolds(evidence.frameState, check.path, check.op, check.value)
    case 'frame-hash': return evidence.frameHash === check.hash
  }
}

/**
 * Derive a milestone contract from one demonstrated trajectory.
 *
 * The result is a HYPOTHESIS, not a benchmark. This function proves only that
 * every mark fires on the reference run and that the contract validates. It
 * cannot know whether the progressions it pinned are hard to reach: a mark
 * anchored on a memory channel that moves whenever the game runs at all yields
 * a contract that a constant button press satisfies exactly as well as an
 * evaluated agent does.
 *
 * Blind-discovery marks are the sharp case, because nothing in the pipeline
 * ever asserts that a discovered channel means progress.
 *
 * It also cannot know what a mark DEMONSTRATES. A mark on a life counter fires
 * when the reference dies, and a contract that scores it rewards the run that
 * played worse.
 *
 * Run `calibrateContract` from calibration.ts on the derived contract and gate
 * publication with `PackagedContract.calibrate`, which refuses a contract that
 * does not separate, an undeclared hash, an undeclared attrition milestone, and
 * a contract every milestone of which requires one event. A contract that no
 * trivial policy can satisfy is a benchmark; an uncalibrated one is a guess.
 */
export function deriveContract<S>(
  game: Game<S>,
  seed: number,
  reference: Input[],
  marks: MarkPoint[],
): MilestoneContract {
  const firstSatisfying = new Map<MarkPoint, number>()
  if (marks.some((m) => m.when !== undefined)) {
    let state = game.init(seed)
    const consider = (e: Evidence, index: number): void => {
      for (const m of marks) {
        if (m.when && !firstSatisfying.has(m) && m.when(e)) firstSatisfying.set(m, index)
      }
    }
    consider(game.evidence(state), 0)
    let i = 0
    for (const input of reference) {
      state = game.step(state, input)
      i++
      consider(game.evidence(state), i)
    }
    for (const m of marks) {
      if (m.when && !firstSatisfying.has(m)) {
        throw new Error(`mark ${m.id} never fires on the reference playthrough for ${game.id}`)
      }
    }
  }

  const withPositions = marks.map((m) => {
    if (m.when !== undefined) return { ...m, afterInputs: firstSatisfying.get(m) }
    if (m.afterInputs === undefined) throw new Error(`mark ${m.id} needs afterInputs or when`)
    return m
  })
  if (withPositions.some((m) => m.afterInputs! > reference.length || m.afterInputs! < 0)) {
    throw new Error(`mark afterInputs must be within 0..${reference.length} for ${game.id} (0 = pre-input snapshot)`)
  }

  const milestones: Milestone[] = withPositions.map((m) => {
    const state = replay(game, seed, logFrom(seed, reference.slice(0, m.afterInputs)))
    const evidence = game.evidence(state)
    const check = m.sample(evidence)
    if (!checkHolds(check, evidence)) {
      throw new Error(`mark ${m.id} samples a check that does not hold at its own mark (${m.afterInputs} inputs) for ${game.id}`)
    }
    return {
      id: m.id,
      tier: m.tier,
      requires: m.requires ?? [],
      check,
      glitchClass: m.glitchClass,
    }
  })
  const contract: MilestoneContract = { schemaVersion: 1, gameId: game.id, milestones }
  const violations = validateContract(contract)
  if (violations.length > 0) throw new Error(`derived contract for ${game.id} is invalid: ${violations.join('; ')}`)
  return contract
}
