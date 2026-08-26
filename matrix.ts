/**
 * The matrix: one hand-written file that states which cells a study runs.
 *
 * A cell is one profile playing one game at one objective under one protocol,
 * repeated `reps` times. This module owns the definition and the cell set it
 * denotes; `matrix-run.ts` owns execution. Nothing here spawns a process, reads
 * a clock, or touches an emulator, so a definition can be checked for free.
 *
 * PROTOCOL AND CLOCK ARE PART OF A CELL'S IDENTITY, and this is why the type
 * makes a cell without them unrepresentable rather than defaulting them.
 * Measured on ale-py 0.12.1 against the bundled Breakout reference, changing
 * only the protocol changes what the adapter can even build:
 *
 *   sticky 0 -> 0.10   contract derives, 6 milestones
 *   sticky 0 -> 0.25   REFUSED: mark score-tier-2 never fires on the reference
 *   frameskip 4 -> 2   REFUSED: mark score-opened never fires on the reference
 *   frameskip 4 -> 8   REFUSED: mark score-tier-2 never fires on the reference
 *   seed 0 -> 7        contract derives, 6 milestones
 *
 * A reference script is recorded at one protocol and one clock. Replaying it
 * under another produces another trajectory, so the milestones it was derived
 * from need not fire. A study that reports two such cells side by side is not
 * comparing two profiles; it is comparing two games. The protocol therefore
 * sits in the cell key and in the result, never in a default.
 *
 * A SEED IS NOT AN AXIS UNTIL SOMETHING MAKES IT ONE. Measured on the same
 * build: at `sticky=0`, ALE Breakout seeds 0..4 driven by one fixed script
 * produced 1 distinct trajectory of 5 (final scores [3,3,3,3,3]). At
 * `sticky=0.25` the same five seeds produced 3 distinct trajectories of 5. A
 * definition that declares five seeds at sticky 0 reports one trajectory five
 * times and calls the spread a measurement, so `parseMatrix` refuses it.
 *
 * The format is line-oriented and hand-written on purpose. A study is read and
 * argued over by people before it is run, so the definition is the artifact:
 *
 *   # a comment
 *   profile.opus    harness=claude-code model=claude-opus-5 effort=high
 *   profile.chaser  harness=none policy=./policies/chaser note=hand-written
 *   game.breakout   adapter=ale rom=breakout
 *   objective.score goal=maximize:score horizon=3000 budgetUsd=8
 *   protocol.det    frameskip=4 sticky=0 seeds=1
 *   sensor.ascii    pixels=off channels=-
 *   reps 1
 *
 * Every axis is a namespaced line; the cell set is their cross product times
 * `reps`. An unknown key is refused rather than ignored, because a typo in an
 * axis key silently drops the axis and the study still produces numbers.
 */

/** How a cell's decisions are produced. */
export type ProfileKind = 'harness' | 'policy'

/**
 * How the profile's process is run.
 *
 * `persistent` starts one child for the whole episode and asks it for every
 * decision over stdio. `per-decision` starts a fresh child each time, which is
 * `createCliAgentDriver`'s model.
 *
 * MEASURED, ALE Breakout at 300 decisions: per-decision spawning cost 37.5 ms a
 * decision and 83% of the episode; one process costs 0.97 ms a decision, 38x
 * less. The cost is not the important half. Under `per-decision` A POLICY
 * CANNOT KEEP STATE between turns, silently, with no crash — two programs of
 * one study that differed entirely in design produced hash-identical input logs
 * for that reason alone.
 *
 * `stream` is the third shape and the only ASYNCHRONOUS one. The game writes
 * each observation into a sandbox directory and never waits: the agent reads on
 * its own schedule and appends actions to a file, which the game consumes one
 * per decision. An agent may think for ten frames and then act, which neither
 * polled transport can express, and it holds no emulator handle at all — so the
 * isolation problem that made the offline-author shape expensive to prove does
 * not arise. See `drivers/stream-sandbox.ts`.
 *
 * `persistent` is the default because it is a superset of `per-decision`: a
 * stateless program behaves identically under it, while a stateful one is only
 * correct under it. `per-decision` stays selectable because a one-shot CLI is a
 * real way to run an agent, and a matrix should be able to MEASURE what the
 * transport costs rather than impose one, which is what seventeen rounds of one
 * study did without ever naming it.
 */
