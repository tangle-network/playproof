/**
 * Contract calibration test — the gate that rejects a contract a trivial
 * baseline satisfies.
 *
 * Two hand-written games make the two outcomes exact. The combination lock can
 * only be opened by one long word sequence, so it must separate. The mash game
 * pins a channel that moves whenever one button is pressed — the Libbet shape —
 * so it must not. The native-2048 adapter then runs the same gate on a real
 * out-of-process game.
 */
import { strict as assert } from 'node:assert'
import { deriveContract } from './authoring'
import {
  assertContractSeparates,
  calibrateContract,
  trivialBaselines,
  UNKNOWN_BASELINE_WORD,
} from './calibration'
import type { Game } from './runtime'
import { makeNative2048, NATIVE_2048_INPUTS, NATIVE_2048_REFERENCE } from './adapters/native-2048'

// --- a game that needs an exact sequence ------------------------------------

const LOCK_VOCABULARY = ['a', 'b', 'c', 'd', 'e', 'f']
const LOCK_CODE = ['c', 'a', 'f', 'b', 'e', 'd']
const LOCK_REFERENCE = ['b', 'a', ...LOCK_CODE]

interface LockState {
  progress: number
  opened: number
  steps: number
}

const comboLock: Game<LockState> = {
  id: 'combo-lock',
  init: () => ({ progress: 0, opened: 0, steps: 0 }),
  step: (s, input) => {
    const steps = s.steps + 1
    if (s.opened === 1) return { ...s, steps }
    const advances = input === LOCK_CODE[s.progress]
    const restarts = !advances && input === LOCK_CODE[0]
    const progress = advances ? s.progress + 1 : restarts ? 1 : 0
    return { progress, opened: progress === LOCK_CODE.length ? 1 : 0, steps }
  },
  frame: (s) => `steps ${s.steps} · the lock is ${s.opened === 1 ? 'open' : 'shut'}`,
  evidence: (s) => ({ engineState: { progress: s.progress, opened: s.opened, steps: s.steps } }),
}

const lockContract = deriveContract(comboLock, 0, [...LOCK_REFERENCE], [
  {
    // Free: any input at all moves the step counter. A contract may carry such
    // a milestone and still separate, as long as something is out of reach.
    id: 'moved',
    tier: 'engine-state',
    glitchClass: 'legal',
    when: (e) => (e.engineState?.steps ?? 0) >= 1,
    sample: (e) => ({ kind: 'state-path', path: 'steps', op: '>=', value: e.engineState?.steps ?? 1 }),
  },
  {
    id: 'lock-opened',
    tier: 'engine-state',
    glitchClass: 'legal',
    requires: ['moved'],
    when: (e) => (e.engineState?.opened ?? 0) >= 1,
    sample: (e) => ({ kind: 'state-path', path: 'opened', op: '>=', value: e.engineState?.opened ?? 1 }),
  },
])

// --- a game whose channel moves whenever one button is pressed ---------------

const MASH_VOCABULARY = ['a', 'b', 'up', 'down']
const MASH_REFERENCE = ['up', 'a', 'down', 'a', 'b', 'up', 'a', 'down']

interface MashState {
  channel: number
  steps: number
}

const mashGame: Game<MashState> = {
  id: 'mash-channel',
  init: () => ({ channel: 0, steps: 0 }),
  step: (s, input) => ({ channel: input === 'a' ? s.channel + 1 : s.channel, steps: s.steps + 1 }),
  frame: (s) => `steps ${s.steps}`,
  evidence: (s) => ({ engineState: { channel: s.channel, steps: s.steps } }),
}

const mashContract = deriveContract(mashGame, 0, [...MASH_REFERENCE], [
  {
    id: 'channel-progressed',
    tier: 'engine-state',
    glitchClass: 'legal',
    when: (e) => (e.engineState?.channel ?? 0) > 0,
    sample: (e) => ({ kind: 'state-path', path: 'channel', op: '>=', value: e.engineState?.channel ?? 1 }),
  },
])

