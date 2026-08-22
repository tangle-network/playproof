/**
 * Playproof campaign test — a run played in segments across process
 * boundaries must be the same verifiable run as one continuous episode.
 *
 * The game is the deterministic native-process 2048 adapter, so every
 * assertion here holds against a real out-of-process execution model.
 */
import { strict as assert } from 'node:assert'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadLedger,
  runCampaign,
  saveLedger,
  type Analysis,
  type CampaignLedger,
  type SegmentReport,
  type Steering,
} from './campaign'
import { playEpisode, type AgentDriver } from './episode'
import { makeNative2048, NATIVE_2048_REFERENCE } from './adapters/native-2048'

const SEED = 0
const BUDGET = 1
const MAX_TURNS = 12
const SEGMENT_TURNS = 4
const COST_PER_TURN = 0.002
const SCRIPT = [...NATIVE_2048_REFERENCE]

/**
 * A driver a resumed process can reproduce: the input depends on the turn
 * index, never on the driver object's own history. Anything that keeps hidden
 * state cannot survive a process boundary, whatever the harness does.
 */
function turnScriptedDriver(
  observe?: (turn: number, guidance: string | undefined) => void,
): AgentDriver {
  return {
    act: async (_frame, _history, context) => {
      observe?.(context.turn, context.guidance)
      return { input: SCRIPT[context.turn - 1] ?? 'noop', costUsd: COST_PER_TURN }
    },
  }
}

const adapter = makeNative2048(SEED)
const { game, contract } = adapter
const workspace = await mkdtemp(join(tmpdir(), 'playproof-campaign-'))

