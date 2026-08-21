"""stable-retro worker driven over the shared Playproof line-JSON protocol.

One worker serves any console that stable-retro bundles a libretro core for:
NES, SNES, Genesis/Mega Drive, Game Boy, Game Boy Color, Game Boy Advance,
Atari 2600, Sega Master System, Game Gear, PC Engine, and the rest of the
integration set. Nothing in this file is console-specific: the button names,
the privileged variables, and the screen resolution all come from the
integration data of the selected game.

Protocol methods:
  boot       {game, state?, scenario?, players?, frameskip?, seed?,
              screenImage?, screenScale?}
  reset      {seed?}
  step       {input}          one input word, repeated for `frameskip` frames
  evidence   {}
  frame      {}
  inputs     {}               the advertised input vocabulary
  snapshot   {}               libretro save state, deflate + base64
  checkpoint {}               same blob, shaped for the shared WorkerRpc
  restore    {state}
  shutdown   {}

Determinism, measured on Airstriker-Genesis with stable-retro 1.0.1:
the rendered frames and the integration variables are bit-identical across
separate worker processes, so `frameHash` and `engineState` are sound replay
evidence. The raw `em.get_state()` serialization is NOT byte-stable across
processes (165 of 1036288 bytes move, in padding around offset 140k), so this
worker deliberately publishes no `saveBlobHash`. Save states remain exact
within one process, which is what snapshot/restore needs.

`screenImage` publishes the rendered screen as a PNG next to `frameText`, so a
vision agent reads the pixels this worker already hashes into `frameHash`
instead of a luminance-to-ASCII downsample of them. It is off by default, so
the bytes on the protocol line are unchanged for a caller that does not ask.
`screenScale` repeats whole pixels for the low-resolution consoles.

stdout carries only protocol lines. Diagnostics belong on stderr.
"""
import base64
import hashlib
import json
import os
import struct
import sys
import warnings
import zlib

warnings.filterwarnings('ignore')

sys.path.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'pyshared'))
from playproof_png import encode_png

# Checkpoint container. The libretro core blob alone cannot rewind the worker
# frame counter, so the counter travels with it and restore is exact.
SNAPSHOT_MAGIC = b'PPRS'
SNAPSHOT_VERSION = 1
SNAPSHOT_HEADER = struct.Struct('<4sHQ')

FRAME_ROWS = 24
FRAME_COLS = 40
GLYPHS = ' .:-=+*#%@'
# Console screens are mostly dark, so a linear ramp collapses gameplay into
# blanks. A square-root curve keeps sprites legible without per-frame
# normalization, which would make the observation jump between frames.
GLYPH_RAMP = tuple(
    min(len(GLYPHS) - 1, int(((value / 255.0) ** 0.5) * (len(GLYPHS) - 1) + 0.5))
    for value in range(256)
)
# Whole-pixel repeat only, and never past the edge a model provider resizes to.
MAX_SCREEN_SCALE = 8
MAX_SCREEN_DIMENSION = 2048
MAX_SUMMARY_VARIABLES = 8
MAX_VOCABULARY_ACTIONS = 3
DIRECTIONS = ('UP', 'DOWN', 'LEFT', 'RIGHT')
NON_ACTION_BUTTONS = ('MODE', 'START', 'SELECT')
NOOP = 'NOOP'


def _resolve_game(retro, name):
    """Accept a game with or without the integration `-v0` suffix."""
    known = set(retro.data.list_games(retro.data.Integrations.ALL))
    for candidate in (name, f'{name}-v0', name[:-3] if name.endswith('-v0') else name):
        if candidate in known:
            return candidate
    raise ValueError(f'unknown stable-retro game {name!r}; import a ROM with `python -m retro.import <dir>`')


def _rom_sha(retro, game):
    try:
        path = retro.data.get_romfile_path(game, retro.data.Integrations.ALL)
    except Exception:
        return None
    with open(path, 'rb') as handle:
        return hashlib.sha1(handle.read()).hexdigest()


