import { ToolError } from "../errors"
import { quintoandar } from "./quintoandar"
import type { Business, CrawlOptions, Listing, SearchQuery, SearchResult } from "./types"

/** The listing sources, available or not. The notes are read by the model. */
export interface SourceEntry {
  id: string
  label: string
  reachable: boolean
  note: string
  search(env: Env, query: SearchQuery, options?: CrawlOptions): Promise<SearchResult>
  detail(env: Env, id: string, business: Business): Promise<Listing>
}

function unreachable(id: string) {
  return async (): Promise<never> => {
    throw new ToolError(`${id} is not available from this server`, "use quintoandar")
  }
}

export const SOURCES: SourceEntry[] = [
  quintoandar,
  {
    id: "zap",
    label: "ZAP Imóveis",
    reachable: false,
    note: "Not available from this server.",
    search: unreachable("zap"),
    detail: unreachable("zap"),
  },
  {
    id: "vivareal",
    label: "VivaReal",
    reachable: false,
    note: "Not available from this server.",
    search: unreachable("vivareal"),
    detail: unreachable("vivareal"),
  },
  {
    id: "olx",
    label: "OLX Imóveis",
    reachable: false,
    note: "Not available from this server.",
    search: unreachable("olx"),
    detail: unreachable("olx"),
  },
  {
    id: "imovelweb",
    label: "Imovelweb",
    reachable: false,
    note: "Not available from this server.",
    search: unreachable("imovelweb"),
    detail: unreachable("imovelweb"),
  },
]

export const DEFAULT_SOURCE = "quintoandar"

export function getSource(id: string): SourceEntry {
  const entry = SOURCES.find((source) => source.id === id)
  if (!entry) {
    const known = SOURCES.map((source) => source.id).join(", ")
    throw new ToolError(`unknown source: ${id}`, `known: ${known}`)
  }
  if (!entry.reachable) {
    throw new ToolError(`${id} is not available from this server`, entry.note)
  }
  return entry
}

/** The list as the model reads it, without the functions. */
export function describeSources(): {
  id: string
  label: string
  reachable: boolean
  note: string
}[] {
  return SOURCES.map(({ id, label, reachable, note }) => ({ id, label, reachable, note }))
}
