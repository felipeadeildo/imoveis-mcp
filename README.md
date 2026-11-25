# imoveis-mcp

Apartment listings in Brazil, as MCP tools on a Cloudflare Worker. An agent
searches, opens a listing, looks at the photos, and hands the user links to the
files.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/felipeadeildo/imoveis-mcp)

## Tools

| Tool               | What it does                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search_listings`  | City, rent or buy, price ceiling, rooms, area, type, amenities, sorting. Returns compact listings.                                                            |
| `get_listing`      | One listing in full: monthly cost split into rent, condo and IPTU, area, rooms, suites, parking, furniture, pets, coordinates, amenities, description, media. |
| `see_photos`       | The photos as images the model can see, in the order the source shows them, with `focus` to keep one room.                                                    |
| `get_media`        | Photo and video links, at the size you ask for.                                                                                                               |
| `compare_listings` | Two to six listings side by side, with price per square metre.                                                                                                |
| `list_cities`      | The cities the source covers.                                                                                                                                 |
| `list_sources`     | Which sources this server can read right now.                                                                                                                 |

A search reports how many listings the source says exist, so the agent can tell
when the result is a slice of a bigger market. `deep: true` widens the search to
the neighbourhoods of a city, or to the streets of a neighbourhood. On a city
that means a sample across the whole city, not one area, and it costs a few more
requests.

## Media without a bucket

Three ways to hand media over. Only the last one keeps a copy:

| `serve`              | Where the link points                                 | Keeps a copy |
| -------------------- | ----------------------------------------------------- | ------------ |
| `upstream` (default) | the source's own CDN                                  | no           |
| `proxy`              | this worker, `/media/proxy?src=…`, cached at the edge | no           |
| `r2`                 | this worker's R2 bucket                               | yes          |

`see_photos` returns the photos inline as images, which needs no storage at all.
Use `r2` only when a file has to outlive the listing, since it is the one option
with a cost and a lifetime. To enable it, uncomment the `r2_buckets` entry in
`wrangler.jsonc` and deploy again.

## Deploy

The button above clones this repository into your GitHub account, creates the
Worker and deploys it. You pick the Worker and repository names, then paste a
value for `MCP_TOKEN`:

```bash
openssl rand -hex 32
```

That token is the whole secret. Anyone with it can call the tools, so keep it in
a password manager and hand it only to the client you use.

Deploying by hand takes three commands:

```bash
bunx wrangler login
bunx wrangler deploy
bunx wrangler secret put MCP_TOKEN
```

What the account needs:

| Thing          | Why                                                          |
| -------------- | ------------------------------------------------------------ |
| Workers        | Runs the server. The free plan covers this workload.         |
| Workers Builds | Only for the button or a Git connection. Not needed by hand. |
| R2             | Only for `serve: "r2"`. Skip it and nothing else breaks.     |

Nothing else is required. There is no database, no queue and no Durable Object.

### Build settings on Cloudflare

If you connect the repository through Workers Builds instead of the button, the
settings are:

| Field            | Value                                    |
| ---------------- | ---------------------------------------- |
| Build command    | leave empty                              |
| Deploy command   | `bunx wrangler deploy`                   |
| Preview command  | `bunx wrangler preview` (beta), or empty |
| Root directory   | `/`                                      |
| Environment vars | none needed                              |

`MCP_TOKEN` is a secret, not a variable. Set it with
`bunx wrangler secret put MCP_TOKEN`, or under Settings, Variables and Secrets in
the dashboard. Until it is set, every MCP request answers 401.

There is no build step. The entry is TypeScript and Wrangler bundles it, so an
empty build command is correct. `npx wrangler deploy` works if the image has no
Bun.

## Run it

```bash
bun install
cp .dev.vars.example .dev.vars   # set MCP_TOKEN, 32 characters or more
bunx wrangler dev                # http://localhost:8787/mcp
```

```bash
bun test          # no network, saved pages as fixtures
bun run lint      # oxlint, type-aware
bun run fmt       # oxfmt
bun run check     # types, lint, format, tsc and tests
```

## Connect a client

```bash
claude mcp add --transport http imoveis https://imoveis-mcp.<account>.workers.dev/mcp \
  --header "Authorization: Bearer $MCP_TOKEN"
```

Any client that takes JSON:

```json
{
  "mcpServers": {
    "imoveis": {
      "type": "http",
      "url": "https://imoveis-mcp.<account>.workers.dev/mcp",
      "headers": { "Authorization": "Bearer <MCP_TOKEN>" }
    }
  }
}
```

The token can also come as `?token=`, for clients that only accept a URL.

## Endpoints

| Route                                       | Auth   | What                                         |
| ------------------------------------------- | ------ | -------------------------------------------- |
| `POST /mcp`                                 | bearer | MCP over streamable HTTP, stateless          |
| `GET /media/proxy?src=…`                    | none   | stream one media file, ranges passed through |
| `GET /media/<key>`                          | none   | an object from the bucket, when one is bound |
| `GET /`                                     | none   | what this server is, and its sources         |
| `GET /health`                               | none   | `{ ok: true }`                               |
| `GET /.well-known/oauth-protected-resource` | none   | metadata a 401 points at                     |

Furniture and pets are the portal's own claim. A flat can be marked furnished
while its photos show empty rooms, so check the amenity list before trusting it.

## Adding a source

A source is one file in `src/packs` that returns the shapes in
`src/packs/types.ts`, plus one line in `src/packs/registry.ts`. A site that
cannot be read belongs in the registry too, marked unavailable, so the agent
gets an answer instead of a failed request.

## Disclaimer

Unofficial, not affiliated with any listing site. It reads public listings for
one person's own apartment search.

<br>

<div align="center">
<a href="https://adeildo.dev"><img src="https://adeildo.dev/assets/images/cat.svg" width="44" alt="A cat asleep on a laptop, the adeildo.dev logo"></a>
<br>
<sub>Brought to you by <a href="https://adeildo.dev">adeildo.dev</a></sub>
</div>
