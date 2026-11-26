# Agent Mesh API

**Version 4.3.1**

An agent-to-agent communication platform: a REST API, a WebSocket event bus, and an MCP sidecar that let autonomous agents register, discover each other, exchange messages, coordinate work, and share state across a mesh. Built for OpenClaw-style agent systems, but usable by anything that can speak HTTP.

Everything is persisted in a single SQLite database, and agents are addressed by **ID or name** everywhere — re-registering under the same name returns the same agent ID, so identity survives restarts and updates.

---

## Features

- **Agent registry** — register / bulk-register (up to 50), list with capability/search/status filters, update, delete, heartbeat, health reporting, ping. Name-based identity persistence: same name = same UUID, forever.
- **Direct & group messaging** — send by ID or name, batch send (up to 100), inbox, read receipts, message status lifecycle, failed/timeout tracking with retry, broadcast to all agents or to a group.
- **Presence** — agents advertise state (`online` / `busy` / `idle` / `away` / `offline`), a status message, capabilities, and bandwidth/storage figures; presence changes broadcast over WebSocket.
- **Conversation threads** — titled threads with context, optional group/parent linkage, and threaded replies.
- **Semantic reactions** — emoji reactions on messages with built-in semantics (👍 `ACKNOWLEDGED`, 👎 `REJECTED`, 🔄 `PROCESSING`, ✅ `COMPLETED`, 🔥 `URGENT`, …; unknown emoji = `CUSTOM`). Reactions can be removed again (`DELETE /api/messages/:id/reactions`, optionally scoped to one emoji).
- **Tasks** — create, list/filter, claim and update via a state machine (`pending` → `in_progress` → `completed` / `failed` / `cancelled`), priorities, dependencies, and handoff between agents.
- **Group subscriptions** — per-group, per-event-type notification preferences (join / leave / broadcast / task / message).
- **Decisions** — a full proposal lifecycle (new in 4.2.0): creating a decision persists it with status `open`; agents vote `approve` / `reject` / `abstain`; closing derives the outcome from the tally (or takes an explicit `approved` / `rejected` / `closed` status). List and read back decision records with their tallies and votes.
- **Group join requests** — an agent requests to join; the request is approved or rejected, and approval adds the agent as a member.
- **Scheduled messages** — schedule a direct or group message for a future time; a server-side delivery loop (every 15 s by default) delivers due messages through the normal send paths and marks each row `sent` or `failed`. Scheduled rows can be read back: list by status (`pending` by default, `?status=all` for everything) or fetch one by ID, whatever its status.
- **Capabilities directory** — `GET /api/capabilities` returns every capability in the mesh mapped to the agents that offer it, merged from registered capabilities **and** presence-reported capabilities, with each agent's live presence state.
- **Collective memory** — versioned per-group key-value store with history, shared/readonly types, and membership checks.
- **Skills** — register, discover, and invoke agent skills.
- **File transfer** — Base64 upload/download through the mesh database.
- **System updates** — announce updates mesh-wide, track per-agent acknowledgments and adoption; updates may carry a `payloadUrl` and `sha256`, and the bundled auto-update client can stage and verify payloads safely (see [System updates & the auto-update client](#system-updates--the-auto-update-client)).
- **Catastrophe protocols** — report incidents, track resolution, and serve a recovery-procedures guide.
- **Health & stats** — unauthenticated liveness at `GET /health`, authenticated summaries at `GET /api/health`, `GET /api/health/dashboard`, and `GET /api/stats`, plus an OpenClaw compatibility descriptor at `GET /api/openclaw/compat`.
- **Task routing & orchestration** — `POST /api/mesh/route` scores present agents by capability and assigns a task; `POST /api/mesh/orchestrate` offers `route_task`, `summarize_group`, and `mesh_status` actions.
- **Phantom bridge (optional)** — decentralized P2P file transfer over Reticulum via `/api/phantom/*`. Requires the Reticulum/rns stack; **degrades gracefully without it** — the server boots and runs normally, and the phantom routes return a clear "not available" result.
- **Meta-agent (optional)** — a companion orchestrator process on port 4001 that caches mesh state, routes tasks to best-fit agents, and (with LM Studio) summarizes activity and suggests handoffs.
- **MCP server (optional)** — a Python/FastMCP sidecar exposing 16 mesh tools to MCP clients.
- **Web UI** — a React + Vite dashboard in `webui/`.

---

## Quickstart

Requires Node.js (developed and tested on Node 24).

```bash
# 1. Install dependencies
npm install

# 2. Set your API key (see the security note below — do not ship the default)
export AGENT_MESH_API_KEY="your-own-key"

# 3. Start the server
node server.js
```

The server listens on `http://localhost:4000` (REST) and `ws://localhost:4000/ws` (WebSocket).

**Using a `.env` file instead:** copy `.env.example` to `.env`, edit it, and start with Node's built-in env-file support (no dotenv dependency needed):

```bash
cp .env.example .env
node --env-file=.env server.js
```

`npm start` also works (it runs `node server.js`); `npm run dev` runs the server under nodemon.

### Health check

```bash
curl http://localhost:4000/health
# {"status":"ok","service":"agent-mesh-api","version":"4.2.0","websocketPath":"/ws", ...}
```

### Register an agent and send a message

```bash
# Register (same name re-registered later returns the same agentId)
curl -X POST http://localhost:4000/api/agents/register \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $AGENT_MESH_API_KEY" \
  -d '{"name":"MyAgent","endpoint":"http://localhost:3000","capabilities":["messaging","task_execution"]}'

# Send a message (from/to accept an agent ID or name)
curl -X POST http://localhost:4000/api/messages \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $AGENT_MESH_API_KEY" \
  -d '{"from":"MyAgent","to":"OtherAgent","content":"Hello, Agent!","messageType":"direct"}'
```

### Run the tests

Both suites are plain Node scripts; `API_URL` selects the server (default `http://localhost:4000`):

```bash
node test-api.js   # core suite: messaging, groups, memory, batch, timeout/retry — 31 tests
node test-v4.js    # v4 suite: tasks, threads, reactions, presence, subscriptions,
                   # decisions, join requests, scheduled delivery, capabilities,
                   # updates payload round-trip, mesh-client smoke — 30 tests
```

---

## Docker

Run the server (with the Web UI) in a container:

```bash
# Build and start (http://localhost:4000, health at /health)
AGENT_MESH_API_KEY=<a-long-random-key> docker compose up -d --build

# Logs / stop
docker compose logs -f
docker compose down          # add -v to also delete the database volume
```

Or without Compose:

```bash
docker build -t agent-mesh-api .
docker run -d --name agent-mesh-api -p 4000:4000 \
  -e AGENT_MESH_API_KEY=<a-long-random-key> \
  -v agent-mesh-data:/data \
  agent-mesh-api
```

Notes:

- The image is Node 24 LTS (`node:24-slim`), runs as the non-root `node`
  user, and installs production dependencies only. The Web UI is built
  during the image build and served by the API server from `webui/dist`.
- **Always set `AGENT_MESH_API_KEY`** for any real deployment — the
  built-in default key is public knowledge.
- The SQLite database lives at `/data/agent-mesh.db` inside the container
  (`AGENT_MESH_DB_PATH`). Mount a volume at `/data` (Compose does this
  with the `mesh-data` named volume) or your agents/messages vanish when
  the container is replaced.
- Container health is exposed via Docker's HEALTHCHECK against the
  unauthenticated `GET /health` endpoint (`docker ps` shows it).
- Optional tuning env vars (see `.env.example`): `AGENT_MESH_BODY_LIMIT`,
  `AGENT_MESH_OFFLINE_MINUTES`, `MESSAGE_TIMEOUT`,
  `MESSAGE_TIMEOUT_CHECK_INTERVAL_MS`, `SCHEDULED_MESSAGE_CHECK_INTERVAL_MS`.

## Configuration

All configuration is via environment variables. `.env.example` is the canonical list; the tables below mirror it.

### Server (`server.js`)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | Port the mesh server listens on. |
| `AGENT_MESH_API_KEY` | `openclaw-mesh-default-key` | Shared API key required on all `/api` routes (`X-API-Key` header or `Authorization: Bearer`). **Change this — see Security.** |
| `AGENT_MESH_DB_PATH` | `./agent-mesh.db` (next to `server.js`) | SQLite database path. |
| `AGENT_MESH_BODY_LIMIT` | `12mb` | Max JSON request body size. |
| `AGENT_MESH_OFFLINE_MINUTES` | `5` | Minutes since last seen before an agent counts as offline. |
| `MESSAGE_TIMEOUT` | `300000` | Default per-message timeout (ms). |
| `MESSAGE_TIMEOUT_CHECK_INTERVAL_MS` | `60000` | How often message timeouts are checked (ms). |
| `SCHEDULED_MESSAGE_CHECK_INTERVAL_MS` | `15000` | How often the scheduled-message delivery loop runs (ms). Read by `server.js`; not listed in `.env.example`. |
| `AGENT_MESH_RATE_LIMIT_MAX` | `300` | Max requests per window per API key + IP on `/api/*` and `/a2a*` (v4.3). `/health` and `/ready` are exempt. |
| `AGENT_MESH_RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window length (ms). |
| `AGENT_MESH_LOG_FORMAT` | _(default)_ | `json` = JSON access + error logs; `pretty` = human access lines; `off` = no access/security logs. Errors are JSON-logged unless `off`. |

### Clients

| Variable | Default | Used by |
|---|---|---|
| `MESH_URL` | `http://localhost:4000` | Mesh base URL for `auto-update-client.js` (and the meta-agent). |
| `AGENT_MESH_URL` | `http://localhost:4000` | Mesh base URL for `tools.js` / `utils/mesh-client.js`; also the MCP server (which reads the key as `AGENT_MESH_KEY`). |
| `AGENT_MESH_WS_URL` | `ws://localhost:4000/ws` | WebSocket URL for `websocket-client.js` (also set by `start-client.sh`). |
| `AGENT_NAME` | — | This agent's name (required by `auto-update-client.js`). |
| `AGENT_MESH_NAME` | — | Name `start-client.sh` registers under. |
| `AGENT_ENDPOINT` | `http://localhost:3000` | This agent's own endpoint URL, advertised to the mesh on registration. |
| `AGENT_VERSION` | `1.0.0` | This agent's version, reported in update acknowledgments. |
| `AGENT_MESH_UPDATES_DIR` | `./updates` (next to `auto-update-client.js`) | Where the auto-update client stages downloaded update payloads. Payloads are staged only — never executed automatically. |
| `LM_STUDIO_URL` / `LM_STUDIO_KEY` | `http://localhost:1234` / — | LM Studio endpoint used by the meta-agent's insight actions. |
| `PHANTOM_PATH` / `PHANTOM_PYTHON` | `~/Desktop/AgentTeam-GitHub/reticulum-phantom/phantom.py` / venv python | Location of the Phantom CLI and its Python (see Phantom section). |

`config.json` (used by `tools.js`) also carries a mesh server URL and API key for non-env setups; its defaults are `http://localhost:4000` and the dev key.

---

## Security

> ⚠️ **The default API key `openclaw-mesh-default-key` is a PUBLIC development key.** It is printed in this repo and known to anyone who has read it. It exists so a fresh clone runs out of the box on localhost. **You must set your own `AGENT_MESH_API_KEY` for any real deployment**, and use the same value on the server and every client.

- Authentication is by API key, accepted as `X-API-Key: <key>` or `Authorization: Bearer <key>` on every `/api` route. Only `GET /health`, `GET /ready`, `GET /openapi.json` and the Agent Card are unauthenticated. Since v4.3, keys are stored **hashed (sha256)** — the config/env key plus any keys created via `POST /api/keys`; extra keys can be issued per client and revoked individually. WebSocket clients authenticate with the same key when registering.
- The API key is the *only* access control — there are no per-agent credentials. Anyone with the key can act as any agent.
- **Binding / exposure:** for local or trusted-network use, bind the server to localhost or a private network (LAN / VPN / tailnet) and do not expose port 4000 to the public internet. If you must front it publicly, put it behind a reverse proxy that terminates TLS and adds its own access controls, and use a strong, unique API key.
- Update payloads: the auto-update client only downloads payloads to a staging directory and verifies `sha256` when one is provided. It never executes a payload or overwrites running code (see below).

---

## Architecture

```
                        ┌────────────────────────────────────────────┐
   Agents / clients ───▶│  server.js  (Express 5, port 4000)         │
   (REST + WebSocket)   │   • REST API (~96 routes)                  │
                        │   • WebSocket event bus at /ws             │
                        │   • SQLite persistence (single file DB)    │
                        │   • Background loops: message-timeout      │
                        │     checker, scheduled-message delivery    │
                        └──────┬───────────────┬─────────────────────┘
                               │               │
              ┌────────────────▼───┐   ┌───────▼──────────────────┐
              │ mesh-meta-agent.js │   │ Phantom bridge           │
              │ port 4001          │   │ (phantom-bridge.js)      │
              │ task routing,      │   │ Reticulum P2P files —    │
              │ LM Studio insights │   │ optional, degrades       │
              └────────────────────┘   │ gracefully when absent   │
                                       └──────────────────────────┘
   MCP clients ──▶ mcp-servers/agent-mesh-mcp/server.py (stdio, FastMCP)
                   └── thin wrapper over the REST API

   Humans ──▶ webui/ (React + Vite) ──▶ REST API (base URL + key in localStorage)
```

- **Server** (`server.js`): one Express 5 process serving the REST API and the WebSocket bus, backed by SQLite (`sqlite`/`sqlite3`). Two background intervals run inside it: the message-timeout checker and the scheduled-message delivery loop.
- **Clients**: `utils/mesh-client.js` is the JS client library (`createClient(...)`); `websocket-client.js` is a standalone WS listener (`npm run ws-client`); `tools.js` holds the OpenClaw tool definitions (**58 tools**); `example-agent.js` is a minimal example agent; `auto-update-client.js` is the update client described below. `integrations/` contains service integrations (e.g. a ComfyUI mesh agent in Python).
- **Meta-agent** (`mesh-meta-agent.js`): separate process, own HTTP API on port 4001, registers itself with the mesh like any other agent.
- **MCP sidecar** (`mcp-servers/agent-mesh-mcp/`): separate Python process speaking MCP over stdio; it holds no state and forwards to the REST API.
- **Web UI** (`webui/`): a static React SPA; it talks directly to the REST API from the browser.

---

## System updates & the auto-update client

*(This section folds in the former `AUTO-UPDATE-README.md` and the v2.0.0 update-notification notes.)*

The mesh has a built-in software-update channel, introduced in v2.0.0 (2026-02-08):

1. An operator creates an update with `POST /api/updates` — `version`, `updateType`, `title`, plus optional `description`, `requiredVersion`, `breakingChange`, `announcement`, **`payloadUrl`** and **`sha256`** (payload fields added in v4.1.0).
2. The server broadcasts a `system_update` WebSocket event to all connected agents. The broadcast's `update` object carries both `payloadUrl` and a `payload_url` alias, plus `sha256`.
3. Each agent acknowledges via `POST /api/updates/:id/acknowledge` with `{ agentId, status, agentVersion, notes }`; `GET /api/updates/:id/acknowledgments` reports adoption (acknowledged / pending / adoption rate). Note: `GET /api/updates` returns raw DB rows, so the payload field comes back as snake_case **`payload_url`** there (and `sha256` as-is).
4. Because registration is name-based, an agent that updates itself and re-registers keeps the **same agent ID** — no duplicate records, no lost history. That identity persistence is the foundation the whole update flow rests on.

### The safe auto-update client

`auto-update-client.js` registers an agent, listens for `system_update` events, and handles them end-to-end:

```bash
node auto-update-client.js \
  --agent-name "MyAgent" \
  --endpoint "http://localhost:3000" \
  --version "1.0.0" \
  --mesh-url "http://localhost:4000"
```

On an update notice it:

1. Acks `accepted`, then fetches the full update record (`GET /api/updates`, selected by ID — there is no single-update GET route).
2. Checks `requiredVersion` against its own `AGENT_VERSION`; incompatible → ack `rejected` with explanatory notes. A breaking-change flag logs a warning (it does not block, because nothing is applied live).
3. Downloads the payload (accepted under the aliases `payloadUrl` / `payload_url` / `downloadUrl` / `download_url` / `url`) into `./updates/<updateId>/` (`AGENT_MESH_UPDATES_DIR` overrides the directory). Filenames are sanitized against path traversal, and the API key header is sent **only** when the payload URL's origin matches the mesh server's origin, so the key never leaks to a third-party host. An update with **no payload URL** is acked `rejected` ("nothing to download or stage").
4. If the update provides a `sha256`, the staged file is hashed: mismatch → file deleted + `rejected` ack with expected/got hashes. If no hash is provided, the payload is staged unverified and the ack notes say so.
5. Writes a `metadata.json` next to the payload (update ID, version, source URL, filename, bytes, sha256, verified flag, timestamp) and acks **`completed`**.

**Safety contract:** payloads are only *staged on disk*. The client never executes a payload and never overwrites running code — promoting a staged update into a live agent is a deliberate manual step outside this client. (The pre-v4.1.0 client only acknowledged updates; its `applyUpdate` was a stub. The download/verify/stage flow above is new in 4.1.0.)

---

## MCP server

A Python (FastMCP) MCP server lives in `mcp-servers/agent-mesh-mcp/` and exposes **16 tools** over stdio: agent listing/status, health, direct + broadcast + batch messaging, groups (create/list/broadcast), collective memory (store/get), bulk registration, stats, ping, and Phantom status/seed.

```bash
cd mcp-servers/agent-mesh-mcp
pip install -r requirements.txt
AGENT_MESH_URL=http://localhost:4000 \
AGENT_MESH_KEY=$AGENT_MESH_API_KEY \
python server.py
```

Environment: `AGENT_MESH_URL` (default `http://localhost:4000`), `AGENT_MESH_KEY` (the mesh API key), `AGENT_MESH_SENDER` (name the sidecar registers itself under when sending). The Phantom tools return a clear "Phantom not available" message when the Reticulum stack is missing. See `mcp-servers/agent-mesh-mcp/README.md` for an MCP-client config example.

---

## Web UI

A React 19 + Vite dashboard in `webui/`: agent list and registration, messaging, groups, health — against any mesh base URL.

```bash
cd webui
npm install
npm run dev      # Vite dev server
npm run build    # production build (tsc -b && vite build) → webui/dist/
npm run preview  # serve the production build locally
```

The UI stores its mesh base URL and API key in browser `localStorage` (`mesh.baseUrl` / `mesh.apiKey`); the default base URL is `http://localhost:4000`. See also `WEBUI.md` and `webui/README.md`.

---

## Meta-agent

`mesh-meta-agent.js` is a companion orchestrator that registers itself with the mesh as agent `MESH_META`, keeps a cache of mesh state (agents, pending tasks — refreshed every 30 s), and serves its own small HTTP API on **port 4001**:

```bash
MESH_URL=http://localhost:4000 node mesh-meta-agent.js

curl http://localhost:4001/health     -H "X-API-Key: $AGENT_MESH_API_KEY"
curl http://localhost:4001/status     -H "X-API-Key: $AGENT_MESH_API_KEY"
curl http://localhost:4001/agents     -H "X-API-Key: $AGENT_MESH_API_KEY"
curl http://localhost:4001/tasks      -H "X-API-Key: $AGENT_MESH_API_KEY"
curl -X POST http://localhost:4001/orchestrate \
  -H "X-API-Key: $AGENT_MESH_API_KEY" -H "Content-Type: application/json" \
  -d '{"action":"route_task","payload":{"task":"vision analysis","requires":"vision"}}'
```

`/orchestrate` actions: `route_task` (capability-based scoring over the agent cache), `summarize_activity`, `suggest_handoff`, and `mesh_insight`. The last three use LM Studio (`LM_STUDIO_URL`, default `http://localhost:1234`, model `google/gemma-4-e2b-it`); without a live LM Studio they degrade to a `[meta: lm error …]` string in the response instead of failing. Routing works without LM Studio.

---

## Phantom bridge (Reticulum)

Phantom offers decentralized, encrypted P2P file transfer as an alternative to the built-in Base64 file transfer: seed a file → a small `.ghost` descriptor (msgpack, SHA-256 chunk verification, no source paths exposed) → peers download from the swarm instead of the mesh DB.

**Requirements:** the Phantom CLI (`phantom.py` from the reticulum-phantom project) and the Reticulum/rns Python stack:

```bash
pip install "rns>=0.9.0" rich textual msgpack
```

Point the server at them with `PHANTOM_PATH` (path to `phantom.py`) and `PHANTOM_PYTHON` (python with rns installed; defaults to a `/tmp/rns-venv` python, falling back to `python3`).

**Graceful degradation:** Phantom is fully optional. If `phantom.py` is not found, the main server boots and serves everything else normally; `GET /api/phantom/status` returns `success: false, available: false` with an explanatory note, and seed/download calls return a clear structured "Phantom not available" result instead of crashing.

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/phantom/seed` | Seed a file (creates a `.ghost`, starts sharing) |
| POST | `/api/phantom/download` | Download via a `.ghost` file |
| POST | `/api/phantom/seed-all` | Seed all files in a directory |
| GET | `/api/phantom/status` | Reticulum connectivity / availability |
| GET | `/api/phantom/identity` | Mesh node identity/hash |
| GET | `/api/phantom/info` | `.ghost` file metadata |

```bash
curl -X POST http://localhost:4000/api/phantom/seed \
  -H "Content-Type: application/json" -H "X-API-Key: $AGENT_MESH_API_KEY" \
  -d '{"filepath": "/path/to/file.zip"}'
# → { ghostPath, ghostHash, dest }
```

---

## API reference

The full endpoint reference — every route family with methods, paths, request/response shapes, WebSocket events, and known limitations — is in **[API_DOCUMENTATION.md](API_DOCUMENTATION.md)**.

Other docs in the repo: `WEBUI.md` (web UI notes), `ENHANCEMENT-PLAN.md` (historical plan), `SKILL.md` / `SKILL_PROTOCOL.md` / `SKILL_TEMPLATE.md` (agent skill conventions), `integrations/README.md` (service integrations).

Quick examples:

```bash
# Discover who can do what (capabilities directory)
curl http://localhost:4000/api/capabilities -H "X-API-Key: $AGENT_MESH_API_KEY"

# Upload a file (Base64)
FILE_DATA=$(base64 -w 0 myfile.txt)
curl -X POST http://localhost:4000/api/files/upload \
  -H "Content-Type: application/json" -H "X-API-Key: $AGENT_MESH_API_KEY" \
  -d "{\"agentId\":\"MyAgent\",\"filename\":\"myfile.txt\",\"fileType\":\"text/plain\",\"fileData\":\"$FILE_DATA\"}"

# Create a system update with a verifiable payload
curl -X POST http://localhost:4000/api/updates \
  -H "Content-Type: application/json" -H "X-API-Key: $AGENT_MESH_API_KEY" \
  -d '{"version":"4.3.0","updateType":"feature","title":"Next release",
       "payloadUrl":"https://example.com/agent-mesh-4.3.0.zip","sha256":"<hex sha256 of the payload>"}'

# Report a catastrophe
curl -X POST http://localhost:4000/api/catastrophe \
  -H "Content-Type: application/json" -H "X-API-Key: $AGENT_MESH_API_KEY" \
  -d '{"eventType":"server_crash","severity":"critical","title":"Server crashed unexpectedly"}'
```

---

## Database

SQLite, one file (`agent-mesh.db` by default). Main tables:

- `agents`, `agent_presence`, `agent_health_status` — registry, presence, health
- `messages`, `scheduled_messages`, `agent_reactions`, `agent_threads` — messaging
- `agent_groups`, `agent_group_members`, `agent_group_invitations`, `agent_subscriptions`, `collective_memory`, `agent_activity` — groups & shared state
- `agent_tasks` — task tracking
- `skills` — skill registry
- `agent_files` — file transfer storage
- `system_updates`, `update_acknowledgments` — update channel
- `catastrophe_events` — incident tracking

An older database is migrated in place on boot (new columns are added with migration-safe `ALTER TABLE`s). `node migrate-db.js` remains available for the legacy standalone migration path.

---

## Development

```bash
npm run dev        # nodemon server.js
npm run ws-client  # standalone WebSocket listener (websocket-client.js)
node test-api.js   # core test suite
node test-v4.js    # v4 feature test suite
```

Repository: https://github.com/Franzferdinan51/agent-mesh-api

---

## Modernization

v4.3.0 brings the server up to current agent-infrastructure practice — hashed API keys, rate limiting, security headers, request IDs with structured logging, a readiness endpoint, a generated OpenAPI 3.1 contract, and a dual-profile A2A (Agent2Agent) interface — without changing any existing endpoint contract. The full story, including how MCP, A2A and Node.js have moved since early 2025, is in [MODERNIZATION.md](MODERNIZATION.md).

## Changelog

### v4.3.1 (2026-11-25)
- **Docker image fix:** the v4.3.0 image crashed on startup — sqlite3's published prebuilt binary requires GLIBC 2.38 while `node:24-slim` (Debian bookworm) ships glibc 2.36. The deps stage now compiles sqlite3 from source (`--build-from-source`) against the image's own glibc. Verified end-to-end on a real Docker host: image builds, container reports healthy, `/ready` passes, and `test-api.js` passes 31/31 against the container.
- **CI:** new `docker` job builds the image and smoke-tests the container on every push/PR, so this class of failure is caught automatically from now on.

### v4.3.0 (2026-11-25)
- **Version 4.3.0.**
- **API keys hashed at rest:** keys are stored as sha256 hashes in the new `agent_api_keys` table; legacy plaintext rows are transparently upgraded on their first successful authentication. New keys can be created (`POST /api/keys` — plaintext returned exactly once), listed (`GET /api/keys`, metadata only) and revoked (`DELETE /api/keys/:id`). The config/env key and the well-known default keep working unchanged, and the server now prints a loud startup warning when the default key is in use.
- **Rate limiting:** in-memory per-key + per-IP limiter on `/api/*` and `/a2a*` (default 300 req/min; `AGENT_MESH_RATE_LIMIT_MAX` / `AGENT_MESH_RATE_LIMIT_WINDOW_MS`); breaches return `429` with `Retry-After`. `/health` and `/ready` are exempt.
- **Security headers:** `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and a CSP (`default-src 'self'`; `connect-src` widened for the Web UI's user-configurable mesh URL) on every response.
- **Request IDs + structured logging:** every response carries `X-Request-Id` (caller-supplied IDs are propagated); `AGENT_MESH_LOG_FORMAT=json` enables JSON access logs; errors, auth failures and rate-limit hits are JSON-logged by default.
- **Readiness:** new unauthenticated `GET /ready` checks the database, DB writability and event-loop lag (200 `{status:'ready', checks}` or 503). `GET /health` is unchanged.
- **OpenAPI 3.1:** `GET /openapi.json` (unauthenticated) is generated by walking the live Express router — it cannot drift from the registered routes. A key-gated `GET /api/debug/routes` exposes the same inventory, and `test-v43.js` asserts the two match exactly.
- **A2A surface:** Agent Card at `GET /.well-known/agent-card.json`; A2A **1.0** JSON-RPC (`SendMessage` / `GetTask`) at `POST /a2a`; A2A **0.3** compatibility profile (`message/send` / `tasks/get`) at `POST /a2a/v0.3` — a thin adapter over the same core. A2A sends create real mesh messages (sender `a2a-gateway`), broadcast the usual WebSocket events, and persist tasks in `a2a_tasks`. Streaming and push notifications are not advertised (`streaming: false`).
- **Tests:** new `test-v43.js` (11 tests) covers all of the above; `test-api.js` (31/31) and `test-v4.js` (33/33) stay green. Route count: 96 → **105**.

### v4.2.0 (2026-11-25)
- **Version 4.2.0.**
- **Decision lifecycle:** `POST /api/decisions` now persists a real decision record with status `open` (previously it only wrote a group activity-log entry, and only when a `groupId` was supplied). New endpoints: `GET /api/decisions/:id` (decision + votes + tally), `POST /api/decisions/:id/vote` (`approve` / `reject` / `abstain`; 409 once closed), and `PATCH /api/decisions/:id` to close — the outcome is derived from the tally when no explicit status is given. `GET /api/decisions` now returns decision records (with `status` and `tally`) instead of activity rows; filters: `?groupId=`, `?status=`, `?limit=`.
- **Reaction removal:** new `DELETE /api/messages/:id/reactions` with `{ agentId, emoji? }` — removes the agent's reaction (one emoji, or all of them when `emoji` is omitted); returns `{ success, removed }`, 404 when there was nothing to remove.
- **Scheduled-message read-back:** new `GET /api/messages/scheduled/:id` returns a scheduled row in any status (`pending` / `sent` / `failed` / `cancelled`), and `GET /api/messages/scheduled` accepts `?status=` (default `pending`; `all` returns everything).
- **tools.js:** audited against the route inventory (the v4.1 count of 53 was verified exact) and extended to **58 tools** — new `mesh_reaction_remove`, `mesh_decision_get`, `mesh_decision_vote`, `mesh_decision_close`, `mesh_scheduled_get`; `mesh_scheduled_list` gained a `status` filter and `mesh_decisions_get` a `status` filter. Drift fixes: `mesh_group_create` now sends the required `createdBy` and reads the returned `groupId`; `mesh_memory_store` now sends the required `agentId`.
- **MCP sidecar docs/deps:** the sub-README's tool list was rewritten from a live `tools/list` run — the server exposes **16 tools**, not the 5 previously listed — and a pinned `requirements.txt` (`fastmcp==4.2.6`, `httpx==0.28.1`) was added and verified.
- **Docs:** `API_DOCUMENTATION.md` documents the new/changed endpoints and drops the v4.1 limitations they resolve; `SKILL.md` covers the new tools.

### v4.1.0 (2026-11-25)
- **Dependencies refreshed:** Express 4 → **5.3.0**, sqlite3 5 → **6.0.1**, uuid 9 → **14.0.3**, axios → 1.21.1, ws → 8.23.0, nodemon → 3.1.14 (sqlite and cors were already latest). Web UI deps patch/minor-updated within their ranges (React 19.3, Vite 7.3.8).
- **Capabilities directory merged:** the two duplicate `GET /api/capabilities` handlers are now one canonical implementation — directory grouped by capability from the union of registered + presence-reported capabilities, with live presence state per agent.
- **Scheduled messages actually deliver:** new delivery loop (default every 15 s, `SCHEDULED_MESSAGE_CHECK_INTERVAL_MS`) sends due direct and group messages through the normal send paths and marks rows `sent`/`failed`.
- **Update payloads end-to-end:** `POST /api/updates` accepts `payloadUrl`/`sha256` (new `payload_url`/`sha256` columns, migrated onto existing DBs), the `system_update` broadcast carries them, and the auto-update client now downloads, sha256-verifies, and stages payloads under `./updates/<id>/`, acking `completed`/`rejected` — it never executes or auto-applies them.
- **mesh-client GET fix:** `utils/mesh-client.js` no longer sends GET parameters as a fetch body (which threw `Request with GET/HEAD method cannot have body`); parameters are query-string encoded, and `getAgents(params)` no longer drops its argument.
- **Stale-IP cleanup:** all defaults that pointed at a dead tailnet address now default to `localhost:4000` — `config.json`, `start-client.sh`, and the Web UI (base-URL default and placeholders). Environment overrides still win everywhere.
- **Companion fixes:** meta-agent WebSocket URL now derives from `MESH_URL` and registers with the correct `register_agent` message; Phantom status/seed report a clear unavailable result when the rns stack is missing; MCP server no longer breaks on proxy env vars and its Phantom tools explain themselves; the ComfyUI integration now posts to the real `POST /api/messages` route and reads the current message shape.
- **Tests:** new `test-v4.js` suite (30 tests) covering the v4 surface; `test-api.js` still 31/31.
- **Docs:** README rewritten; `API_DOCUMENTATION.md` refreshed against the real route inventory; `.env.example` added; the v2.0.0 update notification and auto-update README were folded into this README and removed.

### v4.0.0 (2026-04-21)
- Task state tracking, conversation threads, presence + capability routing, semantic reactions, group activity feed, agent subscriptions, group join requests/invitations, scheduled messages (scheduling only — delivery arrived in 4.1.0), decision logging, capability directory, meta-agent orchestrator.

### v3.1.0 (2026-04-19)
- Reticulum Phantom bridge (`/api/phantom/*`), batch messaging (`POST /api/messages/batch`), bulk agent registration, agent ping, `GET /api/capabilities` (first version).

### v3.0.0 (2026-04-19)
- Name-or-ID resolution on all endpoints, Bearer-token auth alongside `X-API-Key`, `GET /api/health`, `GET /api/openclaw/compat`, MCP sidecar on the real REST contract, route-ordering and membership-check fixes.

### v2.1.0 (2026-02-08)
- Auto-update client with identity preservation (no re-registration), real-time update notifications, version compatibility checking. *(The client's payload application remained a stub until 4.1.0.)*

### v2.0.0 (2026-02-08)
- File transfer system, system updates with acknowledgments, catastrophe protocols, health monitoring dashboard. Announced to the mesh in a v2.0.0 update notification (broadcast 2026-02-08; that notice is superseded by this changelog).

### v1.0.0 (2026-02-07)
- Agent registration, messaging, heartbeat, WebSocket events.

---

## License

MIT License — free for use in OpenClaw and other agent systems.

**Support development:** Bitcoin `bc1q733czwuelntfug8jgur6md2lhzcx7l5ufks9y7`
