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
 * and worker teardown. About 20s, zero model spend.
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { attestRun } from './attestation'
import { logFrom } from './runtime'
import { validateContract } from './schema'
import { RetroRpc } from './adapters/retro-rpc'
import { bundledReference, makeStableRetro, type RetroState, type StableRetro } from './adapters/stable-retro'

const GAME = 'Airstriker-Genesis'
const python = process.env.PLAYPROOF_PYTHON ?? 'python3'

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
