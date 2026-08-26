/**
 * Turn a played game into a verifier a code-improvement loop can climb.
 *
 * ## Why this is a verifier and not a loop
 *
 * `improve({ surface: 'code' })` in `@tangle-network/agent-runtime` already
 * owns the loop: it forks a worktree per candidate, runs an agent for a bounded
 * number of shots, meters each shot against the exact profile, and feeds the
 * verifier's feedback into the next shot. Writing a second loop here would put
 * the two out of step and measure whichever one drifted.
 *
 * What that loop cannot know is whether a program plays a game well. That is
 * this function.
 *
 * ## Why a score is not a pass
 *
 * A test suite is binary: it passes and there is nothing left to win. A game
 * score is not. There is always a higher number, so a verifier that answers
 * only `ok` either stops a run that could still improve or never stops at all.
 * `keepGoing` and `score` say the difference: the candidate WORKS, the number
 * is this, and spending another shot is still worth it.
 *
 * ## What the agent is told
 *
 * The score it earned, the milestones it earned, and the ones it did not. It is
 * never told the contract, the reference playthrough or the evidence channel.
 * Those are the grader, and an author that reads its own grader is not being
 * measured against the game.
 */
import { attestRun } from './attestation'
import { playEpisode } from './episode'
import { createPersistentCliDriver } from './drivers/persistent-cli'
import { channel, watchEvidence } from './matrix-run'
import type { Game } from './runtime'
import type { MilestoneContract } from './schema'

export interface HillclimbTargetOptions<S> {
  /** Fresh scored instance. Built per attempt, never shared with the author. */
  build: () => { game: Game<S>; contract: MilestoneContract; commands: readonly string[]; dispose?: () => void }
  /** Path of the program inside the candidate worktree, relative to its root. */
  policyPath: string
  /** Decisions one attempt plays. */
  horizon: number
  /** Seed the attempt is scored on. */
  seed: number
  /** Evidence channel the score is read from, such as `score` or `steps`. */
  scoreField: string
  /**
   * Score at which the run has nothing left to win.
   *
   * Omit when the game has no ceiling, and the loop then stops on its own shot
   * budget rather than on a number nobody can reach.
   */
  target?: number
}

/** What one attempt did. Returned for a record; the loop reads the verdict. */
export interface HillclimbAttempt {
  ok: boolean
  keepGoing: boolean
  score: number | null
  feedback: string
  verified: readonly string[]
  unearned: readonly string[]
  decisions: number
  replayVerified: boolean
}

/**
 * Play one candidate program and report what it earned.
 *
 * A candidate that cannot start is `ok: false` with the reason, which is a
 * failure the next shot can act on. A candidate that plays and scores badly is
 * `ok: true` with a low number, which is a different thing entirely: the
 * program works and needs to get better.
 */
export async function playCandidate<S>(
  worktreePath: string,
  options: HillclimbTargetOptions<S>,
): Promise<HillclimbAttempt> {
  const built = options.build()
  // The scored channel is read from the evidence as the episode produces it,
  // which is the same path `runCell` uses. Reading it twice two ways is how two
  // numbers that should agree stop agreeing.
  const watched = watchEvidence(built.game as Game<unknown>)
  const driver = createPersistentCliDriver({
    command: `${worktreePath.replace(/\/$/u, '')}/${options.policyPath}`,
    commands: built.commands,
    output: 'first-word',
    fixedCostUsd: 0,
  })
  try {
    const played = await playEpisode(
      watched.game,
      built.contract,
      driver,
      Number.MAX_SAFE_INTEGER,
      options.horizon,
      options.seed,
      undefined,
      { stopAtGameOver: true },
    )
    const record = played.record
    // The replay is the only thing that makes the number a claim rather than a
    // report. A candidate whose log does not reproduce did not earn its score.
    const attested = attestRun(watched.game, built.contract, options.seed, played.log, record.verified)
    const series = channel(watched.snapshots, options.scoreField)
    const score = series.length === 0 ? null : series[series.length - 1]!
    const verified = record.verified
    const unearned = built.contract.milestones
      .map((milestone) => milestone.id)
      .filter((id) => !verified.includes(id))
    const reached = options.target !== undefined && score !== null && score >= options.target
    const clean = attested.verdict === 'clean'
    return {
      ok: clean,
      // A working program with room above it is worth another shot. A program
      // that reached the target is not, and neither is one whose replay failed,
      // because the next shot cannot fix a divergence it will not be told about
      // in a form it can act on.
      keepGoing: clean && !reached,
      score,
      verified,
      unearned,
      decisions: record.turns,
      replayVerified: clean,
      feedback: describe(score, options, verified, unearned, record.turns, clean),
    }
  } catch (error) {
    return {
      ok: false,
      keepGoing: true,
      score: null,
      verified: [],
      unearned: [],
      decisions: 0,
      replayVerified: false,
      feedback: `The program did not play: ${(error as Error).message}.`
        + ' It is started once and asked for many decisions over stdio.'
        + ' Each request is one JSON object per line on stdin; answer with one line whose first word is the move.'
        + ' stdin does not close between requests.',
    }
  } finally {
    driver.close()
    built.dispose?.()
  }
}

/**
 * What the author is told between shots.
 *
 * Its own result and nothing else. Naming the contract here would hand the
 * author the grader, and a program written against the grader is not a program
 * that plays the game.
 */
function describe(
  score: number | null,
  options: { scoreField: string; horizon: number; target?: number },
  verified: readonly string[],
  unearned: readonly string[],
  decisions: number,
  replayVerified: boolean,
): string {
  if (!replayVerified) {
    return 'The run did not reproduce when replayed from its own input log.'
      + ' The program answered differently to the same request twice.'
      + ' Make every decision a function of the request it was given.'
  }
  const lines = [
    `Scored ${score ?? 'nothing'} on ${options.scoreField} over ${decisions} decisions`
    + `${options.target === undefined ? '' : `, out of a target of ${options.target}`}.`,
  ]
  if (verified.length > 0) lines.push(`Reached: ${verified.join(', ')}.`)
  if (unearned.length > 0) lines.push(`Not reached: ${unearned.join(', ')}.`)
  if (decisions < options.horizon) {
    lines.push(`The episode ended after ${decisions} of ${options.horizon} decisions, so the game finished early.`)
  }
  return lines.join(' ')
}
