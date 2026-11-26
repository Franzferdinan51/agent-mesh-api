# Modernization — Agent Mesh API v4.3.0

This project was built in the first wave after OpenClaw's release, when the
agent ecosystem was weeks old. This document records what has changed in that
ecosystem since, what the v4.3.0 pass did about it, and what we deliberately
did *not* do yet (with reasons). Research was done against the live specs and
docs in November 2026; sources are cited at the end.

## What changed since the OpenClaw era (early 2025)

### MCP (Model Context Protocol)
In early 2025 MCP was months old: the 2024-11-05 spec, stdio-first, remote
access via the two-endpoint HTTP+SSE transport, no standardized auth, and no
structured tool output, elicitation, or tasks. Since then:

- Streamable HTTP replaced HTTP+SSE (2025-03-26) and is the only remote
  transport.
- Auth standardized on OAuth 2.1 with Protected Resource Metadata,
  audience-bound tokens, and a ban on token passthrough (2025-06-18,
  tightened twice since; client ID metadata documents are replacing dynamic
  registration).
- Tools gained `outputSchema`/`structuredContent`; elicitation (form + URL
  modes) and experimental tasks arrived (2025-11-25).
- The **2026-07-28 revision removed protocol sessions and the `initialize`
  handshake entirely** (stateless, per-request metadata), moved tasks into an
  extension, replaced server-initiated requests with multi-round-trip
  requests, and deprecated roots/sampling/logging.

A 2025-era MCP integration — stdio-only, SSE-based, or session-assuming — is
two protocol generations behind.

### A2A (Agent2Agent)
A2A didn't exist publicly in early 2025 (announced by Google in April 2025).
It went 0.1 → 0.2 → **0.3.0** (the shape most tutorials still describe:
`message/send`, `kind`-discriminated Parts, lowercase task states, a top-level
`url` in the Agent Card) → governance moved to the Linux Foundation →
**1.0.0 (March 2026)**, which rebuilt the spec around a normative protobuf
model and **broke wire compatibility**: PascalCase methods (`SendMessage`,
`GetTask`), Agent Cards built on `supportedInterfaces[]`, oneof Parts,
`TASK_STATE_*` values, three formal bindings (JSON-RPC / gRPC / HTTP+JSON),
signed agent cards, and `A2A-Version` header negotiation where *no header
legally means 0.3*. Implement 1.0; treat 0.3 as a legacy compatibility
profile; never mix the two on one endpoint.

### Node.js
In early 2025 the target was Node 20 LTS / 22 entering LTS, and a typical API
server installed `sqlite3`, `axios`, `ws`, `uuid`, `dotenv`, and a test
framework before writing any business logic. Since then: Node 20 hit EOL
(April 2026), 22 and 24 moved into Maintenance LTS, and **Node 26 "Lithium"
became the LTS line (October 2026, supported to April 2029)**. The platform
absorbed most of that dependency list: `node:sqlite` reached Release
Candidate, `fetch` and a WebSocket *client* are built in,
`crypto.randomUUID()`, `node:test`, `--env-file`, and `--watch` are standard.
Two honest exceptions: `node:sqlite` is still RC (not Stability 2), and there
is still no built-in WebSocket *server*.

### API security practice
The OWASP API Top 10 framing hasn't changed, but the baseline expectation
has hardened: API keys hashed at rest (with prefixes/scopes/rotation rather
than one shared plaintext key in a config file), per-key + per-IP rate
limiting with `429`/`Retry-After`, default security headers,
request-ID-correlated structured logs with secrets kept out, separate
liveness/readiness endpoints, and an OpenAPI 3.1 contract. For agent
infrastructure specifically: treat every agent-registered endpoint as SSRF
surface, authenticate "internal" mesh APIs exactly like public ones, and
align with the protocols' own auth stories (MCP's OAuth 2.1/PRM, A2A's
card-declared schemes) instead of inventing per-integration auth.

## What v4.3.0 did about it

### Tier 1 — hardening & operability
- **Keys hashed at rest.** New `agent_api_keys` table stores sha256 hashes.
  The config/env key is seeded hashed; legacy plaintext rows are
  transparently upgraded on first successful authentication; comparisons are
  timing-safe (digest equality). New keys are created via
  `POST /api/keys` (plaintext shown once), listed via `GET /api/keys`, and
  revoked via `DELETE /api/keys/:id` (the config key is non-revocable).
  Existing clients — including users of the well-known default key — see no
  behavior change; the default key now also triggers a loud boxed warning at
  boot, because it is public knowledge and must be replaced for any real
  deployment.
