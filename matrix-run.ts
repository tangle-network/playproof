/**
 * Running a matrix: one cell at a time, through the machinery that already
 * exists.
 *
 * This module builds nothing that playproof already owns. A cell's decisions
 * come from `createCliAgentDriver`, its episode from `playEpisode`, its grade
 * from `attestRun` by way of that episode's record, and its game from the
 * adapter the definition names. What is written here is only the part that had
 * no owner: turning one `MatrixCell` into one row, and turning the rows into
 * the cross-game statistic that is the point of running a matrix at all.
 *
 * THE RESULT IS A VECTOR, NOT A SCALAR. A single number cannot say that a
 * profile scored well by dying repeatedly, or that it answered every decision
 * with one word, or that its dollars are unknown rather than zero. Every field
 * of `CellResult` is reported, and a field that was not measured is `null`
 * rather than 0 — a distinction that exists because summing an unmeasured cost
 * as zero is how a study reports a free run that was never priced.
 *
 * A BLOCKED CELL HAS NO STANDING. A cell whose game could not be built under
 * its own protocol is recorded with the reason and is excluded from every
 * ranking. It is not a zero: a profile that never played did not lose.
 * Measured on ale-py 0.12.1, this is not hypothetical — the bundled Breakout
 * reference is recorded at one clock, and asking for `frameskip=2` or
 * `frameskip=8` or `sticky=0.25` makes its contract underivable, so those cells
 * cannot be built at all. See `matrix.ts` for the table.
 *
 * Env knobs:
 *   PLAYPROOF_PYTHON   interpreter that runs an emulator worker (default python3)
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { attestRun } from './attestation'
import { playEpisode, scriptedDriver, type AgentDriver, type EpisodeRecord, type EpisodeStop } from './episode'
import { createCliAgentDriver } from './drivers/cli'
import { createPersistentCliDriver, type PersistentAgentDriver } from './drivers/persistent-cli'
import { createStreamSandboxDriver } from './drivers/stream-sandbox'
import {
  cellId,
  cellName,
  describeSensor,
  type MatrixCell,
  type MatrixDefinition,
  type MatrixGame,
  type MatrixObjective,
  type MatrixProfile,
  type MatrixProtocol,
  type MatrixSensor,
} from './matrix'
import { enumerateCells } from './matrix'
import type { Evidence, Game } from './runtime'
import type { MilestoneContract, MilestoneScore } from './schema'

/** A game built for one cell, under that cell's own protocol and clock. */
export interface BuiltGame {
  game: Game<unknown>
  contract: MilestoneContract
  /** Input words the adapter accepts, handed to the driver as its vocabulary. */
  commands: readonly string[]
  dispose(): void
}

/**
 * How a cell's game is built.
 *
 * A seam rather than a hard-wired switch, because a test must run a whole
 * matrix with no emulator on the machine, and because a study may bring a game
 * playproof does not ship an adapter for. `buildAdapterGame` is the default.
 */
export interface GameBuilder {
  (game: MatrixGame, protocol: MatrixProtocol, sensor: MatrixSensor, seed: number): Promise<BuiltGame>
}

/** Why a cell produced no episode. */
export type BlockedReason = 'game-unbuildable' | 'driver-unusable' | 'episode-failed'

/**
 * One row of a matrix.
 *
 * The identity fields come first and are complete: profile, game, objective,
 * protocol, seed and repetition. Two cells that differ only in their clock have
 * different `cell` strings, so nothing can average them into one row.
 */
export interface CellResult {
  /** Identity over the protocol's contents, not its name. See `cellId`. */
  cell: string
  /** The readable name, for a report. Not an identity. */
  name: string
  profile: string
  game: string
  objective: string
  protocol: string
  /** The clock, the protocol and the sensor, restated in the row so a reader
   * never has to find the definition file to know what produced the number. */
  frameskip: number
  sticky: number
  /** What the agent could see, and what the harness recorded. */
  sensor: string
  sensorDetail: string
  seed: number
  rep: number
  status: 'played' | 'blocked'
  /** Present only when `status` is `blocked`. */
  blocked?: { reason: BlockedReason; detail: string }

