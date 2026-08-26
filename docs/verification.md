# Verification and evidence

## Verification modes

Different platforms provide different proof strengths. Playproof records the distinction instead of collapsing everything into “supported.”

| Mode | Hard statement | Appropriate targets | Limit |
|---|---|---|---|
| `replay` | A verifier-owned execution reproduced each milestone from the pinned build, seed, and inputs. | Deterministic emulators and games | Determinism must be continuously calibrated. |
| `trusted-recorder` | The named recorder signed the inputs, accounting, observations, and evidence it captured. | Ordinary native desktop games | The recorder boundary is trusted; state is not independently reproduced. |
| `platform-attested` | A signed recorder captured normalized progress from a named platform API or title-side SDK and pinned the raw-response digest. | Steam or Xbox API/SDK reads | This is not a Steam/Microsoft signature unless an adapter verifies a provider-signed proof. |

A benchmark declaration that cannot support its selected mode is rejected before execution.

## Evidence and milestone contracts

Milestones can use:

- normalized engine state;
- normalized save data;
- exact save identity;
- append-only events;
- normalized fields derived from a rendered frame;
- exact rendered identity; or
- baseline-to-final platform achievements and statistics.

Use semantic checks such as `score >= 10` for progression. Exact hashes identify one specific save or frame and should not define a semantic milestone when multiple valid trajectories can reach the same outcome.

Dependencies between milestones form a declared partial order. A later achievement cannot verify before its prerequisites, even when its raw condition already holds.

### Legible checks and opaque ones

A hash check identifies a **state**, not a trajectory.
Many trajectories reach one state, so a hash is an achievement like any other and an independent policy earns it by playing.
What a hash cannot do is tell a reader what it demands.

- A **legible** check is a threshold, a normalized field, or an event. A reader sees what the milestone asks for and can judge whether reaching it is progress.
- An **opaque** check is a hash. It names one exact state without saying which, so nobody reading the contract can weigh the point.

Legibility is derived from the check kind, so no contract changes and no author has to remember to set it.
`save-hash` and `frame-hash` are opaque; `state-path`, `save-path`, `frame-path`, and `log-contains` are legible.
`requires` is followed: a legible check gated behind a hash still demands something a reader cannot see.

```ts
import { contractLegibility, formatMilestoneScore } from '@tangle-network/playproof'

contractLegibility(contract)
// { legible: ['score-opened', 'life-lost'],
//   opaque: ['frame-at-first-score', 'save-at-first-score'],
//   reasons: { 'frame-at-first-score': 'its frame-hash check states its requirement as a hash, …' } }

formatMilestoneScore(record.score) // '3 of 4'
```

The contract above is the demonstration contract in `ale.test.mts`, not the packaged Breakout one.
The packaged contract states no hash at all, for the measured reason two sections below.

Every milestone is a point, hashes included, so the denominator of a score is the contract's milestone count.
`Attestation` and `EpisodeRecord` carry `verified` and `score`; a campaign segment report carries `scoreSoFar`.

Replay attestation is a different mechanism and is untouched.
The input-log hash chain is what proves a replay reproduced a recorded run.
A milestone hash never proved that, because many logs reach the same state.

## Signed publication artifacts

A signed run pins:

- contract hash;
- game and exact build digest;
- platform and verification mode;
- actor identity and seed;
- budget and turn limits;
- every input, latency, and reported cost;
- decision-chain hashes; and
- claimed milestones.

A capable attacker may rebuild every public hash after editing a run, but cannot forge the recorder’s Ed25519 signature or key identity. Deterministic replay remains stronger than recorder trust whenever the verifier owns a reproducible execution.

