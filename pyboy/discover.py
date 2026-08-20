"""Blind progression-channel discovery (EXP-040, claim G5).

Snapshots RAM (WRAM + HRAM) at every exploration step, classifies each byte's
trajectory, and groups adjacent monotone counters into candidate progression
channels. NO game knowledge enters this file: no addresses, no decodes beyond
generic BCD/binary, no geometry. Ground truth (a disassembly, a wiki) is used
only AFTERWARD, by the researcher, to score the output — never by this code.

Trajectory classes:
  constant    never changes                     (dead)
  noise       changes in most steps             (timers, RNG, audio)
  counter-up  non-decreasing, >=1 strict rise   (score/lines/level family)
  counter-dn  non-increasing, >=1 strict fall   (lives-remaining family)
  other       everything else                   (positions, board cells)

A byte that wraps (0xFF -> 0x00) is NOT monotone; free-running counters
(frame ticks) self-eliminate. Multi-byte channels decode big-endian across
ascending addresses (GB convention: higher address = higher significance),
BCD preferred when every observed nibble is 0-9.

Run:
  python3 discover.py <rom> <out.json> [--mode script --script ref.json]
                                          [--mode random --seed 1 --steps 1500]
  Phase A uses --preamble tetris (the hand preamble, so the blind part under
  test is channel discovery alone); Phase C omits it and uses generic search.
"""
import hashlib
import json
import random
import sys
import warnings
from datetime import datetime, timezone

warnings.filterwarnings('ignore')

sys.path.insert(0, __file__.rsplit('/', 1)[0])
import generic  # snapshot + gameplay boot (game-agnostic)
import tetris  # press/settle timing (game-agnostic constants)

BUTTONS = ('up', 'down', 'left', 'right', 'a', 'b', 'start', 'select')
NOISE_FRAC = 0.5
MAX_CHANNEL_BYTES = 4


def addr_of(index):
    w = generic.WRAM[1] - generic.WRAM[0]
    if index < w:
        return generic.WRAM[0] + index
    return generic.HRAM[0] + (index - w)


def classify(traj):
    changes = sum(1 for i in range(1, len(traj)) if traj[i] != traj[i - 1])
    if changes == 0:
        return 'constant', changes
    if changes > NOISE_FRAC * (len(traj) - 1):
        return 'noise', changes
    up = all(traj[i] >= traj[i - 1] for i in range(1, len(traj)))
    dn = all(traj[i] <= traj[i - 1] for i in range(1, len(traj)))
    if up:
        return 'counter-up', changes
    if dn:
        return 'counter-down', changes
    return 'other', changes


def _bcd(byte):
    return (byte >> 4) * 10 + (byte & 0x0F)


def bcd_valid(values):
    return all((b >> 4) <= 9 and (b & 0x0F) <= 9 for b in values if b > 0)


def decode_series(series, use_bcd):
    vals = []
    for step_bytes in series:
        total = 0
        power = len(step_bytes) - 1
        for i, b in enumerate(step_bytes):
            total += (_bcd(b) if use_bcd else b) * ((100 if use_bcd else 256) ** (power - i))
        vals.append(total)
    return vals


def group_channels(classed, snaps):
    """Adjacent counter-up bytes -> channels (ascending = low significance)."""
    channels = []
    n_bytes = len(snaps[0])
    i = 0
    while i < n_bytes:
        if classed[i][0] != 'counter-up':
            i += 1
            continue
        j = i
        while j + 1 < n_bytes and classed[j + 1][0] == 'counter-up' and (j + 1 - i) < MAX_CHANNEL_BYTES:
            if addr_of(j) + 1 != addr_of(j + 1):
                break
            j += 1
        group_idx = list(range(i, j + 1))
        series = [tuple(s[k] for k in group_idx) for s in snaps]
        use_bcd = bcd_valid([b for s in series for b in s])
        vals = decode_series(series, use_bcd)
        mono = all(vals[k] >= vals[k - 1] for k in range(1, len(vals))) and vals[-1] > vals[0]
        # Saturation filter: every byte ending at its max value is a memset
        # signature (buffer fill), not a counter — junk discovered on libbet.
        fill_byte = 0x99 if use_bcd else 0xFF
        saturated = all(b == fill_byte for b in series[-1])
        first_change = next((k for k in range(1, len(vals)) if vals[k] != vals[k - 1]), None)
        if mono and first_change is not None and not saturated:
            changes = sum(1 for k in range(1, len(vals)) if vals[k] != vals[k - 1])
            channels.append({
                'addresses': [addr_of(k) for k in group_idx],
                'decode': 'bcd' if use_bcd else 'bin',
                'firstChangeStep': first_change,
                'changes': changes,
                'valueStart': vals[0],
                'valueEnd': vals[-1],
                'values': vals,
            })
        i = j + 1
    # rank: rare changes first (progression events, not ticking), then bigger delta
    channels.sort(key=lambda c: (c['changes'], -(c['valueEnd'] - c['valueStart'])))
    for n, c in enumerate(channels):
        c['id'] = 'ch_' + '_'.join(f'{a:04x}' for a in c['addresses'])
        c['rank'] = n
    return channels


