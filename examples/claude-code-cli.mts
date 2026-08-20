import type { KeyLike } from 'node:crypto'
import {
  createCliAgentDriver,
  executeBenchmark,
  renderCliAgentPrompt,
  type BenchmarkTarget,
} from '../index'

/**
 * Claude Code supports non-interactive print mode with `claude -p`.
 * The harness is invoked once per game decision and is not granted game-state
 * access beyond the observation embedded in the prompt.
 */
export async function runClaudeCodeAgent<S>(options: {
  target: BenchmarkTarget<S>
  privateKey: KeyLike
  commands: readonly string[]
  claudeCommand?: string
  cwd?: string
  model?: string
  measureCostUsd?: (durationMs: number) => number
}): Promise<void> {
  const driver = createCliAgentDriver({
    command: options.claudeCommand ?? 'claude',
    args: (request) => [
      '-p',
      renderCliAgentPrompt(request, options.commands),
      '--output-format',
      'text',
      '--max-turns',
      '1',
      ...(options.model === undefined ? [] : ['--model', options.model]),
    ],
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    stdin: 'none',
    output: 'first-word',
    commands: options.commands,
    timeoutMs: 180_000,
    maxOutputBytes: 1 << 20,
    ...(options.measureCostUsd === undefined
      ? { fixedCostUsd: 0 }
      : { costUsd: (run) => options.measureCostUsd!(run.durationMs) }),
  })

  const result = await executeBenchmark(options.target, driver, {
    budgetUsd: 1,
    maxTurns: 100,
    actor: { kind: 'agent', id: 'claude-code-cli' },
    signer: { privateKey: options.privateKey, keyId: 'benchmark-recorder-v1' },
  })
  console.log(result.record)
}
