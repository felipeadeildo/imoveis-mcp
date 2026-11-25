/**
 * Reading data out of an HTML page.
 *
 * The pages this server reads are server-rendered Next.js: the search result
 * set is one JSON blob inside `<script id="__NEXT_DATA__">`, and the links we
 * follow are plain anchors. Both are a single pass over the page text, so the
 * readers here take a string and nothing else.
 */

const NEXT_DATA = /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i
const HREF = /href="([^"]+)"/g

/** The raw JSON text inside `<script id="__NEXT_DATA__">`, or null. */
export function nextDataScript(html: string): string | null {
  return NEXT_DATA.exec(html)?.[1] ?? null
}

/**
 * The parsed `__NEXT_DATA__` payload, or null when the page has none. This is
 * untrusted input, so it comes back as `unknown` and each reader narrows it.
 */
export function nextData(html: string): unknown {
  const script = nextDataScript(html)
  if (script === null) return null
  try {
    const parsed: unknown = JSON.parse(script)
    return parsed
  } catch {
    return null
  }
}

/** Every `href` that matches `pattern`, in document order, deduplicated. */
export function links(html: string, pattern: RegExp): string[] {
  const found = new Set<string>()
  for (const match of html.matchAll(HREF)) {
    const href = match[1]
    if (href && pattern.test(href)) found.add(href)
  }
  return [...found]
}

/** "São Paulo" becomes "sao-paulo", the shape these sites use in URLs. */
export function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/**
 * A number, or null. A string arrives as "R$ 1.200,50" when a person wrote the
 * field, so a comma is read as the decimal mark.
 */
export function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value !== "string") return null
  const digits = value.replace(/[^\d,.]/g, "")
  if (digits === "") return null
  const parsed = Number(digits.includes(",") ? digits.replace(/\./g, "").replace(",", ".") : digits)
  return Number.isFinite(parsed) ? parsed : null
}
