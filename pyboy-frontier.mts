/**
 * Deterministic frontier exploration for any PyBoy ROM.
 *
 * Output is a plain reference script consumable by:
 *   discover.py ROM channels.json --mode script --script frontier.json
 *
 * Env knobs:
 *   PLAYPROOF_ROM          legally obtained ROM path (required, never committed)
 *   PLAYPROOF_OUT          output JSON (required; must not exist)
 *   PLAYPROOF_STEPS        frontier rounds (default 40)
 *   PLAYPROOF_BEAM         retained branches (default 8)
 *   PLAYPROOF_PREAMBLE     generic (default) | tetris-hand
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { frontierExplore, type ActionMacro, type CheckpointEnvironment } from './exploration/frontier'
import { PyBoyRpc, type StepResult, type WorkerEvidence } from './adapters/pyboy-rpc'

interface Observation {
  snapshot: Buffer
  evidence: WorkerEvidence
  frameText: string
}

const actions: ActionMacro[] = [
  { id: 'a', inputs: ['a'] },
  { id: 'b', inputs: ['b'] },
  { id: 'down', inputs: ['down'] },
  { id: 'left', inputs: ['left'] },
  { id: 'right', inputs: ['right'] },
  { id: 'select', inputs: ['select'] },
  { id: 'start', inputs: ['start'] },
  { id: 'up', inputs: ['up'] },
  { id: 'a-a', inputs: ['a', 'a'] },
  { id: 'down-a', inputs: ['down', 'a'] },
  { id: 'left-a', inputs: ['left', 'a'] },
  { id: 'right-a', inputs: ['right', 'a'] },
  { id: 'start-a', inputs: ['start', 'a'] },
  { id: 'up-a', inputs: ['up', 'a'] },
  { id: 'down-hold', inputs: ['down', 'down', 'down', 'down'] },
]

const rom = process.env.PLAYPROOF_ROM
const out = process.env.PLAYPROOF_OUT
if (!rom) throw new Error('PLAYPROOF_ROM is required')
if (!out) throw new Error('PLAYPROOF_OUT is required')
if (existsSync(out)) throw new Error(`PLAYPROOF_OUT ${out} already exists`)

const rpc = new PyBoyRpc()
try {
  const boot = (): void => {
    const preamble = process.env.PLAYPROOF_PREAMBLE === 'tetris-hand' ? 'tetris-hand' : undefined
    rpc.boot(rom, 'generic', preamble ? { preamble } : {})
  }
  const capture = (step?: StepResult): Observation => ({
    snapshot: rpc.snapshot(),
    evidence: step?.evidence ?? rpc.evidence(),
    frameText: step?.frameText ?? rpc.frameText(),
  })
  const environment: CheckpointEnvironment<unknown, Observation> = {
    reset: () => { boot() },
    checkpoint: () => rpc.checkpoint(),
    restore: (checkpoint) => { rpc.restore(checkpoint) },
    step: (input) => capture(rpc.step(input)),
    observe: () => capture(),
    fingerprint: (observation) => createHash('sha256')
      .update(observation.snapshot)
      .update(observation.evidence.frameHash ?? '')
      .digest('hex'),
    features: (observation) => {
      const features: string[] = []
      for (let i = 0; i < observation.snapshot.length; i += 16) {
        features.push(`ram:${i}:${observation.snapshot[i]}`)
      }
      for (let i = 0; i < observation.frameText.length; i += 16) {
        features.push(`frame:${i}:${observation.frameText[i]}`)
      }
      return features
    },
  }
  const result = frontierExplore(environment, {
    seed: 0,
    rounds: Number(process.env.PLAYPROOF_STEPS ?? 40),
    beamWidth: Number(process.env.PLAYPROOF_BEAM ?? 8),
    actions,
  })
  writeFileSync(out, JSON.stringify({
    schemaVersion: 1,
    source: 'playproof-pyboy-frontier',
    romMd5: createHash('md5').update(readFileSync(rom)).digest('hex'),
    inputs: result.inputs,
    exploration: result,
  }, null, 2))
  console.log(`frontier: ${result.inputs.length} inputs, ${result.coverage} features, ${result.statesExamined} states -> ${out}`)
} finally {
  rpc.shutdown()
}
