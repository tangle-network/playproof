/**
 * Enough of a PNG reader for the adapter gates to prove a worker wrote a real
 * image: the signature, the declared size, the pixels behind every scanline
 * filter, and how many distinct values the picture holds.
 *
 * All five filter types are implemented, because the gates read two kinds of
 * file. `pyshared/playproof_png.py` writes filter 0 on every scanline, and the
 * three encoder-owned gates assert that with `expectFilterNone`. RetroArch
 * writes its own PNG and picks a filter per scanline, so the RetroArch gate
 * reads the file its worker republishes and takes whatever filters are in it.
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

export interface DecodePngOptions {
  /** Assert every scanline uses filter 0, which is what our own encoder writes. */
  expectFilterNone?: boolean
}

export function decodePng(bytes: Buffer, options: DecodePngOptions = {}): DecodedPng {
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
  const pixels = Buffer.alloc(height * stride)
  for (let row = 0; row < height; row++) {
    const start = row * (stride + 1)
    const filter = raw[start]!
    if (options.expectFilterNone === true) {
      // pyshared/playproof_png.py documents filter 0 (None) on every scanline.
      assert.equal(filter, 0, `row ${row} is not filter 0`)
    }
    unfilter(filter, raw.subarray(start + 1, start + 1 + stride), pixels, row * stride, stride, channels)
  }
  const seen = new Set<string>()
  for (let offset = 0; offset < pixels.length; offset += channels) {
    seen.add(pixels.subarray(offset, offset + channels).toString('hex'))
  }
  return { width, height, channels, colours: seen.size, pixels }
}

/** Reverse one scanline filter into `out` at `at`, reading the row above it. */
function unfilter(
  filter: number,
  line: Buffer,
  out: Buffer,
  at: number,
  stride: number,
  channels: number,
): void {
  for (let x = 0; x < stride; x++) {
    const left = x >= channels ? out[at + x - channels]! : 0
    const up = at >= stride ? out[at - stride + x]! : 0
    const upLeft = at >= stride && x >= channels ? out[at - stride + x - channels]! : 0
    const value = line[x]!
    let restored: number
    if (filter === 0) restored = value
    else if (filter === 1) restored = value + left
    else if (filter === 2) restored = value + up
    else if (filter === 3) restored = value + ((left + up) >> 1)
    else if (filter === 4) restored = value + paeth(left, up, upLeft)
    else throw new Error(`unknown PNG filter ${filter}`)
    out[at + x] = restored & 0xff
  }
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft
  const dLeft = Math.abs(estimate - left)
  const dUp = Math.abs(estimate - up)
  const dUpLeft = Math.abs(estimate - upLeft)
  if (dLeft <= dUp && dLeft <= dUpLeft) return left
  return dUp <= dUpLeft ? up : upLeft
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
