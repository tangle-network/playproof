import { strict as assert } from 'node:assert'
import { createCliAgentDriver, renderCliAgentPrompt } from './drivers/cli'
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

{
  // Campaign guidance reaches the CLI JSON request only when a supervisor set it.
  const script = [
    "let text = ''",
    "process.stdin.setEncoding('utf8')",
    "process.stdin.on('data', (chunk) => { text += chunk })",
    "process.stdin.on('end', () => {",
    "  const request = JSON.parse(text)",
    "  const guided = Object.hasOwn(request.context, 'guidance') && request.context.guidance === 'hug the left wall'",
    "  process.stdout.write(JSON.stringify({ input: guided ? 'left' : 'right', costUsd: 0 }))",
    "})",
  ].join(';')
  const driver = createCliAgentDriver({
    command: process.execPath,
    args: ['-e', script],
    commands: ['left', 'right'],
    timeoutMs: 5_000,
  })
  const guided = await driver.act('FRAME', [], { ...context, guidance: 'hug the left wall' })
  assert.equal(guided.input, 'left')
  const plain = await driver.act('FRAME', [], context)
  assert.equal(plain.input, 'right')
}

{
  // The rendered CLI prompt carries guidance verbatim and omits the line otherwise.
  const request = {
    schemaVersion: 1 as const,
    frame: 'FRAME',
    history: [],
    context: { ...context, guidance: 'stop farming the corner' },
  }
  const guided = renderCliAgentPrompt(request, ['left', 'right'])
  assert.ok(guided.includes('Supervisor guidance:\nstop farming the corner'))
  const plain = renderCliAgentPrompt({ ...request, context }, ['left', 'right'])
  assert.ok(!plain.includes('Supervisor guidance:'))
}

{
  // The OpenAI-compatible prompt carries guidance in the user message.
  let body: { messages?: { role: string; content: string }[] } | undefined
  const fetchImpl: typeof globalThis.fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body)) as { messages?: { role: string; content: string }[] }
    return new Response(JSON.stringify({ choices: [{ message: { content: 'left' } }] }), { status: 200 })
  }
  const driver = createOpenAICompatibleDriver({
    model: 'local-model',
    fetch: fetchImpl,
    commands: ['left', 'right'],
  })
  await driver.act('FRAME', [], { ...context, guidance: 'push toward the exit' })
  const guided = body?.messages?.find((message) => message.role === 'user')?.content ?? ''
  assert.ok(guided.includes('Supervisor guidance:\npush toward the exit'))
  await driver.act('FRAME', [], context)
  const plain = body?.messages?.find((message) => message.role === 'user')?.content ?? ''
  assert.ok(!plain.includes('Supervisor guidance:'))
}

console.log('playproof-drivers: CLI and OpenAI-compatible adapters green')
