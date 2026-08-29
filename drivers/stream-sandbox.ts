/**
 * The game streams into a sandbox directory; the agent reads it when it likes
 * and writes actions back. The game never waits.
 *
 * ## Why this is a third shape and not a variant of the other two
 *
 * Playproof has two transports already, and both couple the agent's thinking
 * rate to the game's frame rate:
 *
 *   `createCliAgentDriver`         one process per decision. The harness blocks
 *                                  until the agent answers, and the agent
 *                                  cannot keep state, let alone think between
 *                                  frames.
 *   `createPersistentCliDriver`    one process per episode. State survives, but
 *                                  the harness still blocks on every decision.
 *
 * Both are POLLED: the game stands still while the agent thinks, so an agent
 * that reasons for a second per frame plays a game that has stopped for a
 * second. That is not how the game is played by anything else, and it is not
 * how an agent is good at working — an agent is good at accumulating, running a
 * script over what it accumulated, and then acting.
 *
 * The third shape decouples them. The observation is written to a file; the
 * agent reads it on its own schedule, with as many subagents and analysis
 * scripts as it likes; actions come back over a one-word-per-line file. The
 * agent may take a thousand frames' worth of wall clock to decide, and the game
 * does not care, because the game does not wait.
 *
 * ISOLATION BECOMES A FILESYSTEM QUESTION. In the offline-author shape the
 * agent's program holds a live emulator handle, and an adversary reaches the
 * scored emulator by walking `sys._getframe` even when the attribute has been
 * deleted — which is why proving that shape honest needed a child process, a
 * shadow emulator advanced by the same actions, and a SHA-256 comparison every
 * decision. Here the agent holds no handle at all. It reads files and writes a
 * word. There is no object graph to isolate, so the hardest part of that proof
 * simply does not arise.
 *
 * ## The design question, answered rather than defaulted
 *
 * If the agent is asynchronous, WHAT ACTS WHILE IT IS THINKING? Two answers,
 * and they measure different things:
 *
 *   BLOCK  the game waits for an action. This is polling again with a file
 *          transport, and it measures the same thing the two drivers above do.
 *   QUEUE  actions accumulate, the game consumes one per decision, and a
 *          DEFAULT applies when the queue is empty.
 *
 * This implements QUEUE, because it is the one that measures something new: an
 * agent that thinks for ten frames and then acts is a different player from one
 * that thinks for one, and only the queue can tell them apart. Blocking would
 * make the transport invisible in the result, which is the outcome this whole
 * exercise exists to stop.
 *
 * `whenEmpty` and `queueDepth` therefore CHANGE WHAT IS BEING MEASURED, so
 * `matrix.ts` puts them in the protocol next to sticky actions and the frame
 * repeat, and a cell that does not state them is not a result. `repeat-last` is
 * a game that keeps doing what it was told until told otherwise; `noop` is a
 * game that stops. Those are different games, and neither is a default worth
 * hiding.
 *
 * ## What does not change
 *
 * The attestation. The action log this driver emits is replayed exactly like
 * any other, so a stream cell is checkable by `attestRun` on the same terms as
 * a polled one. `observationOf` is still the only thing that builds what gets
 * written, so the privileged channel cannot leak into the sandbox: what the
 * agent may see here is the same `observe()` every other transport reads.
 *
 * Env knobs:
 *   PLAYPROOF_STREAM_ACTIONS  action file name inside the sandbox (default actions)
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync, closeSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentDriver } from '../episode'
import type { Observation } from '../runtime'

const ACTION_FILE = process.env.PLAYPROOF_STREAM_ACTIONS ?? 'actions'

/** What the game does on a decision the agent has not answered. */
export type WhenEmpty = 'noop' | 'repeat-last'