export type ProfileTransport = 'persistent' | 'per-decision' | 'stream'

/**
 * One arm of the study.
 *
 * A `harness` profile spawns a coding CLI or model CLI for each decision. A
 * `policy` profile runs a local executable that costs nothing, which is a
 * CONTROL and never the subject: it bounds what an agent profile must beat.
 * Exactly one of the two, because a profile that named both would leave the
 * reader unable to say which produced the number.
 */
export interface MatrixProfile {
  id: string
  kind: ProfileKind
  /** Harness command for `kind: 'harness'`, executable path for `kind: 'policy'`. */
  command: string
  /** Model id, for a harness profile that selects one. */
  model?: string
  /** Reasoning effort, for a harness that accepts one. */
  effort?: string
  /** One process per episode, or one per decision. See `ProfileTransport`. */
  transport: ProfileTransport
  /** Free-text note carried into the result, for a reader. */
  note?: string
}

/** One game, named by the adapter that boots it. */
export interface MatrixGame {
  id: string
  /** Which playproof adapter builds this game. */
  adapter: 'ale' | 'gymnasium' | 'stable-retro' | 'native-2048'
  /** Adapter-specific target: an ale-py ROM id, a Gymnasium env id, a retro game. */
  target: string
  note?: string
}

/** What a cell is trying to do, and what it may spend doing it. */
export interface MatrixObjective {
  id: string
  /** Stated as `maximize:<field>` or `minimize:<field>`. */
  goal: string
  /** Decisions per episode. */
  horizon: number
  /** Dollar ceiling for one episode of one cell. */
  budgetUsd: number
}

/**
 * The protocol and the clock, together, because a cell needs both to mean
 * anything and neither has a defensible default.
 */
export interface MatrixProtocol {
  id: string
  /** Emulator frames per decision. The clock. */
  frameskip: number
  /** Sticky-action probability. 0 is a deterministic, replay-verifiable run. */
  sticky: number
  /** How many seeds this protocol sweeps, starting at `seed0`. */
  seeds: number
  /** First seed of the sweep. */
  seed0: number
  /**
   * Most actions an asynchronous agent may have waiting. Null when no profile
   * in this matrix streams, because the game then never queues anything.
   *
   * It sits in the protocol rather than the profile because it is a fact about
   * how the GAME consumes actions, like the frame repeat and sticky actions,
   * and because it changes what the cell measures.
   */
  queue: number | null
  /**
   * What the game does on a decision the agent has not answered.
   *
   * `repeat-last` keeps doing what it was last told; `noop` stops. Those are
   * different games, so neither is a default worth hiding, and a matrix with a
   * streaming profile must say which one it ran.
   */
  whenEmpty: 'noop' | 'repeat-last' | null
  /**
   * Milliseconds of wall clock the game spends on one decision, or null when
   * no profile streams.
   *
   * A POLLED game has no need of this: it stands still while the agent thinks,
   * so the agent's speed cannot cost it anything. An ASYNCHRONOUS game does not
   * wait, which means wall clock is the agent's whole budget — and with no pace
   * the game steps as fast as the host can run it, so a player that needs two
   * seconds to boot has already lost every decision in the episode. That is not
   * a measurement of the player; it is a measurement of the host's clock speed.
   *
   * Stating the pace is what makes a streamed cell comparable to a polled one
   * and to a human: `pace=16` is roughly sixty decisions a second, `pace=200`
   * is a deliberate turn-taking game. It belongs with the frame repeat and the
   * queue depth because, like them, it changes what the number means.
   */
  paceMs: number | null
}

/** One named RAM byte an adapter may publish to the agent. */
export interface SensorChannel {
  /** Evidence key the agent sees, for example `ball_x`. */
  id: string
  /** RAM byte index, 0..127. */
  index: number
}