class Worker:
    def __init__(self):
        self.retro = None
        self.env = None
        self.game = None
        self.state = None
        self.scenario = None
        self.players = 1
        self.frameskip = 4
        self.seed = 0
        self.buttons = []
        self.rom_sha = None
        self.screen_image = False
        self.screen_scale = 1
        self.gen = 0
        self.frame = 0
        self.done = False
        self.obs = None
        self._cache = None
        self._image = None
        self._edges = None

    # ---- lifecycle -------------------------------------------------------

    def boot(self, game, state=None, scenario=None, players=1, frameskip=4, seed=0,
             screen_image=False, screen_scale=1):
        import retro
        import retro.data
        self.screen_image = bool(screen_image)
        self.screen_scale = int(screen_scale)
        if not 1 <= self.screen_scale <= MAX_SCREEN_SCALE:
            raise ValueError('screenScale must be 1..%d, got %r' % (MAX_SCREEN_SCALE, screen_scale))
        self.retro = retro
        self.game = _resolve_game(retro, game)
        self.state = state
        self.scenario = scenario
        self.players = int(players)
        self.frameskip = max(1, int(frameskip))
        self.seed = int(seed)
        self.rom_sha = _rom_sha(retro, self.game)
        self._start()
        return self.identity()

    def _start(self):
        retro = self.retro
        if self.env is not None:
            self.env.close()
            self.env = None
        self.env = retro.make(
            self.game,
            state=self.state if self.state else retro.State.DEFAULT,
            scenario=self.scenario,
            use_restricted_actions=retro.Actions.ALL,
            players=self.players,
            inttype=retro.data.Integrations.ALL,
            render_mode=None,
        )
        self.buttons = list(self.env.buttons)
        obs, _info = self.env.reset(seed=self.seed)
        self.obs = obs
        self.frame = 0
        self.done = False
        self.gen += 1
        self._cache = None
        self._image = None

    def reset(self, seed=None):
        if seed is not None:
            self.seed = int(seed)
        self._start()
        return {'gen': self.gen, 'frame': self.frame}

    def identity(self):
        return {
            'gen': self.gen,
            'frame': self.frame,
            'game': self.game,
            'state': self.state,
            'buttons': list(self.buttons),
            'inputs': self.vocabulary(),
            'variables': sorted(self._variables().keys()),
            'romSha': self.rom_sha,
            'frameskip': self.frameskip,
            'screenImage': self.screen_image,
            'screenScale': self.screen_scale,
            'frameText': self.frame_text(),
            **({} if not self.screen_image else {'frameImage': self.screen_rgb()}),
        }

    # ---- inputs ----------------------------------------------------------

    def vocabulary(self):
        """Advertised words. Any `+`-joined button subset is also accepted."""
        directions = [b for b in self.buttons if b in DIRECTIONS]
        actions = [b for b in self.buttons if b not in DIRECTIONS and b not in NON_ACTION_BUTTONS]
        words = [NOOP] + list(self.buttons)
        for direction in directions:
            for action in actions[:MAX_VOCABULARY_ACTIONS]:
                words.append(f'{direction}+{action}')
        return words

    def _mask(self, word):
        """Unknown names are no-ops: Playproof never treats an agent typo as a cheat."""
        mask = [False] * len(self.buttons)
        if not isinstance(word, str):
            return mask
        for part in word.upper().split('+'):
            part = part.strip()
            if part in ('', NOOP):
                continue
            if part in self.buttons:
                mask[self.buttons.index(part)] = True
        return mask

    # ---- evidence --------------------------------------------------------

    def _variables(self):
        try:
            raw = self.env.data.lookup_all()
        except Exception:
            return {}
        engine = {}
        for key, value in raw.items():
            try:
                engine[str(key)] = int(value)
            except (TypeError, ValueError):
                continue
        return engine

    def _luminance(self):
        import numpy as np
        pixels = self.obs
        if pixels is None:
            return None
        if pixels.ndim == 3:
            channels = pixels[:, :, :3].astype(np.uint16)
            lum = (2 * channels[:, :, 0] + 5 * channels[:, :, 1] + channels[:, :, 2]) // 8
        else:
            lum = pixels.astype(np.uint16)
        return lum

    def _cells(self, lum):
        """Block-mean downsample to FRAME_ROWS x FRAME_COLS for any resolution."""
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

    def _evidence(self):
        key = (self.gen, self.frame)
        if self._cache is not None and self._cache[0] == key:
            return self._cache[1]
        engine = self._variables()
        engine.setdefault('emuFrame', self.frame)
        engine.setdefault('episodeDone', 1 if self.done else 0)
        frame_hash = hashlib.sha256(memoryview(self.obs).tobytes()).hexdigest() if self.obs is not None else None
        lum = self._luminance()
        frame_state = {}
        if lum is not None:
            cells = self._cells(lum)
            frame_state = {
                'lumMean': int(cells.mean()),
                'lumMax': int(cells.max()),
                'activeCells': int((cells >= 24).sum()),
                'brightCells': int((cells >= 128).sum()),
            }
        ev = {'engineState': engine, 'frameState': frame_state}
        if frame_hash is not None:
            ev['frameHash'] = frame_hash
        self._cache = (key, ev)
        return ev

    def screen_rgb(self):
        """The rendered screen as a PNG, or None when the boot did not ask.

        This is the SAME observation buffer `_evidence` hashes into
        `frameHash`, so the picture the agent sees is the screen the verifier
        checks, including immediately after a checkpoint restore. The cost is
        one encode per emulator instant, cached until the state moves.
        """
        if not self.screen_image or self.obs is None:
            return None
        key = (self.gen, self.frame)
        if self._image is not None and self._image[0] == key:
            return self._image[1]
        import numpy as np
        pixels = self.obs
        if pixels.ndim == 3:
            pixels = pixels[:, :, :3]
            channels = 3
        else:
            channels = 1
        if self.screen_scale > 1:
            pixels = np.repeat(np.repeat(pixels, self.screen_scale, axis=0), self.screen_scale, axis=1)
        height, width = int(pixels.shape[0]), int(pixels.shape[1])
        if max(height, width) > MAX_SCREEN_DIMENSION:
            raise ValueError(
                'screen is %dx%d at scale %d, over the %dpx observation bound'
                % (width, height, self.screen_scale, MAX_SCREEN_DIMENSION))
        png = encode_png(width, height, channels, np.ascontiguousarray(pixels).tobytes())
        image = {
            'mediaType': 'image/png',
            'base64': base64.b64encode(png).decode('ascii'),
            'width': width,
            'height': height,
        }
        self._image = (key, image)
        return image

    def frame_text(self):
        lum = self._luminance()
        lines = []
        if lum is not None:
            cells = self._cells(lum)
            for row in cells:
                lines.append(''.join(GLYPHS[GLYPH_RAMP[min(255, int(value))]] for value in row))
        engine = self._evidence()['engineState']
        shown = list(engine.items())[:MAX_SUMMARY_VARIABLES]
        lines.append(' '.join(f'{k}={v}' for k, v in shown)[:160])
        return '\n'.join(lines)

    # ---- transitions -----------------------------------------------------

    def step(self, word):
        import numpy as np
        mask = np.array(self._mask(word), dtype=np.uint8)
        for _ in range(self.frameskip):
            if self.done:
                break
            obs, _reward, terminated, truncated, _info = self.env.step(mask)
            self.obs = obs
            self.frame += 1
            if terminated or truncated:
                self.done = True
        self._cache = None
        self._image = None
        ev = self._evidence()
        result = {'frame': self.frame, 'evidence': ev, 'frameText': self.frame_text()}
        if self.screen_image:
            result['frameImage'] = self.screen_rgb()
        return result

    def snapshot(self):
        header = SNAPSHOT_HEADER.pack(SNAPSHOT_MAGIC, SNAPSHOT_VERSION, self.frame)
        blob = zlib.compress(header + self.env.em.get_state(), 6)
        return {
            'bytes': base64.b64encode(blob).decode('ascii'),
            'frame': self.frame,
            'encoding': 'deflate',
        }

    def restore(self, blob):
        if isinstance(blob, dict):
            blob = blob.get('bytes', '')
        raw = zlib.decompress(base64.b64decode(blob))
        magic, version, frame = SNAPSHOT_HEADER.unpack_from(raw)
        if magic != SNAPSHOT_MAGIC or version != SNAPSHOT_VERSION:
            raise ValueError('blob is not a Playproof stable-retro checkpoint')
        # No emulator frame is consumed here. The core lands exactly on the
        # snapshotted frame, so the next step advances the same frames the
        # original run advanced. RAM is re-read immediately; the rendered
        # screen refreshes on that next step.
        self.env.em.set_state(raw[SNAPSHOT_HEADER.size:])
        self.env.data.update_ram()
        self.obs = self.env._update_obs()
        self.frame = frame
        self.done = False
        self._cache = None
        self._image = None
        return {'gen': self.gen, 'frame': self.frame}

    def close(self):
        if self.env is not None:
            self.env.close()
            self.env = None


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
            state=params.get('state'),
            scenario=params.get('scenario'),
            players=params.get('players', 1),
            frameskip=params.get('frameskip', 4),
            seed=params.get('seed', 0),
            screen_image=params.get('screenImage', False),
            screen_scale=params.get('screenScale', 1),
        )
    if method == 'reset':
        return worker.reset(params.get('seed'))
    if method == 'step':
        return worker.step(params.get('input'))
    if method == 'evidence':
        return worker._evidence()
    if method == 'frame':
        image = worker.screen_rgb()
        return {'text': worker.frame_text(), **({} if image is None else {'image': image})}
    if method == 'inputs':
        return {'inputs': worker.vocabulary(), 'buttons': list(worker.buttons)}
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
