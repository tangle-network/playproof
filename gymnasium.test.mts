/**
 * Gymnasium adapter test — the generic-environment real-substrate gate.
 *
 * Runs on CartPole-v1 and FrozenLake-v1, both part of Gymnasium itself, so it
 * needs no asset. Skips with one line when gymnasium is absent, unless
 * PLAYPROOF_REQUIRE_GYM=1, which turns the missing dependency into a loud
 * failure (that is how CI proves the job really executed).
 *
 * Battery: contract derivation, known-good attestation, graded partial
 * replay, garbage rejection, cross-process determinism, both checkpoint paths,
 * unknown-input no-op, terminated-episode freeze, and worker teardown.
 * About 10s, zero model spend.
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { attestRun } from './attestation'
import { playEpisode, scriptedDriver } from './episode'
import { logFrom } from './runtime'
import { validateContract } from './schema'
import { GymRpc } from './adapters/gym-rpc'
import { bundledReference, makeGymnasium, type Gymnasium, type GymState } from './adapters/gymnasium'

const CARTPOLE = 'CartPole-v1'
const FROZENLAKE = 'FrozenLake-v1'
const python = process.env.PLAYPROOF_PYTHON ?? 'python3'

/**
 * Probe from a temporary directory, never from the repository root: Playproof's
 * own `gym/` worker directory sits on `sys.path[0]` and would shadow a package
 * of that name. Making both environments proves the library and its optional
 * toy-text extra are really installed.
 */
function pythonHasGymnasium(): boolean {
  const probe = [
    'import gymnasium',
    `gymnasium.make('${CARTPOLE}').close()`,
    `gymnasium.make('${FROZENLAKE}', is_slippery=False).close()`,
  ].join('; ')
  return spawnSync(python, ['-c', probe], { encoding: 'utf8', cwd: tmpdir() }).status === 0
}

