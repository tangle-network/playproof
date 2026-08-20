/**
 * Deterministic checkpoint-frontier exploration.
 *
 * Unlike a greedy novelty walk, this keeps several saved branches alive. A
 * dead-end or attractive menu animation therefore cannot permanently consume
 * the only trajectory. The result remains a plain input script and can be
 * replay-attested from boot.
 */
export interface ActionMacro {
  id: string
  inputs: readonly string[]
}

export interface CheckpointEnvironment<C, O> {
  reset(seed: number): void
  checkpoint(): C
  restore(checkpoint: C): void
  step(input: string): O
  observe(): O
  fingerprint(observation: O): string
  features(observation: O): Iterable<string>
}

export interface FrontierOptions {
  seed?: number
  rounds: number
  beamWidth: number
  actions: readonly ActionMacro[]
}

export interface FrontierResult {
  inputs: string[]
  coverage: number
  statesExamined: number
  roundsCompleted: number
  terminalFingerprint: string
}

interface Node<C> {
  checkpoint: C
  inputs: string[]
  features: Set<string>
  fingerprint: string
}

export function frontierExplore<C, O>(env: CheckpointEnvironment<C, O>, options: FrontierOptions): FrontierResult {
  if (options.rounds < 1) throw new Error('frontier rounds must be positive')
  if (options.beamWidth < 1) throw new Error('frontier beamWidth must be positive')
  if (options.actions.length === 0 || options.actions.some((a) => a.inputs.length === 0)) {
    throw new Error('frontier actions must contain at least one non-empty macro')
  }
  const ids = new Set(options.actions.map((a) => a.id))
  if (ids.size !== options.actions.length) throw new Error('frontier action ids must be unique')

  env.reset(options.seed ?? 0)
  const rootObservation = env.observe()
  const root: Node<C> = {
    checkpoint: env.checkpoint(),
    inputs: [],
    features: new Set(env.features(rootObservation)),
    fingerprint: env.fingerprint(rootObservation),
  }
  let frontier = [root]
  let best = root
  let statesExamined = 1
  const globallySeen = new Set([root.fingerprint])
  let roundsCompleted = 0

  for (let round = 0; round < options.rounds; round++) {
    const byState = new Map<string, Node<C>>()
    for (const parent of frontier) {
      for (const action of [...options.actions].sort((a, b) => a.id.localeCompare(b.id))) {
        env.restore(parent.checkpoint)
        let observation = env.observe()
        for (const input of action.inputs) observation = env.step(input)
        statesExamined++
        const fingerprint = env.fingerprint(observation)
        const features = new Set(parent.features)
        for (const feature of env.features(observation)) features.add(feature)
        const child: Node<C> = {
          checkpoint: env.checkpoint(),
          inputs: [...parent.inputs, ...action.inputs],
          features,
          fingerprint,
        }
        const old = byState.get(fingerprint)
        if (!old || better(child, old)) byState.set(fingerprint, child)
      }
    }
    const candidates = [...byState.values()]
    candidates.sort((a, b) => compareNodes(a, b, globallySeen))
    frontier = candidates.slice(0, options.beamWidth)
    if (frontier.length === 0) break
    for (const node of frontier) globallySeen.add(node.fingerprint)
    if (better(frontier[0]!, best)) best = frontier[0]!
    roundsCompleted = round + 1
  }

  env.restore(best.checkpoint)
  return {
    inputs: [...best.inputs],
    coverage: best.features.size,
    statesExamined,
    roundsCompleted,
    terminalFingerprint: best.fingerprint,
  }
}

function better<C>(a: Node<C>, b: Node<C>): boolean {
  if (a.features.size !== b.features.size) return a.features.size > b.features.size
  if (a.inputs.length !== b.inputs.length) return a.inputs.length < b.inputs.length
  return lexicographic(a.inputs, b.inputs) < 0
}

function compareNodes<C>(a: Node<C>, b: Node<C>, globallySeen: Set<string>): number {
  const aNew = globallySeen.has(a.fingerprint) ? 0 : 1
  const bNew = globallySeen.has(b.fingerprint) ? 0 : 1
  if (aNew !== bNew) return bNew - aNew
  if (a.features.size !== b.features.size) return b.features.size - a.features.size
  if (a.inputs.length !== b.inputs.length) return a.inputs.length - b.inputs.length
  return lexicographic(a.inputs, b.inputs)
}

function lexicographic(a: readonly string[], b: readonly string[]): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const order = a[i]!.localeCompare(b[i]!)
    if (order !== 0) return order
  }
  return a.length - b.length
}
