"""PyBoy worker driven over the shared Playproof line-JSON protocol.

Protocol methods:
  boot       {game, rom, channels?, preamble?, screenImage?, screenScale?}
  reset      {}
  step       {input}
  evidence   {}
  frame      {}
  snapshot   {}        whole WRAM+HRAM, base64 (blind discovery)
  checkpoint {}        emulator save-state, base64 (frontier exploration)
  restore    {state}
  shutdown   {}

Determinism: PyBoy is headless with sound off and fixed input timing. Every
checkpoint and final input script remains replayable from power-on. The
emulator always stops with save=False, because PyBoy writes cartridge RAM to
'<rom>.ram' and loads that file at the next power-on: a battery save would
make each boot start from a different state, and a truncated one aborts the
boot. Playproof keeps state in save-states, never in a cartridge save.

`screenImage` publishes the rendered screen as a PNG next to `frameText`, so a
vision agent reads the pixels this worker already hashes for evidence. PyBoy's
own `screen.image` needs Pillow, which is absent from the CI environment (the
job logs `Missing dependency "Pillow"`), so the PNG is encoded from the raw
RGBA array by `pyshared/png.py`. The channel is off by default, so a caller
that does not ask sends the same bytes it sends today. `screenScale` repeats
whole pixels; a Game Boy frame is 160x144, below the tile grid a model provider
resizes into.
"""
import base64
import hashlib
import io
import json
import os
import sys
import warnings

warnings.filterwarnings('ignore')

sys.path.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'pyshared'))
from png import encode_png

GAME_WIRING = {}
WRAM = (0xC000, 0xE000)
HRAM = (0xFF80, 0xFFFF)
# Whole-pixel repeat only, and never past the edge a model provider resizes to.
MAX_SCREEN_SCALE = 8
MAX_SCREEN_DIMENSION = 2048


def _load_wiring(game):
    if game not in GAME_WIRING:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        GAME_WIRING[game] = __import__(game)
    return GAME_WIRING[game]


