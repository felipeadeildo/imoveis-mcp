import { afterEach, describe, expect, test } from "bun:test"

import { Client, InMemoryTransport } from "@modelcontextprotocol/client"

import worker from "../src/index"
import { createServer } from "../src/mcp/server"

import searchFixture from "./fixtures/qa-search.json"
import detailFixture from "./fixtures/qa-detail.json"

function pageOf(data: unknown): string {
  return `<!doctype html><html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></body></html>`
}

// A JPEG header plus bytes that are not valid UTF-8, so a decode round trip
// through the fetch layer would corrupt it.
const JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xc3, 0x28, 0xa0, 0xff,
])

const LINKS = [
  '<a href="/alugar/imovel/pinheiros-sao-paulo-sp-brasil">Pinheiros</a>',
  '<a href="/alugar/imovel/vila-mariana-sao-paulo-sp-brasil">Vila Mariana</a>',
].join("")

/** Serve the saved pages, plus a fake JPEG for anything that looks like media. */
function stubFetch(): { restore: () => void; requests: string[] } {
  const original = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    requests.push(url)
    if (/\/img\//.test(url)) {
      return new Response(JPEG, { headers: { "content-type": "image/jpeg" } })
    }
    // Neighbourhood links only exist as anchors in the markup, not in the JSON.
    const body = /\/imovel\/\d+\//.test(url)
      ? pageOf(detailFixture)
      : `${pageOf(searchFixture)}${LINKS}`
    return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } })
  }) as typeof fetch
  return { restore: () => (globalThis.fetch = original), requests }
}

function env(overrides: Partial<Record<string, unknown>> = {}): never {
  return { MCP_TOKEN: "a".repeat(32), PUBLIC_BASE: "http://localhost:8787", ...overrides } as never
}

async function connect(environment = env()) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createServer(environment)
  await server.connect(serverTransport)
  const client = new Client({ name: "test", version: "1" }, { capabilities: {} })
  await client.connect(clientTransport)
  return client
}

let restore: (() => void) | null = null
afterEach(() => {
  restore?.()
  restore = null
})

describe("mcp surface", () => {
  test("exposes the tools an agent needs, and nothing more", async () => {
    const client = await connect()
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name).toSorted()).toEqual([
      "compare_listings",
      "get_listing",
      "get_media",
      "list_cities",
      "list_sources",
      "search_listings",
      "see_photos",
    ])
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object")
      expect(tool.description?.length ?? 0).toBeGreaterThan(40)
    }
    await client.close()
  })

  test("search_listings returns compact listings", async () => {
    const stub = stubFetch()
    restore = stub.restore
    const client = await connect()
    const result = await client.callTool({
      name: "search_listings",
      arguments: { city: "São Paulo", price_max: 1900, limit: 5 },
    })
    const payload = JSON.parse((result.content as { type: string; text: string }[])[0]!.text)
    expect(payload.source).toBe("quintoandar")
    expect(payload.listings).toHaveLength(3)
    expect(payload.listings[0]).toMatchObject({ business: "rent", partial: true })
    expect(payload.listings[0].photo_count).toBeGreaterThan(0)
    expect(payload.areas.length).toBeGreaterThan(0)
    expect(payload.server_filters).toEqual([])
    await client.close()
  })

  test("get_listing carries what a card does not", async () => {
    const stub = stubFetch()
    restore = stub.restore
    const client = await connect()
    const result = await client.callTool({ name: "get_listing", arguments: { id: "893237705" } })
    const payload = JSON.parse((result.content as { type: string; text: string }[])[0]!.text)
    // `partial` is only sent when true, so a full listing simply omits it.
    expect(payload).toMatchObject({ id: "893237705", condo: 0, iptu: 10, accepts_pets: false })
    expect(payload.partial).toBeUndefined()
    expect(payload.amenities).toContain("Box")
    expect(payload.coordinates).toEqual({ lat: -23.5383432, lng: -46.4604271 })
    await client.close()
  })

  test("see_photos returns images the model can see", async () => {
    const stub = stubFetch()
    restore = stub.restore
    const client = await connect()
    const result = await client.callTool({
      name: "see_photos",
      arguments: { id: "893237705", limit: 2, size: "sml" },
    })
    const blocks = result.content as {
      type: string
      data?: string
      mimeType?: string
      text?: string
    }[]
    const images = blocks.filter((block) => block.type === "image")
    expect(images).toHaveLength(2)
    expect(images[0]?.mimeType).toBe("image/jpeg")
    expect(images[0]?.data?.length ?? 0).toBeGreaterThan(0)
    expect(
      blocks.some((block) => block.type === "text" && /^\d+\/\d+/.test(block.text ?? "")),
    ).toBe(true)
    await client.close()
  })

  test("see_photos focuses on a room by caption", async () => {
    const stub = stubFetch()
    restore = stub.restore
    const client = await connect()
    const result = await client.callTool({
      name: "see_photos",
      arguments: { id: "893237705", focus: "cozinha", limit: 1 },
    })
    const texts = (result.content as { type: string; text?: string }[])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
    expect(texts.some((text) => /cozinha/i.test(text))).toBe(true)
    await client.close()
  })

  test("media links default to the portal's CDN", async () => {
    const stub = stubFetch()
    restore = stub.restore
    const client = await connect()
    const result = await client.callTool({
      name: "get_media",
      arguments: { id: "893237705", limit: 2 },
    })
    const payload = JSON.parse((result.content as { type: string; text: string }[])[0]!.text)
    expect(payload.serve).toBe("upstream")
    expect(payload.photos).toHaveLength(2)
    expect(payload.photos[0].url).toStartWith("https://www.quintoandar.com.br/img/lrg/")
    await client.close()
  })

  test("proxy links go through this worker and need no bucket", async () => {
    const stub = stubFetch()
    restore = stub.restore
    const client = await connect()
    const result = await client.callTool({
      name: "get_media",
      arguments: { id: "893237705", limit: 1, serve: "proxy", size: "med" },
    })
    const payload = JSON.parse((result.content as { type: string; text: string }[])[0]!.text)
    expect(payload.serve).toBe("proxy")
    expect(payload.photos[0].url).toStartWith("http://localhost:8787/media/proxy?src=")
    expect(payload.photos[0].url).toContain(encodeURIComponent("/img/med/"))
    await client.close()
  })

  test("asking for r2 without a bucket explains how to add one", async () => {
    const stub = stubFetch()
    restore = stub.restore
    const client = await connect()
    const result = await client.callTool({
      name: "get_media",
      arguments: { id: "893237705", limit: 1, serve: "r2" },
    })
    const payload = JSON.parse((result.content as { type: string; text: string }[])[0]!.text)
    expect(payload.photos[0].error).toContain("no media bucket")
    await client.close()
  })

  test("a blocked source is refused with a reason, not a crash", async () => {
    const client = await connect()
    const result = await client.callTool({ name: "list_sources", arguments: {} })
    const payload = JSON.parse((result.content as { type: string; text: string }[])[0]!.text)
    const zap = payload.sources.find((source: { id: string }) => source.id === "zap")
    expect(zap.reachable).toBe(false)
    expect(zap.note).toMatch(/not available/i)
    await client.close()
  })
})

