/**
 * Playproof episode engine test — the agent loop drives games under budget, and budget
 * exhaustion stops the episode while keeping verified partial progress.
 */
import { strict as assert } from 'node:assert'
import { playEpisode, scriptedDriver } from './episode'
import { formatMilestoneScore } from './schema'
import { engineCrawler, engineCrawlerContract, ENGINE_CRAWLER_REFERENCE } from './adapters/engine-crawler'
import { saveLevels, saveLevelsContract, SAVE_LEVELS_REFERENCE } from './adapters/save-levels'

{
  // scripted agent solves the crawler; all milestones verify
  const { record } = await playEpisode(engineCrawler, engineCrawlerContract(), scriptedDriver(ENGINE_CRAWLER_REFERENCE), 1, 12)
  assert.equal(record.verdict, 'clean')
  assert.deepEqual(record.verified, ['hp-untouched', 'room-1', 'room-2-plus', 'room-3'])
  assert.equal(record.spentUsd, 0)
  assert.deepEqual(record.score, { verified: 4, total: 4 })
  assert.equal(formatMilestoneScore(record.score), '4 of 4')
}

{
  // budget 0 stops immediately; honest partial progress, nothing faked
  const { record } = await playEpisode(engineCrawler, engineCrawlerContract(), scriptedDriver(ENGINE_CRAWLER_REFERENCE), 0, 12)
  assert.equal(record.turns, 0)
  assert.equal(record.budgetExhausted, true)
  // hp-untouched legitimately holds at snapshot 0; no input-driven milestone does
  assert.deepEqual(record.verified, ['hp-untouched'])
}

{
  // turn ceiling mid-run: keeps verified prefix, stays clean
  const { record } = await playEpisode(engineCrawler, engineCrawlerContract(), scriptedDriver(ENGINE_CRAWLER_REFERENCE), 1, 2)
  assert.equal(record.turns, 2)
  assert.deepEqual(record.verified, ['hp-untouched', 'room-1'])
  assert.deepEqual(record.score, { verified: 2, total: 4 })
}

// A run on a contract whose milestones are all hash checks scores them like
// any other points. A hash names one game state; reaching it is progress a
// reader cannot read, not progress that did not happen.
{
  const { record } = await playEpisode(saveLevels, saveLevelsContract(), scriptedDriver(SAVE_LEVELS_REFERENCE), 1, 8)
  assert.equal(record.verdict, 'clean')
  assert.deepEqual(record.verified, ['level-2-saved', 'level-2-logged'])
  // Both milestones are hashes, and both are points a run scores by reaching
  // the state they name. The denominator does not shrink because a check is
  // opaque; what shrinks is what a reader can tell about it.
  assert.deepEqual(record.score, { verified: 2, total: 2 })
  assert.equal(formatMilestoneScore(record.score), '2 of 2')
}

// A scripted driver is positioned by the harness turn, so a driver created in a
// fresh process resumes a campaign mid-script instead of restarting it.
{
  const driver = scriptedDriver(['a', 'b', 'c'])
  const context = { turn: 3, maxTurns: 10, seed: 0, spentUsd: 0, remainingBudgetUsd: 1 }
  assert.equal((await driver.act('', [], context)).input, 'c')
  assert.equal((await driver.act('', [], { ...context, turn: 4 })).input, 'noop')
  assert.equal((await driver.act('', [], { ...context, turn: 1 })).input, 'a')
}

console.log('playproof episode: loop, budget, and partial-progress semantics OK')
