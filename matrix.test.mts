/**
 * The matrix: what the definition refuses, what a cell's identity commits to,
 * and what the cross-game statistic says about its own limits.
 *
 * Offline and free. The games below are in-memory state machines, so this runs
 * on a machine with no emulator — which is exactly where a gate about study
 * design most needs to run.
 *
 * Each refusal is watched going RED (the bad definition is refused, for its own
 * stated reason) and GREEN (the corrected definition parses). A refusal that
 * was only ever run against a definition it accepts has been used, not tested.
 */
import { strict as assert } from 'node:assert'
import {
  cellId,
  cellName,
  enumerateCells,
  parseMatrix,
  type MatrixCell,
  type MatrixDefinition,
} from './matrix'
import {
  assertJoinable,
  effectiveArms,
  generalization,
  kendallTauB,
  runCell,
  runMatrix,
  type BuiltGame,
  type CellResult,
  type GameBuilder,
} from './matrix-run'
import { scriptedDriver } from './episode'
import type { Evidence, Game } from './runtime'
import type { MilestoneContract } from './schema'

const DEFINITION = `
# two arms, two games, one protocol
profile.opus   harness=claude-code model=claude-opus-5 effort=high
profile.chaser harness=none policy=./policies/chaser note=hand-written
game.breakout  adapter=ale target=breakout
game.pacman    adapter=ale target=ms_pacman
objective.score goal=maximize:score horizon=3000 budgetUsd=8
protocol.det   frameskip=4 sticky=0 seeds=1
sensor.ascii   pixels=off channels=-
reps 2
`

// ---- Part 1: the definition parses into the cells it denotes ---------------

{
  const definition = parseMatrix(DEFINITION)
  assert.equal(definition.profiles.length, 2)
  assert.equal(definition.games.length, 2)
  assert.equal(definition.reps, 2)
  assert.equal(definition.profiles[0]!.kind, 'harness')
  assert.equal(definition.profiles[0]!.model, 'claude-opus-5')
  assert.equal(definition.profiles[1]!.kind, 'policy')
  assert.equal(definition.profiles[1]!.command, './policies/chaser')

  const cells = enumerateCells(definition)
  assert.equal(definition.sensors.length, 1)
  assert.equal(definition.profiles[0]!.transport, 'persistent', 'the default transport lets a policy keep state')
  // 2 profiles x 2 games x 1 objective x 1 protocol x 1 sensor x 1 seed x 2 reps
  assert.equal(cells.length, 8)
  assert.equal(new Set(cells.map(cellId)).size, 8, 'every cell must have a distinct identity')
}

// ---- Part 2: every refusal, watched red then green -------------------------