/**
 * WHAT THE AGENT MAY SEE. A cell that does not state it is not a result.
 *
 * The observation filter is the dominant variable, not a constant, and it is
 * declared per cell for the same reason the clock is. Measured on one game with
 * one model, changing nothing but the sensor:
 *
 *   ASCII downsample at 4 screen pixels per character     score    20
 *   named RAM channels (ball x, ball y, paddle x)         score   864
 *
 * A 43x swing from the sensor alone. A study that does not name its sensor has
 * not described what it measured, and a study whose sensor is fixed by its
 * adapter has had that choice made for it. Both are how seventeen rounds of one
 * program measured a sensor nobody had named.
 *
 * TWO PLANES, AND THEY ARE NOT THE SAME PLANE. Playproof splits what the agent
 * perceives from what the harness reads, and `observationOf` structurally never
 * reads the second — `scripts/check-boundary.mjs` fails the build if it ever
 * does. So:
 *
 *   `pixels` is an AGENT sensor. It turns on the rendered screen the adapter
 *   publishes through `observe()`, next to the text frame. Off is the text
 *   frame alone, which every adapter publishes. This is the human-like arm.
 *
 *   `channels` is a HARNESS channel. Named RAM bytes reach `evidence()`, which
 *   feeds milestones and this matrix's result vector, and they DO NOT reach the
 *   agent. They still belong to cell identity, because they change what the
 *   contract can check and what the row can report.
 *
 * The superhuman arm — an agent reading RAM directly — is therefore NOT
 * expressible here, and deliberately so: routing evidence to the agent would
 * cross the one boundary playproof exists to hold. Reaching it needs an adapter
 * that renders declared channels into its own `frame()` text, which is an
 * adapter behaviour change and is out of scope for this module. The refusal
 * below is what stops a study believing it got that arm when it did not.
 */
export interface MatrixSensor {
  id: string
  /** Publish the rendered screen to the agent. */
  pixels: boolean
  /** Whole-pixel upscale of that screen, 1..8. Meaningful only with pixels. */
  scale: number
  /** Named RAM bytes published as part of the observation. Empty for none. */
  channels: SensorChannel[]
}

export interface MatrixDefinition {
  profiles: MatrixProfile[]
  games: MatrixGame[]
  objectives: MatrixObjective[]
  protocols: MatrixProtocol[]
  sensors: MatrixSensor[]
  reps: number
}

/** One executable unit of a study. Every axis is present; none is defaulted. */
export interface MatrixCell {
  profile: MatrixProfile
  game: MatrixGame
  objective: MatrixObjective
  protocol: MatrixProtocol
  /** What the agent could see. Required, for the reason `MatrixSensor` states. */
  sensor: MatrixSensor
  /** The seed this cell plays, drawn from the protocol's sweep. */
  seed: number
  /** One-based repetition index within the cell's `reps`. */
  rep: number
}

/**
 * What each adapter can actually publish to the agent.
 *
 * A cell whose sensor an adapter cannot honour is REFUSED rather than quietly
 * downgraded. A silent downgrade is exactly how a study runs for weeks against
 * a sensor it believes it configured and never had.
 */
export const SENSOR_SUPPORT: Record<MatrixGame['adapter'], { pixels: boolean; channels: boolean }> = {
  ale: { pixels: true, channels: true },
  'stable-retro': { pixels: true, channels: false },
  gymnasium: { pixels: false, channels: false },
  'native-2048': { pixels: false, channels: false },
}

/**
 * A cell's readable name. Two cells with the same name may still differ.
 *
 * Use it in a report for a person. Use `cellId` wherever identity decides
 * anything, because a name carries the protocol's NAME and not its contents.
 */
export function cellName(cell: MatrixCell): string {
  return [
    cell.profile.id,
    cell.game.id,
    cell.objective.id,
    cell.protocol.id,
    cell.sensor.id,
    `seed${cell.seed}`,
    `rep${cell.rep}`,
  ].join('/')
}

