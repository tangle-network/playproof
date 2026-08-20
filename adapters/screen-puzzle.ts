/**
 * Tier-D adapter: screen-checkpoint game ("screen-puzzle").
 *
 * Progression is visible ONLY on the rendered frame — the weakest evidence
 * tier, the one screen-only commercial games force on you. The milestone binds
 * a frame hash captured from the reference playthrough (the VideoGameBench
 * walkthrough-checkpoint pattern). Frame forgery dies on replay: the verifier
 * re-renders every frame from the input log and compares hashes.
 */
import type { Evidence, Game } from '../runtime'
import { hashString } from '../runtime'
import type { MilestoneContract } from '../schema'
import { deriveContract } from '../authoring'

export interface PuzzleState {
  x: number
}

export const SCREEN_PUZZLE_REFERENCE = ['r', 'r', 'r', 'r', 'r', 'r', 'r', 'r'] as const
export const PUZZLE_WIDTH = 9

const render = (s: PuzzleState): string => `${'.'.repeat(s.x)}P${'.'.repeat(PUZZLE_WIDTH - 1 - s.x)}`

export const screenPuzzle: Game<PuzzleState> = {
  id: 'screen-puzzle',
  init: () => ({ x: 0 }),
  step: (s, input) => {
    if (input === 'r') return { x: Math.min(s.x + 1, PUZZLE_WIDTH - 1) }
    if (input === 'l') return { x: Math.max(s.x - 1, 0) }
    return s
  },
  frame: (s) => `${render(s)}\nmove with l/r · reach the far gate »`,
  evidence: (s): Evidence => ({
    engineState: { x: s.x },
    frameHash: hashString(render(s)),
  }),
}

export const screenPuzzleContract = (): MilestoneContract =>
  deriveContract(screenPuzzle, 0, [...SCREEN_PUZZLE_REFERENCE], [
    {
      afterInputs: 4,
      id: 'midway-frame',
      tier: 'screen-frame',
      glitchClass: 'legal',
      sample: (e) => ({ kind: 'frame-hash', hash: e.frameHash ?? '' }),
    },
    {
      afterInputs: 8,
      id: 'east-gate-frame',
      tier: 'screen-frame',
      glitchClass: 'legal',
      requires: ['midway-frame'],
      sample: (e) => ({ kind: 'frame-hash', hash: e.frameHash ?? '' }),
    },
  ])
