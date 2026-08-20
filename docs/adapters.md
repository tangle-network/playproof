# Execution adapters

An adapter is the bridge between one kind of game and the Playproof core.
It declares four things and nothing else: what it executes, what the agent is allowed to see, what privileged evidence the harness collects, and which verification mode the result can honestly claim.

The core never changes when a new adapter arrives.

## Adapter matrix

| Adapter | Executes | Observation channel | Evidence channel | Verification mode | Runs on CI? |
|---|---|---|---|---|---|
| `adapters/native-2048` | A seeded 2048 implementation in a child process | Rendered text board | Engine state, save file, append-only events, rendered fields | `replay` | Yes, no external assets |
| `adapters/native-desktop` | An arbitrary desktop executable, launched or attached after launcher handoff | Process stdout or a capture helper | Bounded JSON/binary saves, event files, rendered fields, authorized read-only reads | `trusted-recorder` | No, needs the game |
| `adapters/pyboy-generic`, `adapters/pyboy-tetris` | Game Boy ROM on PyBoy, headless, out of process | ASCII frame plus a variable summary | RAM-decoded engine state, save-state hash, framebuffer hash | `replay` | No, ROM is user-supplied |
| `adapters/stable-retro` | Any console stable-retro bundles a libretro core for, out of process | ASCII frame downsample plus a variable summary | Integration variables read from RAM, framebuffer hash, bounded derived frame numbers | `replay` | **Yes**, on the bundled free ROM |
| `adapters/gymnasium` | Any registered Gymnasium environment with a `Discrete` action space, out of process | The `ansi` render, the text observation, or a labelled number list | Cumulative reward, step count, termination flags, numeric `info` entries, the observation hash, and a bounded projection of the observation | `replay`, for seed-deterministic environments only | **Yes**, on environments that ship with the library |
| `platforms/steam` | Nothing; the title runs elsewhere | Not provided by the adapter | Steam Web API achievements and statistics, or a title-side bridge | `platform-attested` | Contract tests only |
| `platforms/xbox` | Nothing; the title runs elsewhere | Not provided by the adapter | Xbox services achievements and statistics, or a GDK/XSAPI bridge | `platform-attested` | Contract tests only |

Read the mode column strictly.
`replay` means a verifier re-executed the run and recomputed every milestone.
`trusted-recorder` means a named recorder signed what it captured and nothing was independently reproduced.
`platform-attested` means a signed recorder read normalized progress from a platform API; it is not a signature from that platform.

## What a replay adapter must prove

Two adapters claim `replay`, and both had to earn it with a measurement rather than an assumption.

An emulator is not automatically deterministic in the way replay verification needs.
The requirement is narrower than "the emulator is deterministic": each evidence field a contract can pin must be reproducible in a **different process**, because a verifier never shares the emulator that produced the run.

For stable-retro this was measured, not assumed, and the result shaped the adapter:

- Rendered frames and integration variables are bit-identical across separate worker processes over the full reference playthrough. Both are published as evidence.
- The raw libretro save-state serialization is **not** byte-stable across processes. On Airstriker-Genesis, 165 of 1,036,288 bytes move between runs, in padding around offset 140k. Hashing that blob would pin a milestone no correct replay could reproduce, so the adapter publishes no `saveBlobHash`.
- Save states remain exact inside one worker, so checkpoint and restore still work for frontier exploration.

The PyBoy adapter reaches the opposite conclusion on its own substrate and does publish a save-state hash.
Neither answer generalizes. A new replay adapter measures its own substrate before it declares a tier.

## Libretro consoles through stable-retro

```ts
import { makeStableRetro } from '@tangle-network/playproof/adapters/stable-retro'

const { game, contract, reference, inputs, dispose } = makeStableRetro({
  game: 'Airstriker-Genesis',
})
```

One Python worker serves every console in the integration set: NES, SNES, Genesis/Mega Drive, Game Boy, Game Boy Color, Game Boy Advance, Atari 2600, Sega Master System, Game Gear, and PC Engine.
Nothing in the adapter is console-specific. Button names, privileged variables, and screen resolution all come from the selected game's integration data.

**Inputs.** One word per turn. `NOOP`, any button name the core reports, and any `+`-joined combination of them, such as `LEFT+B`.
The advertised vocabulary is returned as `inputs`; combinations outside it still work.
Unknown words are no-ops, because an agent typo is not a cheat.
Each input is held for `frames` emulator frames, four by default.

**Evidence.** The integration's `data.json` names RAM addresses for the values the game itself keeps: score, lives, level, and so on.
The worker reads them each step into `engineState`.
`frameHash` is the SHA-256 of the rendered frame, and `frameState` carries a few bounded numbers derived from that frame.
The agent never sees any of it.

