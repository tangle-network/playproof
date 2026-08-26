# Playproof

**Turn games into verifiable, cost-aware benchmarks for any agent.**

Playproof separates four concerns that game benchmarks often blur together:

1. **Execution** — launch or emulate the game and apply one declared input at a time.
2. **Observation** — show the evaluated agent only the allowed frame or text representation.
3. **Evidence** — privately collect engine state, saves, events, rendered state, or platform receipts.
4. **Verification** — recompute earned milestones and sign the exact run, build, contract, inputs, cost, and latency.

The agent can be an API model, a local policy, Claude Code, Codex CLI, OpenCode, a reinforcement-learning policy, a multi-agent system, or any custom harness. The core interface has no model, provider, orchestration, or sandbox dependency.

## Install

```bash
pnpm add @tangle-network/playproof
```

Node.js 20.19 or newer is required. Python is needed only by adapters whose worker is implemented in Python, such as PyBoy and the generic desktop worker.

## Minimal benchmark

```ts
import {
  executeBenchmark,
  type AgentDriver,
  type BenchmarkTarget,
} from '@tangle-network/playproof'

const driver: AgentDriver = {
  async act(frame, history, context) {
    const input = await chooseAction({
      frame,
      history,
      remainingBudgetUsd: context.remainingBudgetUsd,
    })
    return { input, costUsd: 0 }
  },
}

const result = await executeBenchmark(
  target satisfies BenchmarkTarget<unknown>,
  driver,
  {
    budgetUsd: 1,
    maxTurns: 100,
    actor: { kind: 'agent', id: 'my-agent-v1' },
    signer: { privateKey, keyId: 'benchmark-recorder-v1' },
  },
)

console.log(result.record.verified)
console.log(result.signed)
```

`BenchmarkTarget` pins the game, exact build digest, platform capabilities, milestone contract, and reference inputs. `executeBenchmark` uses the shared episode engine, records every decision and measured cost, recomputes progression, and emits an Ed25519-signed publication envelope.

## Any agent means any agent

The complete contract is deliberately small:

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

`guidance` carries the latest supervisor or analyst note of a long-horizon run.
It is out-of-band context, never evidence, and never part of the input log.

`observation` is the same turn's full observation. `observation.text` is exactly the `frame` argument, so a text-only driver can ignore the field.

Playproof includes two optional conveniences:

### OpenAI-compatible HTTP

```ts
import { createOpenAICompatibleDriver } from '@tangle-network/playproof/drivers/openai-compatible'

const driver = createOpenAICompatibleDriver({
  baseUrl: 'https://your-endpoint.example/v1',
  apiKey: process.env.AGENT_API_KEY,
  model: 'your-model',
  commands: ['up', 'down', 'left', 'right'],
  pricing: {
    inputPerMillionUsd: 1,
    outputPerMillionUsd: 4,
  },
})
```

### Any CLI or coding harness

```ts
import { createCliAgentDriver } from '@tangle-network/playproof/drivers/cli'

const driver = createCliAgentDriver({
  command: '/opt/my-agent',
  args: ['--one-turn'],
  stdin: 'json',
  output: 'json',
  commands: ['left', 'right'],
  timeoutMs: 120_000,
  maxOutputBytes: 2 << 20,
})
```

The CLI driver spawns without a shell and bounds time and output. It can invoke Claude Code, Codex CLI, OpenCode, Pi, a local executable, or a container entrypoint. See [Agent drivers](docs/agent-drivers.md) and `examples/` for complete integrations, including a caller-supplied Tangle Agent Runtime backend.

## When an episode ends

An episode has three stop conditions, and the record names the one that fired.

| `record.stoppedBy` | What happened |
|---|---|
| `maxTurns` | The turn limit was reached. |
| `budget` | The dollar budget was reached. |
| `gameOver` | The game reported that it is finished. |

The game-over stop is opt-in.

```ts
const { record } = await playEpisode(game, contract, driver, budgetUsd, maxTurns, seed, signal, {
  stopAtGameOver: true,
})
// record.stoppedBy === 'gameOver'
// record.gameOver === true
```

`runCampaign` and `executeBenchmark` take the same `stopAtGameOver` option.

It is off by default because episode length is a denominator.
Rounds of one study compare only while every round played to the same turn limit, so shortening an episode is the caller's decision, taken once for a whole series.

Every record also carries `gameOver`, armed or not.
It is `true` when the game was finished at the last state of the run, `false` when it was not, and `null` when the game declares no terminal state at all.
A record that reports `stoppedBy: 'maxTurns'` next to `gameOver: true` is a run that kept paying for decisions after the game ended.

A game declares the end of play with the optional `over(state)` member.

```ts
const game: Game<MyState> = {
  // ...
  evidence: (s) => s.evidence,
  over: (s) => s.evidence.engineState?.terminal === 1,
}
```

`over` must be pure, like `step`, because a verifier recomputes the final state from the seed and the input log and asks again.
A game that omits it is never over, so every adapter written before this member keeps its behaviour.
`adapters/ale`, `adapters/gymnasium`, `adapters/stable-retro`, and `adapters/native-2048` implement it over the terminal flag their worker already publishes.

The stop is an exit from the decision loop, not an abort.
The attestation runs, and the record verifies by replay exactly as a turn-limited one does.
Aborting through `signal` is a different thing: it throws inside the loop, before the record is built, and leaves nothing to grade.

### Measured

ALE Breakout, ale-py 0.12.1, seed 0, 300 turns, one scripted policy that opens the first rung of the ladder and then loses every life:

| Run | Decisions | `stoppedBy` | `gameOver` | Milestones |
|---|---|---|---|---|
| turn limit | 300 | `maxTurns` | `true` | 1 of 7 |
| game-over stop | 150 | `gameOver` | `true` | 1 of 7 |

The 150 dropped decisions are inert, not merely unproductive.
The ALE worker breaks out of its action-repeat loop once the game is over, so every evidence channel is byte-identical from decision 150 to decision 300.
Gymnasium FrozenLake behaves the same way: 6 decisions instead of 26, with 3 of 3 milestones either way.

## The observation channel: text always, pixels optional

A game declares what the agent perceives. Text is always there. Images are opt-in.

```ts
interface Observation {
  text: string
  images?: readonly ObservationImage[]
}

interface ObservationImage {
  mediaType: 'image/png' | 'image/jpeg'
  base64: string
  width: number
  height: number
  label?: string
}
```