  // ---- the vector -----------------------------------------------------------
  /** Final engine score, or null when the game publishes no score channel. */
  score: number | null
  /** Lives lost, or null when the game publishes no life counter. Never 0 for
   * a game that has none: absent is not "died zero times". */
  deaths: number | null
  /** Decisions the episode actually took. */
  decisions: number
  /** Emulator frames advanced, or null when the game publishes no frame counter. */
  emulatorFrames: number | null
  /** Wall clock for the whole cell, including building the game. */
  wallMs: number
  /**
   * Tokens the decisions cost.
   *
   * Always null today, and deliberately so rather than absent: playproof prices
   * a decision in dollars through the driver's own report and never sees a
   * token count. A reader who needs tokens must meter the provider; a zero here
   * would claim a measurement nobody took.
   */
  tokens: number | null
  /** Dollars the episode reported spending. */
  usd: number | null
  /** Whether the game declared itself finished. Null when it declares no end. */
  cleared: boolean | null
  /** Milestones the replay reproduced. */
  verified: readonly string[]
  milestones: MilestoneScore
  verdict: 'clean' | 'rejected'
  stoppedBy: EpisodeStop | null
  /** Distinct input words the cell emitted, over its whole log. */
  distinctInputs: number
  /** A replay that did not reproduce the run is a harness fault, not a score. */
  replayDivergence: boolean
  /**
   * What became of the process the transport started, when it reports it.
   *
   * A streaming agent that never started still produces a full episode of
   * default actions and a clean attestation, so without this a broken arm is
   * indistinguishable from a cautious one. Null when the transport has nothing
   * to say.
   */
  transportNote: string | null
  /**
   * The input log's chained head: one value identifying the whole action
   * sequence this cell emitted.
   *
   * Two profiles whose cells share it did not play two ways; they played once,
   * and a statistic counting them as two arms is counting one. `effectiveArms`
   * reads this. Null when the cell emitted nothing.
   */
  actionsHash: string | null
}

/**
 * Build the driver a profile denotes. Nothing here is a new dispatch layer.
 *
 * A profile IS a set of driver options — a command, arguments, a vocabulary and
 * a transport. It needs no bridge and no adapter of its own.
 */
export function driverFor(
  profile: MatrixProfile,
  commands: readonly string[],
  sensor?: MatrixSensor,
  protocol?: MatrixProtocol,
  streamDir?: string,
  objective?: MatrixObjective,
): AgentDriver {
  // A control is a local executable that costs nothing. `fixedCostUsd: 0` is
  // the explicit statement that this arm is free, which both drivers demand
  // rather than assume.
  const args: string[] = []
  if (profile.kind === 'harness') {
    if (profile.model !== undefined) args.push('--model', profile.model)
    if (profile.effort !== undefined) args.push('--effort', profile.effort)
  }
  const vision = sensor?.pixels === true
  if (profile.transport === 'stream') {
    if (streamDir === undefined) {
      throw new Error(`profile.${profile.id} streams, so it needs a sandbox directory to stream into`)
    }
    if (protocol?.queue == null || protocol.whenEmpty == null || protocol.paceMs == null) {
      throw new Error(
        `profile.${profile.id} streams, so its protocol must state queue, empty and pace`
        + ' — the game decides what acts while the agent thinks and how long it had to think,'
        + ' and both are part of the measurement',
      )
    }
    return createStreamSandboxDriver({
      dir: streamDir,
      commands,
      queueDepth: protocol.queue,
      whenEmpty: protocol.whenEmpty,
      ...(protocol.paceMs === null ? {} : { paceMs: protocol.paceMs }),
      ...(vision ? { vision } : {}),
      fixedCostUsd: 0,
      // An agent started in a directory of observation files has been told the
      // controls by `brief.json` and nothing else. What it is being ASKED to do
      // lives in the objective, so it travels with the process. Omitted rather
      // than defaulted when there is no objective: an invented goal would be a
      // silent change to what the cell measures.
      ...(objective === undefined
        ? {}
        : {
            env: {
              PLAYPROOF_GOAL: objective.goal,
              PLAYPROOF_HORIZON: String(objective.horizon),
              PLAYPROOF_SPEND_CEILING: String(objective.budgetUsd),
            },
          }),
      // The sandbox is the agent's working directory, so a relative program
      // path in the definition would resolve against the sandbox and silently
      // fail to start. It is resolved against the caller's directory, which is
      // what the person writing the definition meant.
      ...(profile.command === ''
        ? {}
        : { command: isAbsolute(profile.command) ? profile.command : resolve(profile.command), args }),
    })
  }
  // A control writes a bare word and is free, and says so explicitly. A metered
  // agent writes JSON and reports what the decision cost; nothing here invents a
  // cost, so an agent that reports none fails the decision instead of banking a
  // zero. The wire format follows the PROFILE, never the transport, so one
  // program runs unchanged under all three and the transport axis measures the
  // transport alone.
  const wire = profile.kind === 'policy'
    ? { output: 'first-word' as const, fixedCostUsd: 0 }
    : { output: 'json' as const }
  if (profile.transport === 'persistent') {
    return createPersistentCliDriver({
      command: profile.command,
      args,
      commands,
      ...(vision ? { vision } : {}),
      ...wire,
    })
  }
  return createCliAgentDriver({
    command: profile.command,
    args,
    commands,
    stdin: 'json',
    ...(vision ? { vision } : {}),
    ...wire,
  })
}

