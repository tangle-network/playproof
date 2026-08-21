/** Thin RetroArch specialization of the shared out-of-process WorkerRpc protocol. */
import { fileURLToPath } from 'node:url'
import type { ObservationImage } from '../runtime'
import { WorkerRpc, type WorkerEvidence, type WorkerStepResult } from './worker-rpc'

const WORKER_PATH = fileURLToPath(new URL('../retroarch/worker.py', import.meta.url))

/**
 * A RetroArch save state is large before compression (a Nintendo 64 core emits
 * several megabytes). The worker deflates every checkpoint, but the cap is
 * raised so a poorly compressible core state still fits one protocol line.
 */
const MAX_RESPONSE_BYTES = 16 << 20

export type { WorkerEvidence }
export type StepResult = WorkerStepResult

/** How the bytes at `address` become one number. */
export type ChannelDecode = 'bin' | 'bcd'

export interface RetroArchChannel {
  id: string
  /** Core memory-map address. Game Boy work RAM starts at 0xC000. */
  address: number
  /** Contiguous bytes, most significant first. Defaults to 1. */
  size?: number
  /** Defaults to `bin`. `bcd` reads two decimal digits per byte. */
  decode?: ChannelDecode
  /** Value this channel holds before the run makes progress, when known. */
  baseline?: number
}

export interface RetroArchBootOptions {
  /** RetroArch executable. */
  binary: string
  /** libretro core shared library. */
  core: string
  /** ROM, disc image, or other content the core accepts. */
  content: string
  channels?: RetroArchChannel[]
  /** Button vocabulary for this core, e.g. gambatte's Game Boy face buttons. */
  inputs?: string[]
  /** Emulator frames advanced per Playproof input. */
  frames?: number
  /** Frames the buttons stay held inside that window. */
  pressFrames?: number
  /** Frames advanced after the core reset that pins the boot state. */
  bootFrames?: number
  /** Regions zeroed before the core reset, as `[address, size]` pairs. */
  clearRegions?: [number, number][]
  /** BIOS directory for cores that need one. */
  systemDir?: string
  /** RetroArch video driver. `null` is headless and still serves SCREENSHOT. */
  videoDriver?: string
  /**
   * Republish the SCREENSHOT PNG to the agent. Off by default.
   *
   * There is no upscale knob here: the worker has no array library, and the
   * bytes are RetroArch's own file rather than a re-encode.
   */
  screenImage?: boolean
  seed?: number
}

export interface RetroArchIdentity {
  gen: number
  frame: number
  core: string
  content: string
  /** SHA-256 of the content file, so a reference can pin what it was authored on. */
  contentSha: string
  /** RetroArch's own GET_STATUS line, e.g. `GET_STATUS PAUSED game_boy,libbet,crc32=…`. */
  status: string
  /** Libretro button names this core is driven with. */
  buttons: string[]
  /** Advertised input vocabulary. */
  inputs: string[]
  /** Declared evidence channel ids. */
  channels: string[]
  frames: number
  pressFrames: number
  bootFrames: number
  clearRegions: [number, number][]
  seed: number
  /** RetroArch's process id, so a caller can prove teardown killed it. */
  pid: number | null
  /** Whether this boot republishes the screenshot for the agent. */
  screenImage: boolean
  frameText: string
  /** The boot screen, present only when `screenImage` is on. */
  frameImage?: ObservationImage
}

export class RetroArchRpc extends WorkerRpc {
  constructor(python = process.env.PLAYPROOF_PYTHON ?? 'python3') {
    super({ name: 'retroarch', command: python, args: [WORKER_PATH], maxResponseBytes: MAX_RESPONSE_BYTES })
  }

  /** Launch RetroArch, pause it, and pin the boot state every reset returns to. */
  boot(options: RetroArchBootOptions): RetroArchIdentity {
    return this.call('boot', { ...options })
  }

  reset(seed?: number): { gen: number; frame: number } {
    return this.call('reset', seed === undefined ? {} : { seed })
  }

  /** Opaque Playproof checkpoint: deflated RetroArch save state plus the frame counter. */
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
