# Changelog

All notable changes to Playproof are documented here.

## 0.4.0

### Game and platform adapters

- `adapters/retroarch`: Playproof drives the RetroArch binary as a black box, so every core RetroArch can load becomes a game with no Playproof code per console. Nothing is linked and no C ABI is touched.
- Control is the two UDP interfaces RetroArch already publishes: the network command interface for `FRAMEADVANCE`, `READ_CORE_MEMORY`, `SCREENSHOT`, `SAVE_STATE`, `LOAD_STATE`, and `GET_STATUS`, and the network remote gamepad for per-button state.
- The worker runs RetroArch headless with `video_driver = "null"`, which opens no window and was measured to render frames for `SCREENSHOT` exactly as the `gl` driver does. Every run gets its own generated config and private save-state, screenshot, and system directories.
- `bootFrames` and `clearRegions` are exposed as the real per-game knobs they are, because a core reset does not clear the memory a console powers on with.
- The gate asserts what a verifier actually does: the contract derived in one emulator verifies clean in a second, separately launched one over the whole reference. Byte-for-byte agreement between two boots is measured and printed rather than asserted, because a core reset leaves residue the game reads and the measurement says so.
- Milestones are derived from memory channels only, and only from channels measured to reproduce. Screen evidence and the low-ranked channels that drift are published for the agent and for exploration but never pinned; the gate prints the agreement counts on every run. Pinning `screenMilestones` is opt-in for cores where the same measurement comes out clean.
- A state load makes RetroArch reinitialise its drivers and can end the process, so a reset replaces a dead emulator and restores the same pinned boot blob into the new one. The emulator is disposable; the pinned state is the source of truth.
- No `saveBlobHash` is published. RetroArch compresses save states and the bytes were measured not equal between processes at the same instant, so hashing them would pin a milestone a correct replay cannot reproduce.
- `channelsFromDiscovery` turns a PyBoy discovery document into RetroArch channels, so the same blind-discovered work-RAM addresses drive two unrelated emulators and neither adapter carries a hand-copied address.
- The adapter gate is a cross-emulator proof, not just an emulator run: the 266-input reference discovered on PyBoy derives a contract that verifies clean through RetroArch and gambatte, rejects a garbage script of equal length, and reproduces every evidence snapshot in a separately launched emulator.
- The black box was measured rather than assumed, and `docs/adapters.md` records each measurement: `FRAMEADVANCE` is edge triggered, save and load state only fire when they travel with a frame advance, one `READ_CORE_MEMORY` reply must fit 2048 bytes, the remote gamepad consumes one message per poll, RetroArch serves one instance at a time, and an unset directory setting segfaults the emulator inside `retro_run`.

### Continuous integration

- A `real-retroarch` job installs RetroArch, the gambatte core, and the verified free Libbet ROM from their own upstreams and runs the black-box host gate on the same pool. The job reports an explicit warning and skips instead of failing if the pool cannot install the emulator.

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
