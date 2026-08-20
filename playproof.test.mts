/**
 * Playproof test — the calibration gate runs under the repo test runner.
 * Every gate row must pass; a red row is a framework defect, not a test nit.
 */
import { strict as assert } from 'node:assert'
import { runCalibration } from './calibrate.mts'
import { attestRun, verifyAlongReplay } from './attestation'
import { logFrom, logFrom as log } from './runtime'
import { validateContract } from './schema'
import type { MilestoneContract } from './schema'
import { engineCrawler, engineCrawlerContract, ENGINE_CRAWLER_REFERENCE } from './adapters/engine-crawler'

const rows = runCalibration()
for (const r of rows) {
  assert.ok(r.passed, `${r.game}/${r.gate} failed: ${r.detail}`)
}
// Suites are environment-gated (ROM md5, channels file); the expectation
// derives from which suites actually ran: 17 toy rows + 7 per real-game suite.
const tetrisRan = rows.some((r) => r.game === 'pyboy-tetris')
const genericRan = rows.some((r) => r.game.startsWith('pyboy-generic'))
const expectedRows = 22 + (tetrisRan ? 7 : 0) + (genericRan ? 7 : 0)
assert.ok(rows.length === expectedRows, `expected ${expectedRows} calibration rows (17 toy + 5 framework, +7 per real suite), got ${rows.length}`)

// Core doctrine: replay is the only source of truth.
{
  const contract = engineCrawlerContract()
  const seed = 0
  const good = attestRun(engineCrawler, contract, seed, logFrom(seed, [...ENGINE_CRAWLER_REFERENCE]), ['room-1', 'room-3'])
  assert.equal(good.verdict, 'clean')
  // pass-discovery order: hp-untouched holds at snapshot 0, room-1 at input 1,
  // then same-snapshot dependents in declaration order
  assert.deepEqual(good.verified, ['hp-untouched', 'room-1', 'room-2-plus', 'room-3'])

  // A short honest run claiming the final milestone must be rejected —
  // submitted/forged evidence has no path into verification at all.
  const honestShort = attestRun(engineCrawler, contract, seed, logFrom(seed, ['right']), ['room-3'])
  assert.equal(honestShort.verdict, 'rejected')
  assert.ok(honestShort.reasons.some((x) => x.startsWith('claimed-not-reproduced')))
}

// Same-snapshot dependent admission: dependent listed AFTER its prerequisite
// verifies in the same snapshot pass (the review's medium finding).
{
  const contract = engineCrawlerContract()
  const verified = verifyAlongReplay(engineCrawler, contract, 0, logFrom(0, ['right']))
  assert.ok(verified.includes('room-1'))
  assert.ok(!verified.includes('room-3'))
  const full = verifyAlongReplay(engineCrawler, contract, 0, logFrom(0, [...ENGINE_CRAWLER_REFERENCE]))
  assert.ok(full.includes('room-2-plus') && full.includes('room-3'), `same-snapshot dependents admitted: ${full.join(',')}`)
}

// Diamond DAGs validate clean (the review's false-positive finding).
{
  const diamond: MilestoneContract = {
    schemaVersion: 1,
    gameId: 'engine-crawler',
    milestones: [
      { id: 'D', tier: 'engine-state', requires: [], glitchClass: 'legal', check: { kind: 'state-path', path: 'room', op: '==', value: 0 } },
      { id: 'B', tier: 'engine-state', requires: ['D'], glitchClass: 'legal', check: { kind: 'state-path', path: 'room', op: '>=', value: 0 } },
      { id: 'C', tier: 'engine-state', requires: ['D'], glitchClass: 'legal', check: { kind: 'state-path', path: 'hp', op: '>=', value: 0 } },
      { id: 'A', tier: 'engine-state', requires: ['B', 'C'], glitchClass: 'legal', check: { kind: 'state-path', path: 'room', op: '>=', value: 0 } },
    ],
  }
  assert.deepEqual(validateContract(diamond), [])

  // True cycles still rejected.
  const cyclic: MilestoneContract = {
    schemaVersion: 1,
    gameId: 'engine-crawler',
    milestones: [
      { id: 'X', tier: 'engine-state', requires: ['Y'], glitchClass: 'legal', check: { kind: 'state-path', path: 'room', op: '>=', value: 0 } },
      { id: 'Y', tier: 'engine-state', requires: ['X'], glitchClass: 'legal', check: { kind: 'state-path', path: 'room', op: '>=', value: 0 } },
    ],
  }
  assert.ok(validateContract(cyclic).some((v) => v.includes('cycle')))

  // Out-of-order declaration rejected (topological listing enforced).
  const unordered: MilestoneContract = {
    schemaVersion: 1,
    gameId: 'engine-crawler',
    milestones: [
      { id: 'L', tier: 'engine-state', requires: ['M'], glitchClass: 'legal', check: { kind: 'state-path', path: 'room', op: '>=', value: 0 } },
      { id: 'M', tier: 'engine-state', requires: [], glitchClass: 'legal', check: { kind: 'state-path', path: 'room', op: '>=', value: 0 } },
    ],
  }
  assert.ok(validateContract(unordered).some((v) => v.includes('dependency order')))

  // Empty contracts rejected.
  assert.ok(validateContract({ schemaVersion: 1, gameId: 'g', milestones: [] }).some((v) => v.includes('no milestones')))
}

// Game/contract mismatch is a hard error, not a silent wrong-verdict.
{
  const contract = engineCrawlerContract()
  assert.throws(
    () => attestRun(engineCrawler, { ...contract, gameId: 'wrong-game' }, 0, log(0, []), []),
    /game\/contract mismatch/,
  )
}

// Ops coverage beyond the adapters' happy paths: '>' and '==' negative cases.
{
  const seed = 0
  const one = logFrom(seed, ['right']) // room 1: >2 false, ==1 for room
  const verified = verifyAlongReplay(engineCrawler, engineCrawlerContract(), seed, one)
  assert.ok(!verified.includes('room-2-plus'), `'>' milestone must not hold at room 1`)
  assert.ok(verified.includes('hp-untouched'), `'==' milestone holds while hp untouched`)
}

console.log(`playproof: ${rows.length} calibration gates green + review-fix regressions green`)
