/**
 * Atari 2600 adapter on the Arcade Learning Environment (`ale-py`).
 *
 * ALE is the substrate the reinforcement-learning literature reports on, so a
 * Playproof score on one of these ROMs is directly comparable with decades of
 * published baselines. The adapter drives `ALEInterface` rather than a
 * Gymnasium wrapper, which keeps the determinism knobs explicit: the seed, the
 * sticky-action probability, and the frame repeat are all set by Playproof.
 *
 * Evidence tiers exercised:
 *   A engine-state — cumulative score, lives, emulator counters, and the RAM
 *     bytes the caller names as channels, never read from the agent
 *   B save-file — sha256 of the serialized `ALEState`
 *   D screen-frame — sha256 of the raw RGB screen
 *
 * `screenImage` turns on the observation image channel: the worker encodes the
 * same RGB screen it hashes for evidence as a PNG, and `observe()` hands it to
 * the agent next to the ASCII text. It is off by default, so an existing run
 * costs the same bytes it costs today.
 *
 * `saveBlobHash` is published here, and that is the opposite of what
 * `adapters/stable-retro` concluded on its own substrate. Measured on Breakout
 * with ale-py 0.12.1: over the 210-input reference, two separate worker
 * processes produced byte-identical `ALEState` serializations at all 211
 * snapshots, alongside identical screens, RAM, and counters. A verifier that
 * never shares the emulator can therefore recompute a save-file milestone.
 * Each substrate earns its tiers with its own measurement.
 *
 * Contracts carry no hand-copied constants. The reference file declares the
 * trigger for each milestone; `deriveContract` replays the reference and
 * samples the value or hash that actually held at that instant.
 *
 * ROMs are not a problem here: ale-py bundles the Atari ROM set under the
 * terms the ALE project distributes it with, so the adapter and its test run
 * on a clean CI machine with no download and no secret.
 *
 * Env knobs:
 *   PLAYPROOF_PYTHON  python interpreter with ale-py installed (default python3)
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { deriveContract, type MarkPoint } from '../authoring'
import type { Evidence, Game, ObservationImage } from '../runtime'
import type { EvidenceTier, MilestoneContract, NumericOperator } from '../schema'
import { AleRpc, type AleIdentity, type AleRamChannel, type WorkerEvidence } from './ale-rpc'

export type { AleIdentity, AleRamChannel }

/** Engine-state triggers. `<` reads a decreasing counter such as lives. */
export type AleTriggerOperator = '>' | '>=' | '<' | '=='

/** Which evidence a milestone pins once its trigger fires. */
export type AleSampleKind = 'state-path' | 'frame-hash' | 'save-hash'

export interface AleMilestoneRule {
  id: string
  tier: EvidenceTier
  /** Engine-state field whose value opens the milestone. */
  variable: string
  op: AleTriggerOperator
  trigger: number
  requires?: string[]
  /** Defaults to `state-path` on `variable`. */
  sample?: AleSampleKind
  /** Evidence key for `state-path`; defaults to `variable`. */
  path?: string
  /** Comparison written into the contract. Defaults to `>=`. */
  sampleOp?: NumericOperator
}

export interface AleReference {
  schemaVersion: 1
  /** ale-py ROM id. */
  game: string
  seed: number
  /** Emulator frames per input the script was recorded at. */
  frames: number
  /** SHA-256 of the ROM the script was recorded against. */
  romSha?: string
  /** RAM bytes the reference expects in evidence. */
  channels?: AleRamChannel[]
  milestones: AleMilestoneRule[]
  inputs: string[]
  provenance?: Record<string, unknown>
}

export interface AleState {
  gen: number
  frame: number
  evidence: Evidence
  frameText: string
  /** Rendered screen, present only when the adapter booted with `screenImage`. */
  frameImage?: ObservationImage
}

export interface AleOptions {
  /** ale-py ROM id, e.g. `breakout`. */
  game: string
  python?: string
  /** Emulator frames per Playproof input. Defaults to the reference's value. */
  frames?: number
  seed?: number
  /** RAM bytes to publish as evidence. Defaults to the reference's channels. */
  channels?: AleRamChannel[]
  mode?: number
  difficulty?: number
  /** Sticky actions. Leave at 0 for a replay-verifiable run. */
  repeatActionProbability?: number
  /**
   * Publish the rendered screen to the agent as a PNG. Off by default.
   *
   * The pixels are observation only. They never enter the input log, the
   * contract, or the attestation, so a run verifies identically with or
   * without them.
   */
  screenImage?: boolean
  /** Whole-pixel upscale of the published screen, 1..8. Native is 160x210. */
  screenScale?: number
  /** Overrides the bundled reference; required for a game with none. */
  reference?: AleReference
}

export interface Ale {
  game: Game<AleState>
  contract: MilestoneContract
  reference: string[]
  /** The game's minimal action set, as `Action` enum names. */
  inputs: string[]
  identity: AleIdentity
  seed: number
  dispose(): void
}

/** References shipped with Playproof, keyed by ale-py ROM id. */
const BUNDLED_REFERENCES: Record<string, string> = {
  breakout: '../ale/reference-breakout.json',
}

export function bundledReference(game: string): AleReference | undefined {
  const path = BUNDLED_REFERENCES[game]
  if (!path) return undefined
  return JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')) as AleReference
}

/** Games Playproof ships a reference playthrough for. */
export function bundledReferenceGames(): string[] {
  return Object.keys(BUNDLED_REFERENCES)
}

