/** Thin PyBoy specialization of the shared out-of-process WorkerRpc protocol. */
import { fileURLToPath } from 'node:url'
import { WorkerRpc, type WorkerEvidence, type WorkerStepResult } from './worker-rpc'

const WORKER_PATH = fileURLToPath(new URL('../pyboy/worker.py', import.meta.url))

export type { WorkerEvidence }
export type StepResult = WorkerStepResult

export class PyBoyRpc extends WorkerRpc {
  constructor(python = process.env.PLAYPROOF_PYTHON ?? 'python3') {
    super({ name: 'pyboy', command: python, args: [WORKER_PATH] })
  }

  boot(rom: string, game: string, opts: { channels?: unknown[]; preamble?: string } = {}): { gen: number; frame: number } {
    return this.call('boot', { rom, game, ...opts })
  }

  snapshot(): Buffer {
    const result = this.call<{ bytes: string }>('snapshot')
    return Buffer.from(result.bytes, 'base64')
  }
}
