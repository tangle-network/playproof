/**
 * The persistent driver: one process for a whole episode, and the four ways
 * that can go wrong.
 *
 * Per-decision spawning made every decision independent, so a child that hung,
 * died or flooded cost exactly one turn. One process for a whole episode has no
 * such boundary, and each failure mode has to be handled explicitly. Each one
 * below is watched going RED — the bad program really does hang, die, flood, or
 * refuse to read — and the episode survives every one of them.
 *
 * The programs are written to a temp directory and run with this same node, so
 * the test needs no emulator and no network.
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPersistentCliDriver } from './drivers/persistent-cli'
import type { AgentDecisionContext } from './episode'

const dir = mkdtempSync(join(tmpdir(), 'playproof-persistent-'))
const COMMANDS = ['up', 'down'] as const

function program(name: string, body: string): string {
  const path = join(dir, `${name}.mjs`)
  writeFileSync(path, body)
  return path
}

const context = (turn: number): AgentDecisionContext => ({
  turn,
  maxTurns: 10,
  seed: 0,
  spentUsd: 0,
  remainingBudgetUsd: 1,
})

/** Read stdin line by line, and answer each request with `answer(request, n)`. */
const lineLoop = (answer: string): string => `
let buffer = ''
let n = 0
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const at = buffer.indexOf('\\n')
    if (at < 0) break
    const line = buffer.slice(0, at)
    buffer = buffer.slice(at + 1)
    n += 1
    const request = JSON.parse(line)
    ${answer}
  }
})
`

// ---- One process, many decisions, and state that survives between them -----

{
  // The program counts its own decisions. Under per-decision spawning this
  // counter resets every turn and the program is a constant; here it is not,
  // which is the whole reason the transport exists.
  const path = program('stateful', lineLoop(`process.stdout.write((n % 2 === 1 ? 'up' : 'down') + '\\n')`))
  const driver = createPersistentCliDriver({ command: process.execPath, args: [path], commands: COMMANDS, fixedCostUsd: 0 })
  try {
    const answers: string[] = []
    for (let turn = 1; turn <= 6; turn += 1) answers.push((await driver.act('frame', [], context(turn))).input)
    assert.deepEqual(
      answers,
      ['up', 'down', 'up', 'down', 'up', 'down'],
      'a program that counts its own decisions must keep that count across turns',
    )
    const health = driver.health()
    assert.equal(health.answered, 6)
    assert.equal(health.endReason, null, 'a healthy session reports no failure')
    assert.equal(health.lost, 0)
  } finally {
    driver.close()
  }
}

// The same program under the SAME driver, closed and re-made, starts over —
// which is the control proving the counter above came from one live process.
{
  const path = program('stateful2', lineLoop(`process.stdout.write((n % 2 === 1 ? 'up' : 'down') + '\\n')`))
  const first = createPersistentCliDriver({ command: process.execPath, args: [path], commands: COMMANDS, fixedCostUsd: 0 })
  assert.equal((await first.act('f', [], context(1))).input, 'up')
  first.close()
  const second = createPersistentCliDriver({ command: process.execPath, args: [path], commands: COMMANDS, fixedCostUsd: 0 })
  assert.equal((await second.act('f', [], context(2))).input, 'up', 'a new session starts the program over')
  second.close()
}

// ---- RED 1: the program hangs ----------------------------------------------

{
  const path = program('hangs', `process.stdin.resume()\n`)
  const driver = createPersistentCliDriver({
    command: process.execPath,
    args: [path],
    commands: COMMANDS,
    fixedCostUsd: 0,
    timeoutMs: 250,
  })
  try {
    await assert.rejects(driver.act('frame', [], context(1)), /did not answer within 250ms/u, 'a hang must be refused')
    const health = driver.health()
    assert.equal(health.endReason, 'timeout')
    assert.equal(health.endedAtDecision, 1, 'the session died on the decision it was asked for')
    // Every later decision is refused too, and each one is countable, so the
    // episode plays to its full length instead of being lost.
    await assert.rejects(driver.act('frame', [], context(2)))
    assert.equal(driver.health().lost, 1, 'decisions after the session died are counted as lost, not silently dropped')
  } finally {
    driver.close()
  }
}

// ---- RED 2: the program dies mid-episode -----------------------------------

{
  const path = program('dies', lineLoop(`if (n >= 2) process.exit(3); process.stdout.write('up\\n')`))
  const driver = createPersistentCliDriver({ command: process.execPath, args: [path], commands: COMMANDS, fixedCostUsd: 0, timeoutMs: 2000 })
  try {
    assert.equal((await driver.act('frame', [], context(1))).input, 'up')
    await assert.rejects(driver.act('frame', [], context(2)), /exited \(3\)/u, 'a child exiting must end the session')
    const health = driver.health()
    assert.equal(health.endReason, 'exited')
    assert.equal(health.answered, 1, 'the decision it did answer is kept')
  } finally {
    driver.close()
  }
}

// ---- RED 3: the program floods stdout --------------------------------------

