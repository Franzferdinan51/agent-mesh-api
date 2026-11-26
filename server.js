#!/usr/bin/env node
/**
 * Agent Mesh API Server
 * Agent-to-Agent Communication for OpenClaw
 */

import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import http from 'http';
import crypto from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { phantomSeed, phantomDownload, phantomIdentity, phantomStatus, phantomInfo, phantomSeedAll } from './phantom-bridge.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const APP_VERSION = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8')).version;

const app = express();
const PORT = process.env.PORT || 4000;
const DEFAULT_API_KEY = 'openclaw-mesh-default-key';
const API_KEY = process.env.AGENT_MESH_API_KEY || DEFAULT_API_KEY;
const USING_DEFAULT_API_KEY = API_KEY === DEFAULT_API_KEY;
// v4.3: rate limiting (in-memory, per API-key + IP)
const RATE_LIMIT_MAX = toPositiveIntEnv(process.env.AGENT_MESH_RATE_LIMIT_MAX, 300);
const RATE_LIMIT_WINDOW_MS = toPositiveIntEnv(process.env.AGENT_MESH_RATE_LIMIT_WINDOW_MS, 60000);
// v4.3: structured logging — 'json' | 'pretty' | 'off' (default: errors JSON-logged, no access log)
const LOG_FORMAT = (process.env.AGENT_MESH_LOG_FORMAT || 'default').toLowerCase();

function toPositiveIntEnv(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

// Constant-time string comparison (via fixed-length digests so length never leaks)
function timingSafeStringEqual(a, b) {
  const da = crypto.createHash('sha256').update(String(a), 'utf8').digest();
  const db = crypto.createHash('sha256').update(String(b), 'utf8').digest();
  return crypto.timingSafeEqual(da, db);
}

function logJson(level, fields) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, ...fields });
  if (level === 'error') console.error(line); else console.log(line);
}
const DB_PATH = process.env.AGENT_MESH_DB_PATH || join(__dirname, 'agent-mesh.db');
const BODY_LIMIT = process.env.AGENT_MESH_BODY_LIMIT || '12mb';
const OFFLINE_THRESHOLD_MINUTES = parseInt(process.env.AGENT_MESH_OFFLINE_MINUTES || '5', 10);
const DEFAULT_MESSAGE_TIMEOUT_MS = parseInt(process.env.MESSAGE_TIMEOUT || '300000', 10);
const MESSAGE_TIMEOUT_CHECK_INTERVAL_MS = parseInt(process.env.MESSAGE_TIMEOUT_CHECK_INTERVAL_MS || '60000', 10);
const SCHEDULED_MESSAGE_CHECK_INTERVAL_MS = parseInt(process.env.SCHEDULED_MESSAGE_CHECK_INTERVAL_MS || '15000', 10);
const SERVER_STARTED_AT = Date.now();
const VALID_MESSAGE_STATUSES = ['pending', 'delivered', 'processing', 'completed', 'failed', 'timeout'];
const VALID_HEALTH_STATUSES = ['healthy', 'degraded', 'unhealthy', 'offline'];

// Middleware
// v4.3: request IDs — propagate a caller-supplied X-Request-Id or mint one
app.use((req, res, next) => {
  req.requestId = req.headers['x-request-id'] || crypto.randomUUID();
  res.set('X-Request-Id', req.requestId);
  next();
});

// v4.3: security headers (hand-rolled — the set is small and fixed, so no helmet
// dependency is justified). CSP note: the server also serves the built Web UI
// statically; its JS/CSS are external files (default-src 'self' is safe), but the
// console lets the user point it at an arbitrary mesh URL, so connect-src is
// deliberately widened to http/https/ws/wss — see MODERNIZATION.md / report.
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss: http: https:; frame-ancestors 'none'; base-uri 'self'");
  next();
});

// v4.3: access logging (JSON when AGENT_MESH_LOG_FORMAT=json, human line when pretty)
app.use((req, res, next) => {
  if (LOG_FORMAT === 'json' || LOG_FORMAT === 'pretty') {
    const started = Date.now();
    res.on('finish', () => {
      if (LOG_FORMAT === 'json') {
        logJson('info', { type: 'access', reqId: req.requestId, method: req.method, path: req.originalUrl, status: res.statusCode, ms: Date.now() - started });
      } else {
        console.log(`[HTTP] ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - started}ms reqId=${req.requestId}`);
      }
    });
  }
  next();
});

app.use(cors());
app.use(express.json({ limit: BODY_LIMIT }));

// v4.3: in-memory rate limiter for /api/* and /a2a* (per presented-key + IP).
// /health and /ready are not under those mounts, so they stay exempt.
const rateBuckets = new Map();
function rateLimiter(req, res, next) {
  const presented = req.headers['x-api-key']
    || (req.headers['authorization']?.startsWith('Bearer ') ? req.headers['authorization'].substring(7) : null)
    || req.query.apiKey || 'anonymous';
  const bucketKey = `${sha256Hex(presented).slice(0, 16)}|${req.ip || req.socket?.remoteAddress || 'unknown'}`;
  const now = Date.now();
  let bucket = rateBuckets.get(bucketKey);
  if (!bucket || now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
    bucket = { windowStart: now, count: 0 };
    rateBuckets.set(bucketKey, bucket);
  }
  bucket.count += 1;
  if (rateBuckets.size > 10000) { // opportunistic prune of expired buckets
    for (const [k, b] of rateBuckets) if (now - b.windowStart >= RATE_LIMIT_WINDOW_MS) rateBuckets.delete(k);
  }
  if (bucket.count > RATE_LIMIT_MAX) {
    const retryAfter = Math.max(1, Math.ceil((bucket.windowStart + RATE_LIMIT_WINDOW_MS - now) / 1000));
    res.set('Retry-After', String(retryAfter));
    if (LOG_FORMAT !== 'off') logJson('warn', { type: 'rate_limit', reqId: req.requestId, method: req.method, path: req.originalUrl, status: 429 });
    return res.status(429).json({ error: 'Too many requests', retryAfter });
  }
  next();
}
app.use('/api', rateLimiter);
app.use('/a2a', rateLimiter);

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function toPositiveInt(value, fallback, max = 500) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
}

function getPagination(query, defaultLimit = 50, maxLimit = 200) {
  return {
    limit: toPositiveInt(query.limit, defaultLimit, maxLimit),
    offset: toPositiveInt(query.offset, 0, Number.MAX_SAFE_INTEGER)
  };
}

function applyPaginationHeaders(res, total, limit, offset) {
  res.set('X-Total-Count', String(total));
  res.set('X-Limit', String(limit));
  res.set('X-Offset', String(offset));
}

function normalizeMessage(row) {
  return {
    id: row.id,
    from: row.from_agent,
    to: row.to_agent,
    content: row.content,
    messageType: row.message_type,
    read: Boolean(row.read),
    status: row.status,
    timeoutMs: row.timeout_ms,
    createdAt: row.created_at
  };
}

async function resolveAgent(identifier) {
  if (!identifier) return null;
  return db.get('SELECT * FROM agents WHERE id = ? OR name = ? LIMIT 1', [identifier, identifier]);
}

async function requireAgent(identifier, fieldName = 'agent') {
  const agent = await resolveAgent(identifier);
  if (!agent) {
    const error = new Error(`${fieldName} not found`);
    error.statusCode = 404;
    throw error;
  }
  return agent;
}

async function requireGroup(identifier, fieldName = 'group') {
  const group = await db.get(
    'SELECT * FROM agent_groups WHERE id = ? OR name = ? LIMIT 1',
    [identifier, identifier]
  );
  if (!group) {
    const error = new Error(`${fieldName} not found`);
    error.statusCode = 404;
    throw error;
  }
  return group;
}

async function fetchMessages(filters = {}, pagination = { limit: 50, offset: 0 }) {
  const clauses = [];
  const params = [];

  if (filters.toAgent) {
    clauses.push('to_agent = ?');
    params.push(filters.toAgent);
  }

  if (filters.fromAgent) {
    clauses.push('from_agent = ?');
    params.push(filters.fromAgent);
  }

  if (filters.since) {
    clauses.push('created_at > ?');
    params.push(filters.since);
  }

  if (filters.unreadOnly) {
    clauses.push('read = 0');
  }

  if (filters.status) {
    clauses.push('status = ?');
    params.push(filters.status);
  }

  if (filters.messageType) {
    clauses.push('message_type = ?');
    params.push(filters.messageType);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const totalRow = await db.get(`SELECT COUNT(*) as count FROM messages ${where}`, params);
  const rows = await db.all(
    `SELECT * FROM messages ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, pagination.limit, pagination.offset]
  );

  return {
    total: totalRow?.count || 0,
    items: rows.map(normalizeMessage)
  };
}

// Optional: Serve the Web UI build (webui/dist)
// This is convenience for LAN/Tailscale usage.
const webuiDist = join(__dirname, 'webui', 'dist');
if (existsSync(webuiDist)) {
  app.use('/', express.static(webuiDist));
}

// Initialize SQLite
let db;
async function initDb() {
  db = await open({
    filename: DB_PATH,
    driver: sqlite3.Database
  });

  // Windows-safe SQLite settings (WAL mode has issues on Windows)
  await db.exec('PRAGMA journal_mode = DELETE;');
  await db.exec('PRAGMA synchronous = FULL;');
  await db.exec('PRAGMA busy_timeout = 5000;');
  await db.exec('PRAGMA foreign_keys = ON;');
  await db.exec('PRAGMA temp_store = MEMORY;');
  await db.exec('PRAGMA locking_mode = NORMAL;');

  console.log(`[DB] SQLite initialized: ${DB_PATH}`);
  console.log('[DB] Windows-safe mode: DELETE journal, FULL sync, MEMORY temp_store');

  await db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      endpoint TEXT,
      capabilities TEXT,
      last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      from_agent TEXT NOT NULL,
      to_agent TEXT,
      content TEXT NOT NULL,
      message_type TEXT DEFAULT 'direct',
      read BOOLEAN DEFAULT 0,
      status TEXT DEFAULT 'pending',
      timeout_ms INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      endpoint TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS agent_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      metadata TEXT,
      created_by TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS agent_group_members (
      group_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      role TEXT DEFAULT 'member',
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (group_id, agent_id),
      FOREIGN KEY (group_id) REFERENCES agent_groups(id) ON DELETE CASCADE,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS collective_memory (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      memory_type TEXT DEFAULT 'shared',
      version INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (group_id) REFERENCES agent_groups(id) ON DELETE CASCADE,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_to_agent ON messages(to_agent);
    CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
    CREATE INDEX IF NOT EXISTS idx_agent_groups_group ON agent_group_members(group_id);
    CREATE INDEX IF NOT EXISTS idx_collective_memory_group ON collective_memory(group_id);
    CREATE INDEX IF NOT EXISTS idx_collective_memory_key ON collective_memory(group_id, key);

    -- NEW: File Transfer Support
    CREATE TABLE IF NOT EXISTS agent_files (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      file_type TEXT,
      file_size INTEGER,
      file_data TEXT,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_agent_files_agent ON agent_files(agent_id);

    -- NEW: System Updates
    CREATE TABLE IF NOT EXISTS system_updates (
      id TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      update_type TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      required_version TEXT,
      breaking_change BOOLEAN DEFAULT 0,
      announcement TEXT,
      payload_url TEXT,
      sha256 TEXT,
      created_by TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME
    );

    CREATE INDEX IF NOT EXISTS idx_system_updates_created ON system_updates(created_at DESC);

    -- NEW: Update Acknowledgments
    CREATE TABLE IF NOT EXISTS update_acknowledgments (
      id TEXT PRIMARY KEY,
      update_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      acknowledged_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      agent_version TEXT,
      status TEXT DEFAULT 'pending',
      notes TEXT,
      FOREIGN KEY (update_id) REFERENCES system_updates(id) ON DELETE CASCADE,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
      UNIQUE(update_id, agent_id)
    );

    CREATE INDEX IF NOT EXISTS idx_update_acknowledgments_update ON update_acknowledgments(update_id);

    -- NEW: Catastrophe Events
    CREATE TABLE IF NOT EXISTS catastrophe_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      affected_agents TEXT,
      recovery_protocol TEXT,
      status TEXT DEFAULT 'active',
      occurred_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      resolved_at DATETIME
    );

    CREATE INDEX IF NOT EXISTS idx_catastrophe_events_status ON catastrophe_events(status, occurred_at DESC);

    -- NEW: Agent Health Status
    CREATE TABLE IF NOT EXISTS agent_health_status (
      agent_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      last_heartbeat DATETIME,
      uptime_seconds INTEGER,
      cpu_usage REAL,
      memory_usage REAL,
      custom_metrics TEXT,
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_agent_health_status ON agent_health_status(status, last_updated DESC);

    -- v4.2: Decisions voting lifecycle
    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY,
      group_id TEXT,
      content TEXT NOT NULL,
      context TEXT,
      proposed_by TEXT,
      status TEXT DEFAULT 'open',
      created_at TEXT DEFAULT (datetime('now')),
      closed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS decision_votes (
      decision_id TEXT,
      agent_id TEXT,
      vote TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(decision_id, agent_id)
    );

    -- v4.3: API keys hashed at rest. key_hash holds sha256(key); key_value is a
    -- legacy plaintext column kept ONLY so pre-4.3 rows can be transparently
    -- upgraded (nulled) on their first successful authentication.
    CREATE TABLE IF NOT EXISTS agent_api_keys (
      id TEXT PRIMARY KEY,
      name TEXT,
      key_hash TEXT,
      key_value TEXT,
      key_prefix TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      last_used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON agent_api_keys(key_hash);

    -- v4.3: persisted A2A tasks (see /a2a endpoints)
    CREATE TABLE IF NOT EXISTS a2a_tasks (
      id TEXT PRIMARY KEY,
      context_id TEXT,
      state TEXT,
      task_json TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // v4.3: seed the config/env key into the key store, hashed only. Any legacy
  // plaintext row for the same key is left in place and upgraded on first use.
  try {
    const configHash = sha256Hex(API_KEY);
    const existing = await db.get(
      'SELECT id FROM agent_api_keys WHERE key_hash = ? OR key_value = ? LIMIT 1',
      [configHash, API_KEY]
    );
    if (!existing) {
      await db.run(
        'INSERT INTO agent_api_keys (id, name, key_hash, key_value, key_prefix) VALUES (?, ?, ?, NULL, ?)',
        [uuidv4(), 'config', configHash, API_KEY.slice(0, 8)]
      );
      console.log('[DB] Config API key recorded as sha256 hash (no plaintext stored)');
    }
  } catch (e) {
    console.error('[DB] API key seed failed:', e.message);
  }

  // v4.0: Add thread_id and intent columns if messages table already exists
  try { await db.exec(`ALTER TABLE messages ADD COLUMN thread_id TEXT`); } catch (e) { /* ignore if exists */ }
  try { await db.exec(`ALTER TABLE messages ADD COLUMN intent TEXT`); } catch (e) { /* ignore if exists */ }

  // v4.1: Add payload_url and sha256 columns if system_updates table already exists
  try { await db.exec(`ALTER TABLE system_updates ADD COLUMN payload_url TEXT`); } catch (e) { /* ignore if exists */ }
  try { await db.exec(`ALTER TABLE system_updates ADD COLUMN sha256 TEXT`); } catch (e) { /* ignore if exists */ }


  // ---- v4.0: Presence & Capabilities ------
    await db.exec(`
      CREATE TABLE IF NOT EXISTS agent_presence (
        agent_id TEXT PRIMARY KEY,
        state TEXT DEFAULT 'offline',
        status_message TEXT DEFAULT '',
        last_ping INTEGER DEFAULT 0,
        capabilities TEXT DEFAULT '[]',
        bandwidth_upload INTEGER DEFAULT 0,
        bandwidth_download INTEGER DEFAULT 0,
        storage_free_gb REAL DEFAULT 0
      )
    `);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_presence_state ON agent_presence(state)`);

    // ---- v4.0: Threads / Conversations ------
    await db.exec(`
      CREATE TABLE IF NOT EXISTS agent_threads (
        id TEXT PRIMARY KEY,
        group_id TEXT,
        parent_id TEXT,
        title TEXT DEFAULT '',
        context TEXT DEFAULT '',
        created_by TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        message_count INTEGER DEFAULT 0,
        last_message_at TEXT
      )
    `);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_threads_group ON agent_threads(group_id)`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_threads_parent ON agent_threads(parent_id)`);

    // ---- v4.0: Reactions ------
    await db.exec(`
      CREATE TABLE IF NOT EXISTS agent_reactions (
        id TEXT PRIMARY KEY,
        message_id TEXT,
        agent_id TEXT,
        emoji TEXT NOT NULL,
        semantic TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(message_id, agent_id, emoji)
      )
    `);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_reactions_message ON agent_reactions(message_id)`);

    // ---- v4.0: Group Activity Feed ------
    await db.exec(`
      CREATE TABLE IF NOT EXISTS agent_activity (
        id TEXT PRIMARY KEY,
        group_id TEXT,
        actor_id TEXT,
        action TEXT NOT NULL,
        target_type TEXT DEFAULT '',
        target_id TEXT DEFAULT '',
        metadata TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_activity_group ON agent_activity(group_id, created_at DESC)`);

    // ---- v4.0: Agent Subscriptions ------
    await db.exec(`
      CREATE TABLE IF NOT EXISTS agent_subscriptions (
        agent_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        notify_join INTEGER DEFAULT 1,
        notify_leave INTEGER DEFAULT 1,
        notify_broadcast INTEGER DEFAULT 1,
        notify_task INTEGER DEFAULT 1,
        notify_message INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (agent_id, group_id)
      )
    `);

    // ---- v4.0: Task State Tracking ------
    await db.exec(`
      CREATE TABLE IF NOT EXISTS agent_tasks (
        id TEXT PRIMARY KEY,
        group_id TEXT,
        title TEXT DEFAULT '',
        description TEXT DEFAULT '',
        state TEXT DEFAULT 'pending',
        priority INTEGER DEFAULT 5,
        owner_id TEXT,
        assigned_id TEXT,
        depends_on TEXT DEFAULT '[]',
        context TEXT DEFAULT '',
        result TEXT DEFAULT '',
        created_by TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        started_at TEXT,
        completed_at TEXT
      )
    `);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_state ON agent_tasks(state)`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON agent_tasks(assigned_id)`);

    // ---- v4.0: Scheduled Messages ------
    await db.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_messages (
        id TEXT PRIMARY KEY,
        from_agent TEXT,
        to_agent TEXT,
        to_group TEXT,
        content TEXT NOT NULL,
        intent TEXT DEFAULT 'direct',
        priority INTEGER DEFAULT 0,
        scheduled_at TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_scheduled_status ON scheduled_messages(status, scheduled_at)`);

    // ---- v4.0: Group Invitations ------
    await db.exec(`
      CREATE TABLE IF NOT EXISTS agent_group_invitations (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        created_at TEXT DEFAULT (datetime('now')),
        responded_at TEXT,
        UNIQUE(group_id, agent_id)
      )
    `);

  // Verify database is writable
  try {
    await db.run('SELECT COUNT(*) FROM agents');
    console.log('[DB] Database verified and writable');
  } catch (error) {
    console.error('[DB] ERROR: Database is not writable!', error);
    throw error;
  }
}