/** The adapter-backed builder. Imports lazily so one missing emulator cannot
 * stop a matrix whose other cells do not need it. */
export const buildAdapterGame: GameBuilder = async (game, protocol, sensor, seed) => {
  const python = process.env.PLAYPROOF_PYTHON
  if (game.adapter === 'ale') {
    const { makeAle } = await import('./adapters/ale')
    const ale = makeAle({
      game: game.target,
      seed,
      frames: protocol.frameskip,
      repeatActionProbability: protocol.sticky,
      // The agent sensor. `screenScale` is only accepted with the screen on,
      // so it is passed only then; the adapter refuses the pair otherwise.
      ...(sensor.pixels ? { screenImage: true, screenScale: sensor.scale } : {}),
      // The harness channel. These reach `evidence()` and never the agent.
      // Passing none leaves the reference's own channels in place, so a cell
      // that declares no channel cannot silently strip the ones a milestone
      // reads.
      ...(sensor.channels.length === 0
        ? {}
        : { channels: sensor.channels.map((c) => ({ id: c.id, index: c.index, decode: 'u8' as const })) }),
      ...(python === undefined ? {} : { python }),
    })
    return { game: ale.game as Game<unknown>, contract: ale.contract, commands: ale.inputs, dispose: ale.dispose }
  }
  if (game.adapter === 'gymnasium') {
    const { makeGymnasium } = await import('./adapters/gymnasium')
    const gym = makeGymnasium({ envId: game.target, seed, ...(python === undefined ? {} : { python }) })
    return { game: gym.game as Game<unknown>, contract: gym.contract, commands: gym.inputs, dispose: gym.dispose }
  }
  if (game.adapter === 'stable-retro') {
    const { makeStableRetro } = await import('./adapters/stable-retro')
    const retro = makeStableRetro({
      game: game.target,
      seed,
      frames: protocol.frameskip,
      ...(sensor.pixels ? { screenImage: true, screenScale: sensor.scale } : {}),
      ...(python === undefined ? {} : { python }),
    })
    return { game: retro.game as Game<unknown>, contract: retro.contract, commands: retro.inputs, dispose: retro.dispose }
  }
  const { makeNative2048, NATIVE_2048_INPUTS } = await import('./adapters/native-2048')
  const native = makeNative2048(seed)
  return {
    game: native.game as Game<unknown>,
    contract: native.contract,
    commands: NATIVE_2048_INPUTS,
    dispose: native.dispose,
  }
}

