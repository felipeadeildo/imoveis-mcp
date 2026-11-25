/**
 * One shared secret. A personal server does not need OAuth, and a token the
 * client pastes into its config is enough.
 */

/** Compare two secrets in constant time, so timing leaks nothing. */
export async function tokenMatches(presented: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(presented)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ])
  const a = new Uint8Array(left)
  const b = new Uint8Array(right)
  let diff = 0
  for (let index = 0; index < a.length; index += 1) diff |= (a[index] ?? 0) ^ (b[index] ?? 0)
  return diff === 0
}

export function presentedToken(request: Request): string | null {
  const header = request.headers.get("authorization")
  if (header?.toLowerCase().startsWith("bearer ")) return header.slice(7).trim()
  // Some clients only accept a URL, so the query string is the fallback.
  return new URL(request.url).searchParams.get("token")
}

export async function authorized(request: Request, env: Env): Promise<boolean> {
  const expected = env.MCP_TOKEN
  if (!expected || expected.length < 16) return false
  const presented = presentedToken(request)
  if (!presented) return false
  return tokenMatches(presented, expected)
}

export function unauthorized(request: Request): Response {
  const origin = new URL(request.url).origin
  return new Response("unauthorized: send the token as `Authorization: Bearer <token>`", {
    status: 401,
    headers: {
      "www-authenticate": `Bearer realm="imoveis-mcp", resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
    },
  })
}