try {
  // The hard invariant: K segments with a save/load boundary between each are
  // the same run as one continuous episode.
  {
    const continuous = await playEpisode(game, contract, turnScriptedDriver(), BUDGET, MAX_TURNS, SEED)
    const path = join(workspace, 'invariant.json')
    let ledger: CampaignLedger | undefined
    let segments = 0
    let result = null as Awaited<ReturnType<typeof runCampaign>> | null
    while (result === null || result.record.turns < MAX_TURNS) {
      result = await runCampaign(game, contract, turnScriptedDriver(), {
        budgetUsd: BUDGET,
        maxTurns: MAX_TURNS,
        segmentTurns: SEGMENT_TURNS,
        seed: SEED,
        ...(ledger === undefined ? {} : { ledger }),
        // One segment per process: stop, persist, and let the next call resume.
        steer: async () => ({ stop: true, source: 'process-boundary' }),
        onLedger: async (current) => { await saveLedger(path, current) },
      })
      segments += 1
      assert.ok(segments <= MAX_TURNS, 'campaign made no progress')
      ledger = await loadLedger(path)
    }

    assert.equal(segments, MAX_TURNS / SEGMENT_TURNS)
    assert.equal(result.log.head(), continuous.log.head())
    assert.deepEqual(result.record.verified, continuous.record.verified)
    assert.equal(result.record.spentUsd, continuous.record.spentUsd)
    assert.equal(result.record.turns, continuous.record.turns)
    assert.equal(result.record.replayDivergence, false)
    assert.equal(result.record.verdict, 'clean')
    assert.deepEqual(result.record.milestones, continuous.record.milestones)
    assert.deepEqual(result.ledger.inputs, [...continuous.log.inputs()])
    assert.deepEqual(
      result.ledger.segments.map((segment) => segment.stoppedBy),
      ['steering', 'steering', 'maxTurns'],
    )
    assert.equal(result.ledger.spentUsd, continuous.record.spentUsd)

    // The persisted ledger is the complete run, not the last segment.
    const saved = await loadLedger(path)
    assert.deepEqual(saved.inputs, [...continuous.log.inputs()])
    assert.deepEqual(saved.verified, continuous.record.verified)
    assert.equal(saved.decisions.length, MAX_TURNS)
    assert.equal(saved.decisions.at(-1)?.segment, 2)
  }

  // Guidance: explicit steering wins, the analyst's note is the fallback, and
  // both are recorded in the ledger.
  {
    const seen = new Map<number, string | undefined>()
    const { ledger } = await runCampaign(game, contract, turnScriptedDriver((turn, guidance) => {
      seen.set(turn, guidance)
    }), {
      budgetUsd: BUDGET,
      maxTurns: 8,
      segmentTurns: 2,
      seed: SEED,
      analyst: async (report: SegmentReport): Promise<Analysis> => ({
        summary: `segment ${report.segment}: ${report.verifiedSoFar.length} verified`,
        recommendation: 'steer',
        guidance: `analyst note ${report.segment}`,
        progressScore: report.verifiedSoFar.length,
      }),
      steer: async (report: SegmentReport): Promise<Steering | null> => (
        report.segment === 0
          ? { guidance: 'human override', source: 'operator', note: 'work the left wall' }
          : null
      ),
    })

    assert.equal(seen.get(1), undefined)
    assert.equal(seen.get(2), undefined)
    assert.equal(seen.get(3), 'human override')
    assert.equal(seen.get(4), 'human override')
    assert.equal(seen.get(5), 'analyst note 1')
    assert.equal(seen.get(7), 'analyst note 2')

    assert.equal(ledger.segments.length, 4)
    assert.equal(ledger.segments[0]?.guidance, null)
    assert.equal(ledger.segments[1]?.guidance, 'human override')
    assert.equal(ledger.segments[2]?.guidance, 'analyst note 1')
    assert.equal(ledger.steering.length, 1)
    assert.deepEqual(ledger.steering[0], {
      afterSegment: 0,
      source: 'operator',
      guidance: 'human override',
      note: 'work the left wall',
    })
    assert.equal(ledger.analyses.length, 4)
    assert.equal(ledger.analyses[0]?.recommendation, 'steer')
    assert.equal(ledger.analyses[0]?.guidance, 'analyst note 0')
    assert.equal(ledger.analyses[0]?.progressScore, 1)
  }

  // A segment report carries the evidence an analyst needs and nothing else.
  {
    const reports: SegmentReport[] = []
    await runCampaign(game, contract, turnScriptedDriver(), {
      budgetUsd: BUDGET,
      maxTurns: 4,
      segmentTurns: 2,
      seed: SEED,
      analyst: async (report) => {
        reports.push(report)
        return null
      },
    })
    assert.equal(reports.length, 2)
    const first = reports[0]!
    assert.equal(first.segment, 0)
    assert.equal(first.turnsSoFar, 2)
    assert.equal(first.spentUsd, 2 * COST_PER_TURN)
    assert.equal(first.remainingBudgetUsd, BUDGET - 2 * COST_PER_TURN)
    assert.equal(first.latencyMs.length, 2)
    assert.ok(first.recentHistory.length <= 8)
    assert.ok(first.lastFrame.length > 0)
    assert.ok(first.verifiedSoFar.includes('first-legal-move'))
    // Mid-run progress carries its denominator, so an analyst never has to
    // guess how many points the contract holds.
    assert.equal(first.scoreSoFar.verified, first.verifiedSoFar.length)
    assert.equal(first.scoreSoFar.total, contract.milestones.length)
    assert.equal(first.ledger.decisions.length, 2)
  }

  // Both stop paths end the run and name the right reason.
  {
    const steered = await runCampaign(game, contract, turnScriptedDriver(), {
      budgetUsd: BUDGET,
      maxTurns: MAX_TURNS,
      segmentTurns: 2,
      seed: SEED,
      analyst: async () => ({ summary: 'still climbing', recommendation: 'continue' }),
      steer: async () => ({ stop: true, source: 'operator', note: 'pausing the study' }),
    })
    assert.equal(steered.record.turns, 2)
    assert.equal(steered.ledger.segments.at(-1)?.stoppedBy, 'steering')
    assert.equal(steered.ledger.steering.at(-1)?.stop, true)

    const halted = await runCampaign(game, contract, turnScriptedDriver(), {
      budgetUsd: BUDGET,
      maxTurns: MAX_TURNS,
      segmentTurns: 2,
      seed: SEED,
      analyst: async () => ({ summary: 'no progress in this segment', recommendation: 'stop' }),
    })
    assert.equal(halted.record.turns, 2)
    assert.equal(halted.ledger.segments.at(-1)?.stoppedBy, 'analyst')
    assert.equal(halted.record.verdict, 'clean')
  }

  // An abort persists the decisions already taken, and the run resumes.
  {
    const controller = new AbortController()
    const path = join(workspace, 'aborted.json')
    const driver: AgentDriver = {
      act: async (_frame, _history, context) => {
        if (context.turn === 3) controller.abort()
        return { input: SCRIPT[context.turn - 1] ?? 'noop', costUsd: COST_PER_TURN }
      },
    }
    await assert.rejects(runCampaign(game, contract, driver, {
      budgetUsd: BUDGET,
      maxTurns: MAX_TURNS,
      segmentTurns: SEGMENT_TURNS,
      seed: SEED,
      signal: controller.signal,
      onLedger: async (current) => { await saveLedger(path, current) },
    }))
    const aborted = await loadLedger(path)
    assert.equal(aborted.decisions.length, 2)
    assert.equal(aborted.segments.at(-1)?.stoppedBy, 'abort')

    const resumed = await runCampaign(game, contract, turnScriptedDriver(), {
      budgetUsd: BUDGET,
      maxTurns: MAX_TURNS,
      segmentTurns: SEGMENT_TURNS,
      seed: SEED,
      ledger: aborted,
    })
    assert.equal(resumed.record.turns, MAX_TURNS)
    assert.equal(resumed.record.replayDivergence, false)
  }

  // A doctored ledger never resumes silently.
  {
    const path = join(workspace, 'tamper.json')
    const base = await runCampaign(game, contract, turnScriptedDriver(), {
      budgetUsd: BUDGET,
      maxTurns: MAX_TURNS,
      segmentTurns: SEGMENT_TURNS,
      seed: SEED,
      steer: async () => ({ stop: true, source: 'process-boundary' }),
      onLedger: async (current) => { await saveLedger(path, current) },
    })
    const original: CampaignLedger = await loadLedger(path)
    assert.equal(original.decisions.length, SEGMENT_TURNS)

    const resume = async (ledger: CampaignLedger, seed = SEED): Promise<unknown> => runCampaign(
      game,
      contract,
      turnScriptedDriver(),
      { budgetUsd: BUDGET, maxTurns: MAX_TURNS, segmentTurns: SEGMENT_TURNS, seed, ledger },
    )

    const editedInput = structuredClone(original)
    editedInput.inputs[2] = 'up'
    await assert.rejects(resume(editedInput), /does not match inputs\[2\]/u)

    const editedCost = structuredClone(original)
    editedCost.spentUsd = 0
    await assert.rejects(resume(editedCost), /does not match the recorded decision costs/u)

    const swappedContract = structuredClone(original)
    swappedContract.contractHash = 'a'.repeat(64)
    await assert.rejects(resume(swappedContract), /pins contract/u)

    const swappedSeed = structuredClone(original)
    swappedSeed.seed = 7
    await assert.rejects(resume(swappedSeed), /does not match requested seed/u)

    const swappedGame = structuredClone(original)
    swappedGame.gameId = 'not-2048'
    await assert.rejects(resume(swappedGame), /is for game not-2048/u)

    const swappedBudget = structuredClone(original)
    swappedBudget.budgetUsd = 2
    await assert.rejects(resume(swappedBudget), /does not match requested budget/u)

    const droppedSegment = structuredClone(original)
    droppedSegment.segments = []
    await assert.rejects(resume(droppedSegment), /segments cover 0 turns/u)

    // A consistently rewritten ledger is not a forgery path: it simply becomes
    // a different run with a different chain head, attested on its own inputs.
    const rewritten = structuredClone(original)
    rewritten.inputs[2] = 'up'
    rewritten.decisions[2]!.input = 'up'
    const forked = await runCampaign(game, contract, turnScriptedDriver(), {
      budgetUsd: BUDGET,
      maxTurns: MAX_TURNS,
      segmentTurns: SEGMENT_TURNS,
      seed: SEED,
      ledger: rewritten,
    })
    const honest = await runCampaign(game, contract, turnScriptedDriver(), {
      budgetUsd: BUDGET,
      maxTurns: MAX_TURNS,
      segmentTurns: SEGMENT_TURNS,
      seed: SEED,
      ledger: original,
    })
    assert.notEqual(forked.log.head(), honest.log.head())
    assert.equal(base.record.turns, SEGMENT_TURNS)
  }

  // Malformed persisted ledgers fail closed with a readable reason.
  {
    const path = join(workspace, 'broken.json')
    await writeFile(path, '{ this is not json', 'utf8')
    await assert.rejects(loadLedger(path), /is not JSON/u)
    await writeFile(path, JSON.stringify({ schemaVersion: 2 }), 'utf8')
    await assert.rejects(loadLedger(path), /schemaVersion must be 1/u)
    await writeFile(path, JSON.stringify([]), 'utf8')
    await assert.rejects(loadLedger(path), /must be an object/u)
    await assert.rejects(loadLedger(join(workspace, 'absent.json')), /ENOENT/u)
  }

  // Option validation is fail-closed.
  {
    const invalid = async (options: Record<string, unknown>): Promise<unknown> => runCampaign(
      game,
      contract,
      turnScriptedDriver(),
      { budgetUsd: BUDGET, maxTurns: MAX_TURNS, segmentTurns: SEGMENT_TURNS, ...options } as never,
    )
    await assert.rejects(invalid({ segmentTurns: 0 }), /segmentTurns must be an integer of at least 1/u)
    await assert.rejects(invalid({ segmentTurns: 1.5 }), /segmentTurns must be an integer of at least 1/u)
    await assert.rejects(invalid({ segmentTurns: Number.NaN }), /segmentTurns must be an integer of at least 1/u)
    await assert.rejects(invalid({ budgetUsd: -1 }), /budgetUsd must be non-negative/u)
    await assert.rejects(invalid({ budgetUsd: Number.POSITIVE_INFINITY }), /budgetUsd must be non-negative/u)
    await assert.rejects(invalid({ maxTurns: -1 }), /maxTurns must be a non-negative integer/u)
    await assert.rejects(invalid({ maxTurns: 2.5 }), /maxTurns must be a non-negative integer/u)
    await assert.rejects(invalid({ seed: Number.NaN }), /seed must be finite/u)

    // A zero budget runs nothing, records nothing, and stays honest.
    const empty = await runCampaign(game, contract, turnScriptedDriver(), {
      budgetUsd: 0,
      maxTurns: MAX_TURNS,
      segmentTurns: SEGMENT_TURNS,
      seed: SEED,
    })
    assert.equal(empty.record.turns, 0)
    assert.equal(empty.ledger.segments.length, 0)
    assert.equal(empty.record.budgetExhausted, true)
  }

  console.log('playproof campaign: segment, steer, resume, and tamper semantics OK')
} finally {
  adapter.dispose()
  await rm(workspace, { recursive: true, force: true })
}
