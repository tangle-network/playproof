/**
 * stable-retro adapter test — the multi-console real-substrate gate.
 *
 * Runs on Airstriker-Genesis, the free ROM stable-retro ships, so it needs no
 * user-supplied game. Skips with one line when stable-retro is absent, unless
 * PLAYPROOF_REQUIRE_RETRO=1, which turns the missing dependency into a loud
 * failure (that is how CI proves the job really executed).
 *
 * Battery: contract derivation, known-good attestation, garbage rejection,
 * cross-process determinism, checkpoint round-trip, unknown-input no-op,
 * the observation image channel, and worker teardown. About 20s, zero model
 * spend.
 */
import { strict as assert } from 'node:assert'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { attestRun } from './attestation'
import { calibrateContract, PackagedContract } from './calibration'
import { logFrom, observationOf } from './runtime'
import { decodePng, unscale } from './test-png.mts'
import { formatMilestoneScore, validateContract } from './schema'
import { RetroRpc } from './adapters/retro-rpc'
import { bundledReference, makeStableRetro, type RetroState, type StableRetro } from './adapters/stable-retro'

const GAME = 'Airstriker-Genesis'
/**
 * The interpreter, resolved against the CALLER's directory.
 *
 * A probe below runs with `cwd: tmpdir()` so it cannot import from the repo by
 * accident, which means a relative `PLAYPROOF_PYTHON` never resolves and the
 * gate reports the package missing when the real fault is the path. Measured:
 * `PLAYPROOF_PYTHON=./.venv/bin/python` produced "stable-retro is not
 * importable", advising an install of software that was already installed.
 *
 * A bare name like `python3` is left alone for PATH lookup.
 */
const rawPython = process.env.PLAYPROOF_PYTHON ?? 'python3'
const python = rawPython.includes('/') ? resolve(rawPython) : rawPython

/**
 * Probe from a temporary directory, never from the repository root: Playproof's
 * own `retro/` worker directory is a namespace package that shadows the
 * installed `retro` on `sys.path[0]`, so a plain `import retro` here would pass
 * without the emulator. Importing `retro.data` and listing the integrations
 * proves the real package and its game data are present.
 */
function pythonHasRetro(): boolean {
  const probe = 'import retro.data, sys; sys.exit(0 if retro.data.list_games() else 1)'
  return spawnSync(python, ['-c', probe], { encoding: 'utf8', cwd: tmpdir() }).status === 0
}

