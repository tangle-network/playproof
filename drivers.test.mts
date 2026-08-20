import { strict as assert } from 'node:assert'
import { createCliAgentDriver } from './drivers/cli'
import { createOpenAICompatibleDriver } from './drivers/openai-compatible'
import type { AgentDecisionContext } from './episode'

const context: AgentDecisionContext = {
  turn: 1,
  maxTurns: 10,
  seed: 7,
  spentUsd: 0.25,
  remainingBudgetUsd: 0.75,
}

{
  const script = [
    "let text = ''",
    "process.stdin.setEncoding('utf8')",
    "process.stdin.on('data', (chunk) => { text += chunk })",
    "process.stdin.on('end', () => {",
    "  const request = JSON.parse(text)",
    "  process.stdout.write(JSON.stringify({ input: request.context.turn === 1 ? 'left' : 'noop', costUsd: 0.125 }))",
    "})",
  ].join(';')
  const driver = createCliAgentDriver({
    command: process.execPath,
    args: ['-e', script],
    commands: ['left', 'right'],
    timeoutMs: 5_000,
  })
  const turn = await driver.act('FRAME', [], context)
  assert.deepEqual(turn, { input: 'left', costUsd: 0.125 })
}

{
  const script = "process.stdout.write(JSON.stringify({input:'left\\nright',costUsd:0}))"
  const driver = createCliAgentDriver({
    command: process.execPath,
    args: ['-e', script],
    commands: ['left', 'right'],
  })
  assert.equal((await driver.act('FRAME', [], context)).input, 'noop')
}

{
  const driver = createCliAgentDriver({
    command: process.execPath,
    args: ['-e', "process.stdout.write('x'.repeat(10000))"],
    maxOutputBytes: 100,
  })
  await assert.rejects(driver.act('FRAME', [], context), /exceeded 100 bytes/)
}

{
  let requestBody: Record<string, unknown> | undefined
  const fetchImpl: typeof globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'right' } }],
      usage: {
        prompt_tokens: 1_000,
        completion_tokens: 500,
        prompt_tokens_details: { cached_tokens: 400 },
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const driver = createOpenAICompatibleDriver({
    model: 'local-model',
    baseUrl: 'http://localhost:9999/v1/',
    fetch: fetchImpl,
    commands: ['left', 'right'],
    pricing: {
      inputPerMillionUsd: 1,
      cachedInputPerMillionUsd: 0.5,
      outputPerMillionUsd: 2,
    },
  })
  const turn = await driver.act('FRAME', [{ input: 'left', frame: 'OLD' }], context)
  assert.equal(turn.input, 'right')
  assert.ok(Math.abs(turn.costUsd - 0.0018) < 1e-12)
  assert.equal(requestBody?.model, 'local-model')
  assert.ok(Array.isArray(requestBody?.messages))
}

{
  const fetchImpl: typeof globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: 'not-a-command' } }],
  }), { status: 200 })
  const driver = createOpenAICompatibleDriver({
    model: 'local-model',
    fetch: fetchImpl,
    commands: ['left', 'right'],
  })
  assert.deepEqual(await driver.act('FRAME', [], context), { input: 'noop', costUsd: 0 })
}

console.log('playproof-drivers: CLI and OpenAI-compatible adapters green')
