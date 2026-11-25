import { ToolError } from "../errors"
import { fetchText } from "../http"
import { links, nextData, slugify, toNumber } from "../html"
import type { Area, Business, Listing, Photo, SearchQuery, SearchResult, Source } from "./types"

/**
 * QuintoAndar.
 *
 * Everything here was measured against the live site on 2026-11-25 with a
 * plain fetch; docs/RESEARCH.md keeps the request log.
 *
 * A search page is server-rendered Next.js. `__NEXT_DATA__` carries
 * `props.pageProps.initialState.houses`, a map of listing id to card, and
 * `search.visibleHouses.total`, the number of listings the portal says exist
 * for that search. A card has prices, area, rooms, address, neighbourhood and
 * the photo filenames. The detail page adds `house.houseInfo`: readable amenity
 * names, condo and IPTU apart, suites, pets, coordinates and the description.
 *
 * Two limits shape the crawl:
 *
 * - The site ignores query-string filters. `?precoMinimo=`, `?quartos=`,
 *   `?vagasDeGaragem=`, `?areaMinima=` and `?tiposDeImovel=` all return the
 *   page you would get without them, so filtering happens in applyQuery.
 * - The site serves two result pages, not more: `?page=3` repeats page 1 and
 *   `?page=4` repeats page 2. Real paging lives behind the app's API, which
 *   answers 404 without a session. Coverage therefore comes from the pages a
 *   search page links to: neighbourhoods of a city, streets of a neighbourhood.
 */

const ORIGIN = "https://www.quintoandar.com.br"
const PHOTO_SIZE = /\/(sml|med|lrg|xlg)\//
const CITY_INDEX_TTL = 86_400

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** The two hops of `__NEXT_DATA__` this source reads. */
function initialStateOf(page: unknown): Record<string, unknown> {
  const pageProps = asRecord(asRecord(page).props).pageProps
  return asRecord(asRecord(pageProps).initialState)
}

export function searchPath(business: Business, slug: string): string {
  return `/${business === "rent" ? "alugar" : "comprar"}/imovel/${slug}`
}

export function detailPath(id: string, business: Business): string {
  return `/imovel/${id}/${business === "rent" ? "alugar" : "comprar"}`
}

/**
 * Photo URLs arrive as bare filenames in the JSON and as absolute URLs in the
 * markup. Both resolve, and the size is a path segment: the same photo costs
 * about 6, 11, 17 or 31 KB at sml, med, lrg or xlg.
 */
export function photoUrl(file: string, size: "sml" | "med" | "lrg" | "xlg" = "lrg"): string {
  if (PHOTO_SIZE.test(file)) return file.replace(PHOTO_SIZE, `/${size}/`)
  if (file.startsWith("http")) return file
  return `${ORIGIN}/img/${size}/${file.replace(/^\/+/, "")}`
}

