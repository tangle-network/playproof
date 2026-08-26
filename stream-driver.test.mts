/**
 * The asynchronous transport: the game streams, the agent answers when it can,
 * and the game never waits.
 *
 * The behaviour under test is the one design decision this shape forces — what
 * acts while the agent is thinking. Every case below is watched going RED: the
 * queue really does starve, the depth really does drop, and the two
 * empty-queue defaults really do produce different episodes. If they did not,
 * the option would be decoration.
 */
import { strict as assert } from 'node:assert'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStreamSandboxDriver } from './drivers/stream-sandbox'
import type { AgentDecisionContext } from './episode'

const root = mkdtempSync(join(tmpdir(), 'playproof-stream-'))
const COMMANDS = ['up', 'down'] as const
let made = 0

const context = (turn: number): AgentDecisionContext => ({
  turn,
  maxTurns: 100,
  seed: 0,
  spentUsd: 0,
  remainingBudgetUsd: 1,
})

function sandbox(options: { queueDepth: number; whenEmpty: 'noop' | 'repeat-last' }): ReturnType<typeof createStreamSandboxDriver> {
  made += 1
  return createStreamSandboxDriver({
    dir: join(root, `s${made}`),
    commands: COMMANDS,
    fixedCostUsd: 0,
    ...options,
  })
}

// ---- The game does not wait ------------------------------------------------

{
  // No agent exists at all. Every decision still returns, immediately. A polled
  // transport would block here forever; this is the difference.
  const driver = sandbox({ queueDepth: 4, whenEmpty: 'noop' })
  try {
    const started = Date.now()
    for (let turn = 1; turn <= 20; turn += 1) {
      assert.equal((await driver.act(`frame ${turn}`, [], context(turn))).input, 'noop')
    }
    assert.ok(Date.now() - started < 2000, 'a game with no agent attached must not wait for one')
    const health = driver.health()
    assert.equal(health.written, 20, 'every decision writes an observation the agent could have read')
    assert.equal(health.starved, 20)
    assert.equal(health.consumed, 0)
  } finally {
    driver.close()
  }
}

// ---- What the agent can read is what `observe()` published -----------------

{
  const driver = sandbox({ queueDepth: 4, whenEmpty: 'noop' })
  try {
    await driver.act('the visible frame', [], context(1))
    const latest = JSON.parse(readFileSync(join(driver.dir, 'latest.json'), 'utf8')) as Record<string, unknown>
    assert.equal(latest.text, 'the visible frame')
    assert.equal(latest.turn, 1)
    assert.equal(latest.images, undefined, 'pixels are off unless the sensor asked for them')
    // The privileged channel is not in the sandbox, and could not be: the text
    // written is the driver's `frame` argument, which is `observationOf`'s text.
    assert.ok(!JSON.stringify(latest).includes('engineState'), 'the harness channel must never reach the sandbox')
  } finally {
    driver.close()
  }
}

// ---- The queue is consumed one action per decision -------------------------

{
  const driver = sandbox({ queueDepth: 8, whenEmpty: 'noop' })
  try {
    // The agent thinks for three frames, then commits three actions at once.
    for (let turn = 1; turn <= 3; turn += 1) {
      assert.equal((await driver.act('f', [], context(turn))).input, 'noop', 'nothing queued yet')
    }
    appendFileSync(join(driver.dir, 'actions'), 'up\ndown\nup\n')
    assert.equal((await driver.act('f', [], context(4))).input, 'up')
    assert.equal((await driver.act('f', [], context(5))).input, 'down')
    assert.equal((await driver.act('f', [], context(6))).input, 'up')
    assert.equal((await driver.act('f', [], context(7))).input, 'noop', 'the queue is empty again')
    const health = driver.health()
    assert.equal(health.consumed, 3)
    assert.equal(health.starved, 4)
    assert.equal(health.peakQueue, 3, 'the agent got three frames ahead of the game')
  } finally {
    driver.close()
  }
}

// ---- The two empty-queue defaults are two different games ------------------

{
  const stopping = sandbox({ queueDepth: 4, whenEmpty: 'noop' })
  const holding = sandbox({ queueDepth: 4, whenEmpty: 'repeat-last' })
  try {
    for (const driver of [stopping, holding]) {
      appendFileSync(join(driver.dir, 'actions'), 'up\n')
      assert.equal((await driver.act('f', [], context(1))).input, 'up')
    }
    // Same history, same agent silence, different game.
    assert.equal((await stopping.act('f', [], context(2))).input, 'noop', 'noop: the game stops when nobody answers')
    assert.equal(
      (await holding.act('f', [], context(2))).input,
      'up',
      'repeat-last: the game keeps doing what it was told until told otherwise',
    )
    assert.notEqual(
      (await stopping.act('f', [], context(3))).input,
      (await holding.act('f', [], context(3))).input,
      'the two defaults must produce different episodes, or the option is decoration',
    )
  } finally {
    stopping.close()
    holding.close()
  }
}