A game publishes pixels by implementing `observe(state)`.
A game that does not implement it has the observation `{ text: frame(state) }`, which is what every game had before, so nothing about a text game changes.
The harness builds every observation through one function, `observationOf(game, state)`, and hands it to the driver as `context.observation`.

### Why this exists

The emulator adapters were already capturing the screen.
`ale/worker.py` calls `getScreenRGB()`, hashes those pixels into `frameHash` for verification, and used to throw the picture away; the agent received a luminance-to-ASCII downsample of it.
That is a perception limit the harness created, not a result about the agent.

Measured on ALE Breakout, against the six-milestone contract of the time: `stealth/ox-alpha`, a `text+image->text` model, and `liquid/lfm-2.5-2.6b:free` both scored 0 of 6 milestones, and their own transcripts show them reading the ASCII as a maze — "exploring the map", "positioned near the goal area" — rather than a paddle-and-ball game.
One of them pressed `FIRE` twice in 45 turns, so no ball was ever in play.

### Bounds

An image is an unbounded byte channel into a context somebody pays for, so the harness fixes a ceiling:

| Bound | Value | Why |
|---|---|---|
| `MAX_OBSERVATION_IMAGE_BYTES` | 1 MiB decoded | About 440x the largest real frame measured (a 3x Breakout upscale encodes to 2,383 bytes), so it never fires on legitimate pixels and still stops a runaway adapter. |
| `MAX_OBSERVATION_IMAGE_DIMENSION` | 2048 px | Model providers resize an image into their own tile grid at or below that edge, so pixels past it are re-encoded away before the model reads them while the harness still pays for the bytes. |
| `MAX_OBSERVATION_IMAGES` | 4 per turn | A screen plus an inset or a comparison frame, not a filmstrip. |
| `MAX_OBSERVATION_TOTAL_IMAGE_BYTES` | 2 MiB per turn | The per-turn total is what the context actually pays for. |

Breaching a bound is a harness error that fails the turn.
Nothing is silently shrunk: a run whose observation quietly changed size is a run whose reported result cannot be reproduced.

History stays text only.
A driver replays its retained trajectory into every prompt, so keeping images in history would multiply the image tokens by the history depth on every decision.

### The evidence boundary does not move

`Observation` is the agent's channel and `Evidence` is the harness's.
The screen image is legitimate precisely because it is what a human player sees; a caption that carried privileged state would not be.
`scripts/check-boundary.mjs` fails the build if `observationOf` reads `evidence`, or if any driver names it at all, and `observation.test.mts` runs a game whose privileged counter must never appear in the text, the caption, or the history.

### Replay is unaffected

Images never enter the input log, the contract, or the attestation.
A replay recomputes progress from the seed and the inputs alone, so the same run verifies identically whether or not it produced pixels.
`observation.test.mts` asserts it: same contract hash, same chain head, same verified set, same attestation.

### Sending the pixels

Both built-in drivers default to off, so no existing caller starts paying for image tokens without asking:

```ts
const driver = createOpenAICompatibleDriver({ model: 'your-model', vision: true })
```

With `vision: true` and an observation that has images, the user message becomes OpenAI content parts (`text` plus `image_url` data URLs).
With vision off, or on a turn with no images, the request is the same single string it always was.
The CLI driver takes `vision: true` as well and adds an `images` key to its JSON request; its first-word protocol is unchanged.

**A vision run costs image tokens.** A rendered frame is typically several hundred to a thousand-plus input tokens per turn, on top of the text, on every decision. Playproof records the reported cost either way and does not discount it.

### Which adapters produce pixels

`adapters/ale`, `adapters/pyboy-generic`, and `adapters/stable-retro` take `screenImage: true` and encode the screen their worker already captured; `screenScale` repeats whole pixels for the low-resolution consoles.
`adapters/retroarch` takes `screenImage: true` and republishes RetroArch's own screenshot.
The Gymnasium adapter publishes no image: its environments are vector or `ansi` observations, and a pixel render would need an imaging dependency Playproof does not take.
See [Execution adapters](docs/adapters.md).

## Long-horizon runs: segments, steering, resume, analysts

A campaign is one episode played in segments.
Between two segments an analyst can read the progress so far, a human can leave a note, and the process can exit and come back later.

```ts
import { existsSync } from 'node:fs'
import { loadLedger, runCampaign, saveLedger } from '@tangle-network/playproof'

const path = 'campaign.json'
const resumed = existsSync(path) ? await loadLedger(path) : undefined

const { record, ledger, log } = await runCampaign(game, contract, driver, {
  budgetUsd: 25,
  maxTurns: 5_000,
  segmentTurns: 50,
  ...(resumed === undefined ? {} : { ledger: resumed }),
  analyst: async (report) => ({
    summary: `segment ${report.segment}: ${report.verifiedSoFar.length} verified`,
    recommendation: report.newMilestones.length > 0 ? 'continue' : 'steer',
    guidance: 'stop farming the corner; open the right column',
  }),
  steer: async (report, analysis) => readOperatorNote(),
  onLedger: async (current) => saveLedger(path, current),
})
```

- **Segments.** `segmentTurns` decisions run, then the hooks get a `SegmentReport`: new milestones, verified progress, spend, remaining budget, the last frame, the recent trajectory, and this segment's latencies.
- **Steering.** A note reaches the next segment as `context.guidance`. Explicit steering outranks the analyst. A `stop` from either ends the run, and the segment records which one stopped it.
- **Resume.** `onLedger` is the persistence hook. Save the ledger, and any later process can pass it back to `runCampaign` to continue the same run. Resume replays the recorded inputs from the seed, so the milestone tracker, the trajectory, and the spend match a continuous run.
- **Fail closed.** A ledger that disagrees with itself, or that pins a different game, seed, contract hash, budget, or turn limit, is rejected instead of resumed.

The invariant the test suite pins:

> A campaign run in K segments, with a save, a reload, and a new `runCampaign` call between each, produces the same `log.head()`, the same `verified` list, and the same `spentUsd` as one continuous `playEpisode` with the same driver, seed, contract, budget, and turn limit.

The record `runCampaign` returns covers the whole campaign, not the last segment, because the attestation replays the complete input log.
`examples/tangle-agent-runtime-campaign.mts` runs the loop with one agent per decision and one analyst task per segment.

## Verification modes

Different platforms provide different proof strengths. Playproof records the distinction instead of collapsing everything into “supported.”

