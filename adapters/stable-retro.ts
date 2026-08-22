/**
 * Multi-console adapter on stable-retro: every libretro core the package
 * bundles becomes a Playproof `Game` with the same guarantees the PyBoy
 * adapter gives on the Game Boy.
 *
 * Consoles reachable through one worker: NES, SNES, Genesis/Mega Drive,
 * Game Boy, Game Boy Color, Game Boy Advance, Atari 2600, Sega Master System,
 * Game Gear, and PC Engine. Nothing in this file is console-specific.
 *
 * Evidence tiers exercised:
 *   A engine-state — the game's integration variables (score, lives, level, …)
 *     read from RAM through the integration's data.json, never from the agent
 *   D screen-frame — sha256 of the rendered frame, plus bounded numbers
 *     derived from it (`frameState`)
 *
 * Deliberately absent: `saveBlobHash`. Measured on stable-retro 1.0.1, the raw
 * libretro save-state serialization is not byte-stable across processes — 165
 * of 1036288 bytes move, in padding around offset 140k — while the rendered
 * frames and the integration variables are bit-identical. Hashing the save
 * blob would therefore pin a milestone that a correct replay cannot reproduce.
 * Checkpoints stay exact within one worker, which is all snapshot/restore
 * needs; `stable-retro.test.mts` proves both halves of that claim.
 *
 * Contracts carry no hand-copied constants. The reference file declares the
 * trigger for each milestone; `deriveContract` replays the reference and
 * samples the value and the frame hash that actually held at that instant.
 *
 * ROMs are never distributed by Playproof. `Airstriker-Genesis` is the one
 * exception the ecosystem already ships: it comes with stable-retro under a
 * free licence, so the adapter and its test run on a clean CI machine.
 * Bring other legally obtained ROMs in with `python -m retro.import <dir>`.
 *
 * Env knobs:
 *   PLAYPROOF_PYTHON  python interpreter with stable-retro installed (default python3)
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { deriveContract, type MarkPoint } from '../authoring'
import type { Evidence, Game, ObservationImage } from '../runtime'
import type { EvidenceTier, MilestoneContract, NumericOperator } from '../schema'
import { RetroRpc, type RetroIdentity, type WorkerEvidence } from './retro-rpc'

/** Integration variable triggers. `<` reads a decreasing counter such as lives. */
export type RetroTriggerOperator = '>' | '>=' | '<' | '=='

/** Which evidence a milestone pins once its trigger fires. */
export type RetroSampleKind = 'state-path' | 'frame-hash' | 'frame-path'

export interface RetroMilestoneRule {
  id: string
  tier: EvidenceTier
  /** Integration variable whose value opens the milestone. */
  variable: string
  op: RetroTriggerOperator
  trigger: number
  requires?: string[]
  /** Defaults to `state-path` on `variable`. */
  sample?: RetroSampleKind
  /** Evidence key for `frame-path`; defaults to `variable` for `state-path`. */
  path?: string
  /** Comparison written into the contract. Defaults to `>=`. */
  sampleOp?: NumericOperator
}

export interface RetroReference {
  schemaVersion: 1
  game: string
  state: string | null
  seed: number
  frames: number
  romSha: string | null
  milestones: RetroMilestoneRule[]
  inputs: string[]
  provenance?: Record<string, unknown>
}

export interface RetroState {
  gen: number
  frame: number
  evidence: Evidence
  frameText: string
  /** Rendered screen, present only when the adapter booted with `screenImage`. */
  frameImage?: ObservationImage
}

export interface StableRetroOptions {
  /** Integration name, with or without the `-v0` suffix. */
  game: string
  state?: string
  scenario?: string
  players?: number
  /** Emulator frames per Playproof input. Defaults to the reference's value. */
  frames?: number
  seed?: number
  python?: string
  /**
   * Publish the rendered screen to the agent as a PNG. Off by default.
   *
   * The pixels are observation only. They never enter the input log, the
   * contract, or the attestation, so a run verifies identically with or
   * without them.
   */
  screenImage?: boolean
  /** Whole-pixel upscale of the published screen, 1..8. */
  screenScale?: number
  /** Overrides the bundled reference; required for a game with none. */
  reference?: RetroReference
}

