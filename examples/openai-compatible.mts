import type { KeyLike } from 'node:crypto'
import {
  createOpenAICompatibleDriver,
  executeBenchmark,
  type BenchmarkTarget,
} from '../index'

export async function runOpenAICompatibleAgent<S>(options: {
  target: BenchmarkTarget<S>
  privateKey: KeyLike
  apiKey: string
  model: string
  baseUrl?: string
  commands: readonly string[]
}): Promise<void> {
  const driver = createOpenAICompatibleDriver({
    model: options.model,
    apiKey: options.apiKey,
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    commands: options.commands,
    // Supply current provider pricing when exact dollar accounting is required.
    // Without pricing or a server-returned cost field, cost remains honestly 0.
  })

  const result = await executeBenchmark(options.target, driver, {
    budgetUsd: 1,
    maxTurns: 100,
    actor: { kind: 'agent', id: `openai-compatible:${options.model}` },
    signer: { privateKey: options.privateKey, keyId: 'benchmark-recorder-v1' },
  })
  console.log(result.signed)
}