/** The portal writes "StudioOuKitchenette"; read that as "Studio ou kitchenette". */
export function prettyType(raw: string | null): string | null {
  if (!raw) return null
  const words = raw
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase()
    .trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** "ARMARIOS_NA_COZINHA" becomes "Armarios na cozinha"; detail pages have proper text. */
function humanizeKey(key: string): string {
  const words = key.toLowerCase().replace(/_/g, " ").trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function amenitiesOf(raw: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const entry of asList(raw.amenities)) {
    if (typeof entry === "string") {
      out.push(humanizeKey(entry))
      continue
    }
    const amenity = asRecord(entry)
    // Detail pages list every amenity with SIM or NAO; keep the SIM ones.
    if (amenity.value === "NAO") continue
    const key = asString(amenity.key)
    const text = asString(amenity.text) ?? (key ? humanizeKey(key) : null)
    if (text) out.push(text)
  }
  return [...new Set(out)]
}

function photosOf(raw: Record<string, unknown>): Photo[] {
  const out: Photo[] = []
  for (const entry of asList(raw.photos)) {
    const photo = asRecord(entry)
    const file = asString(photo.url)
    if (!file) continue
    out.push({ url: photoUrl(file), caption: asString(photo.subtitle) })
  }
  return out
}

function listingOf(
  raw: Record<string, unknown>,
  business: Business,
  partial: boolean,
): Listing | null {
  const id = asString(raw.id)
  if (!id) return null
  const address = asRecord(raw.address)
  const salePrice = toNumber(raw.salePrice)
  return {
    id,
    source: "quintoandar",
    url: `${ORIGIN}${detailPath(id, business)}`,
    business,
    type: prettyType(asString(raw.type)),
    rentPrice: toNumber(raw.rentPrice),
    salePrice: salePrice === null || salePrice === 0 ? null : salePrice,
    totalCost: toNumber(raw.totalCost),
    condo: toNumber(raw.condoPrice ?? raw.condoIptu),
    iptu: toNumber(raw.iptu),
    area: toNumber(raw.area),
    bedrooms: toNumber(raw.bedrooms),
    bathrooms: toNumber(raw.bathrooms),
    suites: toNumber(raw.suites),
    parkingSpots: toNumber(raw.parkingSpots),
    furnished: raw.isFurnished === true || raw.hasFurniture === true,
    acceptsPets: asBoolean(raw.acceptsPets),
    address: asString(address.address) ?? asString(address.street),
    neighborhood:
      asString(raw.neighbourhood) ?? asString(address.neighborhood) ?? asString(raw.regionName),
    city: asString(address.city) ?? asString(raw.city),
    state: asString(address.stateAcronym) ?? asString(address.stateName),
    lat: toNumber(address.lat),
    lng: toNumber(address.lng),
    photos: photosOf(raw),
    amenities: amenitiesOf(raw),
    description:
      asString(raw.generatedDescription) ??
      asString(raw.remarks) ??
      asString(raw.shortRentDescription) ??
      asString(raw.shortSaleDescription),
    video: asString(raw.video),
    publishedAt: asString(raw.lastPublishedDate),
    tags: asList(raw.listingTags).filter((tag): tag is string => typeof tag === "string"),
    partial,
  }
}

export interface City {
  name: string
  state: string
  slug: string
}

export interface SearchPage {
  listings: Listing[]
  cities: City[]
  /** Neighbourhoods of a city, or streets of a neighbourhood. */
  areas: Area[]
  /** What the portal says exists for this search, which is usually far more than one page. */
  totalAvailable: number | null
}

/** Read one search page: its listings, the city index, its links and its total. */
export function parseSearchPage(html: string, business: Business): SearchPage {
  const state = initialStateOf(nextData(html))
  const listings: Listing[] = []
  for (const value of Object.values(asRecord(state.houses))) {
    const listing = listingOf(asRecord(value), business, true)
    if (listing) listings.push(listing)
  }

  const cities: City[] = []
  for (const entry of asList(state.supportedCities)) {
    const city = asRecord(entry)
    const name = asString(city.primaryText)
    const slug = asString(city.slug)
    if (!name || !slug) continue
    cities.push({ name, state: asString(city.secondaryTextAlt) ?? "", slug })
  }

  const visibleHouses = asRecord(asRecord(state.search).visibleHouses)
  const region = asRecord(asRecord(asRecord(state.search).region).info)
  const selfSlug = asString(region.citySlug) ?? asString(region.slug)
  return {
    listings,
    cities,
    areas: selfSlug ? linkedAreas(html, business, selfSlug) : [],
    totalAvailable: toNumber(visibleHouses.total),
  }
}

/**
 * The narrower pages a search page links to. On a city page these are its
 * neighbourhoods; on a neighbourhood page they are the streets inside it. The
 * slug is kept whole, exactly as linked, so it can be fetched back without
 * rebuilding it; the name drops the city part for display.
 */
function linkedAreas(html: string, business: Business, selfSlug: string): Area[] {
  const prefix = searchPath(business, "")
  const hrefs = links(html, new RegExp(`^${prefix}[a-z0-9-]+$`))
  const suffix = `-${selfSlug}`
  const areas: Area[] = []
  const seen = new Set<string>()
  for (const href of hrefs) {
    const slug = href.slice(prefix.length)
    if (!slug.endsWith(suffix)) continue
    const name = slug.slice(0, -suffix.length)
    if (!name || seen.has(name)) continue
    seen.add(name)
    areas.push({ name: name.replace(/-/g, " "), slug })
  }
  return areas
}

function priceOf(listing: Listing): number | null {
  return listing.business === "rent" ? (listing.totalCost ?? listing.rentPrice) : listing.salePrice
}

/** A listing passes when every filter accepts it. */
type Filter = (listing: Listing) => boolean

function atLeast(value: number | null, minimum: number | undefined): boolean {
  if (minimum === undefined) return true
  return (value ?? 0) >= minimum
}

function priceInRange(listing: Listing, query: SearchQuery): boolean {
  const price = priceOf(listing)
  if (query.priceMin !== undefined && (price === null || price < query.priceMin)) return false
  if (query.priceMax !== undefined && (price === null || price > query.priceMax)) return false
  return true
}

function typeMatches(listing: Listing, wanted: string[]): boolean {
  if (wanted.length === 0) return true
  const type = slugify(listing.type ?? "")
  return wanted.some((one) => type.includes(one))
}

function amenitiesMatch(listing: Listing, wanted: string[]): boolean {
  if (wanted.length === 0) return true
  const have = listing.amenities.map(slugify)
  return wanted.every((one) => have.some((text) => text.includes(one)))
}

/** Every filter the source refuses to apply itself. */
export function applyQuery(listings: Listing[], query: SearchQuery): Listing[] {
  const types = (query.types ?? []).map(slugify)
  const amenities = (query.amenities ?? []).map(slugify)
  const filters: Filter[] = [
    (listing) => priceInRange(listing, query),
    (listing) => atLeast(listing.bedrooms, query.bedroomsMin),
    (listing) => atLeast(listing.bathrooms, query.bathroomsMin),
    (listing) => atLeast(listing.parkingSpots, query.parkingMin),
    (listing) => atLeast(listing.area, query.areaMin),
    (listing) => query.furnished !== true || listing.furnished,
    (listing) => query.acceptsPets !== true || listing.acceptsPets === true,
    (listing) => typeMatches(listing, types),
    (listing) => amenitiesMatch(listing, amenities),
  ]
  return listings
    .filter((listing) => filters.every((filter) => filter(listing)))
    .toSorted(comparator(query.sort))
}

function comparator(sort: SearchQuery["sort"]): (a: Listing, b: Listing) => number {
  switch (sort) {
    case "price_desc":
      return (a, b) => (priceOf(b) ?? 0) - (priceOf(a) ?? 0)
    case "area_desc":
      return (a, b) => (b.area ?? 0) - (a.area ?? 0)
    case "newest":
      return (a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "")
    default:
      return (a, b) =>
        (priceOf(a) ?? Number.MAX_SAFE_INTEGER) - (priceOf(b) ?? Number.MAX_SAFE_INTEGER)
  }
}

export function findCity(cities: City[], name: string): City | null {
  const needle = slugify(name)
  const exact = cities.find((city) => slugify(city.name) === needle || city.slug === needle)
  if (exact) return exact
  return (
    cities.find((city) => city.slug.startsWith(needle) || slugify(city.name).startsWith(needle)) ??
    null
  )
}

/** The city index. `/alugar/imovel` serves it without any listing. */
export async function listCities(env: Env, business: Business): Promise<City[]> {
  const page = await fetchText(`${ORIGIN}${searchPath(business, "")}`, env, { ttl: CITY_INDEX_TTL })
  return parseSearchPage(page, business).cities
}

/** What one crawl collected, before filtering. */
interface Pool {
  listings: Listing[]
  pagesFetched: number
  crawled: string[]
  totalAvailable: number | null
  areas: Area[]
}

/**
 * Read the seed area, its second page, then the areas it links to, until the
 * page budget is spent. This is the whole crawl; filtering happens afterwards
 * in applyQuery.
 */
async function crawl(env: Env, business: Business, seed: string, maxPages: number): Promise<Pool> {
  const byId = new Map<string, Listing>()
  const crawled = new Set<string>()
  let totalAvailable: number | null = null
  let pagesFetched = 0

  const read = async (slug: string, page: 1 | 2): Promise<SearchPage> => {
    const path = searchPath(business, slug)
    const url = `${ORIGIN}${path}${page === 2 ? "?page=2" : ""}`
    const parsed = parseSearchPage(await fetchText(url, env), business)
    pagesFetched += 1
    crawled.add(slug)
    for (const listing of parsed.listings) if (!byId.has(listing.id)) byId.set(listing.id, listing)
    totalAvailable ??= parsed.totalAvailable
    return parsed
  }

  const seedPage = await read(seed, 1)
  if (maxPages > 1) await read(seed, 2)

  // Areas in the order the page links them. The page repeats some, and `read`
  // does not deduplicate, so the budget can be spent twice on the same slug;
  // skipping a slug already read keeps each area at one fetch.
  for (const area of seedPage.areas) {
    if (pagesFetched >= maxPages) break
    if (crawled.has(area.slug)) continue
    await read(area.slug, 1)
  }

  return {
    listings: [...byId.values()],
    pagesFetched,
    crawled: [...crawled],
    totalAvailable,
    areas: seedPage.areas,
  }
}

export const quintoandar: Source = {
  id: "quintoandar",
  label: "QuintoAndar",
  reachable: true,
  note: "Apartments, houses and studios for rent and sale, across Brazil.",

  async search(env, query, options = {}): Promise<SearchResult> {
    const city = findCity(await listCities(env, query.business), query.city)
    if (!city) {
      throw new ToolError(
        `city not found: ${query.city}`,
        "call list_cities for the cities this source covers",
      )
    }

    const seed = query.neighborhood ? `${slugify(query.neighborhood)}-${city.slug}` : city.slug
    const maxPages = options.maxPages ?? (query.deep ? 8 : 2)
    const pool = await crawl(env, query.business, seed, maxPages)
    return {
      listings: applyQuery(pool.listings, query).slice(0, query.limit),
      pagesFetched: pool.pagesFetched,
      seen: pool.listings.length,
      totalAvailable: pool.totalAvailable,
      crawled: pool.crawled,
      areas: pool.areas,
      serverFilters: [],
    }
  },

  async detail(env, id, business): Promise<Listing> {
    const url = `${ORIGIN}${detailPath(id, business)}`
    const info = asRecord(
      asRecord(initialStateOf(nextData(await fetchText(url, env))).house).houseInfo,
    )
    if (Object.keys(info).length === 0) {
      throw new ToolError(
        `listing not found: ${id}`,
        `the detail page at ${url} carried no houseInfo`,
      )
    }
    const listing = listingOf(info, business, false)
    if (!listing) throw new ToolError(`listing not found: ${id}`)
    return listing
  },
}
