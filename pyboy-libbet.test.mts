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
import { logFrom } from './runtime'
import { validateContract } from './schema'

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
} finally {
  adapter.dispose()
}

// (e) Dispose ends the worker process and closes the transport.
assert.ok(workerPid !== undefined, 'no PyBoy worker process was observed while the adapter was live')
const deadline = Date.now() + 5_000
while (workerPids().has(workerPid) && Date.now() < deadline) sleepSync(50)
assert.ok(!workerPids().has(workerPid), `PyBoy worker ${workerPid} survived dispose`)
assert.throws(() => adapter.game.init(adapter.seed), /closed/u)
console.log(`pyboy-libbet: dispose reaped worker pid ${workerPid} OK`)