const refusals: { label: string; text: string; expect: RegExp }[] = [
  {
    label: 'a matrix with no protocol',
    text: DEFINITION.split('\n').filter((l) => !l.startsWith('protocol.')).join('\n'),
    expect: /needs .*a protocol, which states the clock and the sticky probability/u,
  },
  {
    label: 'several seeds at sticky 0',
    text: DEFINITION.replace('sticky=0 seeds=1', 'sticky=0 seeds=5'),
    expect: /seeds=5 at sticky=0 reports one trajectory 5 times/u,
  },
  {
    label: 'a misspelled axis key',
    text: DEFINITION.replace('frameskip=4', 'framskip=4'),
    expect: /unknown key "framskip"/u,
  },
  {
    label: 'a profile that is both an agent and a control',
    text: DEFINITION.replace('harness=none policy=./policies/chaser', 'harness=claude-code policy=./policies/chaser'),
    expect: /names both harness=.* and policy=/u,
  },
  {
    label: 'a control with no program',
    text: DEFINITION.replace('harness=none policy=./policies/chaser note=hand-written', 'harness=none note=hand-written'),
    expect: /a control profile needs policy=/u,
  },
  {
    label: 'a goal that states no direction',
    text: DEFINITION.replace('goal=maximize:score', 'goal=score'),
    expect: /goal must read maximize:<field> or minimize:<field>/u,
  },
  {
    label: 'two profiles with one name',
    text: `${DEFINITION}\nprofile.opus harness=codex model=gpt-5\n`,
    expect: /profile\.opus is declared twice/u,
  },
  {
    label: 'a protocol whose sticky is not a probability',
    text: DEFINITION.replace('sticky=0 ', 'sticky=1.5 '),
    expect: /sticky must be in 0\.\.1/u,
  },
  {
    label: 'an unknown adapter',
    text: DEFINITION.replace('adapter=ale target=breakout', 'adapter=snes target=breakout'),
    expect: /unknown adapter "snes"/u,
  },
  {
    label: 'a matrix that never says what the agent could see',
    text: DEFINITION.split('\n').filter((l) => !l.startsWith('sensor.')).join('\n'),
    expect: /needs .*a sensor, which states what the agent may see/u,
  },
  {
    label: 'pixels from an adapter that renders none',
    text: DEFINITION
      .replace('game.pacman    adapter=ale target=ms_pacman', 'game.cartpole adapter=gymnasium target=CartPole-v1')
      .replace('sensor.ascii   pixels=off channels=-', 'sensor.eyes pixels=on scale=3 channels=-'),
    expect: /publishes no rendered screen[\s\S]*Refused rather than downgraded/u,
  },
  {
    label: 'RAM channels from an adapter that publishes none',
    text: DEFINITION
      .replace('game.pacman    adapter=ale target=ms_pacman', 'game.air adapter=stable-retro target=Airstriker-Genesis')
      .replace('sensor.ascii   pixels=off channels=-', 'sensor.ram pixels=off channels=ball_x@99'),
    expect: /publishes no named RAM bytes/u,
  },
  {
    label: 'a scale with no screen to scale',
    text: DEFINITION.replace('sensor.ascii   pixels=off channels=-', 'sensor.ascii pixels=off scale=3'),
    expect: /scale needs pixels=on/u,
  },
  {
    label: 'a channel with no RAM index',
    text: DEFINITION.replace('channels=-', 'channels=ball_x'),
    expect: /must read <id>@<ramIndex>/u,
  },
  {
    label: 'a channel outside the RAM',
    text: DEFINITION.replace('channels=-', 'channels=ball_x@999'),
    expect: /must be an integer 0\.\.127/u,
  },
  {
    label: 'an unknown transport',
    text: DEFINITION.replace('effort=high', 'effort=high transport=carrier-pigeon'),
    expect: /transport must be persistent, per-decision or stream/u,
  },
  {
    label: 'a streaming profile whose protocol never says what acts while it thinks',
    text: DEFINITION.replace('effort=high', 'effort=high transport=stream'),
    expect: /must state queue=<depth> and empty=noop\|repeat-last, because/u,
  },
  {
    label: 'a streaming profile whose protocol states a queue but no default',
    text: DEFINITION
      .replace('effort=high', 'effort=high transport=stream')
      .replace('seeds=1', 'seeds=1 queue=8'),
    expect: /must state empty=noop\|repeat-last/u,
  },
  {
    label: 'an empty-queue default that is neither',
    text: DEFINITION.replace('seeds=1', 'seeds=1 empty=freeze'),
    expect: /empty must be noop or repeat-last/u,
  },
]

for (const refusal of refusals) {
  assert.throws(
    () => parseMatrix(refusal.text),
    refusal.expect,
    `"${refusal.label}" was not refused, or was refused for the wrong reason`,
  )
}
// GREEN: the same parser accepts the definition these are corruptions of.
assert.doesNotThrow(() => parseMatrix(DEFINITION), 'the parser must accept the definition the red cases corrupt')

