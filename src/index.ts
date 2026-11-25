import { createMcpHandler } from "agents/mcp/server"

import { authorized, unauthorized } from "./auth"
import { errorText } from "./errors"
import { proxyMedia, readStoredMedia } from "./media"
import { createServer } from "./mcp/server"
import { describeSources } from "./packs/registry"

const MCP_ROUTE = "/mcp"
const STORED_MEDIA = /^\/media\/(.+)$/

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "imoveis-mcp" })
    }

    if (url.pathname === "/") {
      return Response.json(
        {
          name: "imoveis-mcp",
          description: "Brazilian real-estate listings as MCP tools.",
          endpoint: `${url.origin}${MCP_ROUTE}`,
          auth: "Authorization: Bearer <MCP_TOKEN>",
          stores_media: Boolean(env.MEDIA),
          sources: describeSources(),
        },
        { headers: { "access-control-allow-origin": "*" } },
      )
    }

    if (url.pathname === "/.well-known/oauth-protected-resource") {
      return Response.json({
        resource: `${url.origin}${MCP_ROUTE}`,
        bearer_methods_supported: ["header"],
        resource_name: "imoveis-mcp",
      })
    }

    if (url.pathname === "/media/proxy") {
      const src = url.searchParams.get("src")
      if (!src) return new Response("missing src", { status: 400 })
      try {
        return await proxyMedia(src, request)
      } catch (error) {
        return new Response(errorText(error), { status: 502 })
      }
    }

    const stored = STORED_MEDIA.exec(url.pathname)
    if (stored) {
      const key = decodeURIComponent(stored[1] ?? "")
      if (key.includes("..")) return new Response("bad key", { status: 400 })
      return readStoredMedia(env, key)
    }

    if (url.pathname === MCP_ROUTE) {
      if (!(await authorized(request, env))) return unauthorized(request)
      return createMcpHandler(() => createServer(env), { route: MCP_ROUTE })(request, env, ctx)
    }

    return new Response("not found", { status: 404 })
  },
} satisfies ExportedHandler<Env>
