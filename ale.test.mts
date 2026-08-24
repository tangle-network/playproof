/**
 * ALE adapter test — the Atari real-substrate gate.
 *
 * Runs on Breakout from the ROM set ale-py bundles, so it needs no
 * user-supplied game and no download. Skips with one line when ale-py is
 * absent, unless PLAYPROOF_REQUIRE_ALE=1, which turns the missing dependency
 * into a loud failure (that is how CI proves the job really executed).
 *
 * Battery: derivation of the packaged score ladder, known-good attestation,
 * garbage rejection, graded partial credit, the publication gate
 * (`PackagedContract.calibrate`, with no declaration to make), three
 * hand-written controls the ladder must rank in the order the game itself
 * reports, a demonstration contract that carries the hash tiers, a `requires`
 * chain and a milestone a lost life earns, cross-process determinism including
 * the save-state hash, checkpoint round-trip, unknown-input no-op, the
 * observation image channel, and worker teardown. Zero model spend.
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { deriveContract } from './authoring'
import { attestRun, MilestoneTracker } from './attestation'
import {
  assertContractSeparates,
  assertOpaqueChecksDeclared,
  calibrateContract,
  measureProgressions,
  PackagedContract,
} from './calibration'
import { playEpisode, scriptedDriver } from './episode'
import { isGameOver, logFrom, observationOf } from './runtime'
import { decodePng, unscale } from './test-png.mts'
import {
  contractHash,
  contractLegibility,
  formatMilestoneScore,
  scoreAchievements,
  scoreMilestones,
  validateContract,
} from './schema'
import { AleRpc } from './adapters/ale-rpc'
import { aleMarks, bundledReference, makeAle, type Ale, type AleMilestoneRule, type AleState } from './adapters/ale'

const GAME = 'breakout'

/**
 * The packaged ladder, as the reference attains it.
 *
 * The reference file declares trigger points that double — 1, 2, 4, 8, 16, 32,
 * 64 — and `deriveContract` samples the score that actually held when each one
 * fired, so this is the contract a consumer gets rather than a restatement of
 * the reference. The fifth rung reads 18 because the reference's score steps 14
 * to 18 when it clears a four-point row, and its trigger is written as 18 so
 * the milestone id and its derived check agree.
 */
const LADDER = [1, 2, 4, 8, 18, 32, 64] as const

/** Reference inputs consumed before each rung of the ladder first passes. */
const LADDER_FIRST_PASS = [32, 71, 137, 259, 404, 636, 839]

/**
 * A second contract, derived from the SAME reference, for everything the
 * packaged ladder deliberately no longer carries.
 *
 * The packaged contract is seven rungs of one legible progression: every point
 * says how many bricks the run broke, and a reader can weigh every one. That
 * left three mechanisms with no live subject on a real emulator — the
 * screen-frame and save-file evidence tiers, a `requires` chain, and a
 * milestone a lost life earns. They are exercised here instead, so removing
 * them from the published contract does not quietly stop testing them.
 */
const DEMO_RULES: AleMilestoneRule[] = [
  { id: 'score-opened', tier: 'engine-state', variable: 'score', op: '>=', trigger: 1 },
  {
    id: 'frame-at-first-score', tier: 'screen-frame', sample: 'frame-hash',
    variable: 'score', op: '>=', trigger: 1, requires: ['score-opened'],
  },
  {
    id: 'save-at-first-score', tier: 'save-file', sample: 'save-hash',
    variable: 'score', op: '>=', trigger: 1, requires: ['score-opened'],
  },
  {
    id: 'life-lost', tier: 'engine-state', variable: 'lives', op: '<',
    trigger: 5, sampleOp: '==', requires: ['score-opened'],
  },
]

/**
 * Inputs the demonstration contract is calibrated over. The reference loses its
 * first life after 226, so a shorter budget would leave `lives` motionless and
 * the attrition classifier with nothing to read.
 */
const DEMO_TURNS = 240

/**
 * The opaque-collision sweep on the demonstration contract, pinned.
 *
 * Both hashes fire after 32 inputs. Over the vocabulary NOOP/FIRE/RIGHT/LEFT
 * that prefix admits 96 single-input substitutions, and 56 of them still
 * reproduce both hashes, at 21 of the 32 turns. Applying one alternative at
 * every free turn at once does NOT, so the family bound is a product the sweep
 * has not shown to be reachable jointly.
 *
 * These numbers are the correction to #22, which concluded from a clean
 * trivial-baseline result that a hash could only be reached by replaying the
 * reference. They are also the reason the packaged contract carries no hash: a
 * check half a billion 32-input logs satisfy states nothing a reader can weigh,
 * and no independent control in this file has ever earned one.
 *
 * A regression here means ale-py, the ROM, or the reference moved.
 */