// Bun's `Request` defaults to a looser cf-properties type than the one the
// worker handler is declared with.
const request = (url: string, init?: RequestInit<IncomingRequestCfProperties>) =>
  new Request<unknown, IncomingRequestCfProperties>(url, init)

describe("worker routing", () => {
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext

  test("health needs no token", async () => {
    const response = await worker.fetch(request("http://x/health"), env(), ctx)
    expect(response.status).toBe(200)
  })

  test("the index describes the server and its sources", async () => {
    const response = await worker.fetch(request("http://x/"), env(), ctx)
    const payload = (await response.json()) as { endpoint: string; sources: { id: string }[] }
    expect(payload.endpoint).toBe("http://x/mcp")
    expect(payload.sources[0]?.id).toBe("quintoandar")
  })

  test("/mcp without a token is 401 and points at the metadata", async () => {
    const response = await worker.fetch(request("http://x/mcp"), env(), ctx)
    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toContain(
      "/.well-known/oauth-protected-resource",
    )
  })

  test("/mcp with a wrong token is 401", async () => {
    const wrongToken = request("http://x/mcp", {
      headers: { authorization: `Bearer ${"b".repeat(32)}` },
    })
    expect((await worker.fetch(wrongToken, env(), ctx)).status).toBe(401)
  })

  test("/mcp with the token accepts an initialize call", async () => {
    const initialize = request("http://x/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${"a".repeat(32)}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      }),
    })
    const response = await worker.fetch(initialize, env(), ctx)
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain("imoveis-mcp")
  })

  test("/media/proxy streams an allowed host and refuses another", async () => {
    const stub = stubFetch()
    restore = stub.restore
    const ok = await worker.fetch(
      request(
        `http://x/media/proxy?src=${encodeURIComponent("https://www.quintoandar.com.br/img/lrg/a.jpeg")}`,
      ),
      env(),
      ctx,
    )
    expect(ok.status).toBe(200)
    expect(ok.headers.get("content-type")).toBe("image/jpeg")
    const refused = await worker.fetch(
      request(`http://x/media/proxy?src=${encodeURIComponent("https://evil.example/a.jpeg")}`),
      env(),
      ctx,
    )
    expect(refused.status).toBe(502)
    await refused.text()
  })

  test("/media/proxy returns the upstream bytes unchanged", async () => {
    const stub = stubFetch()
    restore = stub.restore
    const response = await worker.fetch(
      request(
        `http://x/media/proxy?src=${encodeURIComponent("https://www.quintoandar.com.br/img/lrg/a.jpeg")}`,
      ),
      env(),
      ctx,
    )
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(JPEG)
  })

  test("unknown routes are 404", async () => {
    expect((await worker.fetch(request("http://x/nope"), env(), ctx)).status).toBe(404)
  })
})
