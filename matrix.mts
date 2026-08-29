/**
 * Run a matrix definition and print its rows.
 *
 *   tsx matrix.mts <definition.matrix> [--out runs/<study>/cells.json]
 *
 * Every cell is played in the definition's own order. A cell that cannot be
 * built under its own protocol is written as a blocked row with the reason,
 * and the run continues: one unbuildable clock must not cost the study every
 * other cell.
 *
 * Env knobs:
 *   PLAYPROOF_PYTHON   interpreter that runs an emulator worker (default python3)
 */
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { cellName, enumerateCells, parseMatrix } from './matrix'
import { assertJoinable, blockedResult, effectiveArms, generalization, runCell, type CellResult } from './matrix-run'

// SEVERAL definitions, pooled into one study.
//
// A transfer statistic needs two games, and two games do not fit one
// definition: each names its own score channel and its own seed. CartPole is
// scored on `steps` at the seed its reference was recorded at; 2048 is scored
// on `score`. Crossing one objective set over both games would spend half the
// cells scoring a channel the game does not publish. One definition per game,
// pooled here, is the shape the study already has.
const argv = process.argv.slice(2)
const outIndex = argv.indexOf('--out')
const outPath = outIndex >= 0 ? argv[outIndex + 1] : undefined
const definitionPaths = argv.filter((arg, at) => arg !== '--out' && at !== outIndex + 1)
if (definitionPaths.length === 0) {
  console.error('usage: tsx matrix.mts <definition.matrix> [more.matrix ...] [--out <path.json>]')
  process.exit(2)
}

const cells = []
for (const path of definitionPaths) {
  const parsed = enumerateCells(parseMatrix(await readFile(path, 'utf8')))
  console.error(`matrix: ${parsed.length} cells from ${path}`)
  cells.push(...parsed)
}
const definitionPath = definitionPaths.join(' ')

const rows: CellResult[] = []

/**
 * Write what has finished so far.
 *
 * Called after EVERY cell, not once at the end. A 42-cell study died at cell 3
 * on an unhandled pipe error and left no artifact at all, so two cells that had
 * each cost twenty minutes were lost after they had already succeeded. Work
 * that is done should survive whatever happens to the work that is not.
 *
 * `partial` marks a file whose run has not finished, so a reader never mistakes
 * an interrupted study for a complete one.
 */
async function persist(partial: boolean): Promise<void> {
  const protocolsSeen = new Set(rows.map((row) => row.protocol))
  const artifact = {
    definition: definitionPath,
    cells: rows.length,
    expected: cells.length,
    partial,
    rows,
    summary: partial || protocolsSeen.size !== 1
      ? { transfer: null, arms: effectiveArms(rows), note: partial ? 'run did not finish' : 'several protocols' }
      : { transfer: generalization(rows), arms: effectiveArms(rows) },
  }
  const text = `${JSON.stringify(artifact, null, 2)}\n`
  if (outPath === undefined) return
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, text)
}

// A crash must not take finished work with it. What is on disk is written
// first, then the failure is reported and the exit code still says it failed:
// keeping the data is not the same as pretending the run succeeded.
for (const signal of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(signal, (error: unknown) => {
    void persist(true).finally(() => {
      console.error(`\nmatrix: ${signal} after ${rows.length} of ${cells.length} cells`)
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
      if (outPath !== undefined) console.error(`matrix: wrote ${rows.length} finished cells to ${outPath}`)
      process.exit(1)
    })
  })
}

