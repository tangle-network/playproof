import { spawnSync } from 'node:child_process'

export interface JsonBridgeSpec {
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  maxBytes?: number
}

export function runJsonBridge(spec: JsonBridgeSpec, request: unknown): { data: unknown; text: string } {
  if (!spec.command.trim() || spec.command.includes('\0')) throw new Error('bridge command is invalid')
  const result = spawnSync(spec.command, spec.args ?? [], {
    cwd: spec.cwd,
    env: { ...process.env, ...(spec.env ?? {}) },
    input: JSON.stringify(request),
    encoding: 'utf8',
    timeout: spec.timeoutMs ?? 15_000,
    maxBuffer: spec.maxBytes ?? (4 << 20),
    shell: false,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`bridge exited ${result.status}: ${(result.stderr ?? '').slice(0, 300)}`)
  const text = result.stdout ?? ''
  try {
    return { data: JSON.parse(text) as unknown, text }
  } catch (error) {
    throw new Error(`bridge returned invalid JSON: ${(error as Error).message}`)
  }
}
