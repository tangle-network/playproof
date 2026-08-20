"""Generic (game-agnostic) wiring for the PyBoy worker and discovery.

Everything here works from public emulator surfaces only — screen pixels and
whole-region RAM reads. No addresses, no game knowledge. This is the module
that makes 'any Game Boy game' possible without per-game code (EXP-040):

  - boot_to_gameplay: generic preamble search (press start until the game
    responds to input the way gameplay does, not the way menus do)
  - set_channels / read_engine_state: evidence decoded from DISCOVERED
    channel addresses (from discover.py), passed in at boot
  - render_frame: luminance downsample of the framebuffer; no tilemap layout
    assumptions

Determinism: the preamble search uses a fixed seed so worker boots replay
byte-identically from power-on.
"""
import random

import tetris  # press/settle timing only (game-agnostic constants)

# Worker-facing surface: apply_input reuses the same fixed press/settle window
# as every other wiring module.
apply_input = tetris.apply_input

WRAM = (0xC000, 0xE000)
HRAM = (0xFF80, 0xFFFF)
PREAMBLE_SEED = 0
LIVE_BYTE_THRESHOLD = 40


def _regions():
    yield WRAM
    yield HRAM


def snapshot(pyboy):
    chunks = []
    for start, end in _regions():
        chunks.append(bytes(pyboy.memory[start:end]))
    return b''.join(chunks)


def _probe_delta(pyboy, rng):
    """Apply a random input burst; return how many RAM bytes moved. Menus
    move a cursor (few bytes); gameplay moves sprites/counters (many)."""
    before = snapshot(pyboy)
    for _ in range(10):
        tetris.apply_input(pyboy, rng.choice(('up', 'down', 'left', 'right', 'a', 'b')))
    after = snapshot(pyboy)
    return sum(1 for a, b in zip(before, after) if a != b)


def boot_to_gameplay(pyboy, max_presses=8):
    """Press start (with settle) until the game is live. Deterministic:
    PREAMBLE_SEED drives every probe. Returns (presses, live)."""
    rng = random.Random(PREAMBLE_SEED)
    for press in range(max_presses):
        if _probe_delta(pyboy, rng) > LIVE_BYTE_THRESHOLD:
            return press, True
        tetris.apply_input(pyboy, 'start')
    return max_presses, _probe_delta(pyboy, rng) > LIVE_BYTE_THRESHOLD


_BOOT_MODE = 'generic'


def set_boot_mode(mode):
    """'generic' (default) or 'tetris-hand' — the latter delegates to the
    hand-written Tetris preamble so Phase A replays match discovery runs
    (discovery's blind part is channel classification, not menu handling)."""
    global _BOOT_MODE
    _BOOT_MODE = mode


def run_preamble(pyboy):
    if _BOOT_MODE == 'tetris-hand':
        tetris.run_preamble(pyboy)
        return
    presses, live = boot_to_gameplay(pyboy)
    if not live:
        raise TimeoutError('generic preamble failed: game never reached a live state')


# ── discovered-channel evidence ──────────────────────────────────────────────

_CHANNELS = None


def set_channels(channels):
    """channels: [{id, addresses, decode}] from discover.py output."""
    global _CHANNELS
    _CHANNELS = channels


def _bcd(byte):
    return (byte >> 4) * 10 + (byte & 0x0F)


def _decode(pyboy, addresses, decode):
    total = 0
    power = len(addresses) - 1
    for i, a in enumerate(addresses):
        v = pyboy.memory[a]
        total += (_bcd(v) if decode == 'bcd' else v) * ((100 if decode == 'bcd' else 256) ** (power - i))
    return total


def read_engine_state(pyboy, emu_frame):
    state = {'emuFrame': emu_frame}
    for c in _CHANNELS or []:
        state[c['id']] = _decode(pyboy, c['addresses'], c.get('decode', 'bin'))
    return state


def render_frame(pyboy, engine):
    """Generic observation: 40x18 luminance grid + one status line."""
    arr = pyboy.screen.ndarray[:, :, :3]
    rows = []
    for y in range(0, 144, 8):
        row = ''
        for x in range(0, 160, 4):
            px = arr[y:y + 8, x:x + 4].mean()
            row += '#' if px < 80 else ('+' if px < 160 else '.')
        rows.append(row)
    chans = ' '.join(f"{k}={v}" for k, v in engine.items() if k != 'emuFrame')
    return f"GB {chans}\n" + '\n'.join(rows)
