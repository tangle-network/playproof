/**
 * ALE adapter test — the Atari real-substrate gate.
 *
 * Runs on Breakout from the ROM set ale-py bundles, so it needs no
 * user-supplied game and no download. Skips with one line when ale-py is
 * absent, unless PLAYPROOF_REQUIRE_ALE=1, which turns the missing dependency
 * into a loud failure (that is how CI proves the job really executed).
 *
 * Battery: contract derivation across three evidence tiers, known-good
 * attestation, garbage rejection, graded partial credit, calibration with the
 * legible/opaque split and the opaque-collision sweep, cross-process
 * determinism including the save-state hash,
 * checkpoint round-trip, unknown-input no-op, the observation image channel,
 * and worker teardown. Zero model spend.
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { attestRun } from './attestation'
import { assertContractSeparates, assertOpaqueChecksDeclared, calibrateContract } from './calibration'
import { logFrom, observationOf } from './runtime'
import { decodePng, unscale } from './test-png.mts'
import { contractLegibility, formatMilestoneScore, scoreMilestones, validateContract } from './schema'
import { AleRpc } from './adapters/ale-rpc'
import { bundledReference, makeAle, type Ale, type AleState } from './adapters/ale'

const GAME = 'breakout'

/**
 * The opaque-collision sweep on the packaged Breakout contract, pinned.
 *
 * Both hashes fire after 32 inputs. Over the vocabulary NOOP/FIRE/RIGHT/LEFT
 * that prefix admits 96 single-input substitutions, and 40 of them still
 * reproduce both hashes, at 16 of the 32 turns. Applying one alternative at
 * every free turn at once reproduces them too, which is why the family bound
 * multiplies out instead of adding.
 *
 * These numbers are the correction to #22, which concluded from a clean
 * trivial-baseline result that a hash could only be reached by replaying the
 * reference. A regression here means ale-py, the ROM, or the reference moved.
 */