**Contracts.** A reference file declares the trigger for each milestone; `deriveContract` replays the reference and samples the value or hash that actually held at that instant.
No threshold or hash is written by hand.

**ROMs.** Playproof distributes no ROMs.
`Airstriker-Genesis` is the exception the ecosystem already provides: it ships inside stable-retro under a free licence, which is why the adapter and its test run on a clean CI machine with no secret.
Add legally obtained ROMs for the other integrations with:

```bash
python -m retro.import /path/to/roms
```

Then supply a reference playthrough for the game through `options.reference`.

## Any Gymnasium environment

```ts
import { makeGymnasium } from '@tangle-network/playproof/adapters/gymnasium'

const { game, contract, reference, inputs, dispose } = makeGymnasium({
  envId: 'FrozenLake-v1',
})
```

One Python worker serves any environment registered with [Gymnasium](https://gymnasium.farama.org) whose action space is `Discrete`: classic control, toy text, procedurally generated suites, text environments, and third-party environments that register the same way.
Nothing in the adapter is environment-specific.
`MultiDiscrete`, `MultiBinary`, and `Box` action spaces are refused at boot, because a word-to-vector encoding for a continuous action is a design decision this adapter does not make for the caller.

**Inputs.** One word per turn: `NOOP` plus one name per discrete action.
Names come from `env.unwrapped.get_action_meanings()` when the environment exposes it, and are `a0` … `a{n-1}` otherwise.
A discrete action space has no guaranteed idle action, so a no-op cannot be "repeat nothing" the way a console controller can.
`NOOP` and every unknown word therefore do not call `env.step` at all: the environment is left exactly where it was.
An agent typo is not a cheat, and it must not silently advance the episode either.
An environment that names one of its own actions `NOOP`, as ALE does, keeps that real action.

**Observation.** The `ansi` render when the environment advertises one, the observation itself when it is text, and a labelled number list otherwise, followed by a step and reward summary line.
A toy-text `ansi` render marks the agent's own cell with a terminal colour escape and nothing else, so the worker converts the highlight to brackets before it strips the escapes; dropping them outright would delete the agent's position from the frame.

**Evidence.** `engineState` carries `cumulativeReward`, `steps`, `terminated`, `truncated`, and the numeric entries of the environment's `info` dictionary, bounded to the first 16.
`frameHash` is the SHA-256 of the whole observation — over its dtype, shape, and raw bytes for a dense array, and over its canonical JSON otherwise — and `frameState` carries the first 8 observation components.
Playproof evidence is integer-only, so reward, numeric `info` entries, and observation components are multiplied by 1000 and rounded.
Reward 1.0 is `cumulativeReward` 1000.
`steps`, `terminated`, and `truncated` are counts and flags and are never scaled.

**The honest limit.** A generic Gymnasium environment has **no privileged channel the agent cannot author**.
Reward, `info`, and the observation are exactly what the environment hands the policy.
An emulator adapter reads a score out of RAM that the agent never sees; this adapter cannot, so read its tier as reward-derived rather than hidden.
What survives is the part that does the verification work: replay.
The verifier re-executes the environment from the seed and the input log and recomputes every milestone, so a claimed milestone the environment does not produce is still rejected.
What is lost is the ability to surprise the agent with a progress signal it could not have computed itself.

**Determinism.** Replay verification needs `reset(seed=…)` to fix the entire trajectory: either the dynamics are deterministic, or every stochastic draw comes from the environment's seeded `np_random`.
`CartPole-v1` satisfies this, and `FrozenLake-v1` with `is_slippery: false` has no stochastic transition left at all.
`gymnasium.test.mts` measures both across separate worker processes rather than assuming them.
An environment that reads a clock, a global RNG, or external state is not replay-verifiable and must not be given a contract.

**Checkpoints.** Gymnasium exposes no generic state API, so the general checkpoint is `{seed, inputs}` and restore is `reset(seed)` followed by a replay — exact for the environments above, and the only sound answer for the rest.
Where the environment keeps its position in one readable attribute (`state` for classic control, `s` for toy text), the worker also writes a JSON copy of that attribute, and restore puts it back directly instead of replaying.
`pickle` is never used: a checkpoint stays a plain protocol value a verifier can read.
The fast path is exact for environments whose `step` is a deterministic function of that attribute; `GymRpc.snapshot('replay')` forces the general path, and the gate proves both.

**Contracts.** A reference file declares the trigger for each milestone; `deriveContract` replays the reference and samples the value or hash that actually held at that instant.
No threshold or hash is written by hand.
Playproof ships two reference playthroughs — a scripted balancing run on `CartPole-v1` and the shortest winning path on the `FrozenLake-v1` 4x4 map.
Both environments are part of Gymnasium itself, so the adapter and its gate run on a clean CI machine with no asset:

```bash
pip install "gymnasium[toy-text]"
PLAYPROOF_REQUIRE_GYM=1 pnpm test:gym
```

For any other environment, supply a reference playthrough through `options.reference`.

## Candidate adapters

Ordered by how much reach each one buys per unit of work.

**Direct libretro core loader over `ctypes`.** stable-retro compiles a fixed set of cores into its own binary. Loading `libretro.so` cores directly through the C ABI turns the ceiling into "any core that exists": N64 through Mupen64Plus, DS through melonDS, PS1 through Beetle PSX or PCSX-ReARMed, PSP through PPSSPP, 3DS, arcade through MAME or FinalBurn Neo, DOS through DOSBox, and adventure games through ScummVM. The libretro ABI already exposes exactly what Playproof needs — `retro_run`, `retro_serialize`, `retro_unserialize`, `retro_get_memory_data`, and a fixed input descriptor — so this should be **one** worker with a per-core manifest declaring the memory map, the button layout, and the save-state stability the core actually offers. Each new core becomes a data file, not code. The determinism question above must be answered per core: several of these are known to be non-reproducible across processes and would honestly be `trusted-recorder`.

**RetroArch as a black-box host.** RetroArch ships every libretro core the `ctypes` loader would target and already exposes the control surface Playproof needs without any C ABI work: the network command interface (`network_cmd_enable`) accepts `FRAMEADVANCE`, `PAUSE_TOGGLE`, `SAVE_STATE`, `LOAD_STATE`, `READ_CORE_MEMORY`, `SCREENSHOT`, and `GET_STATUS` over UDP, and the network remote gamepad (`network_remote_enable`) accepts per-frame button state over UDP. One worker that launches RetroArch with a core, a ROM, and those two interfaces enabled gives frame-stepped execution, RAM-backed evidence, save states, and frame capture for N64, DS, PS1, PSP, GameCube and Wii, Dreamcast, Saturn, 3DS, and arcade in one stroke, using the core binaries the libretro buildbot already publishes. It is cheaper than the direct loader and should come first; the direct loader remains the answer where RetroArch cannot run headless or where a core needs a tighter step boundary than `FRAMEADVANCE` offers. Determinism is still a per-core measurement, exactly as for stable-retro, and cores that do not reproduce across processes declare `trusted-recorder`.

**ALE (`ale-py`).** The Atari benchmark the reinforcement-learning literature is built on. It gives directly comparable numbers against decades of published baselines, and its deterministic mode plus sticky-action mode make the determinism boundary explicit rather than something to discover.

**Dolphin (GameCube and Wii).** Reachable through the scripting fork's Lua and Python bindings, which expose memory reads and save states. High value because it opens a console generation nothing else here covers, and high cost because its determinism story is weak and it would likely declare `trusted-recorder`.

**Browser and web games through the desktop worker.** The existing native-desktop adapter already models "launch it, feed allowlisted input, capture bounded observations". A browser target fits that shape with a page-driver observation channel instead of stdout. Evidence would be DOM or storage reads, which makes it `trusted-recorder`, and it reaches the large body of games that have no native build at all.

## Evaluated and deferred

**xemu (original Xbox).** A QEMU-based emulator with snapshots and a debug monitor but no scripting or memory-read API, and it needs a legally dumped MCPX boot ROM, flash, and hard-disk image before a game can boot. It fits the native-desktop worker today (launch, allowlisted input, bounded capture, snapshot files as evidence) in `trusted-recorder` mode; a replay-grade adapter would need QMP-level frame stepping that xemu does not expose. Worth doing only for a study that specifically targets the original Xbox catalog.

**WinDurango (Xbox One).** A pre-alpha compatibility layer that reimplements Xbox One system libraries on Windows for a handful of titles. Windows-only, per-game, no input, state, or memory interface, and it needs game packages extracted from a console. Not integrable now; revisit when it exposes a stable process-level surface.

**RetroArch builds for Xbox consoles (XboxEmulationHub).** These run RetroArch on Xbox Series hardware in developer mode; they emulate nothing Xbox. They do not help the execution side, and the platform side is already covered by the Xbox evidence adapter. Benchmarking an agent on real Xbox hardware is a capture-and-input rig problem (video capture plus a virtual-controller injector feeding the desktop worker) with Xbox services as the evidence channel, not an emulator problem.
