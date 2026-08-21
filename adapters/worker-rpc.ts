/**
 * Synchronous line-JSON worker transport shared by every out-of-process game.
 *
 * A worker is any executable that accepts two FIFO paths as its final
 * arguments, creates them plus a sibling `ready` marker, and then serves one
 * JSON object per line:
 *   request  { id, method, params }
 *   response { id, ok, result } | { id, ok: false, error }
 *
 * The protocol is intentionally tiny. Platform adapters define only boot
 * parameters and evidence interpretation; process lifecycle, framing, bounds,
 * and cleanup live here once.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ObservationImage } from '../runtime'

export interface WorkerEvidence {
  engineState: Record<string, number>
  saveBlobHash?: string
  saveState?: Record<string, number>
  logEvents?: string[]
  frameHash?: string
  frameState?: Record<string, number>
}

export interface WorkerStepResult {
  frame: number
  evidence: WorkerEvidence
  frameText: string
  /** Rendered screen, present only when the boot asked a worker for pixels. */
  frameImage?: ObservationImage
}

/** A worker's `frame` reply: the text observation and, when booted for it, the screen. */
export interface WorkerFrame {
  text: string
  image?: ObservationImage
}

export interface WorkerProcessSpec {
  name: string
  command: string
  args?: string[]
  env?: NodeJS.ProcessEnv
  readyTimeoutMs?: number
  maxResponseBytes?: number
}

interface RpcResponse {
  id: number
  ok: boolean
  result?: unknown
  error?: string
}

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export class WorkerRpc {
  private readonly child: ChildProcess
  private readonly dir: string
  private readonly inFd: number
  private readonly outFd: number
  private readonly maxResponseBytes: number
  private nextId = 1
  private dead: string | null = null
  private closed = false

  constructor(private readonly spec: WorkerProcessSpec) {
    this.dir = mkdtempSync(join(tmpdir(), `playproof-${spec.name}-`))
    const fifoIn = join(this.dir, 'in')
    const fifoOut = join(this.dir, 'out')
    this.maxResponseBytes = spec.maxResponseBytes ?? (1 << 20)
    this.child = spawn(spec.command, [...(spec.args ?? []), fifoIn, fifoOut], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: spec.env ?? process.env,
    })
    this.child.on('exit', (code, signal) => {
      if (!this.closed && (code !== 0 || signal)) {
        this.dead = `${spec.name} worker exited (${code === null ? signal : `code ${code}`})`
      }
    })

    const ready = join(this.dir, 'ready')
    const deadline = Date.now() + (spec.readyTimeoutMs ?? 30_000)
    while (!existsSync(ready) && Date.now() < deadline) {
      if (this.child.exitCode !== null) {
        this.cleanupProcess()
        throw new Error(`${spec.name} worker died before connecting (code ${this.child.exitCode})`)
      }
      sleepSync(25)
    }
    if (!existsSync(ready)) {
      this.cleanupProcess()
      throw new Error(`${spec.name} worker never signaled readiness`)
    }

    // FIFO opens synchronize both ends and give this synchronous Game API real
    // blocking descriptors. The worker opens read then write in the same order.
    this.inFd = openSync(fifoIn, 'w')
    this.outFd = openSync(fifoOut, 'r')
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}): T {
    if (this.closed) throw new Error(`${this.spec.name} worker is closed`)
    if (this.dead) throw new Error(this.dead)
    const id = this.nextId++
    writeSync(this.inFd, `${JSON.stringify({ id, method, params })}\n`)

    let text = ''
    const chunk = Buffer.alloc(4096)
    for (;;) {
      const n = readSync(this.outFd, chunk, 0, chunk.length, null)
      if (n === 0) throw new Error(`${this.spec.name} worker closed the transport`)
      text += chunk.toString('utf8', 0, n)
      const newline = text.indexOf('\n')
      if (newline >= 0) {
        let response: RpcResponse
        try {
          response = JSON.parse(text.slice(0, newline)) as RpcResponse
        } catch (error) {
          throw new Error(`${this.spec.name} worker returned invalid JSON: ${(error as Error).message}`)
        }
        if (response.id !== id) {
          throw new Error(`${this.spec.name} worker response id mismatch: sent ${id}, got ${response.id}`)
        }
        if (!response.ok) throw new Error(`${this.spec.name} worker ${method} failed: ${response.error ?? 'unknown error'}`)
        return response.result as T
      }
      if (Buffer.byteLength(text) > this.maxResponseBytes) {
        throw new Error(`${this.spec.name} worker response exceeds ${this.maxResponseBytes} bytes without newline`)
      }
    }
  }

  reset(): { gen: number; frame: number } {
    return this.call('reset')
  }

  step(input: string): WorkerStepResult {
    return this.call('step', { input })
  }

  evidence(): WorkerEvidence {
    return this.call('evidence')
  }

  frameText(): string {
    return this.call<WorkerFrame>('frame').text
  }

  /** The whole agent-visible observation in one call, pixels included. */
  frameObservation(): WorkerFrame {
    return this.call<WorkerFrame>('frame')
  }

  checkpoint<T = unknown>(): T {
    return this.call<T>('checkpoint')
  }

  /**
   * The checkpoint payload is opaque to the transport and its shape belongs to
   * the worker, so `unknown` is the honest parameter type. It also lets an
   * adapter narrow this method to its own checkpoint type.
   */
  restore(state: unknown): { gen: number; frame: number } {
    return this.call('restore', { state })
  }

  shutdown(): void {
    if (this.closed) return
    try {
      this.call('shutdown')
    } finally {
      this.closed = true
      try { closeSync(this.inFd) } catch { /* already closed */ }
      try { closeSync(this.outFd) } catch { /* already closed */ }
      this.cleanupProcess()
    }
  }

  private cleanupProcess(): void {
    if (this.child.exitCode === null) this.child.kill('SIGKILL')
    try { rmSync(this.dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}
