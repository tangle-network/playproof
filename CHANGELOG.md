# Changelog

All notable changes to Playproof are documented here.

## Unreleased

### The Breakout contract now measures how well a run played, not that it played

- **The defect.** The packaged ALE Breakout contract was derived from a reference that reached score 5 over 210 inputs, so its top achievement was `score >= 4`. Nothing in it could tell 7 points from 24. Excluding the point for dying stopped it ranking the worse player first; it did not give it any resolution above the bottom of the range.

  | control @600 decisions, seed 0 | game score | lives left | achievements, before | after |
  |---|---|---|---|---|
  | `screen-blind`, a fixed 3-word cycle | 7 | 0 | 3 of 5 | 3 of 7 |
  | `steer-from-ascii` | 7 | 0 | 3 of 5 | 3 of 7 |
  | `steer-from-ram` | **24** | **5** | 3 of 5 | **5 of 7** |

  Every program that played at all saturated the same three achievements. Under the new ladder the RAM control ranks strictly first at 300 decisions (4 of 7 against 3 of 7) and at 600, and two rungs are still open above it.
- **A new reference, recorded once at seed 0.** A predictive paddle controller reading the RAM ball and paddle channels: it estimates the ball velocity from the previous decision, reflects the predicted path off the side walls, and steers to the crossing point. It reaches score 64 over 839 inputs. The script ends at the input that opened the last rung.
- **The ladder doubles.** The reference declares trigger points 1, 2, 4, 8, 16, 32, 64 and `deriveContract` samples the score that actually held at each, so the packaged checks are `score >= 1, 2, 4, 8, 18, 32, 64`. The fifth trigger is written as 18 because the reference's score steps 14 to 18 when it clears a four-point row, and a trigger inside that step would derive a check that disagrees with its own name.
- **All seven trivial baselines still score zero**, at 210, 300, 450, 600, 900 and 1,200 inputs. `PackagedContract.calibrate` passes with no declaration at all: nothing to accept as opaque, nothing to record as attrition, nothing the whole contract hangs off.
- **The contract states no hash.** `frame-at-first-score` and `save-at-first-score` pinned the screen and the save state at the first point scored. Measured by the substitution sweep: 56 of 96 single-input substitutions of the 32-input prefix still satisfy them, at 21 of 32 turns, for at least 5.22 × 10¹¹ distinct 32-input logs. No independent control has ever landed on that state, so the two points were denominator only the reference could score against.
- **The contract states no `life-lost` milestone.** It is `lives == 4`, earned by dying, and the achievement split below already excluded it from the achievement score. Removing it makes the whole-contract score equal the achievement score, so no consumer can pick the number that ranks a control that died above one that did not.
- **No rung requires another.** `engineState.score` rises and never falls, measured over the reference and every baseline, so `score >= 18` cannot pass before `score >= 8` and a `requires` edge would restate the check while reporting a collapse a seven-rung ladder does not have. `report.collapse.collapses` is now `false` for this target, and its seven rungs first pass at seven distinct inputs (32, 71, 137, 259, 404, 636, 839).
- **`ale.test.mts` keeps a demonstration contract** derived from the same reference, with the two hash tiers, a `requires` chain and `life-lost`. The screen-frame and save-file evidence tiers, the opaque-collision sweep, the attrition classifier and the collapse gate stay under test on the real emulator; they are simply no longer things a Breakout player is graded on. `screen-blind` joins the two steering controls as a permanent gate, and the test now asserts the strongest control does NOT reach the top rung.
- **What a consumer must do.** The packaged reference file, the derived contract and its hash all change. A stored `Attestation` or `EpisodeRecord` against the old contract does not verify against the new one, and a milestone id from it (`score-opened`, `score-tier-2`, `score-tier-4`, `life-lost`, `frame-at-first-score`, `save-at-first-score`) no longer exists. Pass the previous reference through `makeAle({ game: 'breakout', reference })` to keep the old contract. No adapter behaviour changed: the worker, the evidence keys, the observation, the input vocabulary and the seed handling are untouched.

### A milestone earned by dying is not evidence of skill

- **The measurement.** ALE Breakout, ale-py 0.12.1, seed 0. Two deterministic controls with the same control law and the same deadzone in screen pixels, differing only in what they read: the ASCII frame at four screen pixels per character, or the `ram_ball_x`/`ram_paddle_x` channels at one pixel each. Neither carries state between decisions and neither costs a model call.

  | control | game score @300 | @600 | lives left | milestones | achievements |
  |---|---|---|---|---|---|
  | `steer-from-ascii` | 6 | 7 | 0 (dead after 375) | **4 of 6** | 3 of 5 |
  | `steer-from-ram` | **9** | **24** | **5** | 3 of 6 | 3 of 5 |

  The RAM control wins every column the game itself reports and never dies. It scored one milestone LOWER, because the packaged `life-lost` milestone is `lives == 4`: a point for dying. A program that never dies capped at 3 of 6 at any horizon. Those counts are against the six-milestone contract that the section above then replaced.