function toEvidence(w: WorkerEvidence): Evidence {
  return {
    engineState: w.engineState,
    ...(w.frameHash !== undefined ? { frameHash: w.frameHash } : {}),
    ...(w.saveBlobHash !== undefined ? { saveBlobHash: w.saveBlobHash } : {}),
  }
}

function fires(rule: AleMilestoneRule): (e: Evidence) => boolean {
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
export function aleMarks(rules: AleMilestoneRule[]): MarkPoint[] {
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
        if (kind === 'save-hash') {
          const hash = e.saveBlobHash
          if (hash === undefined) throw new Error(`milestone ${rule.id} wants a save hash the worker did not report`)
          return { kind: 'save-hash' as const, hash }
        }
        const value = e.engineState?.[path]
        if (value === undefined) throw new Error(`milestone ${rule.id} reads unknown engine-state path "${path}"`)
        return { kind, path, op, value }
      },
    }
  })
}

/**
 * Boot an Atari ROM on ALE and derive its contract from the reference script.
 *
 * Replay soundness mirrors the other emulator adapters: `init(seed)` reloads
 * the ROM and reseeds the emulator, and every input is applied in order, so a
 * verifier reproduces the run from the seed and the input log alone. Nothing
 * is carried over between passes.
 */
export function makeAle(options: AleOptions): Ale {
  const reference = options.reference ?? bundledReference(options.game)
  if (!reference) {
    throw new Error(
      `no reference playthrough for ${options.game}; pass one as options.reference (bundled: ${bundledReferenceGames().join(', ')})`,
    )
  }
  if (reference.schemaVersion !== 1) throw new Error(`unsupported reference schemaVersion ${reference.schemaVersion}`)
  if (reference.inputs.length === 0) throw new Error(`reference for ${options.game} has no inputs`)

  // A scale with no image channel is a silent no-op: the worker range-checks
  // it and then renders nothing. Say so instead of ignoring the caller.
  if (options.screenScale !== undefined && options.screenImage !== true) {
    throw new Error('screenScale needs screenImage: true; the screen is only published when the image channel is on')
  }

  const seed = options.seed ?? reference.seed
  const frameSkip = options.frames ?? reference.frames
  const channels = options.channels ?? reference.channels ?? []
  const rpc = new AleRpc(options.python)
  let identity: AleIdentity
  try {
    identity = rpc.boot({
      game: options.game,
      seed,
      frameSkip,
      ...(options.repeatActionProbability !== undefined ? { repeatActionProbability: options.repeatActionProbability } : {}),
      ...(options.mode !== undefined ? { mode: options.mode } : {}),
      ...(options.difficulty !== undefined ? { difficulty: options.difficulty } : {}),
      ...(channels.length > 0 ? { channels } : {}),
      ...(options.screenImage === undefined ? {} : { screenImage: options.screenImage }),
      ...(options.screenScale === undefined ? {} : { screenScale: options.screenScale }),
    })
  } catch (error) {
    rpc.shutdown()
    throw error
  }
  if (reference.romSha && reference.romSha !== identity.romSha) {
    rpc.shutdown()
    throw new Error(
      `ROM identity mismatch for ${identity.game}: reference pins ${reference.romSha.slice(0, 12)}, ale-py loaded ${identity.romSha.slice(0, 12)}`,
    )
  }

  let current: AleState = {
    gen: identity.gen,
    frame: identity.frame,
    evidence: toEvidence(rpc.evidence()),
    frameText: identity.frameText,
    ...(identity.frameImage === undefined ? {} : { frameImage: identity.frameImage }),
  }

  const game: Game<AleState> = {
    id: `ale-${identity.game}`,
    init: (initSeed) => {
      const r = rpc.reset(initSeed)
      const observation = rpc.frameObservation()
      current = {
        gen: r.gen,
        frame: r.frame,
        evidence: toEvidence(rpc.evidence()),
        frameText: observation.text,
        ...(observation.image === undefined ? {} : { frameImage: observation.image }),
      }
      return current
    },
    step: (s, input) => {
      // Staleness guard: gen only changes in init(), so a mismatch means a
      // caller is stepping a state captured against an older emulator boot.
      if (s.gen !== current.gen) {
        throw new Error(`stale state: gen ${s.gen} but worker is at gen ${current.gen} — step ordering violated`)
      }
      const r = rpc.step(input)
      current = {
        gen: current.gen,
        frame: r.frame,
        evidence: toEvidence(r.evidence),
        frameText: r.frameText,
        ...(r.frameImage === undefined ? {} : { frameImage: r.frameImage }),
      }
      return current
    },
    frame: (s) => s.frameText,
    // The agent channel: the ASCII text always, and the rendered screen when
    // the boot asked for it. Never `s.evidence`, which is harness-only.
    observe: (s) => (s.frameImage === undefined
      ? { text: s.frameText }
      : { text: s.frameText, images: [s.frameImage] }),
    evidence: (s) => s.evidence,
    // The worker sets `terminal` when `ale.game_over()` first holds, and from
    // that instant its step loop breaks out before it acts, so no further
    // input reaches the emulator. Reading the flag the worker already
    // publishes keeps one definition of the end of the game.
    over: (s) => s.evidence.engineState?.terminal === 1,
  }

  try {
    const contract = deriveContract(game, seed, reference.inputs, aleMarks(reference.milestones))
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
