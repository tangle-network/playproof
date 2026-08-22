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
 * stated as a hash, which a reader cannot judge. The trace game hashes the
 * whole input sequence, so exactly one trajectory satisfies it. The ledge walk
 * hashes a state many trajectories reach, and only the substitution sweep
 * finds that.
 */
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { deriveContract } from './authoring'
import {
  assertContractSeparates,
  assertOpaqueChecksDeclared,
  calibrateContract,
  trivialBaselines,
  UNKNOWN_BASELINE_WORD,
} from './calibration'
import { hashString, type Game } from './runtime'
import {
  canonicalContractJson,
  contractHash,
  contractLegibility,
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

// --- legible checks vs opaque ones -------------------------------------------
//
// A hash check identifies a STATE, not a trajectory. It is earnable: any policy
// that stands in that state satisfies it, whether or not it ever saw the
// reference. What a hash cannot do is tell a reader what it demands, and that
// is the axis these cases pin.

// (f) an all-legible contract: nothing to declare, and the gate passes exactly
// as it did before opacity existed.
{
  const report = calibrateContract(comboLock, lockContract, {
    reference: LOCK_REFERENCE,
    vocabulary: LOCK_VOCABULARY,
  })
  assert.deepEqual(report.legible, ['moved', 'lock-opened'])
  assert.deepEqual(report.opaque, [])
  assert.deepEqual(report.opacityReasons, {})
  assert.deepEqual(report.opaqueReproduced, [])
  assert.deepEqual(report.collisions, [])
  assert.deepEqual(report.referenceScore, { verified: 2, total: 2 })
  assert.equal(formatMilestoneScore(report.referenceScore), '2 of 2')
  assert.equal(report.bestBaselineLegibleCount, 1)
  assert.equal(report.separates, true)
  assertContractSeparates(report)
  assertOpaqueChecksDeclared(report)
}

// (g) a contract mixing both kinds. `frame-at-open` hashes the whole input
// chain, so exactly one trajectory reaches the state it names — the sweep
// proves that, rather than assuming it from the check kind.
//
// The hash is still a point an independent policy can score, so it stays in
// the denominator: a run that opens the lock without landing on the pinned
// frame scores 2 of 3, not 2 of 2.
const lockOpaqueContract = deriveContract(comboLock, 0, [...LOCK_REFERENCE], [
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
  const report = calibrateContract(comboLock, lockOpaqueContract, {
    reference: LOCK_REFERENCE,
    vocabulary: LOCK_VOCABULARY,
  })
  assert.deepEqual(report.reference.verified, ['moved', 'lock-opened', 'frame-at-open'])
  assert.deepEqual(report.legible, ['moved', 'lock-opened'])
  assert.deepEqual(report.opaque, ['frame-at-open'])
  assert.match(report.opacityReasons['frame-at-open'] ?? '', /frame-hash check states its requirement as a hash/u)
  assert.deepEqual(report.opaqueReproduced, [])

  // The corrected arithmetic. Three milestones, three points, whoever scores
  // them. A run that reached the first two scores 2 of 3.
  assert.deepEqual(report.referenceScore, { verified: 3, total: 3 })
  assert.equal(formatMilestoneScore(report.referenceScore), '3 of 3')
  assert.deepEqual(scoreMilestones(lockOpaqueContract, ['moved', 'lock-opened']), { verified: 2, total: 3 })
  assert.equal(formatMilestoneScore(scoreMilestones(lockOpaqueContract, ['moved', 'lock-opened'])), '2 of 3')

  // The preserved half of the separation fix: an opaque milestone no baseline
  // reached is not evidence that the contract separates, because no reader can
  // see what it asked for. `separating` names the legible milestone only.
  assert.deepEqual(report.separating, ['lock-opened'])
  assert.equal(report.separates, true)

  // Shipping it silently is impossible: the gate refuses until the author
  // writes the id down.
  assert.throws(
    () => assertContractSeparates(report),
    (error: unknown) => {
      const message = (error as Error).message
      assert.match(message, /states 1 of 3 milestone\(s\) as a hash/u)
      assert.match(message, /2 legible, 33% opaque/u)
      assert.match(message, /frame-at-open/u)
      assert.match(message, /opaqueChecks: \['frame-at-open'\]/u)
      assert.doesNotMatch(message, /does not separate/u)
      return true
    },
  )
  assert.throws(() => assertOpaqueChecksDeclared(report), /as a hash/u)

  // Declared, the same contract passes both gates. Nothing needs declaring as
  // weak, because the sweep found no other log that satisfies the hash.
  assertContractSeparates(report, { opaqueChecks: ['frame-at-open'] })
  assertOpaqueChecksDeclared(report, { opaqueChecks: ['frame-at-open'] })

  // A declaration is an exact set. A missing id and a stale id both fail, so a
  // hash milestone added by a later derivation cannot hide behind it.
  assert.throws(() => assertContractSeparates(report, { opaqueChecks: [] }), /1 undeclared opaque milestone\(s\)/u)
  assert.throws(
    () => assertContractSeparates(report, { opaqueChecks: ['frame-at-open', 'lock-opened'] }),
    /the contract does not state as a hash: lock-opened/u,
  )

  // A hash over the whole input chain really is reached one way: 40 perturbed
  // logs, none of them satisfying it.
  assert.deepEqual(report.collisions, [{
    milestone: 'frame-at-open',
    firesAfter: 8,
    probedTurns: 8,
    substitutions: 40,
    collisions: 0,
    freeTurns: 0,
    jointCollision: false,
    family: 1,
  }])
  // Declaring a check weak when the sweep found no collision is stale too.
  assert.throws(
    () => assertOpaqueChecksDeclared(report, { opaqueChecks: ['frame-at-open'], weakChecks: ['frame-at-open'] }),
    /weakChecks names 1 milestone\(s\) the sweep found no colliding log for/u,
  )

  // Attestation reports the same score for one run.
  assert.deepEqual(scoreMilestones(lockOpaqueContract, report.reference.verified), report.referenceScore)
}

// (h) an all-opaque contract. This is the regression #22 found and the reason
// its fix survives: every baseline earns nothing, so before the split both
// milestones landed in `separating` and the report called the contract a
// benchmark. Nothing a reader can check separates it from a coin flip.
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
  assert.deepEqual(report.legible, [])
  assert.deepEqual(report.opaque, ['frame-at-three', 'save-at-five'])
  // Both points are real points; the reference scored both, and so would any
  // policy that reached the two states. The denominator is not the problem.
  assert.deepEqual(report.referenceScore, { verified: 2, total: 2 })
  assert.equal(formatMilestoneScore(report.referenceScore), '2 of 2')

  // No baseline earned anything, and the contract still does not separate.
  // That combination is the whole point: a claim no reader can check is not
  // evidence, however few policies satisfy it.
  assert.deepEqual(report.trivial, [])
  assert.ok(report.baselines.every((b) => b.verified.length === 0))
  assert.deepEqual(report.separating, [])
  assert.equal(report.bestBaselineLegibleCount, 0)
  assert.equal(report.separates, false)
  assert.throws(
    () => assertContractSeparates(report),
    (error: unknown) => {
      const message = (error as Error).message
      assert.match(message, /states 2 of 2 milestone\(s\) as a hash/u)
      assert.match(message, /0 legible, 100% opaque/u)
      assert.match(message, /on legible milestones alone: reference 0, best baseline 0, of 0 legible/u)
      assert.match(message, /does not separate/u)
      return true
    },
  )
  // Declaring both is honest about the checks and still not a benchmark.
  assert.throws(
    () => assertContractSeparates(report, { opaqueChecks: ['frame-at-three', 'save-at-five'] }),
    (error: unknown) => {
      const message = (error as Error).message
      assert.match(message, /does not separate/u)
      assert.doesNotMatch(message, /as a hash/u)
      return true
    },
  )
  assertOpaqueChecksDeclared(report, { opaqueChecks: ['frame-at-three', 'save-at-five'] })

  // A hash over the whole input chain admits one trajectory, measured.
  assert.deepEqual(report.collisions.map((row) => [row.milestone, row.substitutions, row.collisions, row.family]), [
    ['frame-at-three', 6, 0, 1],
    ['save-at-five', 10, 0, 1],
  ])

  // Opacity propagates through `requires`: the tracker admits a milestone only
  // after its prerequisites passed, so a legible check gated behind a hash
  // still demands something a reader cannot see.
  const gated = contractLegibility({
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
  assert.deepEqual(gated.legible, [])
  assert.equal(gated.reasons['steps-after-save'], 'requires save-at-five, whose requirement is opaque')
}

// (i) the same split on the two packaged toy adapters, measured rather than
// assumed. Both are demonstration targets for the evidence tiers, and neither
// states a single milestone a reader can check.
{
  const levels = contractLegibility(saveLevelsContract())
  assert.deepEqual(levels.legible, [])
  assert.deepEqual(levels.opaque, ['level-2-saved', 'level-2-logged'])
  // The log-event check reads in the open; it is opaque only through its
  // prerequisite, which is the dependency rule doing real work.
  assert.equal(levels.reasons['level-2-logged'], 'requires level-2-saved, whose requirement is opaque')
  const report = calibrateContract(saveLevels, saveLevelsContract(), {
    reference: SAVE_LEVELS_REFERENCE,
    vocabulary: ['clear', 'grind'],
  })
  assert.equal(report.separates, false)
  assert.deepEqual(report.referenceScore, { verified: 2, total: 2 })

  // screen-puzzle renders from one coordinate, so `constant:r` walks to the
  // same square and reproduces both pinned frames. A hash one constant button
  // press satisfies demands nothing, and the gate says so even when the author
  // declares it.
  //
  // The two probers are complementary, and this is the case that proves it:
  // the substitution sweep finds nothing here, because every substitution
  // shortens the walk, while a baseline that walks further reaches both.
  const puzzle = calibrateContract(screenPuzzle, screenPuzzleContract(), {
    reference: SCREEN_PUZZLE_REFERENCE,
    vocabulary: ['l', 'r'],
  })
  assert.deepEqual(puzzle.legible, [])
  assert.deepEqual(puzzle.opaqueReproduced, ['midway-frame', 'east-gate-frame'])
  assert.deepEqual(puzzle.collisions.map((row) => row.collisions), [0, 0])
  assert.throws(
    () => assertOpaqueChecksDeclared(puzzle, { opaqueChecks: ['midway-frame', 'east-gate-frame'] }),
    (error: unknown) => {
      const message = (error as Error).message
      assert.match(message, /2 opaque milestone\(s\) were reproduced by a trivial baseline/u)
      assert.match(message, /midway-frame — reproduced by constant:r/u)
      return true
    },
  )
}

// --- the collision sweep, and what only it can find --------------------------
//
// #22 tested an opaque check against trivial baselines alone, and concluded
// from a clean result that the check identified one run. It does not follow.
// The ledge walk is the Breakout shape in miniature: pressing into a wall is a
// state no-op, so two logs that differ at those turns reach the same state and
// the same hash. No trivial baseline finds that; a one-input substitution of
// the reference finds it immediately.

const LEDGE_VOCABULARY = ['l', 'r']
const LEDGE_REFERENCE = ['l', 'l', 'r', 'r', 'r', 'r', 'r', 'l', 'l']
const LEDGE_END = 5

interface LedgeState {
  x: number
  lit: boolean
  steps: number
}

const ledgeWalk: Game<LedgeState> = {
  id: 'ledge-walk',
  init: () => ({ x: 0, lit: false, steps: 0 }),
  step: (s, input) => {
    // Walking into either wall is a no-op, which is the whole mechanism.
    const x = input === 'r' ? Math.min(s.x + 1, LEDGE_END) : input === 'l' ? Math.max(s.x - 1, 0) : s.x
    return { x, lit: s.lit || x === LEDGE_END, steps: s.steps + 1 }
  },
  frame: (s) => `x ${s.x}${s.lit ? ' · torch lit' : ''}`,
  evidence: (s) => ({
    engineState: { x: s.x, lit: s.lit ? 1 : 0, steps: s.steps },
    frameHash: hashString(`ledge:${s.x}:${s.lit ? 1 : 0}`),
  }),
}

const ledgeContract = deriveContract(ledgeWalk, 0, [...LEDGE_REFERENCE], [
  {
    afterInputs: 9,
    id: 'frame-back-from-the-ledge',
    tier: 'screen-frame',
    glitchClass: 'legal',
    sample: (e) => ({ kind: 'frame-hash', hash: e.frameHash ?? '' }),
  },
])

{
  const report = calibrateContract(ledgeWalk, ledgeContract, {
    reference: LEDGE_REFERENCE,
    vocabulary: LEDGE_VOCABULARY,
  })
  assert.deepEqual(report.opaque, ['frame-back-from-the-ledge'])
  // The old prober says the hash is clean: no constant, no cycle and no walk
  // over this vocabulary lands on the pinned frame.
  assert.deepEqual(report.opaqueReproduced, [])

  // The new one says otherwise, with the number. The two turns that press
  // into the left wall at x = 0 are free: the state is the same either way.
  assert.deepEqual(report.collisions, [{
    milestone: 'frame-back-from-the-ledge',
    firesAfter: 9,
    probedTurns: 9,
    substitutions: 9,
    collisions: 2,
    freeTurns: 2,
    jointCollision: true,
    family: 4,
  }])

  // Declaring the check opaque is no longer enough: the gate refuses until the
  // author has read the measured weakness and accepted it by id.
  assert.throws(
    () => assertOpaqueChecksDeclared(report, { opaqueChecks: ['frame-back-from-the-ledge'] }),
    (error: unknown) => {
      const message = (error as Error).message
      assert.match(message, /1 opaque milestone\(s\) are satisfied by input logs other than the reference/u)
      assert.match(message, /2 of 9 single-input substitutions/u)
      assert.match(message, /at 2 of 9 probed turn\(s\) before it fires \(after 9 input\(s\)\)/u)
      assert.match(message, /also satisfies it, so at least 4 distinct 9-input log\(s\) satisfy it/u)
      assert.match(message, /weakChecks: \['frame-back-from-the-ledge'\]/u)
      return true
    },
  )
  assertOpaqueChecksDeclared(report, {
    opaqueChecks: ['frame-back-from-the-ledge'],
    weakChecks: ['frame-back-from-the-ledge'],
  })
}

// (j) the split is derived, so every existing contract keeps its bytes. These
// hashes were recorded before legibility existed; a contract whose hash moves
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

console.log('playproof calibration: separating and non-separating contracts, legible/opaque split, opaque-collision sweep, policy determinism, edge cases OK')
