/**
 * One policy process per EPISODE, asked for many decisions over stdio.
 *
 * `createCliAgentDriver` spawns one child per decision. That is a legitimate
 * profile — a one-shot CLI is a real way to run an agent — but it is a slow one
 * and it silently forbids a policy from keeping state. This driver is the same
 * `AgentDriver` seam over a different transport, so a matrix can measure both
 * rather than baking one in.
 *
 * MEASURED, 2026-08-23, ALE Breakout at 300 decisions: per-decision spawning
 * cost 13.6 s an episode, of which 11.2 s (83%) was process startup at 37.5 ms
 * a decision, against an emulator step of 0.85 ms. One process for the whole
 * episode takes a decision to 0.97 ms, a 38x reduction on the term that
 * dominated.
 *
 * The second consequence matters more than the first. Under per-decision
 * spawning A POLICY CANNOT KEEP STATE: a program that stores anything between
 * decisions loses it, with no crash and no warning. Two programs of a study
 * that differed entirely in design produced hash-identical input logs for
 * exactly this reason, while one of them printed its tracking state three
 * hundred times to a stderr nobody read. A degraded policy that still answers
 * every decision and still attests clean is the worst failure this seam has,
 * and it is a transport artifact rather than anything the policy did.
 *
 * ## The protocol
 *
 * The request bytes are exactly what `createCliAgentDriver` writes — the same
 * `schemaVersion`, `frame`, `history`, `images` and `context` keys — one JSON
 * object per line on stdin. The answer is one line on stdout whose first word
 * is the input, which is that driver's `output: 'first-word'` byte for byte.
 * What changed is only that stdin does not end after the first request.
 *
 * A program written to wait for stdin to END before answering therefore answers
 * nothing here. That is deliberate and it is visible rather than silent: the
 * first decision times out, the session ends, and `health()` says so.
 *
 * ## The four failure modes per-decision spawning handled for free
 *
 *   HANGS        one decision may take `timeoutMs`. On expiry the session is
 *                over, because a late answer would be read as the answer to the
 *                NEXT request and the rest of the episode would be off by one.
 *   DIES         the child exiting is the session ending, whatever its code.
 *   FLOODS       stdout per decision is bounded, and so is the whole session,
 *                so a program printing in a loop cannot take the machine.
 *   NEVER READS  a child that does not drain stdin makes the write block, so
 *   STDIN        the decision hits `timeoutMs` and ends the session.
 *
 * In every one of them THE EPISODE SURVIVES. `act` throws, and a harness that
 * substitutes an unusable answer — as playproof's own episode loop does for any
 * driver error — plays the episode to its full turn count, keeps the milestones
 * earned before the session died, and grades it by the same replay attestation.
 * A dead policy produces a gradeable episode, never a lost run.
 *
 * ## Extra stdout is discarded rather than fatal
 *
 * A process boundary used to delimit a decision, so a debug line cost nothing.
 * One process for an episode has no such boundary, and "the first line after
 * the request" is ambiguous: a trailing line from the previous decision may
 * still be in the pipe. Reading it as the next answer puts the episode silently
 * off by one. Measured: a program writing three lines a decision answered 3 of
 * 20 decisions with a debug line, and a fix that waited a fixed number of
 * event-loop turns worked on one machine and not on another.
 *
 * The rule below does not depend on timing. THE ANSWER IS THE LINE THAT NAMES A
 * COMMAND THE GAME ACCEPTS; any other line is held as a fallback and the wait
 * continues. A vocabulary is declared by the game, so a naming line can only be
 * an answer, whenever it arrives.
 *
 * Env knobs:
 *   PLAYPROOF_DECISION_TIMEOUT_MS  wall clock one decision may take (default 10000)
 *   PLAYPROOF_DECISION_BYTES       stdout bytes one decision may produce (default 65536)
 *   PLAYPROOF_SESSION_BYTES        stdout+stderr bytes one session may produce (default 8388608)
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { AgentDecisionContext, AgentDriver, AgentHistoryEntry } from '../episode'
import type { ObservationImage } from '../runtime'

const DECISION_TIMEOUT_MS = Number(process.env.PLAYPROOF_DECISION_TIMEOUT_MS ?? 10_000)
const DECISION_BYTES = Number(process.env.PLAYPROOF_DECISION_BYTES ?? 64 * 1024)
const SESSION_BYTES = Number(process.env.PLAYPROOF_SESSION_BYTES ?? 8 * 1024 * 1024)

/** Why a session stopped answering. `closed` is the caller ending a healthy one. */
export type SessionEndReason = 'exited' | 'timeout' | 'flooded' | 'failed' | 'closed'

