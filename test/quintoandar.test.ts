import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

import { nextData } from "../src/html"
import {
  applyQuery,
  listCities,
  parseSearchPage,
  photoUrl,
  prettyType,
  quintoandar,
} from "../src/packs/quintoandar"
import type { SearchQuery } from "../src/packs/types"

import searchFixture from "./fixtures/qa-search.json"
import detailFixture from "./fixtures/qa-detail.json"

const linksFixture = readFileSync(`${import.meta.dir}/fixtures/qa-links.html`, "utf8")

/** Wrap a saved `__NEXT_DATA__` payload the way the portal serves it. */
function pageOf(data: unknown): string {
  return `<!doctype html><html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></body></html>`
}

const searchPage = `${pageOf(searchFixture)}${linksFixture}`
const detailPage = pageOf(detailFixture)

function query(overrides: Partial<SearchQuery> = {}): SearchQuery {
  return { city: "São Paulo", business: "rent", limit: 20, ...overrides }
}

/** Point `fetch` at fixed pages for the duration of a test. */
function stubFetch(searchBody: string, detailBody = searchBody): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const body = /\/imovel\/\d+\//.test(url) ? detailBody : searchBody
    return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } })
  }) as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

function testEnv(): never {
  return { MCP_TOKEN: "x".repeat(32) } as never
}

describe("search page", () => {
  test("reads every listing card and skips the map counters", async () => {
    const page = parseSearchPage(searchPage, "rent")
    expect(page.listings).toHaveLength(6)
    expect(page.listings.every((listing) => listing.id.length > 0)).toBe(true)
  })

  test("keeps the fields a card carries", async () => {
    const [first] = parseSearchPage(searchPage, "rent").listings
    expect(first).toMatchObject({
      id: "893237705",
      type: "Casa",
      business: "rent",
      rentPrice: 1200,
      totalCost: 1261,
      area: 40,
      bedrooms: 1,
      bathrooms: 1,
      parkingSpots: 0,
      neighborhood: "Vila Campanela",
      city: "São Paulo",
      partial: true,
    })
    expect(first?.url).toBe("https://www.quintoandar.com.br/imovel/893237705/alugar")
    expect(first?.photos).toHaveLength(12)
    expect(first?.photos[0]?.caption).toBeNull()
    expect(first?.photos[1]?.caption).toBe("Sala")
    expect(first?.amenities).toContain("Box")
  })

  test("reports the total the portal claims, not the page size", async () => {
    const page = parseSearchPage(searchPage, "rent")
    expect(page.totalAvailable).toBe(71117)
  })

  test("reads the city index out of the same page", async () => {
    const page = parseSearchPage(searchPage, "rent")
    expect(page.cities).toEqual([
      { name: "São Paulo", state: "SP", slug: "sao-paulo-sp-brasil" },
      { name: "Rio de Janeiro", state: "RJ", slug: "rio-de-janeiro-rj-brasil" },
      { name: "Belo Horizonte", state: "MG", slug: "belo-horizonte-mg-brasil" },
      { name: "Porto Alegre", state: "RS", slug: "porto-alegre-rs-brasil" },
    ])
  })

  test("finds the linked areas and leaves other cities out", async () => {
    const areas = parseSearchPage(searchPage, "rent").areas.map((area) => area.name)
    expect(areas).toContain("barra funda")
    expect(areas).toContain("brooklin")
    // Barueri is another city, not a neighbourhood of São Paulo.
    expect(areas).not.toContain("barueri")
  })
})

describe("photos and labels", () => {
  test("builds the size path from a bare filename", () => {
    expect(photoUrl("original1-2.jpeg", "med")).toBe(
      "https://www.quintoandar.com.br/img/med/original1-2.jpeg",
    )
  })

  test("swaps the size in an absolute URL", () => {
    const url = "https://www.quintoandar.com.br/img/sml/original1-2.jpeg"
    expect(photoUrl(url, "xlg")).toBe("https://www.quintoandar.com.br/img/xlg/original1-2.jpeg")
  })

  test("reads a portal type label", () => {
    expect(prettyType("StudioOuKitchenette")).toBe("Studio ou kitchenette")
    expect(prettyType("Apartamento")).toBe("Apartamento")
    expect(prettyType(null)).toBeNull()
  })
})

