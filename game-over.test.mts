/**
 * Game-over stop gates — an episode may end because the GAME ended, and the
 * record it produces is a complete one.
 *
 * The measurement that motivated the stop: on `ale-breakout` at 300 turns, a
 * consumer counted 163 of 300 decisions (54.3%) taken after lives reached 0
 * with the engine's own `terminal` flag set. The ALE worker breaks out of its
 * action-repeat loop once that flag holds, so those inputs never reached the
 * emulator; the episode still reported 300 of 300 answered.
 *
 * Every gate here is deterministic and offline. `screen-puzzle` is a shipped
 * adapter whose far gate is a real terminal state; the two local fixtures cover
 * the ends of the range no shipped adapter reaches in one input.
 */
import { strict as assert } from 'node:assert'
import { deriveContract } from './authoring'
import { verifyRunArtifact } from './attestation'
import { runCampaign, type CampaignLedger } from './campaign'
import { playEpisode, scriptedDriver, type EpisodeRecord } from './episode'
import { engineCrawler, engineCrawlerContract, ENGINE_CRAWLER_REFERENCE } from './adapters/engine-crawler'
import { screenPuzzle, screenPuzzleContract, SCREEN_PUZZLE_REFERENCE, PUZZLE_WIDTH } from './adapters/screen-puzzle'
import { contractHash, type MilestoneContract } from './schema'
import type { Game, InputLog } from './runtime'

const puzzle = screenPuzzleContract()
/** Reaching the gate takes every reference input; `noop` after that. */
const GATE_TURN = SCREEN_PUZZLE_REFERENCE.length
const drive = () => scriptedDriver([...SCREEN_PUZZLE_REFERENCE])

/** Replay the log against a fresh verifier, the way an artifact is checked. */
function replayVerifies<S>(game: Game<S>, contract: MilestoneContract, seed: number, record: EpisodeRecord, log: InputLog): void {
  const verdict = verifyRunArtifact(game, contract, {
    gameId: game.id,
    contractHash: contractHash(contract),
    seed,
    inputs: [...log.inputs()],
    claimed: [...record.verified],
  })
  assert.equal(verdict.verdict, 'clean', `replay rejected the record: ${verdict.reasons.join(', ')}`)
  assert.deepEqual(verdict.recomputed, record.verified)
  assert.equal(record.verdict, 'clean')
  assert.equal(record.replayDivergence, false)
}

// ---------------------------------------------------------------------------
// The pathology, reproduced offline: without the stop, an episode keeps paying
// for decisions after the game has ended, and the extra decisions buy nothing.
{
  const long = await playEpisode(screenPuzzle, puzzle, drive(), 1, 20)
  assert.equal(long.record.turns, 20)
  assert.equal(long.record.stoppedBy, 'maxTurns')
  assert.equal(long.record.gameOver, true, 'the puzzle was over long before turn 20')

  const stopped = await playEpisode(screenPuzzle, puzzle, drive(), 1, 20, 0, undefined, { stopAtGameOver: true })
  assert.equal(stopped.record.turns, GATE_TURN)
  assert.equal(stopped.record.stoppedBy, 'gameOver')
  assert.equal(stopped.record.gameOver, true)
  // 12 of 20 decisions were played past the end, and dropping them costs no
  // progress: the shorter run verifies exactly the same milestones.
  assert.equal(long.record.turns - stopped.record.turns, 12)
  assert.deepEqual(stopped.record.verified, long.record.verified)
  assert.deepEqual(stopped.record.score, long.record.score)

  // The attestation survives the early stop and is checked the same way.
  replayVerifies(screenPuzzle, puzzle, 0, stopped.record, stopped.log)
  replayVerifies(screenPuzzle, puzzle, 0, long.record, long.log)
}

