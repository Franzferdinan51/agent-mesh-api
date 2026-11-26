# syntax=docker/dockerfile:1
# Agent Mesh API — production image (v4.3.0 modernization pass)
#
# Multi-stage build:
#   1. webui-build — builds webui/dist (server.js serves it statically
#      when the directory exists: `app.use('/', express.static(webuiDist))`)
#   2. deps        — production npm dependencies only (sqlite3 is a native
#      module, so build tools are present in THIS stage only, in case the
#      prebuilt binary for the platform is unavailable and node-gyp runs)
#   3. runtime     — slim image, non-root, no build tools, no dev deps
#
# Base image: Node 24 LTS ("Krypton", Active LTS, supported to Apr 2028),
# pinned to the 24 line as node:24-slim (24.22.x at time of writing).

# ── Stage 1: build the Web UI ──────────────────────────────────────────
FROM node:24-slim AS webui-build
WORKDIR /app/webui
COPY webui/package.json webui/package-lock.json ./
RUN npm ci
COPY webui/ ./
RUN npm run build

# ── Stage 2: production dependencies ───────────────────────────────────
FROM node:24-slim AS deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ── Stage 3: runtime ───────────────────────────────────────────────────
FROM node:24-slim AS runtime

ENV NODE_ENV=production \
    PORT=4000 \
    AGENT_MESH_DB_PATH=/data/agent-mesh.db

WORKDIR /app

# Production dependencies (from the deps stage — no build tools leak in)
COPY --from=deps --chown=node:node /app/node_modules ./node_modules

# Server runtime files. server.js imports only ./phantom-bridge.js from
# the repo itself; package.json is read at startup for APP_VERSION.
# utils/ (mesh-client) is included so in-container clients/tests can use it.
COPY --chown=node:node package.json server.js phantom-bridge.js ./
COPY --chown=node:node utils ./utils

# Built Web UI (served by Express when webui/dist exists)
COPY --from=webui-build --chown=node:node /app/webui/dist ./webui/dist

# SQLite database lives on a volume so data survives container replacement.
# AGENT_MESH_DB_PATH (above) points the server at /data/agent-mesh.db.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node

EXPOSE 4000

# /health is unauthenticated in server.js. node:24-slim ships no curl/wget,
# so the check uses Node's built-in fetch.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
