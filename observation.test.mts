/**
 * Observation-channel test — the agent may be shown pixels, and showing them
 * changes nothing a verifier recomputes.
 *
 * Battery: the text-only default, an image game through `playEpisode` and
 * `runCampaign`, every bound rejecting an oversized or malformed image, the
 * evidence boundary holding on the agent channel, replay and attestation
 * identical with and without images, and both built-in drivers sending pixels
 * only when the caller opted in. No emulator and no model spend.
 */
import { strict as assert } from 'node:assert'
import { attestRun } from './attestation'
import { deriveContract } from './authoring'
import { runCampaign, type CampaignLedger } from './campaign'
import { createCliAgentDriver } from './drivers/cli'
import { createOpenAICompatibleDriver } from './drivers/openai-compatible'
import { playEpisode, type AgentDecisionContext, type AgentDriver } from './episode'
import {
  logFrom,
  observationOf,
  observationTextOf,
  MAX_OBSERVATION_IMAGE_BYTES,
  MAX_OBSERVATION_IMAGES,
  MAX_OBSERVATION_IMAGE_DIMENSION,
  MAX_OBSERVATION_IMAGE_LABEL_CHARS,
  MAX_OBSERVATION_TOTAL_IMAGE_BYTES,
  type Evidence,
  type Game,
  type ObservationImage,
} from './runtime'
import { contractHash, type MilestoneContract } from './schema'

/** A real 1x1 PNG, so the magic-byte check sees a genuine file. */
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** A well-formed PNG header followed by `bytes` of filler, as base64. */
function pngOfSize(bytes: number): string {
  return Buffer.concat([PNG_MAGIC, Buffer.alloc(Math.max(0, bytes - PNG_MAGIC.length))]).toString('base64')
}

function screen(state: RoomState): ObservationImage {
  return { mediaType: 'image/png', base64: PNG_1X1, width: 1, height: 1, label: `room ${state.room}` }
}

interface RoomState {
  room: number
  /** Privileged counter. It must never appear on the agent channel. */
  hidden: number
}

/**
 * The same game twice: once publishing pixels, once not.
 *
 * Both share an id, a transition, and an evidence function, which is what lets
 * the replay assertions below compare them directly.
 */
function roomGame(images: boolean): Game<RoomState> {
  const base: Game<RoomState> = {
    id: 'room-walker',
    init: () => ({ room: 0, hidden: 1_000 }),
    step: (s, input) => (input === 'right' ? { room: s.room + 1, hidden: s.hidden + 7_919 } : s),
    frame: (s) => `room ${s.room} · exits: east`,
    evidence: (s): Evidence => ({ engineState: { room: s.room, hidden: s.hidden } }),
  }
  if (!images) return base
  return { ...base, observe: (s) => ({ text: base.frame(s), images: [screen(s)] }) }
}

function roomContract(game: Game<RoomState>): MilestoneContract {
  return deriveContract(game, 0, ['right', 'right', 'right'], [
    {
      afterInputs: 3,
      id: 'room-3',
      tier: 'engine-state',
      glitchClass: 'legal',
      sample: (e) => ({ kind: 'state-path', path: 'room', op: '>=', value: e.engineState?.room ?? 0 }),
    },
  ])
}

interface SeenTurn {
  frame: string
  images: readonly ObservationImage[] | undefined
  observationText: string | undefined
  historyKeys: string[]
}

function recordingDriver(seen: SeenTurn[]): AgentDriver {
  return {
    act: async (frame, history, context) => {
      seen.push({
        frame,
        images: context.observation?.images,
        observationText: context.observation?.text,
        historyKeys: history.flatMap((entry) => Object.keys(entry)),
      })
      return { input: 'right', costUsd: 0 }
    },
  }
}

const withImages = roomGame(true)
const textOnly = roomGame(false)

{
  // A game with no observe() has exactly the observation it always had.
  const state = textOnly.init(0)
  const observation = observationOf(textOnly, state)
  assert.deepEqual(observation, { text: textOnly.frame(state) })
  assert.equal('images' in observation, false)
}

