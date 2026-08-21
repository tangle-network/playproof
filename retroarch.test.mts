/**
 * RetroArch adapter test — the black-box host gate, and the cross-emulator proof.
 *
 * The headline is not that a Game Boy game runs. It is that the SAME evidence
 * channels `pyboy/discover.py` found by watching PyBoy's work RAM verify
 * through RetroArch and gambatte, two pieces of software that share no code
 * with PyBoy. `pyboy/discovery-libbet.json` supplies the addresses, the decode
 * of each channel, the 266-input reference script, and PyBoy's own recorded
 * value for every channel at every step. Nothing in this file is typed by
 * hand: not an address, not a threshold, not a hash.
 *
 * Assets are never committed. The test needs three paths from the environment:
 *   PLAYPROOF_RETROARCH       RetroArch executable
 *   PLAYPROOF_RETROARCH_CORE  gambatte core (libretro buildbot)
 *   PLAYPROOF_ROM             Libbet and the Magic Floor v0.08, free software
 * It skips with one line when they are missing, unless
 * PLAYPROOF_REQUIRE_RETROARCH=1, which turns a missing asset into a loud
 * failure (that is how CI proves the job really executed).
 *
 * RetroArch runs one instance at a time, so every emulator in this file is
 * booted, used, and disposed before the next one starts.
 */
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { attestRun } from './attestation'
import { logFrom, observationOf } from './runtime'
import { validateContract } from './schema'
import { decodePng } from './test-png.mts'
import type { DiscoveryDoc } from './adapters/pyboy-generic'
import { RetroArchRpc } from './adapters/retroarch-rpc'
import { channelsFromDiscovery, makeRetroArch, type RetroArch, type RetroArchState } from './adapters/retroarch'

const binary = process.env.PLAYPROOF_RETROARCH
const core = process.env.PLAYPROOF_RETROARCH_CORE
const rom = process.env.PLAYPROOF_ROM

/**
 * PyBoy applies each input for 2 frames and lets the game settle for 8. The
 * same window is used here so the two emulators see the same input timing and
 * the channel comparison measures the emulators, not two different scripts.
 */
const FRAMES = 10
const PRESS_FRAMES = 2
/**
 * Frames advanced after the core reset that pin the boot state. RetroArch
 * starts emulating the moment content loads and a core reset does not clear
 * work RAM, so the boot state inherits whatever the launch race produced
 * until the game finishes its own initialisation. Measured on gambatte with
 * Libbet: 60 frames leaves one snapshot of 21 differing between processes,
 * 180 frames makes every snapshot identical, and 420 frames diverges again
 * because the title screen animation is by then running at a phase that
 * depends on the residue. 180 is the value cross-process determinism holds at.
 */
const BOOT_FRAMES = 180
/** Determinism and cross-emulator agreement are measured over this prefix. */
const TRACE_INPUTS = 120


function missing(): string | null {
  // Hard platform guard, ahead of every other check. The RetroArch that
  // Homebrew installs on macOS is an x86_64 build running under Rosetta, and
  // it segfaults inside an environment callback during `retro_run`
  // (KERN_INVALID_ADDRESS, repeatedly, with a crash dialog each time). The
  // adapter is therefore unproven on darwin and this gate never launches an
  // emulator there, even when the paths are set. Linux CI is the execution
  // proof; see docs/adapters.md.
  if (process.platform === 'darwin') {
    return 'the RetroArch gate does not run on macOS: the x86_64 build under Rosetta segfaults during retro_run'
  }
  if (!binary) return 'PLAYPROOF_RETROARCH is unset (path to the RetroArch executable)'
  if (!existsSync(binary)) return `PLAYPROOF_RETROARCH=${binary} does not exist`
  if (!core) return 'PLAYPROOF_RETROARCH_CORE is unset (path to a gambatte libretro core)'
  if (!existsSync(core)) return `PLAYPROOF_RETROARCH_CORE=${core} does not exist`
  if (!rom) return 'PLAYPROOF_ROM is unset (path to Libbet and the Magic Floor v0.08)'
  if (!existsSync(rom)) return `PLAYPROOF_ROM=${rom} does not exist`
  return null
}

