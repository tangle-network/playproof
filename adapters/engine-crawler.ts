/**
 * Tier-A adapter: engine-state game ("engine-crawler").
 *
 * Progression lives in privileged engine state the agent cannot legitimately
 * write; the frame is only a status line. This is the ALE/NLE evidence class:
 * the strongest channel, and the least general — one engine, one wiring.
 * Here it is a tiny pure state machine so the contract semantics are testable
 * without an emulator.
 */
import type { Evidence, Game } from '../runtime'
import { hashString } from '../runtime'
import type { MilestoneContract } from '../schema'
import { deriveContract } from '../authoring'

export interface CrawlerState {
  room: number
  hp: number
  /** Full-hp flag exercised by the '==' op milestone below. */
  hpExact: boolean
}

export const ENGINE_CRAWLER_REFERENCE = ['right', 'right', 'right'] as const

export const engineCrawler: Game<CrawlerState> = {
  id: 'engine-crawler',
  init: () => ({ room: 0, hp: 3, hpExact: true }),
  step: (s, input) => {
    if (input === 'right') return { ...s, room: s.room + 1 }
    if (input === 'rest') return { ...s, hp: Math.min(s.hp + 1, 9), hpExact: false }
    return s
  },
  frame: (s) => `you are in room ${s.room} · hp ${s.hp} · exits: east`,
  evidence: (s): Evidence => ({
    engineState: { room: s.room, hp: s.hp, hpExact: s.hpExact ? 1 : 0 },
    frameHash: hashString(`crawler:${s.room}:${s.hp}`),
  }),
}

export const engineCrawlerContract = (): MilestoneContract =>
  deriveContract(engineCrawler, 0, [...ENGINE_CRAWLER_REFERENCE], [
    {
      afterInputs: 1,
      id: 'room-1',
      tier: 'engine-state',
      glitchClass: 'legal',
      sample: (e) => ({ kind: 'state-path', path: 'room', op: '>=', value: (e.engineState?.room ?? 0) }),
    },
    {
      // '==' op coverage: hp untouched (rest breaks hpExact).
      afterInputs: 1,
      id: 'hp-untouched',
      tier: 'engine-state',
      glitchClass: 'legal',
      sample: (e) => ({ kind: 'state-path', path: 'hpExact', op: '==', value: 1 }),
    },
    {
      // '>' op coverage: strictly beyond room 2 (holds at room 3).
      afterInputs: 3,
      id: 'room-2-plus',
      tier: 'engine-state',
      glitchClass: 'legal',
      requires: ['room-1'],
      sample: (e) => ({ kind: 'state-path', path: 'room', op: '>', value: 2 }),
    },
    {
      afterInputs: 3,
      id: 'room-3',
      tier: 'engine-state',
      glitchClass: 'legal',
      requires: ['room-1'],
      sample: (e) => ({ kind: 'state-path', path: 'room', op: '>=', value: (e.engineState?.room ?? 0) }),
    },
  ])