// Auth middleware (v4.3: keys are verified against sha256 hashes at rest;
// legacy plaintext rows in agent_api_keys are transparently upgraded on use)
function extractApiKey(req) {
  let key = req.headers['x-api-key'] || req.query.apiKey;
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    key = authHeader.substring(7);
  }
  return key ? String(key).trim() : null;
}

async function validateApiKey(candidate) {
  if (!candidate) return false;
  // Config/env key (includes the well-known default) — constant-time compare.
  if (timingSafeStringEqual(candidate, API_KEY)) return true;
  if (!db) return false;
  const candidateHash = sha256Hex(candidate);
  try {
    const hashed = await db.get('SELECT id FROM agent_api_keys WHERE key_hash = ? LIMIT 1', [candidateHash]);
    if (hashed) {
      await db.run('UPDATE agent_api_keys SET last_used_at = datetime(\'now\') WHERE id = ?', [hashed.id]);
      return true;
    }
    // Legacy plaintext row: on a successful match, upgrade it to a hash in place.
    const rows = await db.all('SELECT id, key_value FROM agent_api_keys WHERE key_value IS NOT NULL');
    for (const row of rows) {
      if (row.key_value && timingSafeStringEqual(candidate, row.key_value)) {
        await db.run(
          'UPDATE agent_api_keys SET key_hash = ?, key_value = NULL, key_prefix = ?, last_used_at = datetime(\'now\') WHERE id = ?',
          [candidateHash, candidate.slice(0, 8), row.id]
        );
        console.log(`[Auth] Upgraded legacy plaintext API key (id=${row.id}) to sha256 hash`);
        return true;
      }
    }
  } catch (e) {
    console.error('[Auth] Key lookup failed:', e.message);
  }
  return false;
}

async function requireApiKey(req, res, next) {
  try {
    const key = extractApiKey(req);
    if (!key || !(await validateApiKey(key))) {
      if (LOG_FORMAT !== 'off') logJson('warn', { type: 'auth_failure', reqId: req.requestId, method: req.method, path: req.originalUrl, status: 401 });
      return res.status(401).json({
        error: 'Invalid or missing API key',
        received: key ? `${key.substring(0, 3)}...` : 'none'
      });
    }
    req.apiKeyPrefix = key.slice(0, 8);
    next();
  } catch (error) {
    next(error);
  }
}

