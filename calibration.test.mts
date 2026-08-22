/**
 * Contract calibration test — the gate that rejects a contract a trivial
 * baseline satisfies.
 *
 * Two hand-written games make the two outcomes exact. The combination lock can
 * only be opened by one long word sequence, so it must separate. The mash game
 * pins a channel that moves whenever one button is pressed — the Libbet shape —
 * so it must not. The native-2048 adapter then runs the same gate on a real
 * out-of-process game.
 *
 * The second half covers the other way a contract fails to measure: a milestone
 * NO policy can earn, because a hash check pins the reference run's exact
 * bytes. The trace game makes that case unambiguous, because its hash covers
 * the whole input sequence.
 */
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { deriveContract } from './authoring'
import {
  assertContractSeparates,
  assertMilestonesEarnable,
  calibrateContract,
  trivialBaselines,
  UNKNOWN_BASELINE_WORD,
} from './calibration'
import type { Game } from './runtime'
import {
  canonicalContractJson,
  contractEarnability,
  contractHash,
  earnedMilestones,
  formatMilestoneScore,
  scoreMilestones,
} from './schema'
import { makeNative2048, NATIVE_2048_INPUTS, NATIVE_2048_REFERENCE } from './adapters/native-2048'
import { engineCrawlerContract } from './adapters/engine-crawler'
import { saveLevels, saveLevelsContract, SAVE_LEVELS_REFERENCE } from './adapters/save-levels'
import { screenPuzzle, screenPuzzleContract, SCREEN_PUZZLE_REFERENCE } from './adapters/screen-puzzle'

// --- a game that needs an exact sequence ------------------------------------

const LOCK_VOCABULARY = ['a', 'b', 'c', 'd', 'e', 'f']
const LOCK_CODE = ['c', 'a', 'f', 'b', 'e', 'd']
const LOCK_REFERENCE = ['b', 'a', ...LOCK_CODE]

const chain = (previous: string, input: string): string =>
  createHash('sha256').update(`${previous}:${input}`).digest('hex')

interface LockState {
  progress: number
  opened: number
  steps: number
  /** Hash chain over the inputs, so a frame hash pins one trajectory. */
  trace: string
}

