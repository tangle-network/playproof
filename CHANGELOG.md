# Changelog

All notable changes to Playproof are documented here.

## 0.4.0

### Verification

- `calibrateContract` replays a reference trajectory and a suite of trivial policies against the same contract, then reports which milestones the trivial policies cannot reach.
- The suite is one constant policy per input word, a word the game cannot interpret, a round-robin cycle over the vocabulary, and a seeded pseudo-random walk over it. Every policy is deterministic in the seed, so a report reproduces from one number.
- `assertContractSeparates` fails closed on a contract a trivial policy satisfies, and names every trivial milestone with the baseline that earned it.
- A contract separates only when at least one milestone is out of reach of every baseline and the reference verifies strictly more milestones than the strongest baseline.
- `deriveContract` is documented as producing a hypothesis, not a benchmark. It proves that a mark fires on the reference run; it cannot prove the mark is hard to reach.
- Measured, and pinned by the Libbet regression in CI: a 70-turn agent campaign on the packaged blind-discovery contract earned three milestones, and pressing `a` seventy times earns the same three. `constant:start`, `round-robin`, and a seeded pseudo-random walk also earn them, while five of the eight buttons and an unknown word earn none.
- Measured on the packaged 2048 target: its reference is a fixed cycle of four directions, so a pseudo-random walk of the same length reaches every milestone. That target exercises the execution and evidence paths and does not measure skill.

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