- **`ProgressionKind` is `achievement` or `attrition`.** A milestone is attrition when a resource running down earns it. It marks progress REACHED and never competence shown, because the shortest path to it is to play badly. Recording it is legitimate; scoring it as competence is not.
- **The split is measured, not declared, and it reads no field name.** `measureProgressions` watches every numeric channel the evidence publishes across the reference and every baseline, and calls a milestone attrition when three measured statements hold: its check reads a numeric channel; that channel never rose and fell at least once, over every snapshot of every trajectory; and the check does not hold at the initial value of that channel. Attrition propagates through `requires`, because `MilestoneTracker` admits a milestone only after its prerequisites passed.
- A hardcoded `lives`/`health`/`shields` list would have failed the way a name match already failed one layer down: ALE spells its terminal flag `terminal`, Gymnasium `terminated`, stable-retro `episodeDone`. A fixture channel named `lives` that counts rescued divers only rises, and the measurement classifies it as the achievement it is.
- A milestone no numeric channel speaks for — a hash, a log event, a path no trajectory published — is an achievement and is listed in `unmeasured`, so a reader sees where the measurement stopped. Attrition is a positive finding; the absence of one is not evidence of the opposite.
- **`scoreAchievements(contract, profile, verified)`** drops attrition milestones from the numerator AND the denominator. `scoreMilestones` is unchanged and still answers how far a run got.
- `CalibrationReport.separating` now counts legible **achievement** milestones, and `separates` compares the reference to the strongest baseline on those. Attrition milestones out of reach of every baseline move to `attritionSeparating`: they are recorded and never counted as separation. The report also carries `progression`, `referenceAchievementScore`, and `bestBaselineAchievementCount`.

### A contract that grades on one event

- `requires` is a partial order, so a contract can state six progressions and demand exactly one event. `report.collapse` states the structure with the number: which milestone the largest share requires, whether a trivial baseline reaches it, and how many milestones first pass at the SAME reference input.

  | packaged contract | gated behind | of | prerequisite reached by a baseline | open at one instant |
  |---|---|---|---|---|
  | ALE Breakout, before the ladder above | `score-opened` | 6 of 6 | no, 0 of 7 | 3 of 6, after 32 inputs |
  | stable-retro Airstriker | `score-opened` | 5 of 5 | yes, 2 of 28 | 3 of 5, after 41 inputs |
  | Gymnasium CartPole | `survived-25-steps` | 5 of 5 | yes, 2 of 6 | 3 of 5, after 25 steps |
  | Gymnasium FrozenLake | `reached-goal` | 3 of 3 | no, 0 of 8 | 3 of 3, after 6 steps |
  | native-2048 | `first-legal-move` | 7 of 7 | yes, 6 of 7 | 2 of 7, after 4 inputs |

- A run that misses the prerequisite scores 0 of N however well it played; where a baseline reaches it, the whole contract opens for free and grades only what follows a free event. The gate refuses until the author declares the structure with `{ gatedBehind: 'score-opened' }`, and refuses a stale declaration the same way `opaqueChecks` does.

### Calibration is no longer optional for a packaged contract

- **The measurement.** `calibrateContract` on the packaged stable-retro Airstriker contract reports `separates: false` with an EMPTY separating set. A seeded pseudo-random walk over the 25 advertised button words earns three of the four legible milestones, the same three the reference earns; the fourth is a hash that 271 of 768 single-input substitutions of the reference reproduce. It shipped because nothing between `deriveContract` and a published target ever ran the gate.
- **`PackagedContract.calibrate` is the only way to build a `PackagedContract`.** The class carries a private field and a private constructor, so an object literal of the same shape is not assignable and `new` is not available. It runs `calibrateContract`, refuses every finding the gate reports, and returns the contract with its hash, its report, and the declaration that let it through. A target that hands out a bare `MilestoneContract` has not been calibrated and now says so in its type.
- `{ nonSeparating: '<why>' }` is the escape hatch for a target that is not meant to separate — a tier demonstration, a smoke fixture. It is a sentence rather than a switch, so the reason travels with the package, and it is REFUSED when the contract does separate: a declaration must not outlive the reason for it.
- `assertContractSeparates` now reports the attrition and collapse findings alongside the opacity ones, so one run of the gate names everything an author must fix. `assertOpaqueChecksDeclared` is unchanged and still checks opacity alone.

### Measured across every packaged contract

Full calibration, seed as packaged, run on every target this machine can boot. `pnpm test:ale`, `pnpm test:retro`, and `pnpm test:gym` now carry these as gates; nothing but the fixtures ran calibration before.

| contract | reference | achievements | best baseline | separating | attrition | verdict |
|---|---|---|---|---|---|---|
| ALE Breakout | 6 of 6 | 5 of 5 | 0 of 7 policies scored | `score-opened`, `score-tier-2`, `score-tier-4` | `life-lost` | separates, collapses, 1 undeclared attrition |
| stable-retro Airstriker | 5 of 5 | 4 of 4 | 3 (pseudo-random) | **nothing** | `life-lost` | **does not separate**, collapses |
| Gymnasium CartPole | 5 of 5 | 5 of 5 | 2 (round-robin, pseudo-random) | `survived-50-steps`, `reward-at-50-steps` | none | separates, collapses |
| Gymnasium FrozenLake | 3 of 3 | 3 of 3 | 0 of 8 policies scored | `reached-goal`, `goal-cell` | none | separates, collapses |
| native-2048 | 7 of 7 | 7 of 7 | 7 (pseudo-random) | **nothing** | none | **does not separate**, collapses |
| save-levels | 2 of 2 | 2 of 2 | 2 (round-robin, pseudo-random) | **nothing** | none | **does not separate**, collapses |
| screen-puzzle | 2 of 2 | 2 of 2 | 2 (constant:r) | **nothing** | none | **does not separate**, collapses |
| engine-crawler | 4 of 4 | 4 of 4 | 4 (constant:right) | **nothing** | none | **does not separate**, does not collapse |

