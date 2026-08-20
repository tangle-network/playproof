"""Arcade Learning Environment worker on the shared Playproof line-JSON protocol.

One worker serves every Atari 2600 ROM `ale-py` ships, which includes the
Atari-57 suite the reinforcement-learning literature reports on. The adapter
drives `ALEInterface` directly rather than a Gymnasium wrapper, so the
determinism knobs are explicit and set here:

  random_seed                the emulator seed, re-applied on every boot
  repeat_action_probability  0.0 by default, which disables sticky actions
  frame_skip                 1, because this worker repeats actions itself

Protocol methods:
  boot       {game, seed?, frameSkip?, repeatActionProbability?, mode?,
              difficulty?, channels?}
  reset      {seed?}
  step       {input, frames?}   one action name, repeated for `frames` frames
  evidence   {}
  frame      {}
  inputs     {}                 the game's minimal action set, as names
  snapshot   {}                 ALE state, deflate + base64
  checkpoint {}                 same blob, shaped for the shared WorkerRpc
  restore    {state}
  shutdown   {}

Determinism, measured on Breakout with ale-py 0.12.1 over the 210-input
reference: the rendered screen, the RAM, the emulator counters, and the
serialized `ALEState` are byte-identical at all 211 snapshots of two separate
worker processes. Unlike the libretro save state behind `adapters/stable-retro`,
the ALE state blob IS reproducible across processes, so this worker publishes
`saveBlobHash` and a contract may pin it.

Evidence stays bounded. The 128-byte RAM is never published whole: only the
byte indices the caller names as channels reach `engineState`.

stdout carries only protocol lines. The emulator prints its banner at the Info
log level, so the logger is lowered to Error before the interface is built.
"""
import base64
import hashlib
import json
import os
import re
import struct
import sys
import zlib

# Checkpoint container. `ALEState` restores the emulator and its frame
# counters, but ALE keeps no cumulative episode reward, so the score travels
# with the blob and restore is exact.
SNAPSHOT_MAGIC = b'PPAL'
SNAPSHOT_VERSION = 1
SNAPSHOT_HEADER = struct.Struct('<4sHd')

FRAME_ROWS = 24
FRAME_COLS = 40
GLYPHS = ' .:-=+*#%@'
# Atari screens are mostly dark, so a linear ramp collapses gameplay into
# blanks. A square-root curve keeps sprites legible without per-frame
# normalization, which would make the observation jump between frames.
GLYPH_RAMP = tuple(
    min(len(GLYPHS) - 1, int(((value / 255.0) ** 0.5) * (len(GLYPHS) - 1) + 0.5))
    for value in range(256)
)
RAM_SIZE = 128
MAX_CHANNELS = 32
CHANNEL_ID = re.compile(r'^[A-Za-z][A-Za-z0-9_]{0,31}$')
NOOP = 'NOOP'


def _rom_sha(path):
    with open(path, 'rb') as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def _parse_channels(raw):
    """Validate the caller's RAM channel list. Anything unsound fails the boot."""
    if not raw:
        return []
    if len(raw) > MAX_CHANNELS:
        raise ValueError(f'at most {MAX_CHANNELS} RAM channels, got {len(raw)}')
    channels = []
    seen = set()
    for entry in raw:
        channel_id = entry.get('id')
        if not isinstance(channel_id, str) or not CHANNEL_ID.match(channel_id):
            raise ValueError(f'RAM channel id must match {CHANNEL_ID.pattern}, got {channel_id!r}')
        if channel_id in seen:
            raise ValueError(f'duplicate RAM channel id {channel_id!r}')
        decode = entry.get('decode', 'u8')
        if decode != 'u8':
            raise ValueError(f'RAM channel {channel_id!r} asks for decode {decode!r}; only u8 is supported')
        index = entry.get('index')
        if not isinstance(index, int) or isinstance(index, bool) or not 0 <= index < RAM_SIZE:
            raise ValueError(f'RAM channel {channel_id!r} index must be 0..{RAM_SIZE - 1}, got {index!r}')
        seen.add(channel_id)
        channels.append({'id': channel_id, 'index': index, 'decode': decode})
    return channels