/** What one streamed episode did, for an operator. It grades nothing. */
export interface StreamHealth {
  /** Observations written into the sandbox. */
  written: number
  /** Actions the agent supplied and the game consumed. */
  consumed: number
  /** Decisions taken with an empty queue, so the default applied. */
  starved: number
  /** Actions dropped because the queue was already at its depth. */
  dropped: number
  /** Lines the agent wrote that named no command the game accepts. */
  rejected: number
  /** Deepest the queue ever got. */
  peakQueue: number
  /**
   * Times the action file got shorter, meaning the agent rewrote it rather than
   * appending. Recovered from, and counted so a reader can tell an agent that
   * rewrites from one that appends.
   */
  rewrites: number
  /**
   * Decisions the game was already late for when they came due.
   *
   * A paced cell with a high overrun did not run at the pace it declared, so
   * the agent had less thinking time than the definition says. Reported rather
   * than corrected: silently stretching the episode would hide the fact that
   * the host could not hold the rate.
   */
  overrun: number
  /**
   * What became of the agent this driver started.
   *
   * `none` when the caller started its own. The game never waits for an agent,
   * which is the whole design — but that also means an agent which never ran
   * looks exactly like one that is still thinking. Measured while smoke-testing
   * this driver: a bad command produced 30 starved decisions, a clean
   * attestation, and no sign anywhere that the agent had not started. So the
   * fate of the child is reported, and its last error with it.
   */
  agent: 'none' | 'running' | 'exited' | 'failed'
  /** The child's exit status, or the reason it could not start. Null while healthy. */
  agentDetail: string | null
  /**
   * What the agent says it spent, or null when it did not say.
   *
   * This transport cannot meter per decision: the agent runs on its own clock
   * and answers into a file, so there is no call to bracket. The only honest
   * source is the agent's own report, republished by its launcher into
   * `agent-cost.json`. NULL AND ZERO ARE DIFFERENT FACTS — a free arm and an
   * unmetered one look identical in a total, and only one of them is a result.
   */
  costUsd: number | null
  /** Tokens the agent says it has spent, or null when it did not say. */
  tokens: number | null
  /** Input and output tokens apart, and turns taken. A ratio is diagnostic:
   *  1.8M in against 72 out is an agent reading, not one writing. */
  inputTokens: number | null
  outputTokens: number | null
  turns: number | null
  /**
   * Which credential path the agent used, as its launcher reported it.
   *
   * `'api-key' | 'oauth'` is the union the rest of the stack uses, and the CLI
   * agent registry passes the same value to a spawned backend as
   * `CLAUDE_CODE_AUTH_MODE`. Null when the launcher did not say.
   *
   * It decides whether a dollar figure can exist. Under `oauth` the agent bills
   * against a plan and reports no per-request cost, so a null cost means
   * UNBILLED THIS WAY rather than free.
   */
  authMode: 'api-key' | 'oauth' | null
}

export interface StreamSandboxDriverOptions {
  /** Directory the game writes into and the agent reads. Created if absent. */
  dir: string
  /** Input words the game accepts. A line naming anything else is rejected. */
  commands: readonly string[]
  /** Most actions the queue holds. Beyond it, the agent's writes are dropped. */
  queueDepth: number
  /** What the game does when no action is waiting. */
  whenEmpty: WhenEmpty
  /**
   * Wall clock the game spends on one decision. Omitted means as fast as the
   * host can step, which is only honest for a player that is already running.
   *
   * The game does not wait for the agent, so wall clock IS the agent's budget.
   * Unpaced, an episode of a few hundred decisions is over in milliseconds and
   * anything with a process to start has lost all of them before it printed a
   * line — a result that reports the host's clock speed, not the player. The
   * pace is held against a schedule rather than slept after each decision, so a
   * slow decision borrows from the next one instead of stretching the episode.
   */
  paceMs?: number
  /** Write the rendered screen into the sandbox next to the text. Off by default. */
  vision?: boolean
  /** Started once with `dir` as its working directory, and killed at `close()`. */
  command?: string
  args?: readonly string[]
  env?: Readonly<Record<string, string>>
  /** Explicitly 0 only for genuinely free execution. */
  fixedCostUsd?: number
}

export interface StreamSandboxDriver extends AgentDriver {
  /** Idempotent. Kills the agent, if this driver started one. */
  close(): void
  health(): StreamHealth
  /** The directory the agent reads. */
  readonly dir: string
}