// (a) a contract that genuinely requires skill separates.
{
  const report = calibrateContract(comboLock, lockContract, {
    reference: LOCK_REFERENCE,
    vocabulary: LOCK_VOCABULARY,
  })
  assert.equal(report.separates, true, `lock contract must separate: ${JSON.stringify(report.separating)}`)
  assert.deepEqual(report.separating, ['lock-opened'])
  assert.deepEqual(report.trivial, ['moved'])
  assert.equal(report.bestBaselineCount, 1)
  assert.deepEqual(report.reference.verified, ['moved', 'lock-opened'])
  assertContractSeparates(report)

  // (d) the counts are internally consistent.
  assert.equal(report.turns, LOCK_REFERENCE.length)
  assert.equal(report.seed, 0)
  assert.deepEqual(report.vocabulary, LOCK_VOCABULARY)
  assert.equal(report.baselines.length, LOCK_VOCABULARY.length + 3)
  assert.equal(report.bestBaselineCount, Math.max(...report.baselines.map((b) => b.verified.length)))
  assert.ok(report.baselines.every((b) => b.verdict === 'clean'))
  assert.ok(report.separating.every((id) => !report.trivial.includes(id)))
  for (const id of report.reference.verified) {
    assert.ok(report.separating.includes(id) !== report.trivial.includes(id),
      `${id} must be either separating or trivial, never both or neither`)
  }
  // No baseline may earn a milestone that is reported as separating.
  for (const baseline of report.baselines) {
    for (const id of baseline.verified) assert.ok(!report.separating.includes(id))
  }
  // The unknown word is a no-op, so it earns exactly what elapsed time earns.
  const unknown = report.baselines.find((b) => b.id === `constant:${UNKNOWN_BASELINE_WORD}`)
  assert.deepEqual(unknown?.verified, ['moved'])
}

// (b) a contract a constant policy satisfies does not separate, and the gate
// throws with the offending baseline named.
{
  const report = calibrateContract(mashGame, mashContract, {
    reference: MASH_REFERENCE,
    vocabulary: MASH_VOCABULARY,
  })
  assert.equal(report.separates, false)
  assert.deepEqual(report.separating, [])
  assert.deepEqual(report.trivial, ['channel-progressed'])
  assert.deepEqual(report.reference.verified, ['channel-progressed'])
  assert.equal(report.bestBaselineCount, 1)
  const earners = report.baselines.filter((b) => b.verified.includes('channel-progressed')).map((b) => b.id)
  assert.deepEqual(earners, ['constant:a', 'round-robin', 'pseudo-random'])

  assert.throws(
    () => assertContractSeparates(report),
    (error: unknown) => {
      const message = (error as Error).message
      assert.match(message, /does not separate/u)
      assert.match(message, /channel-progressed/u)
      assert.match(message, /constant:a/u)
      assert.match(message, /reference verified 1 milestone\(s\)/u)
      assert.match(message, /best trivial baseline verified 1 over 8 turns/u)
      return true
    },
  )
}

// (c) policies are deterministic across calls, and only pseudo-random moves
// with the seed.
{
  const script = (seed: number) =>
    Object.fromEntries(trivialBaselines(LOCK_VOCABULARY).map((p) => [p.id, [...p.inputs(LOCK_VOCABULARY, 12, seed)]]))
  assert.deepEqual(script(0), script(0))
  assert.deepEqual(script(7), script(7))
  const zero = script(0)
  const seven = script(7)
  for (const id of Object.keys(zero)) {
    if (id === 'pseudo-random') continue
    assert.deepEqual(zero[id], seven[id], `${id} must not depend on the seed`)
  }
  assert.notDeepEqual(zero['pseudo-random'], seven['pseudo-random'], 'pseudo-random must depend on the seed')
  assert.deepEqual(zero['constant:c'], Array.from({ length: 12 }, () => 'c'))
  assert.deepEqual(zero['round-robin']?.slice(0, 7), ['a', 'b', 'c', 'd', 'e', 'f', 'a'])
  assert.ok(zero['pseudo-random']?.every((word) => LOCK_VOCABULARY.includes(word)))

  // A seeded report reproduces exactly.
  const options = { reference: LOCK_REFERENCE, vocabulary: LOCK_VOCABULARY, seed: 3 }
  assert.deepEqual(calibrateContract(comboLock, lockContract, options), calibrateContract(comboLock, lockContract, options))
}

