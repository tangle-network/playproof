/**
 * Production execution entrypoint: run one benchmark through the shared
 * episode engine, capture every driver decision, and emit a signed publication
 * envelope.
 */
import type { KeyLike } from 'node:crypto'
import { makeRunEnvelope, signRunEnvelope, type SignedRunEnvelope, type RunEnvelope } from './artifact'
import type { BenchmarkTarget } from './platform'
import type { InputLog } from './runtime'
import { playEpisode, type AgentDriver, type DriverTurn, type EpisodeRecord } from './episode'
import { contractHash } from './schema'

export interface ExecuteBenchmarkOptions {
  budgetUsd: number
  maxTurns: number
  seed?: number
  /** End the run as soon as the game declares itself over. Off by default. */
  stopAtGameOver?: boolean
  signal?: AbortSignal
  actor: RunEnvelope['actor']
  signer: {
    privateKey: KeyLike
    keyId: string
  }
  createdAt?: string
}

export interface ExecutedBenchmark {
  record: EpisodeRecord
  log: InputLog
  signed: SignedRunEnvelope
}

export async function executeBenchmark<S>(
  target: BenchmarkTarget<S>,
  driver: AgentDriver,
  options: ExecuteBenchmarkOptions,
): Promise<ExecutedBenchmark> {
  const turns: DriverTurn[] = []
  const recordingDriver: AgentDriver = {
    act: async (frame, history, context) => {
      const turn = await driver.act(frame, history, context)
      turns.push({ input: turn.input, costUsd: turn.costUsd })
      return turn
    },
  }
  const seed = options.seed ?? 0
  const { record, log } = await playEpisode(
    target.game,
    target.contract,
    recordingDriver,
    options.budgetUsd,
    options.maxTurns,
    seed,
    options.signal,
    { ...(options.stopAtGameOver === undefined ? {} : { stopAtGameOver: options.stopAtGameOver }) },
  )
  if (turns.length !== record.latencyMs.length || turns.length !== log.inputs().length) {
    throw new Error(`decision capture mismatch: turns=${turns.length} latency=${record.latencyMs.length} log=${log.inputs().length}`)
  }
  const envelope = makeRunEnvelope({
    gameId: target.game.id,
    gameBuild: target.build,
    contractHash: contractHash(target.contract),
    platform: target.platform,
    actor: options.actor,
    seed,
    limits: { budgetUsd: options.budgetUsd, maxTurns: options.maxTurns },
    decisions: turns.map((turn, index) => ({
      turn: index + 1,
      input: turn.input,
      latencyMs: record.latencyMs[index]!,
      costUsd: turn.costUsd,
    })),
    claimed: record.verified,
    ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt }),
  })
  return { record, log, signed: signRunEnvelope(envelope, options.signer.privateKey, options.signer.keyId) }
}