/**
 * A file the game appends to and the agent reads, plus the reverse.
 *
 * Both directions are plain files rather than a FIFO on purpose: a FIFO couples
 * the two processes' lifetimes, and the point of this shape is that it does
 * not. An agent may start late, crash and restart, or read the same
 * observation twice, and none of that stops the game.
 */
export function createStreamSandboxDriver(options: StreamSandboxDriverOptions): StreamSandboxDriver {
  if (!Number.isInteger(options.queueDepth) || options.queueDepth < 1) {
    throw new Error('stream queueDepth must be an integer of at least 1')
  }
  if (options.whenEmpty !== 'noop' && options.whenEmpty !== 'repeat-last') {
    throw new Error(`stream whenEmpty must be noop or repeat-last, got "${String(options.whenEmpty)}"`)
  }
  if (options.fixedCostUsd === undefined) {
    throw new Error('stream cost is unavailable; configure explicit pricing with fixedCostUsd')
  }
  if (!Number.isFinite(options.fixedCostUsd) || options.fixedCostUsd < 0) {
    throw new Error('stream fixedCostUsd must be non-negative')
  }

  const dir = options.dir
  mkdirSync(join(dir, 'observations'), { recursive: true })
  const actionPath = join(dir, ACTION_FILE)
  // Created empty so the agent can open it before the first decision without
  // racing the harness for its existence.
  if (!existsSync(actionPath)) writeFileSync(actionPath, '')
  // The sandbox describes itself. A player of any kind is entitled to the
  // control scheme and to the rule about what acts while it thinks — a person
  // handed a cabinet reads the panel before the first credit. Everything here
  // is the SHAPE of the channel, never the state of the game: no value this
  // driver writes comes from anywhere but the observation it was handed.
  // Without it an agent started in here must guess its own vocabulary, and a
  // guessed word is a rejected line, which reads in the health record as an
  // agent that played badly rather than one that was never told the rules.
  writeFileSync(
    join(dir, 'brief.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        actions: ACTION_FILE,
        observations: 'observations',
        latest: 'latest.json',
        commands: [...options.commands],
        queueDepth: options.queueDepth,
        whenEmpty: options.whenEmpty,
        paceMs: options.paceMs ?? null,
        vision: options.vision === true,
      },
      null,
      2,
    )}\n`,
  )

  const queue: string[] = []
  let offset = 0
  let carry = ''
  let written = 0
  let consumed = 0
  let starved = 0
  let dropped = 0
  let rejected = 0
  let peakQueue = 0
  let last = 'noop'
  let child: ChildProcess | null = null
  let agent: StreamHealth['agent'] = 'none'
  let agentDetail: string | null = null
  /** The child's last stderr, kept only to explain a death. */
  let agentStderr = ''
  /** When the next decision is due, on the same clock `Date.now` reads. */
  let dueAt: number | null = null
  /** Decisions the game was already late for, so the pace was not held. */
  let overrun = 0
  /** Times the agent rewrote the action file instead of appending to it. */
  let rewrites = 0

  if (options.command !== undefined) {
    const started = spawn(options.command, [...(options.args ?? [])], {
      cwd: dir,
      env: {
        ...process.env,
        ...(options.env ?? {}),
        PLAYPROOF_STREAM_DIR: dir,
        // Duplicated from brief.json on purpose: a launcher that is a shell
        // one-liner should not have to parse JSON to know the vocabulary.
        PLAYPROOF_ACTIONS: ACTION_FILE,
        PLAYPROOF_COMMANDS: options.commands.join(','),
        PLAYPROOF_WHEN_EMPTY: options.whenEmpty,
        PLAYPROOF_QUEUE_DEPTH: String(options.queueDepth),
        PLAYPROOF_PACE_MS: String(options.paceMs ?? 0),
      },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    // The agent's own output is not an action channel: actions arrive through
    // the file. Its stderr is still kept, bounded, because it is the only thing
    // that can explain an agent which never wrote an action.
    // A killed child's pipes can emit `error` after the fact, and a stream with
    // no error listener throws to the top of the process. MEASURED: a 42-cell
    // study died at cell 3 on an unhandled `EPIPE` from one of these, after two
    // cells had already cost twenty minutes each. The child's fate is already
    // reported through `health()`, so these listeners record and do not rethrow.
    started.stdout?.on('error', (error: Error) => {
      if (agentStderr.length < 4096) agentStderr += `\n[stdout] ${error.message}`
    })
    started.stderr?.on('error', (error: Error) => {
      if (agentStderr.length < 4096) agentStderr += `\n[stderr] ${error.message}`
    })
    started.stdout?.resume()
    started.stderr?.setEncoding('utf8')
    started.stderr?.on('data', (chunk: string) => {
      if (agentStderr.length < 4096) agentStderr += chunk
    })
    // A permanent listener, never removed: a ChildProcess that emits `error`
    // with nobody listening throws, and this one can emit long after `close()`.
    started.on('error', (error) => {
      agent = 'failed'
      agentDetail = `the agent could not be started: ${error.message}`
    })
    // A spawn that failed outright has no pid, and says so at once rather than
    // waiting for the asynchronous `error`. Without this a bad command reads as
    // `running` for as long as the episode is short, which is the same silence
    // this field exists to break.
    if (started.pid === undefined) {
      agent = 'failed'
      agentDetail = `the agent could not be started: no process for ${options.command}`
    }
    started.once('exit', (code, signal) => {
      // A kill from `close()` is the caller ending a healthy agent, not a death.
      if (agent === 'failed' || child === null) return
      agent = code === 0 ? 'exited' : 'failed'
      const how = code ?? signal ?? 'unknown'
      agentDetail = `the agent exited (${how})${agentStderr === '' ? '' : `: ${agentStderr.trim().slice(-500)}`}`
    })
    if (agent !== 'failed') agent = 'running'
    // The game owns its own lifetime. An agent must never be the reason the
    // harness cannot exit.
    started.unref()
    child = started
  }

  /**
   * Read whatever the agent has put in the action file since the last decision.
   *
   * The file is read forward from a byte offset, which assumes the agent only
   * ever APPENDS. A real agent does not: measured on the first cell this
   * transport ever played, the player wrote itself a controller that kept the
   * last eight actions with `open(path, 'w')`, truncating the file on every
   * pass. The offset then sat past the end of a shorter file, every later read
   * returned nothing, and the driver was deaf for the rest of the episode while
   * the health record said 112 starved decisions — which reads as a player that
   * played badly rather than a channel that broke.
   *
   * Rewriting a queue file to hold the last few entries is an ordinary thing to
   * do, so it is HANDLED rather than forbidden: a file shorter than the offset
   * has been rewritten, and its whole contents replace what was pending. The
   * rewrite is counted, because an agent that rewrites and one that appends are
   * playing differently and a reader should be able to tell.
   */
  const drainActions = (): void => {
    let fd: number
    try {
      fd = openSync(actionPath, 'r')
    } catch {
      return
    }
    try {
      // Checked before reading, so a truncation is noticed on the pass that
      // follows it rather than never.
      const size = fstatSync(fd).size
      if (size < offset) {
        rewrites += 1
        offset = 0
        carry = ''
        // The queue goes with it. A rewrite is the agent saying THIS IS MY PLAN
        // NOW, so keeping what it wrote earlier would splice a stale intention
        // in front of a current one. That is the opposite of the reason a full
        // queue drops the newest: there the earlier action is still the agent's
        // own standing decision, here the agent has just replaced it.
        queue.length = 0
      }
      const buffer = Buffer.alloc(64 * 1024)
      for (;;) {
        const read = readSync(fd, buffer, 0, buffer.length, offset)
        if (read <= 0) break
        offset += read
        carry += buffer.subarray(0, read).toString('utf8')
        for (;;) {
          const at = carry.indexOf('\n')
          if (at < 0) break
          const line = carry.slice(0, at)
          carry = carry.slice(at + 1)
          const word = line.trim().split(/\s+/u)[0] ?? ''
          if (word === '') continue
          if (options.commands.length > 0 && !options.commands.includes(word)) {
            rejected += 1
            continue
          }
          // A full queue drops the newest rather than the oldest: the agent's
          // earlier decisions were taken with earlier information, and a game
          // that discards them would be reordering the agent's intent.
          if (queue.length >= options.queueDepth) {
            dropped += 1
            continue
          }
          queue.push(word)
          if (queue.length > peakQueue) peakQueue = queue.length
        }
      }
    } finally {
      closeSync(fd)
    }
  }

  /**
   * Read the cost the launcher republished, if it has by now.
   *
   * Written when the agent exits, so it is absent for a cell read while the
   * agent still runs. Absence is reported as absence.
   */
  function reportedMeter(): {
    costUsd: number | null
    tokens: number | null
    inputTokens: number | null
    outputTokens: number | null
    turns: number | null
    authMode: 'api-key' | 'oauth' | null
  } {
    const nonNegative = (value: unknown): number | null =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, 'agent-cost.json'), 'utf8'))
      const meter = parsed as Record<string, unknown>
      const mode = meter.authMode === 'api-key' || meter.authMode === 'oauth' ? meter.authMode : null
      return {
        costUsd: nonNegative(meter.usd),
        tokens: nonNegative(meter.tokens),
        inputTokens: nonNegative(meter.inputTokens),
        outputTokens: nonNegative(meter.outputTokens),
        turns: nonNegative(meter.turns),
        authMode: mode,
      }
    } catch {
      return { costUsd: null, tokens: null, inputTokens: null, outputTokens: null, turns: null, authMode: null }
    }
  }

  return {
    dir,
    act: async (frame, _history, context) => {
      // Hold the game's rate BEFORE the observation is written, so the agent's
      // thinking time is the gap between two observations rather than a pause
      // bolted on after it has already seen the next one.
      if (options.paceMs !== undefined && options.paceMs > 0) {
        const now = Date.now()
        if (dueAt === null) dueAt = now
        const wait = dueAt - now
        if (wait > 0) await new Promise((resume) => setTimeout(resume, wait))
        else if (dueAt < now) overrun += 1
        dueAt = Math.max(dueAt, now) + options.paceMs
      }
      // What the agent may see, built by the one function that never reads the
      // privileged channel. `frame` is that observation's text.
      const observation: Observation & { turn: number } = {
        turn: context.turn,
        text: frame,
        ...(options.vision === true && context.observation?.images !== undefined
          ? { images: context.observation.images.map((image) => ({ ...image })) }
          : {}),
      }
      const body = `${JSON.stringify(observation)}\n`
      // Numbered for a reader, plus a stable name an agent can poll without
      // having to guess how far the game has got.
      writeFileSync(join(dir, 'observations', `${String(context.turn).padStart(6, '0')}.json`), body)
      writeFileSync(join(dir, 'latest.json'), body)
      written += 1

      drainActions()
      const next = queue.shift()
      if (next === undefined) {
        starved += 1
        // The measured difference between the two games this option names.
        const input = options.whenEmpty === 'repeat-last' ? last : 'noop'
        return { input, costUsd: options.fixedCostUsd! }
      }
      consumed += 1
      last = next
      return { input: next, costUsd: options.fixedCostUsd! }
    },
    close: () => {
      const running = child
      child = null
      if (running !== null) {
        running.stdout?.removeAllListeners()
        running.stderr?.removeAllListeners()
        // Killing a child that never started throws; the `error` listener above
        // stays attached so a late failure cannot become an uncaught exception.
        try {
          if (running.pid !== undefined) running.kill('SIGKILL')
        } catch {
          // Already gone. Nothing to stop.
        }
      }
    },
    health: () => ({
      written,
      consumed,
      starved,
      dropped,
      rejected,
      peakQueue,
      overrun,
      rewrites,
      agent,
      agentDetail,
      ...reportedMeter(),
    }),
  }
}