/** A sensor's contents, for the cell key and for a report. */
export function describeSensor(sensor: MatrixSensor): string {
  const channels = sensor.channels.length === 0
    ? 'no-channels'
    : sensor.channels.map((c) => `${c.id}@${c.index}`).join('+')
  return `pixels=${sensor.pixels ? `on@${sensor.scale}x` : 'off'},${channels}`
}

/**
 * A cell's identity, over everything that decides what it measures.
 *
 * The protocol's CONTENTS are in the key, not just its name. Editing
 * `frameskip=4` to `frameskip=8` under the name `det` produces a different
 * game — measured, see this file's header — so it must produce a different
 * cell. A key built from the name alone would let an edited protocol silently
 * reuse a cached result from the protocol it replaced.
 *
 * The same reasoning covers the profile and the objective: a profile that
 * changes its model is a different arm under the same name.
 */
export function cellId(cell: MatrixCell): string {
  const profile = [
    cell.profile.kind,
    cell.profile.command,
    cell.profile.model ?? '-',
    cell.profile.effort ?? '-',
    cell.profile.transport,
  ]
  const game = [cell.game.adapter, cell.game.target]
  const objective = [cell.objective.goal, cell.objective.horizon, cell.objective.budgetUsd]
  const protocol = [
    cell.protocol.frameskip,
    cell.protocol.sticky,
    cell.protocol.queue ?? '-',
    cell.protocol.whenEmpty ?? '-',
    cell.protocol.paceMs === null ? '-' : `${cell.protocol.paceMs}ms`,
  ]
  return [
    `${cell.profile.id}(${profile.join(',')})`,
    `${cell.game.id}(${game.join(',')})`,
    `${cell.objective.id}(${objective.join(',')})`,
    `${cell.protocol.id}(${protocol.join(',')})`,
    `${cell.sensor.id}(${describeSensor(cell.sensor)})`,
    `seed${cell.seed}`,
    `rep${cell.rep}`,
  ].join('/')
}

/** Every cell a definition denotes, in a stable order. */
export function enumerateCells(definition: MatrixDefinition): MatrixCell[] {
  const cells: MatrixCell[] = []
  for (const profile of definition.profiles) {
    for (const game of definition.games) {
      for (const objective of definition.objectives) {
        for (const protocol of definition.protocols) {
          for (const sensor of definition.sensors) {
            for (let s = 0; s < protocol.seeds; s += 1) {
              for (let rep = 1; rep <= definition.reps; rep += 1) {
                cells.push({ profile, game, objective, protocol, sensor, seed: protocol.seed0 + s, rep })
              }
            }
          }
        }
      }
    }
  }
  return cells
}

const ADAPTERS = new Set<MatrixGame['adapter']>(['ale', 'gymnasium', 'stable-retro', 'native-2048'])

const PROFILE_KEYS = new Set(['harness', 'model', 'effort', 'policy', 'note', 'transport'])
const GAME_KEYS = new Set(['adapter', 'target', 'note'])
const OBJECTIVE_KEYS = new Set(['goal', 'horizon', 'budgetUsd'])
const PROTOCOL_KEYS = new Set(['frameskip', 'sticky', 'seeds', 'seed0', 'queue', 'empty', 'pace'])
const SENSOR_KEYS = new Set(['pixels', 'scale', 'channels'])

/** Parse `ball_x@99,paddle_x@72`, or `-` for none. */
function parseChannels(raw: string, where: string): SensorChannel[] {
  if (raw === '-' || raw === '') return []
  return raw.split(',').map((token) => {
    const at = token.lastIndexOf('@')
    if (at <= 0) throw new Error(`${where}: channel "${token}" must read <id>@<ramIndex>`)
    const id = token.slice(0, at)
    const index = Number(token.slice(at + 1))
    if (!Number.isInteger(index) || index < 0 || index > 127) {
      throw new Error(`${where}: channel "${id}" names RAM byte ${token.slice(at + 1)}; it must be an integer 0..127`)
    }
    if (!/^[a-zA-Z][\w-]*$/u.test(id)) throw new Error(`${where}: channel id "${id}" must start with a letter`)
    return { id, index }
  })
}

