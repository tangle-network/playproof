# Changelog

All notable changes to Playproof are documented here.

## 0.2.0

### Game and platform adapters

- Real-emulator PyBoy regression on the free Libbet and the Magic Floor ROM, pinned by hash and run in CI.
- The PyBoy worker no longer writes a cartridge save next to the ROM, which made each later boot start from a different state.

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
