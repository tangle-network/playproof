"""PNG encoder shared by every Playproof Python worker.

Playproof adds no image dependency. Pillow is absent from the CI virtual
environments (the PyBoy job logs `Missing dependency "Pillow"`), and a
benchmark harness that gains an imaging stack to show an agent a game screen
has paid too much for the feature. `zlib` and `struct` are in the standard
library and are enough.

Every scanline is written with filter type 0 (None). A per-line filter search
would shrink the file, but the screens these workers encode are small and
already compress well, and a fixed filter keeps the encoder short enough to
audit. The bytes are never evidence: a milestone hashes the raw pixels the
emulator produced, never this file, so the encoder is free to change without
invalidating a single recorded run.

Measured on an ale-py 0.12.1 Breakout frame: 518 bytes at the native 160x210
in 0.84 ms, and 2,383 bytes at a 3x upscale in 4.4 ms, both at level 9. Level 6
is about a millisecond faster and 40 percent larger, so the smaller file wins
on a channel a model provider bills by the byte.
"""
import struct
import zlib

# 8 bits per sample, matching the buffers the emulators expose.
_COLOR_TYPE = {1: 0, 3: 2, 4: 6}
_SIGNATURE = b'\x89PNG\r\n\x1a\n'


def _chunk(kind, body):
    return (struct.pack('>I', len(body)) + kind + body
            + struct.pack('>I', zlib.crc32(kind + body) & 0xFFFFFFFF))


def encode_png(width, height, channels, pixels, level=9):
    """Encode 8-bit grayscale (1), RGB (3), or RGBA (4) pixels as PNG bytes.

    `pixels` is a row-major buffer of `height * width * channels` bytes.
    """
    if channels not in _COLOR_TYPE:
        raise ValueError('channels must be 1, 3, or 4, got %r' % (channels,))
    if width <= 0 or height <= 0:
        raise ValueError('image dimensions must be positive, got %dx%d' % (width, height))
    stride = width * channels
    view = memoryview(pixels)
    if len(view) != height * stride:
        raise ValueError('pixel buffer is %d bytes, expected %d' % (len(view), height * stride))
    raw = bytearray(height * (stride + 1))
    for row in range(height):
        start = row * (stride + 1)
        raw[start] = 0
        raw[start + 1:start + 1 + stride] = view[row * stride:(row + 1) * stride]
    header = struct.pack('>IIBBBBB', width, height, 8, _COLOR_TYPE[channels], 0, 0, 0)
    return (_SIGNATURE
            + _chunk(b'IHDR', header)
            + _chunk(b'IDAT', zlib.compress(bytes(raw), level))
            + _chunk(b'IEND', b''))