// ---------------------------------------------------------------------------
// The three stop reasons are recorded and distinct, on one game and one driver.
{
  const limit = await playEpisode(screenPuzzle, puzzle, drive(), 1, 3, 0, undefined, { stopAtGameOver: true })
  const budget = await playEpisode(screenPuzzle, puzzle, drive(), 0, 20, 0, undefined, { stopAtGameOver: true })
  const ended = await playEpisode(screenPuzzle, puzzle, drive(), 1, 20, 0, undefined, { stopAtGameOver: true })

  assert.equal(limit.record.stoppedBy, 'maxTurns')
  assert.equal(budget.record.stoppedBy, 'budget')
  assert.equal(ended.record.stoppedBy, 'gameOver')
  assert.equal(new Set([limit.record.stoppedBy, budget.record.stoppedBy, ended.record.stoppedBy]).size, 3)

  // A limit still ends a run while the game-over stop is armed.
  assert.equal(limit.record.turns, 3)
  assert.equal(limit.record.gameOver, false)
  assert.equal(budget.record.turns, 0)
  assert.equal(budget.record.budgetExhausted, true)
}

// ---------------------------------------------------------------------------
// COMPATIBILITY GATE. An adapter that implements no `over()` behaves exactly as
// it does today, whether or not the caller arms the stop.
{
  assert.equal(engineCrawler.over, undefined, 'this gate is only meaningful while the crawler declares no terminal state')
  const contract = engineCrawlerContract()
  const script = () => scriptedDriver([...ENGINE_CRAWLER_REFERENCE])
  const today = await playEpisode(engineCrawler, contract, script(), 1, 12)
  const armed = await playEpisode(engineCrawler, contract, script(), 1, 12, 0, undefined, { stopAtGameOver: true })

  // `ms` is wall time; everything a reader grades is identical.
  const { ms: _today, ...todayFields } = today.record
  const { ms: _armed, ...armedFields } = armed.record
  assert.deepEqual(armedFields, todayFields)
  assert.deepEqual([...armed.log.inputs()], [...today.log.inputs()])
  assert.equal(armed.record.turns, 12)
  assert.equal(armed.record.stoppedBy, 'maxTurns')
  // Null, not false: the game states no terminal condition, which is a
  // different fact from stating that it is still playable.
  assert.equal(armed.record.gameOver, null)
  assert.equal(today.record.gameOver, null)
}

// ---------------------------------------------------------------------------
// Game over on the LAST allowed decision. The game ended and the turn limit was
// reached at the same instant; the record names the game, because a finished
// game had no further turn to give whatever the limit said.
{
  const armed = await playEpisode(screenPuzzle, puzzle, drive(), 1, GATE_TURN, 0, undefined, { stopAtGameOver: true })
  const bare = await playEpisode(screenPuzzle, puzzle, drive(), 1, GATE_TURN)
  assert.equal(armed.record.turns, GATE_TURN)
  assert.equal(bare.record.turns, GATE_TURN)
  assert.equal(armed.record.stoppedBy, 'gameOver')
  assert.equal(bare.record.stoppedBy, 'maxTurns')
  assert.equal(armed.record.gameOver, true)
  assert.equal(bare.record.gameOver, true)
  // Same inputs, same progression, same attestation: only the stated reason
  // differs, so a reader can tell the two modes apart at equal length.
  assert.deepEqual([...armed.log.inputs()], [...bare.log.inputs()])
  assert.deepEqual(armed.record.verified, bare.record.verified)
  replayVerifies(screenPuzzle, puzzle, 0, armed.record, armed.log)
}

// ---------------------------------------------------------------------------
// Game over on the FIRST decision, and before it.
interface SprintState {
  steps: number
}

/** One input finishes it — the shortest playable episode. */
const sprint: Game<SprintState> = {
  id: 'game-over-sprint',
  init: () => ({ steps: 0 }),
  step: (s) => ({ steps: s.steps + 1 }),
  frame: (s) => `steps ${s.steps}`,
  evidence: (s) => ({ engineState: { steps: s.steps } }),
  over: (s) => s.steps >= 1,
}
const sprintContract = deriveContract(sprint, 0, ['go'], [
  {
    afterInputs: 1,
    id: 'moved',
    tier: 'engine-state',
    glitchClass: 'legal',
    sample: () => ({ kind: 'state-path', path: 'steps', op: '>=', value: 1 }),
  },
])

