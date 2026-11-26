#!/usr/bin/env node
/**
 * Agent Mesh API — v4.3.0 test suite
 *
 * Covers: hashed API keys + legacy plaintext migration, rate limiting,
 * /ready, OpenAPI 3.1 honesty, security headers, X-Request-Id, the A2A 1.0
 * interface (POST /a2a) and the A2A 0.3 compatibility profile (POST /a2a/v0.3),
 * and the Agent Card.
 *
 * REQUIRED BOOT ENV (the gate script boots a dedicated instance for this file):
 *   PORT=4343 AGENT_MESH_DB_PATH=/tmp/mesh-v43.db \
 *   AGENT_MESH_RATE_LIMIT_MAX=20 AGENT_MESH_RATE_LIMIT_WINDOW_MS=60000 \
 *   node server.js
 *
 * Run:
 *   API_URL=http://localhost:4343 AGENT_MESH_DB_PATH=/tmp/mesh-v43.db node test-v43.js
 *
 * AGENT_MESH_DB_PATH must point at the SAME database file the server uses —
 * the key-storage tests inspect it directly. The low rate-limit max (20) is
 * per key+IP: this suite keeps its main-key /api request count well under 20
 * and gives the rate-limit burst its own freshly created key bucket.
 */
import crypto from 'crypto';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

const API_KEY = process.env.AGENT_MESH_API_KEY || 'openclaw-mesh-default-key';
const BASE_URL = process.env.API_URL || 'http://localhost:4000';
const DB_PATH = process.env.AGENT_MESH_DB_PATH;

const headers = { 'Content-Type': 'application/json', 'X-API-Key': API_KEY };
const sha256 = v => crypto.createHash('sha256').update(String(v), 'utf8').digest('hex');

