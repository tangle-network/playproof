# Long-horizon runs

## Long-horizon runs: segments, steering, resume, analysts

A campaign is one episode played in segments.
Between two segments an analyst can read the progress so far, a human can leave a note, and the process can exit and come back later.

```ts
import { existsSync } from 'node:fs'
import { loadLedger, runCampaign, saveLedger } from '@tangle-network/playproof'

const path = 'campaign.json'
const resumed = existsSync(path) ? await loadLedger(path) : undefined

const { record, ledger, log } = await runCampaign(game, contract, driver, {
  budgetUsd: 25,
  maxTurns: 5_000,
  segmentTurns: 50,
  ...(resumed === undefined ? {} : { ledger: resumed }),
  analyst: async (report) => ({
    summary: `segment ${report.segment}: ${report.verifiedSoFar.length} verified`,
    recommendation: report.newMilestones.length > 0 ? 'continue' : 'steer',
    guidance: 'stop farming the corner; open the right column',
  }),
  steer: async (report, analysis) => readOperatorNote(),
  onLedger: async (current) => saveLedger(path, current),
})
```

- **Segments.** `segmentTurns` decisions run, then the hooks get a `SegmentReport`: new milestones, verified progress, spend, remaining budget, the last frame, the recent trajectory, and this segment's latencies.
- **Steering.** A note reaches the next segment as `context.guidance`. Explicit steering outranks the analyst. A `stop` from either ends the run, and the segment records which one stopped it.
- **Resume.** `onLedger` is the persistence hook. Save the ledger, and any later process can pass it back to `runCampaign` to continue the same run. Resume replays the recorded inputs from the seed, so the milestone tracker, the trajectory, and the spend match a continuous run.
- **Fail closed.** A ledger that disagrees with itself, or that pins a different game, seed, contract hash, budget, or turn limit, is rejected instead of resumed.

The invariant the test suite pins:

> A campaign run in K segments, with a save, a reload, and a new `runCampaign` call between each, produces the same `log.head()`, the same `verified` list, and the same `spentUsd` as one continuous `playEpisode` with the same driver, seed, contract, budget, and turn limit.

The record `runCampaign` returns covers the whole campaign, not the last segment, because the attestation replays the complete input log.
`examples/tangle-agent-runtime-campaign.mts` runs the loop with one agent per decision and one analyst task per segment.