// ---- A full queue drops the newest, not the oldest -------------------------

{
  const driver = sandbox({ queueDepth: 2, whenEmpty: 'noop' })
  try {
    appendFileSync(join(driver.dir, 'actions'), 'up\ndown\nup\nup\n')
    // Draining happens at the decision, so all four lines meet a depth-2 queue.
    assert.equal((await driver.act('f', [], context(1))).input, 'up')
    assert.equal((await driver.act('f', [], context(2))).input, 'down')
    assert.equal((await driver.act('f', [], context(3))).input, 'noop', 'the two beyond the depth were dropped')
    const health = driver.health()
    assert.equal(health.dropped, 2)
    assert.equal(health.peakQueue, 2, 'the queue never exceeded its declared depth')
  } finally {
    driver.close()
  }
}

// ---- A word the game does not accept is rejected, not queued ---------------

{
  const driver = sandbox({ queueDepth: 4, whenEmpty: 'noop' })
  try {
    appendFileSync(join(driver.dir, 'actions'), 'jump\n\n  \nup\n')
    assert.equal((await driver.act('f', [], context(1))).input, 'up', 'the unusable word must not become an action')
    assert.equal(driver.health().rejected, 1)
  } finally {
    driver.close()
  }
}

// ---- A partial line is not an action until it is complete ------------------

{
  const driver = sandbox({ queueDepth: 4, whenEmpty: 'noop' })
  try {
    appendFileSync(join(driver.dir, 'actions'), 'do')
    assert.equal((await driver.act('f', [], context(1))).input, 'noop', 'a half-written word is not an action')
    appendFileSync(join(driver.dir, 'actions'), 'wn\n')
    assert.equal((await driver.act('f', [], context(2))).input, 'down', 'and it becomes one when the line completes')
    assert.equal(driver.health().rejected, 0, 'a partial write must not be counted as a bad word')
  } finally {
    driver.close()
  }
}

// ---- An agent that never starts is VISIBLE ---------------------------------

{
  // Found while smoke-testing this driver: a bad command produced 30 starved
  // decisions, a clean attestation, and nothing anywhere saying the agent had
  // not started. The game still must not wait — but the operator must be able
  // to tell "still thinking" from "never ran".
  made += 1
  const driver = createStreamSandboxDriver({
    dir: join(root, `s${made}`),
    commands: COMMANDS,
    queueDepth: 4,
    whenEmpty: 'noop',
    fixedCostUsd: 0,
    command: join(root, 'no-such-program'),
  })
  try {
    for (let turn = 1; turn <= 3; turn += 1) {
      assert.equal((await driver.act('f', [], context(turn))).input, 'noop', 'the game still does not wait')
    }
    const health = driver.health()
    assert.equal(health.starved, 3)
    assert.equal(health.agent, 'failed', 'an agent that could not start must be reported, not left looking thoughtful')
    assert.match(health.agentDetail ?? '', /could not be started|exited/u)
  } finally {
    driver.close()
  }
}