let passed = 0, failed = 0;
async function test(name, fn) {
  try {
    console.log(`\n▶ ${name}`);
    await fn();
    console.log(`✓ ${name} - PASSED`);
    passed++;
  } catch (e) {
    console.error(`✗ ${name} - FAILED:`, e.message);
    failed++;
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function req(method, path, { key, body, extraHeaders } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(key ? { 'X-API-Key': key } : {}), ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* leave null */ }
  return { status: res.status, headers: res.headers, json, text };
}
const get = (path, opts) => req('GET', path, opts);
const post = (path, body, opts = {}) => req('POST', path, { ...opts, body });

async function openDb() {
  assert(DB_PATH, 'AGENT_MESH_DB_PATH env is required (must match the server boot env)');
  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await db.run('PRAGMA busy_timeout = 5000');
  return db;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Agent Mesh API — v4.3.0 Test Suite');
  console.log('═══════════════════════════════════════════════════════════');

  // (c) /ready
  await test('GET /ready returns 200 ready shape', async () => {
    const r = await get('/ready');
    assert(r.status === 200, `expected 200, got ${r.status}: ${r.text}`);
    assert(r.json.status === 'ready', `status should be ready, got ${r.json.status}`);
    assert(r.json.checks?.database === 'ok', `database check: ${JSON.stringify(r.json.checks)}`);
    assert(r.json.checks?.databaseWritable === 'ok', `writable check: ${JSON.stringify(r.json.checks)}`);
  });

  // (h) security headers + (i) request id
  await test('Security headers + X-Request-Id present', async () => {
    const r = await get('/health');
    assert(r.headers.get('x-content-type-options') === 'nosniff', 'missing nosniff');
    assert(r.headers.get('x-frame-options') === 'DENY', 'missing X-Frame-Options DENY');
    assert(r.headers.get('referrer-policy') === 'no-referrer', 'missing Referrer-Policy');
    const csp = r.headers.get('content-security-policy') || '';
    assert(csp.includes("default-src 'self'"), `CSP missing default-src 'self': ${csp}`);
    assert(r.headers.get('x-request-id'), 'missing X-Request-Id');
    const echo = await get('/health', { extraHeaders: { 'X-Request-Id': 'v43-probe-123' } });
    assert(echo.headers.get('x-request-id') === 'v43-probe-123', 'X-Request-Id not propagated');
  });

  // (e) agent card
  await test('Agent Card shape (A2A 1.0)', async () => {
    const r = await get('/.well-known/agent-card.json');
    assert(r.status === 200, `expected 200, got ${r.status}`);
    assert(Array.isArray(r.json.supportedInterfaces) && r.json.supportedInterfaces.length >= 2, 'supportedInterfaces missing');
    const v1 = r.json.supportedInterfaces.find(i => i.protocolVersion === '1.0');
    const v03 = r.json.supportedInterfaces.find(i => i.protocolVersion === '0.3');
    assert(v1 && v1.url.endsWith('/a2a'), `1.0 interface wrong: ${JSON.stringify(v1)}`);
    assert(v03 && v03.url.endsWith('/a2a/v0.3'), `0.3 interface wrong: ${JSON.stringify(v03)}`);
    assert(r.json.capabilities?.streaming === false, 'capabilities.streaming must be false');
    assert(Array.isArray(r.json.skills) && r.json.skills.length >= 3, 'skills missing');
    assert(r.json.defaultInputModes?.includes('text/plain'), 'defaultInputModes missing text/plain');
    assert(r.json.securityRequirements, 'securityRequirements missing');
  });

  // (a1) legacy plaintext key migrates
  await test('Legacy plaintext key authenticates and is upgraded to a hash', async () => {
    const legacyKey = 'legacy-plain-key-v43';
    const db = await openDb();
    await db.run('DELETE FROM agent_api_keys WHERE key_value = ? OR key_hash = ?', [legacyKey, sha256(legacyKey)]);
    await db.run(
      "INSERT INTO agent_api_keys (id, name, key_hash, key_value, key_prefix) VALUES (?, 'legacy-test', NULL, ?, ?)",
      ['v43-legacy-row', legacyKey, legacyKey.slice(0, 8)]
    );
    await db.close();
    const r = await get('/api/agents', { key: legacyKey });
    assert(r.status === 200, `legacy key should authenticate, got ${r.status}: ${r.text}`);
    const db2 = await openDb();
    const row = await db2.get('SELECT * FROM agent_api_keys WHERE id = ?', ['v43-legacy-row']);
    await db2.close();
    assert(!row.key_value, `plaintext should be nulled after upgrade, still: ${row.key_value}`);
    assert(row.key_hash === sha256(legacyKey), `stored hash mismatch: ${row.key_hash}`);
  });

  // (a2) newly created key stored hashed only
  let createdKey = null;
  await test('Newly created API key is stored hashed only and authenticates', async () => {
    const r = await post('/api/keys', { name: 'v43-created' }, { key: API_KEY });
    assert(r.status === 200 && r.json.apiKey, `create failed: ${r.status} ${r.text}`);
    createdKey = r.json.apiKey;
    const db = await openDb();
    const row = await db.get('SELECT * FROM agent_api_keys WHERE id = ?', [r.json.id]);
    await db.close();
    assert(row, 'created key row missing from DB');
    assert(!row.key_value, 'new key must not store plaintext');
    assert(row.key_hash === sha256(createdKey), 'stored value is not sha256(key)');
    assert(row.key_hash !== createdKey, 'stored value equals plaintext!');
    const auth = await get('/api/agents', { key: createdKey });
    assert(auth.status === 200, `new key should authenticate, got ${auth.status}`);
  });

  // (d) OpenAPI honesty: every registered route appears in the spec
  await test('OpenAPI 3.1 spec covers every registered route', async () => {
    const spec = await get('/openapi.json');
    assert(spec.status === 200, `expected 200, got ${spec.status}`);
    assert(String(spec.json.openapi).startsWith('3.1'), `openapi version: ${spec.json.openapi}`);
    const dump = await get('/api/debug/routes', { key: API_KEY });
    assert(dump.status === 200 && Array.isArray(dump.json.routes), `route dump failed: ${dump.status}`);
    const specPaths = spec.json.paths || {};
    const missing = [];
    for (const route of dump.json.routes) {
      const oaPath = route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
      if (!specPaths[oaPath]?.[route.method.toLowerCase()]) missing.push(`${route.method} ${route.path}`);
    }
    assert(missing.length === 0, `routes missing from spec: ${missing.join(', ')}`);
    console.log(`  → ${dump.json.routes.length} registered routes, all present in spec (${Object.keys(specPaths).length} paths)`);
  });

  // Register an A2A target agent
  let targetId = null;
  await test('Register A2A target agent', async () => {
    const r = await post('/api/agents/register', { name: 'A2ATarget43', capabilities: ['messaging'] }, { key: API_KEY });
    assert(r.status === 200 && r.json.agentId, `register failed: ${r.status} ${r.text}`);
    targetId = r.json.agentId;
  });

  // (f) A2A 1.0 round-trip
  let taskId = null;
  await test('A2A 1.0 SendMessage → completed task, message delivered', async () => {
    const r = await post('/a2a', {
      jsonrpc: '2.0', id: 'v43-1', method: 'SendMessage',
      params: { message: { messageId: crypto.randomUUID(), role: 'ROLE_USER', parts: [{ text: 'hello from a2a 1.0', mediaType: 'text/plain' }], metadata: { toAgent: 'A2ATarget43' } } }
    }, { key: API_KEY });
    assert(r.status === 200, `HTTP ${r.status}: ${r.text}`);
    assert(!r.json.error, `JSON-RPC error: ${JSON.stringify(r.json.error)}`);
    const task = r.json.result?.task;
    assert(task?.id, `no task in result: ${r.text}`);
    assert(task.status?.state === 'TASK_STATE_COMPLETED', `state: ${task.status?.state}`);
    taskId = task.id;
    const inbox = await get(`/api/messages/${targetId}`, { key: API_KEY });
    assert(inbox.status === 200 && JSON.stringify(inbox.json).includes('hello from a2a 1.0'), 'message not in target inbox');
  });

  await test('A2A 1.0 GetTask returns same task; unknown id + method errors', async () => {
    const r = await post('/a2a', { jsonrpc: '2.0', id: 'v43-2', method: 'GetTask', params: { id: taskId } }, { key: API_KEY });
    assert(r.json.result?.task?.id === taskId, `GetTask mismatch: ${r.text}`);
    const missing = await post('/a2a', { jsonrpc: '2.0', id: 'v43-3', method: 'GetTask', params: { id: 'no-such-task' } }, { key: API_KEY });
    assert(missing.json.error?.code === -32001, `expected -32001, got ${JSON.stringify(missing.json.error)}`);
    const bad = await post('/a2a', { jsonrpc: '2.0', id: 'v43-4', method: 'NoSuchMethod', params: {} }, { key: API_KEY });
    assert(bad.json.error?.code === -32601, `expected -32601, got ${JSON.stringify(bad.json.error)}`);
    const unauth = await post('/a2a', { jsonrpc: '2.0', id: 'v43-5', method: 'GetTask', params: { id: taskId } });
    assert(unauth.status === 401, `expected 401 without key, got ${unauth.status}`);
  });

  // (g) A2A 0.3 round-trip
  await test('A2A 0.3 message/send + tasks/get round-trip', async () => {
    const r = await post('/a2a/v0.3', {
      jsonrpc: '2.0', id: 'v43-6', method: 'message/send',
      params: { message: { messageId: crypto.randomUUID(), role: 'user', kind: 'message', parts: [{ kind: 'text', text: 'hello from a2a 0.3' }], metadata: { toAgent: 'A2ATarget43' } } }
    }, { key: API_KEY });
    assert(!r.json.error, `JSON-RPC error: ${JSON.stringify(r.json.error)}`);
    const task = r.json.result;
    assert(task?.kind === 'task', `0.3 result should be a task object: ${r.text}`);
    assert(task.status?.state === 'completed', `0.3 state: ${task.status?.state}`);
    assert(task.history?.[0]?.parts?.[0]?.kind === 'text', '0.3 parts should use kind');
    const got = await post('/a2a/v0.3', { jsonrpc: '2.0', id: 'v43-7', method: 'tasks/get', params: { id: task.id } }, { key: API_KEY });
    assert(got.json.result?.id === task.id, `tasks/get mismatch: ${got.text}`);
    assert(got.json.result?.status?.state === 'completed', 'tasks/get state not completed');
  });

  // (b) rate limiting — burst with its OWN key bucket (limit is 20 per boot env)
  await test('Rate limit: burst past limit returns 429 with Retry-After', async () => {
    const created = await post('/api/keys', { name: 'v43-ratelimit' }, { key: API_KEY });
    assert(created.status === 200 && created.json.apiKey, `key create failed: ${created.text}`);
    const burstKey = created.json.apiKey;
    let saw429 = null, okCount = 0;
    for (let i = 0; i < 30; i++) {
      const r = await get('/api/agents', { key: burstKey });
      if (r.status === 200) okCount++;
      if (r.status === 429) { saw429 = r; break; }
    }
    assert(okCount >= 1, 'first burst requests should succeed');
    assert(saw429, 'no 429 in 30-request burst against limit=20');
    assert(saw429.headers.get('retry-after'), '429 missing Retry-After header');
    console.log(`  → ${okCount} OK before first 429 (Retry-After: ${saw429.headers.get('retry-after')}s)`);
  });

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(`  Test Results: ${passed}/${passed + failed} passed`);
  console.log(failed === 0 ? '  ✓ All v4.3 tests passed!' : `  ✗ ${failed} test(s) failed`);
  console.log('═══════════════════════════════════════════════════════════\n');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error('✗ Suite error:', e); process.exit(1); });