| Mode | Hard statement | Appropriate targets | Limit |
|---|---|---|---|
| `replay` | A verifier-owned execution reproduced each milestone from the pinned build, seed, and inputs. | Deterministic emulators and games | Determinism must be continuously calibrated. |
| `trusted-recorder` | The named recorder signed the inputs, accounting, observations, and evidence it captured. | Ordinary native desktop games | The recorder boundary is trusted; state is not independently reproduced. |
| `platform-attested` | A signed recorder captured normalized progress from a named platform API or title-side SDK and pinned the raw-response digest. | Steam or Xbox API/SDK reads | This is not a Steam/Microsoft signature unless an adapter verifies a provider-signed proof. |

A benchmark declaration that cannot support its selected mode is rejected before execution.

## Evidence and milestone contracts

Milestones can use:

- normalized engine state;
- normalized save data;
- exact save identity;
- append-only events;
- normalized fields derived from a rendered frame;
- exact rendered identity; or
- baseline-to-final platform achievements and statistics.

Use semantic checks such as `score >= 10` for progression. Exact hashes identify one specific save or frame and should not define a semantic milestone when multiple valid trajectories can reach the same outcome.

Dependencies between milestones form a declared partial order. A later achievement cannot verify before its prerequisites, even when its raw condition already holds.

### Legible checks and opaque ones

A hash check identifies a **state**, not a trajectory.
Many trajectories reach one state, so a hash is an achievement like any other and an independent policy earns it by playing.
What a hash cannot do is tell a reader what it demands.

- A **legible** check is a threshold, a normalized field, or an event. A reader sees what the milestone asks for and can judge whether reaching it is progress.
- An **opaque** check is a hash. It names one exact state without saying which, so nobody reading the contract can weigh the point.

Legibility is derived from the check kind, so no contract changes and no author has to remember to set it.
`save-hash` and `frame-hash` are opaque; `state-path`, `save-path`, `frame-path`, and `log-contains` are legible.
`requires` is followed: a legible check gated behind a hash still demands something a reader cannot see.

```ts
import { contractLegibility, formatMilestoneScore } from '@tangle-network/playproof'

contractLegibility(contract)
// { legible: ['score-opened', 'life-lost'],
//   opaque: ['frame-at-first-score', 'save-at-first-score'],
//   reasons: { 'frame-at-first-score': 'its frame-hash check states its requirement as a hash, …' } }

formatMilestoneScore(record.score) // '3 of 4'
```

The contract above is the demonstration contract in `ale.test.mts`, not the packaged Breakout one.
The packaged contract states no hash at all, for the measured reason two sections below.

Every milestone is a point, hashes included, so the denominator of a score is the contract's milestone count.
`Attestation` and `EpisodeRecord` carry `verified` and `score`; a campaign segment report carries `scoreSoFar`.

Replay attestation is a different mechanism and is untouched.
The input-log hash chain is what proves a replay reproduced a recorded run.
A milestone hash never proved that, because many logs reach the same state.

## Calibration: does the contract separate?

A milestone contract says which progressions count.
It does not say that reaching them is hard.
`deriveContract` proves only that every mark fires on the reference run, so a contract can pin a memory channel that moves whenever the game runs at all.
A constant button press then earns exactly what an evaluated agent earns.

**An uncalibrated derived contract is not a benchmark.** Calibrate it, or do not publish a score from it.

```ts
import { assertContractSeparates, calibrateContract } from '@tangle-network/playproof'

const report = calibrateContract(game, contract, {
  reference: referenceInputs,
  vocabulary: ['up', 'down', 'left', 'right', 'a', 'b', 'start', 'select'],
})
assertContractSeparates(report)
```

`calibrateContract` replays the reference and a suite of trivial policies through the same attestation path: one constant policy per input word, a word the game cannot interpret, a round-robin cycle over the vocabulary, and a seeded pseudo-random walk over it.
Every policy is deterministic in the seed, so a report reproduces from one number.

The report names `separating` (legible achievement milestones no baseline earned), `attritionSeparating` (out of reach of every baseline, and earned by a resource running down), `trivial` (milestones at least one baseline earned), `legible` and `opaque`, `progression`, `collapse`, `collisions`, and every baseline count.
`separates` is true only when a **legible achievement** milestone is out of reach of every baseline **and** the reference verifies strictly more of them than the strongest baseline.
Two kinds of milestone are excluded, for two different reasons.
An opaque milestone cannot carry the claim: "the reference reached it and no baseline did" states nothing a reader can check.
An attrition milestone cannot carry it either: the run that earns it is the run that let a resource run down.
`assertContractSeparates` throws otherwise, and the message names every trivial milestone with the baseline that earned it.

### The gate also refuses points nobody can read

Declare every opaque check by id, or state the progression with a legible check:

```ts
assertContractSeparates(report, {
  opaqueChecks: ['frame-at-first-score', 'save-at-first-score'],
  weakChecks: ['frame-at-first-score', 'save-at-first-score'],
})
```

The declaration is an exact set, not a switch: an undeclared hash milestone, a stale id, and a hash that a trivial baseline reproduced all fail the gate.
A hash milestone that a later derivation adds therefore cannot enter a published contract unnoticed.
`assertOpaqueChecksDeclared` runs the same check alone, for a demonstration target that is not meant to separate.

### How many logs satisfy a hash? Measure it

`calibrateContract` also runs `probeOpaqueCollisions`: it replaces one input of the reference at a time, over the prefix that ends where an opaque check first passes, and counts the perturbed logs that still satisfy it.
A hash a large family of logs satisfies is a weak check, and `weakChecks` is where an author accepts the measured number by id.

Measured on a Breakout contract that pins the screen and the save state at the first point scored, whose two hashes fire after 32 inputs over `NOOP/FIRE/RIGHT/LEFT`:

| Measurement | Value |
|---|---|
| single-input substitutions of the 32-turn prefix | 96 |
| substitutions that still reproduce both hashes | 56, at 21 of the 32 turns |
| all 21 applied at once | does not reproduce them |
| distinct 32-input logs that satisfy the hashes | at least 5.22 × 10¹¹ |

The packaged Breakout contract therefore states no hash.
Half a trillion logs stand in that state, and no independent control in `ale.test.mts` has ever landed on it: the two points were a denominator only the reference could score against.

`FIRE` while the ball is already in flight is a state no-op, so those logs reach a bit-identical emulator state.

### A milestone earned by dying is not a milestone earned by playing well