if (!pythonHasGymnasium()) {
  const hint = `gymnasium is not importable from ${python}; install it with \`${python} -m pip install "gymnasium[toy-text]"\` (both reference environments ship with the library, so no download is needed)`
  if (process.env.PLAYPROOF_REQUIRE_GYM === '1') {
    throw new Error(`PLAYPROOF_REQUIRE_GYM=1 but ${hint}`)
  }
  console.log(`gymnasium: skip: ${hint}`)
} else {
  /** One replay of a script, recorded as the evidence a verifier would recompute. */
  const trace = (adapter: Gymnasium, inputs: readonly string[]): string[] => {
    let state: GymState = adapter.game.init(adapter.seed)
    const out: string[] = []
    const record = (s: GymState): void => {
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

  const cartpole = makeGymnasium({ envId: CARTPOLE })
  let lake: Gymnasium | null = null
  let second: Gymnasium | null = null
  let disposed = false
  try {
    // Identity: a discrete environment with no action meanings advertises
    // positional names plus the declared no-op.
    assert.equal(cartpole.game.id, 'gymnasium-CartPole-v1')
    assert.equal(cartpole.identity.actionSpace, 'Discrete(2)')
    assert.deepEqual(cartpole.inputs, ['NOOP', 'a0', 'a1'])
    assert.equal(cartpole.identity.rewardScale, 1000)

    // Authoring: contract derived from the reference with event-anchored
    // marks. No hash, position, or threshold is typed into the adapter.
    const reference = bundledReference(CARTPOLE)!
    assert.deepEqual(validateContract(cartpole.contract), [])
    assert.equal(cartpole.contract.milestones.length, reference.milestones.length)
    const cartKinds = new Set(cartpole.contract.milestones.map((m) => m.check.kind))
    assert.ok(cartKinds.has('state-path') && cartKinds.has('frame-hash'),
      `expected state-path and frame-hash checks, got ${[...cartKinds].join(',')}`)

    // Known-good: the reference verifies every milestone.
    const all = cartpole.contract.milestones.map((m) => m.id)
    const good = attestRun(cartpole.game, cartpole.contract, cartpole.seed, logFrom(cartpole.seed, [...cartpole.reference]), all)
    assert.equal(good.verdict, 'clean', `reference rejected: ${good.reasons.join('; ')}`)
    assert.deepEqual(good.verified, all)

    // False claim: a garbage script of the same length claiming the same
    // milestones is rejected. The words mix real actions that drop the pole
    // with nonsense that maps to a no-op.
    const garbageWords = ['a0', 'a0', 'a1', 'flibbertigibbet']
    const garbage = cartpole.reference.map((_, i) => garbageWords[i % garbageWords.length]!)
    const rejected = attestRun(cartpole.game, cartpole.contract, cartpole.seed, logFrom(cartpole.seed, garbage), all)
    assert.equal(rejected.verdict, 'rejected')
    assert.deepEqual(rejected.verified, [])
    assert.ok(rejected.reasons.some((r) => r.startsWith('claimed-not-reproduced')), rejected.reasons.join('; '))

    // Graded, not all-or-nothing: a partial replay earns the milestones it
    // actually reached and is rejected only for the ones it claims beyond.
    const partial = attestRun(cartpole.game, cartpole.contract, cartpole.seed, logFrom(cartpole.seed, cartpole.reference.slice(0, 30)), all)
    assert.equal(partial.verdict, 'rejected')
    assert.deepEqual(partial.verified, ['survived-25-steps', 'reward-at-25-steps', 'frame-at-25-steps'])
    assert.deepEqual(partial.reasons, ['claimed-not-reproduced:survived-50-steps,reward-at-50-steps'])

    // Determinism: two replays in this worker and one in a freshly spawned
    // worker must agree on every frame hash and every evidence field.
    // Cross-process is the load-bearing case, because a verifier never shares
    // the environment that produced the run.
    const first = trace(cartpole, cartpole.reference)
    const again = trace(cartpole, cartpole.reference)
    assert.deepEqual(again, first, 'same-process replay diverged')
    second = makeGymnasium({ envId: CARTPOLE })
    const other = trace(second, cartpole.reference)
    assert.deepEqual(other, first, 'cross-process replay diverged')
    assert.equal(first.length, cartpole.reference.length + 1)
    second.dispose()
    second = null

    // Unknown inputs are no-ops, not cheats and not errors. A discrete
    // environment has no guaranteed idle action, so a no-op does not step it.
    const junkWords = ['FLIBBERTIGIBBET', '', 'nope', 'a2-not-an-action', 'NOOP']
    let junkState = cartpole.game.init(cartpole.seed)
    const beforeJunk = cartpole.game.evidence(junkState)
    for (const word of junkWords) junkState = cartpole.game.step(junkState, word)
    assert.deepEqual(cartpole.game.evidence(junkState), beforeJunk)

    // Both checkpoint paths round-trip: the fast one writes the environment's
    // own state attribute back, the general one rebuilds from the seed and
    // replays. Garbage is rejected instead of silently accepted.
    const rpc = new GymRpc()
    try {
      rpc.boot({ envId: CARTPOLE, seed: cartpole.seed })
      for (const input of cartpole.reference.slice(0, 40)) rpc.step(input)
      const ahead = cartpole.reference.slice(40, 48)
      for (const mode of ['engine', 'replay'] as const) {
        const checkpoint = rpc.snapshot(mode)
        assert.equal(checkpoint.kind, mode)
        const forward = ahead.map((w) => JSON.stringify(rpc.step(w).evidence))
        const restored = rpc.restore(checkpoint)
        assert.equal(restored.frame, 40)
        const replayed = ahead.map((w) => JSON.stringify(rpc.step(w).evidence))
        assert.deepEqual(replayed, forward, `${mode} checkpoint restore did not reproduce the same evidence`)
        rpc.restore(checkpoint)
      }
      assert.throws(() => rpc.restore({ nope: true } as never), /not a Playproof Gymnasium checkpoint/)
    } finally {
      rpc.shutdown()
    }

    // FrozenLake: a different observation space, a text frame, and a reward
    // that only a winning path produces.
    lake = makeGymnasium({ envId: FROZENLAKE })
    const lakeAll = lake.contract.milestones.map((m) => m.id)
    assert.deepEqual(validateContract(lake.contract), [])
    assert.deepEqual(lake.inputs, ['NOOP', 'a0', 'a1', 'a2', 'a3'])
    const lakeKinds = new Set(lake.contract.milestones.map((m) => m.check.kind))
    assert.ok(lakeKinds.has('state-path') && lakeKinds.has('frame-hash') && lakeKinds.has('frame-path'),
      `expected state-path, frame-hash and frame-path checks, got ${[...lakeKinds].join(',')}`)
    const lakeGood = attestRun(lake.game, lake.contract, lake.seed, logFrom(lake.seed, [...lake.reference]), lakeAll)
    assert.equal(lakeGood.verdict, 'clean', `frozenlake reference rejected: ${lakeGood.reasons.join('; ')}`)
    assert.deepEqual(lakeGood.verified, lakeAll)

    // Walking into a hole earns nothing, and the frozen episode stays frozen:
    // further inputs after termination leave the evidence unchanged.
    const drowned = attestRun(lake.game, lake.contract, lake.seed, logFrom(lake.seed, ['a1', 'a2', 'a2', 'a2', 'a2', 'a2']), lakeAll)
    assert.equal(drowned.verdict, 'rejected')
    assert.deepEqual(drowned.verified, [])
    let ended = lake.game.init(lake.seed)
    for (const input of lake.reference) ended = lake.game.step(ended, input)
    const atEnd = lake.game.evidence(ended)
    assert.equal(atEnd.engineState!.terminated, 1)
    for (const input of ['a0', 'a1', 'a2']) ended = lake.game.step(ended, input)
    assert.deepEqual(lake.game.evidence(ended), atEnd, 'a terminated episode kept stepping')

    // The game-over stop on a second real substrate. FrozenLake terminates
    // when the walk reaches the goal, and the worker freezes the environment
    // there, so every later decision is inert exactly as ALE's is.
    // Bound once: the driver factory is a closure, and `lake` is the mutable
    // handle the teardown clears.
    const frozenLake = lake
    const LAKE_TURNS = frozenLake.reference.length + 20
    const walk = () => scriptedDriver([...frozenLake.reference])
    const lakeFull = await playEpisode(frozenLake.game, frozenLake.contract, walk(), 1, LAKE_TURNS, frozenLake.seed)
    const lakeStopped = await playEpisode(
      frozenLake.game, frozenLake.contract, walk(), 1, LAKE_TURNS, frozenLake.seed, undefined, { stopAtGameOver: true },
    )
    assert.equal(lakeFull.record.turns, LAKE_TURNS)
    assert.equal(lakeFull.record.stoppedBy, 'maxTurns')
    assert.equal(lakeFull.record.gameOver, true)
    assert.equal(lakeStopped.record.turns, frozenLake.reference.length)
    assert.equal(lakeStopped.record.stoppedBy, 'gameOver')
    assert.deepEqual(lakeStopped.record.verified, lakeAll)
    assert.deepEqual(lakeStopped.record.verified, lakeFull.record.verified)
    assert.equal(lakeStopped.record.verdict, 'clean')
    assert.equal(lakeStopped.record.replayDivergence, false)
    const lakeRecomputed = attestRun(frozenLake.game, frozenLake.contract, frozenLake.seed, lakeStopped.log, [...lakeStopped.record.verified])
    assert.equal(lakeRecomputed.verdict, 'clean', lakeRecomputed.reasons.join('; '))

    // Determinism across processes on the second environment too.
    const lakeFirst = trace(lake, lake.reference)
    second = makeGymnasium({ envId: FROZENLAKE })
    assert.deepEqual(trace(second, lake.reference), lakeFirst, 'frozenlake cross-process replay diverged')

    // Unsupported action spaces fail at boot with a readable message.
    assert.throws(
      () => makeGymnasium({ envId: 'Pendulum-v1', reference: { ...bundledReference(CARTPOLE)!, envId: 'Pendulum-v1' } }),
      /supports Discrete only/,
    )

    // Teardown: dispose kills the worker and every later call fails loudly
    // instead of silently reading a dead transport.
    second.dispose()
    second = null
    lake.dispose()
    lake = null
    cartpole.dispose()
    disposed = true
    assert.throws(() => cartpole.game.init(cartpole.seed), /closed/)

    const finalState = JSON.parse(first[first.length - 1]!)[1]
    console.log(
      `gymnasium: ${cartpole.identity.envId} on ${cartpole.identity.actionSpace} and ${FROZENLAKE} — ` +
      `derivation, ${cartpole.contract.milestones.length}+${lakeAll.length}-milestone contracts, known-good, ` +
      `graded partial, false-claim, cross-process determinism over ${first.length} snapshots, ` +
      `engine and replay checkpoints, unknown-input no-op, ` +
      `game-over stop at ${lakeStopped.record.turns} of ${LAKE_TURNS} FrozenLake decisions ` +
      `(${lakeFull.record.turns - lakeStopped.record.turns} dropped, milestones unchanged), teardown OK ` +
      `(reference balances ${finalState.steps} steps for reward ${finalState.cumulativeReward / 1000})`,
    )
  } finally {
    if (second) second.dispose()
    if (lake) lake.dispose()
    if (!disposed) cartpole.dispose()
  }
}