/**
 * Where a streaming cell's sandbox lives.
 *
 * One directory per cell, named by the cell, so two cells never read each
 * other's observations or each other's actions.
 */
function streamDir(cell: MatrixCell, options: RunCellOptions): string {
  const root = options.streamRoot ?? mkdtempSync(join(tmpdir(), 'playproof-stream-'))
  return join(root, cellName(cell).replace(/[^\w.-]+/gu, '_'))
}

/** Watch the privileged channel as the episode produces it, for the vector. */
function watchEvidence(source: Game<unknown>): { game: Game<unknown>; snapshots: Record<string, number>[] } {
  const snapshots: Record<string, number>[] = []
  // `playEpisode` finalizes by replaying the log, which walks the trajectory a
  // second time. Only the first pass is kept, or every channel is counted twice.
  let pass = 0
  const observe = source.observe?.bind(source)
  const over = source.over?.bind(source)
  return {
    snapshots,
    game: {
      id: source.id,
      init: (seed) => {
        pass += 1
        return source.init(seed)
      },
      step: (state, input) => source.step(state, input),
      frame: (state) => source.frame(state),
      ...(observe === undefined ? {} : { observe }),
      ...(over === undefined ? {} : { over }),
      evidence: (state): Evidence => {
        const evidence = source.evidence(state)
        if (pass === 1 && evidence.engineState !== undefined) snapshots.push(evidence.engineState)
        return evidence
      },
    },
  }
}

function channel(snapshots: readonly Record<string, number>[], key: string): number[] {
  return snapshots.map((s) => s[key]).filter((v): v is number => v !== undefined)
}

/** Lives lost across the run, or null when the game counts no lives. */
function deathsFrom(snapshots: readonly Record<string, number>[]): number | null {
  const lives = channel(snapshots, 'lives')
  if (lives.length === 0) return null
  let deaths = 0
  for (let i = 1; i < lives.length; i += 1) {
    if (lives[i]! < lives[i - 1]!) deaths += lives[i - 1]! - lives[i]!
  }
  return deaths
}

function lastOf(values: readonly number[]): number | null {
  return values.length === 0 ? null : values[values.length - 1]!
}

function blockedResult(cell: MatrixCell, reason: BlockedReason, detail: string, wallMs: number): CellResult {
  return {
    ...identity(cell),
    status: 'blocked',
    blocked: { reason, detail },
    score: null,
    deaths: null,
    decisions: 0,
    emulatorFrames: null,
    wallMs,
    tokens: null,
    usd: 0,
    cleared: null,
    verified: [],
    milestones: { verified: 0, total: 0 },
    verdict: 'rejected',
    stoppedBy: null,
    distinctInputs: 0,
    replayDivergence: false,
    actionsHash: null,
    transportNote: null,
  }
}

function identity(cell: MatrixCell): Pick<
  CellResult,
  'cell' | 'name' | 'profile' | 'game' | 'objective' | 'protocol' | 'frameskip' | 'sticky'
  | 'sensor' | 'sensorDetail' | 'seed' | 'rep'
> {
  return {
    cell: cellId(cell),
    name: cellName(cell),
    profile: cell.profile.id,
    game: cell.game.id,
    objective: cell.objective.id,
    protocol: cell.protocol.id,
    frameskip: cell.protocol.frameskip,
    sticky: cell.protocol.sticky,
    sensor: cell.sensor.id,
    sensorDetail: describeSensor(cell.sensor),
    seed: cell.seed,
    rep: cell.rep,
  }
}

export interface RunCellOptions {
  /** Defaults to `buildAdapterGame`. */
  build?: GameBuilder
  /** Defaults to `driverFor`. */
  driver?: (
    profile: MatrixProfile,
    commands: readonly string[],
    sensor: MatrixSensor,
    protocol: MatrixProtocol,
    streamDir: string,
    objective: MatrixObjective,
  ) => AgentDriver
  /** Where a streaming profile's sandbox is made. Defaults to a temp directory. */
  streamRoot?: string
  signal?: AbortSignal
  now?: () => number
}