A milestone is an `achievement` when a run made something happen, and `attrition` when a run let a resource run down.
Lives, health, shields, fuel, time remaining: the shortest path to such a milestone is to play badly.
It is a real fact about a trajectory and it is recorded, but it is never counted as competence.

The split is **measured, never declared**, and it reads no field name.
`measureProgressions` watches every numeric channel the engine publishes across the reference and every baseline, and calls a milestone attrition when all three of these hold:

1. its check reads a numeric channel of the evidence;
2. that channel never rose and fell at least once, over every snapshot of every measured trajectory;
3. the check does not hold at the initial value of that channel.

Anything else is an achievement, including a hash, a log event, and a channel no trajectory published; those are listed in `unmeasured` so a reader sees where the measurement stopped.
Attrition propagates through `requires`, because a milestone gated behind a lost life needs a lost life.

A name list would have failed the same way `over()` would have: ALE spells its terminal flag `terminal`, Gymnasium `terminated`, stable-retro `episodeDone`.
A channel called `lives` that counts rescued hostages goes UP, and the measurement classifies it as the achievement it is.

```ts
import { measureProgressions, scoreAchievements, scoreMilestones } from '@tangle-network/playproof'

const profile = report.progression
scoreMilestones(contract, verified)               // how far the run got
scoreAchievements(contract, profile, verified)    // how well it played
```

Measured on ALE Breakout, ale-py 0.12.1, seed 0. Three deterministic controls, none of which costs a model call. Two share a control law and a deadzone in screen pixels and differ only in what they read; the third reads nothing and repeats a fixed three-word cycle, and it is the strongest screen-blind program a sweep of all 340 input patterns of period four or less found:

| control | reads | game score @300 | @600 | lives left | achievements @300 | @600 |
|---|---|---|---|---|---|---|
| `screen-blind` | nothing | 7 | 7 | 0 | 3 of 7 | 3 of 7 |
| `steer-from-ascii` | the ASCII frame, 4 px per character | 6 | 7 | 0 | 3 of 7 | 3 of 7 |
| `steer-from-ram` | `ram_ball_x`, `ram_paddle_x` | **9** | **24** | **5** | **4 of 7** | **5 of 7** |

The RAM control wins every column the game reports and never dies, and the contract now says so at both budgets.
It did not always. Against a six-milestone contract whose top achievement was `score >= 4`, all three controls tied at 3 of 5 achievements, and the whole-contract score put the ASCII control FIRST at 4 of 6, because `life-lost` is `lives == 4`: a point for dying.
`separating` and `separates` therefore count legible **achievement** milestones only, and `attritionSeparating` records the rest.
Declare an attrition milestone to keep it: `assertContractSeparates(report, { attritionChecks: ['life-lost'] })`.

Excluding a point for dying was necessary and it was not sufficient.
A contract whose top rung is `score >= 4` cannot tell 7 from 24 however it scores, so the packaged Breakout ladder now doubles — `score >= 1, 2, 4, 8, 18, 32, 64` — over a reference that reaches 64.
The strongest control reaches 5 of those 7, so the ladder still has rungs above the best program anyone has written for it.

### A contract that grades on one event

`requires` is a partial order, so a contract can state six progressions and demand exactly one event.
`report.collapse` states how much of the contract hangs off one milestone, whether a trivial baseline reaches it, and how many milestones first pass at the same instant of the reference.

| contract | gated behind | of | prerequisite reached by a baseline | open at one instant |
|---|---|---|---|---|
| stable-retro Airstriker | `score-opened` | 5 of 5 | yes: `round-robin`, `pseudo-random` | 3 of 5, after 41 inputs |
| Gymnasium CartPole | `survived-25-steps` | 5 of 5 | yes: `round-robin`, `pseudo-random` | 3 of 5, after 25 steps |
| Gymnasium FrozenLake | `reached-goal` | 3 of 3 | no | 3 of 3, after 6 steps |

A run that misses the prerequisite scores zero however well it played; where a baseline reaches it, the whole contract opens for free.
The gate refuses until the author declares the structure with `{ gatedBehind: 'score-opened' }`.

ALE Breakout used to head that table at 6 of 6, gated behind `score-opened`, with three milestones opening at input 32.
Its seven rungs now chain nothing and open at seven distinct inputs: `engineState.score` never falls, so `score >= 18` cannot pass before `score >= 8` and a `requires` edge would only restate the check.

### A packaged contract carries the calibration that justified it

Calibration used to be optional, and an optional gate is a gate nothing has to pass.
Measured on stable-retro Airstriker: the packaged contract reports `separates: false` with an EMPTY separating set, and it shipped, because nothing between `deriveContract` and a published target ever asked.

`PackagedContract.calibrate` is the only way to build a `PackagedContract`, and it runs the whole gate:

```ts
const packaged = PackagedContract.calibrate(game, contract, {
  reference: referenceInputs,
  vocabulary,
  declare: {
    opaqueChecks: ['frame-at-first-score'],
    weakChecks: ['frame-at-first-score'],
    attritionChecks: ['life-lost'],
    gatedBehind: 'score-opened',
  },
})
packaged.report.separates   // the verdict travels with the contract
```

A contract with nothing to declare passes with no `declare` at all.
The packaged ALE Breakout contract is calibrated that way in `ale.test.mts`: seven legible achievement rungs, no hash, no attrition milestone, and no prerequisite the whole contract hangs off.

A target that is not meant to separate — a tier demonstration, a smoke fixture — says so in words, and the declaration is refused when it goes stale:

```ts
PackagedContract.calibrate(game, contract, {
  reference, vocabulary,
  declare: { nonSeparating: 'tier demonstration: exercises the evidence path, does not grade play' },
})
```

A contract that hands out a bare `MilestoneContract` has not been calibrated, and now says so in its type.
No trivial baseline reproduces either hash, which is exactly why the baseline suite is not enough to judge one.

| Contract | Milestones | Legible | Reference score | Best trivial baseline |
|---|---|---|---|---|
| ALE Breakout | 7 | 7 | 7 of 7 | 0 legible |
| Libbet through `pyboy-generic` | 6 | 4 | 3 of 6 | 3 legible |

Breakout separates on its legible milestones.
Libbet does not separate, and its legible milestones are exactly the ones a constant button press already earns.

### The measurement that made this exist

A live agent campaign ran 70 turns on Libbet and the Magic Floor through `adapters/pyboy-generic` and the packaged `pyboy/discovery-libbet.json` blind-discovery document.
It earned three milestones. Its verdict was clean and its run replay-verified.

