/**
 * PyBoy real-emulator regression on a FREE ROM: Libbet and the Magic Floor
 * (pinobatch/libbet, GPL-3.0). The Tetris regression proves the same
 * mechanisms but needs a commercial ROM, so it stays local; this file is the
 * copy CI can run, because the ROM is downloadable and redistributable.
 *
 * Nothing here is Libbet-specific: the adapter is the generic one, and every
 * address, decode, and reference input comes from pyboy/discovery-libbet.json
 * (a discover.py artifact pinned to the release ROM by MD5).
 *
 * Environment:
 *   PLAYPROOF_ROM          path to the pinned Libbet ROM (MD5 must match the doc)
 *   PLAYPROOF_PYTHON       python with pyboy installed (default python3)
 *   PLAYPROOF_REQUIRE_ROM  set to 1 to fail instead of skip when either is missing
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { autoMarks, loadDiscovery, makePyBoyGeneric } from './adapters/pyboy-generic'
import { attestRun } from './attestation'
import { assertContractSeparates, assertOpaqueChecksDeclared, calibrateContract, UNKNOWN_BASELINE_WORD } from './calibration'
import { logFrom, observationOf } from './runtime'
import { contractLegibility, formatMilestoneScore, validateContract } from './schema'
import { decodePng, unscale } from './test-png.mts'

/** The Game Boy pad, matching `BUTTONS` in pyboy/tetris.py. */
const GAME_BOY_BUTTONS = ['up', 'down', 'left', 'right', 'a', 'b', 'start', 'select']
/** Turn count of the agent campaign this regression pins. */
const CAMPAIGN_TURNS = 70

const DISCOVERY = fileURLToPath(new URL('./pyboy/discovery-libbet.json', import.meta.url))
const WORKER_MATCH = 'pyboy/worker.py'
const required = process.env.PLAYPROOF_REQUIRE_ROM === '1'

