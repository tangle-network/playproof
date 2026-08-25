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

const [definitionPath, ...rest] = process.argv.slice(2)
if (definitionPath === undefined) {
  console.error('usage: tsx matrix.mts <definition.matrix> [--out <path.json>]')
  process.exit(2)
}
const outIndex = rest.indexOf('--out')
const outPath = outIndex >= 0 ? rest[outIndex + 1] : undefined

const definition = parseMatrix(await readFile(definitionPath, 'utf8'))
const cells = enumerateCells(definition)
console.error(`matrix: ${cells.length} cells from ${definitionPath}`)

const rows: CellResult[] = []
for (const [index, cell] of cells.entries()) {
  const row = await runCell(cell)
  rows.push(row)
  const headline = row.status === 'played'
    ? `score=${row.score ?? '-'} deaths=${row.deaths ?? '-'} decisions=${row.decisions} usd=${row.usd.toFixed(4)}`
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
