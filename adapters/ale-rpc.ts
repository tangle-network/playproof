/** Thin Arcade Learning Environment specialization of the shared out-of-process WorkerRpc protocol. */
import { fileURLToPath } from 'node:url'
import type { ObservationImage } from '../runtime'
import { WorkerRpc, type WorkerEvidence, type WorkerStepResult } from './worker-rpc'

const WORKER_PATH = fileURLToPath(new URL('../ale/worker.py', import.meta.url))

/**
 * One protocol line may now carry a rendered screen. An observation image is
 * capped at 1 MiB decoded, which is about 1.4 MB of base64 before the JSON
 * around it, so the transport bound is raised above what a legal image can
 * produce. Otherwise the transport would reject the line first and report a
 * byte count instead of the cap the caller actually breached.
 */
const MAX_RESPONSE_BYTES = 8 << 20

export type { WorkerEvidence }
export type StepResult = WorkerStepResult

/** One RAM byte published as a named evidence field. */
export interface AleRamChannel {
  /** Evidence key, e.g. `ram_ball_x`. */
  id: string
  /** RAM byte index, 0..127. */
  index: number
  decode: 'u8'
}

export interface AleBootOptions {
  /** ale-py ROM id, e.g. `breakout` or `space_invaders`. */
  game: string
  seed?: number
  /** Emulator frames advanced per Playproof input. */
  frameSkip?: number
  /** Sticky-action probability. 0 (the default) makes the run deterministic. */
  repeatActionProbability?: number
  mode?: number
  difficulty?: number
  /** RAM bytes to publish as evidence. Everything else stays unpublished. */
  channels?: AleRamChannel[]
  /** Publish the rendered screen as a PNG for the agent. Off by default. */
  screenImage?: boolean
  /** Whole-pixel upscale of that PNG, 1..8. An Atari frame is 160x210. */
  screenScale?: number
}

export interface AleIdentity {
  gen: number
  frame: number
  game: string
  /** The game's minimal action set, as `Action` enum names. */
  inputs: string[]
  /** Evidence keys of the RAM channels this boot publishes. */
  channels: string[]
  /** SHA-256 of the ROM ale-py loaded. */
  romSha: string
  frameSkip: number
  seed: number
  repeatActionProbability: number
  mode: number
  difficulty: number
  modes: number[]
  difficulties: number[]
  /** Screen height and width in pixels. */
  screen: [number, number]
  /** Whether this boot publishes the rendered screen for the agent. */
  screenImage: boolean
  screenScale: number
  frameText: string
  /** The boot screen, present only when `screenImage` is on. */
  frameImage?: ObservationImage
}

export class AleRpc extends WorkerRpc {
  constructor(python = process.env.PLAYPROOF_PYTHON ?? 'python3') {
    super({ name: 'ale', command: python, args: [WORKER_PATH], maxResponseBytes: MAX_RESPONSE_BYTES })
  }

  boot(options: AleBootOptions): AleIdentity {
    return this.call('boot', { ...options })
  }

  reset(seed?: number): { gen: number; frame: number } {
    return this.call('reset', seed === undefined ? {} : { seed })
  }

  /** `frames` overrides the boot-time frame repeat for this input only. */
  step(input: string, frames?: number): StepResult {
    return this.call('step', frames === undefined ? { input } : { input, frames })
  }

  /** Opaque Playproof checkpoint: deflated ALE state plus the cumulative score. */
  snapshot(): Buffer {
    const result = this.call<{ bytes: string }>('snapshot')
    return Buffer.from(result.bytes, 'base64')
  }

  restore(state: Buffer): { gen: number; frame: number } {
    return this.call('restore', { state: state.toString('base64') })
  }

  inputs(): string[] {
    return this.call<{ inputs: string[] }>('inputs').inputs
  }
}
