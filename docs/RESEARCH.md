# Research notes

Internal. For whoever maintains this server, not for users. Everything here was
measured on 2026-11-25; a site changes and this file goes stale.

## MCP

- Spec: **2025-11-25** (tasks, icons, incremental OAuth scope consent,
  `WWW-Authenticate` guidance). The `2026-07-28` draft removes the GET stream and
  protocol-level sessions from Streamable HTTP.
- **Streamable HTTP** is the transport for remote servers; HTTP+SSE is gone.
  One endpoint, POST for requests, optional SSE for streaming.
- Servers SHOULD answer 403 to a bad `Origin`, and expose
  `/.well-known/oauth-protected-resource` so a 401 can point somewhere.
- This worker is **stateless**: `createMcpHandler` from `agents/mcp/server`
  builds a fresh server per request. No Durable Object, no session, nothing to
  hibernate. A crawl is request-scoped work, so state would buy nothing.

## Cloudflare

- `agents` 0.27 ships `createMcpHandler`, a stateless MCP server as a Worker
  fetch handler, with CORS and host checks. `McpAgent` (one Durable Object per
  session) is deprecated for new servers.
- `HTMLRewriter` exists in the runtime, and this server does not use it. The
  data is one JSON blob inside a `<script>`, and the links are plain anchors, so
  a regex over the page text is enough and it runs unchanged under `bun test`,
  where `HTMLRewriter` is missing. A DOM-based extractor would be the answer if
  a source needed element structure; none does yet.
- `caches.default` exists in workerd and is absent under Bun. `fetchPage` treats
  the cache as optional.
- Browser Rendering is out of scope. A headless browser costs a session per
  request and still carries a datacenter IP, and the 403s below are an egress
  identity problem, which hedy solves with TLS fingerprints and proxy lanes.

## QuintoAndar

```
GET /alugar/imovel/sao-paulo-sp-brasil              → 200, 924 KB, 26 listings
GET /alugar/imovel/sao-paulo-sp-brasil?page=2       → 200, 26 different listings
GET /alugar/imovel/sao-paulo-sp-brasil?page=3       → same as page 1
GET /alugar/imovel/sao-paulo-sp-brasil?page=4       → same as page 2
GET ...?precoMinimo=1500&precoMaximo=2500           → identical to no query
GET ...?quartos=2 / ?vagasDeGaragem=1 / ?areaMinima → identical to no query
GET ...?tiposDeImovel=apartamento                   → identical to no query
GET /alugar/imovel                                 → 200, 87 supported cities
GET /imovel/893237705/alugar                       → 200, houseInfo with detail
GET /img/{sml,med,lrg,xlg}/<file>.jpeg             → 200, 6/11/17/31 KB
GET static.quintoandar.com.br/img/lrg/<file>.jpeg  → 403
```

`__NEXT_DATA__.props.pageProps.initialState`:

- `houses`, a map of id to card: `rentPrice`, `salePrice`, `totalCost` (rent plus
  condo plus IPTU), `condoIptu`, `area`, `bedrooms`, `bathrooms`, `parkingSpots`,
  `isFurnished`, `amenities[]` (enum keys), `address`, `neighbourhood`, `city`,
  `type`, `listingTags`, `photos[{url, subtitle}]`.
- `search.visibleHouses.total`, how many listings the site reports for the
  search: 71117 for São Paulo rent, against 26 per page.
- `house.houseInfo` on a detail page, the same plus `condoPrice` and `iptu`
  apart, `suites`, `acceptsPets`, `address.lat/lng`, `generatedDescription`,
  `lastPublishedDate`, `amenities[{key, text, value: SIM|NAO}]`, `video`.
- `supportedCities`, 87 entries with `slug`, `regionId`, `hashId`.
- `search.filters.pastChoices`, the bounds the site would apply itself, always
  the defaults, which confirms the query string is ignored.

### What the card does not carry

Found by using the server against live pages:

- `parkingSpaces` is the field name; `parkingSpots` is always absent.
- Pets and furniture are not fields on a card. They exist only as amenity keys,
  `PODE_TER_ANIMAIS_DE_ESTIMACAO` and `MOBILIADO`. Reading `acceptsPets` on a
  card returns null for every listing, so a pets filter matched nothing.
- A detail page marks every amenity `SIM`, `NAO` or `NAO_INFORMADO`. Skipping
  only `NAO` puts `NAO_INFORMADO` in the result as if it were a yes.
- `search.region.info.slug` is the page's own area, while `citySlug` is always
  the city. Anchoring a crawl on `citySlug` makes a neighbourhood page link its
  neighbours instead of its own streets.
- A neighbourhood page links both streets inside it (`rua-*`, `avenida-*`) and
  neighbouring areas (`jardim-*`, `vila-*`). Only the streets stay inside.
- `visibleHouses.total` is the regional count for the map, not the count for the
  page: Vila Mariana reports 10069 against 24 cards. Treat it as an order of
  magnitude, not a promise.

### Pagination

Two pages per area, and that is the ceiling for HTML:

- `?page=N` alternates between two result sets, so there is no third page.
- Real paging is `POST apigw.prod.quintoandar.com.br/house-listing-search/v3/search/list`
  with `pagination: {page, pageSize, offset}` in the body. The client code is in
  the `find-webapp` chunks (`92130-*.js`, `_app-*.js`).
- That API answered `404 {"code":4001,"message":"The resource was not found."}`
  to every attempt without a session: `{}`, a `location`+`pagination` body, with
  and without `origin`/`referer`, GET and POST, `v2` and `v3`, with and without
  a trailing slash. It wants app credentials.
- Coverage therefore comes from the pages the site links to:
  `/alugar/imovel/<bairro>-<cidade>-<uf>-brasil` on a city page, and
  `/alugar/imovel/<rua>-<bairro>-<cidade>-<uf>-brasil` on a neighbourhood page.
  Each has its own 26 listings and its own total. `deep: true` spends up to 8
  page fetches on them.

### Other portals, same day, plain fetch

```
zapimoveis.com.br/aluguel/apartamentos/sp+sao-paulo/         → 403 "Attention Required!"
vivareal.com.br/aluguel/sp/sao-paulo/apartamento_residencial/ → 403 "Attention Required!"
olx.com.br/imoveis/aluguel/estado-sp/sao-paulo-e-regiao        → 403 "Attention Required!"
imovelweb.com.br/apartamentos-aluguel-sao-paulo-sp.html        → 403 "Just a moment..."
chavesnamao.com.br/apartamentos-para-alugar/sp-sao-paulo/      → 200, 1.3 MB, React Server Components (self.__next_f)
casamineira.com.br/imoveis/aluguel/apartamento/sao-paulo-sp    → 200, but Alagoas listings
imoveis.mercadolivre.com.br/apartamentos/aluguel/sao-paulo-sao-paulo → 200, 43 KB shell, listings by JS
```

The 403s are a datacenter-IP block, not a JS requirement: a browser from the
same host hits the same challenge. Getting past them means a different egress
identity or a logged-in session, which is a separate problem from parsing and
not something this worker tries to solve. Chaves na Mão is the next one worth
doing, since it answers 200; it streams RSC payloads instead of `__NEXT_DATA__`,
so it needs its own parser.

## Fixtures

`test/fixtures/qa-search.json` and `qa-detail.json` are trimmed copies of real
`__NEXT_DATA__` payloads, six listings and one detail page, keeping every field
the parsers read. `qa-links.html` is the anchor set from a real city page. The
tests stub `fetch`, so they are deterministic and never touch the network.
