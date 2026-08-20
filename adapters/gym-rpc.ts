/** Thin Gymnasium specialization of the shared out-of-process WorkerRpc protocol. */
import { fileURLToPath } from 'node:url'
import { WorkerRpc, type WorkerEvidence, type WorkerStepResult } from './worker-rpc'

const WORKER_PATH = fileURLToPath(new URL('../gym/worker.py', import.meta.url))

/**
 * A generic checkpoint carries every input played so far, because Gymnasium
 * has no state API and the general restore is "reset to the seed and replay".
 * The cap keeps a long run on one protocol line.
 */
const MAX_RESPONSE_BYTES = 4 << 20

export type { WorkerEvidence }
export type StepResult = WorkerStepResult

export interface GymBootOptions {
  /** Registered environment id, such as `CartPole-v1`. */
  envId: string
  seed?: number
  /** Extra arguments for `gymnasium.make`, such as `{ is_slippery: false }`. */
  kwargs?: Record<string, unknown>
  /** Overrides the environment's own `TimeLimit`. */
  maxEpisodeSteps?: number
}

export interface GymIdentity {
  gen: number
  frame: number
  envId: string
  seed: number
  kwargs: Record<string, unknown>
  /** One name per discrete action, in action-index order. */
  actions: string[]
  /** Advertised input vocabulary: the action names plus `NOOP`. */
  inputs: string[]
  actionSpace: string
  observationSpace: string
  maxEpisodeSteps: number | null
  /** `ansi` when the environment renders text, otherwise null. */
  renderMode: string | null
  /** Reward and numeric `info` entries are multiplied by this and rounded. */
  rewardScale: number
  /** Published observation components are multiplied by this and rounded. */
  obsScale: number
  frameText: string
}

/**
 * Playproof checkpoint for a Gymnasium environment. `engine` holds a JSON copy
 * of the environment's own position when it lives in one readable attribute;
 * otherwise the payload restores by replaying `inputs` from `seed`.
 */
export interface GymCheckpoint {
  playproof: 'playproof-gym-checkpoint'
  version: 1
  kind: 'engine' | 'replay'
  envId: string
  gen: number
  frame: number
  steps: number
  reward: number
  terminated: boolean
  truncated: boolean
  inputs: string[]
  engine: Record<string, unknown> | null
}

export class GymRpc extends WorkerRpc {
  constructor(python = process.env.PLAYPROOF_PYTHON ?? 'python3') {
    super({ name: 'gym', command: python, args: [WORKER_PATH], maxResponseBytes: MAX_RESPONSE_BYTES })
  }

  boot(options: GymBootOptions): GymIdentity {
    return this.call('boot', { ...options })
  }

  reset(seed?: number): { gen: number; frame: number } {
    return this.call('reset', seed === undefined ? {} : { seed })
  }

  /** `replay` forces the general path even where a state attribute exists. */
  snapshot(mode?: 'engine' | 'replay'): GymCheckpoint {
    return this.call('snapshot', mode === undefined ? {} : { mode })
  }

  restore(state: GymCheckpoint): { gen: number; frame: number } {
    return this.call('restore', { state })
  }

  inputs(): string[] {
    return this.call<{ inputs: string[] }>('inputs').inputs
  }
}