/**
 * The ways a session ends BADLY.
 *
 * `closed` is not among them, so a reader of `endReason` never has to ask which
 * value means "nothing went wrong". The type says it instead of a comment.
 */
export type SessionFailure = Exclude<SessionEndReason, 'closed'>

/** What one session did, for an operator. None of it grades anything. */
export interface SessionHealth {
  /** Decisions the program answered. */
  answered: number
  /** Decisions refused because the session was already over. */
  lost: number
  /** The decision the session died ON, or null while it lived to the end. */
  endedAtDecision: number | null
  /** How it died, or null when nothing went wrong. */
  endReason: SessionFailure | null
  /** One sentence naming what happened, or null. */
  detail: string | null
  /** Extra stdout lines dropped between answers. */
  discardedLines: number
  /** Wall clock the program spent answering, summed over decisions. */
  answerMs: number
}

/** A driver whose child outlives one decision, so the caller must close it. */
export interface PersistentAgentDriver extends AgentDriver {
  /** Idempotent. Call it in a `finally`, so no episode leaves a child behind. */
  close(): void
  health(): SessionHealth
}

export interface PersistentCliDriverOptions {
  command: string
  args?: readonly string[]
  cwd?: string
  env?: Readonly<Record<string, string>>
  /** Input words the game accepts. This is what separates an answer from chatter. */
  commands?: readonly string[]
  /** Wall clock one decision may take. */
  timeoutMs?: number
  /** Bytes of stdout one decision may produce. */
  maxOutputBytes?: number
  /** Bytes of stdout and stderr the whole session may produce. */
  maxSessionBytes?: number
  /** Put the observation's images in the request. Off by default. */
  vision?: boolean
  /**
   * How an answer line is read.
   *
   * `first-word` is a bare word, which is what a local control writes.
   * `json` expects `{input, costUsd?}`, which is how a metered agent reports
   * what its decision cost. Both match `createCliAgentDriver`'s options of the
   * same name, so ONE program runs unchanged under either transport — without
   * that, the transport axis would be confounded with the wire format.
   */
  output?: 'json' | 'first-word'
  /** Explicitly 0 only for genuinely free execution. */
  fixedCostUsd?: number
  /** Derive a per-decision cost from what the child wrote. */
  costUsd?: (line: string) => number
}

/** The request one decision is sent, in the shape `createCliAgentDriver` writes. */
interface PersistentRequest {
  schemaVersion: 1
  frame: string
  history: readonly AgentHistoryEntry[]
  images?: readonly ObservationImage[]
  context: Readonly<Omit<AgentDecisionContext, 'signal' | 'observation'>>
}

/** The word a line names, or the fallback no game accepts. */
function inputFrom(line: string, commands: readonly string[]): string {
  const word = line.trim().split(/\s+/u)[0] ?? ''
  if (word === '' || /[\0\r]/u.test(word)) return 'noop'
  if (commands.length > 0 && !commands.includes(word)) return 'noop'
  return word
}

/** One decision waiting on the child's next line. */
interface Pending {
  resolve(line: string): void
  reject(error: Error): void
  timer: NodeJS.Timeout
  /**
   * The first line this decision saw that named no command.
   *
   * Held rather than dropped, so a program answering a word the game refuses is
   * still ANSWERING — which a floor must tell apart from a program gone silent.
   */
  candidate: string | null
}

