# The arena: comparing agent profiles across games

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

### Transports

A profile states how it is asked for a decision. The choice changes the score
more than the model does.

```
profile.slow harness=./harnesses/claude-code model=claude-opus-5 transport=per-decision
profile.fast harness=none policy=./policies/greedy               transport=persistent
profile.live harness=./harnesses/claude-code model=claude-opus-5 transport=stream
```

| transport | one process per | measured on native-2048 |
|---|---|---|
| `per-decision` | decision | 37.29 ms/decision, score 4 |
| `persistent` | episode | 1.28 ms/decision, score 1948 |
| `stream` | episode, asynchronous | see below |

Both rows above ran the same program. A new process each decision loses all
state between decisions. The program still answers every decision and still
attests clean, so the failure is silent. Declare the transport, or the score is
a property of the harness.

### Streaming

The game writes each observation into a sandbox directory. The agent writes
moves back to a file when it is ready. It is never blocked, so it can run its
own scripts and subagents while the game continues.

The game does not wait. Three fields say what that means:

```
protocol.async frameskip=1 sticky=0 seeds=1 queue=8 empty=repeat-last pace=1200
```

- `queue` is how many moves may wait to be played.
- `empty` is what the game does when no move is waiting. `noop` stops.
  `repeat-last` keeps doing the last thing. These are two different games.
- `pace` is the wall clock one decision takes, in milliseconds.

Without a pace, 12 decisions complete in 2 ms. An agent that must start a
process has already lost the episode. The score then measures the host.

The sandbox writes `brief.json` with the vocabulary, the queue depth and the
empty-queue rule. An agent that guesses its vocabulary writes illegal words,
and illegal words read as bad play.

### Authoring

Under a live transport, the agent's start-up time and typing rate count against
its score. Measured over nine cells here, the rank correlation between moves
delivered and score was 0.94. One agent wrote a working expectimax search and
scored 240, because the harness graded how fast its author typed.

`author=` splits the cell in two.

```
profile.opus harness=./harnesses/claude-code author=./harnesses/author-policy \
             model=claude-opus-5 buildMin=8 transport=persistent
```

**Build.** The agent gets a practice game in its sandbox for `buildMin`
minutes. Nobody scores that game, and it runs at a different seed. The agent
can play it, reimplement it, fit weights or train against it. It must leave an
executable `policy` behind.

**Evaluate.** That program runs cold against a fresh scored game, in its own
process, and the replay is attested. The agent is not running.

The evaluation only sees a program that answers decisions over stdio. Any
solution qualifies: a heuristic table, a search, weights fitted offline, a
learned policy. Build cost goes in the `build` column as `usd`, `tokens` and
`minutes`. It never touches the play score.

An agent that leaves no policy is blocked, not scored zero. Building nothing
and playing badly are two findings, and one number cannot carry both.

Authoring with `transport=stream` is refused. Streaming an authored policy puts
the author's clock back into the measurement.

### Several games

Each game names its own score channel and its own seed, so each gets its own
definition file. The runner pools them.

```bash
npx tsx matrix.mts examples/study-2048.matrix examples/study-cartpole.matrix --out runs/study/cells.json
```

The objective names the channel and the direction: `goal=maximize:score` for
2048, `goal=maximize:steps` for CartPole. Every row records the `scoreField`
and `scoreDirection` it used, so a table across games says what produced each
number. A `minimize:` game is flipped before the ranks are correlated. Left
raw, a perfect transfer reports as a perfect inversion.

### Many harnesses

`harness=<launcher>` spawns a program, so that column holds one vendor. To put
claude-code, codex and opencode in one table, give each profile a runtime
backend. `RunCellOptions.driver` is the seam. See
`examples/agent-runtime-matrix.mts`.

### The cross-game statistic

`generalization(rows)` is the number a matrix exists to produce: mean pairwise
Kendall tau-b between per-game rankings. It reports its own limits beside it —
`folds` (games, not pairs), `effectiveArms` against `declaredArms`, and every
excluded cell.

Two arms that emit identical action sequences are **one arm wearing two names**,
and a tau over "three profiles" that are really two is not the statistic it says
it is. `assertJoinable(rows)` refuses to pool rows measured under different
protocols or different sensors, rather than averaging across the dominant term.

