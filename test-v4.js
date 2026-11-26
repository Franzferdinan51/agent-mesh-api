#!/usr/bin/env node
/**
 * API Test Script — v4 surface
 * Tests the v4.0/v4.1 HTTP surface not covered by test-api.js:
 * tasks, threads, reactions, presence, subscriptions, decisions,
 * group join requests, scheduled-message delivery, the merged
 * capabilities directory, updates payload round-trip, and the
 * utils/mesh-client.js GET-params smoke test.
 *
 * Style matches test-api.js: plain Node script, API_URL env selects
 * the base URL, pass/fail counting, nonzero exit on failure.
 * Self-contained: registers fresh agents with unique names per run.
 */

import { createClient } from './utils/mesh-client.js';

const API_KEY = process.env.AGENT_MESH_API_KEY || 'openclaw-mesh-default-key';
const BASE_URL = process.env.API_URL || 'http://localhost:4000';

// Test with both X-API-Key header (primary) and Authorization Bearer (fallback)
const headers = {
  'Content-Type': 'application/json',
  'X-API-Key': API_KEY,
  'Authorization': `Bearer ${API_KEY}` // Also include Bearer token for testing
};

// Unique per run so the suite is deterministic against any scratch DB
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const NAME_A = `V4AgentA-${RUN}`;
const NAME_B = `V4AgentB-${RUN}`;
const NAME_C = `V4AgentC-${RUN}`;
const UNIQUE_CAP = `v4-cap-${RUN}`;

let agentA, agentB, agentC;
let taskId, threadId, groupId, directMessageId, scheduledId, decisionId;
let gapNotes = [];

async function test(name, fn) {
  try {
    console.log(`\n▶ ${name}`);
    await fn();
    console.log(`✓ ${name} - PASSED`);
    return true;
  } catch (error) {
    console.error(`✗ ${name} - FAILED:`, error.message);
    return false;
  }
}