const ALE_BREAKOUT_COLLISIONS = [
  {
    milestone: 'frame-at-first-score',
    firesAfter: 32, probedTurns: 32, substitutions: 96,
    collisions: 40, freeTurns: 16, jointCollision: true, family: 382205952,
  },
  {
    milestone: 'save-at-first-score',
    firesAfter: 32, probedTurns: 32, substitutions: 96,
    collisions: 40, freeTurns: 16, jointCollision: true, family: 382205952,
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
    // marks. No hash, position, or threshold is typed into the adapter.
    assert.deepEqual(validateContract(adapter.contract), [])
    assert.equal(adapter.contract.milestones.length, reference.milestones.length)
    const tiers = new Set(adapter.contract.milestones.map((m) => m.tier))
    assert.ok(tiers.has('engine-state') && tiers.has('screen-frame') && tiers.has('save-file'),
      `expected engine-state, screen-frame and save-file tiers, got ${[...tiers].join(',')}`)
    const kinds = new Set(adapter.contract.milestones.map((m) => m.check.kind))
    assert.ok(kinds.has('state-path') && kinds.has('frame-hash') && kinds.has('save-hash'),
      `expected state-path, frame-hash and save-hash checks, got ${[...kinds].join(',')}`)

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
    assert.deepEqual(partial.verified, ['score-opened', 'frame-at-first-score', 'save-at-first-score', 'score-tier-2'])
    assert.deepEqual(partial.reasons, ['claimed-not-reproduced:score-tier-4,life-lost'])

    // A hash check identifies a STATE, not a trajectory. Both hashes here name
    // the exact screen and save state the reference stood in when it first
    // scored, and any policy that stands in that state earns them. They are
    // points, so the honest denominator is six.
    //
    // What they are not is readable: `frame-at-first-score` says nothing a
    // contract reader can weigh, while `score-tier-4` says score >= 4.
    assert.deepEqual(contractLegibility(adapter.contract), {
      legible: ['score-opened', 'score-tier-2', 'score-tier-4', 'life-lost'],
      opaque: ['frame-at-first-score', 'save-at-first-score'],
      reasons: {
        'frame-at-first-score':
          'its frame-hash check states its requirement as a hash, so a reader cannot see what it demands',
        'save-at-first-score':
          'its save-hash check states its requirement as a hash, so a reader cannot see what it demands',
      },
    })
    assert.deepEqual(good.score, { verified: 6, total: 6 })
    assert.equal(formatMilestoneScore(partial.score), '4 of 6')

    // A run that played Breakout and did not land on the pinned state scores
    // three of six. Three of four was the wrong statement: it removed two
    // points from the denominator that a policy can, and does, reach.
    const played = ['score-opened', 'score-tier-2', 'life-lost']
    assert.deepEqual(scoreMilestones(adapter.contract, played), { verified: 3, total: 6 })
    assert.equal(formatMilestoneScore(scoreMilestones(adapter.contract, played)), '3 of 6')

    // Calibration on the real emulator. Every baseline plays the reference's
    // 210 turns, so the comparison is length-matched.
    const calibration = calibrateContract(adapter.game, adapter.contract, {
      reference: adapter.reference,
      vocabulary: adapter.inputs,
      seed: adapter.seed,
    })
    for (const outcome of [calibration.reference, ...calibration.baselines]) {
      console.log(`  ${outcome.id.padEnd(32)} ${String(outcome.verified.length).padStart(2)}  ${outcome.verdict}  ${outcome.verified.join(',') || '-'}`)
    }
    assert.deepEqual(calibration.legible, ['score-opened', 'score-tier-2', 'score-tier-4', 'life-lost'])
    assert.deepEqual(calibration.opaque, ['frame-at-first-score', 'save-at-first-score'])
    assert.deepEqual(calibration.referenceScore, { verified: 6, total: 6 })
    // No trivial policy reproduced either hash. That was the whole of the
    // evidence #22 had for calling them unearnable, and it proves nothing: the
    // baseline suite cannot serve a ball, let alone score.
    assert.deepEqual(calibration.opaqueReproduced, [])

    // The substitution sweep is the prober that can. Both hashes fire after 32
    // inputs; the sweep replaces one input of that prefix at a time over
    // NOOP/FIRE/RIGHT/LEFT and counts the logs that still satisfy the check.
    // FIRE while the ball is already in flight is a state no-op, so a large
    // family of logs reaches a bit-identical emulator state.
    for (const row of calibration.collisions) {
      console.log(
        `  ${row.milestone.padEnd(24)} fires after ${row.firesAfter}; ` +
        `${row.collisions}/${row.substitutions} substitutions collide at ${row.freeTurns}/${row.probedTurns} turns; ` +
        `joint=${row.jointCollision}; family >= ${row.family.toExponential(2)}`,
      )
    }
    assert.deepEqual(calibration.collisions, ALE_BREAKOUT_COLLISIONS)

    // Undeclared, the contract cannot ship, whatever the separation verdict.
    assert.throws(() => assertOpaqueChecksDeclared(calibration), /states 2 of 6 milestone\(s\) as a hash/u)
    // Declaring them opaque is still not enough, because the sweep measured
    // the collisions. The author must accept the weakness by id.
    assert.throws(
      () => assertOpaqueChecksDeclared(calibration, { opaqueChecks: ['frame-at-first-score', 'save-at-first-score'] }),
      /2 opaque milestone\(s\) are satisfied by input logs other than the reference/u,
    )
    const declared = {
      opaqueChecks: ['frame-at-first-score', 'save-at-first-score'],
      weakChecks: ['frame-at-first-score', 'save-at-first-score'],
    }
    assertOpaqueChecksDeclared(calibration, declared)
    // Whether Breakout separates is a fact about the ROM, not about this
    // change: assert only that the legible comparison is the one being made.
    const referenceLegible = calibration.reference.verified.filter((id) => calibration.legible.includes(id)).length
    assert.equal(
      calibration.separates,
      calibration.separating.length > 0 && referenceLegible > calibration.bestBaselineLegibleCount,
    )
    if (calibration.separates) assertContractSeparates(calibration, declared)
    else assert.throws(() => assertContractSeparates(calibration, declared), /does not separate/u)
    console.log(
      `ale: calibration — reference ${formatMilestoneScore(calibration.referenceScore)}, ` +
      `best trivial baseline ${calibration.bestBaselineLegibleCount} legible over ${calibration.turns} turns, ` +
      `separating=${calibration.separating.join(',') || 'nothing'}, separates=${calibration.separates}`,
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
      `derivation, ${adapter.contract.milestones.length}-milestone contract over ${tiers.size} evidence tiers, ` +
      `known-good, false-claim, graded partial, cross-process determinism over ${first.length} snapshots ` +
      `(screen, save state, and engine state), checkpoint round-trip, unknown-input no-op, teardown OK ` +
      `(reference reaches score ${finalState.score} with ${finalState.lives} lives)`,
    )
  } finally {
    if (second) second.dispose()
    if (!disposed) adapter.dispose()
  }
}
