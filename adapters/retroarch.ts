/**
 * RetroArch host adapter: Playproof drives the RetroArch binary as a black box.
 *
 * The other emulator adapters link a Python emulator into the worker. This one
 * links nothing. It launches whatever RetroArch the caller points at, with
 * whatever libretro core and content they own, and drives it over the two UDP
 * interfaces RetroArch already publishes: the text command interface for
 * frame advance, memory reads, screenshots and save states, and the binary
 * remote gamepad for button presses. Every core RetroArch can load therefore
 * becomes a Playproof `Game` with no Playproof code per console.
 *
 * Evidence tiers exercised:
 *   A engine-state — caller-declared memory channels read with
 *     READ_CORE_MEMORY, never from the agent
 *   D screen-frame — sha256 of the decoded screenshot, plus bounded numbers
 *     derived from it (`frameState`)
 *
 * Deliberately absent: `saveBlobHash`. RetroArch compresses save states, and a
 * compressed state is not a stable identity for a game position. Checkpoints
 * stay exact within one worker, which is all snapshot/restore needs, and
 * `retroarch.test.mts` proves that half.
 *
 * Determinism does not come from a seed. Libretro cores take none, so
 * `init(seed)` restores a boot save state that the worker pins with a core
 * reset plus a fixed number of frame advances, and every later transition is
 * an explicit, counted frame advance from that state. The seed is recorded
 * and reported so a run artifact stays shaped like every other adapter's, but
 * it is nominal: the input log plus the boot state is the complete
 * determinism key. `retroarch.test.mts` proves the boot state and the whole
 * evidence stream are identical in a second, separately launched emulator.
 *
 * Cores and content are never distributed by Playproof. The caller brings a
 * RetroArch binary, a core from the libretro buildbot, and legally obtained
 * content, and names them through the options below or the env knobs.
 *
 * Env knobs:
 *   PLAYPROOF_PYTHON  python interpreter that runs the worker (default python3)
 */
import { deriveContract, type MarkPoint } from '../authoring'
import type { Evidence, Game } from '../runtime'
import type { MilestoneContract } from '../schema'
import type { DiscoveryDoc } from './pyboy-generic'
import {
  RetroArchRpc,
  type RetroArchChannel,
  type RetroArchIdentity,
  type WorkerEvidence,
} from './retroarch-rpc'

export type { RetroArchChannel, RetroArchIdentity }

/** Engine-state milestones auto-generated from declared channels (cap). */
export const AUTO_MARK_CHANNEL_CAP = 4

export interface RetroArchState {
  gen: number
  frame: number
  evidence: Evidence
  frameText: string
}

export interface RetroArchOptions {
  /** RetroArch executable. Defaults to PLAYPROOF_RETROARCH. */
  binary?: string
  /** libretro core shared library. */
  core: string
  /** ROM, disc image, or other content the core accepts. */
  content: string
  /** Evidence channels, most significant first; `channelsFromDiscovery` builds these. */
  channels: RetroArchChannel[]
  /** Button vocabulary for this core, e.g. `['up','down','left','right','a','b','start','select']`. */
  inputs?: string[]
  /** Emulator frames per Playproof input. Defaults to 4. */
  frames?: number
  /** Frames the buttons stay held inside that window. Defaults to 2. */
  pressFrames?: number
  /** Frames advanced after the core reset that pins the boot state. Defaults to 60. */
  bootFrames?: number
  /**
   * Regions zeroed before the core reset, as `[address, size]` pairs. A core
   * reset does not clear the memory the console powered on with, so without
   * this the boot state inherits whatever the launch race left behind and two
   * processes can pin two different boot states. Name the console's volatile
   * regions here to make the boot state a function of the content alone.
   */
  clearRegions?: [number, number][]
  systemDir?: string
  videoDriver?: string
  seed?: number
  python?: string
  /** Reference input script the contract is derived from. */
  reference: string[]
  /** Channel whose first change anchors the screen-frame milestones. */
  anchorChannelId?: string
  /**
   * Pin screen-frame milestones as well as engine-state ones. Off by default:
   * a milestone is only honest when a verifier in a separate process
   * reproduces it, and screen evidence has to be measured per core and per
   * game before it can carry that weight. See the adapter docs for the
   * measurement on gambatte.
   */
  screenMilestones?: boolean
}

