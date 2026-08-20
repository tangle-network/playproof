/** Thin stable-retro specialization of the shared out-of-process WorkerRpc protocol. */
import { fileURLToPath } from 'node:url'
import { WorkerRpc, type WorkerEvidence, type WorkerStepResult } from './worker-rpc'

const WORKER_PATH = fileURLToPath(new URL('../retro/worker.py', import.meta.url))

/**
 * Libretro save states are large before compression (a Genesis core emits
 * ~1 MB). The worker deflates every checkpoint, but the cap is raised so a
 * poorly compressible core state still fits one protocol line.
 */
const MAX_RESPONSE_BYTES = 8 << 20

export type { WorkerEvidence }
export type StepResult = WorkerStepResult

export interface RetroBootOptions {
  /** Integration name, with or without the `-v0` suffix (`Airstriker-Genesis`). */
  game: string
  /** Named save state to start from. Omitted means the integration default. */
  state?: string
  /** Named scenario file. Omitted means the integration default. */
  scenario?: string
  players?: number
  /** Emulator frames advanced per Playproof input. */
  frameskip?: number
  seed?: number
}

export interface RetroIdentity {
  gen: number
  frame: number
  game: string
  state: string | null
  /** Console button names in core order, e.g. Genesis `B A MODE START UP …`. */
  buttons: string[]
  /** Advertised input vocabulary. */
  inputs: string[]
  /** Integration variable names readable from RAM. */
  variables: string[]
  /** SHA-1 of the ROM the core loaded, or null when the path is unavailable. */
  romSha: string | null
  frameskip: number
  frameText: string
}

export class RetroRpc extends WorkerRpc {
  constructor(python = process.env.PLAYPROOF_PYTHON ?? 'python3') {
    super({ name: 'retro', command: python, args: [WORKER_PATH], maxResponseBytes: MAX_RESPONSE_BYTES })
  }

  boot(options: RetroBootOptions): RetroIdentity {
    return this.call('boot', { ...options })
  }

  reset(seed?: number): { gen: number; frame: number } {
    return this.call('reset', seed === undefined ? {} : { seed })
  }

  /** Opaque Playproof checkpoint: deflated core state plus the frame counter. */
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