/**
 * Run one cell and return its row.
 *
 * A cell that cannot be built is BLOCKED, never zero. That distinction is the
 * whole reason this returns a row instead of throwing: a matrix that stops on
 * its first unbuildable cell reports nothing about the cells that would have
 * run, and a matrix that scores it 0 reports that a profile played badly when
 * it never played.
 */
export async function runCell(cell: MatrixCell, options: RunCellOptions = {}): Promise<CellResult> {
  const now = options.now ?? (() => Date.now())
  const build = options.build ?? buildAdapterGame
  const makeDriver = options.driver ?? driverFor
  const started = now()

  let built: BuiltGame
  try {
    built = await build(cell.game, cell.protocol, cell.sensor, cell.seed)
  } catch (error) {
    return blockedResult(cell, 'game-unbuildable', (error as Error).message, now() - started)
  }

  try {
    let driver: AgentDriver
    try {
      driver = makeDriver(
        cell.profile,
        built.commands,
        cell.sensor,
        cell.protocol,
        streamDir(cell, options),
        cell.objective,
      )
    } catch (error) {
      return blockedResult(cell, 'driver-unusable', (error as Error).message, now() - started)
    }

    // The cell owns the process it played with, whatever happened to it.
    // Closing a session that already ended is a no-op; closing a healthy one is
    // what stops a child outliving its cell.
    try {
    const watched = watchEvidence(built.game)
    let record: EpisodeRecord
    let actionsHash: string | null
    try {
      const played = await playEpisode(
        watched.game,
        built.contract,
        driver,
        cell.objective.budgetUsd,
        cell.objective.horizon,
        cell.seed,
        options.signal,
        { stopAtGameOver: true },
      )
      record = played.record
      actionsHash = played.log.head()
    } catch (error) {
      return blockedResult(cell, 'episode-failed', (error as Error).message, now() - started)
    }

    // Read before the driver is closed: closing kills the process that keeps
    // the meter current, and a meter read after that is a meter read too late.
    const meter = meterOf(driver)
    return {
      ...identity(cell),
      status: 'played',
      score: lastOf(channel(watched.snapshots, 'score')),
      deaths: deathsFrom(watched.snapshots),
      decisions: record.turns,
      emulatorFrames: lastOf(channel(watched.snapshots, 'frameNumber')),
      wallMs: now() - started,
      // An unmetered arm reports null, never zero: a study that reads them the
      // same ranks the profile nobody metered first on cost per point.
      tokens: meter.tokens,
      usd: meter.metered && meter.costUsd === null ? null : (meter.costUsd ?? 0) + record.spentUsd,
      cleared: record.gameOver,
      verified: record.verified,
      milestones: record.score,
      verdict: record.verdict,
      stoppedBy: record.stoppedBy,
      distinctInputs: Math.round(record.inputStats.uniqueRatio * record.inputStats.inputs),
      replayDivergence: record.replayDivergence,
      actionsHash,
      transportNote: transportNoteOf(driver),
    }
    } finally {
      closeIfPersistent(driver)
    }
  } finally {
    built.dispose()
  }
}

/** A driver that owns a child process must be closed by whoever made it. */
function closeIfPersistent(driver: AgentDriver): void {
  const session = driver as Partial<PersistentAgentDriver>
  if (typeof session.close === 'function') session.close()
}

/**
 * What the transport has to say about the process it ran, if anything.
 *
 * Read before the driver is closed. A transport that reports nothing returns
 * null rather than an empty string, so a reader can tell "nothing to report"
 * from "reported nothing".
 *
 * Every fact it holds is JOINED, never substituted. The fate of the agent used
 * to return early and hide the starvation count behind it. Measured on the
 * first three-profile comparison this repo ran: the one arm whose agent
 * finished was the one arm whose starvation nobody could read — an asymmetry
 * between compared arms produced by the reporting rather than by the run.
 */