export function createPersistentCliDriver(options: PersistentCliDriverOptions): PersistentAgentDriver {
  if (!options.command.trim() || options.command.includes('\0')) throw new Error('CLI command is invalid')
  for (const arg of options.args ?? []) {
    if (arg.includes('\0')) throw new Error('CLI argument contains NUL')
  }
  if (options.fixedCostUsd !== undefined && (!Number.isFinite(options.fixedCostUsd) || options.fixedCostUsd < 0)) {
    throw new Error('persistent CLI fixedCostUsd must be non-negative')
  }
  if ((options.output ?? 'first-word') === 'first-word'
    && options.fixedCostUsd === undefined
    && options.costUsd === undefined) {
    throw new Error('persistent CLI first-word output requires costUsd or fixedCostUsd')
  }
  const commands = options.commands ?? []
  const outputMode = options.output ?? 'first-word'
  const timeoutMs = options.timeoutMs ?? DECISION_TIMEOUT_MS
  const maxOutputBytes = options.maxOutputBytes ?? DECISION_BYTES
  const maxSessionBytes = options.maxSessionBytes ?? SESSION_BYTES

  let child: ChildProcessWithoutNullStreams | null = null
  let pending: Pending | null = null
  let stdout = ''
  let sessionBytes = 0
  let answered = 0
  let lost = 0
  let answerMs = 0
  let discardedLines = 0
  /** True once a decision was answered by a line naming no command. */
  let outsideVocabulary = false
  let atTurn = 0
  let awaiting = false
  let endedAtDecision: number | null = null
  let endReason: SessionEndReason | null = null
  let detail: string | null = null

  /**
   * End the session once, and answer whatever decision was waiting.
   *
   * Idempotent: `exit` and `error` both fire on a kill, and the first reason is
   * the cause while the rest are consequences of it.
   */
  const end = (reason: SessionEndReason, why: string): void => {
    if (endReason === null) {
      endReason = reason
      detail = why
      // A session that dies WHILE a decision waits cost that decision; one that
      // dies between decisions costs the next. A program that answers every
      // decision and then exits has cost nothing.
      endedAtDecision = reason === 'closed' ? null : awaiting ? atTurn : atTurn + 1
    }
    const waiting = pending
    pending = null
    if (waiting !== null) {
      clearTimeout(waiting.timer)
      waiting.reject(new Error(why))
    }
    const running = child
    child = null
    if (running !== null) {
      // Drop the DATA listeners and keep an error listener on every pipe.
      //
      // `removeAllListeners()` took the `error` handler with it, and the kill
      // below makes a write to stdin fail. An in-flight write then completed
      // with EPIPE on a socket that no longer had a listener, which Node turns
      // into an unhandled `error` event and a dead process.
      //
      // MEASURED: three separate long studies died this way, each losing every
      // finished cell, with a stack carrying no frame from this repository.
      // The session's other three crashes were the same shape — an error path
      // with nothing listening on it.
      for (const pipe of [running.stdout, running.stderr, running.stdin]) {
        pipe?.removeAllListeners('data')
        pipe?.removeAllListeners('error')
        pipe?.on('error', () => {
          // A pipe to a process being killed is expected to fail. The session's
          // outcome is already recorded by `end()`; this listener exists so the
          // failure cannot escape as an unhandled event.
        })
      }
      running.kill('SIGKILL')
    }
  }

  const takeLine = (): string | null => {
    const at = stdout.indexOf('\n')
    if (at < 0) return null
    const line = stdout.slice(0, at)
    stdout = stdout.slice(at + 1)
    return line
  }

  /**
   * Does this line name a command the game accepts?
   *
   * This separates an ANSWER from CHATTER deterministically rather than by a
   * race. A line naming a declared word can only be an answer; a line naming
   * anything else is either an answer the game refuses or a debug line, and
   * both produce the same substituted input, so they are indistinguishable by
   * construction rather than by luck.
   */
  const answerable = (line: string): boolean => {
    if (outputMode === 'json') {
      // A JSON answer names itself: any line that parses to an object carrying
      // a string `input` is an answer, and any line that does not is chatter.
      try {
        const value: unknown = JSON.parse(line.trim())
        return typeof value === 'object' && value !== null && typeof (value as { input?: unknown }).input === 'string'
      } catch {
        return false
      }
    }
    if (commands.length === 0) return true
    const word = line.trim().split(/\s+/u)[0] ?? ''
    return commands.includes(word)
  }

  const resolveWith = (waiting: Pending, line: string): void => {
    pending = null
    clearTimeout(waiting.timer)
    waiting.resolve(line)
  }

  /**
   * Answer with the held fallback once the program's burst has been read.
   *
   * Reached only after the session has already been shown to answer outside the
   * vocabulary, where every candidate maps to the same substituted input, so
   * how long this waits cannot change an episode. It bounds wall clock; it is
   * not a decision rule.
   */
  const fallBackAfterTheBurst = (waiting: Pending): void => {
    let turns = 2
    const step = (): void => {
      turns -= 1
      if (turns > 0) {
        setImmediate(step)
        return
      }
      if (pending !== waiting || waiting.candidate === null) return
      resolveWith(waiting, waiting.candidate)
    }
    setImmediate(step)
  }

  const drain = (): void => {
    for (;;) {
      const line = takeLine()
      if (line === null) return
      const waiting = pending
      if (waiting === null) {
        discardedLines += 1
        continue
      }
      if (answerable(line)) {
        resolveWith(waiting, line)
        continue
      }
      if (waiting.candidate === null) {
        waiting.candidate = line
        if (outsideVocabulary) fallBackAfterTheBurst(waiting)
        continue
      }
      discardedLines += 1
    }
  }

  /**
   * The decision timer fired. Answer from the fallback, or end the session.
   *
   * A program that wrote something the game refuses is answering badly; one
   * that wrote nothing has gone silent. Only the second is a dead session. A
   * program of the first kind pays this timeout ONCE, because from the first
   * fallback the session knows its shape.
   */
  const decisionExpired = (waiting: Pending): void => {
    if (pending !== waiting) return
    if (waiting.candidate === null) {
      end('timeout', `the policy did not answer within ${timeoutMs}ms`)
      return
    }
    outsideVocabulary = true
    resolveWith(waiting, waiting.candidate)
  }

  const start = (): void => {
    try {
      child = spawn(options.command, [...(options.args ?? [])], {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        env: { ...process.env, ...(options.env ?? {}) },
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      end('failed', `the policy could not be started: ${String(error)}`)
      return
    }
    const started = child
    started.stdout.setEncoding('utf8')
    started.stderr.setEncoding('utf8')
    started.stdout.on('data', (chunk: string) => {
      sessionBytes += Buffer.byteLength(chunk, 'utf8')
      stdout += chunk
      if (stdout.length > maxOutputBytes) {
        end('flooded', `the policy wrote more than ${maxOutputBytes} bytes for one decision`)
        return
      }
      if (sessionBytes > maxSessionBytes) {
        end('flooded', `the policy wrote more than ${maxSessionBytes} bytes in one episode`)
        return
      }
      drain()
    })
    started.stderr.on('data', (chunk: string) => {
      sessionBytes += Buffer.byteLength(chunk, 'utf8')
      if (sessionBytes > maxSessionBytes) {
        end('flooded', `the policy wrote more than ${maxSessionBytes} bytes in one episode`)
      }
    })
    started.once('error', (error) => end('failed', `the policy could not be started: ${error.message}`))
    started.once('exit', (code, signal) => end('exited', `the policy exited (${code ?? signal ?? 'unknown'})`))
    started.stdin.on('error', (error: Error) => end('failed', `the policy stopped reading its input: ${error.message}`))
  }

  return {
    act: async (frame, history, context) => {
      atTurn = context.turn
      if (child === null && endReason === null) start()
      if (endReason !== null || child === null) {
        lost += 1
        throw new Error(detail ?? 'the policy session is over')
      }
      const images = options.vision === true ? (context.observation?.images ?? []) : []
      const request: PersistentRequest = {
        schemaVersion: 1,
        frame,
        history: history.map((entry) => ({ ...entry })),
        ...(images.length === 0 ? {} : { images: images.map((image) => ({ ...image })) }),
        context: {
          turn: context.turn,
          maxTurns: context.maxTurns,
          seed: context.seed,
          spentUsd: context.spentUsd,
          remainingBudgetUsd: context.remainingBudgetUsd,
          ...(context.guidance === undefined ? {} : { guidance: context.guidance }),
        },
      }

      const started = Date.now()
      awaiting = true
      try {
        const line = await new Promise<string>((resolve, reject) => {
          const waiting: Pending = {
            resolve,
            reject,
            candidate: null,
            timer: setTimeout(() => decisionExpired(waiting), timeoutMs),
          }
          pending = waiting
          const abort = (): void => end('failed', 'the episode was aborted')
          context.signal?.addEventListener('abort', abort, { once: true })
          // Any complete line already in the buffer belongs to this decision.
          drain()
          if (pending !== waiting) return
          child?.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
            if (error) end('failed', `the policy stopped reading its input: ${error.message}`)
          })
        })
        answered += 1
        answerMs += Date.now() - started
        if (outputMode === 'json') {
          let value: unknown
          try {
            value = JSON.parse(line.trim())
          } catch (error) {
            throw new Error(`persistent CLI returned invalid JSON: ${(error as Error).message}`)
          }
          if (typeof value !== 'object' || value === null || typeof (value as { input?: unknown }).input !== 'string') {
            throw new Error('persistent CLI JSON must contain a string input')
          }
          const reported = (value as { costUsd?: unknown }).costUsd
          const costUsd = options.costUsd?.(line)
            ?? (reported === undefined ? options.fixedCostUsd : Number(reported))
          // Cost is never invented. An agent that does not report what it spent
          // fails the decision rather than banking a zero nobody measured.
          if (costUsd === undefined || !Number.isFinite(costUsd) || costUsd < 0) {
            throw new Error('persistent CLI cost is unavailable; report costUsd or configure explicit pricing')
          }
          return { input: inputFrom(String((value as { input: string }).input), commands), costUsd }
        }
        const costUsd = options.costUsd?.(line) ?? options.fixedCostUsd
        if (costUsd === undefined || !Number.isFinite(costUsd) || costUsd < 0) {
          throw new Error('persistent CLI returned an invalid costUsd')
        }
        return { input: inputFrom(line, commands), costUsd }
      } finally {
        awaiting = false
      }
    },
    close: () => end('closed', 'the caller closed the session'),
    health: () => ({
      answered,
      lost,
      endedAtDecision,
      endReason: endReason === 'closed' || endReason === null ? null : endReason,
      detail: endReason === 'closed' ? null : detail,
      discardedLines,
      answerMs,
    }),
  }
}
