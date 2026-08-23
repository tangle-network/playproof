/**
 * Playproof runtime — deterministic game core, hash-chained input log, replay.
 *
 * A Game is a PURE state machine: step() is the only transition, observe() is
 * the channel the agent reads, evidence() is the privileged channel only the
 * harness reads. Purity is what makes replay verification sound: the same seed
 * plus the same input log must always produce the same evidence, so any claimed
 * progression the replay cannot reproduce is a cheat or a harness bug.
 *
 * The agent channel carries text always and pixels optionally. Neither reaches
 * the input log, the contract, or the attestation: an observation is what the
 * player sees, and a replay recomputes progress from the seed and the inputs
 * alone. A run therefore verifies identically whether or not images were shown.
 */

export type Input = string

/** Privileged evidence snapshot, recomputed by the verifier — never trusted from the run. */
export interface Evidence {
  engineState?: Record<string, number>
  saveBlobHash?: string
  /** Normalized fields parsed from persisted state; supports semantic progress across distinct valid trajectories. */
  saveState?: Record<string, number>
  logEvents?: string[]
  frameHash?: string
  /** Normalized fields derived from the rendered observation, not from engine memory. */
  frameState?: Record<string, number>
}

/**
 * One rendered image in an observation.
 *
 * `base64` holds the encoded file, not raw pixels, so the bytes a driver sends
 * are the bytes the adapter produced. `width` and `height` are the adapter's
 * declaration of what it drew, for a driver that lays out a prompt.
 */
export interface ObservationImage {
  mediaType: 'image/png' | 'image/jpeg'
  base64: string
  width: number
  height: number
  /** Short caption. It is agent-visible, so it must never carry evidence. */
  label?: string
}

/**
 * What the agent perceives on one turn.
 *
 * `text` is always present and is exactly what `frame()` returns for a game
 * that publishes no images, so every existing driver keeps its behaviour.
 */
export interface Observation {
  text: string
  images?: readonly ObservationImage[]
}

export interface Game<S> {
  id: string
  init(seed: number): S
  /** Pure transition. Unknown inputs are no-ops (agent typos are not cheats). */
  step(state: S, input: Input): S
  /** The text observation the agent receives each turn. */
  frame(state: S): string
  /**
   * The full observation, when the game renders more than text.
   *
   * Omitting it means the observation is exactly `{ text: frame(state) }`.
   * A game that implements it must keep `text` equal to what it would have
   * returned from `frame()`, because the driver's first argument is that text.
   */
  observe?(state: S): Observation
  /** Privileged progression channel — harness-side only. */
  evidence(state: S): Evidence
  /**
   * Whether the game is finished, so that no further input can change it.
   *
   * The member is optional and a game that omits it is never over. That is
   * what a game with no terminal state means, and it is what every adapter
   * written before this member already did.
   *
   * It must be PURE, like `step`. A verifier replays the input log, recomputes
   * the final state, and asks again; an answer that reads wall time or the
   * live process would make "this episode stopped at game over" a claim the
   * verifier cannot reproduce.
   *
   * Derive it from state the adapter already holds. An emulator adapter reads
   * the terminal flag its worker publishes in `evidence().engineState`. There
   * is no shared spelling of that flag across substrates — ALE writes
   * `terminal`, Gymnasium writes `terminated` and `truncated`, stable-retro
   * writes `episodeDone`, the 2048 core writes `gameOver` — so the mapping
   * belongs to the adapter that knows its own engine, not to a guess the
   * harness makes over field names.
   */
  over?(state: S): boolean
}

/**
 * Bounds on the image channel.
 *
 * An image is an unbounded byte channel into a paid context, so the harness
 * fixes a ceiling rather than trusting an adapter. Measured on ale-py 0.12.1,
 * a Breakout frame encodes to 518 bytes at native 160x210 and 2,383 bytes at a
 * 3x upscale, so `MAX_OBSERVATION_IMAGE_BYTES` sits about 440x above the
 * largest real frame: it never fires on legitimate pixels and still stops a
 * runaway adapter inside one turn.
 *
 * `MAX_OBSERVATION_IMAGE_DIMENSION` is 2048 because model providers resize an
 * image into their own tile grid at or below that edge, so pixels beyond it are
 * re-encoded away before the model reads them while the harness still pays for
 * the bytes.
 *
 * Exceeding any bound is a harness error that fails the turn. Nothing is
 * silently shrunk: a run whose observation quietly changed size is a run whose
 * result cannot be reproduced from what it reports.
 */