/**
 * What the transport says the agent spent.
 *
 * A transport with no meter reports nothing, and nothing stays NULL rather than
 * becoming zero: an arm nobody metered and an arm that was free are different
 * claims, and a study that confuses them ranks an unmeasured profile first on
 * efficiency.
 */
function meterOf(driver: AgentDriver): { metered: boolean; costUsd: number | null; tokens: number | null } {
  const reporter = driver as { health?: () => Record<string, unknown> }
  if (typeof reporter.health !== 'function') return { metered: false, costUsd: null, tokens: null }
  const health = reporter.health()
  // `metered` asks whether this transport HAS a cost channel, which is a
  // different question from whether anything came down it. A per-decision
  // control that declares `fixedCostUsd: 0` is genuinely free and must total
  // zero; only a transport that owns a meter can report the absence of one.
  if (!('costUsd' in health)) return { metered: false, costUsd: null, tokens: null }
  const nonNegative = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
  return { metered: true, costUsd: nonNegative(health.costUsd), tokens: nonNegative(health.tokens) }
}

function transportNoteOf(driver: AgentDriver): string | null {
  const reporter = driver as { health?: () => Record<string, unknown> }
  if (typeof reporter.health !== 'function') return null
  const health = reporter.health()
  const parts: string[] = []
  const agent = health.agent
  const detail = health.agentDetail
  if (typeof agent === 'string' && agent !== 'running' && agent !== 'none') {
    parts.push(`agent ${agent}${typeof detail === 'string' ? `: ${detail}` : ''}`)
  }
  const endReason = health.endReason
  if (typeof endReason === 'string') {
    parts.push(`session ${endReason}${typeof health.detail === 'string' ? `: ${health.detail}` : ''}`)
  }
  const starved = health.starved
  if (typeof starved === 'number' && starved > 0) parts.push(`${starved} decisions took the empty-queue default`)
  // Reported beside the starvation it explains. A rewritten action file used to
  // silence the agent outright, so a reader who sees both numbers can tell an
  // agent that stopped playing from one that keeps a rolling plan.
  const rewrites = health.rewrites
  if (typeof rewrites === 'number' && rewrites > 0) parts.push(`${rewrites} action-file rewrites`)
  const overrun = health.overrun
  if (typeof overrun === 'number' && overrun > 0) parts.push(`${overrun} decisions ran late of the pace`)
  return parts.length > 0 ? parts.join('; ') : null
}

/** Run every cell a definition denotes, in the definition's own order. */
export async function runMatrix(definition: MatrixDefinition, options: RunCellOptions = {}): Promise<CellResult[]> {
  const rows: CellResult[] = []
  for (const cell of enumerateCells(definition)) rows.push(await runCell(cell, options))
  return rows
}

/**
 * Refuse to pool rows that were not measured under one protocol and one clock.
 *
 * Averaging a `frameskip=4` cell with a `frameskip=8` cell produces a number
 * with no referent: measured on ale-py 0.12.1, those are different games to the
 * point that one of them cannot even build the other's contract. This throws
 * rather than warning, because a warning next to a number gets quoted without
 * the warning.
 *
 * Rows of different GAMES are joinable — that is what a matrix is for. Rows of
 * different protocols or horizons are not.
 */
export function assertJoinable(rows: readonly CellResult[]): void {
  const protocols = new Set(rows.map((r) => `${r.protocol}:frameskip=${r.frameskip},sticky=${r.sticky}`))
  if (protocols.size > 1) {
    throw new Error(
      `these rows were measured under ${protocols.size} protocols and cannot be pooled: ${[...protocols].sort().join(' | ')}`,
    )
  }
  // The sensor is a 43x variable on one measured game. Pooling across it is
  // pooling across the dominant term.
  const sensors = new Set(rows.map((r) => `${r.sensor}:${r.sensorDetail}`))
  if (sensors.size > 1) {
    throw new Error(
      `these rows were measured through ${sensors.size} sensors and cannot be pooled: ${[...sensors].sort().join(' | ')}`,
    )
  }
  const objectives = new Set(rows.map((r) => r.objective))
  if (objectives.size > 1) {
    throw new Error(
      `these rows were measured at ${objectives.size} objectives, so their clocks differ and they cannot be pooled:`
      + ` ${[...objectives].sort().join(', ')}`,
    )
  }
}

