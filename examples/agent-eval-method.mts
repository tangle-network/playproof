/**
 * A complete optimization method for a game, in the shape the comparator takes.
 *
 * `compareOptimizationMethods` runs several of these on disjoint train,
 * selection and final-test scenarios and reports each one's lift over the
 * baseline with a simultaneous, Bonferroni-adjusted bootstrap interval. The
 * point of writing a method rather than a loop is that the comparator can then
 * answer a question a single run cannot: whether one way of searching beats
 * another by more than the game's own noise.
 *
 * This is the simplest honest method. It authors N candidate programs, scores
 * each on the SELECTION scenarios, and keeps the best. The final-test partition
 * is never touched, which is the one rule a method may not break.
 */
import type {
  ComparisonCost,
  OptimizationMethod,
  OptimizationMethodResult,
} from '@tangle-network/agent-eval/campaign'
import type { CellResult } from '../matrix-run'
import type { GameScenario } from './agent-eval-arena.mts'

/**
 * Author one candidate and return where its program landed.
 *
 * Supplied by the caller because building a player is the expensive, credential
 * -carrying half, and a method should not decide how an agent is run.
 */
export type AuthorCandidate = (attempt: number) => Promise<{
  /** Path of the program the agent left behind. */
  policy: string
  usd: number | null
  /** `oauth` bills a plan and reports no per-request figure. */
  authMode: 'api-key' | 'oauth' | null
}>

/**
 * State the spend honestly, including when it cannot be known.
 *
 * A plan-billed agent reports no per-request cost, so its absence is recorded
 * as INCOMPLETE ACCOUNTING rather than folded into a total as zero. A
 * comparison that sums an unbilled arm to zero reports the arm nobody could
 * meter as the cheapest one.
 */
function costOf(spends: readonly { usd: number | null; authMode: string | null }[]): ComparisonCost {
  const known = spends.filter((s) => s.usd !== null)
  const unbilled = spends.filter((s) => s.usd === null)
  const total = known.reduce((sum, s) => sum + (s.usd ?? 0), 0)
  return {
    totalCostUsd: total,
    // The union refuses to call a partial sum observed. An arm nobody could
    // meter makes the whole total `uncaptured`, which is the correct claim: a
    // known subtotal is not a total, and reporting it as one would make the
    // unmetered arm the cheapest.
    costProvenance: unbilled.length === 0 ? { kind: 'observed', usd: total } : { kind: 'uncaptured', usd: null },
    accountingComplete: unbilled.length === 0,
    incompleteReasons: unbilled.length === 0
      ? []
      : [`${unbilled.length} of ${spends.length} candidates billed a plan`
        + ` (${[...new Set(unbilled.map((s) => s.authMode ?? 'unknown'))].join(', ')})`
        + ' and reported no per-request cost'],
  }
}

/**
 * Author `attempts` players, keep the one that scores best on selection.
 *
 * Candidates are scored ONLY on the selection partition. Reading the final test
 * to choose a winner is how a comparison reports a lift it did not earn, and it
 * is the reason the comparator hands a method two partitions instead of one.
 */
export function bestOfN(
  attempts: number,
  author: AuthorCandidate,
): OptimizationMethod<GameScenario, CellResult> {
  return {
    name: `best-of-${attempts}`,
    optimize: async (input): Promise<OptimizationMethodResult> => {
      const spends: { usd: number | null; authMode: string | null }[] = []
      let best: { policy: string; mean: number } | null = null

      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        input.runOptions.signal?.throwIfAborted?.()
        const built = await author(attempt)
        spends.push({ usd: built.usd, authMode: built.authMode })

        const scored: number[] = []
        for (const scenario of input.selectionScenarios) {
          const row = await input.dispatchWithSurface(built.policy, scenario, {
            cellId: `${scenario.id}#${attempt}`,
          } as Parameters<typeof input.dispatchWithSurface>[2])
          // A cell that could not be built did not play badly. Skipping it
          // keeps an unbuildable clock from reading as a weak candidate.
          if (row.status === 'played' && row.score !== null) scored.push(row.score)
        }
        if (scored.length === 0) continue

        const mean = scored.reduce((a, b) => a + b, 0) / scored.length
        if (best === null || mean > best.mean) best = { policy: built.policy, mean }
      }

      if (best === null) {
        throw new Error(`${attempts} candidates were authored and none produced a scoreable run`)
      }
      return { winnerSurface: best.policy, cost: costOf(spends) }
    },
  }
}
