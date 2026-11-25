import { type CallToolResult, McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { toBase64 } from "../bytes"
import { errorText } from "../errors"
import { inlineImage, proxyUrl, storeMedia } from "../media"
import { DEFAULT_SOURCE, describeSources, getSource } from "../packs/registry"
import { listCities } from "../packs/quintoandar"
import type { Listing } from "../packs/types"

const INSTRUCTIONS = `Find flats in Brazil for a user, from public listing pages.

Every listing has an id, a source and a business ("rent" or "sale"). Pass them back to the other tools.

A typical run:
1. search_listings with a city, a business and a price ceiling. It returns compact listings and "total_available", the number the source reports, so you can tell when one page is not the whole answer.
2. get_listing on the few worth a closer look, for what a search card does not carry: amenity names, condo and IPTU apart, pets, coordinates, description.
3. see_photos to look at the rooms. Each photo comes back as an image you can see. Ask for size "med" unless detail matters; "sml" is cheaper.
4. get_media when the user wants the files rather than a look. Links point at the source's CDN by default, through this worker with serve "proxy", or into its storage with serve "r2".

Prices are BRL per month for rent, with total_cost including condo and IPTU, and BRL for sale. Filters run on this server, after the pages are read, so a filter narrows what came back.

One search reads a limited number of pages. When "total_available" is much larger than what came back, run it again with deep: true: that follows the areas the page links to, which on a city page are its neighbourhoods and on a neighbourhood page are its streets. It costs a handful of requests, so use it on the second pass.

Sources: quintoandar is available. zap, vivareal, olx and imovelweb are listed but not available; do not send the user to them through this server. Call list_sources to check.`

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const
const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const

const PHOTO_SIZE = /\/(sml|med|lrg|xlg)\//

const businessSchema = z.enum(["rent", "sale"]).default("rent")
const sizeSchema = z.enum(["sml", "med", "lrg", "xlg"])
const sourceSchema = z.string().default(DEFAULT_SOURCE)

function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] }
}

function text(value: string): CallToolResult["content"][number] {
  return { type: "text", text: value }
}

/** Nulls cost tokens and say nothing, so absent fields are simply absent. */
function present(listing: Listing): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: listing.id,
    source: listing.source,
    business: listing.business,
    url: listing.url,
  }
  if (listing.type) out.type = listing.type
  if (listing.rentPrice !== null) out.rent_price = listing.rentPrice
  if (listing.salePrice !== null) out.sale_price = listing.salePrice
  if (listing.totalCost !== null) out.total_cost = listing.totalCost
  if (listing.condo !== null) out.condo = listing.condo
  if (listing.iptu !== null) out.iptu = listing.iptu
  if (listing.area !== null) out.area_m2 = listing.area
  if (listing.bedrooms !== null) out.bedrooms = listing.bedrooms
  if (listing.bathrooms !== null) out.bathrooms = listing.bathrooms
  if (listing.suites !== null) out.suites = listing.suites
  if (listing.parkingSpots !== null) out.parking = listing.parkingSpots
  if (listing.furnished) out.furnished = true
  if (listing.acceptsPets !== null) out.accepts_pets = listing.acceptsPets
  if (listing.neighborhood) out.neighborhood = listing.neighborhood
  if (listing.city) out.city = listing.city
  if (listing.state) out.state = listing.state
  if (listing.address) out.address = listing.address
  if (listing.lat !== null && listing.lng !== null)
    out.coordinates = { lat: listing.lat, lng: listing.lng }
  if (listing.amenities.length > 0) out.amenities = listing.amenities
  if (listing.description) out.description = listing.description
  if (listing.publishedAt) out.published_at = listing.publishedAt
  if (listing.tags.length > 0) out.tags = listing.tags
  if (listing.video) out.video = listing.video
  if (listing.photos.length > 0) {
    out.photo_count = listing.photos.length
    const captions = listing.photos
      .map((photo) => photo.caption)
      .filter((caption) => caption !== null)
    if (captions.length > 0) out.photo_captions = captions
  }
  if (listing.partial) out.partial = true
  return out
}