// GREEN for the streaming refusal: once the protocol says what acts while the
// agent thinks, the same definition parses.
assert.doesNotThrow(
  () => parseMatrix(
    DEFINITION
      .replace('effort=high', 'effort=high transport=stream')
      .replace('seeds=1', 'seeds=1 queue=8 empty=repeat-last'),
  ),
  'a streaming profile must be accepted once its protocol declares the queue and the default',
)

// The queue and the default are part of what a cell measures, so they are part
// of its identity: two runs that differ only in what acted while the agent
// thought are not the same cell.
{
  const streamed = (empty: string): string => DEFINITION
    .replace('effort=high', 'effort=high transport=stream')
    .replace('seeds=1', `seeds=1 queue=8 empty=${empty}`)
  assert.notEqual(
    cellId(enumerateCells(parseMatrix(streamed('noop')))[0]!),
    cellId(enumerateCells(parseMatrix(streamed('repeat-last')))[0]!),
    'noop and repeat-last are different games and must be different cells',
  )
}

// The seeds-at-sticky-0 refusal is satisfied by raising sticky, not only by
// dropping seeds — otherwise it would read as a ban on sweeping seeds at all.
assert.doesNotThrow(
  () => parseMatrix(DEFINITION.replace('sticky=0 seeds=1', 'sticky=0.25 seeds=5')),
  'five seeds must be allowed once sticky makes the seed reach the trajectory',
)

// ---- Part 3: identity commits to the protocol's contents, not its name -----

{
  const base = parseMatrix(DEFINITION)
  const edited = parseMatrix(DEFINITION.replace('frameskip=4', 'frameskip=8'))
  const before = enumerateCells(base)[0]!
  const after = enumerateCells(edited)[0]!
  assert.equal(cellName(before), cellName(after), 'the readable name is unchanged, which is why it is not the identity')
  assert.notEqual(
    cellId(before),
    cellId(after),
    'editing frameskip under the same protocol name must change every cell id under it,'
    + ' or an edited protocol silently reuses the results of the protocol it replaced',
  )

  const remodelled = parseMatrix(DEFINITION.replace('model=claude-opus-5', 'model=claude-haiku-4-5'))
  assert.notEqual(
    cellId(before),
    cellId(enumerateCells(remodelled)[0]!),
    'a profile that changes its model is a different arm under the same name',
  )

  // The sensor is a 43x variable on one measured game, so it is identity too.
  const resensed = parseMatrix(DEFINITION.replace('pixels=off channels=-', 'pixels=on scale=3'))
  assert.equal(cellName(before), cellName(enumerateCells(resensed)[0]!), 'the sensor name is unchanged')
  assert.notEqual(
    cellId(before),
    cellId(enumerateCells(resensed)[0]!),
    'turning the screen on under the same sensor name must change every cell id under it',
  )

  const retransported = parseMatrix(DEFINITION.replace('effort=high', 'effort=high transport=per-decision'))
  assert.notEqual(
    cellId(before),
    cellId(enumerateCells(retransported)[0]!),
    'a profile that changes transport measures a different thing and must be a different cell',
  )
}

// ---- Part 4: running cells against in-memory games -------------------------

/** A game whose score is the count of `up` inputs and that counts no lives. */
function counter(id: string, opts: { lives?: number } = {}): Game<{ n: number; lives: number }> {
  return {
    id,
    init: () => ({ n: 0, lives: opts.lives ?? 0 }),
    step: (s, input) => (input === 'up'
      ? { n: s.n + 1, lives: s.lives }
      : input === 'hurt' && s.lives > 0
        ? { n: s.n, lives: s.lives - 1 }
        : s),
    frame: (s) => `n=${s.n}`,
    evidence: (s): Evidence => ({
      engineState: { score: s.n, frameNumber: s.n, ...(opts.lives === undefined ? {} : { lives: s.lives }) },
    }),
  }
}

