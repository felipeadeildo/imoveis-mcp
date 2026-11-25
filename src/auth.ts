/**
 * One shared secret, compared without leaking where the first byte differs.
 *
 * This is deliberately small: the server is a personal research tool, not a
 * multi-tenant service. If it ever holds someone else's account, replace this
 * with the OAuth provider (`@cloudflare/workers-oauth-provider`), which is
 * what the sibling whatsapp-mcp worker does.
 */
export async function tokenMatches(presented: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(presented)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ])
  const left = new Uint8Array(a)
  const right = new Uint8Array(b)
  let diff = 0
  for (let index = 0; index < left.length; index += 1)
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0)
  return diff === 0
}

export function presentedToken(request: Request): string | null {
  const header = request.headers.get("authorization")
  if (header?.toLowerCase().startsWith("bearer ")) return header.slice(7).trim()
  // Some MCP clients only let you paste a URL, so accept the token there too.
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
