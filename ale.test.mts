/**
 * ALE adapter test — the Atari real-substrate gate.
 *
 * Runs on Breakout from the ROM set ale-py bundles, so it needs no
 * user-supplied game and no download. Skips with one line when ale-py is
 * absent, unless PLAYPROOF_REQUIRE_ALE=1, which turns the missing dependency
 * into a loud failure (that is how CI proves the job really executed).
 *
 * Battery: contract derivation across three evidence tiers, known-good
 * attestation, garbage rejection, graded partial credit, cross-process
 * determinism including the save-state hash, checkpoint round-trip,
 * unknown-input no-op, and worker teardown. Zero model spend.
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { attestRun } from './attestation'
import { logFrom } from './runtime'
import { validateContract } from './schema'
import { AleRpc } from './adapters/ale-rpc'
import { bundledReference, makeAle, type Ale, type AleState } from './adapters/ale'

const GAME = 'breakout'
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
