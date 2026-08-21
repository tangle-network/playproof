"""Tetris wiring for the PyBoy worker (game-specific constants and reads).

RAM map and menu flow come from the MIT-licensed disassembly
alexsteb/tetris_disassembly @ b4bbceb3 (constants.asm), NOT hand-discovered
magic. This file is the "one engine, one wiring" cost named by tier A: every
emulator benchmark has a per-game address table; the milestone CONTRACT still
carries no hand-copied constants (hashes and thresholds are sampled from
replays by the authoring layer).

Playfield geometry (verified empirically against the assembled ROM):
  - BG tilemap at 0x9800; well interior = tilemap columns 2..11 x rows 0..17.
  - empty cell tile = 0x2F; locked pieces use tiles >= 0x80.
  - falling piece is OAM sprites; locked pieces are BG tiles.
"""

# RAM addresses (see module docstring for provenance)
A_SCORE_HI = 0xC0A2  # BCD, 10000s and above
A_SCORE_MID = 0xC0A1  # BCD, 100s
A_SCORE_LO = 0xC0A0  # BCD, 1s
A_LINES_HI = 0xFF9F  # BCD, 100s
A_LINES_LO = 0xFF9E  # BCD, 1s
A_LEVEL = 0xFFC2  # current level, type A
A_STATUS = 0xFFE1  # game status table (constants.asm @ rGAME_STATUS)
A_BLOCK_Y = 0xC201  # falling piece Y, pixels
A_BLOCK_X = 0xC202  # falling piece X, pixels
A_BLOCK_TYPE = 0xC203  # falling piece type id
A_NEXT_TYPE = 0xC213  # next piece type id

# Game-status values used here (constants.asm table)
ST_INGAME = 0x00
ST_TITLE = 0x07
ST_SELECT_TYPE = 0x0E
ST_SELECT_LEVEL_A = 0x11

# Playfield geometry
WELL_TILEMAP_BASE = 0x9800
WELL_COL_FIRST = 2
WELL_COLS = 10
WELL_ROWS = 18
WELL_TILE_EMPTY = 0x2F
# Screen-pixel bounds of the well interior (tilemap col 2 -> x=16; row 0 -> y=0)
WELL_PX_X0 = WELL_COL_FIRST * 8
WELL_PX_Y0 = 0

# Buttons accepted as step inputs; anything else is a no-op advance.
BUTTONS = ('up', 'down', 'left', 'right', 'a', 'b', 'start', 'select')

# Per-step emulator timing: press N frames, release, settle M frames. Fixed
# constants keep the input log a complete determinism key (TAS doctrine).
PRESS_FRAMES = 2
SETTLE_FRAMES = 8


def _bcd(byte):
    """One byte = two BCD digits (constants.asm stores score/lines in BCD)."""
    return (byte >> 4) * 10 + (byte & 0x0F)


def read_engine_state(pyboy, emu_frame):
    score = _bcd(pyboy.memory[A_SCORE_HI]) * 10000 + _bcd(pyboy.memory[A_SCORE_MID]) * 100 + _bcd(pyboy.memory[A_SCORE_LO])
    lines = _bcd(pyboy.memory[A_LINES_HI]) * 100 + _bcd(pyboy.memory[A_LINES_LO])
    status = pyboy.memory[A_STATUS]
    return {
        'score': score,
        'lines': lines,
        'level': pyboy.memory[A_LEVEL],
        'gameStatus': status,
        'inGame': 1 if status == ST_INGAME else 0,
        'emuFrame': emu_frame,
    }


def _wait_status(pyboy, targets, limit=3000):
    for _ in range(limit):
        pyboy.tick(1, False)
        if pyboy.memory[A_STATUS] in targets:
            return
    raise TimeoutError(f'game status never reached {targets}, stuck at {pyboy.memory[A_STATUS]:#x}')


