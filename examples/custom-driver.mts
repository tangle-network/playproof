import type { KeyLike } from 'node:crypto'
import {
  executeBenchmark,
  type AgentDriver,
  type BenchmarkTarget,
} from '../index'

/** Any function, service, model, or policy can satisfy this three-argument seam. */
export async function runCustomAgent<S>(
  target: BenchmarkTarget<S>,
  privateKey: KeyLike,
): Promise<void> {
  const driver: AgentDriver = {
    async act(frame, history, context) {
      const input = chooseAction({ frame, history, remainingUsd: context.remainingBudgetUsd })
      return { input, costUsd: 0 }
    },
  }

  const result = await executeBenchmark(target, driver, {
    budgetUsd: 1,
    maxTurns: 100,
    actor: { kind: 'agent', id: 'custom-policy-v1' },
    signer: { privateKey, keyId: 'local-recorder-v1' },
  })
  console.log(result.record.verified)
}

function chooseAction(_observation: unknown): string {
  return 'noop'
}
