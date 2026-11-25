export type Business = "rent" | "sale"

export interface Photo {
  url: string
  /** The room, when the portal names it. */
  caption: string | null
}

export interface Listing {
  id: string
  source: string
  url: string
  business: Business
  type: string | null
  rentPrice: number | null
  salePrice: number | null
  /** Rent plus condo plus IPTU: what is paid every month. */
  totalCost: number | null
  condo: number | null
  iptu: number | null
  area: number | null
  bedrooms: number | null
  bathrooms: number | null
  suites: number | null
  parkingSpots: number | null
  furnished: boolean
  acceptsPets: boolean | null
  address: string | null
  neighborhood: string | null
  city: string | null
  state: string | null
  lat: number | null
  lng: number | null
  photos: Photo[]
  amenities: string[]
  description: string | null
  video: string | null
  publishedAt: string | null
  tags: string[]
  /** A search card carries fewer fields than a detail page. */
  partial: boolean
}

export interface SearchQuery {
  city: string
  neighborhood?: string | undefined
  business: Business
  priceMin?: number | undefined
  priceMax?: number | undefined
  bedroomsMin?: number | undefined
  bathroomsMin?: number | undefined
  parkingMin?: number | undefined
  areaMin?: number | undefined
  types?: string[] | undefined
  furnished?: boolean | undefined
  acceptsPets?: boolean | undefined
  amenities?: string[] | undefined
  /** Crawl linked areas as well, to get past one page's worth of listings. */
  deep?: boolean | undefined
  sort?: "price_asc" | "price_desc" | "area_desc" | "newest" | undefined
  limit: number
}

export interface Area {
  name: string
  slug: string
}

export interface SearchResult {
  listings: Listing[]
  /** Pages fetched, so the caller sees what the query cost. */
  pagesFetched: number
  /** Listings read before filtering. */
  seen: number
  /** Listings the portal says exist for this search. */
  totalAvailable: number | null
  /** Page slugs that were crawled. */
  crawled: string[]
  /** Areas linked from the crawled pages, for a narrower search. */
  areas: Area[]
  /** Filters the source applies itself. Empty means everything was filtered here. */
  serverFilters: string[]
}

export interface CrawlOptions {
  /** Hard cap on page fetches. Defaults to 2, or 8 when the query is deep. */
  maxPages?: number
}

export interface Source {
  id: string
  label: string
  /** Whether a plain fetch can read it. */
  reachable: boolean
  /** One line the model reads before choosing this source. */
  note: string
  search(env: Env, query: SearchQuery, options?: CrawlOptions): Promise<SearchResult>
  detail(env: Env, id: string, business: Business): Promise<Listing>
}