interface Trace {
  /** Only the channels the contract reads. Every milestone rests on these. */
  pinned: string[]
  /** Every declared channel, reported rather than asserted across processes. */
  all: string[]
  /** Screen evidence, reported rather than asserted across processes. */
  screens: string[]
  engine: Record<string, number>[]
}

const gap = missing()
if (gap) {
  const hint =
    `${gap}; the adapter needs a RetroArch binary, a libretro core, and content. ` +
    'Get the core from https://buildbot.libretro.com/nightly/ and the free ROM from ' +
    'https://github.com/pinobatch/libbet/releases/download/v0.08/libbet.gb'
  // A macOS skip is unconditional: PLAYPROOF_REQUIRE_RETROARCH exists so CI
  // cannot silently skip a missing asset, not to force an emulator that
  // crashes on this platform.
  if (process.env.PLAYPROOF_REQUIRE_RETROARCH === '1' && process.platform !== 'darwin') {
    throw new Error(`PLAYPROOF_REQUIRE_RETROARCH=1 but ${hint}`)
  }
  console.log(`retroarch: skip: ${hint}`)
} else {
  const doc = JSON.parse(readFileSync(new URL('./pyboy/discovery-libbet.json', import.meta.url), 'utf8')) as DiscoveryDoc
  const romMd5 = createHash('md5').update(readFileSync(rom!)).digest('hex')
  assert.equal(
    romMd5,
    doc.romMd5,
    `PLAYPROOF_ROM is md5 ${romMd5} but the discovery document was authored on ${doc.romMd5}; ` +
    'point PLAYPROOF_ROM at Libbet and the Magic Floor v0.08',
  )

  const channels = channelsFromDiscovery(doc)
  const reference = doc.exploration.inputs
  const options = {
    binary: binary!,
    core: core!,
    content: rom!,
    channels,
    inputs: ['up', 'down', 'left', 'right', 'a', 'b', 'start', 'select'],
    frames: FRAMES,
    pressFrames: PRESS_FRAMES,
    bootFrames: BOOT_FRAMES,
    reference,
  }

  /**
   * One replay, recorded as the evidence a verifier would recompute. The
   * privileged stream and the screen stream are kept apart because only the
   * first is asserted: see the cross-process check below.
   */
  const trace = (adapter: RetroArch, inputs: readonly string[], pinnedPaths: readonly string[]): Trace => {
    let state: RetroArchState = adapter.game.init(adapter.seed)
    const pinned: string[] = []
    const all: string[] = []
    const screens: string[] = []
    const engine: Record<string, number>[] = []
    const record = (s: RetroArchState): void => {
      const e = adapter.game.evidence(s)
      const engineState = e.engineState ?? {}
      pinned.push(JSON.stringify(pinnedPaths.map((path) => engineState[path])))
      all.push(JSON.stringify(engineState))
      screens.push(`${e.frameHash}|${JSON.stringify(e.frameState)}`)
    }
    record(state)
    for (const input of inputs) {
      state = adapter.game.step(state, input)
      record(state)
      engine.push({ ...(adapter.game.evidence(state).engineState ?? {}) })
    }
    return { pinned, all, screens, engine }
  }

  const dead = async (pid: number | null): Promise<boolean> => {
    if (pid === null) return false
    for (let i = 0; i < 100; i++) {
      try {
        process.kill(pid, 0)
      } catch {
        return true
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return false
  }

  const prefix = reference.slice(0, TRACE_INPUTS)
  let first: Trace
  let firstPid: number | null = null
  let contractIds: string[] = []
  let pinnedPaths: string[] = []

  // ── emulator 1: contract derivation, attestation, determinism in process ──
  const adapter = makeRetroArch({ ...options, screenImage: true })
  try {
    // Identity: RetroArch loaded the content the discovery document pins, and
    // the adapter advertises this core's button vocabulary.
    assert.equal(adapter.identity.contentSha, createHash('sha256').update(readFileSync(rom!)).digest('hex'))
    assert.ok(adapter.identity.status.includes('PAUSED'), `emulator is not paused: ${adapter.identity.status}`)
    assert.equal(adapter.game.id, `retroarch-gambatte-${adapter.identity.contentSha.slice(0, 8)}`)
    assert.ok(adapter.inputs.includes('NOOP') && adapter.inputs.includes('up+a'),
      `input vocabulary missing expected words: ${adapter.inputs.join(',')}`)
    assert.equal(adapter.identity.channels.length, channels.length)

    // Observation images: this worker needs no encoder. RetroArch writes a PNG
    // for SCREENSHOT and the evidence path already reads it, so the option
    // republishes those exact bytes.
    assert.equal(adapter.identity.screenImage, true)
    const bootState = adapter.game.init(adapter.seed)
    const observation = observationOf(adapter.game, bootState)
    assert.equal(observation.text, adapter.game.frame(bootState))
    assert.equal(observation.images?.length, 1)
    const screen = observation.images![0]!
    assert.equal(screen.mediaType, 'image/png')
    const decoded = decodePng(Buffer.from(screen.base64, 'base64'))
    assert.deepEqual([screen.width, screen.height], [decoded.width, decoded.height])
    // `frameHash` covers the DECODED pixels and never the file, because
    // RetroArch picks a filter per scanline. That is what makes republishing
    // its file sound, and it lets this gate prove the identity: the picture the
    // agent sees is the screen the verifier hashes.
    assert.equal(
      createHash('sha256').update(decoded.pixels).digest('hex'),
      adapter.game.evidence(bootState).frameHash,
    )

    // Authoring: contract derived from the discovered channels with
    // event-anchored marks. No hash, position, or threshold is in the adapter.
    assert.deepEqual(validateContract(adapter.contract), [])
    assert.ok(adapter.contract.milestones.length >= 4, `thin contract: ${adapter.contract.milestones.length} milestones`)
    // Screen evidence is published but never pinned by default: a milestone
    // is only honest when a verifier in another process reproduces it, and
    // the cross-process measurement below is why this contract is engine
    // state alone. `screenMilestones` opts in where a core earns it.
    const tiers = new Set(adapter.contract.milestones.map((m) => m.tier))
    assert.deepEqual([...tiers], ['engine-state'],
      `expected engine-state milestones only, got ${[...tiers].join(',')}`)
    const kinds = new Set(adapter.contract.milestones.map((m) => m.check.kind))
    assert.deepEqual([...kinds], ['state-path'],
      `expected only state-path checks by default, got ${[...kinds].join(',')}`)

    // Known-good: the discovered reference verifies every milestone THROUGH
    // RETROARCH. This is the cross-emulator claim: channels found on PyBoy
    // carry real progression on gambatte.
    contractIds = adapter.contract.milestones.map((m) => m.id)
    const good = attestRun(adapter.game, adapter.contract, adapter.seed, logFrom(adapter.seed, [...adapter.reference]), contractIds)
    assert.equal(good.verdict, 'clean', `reference rejected: ${good.reasons.join('; ')}`)
    // Milestones verify in the order they fire, which is not the order they
    // are declared in, so the claim is that every one of them reproduced.
    assert.deepEqual([...good.verified].sort(), [...contractIds].sort())
    assert.ok(good.verified.length > 0)

    // False claim: a garbage script of the same length claiming the same
    // milestones is rejected. The words mix real buttons with nonsense that
    // maps to a no-op.
    // Every word is unknown, so every one is a no-op: this is a run that
    // claims the whole contract while never pressing a button. Libbet is
    // played with the direction pad, so a script of real directions is not a
    // false claim at all — it is a worse attempt at the same game, and it
    // does earn milestones.
    const garbageWords = ['wiggle', 'flibbertigibbet', 'nope', 'b-not-a-button', 'jump', 'zzz', 'hurry', 'win']
    const garbage = adapter.reference.map((_, i) => garbageWords[i % garbageWords.length]!)
    const rejected = attestRun(adapter.game, adapter.contract, adapter.seed, logFrom(adapter.seed, garbage), contractIds)
    assert.equal(rejected.verdict, 'rejected')
    assert.ok(rejected.reasons.some((r) => r.startsWith('claimed-not-reproduced')), rejected.reasons.join('; '))

    // Determinism inside one emulator.
    pinnedPaths = adapter.contract.milestones
      .filter((m) => m.check.kind === 'state-path')
      .map((m) => (m.check as { path: string }).path)
    assert.ok(pinnedPaths.length > 0)
    first = trace(adapter, prefix, pinnedPaths)
    const again = trace(adapter, prefix, pinnedPaths)
    assert.deepEqual(again.all, first.all, 'same-process replay diverged')
    assert.equal(first.all.length, prefix.length + 1)

    // Unknown inputs are no-ops, not cheats and not errors.
    const junkWords = ['FLIBBERTIGIBBET', '', 'nope', 'b-not-a-button']
    let junkState = adapter.game.init(adapter.seed)
    for (const word of junkWords) junkState = adapter.game.step(junkState, word)
    let noopState = adapter.game.init(adapter.seed)
    for (const _ of junkWords) noopState = adapter.game.step(noopState, 'NOOP')
    assert.deepEqual(adapter.game.evidence(junkState), adapter.game.evidence(noopState))

    firstPid = adapter.identity.pid
  } finally {
    adapter.dispose()
  }
  assert.throws(() => adapter.game.init(adapter.seed), /closed/)
  assert.ok(await dead(firstPid), `dispose left RetroArch ${firstPid} running`)

  // ── emulator 2: the contract has to verify somewhere else ───────────────
  // This is the whole replay claim. A verifier never shares the emulator that
  // produced a run: it boots its own, replays the input log, and recomputes
  // the evidence. The assertion is therefore that the contract derived in the
  // first emulator verifies clean in a second one, which is exactly the work a
  // verifier does. Per-snapshot agreement is measured underneath it and
  // reported, because two boots of a console that does not clear its memory on
  // reset do not have to agree on every byte for every milestone to reproduce.
  const second = makeRetroArch(options)
  let secondPid: number | null = null
  let other: Trace
  try {
    secondPid = second.identity.pid
    assert.equal(second.game.id, adapter.game.id)
    // The image channel is off by default, and turning it on changed neither
    // the game id nor anything a verifier recomputes.
    assert.equal(second.identity.screenImage, false)
    assert.equal('images' in observationOf(second.game, second.game.init(second.seed)), false)
    const elsewhere = attestRun(
      second.game,
      adapter.contract,
      adapter.seed,
      logFrom(adapter.seed, [...adapter.reference]),
      contractIds,
    )
    assert.equal(elsewhere.verdict, 'clean',
      `the contract did not verify in a second emulator: ${elsewhere.reasons.join('; ')}`)
    assert.deepEqual([...elsewhere.verified].sort(), [...contractIds].sort())
    other = trace(second, prefix, pinnedPaths)
  } finally {
    second.dispose()
  }
  assert.ok(await dead(secondPid), `dispose left RetroArch ${secondPid} running`)

  // ── cross-emulator agreement ─────────────────────────────────────────────
  // The discovery document carries PyBoy's own value for every channel at
  // every step of the same script, so the comparison needs no second emulator
  // running here. Emulators differ in where a frame boundary falls, so a
  // channel that samples an animation can disagree on a few steps; the hard
  // assertion is the milestone outcome above, and agreement is reported.
  const agreement = channels.map((channel) => {
    // `values` is discovery's recorded PyBoy reading per step. It is not part
    // of the DiscoveredChannel contract the adapter consumes, so it is read
    // here through its own narrow shape.
    const source = doc.channels.find((c) => c.id === channel.id) as unknown as { values?: number[] }
    const recorded = source.values ?? []
    const ours = first!.engine.map((row) => row[channel.id]!)
    const n = Math.min(recorded.length, ours.length)
    let same = 0
    for (let i = 0; i < n; i++) if (recorded[i] === ours[i]) same++
    return { id: channel.id, same, n }
  })
  // Screen evidence: measured, reported, and deliberately not asserted.
  // Two separately launched emulators reach the same work RAM at every
  // snapshot, and the same screen for a while before an animation drifts one
  // step out of phase, which is why no milestone is pinned to it here.
  let pinnedAgree = 0
  for (let i = 0; i < first!.pinned.length; i++) {
    if (first!.pinned[i] === other!.pinned[i]) pinnedAgree++
  }
  let screenAgree = 0
  for (let i = 0; i < first!.screens.length; i++) {
    if (first!.screens[i] === other!.screens[i]) screenAgree++
  }
  let allAgree = 0
  for (let i = 0; i < first!.all.length; i++) {
    if (first!.all[i] === other!.all[i]) allAgree++
  }

  const exact = agreement.filter((a) => a.same === a.n)
  const near = agreement.filter((a) => a.same >= Math.floor(a.n * 0.9))
  const tracking = agreement.filter((a) => a.same >= Math.floor(a.n * 0.5))
  // The bar is that most channels TRACK PyBoy, not that they match it step for
  // step: two emulators put frame boundaries in different places, so a channel
  // that samples an animation disagrees on the steps around each transition.
  // Wrong addresses or a wrong decode would show as agreement near zero, which
  // is what this catches. The exact figures are printed below either way.
  assert.ok(tracking.length >= channels.length / 2,
    `only ${tracking.length}/${channels.length} channels track PyBoy on half the steps: ` +
    agreement.map((a) => `${a.id} ${a.same}/${a.n}`).join(', '))

  // ── emulator 3: checkpoints ──────────────────────────────────────────────
  const rpc = new RetroArchRpc()
  let rpcPid: number | null = null
  try {
    const identity = rpc.boot({
      binary: binary!,
      core: core!,
      content: rom!,
      channels,
      inputs: options.inputs,
      frames: FRAMES,
      pressFrames: PRESS_FRAMES,
      bootFrames: BOOT_FRAMES,
    })
    rpcPid = identity.pid
    for (const input of reference.slice(0, 40)) rpc.step(input)
    const checkpoint = rpc.snapshot()
    const ahead = ['a', 'up', 'b', 'down'].map((w) => JSON.stringify(rpc.step(w).evidence))
    const restored = rpc.restore(checkpoint)
    assert.equal(restored.gen, 1)
    const replayed = ['a', 'up', 'b', 'down'].map((w) => JSON.stringify(rpc.step(w).evidence))
    assert.deepEqual(replayed, ahead, 'checkpoint restore did not reproduce the same evidence')
    assert.throws(() => rpc.restore(Buffer.from('not a checkpoint')), /worker restore failed/)
  } finally {
    rpc.shutdown()
  }
  assert.ok(await dead(rpcPid), `shutdown left RetroArch ${rpcPid} running`)

  console.log(
    `retroarch: gambatte through RetroArch ${adapter.identity.status.split(' ')[1] ?? ''} — ` +
    `${contractIds.length}-milestone contract derived from ${channels.length} discovered channels, ` +
    `known-good over ${reference.length} inputs, false-claim rejected, ` +
    `contract re-verified in a second emulator over ${reference.length} inputs ` +
    `(snapshot agreement between the two: pinned channels ${pinnedAgree}/${first!.pinned.length}, ` +
    `all ${channels.length} channels ${allAgree}/${first!.all.length}, screen ${screenAgree}/${first!.screens.length}), ` +
    `checkpoint round-trip, ` +
    `unknown-input no-op, teardown OK; cross-emulator agreement with PyBoy: ` +
    `${exact.length}/${channels.length} channels exact, ${near.length}/${channels.length} agree on 90% of steps, ` +
    `${tracking.length}/${channels.length} on half, over ${TRACE_INPUTS} inputs`,
  )
}