class Worker:
    def __init__(self):
        self.pyboy = None
        self.wiring = None
        self.rom = None
        self.game = None
        self.screen_image = False
        self.screen_scale = 1
        self.gen = 0
        self.frame = 0
        self._cache = None
        self._image = None

    def boot(self, rom, game, channels=None, preamble=None, screen_image=False, screen_scale=1):
        self.rom = rom
        self.game = game
        self.screen_image = bool(screen_image)
        self.screen_scale = int(screen_scale)
        if not 1 <= self.screen_scale <= MAX_SCREEN_SCALE:
            raise ValueError(f'screenScale must be 1..{MAX_SCREEN_SCALE}, got {screen_scale!r}')
        self.wiring = _load_wiring(game)
        if channels and hasattr(self.wiring, 'set_channels'):
            self.wiring.set_channels(channels)
        if preamble and hasattr(self.wiring, 'set_boot_mode'):
            self.wiring.set_boot_mode(preamble)
        self._start()

    def _start(self):
        if self.pyboy is not None:
            self.pyboy.stop(save=False)
            self.pyboy = None
        from pyboy import PyBoy
        battery = self.rom + '.ram'
        if os.path.exists(battery):
            raise RuntimeError(
                f'cartridge save file {battery} exists. PyBoy loads it at power-on, '
                'so the run would not start from the pinned power-on state. '
                'Move or delete the file.')
        self.pyboy = PyBoy(self.rom, window='null', sound=False, cgb=False)
        self.frame = 0
        self.gen += 1
        self._cache = None
        self._image = None
        self.wiring.run_preamble(self.pyboy)
        self.frame = self._tick_count()

    def _tick_count(self):
        return self.pyboy.frame_count

    def reset(self):
        self._start()
        return {'gen': self.gen, 'frame': self.frame}

    def _evidence(self):
        key = (self.gen, self.frame)
        if self._cache is not None and self._cache[0] == key:
            return self._cache[1]
        engine = self.wiring.read_engine_state(self.pyboy, self.frame)
        buf = io.BytesIO()
        self.pyboy.save_state(buf)
        save_hash = hashlib.sha256(buf.getvalue()).hexdigest()
        frame_hash = hashlib.sha256(self.pyboy.screen.ndarray[:, :, :3].tobytes()).hexdigest()
        ev = {
            'engineState': engine,
            'saveBlobHash': save_hash,
            'frameHash': frame_hash,
        }
        self._cache = (key, ev)
        return ev

    def screen_rgb(self):
        """The rendered screen as a PNG, or None when the boot did not ask.

        These are the SAME pixels `_evidence` hashes into `frameHash`. The
        worker captured them for verification already; publishing them costs
        one encode and gives the agent the picture a human player sees.
        """
        if not self.screen_image:
            return None
        key = (self.gen, self.frame)
        if self._image is not None and self._image[0] == key:
            return self._image[1]
        import numpy as np
        rgb = self.pyboy.screen.ndarray[:, :, :3]
        if self.screen_scale > 1:
            rgb = np.repeat(np.repeat(rgb, self.screen_scale, axis=0), self.screen_scale, axis=1)
        height, width = int(rgb.shape[0]), int(rgb.shape[1])
        if max(height, width) > MAX_SCREEN_DIMENSION:
            raise ValueError(
                'screen is %dx%d at scale %d, over the %dpx observation bound'
                % (width, height, self.screen_scale, MAX_SCREEN_DIMENSION))
        png = encode_png(width, height, 3, np.ascontiguousarray(rgb).tobytes())
        image = {
            'mediaType': 'image/png',
            'base64': base64.b64encode(png).decode('ascii'),
            'width': width,
            'height': height,
        }
        self._image = (key, image)
        return image

    def step(self, word):
        self.wiring.apply_input(self.pyboy, word)
        self.frame = self._tick_count()
        self._cache = None
        self._image = None
        ev = self._evidence()
        frame_text = self.wiring.render_frame(self.pyboy, ev['engineState'])
        result = {'frame': self.frame, 'evidence': ev, 'frameText': frame_text}
        if self.screen_image:
            result['frameImage'] = self.screen_rgb()
        return result

    def frame_text(self):
        ev = self._evidence()
        return self.wiring.render_frame(self.pyboy, ev['engineState'])

    def snapshot(self):
        chunks = [bytes(self.pyboy.memory[start:end]) for start, end in (WRAM, HRAM)]
        return {'bytes': base64.b64encode(b''.join(chunks)).decode('ascii')}

    def checkpoint(self):
        buf = io.BytesIO()
        self.pyboy.save_state(buf)
        return {
            'state': base64.b64encode(buf.getvalue()).decode('ascii'),
            'frame': self.frame,
        }

    def restore(self, checkpoint):
        raw = base64.b64decode(checkpoint['state'])
        self.pyboy.load_state(io.BytesIO(raw))
        self.frame = self._tick_count()
        self._cache = None
        self._image = None
        return {'gen': self.gen, 'frame': self.frame}


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
            if method == 'boot':
                worker.boot(
                    rom=params['rom'],
                    game=params['game'],
                    channels=params.get('channels'),
                    preamble=params.get('preamble'),
                    screen_image=params.get('screenImage', False),
                    screen_scale=params.get('screenScale', 1),
                )
                result = {'gen': worker.gen, 'frame': worker.frame}
            elif method == 'reset':
                result = worker.reset()
            elif method == 'step':
                result = worker.step(params['input'])
            elif method == 'evidence':
                result = worker._evidence()
            elif method == 'frame':
                image = worker.screen_rgb()
                result = {'text': worker.frame_text()}
                if image is not None:
                    result['image'] = image
            elif method == 'snapshot':
                result = worker.snapshot()
            elif method == 'checkpoint':
                result = worker.checkpoint()
            elif method == 'restore':
                result = worker.restore(params['state'])
            elif method == 'shutdown':
                # Stop the emulator BEFORE the reply. The client kills this
                # process as soon as the reply arrives, so teardown that runs
                # after the reply can be interrupted part way.
                if worker.pyboy is not None:
                    worker.pyboy.stop(save=False)
                    worker.pyboy = None
                fout.write(json.dumps({'id': req.get('id'), 'ok': True, 'result': {'bye': True}}) + '\n')
                fout.flush()
                return
            else:
                raise ValueError(f'unknown method {method}')
            fout.write(json.dumps({'id': req.get('id'), 'ok': True, 'result': result}) + '\n')
            fout.flush()
        except Exception as e:
            fout.write(json.dumps({'id': req.get('id', -1), 'ok': False, 'error': f'{type(e).__name__}: {e}'}) + '\n')
            fout.flush()


if __name__ == '__main__':
    main()
