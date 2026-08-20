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

## Candidate adapters

Ordered by how much reach each one buys per unit of work.

**Direct libretro core loader over `ctypes`.** stable-retro compiles a fixed set of cores into its own binary. Loading `libretro.so` cores directly through the C ABI turns the ceiling into "any core that exists": N64 through Mupen64Plus, DS through melonDS, PS1 through Beetle PSX or PCSX-ReARMed, PSP through PPSSPP, 3DS, arcade through MAME or FinalBurn Neo, DOS through DOSBox, and adventure games through ScummVM. The libretro ABI already exposes exactly what Playproof needs — `retro_run`, `retro_serialize`, `retro_unserialize`, `retro_get_memory_data`, and a fixed input descriptor — so this should be **one** worker with a per-core manifest declaring the memory map, the button layout, and the save-state stability the core actually offers. Each new core becomes a data file, not code. The determinism question above must be answered per core: several of these are known to be non-reproducible across processes and would honestly be `trusted-recorder`.

**RetroArch as a black-box host.** RetroArch ships every libretro core the `ctypes` loader would target and already exposes the control surface Playproof needs without any C ABI work: the network command interface (`network_cmd_enable`) accepts `FRAMEADVANCE`, `PAUSE_TOGGLE`, `SAVE_STATE`, `LOAD_STATE`, `READ_CORE_MEMORY`, `SCREENSHOT`, and `GET_STATUS` over UDP, and the network remote gamepad (`network_remote_enable`) accepts per-frame button state over UDP. One worker that launches RetroArch with a core, a ROM, and those two interfaces enabled gives frame-stepped execution, RAM-backed evidence, save states, and frame capture for N64, DS, PS1, PSP, GameCube and Wii, Dreamcast, Saturn, 3DS, and arcade in one stroke, using the core binaries the libretro buildbot already publishes. It is cheaper than the direct loader and should come first; the direct loader remains the answer where RetroArch cannot run headless or where a core needs a tighter step boundary than `FRAMEADVANCE` offers. Determinism is still a per-core measurement, exactly as for stable-retro, and cores that do not reproduce across processes declare `trusted-recorder`.

**ALE (`ale-py`).** The Atari benchmark the reinforcement-learning literature is built on. It gives directly comparable numbers against decades of published baselines, and its deterministic mode plus sticky-action mode make the determinism boundary explicit rather than something to discover.

**Gymnasium environment wrapper.** A thin bridge that turns any Gymnasium environment into a `Game`. This costs little and immediately covers control tasks, procedurally generated suites, and text environments. Its honest limit is that a generic environment offers no privileged channel the agent cannot author, so contracts must come from the environment's own reward and info dictionaries.

**Dolphin (GameCube and Wii).** Reachable through the scripting fork's Lua and Python bindings, which expose memory reads and save states. High value because it opens a console generation nothing else here covers, and high cost because its determinism story is weak and it would likely declare `trusted-recorder`.

**Browser and web games through the desktop worker.** The existing native-desktop adapter already models "launch it, feed allowlisted input, capture bounded observations". A browser target fits that shape with a page-driver observation channel instead of stdout. Evidence would be DOM or storage reads, which makes it `trusted-recorder`, and it reaches the large body of games that have no native build at all.

## Evaluated and deferred

**xemu (original Xbox).** A QEMU-based emulator with snapshots and a debug monitor but no scripting or memory-read API, and it needs a legally dumped MCPX boot ROM, flash, and hard-disk image before a game can boot. It fits the native-desktop worker today (launch, allowlisted input, bounded capture, snapshot files as evidence) in `trusted-recorder` mode; a replay-grade adapter would need QMP-level frame stepping that xemu does not expose. Worth doing only for a study that specifically targets the original Xbox catalog.

**WinDurango (Xbox One).** A pre-alpha compatibility layer that reimplements Xbox One system libraries on Windows for a handful of titles. Windows-only, per-game, no input, state, or memory interface, and it needs game packages extracted from a console. Not integrable now; revisit when it exposes a stable process-level surface.

**RetroArch builds for Xbox consoles (XboxEmulationHub).** These run RetroArch on Xbox Series hardware in developer mode; they emulate nothing Xbox. They do not help the execution side, and the platform side is already covered by the Xbox evidence adapter. Benchmarking an agent on real Xbox hardware is a capture-and-input rig problem (video capture plus a virtual-controller injector feeding the desktop worker) with Xbox services as the evidence channel, not an emulator problem.
