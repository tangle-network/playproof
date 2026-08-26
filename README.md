# Playproof

**Turn games into verifiable, cost-aware benchmarks for any agent.**

Playproof separates four concerns that game benchmarks often blur together:

1. **Execution.** Launch or emulate the game and apply one declared input at a time.
2. **Observation.** Show the evaluated agent only the allowed frame or text representation.
3. **Evidence.** Privately collect engine state, saves, events, rendered state, or platform receipts.
4. **Verification.** Recompute earned milestones and sign the exact run, build, contract, inputs, cost, and latency.

The agent can be an API model, a local policy, Claude Code, Codex CLI, OpenCode, a reinforcement-learning policy, a multi-agent system, or any custom harness. The core interface has no model, provider, orchestration, or sandbox dependency.

## Install

```bash
pnpm add @tangle-network/playproof
```

Node.js 20.19 or newer is required. Python is needed only by adapters whose worker is implemented in Python, such as PyBoy and the generic desktop worker.

## Minimal benchmark

```ts
import { generateKeyPairSync } from 'node:crypto'
import { executeBenchmark, type AgentDriver } from '@tangle-network/playproof'
import { makeNative2048, NATIVE_2048_INPUTS } from '@tangle-network/playproof/adapters/native-2048'

// Any BenchmarkTarget works. This one is bundled and needs no ROM.
const target = makeNative2048(0)

// Replace the body with a model call. Return one word from the game's
// vocabulary, and what the decision cost.
const driver: AgentDriver = {
  async act(frame, history, context) {
    return { input: NATIVE_2048_INPUTS[0]!, costUsd: 0 }
  },
}

const { privateKey } = generateKeyPairSync('ed25519')

const result = await executeBenchmark(target, driver, {
  budgetUsd: 1,
  maxTurns: 100,
  actor: { kind: 'agent', id: 'my-agent-v1' },
  signer: { privateKey, keyId: 'benchmark-recorder-v1' },
})

console.log(result.record.verified) // [ 'first-legal-move', 'first-merge' ]
console.log(result.signed)
```

`BenchmarkTarget` pins the game, exact build digest, platform capabilities, milestone contract, and reference inputs. `executeBenchmark` uses the shared episode engine, records every decision and measured cost, recomputes progression, and emits an Ed25519-signed publication envelope.

## Any agent

An agent is anything that implements one method.

```ts
interface AgentDriver {
  act(
    frame: string,
    history: readonly { input: string; frame: string }[],
    context: {
      turn: number
      maxTurns: number
      seed: number
      spentUsd: number
      remainingBudgetUsd: number
      guidance?: string
      observation?: { text: string; images?: readonly ObservationImage[] }
      signal?: AbortSignal
    },
  ): Promise<{ input: string; costUsd: number }>
}
```

No model, provider, orchestration or sandbox dependency. An API model, a local
policy, Claude Code, Codex CLI, OpenCode, a trained policy and a multi-agent
system all reach the game the same way. The verifier cannot tell them apart.

Ready-made drivers ship for an OpenAI-compatible endpoint, any CLI, a
persistent process, and an asynchronous sandbox. See
[docs/agent-drivers.md](docs/agent-drivers.md).

## Compare agents against each other

One benchmark says how an agent did on one game. An arena asks the question a
single game cannot: does the ranking survive a change of game?

```
profile.opus   harness=./harnesses/claude-code model=claude-opus-5 transport=persistent
profile.greedy harness=none policy=./policies/greedy              transport=persistent

game.puzzle    adapter=native-2048 target=2048
objective.score goal=maximize:score horizon=2000 budgetUsd=5
protocol.det   frameskip=1 sticky=0 seeds=1
sensor.ascii   pixels=off channels=-
reps 3
```

```bash
npx tsx matrix.mts study.matrix --out runs/study/cells.json
```

A cell is one profile, one game, one objective, one protocol, one sensor. None
of those has a default, because each one changes what the number means. The
runner plays every cell, attests every replay, and reports mean pairwise
Kendall tau-b between the per-game rankings.

Two facts the arena exists to keep visible:

- **How an agent is asked for a decision changes its score more than the model
  does.** The same program scores 4 under one process per decision and 1948
  under one process per episode.
- **A profile can be asked to build a player instead of playing one.** It gets
  a practice game and a build budget, leaves an executable behind, and that
  program is scored cold. Build cost is reported apart from the score.

