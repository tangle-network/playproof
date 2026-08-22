/** Thin PyBoy specialization of the shared out-of-process WorkerRpc protocol. */
import { fileURLToPath } from 'node:url'
import { WorkerRpc, type WorkerEvidence, type WorkerStepResult } from './worker-rpc'

const WORKER_PATH = fileURLToPath(new URL('../pyboy/worker.py', import.meta.url))

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

export class PyBoyRpc extends WorkerRpc {
  constructor(python = process.env.PLAYPROOF_PYTHON ?? 'python3') {
    super({ name: 'pyboy', command: python, args: [WORKER_PATH], maxResponseBytes: MAX_RESPONSE_BYTES })
  }

  /**
   * `screenImage` publishes the rendered screen as a PNG for the agent.
   * `screenScale` repeats whole pixels, 1..8; a Game Boy frame is 160x144.
   */
  boot(
    rom: string,
    game: string,
    opts: { channels?: unknown[]; preamble?: string; screenImage?: boolean; screenScale?: number } = {},
  ): { gen: number; frame: number } {
    return this.call('boot', { rom, game, ...opts })
  }

  snapshot(): Buffer {
    const result = this.call<{ bytes: string }>('snapshot')
    return Buffer.from(result.bytes, 'base64')
  }
}
