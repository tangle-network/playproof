/**
 * Benchmark MANY agent profiles at once, each run through the Tangle runtime.
 *
 * `harness=<launcher>` in a matrix definition spawns a program, which is how
 * `harnesses/claude-code` works and why that axis is one vendor wide. The
 * runtime is the vendor-neutral way in: one backend per profile, so a single
 * definition can put claude-code, codex and opencode in the same table on the
 * same game, the same clock and the same sensor.
 *
 * Nothing here re-implements the runner. `runMatrix` already enumerates the
 * cells, plays each one, attests the replay and computes the transfer
 * statistic; `RunCellOptions.driver` is the seam that decides WHAT plays them.
 * This file is that one function.
 *
 *   npx tsx examples/agent-runtime-matrix.mts examples/agent-runtime.matrix
 */
import { readFile } from 'node:fs/promises'
import type { AgentExecutionBackend, RuntimeStreamEvent } from '@tangle-network/agent-runtime'
import { parseMatrix } from '../matrix'
import { driverFor, generalization, runMatrix } from '../matrix-run'
import type { AgentDriver } from '../episode'
import { createTangleRuntimeDriver } from './tangle-agent-runtime.mts'

/**
 * One runtime backend per profile id.
 *
 * Replace these with real backends — a local iterable, a CLI bridge, a sandbox,
 * a remote gateway. The point of the map is that the PROFILE chooses, so a row
 * labelled `codex` was really produced by codex.
 */
declare function backendForProfile(id: string, model?: string): AgentExecutionBackend

/**
 * Sum what the runtime says a decision cost.
 *
 * Never invent a price here. A profile whose backend reports nothing must fail
 * the decision rather than bank a zero, because a free arm and an unmetered one
 * are indistinguishable in a total and only one of them is good news.
 */
function costOf(events: readonly RuntimeStreamEvent[]): number {
  let usd = 0
  let reported = false
  for (const event of events) {
    const spend = (event as { costUsd?: unknown }).costUsd
    if (typeof spend === 'number' && Number.isFinite(spend)) {
      usd += spend
      reported = true
    }
  }
  if (!reported) throw new Error('the runtime reported no cost for this decision')
  return usd
}

const [definitionPath] = process.argv.slice(2)
if (definitionPath === undefined) {
  console.error('usage: tsx examples/agent-runtime-matrix.mts <definition.matrix>')
  process.exit(2)
}

const definition = parseMatrix(await readFile(definitionPath, 'utf8'))

const rows = await runMatrix(definition, {
  driver: (profile, commands, sensor, protocol, streamDir, objective): AgentDriver => {
    // A control is a local program and stays one. Only harness profiles are
    // routed through the runtime, so a hand-written baseline in the same
    // definition is still free and still deterministic.
    if (profile.kind === 'policy') {
      return driverFor(profile, commands, sensor, protocol, streamDir, objective)
    }
    return createTangleRuntimeDriver({
      backend: backendForProfile(profile.id, profile.model),
      commands,
      costUsd: costOf,
    })
  },
})

for (const row of rows) {
  const headline = row.status === 'played'
    ? `${row.scoreField}=${row.score ?? '-'} usd=${row.usd === null ? 'unmetered' : row.usd.toFixed(4)}`
    : `BLOCKED (${row.blocked?.reason})`
  console.log(`${row.name}  ${headline}`)
}

// The transfer statistic is the reason to run several games rather than one:
// it asks whether the ORDER of these profiles survives a change of game.
const transfer = generalization(rows)
console.log(`\ntransfer: tau=${transfer.tau ?? 'none'} over ${transfer.folds} games (${transfer.pairs} pairs)`)
if (transfer.note !== null) console.log(`note: ${transfer.note}`)

// NOTE ON THE TRANSPORT. This driver asks the runtime once PER DECISION, so the
// agent cannot keep state between moves and its latency is charged against the
// clock. MEASURED across nine cells of the first study run here: the rank
// correlation between actions delivered and score was 0.94, which is to say a
// live cell very nearly measures delivery. To compare what profiles BUILD
// rather than how fast they answer, give the profile an `author=` launcher and
// evaluate the program it writes with `transport=persistent`.