if (!pythonHasRetro()) {
  const hint = `stable-retro is not importable from ${python}; install it with \`${python} -m pip install stable-retro\` (it bundles the Airstriker-Genesis ROM, so no download is needed)`
  if (process.env.PLAYPROOF_REQUIRE_RETRO === '1') {
    throw new Error(`PLAYPROOF_REQUIRE_RETRO=1 but ${hint}`)
  }
  console.log(`stable-retro: skip: ${hint}`)
} else {
  /** One replay of a script, recorded as the evidence a verifier would recompute. */
  const trace = (adapter: StableRetro, inputs: readonly string[]): string[] => {
    let state: RetroState = adapter.game.init(adapter.seed)
    const out: string[] = []
    const record = (s: RetroState): void => {
      const e = adapter.game.evidence(s)
      out.push(JSON.stringify([e.frameHash, e.engineState, e.frameState]))
    }
    record(state)
    for (const input of inputs) {
      state = adapter.game.step(state, input)
      record(state)
    }
    return out
  }

  const reference = bundledReference(GAME)!
  const adapter = makeStableRetro({ game: GAME })
  let second: StableRetro | null = null
  let disposed = false
  try {
    // Identity: the core loaded the ROM the reference pins.
    assert.equal(adapter.identity.romSha, reference.romSha)
    assert.equal(adapter.game.id, 'stable-retro-Airstriker-Genesis')
    assert.ok(adapter.inputs.includes('NOOP') && adapter.inputs.includes('LEFT+B'),
      `input vocabulary missing expected words: ${adapter.inputs.join(',')}`)

    // Authoring: contract derived from the reference with event-anchored
    // marks. No hash, position, or threshold is typed into the adapter.
    assert.deepEqual(validateContract(adapter.contract), [])
    assert.equal(adapter.contract.milestones.length, reference.milestones.length)
    const tiers = new Set(adapter.contract.milestones.map((m) => m.tier))
    assert.ok(tiers.has('engine-state') && tiers.has('screen-frame'),
      `expected engine-state and screen-frame tiers, got ${[...tiers].join(',')}`)
    const kinds = new Set(adapter.contract.milestones.map((m) => m.check.kind))
    assert.ok(kinds.has('state-path') && kinds.has('frame-hash') && kinds.has('frame-path'),
      `expected state-path, frame-hash and frame-path checks, got ${[...kinds].join(',')}`)

    // Known-good: the reference verifies every milestone.
    const all = adapter.contract.milestones.map((m) => m.id)
    const good = attestRun(adapter.game, adapter.contract, adapter.seed, logFrom(adapter.seed, [...adapter.reference]), all)
    assert.equal(good.verdict, 'clean', `reference rejected: ${good.reasons.join('; ')}`)
    assert.deepEqual(good.verified, all)

    // False claim: a garbage script of the same length claiming the same
    // milestones is rejected. The words are a mix of real buttons that do not
    // shoot and nonsense that maps to a no-op.
    const garbageWords = ['UP', 'DOWN', 'START', 'MODE', 'wiggle', 'flibbertigibbet', 'A', 'C']
    const garbage = adapter.reference.map((_, i) => garbageWords[i % garbageWords.length]!)
    const rejected = attestRun(adapter.game, adapter.contract, adapter.seed, logFrom(adapter.seed, garbage), all)
    assert.equal(rejected.verdict, 'rejected')
    assert.ok(rejected.reasons.some((r) => r.startsWith('claimed-not-reproduced')), rejected.reasons.join('; '))
    assert.deepEqual(rejected.verified, [])

    // Graded, not all-or-nothing: a partial replay earns the milestones it
    // actually reached and is rejected only for the ones it claims beyond.
    const partial = attestRun(adapter.game, adapter.contract, adapter.seed, logFrom(adapter.seed, adapter.reference.slice(0, 45)), all)
    assert.equal(partial.verdict, 'rejected')
    assert.deepEqual(partial.verified, ['score-opened', 'frame-at-first-score', 'screen-active-at-first-score'])
    assert.deepEqual(partial.reasons, ['claimed-not-reproduced:score-tier-2,life-lost'])

    // Determinism: two replays in this worker and one in a freshly spawned
    // worker must agree on every frame hash and every privileged variable.
    // Cross-process is the load-bearing case, because a verifier never shares
    // the emulator that produced the run.
    const first = trace(adapter, adapter.reference)
    const again = trace(adapter, adapter.reference)
    assert.deepEqual(again, first, 'same-process replay diverged')
    second = makeStableRetro({ game: GAME })
    const other = trace(second, adapter.reference)
    assert.deepEqual(other, first, 'cross-process replay diverged')
    assert.equal(first.length, adapter.reference.length + 1)

    // Unknown inputs are no-ops, not cheats and not errors.
    const junkWords = ['FLIBBERTIGIBBET', '', 'nope', 'B-not-a-button']
    let junkState = adapter.game.init(adapter.seed)
    for (const word of junkWords) junkState = adapter.game.step(junkState, word)
    let noopState = adapter.game.init(adapter.seed)
    for (const _ of junkWords) noopState = adapter.game.step(noopState, 'NOOP')
    assert.deepEqual(adapter.game.evidence(junkState), adapter.game.evidence(noopState))

    // Checkpoints: a save state restores to the exact emulator instant, so
    // the same inputs after a restore produce the same evidence. This is what
    // frontier exploration needs, and it holds even though the raw save bytes
    // are not comparable across processes.
    const rpc = new RetroRpc()
    try {
      rpc.boot({ game: GAME, frameskip: reference.frames, seed: reference.seed })
      for (const input of adapter.reference.slice(0, 44)) rpc.step(input)
      const checkpoint = rpc.snapshot()
      const ahead = ['B', 'NOOP', 'LEFT', 'B'].map((w) => JSON.stringify(rpc.step(w).evidence))
      const restored = rpc.restore(checkpoint)
      assert.equal(restored.gen, 1)
      const replayed = ['B', 'NOOP', 'LEFT', 'B'].map((w) => JSON.stringify(rpc.step(w).evidence))
      assert.deepEqual(replayed, ahead, 'checkpoint restore did not reproduce the same evidence')
      assert.throws(() => rpc.restore(Buffer.from('not a checkpoint')), /worker restore failed/)
    } finally {
      rpc.shutdown()
    }

    // Observation images: the worker encodes the SAME observation buffer it
    // hashes for evidence. The default adapter above published none, which is
    // the point of the option: the byte cost is unchanged until a caller asks.
    assert.equal(adapter.identity.screenImage, false)
    assert.equal('images' in observationOf(adapter.game, adapter.game.init(adapter.seed)), false)

    const vision = makeStableRetro({ game: GAME, screenImage: true, screenScale: 2 })
    try {
      assert.equal(vision.identity.screenImage, true)
      let seen = vision.game.init(vision.seed)
      for (const input of vision.reference.slice(0, 44)) seen = vision.game.step(seen, input)
      const observation = observationOf(vision.game, seen)
      assert.equal(observation.text, vision.game.frame(seen))
      assert.equal(observation.images?.length, 1)
      const image = observation.images![0]!
      assert.equal(image.mediaType, 'image/png')
      const decoded = decodePng(Buffer.from(image.base64, 'base64'), { expectFilterNone: true })
      assert.deepEqual([image.width, image.height], [decoded.width, decoded.height])
      assert.ok(decoded.colours > 1, 'the encoded screen is one flat colour')

      // The picture the agent is shown is the screen the verifier hashes:
      // undoing the whole-pixel upscale recovers the native buffer, and its
      // SHA-256 is `frameHash`.
      const native = createHash('sha256').update(unscale(decoded, 2)).digest('hex')
      assert.equal(native, vision.game.evidence(seen).frameHash)

      // The image path does not perturb the emulator.
      let plain = adapter.game.init(adapter.seed)
      for (const input of adapter.reference.slice(0, 44)) plain = adapter.game.step(plain, input)
      assert.deepEqual(vision.game.evidence(seen), adapter.game.evidence(plain))
      console.log(
        `stable-retro: observation image — ${decoded.width}x${decoded.height} PNG, ` +
        `${Buffer.from(image.base64, 'base64').length} bytes encoded, ${decoded.colours} distinct colours, ` +
        'pixels hash to frameHash, evidence unchanged',
      )
    } finally {
      vision.dispose()
    }

    // Calibration on the packaged Airstriker contract.
    //
    // Nothing in the path from `deriveContract` to a published target used to
    // ask for this, and the answer is that the contract does not separate: the
    // separating set is EMPTY. A seeded pseudo-random walk over the 25 advertised
    // button words earns three of the four legible milestones, the same three
    // the reference earns, and the fourth is a hash. Reporting it is the point:
    // a contract that grades nothing must not look like one that grades play.
    // The sweep is capped at 8 probed turns here. Genesis is the slowest
    // substrate in the suite and this console advertises 25 input words, so a
    // full 32-turn sweep costs 24,000 emulator steps for a number the first
    // eight turns already establish.
    const calibration = calibrateContract(adapter.game, adapter.contract, {
      reference: adapter.reference,
      vocabulary: adapter.inputs,
      seed: adapter.seed,
      collisionTurns: 8,
    })
    assert.deepEqual(calibration.reference.verified, adapter.contract.milestones.map((m) => m.id))
    assert.deepEqual(calibration.separating, [])
    assert.equal(calibration.separates, false)
    assert.equal(calibration.bestBaselineAchievementCount, 3)
    assert.deepEqual(calibration.trivial, ['score-opened', 'screen-active-at-first-score', 'score-tier-2'])

    // `life-lost` is `lives == 2` from a start of 3: earned by dying, on a
    // channel measured falling 18 times and never rising across 29 replayed
    // trajectories. It is the one milestone no baseline reached, and before
    // this split it was the contract's whole claim to discriminating power.
    assert.deepEqual(calibration.progression.attrition, ['life-lost'])
    assert.deepEqual(calibration.attritionSeparating, ['life-lost'])
    assert.equal(calibration.progression.motion.find((row) => row.channel === 'engineState.lives')?.rises, 0)

    // Every milestone requires `score-opened`, which two baselines earn, so the
    // whole contract opens for free; and three of the five open at one instant.
    assert.equal(calibration.collapse.prerequisite, 'score-opened')
    assert.equal(calibration.collapse.gated, 5)
    assert.equal(calibration.collapse.total, 5)
    assert.equal(calibration.collapse.collapses, true)
    assert.deepEqual(calibration.collapse.earnedByBaseline, ['round-robin', 'pseudo-random'])
    assert.deepEqual(
      calibration.collapse.simultaneous,
      ['score-opened', 'frame-at-first-score', 'screen-active-at-first-score'],
    )

    // The hash is weak by a wide margin: a large family of logs reaches the
    // state it names, measured rather than assumed.
    const collision = calibration.collisions[0]!
    assert.equal(collision.milestone, 'frame-at-first-score')
    assert.ok(collision.collisions > 0, 'the sweep found no colliding log for the pinned frame')
    assert.equal(collision.jointCollision, true)

    // A packaged contract cannot be published without a verdict, and this one
    // has no verdict to publish.
    assert.throws(
      () => PackagedContract.calibrate(adapter.game, adapter.contract, {
        reference: adapter.reference,
        vocabulary: adapter.inputs,
        seed: adapter.seed,
        collisionTurns: 8,
        declare: {
          opaqueChecks: ['frame-at-first-score'],
          weakChecks: ['frame-at-first-score'],
          attritionChecks: ['life-lost'],
          gatedBehind: 'score-opened',
        },
      }),
      /does not separate/u,
    )
    console.log(
      `stable-retro: calibration — reference ${formatMilestoneScore(calibration.referenceScore)}, ` +
      `achievements ${formatMilestoneScore(calibration.referenceAchievementScore)}, ` +
      `best baseline ${calibration.bestBaselineCount} over ${calibration.turns} turns, ` +
      `separating=${calibration.separating.join(',') || 'NOTHING'}, ` +
      `attrition-only=${calibration.attritionSeparating.join(',') || 'nothing'}, ` +
      `separates=${calibration.separates}, collapses=${calibration.collapse.collapses}, ` +
      `${collision.collisions} of ${collision.substitutions} substitutions reproduce the pinned frame`,
    )

    // Teardown: dispose kills the worker and every later call fails loudly
    // instead of silently reading a dead transport.
    second.dispose()
    second = null
    adapter.dispose()
    disposed = true
    assert.throws(() => adapter.game.init(adapter.seed), /closed/)

    const finalScore = JSON.parse(first[first.length - 1]!)[1].score
    console.log(
      `stable-retro: ${adapter.identity.game} on ${adapter.identity.buttons.length} buttons — ` +
      `derivation, ${adapter.contract.milestones.length}-milestone contract, known-good, false-claim, ` +
      `cross-process determinism over ${first.length} snapshots, checkpoint round-trip, ` +
      `unknown-input no-op, teardown OK (reference reaches score ${finalScore})`,
    )
  } finally {
    if (second) second.dispose()
    if (!disposed) adapter.dispose()
  }
}
