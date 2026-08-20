/**
 * PyBoy Tetris adapter test — the real-substrate gates (claim G1 L3, G2).
 * Skips cleanly when PLAYPROOF_ROM is unset (CI) or the Python deps are
 * missing; runs the full contract-derivation + attestation + determinism
 * battery when the environment is present (~30s, zero model spend).
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { makePyBoyTetris, pyBoyTetrisConfigured, tetrisMarks } from './adapters/pyboy-tetris'
import { validateContract } from './schema'
import { logFrom } from './runtime'
import { attestRun } from './attestation'

function pythonHasPyBoy(): boolean {
  const r = spawnSync(process.env.PLAYPROOF_PYTHON ?? 'python3', ['-c', 'import pyboy'], { encoding: 'utf8' })
  return r.status === 0
}

function romIsPinnedTetris(): boolean {
  const rom = process.env.PLAYPROOF_ROM
  if (!rom) return false
  const md5 = createHash('md5').update(readFileSync(rom)).digest('hex')
  const ref = JSON.parse(readFileSync(new URL('./pyboy/reference-tetris.json', import.meta.url), 'utf8')) as { romMd5: string }
  return md5 === ref.romMd5
}

if (!romIsPinnedTetris() || !pythonHasPyBoy()) {
  console.log('pyboy-tetris: SKIP (PLAYPROOF_ROM is not the pinned Tetris build, or python pyboy unavailable)')
} else {
  const adapter = makePyBoyTetris()
  try {
    // Authoring (G5): contract derived from the reference playthrough with
    // event-anchored marks — no hand-copied hashes, positions, or thresholds.
    const violations = validateContract(adapter.contract)
    assert.deepEqual(violations, [])
    const tiers = new Set(adapter.contract.milestones.map((m) => m.tier))
    assert.ok(tiers.has('engine-state') && tiers.has('save-file') && tiers.has('screen-frame'),
      `expected all three tiers, got ${[...tiers].join(',')}`)
    assert.equal(adapter.contract.milestones.length, tetrisMarks().length)

    // Known-good: the reference verifies every milestone.
    const all = adapter.contract.milestones.map((m) => m.id)
    const good = attestRun(adapter.game, adapter.contract, adapter.seed, logFrom(adapter.seed, [...adapter.reference]), all)
    assert.equal(good.verdict, 'clean')
    assert.deepEqual(good.verified, all)

    // False claim: partial play claiming the line clear is rejected.
    const partial = adapter.reference.slice(0, adapter.reference.length - 12)
    const falseClaim = attestRun(adapter.game, adapter.contract, adapter.seed, logFrom(adapter.seed, partial), ['line-1'])
    assert.equal(falseClaim.verdict, 'rejected')
    assert.ok(falseClaim.reasons.some((r) => r.startsWith('claimed-not-reproduced')))

    // Determinism: the save-file milestone pins the save-state hash AT the
    // line-clear mark (not at the end of the reference). Replay and confirm
    // the same instant reproduces the same hash on a fresh emulator boot.
    const saveMilestone = adapter.contract.milestones.find((m) => m.check.kind === 'save-hash')!
    const hashAtLine1 = ((): string => {
      let state = adapter.game.init(adapter.seed)
      let hash = ''
      for (const w of adapter.reference) {
        state = adapter.game.step(state, w)
        if ((adapter.game.evidence(state).engineState?.lines ?? 0) >= 1) {
          hash = adapter.game.evidence(state).saveBlobHash!
          break
        }
      }
      return hash
    })()
    assert.notEqual(hashAtLine1, '')
    assert.equal(hashAtLine1, (saveMilestone.check as { hash: string }).hash)

    console.log('pyboy-tetris: derivation, 3-tier contract, known-good, false-claim, determinism OK')
  } finally {
    adapter.dispose()
  }
}
