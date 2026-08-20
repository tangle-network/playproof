/**
 * Tier-C adapter: save-file game ("save-levels").
 *
 * Progression lands in a persisted save blob the game writes; the milestone
 * binds the blob's hash at the progression moment. The cheat shape this tier
 * invites is a direct save edit — the attestation plane defeats it because the
 * save hash is RECOMPUTED from replay, so a doctored blob never matches.
 */
import type { Evidence, Game } from '../runtime'
import { hashString } from '../runtime'
import type { MilestoneContract } from '../schema'
import { deriveContract } from '../authoring'

export interface SaveLevelsState {
  level: number
  stars: number
}

export const SAVE_LEVELS_REFERENCE = ['clear', 'grind', 'clear'] as const

const saveBlob = (s: SaveLevelsState): string => `save-v1|level=${s.level}|stars=${s.stars}`

export const saveLevels: Game<SaveLevelsState> = {
  id: 'save-levels',
  init: () => ({ level: 0, stars: 0 }),
  step: (s, input) => {
    if (input === 'clear') return { ...s, level: s.level + 1 }
    if (input === 'grind') return { ...s, stars: s.stars + 1 }
    return s
  },
  frame: (s) => `LEVEL ${s.level} · ★${s.stars}${s.level >= 2 ? ' · SAVE WRITTEN' : ''}`,
  evidence: (s): Evidence => ({
    engineState: { level: s.level, stars: s.stars },
    saveBlobHash: hashString(saveBlob(s)),
    logEvents: s.level >= 2 ? ['reached-level-2'] : [],
  }),
}

export const saveLevelsContract = (): MilestoneContract =>
  deriveContract(saveLevels, 0, [...SAVE_LEVELS_REFERENCE], [
    {
      // after clear,grind,clear the save blob holds level=2 stars=1
      afterInputs: 3,
      id: 'level-2-saved',
      tier: 'save-file',
      glitchClass: 'legal',
      sample: (e) => ({ kind: 'save-hash', hash: e.saveBlobHash ?? '' }),
    },
    {
      // tier-B coverage: the game emits a progression event to its log channel.
      afterInputs: 3,
      id: 'level-2-logged',
      tier: 'log-event',
      glitchClass: 'legal',
      requires: ['level-2-saved'],
      sample: (e) => ({ kind: 'log-contains', event: e.logEvents?.[0] ?? '' }),
    },
  ])