- Breakout's `life-lost` and Airstriker's `life-lost` are the only two attrition milestones in the packaged set. Both were in `separating` before this change, so both contracts advertised a point for dying as part of their discriminating power.
- The two Breakout controls tie at 3 of 5 achievements rather than separating, and the reason is the second finding: the contract's top achievement is `score >= 4`, so nothing in it tells 7 from 24.
- `engineState.hpExact` in the `engine-crawler` fixture only ever falls, and its milestone is `hpExact == 1`, which HOLDS at the initial value. It is an achievement, which is the third condition of the rule doing its work: a check a run satisfies at turn zero needs no resource to run down.
- Existing adapters are unchanged in behaviour. No adapter file was edited, every contract keeps its bytes and its hash, and the pinned hashes for `engine-crawler`, `save-levels`, and `screen-puzzle` still hold.

## 0.7.0

### An episode can end because the game ended

- **The measurement.** A consumer running `ale-breakout` at `maxTurns: 300` counted **163 of 300 decisions (54.3%) taken after lives reached 0**, with the engine's own `terminal` flag set. The ALE worker breaks out of its action-repeat loop once that flag holds, so none of those inputs reached the emulator: the decisions were inert, not merely unproductive. The episode still reported 300 of 300 answered and looked healthy.
- **Why the consumer could not fix it.** `playEpisode` had two stop conditions, the turn limit and the dollar budget, and no terminal concept in the published API. The only other exit was an abort through `signal`, which throws inside the decision loop before `finalizeRecord` and destroys the attestation the grade is made of.
- `Game<S>` gains an OPTIONAL `over(state): boolean`. A game that omits it is never over, so every existing adapter keeps its behaviour with no edit. It must be pure like `step`, because a verifier recomputes the final state from the seed and the input log and asks again. There is no shared spelling of the terminal flag across substrates — ALE writes `terminal`, Gymnasium `terminated` and `truncated`, stable-retro `episodeDone`, the 2048 core `gameOver` — so the mapping belongs to the adapter, not to a guess the harness makes over field names. `adapters/ale`, `adapters/gymnasium`, `adapters/stable-retro`, `adapters/native-2048`, and the `screen-puzzle` fixture implement it over evidence they already published.
- `playEpisode`, `runCampaign`, and `executeBenchmark` take `stopAtGameOver`. **It is off by default**: episode length is the denominator a study divides by, and rounds compare only while every round played to the same turn limit. A default that shortened episodes would retroactively break a running comparison, so arming the stop is the caller's decision, taken once for a series.
- The stop is an exit from the decision loop, never a thrown abort. `finalizeRecord` runs, and the record verifies by replay exactly as a turn-limited record does.
- `EpisodeRecord` gains `stoppedBy` and `gameOver`, so a reader of an artifact never infers why a run ended. `stoppedBy` is `maxTurns`, `budget`, `gameOver`, or — for a campaign — `steering` or `analyst`. `gameOver` is `true`, `false`, or `null` when the game declares no terminal state at all. Game over outranks the limits: a run that reaches its last allowed turn and a finished game at the same instant reports `gameOver`.
- The two fields together state which mode produced a record. `stoppedBy: 'maxTurns'` next to `gameOver: true` can only come from a run played past the end, so the stop was not armed. Where the game never ended, the two modes produce the same length and the same record.
- `CampaignStop` gains `gameOver`, and a campaign segment records it. A campaign resumed from a ledger whose game already ended plays no further segment and writes no empty one. A ledger written by 0.6.0 still loads; the ledger schema is unchanged.

### Measured

ALE Breakout, ale-py 0.12.1, seed 0, `maxTurns: 300`, one scripted policy that opens four milestones and then loses every life. Both runs are gates in `pnpm test:ale`.