def apply_input(pyboy, word):
    """One step input: fixed press+settle window. Returns nothing; the worker
    advances its frame counter.

    The LAST settle frame renders. PyBoy treats `render=False` as frameskipping
    and leaves the LCD output buffer alone, so a worker that never renders
    reports one constant screen for a whole run. Measured on the 266-input
    Libbet reference: the framebuffer hash took ONE distinct value with
    rendering off and eight with it on. A screen-frame milestone pinned on that
    constant is reproduced by every run, including one that never presses a
    button, so it verified nothing.

    Rendering the final frame of the window was measured to leave every
    privileged variable untouched, identical at all 267 snapshots of the
    reference, and to cost about one per cent of wall time. It does change
    `saveBlobHash`, because PyBoy serializes its renderer state into the save,
    so a save-file milestone recorded before this change does not reproduce
    after it.
    """
    btn = word if word in BUTTONS else None
    if btn:
        pyboy.button_press(btn)
    for _ in range(PRESS_FRAMES):
        pyboy.tick(1, False)
    if btn:
        pyboy.button_release(btn)
    for frame in range(SETTLE_FRAMES):
        pyboy.tick(1, frame == SETTLE_FRAMES - 1)


def run_preamble(pyboy):
    """Execute the preamble on a freshly booted ROM: title -> 1-player A-type
    -> level 0 -> in-game. Menu screens ignore buttons for a short window
    after they appear, so each screen transition retries the START press
    until the status register confirms the advance. Purely status-driven,
    hence deterministic; the recorded episode never includes these words
    (the preamble runs inside init, before the input log starts)."""
    _wait_status(pyboy, {ST_TITLE})

    def advance(targets, max_presses=10):
        for _ in range(max_presses):
            if pyboy.memory[A_STATUS] in targets:
                return
            apply_input(pyboy, 'start')
            for _ in range(400):
                if pyboy.memory[A_STATUS] in targets:
                    return
                pyboy.tick(1, False)
        raise TimeoutError(f'preamble stuck at status {pyboy.memory[A_STATUS]:#x}, wanted {targets}')

    advance({ST_SELECT_TYPE, ST_SELECT_LEVEL_A})
    advance({ST_SELECT_LEVEL_A})
    advance({ST_INGAME})
    for frame in range(6):
        # The preamble also ends on a rendered frame, so the first observation
        # an agent sees is the screen and not an unwritten buffer.
        pyboy.tick(1, frame == 5)


def well_grid(pyboy):
    """18x10 locked-block grid (True = occupied), read from BG tilemap."""
    base = WELL_TILEMAP_BASE
    grid = []
    for row in range(WELL_ROWS):
        cells = []
        for col in range(WELL_COLS):
            t = pyboy.memory[base + row * 32 + WELL_COL_FIRST + col]
            cells.append(t != WELL_TILE_EMPTY)
        grid.append(cells)
    return grid


def falling_cells(pyboy):
    """Screen-pixel cells of falling-piece OAM sprites inside the well."""
    cells = []
    for i in range(40):
        y = pyboy.memory[0xFE00 + i * 4]
        x = pyboy.memory[0xFE00 + i * 4 + 1]
        if x == 0 and y == 0:
            continue
        sx = x - 8
        sy = y - 16
        if WELL_PX_X0 <= sx < WELL_PX_X0 + WELL_COLS * 8 and WELL_PX_Y0 <= sy < WELL_PX_Y0 + WELL_ROWS * 8:
            cells.append((sx // 8, sy // 8))
    return cells


def render_frame(pyboy, engine):
    """Agent observation: compact ASCII well with the falling piece overlaid,
    plus a status line. Locked-only rendering would hide the live piece."""
    grid = well_grid(pyboy)
    falling = falling_cells(pyboy)
    lines = []
    for row in range(WELL_ROWS):
        chars = []
        for col in range(WELL_COLS):
            if (col, row) in falling:
                chars.append('o')
            else:
                chars.append('#' if grid[row][col] else '.')
        lines.append(''.join(chars))
    status = 'title' if engine['gameStatus'] == ST_TITLE else f"status {engine['gameStatus']:#04x}"
    header = f"TETRIS {status} score {engine['score']} lines {engine['lines']} level {engine['level']}"
    return header + '\n' + '\n'.join(lines)
