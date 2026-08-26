# The observation channel

## The observation channel: text always, pixels optional

A game declares what the agent perceives. Text is always there. Images are opt-in.

```ts
interface Observation {
  text: string
  images?: readonly ObservationImage[]
}

interface ObservationImage {
  mediaType: 'image/png' | 'image/jpeg'
  base64: string
  width: number
  height: number
  label?: string
}
```

A game publishes pixels by implementing `observe(state)`.
A game that does not implement it has the observation `{ text: frame(state) }`, which is what every game had before, so nothing about a text game changes.
The harness builds every observation through one function, `observationOf(game, state)`, and hands it to the driver as `context.observation`.

### Why this exists

The emulator adapters were already capturing the screen.
`ale/worker.py` calls `getScreenRGB()`, hashes those pixels into `frameHash` for verification, and used to throw the picture away; the agent received a luminance-to-ASCII downsample of it.
That is a perception limit the harness created, not a result about the agent.

Measured on ALE Breakout, against the six-milestone contract of the time: `stealth/ox-alpha`, a `text+image->text` model, and `liquid/lfm-2.5-2.6b:free` both scored 0 of 6 milestones, and their own transcripts show them reading the ASCII as a maze — "exploring the map", "positioned near the goal area" — rather than a paddle-and-ball game.
One of them pressed `FIRE` twice in 45 turns, so no ball was ever in play.

### Bounds

An image is an unbounded byte channel into a context somebody pays for, so the harness fixes a ceiling:

| Bound | Value | Why |
|---|---|---|
| `MAX_OBSERVATION_IMAGE_BYTES` | 1 MiB decoded | About 440x the largest real frame measured (a 3x Breakout upscale encodes to 2,383 bytes), so it never fires on legitimate pixels and still stops a runaway adapter. |
| `MAX_OBSERVATION_IMAGE_DIMENSION` | 2048 px | Model providers resize an image into their own tile grid at or below that edge, so pixels past it are re-encoded away before the model reads them while the harness still pays for the bytes. |
| `MAX_OBSERVATION_IMAGES` | 4 per turn | A screen plus an inset or a comparison frame, not a filmstrip. |
| `MAX_OBSERVATION_TOTAL_IMAGE_BYTES` | 2 MiB per turn | The per-turn total is what the context actually pays for. |

Breaching a bound is a harness error that fails the turn.
Nothing is silently shrunk: a run whose observation quietly changed size is a run whose reported result cannot be reproduced.

History stays text only.
A driver replays its retained trajectory into every prompt, so keeping images in history would multiply the image tokens by the history depth on every decision.

### The evidence boundary does not move

`Observation` is the agent's channel and `Evidence` is the harness's.
The screen image is legitimate precisely because it is what a human player sees; a caption that carried privileged state would not be.
`scripts/check-boundary.mjs` fails the build if `observationOf` reads `evidence`, or if any driver names it at all, and `observation.test.mts` runs a game whose privileged counter must never appear in the text, the caption, or the history.

### Replay is unaffected

Images never enter the input log, the contract, or the attestation.
A replay recomputes progress from the seed and the inputs alone, so the same run verifies identically whether or not it produced pixels.
`observation.test.mts` asserts it: same contract hash, same chain head, same verified set, same attestation.

### Sending the pixels

Both built-in drivers default to off, so no existing caller starts paying for image tokens without asking:

```ts
const driver = createOpenAICompatibleDriver({ model: 'your-model', vision: true })
```

With `vision: true` and an observation that has images, the user message becomes OpenAI content parts (`text` plus `image_url` data URLs).
With vision off, or on a turn with no images, the request is the same single string it always was.
The CLI driver takes `vision: true` as well and adds an `images` key to its JSON request; its first-word protocol is unchanged.

**A vision run costs image tokens.** A rendered frame is typically several hundred to a thousand-plus input tokens per turn, on top of the text, on every decision. Playproof records the reported cost either way and does not discount it.

### Which adapters produce pixels

`adapters/ale`, `adapters/pyboy-generic`, and `adapters/stable-retro` take `screenImage: true` and encode the screen their worker already captured; `screenScale` repeats whole pixels for the low-resolution consoles.
`adapters/retroarch` takes `screenImage: true` and republishes RetroArch's own screenshot.
The Gymnasium adapter publishes no image: its environments are vector or `ansi` observations, and a pixel render would need an imaging dependency Playproof does not take.
See [Execution adapters](adapters.md).

