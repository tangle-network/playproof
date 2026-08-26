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
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { enumerateCells, parseMatrix } from './matrix'
import { assertJoinable, effectiveArms, generalization, runCell, type CellResult } from './matrix-run'

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
for (const [index, cell] of cells.entries()) {
  const row = await runCell(cell)
  rows.push(row)
  const headline = row.status === 'played'
    ? `score=${row.score ?? '-'} deaths=${row.deaths ?? '-'} decisions=${row.decisions}`
      + ` tokens=${row.tokens ?? 'unmetered'} usd=${row.usd === null ? 'unmetered' : row.usd.toFixed(4)}`
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

const artifact = { definition: definitionPath, cells: rows.length, rows, summary }
if (outPath !== undefined) {
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, `${JSON.stringify(artifact, null, 2)}\n`)
  console.error(`wrote ${outPath}`)
} else {
  process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`)
}

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