// === API KEY MANAGEMENT (v4.3) ===
// Create a new API key. The plaintext is returned exactly once; only its
// sha256 hash is stored.
app.post('/api/keys', requireApiKey, async (req, res) => {
  try {
    const name = (req.body?.name || 'unnamed').toString().slice(0, 100);
    const plain = `mesh_${crypto.randomBytes(24).toString('hex')}`;
    const id = uuidv4();
    await db.run(
      'INSERT INTO agent_api_keys (id, name, key_hash, key_value, key_prefix) VALUES (?, ?, ?, NULL, ?)',
      [id, name, sha256Hex(plain), plain.slice(0, 8)]
    );
    res.json({ success: true, id, name, apiKey: plain, keyPrefix: plain.slice(0, 8) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List keys (metadata only — never hashes or plaintext)
app.get('/api/keys', requireApiKey, async (req, res) => {
  try {
    const rows = await db.all('SELECT id, name, key_prefix, created_at, last_used_at FROM agent_api_keys ORDER BY created_at ASC');
    res.json(rows.map(r => ({ id: r.id, name: r.name, keyPrefix: r.key_prefix, createdAt: r.created_at, lastUsedAt: r.last_used_at })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Revoke a key created via the API (the config/env key cannot be revoked here)
app.delete('/api/keys/:id', requireApiKey, async (req, res) => {
  try {
    const row = await db.get('SELECT * FROM agent_api_keys WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'API key not found' });
    if (row.key_hash && timingSafeStringEqual(row.key_hash, sha256Hex(API_KEY))) {
      return res.status(400).json({ error: 'The config/env API key cannot be revoked via the API' });
    }
    await db.run('DELETE FROM agent_api_keys WHERE id = ?', [req.params.id]);
    res.json({ success: true, id: req.params.id, revoked: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// === AGENT REGISTRY ===

// Register agent
app.post('/api/agents/register', requireApiKey, async (req, res) => {
  try {
    const { name, endpoint, capabilities } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }

    // Check if agent with this name already exists (Identity Persistence)
    const existingAgent = await db.get('SELECT * FROM agents WHERE name = ?', name);

    let id;
    if (existingAgent) {
      // Return existing agentId - don't create duplicate
      id = existingAgent.id;

      // Update endpoint and capabilities if provided
      await db.run(
        'UPDATE agents SET endpoint = ?, capabilities = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?',
        [endpoint || existingAgent.endpoint, JSON.stringify(capabilities || []), id]
      );

      console.log(`[Registration] Agent "${name}" re-registered with existing ID: ${id}`);

      res.json({
        success: true,
        agentId: id,
        message: 'Agent re-registered with existing ID',
        existed: true
      });
    } else {
      // Create new agent
      id = uuidv4();
      await db.run(
        'INSERT INTO agents (id, name, endpoint, capabilities) VALUES (?, ?, ?, ?)',
        [id, name, endpoint || null, JSON.stringify(capabilities || [])]
      );

      console.log(`[Registration] New agent "${name}" registered with ID: ${id}`);

      // Broadcast to all connected WebSocket clients
      broadcast({
        type: 'agent_joined',
        agent: { id, name, endpoint, capabilities }
      });

      res.json({
        success: true,
        agentId: id,
        message: 'Agent registered successfully',
        existed: false
      });
    }
  } catch (error) {
    console.error('[Error] Register agent:', error);
    res.status(500).json({ error: error.message });
  }
});

// Bulk register — register multiple agents in one call (spawning teams)
app.post('/api/agents/bulk-register', requireApiKey, async (req, res) => {
  try {
    const { agents } = req.body;

    if (!Array.isArray(agents) || agents.length === 0) {
      return res.status(400).json({ error: 'agents array is required' });
    }

    if (agents.length > 50) {
      return res.status(400).json({ error: 'Maximum 50 agents per bulk registration' });
    }

    const results = [];
    const errors = [];

    for (let i = 0; i < agents.length; i++) {
      const { name, endpoint, capabilities } = agents[i];

      if (!name) {
        errors.push({ index: i, error: 'name is required' });
        continue;
      }

      try {
        const existing = await db.get('SELECT id, name FROM agents WHERE name = ?', name);

        if (existing) {
          await db.run(
            'UPDATE agents SET endpoint = ?, capabilities = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?',
            [endpoint || existing.endpoint, JSON.stringify(capabilities || []), existing.id]
          );
          results.push({ index: i, name, agentId: existing.id, existed: true });
        } else {
          const id = uuidv4();
          await db.run(
            'INSERT INTO agents (id, name, endpoint, capabilities) VALUES (?, ?, ?, ?)',
            [id, name, endpoint || null, JSON.stringify(capabilities || [])]
          );
          broadcast({ type: 'agent_joined', agent: { id, name, endpoint, capabilities } });
          results.push({ index: i, name, agentId: id, existed: false });
        }
      } catch (err) {
        errors.push({ index: i, name, error: err.message });
      }
    }

    res.json({
      success: true,
      registered: results.length,
      failed: errors.length,
      results,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error) {
    console.error('[Error] Bulk register:', error);
    res.status(500).json({ error: error.message });
  }
});

// List agents
app.get('/api/agents', requireApiKey, async (req, res) => {
  try {
    const { capability, search, status } = req.query;
    const { limit, offset } = getPagination(req.query);
    const clauses = [];
    const params = [];

    if (capability) {
      clauses.push('a.capabilities LIKE ?');
      params.push(`%${capability}%`);
    }

    if (search) {
      clauses.push('(a.name LIKE ? OR a.endpoint LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }

    if (status) {
      clauses.push('COALESCE(h.status, ?) = ?');
      params.push('unknown', status);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const totalRow = await db.get(
      `SELECT COUNT(*) as count FROM agents a LEFT JOIN agent_health_status h ON a.id = h.agent_id ${where}`,
      params
    );
    const agents = await db.all(
      `SELECT a.*, h.status as health_status, h.last_updated as health_last_updated
       FROM agents a
       LEFT JOIN agent_health_status h ON a.id = h.agent_id
       ${where}
       ORDER BY a.last_seen DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    applyPaginationHeaders(res, totalRow?.count || 0, limit, offset);
    res.json(agents.map(a => ({
      ...a,
      status: a.health_status || 'unknown',
      healthLastUpdated: a.health_last_updated || null,
      capabilities: parseJson(a.capabilities, [])
    })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get single agent
app.get('/api/agents/:id', requireApiKey, async (req, res) => {
  try {
    const agent = await db.get(`
      SELECT a.*, h.status as health_status, h.last_updated as health_last_updated
      FROM agents a
      LEFT JOIN agent_health_status h ON a.id = h.agent_id
      WHERE a.id = ?
    `, req.params.id);

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    res.json({
      ...agent,
      status: agent.health_status || 'unknown',
      healthLastUpdated: agent.health_last_updated || null,
      capabilities: parseJson(agent.capabilities, [])
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update agent details
app.put('/api/agents/:id', requireApiKey, async (req, res) => {
  try {
    const existing = await db.get('SELECT * FROM agents WHERE id = ?', req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const name = req.body.name || existing.name;
    const endpoint = req.body.endpoint !== undefined ? req.body.endpoint : existing.endpoint;
    const capabilities = Array.isArray(req.body.capabilities)
      ? JSON.stringify(req.body.capabilities)
      : existing.capabilities;

    await db.run(
      'UPDATE agents SET name = ?, endpoint = ?, capabilities = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?',
      [name, endpoint, capabilities, req.params.id]
    );

    const updated = await db.get('SELECT * FROM agents WHERE id = ?', req.params.id);
    const payload = {
      ...updated,
      capabilities: parseJson(updated.capabilities, [])
    };

    broadcast({
      type: 'agent_updated',
      agent: payload
    });

    res.json({ success: true, agent: payload });
  } catch (error) {
    console.error('[Error] Update agent:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete agent
app.delete('/api/agents/:id', requireApiKey, async (req, res) => {
  try {
    const agent = await db.get('SELECT * FROM agents WHERE id = ?', req.params.id);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    await db.run('DELETE FROM agents WHERE id = ?', req.params.id);

    broadcast({
      type: 'agent_left',
      agentId: req.params.id,
      name: agent.name
    });

    res.json({ success: true, agentId: req.params.id, deleted: true });
  } catch (error) {
    console.error('[Error] Delete agent:', error);
    res.status(500).json({ error: error.message });
  }
});

// Heartbeat - update last_seen and optional health metrics (supports ID or name)
app.post('/api/agents/:id/heartbeat', requireApiKey, async (req, res) => {
  try {
    const { status = 'healthy', uptimeSeconds, cpuUsage, memoryUsage, customMetrics = {} } = req.body || {};

    if (!VALID_HEALTH_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Invalid health status. Must be one of: ${VALID_HEALTH_STATUSES.join(', ')}` });
    }

    const agent = await requireAgent(req.params.id, 'agent');

    await db.run(
      'UPDATE agents SET last_seen = CURRENT_TIMESTAMP WHERE id = ?',
      agent.id
    );

    await db.run(`
      INSERT INTO agent_health_status
       (agent_id, status, last_heartbeat, uptime_seconds, cpu_usage, memory_usage, custom_metrics, last_updated)
      VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(agent_id) DO UPDATE SET
        status = excluded.status,
        last_heartbeat = CURRENT_TIMESTAMP,
        uptime_seconds = excluded.uptime_seconds,
        cpu_usage = excluded.cpu_usage,
        memory_usage = excluded.memory_usage,
        custom_metrics = excluded.custom_metrics,
        last_updated = CURRENT_TIMESTAMP
    `,
    [agent.id, status, uptimeSeconds || null, cpuUsage || null, memoryUsage || null, JSON.stringify(customMetrics)]);

    broadcast({
      type: 'agent_health_change',
      agentId: agent.id,
      status,
      metrics: { uptimeSeconds, cpuUsage, memoryUsage, customMetrics }
    });

    res.json({
      success: true,
      agentId: agent.id,
      status,
      metrics: { uptimeSeconds, cpuUsage, memoryUsage, customMetrics }
    });
  } catch (error) {
    console.error('[Error] Agent heartbeat:', error);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Lightweight ping — check if an agent is alive (avoids full health report overhead)
app.post('/api/agents/ping/:id', requireApiKey, async (req, res) => {
  try {
    const agent = await requireAgent(req.params.id, 'agent');
    const pongAt = new Date().toISOString();

    broadcast({
      type: 'agent_ping',
      agentId: agent.id,
      agentName: agent.name,
      pongAt
    });

    res.json({
      success: true,
      agentId: agent.id,
      agentName: agent.name,
      pong: true,
      pongAt
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// === CAPABILITY DISCOVERY ===

// Canonical capability directory: agents grouped by capability, including each
// agent's presence state. Merged from the former presence-based index and the
// v4.0 presence directory (duplicate route removed in v4.1) — useful for
// multi-agent routing (e.g. Agent-Teams hive-router).
app.get('/api/capabilities', requireApiKey, async (req, res) => {
  try {
    const { agentId } = req.query;

    let agents;
    if (agentId) {
      const agent = await requireAgent(agentId, 'agent');
      agents = [agent];
    } else {
      agents = await db.all('SELECT id, name, capabilities FROM agents');
    }

    // Presence state per agent (agents without a presence row count as offline)
    const presenceRows = await db.all('SELECT * FROM agent_presence');
    const presenceByAgent = {};
    for (const row of presenceRows) presenceByAgent[row.agent_id] = row;

    const directory = {};
    for (const agent of agents) {
      const presence = presenceByAgent[agent.id];
      // Union of the agent's registered capabilities and its presence-reported ones
      const caps = new Set([
        ...parseJson(agent.capabilities, []),
        ...parseJson(presence?.capabilities, [])
      ]);
      for (const cap of caps) {
        if (!directory[cap]) directory[cap] = [];
        directory[cap].push({
          id: agent.id,
          agentId: agent.id,
          name: agent.name,
          state: presence?.state || 'offline',
          statusMessage: presence?.status_message || '',
          bandwidthUpload: presence?.bandwidth_upload || 0,
          bandwidthDownload: presence?.bandwidth_download || 0
        });
      }
    }

    res.json({
      totalCapabilities: Object.keys(directory).length,
      totalAgents: agents.length,
      index: directory,
      directory,
      sorted: Object.keys(directory).sort()
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// === MESSAGING ===

// Send message
app.post('/api/messages', requireApiKey, async (req, res) => {
  try {
    const from = req.body.from || req.body.fromAgentId || req.body.fromAgent || req.body.sender;
    const to = req.body.to || req.body.toAgentId || req.body.toAgent || req.body.recipient;
    const content = req.body.content || req.body.message;
    const { messageType = 'direct' } = req.body;
    const timeoutMs = toPositiveInt(req.body.timeoutMs, DEFAULT_MESSAGE_TIMEOUT_MS, Number.MAX_SAFE_INTEGER);

    if (!from || !to || !content) {
      return res.status(400).json({ error: 'from, to, and content are required' });
    }

    const fromAgent = await requireAgent(from, 'from agent');
    const toAgent = await requireAgent(to, 'to agent');

    const id = uuidv4();
    await db.run(
      'INSERT INTO messages (id, from_agent, to_agent, content, message_type, timeout_ms) VALUES (?, ?, ?, ?, ?, ?)',
      [id, fromAgent.id, toAgent.id, content, messageType, timeoutMs]
    );

    const message = {
      id,
      from: fromAgent.id,
      fromName: fromAgent.name,
      to: toAgent.id,
      toName: toAgent.name,
      content,
      messageType,
      timeoutMs,
      createdAt: new Date().toISOString()
    };

    // WebSocket broadcast
    broadcast({
      type: 'new_message',
      message
    });

    res.json({ success: true, messageId: id, message });
  } catch (error) {
    console.error('[Error] Send message:', error);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// List all messages
app.get('/api/messages', requireApiKey, async (req, res) => {
  try {
    const pagination = getPagination(req.query, 100, 500);
    const { items, total } = await fetchMessages({
      toAgent: req.query.toAgent,
      fromAgent: req.query.fromAgent,
      since: req.query.since,
      unreadOnly: req.query.unreadOnly === 'true',
      status: req.query.status,
      messageType: req.query.messageType
    }, pagination);

    applyPaginationHeaders(res, total, pagination.limit, pagination.offset);
    res.json(items);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get message details
app.get('/api/messages/by-id/:id', requireApiKey, async (req, res) => {
  try {
    const message = await db.get('SELECT * FROM messages WHERE id = ?', req.params.id);
    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }

    res.json(normalizeMessage(message));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Schedule message ─────────────────────────────────────────
// NOTE: the /api/messages/scheduled routes must be registered before
// GET /api/messages/:agentId below — Express matches in registration
// order, so the param route would otherwise swallow "scheduled" as an
// agent id and the list endpoint would 404 with "agent not found".
app.post('/api/messages/scheduled', requireApiKey, async (req, res) => {
  try {
    const { from, to, toGroup, content, intent, priority, sendAt } = req.body;
    if (!from || !content || !sendAt) return res.status(400).json({ error: 'from, content, sendAt required' });
    const fromAgent = await requireAgent(from, 'agent');
    const id = uuidv4();
    await db.run(`INSERT INTO scheduled_messages (id,from_agent,to_agent,to_group,content,intent,priority,scheduled_at) VALUES (?,?,?,?,?,?,?,?)`,
      [id, fromAgent.id, to||null, toGroup||null, content, intent||'direct', priority||0, sendAt]);
    res.json({ success: true, id, scheduledAt: sendAt });
  } catch (e) { res.status(e.statusCode||500).json({ error: e.message }); }
});

// ─── List scheduled ───────────────────────────────────────────
app.get('/api/messages/scheduled', requireApiKey, async (req, res) => {
  try {
    const statusParam = req.query.status === undefined ? 'pending' : req.query.status;
    let rows;
    if (statusParam === 'all') {
      rows = await db.all('SELECT * FROM scheduled_messages ORDER BY scheduled_at ASC LIMIT 100');
    } else {
      rows = await db.all('SELECT * FROM scheduled_messages WHERE status=? ORDER BY scheduled_at ASC LIMIT 100', [statusParam]);
    }
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Get single scheduled message ─────────────────────────────
// Registered with the other scheduled routes, before
// GET /api/messages/:agentId, so it is not shadowed by it.
app.get('/api/messages/scheduled/:id', requireApiKey, async (req, res) => {
  try {
    const row = await db.get('SELECT * FROM scheduled_messages WHERE id=?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Scheduled message not found' });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Cancel scheduled ─────────────────────────────────────────
app.delete('/api/messages/scheduled/:id', requireApiKey, async (req, res) => {
  try {
    await db.run('UPDATE scheduled_messages SET status=? WHERE id=? AND status=?', ['cancelled', req.params.id, 'pending']);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get messages for agent
app.get('/api/messages/:agentId', requireApiKey, async (req, res) => {
  try {
    const agent = await requireAgent(req.params.agentId, 'agent');
    const pagination = getPagination(req.query, 100, 500);
    const { items, total } = await fetchMessages({
      toAgent: agent.id,
      since: req.query.since,
      unreadOnly: req.query.unreadOnly === 'true',
      status: req.query.status,
      messageType: req.query.messageType
    }, pagination);

    applyPaginationHeaders(res, total, pagination.limit, pagination.offset);
    res.json(items);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Backward-compatible alias routes
app.get('/api/agents/:agentId/messages', requireApiKey, async (req, res) => {
  try {
    const agent = await requireAgent(req.params.agentId, 'agent');
    const pagination = getPagination(req.query, 100, 500);
    const { items, total } = await fetchMessages({
      toAgent: agent.id,
      since: req.query.since,
      unreadOnly: req.query.unreadOnly === 'true',
      status: req.query.status,
      messageType: req.query.messageType
    }, pagination);

    applyPaginationHeaders(res, total, pagination.limit, pagination.offset);
    res.json(items);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.get('/api/agents/:agentId/inbox', requireApiKey, async (req, res) => {
  try {
    const agent = await requireAgent(req.params.agentId, 'agent');
    const pagination = getPagination(req.query, 100, 500);
    const { items, total } = await fetchMessages({
      toAgent: agent.id,
      since: req.query.since,
      unreadOnly: true,
      status: req.query.status,
      messageType: req.query.messageType
    }, pagination);

    applyPaginationHeaders(res, total, pagination.limit, pagination.offset);
    res.json(items);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Mark message as read
app.post('/api/messages/:id/read', requireApiKey, async (req, res) => {
  try {
    const result = await db.run('UPDATE messages SET read = 1 WHERE id = ?', req.params.id);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete message
app.delete('/api/messages/:id', requireApiKey, async (req, res) => {
  try {
    const result = await db.run('DELETE FROM messages WHERE id = ?', req.params.id);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }

    res.json({ success: true, messageId: req.params.id, deleted: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Broadcast to all agents
app.post('/api/broadcast', requireApiKey, async (req, res) => {
  try {
    const from = req.body.from || req.body.fromAgentId || req.body.sender;
    const { content } = req.body;
    const timeoutMs = toPositiveInt(req.body.timeoutMs, DEFAULT_MESSAGE_TIMEOUT_MS, Number.MAX_SAFE_INTEGER);

    if (!from || !content) {
      return res.status(400).json({ error: 'from and content are required' });
    }

    const fromAgent = await requireAgent(from, 'from agent');

    // Get all agents
    const agents = await db.all('SELECT id FROM agents WHERE id != ?', fromAgent.id);

    const messageIds = [];
    for (const agent of agents) {
      const id = uuidv4();
      await db.run(
        'INSERT INTO messages (id, from_agent, to_agent, content, message_type, timeout_ms) VALUES (?, ?, ?, ?, ?, ?)',
        [id, fromAgent.id, agent.id, content, 'broadcast', timeoutMs]
      );
      messageIds.push(id);
    }
    
    // WebSocket broadcast
    broadcast({
      type: 'broadcast',
      from: fromAgent.id,
      fromName: fromAgent.name,
      content,
      recipientCount: agents.length
    });
    
    res.json({ 
      success: true, 
      recipientCount: agents.length,
      messageIds 
    });
  } catch (error) {
    console.error('[Error] Broadcast:', error);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Batch message — send multiple messages in one call (multi-agent efficiency)
app.post('/api/messages/batch', requireApiKey, async (req, res) => {
  try {
    const { messages } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    if (messages.length > 100) {
      return res.status(400).json({ error: 'Maximum 100 messages per batch' });
    }

    const results = [];
    const errors = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const from = msg.from || msg.fromAgentId || msg.agent;
      const to = msg.to || msg.toAgentId || msg.recipient;
      const content = msg.content || msg.message;
      const messageType = msg.messageType || 'direct';
      const timeoutMs = toPositiveInt(msg.timeoutMs, DEFAULT_MESSAGE_TIMEOUT_MS, Number.MAX_SAFE_INTEGER);

      if (!from || !to || !content) {
        errors.push({ index: i, error: 'from, to, and content are required' });
        continue;
      }

      try {
        const fromAgent = await resolveAgent(from);
        const toAgent = await resolveAgent(to);

        if (!fromAgent) { errors.push({ index: i, error: `from agent not found: ${from}` }); continue; }
        if (!toAgent) { errors.push({ index: i, error: `to agent not found: ${to}` }); continue; }

        const id = uuidv4();
        await db.run(
          'INSERT INTO messages (id, from_agent, to_agent, content, message_type, timeout_ms) VALUES (?, ?, ?, ?, ?, ?)',
          [id, fromAgent.id, toAgent.id, content, messageType, timeoutMs]
        );

        results.push({ index: i, messageId: id, from: fromAgent.id, to: toAgent.id });
      } catch (err) {
        errors.push({ index: i, error: err.message });
      }
    }

    broadcast({ type: 'batch_sent', count: results.length, from: messages[0]?.from });

    res.json({
      success: true,
      sent: results.length,
      failed: errors.length,
      results,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error) {
    console.error('[Error] Batch message:', error);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// === SKILLS ===

// Register skill
app.post('/api/skills', requireApiKey, async (req, res) => {
  try {
    const { agentId, name, description, endpoint } = req.body;
    
    if (!agentId || !name) {
      return res.status(400).json({ error: 'agentId and name are required' });
    }
    
    const id = uuidv4();
    await db.run(
      'INSERT INTO skills (id, agent_id, name, description, endpoint) VALUES (?, ?, ?, ?, ?)',
      [id, agentId, name, description || '', endpoint || '']
    );
    
    res.json({ success: true, skillId: id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Discover skills
app.get('/api/skills', requireApiKey, async (req, res) => {
  try {
    const skills = await db.all(`
      SELECT s.*, a.name as agent_name 
      FROM skills s 
      JOIN agents a ON s.agent_id = a.id
      ORDER BY s.created_at DESC
    `);
    res.json(skills);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Invoke skill on another agent
app.post('/api/skills/:id/invoke', requireApiKey, async (req, res) => {
  try {
    const fromInput = req.body.from || req.body.fromAgentId || req.body.agentId || req.body.agentName || req.body.agent;
    const { payload } = req.body;

    if (!fromInput) {
      return res.status(400).json({ error: 'from agent is required' });
    }

    const fromAgent = await requireAgent(fromInput, 'from agent');
    const skill = await db.get('SELECT * FROM skills WHERE id = ?', req.params.id);

    if (!skill) {
      return res.status(404).json({ error: 'Skill not found' });
    }

    // Send invocation as a message
    const messageId = uuidv4();
    const content = JSON.stringify({
      type: 'skill_invocation',
      skillName: skill.name,
      payload
    });

    await db.run(
      'INSERT INTO messages (id, from_agent, to_agent, content, message_type) VALUES (?, ?, ?, ?, ?)',
      [messageId, fromAgent.id, skill.agent_id, content, 'skill_invocation']
    );

    broadcast({
      type: 'skill_invoked',
      skillId: skill.id,
      skillName: skill.name,
      from: fromAgent.id,
      to: skill.agent_id
    });

    res.json({ success: true, invocationId: messageId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// === AGENT GROUPS ===

// Create a new agent group
app.post('/api/groups', requireApiKey, async (req, res) => {
  try {
    const { name, description, metadata } = req.body;
    const createdByInput = req.body.createdBy || req.body.createdByAgent || req.body.owner;

    if (!name || !createdByInput) {
      return res.status(400).json({ error: 'name and createdBy are required' });
    }

    const createdBy = await requireAgent(createdByInput, 'createdBy agent');

    const id = uuidv4();
    await db.run(
      'INSERT INTO agent_groups (id, name, description, metadata, created_by) VALUES (?, ?, ?, ?, ?)',
      [id, name, description || null, JSON.stringify(metadata || {}), createdBy.id]
    );

    broadcast({
      type: 'group_created',
      group: { id, name, description, createdBy: createdBy.id, createdByName: createdBy.name, metadata }
    });

    res.json({
      success: true,
      groupId: id,
      message: 'Agent group created successfully'
    });
  } catch (error) {
    console.error('[Error] Create group:', error);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// List all agent groups
app.get('/api/groups', requireApiKey, async (req, res) => {
  try {
    const { limit, offset } = getPagination(req.query, 50, 200);
    const totalRow = await db.get('SELECT COUNT(*) as count FROM agent_groups');
    const groups = await db.all(`
      SELECT g.*,
        (SELECT COUNT(*) FROM agent_group_members WHERE group_id = g.id) as member_count
      FROM agent_groups g
      ORDER BY g.created_at DESC
      LIMIT ? OFFSET ?
    `, [limit, offset]);

    applyPaginationHeaders(res, totalRow?.count || 0, limit, offset);
    res.json(groups.map(g => ({
      ...g,
      metadata: parseJson(g.metadata, {})
    })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get specific group details with members (supports ID or name)
app.get('/api/groups/:id', requireApiKey, async (req, res) => {
  try {
    const group = await requireGroup(req.params.id, 'group');

    const members = await db.all(`
      SELECT agm.*, a.name, a.endpoint, a.capabilities, a.last_seen
      FROM agent_group_members agm
      JOIN agents a ON agm.agent_id = a.id
      WHERE agm.group_id = ?
      ORDER BY agm.joined_at ASC
    `, group.id);

    res.json({
      ...group,
      metadata: parseJson(group.metadata, {}),
      members: members.map(m => ({
        ...m,
        capabilities: parseJson(m.capabilities, [])
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add agent to group
app.post('/api/groups/:groupId/members', requireApiKey, async (req, res) => {
  try {
    const { agentId, role = 'member' } = req.body;

    if (!agentId) {
      return res.status(400).json({ error: 'agentId is required' });
    }

    const group = await requireGroup(req.params.groupId, 'group');
    const agent = await requireAgent(agentId, 'agent');

    const existing = await db.get(
      'SELECT * FROM agent_group_members WHERE group_id = ? AND agent_id = ?',
      [group.id, agent.id]
    );

    if (existing) {
      return res.status(409).json({ error: 'Agent is already a member of this group' });
    }

    await db.run(
      'INSERT INTO agent_group_members (group_id, agent_id, role) VALUES (?, ?, ?)',
      [group.id, agent.id, role]
    );

    broadcast({
      type: 'group_member_added',
      groupId: group.id,
      agentId: agent.id,
      agentName: agent.name,
      role
    });

    res.json({
      success: true,
      message: 'Agent added to group successfully'
    });
  } catch (error) {
    console.error('[Error] Add group member:', error);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Remove agent from group (supports agent name for :agentId)
app.delete('/api/groups/:groupId/members/:agentId', requireApiKey, async (req, res) => {
  try {
    const group = await requireGroup(req.params.groupId, 'group');
    const agent = await requireAgent(req.params.agentId, 'agent');
    const result = await db.run(
      'DELETE FROM agent_group_members WHERE group_id = ? AND agent_id = ?',
      [group.id, agent.id]
    );

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Group member not found' });
    }

    broadcast({
      type: 'group_member_removed',
      groupId: group.id,
      agentId: agent.id
    });

    res.json({
      success: true,
      message: 'Agent removed from group successfully'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Discover groups by agent
app.get('/api/agents/:agentId/groups', requireApiKey, async (req, res) => {
  try {
    const agent = await requireAgent(req.params.agentId, 'agent');
    const groups = await db.all(`
      SELECT g.*, agm.role
      FROM agent_groups g
      JOIN agent_group_members agm ON g.id = agm.group_id
      WHERE agm.agent_id = ?
      ORDER BY g.created_at DESC
    `, agent.id);

    res.json(groups.map(g => ({
      ...g,
      metadata: parseJson(g.metadata, {})
    })));
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Discover agents in a group (for targeting)
app.get('/api/groups/:groupId/agents', requireApiKey, async (req, res) => {
  try {
    const group = await requireGroup(req.params.groupId, 'group');
    const agents = await db.all(`
      SELECT a.*, agm.role
      FROM agents a
      JOIN agent_group_members agm ON a.id = agm.agent_id
      WHERE agm.group_id = ?
      ORDER BY a.name ASC
    `, group.id);

    res.json(agents.map(a => ({
      ...a,
      capabilities: parseJson(a.capabilities, [])
    })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Send message to entire group
app.post('/api/groups/:groupId/broadcast', requireApiKey, async (req, res) => {
  try {
    // Resolve name-or-ID to actual group
    const group = await requireGroup(req.params.groupId, 'group');
    const from = req.body.from || req.body.fromAgentId || req.body.sender;
    const { content, messageType = 'direct' } = req.body;

    if (!from || !content) {
      return res.status(400).json({ error: 'from and content are required' });
    }

    const fromAgent = await requireAgent(from, 'from agent');

    // Get all agents in group except sender
    const agents = await db.all(`
      SELECT agm.agent_id
      FROM agent_group_members agm
      WHERE agm.group_id = ? AND agm.agent_id != ?
    `, [group.id, fromAgent.id]);

    if (agents.length === 0) {
      return res.status(404).json({ error: 'No agents found in group' });
    }

    const messageIds = [];
    for (const agentRecord of agents) {
      const id = uuidv4();
      await db.run(
        'INSERT INTO messages (id, from_agent, to_agent, content, message_type, status, timeout_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, fromAgent.id, agentRecord.agent_id, content, messageType, 'delivered', DEFAULT_MESSAGE_TIMEOUT_MS]
      );
      messageIds.push(id);
    }

    broadcast({
      type: 'group_broadcast',
      groupId: group.id,
      from: fromAgent.id,
      fromName: fromAgent.name,
      content,
      recipientCount: agents.length
    });

    res.json({
      success: true,
      recipientCount: agents.length,
      messageIds
    });
  } catch (error) {
    console.error('[Error] Group broadcast:', error);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// === COLLECTIVE MEMORY ===

// Store shared memory in a group
app.post('/api/groups/:groupId/memory', requireApiKey, async (req, res) => {
  try {
    const agentInput = req.body.agentId || req.body.agentName || req.body.agent;
    const { key, value, memoryType = 'shared' } = req.body;

    if (!agentInput || !key || value === undefined) {
      return res.status(400).json({ error: 'agentId, key, and value are required' });
    }

    const group = await requireGroup(req.params.groupId, 'group');
    const agent = await requireAgent(agentInput, 'agent');

    const membership = await db.get(
      'SELECT * FROM agent_group_members WHERE group_id = ? AND agent_id = ?',
      [group.id, agent.id]
    );

    if (!membership) {
      return res.status(403).json({ error: 'Agent is not a member of this group' });
    }

    const existing = await db.get(
      'SELECT * FROM collective_memory WHERE group_id = ? AND key = ?',
      [group.id, key]
    );

    let memoryId;
    if (existing) {
      memoryId = existing.id;
      await db.run(
        'UPDATE collective_memory SET value = ?, agent_id = ?, memory_type = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [JSON.stringify(value), agent.id, memoryType, memoryId]
      );
    } else {
      memoryId = uuidv4();
      await db.run(
        'INSERT INTO collective_memory (id, group_id, agent_id, key, value, memory_type) VALUES (?, ?, ?, ?, ?, ?)',
        [memoryId, group.id, agent.id, key, JSON.stringify(value), memoryType]
      );
    }

    broadcast({
      type: 'memory_updated',
      groupId: group.id,
      memoryId,
      key,
      agentId: agent.id
    });

    res.json({
      success: true,
      memoryId,
      version: existing ? existing.version + 1 : 1
    });
  } catch (error) {
    console.error('[Error] Store memory:', error);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Get all memory keys for a group
app.get('/api/groups/:groupId/memory', requireApiKey, async (req, res) => {
  try {
    const group = await requireGroup(req.params.groupId, 'group');
    const { keys, memoryType } = req.query;
    let query = 'SELECT * FROM collective_memory WHERE group_id = ?';
    const params = [group.id];

    if (memoryType) {
      query += ' AND memory_type = ?';
      params.push(memoryType);
    }

    if (keys) {
      const keyList = keys.split(',');
      query += ` AND key IN (${keyList.map(() => '?').join(',')})`;
      params.push(...keyList);
    }

    query += ' ORDER BY updated_at DESC';

    const memories = await db.all(query, params);

    res.json(memories.map(m => ({
      ...m,
      value: parseJson(m.value, {})
    })));
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Get specific memory key
app.get('/api/groups/:groupId/memory/:key', requireApiKey, async (req, res) => {
  try {
    const group = await requireGroup(req.params.groupId, 'group');
    const memory = await db.get(
      'SELECT * FROM collective_memory WHERE group_id = ? AND key = ?',
      [group.id, req.params.key]
    );

    if (!memory) {
      return res.status(404).json({ error: 'Memory key not found' });
    }

    res.json({
      ...memory,
      value: parseJson(memory.value, {})
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Delete memory key
app.delete('/api/groups/:groupId/memory/:key', requireApiKey, async (req, res) => {
  try {
    const agentInput = req.body.agentId || req.body.agentName || req.body.agent;

    if (!agentInput) {
      return res.status(400).json({ error: 'agentId is required' });
    }

    const group = await requireGroup(req.params.groupId, 'group');
    const agent = await requireAgent(agentInput, 'agent');

    const membership = await db.get(
      'SELECT * FROM agent_group_members WHERE group_id = ? AND agent_id = ?',
      [group.id, agent.id]
    );

    if (!membership) {
      return res.status(403).json({ error: 'Agent is not a member of this group' });
    }

    const result = await db.run(
      'DELETE FROM collective_memory WHERE group_id = ? AND key = ?',
      [group.id, req.params.key]
    );

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Memory key not found' });
    }

    broadcast({
      type: 'memory_deleted',
      groupId: group.id,
      key: req.params.key,
      agentId: agent.id
    });

    res.json({
      success: true,
      message: 'Memory deleted successfully'
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Get memory history (versions) for a key
app.get('/api/groups/:groupId/memory/:key/history', requireApiKey, async (req, res) => {
  try {
    const group = await requireGroup(req.params.groupId, 'group');
    const memory = await db.get(
      'SELECT * FROM collective_memory WHERE group_id = ? AND key = ?',
      [group.id, req.params.key]
    );

    if (!memory) {
      return res.status(404).json({ error: 'Memory key not found' });
    }

    res.json({
      key: memory.key,
      currentVersion: memory.version,
      lastUpdated: memory.updated_at,
      lastUpdatedBy: memory.agent_id
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// === ENHANCED MESSAGING WITH TIMEOUT HANDLING ===

// Update message status (for timeout handling)
app.patch('/api/messages/:id/status', requireApiKey, async (req, res) => {
  try {
    const { status, error } = req.body;

    if (!status) {
      return res.status(400).json({ error: 'status is required' });
    }

    if (!VALID_MESSAGE_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_MESSAGE_STATUSES.join(', ')}` });
    }

    const message = await db.get('SELECT * FROM messages WHERE id = ?', req.params.id);

    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }

    await db.run(
      'UPDATE messages SET status = ? WHERE id = ?',
      [status, req.params.id]
    );

    // If message failed or timed out, store error details
    if (status === 'failed' || status === 'timeout') {
      broadcast({
        type: 'message_failed',
        messageId: req.params.id,
        status,
        error: error || 'Message processing failed',
        toAgent: message.to_agent
      });
    }

    res.json({ success: true, status });
  } catch (error) {
    console.error('[Error] Update message status:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get failed/timeout messages for retry
app.get('/api/messages/:agentId/failed', requireApiKey, async (req, res) => {
  try {
    const agent = await requireAgent(req.params.agentId, 'agent');
    const messages = await db.all(`
      SELECT * FROM messages
      WHERE to_agent = ? AND status IN ('failed', 'timeout')
      ORDER BY created_at DESC
      LIMIT 50
    `, agent.id);

    res.json(messages.map(normalizeMessage));
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Retry failed message
app.post('/api/messages/:id/retry', requireApiKey, async (req, res) => {
  try {
    const message = await db.get('SELECT * FROM messages WHERE id = ?', req.params.id);

    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }

    if (message.status !== 'failed' && message.status !== 'timeout') {
      return res.status(400).json({ error: 'Only failed or timeout messages can be retried' });
    }

    // Reset status to pending
    await db.run(
      'UPDATE messages SET status = ? WHERE id = ?',
      ['pending', req.params.id]
    );

    broadcast({
      type: 'message_retry',
      messageId: req.params.id,
      toAgent: message.to_agent
    });

    res.json({
      success: true,
      message: 'Message queued for retry'
    });
  } catch (error) {
    console.error('[Error] Retry message:', error);
    res.status(500).json({ error: error.message });
  }
});

// === FILE TRANSFER ===

// Upload file to mesh
app.post('/api/files/upload', requireApiKey, async (req, res) => {
  try {
    const agentInput = req.body.agentId || req.body.agentName || req.body.agent;
    const { filename, fileType, fileData, description } = req.body;

    if (!agentInput || !filename || !fileData) {
      return res.status(400).json({ error: 'agentId, filename, and fileData are required' });
    }

    // Verify agent exists
    const agent = await requireAgent(agentInput, 'agent');

    const id = uuidv4();
    const fileSize = Buffer.from(fileData, 'base64').length;

    await db.run(
      'INSERT INTO agent_files (id, agent_id, filename, file_type, file_size, file_data, description) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, agent.id, filename, fileType || null, fileSize, fileData, description || null]
    );

    console.log(`[File Upload] Agent "${agent.name}" uploaded file: ${filename} (${fileSize} bytes)`);

    // Broadcast file availability
    broadcast({
      type: 'file_available',
      file: { id, agentId: agent.id, agentName: agent.name, filename, fileType, fileSize, description }
    });

    res.json({
      success: true,
      fileId: id,
      url: `/api/files/${id}`,
      filename,
      fileSize,
      message: 'File uploaded successfully'
    });
  } catch (error) {
    console.error('[Error] Upload file:', error);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Download file from mesh
app.get('/api/files/:id', requireApiKey, async (req, res) => {
  try {
    const file = await db.get('SELECT * FROM agent_files WHERE id = ?', req.params.id);

    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    res.json({
      ...file,
      fileData: file.file_data // Base64 encoded
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List all files
app.get('/api/files', requireApiKey, async (req, res) => {
  try {
    const agentFilter = req.query.agentId || req.query.agentName || req.query.agent;
    const { limit, offset } = getPagination(req.query, 50, 200);

    const agent = agentFilter ? await requireAgent(agentFilter, 'agent') : null;
    const where = agent ? 'WHERE agent_id = ?' : '';
    const params = agent ? [agent.id] : [];
    const totalRow = await db.get(`SELECT COUNT(*) as count FROM agent_files ${where}`, params);
    const files = await db.all(
      `SELECT * FROM agent_files ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    applyPaginationHeaders(res, totalRow?.count || 0, limit, offset);
    res.json(files.map(f => ({
      id: f.id,
      agentId: f.agent_id,
      filename: f.filename,
      fileType: f.file_type,
      fileSize: f.file_size,
      description: f.description,
      createdAt: f.created_at
    })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete file
app.delete('/api/files/:id', requireApiKey, async (req, res) => {
  try {
    const agentInput = req.body.agentId || req.body.agentName || req.body.agent;

    if (!agentInput) {
      return res.status(400).json({ error: 'agentId is required for deletion' });
    }

    const agent = await requireAgent(agentInput, 'agent');
    const file = await db.get('SELECT * FROM agent_files WHERE id = ?', req.params.id);

    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Verify ownership
    if (file.agent_id !== agent.id) {
      return res.status(403).json({ error: 'You can only delete your own files' });
    }

    await db.run('DELETE FROM agent_files WHERE id = ?', req.params.id);

    console.log(`[File Delete] File deleted: ${req.params.id}`);

    res.json({
      success: true,
      message: 'File deleted successfully'
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// === SYSTEM UPDATES ===

// Create system update
app.post('/api/updates', requireApiKey, async (req, res) => {
  try {
    const { version, updateType, title, description, requiredVersion, breakingChange, announcement, sha256 } = req.body;
    const payloadUrl = req.body.payloadUrl || req.body.payload_url || null;

    if (!version || !updateType || !title) {
      return res.status(400).json({ error: 'version, updateType, and title are required' });
    }

    const id = uuidv4();
    await db.run(
      'INSERT INTO system_updates (id, version, update_type, title, description, required_version, breaking_change, announcement, payload_url, sha256, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, version, updateType, title, description || null, requiredVersion || null, breakingChange || false, announcement || null, payloadUrl, sha256 || null, 'DuckBot']
    );

    console.log(`[System Update] New update created: ${title} (${version})`);

    // Broadcast to all agents
    broadcast({
      type: 'system_update',
      update: {
        id,
        version,
        updateType,
        title,
        description,
        requiredVersion,
        breakingChange,
        announcement,
        payloadUrl,
        payload_url: payloadUrl,
        sha256: sha256 || null,
        createdAt: new Date().toISOString()
      }
    });

    res.json({
      success: true,
      updateId: id,
      broadcast: true,
      message: 'System update created and broadcasted'
    });
  } catch (error) {
    console.error('[Error] Create system update:', error);
    res.status(500).json({ error: error.message });
  }
});

// List system updates
app.get('/api/updates', requireApiKey, async (req, res) => {
  try {
    const { since, activeOnly } = req.query;
    const { limit, offset } = getPagination(req.query, 50, 200);
    const clauses = [];
    const params = [];

    if (since) {
      clauses.push('created_at > ?');
      params.push(since);
    }

    if (activeOnly === 'true') {
      clauses.push('(expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)');
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const totalRow = await db.get(`SELECT COUNT(*) as count FROM system_updates ${where}`, params);
    const updates = await db.all(
      `SELECT * FROM system_updates ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    applyPaginationHeaders(res, totalRow?.count || 0, limit, offset);
    res.json(updates);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Acknowledge update
app.post('/api/updates/:id/acknowledge', requireApiKey, async (req, res) => {
  try {
    const agentInput = req.body.agentId || req.body.agentName || req.body.agent;
    const { status, agentVersion, notes } = req.body;

    if (!agentInput || !status) {
      return res.status(400).json({ error: 'agentId and status are required' });
    }

    const agent = await requireAgent(agentInput, 'agent');

    // Check if update exists
    const update = await db.get('SELECT * FROM system_updates WHERE id = ?', req.params.id);
    if (!update) {
      return res.status(404).json({ error: 'Update not found' });
    }

    const existing = await db.get(
      'SELECT id FROM update_acknowledgments WHERE update_id = ? AND agent_id = ?',
      [req.params.id, agent.id]
    );
    const id = existing?.id || uuidv4();

    await db.run(`
      INSERT INTO update_acknowledgments (id, update_id, agent_id, agent_version, status, notes)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(update_id, agent_id) DO UPDATE SET
        agent_version = excluded.agent_version,
        status = excluded.status,
        notes = excluded.notes,
        acknowledged_at = CURRENT_TIMESTAMP
    `,
      [id, req.params.id, agent.id, agentVersion || null, status, notes || null]
    );

    console.log(`[Update Acknowledgment] Agent ${agent.id} acknowledged update ${req.params.id}: ${status}`);

    res.json({
      success: true,
      message: 'Update acknowledged',
      acknowledgmentId: id
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Get update acknowledgments
app.get('/api/updates/:id/acknowledgments', requireApiKey, async (req, res) => {
  try {
    const acknowledgments = await db.all(`
      SELECT ua.*, a.name as agent_name, a.endpoint as agent_endpoint
      FROM update_acknowledgments ua
      JOIN agents a ON ua.agent_id = a.id
      WHERE ua.update_id = ?
      ORDER BY ua.acknowledged_at DESC
    `, req.params.id);

    res.json(acknowledgments);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// === CATASTROPHE PROTOCOLS ===

// Report catastrophe event
app.post('/api/catastrophe', requireApiKey, async (req, res) => {
  try {
    const { eventType, severity, title, description, recoveryProtocol, affectedAgents } = req.body;

    if (!eventType || !severity || !title) {
      return res.status(400).json({ error: 'eventType, severity, and title are required' });
    }

    const id = uuidv4();
    await db.run(
      'INSERT INTO catastrophe_events (id, event_type, severity, title, description, affected_agents, recovery_protocol) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, eventType, severity, title, description || null, JSON.stringify(affectedAgents || []), recoveryProtocol || null]
    );

    console.log(`[CATASTROPHE] ${severity.toUpperCase()}: ${title} (${eventType})`);

    // Broadcast catastrophe alert
    broadcast({
      type: 'catastrophe_alert',
      catastrophe: {
        id,
        eventType,
        severity,
        title,
        description,
        recoveryProtocol,
        occurredAt: new Date().toISOString()
      }
    });

    res.json({
      success: true,
      eventId: id,
      broadcast: true,
      message: 'Catastrophe event reported and broadcasted'
    });
  } catch (error) {
    console.error('[Error] Report catastrophe:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get catastrophe protocols guide (MUST be before /:id route)
app.get('/api/catastrophe/protocols', requireApiKey, async (req, res) => {
  try {
    const protocols = {
      server_crash_recovery: {
        trigger: 'Server process dies unexpectedly',
        steps: [
          '1. Detect crash via watchdog process',
          '2. Attempt graceful restart (preserve database)',
          '3. Broadcast crash to all agents',
          '4. Roll agents to previous stable version if needed',
          '5. Monitor for database corruption',
          '6. If DB corrupted: restore from backup',
          '7. Broadcast recovery status'
        ]
      },
      database_corruption: {
        trigger: 'SQLite database errors or corruption detected',
        steps: [
          '1. Detect corruption via error logs',
          '2. Mark catastrophe event',
          '3. Stop server process',
          '4. Restore database from last backup',
          '5. Verify database integrity',
          '6. Start server in read-only mode',
          '7. Test all critical endpoints',
          '8. Broadcast recovery complete'
        ]
      },
      network_partition: {
        trigger: 'Agents cannot reach server',
        steps: [
          '1. Agents detect offline status (heartbeat timeout)',
          '2. Switch to offline mode (file-based coordination)',
          '3. Queue messages locally',
          '4. Monitor for server recovery',
          '5. When server back: sync queued messages',
          '6. Mark catastrophe resolved'
        ]
      },
      breaking_api_update: {
        trigger: 'API version change with breaking changes',
        steps: [
          '1. Broadcast update announcement',
          '2. Mark as breaking change',
          '3. Require minimum version from agents',
          '4. Wait for acknowledgments',
          '5. Reject messages from incompatible agents',
          '6. Provide upgrade instructions',
          '7. Monitor adoption rate',
          '8. Mark update complete'
        ]
      }
    };

    res.json(protocols);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get catastrophe event
app.get('/api/catastrophe/:id', requireApiKey, async (req, res) => {
  try {
    const catastrophe = await db.get('SELECT * FROM catastrophe_events WHERE id = ?', req.params.id);

    if (!catastrophe) {
      return res.status(404).json({ error: 'Catastrophe event not found' });
    }

    res.json({
      ...catastrophe,
      affectedAgents: JSON.parse(catastrophe.affected_agents || '[]')
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List catastrophe events
app.get('/api/catastrophe', requireApiKey, async (req, res) => {
  try {
    const { status: statusFilter, severity: severityFilter } = req.query;
    const { limit, offset } = getPagination(req.query, 50, 200);
    const clauses = [];
    const params = [];

    if (statusFilter) {
      clauses.push('status = ?');
      params.push(statusFilter);
    }

    if (severityFilter) {
      clauses.push('severity = ?');
      params.push(severityFilter);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const totalRow = await db.get(`SELECT COUNT(*) as count FROM catastrophe_events ${where}`, params);
    const catastrophes = await db.all(
      `SELECT * FROM catastrophe_events ${where} ORDER BY occurred_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    applyPaginationHeaders(res, totalRow?.count || 0, limit, offset);
    res.json(catastrophes.map(c => ({
      ...c,
      affectedAgents: parseJson(c.affected_agents, [])
    })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Resolve catastrophe
app.post('/api/catastrophe/:id/resolve', requireApiKey, async (req, res) => {
  try {
    const { resolutionNotes } = req.body;

    await db.run(
      'UPDATE catastrophe_events SET status = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ?',
      ['resolved', req.params.id]
    );

    console.log(`[Catastrophe Resolved] Event ${req.params.id} resolved`);

    res.json({
      success: true,
      message: 'Catastrophe resolved'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// === ENHANCED HEALTH MONITORING ===

// Enhanced health report endpoint (supports ID or name)
app.post('/api/agents/:id/health', requireApiKey, async (req, res) => {
  try {
    const { status = 'healthy', uptimeSeconds, cpuUsage, memoryUsage, customMetrics = {} } = req.body || {};

    if (!VALID_HEALTH_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Invalid health status. Must be one of: ${VALID_HEALTH_STATUSES.join(', ')}` });
    }

    const agent = await requireAgent(req.params.id, 'agent');

    await db.run('UPDATE agents SET last_seen = CURRENT_TIMESTAMP WHERE id = ?', agent.id);
    await db.run(
      `INSERT INTO agent_health_status
       (agent_id, status, last_heartbeat, uptime_seconds, cpu_usage, memory_usage, custom_metrics, last_updated)
       VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(agent_id) DO UPDATE SET
         status = excluded.status,
         last_heartbeat = CURRENT_TIMESTAMP,
         uptime_seconds = excluded.uptime_seconds,
         cpu_usage = excluded.cpu_usage,
         memory_usage = excluded.memory_usage,
         custom_metrics = excluded.custom_metrics,
         last_updated = CURRENT_TIMESTAMP`,
      [agent.id, status, uptimeSeconds || null, cpuUsage || null, memoryUsage || null, JSON.stringify(customMetrics)]
    );

    broadcast({
      type: 'agent_health_change',
      agentId: agent.id,
      status,
      metrics: { uptimeSeconds, cpuUsage, memoryUsage, customMetrics }
    });

    res.json({ success: true, message: 'Health status updated', status });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Get agent health details (supports ID or name)
app.get('/api/agents/:id/health', requireApiKey, async (req, res) => {
  try {
    const agent = await requireAgent(req.params.id, 'agent');
    const health = await db.get('SELECT * FROM agent_health_status WHERE agent_id = ?', agent.id);

    if (!health) {
      return res.status(404).json({ error: 'Health status not found' });
    }

    res.json({
      agentId: health.agent_id,
      status: health.status,
      lastHeartbeat: health.last_heartbeat,
      uptimeSeconds: health.uptime_seconds,
      cpuUsage: health.cpu_usage,
      memoryUsage: health.memory_usage,
      customMetrics: parseJson(health.custom_metrics, {}),
      lastUpdated: health.last_updated
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Health dashboard summary
app.get('/api/health/dashboard', requireApiKey, async (req, res) => {
  try {
    const offlineWindow = `-${OFFLINE_THRESHOLD_MINUTES} minutes`;

    // Get health summary
    const healthSummary = await db.get(`
      SELECT
        SUM(CASE WHEN status = 'healthy' THEN 1 ELSE 0 END) as healthy,
        SUM(CASE WHEN status = 'degraded' THEN 1 ELSE 0 END) as degraded,
        SUM(CASE WHEN status = 'unhealthy' THEN 1 ELSE 0 END) as unhealthy,
        SUM(CASE WHEN status = 'offline' THEN 1 ELSE 0 END) as explicit_offline,
        COUNT(*) as total
      FROM agent_health_status
    `);

    // Get active catastrophes
    const activeCatastrophes = await db.all(
      'SELECT * FROM catastrophe_events WHERE status = ? ORDER BY occurred_at DESC LIMIT 5',
      ['active']
    );

    // Get all agents with health status
    const agents = await db.all(`
      SELECT
        a.id, a.name, a.endpoint, a.last_seen as last_seen,
        h.status, h.uptime_seconds, h.cpu_usage, h.memory_usage, h.last_updated
      FROM agents a
      LEFT JOIN agent_health_status h ON a.id = h.agent_id
      ORDER BY a.last_seen DESC
    `);

    const offlineCount = await db.get(
      `SELECT COUNT(*) as count
       FROM agents
       WHERE datetime(last_seen) < datetime('now', ?)` ,
      [offlineWindow]
    );

    res.json({
      version: APP_VERSION,
      totalAgents: healthSummary?.total || 0,
      healthy: healthSummary?.healthy || 0,
      degraded: healthSummary?.degraded || 0,
      unhealthy: healthSummary?.unhealthy || 0,
      offline: Math.max(offlineCount?.count || 0, healthSummary?.explicit_offline || 0),
      criticalEvents: activeCatastrophes.length,
      lastCatastrophe: activeCatastrophes[0] || null,
      agentList: agents.map(a => ({
        agentId: a.id,
        name: a.name,
        endpoint: a.endpoint,
        status: a.status || 'unknown',
        uptimeSeconds: a.uptime_seconds,
        cpuUsage: a.cpu_usage,
        memoryUsage: a.memory_usage,
        lastSeen: a.last_seen,
        lastUpdated: a.last_updated
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Mesh stats and observability snapshot
app.get('/api/stats', requireApiKey, async (req, res) => {
  try {
    const [agents, messages, groups, files, updates, catastrophes] = await Promise.all([
      db.get('SELECT COUNT(*) as count FROM agents'),
      db.get('SELECT COUNT(*) as count FROM messages'),
      db.get('SELECT COUNT(*) as count FROM agent_groups'),
      db.get('SELECT COUNT(*) as count FROM agent_files'),
      db.get('SELECT COUNT(*) as count FROM system_updates'),
      db.get('SELECT COUNT(*) as count FROM catastrophe_events WHERE status = ?', ['active'])
    ]);

    res.json({
      service: 'agent-mesh-api',
      version: APP_VERSION,
      uptimeSeconds: Math.floor((Date.now() - SERVER_STARTED_AT) / 1000),
      websocketClients: clients.size,
      bodyLimit: BODY_LIMIT,
      defaults: {
        offlineMinutes: OFFLINE_THRESHOLD_MINUTES,
        messageTimeoutMs: DEFAULT_MESSAGE_TIMEOUT_MS,
        timeoutCheckIntervalMs: MESSAGE_TIMEOUT_CHECK_INTERVAL_MS,
        scheduledMessageCheckIntervalMs: SCHEDULED_MESSAGE_CHECK_INTERVAL_MS
      },
      counts: {
        agents: agents.count,
        messages: messages.count,
        groups: groups.count,
        files: files.count,
        updates: updates.count,
        activeCatastrophes: catastrophes.count
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// === TIMEOUT HANDLING UTILITIES ===

// Check for timed out messages (runs periodically)
async function checkMessageTimeouts() {
  try {
    const timedOutMessages = await db.all(`
      SELECT * FROM messages
      WHERE status IN ('pending', 'processing')
        AND timeout_ms IS NOT NULL
        AND datetime(created_at, '+' || CAST(timeout_ms / 1000 AS INTEGER) || ' seconds') <= CURRENT_TIMESTAMP
    `);

    for (const msg of timedOutMessages) {
      await db.run(
        'UPDATE messages SET status = ? WHERE id = ?',
        ['timeout', msg.id]
      );

      broadcast({
        type: 'message_timeout',
        messageId: msg.id,
        toAgent: msg.to_agent,
        fromAgent: msg.from_agent,
        createdAt: msg.created_at,
        timeoutMs: msg.timeout_ms
      });

      console.log(`[Timeout] Message ${msg.id} timed out for agent ${msg.to_agent}`);
    }

    if (timedOutMessages.length > 0) {
      console.log(`[Timeout] Processed ${timedOutMessages.length} timed out messages`);
    }
  } catch (error) {
    console.error('[Error] Checking message timeouts:', error);
  }
}

// Run timeout check every minute
setInterval(checkMessageTimeouts, MESSAGE_TIMEOUT_CHECK_INTERVAL_MS);

// === SCHEDULED MESSAGE DELIVERY ===

let scheduledDeliveryRunning = false;

// Deliver one due scheduled message via the same paths as POST /api/messages
// (direct) and POST /api/groups/:groupId/broadcast (group), broadcasting the
// same WebSocket events a normal send does. Returns the recipient count.
async function deliverScheduledMessage(row) {
  const fromAgent = await db.get('SELECT * FROM agents WHERE id = ?', [row.from_agent]);
  if (!fromAgent) throw new Error(`from agent not found: ${row.from_agent}`);
  const messageType = row.intent || 'direct';

  if (row.to_group) {
    const group = await db.get(
      'SELECT * FROM agent_groups WHERE id = ? OR name = ? LIMIT 1',
      [row.to_group, row.to_group]
    );
    if (!group) throw new Error(`group not found: ${row.to_group}`);

    const members = await db.all(
      'SELECT agent_id FROM agent_group_members WHERE group_id = ? AND agent_id != ?',
      [group.id, fromAgent.id]
    );
    if (members.length === 0) throw new Error(`group has no recipients: ${row.to_group}`);

    for (const member of members) {
      const id = uuidv4();
      await db.run(
        'INSERT INTO messages (id, from_agent, to_agent, content, message_type, status, timeout_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, fromAgent.id, member.agent_id, row.content, messageType, 'delivered', DEFAULT_MESSAGE_TIMEOUT_MS]
      );
    }

    broadcast({
      type: 'group_broadcast',
      groupId: group.id,
      from: fromAgent.id,
      fromName: fromAgent.name,
      content: row.content,
      recipientCount: members.length,
      scheduledMessageId: row.id
    });

    return members.length;
  }

  const toAgent = await resolveAgent(row.to_agent);
  if (!toAgent) throw new Error(`to agent not found: ${row.to_agent}`);

  const id = uuidv4();
  await db.run(
    'INSERT INTO messages (id, from_agent, to_agent, content, message_type, timeout_ms) VALUES (?, ?, ?, ?, ?, ?)',
    [id, fromAgent.id, toAgent.id, row.content, messageType, DEFAULT_MESSAGE_TIMEOUT_MS]
  );

  broadcast({
    type: 'new_message',
    message: {
      id,
      from: fromAgent.id,
      fromName: fromAgent.name,
      to: toAgent.id,
      toName: toAgent.name,
      content: row.content,
      messageType,
      timeoutMs: DEFAULT_MESSAGE_TIMEOUT_MS,
      createdAt: new Date().toISOString(),
      scheduledMessageId: row.id
    }
  });

  return 1;
}

// Find due scheduled messages, deliver them, and mark each sent/failed
async function processScheduledMessages() {
  if (scheduledDeliveryRunning) return;
  scheduledDeliveryRunning = true;
  try {
    const due = await db.all(
      `SELECT * FROM scheduled_messages
       WHERE status = 'pending' AND datetime(scheduled_at) <= datetime('now')
       ORDER BY priority DESC, scheduled_at ASC LIMIT 100`
    );

    for (const row of due) {
      try {
        const recipients = await deliverScheduledMessage(row);
        await db.run('UPDATE scheduled_messages SET status = ? WHERE id = ?', ['sent', row.id]);
        console.log(`[Scheduled] Delivered scheduled message ${row.id} to ${recipients} recipient(s)`);
      } catch (error) {
        await db.run('UPDATE scheduled_messages SET status = ? WHERE id = ?', ['failed', row.id]);
        console.error(`[Scheduled] Failed to deliver scheduled message ${row.id}:`, error.message);
      }
    }
  } catch (error) {
    console.error('[Error] Processing scheduled messages:', error);
  } finally {
    scheduledDeliveryRunning = false;
  }
}

// Run scheduled delivery loop (interval configurable via SCHEDULED_MESSAGE_CHECK_INTERVAL_MS)
setInterval(processScheduledMessages, SCHEDULED_MESSAGE_CHECK_INTERVAL_MS);

// ═══════════════════════════════════════════════════════════════
// v4.0: PRESENCE & CAPABILITY ROUTING
// ═══════════════════════════════════════════════════════════════

const REACTION_SEMANTICS = {
  '👍': 'ACKNOWLEDGED', '👎': 'REJECTED', '🔄': 'PROCESSING',
  '✅': 'COMPLETED', '❌': 'FAILED', '⚠️': 'WARNING',
  '🎯': 'TARGETED', '💡': 'IDEA', '🔥': 'URGENT',
  '🤝': 'AGREED', '❓': 'QUESTION', '📌': 'PINNED'
};

// ─── Update own presence ────────────────────────────────────────
app.patch('/api/agents/:id/presence', requireApiKey, async (req, res) => {
  try {
    const agent = await requireAgent(req.params.id, 'agent');
    const { state, statusMessage, capabilities, bandwidthUpload, bandwidthDownload, storageFreeGb } = req.body;
    const validStates = ['online','busy','idle','away','offline'];
    const s = validStates.includes(state) ? state : 'online';
    const caps = Array.isArray(capabilities) ? JSON.stringify(capabilities) : (typeof capabilities === 'string' ? capabilities : '[]');
    await db.run(`INSERT OR REPLACE INTO agent_presence (agent_id,state,status_message,last_ping,capabilities,bandwidth_upload,bandwidth_download,storage_free_gb) VALUES (?,?,?,?,?,?,?,?)`,
      [agent.id, s, statusMessage||'', Date.now(), caps, bandwidthUpload||0, bandwidthDownload||0, storageFreeGb||0]);
    broadcast({ type: 'presence_changed', agentId: agent.id, state: s, statusMessage: statusMessage||'' });
    res.json({ success: true, state: s });
  } catch (e) { res.status(e.statusCode||500).json({ error: e.message }); }
});

// ─── Get agent presence ────────────────────────────────────────
app.get('/api/agents/:id/presence', requireApiKey, async (req, res) => {
  try {
    const p = await db.get('SELECT * FROM agent_presence WHERE agent_id = ?', [req.params.id]);
    res.json(p ? { ...p, capabilities: JSON.parse(p.capabilities||'[]') } : { agent_id: req.params.id, state: 'offline', status_message: '', capabilities: [] });
  } catch (e) { res.status(e.statusCode||500).json({ error: e.message }); }
});

// ─── List all presence ──────────────────────────────────────────
app.get('/api/presence', requireApiKey, async (req, res) => {
  try {
    const { state, capability } = req.query;
    let sql = 'SELECT ap.*, a.name as agent_name FROM agent_presence ap JOIN agents a ON ap.agent_id = a.id';
    const params = [], conds = [];
    if (state) { conds.push('ap.state = ?'); params.push(state); }
    if (capability) { conds.push('ap.capabilities LIKE ?'); params.push(`%"${capability}"%`); }
    if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
    sql += ' ORDER BY ap.last_ping DESC';
    const rows = await db.all(sql, params);
    res.json(rows.map(r => ({ ...r, capabilities: JSON.parse(r.capabilities||'[]') })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Route task to best agent ───────────────────────────────────
app.post('/api/mesh/route', requireApiKey, async (req, res) => {
  try {
    const { task, requiresCapabilities, priority } = req.body;
    let sql = `SELECT ap.*, a.name FROM agent_presence ap JOIN agents a ON ap.agent_id = a.id WHERE ap.state NOT IN ('offline','away')`;
    const params = [];
    if (requiresCapabilities && requiresCapabilities.length) {
      const caps = requiresCapabilities.map(c => `ap.capabilities LIKE '%"${c}"%'`).join(' AND ');
      sql += ' AND ' + caps;
    }
    sql += ' ORDER BY ap.last_ping DESC LIMIT 5';
    const candidates = await db.all(sql, params);
    const scored = candidates.map(a => {
      const ac = JSON.parse(a.capabilities||'[]');
      return { ...a, capabilities: ac, score: ac.filter(c => requiresCapabilities&&requiresCapabilities.includes(c)).length + (a.state==='online'?10:0) };
    }).sort((a,b) => b.score - a.score);
    if (!scored.length) return res.json({ success: false, error: 'No agents available', candidates: [] });
    const taskId = uuidv4(), assignedId = scored[0].agent_id;
    await db.run(`INSERT INTO agent_tasks (id,title,state,owner_id,assigned_id,priority,context) VALUES (?,?,?,?,?,?,?)`,
      [taskId, task||'Routed task', 'pending', null, assignedId, priority||5, JSON.stringify({ requiresCapabilities })]);
    broadcast({ type: 'task_routed', taskId, agentId: assignedId, task, priority: priority||5 });
    res.json({ success: true, taskId, routedTo: scored[0].name, candidates: scored.slice(0,3).map(a=>({name:a.name, score:a.score, state:a.state})) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// v4.0: THREADS / CONVERSATION CONTEXT
// ═══════════════════════════════════════════════════════════════

// ─── Create thread ──────────────────────────────────────────────
app.post('/api/threads', requireApiKey, async (req, res) => {
  try {
    const { groupId, parentId, title, context, createdBy } = req.body;
    const id = uuidv4();
    const agent = createdBy ? await resolveAgent(createdBy) : null;
    await db.run(`INSERT INTO agent_threads (id,group_id,parent_id,title,context,created_by) VALUES (?,?,?,?,?,?)`,
      [id, groupId||null, parentId||null, title||'', context||'', agent?.id||null]);
    res.json({ success: true, id, title: title||'' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── List threads ───────────────────────────────────────────────
app.get('/api/threads', requireApiKey, async (req, res) => {
  try {
    const { groupId, parentId } = req.query;
    let sql = 'SELECT * FROM agent_threads WHERE 1=1';
    const params = [];
    if (groupId) { sql += ' AND group_id = ?'; params.push(groupId); }
    if (parentId) { sql += ' AND parent_id = ?'; params.push(parentId); }
    sql += ' ORDER BY updated_at DESC LIMIT 50';
    res.json(await db.all(sql, params));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Get thread + messages ──────────────────────────────────────
app.get('/api/threads/:id', requireApiKey, async (req, res) => {
  try {
    const thread = await db.get('SELECT * FROM agent_threads WHERE id = ?', [req.params.id]);
    if (!thread) return res.status(404).json({ error: 'Thread not found' });
    const messages = await db.all(
      'SELECT m.*, a.name as from_name FROM messages m LEFT JOIN agents a ON m.from_agent=a.id WHERE m.thread_id = ? ORDER BY m.created_at ASC LIMIT 200',
      [req.params.id]);
    res.json({ thread, messages });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Send message in thread ────────────────────────────────────
app.post('/api/threads/:id/messages', requireApiKey, async (req, res) => {
  try {
    const thread = await db.get('SELECT * FROM agent_threads WHERE id = ?', [req.params.id]);
    if (!thread) return res.status(404).json({ error: 'Thread not found' });
    const { from, to, content, intent, priority } = req.body;
    if (!from || !content) return res.status(400).json({ error: 'from and content required' });
    const fromAgent = await requireAgent(from, 'agent');
    const id = uuidv4();
    await db.run(`INSERT INTO messages (id,from_agent,to_agent,content,message_type,thread_id,intent,status,timeout_ms) VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, fromAgent.id, to||null, content, to?'direct':'broadcast', req.params.id, intent||'RESPONSE', 'delivered', priority?5000:300000]);
    await db.run('UPDATE agent_threads SET message_count=message_count+1, last_message_at=datetime("now"), updated_at=datetime("now") WHERE id=?', [req.params.id]);
    broadcast({ type: 'thread_message', threadId: req.params.id, messageId: id, from: fromAgent.id, fromName: fromAgent.name, content, intent: intent||'RESPONSE' });
    res.json({ success: true, id, threadId: req.params.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// v4.0: REACTIONS (semantic emoji)
// ═══════════════════════════════════════════════════════════════

// ─── Add reaction ──────────────────────────────────────────────
app.post('/api/messages/:id/reactions', requireApiKey, async (req, res) => {
  try {
    const { agentId, emoji } = req.body;
    if (!agentId || !emoji) return res.status(400).json({ error: 'agentId and emoji required' });
    const agent = await requireAgent(agentId, 'agent');
    const id = uuidv4(), semantic = REACTION_SEMANTICS[emoji] || 'CUSTOM';
    await db.run(`INSERT OR REPLACE INTO agent_reactions (id,message_id,agent_id,emoji,semantic) VALUES (?,?,?,?,?)`,
      [id, req.params.id, agent.id, emoji, semantic]);
    broadcast({ type: 'reaction_added', messageId: req.params.id, agentId: agent.id, emoji, semantic });
    res.json({ success: true, id, semantic });
  } catch (e) { res.status(e.statusCode||500).json({ error: e.message }); }
});

// ─── Get reactions ─────────────────────────────────────────────
app.get('/api/messages/:id/reactions', requireApiKey, async (req, res) => {
  try {
    const reactions = await db.all(
      `SELECT r.*, a.name as agent_name FROM agent_reactions r JOIN agents a ON r.agent_id=a.id WHERE r.message_id=?`, [req.params.id]);
    const semantics = {};
    reactions.forEach(r => { if (!semantics[r.semantic]) semantics[r.semantic]=[]; semantics[r.semantic].push(r.agent_name); });
    res.json({ reactions, semantics });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Remove reaction ───────────────────────────────────────────
app.delete('/api/messages/:id/reactions', requireApiKey, async (req, res) => {
  try {
    const { agentId, emoji } = req.body || {};
    if (!agentId) return res.status(400).json({ error: 'agentId required' });
    const agent = await requireAgent(agentId, 'agent');
    let result;
    if (emoji) {
      result = await db.run('DELETE FROM agent_reactions WHERE message_id=? AND agent_id=? AND emoji=?', [req.params.id, agent.id, emoji]);
    } else {
      result = await db.run('DELETE FROM agent_reactions WHERE message_id=? AND agent_id=?', [req.params.id, agent.id]);
    }
    const removed = result.changes || 0;
    if (removed === 0) return res.status(404).json({ error: 'Reaction not found' });
    const payload = { type: 'reaction_removed', messageId: req.params.id, agentId: agent.id };
    if (emoji) payload.emoji = emoji;
    broadcast(payload);
    res.json({ success: true, removed });
  } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// v4.0: GROUP ACTIVITY FEED
// ═══════════════════════════════════════════════════════════════

// ─── Log activity ──────────────────────────────────────────────
app.post('/api/groups/:groupId/activity', requireApiKey, async (req, res) => {
  try {
    const group = await requireGroup(req.params.groupId, 'group');
    const { actorId, action, targetType, targetId, metadata } = req.body;
    if (!action) return res.status(400).json({ error: 'action required' });
    const id = uuidv4();
    await db.run(`INSERT INTO agent_activity (id,group_id,actor_id,action,target_type,target_id,metadata) VALUES (?,?,?,?,?,?,?)`,
      [id, group.id, actorId||null, action, targetType||'', targetId||'', JSON.stringify(metadata||{})]);
    broadcast({ type: 'group_activity', groupId: group.id, action, actorId: actorId||null });
    res.json({ success: true, id });
  } catch (e) { res.status(e.statusCode||500).json({ error: e.message }); }
});

// ─── Get activity feed ─────────────────────────────────────────
app.get('/api/groups/:groupId/activity', requireApiKey, async (req, res) => {
  try {
    const group = await requireGroup(req.params.groupId, 'group');
    const { limit=50 } = req.query;
    const rows = await db.all(
      `SELECT aa.*, a.name as actor_name FROM agent_activity aa LEFT JOIN agents a ON aa.actor_id=a.id WHERE aa.group_id=? ORDER BY aa.created_at DESC LIMIT ?`,
      [group.id, Math.min(Number(limit),200)]);
    res.json(rows.map(r=>({...r, metadata: JSON.parse(r.metadata||'{}')})));
  } catch (e) { res.status(e.statusCode||500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// v4.0: AGENT SUBSCRIPTIONS
// ═══════════════════════════════════════════════════════════════

// ─── Subscribe to group ─────────────────────────────────────────
app.post('/api/groups/:groupId/subscribe', requireApiKey, async (req, res) => {
  try {
    const group = await requireGroup(req.params.groupId, 'group');
    const { agentId, notifyJoin, notifyLeave, notifyBroadcast, notifyTask, notifyMessage } = req.body;
    const agent = agentId ? await resolveAgent(agentId) : null;
    await db.run(`INSERT OR REPLACE INTO agent_subscriptions (agent_id,group_id,notify_join,notify_leave,notify_broadcast,notify_task,notify_message) VALUES (?,?,?,?,?,?,?)`,
      [agent?.id||agentId, group.id, notifyJoin??1, notifyLeave??1, notifyBroadcast??1, notifyTask??1, notifyMessage??1]);
    res.json({ success: true, subscribedTo: group.name });
  } catch (e) { res.status(e.statusCode||500).json({ error: e.message }); }
});

// ─── Get subscriptions ────────────────────────────────────────
app.get('/api/agents/:id/subscriptions', requireApiKey, async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT s.*, g.name as group_name FROM agent_subscriptions s JOIN agent_groups g ON s.group_id=g.id WHERE s.agent_id=?`, [req.params.id]);
    res.json(rows);
  } catch (e) { res.status(e.statusCode||500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// v4.0: TASK STATE TRACKING
// ═══════════════════════════════════════════════════════════════

// ─── Create task ───────────────────────────────────────────────
app.post('/api/tasks', requireApiKey, async (req, res) => {
  try {
    const { groupId, title, description, priority, ownerId, assignedId, dependsOn, context, createdBy } = req.body;
    const id = uuidv4();
    const owner = ownerId ? await resolveAgent(ownerId) : null;
    const assigned = assignedId ? await resolveAgent(assignedId) : null;
    const creator = createdBy ? await resolveAgent(createdBy) : null;
    await db.run(`INSERT INTO agent_tasks (id,group_id,title,description,state,priority,owner_id,assigned_id,depends_on,context,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [id, groupId||null, title||'', description||'', 'pending', priority||5, owner?.id||null, assigned?.id||null, JSON.stringify(dependsOn||[]), context||'', creator?.id||null]);
    if (groupId) broadcast({ type: 'task_created', taskId: id, title, groupId, assignedId: assigned?.id||assignedId, priority: priority||5 });
    res.json({ success: true, id, state: 'pending' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Update task state ─────────────────────────────────────────
app.patch('/api/tasks/:id', requireApiKey, async (req, res) => {
  try {
    const task = await db.get('SELECT * FROM agent_tasks WHERE id=?', [req.params.id]);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const { state, assignedId, result, priority } = req.body;
    const validStates = ['pending','in_progress','completed','failed','cancelled'];
    const updates = [], params = [];
    if (state && validStates.includes(state)) {
      updates.push('state=?'); params.push(state);
      if (state==='completed'||state==='failed') updates.push('completed_at=datetime("now")');
      if (state==='in_progress') updates.push('started_at=datetime("now")');
    }
    if (assignedId !== undefined) { const a = await resolveAgent(assignedId); updates.push('assigned_id=?'); params.push(a?.id||null); }
    if (priority !== undefined) { updates.push('priority=?'); params.push(priority); }
    if (result !== undefined) { updates.push('result=?'); params.push(result); }
    updates.push('updated_at=datetime("now")');
    params.push(req.params.id);
    await db.run(`UPDATE agent_tasks SET ${updates.join(', ')} WHERE id=?`, params);
    broadcast({ type: 'task_updated', taskId: req.params.id, state, assignedId: assignedId||task.assigned_id, result });
    res.json({ success: true, taskId: req.params.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Get tasks ─────────────────────────────────────────────────
app.get('/api/tasks', requireApiKey, async (req, res) => {
  try {
    const { groupId, state, assignedId, ownerId } = req.query;
    let sql = 'SELECT t.*, a.name as assigned_name, o.name as owner_name FROM agent_tasks t LEFT JOIN agents a ON t.assigned_id=a.id LEFT JOIN agents o ON t.owner_id=o.id WHERE 1=1';
    const params = [];
    if (groupId) { sql += ' AND t.group_id=?'; params.push(groupId); }
    if (state) { sql += ' AND t.state=?'; params.push(state); }
    if (assignedId) { sql += ' AND t.assigned_id=?'; params.push(assignedId); }
    if (ownerId) { sql += ' AND t.owner_id=?'; params.push(ownerId); }
    sql += ' ORDER BY t.priority DESC, t.created_at DESC LIMIT 100';
    const rows = await db.all(sql, params);
    res.json(rows.map(r=>({...r, depends_on: JSON.parse(r.depends_on||'[]')})));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Handoff task ─────────────────────────────────────────────
app.post('/api/tasks/:id/handoff', requireApiKey, async (req, res) => {
  try {
    const task = await db.get('SELECT * FROM agent_tasks WHERE id=?', [req.params.id]);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const { toAgentId, note } = req.body;
    const toAgent = await requireAgent(toAgentId, 'agent');
    await db.run('UPDATE agent_tasks SET assigned_id=?, state=?, updated_at=datetime("now") WHERE id=?', [toAgent.id, 'pending', req.params.id]);
    if (task.group_id) {
      await db.run(`INSERT INTO agent_activity (id,group_id,actor_id,action,target_type,target_id,metadata) VALUES (?,?,?,?,?,?,?)`,
        [uuidv4(), task.group_id, toAgent.id, 'TASK_HANDOFF', 'task', req.params.id, JSON.stringify({ note: note||'', previousAssigned: task.assigned_id })]);
    }
    broadcast({ type: 'task_handoff', taskId: req.params.id, from: task.assigned_id, to: toAgent.id, note });
    res.json({ success: true, taskId: req.params.id, handedTo: toAgent.name });
  } catch (e) { res.status(e.statusCode||500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// v4.0: SCHEDULED MESSAGES
// ═══════════════════════════════════════════════════════════════
// The scheduled-message routes live with the other message routes
// above (registered before GET /api/messages/:agentId, which would
// otherwise shadow GET /api/messages/scheduled).

// ═══════════════════════════════════════════════════════════════
// v4.0: CAPABILITY DIRECTORY + DECISIONS
// ═══════════════════════════════════════════════════════════════

// ─── Capability directory ──────────────────────────────────────
// Canonical implementation lives with the other capability routes above
// (GET /api/capabilities — directory grouped by capability incl. presence).
// The duplicate route that stood here was removed in v4.1.

// ─── Decision helpers ──────────────────────────────────────────
async function decisionTally(decisionId) {
  const rows = await db.all('SELECT vote, COUNT(*) as count FROM decision_votes WHERE decision_id=? GROUP BY vote', [decisionId]);
  const tally = { approve: 0, reject: 0, abstain: 0 };
  for (const row of rows) {
    if (Object.prototype.hasOwnProperty.call(tally, row.vote)) tally[row.vote] = row.count;
  }
  return tally;
}

async function normalizeDecision(row) {
  return {
    id: row.id,
    groupId: row.group_id,
    content: row.content,
    context: row.context,
    proposedBy: row.proposed_by,
    status: row.status,
    tally: await decisionTally(row.id),
    createdAt: row.created_at,
    closedAt: row.closed_at
  };
}

// ─── Log decision ──────────────────────────────────────────────
app.post('/api/decisions', requireApiKey, async (req, res) => {
  try {
    const { groupId, content, context, decidedBy } = req.body;
    if (!content) return res.status(400).json({ error: 'content required' });
    const id = uuidv4();
    if (groupId) {
      await db.run(`INSERT INTO agent_activity (id,group_id,actor_id,action,target_type,target_id,metadata) VALUES (?,?,?,?,?,?,?)`,
        [uuidv4(), groupId, decidedBy||null, 'DECISION', 'decision', id, JSON.stringify({ content, context: context||'' })]);
    }
    const proposer = decidedBy ? await resolveAgent(decidedBy) : null;
    await db.run(`INSERT INTO decisions (id,group_id,content,context,proposed_by,status) VALUES (?,?,?,?,?,?)`,
      [id, groupId||null, content, context||null, proposer?.id||decidedBy||null, 'open']);
    res.json({ success: true, id, decision: content, status: 'open' });
  } catch (e) { res.status(e.statusCode||500).json({ error: e.message }); }
});

// ─── Get decisions ─────────────────────────────────────────────
app.get('/api/decisions', requireApiKey, async (req, res) => {
  try {
    const { limit } = getPagination(req.query, 20, 200);
    const { groupId, status } = req.query;
    let sql = `SELECT * FROM decisions WHERE 1=1`;
    const params = [];
    if (groupId) { sql += ' AND group_id=?'; params.push(groupId); }
    if (status) { sql += ' AND status=?'; params.push(status); }
    sql += ' ORDER BY created_at DESC, rowid DESC LIMIT ?';
    params.push(limit);
    const rows = await db.all(sql, params);
    const decisions = [];
    for (const row of rows) decisions.push(await normalizeDecision(row));
    res.json(decisions);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Get single decision ───────────────────────────────────────
app.get('/api/decisions/:id', requireApiKey, async (req, res) => {
  try {
    const row = await db.get('SELECT * FROM decisions WHERE id=?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Decision not found' });
    const decision = await normalizeDecision(row);
    const voteRows = await db.all(
      `SELECT v.*, a.name as agent_name FROM decision_votes v LEFT JOIN agents a ON v.agent_id=a.id WHERE v.decision_id=? ORDER BY v.created_at ASC`, [req.params.id]);
    decision.votes = voteRows.map(v => ({ agentId: v.agent_id, agentName: v.agent_name || null, vote: v.vote, createdAt: v.created_at }));
    res.json(decision);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Vote on decision ──────────────────────────────────────────
app.post('/api/decisions/:id/vote', requireApiKey, async (req, res) => {
  try {
    const { agentId, vote } = req.body;
    if (!['approve', 'reject', 'abstain'].includes(vote)) return res.status(400).json({ error: 'vote must be approve, reject, or abstain' });
    const decision = await db.get('SELECT * FROM decisions WHERE id=?', [req.params.id]);
    if (!decision) return res.status(404).json({ error: 'Decision not found' });
    if (decision.status !== 'open') return res.status(409).json({ error: 'Decision is not open' });
    const agent = await requireAgent(agentId, 'agent');
    await db.run(`INSERT OR REPLACE INTO decision_votes (decision_id,agent_id,vote) VALUES (?,?,?)`,
      [req.params.id, agent.id, vote]);
    broadcast({ type: 'decision_vote', decisionId: req.params.id, agentId: agent.id, vote });
    res.json({ success: true, tally: await decisionTally(req.params.id) });
  } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
});

// ─── Close decision ────────────────────────────────────────────
app.patch('/api/decisions/:id', requireApiKey, async (req, res) => {
  try {
    const { status, decidedBy } = req.body || {};
    const decision = await db.get('SELECT * FROM decisions WHERE id=?', [req.params.id]);
    if (!decision) return res.status(404).json({ error: 'Decision not found' });
    if (status !== undefined && !['approved', 'rejected', 'closed'].includes(status)) {
      return res.status(400).json({ error: 'status must be approved, rejected, or closed' });
    }
    if (decision.status !== 'open') return res.status(409).json({ error: 'Decision is not open' });
    const tally = await decisionTally(req.params.id);
    let finalStatus = status;
    if (!finalStatus) {
      if (tally.approve > tally.reject) finalStatus = 'approved';
      else if (tally.reject > tally.approve) finalStatus = 'rejected';
      else finalStatus = 'closed';
    }
    await db.run(`UPDATE decisions SET status=?, closed_at=datetime('now') WHERE id=?`, [finalStatus, req.params.id]);
    if (decision.group_id) {
      const actor = decidedBy ? await resolveAgent(decidedBy) : null;
      await db.run(`INSERT INTO agent_activity (id,group_id,actor_id,action,target_type,target_id,metadata) VALUES (?,?,?,?,?,?,?)`,
        [uuidv4(), decision.group_id, actor?.id || decidedBy || null, 'DECISION', 'decision', req.params.id, JSON.stringify({ content: decision.content, outcome: finalStatus, tally })]);
    }
    broadcast({ type: 'decision_closed', decisionId: req.params.id, status: finalStatus });
    res.json({ success: true, id: req.params.id, status: finalStatus, tally });
  } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// v4.0: GROUP INVITATIONS
// ═══════════════════════════════════════════════════════════════

// ─── Request to join ────────────────────────────────────────────
app.post('/api/groups/:groupId/request', requireApiKey, async (req, res) => {
  try {
    const group = await requireGroup(req.params.groupId, 'group');
    const { agentId } = req.body;
    const agent = agentId ? await resolveAgent(agentId) : null;
    const id = uuidv4();
    await db.run(`INSERT OR IGNORE INTO agent_group_invitations (id,group_id,agent_id,status) VALUES (?,?,?,?)`,
      [id, group.id, agent?.id||agentId, 'pending']);
    broadcast({ type: 'group_join_request', groupId: group.id, groupName: group.name, agentId: agent?.id||agentId, agentName: agent?.name||agentId });
    res.json({ success: true, id, status: 'pending' });
  } catch (e) { res.status(e.statusCode||500).json({ error: e.message }); }
});

// ─── Approve/reject invitation ───────────────────────────────
app.patch('/api/groups/:groupId/request/:agentId', requireApiKey, async (req, res) => {
  try {
    const group = await requireGroup(req.params.groupId, 'group');
    const agent = await requireAgent(req.params.agentId, 'agent');
    const { status } = req.body;
    if (!['approved','rejected'].includes(status)) return res.status(400).json({ error: 'status must be approved or rejected' });
    await db.run('UPDATE agent_group_invitations SET status=?, responded_at=datetime("now") WHERE group_id=? AND agent_id=?',
      [status, group.id, agent.id]);
    if (status === 'approved') {
      await db.run('INSERT OR IGNORE INTO agent_group_members (group_id,agent_id,role) VALUES (?,?,?)', [group.id, agent.id, 'member']);
      broadcast({ type: 'group_member_joined', groupId: group.id, agentId: agent.id, agentName: agent.name });
    }
    broadcast({ type: 'group_invite_response', groupId: group.id, agentId: agent.id, status });
    res.json({ success: true, status });
  } catch (e) { res.status(e.statusCode||500).json({ error: e.message }); }
});

// ─── List pending invitations ──────────────────────────────────
app.get('/api/groups/:groupId/requests', requireApiKey, async (req, res) => {
  try {
    const group = await requireGroup(req.params.groupId, 'group');
    const rows = await db.all(
      `SELECT ri.*, a.name as agent_name FROM agent_group_invitations ri JOIN agents a ON ri.agent_id=a.id WHERE ri.group_id=? AND ri.status='pending'`,
      [group.id]);
    res.json(rows);
  } catch (e) { res.status(e.statusCode||500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// v4.0: META-AGENT ORCHESTRATION
// ═══════════════════════════════════════════════════════════════

// ─── Meta-agent orchestrate ────────────────────────────────────
app.post('/api/mesh/orchestrate', requireApiKey, async (req, res) => {
  try {
    const { action, payload, agentId } = req.body;
    switch (action) {
      case 'summarize_group': {
        const { groupId } = payload || {};
        if (!groupId) return res.status(400).json({ error: 'groupId required' });
        const msgs = await db.all(
          `SELECT m.content, m.created_at FROM messages m WHERE m.to_group=? ORDER BY m.created_at DESC LIMIT 50`,
          [groupId]);
        const summary = msgs.length ? `Last ${msgs.length} messages in group ${groupId}: ` + msgs.map(m=>m.content).join(' | ').slice(0,1000) : 'No recent messages';
        res.json({ success: true, action, summary, messageCount: msgs.length });
        break;
      }
      case 'route_task': {
        const { task, requires } = payload || {};
        const caps = requires ? requires.split(',').map(s=>s.trim()) : [];
        const routed = await db.all(
          `SELECT ap.agent_id, a.name, ap.state, ap.capabilities FROM agent_presence ap JOIN agents a ON ap.agent_id=a.id WHERE ap.state NOT IN ('offline','away') LIMIT 5`);
        const scored = routed.map(r => ({ ...r, capabilities: JSON.parse(r.capabilities||'[]') }))
          .map(r => ({ ...r, score: caps.filter(c=>r.capabilities.includes(c)).length + (r.state==='online'?5:0) }))
          .sort((a,b) => b.score - a.score);
        res.json({ success: true, action, candidates: scored.slice(0,3), totalCandidates: scored.length });
        break;
      }
      case 'mesh_status': {
        const agents = await db.get('SELECT COUNT(*) as c FROM agents');
        const groups = await db.get('SELECT COUNT(*) as c FROM agent_groups');
        const tasks = await db.all('SELECT state, COUNT(*) as c FROM agent_tasks GROUP BY state');
        const presence = await db.all('SELECT state, COUNT(*) as c FROM agent_presence GROUP BY state');
        res.json({ success: true, action, stats: { agents: agents.c, groups: groups.c, tasks, presence } });
        break;
      }
      default:
        res.status(400).json({ error: `Unknown action: ${action}. Valid: summarize_group, route_task, mesh_status` });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Basic health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'agent-mesh-api',
    version: APP_VERSION,
    websocketPath: '/ws',
    timestamp: new Date().toISOString()
  });
});

// === v4.3: READINESS ===
// Unauthenticated like /health, but checks real dependencies.
app.get('/ready', async (req, res) => {
  const checks = {};
  let ok = true;
  try {
    const row = await db.get('SELECT 1 as ok');
    checks.database = row?.ok === 1 ? 'ok' : 'fail';
    if (row?.ok !== 1) ok = false;
  } catch (e) {
    checks.database = `fail: ${e.message}`;
    ok = false;
  }
  try {
    // BEGIN IMMEDIATE takes the write lock without changing any data —
    // it proves the DB file is writable, then rolls straight back.
    await db.run('BEGIN IMMEDIATE');
    await db.run('ROLLBACK');
    checks.databaseWritable = 'ok';
  } catch (e) {
    checks.databaseWritable = `fail: ${e.message}`;
    ok = false;
  }
  const lagStart = Date.now();
  await new Promise(resolve => setImmediate(resolve));
  const lagMs = Date.now() - lagStart;
  checks.eventLoop = lagMs < 1000 ? 'ok' : `slow: ${lagMs}ms`;
  if (lagMs >= 1000) ok = false;
  res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'not_ready', checks, timestamp: new Date().toISOString() });
});

// === v4.3: ROUTE INVENTORY + OPENAPI 3.1 ===
// The spec is generated by walking the live Express router stack, so it can
// never drift from the routes the server actually registered.
function getRouteInventory() {
  const routes = [];
  const stack = (app.router || app._router)?.stack || [];
  const walk = (layers, prefix) => {
    for (const layer of layers) {
      if (layer.route) {
        for (const method of Object.keys(layer.route.methods)) {
          if (layer.route.methods[method]) routes.push({ method: method.toUpperCase(), path: prefix + layer.route.path });
        }
      } else if (layer.handle?.stack) {
        walk(layer.handle.stack, prefix);
      }
    }
  };
  walk(stack, '');
  const seen = new Set();
  return routes.filter(r => {
    const k = `${r.method} ${r.path}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function toOpenApiPath(p) {
  return p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function buildOpenApiSpec(req) {
  const base = `${req.protocol}://${req.get('host')}`;
  const paths = {};
  for (const { method, path } of getRouteInventory()) {
    const oaPath = toOpenApiPath(path);
    const params = [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map(m => ({
      name: m[1], in: 'path', required: true, schema: { type: 'string' }
    }));
    const secured = path.startsWith('/api') || path.startsWith('/a2a');
    const operation = {
      operationId: `${method.toLowerCase()}_${oaPath.replace(/[^A-Za-z0-9]+/g, '_')}`,
      summary: `${method} ${path}`,
      responses: {
        '200': { description: 'OK' },
        ...(secured ? { '401': { description: 'Invalid or missing API key' } } : {}),
        '429': { description: 'Rate limited' },
        '500': { description: 'Server error' }
      }
    };
    if (params.length) operation.parameters = params;
    if (secured) operation.security = [{ meshApiKey: [] }];
    if (['POST', 'PUT', 'PATCH'].includes(method)) {
      operation.requestBody = { content: { 'application/json': { schema: { type: 'object' } } } };
    }
    paths[oaPath] = paths[oaPath] || {};
    paths[oaPath][method.toLowerCase()] = operation;
  }
  return {
    openapi: '3.1.0',
    info: { title: 'Agent Mesh API', version: APP_VERSION, description: 'Agent-to-agent communication mesh: registry, messaging, groups, shared memory, decisions, tasks, plus an A2A 1.0 / 0.3 interface.' },
    servers: [{ url: base }],
    paths,
    components: {
      securitySchemes: {
        meshApiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' }
      }
    }
  };
}

app.get('/openapi.json', (req, res) => {
  res.json(buildOpenApiSpec(req));
});

// Key-gated route dump — used by the OpenAPI honesty test in test-v43.js
app.get('/api/debug/routes', requireApiKey, (req, res) => {
  const routes = getRouteInventory();
  res.json({ count: routes.length, routes });
});

// === v4.3: A2A (Agent2Agent) SURFACE ===
// Primary profile: A2A 1.0 (SendMessage / GetTask) at POST /a2a.
// Compatibility profile: A2A 0.3 (message/send / tasks/get) at POST /a2a/v0.3.
// Both are thin adapters over the same core (a2aDeliver + persisted tasks).
const A2A_SKILLS = [
  { id: 'agent-messaging', name: 'Agent messaging', description: 'Deliver a text message to a named registered agent (or broadcast to the whole mesh when no target is named) and return a completed A2A task.', tags: ['messaging', 'routing'], examples: ['Send "summarize the grow log" to Hermes'], inputModes: ['text/plain', 'application/json'], outputModes: ['text/plain', 'application/json'] },
  { id: 'group-broadcast', name: 'Group broadcast', description: 'Broadcast a message to every agent in the mesh or to the members of a group via the mesh broadcast endpoints.', tags: ['messaging', 'broadcast'], examples: ['Broadcast "standup in 5 minutes" to all agents'] },
  { id: 'shared-memory', name: 'Shared memory', description: 'Store and retrieve versioned key-value entries in a group\'s collective memory.', tags: ['memory', 'groups'], examples: ['Remember the deployment checklist for the ops group'] },
  { id: 'decision-voting', name: 'Decision voting', description: 'Propose decisions to a group and collect approve/reject/abstain votes with a derived outcome.', tags: ['decisions', 'voting'], examples: ['Propose shipping v4.3 today and open the vote'] },
  { id: 'agent-discovery', name: 'Agent discovery', description: 'List the agents registered in the mesh with their capabilities and presence.', tags: ['discovery', 'registry'], examples: ['Which agents are online?'] }
];

function buildAgentCard(req) {
  const base = `${req.protocol}://${req.get('host')}`;
  return {
    name: 'Agent Mesh',
    description: 'Registry, routing and messaging hub for local agents: discover agents, send messages, broadcast to groups, share memory and run decision votes.',
    supportedInterfaces: [
      { url: `${base}/a2a`, protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' },
      { url: `${base}/a2a/v0.3`, protocolBinding: 'HTTP+JSON', protocolVersion: '0.3' }
    ],
    provider: { organization: 'Agent Mesh', url: base },
    version: APP_VERSION,
    documentationUrl: `${base}/openapi.json`,
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    securitySchemes: {
      meshApiKey: { apiKeySecurityScheme: { description: 'Agent Mesh API key', location: 'header', name: 'X-API-Key' } }
    },
    securityRequirements: [{ schemes: { meshApiKey: { list: [] } } }],
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: A2A_SKILLS
  };
}

app.get('/.well-known/agent-card.json', (req, res) => {
  res.set('Cache-Control', 'max-age=300');
  res.json(buildAgentCard(req));
});

// Core delivery shared by both A2A profiles. Creates real mesh message rows
// (sender recorded as the gateway identity 'a2a-gateway') and broadcasts the
// same WebSocket events the REST message endpoints use.
async function a2aDeliver({ text, toAgentRef, messageId, contextId }) {
  const taskId = uuidv4();
  const ctx = contextId || uuidv4();
  const now = new Date().toISOString();
  const recipients = [];
  if (toAgentRef) {
    const target = await requireAgent(toAgentRef, 'target agent');
    const mid = uuidv4();
    await db.run(
      'INSERT INTO messages (id, from_agent, to_agent, content, message_type, timeout_ms) VALUES (?, ?, ?, ?, ?, ?)',
      [mid, 'a2a-gateway', target.id, text, 'direct', DEFAULT_MESSAGE_TIMEOUT_MS]
    );
    recipients.push({ id: target.id, name: target.name, messageId: mid });
    broadcast({ type: 'new_message', message: { id: mid, from: 'a2a-gateway', fromName: 'a2a-gateway', to: target.id, toName: target.name, content: text, messageType: 'direct', createdAt: now } });
  } else {
    const agents = await db.all('SELECT id, name FROM agents');
    for (const agent of agents) {
      const mid = uuidv4();
      await db.run(
        'INSERT INTO messages (id, from_agent, to_agent, content, message_type, timeout_ms) VALUES (?, ?, ?, ?, ?, ?)',
        [mid, 'a2a-gateway', agent.id, text, 'broadcast', DEFAULT_MESSAGE_TIMEOUT_MS]
      );
      recipients.push({ id: agent.id, name: agent.name, messageId: mid });
    }
    broadcast({ type: 'broadcast', from: 'a2a-gateway', fromName: 'a2a-gateway', content: text, recipientCount: recipients.length });
  }
  const task = {
    id: taskId,
    contextId: ctx,
    status: { state: 'TASK_STATE_COMPLETED', timestamp: now },
    history: [{
      messageId: messageId || uuidv4(),
      role: 'ROLE_USER',
      parts: [{ text, mediaType: 'text/plain' }],
      ...(toAgentRef ? { metadata: { toAgent: toAgentRef } } : {})
    }],
    artifacts: [{
      artifactId: uuidv4(),
      name: 'delivery',
      parts: [{ text: recipients.length ? `Delivered to ${recipients.map(r => r.name).join(', ')}` : 'Delivered (no registered recipients)', mediaType: 'text/plain' }],
      metadata: { recipients }
    }],
    metadata: { messageIds: recipients.map(r => r.messageId) }
  };
  await db.run(
    'INSERT INTO a2a_tasks (id, context_id, state, task_json) VALUES (?, ?, ?, ?)',
    [task.id, task.contextId, task.status.state, JSON.stringify(task)]
  );
  return task;
}

async function a2aGetTask(id) {
  const row = await db.get('SELECT task_json FROM a2a_tasks WHERE id = ?', [id]);
  return row ? JSON.parse(row.task_json) : null;
}

function a2aTaskTo03(task) {
  const convPart = p => (typeof p.text === 'string' ? { kind: 'text', text: p.text } : { kind: 'data', data: p.data ?? null });
  return {
    id: task.id,
    contextId: task.contextId,
    status: { state: 'completed', timestamp: task.status?.timestamp },
    history: (task.history || []).map(m => ({
      messageId: m.messageId,
      role: 'user',
      parts: (m.parts || []).map(convPart),
      ...(m.metadata ? { metadata: m.metadata } : {}),
      kind: 'message'
    })),
    artifacts: (task.artifacts || []).map(a => ({
      artifactId: a.artifactId,
      name: a.name,
      parts: (a.parts || []).map(convPart)
    })),
    kind: 'task'
  };
}

function rpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id: id ?? null, error: data ? { code, message, data } : { code, message } };
}

function extractA2aTextAndTarget(params, profile) {
  const message = params?.message;
  if (!message || !Array.isArray(message.parts)) return { error: 'params.message with a parts array is required' };
  let text = null;
  for (const part of message.parts) {
    if (typeof part?.text === 'string') { text = part.text; break; }
  }
  if (!text) return { error: 'a text part is required' };
  const toAgent = message.metadata?.toAgent || params.configuration?.toAgent || params.metadata?.toAgent || null;
  return { text, toAgent, messageId: message.messageId || null, contextId: message.contextId || null };
}

app.post('/a2a', requireApiKey, async (req, res) => {
  const { id, method, params } = req.body || {};
  try {
    if (!method) return res.json(rpcError(id, -32600, 'Invalid Request: method is required'));
    if (method === 'SendMessage') {
      const parsed = extractA2aTextAndTarget(params, '1.0');
      if (parsed.error) return res.json(rpcError(id, -32602, parsed.error));
      let task;
      try {
        task = await a2aDeliver(parsed);
      } catch (e) {
        if (e.statusCode === 404) return res.json(rpcError(id, -32602, e.message));
        throw e;
      }
      return res.json({ jsonrpc: '2.0', id: id ?? null, result: { task } });
    }
    if (method === 'GetTask') {
      const taskId = params?.id;
      if (!taskId) return res.json(rpcError(id, -32602, 'params.id is required'));
      const task = await a2aGetTask(taskId);
      if (!task) return res.json(rpcError(id, -32001, 'Task not found', [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'TASK_NOT_FOUND' }]));
      return res.json({ jsonrpc: '2.0', id: id ?? null, result: { task } });
    }
    return res.json(rpcError(id, -32601, `Method not found: ${method}`));
  } catch (error) {
    console.error('[A2A] Error:', error);
    return res.json(rpcError(id, -32603, error.message));
  }
});

app.post('/a2a/v0.3', requireApiKey, async (req, res) => {
  const { id, method, params } = req.body || {};
  try {
    if (!method) return res.json(rpcError(id, -32600, 'Invalid Request: method is required'));
    if (method === 'message/send') {
      const parsed = extractA2aTextAndTarget(params, '0.3');
      if (parsed.error) return res.json(rpcError(id, -32602, parsed.error));
      let task;
      try {
        task = await a2aDeliver(parsed);
      } catch (e) {
        if (e.statusCode === 404) return res.json(rpcError(id, -32602, e.message));
        throw e;
      }
      return res.json({ jsonrpc: '2.0', id: id ?? null, result: a2aTaskTo03(task) });
    }
    if (method === 'tasks/get') {
      const taskId = params?.id;
      if (!taskId) return res.json(rpcError(id, -32602, 'params.id is required'));
      const task = await a2aGetTask(taskId);
      if (!task) return res.json(rpcError(id, -32001, 'Task not found'));
      return res.json({ jsonrpc: '2.0', id: id ?? null, result: a2aTaskTo03(task) });
    }
    return res.json(rpcError(id, -32601, `Method not found: ${method}`));
  } catch (error) {
    console.error('[A2A] Error:', error);
    return res.json(rpcError(id, -32603, error.message));
  }
});

// OpenClaw-friendly health summary alias
app.get('/api/health', requireApiKey, async (req, res) => {
  try {
    const dashboard = await db.get(`
      SELECT
        (SELECT COUNT(*) FROM agents) as totalAgents,
        (SELECT COUNT(*) FROM agent_health_status WHERE status = 'healthy') as healthy,
        (SELECT COUNT(*) FROM agent_health_status WHERE status = 'degraded') as degraded,
        (SELECT COUNT(*) FROM agent_health_status WHERE status = 'unhealthy') as unhealthy,
        (SELECT COUNT(*) FROM catastrophe_events WHERE status = 'active') as activeCatastrophes
    `);

    res.json({
      status: 'ok',
      service: 'agent-mesh-api',
      version: APP_VERSION,
      totalAgents: dashboard.totalAgents || 0,
      healthy: dashboard.healthy || 0,
      degraded: dashboard.degraded || 0,
      unhealthy: dashboard.unhealthy || 0,
      activeCatastrophes: dashboard.activeCatastrophes || 0,
      websocketClients: clients.size,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// OpenClaw compatibility descriptor
app.get('/api/openclaw/compat', requireApiKey, (req, res) => {
  res.json({
    service: 'agent-mesh-api',
    version: APP_VERSION,
    compatibility: {
      openclaw: true,
      transport: ['rest', 'websocket', 'mcp-via-sidecar'],
      supportsAgentNames: true,
      supportsAgentIds: true,
      healthEndpoint: '/api/health',
      statsEndpoint: '/api/stats',
      websocketEndpoint: `/ws`
    }
  });
});


// === PHANTOM / RETICULUM BRIDGE ===

// Seed a file on Reticulum mesh
app.post('/api/phantom/seed', requireApiKey, async (req, res) => {
  try {
    const { filepath } = req.body;
    if (!filepath) return res.status(400).json({ error: 'filepath is required' });
    
    const result = await phantomSeed(filepath);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Download a file from Reticulum mesh
app.post('/api/phantom/download', requireApiKey, async (req, res) => {
  try {
    const { ghostFile, outputDir } = req.body;
    if (!ghostFile) return res.status(400).json({ error: 'ghostFile is required' });
    
    const result = await phantomDownload(ghostFile, outputDir);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get Phantom node identity
app.get('/api/phantom/identity', requireApiKey, async (req, res) => {
  try {
    const result = await phantomIdentity();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get Phantom/Reticulum status
app.get('/api/phantom/status', requireApiKey, async (req, res) => {
  try {
    const result = await phantomStatus();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Seed all files in a directory
app.post('/api/phantom/seed-all', requireApiKey, async (req, res) => {
  try {
    const { dirPath } = req.body;
    if (!dirPath) return res.status(400).json({ error: 'dirPath is required' });
    
    const result = await phantomSeedAll(dirPath);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get ghost file info
app.get('/api/phantom/info', requireApiKey, async (req, res) => {
  try {
    const { ghostFile } = req.query;
    if (!ghostFile) return res.status(400).json({ error: 'ghostFile query param is required' });
    
    const result = await phantomInfo(ghostFile);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// v4.3: final error handler — errors are always JSON-logged (unless logging is
// off) and answered with the standard {error} JSON shape instead of Express's
// default HTML error page.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (LOG_FORMAT !== 'off') logJson('error', { type: 'error', reqId: req.requestId, method: req.method, path: req.originalUrl, status: err.status || err.statusCode || 500, error: err.message });
  if (!res.headersSent) res.status(err.status || err.statusCode || 500).json({ error: err.message });
});

// === WEBSOCKET ===

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const clients = new Map();

function broadcast(data) {
  const message = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(message);
    }
  });
}

wss.on('connection', (ws, req) => {
  const clientId = uuidv4();
  console.log(`[WS] Client connected: ${clientId}`);
  
  clients.set(clientId, ws);
  
  ws.send(JSON.stringify({
    type: 'connected',
    clientId,
    message: 'Connected to Agent Mesh'
  }));
  
  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      
      if (msg.type === 'register_agent') {
        // Handle WebSocket agent registration
        ws.agentId = msg.agentId;
        console.log(`[WS] Agent registered: ${msg.agentId}`);
      }
      
      if (msg.type === 'heartbeat') {
        // Update agent last_seen
        if (ws.agentId) {
          await db.run(
            'UPDATE agents SET last_seen = CURRENT_TIMESTAMP WHERE id = ?',
            ws.agentId
          );
        }
      }
    } catch (error) {
      console.error('[WS] Error handling message:', error);
    }
  });
  
  ws.on('close', () => {
    console.log(`[WS] Client disconnected: ${clientId}`);
    clients.delete(clientId);
  });
});

// Start server
async function start() {
  await initDb();

  if (USING_DEFAULT_API_KEY) {
    console.warn('╔══════════════════════════════════════════════════════════╗');
    console.warn('║  ⚠️  WARNING: using the DEFAULT API key                  ║');
    console.warn('║  "openclaw-mesh-default-key" is public and known to      ║');
    console.warn('║  anyone who has read this repo. Set AGENT_MESH_API_KEY   ║');
    console.warn('║  to your own secret before any real deployment.          ║');
    console.warn('╚══════════════════════════════════════════════════════════╝');
  }

  server.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║  Agent Mesh API Server                                   ║
║  Agent-to-Agent Communication for OpenClaw               ║
╠══════════════════════════════════════════════════════════╣
║  HTTP:  http://localhost:${PORT}                         ║
║  WS:    ws://localhost:${PORT}/ws                        ║
╠══════════════════════════════════════════════════════════╣
║  Core Endpoints:                                         ║
║    POST /api/agents/register   - Register agent          ║
║    GET  /api/agents            - List agents             ║
║    POST /api/messages          - Send message            ║
║    GET  /api/messages/:id      - Get messages            ║
║    POST /api/broadcast         - Broadcast to all        ║
╠══════════════════════════════════════════════════════════╣
║  Agent Groups:                                           ║
║    POST   /api/groups                      - Create group ║
║    GET    /api/groups                      - List groups  ║
║    GET    /api/groups/:id                  - Get group    ║
║    POST   /api/groups/:id/members          - Add member   ║
║    DELETE /api/groups/:id/members/:agentId - Remove      ║
║    GET    /api/agents/:id/groups           - Agent groups ║
║    GET    /api/groups/:id/agents           - List members ║
║    POST   /api/groups/:id/broadcast        - Group msg    ║
╠══════════════════════════════════════════════════════════╣
║  Collective Memory:                                      ║
║    POST    /api/groups/:id/memory          - Store       ║
║    GET     /api/groups/:id/memory          - Get all     ║
║    GET     /api/groups/:id/memory/:key     - Get key     ║
║    DELETE  /api/groups/:id/memory/:key     - Delete      ║
║    GET     /api/groups/:id/memory/:key/history - History║
╠══════════════════════════════════════════════════════════╣
║  Error Handling:                                         ║
║    PATCH  /api/messages/:id/status        - Update stat  ║
║    GET    /api/messages/:id/failed        - Failed msgs  ║
║    POST   /api/messages/:id/retry         - Retry msg    ║
╠══════════════════════════════════════════════════════════╣
║  Skills:                                                 ║
║    POST /api/skills            - Register skill          ║
║    GET  /api/skills            - Discover skills         ║
║    POST /api/skills/:id/invoke - Invoke skill            ║
╠══════════════════════════════════════════════════════════╣
║  Reticulum Phantom (optional - requires rns):          ║
║    POST /api/phantom/seed         - Seed file on mesh   ║
║    POST /api/phantom/download   - Download via mesh   ║
║    GET  /api/phantom/status     - Reticulum status     ║
║    GET  /api/phantom/identity  - Node identity        ║
║    POST /api/phantom/seed-all  - Seed directory       ║
║    GET  /api/phantom/info      - Ghost file metadata  ║
╚══════════════════════════════════════════════════════════╝
    `);
  });
}

start().catch(console.error);
