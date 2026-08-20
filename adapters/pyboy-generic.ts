/**
 * GENERIC PyBoy adapter: any Game Boy game, no per-game code (EXP-040, G5).
 *
 * Everything game-specific comes from a discovery artifact
 * (pyboy/discover.py output JSON): evidence channels (addresses + decode),
 * the reference input sequence, and the preamble mode. The contract is
 * derived by the authoring layer from that data alone — marks are
 * event-anchored (`when`) on discovered channel values, hashes sampled from
 * the replay. This file contains no addresses, no thresholds, no hashes.
 *
 * The discovery doc's `preamble` field selects the worker boot mode:
 * 'tetris-hand' replays Phase A's hand preamble (so discovery and attestation
 * share a boot path); 'generic-search' is the full-blind path for unseen
 * games.
 *
 * Env knobs:
 *   PLAYPROOF_ROM        path to the .gb ROM (required; never committed)
 *   PLAYPROOF_CHANNELS   path to the discovery JSON (required)
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { deriveContract, type MarkPoint } from '../authoring'
import type { Evidence, Game } from '../runtime'
import type { MilestoneContract } from '../schema'
import { PyBoyRpc, type WorkerEvidence } from './pyboy-rpc'

export interface DiscoveredChannel {
  id: string
  addresses: number[]
  decode: 'bcd' | 'bin'
  rank: number
  valueStart: number
  valueEnd: number
  changes: number
  /** Snapshot index (1-based input count) where the decoded value first changed. */
  firstChangeStep: number
}

export interface DiscoveryDoc {
  schemaVersion: 1
  romMd5: string
  exploration: {
    mode: string
    preamble: string
    gameplayDetected: boolean
    seed: number
    inputs: string[]
    snapshots: number
  }
  channels: DiscoveredChannel[]
}

/** Milestones auto-generated per discovered channel (cap). */
export const AUTO_MARK_CHANNEL_CAP = 4

export interface PyBoyGeneric {
  game: Game<PyBoyGenericState>
  contract: MilestoneContract
  reference: string[]
  discovery: DiscoveryDoc
  seed: number
  dispose(): void
}

export interface PyBoyGenericState {
  gen: number
  frame: number
  evidence: Evidence
  frameText: string
}

function toEvidence(w: WorkerEvidence): Evidence {
  return {
    engineState: w.engineState,
    ...(w.saveBlobHash !== undefined ? { saveBlobHash: w.saveBlobHash } : {}),
    ...(w.frameHash !== undefined ? { frameHash: w.frameHash } : {}),
  }
}

export function loadDiscovery(path: string): DiscoveryDoc {
  const doc = JSON.parse(readFileSync(path, 'utf8')) as DiscoveryDoc
  if (!doc.exploration.gameplayDetected) {
    throw new Error('discovery doc says gameplay was never detected — refusing to build a benchmark from a menu')
  }
  return doc
}

/**
 * Auto-marks from discovered channels: one engine-state milestone per channel
 * (top-AUTO_MARK_CHANNEL_CAP by rank, UNION the researcher-confirmed channel
 * if given), plus save-file and screen-frame milestones anchored at the
 * CONFIRMED channel's first progression (tier C+D coverage on any game).
 *
 * The confirmed-channel union is load-bearing (caught by calibration): a
 * claimed milestone missing from the contract dies as claimed-UNKNOWN instead
 * of claimed-NOT-REPRODUCED, and tier-C/D marks anchored at a junk rank-0
 * channel verify "early" on partial replays — both red gates in EXP-040's
 * first run. The confirmation pick anchors everything semantic.
 */
export function autoMarks(doc: DiscoveryDoc, confirmedChannelId?: string): MarkPoint[] {
  const byRank = [...doc.channels].sort((a, b) => a.rank - b.rank)
  const confirmed = confirmedChannelId ? byRank.find((c) => c.id === confirmedChannelId) : undefined
  if (confirmedChannelId && !confirmed) throw new Error(`confirmed channel ${confirmedChannelId} not in discovery output`)
  const channels = [...byRank.slice(0, AUTO_MARK_CHANNEL_CAP)]
  if (confirmed && !channels.some((c) => c.id === confirmed.id)) channels.push(confirmed)
  if (channels.length === 0) throw new Error('discovery produced no channels — nothing to build a contract from')
  const anchor = confirmed ?? channels[0]!
  const progressed = (c: DiscoveredChannel) => (e: Evidence): boolean => (e.engineState?.[c.id] ?? 0) > c.valueStart
  const marks: MarkPoint[] = channels.map((c) => ({
    when: progressed(c),
    id: `${c.id}-progressed`,
    tier: 'engine-state' as const,
    glitchClass: 'legal' as const,
    sample: (e: Evidence) => ({ kind: 'state-path' as const, path: c.id, op: '>=' as const, value: e.engineState?.[c.id] ?? c.valueEnd }),
  }))
  marks.push(
    {
      when: progressed(anchor),
      id: 'state-at-first-progression',
      tier: 'save-file' as const,
      glitchClass: 'legal' as const,
      requires: [`${anchor.id}-progressed`],
      sample: (e: Evidence) => ({ kind: 'save-hash' as const, hash: e.saveBlobHash! }),
    },
    {
      when: progressed(anchor),
      id: 'frame-at-first-progression',
      tier: 'screen-frame' as const,
      glitchClass: 'legal' as const,
      requires: [`${anchor.id}-progressed`],
      sample: (e: Evidence) => ({ kind: 'frame-hash' as const, hash: e.frameHash! }),
    },
  )
  return marks
}

export function makePyBoyGeneric(rom: string, doc: DiscoveryDoc, opts: { confirmedChannelId?: string } = {}): PyBoyGeneric {
  const rpc = new PyBoyRpc()
  const bootOpts = doc.exploration.preamble === 'tetris-hand' ? { preamble: 'tetris-hand' } : {}
  const booted = rpc.boot(rom, 'generic', { channels: doc.channels, ...bootOpts })
  const gen0 = booted.gen
  const bootEv = rpc.evidence()
  const bootText = rpc.frameText()
  let current: PyBoyGenericState = {
    gen: gen0,
    frame: booted.frame,
    evidence: toEvidence(bootEv),
    frameText: bootText,
  }
  const game: Game<PyBoyGenericState> = {
    id: `pyboy-generic-${doc.romMd5.slice(0, 8)}`,
    init: () => {
      const r = rpc.reset()
      const ev = rpc.evidence()
      current = { gen: r.gen, frame: r.frame, evidence: toEvidence(ev), frameText: rpc.frameText() }
      return current
    },
    step: (s, input) => {
      if (s.gen !== current.gen) {
        throw new Error(`stale state: gen ${s.gen} but worker is at gen ${current.gen}`)
      }
      const r = rpc.step(input)
      current = { gen: current.gen, frame: r.frame, evidence: toEvidence(r.evidence), frameText: r.frameText }
      return current
    },
    frame: (s) => s.frameText,
    evidence: (s) => s.evidence,
  }
  const seed = 0
  const contract = deriveContract(game, seed, doc.exploration.inputs, autoMarks(doc, opts.confirmedChannelId))
  return {
    game,
    contract,
    reference: doc.exploration.inputs,
    discovery: doc,
    seed,
    dispose: () => rpc.shutdown(),
  }
}