const DEMO_COLLISIONS = [
  {
    milestone: 'frame-at-first-score',
    firesAfter: 32, probedTurns: 32, substitutions: 96,
    collisions: 56, freeTurns: 21, jointCollision: false, family: 521838526464,
  },
  {
    milestone: 'save-at-first-score',
    firesAfter: 32, probedTurns: 32, substitutions: 96,
    collisions: 56, freeTurns: 21, jointCollision: false, family: 521838526464,
  },
]
const python = process.env.PLAYPROOF_PYTHON ?? 'python3'

/** The bundled ROM must be present, not just the package. */
function pythonHasAle(): boolean {
  const probe = `import pathlib, sys; from ale_py import roms; sys.exit(0 if pathlib.Path(roms.get_rom_path('${GAME}')).is_file() else 1)`
  return spawnSync(python, ['-c', probe], { encoding: 'utf8' }).status === 0
}

if (!pythonHasAle()) {
  const hint = `ale-py is not importable from ${python}; install it with \`${python} -m pip install ale-py\` (it bundles the Atari ROM set, so no download is needed)`
  if (process.env.PLAYPROOF_REQUIRE_ALE === '1') {
    throw new Error(`PLAYPROOF_REQUIRE_ALE=1 but ${hint}`)
  }
  console.log(`ale: skip: ${hint}`)
} else {
  /** One replay of a script, recorded as the evidence a verifier would recompute. */
  const trace = (adapter: Ale, inputs: readonly string[]): string[] => {
    let state: AleState = adapter.game.init(adapter.seed)
    const out: string[] = []
    const record = (s: AleState): void => {
      const e = adapter.game.evidence(s)
      out.push(JSON.stringify([e.frameHash, e.saveBlobHash, e.engineState]))
    }
    record(state)
    for (const input of inputs) {
      state = adapter.game.step(state, input)
      record(state)
    }
    return out
  }

  const reference = bundledReference(GAME)!
  const adapter = makeAle({ game: GAME })
  let second: Ale | null = null
  let disposed = false
  try {
    // Identity: ale-py loaded the ROM the reference pins, with sticky actions
    // off and the RAM channels the reference asked for.
    assert.equal(adapter.identity.romSha, reference.romSha)
    assert.equal(adapter.game.id, 'ale-breakout')
    assert.equal(adapter.identity.repeatActionProbability, 0)
    assert.deepEqual(adapter.inputs, ['NOOP', 'FIRE', 'RIGHT', 'LEFT'])
    assert.deepEqual(adapter.identity.channels, ['ram_ball_x', 'ram_ball_y', 'ram_paddle_x'])
    assert.deepEqual(adapter.identity.screen, [210, 160])

    // Evidence stays bounded: only the named RAM bytes reach engineState, not
    // the whole 128-byte page.
    const bootEvidence = adapter.game.evidence(adapter.game.init(adapter.seed))
    assert.deepEqual(Object.keys(bootEvidence.engineState ?? {}).sort(), [
      'episodeFrame', 'frameNumber', 'lives', 'ram_ball_x', 'ram_ball_y', 'ram_paddle_x', 'score', 'terminal',
    ])

    // Authoring: contract derived from the reference with event-anchored
    // marks. No hash, position, or threshold is typed into the adapter — the
    // reference declares a trigger and the replay decides what held there.
    assert.deepEqual(validateContract(adapter.contract), [])
    assert.equal(adapter.contract.milestones.length, reference.milestones.length)
    assert.deepEqual(adapter.contract.milestones.map((m) => m.id), LADDER.map((v) => `score-${v}`))
    assert.deepEqual(
      adapter.contract.milestones.map((m) => m.check),
      LADDER.map((value) => ({ kind: 'state-path', path: 'score', op: '>=', value })),
    )
    // No rung requires another. `engineState.score` never falls (asserted from
    // the calibration motion below), so a run cannot pass `score >= 18` without
    // having passed `score >= 8`, and a `requires` edge would only restate the
    // check while making the contract report that it grades one event.
    assert.deepEqual(adapter.contract.milestones.flatMap((m) => m.requires ?? []), [])

    // Known-good: the reference verifies every milestone.
    const all = adapter.contract.milestones.map((m) => m.id)
    const good = attestRun(adapter.game, adapter.contract, adapter.seed, logFrom(adapter.seed, [...adapter.reference]), all)
    assert.equal(good.verdict, 'clean', `reference rejected: ${good.reasons.join('; ')}`)
    assert.deepEqual(good.verified, all)

    // False claim: a garbage script of the same length claiming the same
    // milestones is rejected. The words move the paddle and misspell buttons
    // but never serve the ball, so no milestone can open.
    const garbageWords = ['LEFT', 'RIGHT', 'NOOP', 'UP', 'DOWN', 'wiggle', 'flibbertigibbet', 'RIGHT']
    const garbage = adapter.reference.map((_, i) => garbageWords[i % garbageWords.length]!)
    const rejected = attestRun(adapter.game, adapter.contract, adapter.seed, logFrom(adapter.seed, garbage), all)
    assert.equal(rejected.verdict, 'rejected')
    assert.ok(rejected.reasons.some((r) => r.startsWith('claimed-not-reproduced')), rejected.reasons.join('; '))
    assert.deepEqual(rejected.verified, [])

    // Graded, not all-or-nothing: a partial replay earns the milestones it
    // actually reached and is rejected only for the ones it claims beyond.
    const partial = attestRun(adapter.game, adapter.contract, adapter.seed, logFrom(adapter.seed, adapter.reference.slice(0, 100)), all)
    assert.equal(partial.verdict, 'rejected')
    assert.deepEqual(partial.verified, ['score-1', 'score-2'])
    assert.deepEqual(partial.reasons, ['claimed-not-reproduced:score-4,score-8,score-18,score-32,score-64'])

    // Every point of the packaged contract is one rung of one legible ladder,
    // and each rung says the same thing in a louder voice: this run broke this
    // many bricks. Nothing is stated as a hash, so a reader can weigh all seven
    // and the honest denominator is seven.
    assert.deepEqual(contractLegibility(adapter.contract), { legible: all, opaque: [], reasons: {} })
    assert.deepEqual(good.score, { verified: 7, total: 7 })
    assert.equal(formatMilestoneScore(partial.score), '2 of 7')

    // A run that scored 9 earns four rungs out of seven. The old contract's top
    // milestone was `score >= 4`, so 9 and 24 and 64 were the same number to it.
    const played = ['score-1', 'score-2', 'score-4', 'score-8']
    assert.deepEqual(scoreMilestones(adapter.contract, played), { verified: 4, total: 7 })
    assert.equal(formatMilestoneScore(scoreMilestones(adapter.contract, played)), '4 of 7')

    // Calibration on the real emulator, through the gate a published target has
    // to pass. `PackagedContract.calibrate` is the only way to build a
    // `PackagedContract`, and this call carries NO declaration: the ladder
    // states no opaque check to accept, no attrition milestone to record, and no
    // prerequisite the whole contract hangs off. Every baseline plays the
    // reference's 839 turns, so the comparison is length-matched.
    const packaged = PackagedContract.calibrate(adapter.game, adapter.contract, {
      reference: adapter.reference,
      vocabulary: adapter.inputs,
      seed: adapter.seed,
    })
    const calibration = packaged.report
    for (const outcome of [calibration.reference, ...calibration.baselines]) {
      console.log(`  ${outcome.id.padEnd(32)} ${String(outcome.verified.length).padStart(2)}  ${outcome.verdict}  ${outcome.verified.join(',') || '-'}`)
    }
    assert.equal(packaged.hash, contractHash(adapter.contract))
    assert.deepEqual(packaged.declaration, {})
    assert.equal(calibration.turns, adapter.reference.length)
    assert.deepEqual(calibration.legible, all)
    assert.deepEqual(calibration.opaque, [])
    assert.deepEqual(calibration.collisions, [])
    assert.deepEqual(calibration.trivial, [])
    assert.deepEqual(calibration.separating, all)
    assert.deepEqual(calibration.attritionSeparating, [])
    assert.equal(calibration.bestBaselineAchievementCount, 0)
    assert.deepEqual(calibration.referenceScore, { verified: 7, total: 7 })
    assert.deepEqual(calibration.referenceAchievementScore, { verified: 7, total: 7 })
    assert.equal(calibration.separates, true)

    // Nothing is attrition and nothing is unmeasured: every check reads
    // `engineState.score`, which rose and never fell across all eight replayed
    // trajectories. The whole-contract score and the achievement score are
    // therefore the same number, so no consumer can pick the one that ranks a
    // run that died above a run that did not.
    assert.deepEqual(calibration.progression.achievement, all)
    assert.deepEqual(calibration.progression.attrition, [])
    assert.deepEqual(calibration.progression.unmeasured, [])
    const scoreMotion = calibration.progression.motion.find((row) => row.channel === 'engineState.score')
    assert.equal(scoreMotion?.falls, 0)
    assert.ok((scoreMotion?.rises ?? 0) > 0, 'the score channel never rose')

    // The contract no longer resolves a run on one event. Seven rungs open at
    // seven distinct instants of the reference, so no moment of play wears
    // several milestone ids.
    assert.equal(calibration.collapse.prerequisite, null)
    assert.equal(calibration.collapse.collapses, false)
    assert.deepEqual(calibration.collapse.simultaneous, [])
    assert.equal(calibration.collapse.simultaneousAfter, -1)
    assert.deepEqual(all.map((id) => calibration.collapse.firstPassAt[id]), LADDER_FIRST_PASS)
    console.log(
      `ale: calibration — reference ${formatMilestoneScore(calibration.referenceScore)}, ` +
      `best trivial baseline ${calibration.bestBaselineLegibleCount} legible over ${calibration.turns} turns, ` +
      `separating=${calibration.separating.join(',')}, separates=${calibration.separates}, ` +
      `collapses=${calibration.collapse.collapses}, opaque=${calibration.opaque.length}, ` +
      `attrition=${calibration.progression.attrition.length}`,
    )

    // --- the ordering the ladder exists to produce ---------------------------
    //
    // Three deterministic controls, none of which carries state between
    // decisions and none of which costs a model call.
    //
    // Two share a control law and a deadzone in screen pixels and differ only in
    // what they read: the ASCII frame the agent sees, at four screen pixels per
    // character, or the RAM channels the adapter publishes, at one pixel each.
    // The third reads nothing at all — it repeats a fixed three-word cycle. It
    // is the strongest screen-blind program a sweep of every input pattern of
    // period four or less found (340 patterns, best game score 7 at both 300
    // and 600 decisions).
    //
    // The RAM control wins every column the game itself reports: score 9 to 6
    // at 300 decisions and 24 to 7 at 600, and it never dies while the other two
    // run out of lives. Under the contract this file replaced, all three tied at
    // 3 of 5 achievements, because its top achievement was `score >= 4`. The
    // ladder is here so that the ordering the game reports is the ordering the
    // contract reports.
    const PLAY_ROWS = [11, 20] as const
    const PADDLE_ROWS = [21, 22] as const
    const marked = (row: string): number[] => {
      const columns: number[] = []
      for (let column = 2; column <= 37; column++) if ((row[column] ?? ' ') !== ' ') columns.push(column)
      return columns
    }
    const steerTowards = (ball: number | null, paddle: number, deadzone: number): string => {
      if (ball === null) return 'FIRE'
      if (ball > paddle + deadzone) return 'RIGHT'
      if (ball < paddle - deadzone) return 'LEFT'
      return 'NOOP'
    }
    const steerFromAscii = (state: AleState): string => {
      const rows = adapter.game.frame(state).split('\n')
      let ball: number | null = null
      for (let row = PLAY_ROWS[0]; row <= PLAY_ROWS[1] && ball === null; row++) {
        const found = marked(rows[row] ?? '')
        if (found.length > 0) ball = (found[0]! + found[found.length - 1]!) / 2
      }
      const paddle = [...marked(rows[PADDLE_ROWS[0]] ?? ''), ...marked(rows[PADDLE_ROWS[1]] ?? '')]
      if (paddle.length === 0) return 'FIRE'
      return steerTowards(ball, (Math.min(...paddle) + Math.max(...paddle)) / 2, 1)
    }
    const steerFromRam = (state: AleState): string => {
      const engine = (adapter.game.evidence(state).engineState ?? {}) as Record<string, number>
      const ball = (engine.ram_ball_x ?? 0) === 0 ? null : engine.ram_ball_x!
      // The paddle is 20 RAM units wide, so its centre is its position plus 10,
      // and 4 units is the 4-pixel character the ASCII control resolves.
      return steerTowards(ball, (engine.ram_paddle_x ?? 0) + 10, 4)
    }
    const SCREEN_BLIND_CYCLE = ['NOOP', 'FIRE', 'LEFT']
    const screenBlind = (): (() => string) => {
      let turn = 0
      return () => SCREEN_BLIND_CYCLE[turn++ % SCREEN_BLIND_CYCLE.length]!
    }

    const readCounter = (frame: string, key: string): number =>
      Number(new RegExp(`${key}=(-?\\d+)`, 'u').exec(frame)?.[1] ?? -1)
    const control = (id: string, decide: (state: AleState) => string, turns: number) => {
      const tracker = new MilestoneTracker(adapter.contract)
      let state = adapter.game.init(adapter.seed)
      const inputs: string[] = []
      tracker.consider(adapter.game.evidence(state))
      for (let turn = 0; turn < turns && !isGameOver(adapter.game, state); turn++) {
        const input = decide(state)
        inputs.push(input)
        state = adapter.game.step(state, input)
        tracker.consider(adapter.game.evidence(state))
      }
      const frame = adapter.game.frame(state)
      return {
        id, turns, inputs,
        verified: tracker.verified(),
        gameScore: readCounter(frame, 'score'),
        lives: readCounter(frame, 'lives'),
        played: inputs.length,
      }
    }

    const controls = [300, 600].flatMap((turns) => {
      const blind = screenBlind()
      return [
        control('steer-from-ascii', steerFromAscii, turns),
        control('steer-from-ram', steerFromRam, turns),
        control('screen-blind', blind, turns),
      ]
    })
    // The classification is measured over the controls too, so the ordering
    // claim is not made against a profile fitted to the reference alone.
    const profile = measureProgressions(adapter.game, adapter.contract, {
      trajectories: [adapter.reference, ...controls.map((run) => run.inputs)],
      seed: adapter.seed,
    })
    assert.deepEqual(profile.attrition, [])
    assert.deepEqual(profile.achievement, all)

    for (const run of controls) {
      console.log(
        `  ${run.id.padEnd(17)} @${String(run.turns).padStart(3)} decisions — ` +
        `milestones ${formatMilestoneScore(scoreMilestones(adapter.contract, run.verified))}, ` +
        `achievements ${formatMilestoneScore(scoreAchievements(adapter.contract, profile, run.verified))}, ` +
        `game score ${run.gameScore}, lives ${run.lives}, played ${run.played}`,
      )
    }
    for (const turns of [300, 600]) {
      const at = (id: string) => controls.find((run) => run.id === id && run.turns === turns)!
      const ascii = at('steer-from-ascii')
      const ram = at('steer-from-ram')
      const blind = at('screen-blind')
      // The RAM control plays better by the game's own report.
      assert.ok(ram.gameScore > ascii.gameScore, `ram ${ram.gameScore} must beat ascii ${ascii.gameScore} at ${turns}`)
      assert.ok(ram.gameScore > blind.gameScore, `ram ${ram.gameScore} must beat screen-blind ${blind.gameScore} at ${turns}`)
      assert.ok(ram.lives > ascii.lives && ram.lives > blind.lives)

      // The claim this contract exists to make: the achievement score ranks the
      // better player STRICTLY first, at both budgets, over both weaker
      // controls. A tie here is the defect the ladder replaced.
      const achieve = (run: typeof ram) => scoreAchievements(adapter.contract, profile, run.verified)
      const achieveRam = achieve(ram)
      assert.ok(achieveRam.verified > achieve(ascii).verified,
        `achievement score must rank the RAM control above the ASCII control at ${turns}: ` +
        `ram ${formatMilestoneScore(achieveRam)}, ascii ${formatMilestoneScore(achieve(ascii))}`)
      assert.ok(achieveRam.verified > achieve(blind).verified,
        `achievement score must rank the RAM control above the screen-blind control at ${turns}: ` +
        `ram ${formatMilestoneScore(achieveRam)}, blind ${formatMilestoneScore(achieve(blind))}`)

      // The contract carries no attrition milestone, so the whole-contract score
      // is the achievement score and no consumer can pick the number that ranks
      // a control that died above one that did not.
      for (const run of [ascii, ram, blind]) {
        assert.deepEqual(scoreMilestones(adapter.contract, run.verified), achieve(run))
      }

      // The ceiling is not the binding limit any more: the strongest control
      // still has rungs above it, so a better program has somewhere to go.
      assert.ok(achieveRam.verified < achieveRam.total,
        `the ladder must leave headroom above the strongest control at ${turns}, ` +
        `and it scored ${formatMilestoneScore(achieveRam)}`)
    }

    // --- the machinery the packaged ladder no longer carries -----------------
    //
    // One contract, derived from the SAME reference and the same replay, that
    // states two hash milestones, a `requires` chain, and a milestone a lost
    // life earns. It is not published: it exists so that removing those three
    // things from the packaged contract does not quietly stop testing them, and
    // so the numbers that justified removing them stay measured.
    const demo = deriveContract(adapter.game, adapter.seed, adapter.reference, aleMarks(DEMO_RULES))
    assert.deepEqual(validateContract(demo), [])
    const demoTiers = new Set(demo.milestones.map((m) => m.tier))
    assert.ok(demoTiers.has('engine-state') && demoTiers.has('screen-frame') && demoTiers.has('save-file'),
      `expected engine-state, screen-frame and save-file tiers, got ${[...demoTiers].join(',')}`)
    const demoKinds = new Set(demo.milestones.map((m) => m.check.kind))
    assert.ok(demoKinds.has('state-path') && demoKinds.has('frame-hash') && demoKinds.has('save-hash'),
      `expected state-path, frame-hash and save-hash checks, got ${[...demoKinds].join(',')}`)
    assert.deepEqual(contractLegibility(demo), {
      legible: ['score-opened', 'life-lost'],
      opaque: ['frame-at-first-score', 'save-at-first-score'],
      reasons: {
        'frame-at-first-score':
          'its frame-hash check states its requirement as a hash, so a reader cannot see what it demands',
        'save-at-first-score':
          'its save-hash check states its requirement as a hash, so a reader cannot see what it demands',
      },
    })

    const demoReport = calibrateContract(adapter.game, demo, {
      reference: adapter.reference,
      vocabulary: adapter.inputs,
      seed: adapter.seed,
      turns: DEMO_TURNS,
    })
    // No trivial policy reproduced either hash. That was the whole of the
    // evidence #22 had for calling them unearnable, and it proves nothing: the
    // baseline suite cannot serve a ball, let alone score.
    assert.deepEqual(demoReport.opaqueReproduced, [])
    // The substitution sweep is the prober that can. Both hashes fire after 32
    // inputs; the sweep replaces one input of that prefix at a time over
    // NOOP/FIRE/RIGHT/LEFT and counts the logs that still satisfy the check.
    // FIRE while the ball is already in flight is a state no-op, so a large
    // family of logs reaches a bit-identical emulator state.
    for (const row of demoReport.collisions) {
      console.log(
        `  ${row.milestone.padEnd(24)} fires after ${row.firesAfter}; ` +
        `${row.collisions}/${row.substitutions} substitutions collide at ${row.freeTurns}/${row.probedTurns} turns; ` +
        `joint=${row.jointCollision}; family >= ${row.family.toExponential(2)}`,
      )
    }
    assert.deepEqual(demoReport.collisions, DEMO_COLLISIONS)

    // `life-lost` is `lives == 4`: the reference earns it by DYING. The
    // classification reads no field name — it reads the motion of the channel,
    // which falls and never rises across every replayed trajectory, and a check
    // that does not hold at the starting value of a channel that only falls can
    // only be earned by letting the resource run down.
    assert.deepEqual(demoReport.progression.attrition, ['life-lost'])
    assert.deepEqual(demoReport.progression.unmeasured, ['frame-at-first-score', 'save-at-first-score'])
    assert.match(
      demoReport.progression.reasons['life-lost'] ?? '',
      /reads engineState\.lives, which fell \d+ time\(s\) and never rose/u,
    )
    assert.equal(demoReport.progression.motion.find((row) => row.channel === 'engineState.lives')?.rises, 0)
    assert.deepEqual(demoReport.attritionSeparating, ['life-lost'])
    assert.ok(!demoReport.separating.includes('life-lost'))
    assert.deepEqual(demoReport.separating, ['score-opened'])
    assert.deepEqual(demoReport.referenceAchievementScore, { verified: 3, total: 3 })

    // Every milestone requires `score-opened`, and three of the four open at the
    // same instant of the reference. Four milestone ids, two decision points.
    assert.equal(demoReport.collapse.prerequisite, 'score-opened')
    assert.equal(demoReport.collapse.gated, 4)
    assert.equal(demoReport.collapse.total, 4)
    assert.equal(demoReport.collapse.collapses, true)
    assert.deepEqual(demoReport.collapse.earnedByBaseline, [])
    assert.deepEqual(demoReport.collapse.simultaneous, ['score-opened', 'frame-at-first-score', 'save-at-first-score'])
    assert.equal(demoReport.collapse.simultaneousAfter, 32)

    // Undeclared, this contract cannot ship, whatever its separation verdict.
    assert.throws(() => assertOpaqueChecksDeclared(demoReport), /states 2 of 4 milestone\(s\) as a hash/u)
    // Declaring them opaque is still not enough, because the sweep measured the
    // collisions. The author must accept the weakness by id.
    assert.throws(
      () => assertOpaqueChecksDeclared(demoReport, { opaqueChecks: ['frame-at-first-score', 'save-at-first-score'] }),
      /2 opaque milestone\(s\) are satisfied by input logs other than the reference/u,
    )
    const opacity = {
      opaqueChecks: ['frame-at-first-score', 'save-at-first-score'],
      weakChecks: ['frame-at-first-score', 'save-at-first-score'],
    }
    assertOpaqueChecksDeclared(demoReport, opacity)
    assert.throws(
      () => assertContractSeparates(demoReport, opacity),
      (error: unknown) => {
        const message = (error as Error).message
        assert.match(message, /states 1 of 4 milestone\(s\) that a resource running down earns/u)
        assert.match(message, /attritionChecks: \['life-lost'\]/u)
        assert.match(message, /collapses to one event: 4 of 4 milestone\(s\) require score-opened/u)
        assert.match(message, /3 of 4 milestone\(s\) first pass at the same reference input \(after 32\)/u)
        return true
      },
    )
    const demoDeclaration = { ...opacity, attritionChecks: ['life-lost'], gatedBehind: 'score-opened' }
    assertContractSeparates(demoReport, demoDeclaration)
    const demoPackaged = PackagedContract.calibrate(adapter.game, demo, {
      reference: adapter.reference,
      vocabulary: adapter.inputs,
      seed: adapter.seed,
      turns: DEMO_TURNS,
      declare: demoDeclaration,
    })
    assert.equal(demoPackaged.hash, contractHash(demo))
    console.log(
      `ale: demonstration contract — ${demo.milestones.length} milestones over ${demoTiers.size} evidence tiers, ` +
      `${demoReport.opaque.length} opaque, ${demoReport.progression.attrition.length} attrition, ` +
      `collapses=${demoReport.collapse.collapses} over ${demoReport.turns} turns; ` +
      `the packaged ladder states none of it`,
    )

    // Determinism: two replays in this worker and one in a freshly spawned
    // worker must agree on every frame hash, every save-state hash, and every
    // privileged variable. Cross-process is the load-bearing case, because a
    // verifier never shares the emulator that produced the run. The save hash
    // is inside this claim, which is why a save-file milestone is honest here
    // and is not on the stable-retro substrate.
    const first = trace(adapter, adapter.reference)
    const again = trace(adapter, adapter.reference)
    assert.deepEqual(again, first, 'same-process replay diverged')
    second = makeAle({ game: GAME })
    const other = trace(second, adapter.reference)
    assert.deepEqual(other, first, 'cross-process replay diverged')
    assert.equal(first.length, adapter.reference.length + 1)

    // Unknown inputs are no-ops, not cheats and not errors.
    const junkWords = ['FLIBBERTIGIBBET', '', 'nope', 'FIRE-not-a-button']
    let junkState = adapter.game.init(adapter.seed)
    for (const word of junkWords) junkState = adapter.game.step(junkState, word)
    let noopState = adapter.game.init(adapter.seed)
    for (const _ of junkWords) noopState = adapter.game.step(noopState, 'NOOP')
    assert.deepEqual(adapter.game.evidence(junkState), adapter.game.evidence(noopState))

    // Checkpoints: an ALE state restores to the exact emulator instant and
    // carries the cumulative score with it, so the same inputs after a restore
    // produce the same evidence.
    const rpc = new AleRpc()
    try {
      rpc.boot({ game: GAME, seed: reference.seed, frameSkip: reference.frames, channels: reference.channels ?? [] })
      for (const input of adapter.reference.slice(0, 80)) rpc.step(input)
      const checkpoint = rpc.snapshot()
      const ahead = ['LEFT', 'NOOP', 'RIGHT', 'FIRE'].map((w) => JSON.stringify(rpc.step(w).evidence))
      const restored = rpc.restore(checkpoint)
      assert.equal(restored.gen, 1)
      const replayed = ['LEFT', 'NOOP', 'RIGHT', 'FIRE'].map((w) => JSON.stringify(rpc.step(w).evidence))
      assert.deepEqual(replayed, ahead, 'checkpoint restore did not reproduce the same evidence')
      assert.throws(() => rpc.restore(Buffer.from('not a checkpoint')), /worker restore failed/)
    } finally {
      rpc.shutdown()
    }

    // Observation images: the worker encodes the SAME screen it hashes for
    // evidence, so a vision agent sees the game instead of an ASCII downsample
    // of it. The default adapter above published none, which is the whole
    // point of the option: the byte cost is unchanged until a caller asks.
    assert.equal(adapter.identity.screenImage, false)
    assert.equal('images' in observationOf(adapter.game, adapter.game.init(adapter.seed)), false)

    const vision = makeAle({ game: GAME, screenImage: true, screenScale: 3 })
    try {
      assert.equal(vision.identity.screenImage, true)
      assert.equal(vision.identity.screenScale, 3)
      let seen = vision.game.init(vision.seed)
      for (const input of vision.reference.slice(0, 120)) seen = vision.game.step(seen, input)
      const observation = observationOf(vision.game, seen)
      assert.equal(observation.text, vision.game.frame(seen))
      assert.equal(observation.images?.length, 1)
      const image = observation.images![0]!
      assert.equal(image.mediaType, 'image/png')

      // The PNG really decodes, at the size the adapter declared, to a picture
      // with more than one colour in it. A constant frame would mean the
      // encoder ran on an empty buffer and the agent is shown nothing.
      const decoded = decodePng(Buffer.from(image.base64, 'base64'), { expectFilterNone: true })
      const [nativeHeight, nativeWidth] = adapter.identity.screen
      assert.deepEqual([decoded.width, decoded.height], [nativeWidth * 3, nativeHeight * 3])
      assert.deepEqual([image.width, image.height], [decoded.width, decoded.height])
      assert.ok(decoded.colours > 1, 'the encoded screen is one flat colour')

      // The strongest statement about this channel: the picture the agent is
      // shown is the screen the verifier hashes. Undoing the whole-pixel
      // upscale recovers the native buffer, and its SHA-256 is `frameHash`.
      const native = createHash('sha256').update(unscale(decoded, 3)).digest('hex')
      assert.equal(native, vision.game.evidence(seen).frameHash)

      // The image path does not perturb the emulator: at the same instant of
      // the same script, the evidence a verifier recomputes is identical.
      let plain = adapter.game.init(adapter.seed)
      for (const input of adapter.reference.slice(0, 120)) plain = adapter.game.step(plain, input)
      assert.deepEqual(vision.game.evidence(seen), adapter.game.evidence(plain))

      console.log(
        `ale: observation image — ${decoded.width}x${decoded.height} PNG, ` +
        `${Buffer.from(image.base64, 'base64').length} bytes encoded, ${image.base64.length} base64, ` +
        `${decoded.colours} distinct colours, pixels hash to frameHash, evidence unchanged`,
      )
    } finally {
      vision.dispose()
    }

    // The game-over stop, on the real emulator.
    //
    // Motivation, measured by a consumer at 300 turns on this ROM: 163 of 300
    // decisions (54.3%) were taken after lives reached 0 with `terminal` set.
    // The worker breaks out of its action-repeat loop once that flag holds, so
    // none of those inputs reached the emulator.
    //
    // The script reproduces the shape deterministically — 40 inputs of the
    // reference, which open the first rung, then FIRE until the last life is
    // gone. A regression in these turn counts means ale-py, the ROM, or the
    // reference moved.
    const GAME_OVER_TURNS = 300
    const REFERENCE_PREFIX = 40
    const dying = () => scriptedDriver([
      ...adapter.reference.slice(0, REFERENCE_PREFIX),
      ...Array.from({ length: GAME_OVER_TURNS - REFERENCE_PREFIX }, () => 'FIRE'),
    ])
    const fullLength = await playEpisode(adapter.game, adapter.contract, dying(), 1, GAME_OVER_TURNS, adapter.seed)
    const atGameOver = await playEpisode(
      adapter.game, adapter.contract, dying(), 1, GAME_OVER_TURNS, adapter.seed, undefined, { stopAtGameOver: true },
    )
    assert.equal(fullLength.record.turns, GAME_OVER_TURNS)
    assert.equal(fullLength.record.stoppedBy, 'maxTurns')
    assert.equal(fullLength.record.gameOver, true, 'the full-length run ended past a finished game')
    assert.equal(atGameOver.record.turns, 150)
    assert.equal(atGameOver.record.stoppedBy, 'gameOver')
    assert.equal(atGameOver.record.gameOver, true)
    // The milestone verdict is unchanged: the 150 dropped decisions bought
    // nothing on the score ladder.
    assert.deepEqual(atGameOver.record.verified, fullLength.record.verified)
    assert.deepEqual(atGameOver.record.score, fullLength.record.score)
    assert.equal(atGameOver.record.verified.length > 0, true)
    // The short record verifies by replay exactly as the full-length one does.
    for (const run of [atGameOver, fullLength]) {
      assert.equal(run.record.verdict, 'clean')
      assert.equal(run.record.replayDivergence, false)
      const recomputed = attestRun(adapter.game, adapter.contract, adapter.seed, run.log, [...run.record.verified])
      assert.equal(recomputed.verdict, 'clean', recomputed.reasons.join('; '))
      assert.deepEqual(recomputed.verified, run.record.verified)
    }
    // The dropped decisions were inert, not merely unproductive: every
    // evidence channel is byte-identical from the game-over snapshot to the
    // 300th, while the decision before it did move the emulator.
    const dyingTrace = trace(adapter, [...fullLength.log.inputs()])
    assert.equal(dyingTrace[atGameOver.record.turns], dyingTrace[GAME_OVER_TURNS])
    assert.notEqual(dyingTrace[atGameOver.record.turns - 1], dyingTrace[atGameOver.record.turns])
    console.log(
      `ale: game-over stop — ${atGameOver.record.turns} of ${GAME_OVER_TURNS} decisions played, ` +
      `${fullLength.record.turns - atGameOver.record.turns} dropped as inert ` +
      `(${Math.round((1 - atGameOver.record.turns / GAME_OVER_TURNS) * 1000) / 10}% of the episode); ` +
      `milestones ${formatMilestoneScore(atGameOver.record.score)}, unchanged from the full-length run`,
    )

    // Teardown: dispose kills the worker and every later call fails loudly
    // instead of silently reading a dead transport.
    second.dispose()
    second = null
    adapter.dispose()
    disposed = true
    assert.throws(() => adapter.game.init(adapter.seed), /closed/)

    const finalState = JSON.parse(first[first.length - 1]!)[2]
    console.log(
      `ale: ${adapter.identity.game} on ${adapter.inputs.length} actions — ` +
      `derivation, ${adapter.contract.milestones.length}-rung score ladder ` +
      `(${LADDER.join(', ')}), known-good, false-claim, graded partial, cross-process determinism over ` +
      `${first.length} snapshots (screen, save state, and engine state), checkpoint round-trip, ` +
      `unknown-input no-op, teardown OK (reference reaches score ${finalState.score} with ` +
      `${finalState.lives} lives over ${adapter.reference.length} inputs)`,
    )
  } finally {
    if (second) second.dispose()
    if (!disposed) adapter.dispose()
  }
}
