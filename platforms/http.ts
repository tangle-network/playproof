export interface HttpHeadersLike {
  get(name: string): string | null
}

export interface HttpBodyReaderLike {
  read(): Promise<{ done: boolean; value?: Uint8Array }>
  cancel?(reason?: unknown): Promise<void> | void
  releaseLock?(): void
}

export interface HttpBodyLike {
  getReader(): HttpBodyReaderLike
}

export interface HttpResponseLike {
  ok: boolean
  status: number
  headers?: HttpHeadersLike
  /** A streaming body is required so maxBytes is a real resource bound. */
  body: HttpBodyLike | null
}

export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<HttpResponseLike>

export async function fetchJsonBounded(
  fetchImpl: FetchLike,
  url: string,
  options: { headers?: Record<string, string>; timeoutMs?: number; maxBytes?: number } = {},
): Promise<{ data: unknown; text: string }> {
  const maxBytes = options.maxBytes ?? (4 << 20)
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new Error('HTTP maxBytes must be a positive integer')
  const timeoutMs = options.timeoutMs ?? 15_000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('HTTP timeoutMs must be positive')

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      ...(options.headers !== undefined ? { headers: options.headers } : {}),
      signal: controller.signal,
    })
    const declared = response.headers?.get('content-length')
    if (declared !== null && declared !== undefined) {
      const bytes = Number(declared)
      if (Number.isFinite(bytes) && bytes > maxBytes) throw new Error(`HTTP response exceeded ${maxBytes} bytes`)
    }
    const text = await readTextBounded(response.body, maxBytes)
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`)
    try {
      return { data: JSON.parse(text) as unknown, text }
    } catch (error) {
      throw new Error(`HTTP response was not valid JSON: ${(error as Error).message}`)
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function readTextBounded(body: HttpBodyLike | null, maxBytes: number): Promise<string> {
  if (body === null) return ''
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      bytes += value.byteLength
      if (bytes > maxBytes) {
        await reader.cancel?.(`response exceeded ${maxBytes} bytes`)
        throw new Error(`HTTP response exceeded ${maxBytes} bytes`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock?.()
  }
  const all = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    all.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(all)
}
