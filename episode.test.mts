/**
 * Playproof episode engine test — the agent loop drives games under budget, and budget
 * exhaustion stops the episode while keeping verified partial progress.
 */
import { strict as assert } from 'node:assert'
import { playEpisode, scriptedDriver } from './episode'
import { engineCrawler, engineCrawlerContract, ENGINE_CRAWLER_REFERENCE } from './adapters/engine-crawler'

{
  // scripted agent solves the crawler; all milestones verify
  const { record } = await playEpisode(engineCrawler, engineCrawlerContract(), scriptedDriver(ENGINE_CRAWLER_REFERENCE), 1, 12)
  assert.equal(record.verdict, 'clean')
  assert.deepEqual(record.verified, ['hp-untouched', 'room-1', 'room-2-plus', 'room-3'])
  assert.equal(record.spentUsd, 0)
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
}

console.log('playproof episode: loop, budget, and partial-progress semantics OK')
