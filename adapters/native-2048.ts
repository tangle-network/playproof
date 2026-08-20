/**
 * Native-process 2048 adapter: the second real Playproof execution model.
 *
 * The game runs in a separate Python process through the same WorkerRpc
 * protocol used by PyBoy. It is a full seeded 4x4 2048 implementation and
 * exposes all four evidence tiers. No emulator or third-party package is
 * involved, so this is a direct test that the contract/attestation core is not
 * Game-Boy-specific.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { deriveContract, type MarkPoint } from '../authoring'
import type { Evidence, Game } from '../runtime'
import type { MilestoneContract } from '../schema'
import type { PlatformDescriptor } from '../platform'
import type { CheckpointEnvironment } from '../exploration/frontier'
import { WorkerRpc, type WorkerEvidence } from './worker-rpc'

const WORKER_PATH = fileURLToPath(new URL('../native/worker.py', import.meta.url))
export const NATIVE_2048_BUILD = {
  id: 'playproof-native-2048-worker',
  digest: createHash('sha256').update(readFileSync(WORKER_PATH)).digest('hex'),
}

export const NATIVE_2048_INPUTS = ['up', 'down', 'left', 'right'] as const
export const NATIVE_2048_REFERENCE = [
  'left', 'down', 'right', 'down', 'left', 'up', 'right', 'up',
  'left', 'down', 'right', 'down', 'left', 'up', 'right', 'up',
  'left', 'down', 'right', 'down', 'left', 'up', 'right', 'up',
  'left', 'down',
] as const

export const NATIVE_2048_PLATFORM: PlatformDescriptor = {
  id: 'native-process-2048',
  family: 'native-process',
  verificationMode: 'replay',
  capabilities: {
    deterministicReplay: true,
    checkpoints: true,
    rawState: true,
    persistedState: true,
    eventStream: true,
    frameCapture: true,
    signedRecorder: false,
    platformReceipts: false,
  },
}

export interface Native2048State {
  gen: number
  frame: number
  evidence: Evidence
  frameText: string
}

export interface Native2048Adapter {
  game: Game<Native2048State>
  contract: MilestoneContract
  reference: string[]
  seed: number
  platform: PlatformDescriptor
  build: { id: string; digest: string }
  dispose(): void
}

interface NativeCheckpoint {
  seed: number
  board: number[][]
  score: number
  moves: number
  events: string[]
  rng: unknown
}

class Native2048Rpc extends WorkerRpc {
  constructor(python = process.env.PLAYPROOF_PYTHON ?? 'python3') {
    super({ name: 'native-2048', command: python, args: [WORKER_PATH] })
  }

  boot(seed: number): { gen: number; frame: number } {
    return this.call('boot', { seed })
  }
}

function toEvidence(evidence: WorkerEvidence): Evidence {
  return {
    engineState: evidence.engineState,
    ...(evidence.saveBlobHash !== undefined ? { saveBlobHash: evidence.saveBlobHash } : {}),
    ...(evidence.saveState !== undefined ? { saveState: evidence.saveState } : {}),
    ...(evidence.logEvents !== undefined ? { logEvents: evidence.logEvents } : {}),
    ...(evidence.frameHash !== undefined ? { frameHash: evidence.frameHash } : {}),
    ...(evidence.frameState !== undefined ? { frameState: evidence.frameState } : {}),
  }
}

function marks(): MarkPoint[] {
  return [
    {
      id: 'first-legal-move',
      tier: 'engine-state',
      glitchClass: 'legal',
      when: (e) => (e.engineState?.moves ?? 0) >= 1,
      sample: (e) => ({ kind: 'state-path', path: 'moves', op: '>=', value: e.engineState?.moves ?? 1 }),
    },
    {
      id: 'first-merge',
      tier: 'engine-state',
      glitchClass: 'legal',
      requires: ['first-legal-move'],
      when: (e) => (e.engineState?.score ?? 0) > 0,
      sample: (e) => ({ kind: 'state-path', path: 'score', op: '>=', value: e.engineState?.score ?? 1 }),
    },
    {
      id: 'tile-8-engine',
      tier: 'engine-state',
      glitchClass: 'legal',
      requires: ['first-merge'],
      when: (e) => (e.engineState?.maxTile ?? 0) >= 8,
      sample: (e) => ({ kind: 'state-path', path: 'maxTile', op: '>=', value: e.engineState?.maxTile ?? 8 }),
    },
    {
      id: 'tile-8-event',
      tier: 'log-event',
      glitchClass: 'legal',
      requires: ['tile-8-engine'],
      when: (e) => (e.logEvents ?? []).includes('tile-8'),
      sample: () => ({ kind: 'log-contains', event: 'tile-8' }),
    },
    {
      id: 'save-at-tile-16',
      tier: 'save-file',
      glitchClass: 'legal',
      requires: ['tile-8-event'],
      when: (e) => (e.engineState?.maxTile ?? 0) >= 16,
      sample: (e) => ({ kind: 'save-path', path: 'maxTile', op: '>=', value: e.saveState?.maxTile ?? 16 }),
    },
    {
      id: 'frame-at-tile-16',
      tier: 'screen-frame',
      glitchClass: 'legal',
      requires: ['save-at-tile-16'],
      when: (e) => (e.engineState?.maxTile ?? 0) >= 16,
      sample: (e) => ({ kind: 'frame-path', path: 'maxTile', op: '>=', value: e.frameState?.maxTile ?? 16 }),
    },
    {
      id: 'tile-32',
      tier: 'engine-state',
      glitchClass: 'legal',
      requires: ['frame-at-tile-16'],
      when: (e) => (e.engineState?.maxTile ?? 0) >= 32,
      sample: (e) => ({ kind: 'state-path', path: 'maxTile', op: '>=', value: e.engineState?.maxTile ?? 32 }),
    },
  ]
}

export function makeNative2048(seed = 0): Native2048Adapter {
  const rpc = new Native2048Rpc()
  let current: Native2048State | null = null
  const game: Game<Native2048State> = {
    id: 'native-2048',
    init: (requestedSeed) => {
      const booted = rpc.boot(requestedSeed)
      current = {
        gen: booted.gen,
        frame: booted.frame,
        evidence: toEvidence(rpc.evidence()),
        frameText: rpc.frameText(),
      }
      return current
    },
    step: (state, input) => {
      if (!current || state.gen !== current.gen) {
        throw new Error(`stale native-2048 state: ${state.gen} != ${current?.gen ?? 'uninitialized'}`)
      }
      const stepped = rpc.step(input)
      current = {
        gen: current.gen,
        frame: stepped.frame,
        evidence: toEvidence(stepped.evidence),
        frameText: stepped.frameText,
      }
      return current
    },
    frame: (state) => state.frameText,
    evidence: (state) => state.evidence,
  }
  const reference = [...NATIVE_2048_REFERENCE]
  const contract = deriveContract(game, seed, reference, marks())
  return {
    game,
    contract,
    reference,
    seed,
    platform: NATIVE_2048_PLATFORM,
    build: NATIVE_2048_BUILD,
    dispose: () => rpc.shutdown(),
  }
}

export interface Native2048Explorer {
  environment: CheckpointEnvironment<NativeCheckpoint, WorkerEvidence>
  evidence(): WorkerEvidence
  dispose(): void
}

export function makeNative2048Explorer(): Native2048Explorer {
  const rpc = new Native2048Rpc()
  const environment: CheckpointEnvironment<NativeCheckpoint, WorkerEvidence> = {
    reset: (seed) => { rpc.boot(seed) },
    checkpoint: () => rpc.checkpoint<NativeCheckpoint>(),
    restore: (checkpoint) => { rpc.restore(checkpoint) },
    step: (input) => rpc.step(input).evidence,
    observe: () => rpc.evidence(),
    fingerprint: (observation) => observation.saveBlobHash ?? JSON.stringify(observation.engineState),
    features: (observation) => {
      const features: string[] = []
      for (const [key, value] of Object.entries(observation.engineState)) {
        if (key.startsWith('cell') || key === 'maxTile' || key === 'emptyCells') features.push(`${key}:${value}`)
        if (key === 'score') features.push(`scoreBucket:${Math.floor(value / 16)}`)
      }
      for (const event of observation.logEvents ?? []) features.push(`event:${event}`)
      return features
    },
  }
  return {
    environment,
    evidence: () => rpc.evidence(),
    dispose: () => rpc.shutdown(),
  }
}
