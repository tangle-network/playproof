# Changelog

All notable changes to Playproof are documented here.

## 0.2.0

### Game and platform adapters

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