const comboLock: Game<LockState> = {
  id: 'combo-lock',
  init: () => ({ progress: 0, opened: 0, steps: 0, trace: chain('boot', '') }),
  step: (s, input) => {
    const steps = s.steps + 1
    const trace = chain(s.trace, input)
    if (s.opened === 1) return { ...s, steps, trace }
    const advances = input === LOCK_CODE[s.progress]
    const restarts = !advances && input === LOCK_CODE[0]
    const progress = advances ? s.progress + 1 : restarts ? 1 : 0
    return { progress, opened: progress === LOCK_CODE.length ? 1 : 0, steps, trace }
  },
  frame: (s) => `steps ${s.steps} · the lock is ${s.opened === 1 ? 'open' : 'shut'}`,
  evidence: (s) => ({
    engineState: { progress: s.progress, opened: s.opened, steps: s.steps },
    frameHash: s.trace,
  }),
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

// --- earnable milestones vs replay-identity checks ---------------------------

// (f) an all-achievement contract is unchanged: every milestone is earnable,
// nothing is declared, and the gate passes exactly as it did before.
{
  const report = calibrateContract(comboLock, lockContract, {
    reference: LOCK_REFERENCE,
    vocabulary: LOCK_VOCABULARY,
  })
  assert.deepEqual(report.earnable, ['moved', 'lock-opened'])
  assert.deepEqual(report.unearnable, [])
  assert.deepEqual(report.unearnableReasons, {})
  assert.deepEqual(report.unearnableReproduced, [])
  assert.deepEqual(report.referenceScore, { verified: 2, earned: 2, earnable: 2, total: 2 })
  assert.equal(formatMilestoneScore(report.referenceScore), '2 of 2 earnable')
  assert.equal(report.bestBaselineEarnedCount, 1)
  assert.equal(report.separates, true)
  assertContractSeparates(report)
  assertMilestonesEarnable(report)
}

// (g) a contract mixing both kinds reports the right earnable count, and the
// identity check must be declared before the contract ships.
//
// `frame-at-open` is a hash over the whole input chain, so only a replay of the
// reference reproduces it. It is a correct attestation check and it stays in
// the contract; it is not a third point an agent can score.
const lockIdentityContract = deriveContract(comboLock, 0, [...LOCK_REFERENCE], [
  {
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
  {
    id: 'frame-at-open',
    tier: 'screen-frame',
    glitchClass: 'legal',
    requires: ['lock-opened'],
    when: (e) => (e.engineState?.opened ?? 0) >= 1,
    sample: (e) => ({ kind: 'frame-hash', hash: e.frameHash ?? '' }),
  },
])

{
  const report = calibrateContract(comboLock, lockIdentityContract, {
    reference: LOCK_REFERENCE,
    vocabulary: LOCK_VOCABULARY,
  })
  assert.deepEqual(report.reference.verified, ['moved', 'lock-opened', 'frame-at-open'])
  assert.deepEqual(report.earnable, ['moved', 'lock-opened'])
  assert.deepEqual(report.unearnable, ['frame-at-open'])
  assert.match(report.unearnableReasons['frame-at-open'] ?? '', /frame-hash check pins the reference run's exact bytes/u)
  assert.deepEqual(report.unearnableReproduced, [])
  // The reference scored three of three, and only two of them were earnable.
  assert.deepEqual(report.referenceScore, { verified: 3, earned: 2, earnable: 2, total: 3 })
  assert.equal(formatMilestoneScore(report.referenceScore), '2 of 2 earnable (3 of 3 verified, 1 replay-identity)')
  // The identity check is out of reach of every baseline, and that is not
  // separation: `separating` names the earnable milestone only.
  assert.deepEqual(report.separating, ['lock-opened'])
  assert.equal(report.separates, true)

  // Shipping it silently is impossible: the gate refuses until the author
  // writes the id down.
  assert.throws(
    () => assertContractSeparates(report),
    (error: unknown) => {
      const message = (error as Error).message
      assert.match(message, /1 of 3 milestone\(s\) no policy can earn/u)
      assert.match(message, /2 earnable, 33% unearnable/u)
      assert.match(message, /frame-at-open/u)
      assert.match(message, /identityChecks: \['frame-at-open'\]/u)
      assert.doesNotMatch(message, /does not separate/u)
      return true
    },
  )
  assert.throws(() => assertMilestonesEarnable(report), /no policy can earn/u)

  // Declared, the same contract passes both gates.
  assertContractSeparates(report, { identityChecks: ['frame-at-open'] })
  assertMilestonesEarnable(report, { identityChecks: ['frame-at-open'] })

  // A declaration is an exact set. A missing id and a stale id both fail, so a
  // hash milestone added by a later derivation cannot hide behind it.
  assert.throws(() => assertContractSeparates(report, { identityChecks: [] }), /1 undeclared milestone\(s\)/u)
  assert.throws(
    () => assertContractSeparates(report, { identityChecks: ['frame-at-open', 'lock-opened'] }),
    /the contract does not pin: lock-opened/u,
  )

  // Attestation reports the same split for one run.
  const score = scoreMilestones(lockIdentityContract, report.reference.verified)
  assert.deepEqual(score, report.referenceScore)
  assert.deepEqual(earnedMilestones(lockIdentityContract, report.reference.verified), ['moved', 'lock-opened'])
}

// (h) an all-identity contract reports 0 earnable, and calibration refuses it.
//
// This is the regression. Every baseline earns nothing, so before earnability
// existed both milestones landed in `separating` and the report called the
// contract a benchmark — one on which no policy but a replay of the reference
// can ever score a point.
const TRACE_VOCABULARY = ['a', 'b', 'c']
const TRACE_REFERENCE = ['a', 'b', 'b', 'c', 'a']

interface TraceState {
  steps: number
  trace: string
}

const traceGame: Game<TraceState> = {
  id: 'trace-hash',
  init: () => ({ steps: 0, trace: chain('boot', '') }),
  step: (s, input) => ({ steps: s.steps + 1, trace: chain(s.trace, input) }),
  frame: (s) => `steps ${s.steps}`,
  evidence: (s) => ({
    engineState: { steps: s.steps },
    frameHash: s.trace,
    saveBlobHash: chain(s.trace, 'save'),
  }),
}

const traceContract = deriveContract(traceGame, 0, [...TRACE_REFERENCE], [
  {
    afterInputs: 3,
    id: 'frame-at-three',
    tier: 'screen-frame',
    glitchClass: 'legal',
    sample: (e) => ({ kind: 'frame-hash', hash: e.frameHash ?? '' }),
  },
  {
    afterInputs: 5,
    id: 'save-at-five',
    tier: 'save-file',
    glitchClass: 'legal',
    requires: ['frame-at-three'],
    sample: (e) => ({ kind: 'save-hash', hash: e.saveBlobHash ?? '' }),
  },
])

{
  const report = calibrateContract(traceGame, traceContract, {
    reference: TRACE_REFERENCE,
    vocabulary: TRACE_VOCABULARY,
  })
  assert.deepEqual(report.reference.verified, ['frame-at-three', 'save-at-five'])
  assert.deepEqual(report.earnable, [])
  assert.deepEqual(report.unearnable, ['frame-at-three', 'save-at-five'])
  assert.deepEqual(report.referenceScore, { verified: 2, earned: 0, earnable: 0, total: 2 })
  assert.equal(formatMilestoneScore(report.referenceScore), '0 of 0 earnable (2 of 2 verified, 2 replay-identity)')

  // No baseline earned anything at all, and the contract still does not
  // separate. That combination is the whole point: unreachable is not hard.
  assert.deepEqual(report.trivial, [])
  assert.ok(report.baselines.every((b) => b.verified.length === 0))
  assert.deepEqual(report.separating, [])
  assert.equal(report.bestBaselineEarnedCount, 0)
  assert.equal(report.separates, false)
  assert.throws(
    () => assertContractSeparates(report),
    (error: unknown) => {
      const message = (error as Error).message
      assert.match(message, /2 of 2 milestone\(s\) no policy can earn/u)
      assert.match(message, /0 earnable, 100% unearnable/u)
      assert.match(message, /the reference itself scored 0 of 0 earnable \(2 of 2 verified, 2 replay-identity\)/u)
      assert.match(message, /does not separate/u)
      return true
    },
  )
  // Declaring both is honest about the checks and still not a benchmark.
  assert.throws(
    () => assertContractSeparates(report, { identityChecks: ['frame-at-three', 'save-at-five'] }),
    (error: unknown) => {
      const message = (error as Error).message
      assert.match(message, /does not separate/u)
      assert.doesNotMatch(message, /no policy can earn/u)
      return true
    },
  )
  assertMilestonesEarnable(report, { identityChecks: ['frame-at-three', 'save-at-five'] })

  // A milestone gated behind an identity check is unearnable too, whatever its
  // own check kind: the tracker admits it only after its prerequisite passed.
  const gated = contractEarnability({
    ...traceContract,
    milestones: [
      ...traceContract.milestones,
      {
        id: 'steps-after-save',
        tier: 'engine-state',
        requires: ['save-at-five'],
        glitchClass: 'legal',
        check: { kind: 'state-path', path: 'steps', op: '>=', value: 5 },
      },
    ],
  })
  assert.deepEqual(gated.earnable, [])
  assert.equal(gated.reasons['steps-after-save'], 'requires save-at-five, which no independent policy can earn')
}

// (i) the same split on the two packaged toy adapters, measured rather than
// assumed. Both are demonstration targets for the evidence tiers, and both
// turn out to carry no earnable milestone at all.
{
  const levels = contractEarnability(saveLevelsContract())
  assert.deepEqual(levels.earnable, [])
  assert.deepEqual(levels.unearnable, ['level-2-saved', 'level-2-logged'])
  // The log-event check is semantic; it is unearnable only through its
  // prerequisite, which is the dependency rule doing real work.
  assert.equal(levels.reasons['level-2-logged'], 'requires level-2-saved, which no independent policy can earn')
  const report = calibrateContract(saveLevels, saveLevelsContract(), {
    reference: SAVE_LEVELS_REFERENCE,
    vocabulary: ['clear', 'grind'],
  })
  assert.equal(report.separates, false)
  assert.deepEqual(report.referenceScore, { verified: 2, earned: 0, earnable: 0, total: 2 })

  // screen-puzzle renders from one coordinate, so `constant:r` walks to the
  // same square and reproduces both pinned frames. A hash another trajectory
  // reproduces identifies no run, and the gate says so even when the author
  // declares it.
  const puzzle = calibrateContract(screenPuzzle, screenPuzzleContract(), {
    reference: SCREEN_PUZZLE_REFERENCE,
    vocabulary: ['l', 'r'],
  })
  assert.deepEqual(puzzle.earnable, [])
  assert.deepEqual(puzzle.unearnableReproduced, ['midway-frame', 'east-gate-frame'])
  assert.throws(
    () => assertMilestonesEarnable(puzzle, { identityChecks: ['midway-frame', 'east-gate-frame'] }),
    (error: unknown) => {
      const message = (error as Error).message
      assert.match(message, /2 replay-identity milestone\(s\) were reproduced by a trivial baseline/u)
      assert.match(message, /midway-frame — reproduced by constant:r/u)
      return true
    },
  )
}

// (j) the split is derived, so every existing contract keeps its bytes. These
// hashes were recorded before earnability existed; a contract whose hash moves
// invalidates every artifact that pinned it.
{
  assert.equal(contractHash(engineCrawlerContract()), '29a9ff9f3bb296a898493589d6bcdb539b5be15f7f53931de7f3725916274426')
  assert.equal(contractHash(saveLevelsContract()), '6c330131dd004db07d4ee3948af75bdf4d128569c734df6d2d95e6c2f7684498')
  assert.equal(contractHash(screenPuzzleContract()), 'e9b818f754bd5de89277df0797bf212dad3be079453cf47065ee2be8e89da37f')
  for (const contract of [engineCrawlerContract(), saveLevelsContract(), screenPuzzleContract()]) {
    const canonical = JSON.parse(canonicalContractJson(contract)) as { milestones: Record<string, unknown>[] }
    for (const milestone of canonical.milestones) {
      assert.deepEqual(Object.keys(milestone), ['id', 'tier', 'requires', 'check', 'glitchClass'],
        'a milestone gained a serialized field; every published contract hash would move')
    }
  }
}

console.log('playproof calibration: separating and non-separating contracts, earnable/identity split, policy determinism, edge cases OK')