See [docs/arena.md](docs/arena.md).

## When an episode ends

An episode has three stop conditions, and the record names the one that fired.

| `record.stoppedBy` | What happened |
|---|---|
| `maxTurns` | The turn limit was reached. |
| `budget` | The dollar budget was reached. |
| `gameOver` | The game reported that it is finished. |

The game-over stop is opt-in, because episode length is a denominator. Two
rounds of a study compare only if both played to the same turn limit.

```ts
const { record } = await playEpisode(game, contract, driver, budgetUsd, maxTurns, seed, signal, {
  stopAtGameOver: true,
})
```

Every record carries `gameOver` whether or not the stop is armed. A record that
says `stoppedBy: 'maxTurns'` next to `gameOver: true` kept paying for decisions
after the game was over. On ALE Breakout that was 150 of 300 decisions, and
every evidence channel was byte-identical across them.

See [docs/episodes.md](docs/episodes.md).

## Exploration and onboarding

A game can be benchmarked when a bridge provides:

1. a finite input vocabulary;
2. an observation channel;
3. at least one progression signal the agent cannot directly author; and
4. an honest verification declaration.

Reference trajectories can come from a human, a scripted policy, another agent, platform events, or deterministic frontier exploration. Blind discovery can identify candidate changing memory channels before a game-specific semantic adapter is written.

“Any game” does not mean zero integration. It means the benchmark core remains unchanged while the platform bridge declares inputs, observations, evidence, trust, and calibration. Anti-cheat-protected or networked games may only permit platform receipts or approved title-side instrumentation.

## Documentation

| | |
|---|---|
| [Agent drivers](docs/agent-drivers.md) | The four transports, and writing your own. |
| [Arena](docs/arena.md) | Profiles, games, protocols, sensors, authoring, transfer. |
| [Adapters](docs/adapters.md) | Every bridge, what it proves, and what it does not. |
| [Observation](docs/observation.md) | Text and pixels, and where the boundary sits. |
| [Verification](docs/verification.md) | Modes, evidence tiers, milestone contracts, signing. |
| [Calibration](docs/calibration.md) | Whether a contract separates skill from noise. |
| [Episodes](docs/episodes.md) | Stop conditions and the game-over rule. |
| [Long-horizon runs](docs/long-horizon.md) | Segments, steering, resume, analysts. |
| [Releasing](docs/releasing.md) | How a version is cut and published. |

## Security boundary

Playproof does not implement DLL injection, runtime patching, anti-cheat bypasses, credential extraction, arbitrary memory writes, network manipulation, or shell-string evaluation.

Unknown and control-character desktop inputs are no-ops. Worker frames, helper output, HTTP bodies, save files, and event files are bounded while being read. Credentials remain in caller-owned driver or adapter configuration and are not included in signed benchmark artifacts.

Observation images are bounded the same way: a declared media type checked against the file's own magic bytes, canonical base64, a per-image byte and dimension cap, and a per-turn total. A breach fails the turn instead of quietly showing the agent something smaller.

Please report vulnerabilities through the process in [SECURITY.md](SECURITY.md).

## Development

```bash
corepack enable
corepack prepare pnpm@11.17.0 --activate
pnpm install
pnpm ci
```

The release gate runs boundary checks, strict typechecking, adversarial tests, a production build, an exact packed-tarball audit, and clean-consumer imports for every public subpath.

Real PyBoy controls additionally require a legally obtained ROM matching the pinned reference identity:

```bash
PLAYPROOF_ROM=/legal/path/Tetris.gb \
PLAYPROOF_PYTHON=python \
pnpm test:pyboy
```

The stable-retro and ALE gates need no ROM, because both emulators ship one:

```bash
pip install stable-retro
PLAYPROOF_REQUIRE_RETRO=1 pnpm test:retro

pip install ale-py
PLAYPROOF_REQUIRE_ALE=1 pnpm test:ale
```

## License

Apache-2.0.

## Citation

If you use Playproof in your work, please cite it:

```bibtex
@software{stone_yaish_playproof,
  author = {Stone, Drew and Yaish, Aviv},
  title  = {Playproof},
  url    = {https://github.com/tangle-network/playproof}
}
```

Machine-readable citation metadata is available in [`CITATION.cff`](CITATION.cff).