{
  // An image game round-trips through playEpisode: the driver's first argument
  // stays the observation text, and the pixels arrive beside it.
  const seen: SeenTurn[] = []
  const { record } = await playEpisode(withImages, roomContract(withImages), recordingDriver(seen), 1, 3, 0)
  assert.equal(record.verdict, 'clean')
  assert.deepEqual(record.verified, ['room-3'])
  assert.equal(seen.length, 3)
  for (const turn of seen) {
    assert.equal(turn.frame, turn.observationText)
    assert.equal(turn.images?.length, 1)
    assert.equal(turn.images?.[0]?.base64, PNG_1X1)
    assert.equal(turn.images?.[0]?.mediaType, 'image/png')
  }
  // History is text only. Images would be re-sent on every later decision.
  assert.deepEqual([...new Set(seen[2]!.historyKeys)].sort(), ['frame', 'input'])
}

{
  // The same through a segmented campaign, and no image reaches the ledger the
  // campaign writes to disk.
  const seen: SeenTurn[] = []
  let saved: CampaignLedger | undefined
  const { record, ledger } = await runCampaign(withImages, roomContract(withImages), recordingDriver(seen), {
    budgetUsd: 1,
    maxTurns: 4,
    segmentTurns: 2,
    seed: 0,
    onLedger: (next) => { saved = next },
  })
  assert.equal(record.turns, 4)
  assert.equal(ledger.segments.length, 2)
  assert.equal(seen.length, 4)
  assert.ok(seen.every((turn) => turn.images?.length === 1))
  assert.ok(saved !== undefined)
  assert.equal(JSON.stringify(saved).includes(PNG_1X1.slice(0, 24)), false)
}

{
  // Every bound rejects, and none of them silently shrinks the observation.
  const reject = (image: Record<string, unknown>, pattern: RegExp): void => {
    const game: Game<RoomState> = {
      ...textOnly,
      observe: (s) => ({ text: textOnly.frame(s), images: [image as unknown as ObservationImage] }),
    }
    assert.throws(() => observationOf(game, game.init(0)), pattern)
  }
  const ok: Record<string, unknown> = { mediaType: 'image/png', base64: PNG_1X1, width: 1, height: 1 }

  reject({ ...ok, base64: pngOfSize(MAX_OBSERVATION_IMAGE_BYTES + 3) }, /over the 1048576 cap/u)
  reject({ ...ok, width: MAX_OBSERVATION_IMAGE_DIMENSION + 1 }, /expected 1\.\.2048/u)
  reject({ ...ok, height: 0 }, /expected 1\.\.2048/u)
  reject({ ...ok, width: 1.5 }, /expected 1\.\.2048/u)
  reject({ ...ok, mediaType: 'image/gif' }, /unsupported mediaType/u)
  reject({ ...ok, base64: 'not base64!!' }, /not canonical base64/u)
  reject({ ...ok, base64: Buffer.from('plain text, not an image').toString('base64') }, /magic bytes/u)
  reject({ ...ok, label: 'x'.repeat(MAX_OBSERVATION_IMAGE_LABEL_CHARS + 1) }, /at most 200 characters/u)
  reject({ ...ok, label: 'two\nlines' }, /no control character/u)
  // A caption reaches a prompt verbatim, so an escape sequence or a bidi
  // override is rejected as firmly as a newline, and a non-string is not a
  // caption at all.
  reject({ ...ok, label: 'colour\u001b[31mme' }, /no control character/u)
  reject({ ...ok, label: 'flip\u202Eme' }, /no control character/u)
  reject({ ...ok, label: 12_345 }, /label must be a string/u)
  // An inherited key is not a media type. Without an own-property check this
  // failed later with a type error instead of naming the real problem.
  reject({ ...ok, mediaType: 'toString' }, /unsupported mediaType/u)
  reject({ ...ok, mediaType: '__proto__' }, /unsupported mediaType/u)

  const notAnArray: Game<RoomState> = {
    ...textOnly,
    observe: (state) => ({ text: textOnly.frame(state), images: null as unknown as ObservationImage[] }),
  }
  assert.throws(() => observationOf(notAnArray, notAnArray.init(0)), /images that are not an array/u)

  const many: Game<RoomState> = {
    ...textOnly,
    observe: (s) => ({ text: textOnly.frame(s), images: Array.from({ length: MAX_OBSERVATION_IMAGES + 1 }, () => screen(s)) }),
  }
  assert.throws(() => observationOf(many, many.init(0)), /over the 4 per turn/u)

  // Each image is inside the per-image cap; the per-turn total is not.
  const half = pngOfSize(Math.floor(MAX_OBSERVATION_TOTAL_IMAGE_BYTES / 3))
  const bulky: Game<RoomState> = {
    ...textOnly,
    observe: (s) => ({
      text: textOnly.frame(s),
      images: Array.from({ length: 4 }, () => ({ mediaType: 'image/png' as const, base64: half, width: 8, height: 8 })),
    }),
  }
  assert.throws(() => observationOf(bulky, bulky.init(0)), /images total \d+ bytes, over the 2097152 per turn/u)

  // A breached bound fails the turn rather than reaching the driver.
  const oversized: Game<RoomState> = {
    ...textOnly,
    observe: (s) => ({
      text: textOnly.frame(s),
      images: [{ mediaType: 'image/png', base64: pngOfSize(MAX_OBSERVATION_IMAGE_BYTES + 3), width: 8, height: 8 }],
    }),
  }
  await assert.rejects(
    playEpisode(oversized, roomContract(textOnly), recordingDriver([]), 1, 3, 0),
    /over the 1048576 cap/u,
  )
}