Trivial policies of the same length, on the same ROM and the same derived contract, earn this:

| Policy | Milestones verified |
|---|---|
| live agent, 70 turns | 3 — `ch_c321-progressed`, `ch_c32d-progressed`, `ch_ff96-progressed` |
| `constant:a` | 3 — the same set |
| `constant:start` | 3 — the same set |
| `round-robin` | 3 — the same set |
| `pseudo-random` | 3 — the same set |
| `constant:select` | 2 |
| `constant:up`, `constant:down`, `constant:left`, `constant:right`, `constant:b` | 0 |
| an unknown word | 0 |

Pressing `a` seventy times scores what the agent scored.
That contract measures that frames elapsed, not that a game was played well.
`pyboy-libbet.test.mts` pins the result on the free ROM in CI, so no later reader can quote a Libbet milestone count as evidence of competence.

The gate reds a second packaged target for the same reason.
`NATIVE_2048_REFERENCE` is a fixed cycle of four directions, and 2048 merges tiles under almost any input, so a seeded pseudo-random walk of the same length reaches every milestone the reference reaches, `tile-32` included.
That target exercises the execution, evidence, checkpoint, and signing paths. It does not measure skill.

Blind discovery needs this gate most, because nothing in that pipeline ever asserts that a discovered memory channel means progress.

## Execution adapters

### Deterministic native process

`@tangle-network/playproof/adapters/native-2048` is a complete seeded 2048 implementation in an independent process. It exercises engine, save, event, rendered-frame, checkpoint, frontier-search, replay, and signed-run paths without an emulator dependency.

### Generic native desktop games

```ts
import { makeNativeDesktopAdapter } from '@tangle-network/playproof/adapters/native-desktop'
```

A declarative desktop specification can:

- launch directly or attach after launcher handoff;
- select a spawned process, PID file, named descendant, existing PID, or bounded resolver;
- send allowlisted inputs through stdin or a helper;
- observe stdout or a capture helper;
- collect bounded JSON/binary saves, append-only events, rendered fields, and authorized read-only evidence;
- pin executables and assets into the game-build digest; and
- terminate the owned process group and descendants.

A nondeterministic target receives exactly one live pass. Every verifier pass after that replays the immutable recorder transcript and never relaunches the game.

### Game Boy through PyBoy

```ts
import { makePyBoyGeneric } from '@tangle-network/playproof/adapters/pyboy-generic'
```

The PyBoy adapter supports deterministic replay, memory snapshots, save states, framebuffer evidence, checkpoint exploration, and blind progression-channel discovery. ROMs are never distributed by Playproof.

`makePyBoyGeneric(rom, doc, { screenImage: true, screenScale: 3 })` also shows the agent the rendered screen. PyBoy's own `screen.image` needs Pillow, which Playproof does not depend on, so the worker encodes the PNG from the raw array itself.

Showing it required a fix first: the wiring ticked the emulator with rendering off, so the framebuffer hash was one constant value for a whole run and the screen-frame milestone was pinned on it. The last frame of each input window now renders, which leaves every privileged variable identical and changes `saveBlobHash`. See [Execution adapters](docs/adapters.md).

