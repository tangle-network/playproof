/**
 * Generic native desktop game adapter.
 *
 * The platform-specific work is declarative: launch/attach, input helper,
 * observation helper, save/event probes, and build files. Process lifecycle and
 * evidence normalization stay in desktop/worker.py; the Playproof loop,
 * contracts, scoring, and signed artifacts remain shared.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { BenchmarkTarget, PlatformDescriptor } from '../platform'
import type { Evidence, Game } from '../runtime'
import type { MilestoneContract } from '../schema'
import { WorkerRpc, type WorkerEvidence } from './worker-rpc'

const WORKER_PATH = fileURLToPath(new URL('../desktop/worker.py', import.meta.url))

export interface DesktopCommandSpec {
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  maxBytes?: number
}

export type DesktopProcessSelector =
  | { kind: 'spawned' }
  | { kind: 'pid-file'; path: string; timeoutMs?: number }
  | { kind: 'descendant-name'; name: string; timeoutMs?: number }
  | { kind: 'resolver'; bridge: DesktopCommandSpec; timeoutMs?: number }
  | { kind: 'existing-pid'; pid: number }

export interface DesktopReadySpec {
  stdoutPattern?: string
  filePath?: string
  timeoutMs?: number
}

export type DesktopInputSpec =
  | { kind: 'stdin-line'; suffix?: string }
  | { kind: 'helper'; bridge: DesktopCommandSpec }

export type DesktopObservationSpec =
  | { kind: 'stdout'; maxChars?: number }
  | { kind: 'helper'; bridge: DesktopCommandSpec }

export interface DesktopSaveProbe {
  id: string
  path: string
  format: 'json' | 'bytes'
  /** Hard file-read cap; default 4 MiB. */
  maxBytes?: number
}

export interface DesktopEventProbe {
  id: string
  path: string
  /** Hard file-read cap; default 4 MiB. */
  maxBytes?: number
}

export interface DesktopEvidenceSpec {
  saveFiles?: DesktopSaveProbe[]
  eventFiles?: DesktopEventProbe[]
  /** Promote normalized JSON save fields into engineState. */
  promoteSaveToEngine?: boolean
  /** Regexes applied to the rendered frame; capture group 1 becomes a number. */
  framePatterns?: Record<string, string>
  /** Optional authorized read-only helper returning WorkerEvidence JSON. */
  helper?: DesktopCommandSpec
}

export interface DesktopGameSpec {
  id: string
  launch?: DesktopCommandSpec
  process?: DesktopProcessSelector
  ready?: DesktopReadySpec
  input: DesktopInputSpec
  observation: DesktopObservationSpec
  evidence?: DesktopEvidenceSpec
  /** Unknown values are replay-stable no-ops; control characters are always rejected. */
  allowedInputs?: string[]
  /** Maximum observation-settle wait after a sent input. */
  settleMs?: number
  deterministicReplay: boolean
}

export interface NativeDesktopAdapterOptions {
  spec: DesktopGameSpec
  contract: MilestoneContract
  reference: readonly string[]
  build: { id: string; files: string[] }
  seed?: number
  python?: string
}

export interface DesktopState {
  gen: number
  frame: number
  evidence: Evidence
  frameText: string
}

export interface NativeDesktopAdapter extends BenchmarkTarget<DesktopState> {
  seed: number
  dispose(): void
}

class DesktopRpc extends WorkerRpc {
  constructor(python: string) {
    super({ name: 'native-desktop', command: python, args: [WORKER_PATH], readyTimeoutMs: 30_000, maxResponseBytes: 8 << 20 })
  }

  boot(spec: DesktopGameSpec, seed: number): { gen: number; frame: number } {
    return this.call('boot', { spec, seed })
  }
}