{
  // The observation a driver receives is a frozen snapshot, all the way down,
  // so a driver cannot write back into the turn the harness is running.
  const frozen = observationOf(withImages, withImages.init(0))
  assert.ok(Object.isFrozen(frozen))
  assert.ok(Object.isFrozen(frozen.images))
  assert.ok(Object.isFrozen(frozen.images![0]))

  // The text accessor applies the same default and never touches the images,
  // so a history row cannot fail on a bound that governs pixels nobody records.
  const state = textOnly.init(0)
  assert.equal(observationTextOf(textOnly, state), textOnly.frame(state))
  assert.equal(observationTextOf(withImages, state), observationOf(withImages, state).text)
  const oversizedImage: Game<RoomState> = {
    ...textOnly,
    observe: (s) => ({
      text: textOnly.frame(s),
      images: [{ mediaType: 'image/png', base64: pngOfSize(MAX_OBSERVATION_IMAGE_BYTES + 3), width: 8, height: 8 }],
    }),
  }
  assert.equal(observationTextOf(oversizedImage, state), textOnly.frame(state))
}

{
  // The evidence boundary: the privileged counter is in evidence on every turn
  // and never on the agent channel, text or caption.
  const seen: SeenTurn[] = []
  await playEpisode(withImages, roomContract(withImages), recordingDriver(seen), 1, 3, 0)
  let state = withImages.init(0)
  for (let turn = 0; turn < 3; turn++) {
    state = withImages.step(state, 'right')
    const hidden = String(withImages.evidence(state).engineState?.hidden)
    const channel = JSON.stringify(seen[turn])
    assert.ok(hidden.length > 3)
    assert.equal(channel.includes(hidden), false, `turn ${turn + 1} leaked privileged evidence ${hidden}`)
  }
}

{
  // Replay determinism: images are observation only, so the contract, the
  // chain head, the verified set, and the whole attestation are identical.
  const script = ['right', 'right', 'right']
  const contractWith = roomContract(withImages)
  const contractWithout = roomContract(textOnly)
  assert.equal(contractHash(contractWith), contractHash(contractWithout))

  const seen: SeenTurn[] = []
  const visionRun = await playEpisode(withImages, contractWith, recordingDriver(seen), 1, 3, 0)
  const textRun = await playEpisode(textOnly, contractWithout, recordingDriver([]), 1, 3, 0)
  assert.ok(seen.every((turn) => turn.images?.length === 1), 'the vision run really did produce images')
  assert.deepEqual(visionRun.record.verified, textRun.record.verified)
  assert.deepEqual(visionRun.log.inputs(), textRun.log.inputs())
  assert.equal(visionRun.log.head(), textRun.log.head())
  assert.equal(visionRun.record.replayDivergence, false)

  const claimed = contractWith.milestones.map((milestone) => milestone.id)
  const attestedWith = attestRun(withImages, contractWith, 0, logFrom(0, script), claimed)
  const attestedWithout = attestRun(textOnly, contractWithout, 0, logFrom(0, script), claimed)
  assert.deepEqual(attestedWith, attestedWithout)
  assert.equal(attestedWith.verdict, 'clean')
}