/**
 * How many of a matrix's arms are actually distinct.
 *
 * Two profiles that emit the same action sequence are one arm wearing two
 * names. A rank statistic over "three profiles" that are really two is not the
 * statistic it says it is, so the count is reported next to it rather than
 * assumed from the number of profile lines.
 *
 * Only played cells with a hash and at least one decision count. A refused cell
 * emits nothing, and every empty cell would otherwise alias with every other.
 */
export function effectiveArms(rows: readonly CellResult[]): {
  declared: number
  effective: number
  aliases: string[][]
} {
  const declared = new Set(rows.map((r) => r.profile))
  const byHash = new Map<string, Set<string>>()
  for (const row of rows) {
    if (row.status !== 'played' || row.actionsHash === null || row.decisions === 0) continue
    // The hash identifies one action sequence on one game; two profiles alias
    // only when they match on the same game and the same draw.
    const key = `${row.game}/${row.seed}/${row.actionsHash}`
    const group = byHash.get(key) ?? new Set<string>()
    group.add(row.profile)
    byHash.set(key, group)
  }
  const aliases: string[][] = []
  const merged = new Map<string, string>()
  for (const group of byHash.values()) {
    if (group.size < 2) continue
    const names = [...group].sort()
    aliases.push(names)
    for (const name of names) merged.set(name, names[0]!)
  }
  const effective = new Set([...declared].map((name) => merged.get(name) ?? name))
  return { declared: declared.size, effective: effective.size, aliases }
}

// ---- the cross-game statistic ----------------------------------------------

/**
 * How consistently a matrix ranks its profiles across games.
 *
 * A matrix exists to answer one question a single game cannot: does a profile
 * that wins here win there? Running one game and reporting the winner measures
 * that game. This measures whether the ORDER survives a change of game.
 *
 * Kendall's tau-b, pairwise between games, averaged. Tau-b rather than tau-a
 * because two profiles genuinely tie often at these horizons, and tau-a turns
 * a tie into an ordering.
 *
 * `folds` is reported next to the number and is the count of GAMES, not of
 * pairs. Two games give one pair and one fold: a tau computed from it is a
 * single observation and cannot support a claim about transfer. A reader who
 * cannot see the fold count cannot tell that apart from a real finding.
 */
export interface Generalization {
  /** Mean pairwise Kendall tau-b across games, or null when fewer than 2 games ranked. */
  tau: number | null
  /** Games that contributed a ranking. */
  folds: number
  /** Game pairs the mean is over. */
  pairs: number
  /** Profiles ranked in every contributing game; the tau is over these alone. */
  profiles: string[]
  /** Cells excluded for having no standing, with the reason. */
  excluded: { cell: string; reason: string }[]
  /** Profile names the matrix declared. */
  declaredArms: number
  /**
   * Arms that actually played differently. Below `declaredArms` means two
   * profiles emitted the same actions, so the tau has fewer independent arms
   * than its profile count suggests.
   */
  effectiveArms: number
  /** Profile groups that emitted identical action sequences. */
  aliases: string[][]
  /** Why the tau is null, or what qualifies it. */
  note: string | null
}

/**
 * Rank profiles within each game and measure whether the order transfers.
 *
 * `value` reads the field the objective names. A blocked cell never reaches
 * this function's ranking: it has no standing, and a run that never happened
 * cannot out-rank one that did.
 */