export const MAX_OBSERVATION_IMAGE_BYTES = 1 << 20
export const MAX_OBSERVATION_IMAGE_DIMENSION = 2048
export const MAX_OBSERVATION_IMAGES = 4
export const MAX_OBSERVATION_TOTAL_IMAGE_BYTES = 2 << 20
export const MAX_OBSERVATION_IMAGE_LABEL_CHARS = 200

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u
const MAGIC: Record<ObservationImage['mediaType'], readonly number[]> = {
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/jpeg': [0xff, 0xd8, 0xff],
}

/**
 * The observation for one state, with the text-only default applied.
 *
 * Every path that shows a state to an agent goes through this function, so the
 * default and the bounds exist in exactly one place. It reads `frame()` and
 * `observe()` and never `evidence()`, which is what keeps the privileged
 * channel out of the agent's view.
 */
export function observationOf<S>(game: Game<S>, state: S): Observation {
  if (game.observe === undefined) return Object.freeze({ text: game.frame(state) })
  const observed = game.observe(state)
  if (typeof observed?.text !== 'string') {
    throw new Error(`game ${game.id} observe() returned no text`)
  }
  if (observed.images === undefined) return Object.freeze({ text: observed.text })
  if (!Array.isArray(observed.images)) {
    throw new Error(`game ${game.id} observe() returned images that are not an array`)
  }
  const images = [...observed.images]
  if (images.length > MAX_OBSERVATION_IMAGES) {
    throw new Error(
      `game ${game.id} observation carries ${images.length} images, over the ${MAX_OBSERVATION_IMAGES} per turn`,
    )
  }
  let total = 0
  for (const [index, image] of images.entries()) {
    total += checkObservationImage(game.id, index, image)
    if (total > MAX_OBSERVATION_TOTAL_IMAGE_BYTES) {
      throw new Error(
        `game ${game.id} observation images total ${total} bytes, over the ${MAX_OBSERVATION_TOTAL_IMAGE_BYTES} per turn`,
      )
    }
    Object.freeze(image)
  }
  // Frozen through: a driver holds a snapshot of the turn, never a handle it
  // can write back into the harness.
  return Object.freeze({ text: observed.text, images: Object.freeze(images) })
}

/**
 * Just the text of an observation, with the same default applied.
 *
 * The trajectory history and the campaign segment report are text records, and
 * neither of them shows an image to anybody. They read the observation through
 * this function so that appending a history row cannot fail on an image bound,
 * and so that a game whose `observe()` text differs from `frame()` still writes
 * one consistent text everywhere.
 */
export function observationTextOf<S>(game: Game<S>, state: S): string {
  if (game.observe === undefined) return game.frame(state)
  const text = game.observe(state).text
  if (typeof text !== 'string') throw new Error(`game ${game.id} observe() returned no text`)
  return text
}

/**
 * Whether a game declares this state finished, with the never-over default.
 *
 * Every path that asks the question goes through this function, so a game that
 * publishes no terminal state answers the same way everywhere: the episode
 * loop, the campaign loop, and the record all read one definition.
 */
export function isGameOver<S>(game: Game<S>, state: S): boolean {
  if (game.over === undefined) return false
  const over = game.over(state)
  if (typeof over !== 'boolean') {
    throw new Error(`game ${game.id} over() returned ${typeof over}, expected a boolean`)
  }
  return over
}