async function get(path) {
  const res = await fetch(`${BASE_URL}${path}`, { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res.json();
}

async function post(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res.json();
}

async function patch(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res.json();
}

async function del(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'DELETE',
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res.json();
}

// Raw request that never throws on HTTP status — for probing unsupported ops
async function raw(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* HTML error pages etc. */ }
  return { status: res.status, json, text };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runTests() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Agent Mesh API - v4 Surface Test Suite');
  console.log('═══════════════════════════════════════════════════════════');

  const results = [];

  // Health check
  results.push(await test('Health check', async () => {
    const health = await get('/health');
    if (health.status !== 'ok') throw new Error('Health check failed');
  }));

  // Register fresh agents (unique names per run)
  results.push(await test('Register Agent A (unique capability)', async () => {
    const agent = await post('/api/agents/register', {
      name: NAME_A,
      endpoint: 'http://localhost:3101',
      capabilities: [UNIQUE_CAP, 'v4-testing']
    });
    agentA = agent.agentId;
    if (!agentA) throw new Error('No agentId returned');
    console.log(`  → Agent A ID: ${agentA}`);
  }));

  results.push(await test('Register Agent B', async () => {
    const agent = await post('/api/agents/register', {
      name: NAME_B,
      endpoint: 'http://localhost:3102',
      capabilities: ['v4-testing']
    });
    agentB = agent.agentId;
    if (!agentB) throw new Error('No agentId returned');
    console.log(`  → Agent B ID: ${agentB}`);
  }));

  results.push(await test('Register Agent C (join requester)', async () => {
    const agent = await post('/api/agents/register', {
      name: NAME_C,
      endpoint: 'http://localhost:3103',
      capabilities: ['v4-testing']
    });
    agentC = agent.agentId;
    if (!agentC) throw new Error('No agentId returned');
    console.log(`  → Agent C ID: ${agentC}`);
  }));

  // ─── 1. Tasks ────────────────────────────────────────────────
  // Real API: POST /api/tasks {title, description, priority, ownerId,
  // assignedId, groupId, ...} → {success, id, state:'pending'}.
  // There is no dedicated claim endpoint: claiming is
  // PATCH /api/tasks/:id {state:'in_progress', assignedId}, and
  // completion is PATCH {state:'completed', result}.

  results.push(await test('Tasks: create task', async () => {
    const task = await post('/api/tasks', {
      title: `V4 task ${RUN}`,
      description: 'Created by test-v4.js',
      priority: 7,
      ownerId: agentA
    });
    taskId = task.id;
    if (!taskId) throw new Error('No task id returned');
    if (task.state !== 'pending') throw new Error(`Expected state pending, got ${task.state}`);
    console.log(`  → Task ID: ${taskId}`);
  }));

  results.push(await test('Tasks: list with state filter', async () => {
    const pending = await get('/api/tasks?state=pending');
    if (!Array.isArray(pending)) throw new Error('Expected array of tasks');
    if (!pending.some((t) => t.id === taskId)) throw new Error('New task missing from state=pending list');
    const completed = await get('/api/tasks?state=completed');
    if (completed.some((t) => t.id === taskId)) throw new Error('Pending task leaked into state=completed list');
    console.log(`  → ${pending.length} pending task(s), filter respected`);
  }));

  results.push(await test('Tasks: claim/assign via PATCH (in_progress + assignedId)', async () => {
    const res = await patch(`/api/tasks/${taskId}`, { state: 'in_progress', assignedId: agentB });
    if (!res.success) throw new Error('PATCH did not return success');
    const mine = await get(`/api/tasks?state=in_progress&assignedId=${agentB}`);
    const task = mine.find((t) => t.id === taskId);
    if (!task) throw new Error('Task not found under in_progress + assignedId=B filter');
    if (task.assigned_id !== agentB) throw new Error(`assigned_id mismatch: ${task.assigned_id}`);
  }));

  results.push(await test('Tasks: complete via PATCH with result', async () => {
    const res = await patch(`/api/tasks/${taskId}`, { state: 'completed', result: 'done by test-v4' });
    if (!res.success) throw new Error('PATCH did not return success');
    const done = await get('/api/tasks?state=completed');
    const task = done.find((t) => t.id === taskId);
    if (!task) throw new Error('Task missing from state=completed list after completion');
    if (task.result !== 'done by test-v4') throw new Error(`Result mismatch: ${task.result}`);
    if (!task.completed_at) throw new Error('completed_at not set');
  }));

  // ─── 2. Threads ──────────────────────────────────────────────
  // Real API: POST /api/threads {title, context, createdBy, groupId?,
  // parentId?} → {success, id}; POST /api/threads/:id/messages
  // {from, to?, content} → {success, id, threadId};
  // GET /api/threads/:id → {thread, messages}.

  results.push(await test('Threads: create thread', async () => {
    const thread = await post('/api/threads', {
      title: `V4 thread ${RUN}`,
      context: 'test-v4 thread context',
      createdBy: agentA
    });
    threadId = thread.id;
    if (!threadId) throw new Error('No thread id returned');
    console.log(`  → Thread ID: ${threadId}`);
  }));

  results.push(await test('Threads: reply in thread and read back', async () => {
    const msg = await post(`/api/threads/${threadId}/messages`, {
      from: agentA,
      to: agentB,
      content: `Thread reply ${RUN}`
    });
    if (!msg.success || !msg.id) throw new Error('Thread message not created');
    if (msg.threadId !== threadId) throw new Error('threadId mismatch in reply response');

    const view = await get(`/api/threads/${threadId}`);
    if (view.thread.id !== threadId) throw new Error('Thread id mismatch on read-back');
    if (!Array.isArray(view.messages)) throw new Error('Expected messages array');
    const found = view.messages.find((m) => m.id === msg.id);
    if (!found) throw new Error('Thread reply missing from GET /api/threads/:id');
    if (found.content !== `Thread reply ${RUN}`) throw new Error('Thread reply content mismatch');
    if (Number(view.thread.message_count) < 1) throw new Error('message_count not incremented');
    console.log(`  → ${view.messages.length} message(s) in thread`);
  }));

  results.push(await test('Threads: list threads', async () => {
    const threads = await get('/api/threads');
    if (!Array.isArray(threads)) throw new Error('Expected array of threads');
    if (!threads.some((t) => t.id === threadId)) throw new Error('Created thread missing from list');
  }));

  // ─── 3. Reactions ────────────────────────────────────────────
  // Real API: POST /api/messages/:id/reactions {agentId, emoji} →
  // {success, id, semantic}; GET same path → {reactions, semantics};
  // DELETE same path {agentId, emoji?} removes reactions.

  results.push(await test('Reactions: send message to react to', async () => {
    const message = await post('/api/messages', {
      from: agentA,
      to: agentB,
      content: `React to me ${RUN}`,
      messageType: 'direct'
    });
    directMessageId = message.messageId;
    if (!directMessageId) throw new Error('No messageId returned');
  }));

  results.push(await test('Reactions: add reaction and verify it appears', async () => {
    const res = await post(`/api/messages/${directMessageId}/reactions`, {
      agentId: agentB,
      emoji: '👍'
    });
    if (!res.success) throw new Error('Reaction add did not return success');
    if (res.semantic !== 'ACKNOWLEDGED') throw new Error(`Expected semantic ACKNOWLEDGED for 👍, got ${res.semantic}`);

    const view = await get(`/api/messages/${directMessageId}/reactions`);
    if (!Array.isArray(view.reactions)) throw new Error('Expected reactions array');
    const mine = view.reactions.find((r) => r.agent_id === agentB && r.emoji === '👍');
    if (!mine) throw new Error('Reaction missing from GET reactions');
    if (mine.agent_name !== NAME_B) throw new Error(`agent_name mismatch: ${mine.agent_name}`);
    if (!Array.isArray(view.semantics?.ACKNOWLEDGED) || !view.semantics.ACKNOWLEDGED.includes(NAME_B)) {
      throw new Error('Semantics grouping missing reactor under ACKNOWLEDGED');
    }
  }));

  results.push(await test('Reactions: remove reaction and verify it is gone', async () => {
    const res = await del(`/api/messages/${directMessageId}/reactions`, { agentId: agentB, emoji: '👍' });
    if (!res.success) throw new Error('Reaction removal did not return success');
    if (res.removed !== 1) throw new Error(`Expected removed 1, got ${res.removed}`);

    const view = await get(`/api/messages/${directMessageId}/reactions`);
    if (view.reactions.some((r) => r.agent_id === agentB && r.emoji === '👍')) {
      throw new Error('Reaction still present after DELETE');
    }

    const again = await raw('DELETE', `/api/messages/${directMessageId}/reactions`, { agentId: agentB, emoji: '👍' });
    if (again.status !== 404) throw new Error(`Expected 404 removing a missing reaction, got ${again.status}`);
    console.log('  → Reaction removed; second DELETE correctly 404s');
  }));

  // ─── 4. Presence ─────────────────────────────────────────────
  // Real API: PATCH /api/agents/:id/presence {state, statusMessage,
  // capabilities, ...}; GET /api/agents/:id/presence; GET /api/presence.

  results.push(await test('Presence: set presence and read it back', async () => {
    const res = await patch(`/api/agents/${agentA}/presence`, {
      state: 'busy',
      statusMessage: `v4 testing ${RUN}`,
      capabilities: [UNIQUE_CAP, 'v4-testing'],
      bandwidthUpload: 12,
      bandwidthDownload: 34
    });
    if (!res.success || res.state !== 'busy') throw new Error(`Presence set failed: ${JSON.stringify(res)}`);

    const p = await get(`/api/agents/${agentA}/presence`);
    if (p.state !== 'busy') throw new Error(`Expected state busy, got ${p.state}`);
    if (p.status_message !== `v4 testing ${RUN}`) throw new Error(`status_message mismatch: ${p.status_message}`);
    if (!Array.isArray(p.capabilities) || !p.capabilities.includes(UNIQUE_CAP)) {
      throw new Error('Presence capabilities missing unique capability');
    }
    console.log(`  → ${NAME_A} is busy: "${p.status_message}"`);
  }));

  results.push(await test('Presence: list filtered by state', async () => {
    const rows = await get('/api/presence?state=busy');
    if (!Array.isArray(rows)) throw new Error('Expected array from /api/presence');
    const mine = rows.find((r) => r.agent_id === agentA);
    if (!mine) throw new Error('Agent A missing from /api/presence?state=busy');
    if (mine.agent_name !== NAME_A) throw new Error(`agent_name mismatch: ${mine.agent_name}`);
  }));

  // ─── Group (shared fixture for subscriptions / decisions / joins) ──
  // Real API: POST /api/groups {name, description, createdBy} → {groupId}.

  results.push(await test('Groups: create group for v4 flows', async () => {
    const group = await post('/api/groups', {
      name: `V4 Group ${RUN}`,
      description: 'test-v4 shared group',
      createdBy: agentA
    });
    groupId = group.groupId;
    if (!groupId) throw new Error('No groupId returned');
    console.log(`  → Group ID: ${groupId}`);
  }));

  // ─── 5. Subscriptions ────────────────────────────────────────
  // Real API: POST /api/groups/:groupId/subscribe {agentId, notify*}
  // → {success, subscribedTo}; GET /api/agents/:id/subscriptions.

  results.push(await test('Subscriptions: subscribe agent to group and verify listing', async () => {
    const res = await post(`/api/groups/${groupId}/subscribe`, {
      agentId: agentB,
      notifyBroadcast: true,
      notifyTask: true
    });
    if (!res.success) throw new Error('Subscribe did not return success');

    const subs = await get(`/api/agents/${agentB}/subscriptions`);
    if (!Array.isArray(subs)) throw new Error('Expected array of subscriptions');
    const mine = subs.find((s) => s.group_id === groupId);
    if (!mine) throw new Error('Subscription missing from agent subscription listing');
    if (mine.agent_id !== agentB) throw new Error(`agent_id mismatch: ${mine.agent_id}`);
    console.log(`  → Subscribed to "${mine.group_name}"`);
  }));

  // ─── 6. Decisions ────────────────────────────────────────────
  // Real API: POST /api/decisions {groupId, content, context,
  // decidedBy} creates a decision record (status 'open') and, when
  // groupId is supplied, also logs a DECISION activity row.
  // GET /api/decisions returns decision records with tallies;
  // POST /api/decisions/:id/vote votes; PATCH /api/decisions/:id
  // closes (deriving the outcome from the tally when omitted).

  results.push(await test('Decisions: create decision and read back state', async () => {
    const content = `Adopt v4 test plan ${RUN}`;
    const res = await post('/api/decisions', {
      groupId,
      content,
      context: 'test-v4 decision context',
      decidedBy: agentA
    });
    if (!res.success || !res.id) throw new Error('Decision create did not return id');
    if (res.decision !== content) throw new Error('Decision echo mismatch');
    if (res.status !== 'open') throw new Error(`Expected status open, got ${res.status}`);
    decisionId = res.id;

    const list = await get(`/api/decisions?groupId=${groupId}`);
    if (!Array.isArray(list)) throw new Error('Expected array of decisions');
    const mine = list.find((d) => d.id === res.id);
    if (!mine) throw new Error('Decision missing from GET /api/decisions?groupId=');
    if (mine.content !== content) throw new Error('Decision content mismatch on read-back');
    if (mine.status !== 'open') throw new Error(`Expected status open on read-back, got ${mine.status}`);
    console.log(`  → Decision recorded: "${mine.content}"`);
  }));

  results.push(await test('Decisions: votes accumulate into the tally', async () => {
    let res = await post(`/api/decisions/${decisionId}/vote`, { agentId: agentB, vote: 'approve' });
    if (!res.success) throw new Error('Vote by B did not return success');
    res = await post(`/api/decisions/${decisionId}/vote`, { agentId: agentC, vote: 'approve' });
    if (!res.success) throw new Error('Vote by C did not return success');
    res = await post(`/api/decisions/${decisionId}/vote`, { agentId: agentA, vote: 'reject' });
    if (!res.success) throw new Error('Vote by A did not return success');
    const { tally } = res;
    if (tally.approve !== 2 || tally.reject !== 1 || tally.abstain !== 0) {
      throw new Error(`Expected tally {approve:2, reject:1, abstain:0}, got ${JSON.stringify(tally)}`);
    }
    console.log(`  → Tally: ${JSON.stringify(tally)}`);
  }));

  results.push(await test('Decisions: bad vote value is rejected and re-vote replaces', async () => {
    const bad = await raw('POST', `/api/decisions/${decisionId}/vote`, { agentId: agentA, vote: 'maybe' });
    if (bad.status !== 400) throw new Error(`Expected 400 for bad vote value, got ${bad.status}`);

    const res = await post(`/api/decisions/${decisionId}/vote`, { agentId: agentA, vote: 'approve' });
    const { tally } = res;
    if (tally.approve !== 3 || tally.reject !== 0 || tally.abstain !== 0) {
      throw new Error(`Expected tally {approve:3, reject:0, abstain:0} after re-vote, got ${JSON.stringify(tally)}`);
    }
    console.log(`  → Re-vote replaced: ${JSON.stringify(tally)}`);
  }));

  results.push(await test('Decisions: single decision shows its votes', async () => {
    const view = await get(`/api/decisions/${decisionId}`);
    if (view.id !== decisionId) throw new Error('Decision id mismatch on single read');
    if (!Array.isArray(view.votes)) throw new Error('Expected votes array');
    if (view.votes.length !== 3) throw new Error(`Expected 3 votes, got ${view.votes.length}`);
    if (view.tally.approve !== 3) throw new Error(`Expected tally approve 3, got ${JSON.stringify(view.tally)}`);
  }));

  results.push(await test('Decisions: PATCH with no status derives approved; vote after close is 409', async () => {
    const res = await patch(`/api/decisions/${decisionId}`, {});
    if (!res.success) throw new Error('PATCH did not return success');
    if (res.status !== 'approved') throw new Error(`Expected derived status approved, got ${res.status}`);

    const late = await raw('POST', `/api/decisions/${decisionId}/vote`, { agentId: agentB, vote: 'reject' });
    if (late.status !== 409) throw new Error(`Expected 409 voting on a closed decision, got ${late.status}`);
    console.log('  → Decision closed as approved; late vote correctly 409s');
  }));

  // ─── 7. Group join requests ──────────────────────────────────
  // Real API: POST /api/groups/:groupId/request {agentId} →
  // {success, id, status:'pending'}; GET /api/groups/:groupId/requests
  // lists pending; PATCH /api/groups/:groupId/request/:agentId
  // {status:'approved'|'rejected'} approves and adds membership.

  results.push(await test('Join requests: second agent requests to join', async () => {
    const res = await post(`/api/groups/${groupId}/request`, { agentId: agentC });
    if (!res.success) throw new Error('Join request did not return success');
    if (res.status !== 'pending') throw new Error(`Expected status pending, got ${res.status}`);
  }));

  results.push(await test('Join requests: pending request is listed', async () => {
    const reqs = await get(`/api/groups/${groupId}/requests`);
    if (!Array.isArray(reqs)) throw new Error('Expected array of requests');
    const mine = reqs.find((r) => r.agent_id === agentC);
    if (!mine) throw new Error('Pending join request for Agent C not listed');
    if (mine.agent_name !== NAME_C) throw new Error(`agent_name mismatch: ${mine.agent_name}`);
  }));

  results.push(await test('Join requests: approve and verify membership', async () => {
    const res = await patch(`/api/groups/${groupId}/request/${agentC}`, { status: 'approved' });
    if (!res.success || res.status !== 'approved') throw new Error(`Approve failed: ${JSON.stringify(res)}`);

    const members = await get(`/api/groups/${groupId}/agents`);
    if (!Array.isArray(members)) throw new Error('Expected array of members');
    if (!members.some((m) => m.agent_id === agentC || m.id === agentC)) {
      throw new Error('Agent C not in group members after approval');
    }
    const pending = await get(`/api/groups/${groupId}/requests`);
    if (pending.some((r) => r.agent_id === agentC)) throw new Error('Approved request still listed as pending');
    console.log('  → Agent C is now a group member');
  }));

  // ─── 8. Scheduled-message delivery (KEY test) ────────────────
  // Real API: POST /api/messages/scheduled {from, to, content,
  // sendAt} → {success, id, scheduledAt}. The server delivery loop
  // (default 15s) delivers due messages and marks the row sent.
  // GET /api/messages/scheduled/:id reads a row back in any status;
  // GET /api/messages/scheduled defaults to pending rows, with
  // ?status= filtering (or ?status=all).

  results.push(await test('Scheduled: schedule a message due in ~2 seconds', async () => {
    const sendAt = new Date(Date.now() + 2000).toISOString();
    const res = await post('/api/messages/scheduled', {
      from: agentA,
      to: agentB,
      content: `Scheduled hello ${RUN}`,
      sendAt
    });
    scheduledId = res.id;
    if (!res.success || !scheduledId) throw new Error('Schedule did not return id');
    if (res.scheduledAt !== sendAt) throw new Error('scheduledAt echo mismatch');
    console.log(`  → Scheduled ID: ${scheduledId}, due ${sendAt}`);
  }));

  results.push(await test('Scheduled: message lands in recipient inbox (delivery loop)', async () => {
    const deadline = Date.now() + 30000;
    let found = null;
    while (Date.now() < deadline && !found) {
      const inbox = await get(`/api/agents/${agentB}/inbox`);
      found = inbox.find((m) => m.content === `Scheduled hello ${RUN}` && m.from === agentA) || null;
      if (!found) await sleep(2000);
    }
    if (!found) throw new Error('Scheduled message never arrived in recipient inbox within 30s');
    console.log(`  → Delivered message ID: ${found.id}`);
  }));

  results.push(await test('Scheduled: sent status is readable by id and via ?status=', async () => {
    const row = await get(`/api/messages/scheduled/${scheduledId}`);
    if (row.id !== scheduledId) throw new Error('Scheduled row id mismatch on read-back');
    if (row.status !== 'sent') throw new Error(`Expected status sent, got ${row.status}`);

    const sent = await get('/api/messages/scheduled?status=sent');
    if (!Array.isArray(sent)) throw new Error('Expected array from ?status=sent');
    if (!sent.some((r) => r.id === scheduledId)) throw new Error('Delivered message missing from ?status=sent list');

    const pending = await get('/api/messages/scheduled');
    if (!Array.isArray(pending)) throw new Error('Expected array from default scheduled list');
    if (pending.some((r) => r.id === scheduledId)) throw new Error('Delivered message still in default (pending) list');
    console.log('  → Sent status exposed by id and ?status=sent; absent from default list');
  }));

  // ─── 9. Capabilities directory ───────────────────────────────
  // Real API (merged v4.1 implementation): GET /api/capabilities →
  // {totalCapabilities, totalAgents, index, directory, sorted} where
  // index/directory group agents by capability and each entry carries
  // the agent's presence state.

  results.push(await test('Capabilities: directory groups by capability incl. presence', async () => {
    const caps = await get('/api/capabilities');
    if (!caps.index || typeof caps.index !== 'object') throw new Error('Expected index object');
    if (!caps.directory || typeof caps.directory !== 'object') throw new Error('Expected directory object');
    if (!Array.isArray(caps.sorted)) throw new Error('Expected sorted array');
    if (!caps.sorted.includes(UNIQUE_CAP)) throw new Error('Unique capability missing from sorted list');

    const entries = caps.index[UNIQUE_CAP];
    if (!Array.isArray(entries)) throw new Error('Unique capability missing from index');
    const mine = entries.find((e) => e.agentId === agentA || e.id === agentA);
    if (!mine) throw new Error('Agent A missing under its unique capability');
    if (mine.name !== NAME_A) throw new Error(`name mismatch: ${mine.name}`);
    // Presence was set to busy earlier — the directory must reflect it
    if (mine.state !== 'busy') throw new Error(`Expected presence state busy in directory, got ${mine.state}`);
    if (mine.statusMessage !== `v4 testing ${RUN}`) throw new Error('statusMessage not reflected in directory');
    console.log(`  → ${caps.totalCapabilities} capabilities, ${caps.totalAgents} agents; A shows state=${mine.state}`);
  }));

  // ─── 10. Updates payload round-trip ──────────────────────────
  // Real API: POST /api/updates {version, updateType, title,
  // payloadUrl, sha256, ...} → {success, updateId};
  // GET /api/updates returns the stored rows (DB column names:
  // payload_url, sha256).

  results.push(await test('Updates: payloadUrl + sha256 round-trip verbatim', async () => {
    const payloadUrl = `https://example.com/mesh-updates/payload-${RUN}.bin`;
    const sha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const version = `4.1.0-v4test-${RUN}`;
    const created = await post('/api/updates', {
      version,
      updateType: 'feature',
      title: `V4 test update ${RUN}`,
      description: 'payload round-trip probe',
      payloadUrl,
      sha256
    });
    if (!created.success || !created.updateId) throw new Error('Update create did not return updateId');

    const updates = await get('/api/updates');
    if (!Array.isArray(updates)) throw new Error('Expected array of updates');
    const mine = updates.find((u) => u.id === created.updateId);
    if (!mine) throw new Error('Created update missing from GET /api/updates');
    if (mine.version !== version) throw new Error(`version mismatch: ${mine.version}`);
    const storedUrl = mine.payload_url ?? mine.payloadUrl;
    if (storedUrl !== payloadUrl) throw new Error(`payloadUrl mismatch: ${storedUrl}`);
    if (mine.sha256 !== sha256) throw new Error(`sha256 mismatch: ${mine.sha256}`);
    console.log(`  → payload_url and sha256 stored verbatim for ${version}`);
  }));

  // ─── 11. Bonus smoke: utils/mesh-client.js ───────────────────
  // Covers the fixed GET-params bug: getTasks/getMessages must send
  // their params as a query string (GET requests carry no body).

  results.push(await test('Mesh client: getTasks({state}) returns filtered data', async () => {
    const client = createClient({ baseURL: BASE_URL, apiKey: API_KEY });
    const pending = await client.getTasks({ state: 'pending' });
    if (!Array.isArray(pending)) throw new Error('getTasks did not return an array');
    if (pending.some((t) => t.state !== 'pending')) {
      throw new Error('getTasks({state:pending}) returned non-pending tasks — GET params not applied');
    }
    const completed = await client.getTasks({ state: 'completed' });
    if (!completed.some((t) => t.id === taskId)) {
      throw new Error('getTasks({state:completed}) missing the task completed earlier — GET params not applied');
    }
    console.log(`  → getTasks pending=${pending.length}, completed includes our task`);
  }));

  results.push(await test('Mesh client: getMessages({limit:5}) returns data', async () => {
    const client = createClient({ baseURL: BASE_URL, apiKey: API_KEY });
    const messages = await client.getMessages({ limit: 5 });
    if (!Array.isArray(messages)) throw new Error('getMessages did not return an array');
    if (messages.length > 5) throw new Error(`limit=5 not applied: got ${messages.length} messages`);
    if (messages.length === 0) throw new Error('getMessages returned no data');
    console.log(`  → getMessages returned ${messages.length} message(s)`);
  }));

  // Summary
  console.log('\n═══════════════════════════════════════════════════════════');
  const passed = results.filter(r => r).length;
  const total = results.length;
  console.log(`  Test Results: ${passed}/${total} passed`);
  if (passed === total) {
    console.log('  ✓ All tests passed!');
  } else {
    console.log(`  ✗ ${total - passed} test(s) failed`);
  }
  if (gapNotes.length) {
    console.log('\n  API gaps observed (see report):');
    for (const note of gapNotes) console.log(`   - ${note}`);
  }
  console.log('═══════════════════════════════════════════════════════════\n');

  process.exit(passed === total ? 0 : 1);
}

// Check if server is running
async function checkServer() {
  try {
    await get('/health');
    return true;
  } catch (error) {
    return false;
  }
}

async function main() {
  console.log('Checking if server is running...');
  const serverRunning = await checkServer();

  if (!serverRunning) {
    console.error(`\n✗ Server not running at ${BASE_URL}`);
    console.error('  Please start the server first: node server.js\n');
    process.exit(1);
  }

  await runTests();
}

main().catch(error => {
  console.error('\n✗ Test suite error:', error);
  process.exit(1);
});