// An agent that dies mid-episode is reported too, with what it printed.
{
  made += 1
  const dir = join(root, `s${made}`)
  const driver = createStreamSandboxDriver({
    dir,
    commands: COMMANDS,
    queueDepth: 4,
    whenEmpty: 'noop',
    fixedCostUsd: 0,
    command: process.execPath,
    args: ['-e', 'console.error("the agent gave up"); process.exit(2)'],
  })
  try {
    for (let turn = 1; turn <= 3; turn += 1) {
      await driver.act('f', [], context(turn))
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    const health = driver.health()
    assert.equal(health.agent, 'failed')
    assert.match(health.agentDetail ?? '', /exited \(2\)/u, 'the exit status must be reported')
    assert.match(health.agentDetail ?? '', /the agent gave up/u, 'and what it printed, which is why it died')
  } finally {
    driver.close()
  }
}

// A healthy agent this driver started reads as running, so the two above are
// not simply "always failed".
{
  made += 1
  const dir = join(root, `s${made}`)
  const driver = createStreamSandboxDriver({
    dir,
    commands: COMMANDS,
    queueDepth: 4,
    whenEmpty: 'noop',
    fixedCostUsd: 0,
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
  })
  try {
    await driver.act('f', [], context(1))
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(driver.health().agent, 'running', 'a live agent must not read as failed')
    assert.equal(driver.health().agentDetail, null)
  } finally {
    driver.close()
  }
}

// ---- Refusals at construction ---------------------------------------------

assert.throws(
  () => createStreamSandboxDriver({ dir: join(root, 'x'), commands: COMMANDS, queueDepth: 0, whenEmpty: 'noop', fixedCostUsd: 0 }),
  /queueDepth must be an integer of at least 1/u,
)
assert.throws(
  () => createStreamSandboxDriver({ dir: join(root, 'x'), commands: COMMANDS, queueDepth: 1, whenEmpty: 'noop' }),
  /cost is unavailable/u,
  'an unpriced stream must be refused rather than reporting a zero nobody measured',
)

// ---- The sandbox describes itself ------------------------------------------

{
  // An agent started in a directory of observations must be told the control
  // scheme, or the words it guesses become rejected lines and read in the
  // health record as bad play rather than as a player nobody told the rules.
  const driver = sandbox({ queueDepth: 3, whenEmpty: 'repeat-last' })
  try {
    const brief = JSON.parse(readFileSync(join(driver.dir, 'brief.json'), 'utf8')) as Record<string, unknown>
    assert.deepEqual(brief.commands, [...COMMANDS], 'the brief must state the vocabulary the game accepts')
    assert.equal(brief.queueDepth, 3)
    assert.equal(brief.whenEmpty, 'repeat-last')
    assert.equal(brief.actions, 'actions', 'the brief must name the file the agent writes to')
  } finally {
    driver.close()
  }
}

// ---- Wall clock is the asynchronous agent's whole budget --------------------

{
  // RED without the pace: 12 decisions complete in about a millisecond, so a
  // player with a process to start has lost the episode before it printed a
  // line. That measures the host's clock speed, not the player.
  const driver = createStreamSandboxDriver({
    dir: join(root, 'paced'),
    commands: COMMANDS,
    queueDepth: 4,
    whenEmpty: 'noop',
    fixedCostUsd: 0,
    paceMs: 40,
  })
  try {
    const started = Date.now()
    for (let turn = 1; turn <= 12; turn += 1) await driver.act(`frame ${turn}`, [], context(turn))
    const elapsed = Date.now() - started
    // Eleven gaps between twelve decisions, and the first is due immediately.
    assert.ok(elapsed >= 400, `a paced game must hold its rate, took ${elapsed}ms for 12 at 40ms`)
    assert.ok(elapsed < 2000, `the pace must not compound, took ${elapsed}ms`)
  } finally {
    driver.close()
  }
}

// ---- An unmetered agent costs null, never zero -----------------------------

{
  // This transport cannot bracket a call to meter it: the agent answers into a
  // file on its own clock. The only honest source is the agent's own report,
  // and its ABSENCE must stay absent — a free arm and an unmetered one look
  // identical in a total, and only one of them is a result.
  const driver = sandbox({ queueDepth: 2, whenEmpty: 'noop' })
  try {
    assert.equal(driver.health().costUsd, null, 'an agent that reported no cost must not be recorded as free')
    assert.equal(driver.health().tokens, null)
    writeFileSync(join(driver.dir, 'agent-cost.json'), JSON.stringify({ usd: 0.42, tokens: 1234 }))
    assert.equal(driver.health().costUsd, 0.42, 'a reported cost must be read back')
    assert.equal(driver.health().tokens, 1234)
    writeFileSync(join(driver.dir, 'agent-cost.json'), JSON.stringify({ usd: -1, tokens: 'many' }))
    assert.equal(driver.health().costUsd, null, 'a nonsensical cost is no cost, not a negative one')
    assert.equal(driver.health().tokens, null)
  } finally {
    driver.close()
  }
}

// ---- An agent that rewrites its action file is not a silent agent ----------

{
  // RED before the truncation check: the offset sits past the end of a shorter
  // file, every later read returns nothing, and the driver is deaf for the rest
  // of the episode while the health record blames the player. Measured on the
  // first cell this transport ever played, whose agent wrote itself a
  // controller that kept the last eight actions with `open(path, 'w')`.
  const driver = sandbox({ queueDepth: 4, whenEmpty: 'noop' })
  const actions = join(driver.dir, 'actions')
  try {
    appendFileSync(actions, 'up\nup\nup\n')
    assert.equal((await driver.act('f1', [], context(1))).input, 'up')
    assert.equal((await driver.act('f2', [], context(2))).input, 'up')
    // The agent rewrites rather than appends, and the file gets shorter.
    writeFileSync(actions, 'down\n')
    assert.equal(
      (await driver.act('f3', [], context(3))).input,
      'down',
      'an agent that rewrites its action file must still be heard',
    )
    assert.equal(driver.health().rewrites, 1, 'the rewrite must be counted, not hidden')
    assert.equal(driver.health().starved, 0, 'a rewritten file must not be reported as a player that stopped playing')
  } finally {
    driver.close()
  }
}

rmSync(root, { recursive: true, force: true })
console.log(
  'playproof stream sandbox: the game never waits, the queue is consumed one action per decision,'
  + ' a full queue drops the newest, noop and repeat-last produce different episodes,'
  + ' the pace is held, the sandbox describes itself, an unmetered agent costs null,'
  + ' and an agent that rewrites its action file is still heard',
)
