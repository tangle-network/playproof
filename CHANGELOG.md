# Changelog

All notable changes to Playproof are documented here.

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
- `retroarch/worker.py` returned its whole evidence cache entry, not the evidence, on a cache hit. Any second `evidence` call at one emulator instant answered with an array instead of the evidence object.

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
