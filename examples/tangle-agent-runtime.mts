import {
  runAgentTaskStream,
  type AgentExecutionBackend,
  type RuntimeStreamEvent,
} from '@tangle-network/agent-runtime'
import {
  renderCliAgentPrompt,
  type AgentDriver,
  type CliAgentRequest,
} from '../index'

/**
 * Adapt any Tangle Runtime backend—local iterable, CLI bridge, sandbox, or
 * remote gateway—into Playproof's deliberately smaller decision interface.
 */
export function createTangleRuntimeDriver(options: {
  backend: AgentExecutionBackend
  commands: readonly string[]
  costUsd: (events: readonly RuntimeStreamEvent[]) => number
  parseInput?: (text: string) => string
}): AgentDriver {
  return {
    async act(frame, history, context) {
      const request: CliAgentRequest = {
        schemaVersion: 1,
        frame,
        history,
        context: {
          turn: context.turn,
          maxTurns: context.maxTurns,
          seed: context.seed,
          spentUsd: context.spentUsd,
          remainingBudgetUsd: context.remainingBudgetUsd,
        },
      }
      const prompt = renderCliAgentPrompt(request, options.commands)
      const events: RuntimeStreamEvent[] = []
      let text = ''
      for await (const event of runAgentTaskStream({
        task: {
          id: `playproof-turn-${context.turn}`,
          intent: prompt,
          domain: 'game-benchmark',
          metadata: {
            playproofTurn: context.turn,
            remainingBudgetUsd: context.remainingBudgetUsd,
          },
        },
        backend: options.backend,
        input: { message: prompt },
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      })) {
        events.push(event)
        if (event.type === 'text_delta') text += event.text
        if (event.type === 'backend_error') throw new Error(event.message)
        if (event.type === 'final' && event.status !== 'completed') {
          throw new Error(`Runtime agent failed: ${event.reason}`)
        }
      }
      const raw = options.parseInput?.(text) ?? text.trim().split(/\s+/u)[0] ?? ''
      const input = options.commands.includes(raw) ? raw : 'noop'
      const costUsd = options.costUsd(events)
      if (!Number.isFinite(costUsd) || costUsd < 0) throw new Error('Runtime costUsd must be non-negative')
      return { input, costUsd }
    },
  }
}
