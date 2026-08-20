/**
 * Gymnasium adapter: any registered environment with a discrete action space
 * becomes a Playproof `Game`.
 *
 * Reach in one worker: classic control (CartPole, MountainCar, Acrobot), toy
 * text (FrozenLake, CliffWalking, Taxi), and every third-party environment
 * that registers with Gymnasium and exposes `Discrete` actions — procedurally
 * generated suites and text games included. Nothing in this file is
 * environment-specific.
 *
 * Evidence tiers exercised:
 *   A engine-state — cumulative reward, step count, termination flags, and the
 *     numeric entries of the environment's `info` dictionary
 *   D screen-frame — sha256 of the whole observation, plus a bounded numeric
 *     projection of it (`frameState`)
 *
 * The honest limit, stated once: a generic Gymnasium environment has no
 * privileged channel the agent cannot author. Reward, `info`, and the
 * observation are exactly what the environment hands the policy, so this
 * adapter cannot offer a progress signal hidden from the agent the way an
 * emulator adapter reads score out of RAM. Verification still holds, because
 * it is replay: the verifier re-executes the environment from the seed and the
 * input log and recomputes every milestone, so a claim the environment does
 * not produce is rejected. Read the tier as "reward-derived", not "hidden".
 *
 * Determinism is a per-environment property, never an assumption. Replay
 * verification needs `reset(seed=...)` to fix the entire trajectory: either
 * the dynamics are deterministic, or every stochastic draw comes from the
 * environment's seeded `np_random`. CartPole-v1 and FrozenLake-v1 with
 * `is_slippery: false` satisfy this and `gymnasium.test.mts` measures it
 * across separate worker processes. An environment that reads a clock, a
 * global RNG, or external state must not be given a contract.
 *
 * Contracts carry no hand-copied constants. The reference file declares the
 * trigger for each milestone; `deriveContract` replays the reference and
 * samples the value and the frame hash that actually held at that instant.
 *
 * Env knobs:
 *   PLAYPROOF_PYTHON  python interpreter with gymnasium installed (default python3)
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { deriveContract, type MarkPoint } from '../authoring'
import type { Evidence, Game } from '../runtime'
import type { EvidenceTier, MilestoneContract, NumericOperator } from '../schema'
import { GymRpc, type GymIdentity, type WorkerEvidence } from './gym-rpc'

/** Engine-state triggers. `<` reads a decreasing counter. */
export type GymTriggerOperator = '>' | '>=' | '<' | '=='

/** Which evidence a milestone pins once its trigger fires. */
export type GymSampleKind = 'state-path' | 'frame-hash' | 'frame-path'

export interface GymMilestoneRule {
  id: string
  tier: EvidenceTier
  /** Engine-state key whose value opens the milestone, such as `steps`. */
  variable: string
  op: GymTriggerOperator
  trigger: number
  requires?: string[]
  /** Defaults to `state-path` on `variable`. */
  sample?: GymSampleKind
  /** Evidence key for `frame-path`; defaults to `variable` for `state-path`. */
  path?: string
  /** Comparison written into the contract. Defaults to `>=`. */
  sampleOp?: NumericOperator
}

export interface GymReference {
  schemaVersion: 1
  envId: string
  seed: number
  /** Arguments for `gymnasium.make`; part of the environment's identity. */
  kwargs?: Record<string, unknown>
  maxEpisodeSteps?: number
  milestones: GymMilestoneRule[]
  inputs: string[]
  provenance?: Record<string, unknown>
}

export interface GymState {
  gen: number
  frame: number
  evidence: Evidence
  frameText: string
}

export interface GymnasiumOptions {
  /** Registered environment id, such as `CartPole-v1`. */
  envId: string
  seed?: number
  /** Extra `gymnasium.make` arguments. Defaults to the reference's. */
  kwargs?: Record<string, unknown>
  maxEpisodeSteps?: number
  python?: string
  /** Overrides the bundled reference; required for an environment with none. */
  reference?: GymReference
}

export interface Gymnasium {
  game: Game<GymState>
  contract: MilestoneContract
  /** The reference input script the contract was derived from. */
  reference: string[]
  /** Advertised input vocabulary: one word per discrete action, plus `NOOP`. */
  inputs: string[]
  identity: GymIdentity
  seed: number
  dispose(): void
}

/**
 * References shipped with Playproof. Both environments are part of Gymnasium
 * itself, so the adapter gate runs on a clean CI machine with no asset.
 */
const BUNDLED_REFERENCES: Record<string, string> = {
  'CartPole-v1': '../gym/reference-cartpole.json',
  'FrozenLake-v1': '../gym/reference-frozenlake.json',
}

export function bundledReference(envId: string): GymReference | undefined {
  const path = BUNDLED_REFERENCES[envId]
  if (!path) return undefined
  return JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')) as GymReference
}