const driverContext: AgentDecisionContext = {
  turn: 1,
  maxTurns: 10,
  seed: 0,
  spentUsd: 0,
  remainingBudgetUsd: 1,
  observation: { text: 'FRAME', images: [{ mediaType: 'image/png', base64: PNG_1X1, width: 1, height: 1, label: 'screen' }] },
}

{
  // The OpenAI-compatible driver sends content parts only with vision on.
  let body: { messages?: { role: string; content: unknown }[] } | undefined
  const fetchImpl: typeof globalThis.fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body)) as { messages?: { role: string; content: unknown }[] }
    return new Response(JSON.stringify({ choices: [{ message: { content: 'right' } }] }), { status: 200 })
  }
  const userContent = (): unknown => body?.messages?.find((message) => message.role === 'user')?.content

  const plain = createOpenAICompatibleDriver({ model: 'm', fetch: fetchImpl, commands: ['right'] })
  await plain.act('FRAME', [], driverContext)
  assert.equal(typeof userContent(), 'string', 'vision is off by default')

  const vision = createOpenAICompatibleDriver({
    model: 'm',
    fetch: fetchImpl,
    commands: ['right'],
    vision: true,
    imageDetail: 'high',
  })
  await vision.act('FRAME', [], driverContext)
  const parts = userContent() as { type: string; text?: string; image_url?: { url: string; detail?: string } }[]
  assert.ok(Array.isArray(parts))
  assert.deepEqual(parts.map((part) => part.type), ['text', 'text', 'image_url'])
  assert.ok(parts[0]?.text?.includes('FRAME'))
  assert.equal(parts[1]?.text, 'screen')
  assert.equal(parts[2]?.image_url?.url, `data:image/png;base64,${PNG_1X1}`)
  assert.equal(parts[2]?.image_url?.detail, 'high')

  // Vision on, but this turn has no pixels: the plain string request is unchanged.
  const { observation: _dropped, ...noImages } = driverContext
  await vision.act('FRAME', [], noImages)
  assert.equal(typeof userContent(), 'string')
}

{
  // The CLI driver carries the images in its JSON request, under `images`.
  const script = [
    "let text = ''",
    "process.stdin.setEncoding('utf8')",
    "process.stdin.on('data', (chunk) => { text += chunk })",
    "process.stdin.on('end', () => {"
    + '  const request = JSON.parse(text);'
    + '  const image = request.images && request.images[0];'
    + "  const note = image === undefined ? 'none' : image.mediaType + ':' + image.width + 'x' + image.height + ':' + image.base64.length;"
    + "  process.stdout.write(JSON.stringify({ input: 'right', costUsd: 0, note }));"
    + '})',
  ].join(';')
  const options = { command: process.execPath, args: ['-e', script], commands: ['right'], timeoutMs: 10_000 }

  let note = ''
  const capture = (run: { stdout: string }): number => {
    note = (JSON.parse(run.stdout) as { note: string }).note
    return 0
  }
  const plain = createCliAgentDriver({ ...options, costUsd: capture })
  await plain.act('FRAME', [], driverContext)
  assert.equal(note, 'none', 'vision is off by default')

  const vision = createCliAgentDriver({ ...options, costUsd: capture, vision: true })
  const turn = await vision.act('FRAME', [], driverContext)
  assert.equal(turn.input, 'right')
  assert.equal(note, `image/png:1x1:${PNG_1X1.length}`)

  // The rendered prompt is a text protocol; asking it to carry pixels fails
  // at construction instead of dropping them on every turn.
  assert.throws(
    () => createCliAgentDriver({ ...options, fixedCostUsd: 0, vision: true, stdin: 'prompt' }),
    /vision requires stdin json/u,
  )
}

console.log('playproof observation: text default, image round-trip, bounds, evidence boundary, replay parity, and both drivers OK')
