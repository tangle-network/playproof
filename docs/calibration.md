# Calibration

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