const SearchInput = z.object({
  city: z.string().min(1).describe("City name, for example 'São Paulo' or 'Rio de Janeiro'."),
  neighborhood: z
    .string()
    .optional()
    .describe(
      "Neighbourhood, for example 'Pinheiros'. Narrows the crawl to that neighbourhood's page.",
    ),
  business: businessSchema.describe("Rent or buy."),
  price_max: z
    .number()
    .positive()
    .optional()
    .describe("Ceiling in BRL: the monthly total for rent, the price for sale."),
  price_min: z.number().positive().optional(),
  bedrooms_min: z.number().int().min(0).optional(),
  bathrooms_min: z.number().int().min(0).optional(),
  parking_min: z.number().int().min(0).optional(),
  area_min: z.number().positive().optional().describe("Minimum usable area in square metres."),
  types: z
    .array(z.string())
    .optional()
    .describe(
      "Property types to keep, for example ['Apartamento', 'Studio']. Case and accents do not matter.",
    ),
  furnished: z.boolean().optional().describe("Only furnished places, when the portal says so."),
  accepts_pets: z
    .boolean()
    .optional()
    .describe("Only places that accept pets, when the portal says so."),
  amenities: z
    .array(z.string())
    .optional()
    .describe(
      "Required amenities, matched against the listing's amenity names, for example ['Piscina'].",
    ),
  deep: z
    .boolean()
    .default(false)
    .describe(
      "Follow the areas the page links to. Costs several fetches; use it when the first search is thin.",
    ),
  sort: z.enum(["price_asc", "price_desc", "area_desc", "newest"]).default("price_asc"),
  limit: z.number().int().min(1).max(60).default(20),
})

const ListingRef = z.object({
  id: z.string().min(1).describe("Listing id, from search_listings."),
  source: sourceSchema.describe("Source id; defaults to quintoandar."),
  business: businessSchema,
})

/**
 * `origin` is the URL this request came in on, so links point at the host the
 * caller used, whether that is localhost or the deployed worker.
 */