export function makeNativeDesktopAdapter(options: NativeDesktopAdapterOptions): NativeDesktopAdapter {
  validateDesktopSpec(options.spec)
  if (options.contract.gameId !== options.spec.id) {
    throw new Error(`desktop contract gameId ${options.contract.gameId} != spec id ${options.spec.id}`)
  }
  if (!options.build.id.trim()) throw new Error('desktop build id is required')
  if (options.build.files.length === 0) throw new Error('desktop build must pin at least one file')
  const build = { id: options.build.id, digest: digestBuild(options.build.files, options.spec) }
  const platform = desktopPlatform(options.spec)
  const rpc = new DesktopRpc(options.python ?? process.env.PLAYPROOF_PYTHON ?? 'python3')
  let current: DesktopState | null = null
  let phase: 'idle' | 'live' | 'replay' = 'idle'
  let replayIndex = 0
  let recorded: Array<{ input: string | null; state: DesktopState }> = []

  const startLive = (seed: number): DesktopState => {
    const booted = rpc.boot(options.spec, seed)
    current = {
      gen: booted.gen,
      frame: booted.frame,
      evidence: toEvidence(rpc.evidence()),
      frameText: rpc.frameText(),
    }
    phase = 'live'
    replayIndex = 0
    recorded = [{ input: null, state: cloneState(current) }]
    return current
  }

  const startTranscriptReplay = (): DesktopState => {
    const initial = recorded[0]
    if (!initial) throw new Error('trusted-recorder transcript is empty')
    phase = 'replay'
    replayIndex = 0
    current = cloneState(initial.state)
    return current
  }

  const game: Game<DesktopState> = {
    id: options.spec.id,
    init: (seed) => {
      if (options.spec.deterministicReplay) return startLive(seed)
      // Exactly one live pass is permitted per adapter. Every verifier init
      // after that—including a third or later pass—restarts the immutable
      // transcript. It must never launch the non-deterministic game again.
      return recorded.length === 0 ? startLive(seed) : startTranscriptReplay()
    },
    step: (state, input) => {
      if (!current || state.gen !== current.gen) {
        throw new Error(`stale desktop state: ${state.gen} != ${current?.gen ?? 'uninitialized'}`)
      }
      if (!options.spec.deterministicReplay && phase === 'replay') {
        replayIndex += 1
        const row = recorded[replayIndex]
        if (!row) throw new Error(`trusted-recorder replay exceeded ${recorded.length - 1} inputs`)
        if (row.input !== input) throw new Error(`trusted-recorder input mismatch at ${replayIndex}: ${input} != ${row.input}`)
        current = cloneState(row.state)
        return current
      }
      const stepped = rpc.step(input)
      current = {
        gen: current.gen,
        frame: stepped.frame,
        evidence: toEvidence(stepped.evidence),
        frameText: stepped.frameText,
      }
      if (!options.spec.deterministicReplay) recorded.push({ input, state: cloneState(current) })
      return current
    },
    frame: (state) => state.frameText,
    evidence: (state) => state.evidence,
  }

  return {
    platform,
    game,
    contract: options.contract,
    build,
    reference: [...options.reference],
    seed: options.seed ?? 0,
    dispose: () => rpc.shutdown(),
  }
}

export function desktopPlatform(spec: DesktopGameSpec): PlatformDescriptor {
  const evidence = spec.evidence
  const hasSave = (evidence?.saveFiles?.length ?? 0) > 0
  const hasEvents = (evidence?.eventFiles?.length ?? 0) > 0
  const hasRaw = Boolean(evidence?.helper || evidence?.promoteSaveToEngine)
  return {
    id: `desktop:${spec.id}`,
    family: 'native-process',
    verificationMode: spec.deterministicReplay ? 'replay' : 'trusted-recorder',
    capabilities: {
      deterministicReplay: spec.deterministicReplay,
      checkpoints: false,
      rawState: hasRaw,
      persistedState: hasSave,
      eventStream: hasEvents,
      frameCapture: true,
      signedRecorder: !spec.deterministicReplay,
      platformReceipts: false,
    },
  }
}