export function generalization(rows: readonly CellResult[], field: keyof CellResult = 'score'): Generalization {
  const excluded: { cell: string; reason: string }[] = []
  const arms = effectiveArms(rows)
  const byGame = new Map<string, Map<string, number[]>>()
  for (const row of rows) {
    if (row.status !== 'played') {
      excluded.push({ cell: row.cell, reason: `blocked: ${row.blocked?.detail ?? 'no episode'}` })
      continue
    }
    const value = row[field]
    if (typeof value !== 'number') {
      excluded.push({ cell: row.cell, reason: `${String(field)} was not measured on this game` })
      continue
    }
    const game = byGame.get(row.game) ?? new Map<string, number[]>()
    const seen = game.get(row.profile) ?? []
    seen.push(value)
    game.set(row.profile, seen)
    byGame.set(row.game, game)
  }

  const armCounts = { declaredArms: arms.declared, effectiveArms: arms.effective, aliases: arms.aliases }
  const games = [...byGame.keys()].sort()
  if (games.length < 2) {
    return {
      tau: null,
      folds: games.length,
      pairs: 0,
      profiles: [],
      excluded,
      ...armCounts,
      note: `a transfer statistic needs at least 2 games with a ranking; ${games.length} produced one`,
    }
  }

  // Only profiles present in EVERY game. A profile ranked in one game and
  // absent from another would otherwise be imputed a position it never earned.
  const common = [...(byGame.get(games[0]!)?.keys() ?? [])]
    .filter((profile) => games.every((game) => byGame.get(game)!.has(profile)))
    .sort()
  if (common.length < 2) {
    return {
      tau: null,
      folds: games.length,
      pairs: 0,
      profiles: common,
      excluded,
      ...armCounts,
      note: `a rank correlation needs at least 2 profiles ranked in every game; ${common.length} were`,
    }
  }

  const mean = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0) / values.length
  const scores = new Map<string, number[]>()
  for (const game of games) {
    scores.set(game, common.map((profile) => mean(byGame.get(game)!.get(profile)!)))
  }

  const taus: number[] = []
  for (let i = 0; i < games.length; i += 1) {
    for (let j = i + 1; j < games.length; j += 1) {
      taus.push(kendallTauB(scores.get(games[i]!)!, scores.get(games[j]!)!))
    }
  }
  const qualifications: string[] = []
  if (taus.length === 1) {
    qualifications.push('one game pair: this tau is a single observation, not evidence that an order transfers')
  }
  if (arms.effective < arms.declared) {
    qualifications.push(
      `${arms.declared} profiles emitted only ${arms.effective} distinct action sequences`
      + ` (${arms.aliases.map((group) => group.join('=')).join(', ')}), so this tau has fewer independent arms than profiles`,
    )
  }
  return {
    tau: mean(taus),
    folds: games.length,
    pairs: taus.length,
    profiles: common,
    excluded,
    ...armCounts,
    note: qualifications.length === 0 ? null : qualifications.join('; '),
  }
}

/**
 * Kendall's tau-b over two equal-length score vectors.
 *
 * Tau-b corrects for ties in either vector. With no tie it equals tau-a. When
 * one vector is entirely tied it is undefined, and 0 is returned: no order was
 * expressed, so none transferred.
 */
export function kendallTauB(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new Error(`tau needs equal-length vectors, got ${a.length} and ${b.length}`)
  let concordant = 0
  let discordant = 0
  let tiedA = 0
  let tiedB = 0
  for (let i = 0; i < a.length; i += 1) {
    for (let j = i + 1; j < a.length; j += 1) {
      const da = Math.sign(a[i]! - a[j]!)
      const db = Math.sign(b[i]! - b[j]!)
      if (da === 0 && db === 0) {
        tiedA += 1
        tiedB += 1
        continue
      }
      if (da === 0) {
        tiedA += 1
        continue
      }
      if (db === 0) {
        tiedB += 1
        continue
      }
      if (da === db) concordant += 1
      else discordant += 1
    }
  }
  const pairs = (a.length * (a.length - 1)) / 2
  const denominator = Math.sqrt((pairs - tiedA) * (pairs - tiedB))
  return denominator === 0 ? 0 : (concordant - discordant) / denominator
}

/** A fixed script as a profile, for a smoke run that spends nothing. */
export function scriptedProfileDriver(script: readonly string[]): AgentDriver {
  return scriptedDriver(script)
}