export function createServer(env: Env, origin: string): McpServer {
  const server = new McpServer(
    { name: "imoveis-mcp", version: "0.1.0" },
    { instructions: INSTRUCTIONS },
  )

  server.registerTool(
    "search_listings",
    {
      title: "Search listings",
      description:
        "Search rental or sale listings in a Brazilian city, filtered by price, rooms, area, type and amenities. Returns compact listings sorted by price, the total the portal reports, and the areas a narrower search can use.",
      inputSchema: SearchInput,
      annotations: READ,
    },
    async (input) => {
      const source = getSource(DEFAULT_SOURCE)
      const result = await source.search(env, {
        city: input.city,
        neighborhood: input.neighborhood,
        business: input.business,
        priceMin: input.price_min,
        priceMax: input.price_max,
        bedroomsMin: input.bedrooms_min,
        bathroomsMin: input.bathrooms_min,
        parkingMin: input.parking_min,
        areaMin: input.area_min,
        types: input.types,
        furnished: input.furnished,
        acceptsPets: input.accepts_pets,
        amenities: input.amenities,
        deep: input.deep,
        sort: input.sort,
        limit: input.limit,
      })
      return json({
        source: source.id,
        listings: result.listings.map(present),
        matched: result.listings.length,
        seen: result.seen,
        total_available: result.totalAvailable,
        pages_fetched: result.pagesFetched,
        areas: result.areas.map((area) => area.name),
      })
    },
  )

  server.registerTool(
    "get_listing",
    {
      title: "Listing detail",
      description:
        "Everything one listing's page carries: readable amenity names, condo and IPTU apart, suites, pets, coordinates, description, publication date and the media list. Fetches one page, so it is slower than a search result.",
      inputSchema: ListingRef,
      annotations: READ,
    },
    async (input) =>
      json(present(await getSource(input.source).detail(env, input.id, input.business))),
  )

  server.registerTool(
    "see_photos",
    {
      title: "See the photos",
      description:
        "Return a listing's photos as images the model can see, in the portal's order: cover first, then rooms. Pass focus to keep only photos whose caption matches, for example 'cozinha'. Use size 'sml' for a cheap overview and 'lrg' when a detail matters.",
      inputSchema: z.object({
        id: z.string().min(1),
        source: sourceSchema,
        business: businessSchema,
        limit: z.number().int().min(1).max(8).default(4),
        offset: z.number().int().min(0).default(0),
        size: sizeSchema.default("med"),
        focus: z
          .string()
          .optional()
          .describe(
            "Keep only photos whose caption contains this text. Case and accents do not matter.",
          ),
      }),
      annotations: READ,
    },
    async (input) => {
      const listing = await getSource(input.source).detail(env, input.id, input.business)
      const needle = input.focus?.toLowerCase()
      const chosen = listing.photos
        .filter((photo) => !needle || (photo.caption ?? "").toLowerCase().includes(needle))
        .slice(input.offset, input.offset + input.limit)

      if (chosen.length === 0) {
        return json({
          id: listing.id,
          photo_count: listing.photos.length,
          photos: [],
          note: "no photo matched",
        })
      }

      const content: CallToolResult["content"] = []
      for (const [index, photo] of chosen.entries()) {
        const position = input.offset + index + 1
        const label = photo.caption
          ? `${position}/${listing.photos.length}: ${photo.caption}`
          : `${position}/${listing.photos.length}`
        try {
          const image = await inlineImage(photo.url.replace(PHOTO_SIZE, `/${input.size}/`), env)
          content.push(
            { type: "image", data: toBase64(image.bytes), mimeType: image.mimeType },
            text(label),
          )
        } catch (error) {
          content.push(text(`${label} failed: ${errorText(error)}`))
        }
      }
      return { content }
    },
  )

  server.registerTool(
    "get_media",
    {
      title: "Photo and video links",
      description:
        "The listing's media as links at the size you ask for, plus a video when the portal publishes one. serve decides where the links point: 'upstream' is the portal's CDN, free and seekable; 'proxy' streams through this worker, for a link that does not name the portal; 'r2' copies the files into this worker's storage, the only option that survives the listing being taken down, and it needs the bucket to be configured.",
      inputSchema: z.object({
        id: z.string().min(1),
        source: sourceSchema,
        business: businessSchema,
        size: sizeSchema.default("lrg"),
        serve: z.enum(["upstream", "proxy", "r2"]).default("upstream"),
        limit: z.number().int().min(1).max(40).default(20),
      }),
      annotations: WRITE,
    },
    async (input) => {
      const source = getSource(input.source)
      const listing = await source.detail(env, input.id, input.business)
      const photos = listing.photos.slice(0, input.limit).map((photo) => ({
        caption: photo.caption,
        url: photo.url.replace(PHOTO_SIZE, `/${input.size}/`),
      }))

      if (input.serve === "upstream") {
        return json({ id: listing.id, serve: "upstream", photos, video: listing.video })
      }
      if (input.serve === "proxy") {
        return json({
          id: listing.id,
          serve: "proxy",
          photos: photos.map((photo) => ({ ...photo, url: proxyUrl(origin, photo.url) })),
          video: listing.video ? proxyUrl(origin, listing.video) : null,
        })
      }

      const saved: Record<string, unknown>[] = []
      for (const [index, photo] of photos.entries()) {
        try {
          const stored = await storeMedia(
            env,
            origin,
            photo.url,
            `${source.id}/${listing.id}/photo-${index + 1}`,
          )
          saved.push({ caption: photo.caption, ...stored })
        } catch (error) {
          saved.push({ caption: photo.caption, error: errorText(error) })
        }
      }
      let video: unknown = null
      if (listing.video) {
        video = await storeMedia(
          env,
          origin,
          listing.video,
          `${source.id}/${listing.id}/video`,
        ).catch((error) => ({
          error: errorText(error),
        }))
      }
      return json({ id: listing.id, serve: "r2", photos: saved, video })
    },
  )

  server.registerTool(
    "compare_listings",
    {
      title: "Compare listings",
      description:
        "Fetch two to six listings and lay them side by side on the fields that decide a flat: total monthly cost, price per square metre, area, rooms, parking, pets, furniture and amenities.",
      inputSchema: z.object({
        ids: z.array(z.string().min(1)).min(2).max(6),
        source: sourceSchema,
        business: businessSchema,
      }),
      annotations: READ,
    },
    async (input) => {
      const source = getSource(input.source)
      const listings = await Promise.all(
        input.ids.map((id) =>
          source.detail(env, id, input.business).catch((error) => errorText(error)),
        ),
      )
      const rows = listings.map((entry) => {
        if (typeof entry === "string") return { error: entry }
        const price =
          entry.business === "rent" ? (entry.totalCost ?? entry.rentPrice) : entry.salePrice
        return {
          id: entry.id,
          url: entry.url,
          type: entry.type,
          price,
          total_cost: entry.totalCost,
          area_m2: entry.area,
          price_per_m2: price !== null && entry.area ? Math.round(price / entry.area) : null,
          bedrooms: entry.bedrooms,
          bathrooms: entry.bathrooms,
          parking: entry.parkingSpots,
          furnished: entry.furnished,
          accepts_pets: entry.acceptsPets,
          neighborhood: entry.neighborhood,
          amenities: entry.amenities,
          photos: entry.photos.length,
          video: entry.video !== null,
        }
      })
      return json({ listings: rows })
    },
  )

  server.registerTool(
    "list_cities",
    {
      title: "Cities with listings",
      description:
        "The cities this source covers, read from its own index page. Use it when a search says the city is unknown, or to pick a city before searching.",
      inputSchema: z.object({ business: businessSchema }),
      annotations: READ,
    },
    async (input) => json({ cities: await listCities(env, input.business) }),
  )

  server.registerTool(
    "list_sources",
    {
      title: "Sources",
      description: "Which sources this server can read right now, and which it cannot.",
      inputSchema: z.object({}),
      annotations: READ,
    },
    async () => json({ sources: describeSources() }),
  )

  return server
}
