/**
 * Enough of a PNG reader for the adapter gates to prove a worker wrote a real
 * image: the signature, the declared size, the filter byte `pyshared/png.py`
 * documents, and how many distinct pixels the picture holds.
 *
 * A constant-colour result means the encoder ran over an empty buffer and the
 * agent is being shown nothing, which is the failure this exists to catch.
 * Test-only; it is never packed and never imported by the framework.
 */
import { strict as assert } from 'node:assert'
import { inflateSync } from 'node:zlib'

export interface DecodedPng {
  width: number
  height: number
  channels: number
  /** Distinct pixel values in the whole image. */
  colours: number
  /** Row-major pixel bytes, filters removed. */
  pixels: Buffer
}

export function decodePng(bytes: Buffer): DecodedPng {
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'not a PNG')
  let offset = 8
  let width = 0
  let height = 0
  let channels = 0
  const idat: Buffer[] = []
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const kind = bytes.toString('ascii', offset + 4, offset + 8)
    const body = bytes.subarray(offset + 8, offset + 8 + length)
    if (kind === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      assert.equal(body[8], 8, 'expected 8 bits per sample')
      channels = { 0: 1, 2: 3, 6: 4 }[body[9] as 0 | 2 | 6] ?? 0
      assert.ok(channels > 0, `unsupported PNG colour type ${String(body[9])}`)
      assert.equal(body[12], 0, 'expected a non-interlaced PNG')
    } else if (kind === 'IDAT') idat.push(Buffer.from(body))
    else if (kind === 'IEND') break
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  assert.equal(raw.length, height * (stride + 1), 'scanline count does not match the header')
  const seen = new Set<string>()
  const pixels = Buffer.alloc(height * stride)
  for (let row = 0; row < height; row++) {
    const start = row * (stride + 1)
    // pyshared/png.py documents filter 0 (None) on every scanline.
    assert.equal(raw[start], 0, `row ${row} is not filter 0`)
    raw.copy(pixels, row * stride, start + 1, start + 1 + stride)
    for (let column = 0; column < stride; column += channels) {
      seen.add(raw.subarray(start + 1 + column, start + 1 + column + channels).toString('hex'))
    }
  }
  return { width, height, channels, colours: seen.size, pixels }
}

/**
 * Undo a whole-pixel upscale by keeping one pixel per block.
 *
 * The workers upscale with a nearest-neighbour repeat, which is exactly
 * invertible, so a gate can recover the emulator's native buffer and hash it
 * against the `frameHash` a verifier recomputes. That is the strongest thing a
 * test can say about this channel: the agent is shown the same screen the
 * verifier checks, and the upscale invented nothing.
 */
export function unscale(decoded: DecodedPng, factor: number): Buffer {
  const nativeWidth = decoded.width / factor
  const nativeHeight = decoded.height / factor
  assert.ok(Number.isInteger(nativeWidth) && Number.isInteger(nativeHeight), 'size is not a whole multiple of the factor')
  const out = Buffer.alloc(nativeHeight * nativeWidth * decoded.channels)
  const stride = decoded.width * decoded.channels
  let cursor = 0
  for (let row = 0; row < nativeHeight; row++) {
    for (let column = 0; column < nativeWidth; column++) {
      const source = row * factor * stride + column * factor * decoded.channels
      decoded.pixels.copy(out, cursor, source, source + decoded.channels)
      cursor += decoded.channels
    }
  }
  return out
}