for (const [index, cell] of cells.entries()) {
  // A cell is announced BEFORE it runs, and says it is alive while it runs.
  //
  // Printing only on completion makes a slow cell and a hung one identical in
  // the log. Measured: one authoring cell took 2h13m to play 2000 decisions
  // with a compiled search, and produced no output for all of it, so the run
  // could not be told from a hang without attaching to the process.
  const name = cellName(cell)
  const label = cell.profile.author === undefined
    ? name
    : `${name} (build ${cell.profile.buildMinutes}m, then evaluate)`
  console.error(`[${index + 1}/${cells.length}] ${label} ...`)
  const cellStarted = Date.now()
  const heartbeat = setInterval(() => {
    const mins = Math.round((Date.now() - cellStarted) / 60_000)
    console.error(`[${index + 1}/${cells.length}] still running, ${mins}m elapsed`)
  }, 60_000)
  heartbeat.unref()
  let row: CellResult
  try {
    row = await runCell(cell)
  } catch (error) {
    // `runCell` returns a blocked row for everything it can foresee. This is
    // for what it cannot: one cell that throws costs one cell, and the study
    // keeps going and keeps what it has.
    console.error(`[${index + 1}/${cells.length}] threw: ${(error as Error).message}`)
    row = blockedResult(cell, 'episode-failed', (error as Error).message, Date.now() - cellStarted)
  } finally {
    clearInterval(heartbeat)
  }
  // Keep what the cell produced. The authoring sandbox is a temp directory
  // that is reclaimed, so the program an agent wrote and the transcript of how
  // it wrote it are lost the moment the run ends. Those are the two artifacts
  // an autopsy of a build actually needs.
  if (row.build?.policy != null && outPath !== undefined) {
    const keep = join(dirname(outPath), 'artifacts', cellName(cell).replace(/[^\w.-]+/gu, '_'))
    try {
      await mkdir(keep, { recursive: true })
      const from = dirname(row.build.policy)
      for (const name of await readdir(from)) {
        // Observation files are the game talking, not the agent working, and a
        // practice run writes thousands of them.
        if (name === 'observations' || name === 'latest.json') continue
        const source = join(from, name)
        if ((await stat(source)).isDirectory()) continue
        await copyFile(source, join(keep, name))
      }
    } catch (error) {
      console.error(`[${index + 1}/${cells.length}] could not keep artifacts: ${(error as Error).message}`)
    }
  }
  // The raw trace is the whole episode. It goes beside the artifact as JSONL,
  // one decision per line, so the row stays readable and nothing is lost: a
  // 20,000-decision run would otherwise make the study file unopenable.
  if (row.telemetry !== null && row.telemetry.trace.length > 0 && outPath !== undefined) {
    const slug = cellName(cell).replace(/[^\w.-]+/gu, '_')
    const tracePath = join(dirname(outPath), 'traces', `${slug}.jsonl`)
    try {
      await mkdir(dirname(tracePath), { recursive: true })
      await writeFile(tracePath, row.telemetry.trace.map((d) => JSON.stringify(d)).join('\n') + '\n')
      row.telemetry = { ...row.telemetry, trace: [], tracePath }
    } catch (error) {
      console.error(`[${index + 1}/${cells.length}] could not write the trace: ${(error as Error).message}`)
    }
  }
  rows.push(row)
  const headline = row.status === 'played'
    ? `score=${row.score ?? '-'} deaths=${row.deaths ?? '-'} decisions=${row.decisions}`
      // An authored cell reports what BUILDING it cost, next to what its
      // program scored. They answer different questions and a single number
      // cannot carry both.
      + (row.build === null
        ? ''
        : ` build=${row.build.minutes.toFixed(1)}m/${row.build.tokens ?? '?'}tok/`
          + `${row.build.usd === null ? `unbilled(${row.build.authMode ?? 'unknown'})` : `$${row.build.usd.toFixed(2)}`}`)
      + ` tokens=${row.tokens ?? 'unmetered'}`
      // An absent cost reads as its REASON. `oauth` bills a plan and reports no
      // per-request figure, so "unbilled(oauth)" and "$0.0000" are different
      // facts and must not print the same.
      + ` usd=${row.usd === null ? `unbilled(${row.authMode ?? 'unknown'})` : row.usd.toFixed(4)}`
    : `BLOCKED (${row.blocked?.reason}): ${row.blocked?.detail}`
  const note = row.transportNote === null ? '' : `  [${row.transportNote}]`
  console.error(`[${index + 1}/${cells.length}] ${row.name}  ${headline}${note}`)
}

// Refuse to summarise rows that were not measured under one protocol and one
// clock. A definition with several protocols is several studies, and each is
// summarised on its own.
const protocols = new Set(rows.map((row) => row.protocol))
const summary = protocols.size === 1
  ? { transfer: generalization(rows), arms: effectiveArms(rows) }
  : { transfer: null, arms: effectiveArms(rows), note: `${protocols.size} protocols: summarise each on its own` }
if (protocols.size === 1) assertJoinable(rows)

await persist(false)
if (outPath !== undefined) console.error(`wrote ${outPath}`)
else process.stdout.write(`${JSON.stringify({ definition: definitionPath, cells: rows.length, rows, summary }, null, 2)}\n`)

const blocked = rows.filter((row) => row.status === 'blocked').length
console.error(`matrix: ${rows.length - blocked} played, ${blocked} blocked`)
if (summary.transfer !== null && summary.transfer !== undefined) {
  const transfer = summary.transfer
  console.error(
    `transfer: tau=${transfer.tau === null ? 'none' : transfer.tau.toFixed(3)}`
    + ` over ${transfer.folds} games (${transfer.pairs} pairs), ${transfer.effectiveArms} of ${transfer.declaredArms} arms distinct`
    + `${transfer.note === null ? '' : ` — ${transfer.note}`}`,
  )
}