export function validateDesktopSpec(spec: DesktopGameSpec): void {
  if (!spec.id.trim()) throw new Error('desktop game id is required')
  if (!spec.launch && spec.process?.kind !== 'existing-pid' && spec.process?.kind !== 'resolver') {
    throw new Error('desktop spec without launch requires existing-pid or resolver selection')
  }
  if (spec.launch) validateCommand(spec.launch, 'launch')
  if (spec.input.kind === 'helper') validateCommand(spec.input.bridge, 'input helper')
  if (spec.input.kind === 'stdin-line' && spec.input.suffix !== undefined && !['', '\n', '\r\n'].includes(spec.input.suffix)) {
    throw new Error('desktop stdin-line suffix must be empty, LF, or CRLF')
  }
  if (spec.observation.kind === 'helper') validateCommand(spec.observation.bridge, 'observation helper')
  if (spec.evidence?.helper) validateCommand(spec.evidence.helper, 'evidence helper')
  if (spec.process?.kind === 'resolver') validateCommand(spec.process.bridge, 'process resolver')
  if (spec.settleMs !== undefined && (!Number.isFinite(spec.settleMs) || spec.settleMs < 0)) {
    throw new Error('desktop settleMs must be non-negative')
  }
  if (spec.allowedInputs) {
    if (new Set(spec.allowedInputs).size !== spec.allowedInputs.length) {
      throw new Error('desktop allowedInputs contains duplicates')
    }
    for (const input of spec.allowedInputs) {
      if (!input || /[\r\n\0]/.test(input)) throw new Error('desktop allowedInputs contains an invalid input')
    }
  }
  const probeIds = new Set<string>()
  for (const probe of spec.evidence?.saveFiles ?? []) {
    validateProbe(probe.id, probe.path, probe.maxBytes, 'save')
    if (probeIds.has(probe.id)) throw new Error(`duplicate desktop evidence probe id ${probe.id}`)
    probeIds.add(probe.id)
  }
  for (const probe of spec.evidence?.eventFiles ?? []) {
    validateProbe(probe.id, probe.path, probe.maxBytes, 'event')
    if (probeIds.has(probe.id)) throw new Error(`duplicate desktop evidence probe id ${probe.id}`)
    probeIds.add(probe.id)
  }
  for (const [id, pattern] of Object.entries(spec.evidence?.framePatterns ?? {})) {
    if (!id.trim() || !pattern.trim()) throw new Error('desktop frame pattern requires id and regex')
    new RegExp(pattern)
  }
}

function validateProbe(id: string, path: string, maxBytes: number | undefined, kind: string): void {
  if (!id.trim() || !path.trim()) throw new Error(`desktop ${kind} probe requires id and path`)
  if (maxBytes !== undefined && (!Number.isInteger(maxBytes) || maxBytes <= 0)) {
    throw new Error(`desktop ${kind} probe maxBytes must be a positive integer`)
  }
}

function validateCommand(command: DesktopCommandSpec, label: string): void {
  if (!command.command.trim() || command.command.includes('\0')) throw new Error(`${label} command is invalid`)
  for (const arg of command.args ?? []) if (arg.includes('\0')) throw new Error(`${label} argument contains NUL`)
  if (command.maxBytes !== undefined && (!Number.isInteger(command.maxBytes) || command.maxBytes <= 0)) {
    throw new Error(`${label} maxBytes must be a positive integer`)
  }
  if (command.timeoutMs !== undefined && (!Number.isFinite(command.timeoutMs) || command.timeoutMs <= 0)) {
    throw new Error(`${label} timeoutMs must be positive`)
  }
}

function digestBuild(files: readonly string[], spec: DesktopGameSpec): string {
  const hash = createHash('sha256')
  hash.update(JSON.stringify(spec))
  for (const path of [...files].sort()) {
    if (!existsSync(path)) throw new Error(`desktop build file does not exist: ${path}`)
    hash.update(path)
    hash.update(readFileSync(path))
  }
  return hash.digest('hex')
}

function cloneState(state: DesktopState): DesktopState {
  return {
    gen: state.gen,
    frame: state.frame,
    evidence: {
      ...(state.evidence.engineState ? { engineState: { ...state.evidence.engineState } } : {}),
      ...(state.evidence.saveBlobHash ? { saveBlobHash: state.evidence.saveBlobHash } : {}),
      ...(state.evidence.saveState ? { saveState: { ...state.evidence.saveState } } : {}),
      ...(state.evidence.logEvents ? { logEvents: [...state.evidence.logEvents] } : {}),
      ...(state.evidence.frameHash ? { frameHash: state.evidence.frameHash } : {}),
      ...(state.evidence.frameState ? { frameState: { ...state.evidence.frameState } } : {}),
    },
    frameText: state.frameText,
  }
}

function toEvidence(value: WorkerEvidence): Evidence {
  const evidence: Evidence = { engineState: { ...value.engineState } }
  if (value.saveBlobHash !== undefined) evidence.saveBlobHash = value.saveBlobHash
  if (value.saveState !== undefined) evidence.saveState = { ...value.saveState }
  if (value.logEvents !== undefined) evidence.logEvents = [...value.logEvents]
  if (value.frameHash !== undefined) evidence.frameHash = value.frameHash
  if (value.frameState !== undefined) evidence.frameState = { ...value.frameState }
  return evidence
}