{
  const { record, log } = await playEpisode(sprint, sprintContract, scriptedDriver(['go']), 1, 10, 0, undefined, { stopAtGameOver: true })
  assert.equal(record.turns, 1)
  assert.equal(record.stoppedBy, 'gameOver')
  assert.equal(record.gameOver, true)
  assert.deepEqual(record.verified, ['moved'])
  replayVerifies(sprint, sprintContract, 0, record, log)
}

/** Already finished at `init`, so the episode never takes a decision. */
const spent: Game<SprintState> = { ...sprint, id: 'game-over-at-init', over: () => true }
const spentContract = deriveContract(spent, 0, ['go'], [
  {
    afterInputs: 0,
    id: 'booted',
    tier: 'engine-state',
    glitchClass: 'legal',
    sample: () => ({ kind: 'state-path', path: 'steps', op: '>=', value: 0 }),
  },
])

{
  const { record, log } = await playEpisode(spent, spentContract, scriptedDriver(['go']), 1, 10, 0, undefined, { stopAtGameOver: true })
  assert.equal(record.turns, 0)
  assert.equal(record.stoppedBy, 'gameOver')
  assert.equal(record.gameOver, true)
  assert.equal(record.spentUsd, 0)
  assert.equal(log.inputs().length, 0)
  // A zero-decision run is still a complete, replay-checked record.
  assert.deepEqual(record.verified, ['booted'])
  replayVerifies(spent, spentContract, 0, record, log)
}

// ---------------------------------------------------------------------------
// An `over()` that does not answer with a boolean is an adapter bug, named as
// one rather than silently read as false.
{
  const broken = { ...sprint, id: 'game-over-broken', over: (() => 1) as unknown as (s: SprintState) => boolean }
  await assert.rejects(
    playEpisode(broken, { ...sprintContract, gameId: 'game-over-broken' }, scriptedDriver(['go']), 1, 4, 0, undefined, { stopAtGameOver: true }),
    /game-over-broken over\(\) returned number, expected a boolean/u,
  )
}

// ---------------------------------------------------------------------------
// A campaign ends on the same signal, and its ledger says so.
{
  const saved: CampaignLedger[] = []
  const { record, ledger } = await runCampaign(screenPuzzle, puzzle, drive(), {
    budgetUsd: 1,
    maxTurns: 20,
    segmentTurns: 3,
    stopAtGameOver: true,
    onLedger: (next) => { saved.push(structuredClone(next)) },
  })
  assert.equal(record.turns, GATE_TURN)
  assert.equal(record.stoppedBy, 'gameOver')
  assert.equal(ledger.inputs.length, GATE_TURN)
  assert.equal(ledger.segments.at(-1)?.stoppedBy, 'gameOver')
  assert.equal(saved.length > 0, true)

  // Resuming a finished campaign plays nothing and records no empty segment.
  const segmentsBefore = ledger.segments.length
  const resumed = await runCampaign(screenPuzzle, puzzle, drive(), {
    budgetUsd: 1,
    maxTurns: 20,
    segmentTurns: 3,
    stopAtGameOver: true,
    ledger,
  })
  assert.equal(resumed.record.turns, GATE_TURN)
  assert.equal(resumed.record.stoppedBy, 'gameOver')
  assert.equal(resumed.ledger.segments.length, segmentsBefore)
  assert.deepEqual(resumed.ledger.inputs, ledger.inputs)

  // The same campaign without the stop keeps playing to the turn limit.
  const full = await runCampaign(screenPuzzle, puzzle, drive(), {
    budgetUsd: 1,
    maxTurns: 20,
    segmentTurns: 3,
  })
  assert.equal(full.record.turns, 20)
  assert.equal(full.record.stoppedBy, 'maxTurns')
  assert.equal(full.record.gameOver, true)
  assert.deepEqual(full.record.verified, record.verified)
}

console.log(`playproof game-over stop: ${PUZZLE_WIDTH - 1} moves to the gate, three distinct stop reasons, compatibility and replay OK`)
