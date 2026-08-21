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
| `adapters/ale` | Any Atari 2600 ROM `ale-py` bundles, out of process | ASCII frame downsample plus a score, lives, and frame summary | Cumulative score, lives, emulator counters, named RAM bytes, framebuffer hash, emulator-state hash | `replay` | **Yes**, on the bundled ROM set |
| `adapters/gymnasium` | Any registered Gymnasium environment with a `Discrete` action space, out of process | The `ansi` render, the text observation, or a labelled number list | Cumulative reward, step count, termination flags, numeric `info` entries, the observation hash, and a bounded projection of the observation | `replay`, for seed-deterministic environments only | **Yes**, on environments that ship with the library |
| `adapters/retroarch` | Any libretro core, inside a RetroArch process the adapter launches and drives as a black box | ASCII downsample of the screenshot plus a one-line channel summary | Caller-declared memory channels read with `READ_CORE_MEMORY`; screenshot hash and derived frame numbers are published but not pinned by default | `replay` | **Yes**, on a downloaded core and the free Libbet ROM |
| `platforms/steam` | Nothing; the title runs elsewhere | Not provided by the adapter | Steam Web API achievements and statistics, or a title-side bridge | `platform-attested` | Contract tests only |
| `platforms/xbox` | Nothing; the title runs elsewhere | Not provided by the adapter | Xbox services achievements and statistics, or a GDK/XSAPI bridge | `platform-attested` | Contract tests only |

Read the mode column strictly.
`replay` means a verifier re-executed the run and recomputed every milestone.
`trusted-recorder` means a named recorder signed what it captured and nothing was independently reproduced.
`platform-attested` means a signed recorder read normalized progress from a platform API; it is not a signature from that platform.

## What a replay adapter must prove

Three emulator adapters claim `replay`, and each had to earn it with a measurement rather than an assumption.

An emulator is not automatically deterministic in the way replay verification needs.
The requirement is narrower than "the emulator is deterministic": each evidence field a contract can pin must be reproducible in a **different process**, because a verifier never shares the emulator that produced the run.

For stable-retro this was measured, not assumed, and the result shaped the adapter:

- Rendered frames and integration variables are bit-identical across separate worker processes over the full reference playthrough. Both are published as evidence.
- The raw libretro save-state serialization is **not** byte-stable across processes. On Airstriker-Genesis, 165 of 1,036,288 bytes move between runs, in padding around offset 140k. Hashing that blob would pin a milestone no correct replay could reproduce, so the adapter publishes no `saveBlobHash`.
- Save states remain exact inside one worker, so checkpoint and restore still work for frontier exploration.

ALE was measured the same way and gives the opposite answer:

- Screens, RAM, emulator counters, and the serialized `ALEState` are byte-identical across separate worker processes at all 211 snapshots of the Breakout reference, on ale-py 0.12.1.
- The state blob is 7,705 bytes and the same length at every snapshot.
- The adapter therefore publishes `saveBlobHash`, and the bundled contract pins a save-file milestone that a verifier can recompute.

The PyBoy adapter reaches the same conclusion as ALE on its own substrate and does publish a save-state hash.
No answer generalizes. A new replay adapter measures its own substrate before it declares a tier.

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

## Atari through ALE

```ts
import { makeAle } from '@tangle-network/playproof/adapters/ale'

const { game, contract, reference, inputs, dispose } = makeAle({ game: 'breakout' })
```

The Arcade Learning Environment is the Atari 2600 substrate the reinforcement-learning literature reports on.
A Playproof score on one of these ROMs is therefore directly comparable with published baselines.

The worker drives `ALEInterface` and not a Gymnasium wrapper, which keeps the determinism knobs explicit.
Playproof sets `random_seed`, sets `repeat_action_probability` to 0, sets the emulator `frame_skip` to 1, and applies the frame repeat itself.
Sticky actions stay available through `repeatActionProbability`, but a run that enables them is no longer replay-verifiable.

**Inputs.** One word per turn, taken from the game's minimal action set and named by the ALE `Action` enum: `NOOP`, `FIRE`, `UP`, `RIGHT`, `LEFT`, `DOWN`, `UPRIGHT`, and the rest.
The vocabulary is returned as `inputs`.
Unknown words are no-ops, because an agent typo is not a cheat.
Each input is held for `frames` emulator frames, four by default.

**Evidence.** `engineState` carries the cumulative score, the lives counter, the emulator frame counters, and a terminal flag.
The 128-byte RAM page is never published whole.
The caller names the bytes it wants as channels, and only those reach the evidence:

```ts
makeAle({
  game: 'breakout',
  channels: [{ id: 'ram_ball_x', index: 99, decode: 'u8' }],
})
```

`frameHash` is the SHA-256 of the raw RGB screen, and `saveBlobHash` is the SHA-256 of the serialized `ALEState`.
The agent never sees any of it.

**Contracts.** A reference file declares the trigger for each milestone.
`deriveContract` replays the reference and samples the value or hash that actually held at that instant.
No threshold or hash is written by hand.