export interface RetroArch {
  game: Game<RetroArchState>
  contract: MilestoneContract
  /** The reference input script, as replayed. */
  reference: string[]
  /** Advertised input vocabulary for this core's button layout. */
  inputs: string[]
  identity: RetroArchIdentity
  /** Channel values at the pinned boot state, which the marks fire against. */
  baseline: Record<string, number>
  seed: number
  dispose(): void
}

/**
 * Turn a PyBoy discovery document into RetroArch channels.
 *
 * This is the join that makes the cross-emulator proof possible: the same
 * addresses `pyboy/discover.py` found by watching work RAM are read back
 * through RetroArch's core memory map, so one discovery document drives two
 * unrelated emulators and neither adapter carries a hand-copied address.
 * Discovery emits work-RAM addresses, which is exactly what a libretro core
 * exposes through SET_MEMORY_MAPS, so no translation is needed.
 */
export function channelsFromDiscovery(doc: DiscoveryDoc): RetroArchChannel[] {
  if (doc.channels.length === 0) throw new Error('discovery document declares no channels')
  return [...doc.channels]
    .sort((a, b) => a.rank - b.rank)
    .map((channel) => {
      const addresses = channel.addresses
      if (addresses.length === 0) throw new Error(`discovered channel ${channel.id} declares no addresses`)
      for (let i = 1; i < addresses.length; i++) {
        if (addresses[i] !== addresses[0]! + i) {
          throw new Error(
            `discovered channel ${channel.id} reads non-contiguous addresses ${addresses.join(',')}; RetroArch reads a block`,
          )
        }
      }
      return {
        id: channel.id,
        address: addresses[0]!,
        size: addresses.length,
        decode: channel.decode,
        baseline: channel.valueStart,
      }
    })
}

function toEvidence(w: WorkerEvidence): Evidence {
  return {
    engineState: w.engineState,
    ...(w.frameHash !== undefined ? { frameHash: w.frameHash } : {}),
    ...(w.frameState !== undefined ? { frameState: w.frameState } : {}),
  }
}

/**
 * Auto-marks from declared channels: one engine-state milestone per channel
 * (the first AUTO_MARK_CHANNEL_CAP, which callers order by importance), plus
 * screen-frame milestones anchored at the anchor channel's first change.
 *
 * A mark fixes only WHERE a milestone opens. `deriveContract` replays the
 * reference and reads WHAT held there, so this file carries no threshold and
 * no hash. The baseline each mark fires against is sampled from the pinned
 * boot state of this run, or taken from the channel when the caller declares
 * one, which keeps discovered constants in the discovery document.
 */
export function channelMarks(
  channels: RetroArchChannel[],
  baseline: Record<string, number>,
  anchorChannelId?: string,
  screenMilestones = false,
): MarkPoint[] {
  if (channels.length === 0) throw new Error('no evidence channels — nothing to build a contract from')
  const anchor = anchorChannelId ? channels.find((c) => c.id === anchorChannelId) : channels[0]
  if (!anchor) throw new Error(`anchor channel ${anchorChannelId} is not a declared channel`)
  const selected = channels.slice(0, AUTO_MARK_CHANNEL_CAP)
  if (!selected.some((c) => c.id === anchor.id)) selected.push(anchor)

  // The baseline is what THIS emulator reads at the pinned boot state, and a
  // declared one is only the fallback. A discovery document records the value
  // its own emulator powered on with, and uninitialised memory differs between
  // emulators — gambatte reads 0xFF where PyBoy reads 0 — so trusting the
  // declared value would open every milestone at the first snapshot and let
  // any script claim it.
  const changed = (channel: RetroArchChannel) => (e: Evidence): boolean => {
    const value = e.engineState?.[channel.id]
    if (value === undefined) return false
    return value !== (baseline[channel.id] ?? channel.baseline ?? 0)
  }

  const marks: MarkPoint[] = selected.map((channel) => ({
    when: changed(channel),
    id: `${channel.id}-progressed`,
    tier: 'engine-state' as const,
    glitchClass: 'legal' as const,
    sample: (e: Evidence) => ({
      kind: 'state-path' as const,
      path: channel.id,
      op: '>=' as const,
      value: e.engineState?.[channel.id] ?? 0,
    }),
  }))
  if (!screenMilestones) return marks
  marks.push(
    {
      when: changed(anchor),
      id: 'frame-at-first-progression',
      tier: 'screen-frame' as const,
      glitchClass: 'legal' as const,
      requires: [`${anchor.id}-progressed`],
      sample: (e: Evidence) => {
        if (e.frameHash === undefined) throw new Error('the worker reported no frame hash')
        return { kind: 'frame-hash' as const, hash: e.frameHash }
      },
    },
    {
      when: changed(anchor),
      id: 'screen-ink-at-first-progression',
      tier: 'screen-frame' as const,
      glitchClass: 'legal' as const,
      requires: [`${anchor.id}-progressed`],
      sample: (e: Evidence) => {
        const value = e.frameState?.inkCells
        if (value === undefined) throw new Error('the worker reported no frame state')
        return { kind: 'frame-path' as const, path: 'inkCells', op: '>=' as const, value }
      },
    },
  )
  return marks
}

