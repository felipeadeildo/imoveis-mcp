import { ToolError, UpstreamError } from "./errors"

/**
 * The sites decide what to serve from the User-Agent and Accept-Language. This
 * pair is what the public pages were measured with.
 */
export const BROWSER_HEADERS: Record<string, string> = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "accept-language": "pt-BR,pt;q=0.9,en;q=0.8",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-encoding": "gzip, br",
}

const DEFAULT_TTL = 600
const DEFAULT_MAX_BYTES = 4_000_000
const DEFAULT_TIMEOUT_MS = 15_000

export interface FetchOptions {
  /** Seconds the response stays in the edge cache. 0 disables caching. */
  ttl?: number
  timeoutMs?: number
  /** Retries after a timeout or a 5xx. */
  retries?: number
  /** Extra request headers, merged over the defaults. */
  headers?: Record<string, string>
}

function numberVar(value: string | undefined, fallback: number, minimum: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback
}

/** `caches.default` is absent under `bun test`, so caching stays optional. */
function edgeCache(): Cache | undefined {
  return typeof caches === "undefined" ? undefined : caches.default
}

/** Fetch one URL and buffer its body, with a size cap. The body stays bytes. */
async function fetchLimited(url: string, env: Env, options: FetchOptions): Promise<Response> {
  const ttl = options.ttl ?? numberVar(env.PAGE_TTL, DEFAULT_TTL, 0)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const retries = options.retries ?? 1
  const maxBytes = numberVar(env.MAX_PAGE_BYTES, DEFAULT_MAX_BYTES, 1)
  const cache = ttl > 0 ? edgeCache() : undefined
  const cacheKey = new Request(url)

  const cached = await cache?.match(cacheKey)
  if (cached) return cached

  let lastError: unknown = null
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const upstream = await fetch(url, {
        headers: { ...BROWSER_HEADERS, ...options.headers },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "follow",
      })
      if (!upstream.ok) {
        const error = new UpstreamError(url, upstream.status, await snippetOf(upstream))
        // A block or a 4xx will answer the same way again; a 5xx may not.
        if (upstream.status < 500) throw error
        lastError = error
        continue
      }
      const type = upstream.headers.get("content-type") ?? "text/html; charset=utf-8"
      const body = await readLimited(upstream, maxBytes)
      const response = new Response(body, {
        status: 200,
        headers: { "content-type": type, "cache-control": `max-age=${ttl}` },
      })
      if (cache) await cache.put(cacheKey, response.clone())
      return response
    } catch (error) {
      if (error instanceof UpstreamError) throw error
      lastError = error
    }
  }
  if (lastError instanceof Error) throw new ToolError(`${url}: ${lastError.message}`)
  throw new ToolError(`${url}: fetch failed`)
}

/** Buffer at most `limit` bytes, so one hostile page cannot exhaust the isolate. */
async function readLimited(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(await response.arrayBuffer())
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel()
      throw new ToolError(`response larger than ${limit} bytes; raise MAX_PAGE_BYTES`)
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

async function snippetOf(response: Response): Promise<string | undefined> {
  const text = (await response.text()).replace(/\s+/g, " ").trim()
  return text.slice(0, 120) || undefined
}

export async function fetchPage(
  url: string,
  env: Env,
  options: FetchOptions = {},
): Promise<Response> {
  return fetchLimited(url, env, options)
}

export async function fetchText(
  url: string,
  env: Env,
  options: FetchOptions = {},
): Promise<string> {
  return (await fetchLimited(url, env, options)).text()
}

export async function fetchBytes(
  url: string,
  env: Env,
  options: FetchOptions = {},
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const response = await fetchLimited(url, env, { ttl: 86_400, ...options })
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    contentType: response.headers.get("content-type") ?? "application/octet-stream",
  }
}