function contractFor(id: string): MilestoneContract {
  return {
    schemaVersion: 1,
    gameId: id,
    milestones: [
      { id: 'moved', tier: 'engine-state', requires: [], glitchClass: 'legal', check: { kind: 'state-path', path: 'score', op: '>=', value: 1 } },
    ],
  }
}

const SCRIPTS: Record<string, string[]> = {
  strong: ['up', 'up', 'up', 'up'],
  weak: ['up', 'noop', 'noop', 'noop'],
}

const builder = (lives?: number): GameBuilder => async (game): Promise<BuiltGame> => {
  if (game.target === 'unbuildable') {
    throw new Error('mark score-tier-2 never fires on the reference playthrough')
  }
  const g = counter(`test-${game.id}`, ...(lives === undefined ? [] : [{ lives }]))
  return { game: g as Game<unknown>, contract: contractFor(`test-${game.id}`), commands: ['up', 'noop', 'hurt'], dispose: () => {} }
}

function definitionOf(text: string): MatrixDefinition {
  return parseMatrix(text)
}

const TWO_GAME = `
profile.strong harness=none policy=./strong
profile.weak   harness=none policy=./weak
game.a adapter=ale target=a
game.b adapter=ale target=b
objective.score goal=maximize:score horizon=4 budgetUsd=1
protocol.det frameskip=4 sticky=0 seeds=1
sensor.ascii pixels=off channels=-
reps 1
`

const scripted = (cellProfile: { id: string }): ReturnType<typeof scriptedDriver> =>
  scriptedDriver(SCRIPTS[cellProfile.id] ?? ['noop'])

{
  const rows = await runMatrix(definitionOf(TWO_GAME), { build: builder(), driver: scripted })
  assert.equal(rows.length, 4)
  for (const row of rows) assert.equal(row.status, 'played', `${row.name} should have played`)

  const strongA = rows.find((r) => r.profile === 'strong' && r.game === 'a')!
  assert.equal(strongA.score, 4, 'the vector must carry the engine score')
  assert.equal(strongA.decisions, 4)
  assert.equal(strongA.usd, 0, 'a scripted control spends nothing')
  assert.equal(strongA.verdict, 'clean')
  assert.deepEqual([...strongA.verified], ['moved'])
  assert.equal(strongA.replayDivergence, false)
  assert.ok(strongA.actionsHash !== null, 'a cell that played must identify the actions it emitted')

  // Absence is not zero. This game publishes no life counter, so `deaths` is
  // null; a 0 would claim the run died zero times, which nobody measured.
  assert.equal(strongA.deaths, null, 'a game with no life counter must report deaths null, never 0')
  // Playproof prices a decision in dollars through the driver and never sees a
  // token count, so tokens is null for the same reason.
  assert.equal(strongA.tokens, null, 'tokens are not measured here and must not be reported as 0')
}

// A game that DOES count lives reports a number, so the null above is a real
// tristate and not a field that is always absent.
{
  const oneGame = TWO_GAME.replace(/^game\.b.*$/mu, '').replace('horizon=4', 'horizon=3')
  const rows = await runMatrix(definitionOf(oneGame), {
    build: builder(3),
    driver: () => scriptedDriver(['hurt', 'hurt', 'up']),
  })
  assert.equal(rows[0]!.deaths, 2, 'a game that counts lives must report the lives it lost')
}

// ---- Part 5: a blocked cell has no standing --------------------------------

{
  const withBad = TWO_GAME.replace('game.b adapter=ale target=b', 'game.b adapter=ale target=unbuildable')
  const rows = await runMatrix(definitionOf(withBad), { build: builder(), driver: scripted })
  const blocked = rows.filter((r) => r.status === 'blocked')
  assert.equal(blocked.length, 2, 'both cells on the unbuildable game must be blocked')
  for (const row of blocked) {
    assert.equal(row.blocked?.reason, 'game-unbuildable')
    assert.match(row.blocked!.detail, /never fires on the reference playthrough/u)
    assert.equal(row.score, null, 'a blocked cell scores null; a 0 would say the profile played and failed')
  }

  const transfer = generalization(rows)
  assert.equal(transfer.tau, null, 'one game produced a ranking, so no transfer statistic exists')
  assert.match(transfer.note!, /needs at least 2 games/u)
  assert.equal(transfer.excluded.length, 2, 'both blocked cells must be excluded by name')
}