def explore(pyboy, mode, script, seed, steps):
    inputs = []
    rng = random.Random(seed)
    snaps = [generic.snapshot(pyboy)]
    seq = script if mode == 'script' else None
    if seq is None and mode == 'random':
        seq = [rng.choice(BUTTONS) for _ in range(steps)]
    if seq is not None:
        for w in seq:
            tetris.apply_input(pyboy, w)
            inputs.append(w)
            snaps.append(generic.snapshot(pyboy))
        return inputs, snaps
    if mode == 'novelty':
        # Savestate-guided curiosity walk (game-agnostic): at each step, try
        # every button from a snapshot, keep the branch whose RAM state adds
        # the most unseen (address, value) pairs. The chosen path is linear,
        # so it replays from boot for attestation. Novelty rewards staying
        # alive (new screens/tiles) over dying (states repeat).
        import io

        visited = set()
        def novelty(snap_bytes):
            new = 0
            for i in range(0, len(snap_bytes), 8):  # sample stride 8
                if (i, snap_bytes[i]) not in visited:
                    new += 1
            return new
        def commit(snap_bytes):
            for i in range(0, len(snap_bytes), 8):
                visited.add((i, snap_bytes[i]))
        commit(snaps[0])
        last_words = []
        # Game-agnostic action macros: menus advance on SEQUENCES (down->a,
        # a->a confirm), which single-button candidates can never cross.
        CANDIDATES = [
            ('up',), ('down',), ('left',), ('right',), ('a',), ('b',), ('start',),
            ('down', 'a'), ('a', 'a'), ('start', 'a'), ('up', 'a'), ('left', 'a'), ('right', 'a'),
        ]
        for _ in range(steps):
            state = io.BytesIO()
            pyboy.save_state(state)
            scored = []
            for seq in CANDIDATES:
                state.seek(0)
                pyboy.load_state(state)
                for w in seq:
                    tetris.apply_input(pyboy, w)
                s = generic.snapshot(pyboy)
                scored.append((novelty(s), seq, s))
            scored.sort(reverse=True, key=lambda t: t[0])
            # Run-length cap: greedy novelty degenerates into hammering one
            # action (libbet: 'up' x 60). If the best action ran > 3 times in
            # a row, take the next-best; real play alternates.
            pick = 0
            if len(last_words) >= 3 and scored[0][1] == last_words[-1] == last_words[-2] == last_words[-3]:
                pick = 1 if len(scored) > 1 else 0
            best_score, best_seq, best_snap = scored[pick]
            state.seek(0)
            pyboy.load_state(state)
            for w in best_seq:
                tetris.apply_input(pyboy, w)
            inputs.extend(best_seq)
            last_words.append(best_seq)
            snaps.append(generic.snapshot(pyboy))
            commit(snaps[-1])
        return inputs, snaps
    raise ValueError(f'unknown mode {mode}')


def main():
    argv = sys.argv[1:]
    rom, out = argv[0], argv[1]
    mode, seed, steps = 'random', 1, 1500
    script = None
    hand_preamble = False
    it = iter(argv[2:])
    for a in it:
        if a == '--mode':
            mode = next(it)
        elif a == '--script':
            script = json.load(open(next(it)))['inputs']
        elif a == '--seed':
            seed = int(next(it))
        elif a == '--steps':
            steps = int(next(it))
        elif a == '--preamble':
            # value reserved: 'tetris' selects the hand preamble (Phase A)
            hand_preamble = next(it) == 'tetris'

    from pyboy import PyBoy
    pyboy = PyBoy(rom, window='null', sound=False, cgb=False)
    t0 = datetime.now(timezone.utc)
    if hand_preamble:
        tetris.run_preamble(pyboy)
        presses, live = 3, True
    else:
        presses, live = generic.boot_to_gameplay(pyboy)
    inputs, snaps = explore(pyboy, mode, script, seed, steps)
    classed = [classify([s[i] for s in snaps]) for i in range(len(snaps[0]))]
    channels = group_channels(classed, snaps)
    counts = {}
    for cls, _ in classed:
        counts[cls] = counts.get(cls, 0) + 1
    doc = {
        'schemaVersion': 1,
        'romMd5': hashlib.md5(open(rom, 'rb').read()).hexdigest(),
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'exploration': {
            'mode': mode,
            'preamble': 'tetris-hand' if hand_preamble else 'generic-search',
            'preamblePresses': presses,
            'gameplayDetected': live,
            'seed': seed,
            'inputs': inputs,
            'snapshots': len(snaps),
        },
        'byteClassCounts': counts,
        'channels': channels[:24],
    }
    json.dump(doc, open(out, 'w'), indent=1)
    dt = (datetime.now(timezone.utc) - t0).total_seconds()
    print(f"discovery: {len(inputs)} inputs, {len(snaps)} snapshots, "
          f"{len(channels)} channels, gameplay={live}, {dt:.1f}s", file=sys.stderr)
    for c in channels[:8]:
        print(f"  {c['id']:24s} {c['decode']:3s} {c['valueStart']}->{c['valueEnd']} "
              f"changes={c['changes']} first@{c['firstChangeStep']}", file=sys.stderr)
    pyboy.stop()


if __name__ == '__main__':
    main()