- **Rate limiting.** Hand-rolled in-memory limiter on `/api/*` and `/a2a*`:
  300 requests/minute per key+IP by default, env-tunable
  (`AGENT_MESH_RATE_LIMIT_MAX`, `AGENT_MESH_RATE_LIMIT_WINDOW_MS`), `429`
  with `Retry-After` when exceeded. `/health` and `/ready` are exempt.
- **Security headers, hand-rolled** (a fixed four-header set does not justify
  the helmet dependency): `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and a CSP whose
  `connect-src` is deliberately widened because the Web UI console accepts a
  user-configured mesh URL (verified against the built Web UI).
- **Request IDs + structured logging.** Every response carries
  `X-Request-Id` (propagated when the client sends one). Errors, auth
  failures, and 429s are JSON-logged by default; full JSON access logs are
  available with `AGENT_MESH_LOG_FORMAT=json`.
- **`/ready` distinct from `/health`.** `/health` stays the liveness probe;
  `/ready` runs a DB query, a write-transaction probe, and an event-loop lag
  check, returning 503 with the failing check named.
- **OpenAPI 3.1, generated honestly.** `GET /openapi.json` is generated per
  request by walking the live Express router — it cannot drift from the code.
  A key-gated `GET /api/debug/routes` exposes the same inventory, and
  test-v43 asserts **every** registered route appears in the spec (105
  routes, 83 paths at this release).
- **Docker + CI.** Multi-stage Dockerfile (Node 24 LTS slim, non-root,
  production deps only, Web UI built in-image, DB on a `/data` volume,
  HEALTHCHECK on `/health`), docker-compose.yml, and a GitHub Actions
  workflow that boots a scratch server and runs both API suites plus the
  Web UI build on push/PR. *Note: Docker is not installed on the development
  VM, so the image is inspection-validated but not yet build-verified —
  first `docker compose up --build` on a Docker host is the remaining
  check.*
- **Web UI overhaul.** The console was rebuilt from a four-panel monolith
  into components covering the real API surface: agents + presence, messages
  with reactions (add/remove), groups, memory, a decisions panel (tallies,
  voting, close), a scheduled-messages view (status incl. sent/failed),
  system/version display, and live updates over the existing WebSocket
  including the `reaction_removed` / `decision_vote` / `decision_closed`
  events. Lint is fully clean; the build passes.

### Tier 2 — protocol modernity
- **A2A 1.0 surface.** Agent Card at `/.well-known/agent-card.json`
  (1.0 shape: `supportedInterfaces[]`, capabilities with `streaming: false`,
  five skills derived from real mesh capabilities — agent messaging, group
  broadcast, shared memory, decision voting, scheduling). `POST /a2a`
  implements JSON-RPC `SendMessage` and `GetTask`; tasks persist in an
  `a2a_tasks` table; a send creates a real mesh message (sender
  `a2a-gateway`) and fires the existing WebSocket message events.
  **Subsetting, honestly:** no streaming, no push notifications, no
  task cancel/list, no extended agent card — and none of them are advertised
  in the card.
- **A2A 0.3 compatibility profile.** Because the ecosystem's tutorials and
  several hosted runtimes still speak 0.3, `POST /a2a/v0.3` serves the 0.3
  shapes (`message/send`, `tasks/get`, `kind`-discriminated parts, lowercase
  states) as a thin adapter over the same core — on its own interface URL,
  exactly as the 1.0 spec's versioning model intends, and listed as a second
  entry in the card's `supportedInterfaces`.
- **MCP Streamable HTTP.** The MCP server (`mcp-servers/agent-mesh-mcp`)
  keeps stdio as the default and adds an opt-in Streamable HTTP transport
  (`--transport streamable-http` or `MCP_TRANSPORT=streamable-http`, default
  `127.0.0.1:8765/mcp`), run stateless — the posture that stays valid under
  both the 2025-11-25 revision and the sessionless 2026-07-28 revision.
  All 16 tools verified over both transports. The HTTP transport has no
  built-in auth by design (matching the spec's deployment model): bind it to
  localhost/trusted networks or put it behind a proxy that enforces the mesh
  API key; never expose it raw to the internet.

### Small print — behavior changes that are not pure additions
1. `429` is a new possible response on `/api/*` and `/a2a*` (that's the
   point of rate limiting; defaults are generous).
2. Unhandled errors (e.g. malformed JSON bodies) now return a JSON
   `{error}` body instead of Express's default HTML error page.
3. The boot log gained the boxed default-key warning described above.

No existing endpoint contract, auth behavior for existing keys, or
WebSocket message shape changed. Test evidence: test-api.js 31/31,
test-v4.js 33/33, test-v43.js 11/11 (new: key hashing + migration, 429,
/ready, OpenAPI honesty, Agent Card, both A2A round-trips, headers,
request IDs), Web UI build + lint clean, MCP tools/list = 16 over stdio
and HTTP.

## Tier 3 — evaluated, not implemented

### Replace the `sqlite3` package with `node:sqlite`
- **Buys:** removes the only native dependency — no node-gyp/prebuild
  downloads, a much simpler Dockerfile and CI, faster installs; the API
  (`DatabaseSync`) is a close match for how this codebase uses sqlite.
- **Costs:** `node:sqlite` is **Release Candidate (Stability 1.2), not
  stable**; its API can still change, it requires Node ≥24 (our Docker/CI
  floor is 24, but users on 22 would be cut off), and the storage layer
  touches every route, so the swap needs a full-suite migration effort.
- **Recommendation:** *Adopt when it reaches Stability 2, or in a dedicated
  v4.4 pass behind the existing storage call-sites.* The direction is right;
  betting the data layer on an RC API today is not.

### Convert server.js to TypeScript
- **Buys:** type safety across 105 routes and the WS protocol, better
  editor/refactor support, and the Web UI already speaks TypeScript, so
  shared types (messages, decisions, tasks) become possible.
- **Costs:** server.js is a ~3,000-line single file; a big-bang conversion
  risks subtle runtime drift in exactly the layer the test suites just
  pinned down, and adds a build step to a currently zero-build server.
- **Recommendation:** *Incremental, not big-bang.* Split server.js into
  modules first (the A2A core is already separable), type new modules as
  they are extracted, and let `tsc --checkJs` cover the rest. Revisit a
  full conversion after the split.

### AG-UI protocol for the Web UI
- **Buys:** AG-UI 1.0 (September 2026) is the standard for streaming an
  agent's *run* to a frontend — typed events for text deltas, tool calls,
  state patches, and human-in-the-loop interrupts, with SDKs generated from
  a published JSON Schema. If this UI ever drives interactive agent runs,
  AG-UI is the obvious wire format.
- **Costs:** this Web UI is an **operations console** for a message bus,
  not a run interface: its live channel is mesh-wide state changes
  (messages, votes, presence), which the existing WebSocket already models
  well. AG-UI's run lifecycle (`RUN_STARTED` … `RUN_FINISHED` per agent
  execution) maps onto nothing the mesh currently does.
- **Recommendation:** *Not now.* Adopt AG-UI if/when a "talk to an agent"
  surface is added to the console; the mesh event stream and AG-UI can
  coexist (different endpoints, different jobs).

### Semantic / vector memory search
- **Buys:** the shared-memory store is currently keyword/SQL matched;
  embedding-based recall would make `mesh_memory_get`-style lookups find
  semantically related entries, which is how agents actually want to use
  shared memory in 2026.
- **Costs:** needs an embedding source (a local model via LM Studio, or an
  API — a new external dependency either way), an index (e.g. sqlite-vec —
  another native dependency, which fights the `node:sqlite` direction), and
  re-embedding/migration semantics for existing rows.
- **Recommendation:** *Worth a spike, not a commitment.* Prototype behind
  the existing memory endpoints with sqlite-vec + a local embedding model,
  measure recall quality on real mesh data, and decide from evidence.
  Keep keyword search as the fallback path.

## Sources (fetched live during this pass)
- MCP specification & changelogs — https://modelcontextprotocol.io/specification/2026-07-28/changelog · https://modelcontextprotocol.io/specification/2025-11-25/basic/transports · https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
- FastMCP HTTP deployment — https://gofastmcp.com/docs/deployment/http
- A2A specification — https://a2a-protocol.org/latest/specification/ · https://a2a-protocol.org/v0.3.0/specification/ · https://a2a-protocol.org/v1.0.1/definitions/
- Node.js releases & sqlite docs — https://nodejs.org/en/about/previous-releases · https://nodejs.org/dist/index.tab · https://nodejs.org/download/release/v24.22.0/docs/api/sqlite.html
- AG-UI 1.0 — https://www.sitepoint.com/ag-ui-1-0-stable-spec-agent-user-interaction/
- OWASP API Security Top 10 — https://apisecurity.io/encyclopedia/content/owasp-api-security-top-10-cheat-sheet-a4.pdf

Full research notes: `~/workspace/agent-mesh-overhaul/reports/research-4.3.md`
(outside this repo).