// ---- Part 6: the cross-game statistic reports its own limits ---------------

{
  const rows = await runMatrix(definitionOf(TWO_GAME), { build: builder(), driver: scripted })
  const transfer = generalization(rows)
  assert.equal(transfer.folds, 2, 'two games contributed a ranking')
  assert.equal(transfer.pairs, 1)
  assert.equal(transfer.tau, 1, 'the same order in both games is perfect agreement')
  assert.match(
    transfer.note!,
    /one game pair/u,
    'a tau from a single game pair must say so beside the number, or it reads as evidence of transfer',
  )
  assert.deepEqual(transfer.profiles, ['strong', 'weak'])
}

// Two profiles that emit the same actions are one arm, and the statistic says so.
{
  const rows = await runMatrix(definitionOf(TWO_GAME), {
    build: builder(),
    driver: () => scriptedDriver(SCRIPTS.strong!),
  })
  const arms = effectiveArms(rows)
  assert.equal(arms.declared, 2)
  assert.equal(arms.effective, 1, 'two profiles emitting identical actions are one arm')
  assert.deepEqual(arms.aliases[0], ['strong', 'weak'])
  assert.match(
    generalization(rows).note!,
    /2 profiles emitted only 1 distinct action sequences/u,
    'the tau must carry its own arm count',
  )
}

// ---- Part 7: rows measured under different protocols are not pooled --------

{
  const rows = await runMatrix(definitionOf(TWO_GAME), { build: builder(), driver: scripted })
  assert.doesNotThrow(() => assertJoinable(rows), 'rows of one protocol across two games are joinable')

  const other = rows.map((r): CellResult => ({ ...r, protocol: 'fast', frameskip: 8 }))
  assert.throws(
    () => assertJoinable([...rows, ...other]),
    /measured under 2 protocols and cannot be pooled/u,
    'rows measured under two clocks must be refused, not averaged',
  )

  const seeing = rows.map((r): CellResult => ({ ...r, sensor: 'eyes', sensorDetail: 'pixels=on@3x,no-channels' }))
  assert.throws(
    () => assertJoinable([...rows, ...seeing]),
    /measured through 2 sensors and cannot be pooled/u,
    'the sensor is the dominant term; pooling across it pools across the thing being measured',
  )
}

// ---- Part 8: tau-b arithmetic, including ties ------------------------------

assert.equal(kendallTauB([1, 2, 3], [1, 2, 3]), 1)
assert.equal(kendallTauB([1, 2, 3], [3, 2, 1]), -1)
assert.equal(kendallTauB([1, 1, 1], [1, 2, 3]), 0, 'a vector with no order expressed transfers no order')
// tau-b, not tau-a: one tie in each vector shrinks the denominator rather than
// being scored as an ordering.
assert.ok(Math.abs(kendallTauB([1, 1, 2], [1, 2, 2]) - 0.5) < 1e-12)

// A cell type that cannot omit its protocol: this must not compile without one.
{
  const cell: MatrixCell = enumerateCells(parseMatrix(DEFINITION))[0]!
  assert.ok(cell.protocol.frameskip > 0 && cell.protocol.sticky >= 0, 'every cell carries its clock and its protocol')
}

console.log(
  `playproof matrix: ${refusals.length} definition refusals each red for their own reason,`
  + ' identity commits to the protocol\'s contents, a blocked cell has no standing,'
  + ' deaths and tokens stay null rather than 0, aliased arms are counted once,'
  + ' and rows under two clocks are refused',
)
