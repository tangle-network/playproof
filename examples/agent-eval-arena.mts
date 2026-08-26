/**
 * Compare optimizers on a game, with the statistics the comparison needs.
 *
 * `compareOptimizationMethods` in `@tangle-network/agent-eval` already owns
 * everything hard here: disjoint train, selection and final-test scenarios,
 * bootstrap resamples, Bonferroni-adjusted simultaneous confidence across every
 * contrast, a shared cost ceiling, and a policy that refuses to score a final
 * test when the search history is incomplete.
 *
 * That machinery is the reason to route a game through it rather than tabulate
 * means. MEASURED on this repo's own three-profile study: the ranking read
 * cleanly as opus > sonnet > haiku, and a paired bootstrap over the same three
 * replicates put two of the three contrasts across zero. Only opus over haiku
 * survived. A table of means says one thing and an interval says another.
 *
 * Playproof supplies two things and nothing else: what a scenario IS, and what
 * a played game SCORED.
 *
 *   npx tsx examples/agent-eval-arena.mts
 */
import type { DispatchContext, JudgeConfig, Scenario } from '@tangle-network/agent-eval/campaign'
import { runCell } from '../matrix-run'
import type { CellResult } from '../matrix-run'
import type { MatrixCell } from '../matrix'

/** A cell of a matrix, addressed the way the optimizer addresses scenarios. */
export interface GameScenario extends Scenario {
  kind: 'playproof-game'
  cell: MatrixCell
}

/**
 * One cell becomes one scenario.
 *
 * `seedGroup` is the whole reason to bother: two surfaces carrying the same
 * value are handed the same seed for a given replicate, which makes the
 * comparison PAIRED. Without it two profiles are two unrelated samples of a
 * noisy game, and the interval has to absorb the game's variance twice.
 */
export function scenarioOf(cell: MatrixCell): GameScenario {
  return {
    id: `${cell.game.id}/${cell.objective.id}/${cell.protocol.id}/${cell.sensor.id}/seed${cell.seed}`,
    kind: 'playproof-game',
    tags: [cell.game.adapter, cell.game.target, cell.profile.transport],
    seedGroup: `${cell.game.id}:${cell.seed}`,
    cell,
  }
}

/**
 * Play a scenario and hand back the row.
 *
 * The surface is whatever the optimizer is searching — a prompt, a skill set, a
 * tool list, a policy file. It reaches the game only through the profile, so
 * nothing here needs to know which of the ten surfaces is being moved.
 */
export function dispatchWithSurface(
  materialize: (surface: unknown, cell: MatrixCell) => MatrixCell,
): (surface: unknown, scenario: GameScenario, ctx: DispatchContext) => Promise<CellResult> {
  return async (surface, scenario, ctx) =>
    runCell(materialize(surface, scenario.cell), { signal: ctx.signal })
}

/**
 * Score a played game.
 *
 * A judge is a FUNCTION, not an LLM prompt, and this one is deterministic: the
 * game already produced the number. Composite is the score the objective named,
 * oriented so higher is better, because the optimizer maximizes.
 *
 * A blocked cell THROWS. A cell that could not be built did not play badly, and
 * folding it into a zero would let an unbuildable clock look like a bad
 * candidate — which is the one thing this repo refuses everywhere else.
 */
export const gameJudge: JudgeConfig<CellResult, GameScenario> = {
  name: 'playproof-score',
  judgeVersion: 'score-v1',
  dimensions: [
    { key: 'score', description: 'the evidence channel the objective names, oriented so higher is better' },
    { key: 'verified', description: 'milestones the replay reproduced, over the contract total' },
  ],
  score: ({ artifact }) => {
    if (artifact.status !== 'played') {
      throw new Error(`cell did not play: ${artifact.blocked?.reason} — ${artifact.blocked?.detail}`)
    }
    if (artifact.replayDivergence) {
      throw new Error('the run did not reproduce when replayed from its own input log')
    }
    const raw = artifact.score ?? 0
    const oriented = artifact.scoreDirection === 'minimize' ? -raw : raw
    const total = artifact.milestones.total
    return {
      dimensions: {
        score: oriented,
        verified: total === 0 ? 0 : artifact.milestones.verified / total,
      },
      composite: oriented,
      notes: `${artifact.scoreField ?? 'score'}=${artifact.score ?? 'none'}`
        + ` over ${artifact.decisions} decisions;`
        + ` ${artifact.milestones.verified} of ${total} milestones;`
        + ` ${artifact.usd === null ? 'unmetered' : `$${artifact.usd.toFixed(4)}`}`
        + `${artifact.transportNote === null ? '' : `; ${artifact.transportNote}`}`,
    }
  },
}
