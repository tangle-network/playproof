/**
 * Playproof runtime — deterministic game core, hash-chained input log, replay.
 *
 * A Game is a PURE state machine: step() is the only transition, frame() is the
 * observation the agent sees, evidence() is the privileged channel only the
 * harness reads. Purity is what makes replay verification sound: the same seed
 * plus the same input log must always produce the same evidence, so any claimed
 * progression the replay cannot reproduce is a cheat or a harness bug.
 */

export type Input = string

/** Privileged evidence snapshot, recomputed by the verifier — never trusted from the run. */
export interface Evidence {
  engineState?: Record<string, number>
  saveBlobHash?: string
  /** Normalized fields parsed from persisted state; supports semantic progress across distinct valid trajectories. */
  saveState?: Record<string, number>
  logEvents?: string[]
  frameHash?: string
  /** Normalized fields derived from the rendered observation, not from engine memory. */
  frameState?: Record<string, number>
}

export interface Game<S> {
  id: string
  init(seed: number): S
  /** Pure transition. Unknown inputs are no-ops (agent typos are not cheats). */
  step(state: S, input: Input): S
  /** The observation channel the agent receives each turn. */
  frame(state: S): string
  /** Privileged progression channel — harness-side only. */
  evidence(state: S): Evidence
}

/** FNV-1a 32-bit, hex. Not cryptographic; suffices for deterministic state identity. */
export function hashString(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * Tamper-evident input log: each entry stores the chained hash of everything
 * before it, so an in-place edit of a recorded entry desynchronizes entries
 * from the chain and is detected on chainValid().
 *
 * Threat scope (kept honest): the hash is public FNV-1a with no secret, so an
 * adversary who can recompute the whole chain can forge a consistent one.
 * The chain guards accidental mutation and harness-side tampering, NOT a
 * capable adversary. Published or remotely submitted runs use the signed
 * envelope in artifact.ts; replay recomputation remains the strongest proof
 * whenever the verifier controls deterministic execution.
 */
export class InputLog {
  private readonly entries: Input[] = []
  private readonly chain: string[] = []
  private genesis: string

  constructor(genesisSeed: number) {
    this.genesis = hashString(`playproof-genesis:InputLog:${genesisSeed}`)
  }

  add(input: Input): void {
    this.entries.push(input)
    const prev = this.chain.length === 0 ? this.genesis : this.chain[this.chain.length - 1]!
    this.chain.push(hashString(`${prev}|${input}`))
  }

  inputs(): readonly Input[] {
    return this.entries
  }

  head(): string | null {
    return this.chain.length === 0 ? null : this.chain[this.chain.length - 1]!
  }

  /** Recompute the chain; false means the log was edited after the run. */
  chainValid(): boolean {
    let prev = this.genesis
    for (let i = 0; i < this.entries.length; i++) {
      const expect = hashString(`${prev}|${this.entries[i]}`)
      if (expect !== this.chain[i]) return false
      prev = expect
    }
    return true
  }
}

/** Re-execute a log from a seed. The single source of truth for verification. */
export function replay<S>(game: Game<S>, seed: number, log: InputLog): S {
  let state = game.init(seed)
  for (const input of log.inputs()) state = game.step(state, input)
  return state
}

/** Build a log from a literal input script (authoring and calibration). */
export function logFrom(seed: number, inputs: Input[]): InputLog {
  const log = new InputLog(seed)
  for (const i of inputs) log.add(i)
  return log
}