function stop(reason: string): never {
  if (required) {
    console.error(`pyboy-libbet: FAIL — ${reason} (PLAYPROOF_REQUIRE_ROM=1 forbids skipping)`)
    process.exit(1)
  }
  console.log(`skip: pyboy-libbet — ${reason}`)
  process.exit(0)
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** PIDs of live PyBoy workers, so "dispose kills the worker" is an OS fact. */
function workerPids(): Set<number> {
  const listing = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' })
  const pids = new Set<number>()
  for (const line of (listing.stdout ?? '').split('\n')) {
    if (!line.includes(WORKER_MATCH)) continue
    const pid = Number.parseInt(line.trim().split(/\s+/u)[0] ?? '', 10)
    if (Number.isInteger(pid)) pids.add(pid)
  }
  return pids
}

const doc = loadDiscovery(DISCOVERY)
const rom = process.env.PLAYPROOF_ROM
if (!rom) stop('PLAYPROOF_ROM is unset')
if (!existsSync(rom)) stop(`PLAYPROOF_ROM does not exist: ${rom}`)

const romMd5 = createHash('md5').update(readFileSync(rom)).digest('hex')
assert.equal(romMd5, doc.romMd5,
  `PLAYPROOF_ROM is not the ROM this discovery document was built from.\n` +
  `  expected MD5 ${doc.romMd5} (Libbet and the Magic Floor v0.08)\n` +
  `  actual   MD5 ${romMd5} (${rom})\n` +
  `  get it from https://github.com/pinobatch/libbet/releases/download/v0.08/libbet.gb`)

const python = process.env.PLAYPROOF_PYTHON ?? 'python3'
if (spawnSync(python, ['-c', 'import pyboy'], { encoding: 'utf8' }).status !== 0) {
  stop(`${python} cannot import pyboy`)
}

const before = workerPids()
const adapter = makePyBoyGeneric(rom, doc)
const workerPid = [...workerPids()].find((pid) => !before.has(pid))
try {
  // (a) The contract is derived from the discovery document alone.
  assert.deepEqual(validateContract(adapter.contract), [])
  assert.equal(adapter.game.id, `pyboy-generic-${doc.romMd5.slice(0, 8)}`)
  assert.equal(adapter.contract.milestones.length, autoMarks(doc).length)
  assert.deepEqual(adapter.reference, doc.exploration.inputs)
  const tiers = new Set(adapter.contract.milestones.map((m) => m.tier))
  assert.ok(tiers.has('engine-state') && tiers.has('save-file') && tiers.has('screen-frame'),
    `expected all three evidence tiers, got ${[...tiers].join(',')}`)

  // (b) The reference playthrough reproduces every milestone.
  const all = adapter.contract.milestones.map((m) => m.id)
  const good = attestRun(adapter.game, adapter.contract, adapter.seed, logFrom(adapter.seed, [...adapter.reference]), all)
  assert.equal(good.verdict, 'clean', `reference run rejected: ${good.reasons.join('; ')}`)
  assert.ok(good.verified.length > 0)
  // verified is in the order the milestones first held, not contract order.
  assert.deepEqual([...good.verified].sort(), [...all].sort())

  // (c) Determinism: two power-on replays produce byte-identical evidence at
  // every step, so a verifier reruns the script instead of trusting a report.
  const trace = (): string[] => {
    const seen: string[] = []
    let state = adapter.game.init(adapter.seed)
    const record = (): void => {
      const e = adapter.game.evidence(state)
      assert.match(e.saveBlobHash ?? '', /^[0-9a-f]{64}$/u)
      assert.match(e.frameHash ?? '', /^[0-9a-f]{64}$/u)
      seen.push(`${JSON.stringify(e.engineState)}|${e.saveBlobHash}|${e.frameHash}`)
    }
    record()
    for (const w of adapter.reference) {
      state = adapter.game.step(state, w)
      record()
    }
    return seen
  }
  const first = trace()
  const second = trace()
  assert.equal(first.length, adapter.reference.length + 1)
  assert.deepEqual(first, second)
  assert.ok(new Set(first).size > 1, 'evidence never moved across the reference run')

  // (d) A garbage script (the reference reversed) is real input the emulator
  // accepts, and it still must not reproduce the pinned milestones.
  const garbage = attestRun(adapter.game, adapter.contract, adapter.seed, logFrom(adapter.seed, [...adapter.reference].reverse()), all)
  assert.equal(garbage.verdict, 'rejected')
  assert.ok(garbage.reasons.some((r) => r.startsWith('claimed-not-reproduced')), garbage.reasons.join('; '))
  assert.notDeepEqual(garbage.verified, all)
  for (const m of adapter.contract.milestones) {
    if (m.tier === 'engine-state') continue
    assert.ok(!garbage.verified.includes(m.id), `garbage input reproduced ${m.tier} milestone ${m.id}`)
  }

  console.log(`pyboy-libbet: derivation, 3-tier contract, ${all.length} milestones on ${adapter.reference.length} reference inputs, determinism, garbage-input rejection OK`)

  // (e) Calibration regression — this contract is NOT a benchmark, and the
  // gate must keep saying so.
  //
  // A live agent campaign ran 70 turns on this ROM through this adapter and
  // this discovery document and earned three milestones: ch_c321-progressed,
  // ch_c32d-progressed, ch_ff96-progressed. Its verdict was clean and its run
  // replay-verified. Pressing "a" 70 times earns the same three milestones.
  //
  // The agent's transcript is not packaged, so the reference here is the
  // packaged exploration trajectory truncated to the same progress level: the
  // inputs before the rank-0 channel first moves. Every baseline still gets the
  // campaign's full 70 turns, which can only favour the baselines.
  //
  // Nobody may read a Libbet milestone count as evidence of competence.
  const rank0 = [...doc.channels].sort((a, b) => a.rank - b.rank)[0]!
  const report = calibrateContract(adapter.game, adapter.contract, {
    reference: adapter.reference.slice(0, rank0.firstChangeStep - 1),
    vocabulary: GAME_BOY_BUTTONS,
    turns: CAMPAIGN_TURNS,
    seed: adapter.seed,
  })
  for (const outcome of [report.reference, ...report.baselines]) {
    console.log(`  ${outcome.id.padEnd(32)} ${String(outcome.verified.length).padStart(2)}  ${outcome.verdict}  ${outcome.verified.join(',') || '-'}`)
  }
  assert.deepEqual(report.reference.verified, ['ch_c321-progressed', 'ch_c32d-progressed', 'ch_ff96-progressed'],
    'the reference no longer reproduces the milestone set the live agent earned')
  const constantA = report.baselines.find((b) => b.id === 'constant:a')
  assert.deepEqual(constantA?.verified, report.reference.verified,
    'pressing "a" 70 times must still earn exactly what the evaluated agent earned')
  assert.ok(report.bestBaselineCount >= report.reference.verified.length,
    `best baseline ${report.bestBaselineCount} vs reference ${report.reference.verified.length}`)
  assert.deepEqual(report.separating, [], 'no Libbet milestone is out of reach of a trivial policy')
  assert.equal(report.separates, false, 'the Libbet discovery contract must not claim to separate')
  assert.throws(() => assertContractSeparates(report), /constant:a/u)
  // The milestones need a button, just not the right one: an uninterpretable
  // word earns nothing, so this is not a pure function of elapsed frames.
  assert.deepEqual(report.baselines.find((b) => b.id === `constant:${UNKNOWN_BASELINE_WORD}`)?.verified, [])

  // (e2) The legible/opaque split on the derived contract. `autoMarks` anchors
  // one save-hash and one frame-hash milestone at the confirmed channel's first
  // progression. Both are points a policy can score by reaching that state;
  // neither says anything a reader can weigh, so both must be declared.
  const legibility = contractLegibility(adapter.contract)
  assert.deepEqual(legibility.opaque, ['state-at-first-progression', 'frame-at-first-progression'])
  assert.equal(legibility.legible.length, 4)
  assert.ok(legibility.legible.every((id: string) => id.endsWith('-progressed')))
  assert.deepEqual(report.legible, legibility.legible)
  // Six milestones, six points. The reference stops before the pinned state,
  // so it scored three of six.
  assert.deepEqual(report.referenceScore, { verified: 3, total: 6 })
  assert.equal(formatMilestoneScore(report.referenceScore), '3 of 6')
  assert.deepEqual(report.opaqueReproduced, [])
  // The sweep cannot measure a check the reference never reaches, and says so
  // with -1 rather than reporting a clean result it did not earn.
  assert.deepEqual(report.collisions.map((row) => [row.milestone, row.firesAfter, row.collisions]), [
    ['state-at-first-progression', -1, 0],
    ['frame-at-first-progression', -1, 0],
  ])
  // Undeclared, the contract fails the opacity gate on its own, which is a
  // second, independent reason this target must not be published as a score.
  assert.throws(
    () => assertOpaqueChecksDeclared(report),
    (error: unknown) => {
      const message = (error as Error).message
      assert.match(message, /states 2 of 6 milestone\(s\) as a hash/u)
      assert.match(message, /4 legible, 33% opaque/u)
      return true
    },
  )
  const declared = { opaqueChecks: ['state-at-first-progression', 'frame-at-first-progression'] }
  assertOpaqueChecksDeclared(report, declared)
  assert.throws(() => assertContractSeparates(report, declared), /does not separate/u)

  console.log(`pyboy-libbet: calibration regression — reference ${formatMilestoneScore(report.referenceScore)}, best trivial baseline ${report.bestBaselineCount} verified / ${report.bestBaselineLegibleCount} legible over ${report.turns} turns, separates=${report.separates} OK`)

  // (f) The observation image channel on the real emulator. PyBoy's own
  // screen.image needs Pillow, which is absent here — the boot logs say so —
  // so the worker encodes the PNG from the raw array itself.
  assert.equal('images' in observationOf(adapter.game, adapter.game.init(adapter.seed)), false)
  const vision = makePyBoyGeneric(rom, doc, { screenImage: true, screenScale: 3 })
  try {
    let seen = vision.game.init(vision.seed)
    for (const input of vision.reference.slice(0, 60)) seen = vision.game.step(seen, input)
    const observation = observationOf(vision.game, seen)
    assert.equal(observation.text, vision.game.frame(seen))
    assert.equal(observation.images?.length, 1)
    const image = observation.images![0]!
    assert.equal(image.mediaType, 'image/png')
    const decoded = decodePng(Buffer.from(image.base64, 'base64'), { expectFilterNone: true })
    assert.deepEqual([decoded.width, decoded.height], [160 * 3, 144 * 3])
    assert.deepEqual([image.width, image.height], [decoded.width, decoded.height])

    // The strongest statement about this channel, and the one that does not
    // depend on what this ROM happens to draw: the picture the agent is shown
    // is the screen the verifier hashes. Undoing the whole-pixel upscale
    // recovers the native buffer, and its SHA-256 is `frameHash`.
    //
    // Libbet under the blind generic preamble draws an all-white screen from
    // about the fortieth reference input onward, so a "more than one colour"
    // assertion would pin a property of this ROM rather than of the channel.
    const native = createHash('sha256').update(unscale(decoded, 3)).digest('hex')
    assert.equal(native, vision.game.evidence(seen).frameHash)

    // The image path does not perturb the emulator: at the same instant of the
    // same script, the evidence a verifier recomputes is identical.
    let plain = adapter.game.init(adapter.seed)
    for (const input of adapter.reference.slice(0, 60)) plain = adapter.game.step(plain, input)
    assert.deepEqual(vision.game.evidence(seen), adapter.game.evidence(plain))
    console.log(
      `pyboy-libbet: observation image — ${decoded.width}x${decoded.height} PNG, ` +
      `${Buffer.from(image.base64, 'base64').length} bytes encoded, ${decoded.colours} distinct colours, ` +
      'pixels hash to frameHash, evidence unchanged, no Pillow OK',
    )
  } finally {
    vision.dispose()
  }
} finally {
  adapter.dispose()
}

// (g) Dispose ends the worker process and closes the transport.
assert.ok(workerPid !== undefined, 'no PyBoy worker process was observed while the adapter was live')
const deadline = Date.now() + 5_000
while (workerPids().has(workerPid) && Date.now() < deadline) sleepSync(50)
assert.ok(!workerPids().has(workerPid), `PyBoy worker ${workerPid} survived dispose`)
assert.throws(() => adapter.game.init(adapter.seed), /closed/u)
console.log(`pyboy-libbet: dispose reaped worker pid ${workerPid} OK`)