/** Validate one image against the bounds and return its decoded byte count. */
function checkObservationImage(gameId: string, index: number, image: ObservationImage): number {
  const where = `game ${gameId} observation image ${index}`
  // Own-property lookup only: `mediaType` arrives as JSON from a worker, and an
  // inherited key such as `toString` would otherwise pass the guard and fail
  // later with a type error instead of naming the real problem.
  if (!Object.hasOwn(MAGIC, image.mediaType)) {
    throw new Error(`${where} has unsupported mediaType ${String(image.mediaType)}`)
  }
  const magic = MAGIC[image.mediaType]!
  for (const side of ['width', 'height'] as const) {
    const value = image[side]
    if (!Number.isInteger(value) || value <= 0 || value > MAX_OBSERVATION_IMAGE_DIMENSION) {
      throw new Error(
        `${where} declares ${side} ${String(value)}; expected 1..${MAX_OBSERVATION_IMAGE_DIMENSION}`,
      )
    }
  }
  // A label is agent-visible text that a driver puts straight into a prompt, so
  // it is bounded and stripped of every control and formatting character, not
  // just newlines: an escape sequence or a bidi override is prompt injection
  // dressed as a caption.
  if (image.label !== undefined
    && (typeof image.label !== 'string'
      || image.label.length > MAX_OBSERVATION_IMAGE_LABEL_CHARS
      || /\p{C}/u.test(image.label))) {
    throw new Error(
      `${where} label must be a string of at most ${MAX_OBSERVATION_IMAGE_LABEL_CHARS} characters with no control character`,
    )
  }
  if (typeof image.base64 !== 'string' || image.base64.length === 0 || image.base64.length % 4 !== 0
    || !BASE64.test(image.base64)) {
    throw new Error(`${where} is not canonical base64`)
  }
  const padding = image.base64.endsWith('==') ? 2 : image.base64.endsWith('=') ? 1 : 0
  const bytes = (image.base64.length / 4) * 3 - padding
  if (bytes > MAX_OBSERVATION_IMAGE_BYTES) {
    throw new Error(`${where} is ${bytes} bytes, over the ${MAX_OBSERVATION_IMAGE_BYTES} cap`)
  }
  const head = Buffer.from(image.base64.slice(0, 16), 'base64')
  if (head.length < magic.length || magic.some((byte, i) => head[i] !== byte)) {
    throw new Error(`${where} does not start with ${image.mediaType} magic bytes`)
  }
  return bytes
}

/** FNV-1a 32-bit, hex. Not cryptographic; suffices for deterministic state identity. */
export function hashString(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * Tamper-evident input log: each entry stores the chained hash of everything
 * before it, so an in-place edit of a recorded entry desynchronizes entries
 * from the chain and is detected on chainValid().
 *
 * Threat scope (kept honest): the hash is public FNV-1a with no secret, so an
 * adversary who can recompute the whole chain can forge a consistent one.
 * The chain guards accidental mutation and harness-side tampering, NOT a
 * capable adversary. Published or remotely submitted runs use the signed
 * envelope in artifact.ts; replay recomputation remains the strongest proof
 * whenever the verifier controls deterministic execution.
 */
export class InputLog {
  private readonly entries: Input[] = []
  private readonly chain: string[] = []
  private genesis: string

  constructor(genesisSeed: number) {
    this.genesis = hashString(`playproof-genesis:InputLog:${genesisSeed}`)
  }

  add(input: Input): void {
    this.entries.push(input)
    const prev = this.chain.length === 0 ? this.genesis : this.chain[this.chain.length - 1]!
    this.chain.push(hashString(`${prev}|${input}`))
  }

  inputs(): readonly Input[] {
    return this.entries
  }

  head(): string | null {
    return this.chain.length === 0 ? null : this.chain[this.chain.length - 1]!
  }

  /** Recompute the chain; false means the log was edited after the run. */
  chainValid(): boolean {
    let prev = this.genesis
    for (let i = 0; i < this.entries.length; i++) {
      const expect = hashString(`${prev}|${this.entries[i]}`)
      if (expect !== this.chain[i]) return false
      prev = expect
    }
    return true
  }
}

/** Re-execute a log from a seed. The single source of truth for verification. */
export function replay<S>(game: Game<S>, seed: number, log: InputLog): S {
  let state = game.init(seed)
  for (const input of log.inputs()) state = game.step(state, input)
  return state
}

/** Build a log from a literal input script (authoring and calibration). */
export function logFrom(seed: number, inputs: Input[]): InputLog {
  const log = new InputLog(seed)
  for (const i of inputs) log.add(i)
  return log
}