{
  const path = program('floods', lineLoop(`for (let i = 0; i < 100000; i++) process.stdout.write('x'.repeat(200) + '\\n')`))
  const driver = createPersistentCliDriver({
    command: process.execPath,
    args: [path],
    commands: COMMANDS,
    fixedCostUsd: 0,
    timeoutMs: 4000,
    maxOutputBytes: 8 * 1024,
  })
  try {
    await assert.rejects(driver.act('frame', [], context(1)), /wrote more than 8192 bytes/u, 'a flood must be bounded')
    assert.equal(driver.health().endReason, 'flooded')
  } finally {
    driver.close()
  }
}

// ---- RED 4: the program never reads its input ------------------------------

{
  // It writes nothing and never reads stdin, so the decision reaches its
  // timeout. The episode survives; the session does not.
  const path = program('deaf', `setTimeout(() => {}, 60_000)\n`)
  const driver = createPersistentCliDriver({
    command: process.execPath,
    args: [path],
    commands: COMMANDS,
    fixedCostUsd: 0,
    timeoutMs: 250,
  })
  try {
    await assert.rejects(driver.act('frame', [], context(1)), /did not answer within 250ms/u)
    assert.equal(driver.health().endReason, 'timeout')
  } finally {
    driver.close()
  }
}

// ---- Chatter is discarded, and cannot be mistaken for an answer ------------

{
  // Three lines a decision, and the ANSWER is not the first one. A rule based on
  // arrival order reads the debug line and puts the episode off by one; the rule
  // that the answer is the line naming a command cannot.
  const path = program(
    'chatty',
    lineLoop(`process.stdout.write('debug: turn ' + n + '\\n'); process.stdout.write('up\\n'); process.stdout.write('trailing\\n')`),
  )
  const driver = createPersistentCliDriver({ command: process.execPath, args: [path], commands: COMMANDS, fixedCostUsd: 0, timeoutMs: 2000 })
  try {
    for (let turn = 1; turn <= 8; turn += 1) {
      assert.equal(
        (await driver.act('frame', [], context(turn))).input,
        'up',
        `decision ${turn} took a debug line as its answer; the episode is off by one`,
      )
    }
    assert.ok(driver.health().discardedLines > 0, 'the chatter must be counted, not silently ignored')
  } finally {
    driver.close()
  }
}

// ---- A word the game refuses is still ANSWERING ----------------------------

{
  // This separates a program playing badly from one that went silent. It costs
  // the decision timeout ONCE; from then on the session knows its shape.
  const path = program('offvocab', lineLoop(`process.stdout.write('jump\\n')`))
  const driver = createPersistentCliDriver({ command: process.execPath, args: [path], commands: COMMANDS, fixedCostUsd: 0, timeoutMs: 300 })
  try {
    const started = Date.now()
    for (let turn = 1; turn <= 4; turn += 1) {
      assert.equal(
        (await driver.act('frame', [], context(turn))).input,
        'noop',
        'a word outside the vocabulary becomes the substituted input',
      )
    }
    assert.equal(driver.health().endReason, null, 'answering badly is not a dead session')
    assert.equal(driver.health().answered, 4)
    assert.ok(
      Date.now() - started < 300 * 4,
      'a program answering outside the vocabulary must pay the decision timeout once, not once per decision',
    )
  } finally {
    driver.close()
  }
}

// ---- Cost is never fabricated ----------------------------------------------

assert.throws(
  () => createPersistentCliDriver({ command: process.execPath, commands: COMMANDS }),
  /first-word output requires costUsd or fixedCostUsd/u,
  'an unpriced driver must be refused at construction rather than reporting a zero nobody measured',
)

// The JSON wire, which is how a metered agent answers. The same program must
// run under this driver and under `createCliAgentDriver`, or the transport axis
// would be confounded with the wire format.
{
  const path = program('json', lineLoop(`process.stdout.write(JSON.stringify({ input: 'up', costUsd: 0.25 }) + '\\n')`))
  const driver = createPersistentCliDriver({
    command: process.execPath,
    args: [path],
    commands: COMMANDS,
    output: 'json',
    timeoutMs: 2000,
  })
  try {
    const turn = await driver.act('frame', [], context(1))
    assert.equal(turn.input, 'up')
    assert.equal(turn.costUsd, 0.25, 'the cost the agent reported is the cost recorded')
  } finally {
    driver.close()
  }
}

// An agent that answers but reports NO cost fails the decision. A zero here
// would be a spend figure nobody measured.
{
  const path = program('nocost', lineLoop(`process.stdout.write(JSON.stringify({ input: 'up' }) + '\\n')`))
  const driver = createPersistentCliDriver({
    command: process.execPath,
    args: [path],
    commands: COMMANDS,
    output: 'json',
    timeoutMs: 2000,
  })
  try {
    await assert.rejects(
      driver.act('frame', [], context(1)),
      /cost is unavailable/u,
      'an unreported cost must fail the decision rather than bank a zero',
    )
  } finally {
    driver.close()
  }
}

rmSync(dir, { recursive: true, force: true })
console.log(
  'playproof persistent driver: state survives across decisions, and a hang, a death, a flood,'
  + ' a deaf child and a chatty one each end the session while leaving the episode gradeable',
)
