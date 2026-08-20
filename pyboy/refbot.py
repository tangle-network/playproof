"""Reference playthrough generator for pyboy-tetris (authoring-time tool).

Produces the ONE input script a researcher would otherwise record by hand:
a greedy Tetris player that searches every (rotation, column) placement per
piece using emulator save/restore, keeps the well flat, and stops at the first
line clear. The emitted word sequence is the reference artifact the contract
is derived from (adapters/pyboy-tetris.ts); milestone positions are found by
event predicates at derivation time, so this file bakes no contract constants.

Run:
  python3 refbot.py <rom.gb> <out-reference.json>
"""
import hashlib
import io
import json
import sys
import warnings
from datetime import date, datetime, timezone

warnings.filterwarnings('ignore')

sys.path.insert(0, __file__.rsplit('/', 1)[0])
import tetris  # noqa: E402

MAX_PIECES = 90
MAX_DROP_WORDS = 40
GUARD_WORDS = 240  # per-piece word cap across rotate+move+drop


def piece_sig(p):
    return (p.memory[tetris.A_BLOCK_TYPE], p.memory[tetris.A_BLOCK_Y])


def apply_words(p, words):
    for w in words:
        tetris.apply_input(p, w)


def drop_words(p, out):
    """Soft-drop until the piece locks (next piece spawns). Appends to out."""
    for _ in range(MAX_DROP_WORDS):
        sig = piece_sig(p)
        out.append('down')
        tetris.apply_input(p, 'down')
        now = piece_sig(p)
        if now[0] != sig[0] or now[1] < sig[1] - 8:
            return True
    return False


def evaluate(p):
    eng = tetris.read_engine_state(p, 0)
    if eng['inGame'] != 1:
        return None
    grid = tetris.well_grid(p)
    heights = [0] * tetris.WELL_COLS
    holes = 0
    for c in range(tetris.WELL_COLS):
        seen = False
        for r in range(tetris.WELL_ROWS):
            if grid[r][c]:
                if not seen:
                    heights[c] = tetris.WELL_ROWS - r
                    seen = True
            elif seen:
                holes += 1
    agg = sum(heights)
    bump = sum(abs(heights[i] - heights[i + 1]) for i in range(tetris.WELL_COLS - 1))
    return (eng['lines'], -holes, -agg, -bump)


def try_candidate(p, rot, col, snap):
    snap.seek(0)
    p.load_state(snap)
    words = ['a'] * rot
    apply_words(p, words)
    cells = tetris.falling_cells(p)
    spawn = min(cells)[0] if cells else 4
    moves = col - spawn
    move_words = ['right'] * moves if moves > 0 else ['left'] * (-moves)
    apply_words(p, move_words)
    words += move_words
    dropped = drop_words(p, words)
    if not dropped:
        return None, words
    val = evaluate(p)
    return val, words


def main():
    rom, out = sys.argv[1], sys.argv[2]
    target_lines = int(sys.argv[3]) if len(sys.argv) > 3 else 1
    from pyboy import PyBoy

    p = PyBoy(rom, window='null', sound=False, cgb=False)
    tetris.run_preamble(p)
    reference = []
    cleared = tetris.read_engine_state(p, 0)['lines']
    for piece in range(MAX_PIECES):
        if cleared >= target_lines:
            break
        snap = io.BytesIO()
        p.save_state(snap)
        snap.seek(0)
        best = None
        for rot in range(4):
            for col in range(tetris.WELL_COLS):
                val, words = try_candidate(p, rot, col, snap)
                if val is None:
                    continue
                if best is None or val > best[0]:
                    best = (val, list(words))
                if len(words) > GUARD_WORDS:
                    break
        if best is None:
            raise SystemExit('refbot: no viable placement found — search failed')
        snap.seek(0)
        p.load_state(snap)
        apply_words(p, best[1])
        reference.extend(best[1])
        cleared = tetris.read_engine_state(p, 0)['lines']
        print(f'piece {piece}: placed with {len(best[1])} words, value={best[0]}, lines={cleared}', file=sys.stderr)
    p.stop()
    if cleared < target_lines:
        raise SystemExit('refbot: failed to clear a line within the piece budget')
    rom_md5 = hashlib.md5(open(rom, 'rb').read()).hexdigest()
    doc = {
        'schemaVersion': 1,
        'gameId': 'pyboy-tetris',
        'seed': 0,
        'romMd5': rom_md5,
        'inputs': reference,
        'provenance': {
            'generator': 'pyboy/refbot.py greedy placement search',
            'generatedAt': datetime.now(timezone.utc).isoformat(),
            'note': 'word sequence replayed verbatim by the playproof runtime',
            'date': date.today().isoformat(),
        },
    }
    with open(out, 'w') as f:
        json.dump(doc, f, indent=1)
    print(f'reference: {out} ({len(reference)} inputs, lines={cleared}, {rom_md5})', file=sys.stderr)


if __name__ == '__main__':
    main()