describe("detail page", () => {
  test("reads houseInfo with the fields a card lacks", async () => {
    const restore = stubFetch(searchPage, detailPage)
    try {
      const listing = await quintoandar.detail(testEnv(), "893237705", "rent")
      expect(listing).toMatchObject({
        id: "893237705",
        type: "Casa",
        rentPrice: 1200,
        totalCost: 1261,
        condo: 0,
        iptu: 10,
        area: 40,
        bedrooms: 1,
        bathrooms: 1,
        suites: 0,
        parkingSpots: 0,
        acceptsPets: false,
        neighborhood: "Vila Campanela",
        city: "São Paulo",
        state: "SP",
        partial: false,
      })
      expect(listing.lat).toBeCloseTo(-23.5383, 3)
      expect(listing.lng).toBeCloseTo(-46.4604, 3)
      // Only the SIM items are claims about the flat; NAO and NAO_INFORMADO are not.
      expect(listing.amenities).toEqual([
        "Box",
        "Armários na cozinha",
        "Quartos e corredores com portas amplas",
        "Área de serviço",
      ])
      expect(listing.photos).toHaveLength(22)
      expect(listing.video).toBeNull()
    } finally {
      restore()
    }
  })

  test("refuses a page without house data", async () => {
    const restore = stubFetch(pageOf({ props: { pageProps: { initialState: {} } } }))
    try {
      await expect(quintoandar.detail(testEnv(), "1", "rent")).rejects.toThrow(/houseInfo/)
    } finally {
      restore()
    }
  })
})

describe("filtering", () => {
  let listings: Awaited<ReturnType<typeof parseSearchPage>>["listings"] = []

  test("loads the fixture", async () => {
    listings = parseSearchPage(searchPage, "rent").listings
    expect(listings).toHaveLength(6)
  })

  test("price_max uses the monthly total, not the bare rent", () => {
    // 1000 < 1125 < 1261: ordered by total monthly cost.
    const kept = applyQuery(listings, query({ priceMax: 1900 }))
    expect(kept.map((listing) => listing.id)).toEqual(["893898822", "894799943", "893237705"])
  })

  test("bedrooms_min and types narrow it", () => {
    expect(applyQuery(listings, query({ bedroomsMin: 2 })).map((entry) => entry.id)).toEqual([
      "893416226",
      "893510946",
      "894607578",
    ])
    expect(
      applyQuery(listings, query({ types: ["apartamento"] })).map((entry) => entry.id),
    ).toEqual(["894607578"])
  })

  test("a type filter matches a longer portal label", () => {
    const studios = [{ ...listings[0]!, type: "Studio ou kitchenette" }]
    expect(applyQuery(studios, query({ types: ["studio"] }))).toHaveLength(1)
    expect(applyQuery(studios, query({ types: ["casa"] }))).toHaveLength(0)
  })

  test("amenities match by name, accents and case aside", () => {
    const kept = applyQuery(listings, query({ amenities: ["box"] }))
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.every((listing) => listing.amenities.includes("Box"))).toBe(true)
  })

  test("sorts by price ascending by default", () => {
    const prices = applyQuery(listings, query()).map((listing) => listing.totalCost ?? 0)
    expect(prices).toEqual(prices.toSorted((a, b) => a - b))
  })
})

describe("crawl", () => {
  test("reads the city page and its second page, then filters", async () => {
    const restore = stubFetch(searchPage)
    try {
      const result = await quintoandar.search(testEnv(), query({ priceMax: 1900 }))
      expect(result.listings.map((entry) => entry.id)).toEqual([
        "893898822",
        "894799943",
        "893237705",
      ])
      expect(result.pagesFetched).toBe(2)
      expect(result.seen).toBe(6)
      expect(result.totalAvailable).toBe(71117)
      expect(result.areas.length).toBeGreaterThan(0)
    } finally {
      restore()
    }
  })

  test("a deep search spends more pages and keeps the pool deduplicated", async () => {
    const restore = stubFetch(searchPage)
    try {
      const result = await quintoandar.search(testEnv(), query({ deep: true }))
      expect(result.pagesFetched).toBeGreaterThan(2)
      expect(result.pagesFetched).toBeLessThanOrEqual(8)
      // The stub answers every page with the same six listings, so dedupe keeps six.
      expect(result.seen).toBe(6)
    } finally {
      restore()
    }
  })

  test("rejects an unknown city and says where to look", async () => {
    const restore = stubFetch(searchPage)
    try {
      await expect(quintoandar.search(testEnv(), query({ city: "Atlantis" }))).rejects.toThrow(
        /list_cities/,
      )
    } finally {
      restore()
    }
  })

  test("list_cities reads the index page", async () => {
    const restore = stubFetch(searchPage)
    try {
      expect(await listCities(testEnv(), "rent")).toHaveLength(4)
    } finally {
      restore()
    }
  })
})

test("nextData survives a page without the script", () => {
  expect(nextData("<html><body>nothing</body></html>")).toBeNull()
})
