/**
 * The two joins between playproof and the optimizer in agent-runtime.
 *
 * `improve` searches an agent profile over ten surfaces: prompt, skills, tools,
 * mcp, hooks, subagents, agent-profile, memory, code and rollout-policy. It
 * partitions scenarios into train, selection and final test, seals a digest of
 * each split into the lineage, and reports a lift with a simultaneous
 * paired-bootstrap interval. None of that is game-specific and none of it needs
 * to be rebuilt here.
 *
 * What it cannot know is whether a program plays a game well. These two
 * functions are that, and nothing more.
 *
 * This file exists to be COMPILED. It is the proof that the shapes line up, so
 * a change on either side that breaks the join fails the typecheck instead of
 * failing a study three hours in.
 */
import type { Verifier, VerifyResult } from '@tangle-network/agent-runtime'
import type { Scenario } from '@tangle-network/agent-eval/campaign'
import { playCandidate } from '../hillclimb'
import { makeNative2048, NATIVE_2048_INPUTS } from '../adapters/native-2048'
import type { MatrixCell } from '../matrix'

// 1. A playproof cell is a Scenario. `seedGroup` is what makes two profiles on
//    the same game a PAIRED comparison instead of two unrelated samples.
export function cellAsScenario(cell: MatrixCell): Scenario {
  return {
    id: `${cell.game.id}/${cell.objective.id}/${cell.protocol.id}/${cell.sensor.id}/seed${cell.seed}`,
    kind: 'playproof-game',
    tags: [cell.game.adapter, cell.game.target],
    seedGroup: `${cell.game.id}:${cell.seed}`,
  }
}

// 2. Playing a candidate is a Verifier the shot loop can climb.
export const gameVerifier: Verifier = async (worktreePath): Promise<VerifyResult> => {
  const attempt = await playCandidate(worktreePath, {
    build: () => {
      const a = makeNative2048(0)
      return { game: a.game, contract: a.contract, commands: NATIVE_2048_INPUTS, dispose: a.dispose }
    },
    policyPath: 'policy',
    horizon: 400,
    seed: 0,
    scoreField: 'score',
    target: 2048,
  })
  return {
    ok: attempt.ok,
    keepGoing: attempt.keepGoing,
    ...(attempt.score === null ? {} : { score: attempt.score }),
    feedback: attempt.feedback,
  }
}