function fields(rest: string[], allowed: Set<string>, where: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const token of rest) {
    const split = token.indexOf('=')
    if (split <= 0) throw new Error(`${where}: "${token}" is not key=value`)
    const key = token.slice(0, split)
    const value = token.slice(split + 1)
    if (!allowed.has(key)) {
      throw new Error(`${where}: unknown key "${key}" (accepted: ${[...allowed].sort().join(', ')})`)
    }
    if (out.has(key)) throw new Error(`${where}: key "${key}" is set twice`)
    out.set(key, value)
  }
  return out
}

function required(map: Map<string, string>, key: string, where: string): string {
  const value = map.get(key)
  if (value === undefined || value === '') throw new Error(`${where}: ${key} is required`)
  return value
}

function number(map: Map<string, string>, key: string, where: string): number {
  const raw = required(map, key, where)
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error(`${where}: ${key} must be a finite number, got "${raw}"`)
  return value
}

function integer(map: Map<string, string>, key: string, where: string, min: number): number {
  const value = number(map, key, where)
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${where}: ${key} must be an integer of at least ${min}, got ${value}`)
  }
  return value
}

/**
 * Read a matrix definition, or refuse it with the reason.
 *
 * Every refusal below is a study that would otherwise have produced numbers
 * nobody could read correctly, which is worse than a study that did not run.
 */
export function parseMatrix(text: string): MatrixDefinition {
  const profiles: MatrixProfile[] = []
  const games: MatrixGame[] = []
  const objectives: MatrixObjective[] = []
  const protocols: MatrixProtocol[] = []
  const sensors: MatrixSensor[] = []
  let reps: number | null = null

  const lines = text.split('\n')
  for (const [index, raw] of lines.entries()) {
    const line = raw.split('#')[0]!.trim()
    if (line === '') continue
    const where = `line ${index + 1}`
    const [head, ...rest] = line.split(/\s+/u)
    const token = head!

    if (token === 'reps') {
      const value = Number(rest[0])
      if (!Number.isInteger(value) || value < 1) throw new Error(`${where}: reps must be an integer of at least 1`)
      if (reps !== null) throw new Error(`${where}: reps is set twice`)
      reps = value
      continue
    }

    const dot = token.indexOf('.')
    if (dot <= 0) {
      throw new Error(
        `${where}: "${token}" is not one of profile.<id>, game.<id>, objective.<id>, protocol.<id>, sensor.<id>, reps`,
      )
    }
    const axis = token.slice(0, dot)
    const id = token.slice(dot + 1)
    if (id === '') throw new Error(`${where}: ${axis} needs a name, as ${axis}.<id>`)

    if (axis === 'profile') {
      const map = fields(rest, PROFILE_KEYS, `${where} (profile.${id})`)
      const harness = map.get('harness')
      const policy = map.get('policy')
      // `harness=none` is how a definition says "this arm is a local control".
      const isControl = harness === undefined || harness === 'none'
      if (isControl && policy === undefined) {
        throw new Error(`${where} (profile.${id}): a control profile needs policy=<executable>`)
      }
      if (!isControl && policy !== undefined) {
        throw new Error(
          `${where} (profile.${id}): names both harness=${harness} and policy=${policy}`
          + ' — a reader could not say which produced the number',
        )
      }
      const transport = map.get('transport') ?? 'persistent'
      if (transport !== 'persistent' && transport !== 'per-decision' && transport !== 'stream') {
        throw new Error(
          `${where} (profile.${id}): transport must be persistent, per-decision or stream, got "${transport}"`,
        )
      }
      profiles.push({
        id,
        kind: isControl ? 'policy' : 'harness',
        command: isControl ? policy! : harness!,
        transport,
        ...(map.get('model') === undefined ? {} : { model: map.get('model')! }),
        ...(map.get('effort') === undefined ? {} : { effort: map.get('effort')! }),
        ...(map.get('note') === undefined ? {} : { note: map.get('note')! }),
      })
      continue
    }

    if (axis === 'game') {
      const map = fields(rest, GAME_KEYS, `${where} (game.${id})`)
      const adapter = required(map, 'adapter', `${where} (game.${id})`) as MatrixGame['adapter']
      if (!ADAPTERS.has(adapter)) {
        throw new Error(`${where} (game.${id}): unknown adapter "${adapter}" (have: ${[...ADAPTERS].join(', ')})`)
      }
      games.push({
        id,
        adapter,
        target: adapter === 'native-2048' ? (map.get('target') ?? '2048') : required(map, 'target', `${where} (game.${id})`),
        ...(map.get('note') === undefined ? {} : { note: map.get('note')! }),
      })
      continue
    }

    if (axis === 'objective') {
      const map = fields(rest, OBJECTIVE_KEYS, `${where} (objective.${id})`)
      const goal = required(map, 'goal', `${where} (objective.${id})`)
      if (!/^(?:maximize|minimize):[a-zA-Z][\w-]*$/u.test(goal)) {
        throw new Error(`${where} (objective.${id}): goal must read maximize:<field> or minimize:<field>, got "${goal}"`)
      }
      const budgetUsd = number(map, 'budgetUsd', `${where} (objective.${id})`)
      if (budgetUsd < 0) throw new Error(`${where} (objective.${id}): budgetUsd must be non-negative`)
      objectives.push({ id, goal, horizon: integer(map, 'horizon', `${where} (objective.${id})`, 1), budgetUsd })
      continue
    }

    if (axis === 'protocol') {
      const map = fields(rest, PROTOCOL_KEYS, `${where} (protocol.${id})`)
      const sticky = number(map, 'sticky', `${where} (protocol.${id})`)
      if (sticky < 0 || sticky >= 1) {
        throw new Error(`${where} (protocol.${id}): sticky must be in 0..1, got ${sticky}`)
      }
      const seeds = integer(map, 'seeds', `${where} (protocol.${id})`, 1)
      // The measured refusal. See this file's header: at sticky 0 the seed does
      // not reach the trajectory, so N seeds are one trajectory reported N times.
      if (seeds > 1 && sticky === 0) {
        throw new Error(
          `${where} (protocol.${id}): seeds=${seeds} at sticky=0 reports one trajectory ${seeds} times.`
          + ' Measured on ale-py 0.12.1 Breakout: seeds 0..4 under one fixed script gave 1 distinct'
          + ' trajectory of 5 at sticky=0, and 3 of 5 at sticky=0.25. Either set seeds=1, or raise'
          + ' sticky so the seed reaches the trajectory.',
        )
      }
      const emptyRaw = map.get('empty')
      if (emptyRaw !== undefined && emptyRaw !== 'noop' && emptyRaw !== 'repeat-last') {
        throw new Error(`${where} (protocol.${id}): empty must be noop or repeat-last, got "${emptyRaw}"`)
      }
      protocols.push({
        id,
        frameskip: integer(map, 'frameskip', `${where} (protocol.${id})`, 1),
        sticky,
        seeds,
        seed0: map.get('seed0') === undefined ? 0 : integer(map, 'seed0', `${where} (protocol.${id})`, 0),
        queue: map.get('queue') === undefined ? null : integer(map, 'queue', `${where} (protocol.${id})`, 1),
        whenEmpty: emptyRaw ?? null,
        paceMs: map.get('pace') === undefined ? null : integer(map, 'pace', `${where} (protocol.${id})`, 0),
      })
      continue
    }

    if (axis === 'sensor') {
      const at = `${where} (sensor.${id})`
      const map = fields(rest, SENSOR_KEYS, at)
      const pixelsRaw = map.get('pixels') ?? 'off'
      if (pixelsRaw !== 'on' && pixelsRaw !== 'off') {
        throw new Error(`${at}: pixels must be on or off, got "${pixelsRaw}"`)
      }
      const pixels = pixelsRaw === 'on'
      const scale = map.get('scale') === undefined ? 1 : integer(map, 'scale', at, 1)
      if (scale > 8) throw new Error(`${at}: scale must be 1..8, got ${scale}`)
      if (!pixels && map.get('scale') !== undefined) {
        throw new Error(`${at}: scale needs pixels=on; a scale with no screen changes nothing and would read as if it did`)
      }
      const channels = parseChannels(map.get('channels') ?? '-', at)
      const ids = new Set<string>()
      for (const c of channels) {
        if (ids.has(c.id)) throw new Error(`${at}: channel "${c.id}" is declared twice`)
        ids.add(c.id)
      }
      sensors.push({ id, pixels, scale, channels })
      continue
    }

    throw new Error(`${where}: unknown axis "${axis}" (have: profile, game, objective, protocol, sensor)`)
  }

  const missing: string[] = []
  if (profiles.length === 0) missing.push('a profile')
  if (games.length === 0) missing.push('a game')
  if (objectives.length === 0) missing.push('an objective')
  // Refused rather than defaulted: a cell whose protocol and clock are unstated
  // is a cell nobody can reproduce or compare. See this file's header.
  if (protocols.length === 0) missing.push('a protocol, which states the clock and the sticky probability')
  // Same rule, same reason: a cell that does not state what the agent could see
  // is not a result. See `MatrixSensor` for the 43x this is measured against.
  if (sensors.length === 0) missing.push('a sensor, which states what the agent may see')
  if (missing.length > 0) throw new Error(`matrix declares no cells: it needs ${missing.join(', ')}`)

  for (const [axis, ids] of [
    ['profile', profiles.map((p) => p.id)],
    ['game', games.map((g) => g.id)],
    ['objective', objectives.map((o) => o.id)],
    ['protocol', protocols.map((p) => p.id)],
    ['sensor', sensors.map((s) => s.id)],
  ] as const) {
    const seen = new Set<string>()
    for (const id of ids) {
      if (seen.has(id)) throw new Error(`${axis}.${id} is declared twice`)
      seen.add(id)
    }
  }

  // A streaming profile makes the queue and the empty-queue default part of
  // what the cell measures, so they stop being optional the moment one appears.
  // They stay optional otherwise: a polled game never queues an action, and
  // demanding a queue depth it cannot use would be noise stated as rigour.
  const streaming = profiles.filter((profile) => profile.transport === 'stream')
  if (streaming.length > 0) {
    for (const protocol of protocols) {
      const unstated: string[] = []
      if (protocol.queue === null) unstated.push('queue=<depth>')
      if (protocol.whenEmpty === null) unstated.push('empty=noop|repeat-last')
      if (protocol.paceMs === null) unstated.push('pace=<ms per decision>')
      if (unstated.length > 0) {
        throw new Error(
          `protocol.${protocol.id} must state ${unstated.join(' and ')}, because`
          + ` profile.${streaming[0]!.id} streams: an asynchronous agent leaves the game to decide what acts`
          + ' while it thinks and how long it had to think, and a cell that states neither is not a result',
        )
      }
    }
  }

  // A sensor an adapter cannot honour is refused HERE, at the definition, and
  // never downgraded at run time. The cross product is small and fully known,
  // so a study that cannot be run as written is told so before it spends
  // anything, rather than producing rows against a sensor it never had.
  for (const game of games) {
    const support = SENSOR_SUPPORT[game.adapter]
    for (const sensor of sensors) {
      if (sensor.pixels && !support.pixels) {
        throw new Error(
          `sensor.${sensor.id} asks for pixels, and game.${game.id} runs on the ${game.adapter} adapter,`
          + ' which publishes no rendered screen. Refused rather than downgraded to text: a study that'
          + ' believes it configured a sensor it never had measures something nobody named.',
        )
      }
      if (sensor.channels.length > 0 && !support.channels) {
        throw new Error(
          `sensor.${sensor.id} asks for RAM channels (${sensor.channels.map((c) => c.id).join(', ')}),`
          + ` and game.${game.id} runs on the ${game.adapter} adapter, which publishes no named RAM bytes.`
          + ' Refused rather than downgraded, for the same reason.',
        )
      }
    }
  }

  return { profiles, games, objectives, protocols, sensors, reps: reps ?? 1 }
}