| Run | Decisions | `stoppedBy` | `gameOver` | Milestones | Replay |
|---|---|---|---|---|---|
| turn limit (today's behaviour) | 300 | `maxTurns` | `true` | 4 of 6 | clean |
| `stopAtGameOver: true` | 150 | `gameOver` | `true` | 4 of 6 | clean |

The 150 dropped decisions are inert: every evidence channel — screen hash, save-state hash, and engine state — is byte-identical from decision 150 to decision 300, while decision 149 to 150 did move the emulator.

Gymnasium FrozenLake-v1, same shape on a second real substrate: 6 decisions instead of 26, 3 of 3 milestones either way, replay clean. It is a gate in `pnpm test:gym`.

## 0.6.0

### A hash check identifies a state, not a trajectory

- **The correction.** An earlier draft of this release split contract milestones into "earnable" achievements and "replay-identity" hashes, on the premise that a hash pinned from the reference trajectory can only be satisfied by reproducing that trajectory. That premise is false, and it has been measured false. The measurement is below. An earlier draft of this entry published earnable denominators for eleven packaged contracts — Breakout 4 of 6, Libbet 4 of 6, PyBoy Tetris 3 of 5, Gymnasium FrozenLake 2 of 3 — and every one of those denominators was wrong. The denominator is the milestone count.
- **What is true.** A `frame-hash` or `save-hash` check names one exact game state. Many trajectories reach one state, so an independent policy earns a hash milestone by playing, without ever seeing the reference. It is a legitimate achievement check whose requirement happens to be written where nobody can read it.
- The axis is legibility, not earnability. `checkLegibility` and `contractLegibility(contract)` split a contract into **legible** milestones (`state-path`, `save-path`, `frame-path`, `log-contains` — a reader sees what they demand) and **opaque** ones (`save-hash`, `frame-hash`). It follows `requires`, because a legible check gated behind a hash still demands something a reader cannot see. Legibility is derived from the check kind, so every existing contract keeps its bytes and its hash.
- `MilestoneScore` is `{ verified, total }`, and `formatMilestoneScore` writes it as `3 of 6`. Every milestone is a point, hashes included. `Attestation` and `EpisodeRecord` carry `verified` and `score`; the `earned` field and `earnedMilestones` are gone, because a run earns everything it verifies. A campaign segment report carries `scoreSoFar`.
- The campaign ledger is unchanged. Its `verified` list and the contract it pins by hash reproduce the score through `scoreMilestones`, so a ledger written by 0.5.0 still loads.
- Replay attestation is untouched. The input-log hash chain is the mechanism that proves a replay reproduced a recorded run, and it is correct. A milestone hash never proved that.

### Calibration refuses a contract whose points nobody can read

- **A real defect, independent of the model above, and it stands.** An opaque milestone is never earned by a trivial baseline, so it landed in `separating` and the separation test read it as the contract's strongest evidence. Measured on 0.5.0: a contract whose two milestones are hashes over the whole input chain reports `separates: true` with every baseline earning nothing.
- `CalibrationReport.separating` now holds legible milestones only, and `separates` compares legible counts through `bestBaselineLegibleCount`. "The reference reached it and no baseline did" is not evidence when no reader can tell what it was reached for.
- The report gains `legible`, `opaque`, `opacityReasons`, `opaqueReproduced`, `collisions`, and `referenceScore`.
- `assertContractSeparates(report, { opaqueChecks, weakChecks })` takes an exact declaration. An undeclared opaque check, a stale id, and a hash that a trivial baseline reproduced all fail the gate. `assertOpaqueChecksDeclared` runs the same check alone, for a target that is not meant to separate.

### The collision sweep, which the earlier draft could not do

- The earlier draft tested an opaque check against trivial baselines only, found none of them reproduced a hash, and concluded the hash identified one run. That is why the false premise survived: the baseline suite cannot serve a ball, let alone score.
- `probeOpaqueCollisions` is the prober that can. It replaces one input of the reference at a time, over the prefix that ends where the check first passes, and counts the perturbed logs that still satisfy it. It is deterministic, needs no independent policy, and runs inside `calibrateContract` for every opaque milestone.
- Each row carries `firesAfter`, `probedTurns`, `substitutions`, `collisions`, `freeTurns`, `jointCollision`, and `family` — a lower bound on the number of distinct logs that satisfy the check, as the product over probed turns of (1 + surviving alternatives). `collisionTurns` caps the probe for a check that fires very late.
- The gate refuses an opaque check the sweep reproduced, unless the author accepts the measured weakness by id in `weakChecks`. A stale `weakChecks` id fails too.

### Measured

ALE Breakout, ale-py 0.12.1, seed 0, both hashes firing after 32 inputs over `NOOP/FIRE/RIGHT/LEFT`:

| Measurement | Value |
|---|---|
| single-input substitutions of the 32-turn prefix | 96 |
| substitutions that still reproduce both hashes | 40, at 16 of the 32 turns |
| all 16 free turns substituted at once | still reproduces both |
| distinct 32-input logs that satisfy both hashes | at least 382,205,952 |
| trivial baselines that reproduce either hash | 0 of 8 |

`FIRE` while the ball is already in flight is a state no-op, so a large family of logs reaches a bit-identical emulator state. An independently written ball tracker reproduced both hashes without seeing the reference; its log diverges at turn 17, where it plays `FIRE` and the reference plays `NOOP`.

Corrected per-contract figures. The **Milestones** column is the denominator of a score:

| Contract | Milestones | Legible | Opaque | Reference | Best trivial baseline |
|---|---|---|---|---|---|
| ALE Breakout, 210 turns, seed 0 | 6 | 4 | 2 | 6 of 6 | 0 legible |
| Libbet through `pyboy-generic`, 70 turns, seed 0 | 6 | 4 | 2 | 3 of 6 | 3 legible |
| PyBoy Tetris | 5 | 3 | 2 | — | — |
| stable-retro Airstriker | 5 | 4 | 1 | — | — |
| Gymnasium CartPole | 5 | 4 | 1 | — | — |
| Gymnasium FrozenLake | 3 | 2 | 1 | — | — |
| RetroArch, `n` channels with screen milestones | n + 2 | n + 1 | 1 | — | — |
| `native-2048` | 7 | 7 | 0 | — | — |
| `engine-crawler` toy | 4 | 4 | 0 | — | — |
| `save-levels` toy | 2 | 0 | 2 | 2 of 2 | 2 |
| `screen-puzzle` toy | 2 | 0 | 2 | 2 of 2 | 2 |

- Breakout separates on its legible milestones. Libbet still does not separate, and its four legible milestones are exactly the ones a constant `a` press already earns.
- Both toys are reproduced in full by a trivial baseline. On `save-levels` the round-robin cycle over `clear`/`grind` replays the reference exactly, and on `screen-puzzle` `constant:r` walks to the same square. A hash a trivial baseline satisfies demands nothing, and the gate says so. Neither toy's substitution sweep finds a collision, because every substitution of those short references breaks the check — the two probers are complementary, and neither replaces the other.

### Replay attestation is unaffected

- `verified` keeps its meaning and its contents. The three packaged toy contract hashes are byte-identical across the change, and `calibration.test.mts` pins them, together with the serialized milestone key set, so a contract that gains a field fails the build.
- `ale.test.mts` and `pyboy-libbet.test.mts` verify the same milestone ids on the same runs as before, and now also report the split and the sweep.

## 0.5.0

### The observation channel

- A game may now show the agent pixels. `Observation` is `{ text, images? }`, an image is `{ mediaType, base64, width, height, label? }`, and a game publishes one by implementing the optional `observe(state)`.
- The change is additive. `Game.frame()` and `AgentDriver.act(frame, history, context)` keep their signatures and behaviour, a game with no `observe()` has the observation `{ text: frame(state) }`, and a text-only driver is bit-identical.
- `observationOf(game, state)` is the one function that applies that default and the bounds. Every harness path that shows a state to an agent goes through it.
- The harness computes one observation per decision and passes it as `context.observation`. `act`'s first argument is still `observation.text`.
- Trajectory history stays text only. A driver replays its retained history into every prompt, so images in history would multiply the paid image tokens by the history depth on every decision.

### Why

- Measured on ALE Breakout: `stealth/ox-alpha`, a `text+image->text` model, and `liquid/lfm-2.5-2.6b:free` both scored 0 of 6 milestones, and their transcripts show them reading the ASCII downsample as a maze — "exploring the map", "positioned near the goal area" — rather than a paddle-and-ball game. One pressed `FIRE` twice in 45 turns, so no ball was ever in play.
- `ale/worker.py` was already calling `getScreenRGB()` and hashing those pixels into `frameHash` for verification, then discarding the picture. Playproof captured the real screen for the verifier and never showed it to the agent.

### Bounds

- One image is capped at 1 MiB decoded and 2048 px on either edge; a turn carries at most 4 images and 2 MiB in total. Media type is checked against the file's own magic bytes and base64 must be canonical.
- 1 MiB is about 440x the largest real frame measured, and 2048 px is where model providers resize an image into their own tile grid, so pixels past it are re-encoded away while the harness still pays for the bytes.
- A breach is a harness error that fails the turn. Nothing is silently truncated: a run whose observation quietly changed size is a run whose reported result cannot be reproduced.
- An image `label` is agent-visible text that a driver puts straight into a prompt, so it must be a string, is bounded, and rejects every control and formatting character rather than only newlines. An escape sequence or a bidi override is prompt injection dressed as a caption.
- The observation a driver receives is frozen through the images array and each image, so a driver holds a snapshot of the turn and never a handle back into the harness.
- `observationTextOf(game, state)` applies the same default without validating pixels. The trajectory history and the campaign segment report read through it, so appending a text row cannot fail on a bound that governs pixels nobody records, on a live turn or on a ledger replay.
- The ALE and PyBoy worker transports raise their per-line bound to 8 MiB, matching stable-retro. A legal 1 MiB image is about 1.4 MB of base64, so without this the transport would reject the line first and report a byte count instead of the cap the caller breached.

### Evidence boundary and replay

- `Observation` is the agent's channel and `Evidence` stays harness-only. `scripts/check-boundary.mjs` now fails the build if `observationOf` reads `evidence`, or if any file under `drivers/` names it at all.
- Images never enter the input log, the contract, or the attestation. `observation.test.mts` asserts a run verifies identically with and without them: same contract hash, same chain head, same verified set, same attestation.

### Drivers

- `createOpenAICompatibleDriver` takes `vision` (off by default) and `imageDetail`. With vision on and images present, the user message becomes OpenAI content parts with `image_url` data URLs; otherwise the request is the same single string as before.
- `createCliAgentDriver` takes `vision` (off by default) and adds an `images` key to its JSON request. The first-word protocol is unchanged, and `vision` with `stdin: 'prompt'` fails at construction rather than dropping the pixels every turn.
- A vision run costs image tokens on every decision. Playproof records the reported cost either way and does not discount it.

### Adapters

- `adapters/ale`, `adapters/pyboy-generic`, and `adapters/stable-retro` take `screenImage` and `screenScale`, and publish the screen their worker already captured for `frameHash`. `adapters/retroarch` takes `screenImage` and republishes RetroArch's own `SCREENSHOT` PNG byte for byte.
- Every one of them is off by default, so the byte cost of an existing run is unchanged.
- `pyshared/playproof_png.py` encodes 8-bit grayscale, RGB, and RGBA with `zlib` and `struct`, filter 0 on every scanline. No image dependency was added: Pillow is absent from CI, and the RetroArch worker needs no encoder at all. Measured on an ale-py 0.12.1 Breakout frame: 518 bytes at the native 160x210 in 0.84 ms, and 2,383 bytes at a 3x upscale in 4.4 ms.
- `adapters/gymnasium` publishes no image and the docs say why: its environments observe a vector or an `ansi` string, and an `rgb_array` render for the classic-control and toy-text families needs `pygame`.
- The bytes an agent sees are never the bytes a verifier recomputes. ALE and PyBoy hash the raw buffer rather than the encoded file, and the RetroArch evidence hash covers decoded pixels because RetroArch picks a PNG filter per scanline.

### Fixed

- **PyBoy never rendered.** Every tick in the PyBoy wiring ran with `render=False`, which PyBoy treats as frameskipping and which leaves the LCD output buffer untouched. Measured on the 266-input Libbet reference: the framebuffer hash took ONE distinct value for the whole run, so the `screen-frame` milestone the generic adapter derives was pinned on a constant that every run reproduces, including one that never presses a button.
- The last frame of each input window now renders. Measured: every privileged variable is identical at all 267 snapshots of the reference, the framebuffer hash takes eight distinct values instead of one, and wall time rises about one per cent. `saveBlobHash` does change, because PyBoy serializes its renderer state into the save, so a PyBoy save-file milestone recorded before 0.5.0 does not reproduce after it.
### Found and deliberately not fixed here

- `retroarch/worker.py` answers a repeat `evidence` call at one emulator instant with its whole cache entry rather than the evidence. `makeRetroArch` reads the boot evidence through exactly that path, so the contract baseline is empty today and `channelMarks` silently falls back to the discovery document's declared value — the case its own comment warns about, where a milestone can open at the first snapshot.
- Correcting it is one line, and it changes which milestones the adapter derives. Measured on gambatte with Libbet in CI: with a correct baseline, `ch_c581_c582` stops firing at all, because that channel never leaves the value gambatte powers on with, and contract derivation fails. That is a benchmark change needing its own cross-emulator measurement, so it is recorded in the worker and left for a focused commit rather than carried by a change about what the agent can see.

### Tests

- `observation.test.mts` joins the `test` chain: the text-only default, an image game through `playEpisode` and `runCampaign`, every bound rejecting, the evidence boundary holding, replay and attestation parity, and both drivers sending pixels only when the caller opted in.
- `ale.test.mts`, `stable-retro.test.mts`, and `pyboy-libbet.test.mts` gain real-emulator checks. Each decodes the produced PNG, undoes the whole-pixel upscale, and asserts the recovered native buffer hashes to the `frameHash` a verifier recomputes, so the agent is proven to see the screen the verifier checks. Each also asserts the evidence at that instant is identical with the image channel on and off.
- Measured by those gates: ALE Breakout at 3x is a 480x630 PNG of 2,450 bytes with 9 distinct colours; stable-retro Airstriker at 2x is 640x448 and 1,968 bytes with 9 colours; PyBoy Libbet at 3x is 480x432 and 1,228 bytes with 1 colour, because Libbet under the blind generic preamble draws an all-white screen from about the fortieth reference input onward.

## 0.4.0

### Verification

- `calibrateContract` replays a reference trajectory and a suite of trivial policies against the same contract, then reports which milestones the trivial policies cannot reach.
- The suite is one constant policy per input word, a word the game cannot interpret, a round-robin cycle over the vocabulary, and a seeded pseudo-random walk over it. Every policy is deterministic in the seed, so a report reproduces from one number.
- `assertContractSeparates` fails closed on a contract a trivial policy satisfies, and names every trivial milestone with the baseline that earned it.
- A contract separates only when at least one milestone is out of reach of every baseline and the reference verifies strictly more milestones than the strongest baseline.
- `deriveContract` is documented as producing a hypothesis, not a benchmark. It proves that a mark fires on the reference run; it cannot prove the mark is hard to reach.
- Measured, and pinned by the Libbet regression in CI: a 70-turn agent campaign on the packaged blind-discovery contract earned three milestones, and pressing `a` seventy times earns the same three. `constant:start`, `round-robin`, and a seeded pseudo-random walk also earn them, while five of the eight buttons and an unknown word earn none.
- Measured on the packaged 2048 target: its reference is a fixed cycle of four directions, so a pseudo-random walk of the same length reaches every milestone. That target exercises the execution and evidence paths and does not measure skill.

### Game and platform adapters

- `adapters/retroarch`: Playproof drives the RetroArch binary as a black box, so every core RetroArch can load becomes a game with no Playproof code per console. Nothing is linked and no C ABI is touched.
- Control is the two UDP interfaces RetroArch already publishes: the network command interface for `FRAMEADVANCE`, `READ_CORE_MEMORY`, `SCREENSHOT`, `SAVE_STATE`, `LOAD_STATE`, and `GET_STATUS`, and the network remote gamepad for per-button state.
- The worker runs RetroArch headless with `video_driver = "null"`, which opens no window and was measured to render frames for `SCREENSHOT` exactly as the `gl` driver does. Every run gets its own generated config and private save-state, screenshot, and system directories.
- `bootFrames` and `clearRegions` are exposed as the real per-game knobs they are, because a core reset does not clear the memory a console powers on with.
- The gate asserts what a verifier actually does: the contract derived in one emulator verifies clean in a second, separately launched one over the whole reference. Byte-for-byte agreement between two boots is measured and printed rather than asserted, because a core reset leaves residue the game reads and the measurement says so.
- Milestones are derived from memory channels only, and only from channels measured to reproduce. Screen evidence and the low-ranked channels that drift are published for the agent and for exploration but never pinned; the gate prints the agreement counts on every run. Pinning `screenMilestones` is opt-in for cores where the same measurement comes out clean.
- A state load makes RetroArch reinitialise its drivers and can end the process. A reset replaces a dead emulator and restores the same pinned boot blob, because a reset has no evidence to invalidate. A death mid-run ends the run: replaying the inputs so far onto a replacement looks equivalent and was measured not to be, and evidence a verifier cannot recompute is worse than no evidence.
- No `saveBlobHash` is published. RetroArch compresses save states and the bytes were measured not equal between processes at the same instant, so hashing them would pin a milestone a correct replay cannot reproduce.
- `channelsFromDiscovery` turns a PyBoy discovery document into RetroArch channels, so the same blind-discovered work-RAM addresses drive two unrelated emulators and neither adapter carries a hand-copied address.
- The adapter gate is a cross-emulator proof, not just an emulator run: the 266-input reference discovered on PyBoy derives a contract that verifies clean through RetroArch and gambatte, rejects a script of the same length that never presses a button, and re-verifies in a second, separately launched emulator.
- The black box was measured rather than assumed, and `docs/adapters.md` records each measurement: `FRAMEADVANCE` is edge triggered, save and load state only fire when they travel with a frame advance, one `READ_CORE_MEMORY` reply must fit 2048 bytes, the remote gamepad consumes one message per poll, RetroArch serves one instance at a time, and an unset directory setting segfaults the emulator inside `retro_run`.

### Continuous integration

- A `real-retroarch` job installs RetroArch from the buildbot AppImage, unpacks the libraries that build links but never calls, downloads the gambatte core and the verified free Libbet ROM, and runs the black-box host gate on the self-hosted Linux pool. The job reports an explicit warning and skips instead of failing if the pool cannot install the emulator.
- macOS is not a supported host: the x86_64 RetroArch under Rosetta segfaults during `retro_run`, so the gate refuses to launch an emulator on darwin and skips with one line. Linux CI is the only execution evidence for this adapter, and the docs say so.

## 0.3.0

### Game and platform adapters

- `adapters/ale`: the Atari 2600 through the Arcade Learning Environment, the substrate the reinforcement-learning literature reports on, so a Playproof score is directly comparable with published baselines.
- The worker drives `ALEInterface` and not a Gymnasium wrapper, so Playproof owns the determinism knobs: it sets the seed, disables sticky actions, and applies the frame repeat itself.
- Evidence stays bounded. Score, lives, and emulator counters are always published; the 128-byte RAM page never is, and only the byte indices the caller names as channels reach `engineState`.
- Cross-process determinism is measured, not assumed. Screens, RAM, counters, and the serialized `ALEState` reproduce byte for byte, so this adapter publishes `saveBlobHash` where `adapters/stable-retro` could not, and its contract pins a save-file milestone.
- Checkpoint and restore carry the cumulative score with the emulator state, so a restored worker resumes on the exact snapshotted instant.
- `ale-py` bundles the Atari ROM set, so the adapter gate runs a real emulator on a clean CI machine with no download and no secret.
- `adapters/gymnasium`: one worker turns any registered Gymnasium environment with a `Discrete` action space into a Playproof game — classic control, toy text, procedurally generated suites, text environments, and third-party environments that register the same way.
- Action words come from `get_action_meanings()` when the environment exposes it and are positional otherwise. A discrete space has no idle action, so `NOOP` and every unknown word leave the environment untouched instead of advancing it.
- Evidence is the environment's own cumulative reward, step count, termination flags, and numeric `info` entries, joined by the observation hash and a bounded projection of the observation. Reward and numeric `info` entries are scaled by 1000 into integers.
- The evidence limit is stated in the adapter and the docs rather than papered over: a generic environment offers no privileged channel the agent cannot author, so the tier is reward-derived, and verification rests on replay recomputation alone.
- Determinism is measured across separate worker processes, not assumed. `CartPole-v1` and `FrozenLake-v1` with `is_slippery: false` reproduce exactly under `reset(seed)`.
- Gymnasium has no generic state API, so a checkpoint replays from its seed, and additionally writes back the environment's own state attribute where one is readable. No `pickle` is involved.
- Milestone contracts are derived from committed reference playthroughs on `CartPole-v1` and `FrozenLake-v1`, both of which ship inside Gymnasium, so the adapter gate needs no asset on a clean CI machine.
- Determinism comes from frame stepping, not from a seed, because libretro cores take none. `init(seed)` restores a boot state pinned by a core reset plus a fixed number of frame advances, and every later transition is a counted frame advance from there.

### Fixes

- `scriptedDriver` is positioned by the harness turn instead of its own call count, so a driver created in a fresh process resumes a campaign mid-script instead of restarting it.

### Continuous integration

- Releases publish from the self-hosted pool without npm provenance: the registry rejects a sigstore bundle built on a self-hosted runner. The tag-to-commit check, the full gate, and the SHA-256 receipt on the GitHub release are the integrity evidence.
- Every workflow job runs on the organization's self-hosted Linux pool with a per-job `uv` virtual environment and a per-job pnpm install directory; the real-emulator gates (Libbet on PyBoy, Airstriker on stable-retro, Breakout on ALE, CartPole and FrozenLake on Gymnasium) all run there.

## 0.2.0

### Campaigns

- `runCampaign` plays one verifiable run in bounded segments over the shared episode loop.
- `CampaignLedger` records inputs, per-decision cost and latency, segments, steering, analyses, and verified progress as plain JSON.
- Resume by replay: a saved ledger reconstructs the input log, milestone tracking, trajectory, and spend, then continues the same run in a new process.
- `saveLedger` and `loadLedger` write atomically and validate strictly; a ledger that disagrees with itself or with the pinned game, seed, contract, budget, or turn limit is rejected.
- Segment reports give an analyst new milestones, verified progress, spend, remaining budget, the last frame, and a bounded recent trajectory.
- Analyst and human steering hooks, with explicit steering outranking analysis and either able to stop the run.
- `AgentDecisionContext.guidance` carries the latest note to the next decision; the CLI and OpenAI-compatible drivers pass it through unchanged protocols.
- Agent Runtime campaign example with one agent per decision, one analyst task per segment, a human steering file, and ledger resume.

### Game and platform adapters

- Real-emulator PyBoy regression on the free Libbet and the Magic Floor ROM, pinned by hash and run in CI.
- The PyBoy worker no longer writes a cartridge save next to the ROM, which made each later boot start from a different state.

- `adapters/stable-retro`: one worker brings every console stable-retro bundles a libretro core for into Playproof — NES, SNES, Genesis/Mega Drive, Game Boy, Game Boy Color, Game Boy Advance, Atari 2600, Sega Master System, Game Gear, and PC Engine.
- Privileged evidence is read from the game's own integration variables in RAM, joined by a rendered-frame hash and bounded numbers derived from that frame.
- Milestone contracts are derived from a committed reference playthrough; the reference declares only where a milestone opens, and every value is sampled from the replay.
- Cross-process determinism is measured, not assumed. Frames and variables reproduce exactly; the raw libretro save-state blob does not, so no save hash is published and no contract can pin one.
- Checkpoint and restore carry the frame counter with the core state, so a restored worker lands on the exact snapshotted instant.
- `Airstriker-Genesis`, the free ROM stable-retro ships, makes the adapter gate runnable on a clean CI machine with no secret.

## 0.1.0

Initial open-source release.

### Framework

- Provider-neutral `Game`, `AgentDriver`, benchmark target, and episode engine.
- Declarative milestone contracts over engine, save, event, frame, and platform evidence.
- Deterministic replay verification and dependency-ordered milestone tracking.
- Canonical SHA-256 artifacts and Ed25519-signed run envelopes.
- Exact per-decision input, cost, latency, actor, seed, build, and limit accounting.
- Deterministic checkpoint/frontier exploration that emits replayable input scripts.

### Agent integrations

- Callback interface requiring no SDK dependency.
- Bounded arbitrary CLI/coding-harness driver with JSON and first-word protocols.
- Bounded OpenAI Chat Completions-compatible HTTP driver with caller-owned pricing.
- Examples for custom policies, Claude Code CLI, and Tangle Agent Runtime backends.

### Game and platform adapters

- Deterministic native-process 2048.
- Generic native desktop launch/attach, input, observation, bounded file/event evidence, build pinning, and process-group cleanup.
- PyBoy generic/Tetris replay, memory/save/frame evidence, blind discovery, and checkpoint exploration.
- Steam Web API and title-side bridge evidence.
- Xbox services and GDK/XSAPI bridge evidence.
- Baseline-to-final achievement/stat transitions that reject pre-existing progress and identity/build swaps.

### Security and release engineering

- Exactly one live pass for nondeterministic recorder targets; every later verifier pass uses the immutable transcript.
- Bounded worker frames, subprocess output, HTTP bodies, save files, and event files.
- No shell-string execution, injection, runtime patching, anti-cheat bypass, or credential capture.
- Repository-boundary checks, strict tests, packed-tarball inspection, and clean-consumer import verification.