// (e) a one-word vocabulary and a zero-turn calibration are handled.
{
  const single = calibrateContract(mashGame, mashContract, {
    reference: MASH_REFERENCE,
    vocabulary: ['a'],
  })
  assert.deepEqual(single.vocabulary, ['a'])
  assert.equal(single.baselines.length, 4)
  assert.equal(single.separates, false)
  assert.deepEqual(single.trivial, ['channel-progressed'])

  const empty = calibrateContract(comboLock, lockContract, {
    reference: [],
    vocabulary: LOCK_VOCABULARY,
  })
  assert.equal(empty.turns, 0)
  assert.deepEqual(empty.reference.verified, [])
  assert.deepEqual(empty.separating, [])
  assert.deepEqual(empty.trivial, [])
  assert.equal(empty.bestBaselineCount, 0)
  assert.equal(empty.separates, false)
  assert.ok(empty.baselines.every((b) => b.verified.length === 0))

  const truncated = calibrateContract(comboLock, lockContract, {
    reference: LOCK_REFERENCE,
    vocabulary: LOCK_VOCABULARY,
    turns: 2,
  })
  assert.equal(truncated.turns, 2)
  assert.deepEqual(truncated.reference.verified, ['moved'])
  assert.equal(truncated.separates, false)

  assert.throws(
    () => calibrateContract(comboLock, lockContract, { reference: LOCK_REFERENCE, vocabulary: [] }),
    /empty input vocabulary/u,
  )
  assert.throws(
    () => calibrateContract(comboLock, lockContract, { reference: LOCK_REFERENCE, vocabulary: LOCK_VOCABULARY, turns: -1 }),
    /non-negative integer/u,
  )
}

/**
 * The same gate on a real out-of-process game, and a second measured finding.
 *
 * `NATIVE_2048_REFERENCE` is itself a fixed cycle of four directions, and 2048
 * merges tiles under almost any input, so the contract derived from it does not
 * separate: a seeded pseudo-random walk of the same length reaches every
 * milestone, `tile-32` included. The packaged 2048 target demonstrates the
 * execution and evidence paths; it is not a benchmark of skill, and the gate
 * says so instead of leaving a reader to assume otherwise.
 */
const adapter = makeNative2048()
try {
  const report = calibrateContract(adapter.game, adapter.contract, {
    reference: NATIVE_2048_REFERENCE,
    vocabulary: NATIVE_2048_INPUTS,
    seed: adapter.seed,
  })
  assert.equal(report.baselines.length, NATIVE_2048_INPUTS.length + 3)
  assert.equal(report.turns, NATIVE_2048_REFERENCE.length)
  assert.equal(report.reference.verified.length, adapter.contract.milestones.length)
  assert.equal(report.separates, false, `2048 must not separate from a cyclic reference: ${JSON.stringify(report)}`)
  assert.deepEqual(report.separating, [])
  assert.deepEqual(report.trivial, adapter.contract.milestones.map((m) => m.id))
  assert.equal(report.bestBaselineCount, report.reference.verified.length)
  // A constant direction already merges tiles; the unknown word never does.
  assert.ok(report.baselines.find((b) => b.id === 'constant:left')?.verified.includes('tile-8-engine'))
  assert.deepEqual(report.baselines.find((b) => b.id === `constant:${UNKNOWN_BASELINE_WORD}`)?.verified, [])
  assert.throws(() => assertContractSeparates(report), /does not separate/u)
  console.log(
    `playproof calibration: native-2048 reference ${report.reference.verified.length} milestones vs best baseline ` +
    `${report.bestBaselineCount} (${report.baselines.filter((b) => b.verified.length === report.bestBaselineCount).map((b) => b.id).join(', ')}) ` +
    `over ${report.turns} turns — packaged target does not separate`,
  )
} finally {
  adapter.dispose()
}

console.log('playproof calibration: separating and non-separating contracts, policy determinism, edge cases OK')
