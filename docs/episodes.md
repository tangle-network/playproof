# When an episode ends

## When an episode ends

An episode has three stop conditions, and the record names the one that fired.

| `record.stoppedBy` | What happened |
|---|---|
| `maxTurns` | The turn limit was reached. |
| `budget` | The dollar budget was reached. |
| `gameOver` | The game reported that it is finished. |

The game-over stop is opt-in.

```ts
const { record } = await playEpisode(game, contract, driver, budgetUsd, maxTurns, seed, signal, {
  stopAtGameOver: true,
})
// record.stoppedBy === 'gameOver'
// record.gameOver === true
```

`runCampaign` and `executeBenchmark` take the same `stopAtGameOver` option.

It is off by default because episode length is a denominator.
Rounds of one study compare only while every round played to the same turn limit, so shortening an episode is the caller's decision, taken once for a whole series.

Every record also carries `gameOver`, armed or not.
It is `true` when the game was finished at the last state of the run, `false` when it was not, and `null` when the game declares no terminal state at all.
A record that reports `stoppedBy: 'maxTurns'` next to `gameOver: true` is a run that kept paying for decisions after the game ended.

A game declares the end of play with the optional `over(state)` member.

```ts
const game: Game<MyState> = {
  // ...
  evidence: (s) => s.evidence,
  over: (s) => s.evidence.engineState?.terminal === 1,
}
```

`over` must be pure, like `step`, because a verifier recomputes the final state from the seed and the input log and asks again.
A game that omits it is never over, so every adapter written before this member keeps its behaviour.
`adapters/ale`, `adapters/gymnasium`, `adapters/stable-retro`, and `adapters/native-2048` implement it over the terminal flag their worker already publishes.

The stop is an exit from the decision loop, not an abort.
The attestation runs, and the record verifies by replay exactly as a turn-limited one does.
Aborting through `signal` is a different thing: it throws inside the loop, before the record is built, and leaves nothing to grade.

### Measured

ALE Breakout, ale-py 0.12.1, seed 0, 300 turns, one scripted policy that opens the first rung of the ladder and then loses every life:

| Run | Decisions | `stoppedBy` | `gameOver` | Milestones |
|---|---|---|---|---|
| turn limit | 300 | `maxTurns` | `true` | 1 of 7 |
| game-over stop | 150 | `gameOver` | `true` | 1 of 7 |

The 150 dropped decisions are inert, not merely unproductive.
The ALE worker breaks out of its action-repeat loop once the game is over, so every evidence channel is byte-identical from decision 150 to decision 300.
Gymnasium FrozenLake behaves the same way: 6 decisions instead of 26, with 3 of 3 milestones either way.