export interface StableRetro {
  game: Game<RetroState>
  contract: MilestoneContract
  reference: string[]
  /** Advertised input vocabulary for this console's button layout. */
  inputs: string[]
  identity: RetroIdentity
  seed: number
  dispose(): void
}

/**
 * References shipped with Playproof, keyed by integration name without the
 * `-v0` suffix. Only free ROMs that stable-retro itself distributes belong
 * here; everything else is caller-supplied.
 */
const BUNDLED_REFERENCES: Record<string, string> = {
  'Airstriker-Genesis': '../retro/reference-airstriker.json',
}

function normalizeGame(game: string): string {
  return game.endsWith('-v0') ? game.slice(0, -3) : game
}

export function bundledReference(game: string): RetroReference | undefined {
  const path = BUNDLED_REFERENCES[normalizeGame(game)]
  if (!path) return undefined
  return JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')) as RetroReference
}

/** Games Playproof ships a reference playthrough for. */
export function bundledReferenceGames(): string[] {
  return Object.keys(BUNDLED_REFERENCES)
}

function toEvidence(w: WorkerEvidence): Evidence {
  return {
    engineState: w.engineState,
    ...(w.frameHash !== undefined ? { frameHash: w.frameHash } : {}),
    ...(w.frameState !== undefined ? { frameState: w.frameState } : {}),
  }
}

function fires(rule: RetroMilestoneRule): (e: Evidence) => boolean {
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
export function retroMarks(rules: RetroMilestoneRule[]): MarkPoint[] {
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
 * Boot a stable-retro game and derive its contract from the reference script.
 *
 * Replay soundness mirrors the PyBoy adapters: `init(seed)` rebuilds the
 * emulator from the integration's start state and every input is applied in
 * order, so a verifier reproduces the run from the seed and the input log
 * alone. Nothing is carried over between passes.
 */
export function makeStableRetro(options: StableRetroOptions): StableRetro {
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
  const frameskip = options.frames ?? reference.frames
  const rpc = new RetroRpc(options.python)
  let identity: RetroIdentity
  try {
    identity = rpc.boot({
      game: options.game,
      ...(options.state ?? reference.state ? { state: options.state ?? reference.state! } : {}),
      ...(options.scenario !== undefined ? { scenario: options.scenario } : {}),
      ...(options.players !== undefined ? { players: options.players } : {}),
      ...(options.screenImage === undefined ? {} : { screenImage: options.screenImage }),
      ...(options.screenScale === undefined ? {} : { screenScale: options.screenScale }),
      frameskip,
      seed,
    })
  } catch (error) {
    rpc.shutdown()
    throw error
  }
  if (reference.romSha && identity.romSha && reference.romSha !== identity.romSha) {
    rpc.shutdown()
    throw new Error(
      `ROM identity mismatch for ${identity.game}: reference pins ${reference.romSha.slice(0, 12)}, core loaded ${identity.romSha.slice(0, 12)}`,
    )
  }

  let current: RetroState = {
    gen: identity.gen,
    frame: identity.frame,
    evidence: toEvidence(rpc.evidence()),
    frameText: identity.frameText,
    ...(identity.frameImage === undefined ? {} : { frameImage: identity.frameImage }),
  }

  const game: Game<RetroState> = {
    id: `stable-retro-${normalizeGame(identity.game)}`,
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
    // The agent channel: the text observation always, and the rendered screen
    // when the boot asked for it. Never `s.evidence`, which is harness-only.
    observe: (s) => (s.frameImage === undefined
      ? { text: s.frameText }
      : { text: s.frameText, images: [s.frameImage] }),
    evidence: (s) => s.evidence,
  }

  try {
    const contract = deriveContract(game, seed, reference.inputs, retroMarks(reference.milestones))
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