/**
 * Boot a core through RetroArch and derive its contract from the reference.
 *
 * Replay soundness mirrors the other emulator adapters: `init(seed)` restores
 * the pinned boot state and every input is applied in order, so a verifier
 * reproduces the run from the boot state and the input log alone. Nothing is
 * carried over between passes.
 */
export function makeRetroArch(options: RetroArchOptions): RetroArch {
  const binary = options.binary ?? process.env.PLAYPROOF_RETROARCH
  if (!binary) {
    throw new Error('no RetroArch binary: pass options.binary or set PLAYPROOF_RETROARCH')
  }
  if (options.reference.length === 0) throw new Error('the reference input script is empty')
  if (options.channels.length === 0) throw new Error('declare at least one evidence channel')

  const seed = options.seed ?? 0
  const rpc = new RetroArchRpc(options.python)
  let identity: RetroArchIdentity
  try {
    identity = rpc.boot({
      binary,
      core: options.core,
      content: options.content,
      channels: options.channels,
      ...(options.inputs !== undefined ? { inputs: options.inputs } : {}),
      ...(options.frames !== undefined ? { frames: options.frames } : {}),
      ...(options.pressFrames !== undefined ? { pressFrames: options.pressFrames } : {}),
      ...(options.bootFrames !== undefined ? { bootFrames: options.bootFrames } : {}),
      ...(options.clearRegions !== undefined ? { clearRegions: options.clearRegions } : {}),
      ...(options.systemDir !== undefined ? { systemDir: options.systemDir } : {}),
      ...(options.videoDriver !== undefined ? { videoDriver: options.videoDriver } : {}),
      seed,
    })
  } catch (error) {
    rpc.shutdown()
    throw error
  }

  try {
    const bootEvidence = toEvidence(rpc.evidence())
    const baseline = { ...(bootEvidence.engineState ?? {}) }
    let current: RetroArchState = {
      gen: identity.gen,
      frame: identity.frame,
      evidence: bootEvidence,
      frameText: identity.frameText,
    }

    const game: Game<RetroArchState> = {
      id: `retroarch-${identity.core.replace(/_libretro\.(?:dylib|so|dll)$/u, '')}-${identity.contentSha.slice(0, 8)}`,
      init: (initSeed) => {
        const r = rpc.reset(initSeed)
        current = { gen: r.gen, frame: r.frame, evidence: toEvidence(rpc.evidence()), frameText: rpc.frameText() }
        return current
      },
      step: (s, input) => {
        // Staleness guard: gen only changes in init(), so a mismatch means a
        // caller is stepping a state captured against an older emulator boot.
        if (s.gen !== current.gen) {
          throw new Error(`stale state: gen ${s.gen} but worker is at gen ${current.gen} — step ordering violated`)
        }
        const r = rpc.step(input)
        current = { gen: current.gen, frame: r.frame, evidence: toEvidence(r.evidence), frameText: r.frameText }
        return current
      },
      frame: (s) => s.frameText,
      evidence: (s) => s.evidence,
    }

    const contract = deriveContract(
      game,
      seed,
      options.reference,
      channelMarks(options.channels, baseline, options.anchorChannelId, options.screenMilestones ?? false),
    )
    return {
      game,
      contract,
      reference: options.reference,
      inputs: identity.inputs,
      identity,
      baseline,
      seed,
      dispose: () => rpc.shutdown(),
    }
  } catch (error) {
    rpc.shutdown()
    throw error
  }
}