The real-emulator regression runs in CI on [Libbet and the Magic Floor](https://github.com/pinobatch/libbet), a free-software Game Boy game whose release ROM the job downloads and verifies by SHA-256 and MD5. `pnpm test:pyboy-libbet` boots the generic adapter from `pyboy/discovery-libbet.json`, replays the reference run, and checks that the derived milestones verify, that two power-on replays produce identical evidence, and that a garbage input script does not. A commercial ROM such as Tetris stays on the release manager's machine, so `pnpm test:pyboy` remains a local gate.

### Libretro consoles through stable-retro

```ts
import { makeStableRetro } from '@tangle-network/playproof/adapters/stable-retro'

const { game, contract, reference, inputs, dispose } = makeStableRetro({
  game: 'Airstriker-Genesis',
})
```

One Python worker covers every console [stable-retro](https://github.com/Farama-Foundation/stable-retro) bundles a libretro core for: NES, SNES, Genesis/Mega Drive, Game Boy, Game Boy Color, Game Boy Advance, Atari 2600, Sega Master System, Game Gear, and PC Engine. Nothing in the adapter is console-specific. Button names, privileged variables, and screen resolution come from the selected game's integration data.

- **Inputs.** `NOOP`, any button the core reports, and any `+`-joined combination such as `LEFT+B`. Unknown words are no-ops. Each input is held for `frames` emulator frames, four by default.
- **Observation.** An ASCII downsample of the screen plus a one-line variable summary.
- **Evidence.** Integration variables such as score and lives, read from RAM through the game's `data.json`, plus the rendered-frame hash and a few bounded numbers derived from that frame.
- **Verification.** `replay`. Frames and variables were measured bit-identical across separate worker processes; the raw libretro save-state blob was measured **not** byte-stable across processes, so the adapter deliberately publishes no save hash. See [Execution adapters](docs/adapters.md) for the numbers.

`Airstriker-Genesis` ships inside stable-retro under a free licence, so the adapter and its test run on a clean CI machine with no ROM secret. Bring other legally obtained ROMs in with `python -m retro.import <dir>` and supply a reference playthrough through `options.reference`.

### Atari through ALE

```ts
import { makeAle } from '@tangle-network/playproof/adapters/ale'

const { game, contract, reference, inputs, dispose } = makeAle({ game: 'breakout' })
```

The [Arcade Learning Environment](https://github.com/Farama-Foundation/Arcade-Learning-Environment) is the Atari 2600 substrate the reinforcement-learning literature reports on, so a Playproof score on one of these ROMs is directly comparable with published baselines. The adapter drives `ALEInterface` rather than a Gymnasium wrapper, which keeps the determinism knobs explicit: Playproof sets the seed, sets the sticky-action probability to 0, and applies the frame repeat itself.

- **Inputs.** The game's minimal action set, as ALE `Action` names: `NOOP`, `FIRE`, `UP`, `RIGHT`, `LEFT`, `DOWN`, `UPRIGHT`, and the rest. Unknown words are no-ops. Each input is held for `frames` emulator frames, four by default.
- **Observation.** An ASCII downsample of the screen plus a one-line score, lives, and frame summary. `screenImage: true` adds the rendered screen as a PNG, with `screenScale` repeating whole pixels; at 3x a Breakout frame encodes to about 2.4 KB.
- **Evidence.** Cumulative score, lives, the emulator frame counters, and the RAM bytes the caller names as `channels`. The 128-byte RAM page is never published whole. Joined by the rendered-frame hash and the serialized emulator-state hash.
- **Verification.** `replay`. Screens, RAM, counters, and the serialized `ALEState` were measured byte-identical across separate worker processes at all 840 snapshots of the Breakout reference, so a save-file milestone is honest here even though the same tier is not honest on stable-retro. See [Execution adapters](docs/adapters.md) for the numbers.

`ale-py` bundles the Atari ROM set, so the adapter and its test run on a clean CI machine with no download and no secret. The bundled reference plays Breakout to a score of 64 over 839 inputs, and its contract is seven rungs of one progression: `score >= 1, 2, 4, 8, 18, 32, 64`. Supply a reference playthrough through `options.reference` for any of the other ROMs.

### Any Gymnasium environment

```ts
import { makeGymnasium } from '@tangle-network/playproof/adapters/gymnasium'

const { game, contract, reference, inputs, dispose } = makeGymnasium({
  envId: 'CartPole-v1',
})
```

One Python worker turns any registered [Gymnasium](https://gymnasium.farama.org) environment with a `Discrete` action space into a `Game`: classic control, toy text, procedurally generated suites, and text environments, including third-party environments that register with Gymnasium. `MultiDiscrete`, `MultiBinary`, and `Box` action spaces are refused at boot with a clear message.

- **Inputs.** One word per turn: `NOOP` plus one name per action. Names come from `get_action_meanings()` when the environment exposes it, otherwise they are `a0` … `a{n-1}`. A discrete environment has no guaranteed idle action, so `NOOP` and any unknown word do not step the environment at all: the state is unchanged, because an agent typo is not a cheat.
- **Observation.** The `ansi` render for text environments, the text itself for text observations, and a labelled number list otherwise, plus a step and reward summary line.
- **Evidence.** Cumulative reward, step count, termination flags, and the numeric entries of the environment's `info` dictionary, joined by the SHA-256 of the whole observation and a bounded numeric projection of it. Playproof evidence is integer-only, so reward and numeric `info` entries are multiplied by 1000 and rounded: reward 1.0 is `cumulativeReward` 1000.
- **The honest limit.** A generic environment has **no privileged channel the agent cannot author**. Reward, `info`, and the observation are exactly what the environment hands the policy, so this tier is reward-derived, not hidden, and it is weaker than the RAM-backed score an emulator adapter reads. Verification still holds because it is replay: the verifier re-executes the environment from the seed and the input log and recomputes every milestone.
- **Verification.** `replay`, and only for environments where `reset(seed=…)` fixes the whole trajectory. `CartPole-v1` and `FrozenLake-v1` with `is_slippery: false` do, and the gate measures it across separate worker processes. An environment that reads a clock, a global RNG, or external state is not replay-verifiable and must not be given a contract.

Both bundled reference playthroughs — a scripted balancing run on `CartPole-v1` and the shortest winning path on the `FrozenLake-v1` 4x4 map — use environments that ship inside Gymnasium, so the gate runs on a clean machine with no asset:

```bash
pip install "gymnasium[toy-text]"
PLAYPROOF_REQUIRE_GYM=1 pnpm test:gym
```

For any other environment, supply a reference playthrough through `options.reference`.

### Any RetroArch core

```ts
import { makeRetroArch, channelsFromDiscovery } from '@tangle-network/playproof/adapters/retroarch'

const { game, contract, reference, inputs, dispose } = makeRetroArch({
  binary: '/Applications/RetroArch.app/Contents/MacOS/RetroArch',
  core: 'cores/gambatte_libretro.dylib',
  content: 'roms/libbet.gb',
  channels: channelsFromDiscovery(discovery),
  inputs: ['up', 'down', 'left', 'right', 'a', 'b', 'start', 'select'],
  reference: discovery.exploration.inputs,
})
```

Every other emulator adapter links an emulator into a Python worker. This one links nothing. Playproof launches the RetroArch binary the caller points at and drives it as a black box over the two UDP interfaces RetroArch already publishes, so **every core RetroArch can load becomes a Playproof game with no Playproof code per console** — Nintendo 64, PlayStation, Saturn, Dreamcast, DOS, ScummVM, and the rest of the libretro catalogue, not just the consoles a Python package chose to bundle.

- **Command interface** (`network_cmd_port`, text). `FRAMEADVANCE` steps exactly one frame, `READ_CORE_MEMORY` reads the evidence channels, `SCREENSHOT` captures the frame, `SAVE_STATE` and `LOAD_STATE` carry checkpoints, and `GET_STATUS` confirms every one of them landed.
- **Remote gamepad** (`network_remote_base_port`, binary). One 20-byte message per button transition sets the pad for the frames that follow.
- **Inputs.** `NOOP`, any libretro button the caller declares, and any `+`-joined combination such as `up+a`. Unknown words are no-ops. Each input holds the buttons for `pressFrames` frames and then releases them for the rest of the `frames` window.
- **Observation.** An ASCII downsample of the screenshot plus a one-line channel summary.
- **Evidence.** Caller-declared memory channels read through the core memory map, joined by the hash of the decoded screenshot and a few bounded numbers derived from it. Milestones are derived from memory channels only, and only from channels measured to reproduce between two separately launched emulators; screen evidence and any drifting channel are published for the agent but never pinned, and the gate prints the agreement counts on every run. `screenMilestones: true` opts in where a core earns it. No save-blob hash either: RetroArch compresses save states, and a compressed state is not a stable identity for a game position.
- **Verification.** `replay`. Determinism comes from frame stepping, not from a seed — libretro cores take none. `init(seed)` restores a boot state the worker pins with a core reset plus `bootFrames` fixed advances, and every later transition is a counted frame advance from there. The gate proves the claim the way a verifier would: it derives the contract in one emulator and re-verifies it clean in a second, separately launched one. A state load makes RetroArch reinitialise its drivers and can end the process, so a reset replaces a dead emulator and restores the same pinned blob into the new one; the run never sees a different boot state.

Headless: the adapter runs RetroArch with `video_driver = "null"`, which opens no window and was measured to render frames for `SCREENSHOT` exactly as the `gl` driver does. Each run gets its own generated config with private save-state, screenshot, and system directories, so concurrent Playproof runs never share emulator state. RetroArch serves one instance at a time, so one worker owns one emulator: dispose an adapter before booting the next.

Cores and content are never distributed by Playproof. Bring a RetroArch build, a core from the [libretro buildbot](https://buildbot.libretro.com/), and legally obtained content.

**The cross-emulator proof.** The gate replays the 266-input reference from `pyboy/discovery-libbet.json` — the addresses a blind search found by watching *PyBoy's* work RAM — through RetroArch and gambatte, software that shares no code with PyBoy. The same discovered channels carry the same progression, the derived contract verifies clean, and a garbage script of equal length is rejected. `channelsFromDiscovery` is the join, so one discovery document drives both emulators and neither adapter carries a hand-copied address.

```bash
PLAYPROOF_RETROARCH=/path/to/retroarch \
PLAYPROOF_RETROARCH_CORE=/path/to/gambatte_libretro.so \
PLAYPROOF_ROM=/path/to/libbet.gb \
PLAYPROOF_REQUIRE_RETROARCH=1 pnpm test:retroarch
```

**macOS is not supported.** The RetroArch that Homebrew installs is an x86_64 build running under Rosetta, and it segfaults inside an environment callback during `retro_run`. The gate therefore refuses to launch an emulator on darwin and skips with one line, even when the paths are set; Linux CI is the only execution evidence for this adapter. Two application defaults (`ApplePersistenceIgnoreState`, `NSAppSleepDisabled`) are named in the worker's failure messages for anyone who wants to try anyway, but the adapter is unproven there.

### Steam and Xbox

```ts
import { SteamWebApiEvidenceSource } from '@tangle-network/playproof/platforms/steam'
import { XboxRestEvidenceSource } from '@tangle-network/playproof/platforms/xbox'
```

Platform milestones are evaluated as **baseline-to-final transitions**. An achievement already unlocked before the run or a statistic whose threshold was already crossed receives no credit. Provider, title, user, environment/sandbox, build, response size, pagination, and monotonic-stat invariants fail closed.

## Exploration and onboarding

A game can be benchmarked when a bridge provides:

1. a finite input vocabulary;
2. an observation channel;
3. at least one progression signal the agent cannot directly author; and
4. an honest verification declaration.

Reference trajectories can come from a human, a scripted policy, another agent, platform events, or deterministic frontier exploration. Blind discovery can identify candidate changing memory channels before a game-specific semantic adapter is written.

“Any game” does not mean zero integration. It means the benchmark core remains unchanged while the platform bridge declares inputs, observations, evidence, trust, and calibration. Anti-cheat-protected or networked games may only permit platform receipts or approved title-side instrumentation.

## The matrix: comparing profiles across games

One benchmark answers "how did this agent do on this game". A matrix answers the
question a single game cannot: **does the order survive a change of game?** You
write one definition file, a runner plays every cell, and each cell produces the
same result vector.

A **cell** is one profile playing one game at one objective, under one protocol
and one sensor, repeated `reps` times. Every one of those is part of the cell's
identity, and none of them has a default, because each changes what the number
means.

### Add a game

A game is one line naming the adapter that boots it and the target that adapter
takes — an `ale-py` ROM id, a Gymnasium environment id, a stable-retro game.

```
game.breakout adapter=ale           target=breakout
game.pacman   adapter=ale           target=ms_pacman
game.cartpole adapter=gymnasium     target=CartPole-v1
game.air      adapter=stable-retro  target=Airstriker-Genesis
game.puzzle   adapter=native-2048   target=2048
```

Nothing else is needed if playproof ships a reference for that target. If it
does not, author one first (see **Calibration** above) and gate it with
`PackagedContract.calibrate`, which refuses a contract a trivial baseline can
satisfy. A game with no reference is not yet a benchmark.

### Add a profile

A profile is an arm. It is either a coding or model CLI, or a local control
program that costs nothing, and never both.

```
profile.opus   harness=claude-code model=claude-opus-5 effort=high
profile.haiku  harness=claude-code model=claude-haiku-4-5 effort=high
profile.chaser harness=none policy=./policies/chaser note=hand-written-controller
```

A control is not the subject of the study. It bounds what an agent profile has
to beat, which is what makes an agent's number mean anything.

`transport` selects how the profile's process is run, and it is a measurable
axis rather than a fixed cost:

| transport | shape | measured |
|---|---|---|
| `per-decision` | one child process per decision | 37.5 ms a decision, 83% of episode wall clock; a policy **cannot keep state** |
| `persistent` (default) | one child process per episode, request/response over stdio | 0.97 ms a decision, 38x less; state survives |
| `stream` | the game writes observations into a sandbox directory and never waits; the agent appends actions to a file | the agent's thinking rate is decoupled from the frame rate |

`stream` is the asynchronous one. The agent reads when it likes — with as many
subagents and analysis scripts as it wants — and the game consumes one queued
action per decision. It holds no emulator handle, so there is no object graph to
isolate: the boundary is the filesystem.

### Define a matrix

```
# study.matrix — two arms, two games, one protocol, one sensor
profile.opus   harness=claude-code model=claude-opus-5 effort=high
profile.chaser harness=none policy=./policies/chaser

game.breakout  adapter=ale target=breakout
game.pacman    adapter=ale target=ms_pacman

objective.score goal=maximize:score horizon=3000 budgetUsd=8

protocol.det   frameskip=4 sticky=0 seeds=1
sensor.ascii   pixels=off channels=-

reps 1
```

The cell set is the cross product times `reps`. An unknown key is refused rather
than ignored, because a typo in an axis key silently drops the axis while the
study still produces numbers.

**The protocol states the clock.** `frameskip` is emulator frames per decision,
`sticky` is the sticky-action probability, `seeds` is how many seeds to sweep. A
`stream` profile also requires `queue=<depth>` and `empty=noop|repeat-last`,
because an asynchronous agent leaves the game to decide what acts while it is
thinking, and `repeat-last` (keep doing what you were told) and `noop` (stop)
are different games.

**The sensor states what the agent may see.** `pixels=on scale=N` publishes the
rendered screen next to the text frame. `channels=ball_x@99,paddle_x@72` names
RAM bytes — a *harness* channel that reaches milestones and the result vector,
never the agent, because routing it to the agent would cross the one boundary
playproof exists to hold.

Three refusals you will meet, all measured rather than stylistic:

- `seeds=5` at `sticky=0` is refused. On ALE Breakout, seeds 0..4 under one
  fixed script gave **1 distinct trajectory of 5** at `sticky=0` and **3 of 5**
  at `sticky=0.25`. Five inert seeds report one trajectory five times.
- A sensor an adapter cannot honour is refused, never downgraded. Gymnasium
  publishes no screen; only ALE publishes named RAM bytes.
- Editing `frameskip=4` to `frameskip=8` under the same protocol name changes
  every cell id beneath it, so an edited protocol cannot reuse the results of
  the one it replaced.

### Run it

```bash
tsx matrix.mts study.matrix --out runs/study/cells.json
```

Each cell prints a line as it finishes, and the artifact holds every row plus
the summary. A cell whose game cannot be built under its own protocol is a
**blocked** row carrying the reason — never a zero, because a profile that never
played did not lose.

That case is real, not defensive. The bundled Breakout reference is recorded at
one clock, so asking for a different one makes its contract underivable:

| change from the bundled reference | contract derives? |
|---|---|
| `sticky` 0 → 0.10 | yes, 6 milestones |
| `sticky` 0 → 0.25 | **no** — `score-tier-2` never fires on the reference |
| `frameskip` 4 → 2 | **no** — `score-opened` never fires |
| `frameskip` 4 → 8 | **no** — `score-tier-2` never fires |
| `seed` 0 → 7 | yes, 6 milestones |

### The result vector

Each row carries its full identity and then what it measured: `score`, `deaths`,
`decisions`, `emulatorFrames`, `wallMs`, `tokens`, `usd`, `cleared`, `verified`,
`milestones`, `verdict`, `stoppedBy`, `distinctInputs`, `replayDivergence` and
`actionsHash`.

**A field nobody measured is `null`, never `0`.** A game with no life counter
reports `deaths: null`, because `0` would claim the run died zero times.
Playproof prices a decision in dollars through the driver and never sees a token
count, so `tokens` is `null` too.

### Three transports, and why the choice is a measurement

A profile also states HOW it is asked for a decision. This is not plumbing: it
changes the number more than the model does.

```
profile.slow  harness=./harnesses/claude-code model=claude-opus-5 transport=per-decision
profile.fast  harness=none policy=./policies/greedy             transport=persistent
profile.live  harness=./harnesses/claude-code model=claude-opus-5 transport=stream \
              # streaming needs a queue, an empty-queue default and a pace
```

| transport | shape | measured, native-2048, same program |
|---|---|---|
| `per-decision` | one process per decision | 37.29 ms/decision, score **4** |
| `persistent` | one process per episode, keeps state | 1.28 ms/decision, score **1948** |
| `stream` | the game writes files, the agent answers asynchronously | — |

Per-decision spawning silently forbids a program from keeping state, so a real
player degrades to a constant while answering every decision and attesting
clean. That is why the transport is an axis instead of a default.

**Streaming** writes each observation into a sandbox directory and reads moves
back from a file, so the agent is never blocked and may use subagents and its
own scripts. The game does not wait, which forces three declarations:

```
protocol.async frameskip=1 sticky=0 seeds=1 queue=8 empty=repeat-last pace=1200
```

`queue` is how many moves may wait, `empty` is what the game does when none is
(`noop` stops, `repeat-last` keeps going — different games), and `pace` is the
wall clock one decision takes. **Without a pace, twelve decisions complete in 2
ms** and any agent with a process to start has lost the episode before printing
a line; that measures the host's clock speed, not the player. The sandbox
describes itself in `brief.json` — vocabulary, queue depth, empty-queue rule —
because an agent that must guess its own vocabulary scores as a bad player.

### Authoring: measure what a profile BUILDS, not how fast it types

Under any live transport an agent's start-up time and typing rate are charged
against its score. **Measured across nine cells: the rank correlation between
actions delivered and score was 0.94.** One agent in that study wrote a working
expectimax searcher and scored 240, because the program was judged on how fast
its author could type.

`author=` splits the cell in two.

```
profile.opus harness=./harnesses/claude-code author=./harnesses/author-policy \
             model=claude-opus-5 buildMin=8 transport=persistent
```

1. **Build.** The agent gets a practice game streamed into its sandbox, at a
   *different seed*, scored by nobody, for `buildMin` minutes. It may play it,
   reimplement it, fit weights or train against it. It must leave an executable
   `policy` behind.
2. **Evaluate.** That program runs cold against a fresh scored instance, in a
   separate process, and the replay is attested. The agent is not running.

Any solution qualifies, because the evaluation only ever sees a program that
answers decisions over stdio — a heuristic table, a search, weights fitted
offline, a learned policy. Build cost lands in its own `build` column
(`usd`, `tokens`, `minutes`) and never in the play score. An agent that leaves
no policy is **blocked, not scored zero**: building nothing and playing badly
are different findings.

Streaming an authored policy is refused, because it would put the author's
clock back into the measurement.

### Several games mean several definitions

Each game names its own score channel and its own seed, so one definition per
game is the natural unit and the runner pools them.

```
npx tsx matrix.mts examples/study-2048.matrix examples/study-cartpole.matrix --out runs/study/cells.json
```

The objective says which channel carries the score and which way is better —
`goal=maximize:score` for 2048, `goal=maximize:steps` for CartPole — and every
row records the `scoreField` and `scoreDirection` it used, so a table spanning
games states what produced each number. A `minimize:` game is oriented before
correlating; raw, a perfect transfer would report as a perfect inversion.

### Many harnesses through the Tangle runtime

`harness=<launcher>` spawns a program, which makes that axis one vendor wide.
To put claude-code, codex and opencode in the same table, route profiles
through a runtime backend instead — `RunCellOptions.driver` is the seam, and
`examples/agent-runtime-matrix.mts` is the whole integration.

### The cross-game statistic

`generalization(rows)` is the number a matrix exists to produce: mean pairwise
Kendall tau-b between per-game rankings. It reports its own limits beside it —
`folds` (games, not pairs), `effectiveArms` against `declaredArms`, and every
excluded cell.

Two arms that emit identical action sequences are **one arm wearing two names**,
and a tau over "three profiles" that are really two is not the statistic it says
it is. `assertJoinable(rows)` refuses to pool rows measured under different
protocols or different sensors, rather than averaging across the dominant term.

## Signed publication artifacts

A signed run pins:

- contract hash;
- game and exact build digest;
- platform and verification mode;
- actor identity and seed;
- budget and turn limits;
- every input, latency, and reported cost;
- decision-chain hashes; and
- claimed milestones.

A capable attacker may rebuild every public hash after editing a run, but cannot forge the recorder’s Ed25519 signature or key identity. Deterministic replay remains stronger than recorder trust whenever the verifier owns a reproducible execution.

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