class Worker:
    def __init__(self):
        self.ale = None
        self.actions = None
        self.game = None
        self.rom_path = None
        self.rom_sha = None
        self.seed = 0
        self.frame_skip = 4
        self.repeat_action_probability = 0.0
        self.mode = None
        self.difficulty = None
        self.channels = []
        self.gen = 0
        self.score = 0.0
        self.done = False
        self._cache = None
        self._edges = None

    # ---- lifecycle -------------------------------------------------------

    def boot(self, game, seed=0, frame_skip=4, repeat_action_probability=0.0,
             mode=None, difficulty=None, channels=None):
        from ale_py import ALEInterface, LoggerMode, roms
        ALEInterface.setLoggerMode(LoggerMode.Error)
        known = set(roms.get_all_rom_ids())
        if game not in known:
            raise ValueError(f'unknown ALE ROM {game!r}; ale-py ships {len(known)} ROMs, for example breakout, pong, space_invaders')
        self.game = game
        self.rom_path = str(roms.get_rom_path(game))
        self.rom_sha = _rom_sha(self.rom_path)
        self.seed = int(seed)
        self.frame_skip = max(1, int(frame_skip))
        self.repeat_action_probability = float(repeat_action_probability)
        self.mode = None if mode is None else int(mode)
        self.difficulty = None if difficulty is None else int(difficulty)
        self.channels = _parse_channels(channels)
        self._start()
        return self.identity()

    def _start(self):
        from ale_py import ALEInterface
        ale = ALEInterface()
        ale.setInt('random_seed', self.seed)
        ale.setFloat('repeat_action_probability', self.repeat_action_probability)
        # Frame repeats are applied by `step`, so the emulator itself must not
        # skip frames as well.
        ale.setInt('frame_skip', 1)
        ale.loadROM(self.rom_path)
        if self.mode is not None:
            ale.setMode(self.mode)
        if self.difficulty is not None:
            ale.setDifficulty(self.difficulty)
        ale.reset_game()
        self.ale = ale
        self.actions = list(ale.getMinimalActionSet())
        self.score = 0.0
        self.done = False
        self.gen += 1
        self._cache = None

    def reset(self, seed=None):
        if seed is not None:
            self.seed = int(seed)
        self._start()
        return {'gen': self.gen, 'frame': self.frame()}

    def frame(self):
        return int(self.ale.getFrameNumber())

    def identity(self):
        height, width = self.ale.getScreenDims()
        modes = [int(m) for m in self.ale.getAvailableModes()]
        difficulties = [int(d) for d in self.ale.getAvailableDifficulties()]
        return {
            'gen': self.gen,
            'frame': self.frame(),
            'game': self.game,
            'inputs': self.vocabulary(),
            'channels': [c['id'] for c in self.channels],
            'romSha': self.rom_sha,
            'frameSkip': self.frame_skip,
            'seed': self.seed,
            'repeatActionProbability': self.repeat_action_probability,
            # ALE reports -1 for an unset mode or difficulty, so an unset knob
            # is reported as the ROM default: the first available value.
            'mode': modes[0] if self.mode is None else self.mode,
            'difficulty': difficulties[0] if self.difficulty is None else self.difficulty,
            'modes': modes,
            'difficulties': difficulties,
            'screen': [int(height), int(width)],
            'frameText': self.frame_text(),
        }

    # ---- inputs ----------------------------------------------------------

    def vocabulary(self):
        """The game's minimal action set, as `Action` enum names."""
        from ale_py import Action
        return [Action(a).name for a in self.actions]

    def _action(self, word):
        """Unknown names are no-ops: Playproof never treats an agent typo as a cheat."""
        from ale_py import Action
        if not isinstance(word, str):
            return Action.NOOP
        name = word.strip().upper()
        for action in self.actions:
            if Action(action).name == name:
                return action
        return Action.NOOP

    # ---- evidence --------------------------------------------------------

    def _luminance(self):
        import numpy as np
        rgb = self.ale.getScreenRGB().astype(np.uint16)
        return (2 * rgb[:, :, 0] + 5 * rgb[:, :, 1] + rgb[:, :, 2]) // 8

    def _cells(self, lum):
        """Block-mean downsample to FRAME_ROWS x FRAME_COLS."""
        import numpy as np
        height, width = lum.shape
        if self._edges is None or self._edges[0] != (height, width):
            rows = np.unique(np.arange(FRAME_ROWS) * height // FRAME_ROWS)
            cols = np.unique(np.arange(FRAME_COLS) * width // FRAME_COLS)
            counts = np.add.reduceat(
                np.add.reduceat(np.ones((height, width), dtype=np.int32), rows, axis=0),
                cols, axis=1,
            )
            self._edges = ((height, width), rows, cols, counts)
        _shape, rows, cols, counts = self._edges
        totals = np.add.reduceat(np.add.reduceat(lum.astype(np.int64), rows, axis=0), cols, axis=1)
        return totals // counts

    def _engine_state(self):
        engine = {
            'score': int(round(self.score)),
            'lives': int(self.ale.lives()),
            'frameNumber': self.frame(),
            'episodeFrame': int(self.ale.getEpisodeFrameNumber()),
            'terminal': 1 if self.done else 0,
        }
        if self.channels:
            ram = self.ale.getRAM()
            for channel in self.channels:
                engine[channel['id']] = int(ram[channel['index']])
        return engine

    def _evidence(self):
        key = (self.gen, self.frame(), self.score, self.done)
        if self._cache is not None and self._cache[0] == key:
            return self._cache[1]
        screen = memoryview(self.ale.getScreenRGB()).tobytes()
        ev = {
            'engineState': self._engine_state(),
            'frameHash': hashlib.sha256(screen).hexdigest(),
            'saveBlobHash': hashlib.sha256(self.ale.cloneState().serialize()).hexdigest(),
        }
        self._cache = (key, ev)
        return ev

    def frame_text(self):
        cells = self._cells(self._luminance())
        lines = [''.join(GLYPHS[GLYPH_RAMP[min(255, int(value))]] for value in row) for row in cells]
        engine = self._engine_state()
        lines.append(f"score={engine['score']} lives={engine['lives']} frame={engine['frameNumber']}")
        return '\n'.join(lines)

    # ---- transitions -----------------------------------------------------

    def step(self, word, frames=None):
        action = self._action(word)
        repeats = self.frame_skip if frames is None else max(1, int(frames))
        for _ in range(repeats):
            if self.done:
                break
            self.score += self.ale.act(action)
            if self.ale.game_over():
                self.done = True
        self._cache = None
        return {'frame': self.frame(), 'evidence': self._evidence(), 'frameText': self.frame_text()}

    def snapshot(self):
        header = SNAPSHOT_HEADER.pack(SNAPSHOT_MAGIC, SNAPSHOT_VERSION, self.score)
        blob = zlib.compress(header + self.ale.cloneState().serialize(), 6)
        return {
            'bytes': base64.b64encode(blob).decode('ascii'),
            'frame': self.frame(),
            'encoding': 'deflate',
        }

    def restore(self, blob):
        from ale_py import ALEState
        if isinstance(blob, dict):
            blob = blob.get('bytes', '')
        try:
            raw = zlib.decompress(base64.b64decode(blob))
            magic, version, score = SNAPSHOT_HEADER.unpack_from(raw)
        except Exception:
            raise ValueError('blob is not a Playproof ALE checkpoint')
        if magic != SNAPSHOT_MAGIC or version != SNAPSHOT_VERSION:
            raise ValueError('blob is not a Playproof ALE checkpoint')
        try:
            state = ALEState(raw[SNAPSHOT_HEADER.size:])
        except Exception:
            # A truncated or doctored payload reaches the emulator as an
            # untranslated C++ error; report it as a rejected checkpoint.
            raise ValueError('ALE rejected the checkpoint payload')
        self.ale.restoreState(state)
        self.score = float(score)
        self.done = bool(self.ale.game_over())
        self._cache = None
        return {'gen': self.gen, 'frame': self.frame()}

    def close(self):
        self.ale = None


def main():
    if len(sys.argv) >= 3:
        fifo_in, fifo_out = sys.argv[1], sys.argv[2]
        os.mkfifo(fifo_in)
        os.mkfifo(fifo_out)
        ready = os.path.join(os.path.dirname(fifo_in), 'ready')
        with open(ready, 'w'):
            pass
        fin = open(fifo_in, 'r')
        fout = open(fifo_out, 'w')
        transport = (fin, fout)
    else:
        transport = (sys.stdin, sys.stdout)
    serve(transport)


def dispatch(worker, method, params):
    if method == 'boot':
        return worker.boot(
            game=params['game'],
            seed=params.get('seed', 0),
            frame_skip=params.get('frameSkip', 4),
            repeat_action_probability=params.get('repeatActionProbability', 0.0),
            mode=params.get('mode'),
            difficulty=params.get('difficulty'),
            channels=params.get('channels'),
        )
    if method == 'reset':
        return worker.reset(params.get('seed'))
    if method == 'step':
        return worker.step(params.get('input'), params.get('frames'))
    if method == 'evidence':
        return worker._evidence()
    if method == 'frame':
        return {'text': worker.frame_text()}
    if method == 'inputs':
        return {'inputs': worker.vocabulary()}
    if method in ('snapshot', 'checkpoint'):
        return worker.snapshot()
    if method == 'restore':
        return worker.restore(params.get('state'))
    raise ValueError(f'unknown method {method}')


def serve(transport):
    fin, fout = transport
    worker = Worker()
    for line in fin:
        line = line.strip()
        if not line:
            continue
        req = {}
        try:
            req = json.loads(line)
            method = req['method']
            params = req.get('params') or {}
            if method == 'shutdown':
                fout.write(json.dumps({'id': req.get('id'), 'ok': True, 'result': {'bye': True}}) + '\n')
                fout.flush()
                worker.close()
                return
            result = dispatch(worker, method, params)
            fout.write(json.dumps({'id': req.get('id'), 'ok': True, 'result': result}) + '\n')
            fout.flush()
        except Exception as e:
            fout.write(json.dumps({'id': req.get('id', -1), 'ok': False, 'error': f'{type(e).__name__}: {e}'}) + '\n')
            fout.flush()


if __name__ == '__main__':
    main()
