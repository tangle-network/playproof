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
      observation?: {
        text: string
        images?: readonly {
          mediaType: 'image/png' | 'image/jpeg'
          base64: string
          width: number
          height: number
          label?: string
        }[]
      }
      signal?: AbortSignal
    },
  ): Promise<{ input: string; costUsd: number }>
}
```

The benchmark owns game execution, privileged evidence, milestone verification, accounting, and the signed run artifact. The driver sees only the observation channel and its own prior trajectory.

`context.observation` is that channel in full. `observation.text` is exactly the `frame` argument, so a text-only driver ignores the field and behaves as it always did. `observation.images` is present only when the game publishes pixels; see the observation-channel section of the README for the caps and the reason history stays text only.

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

### Sending screen images

```ts
const driver = createOpenAICompatibleDriver({ model: 'your-model', vision: true, imageDetail: 'high' })
```

`vision` is off by default, because images are billed as tokens and an existing caller must not start paying for them silently. With it on and an observation that carries images, the user message becomes content parts:

```json
[
  { "type": "text", "text": "Decision 3 of 100 …" },
  { "type": "image_url", "image_url": { "url": "data:image/png;base64,…", "detail": "high" } }
]
```

An image `label` becomes its own text part immediately before the picture. With vision off, or on a turn whose observation has no images, the request is the single string it always was.

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

With `vision: true`, the request gains an `images` key for the turn's rendered screens and nothing else changes:

```json
{
  "images": [
    { "mediaType": "image/png", "base64": "iVBORw0KGgo…", "width": 480, "height": 630, "label": "screen" }
  ]
}
```

The key is absent when vision is off or the turn has no pixels, so a CLI written against the current request keeps receiving the current request. `vision: true` requires `stdin: 'json'` and fails at construction otherwise, because the rendered prompt is a text protocol that cannot carry an image.

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