/** Environments Playproof ships a reference playthrough for. */
export function bundledReferenceEnvironments(): string[] {
  return Object.keys(BUNDLED_REFERENCES)
}

function toEvidence(w: WorkerEvidence): Evidence {
  return {
    engineState: w.engineState,
    ...(w.frameHash !== undefined ? { frameHash: w.frameHash } : {}),
    ...(w.frameState !== undefined ? { frameState: w.frameState } : {}),
  }
}

function fires(rule: GymMilestoneRule): (e: Evidence) => boolean {
  return (e: Evidence): boolean => {
    const value = e.engineState?.[rule.variable]
    if (value === undefined) return false
    if (rule.op === '>') return value > rule.trigger
    if (rule.op === '>=') return value >= rule.trigger
    if (rule.op === '<') return value < rule.trigger
    return value === rule.trigger
  }
}

/**
 * Turn declared rules into authoring marks. The rule fixes only WHERE a
 * milestone opens; `deriveContract` reads WHAT held there off the replay.
 */
export function gymMarks(rules: GymMilestoneRule[]): MarkPoint[] {
  if (rules.length === 0) throw new Error('reference declares no milestones — nothing to build a contract from')
  return rules.map((rule) => {
    const kind = rule.sample ?? 'state-path'
    const op = rule.sampleOp ?? '>='
    const path = rule.path ?? rule.variable
    return {
      when: fires(rule),
      id: rule.id,
      tier: rule.tier,
      glitchClass: 'legal' as const,
      requires: rule.requires ?? [],
      sample: (e: Evidence) => {
        if (kind === 'frame-hash') {
          const hash = e.frameHash
          if (hash === undefined) throw new Error(`milestone ${rule.id} wants a frame hash the worker did not report`)
          return { kind: 'frame-hash' as const, hash }
        }
        const source = kind === 'frame-path' ? e.frameState : e.engineState
        const value = source?.[path]
        if (value === undefined) throw new Error(`milestone ${rule.id} reads unknown ${kind} "${path}"`)
        return { kind, path, op, value }
      },
    }
  })
}

/**
 * Boot a Gymnasium environment and derive its contract from the reference.
 *
 * Replay soundness: `init(seed)` calls `env.reset(seed=seed)` and every input
 * is applied in order, so a verifier reproduces the run from the seed and the
 * input log alone. Nothing carries over between passes.
 */
export function makeGymnasium(options: GymnasiumOptions): Gymnasium {
  const reference = options.reference ?? bundledReference(options.envId)
  if (!reference) {
    throw new Error(
      `no reference playthrough for ${options.envId}; pass one as options.reference (bundled: ${bundledReferenceEnvironments().join(', ')})`,
    )
  }
  if (reference.schemaVersion !== 1) throw new Error(`unsupported reference schemaVersion ${reference.schemaVersion}`)
  if (reference.inputs.length === 0) throw new Error(`reference for ${options.envId} has no inputs`)

  const seed = options.seed ?? reference.seed
  const kwargs = options.kwargs ?? reference.kwargs
  const maxEpisodeSteps = options.maxEpisodeSteps ?? reference.maxEpisodeSteps
  const rpc = new GymRpc(options.python)
  let identity: GymIdentity
  try {
    identity = rpc.boot({
      envId: options.envId,
      seed,
      ...(kwargs !== undefined ? { kwargs } : {}),
      ...(maxEpisodeSteps !== undefined ? { maxEpisodeSteps } : {}),
    })
  } catch (error) {
    rpc.shutdown()
    throw error
  }

  let current: GymState = {
    gen: identity.gen,
    frame: identity.frame,
    evidence: toEvidence(rpc.evidence()),
    frameText: identity.frameText,
  }

  const game: Game<GymState> = {
    id: `gymnasium-${identity.envId}`,
    init: (initSeed) => {
      const r = rpc.reset(initSeed)
      current = { gen: r.gen, frame: r.frame, evidence: toEvidence(rpc.evidence()), frameText: rpc.frameText() }
      return current
    },
    step: (s, input) => {
      // Staleness guard: gen only changes in init(), so a mismatch means a
      // caller is stepping a state captured against an older environment.
      if (s.gen !== current.gen) {
        throw new Error(`stale state: gen ${s.gen} but worker is at gen ${current.gen} — step ordering violated`)
      }
      const r = rpc.step(input)
      current = { gen: current.gen, frame: r.frame, evidence: toEvidence(r.evidence), frameText: r.frameText }
      return current
    },
    frame: (s) => s.frameText,
    evidence: (s) => s.evidence,
  }

  try {
    const contract = deriveContract(game, seed, reference.inputs, gymMarks(reference.milestones))
    return {
      game,
      contract,
      reference: reference.inputs,
      inputs: identity.inputs,
      identity,
      seed,
      dispose: () => rpc.shutdown(),
    }
  } catch (error) {
    rpc.shutdown()
    throw error
  }
}
