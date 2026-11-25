import { ToolError } from "./errors"
import { BROWSER_HEADERS, fetchBytes } from "./http"

/**
 * Media, in the four shapes a caller can ask for:
 *
 *   inline: bytes in an MCP image block, at the size requested. sml is 6 KB,
 *           med 11 KB, lrg 17 KB, xlg 31 KB.
 *   upstream: the source's CDN URL. Range requests go to the CDN, so video
 *           seeks normally.
 *   proxy: the same bytes through this worker, cached at the edge.
 *   r2: a copy in the bucket, when the binding exists.
 */

const MAX_INLINE_BYTES = 700_000
const MAX_STORED_BYTES = 40_000_000
const ALLOWED_HOSTS = new Set(["www.quintoandar.com.br", "static.quintoandar.com.br"])

export function assertMediaHost(url: string): URL {
  const parsed = new URL(url)
  if (parsed.protocol !== "https:") throw new ToolError(`not https: ${url}`)
  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new ToolError(
      `host not allowed: ${parsed.hostname}`,
      `allowed: ${[...ALLOWED_HOSTS].join(", ")}`,
    )
  }
  return parsed
}

export interface InlineImage {
  bytes: Uint8Array
  mimeType: string
}

export async function inlineImage(url: string, env: Env): Promise<InlineImage> {
  assertMediaHost(url)
  const { bytes, contentType } = await fetchBytes(url, env, { timeoutMs: 20_000 })
  if (bytes.byteLength > MAX_INLINE_BYTES) {
    throw new ToolError(
      `image is ${bytes.byteLength} bytes, over the ${MAX_INLINE_BYTES} inline limit`,
      "ask for a smaller size",
    )
  }
  if (!contentType.startsWith("image/")) throw new ToolError(`not an image: ${contentType}`)
  return { bytes, mimeType: contentType.split(";")[0] ?? contentType }
}

/** A link through this worker, for when the user should not see the source's host. */
export function proxyUrl(base: string, upstream: string): string {
  return `${base.replace(/\/+$/, "")}/media/proxy?src=${encodeURIComponent(upstream)}`
}

/**
 * Stream one upstream file through the worker.
 *
 * A range request goes upstream untouched and comes back as 206. A ranged
 * response is never cached: a partial body under the full URL would corrupt the
 * next request.
 */
export async function proxyMedia(upstream: string, request: Request): Promise<Response> {
  assertMediaHost(upstream)
  const range = request.headers.get("range")
  // Media streams: a video is far larger than the page size cap, so this path
  // does not go through the buffering fetch.
  const response = await fetch(upstream, {
    headers: {
      ...BROWSER_HEADERS,
      // A decompressed body would make content-length and content-range lie.
      "accept-encoding": "identity",
      ...(range ? { range } : {}),
    },
    signal: AbortSignal.timeout(60_000),
    redirect: "follow",
  })
  if (!response.ok && response.status !== 206) {
    throw new ToolError(`upstream ${response.status} for ${upstream}`)
  }

  const passthrough = new Headers()
  for (const name of ["content-type", "content-length", "content-range", "accept-ranges", "etag"]) {
    const value = response.headers.get(name)
    if (value) passthrough.set(name, value)
  }
  passthrough.set("cache-control", range ? "no-store" : "public, max-age=86400")
  passthrough.set("access-control-allow-origin", "*")
  return new Response(response.body, { status: response.status, headers: passthrough })
}

export interface StoredMedia {
  key: string
  url: string
  bytes: number
  contentType: string
}

export async function storeMedia(
  env: Env,
  origin: string,
  url: string,
  keyPrefix: string,
): Promise<StoredMedia> {
  assertMediaHost(url)
  if (!env.MEDIA) {
    throw new ToolError(
      "no media bucket is bound to this worker",
      "add an r2_buckets binding named MEDIA in wrangler.jsonc, then deploy again; without it, use serve: 'proxy'",
    )
  }
  const { bytes, contentType } = await fetchBytes(url, env, { timeoutMs: 60_000 })
  if (bytes.byteLength > MAX_STORED_BYTES) {
    throw new ToolError(`media is ${bytes.byteLength} bytes, over the ${MAX_STORED_BYTES} limit`)
  }
  const extension = extensionFor(contentType, url)
  const key = `${keyPrefix.replace(/^\/+|\/+$/g, "")}${extension}`
  await env.MEDIA.put(key, bytes, {
    httpMetadata: { contentType, cacheControl: "public, max-age=31536000, immutable" },
  })
  return {
    key,
    url: `${origin.replace(/\/+$/, "")}/media/${key}`,
    bytes: bytes.byteLength,
    contentType,
  }
}

export async function readStoredMedia(env: Env, key: string): Promise<Response> {
  if (!env.MEDIA) return new Response("media storage is not configured", { status: 501 })
  const object = await env.MEDIA.get(key)
  if (!object) return new Response("not found", { status: 404 })
  return new Response(object.body, {
    headers: {
      "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "cache-control": object.httpMetadata?.cacheControl ?? "public, max-age=31536000, immutable",
      etag: object.httpEtag,
    },
  })
}

function extensionFor(contentType: string, url: string): string {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? ""
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/avif": ".avif",
    "image/gif": ".gif",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov",
  }
  if (map[type]) return map[type]
  const fromUrl = /\.[a-z0-9]{2,4}$/i.exec(new URL(url).pathname)?.[0]
  return fromUrl ?? ".bin"
}