**ROMs.** `ale-py` bundles the Atari ROM set, so this adapter needs no download and no secret.
The bundled reference plays Breakout and reaches a score of 5 over 210 inputs, which opens milestones on all three evidence tiers.
Supply a reference playthrough through `options.reference` for any other ROM.

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

## Any RetroArch core through the black-box host

`adapters/retroarch` links no emulator. It launches the RetroArch binary the caller names and drives it over the two UDP interfaces RetroArch already publishes, so the reachable set is every core RetroArch can load rather than the set some Python package chose to bundle.

### The two interfaces

| Interface | Setting | Playproof uses it for |
|---|---|---|
| Network command | `network_cmd_enable`, `network_cmd_port` | `FRAMEADVANCE` one frame, `READ_CORE_MEMORY <hexaddr> <n>` for evidence, `SCREENSHOT`, `SAVE_STATE` and `LOAD_STATE` for checkpoints, `PAUSE_TOGGLE` and `RESET` for boot, `GET_STATUS` as the acknowledgement every other verb lacks |
| Network remote gamepad | `network_remote_enable`, `network_remote_base_port` | One 20-byte `struct remote_message { int port, device, index, id; uint16_t state; }` per button transition |

### What the black box forced, and what was measured

RetroArch is not an API, so each of these is a measurement against the real binary rather than a documented contract. RetroArch 1.22.2 was the version measured.

| Behaviour | Measurement | Consequence for the worker |
|---|---|---|
| Unset directory settings | RetroArch copies path settings with `strlcpy` during the first `retro_run` and segfaults on a NULL | The generated config sets **every** directory key, and the core is copied into the run's own `libretro_directory` |
| `video_driver = "null"` | Boots headless, opens no window, and still serves `SCREENSHOT`; frame-by-frame hashes matched the `gl` driver exactly | Headless is the default, and no display is required |
| `FRAMEADVANCE` | Edge triggered: two advance datagrams in consecutive polls advance **one** frame | Every frame costs an advance poll and then a poll without it |
| Frame-advance throughput | ~59 frames per second paused; ~80 with `FAST_FORWARD_HOLD` in the advance datagram, which removes the throttle without changing how many frames the core runs | The advance datagram holds fast-forward |
| `SAVE_STATE` and `LOAD_STATE` | Checked far enough down the hotkey path that a paused iteration never reaches them; both work when they travel in the same datagram as `FRAMEADVANCE`. `SAVE_STATE` samples the state before that frame runs; `LOAD_STATE` consumes the frame | `snapshot` and `restore` both leave the emulator one frame past the snapshotted instant, which is what makes the round trip exact |
| `READ_CORE_MEMORY` reply size | One reply must fit one UDP datagram; 2048 bytes per request works, 4096 does not | Channels are covered by as few capped block reads as possible, all sent in one datagram |
| Remote gamepad | Holds its bitmask until a later message changes it, and RetroArch reads at most one remote message per poll | A message is sent only when a button changes, and a combo drains one poll per changed button |
| Instances | A second RetroArch refuses to come up while one is running | One worker owns one emulator; dispose before booting the next |
| `LOAD_STATE` aftermath | A state load reinitialises the video, input, and audio drivers, and that reinitialisation sometimes ends the process | Resets replace the emulator and restore the SAME pinned boot blob, so a dead emulator never reaches the run |
| Launch race | A launch can come up without a run loop, so the process lives and answers nothing. Never observed mid-run | Bounded relaunch, six attempts |
| macOS state restoration | After an unclean exit AppKit blocks every later launch inside `-[NSApplication _reopenWindowsAsNecessaryIncludingRestorableState:]`, before RetroArch runs any of its own code | The worker deletes the saved state before each launch and names `defaults write <bundle-id> ApplePersistenceIgnoreState -bool YES` in the failure message |
| macOS App Nap | A windowless background application is throttled, which stalls frame advance for seconds at a time mid-run | The failure message names `defaults write <bundle-id> NSAppSleepDisabled -bool YES` |

### Determinism

Libretro cores take no seed, so `init(seed)` cannot rebuild a run the way a seeded environment can. Instead the worker pins a boot state — pause, `RESET`, `bootFrames` fixed advances, save state — and `init` restores it. Every later transition is an explicit, counted frame advance from that state, so the input log plus the boot state is the complete determinism key. The seed is recorded and reported so run artifacts keep one shape, but it is nominal.

The result of that procedure is saved once, and every reset restores the save. Re-running the reset instead is not equivalent: a core reset does not clear video memory or the picture-processing state, so a second reset lands the title-screen animation at a phase that depends on the run before it. Measured over 41 evidence snapshots between two separately launched emulators, re-running the reset reproduced work RAM 40 times and the screen twice, while restoring the pinned save reproduced work RAM every time.

