# Agent drivers

Playproof evaluates behavior, not SDK allegiance. An agent is anything that implements:

```ts
interface AgentDriver {
  act(
    frame: string,
    history: readonly { input: string; frame: string }[],
    context: {
      turn: number
      maxTurns: number
      seed: number
      spentUsd: number
      remainingBudgetUsd: number
      guidance?: string
      signal?: AbortSignal
    },
  ): Promise<{ input: string; costUsd: number }>
}
```

The benchmark owns game execution, privileged evidence, milestone verification, accounting, and the signed run artifact. The driver sees only the observation channel and its own prior trajectory.

## A plain callback

```ts
const driver: AgentDriver = {
  async act(frame, history, context) {
    const input = myPolicy(frame, history)
    return { input, costUsd: 0 }
  },
}
```

This is enough for a local policy, a remote service, a reinforcement-learning policy, a browser agent, or a custom multi-agent system.

## OpenAI-compatible HTTP

```ts
import { createOpenAICompatibleDriver } from '@tangle-network/playproof/drivers/openai-compatible'

const driver = createOpenAICompatibleDriver({
  baseUrl: 'https://your-endpoint.example/v1',
  apiKey: process.env.AGENT_API_KEY,
  model: 'your-model',
  commands: ['up', 'down', 'left', 'right', 'a', 'b'],
  pricing: {
    inputPerMillionUsd: 1,
    outputPerMillionUsd: 4,
  },
})
```

The driver uses Chat Completions-compatible `POST /chat/completions`, bounds response bytes and wall time, exposes the remaining benchmark budget to the model, and computes cost only from a server-returned cost field or caller-supplied pricing. Missing pricing remains zero and should be treated as unavailable by studies that require complete cost coverage.

## Any CLI or coding harness

```ts
import { createCliAgentDriver } from '@tangle-network/playproof/drivers/cli'

const driver = createCliAgentDriver({
  command: '/opt/my-agent',
  args: ['--one-turn'],
  stdin: 'json',
  output: 'json',
  commands: ['left', 'right'],
  timeoutMs: 120_000,
  maxOutputBytes: 2 << 20,
})
```

Each invocation receives one JSON object on stdin:

```json
{
  "schemaVersion": 1,
  "frame": "...",
  "history": [{ "input": "left", "frame": "..." }],
  "context": {
    "turn": 2,
    "maxTurns": 100,
    "seed": 0,
    "spentUsd": 0.02,
    "remainingBudgetUsd": 0.98
  }
}
```

It returns:

```json
{ "input": "right", "costUsd": 0.004 }
```

The process is spawned without a shell. Command arguments, stdin mode, output bytes, wall time, and accepted game inputs are explicit. A plain first-word output mode is also available for existing CLIs.

## Claude Code

Claude Code can be used through the generic CLI driver; Playproof does not require an Anthropic dependency:

```ts
const driver = createCliAgentDriver({
  command: 'claude',
  args: (request) => [
    '-p',
    renderCliAgentPrompt(request, commands),
    '--output-format', 'text',
    '--max-turns', '1',
  ],
  stdin: 'none',
  output: 'first-word',
  commands,
})
```

See `examples/claude-code-cli.mts` for a complete benchmark wrapper. The same pattern works for Codex CLI, OpenCode, Pi, shell-based policies, and proprietary harnesses.

## Tangle Agent Runtime

The runtime stays optional. Supply any `AgentExecutionBackend` to `runAgentTaskStream`, collect the resulting text and measured events, then return one Playproof action. The full adapter is in `examples/tangle-agent-runtime.mts`.

This separation is intentional:

- Playproof owns benchmark semantics and evidence.
- The runtime owns agent execution and orchestration.
- The caller owns the backend, profile, model access, and pricing.

## Budget semantics

`remainingBudgetUsd` lets a driver set a provider-side request cap before it spends. Playproof records the actual reported cost even when a provider overruns that reservation. A true hard dollar ceiling therefore requires the driver or upstream provider to enforce the supplied remaining budget; the benchmark never falsifies accounting to make a run appear compliant.

## Campaign guidance

`context.guidance` is present only in a long-horizon campaign, and only after a supervisor or an analyst left a note.
It is the latest note, not a transcript, and it is out-of-band context: it never enters the hash-chained input log and it never grants progress.

The built-in drivers pass it on without changing their response protocols.
The CLI driver adds `guidance` to the JSON request context.
The OpenAI-compatible driver and `renderCliAgentPrompt` add a `Supervisor guidance:` line to the prompt.
A custom driver may use it, weight it, or ignore it.

See the campaign section of the README for the segment, steering, and resume model.

## Driver safety rules

- Return exactly one input per decision.
- Report actual non-negative cost, or clearly use zero only for genuinely free/unpriced execution.
- Never read privileged evidence from the benchmark adapter.
- Treat abort signals and timeouts as hard stops.
- Bound remote responses and subprocess output.
- Keep credentials in the driver environment; signed artifacts contain decisions and evidence, not API keys.