`bootFrames` is a real per-game knob, because a core reset does not clear work RAM: until the game finishes its own initialisation, the boot state inherits whatever the launch race produced. Measured on gambatte with Libbet over 61 evidence snapshots between two separately launched emulators:

| `bootFrames` | `engineState` snapshots identical | Screen snapshots identical |
|---|---|---|
| 60 | 20 of 21 | 20 of 21 |
| **180** | **61 of 61** | 37 of 61 |
| 300 | 61 of 61 | 37 of 61 |

### What is published, and what is pinned

Every milestone this adapter derives is `engine-state`. Screen evidence is published — the agent sees the screen, and `frameHash` and `frameState` travel with each snapshot — but no milestone is pinned to it unless the caller passes `screenMilestones: true`.

That is a measurement, not caution. Two separately launched emulators reproduce every privileged channel at every one of 61 snapshots, and reproduce the screen for the first 37 before a fade drifts one animation step out of phase; the divergence starts at the same snapshot at `bootFrames` 180 and 300, so it is the game reading residue a core reset does not clear, not the boot length. A screen milestone would therefore pin a frame that an honest replay in a fresh process cannot reproduce. `screenMilestones` exists for cores and games where the same measurement comes out clean.

No `saveBlobHash` is published either. RetroArch compresses save states, and a compressed state is not a stable identity for a game position; the bytes were measured **not** equal between processes at the same instant. Checkpoints stay exact within one worker, which is all snapshot and restore need.

### The cross-emulator proof

The gate does not merely run a Game Boy game. It replays the 266-input reference from `pyboy/discovery-libbet.json` — whose channel addresses a blind search found by watching **PyBoy's** work RAM — through RetroArch and gambatte, software that shares no code with PyBoy. `channelsFromDiscovery` converts the discovered addresses into RetroArch channels, so one discovery document drives two unrelated emulators and neither adapter carries a hand-copied address.

The hard assertion is the milestone outcome: the contract derived over those channels verifies clean through RetroArch, and a garbage script of equal length is rejected. Per-step channel agreement with PyBoy's own recorded values is reported rather than asserted exactly, because two emulators put frame boundaries in different places and a channel that samples an animation can disagree on a few steps.

## Candidate adapters

Ordered by how much reach each one buys per unit of work. RetroArch as a black-box host was the first entry here and is now shipped; see [Any RetroArch core](#any-retroarch-core-through-the-black-box-host) above.

**Direct libretro core loader over `ctypes`.** stable-retro compiles a fixed set of cores into its own binary. Loading `libretro.so` cores directly through the C ABI turns the ceiling into "any core that exists": N64 through Mupen64Plus, DS through melonDS, PS1 through Beetle PSX or PCSX-ReARMed, PSP through PPSSPP, 3DS, arcade through MAME or FinalBurn Neo, DOS through DOSBox, and adventure games through ScummVM. The libretro ABI already exposes exactly what Playproof needs — `retro_run`, `retro_serialize`, `retro_unserialize`, `retro_get_memory_data`, and a fixed input descriptor — so this should be **one** worker with a per-core manifest declaring the memory map, the button layout, and the save-state stability the core actually offers. Each new core becomes a data file, not code. The determinism question above must be answered per core: several of these are known to be non-reproducible across processes and would honestly be `trusted-recorder`.

**Dolphin (GameCube and Wii).** Reachable through the scripting fork's Lua and Python bindings, which expose memory reads and save states. High value because it opens a console generation nothing else here covers, and high cost because its determinism story is weak and it would likely declare `trusted-recorder`.

**Browser and web games through the desktop worker.** The existing native-desktop adapter already models "launch it, feed allowlisted input, capture bounded observations". A browser target fits that shape with a page-driver observation channel instead of stdout. Evidence would be DOM or storage reads, which makes it `trusted-recorder`, and it reaches the large body of games that have no native build at all.

## Evaluated and deferred

**xemu (original Xbox).** A QEMU-based emulator with snapshots and a debug monitor but no scripting or memory-read API, and it needs a legally dumped MCPX boot ROM, flash, and hard-disk image before a game can boot. It fits the native-desktop worker today (launch, allowlisted input, bounded capture, snapshot files as evidence) in `trusted-recorder` mode; a replay-grade adapter would need QMP-level frame stepping that xemu does not expose. Worth doing only for a study that specifically targets the original Xbox catalog.

**WinDurango (Xbox One).** A pre-alpha compatibility layer that reimplements Xbox One system libraries on Windows for a handful of titles. Windows-only, per-game, no input, state, or memory interface, and it needs game packages extracted from a console. Not integrable now; revisit when it exposes a stable process-level surface.

**RetroArch builds for Xbox consoles (XboxEmulationHub).** These run RetroArch on Xbox Series hardware in developer mode; they emulate nothing Xbox. They do not help the execution side, and the platform side is already covered by the Xbox evidence adapter. Benchmarking an agent on real Xbox hardware is a capture-and-input rig problem (video capture plus a virtual-controller injector feeding the desktop worker) with Xbox services as the evidence channel, not an emulator problem.
