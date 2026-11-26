#!/usr/bin/env node
/**
 * Agent Mesh Auto-Update Client
 * Automatically listens for and applies updates without re-registration
 *
 * Usage:
 *   node auto-update-client.js --agent-name "AgentName" --endpoint "http://localhost:3000"
 *
 * Features:
 * - WebSocket listener for real-time updates
 * - Automatic update acknowledgment
 * - Self-update capability (agents can update their own code)
 * - Identity preservation (no re-registration needed)
 */

import WebSocket from 'ws';
import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// `let`, not `const`: the CLI parser at the bottom of this file applies
// --mesh-url/--agent-name/--endpoint/--version by assigning these directly
// (writing process.env there would be too late — these are read at load).
let MESH_URL = process.env.MESH_URL || 'http://localhost:4000';
let WS_URL = MESH_URL.replace('http://', 'ws://').replace('https://', 'wss://');
let AGENT_NAME = process.env.AGENT_NAME;
let AGENT_ENDPOINT = process.env.AGENT_ENDPOINT;
const API_KEY = process.env.AGENT_MESH_API_KEY || 'openclaw-mesh-default-key';
let AGENT_VERSION = process.env.AGENT_VERSION || '1.0.0';
// Downloaded payloads are staged here only — never executed and never
// written over running code. A human/agent step promotes them deliberately.
const UPDATES_DIR = process.env.AGENT_MESH_UPDATES_DIR || path.join(__dirname, 'updates');

// State
let agentId = null;
let ws = null;
let lastUpdateId = null;

/**
 * Register or re-register with identity preservation
 * Agents can re-register anytime without losing their ID
 */
async function registerAgent() {
  console.log(`[Auto-Update] Registering agent: ${AGENT_NAME}`);

  const response = await fetch(`${MESH_URL}/api/agents/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY
    },
    body: JSON.stringify({
      name: AGENT_NAME,
      endpoint: AGENT_ENDPOINT,
      capabilities: ['auto_update', 'messaging', 'task_execution']
    })
  });

  const data = await response.json();

  if (data.success) {
    agentId = data.agentId;
    console.log(`[Auto-Update] ${data.message}`);
    console.log(`[Auto-Update] Agent ID: ${agentId}`);
    return data;
  } else {
    throw new Error(`Registration failed: ${data.error || 'Unknown error'}`);
  }
}

/**
 * Connect to WebSocket for real-time updates
 */
function connectWebSocket() {
  ws = new WebSocket(`${WS_URL}/ws`);

  ws.on('open', () => {
    console.log('[Auto-Update] WebSocket connected');
    // Send heartbeat every 30 seconds
    setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'heartbeat', agentId }));
      }
    }, 30000);
  });

  ws.on('message', async (data) => {
    const message = JSON.parse(data.toString());
    console.log('[Auto-Update] Received:', message.type);

    switch (message.type) {
      case 'system_update':
        await handleSystemUpdate(message.update);
        break;
      case 'update_available':
        await handleUpdateAvailable(message);
        break;
      default:
        // Ignore other events
        break;
    }
  });

  ws.on('close', () => {
    console.log('[Auto-Update] WebSocket disconnected, reconnecting in 5s...');
    setTimeout(connectWebSocket, 5000);
  });

  ws.on('error', (error) => {
    console.error('[Auto-Update] WebSocket error:', error.message);
  });
}

/**
 * Handle system update notification
 */
async function handleSystemUpdate(update) {
  if (lastUpdateId === update.id) {
    console.log('[Auto-Update] Already processed this update, skipping');
    return;
  }

  lastUpdateId = update.id;
  console.log(`[Auto-Update] 🚀 New Update Available: ${update.title} (${update.version})`);
  console.log(`[Auto-Update] Description: ${update.description || 'No description'}`);
  console.log(`[Auto-Update] Breaking Change: ${update.breakingChange ? '⚠️ YES' : '✅ NO'}`);

  // Acknowledge update
  await acknowledgeUpdate(update.id);

  // Apply update if compatible
  await applyUpdate(update);
}

/**
 * Handle update available event
 */
async function handleUpdateAvailable(message) {
  console.log('[Auto-Update] Update available notification:', message);
  await handleSystemUpdate(message.update);
}

/**
 * Acknowledge update to mesh
 * The server upserts acknowledgments per (update, agent), so a later
 * 'completed' / 'rejected' ack from applyUpdate supersedes the initial
 * 'accepted' ack sent on receipt.
 */
async function acknowledgeUpdate(updateId, status = 'accepted', notes = 'Auto-acknowledged by auto-update client') {
  console.log(`[Auto-Update] Acknowledging update: ${updateId} (${status})`);

  const response = await fetch(`${MESH_URL}/api/updates/${updateId}/acknowledge`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY
    },
    body: JSON.stringify({
      agentId: agentId,
      status: status,
      agentVersion: AGENT_VERSION,
      notes: notes
    })
  });

  if (response.ok) {
    console.log('[Auto-Update] ✅ Update acknowledged');
  } else {
    console.error('[Auto-Update] ❌ Failed to acknowledge update');
  }
}

/**
 * Pick the first present field from a list of aliases.
 * Update records arrive in two shapes: WebSocket broadcasts use camelCase
 * (requiredVersion, breakingChange) while GET /api/updates returns raw DB
 * rows in snake_case (required_version, breaking_change).
 */
function pickField(obj, names) {
  for (const name of names) {
    if (obj && obj[name] !== undefined && obj[name] !== null && obj[name] !== '') {
      return obj[name];
    }
  }
  return undefined;
}

/**
 * Fetch the authoritative update record from the mesh server.
 * There is no GET /api/updates/:id route — the list endpoint is the source —
 * so fetch the list and select the matching record. Returns null when the
 * record cannot be fetched/found; callers fall back to the update object
 * carried by the WebSocket notice.
 */
async function fetchUpdateRecord(updateId) {
  try {
    const response = await fetch(`${MESH_URL}/api/updates`, {
      headers: { 'X-API-Key': API_KEY }
    });
    if (!response.ok) {
      console.log(`[Auto-Update] ⚠️ Could not fetch update list (HTTP ${response.status}), using notice payload`);
      return null;
    }
    const data = await response.json();
    const updates = Array.isArray(data) ? data : (data.updates || []);
    return updates.find(u => u.id === updateId) || null;
  } catch (error) {
    console.log(`[Auto-Update] ⚠️ Could not fetch update record (${error.message}), using notice payload`);
    return null;
  }
}

/**
 * Compute the sha256 hex digest of a file.
 */
async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

/**
 * Apply update — safe staging implementation.
 *
 * On an update notice this:
 * 1. Fetches the update record from the mesh server (GET /api/updates,
 *    selecting by id; falls back to the notice payload if unavailable).
 * 2. If the update provides a payload URL, downloads the payload into
 *    ./updates/<updateId>/ (override the root with AGENT_MESH_UPDATES_DIR).
 * 3. If the update provides a sha256, verifies the downloaded file against
 *    it and deletes the file on mismatch.
 * 4. Acknowledges to the server with status 'completed', or 'rejected'
 *    with explanatory notes on missing payload / download or
 *    verification failure / version incompatibility.
 *
 * Safety: the payload is ONLY staged on disk. It is never executed and
 * never overwrites running code — promoting a staged payload is a
 * deliberate manual step outside this client.
 */
async function applyUpdate(update) {
  console.log('[Auto-Update] Applying update...');

  const updateId = update && update.id;
  if (!updateId) {
    console.log('[Auto-Update] ⚠️ Update notice has no id, nothing to apply');
    return { success: false, error: 'Update notice has no id' };
  }

  try {
    // Fetch the authoritative record; the notice payload fills any gaps
    // (e.g. payload fields a broadcast may carry that the DB row does not).
    const record = await fetchUpdateRecord(updateId);
    const merged = { ...(record || {}), ...update };
    const payloadUrl = pickField(record, ['payloadUrl', 'payload_url', 'downloadUrl', 'download_url', 'url'])
      || pickField(update, ['payloadUrl', 'payload_url', 'downloadUrl', 'download_url', 'url']);
    const expectedSha256 = pickField(record, ['sha256', 'payloadSha256', 'payload_sha256', 'checksum'])
      || pickField(update, ['sha256', 'payloadSha256', 'payload_sha256', 'checksum']);
    const requiredVersion = pickField(merged, ['requiredVersion', 'required_version']);
    const breakingChange = pickField(merged, ['breakingChange', 'breaking_change']);

    // Check if update is compatible
    if (requiredVersion && !isVersionCompatible(AGENT_VERSION, requiredVersion)) {
      const notes = `Update requires minimum version ${requiredVersion}; current version is ${AGENT_VERSION}. Manual upgrade required.`;
      console.log(`[Auto-Update] ⚠️ ${notes}`);
      await acknowledgeUpdate(updateId, 'rejected', notes);
      return { success: false, error: notes };
    }

    // Check breaking changes (warning only — payload is staged, not applied live)
    if (breakingChange) {
      console.log('[Auto-Update] ⚠️ Breaking change detected!');
      console.log('[Auto-Update] Review update announcement before promoting the staged payload');
      console.log(`[Auto-Update] Announcement: ${merged.announcement || 'None provided'}`);
    }

    if (!payloadUrl) {
      const notes = 'Update provides no payload URL; nothing to download or stage.';
      console.log(`[Auto-Update] ⚠️ ${notes}`);
      await acknowledgeUpdate(updateId, 'rejected', notes);
      return { success: false, error: notes };
    }

    // Stage the payload under ./updates/<updateId>/ (id sanitized against traversal)
    const safeUpdateId = String(updateId).replace(/[^a-zA-Z0-9._-]/g, '_');
    const updateDir = path.join(UPDATES_DIR, safeUpdateId);
    await fs.promises.mkdir(updateDir, { recursive: true });

    const downloadUrl = new URL(payloadUrl, MESH_URL);
    let filename = path.basename(downloadUrl.pathname).replace(/[^a-zA-Z0-9._-]/g, '_');
    if (!filename || filename === '.' || filename === '_') filename = 'payload.bin';
    const filePath = path.join(updateDir, filename);

    // Only send the API key to the mesh server itself, never to a third-party host
    const headers = {};
    if (downloadUrl.origin === new URL(MESH_URL).origin) {
      headers['X-API-Key'] = API_KEY;
    }

    console.log(`[Auto-Update] Downloading payload: ${downloadUrl.href}`);
    const response = await fetch(downloadUrl, { headers });
    if (!response.ok || !response.body) {
      const notes = `Payload download failed: HTTP ${response.status} from ${downloadUrl.href}`;
      console.log(`[Auto-Update] ❌ ${notes}`);
      await acknowledgeUpdate(updateId, 'rejected', notes);
      return { success: false, error: notes };
    }

    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(filePath));
    const { size } = await fs.promises.stat(filePath);
    console.log(`[Auto-Update] Payload staged: ${filePath} (${size} bytes)`);

    // Verify sha256 when the update provides one
    let verified = false;
    let actualSha256 = null;
    if (expectedSha256) {
      actualSha256 = await sha256File(filePath);
      const expected = String(expectedSha256).trim().toLowerCase();
      if (actualSha256 !== expected) {
        const notes = `Payload sha256 verification failed: expected ${expected}, got ${actualSha256}. Downloaded file deleted.`;
        console.log(`[Auto-Update] ❌ ${notes}`);
        await fs.promises.rm(filePath, { force: true });
        await acknowledgeUpdate(updateId, 'rejected', notes);
        return { success: false, error: notes };
      }
      verified = true;
      console.log('[Auto-Update] ✅ Payload sha256 verified');
    } else {
      console.log('[Auto-Update] ⚠️ Update provides no sha256; payload staged unverified');
    }

    // Record what was staged, alongside the payload
    await fs.promises.writeFile(path.join(updateDir, 'metadata.json'), JSON.stringify({
      updateId,
      version: merged.version || null,
      payloadUrl: downloadUrl.href,
      file: filename,
      bytes: size,
      sha256: actualSha256,
      verified,
      downloadedAt: new Date().toISOString()
    }, null, 2));

    const notes = verified
      ? `Payload downloaded to updates/${safeUpdateId}/${filename} (${size} bytes) and sha256 verified. Staged only; not executed.`
      : `Payload downloaded to updates/${safeUpdateId}/${filename} (${size} bytes); no sha256 provided by update, staged unverified. Not executed.`;
    await acknowledgeUpdate(updateId, 'completed', notes);
    console.log('[Auto-Update] ✅ Update staged and acknowledged as completed');
    return { success: true, filePath, bytes: size, sha256: actualSha256, verified };
  } catch (error) {
    const notes = `Failed to apply update: ${error.message}`;
    console.error(`[Auto-Update] ❌ ${notes}`);
    try {
      await acknowledgeUpdate(updateId, 'rejected', notes);
    } catch (ackError) {
      console.error('[Auto-Update] ❌ Failed to send rejection acknowledgment:', ackError.message);
    }
    return { success: false, error: notes };
  }
}

/**
 * Update agent capabilities after update
 */
async function updateAgentCapabilities(newCapabilities) {
  console.log('[Auto-Update] Updating agent capabilities...');

  const response = await fetch(`${MESH_URL}/api/agents/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY
    },
    body: JSON.stringify({
      name: AGENT_NAME,
      endpoint: AGENT_ENDPOINT,
      capabilities: newCapabilities
    })
  });

  if (response.ok) {
    console.log('[Auto-Update] ✅ Capabilities updated');
  } else {
    console.error('[Auto-Update] ❌ Failed to update capabilities');
  }
}

/**
 * Check version compatibility
 */
function isVersionCompatible(current, required) {
  const currentParts = current.split('.').map(Number);
  const requiredParts = required.split('.').map(Number);

  for (let i = 0; i < requiredParts.length; i++) {
    if (currentParts[i] === undefined || currentParts[i] < requiredParts[i]) {
      return false;
    }
  }

  return true;
}

/**
 * Update agent heartbeat
 */
async function sendHeartbeat() {
  const response = await fetch(`${MESH_URL}/api/agents/${agentId}/health`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY
    },
    body: JSON.stringify({
      status: 'healthy',
      uptimeSeconds: process.uptime(),
      cpuUsage: process.cpuUsage().user / 1000000,
      memoryUsage: process.memoryUsage().heapUsed / 1024 / 1024
    })
  });

  if (response.ok) {
    console.log('[Auto-Update] Heartbeat sent');
  }
}

/**
 * Main startup
 */
async function main() {
  console.log('='.repeat(60));
  console.log('🤖 Agent Mesh Auto-Update Client');
  console.log('='.repeat(60));
  console.log(`Mesh URL: ${MESH_URL}`);
  console.log(`Agent Name: ${AGENT_NAME}`);
  console.log(`Agent Version: ${AGENT_VERSION}`);
  console.log('='.repeat(60));
  console.log();

  // Register agent
  await registerAgent();

  // Connect WebSocket
  connectWebSocket();

  // Send heartbeat every 60 seconds
  setInterval(sendHeartbeat, 60000);

  console.log('[Auto-Update] 🚀 Ready and listening for updates...');
  console.log('[Auto-Update] Press Ctrl+C to stop');
}

// Parse command line arguments
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--agent-name' && args[i + 1]) {
      AGENT_NAME = process.env.AGENT_NAME = args[i + 1];
    } else if (args[i] === '--endpoint' && args[i + 1]) {
      AGENT_ENDPOINT = process.env.AGENT_ENDPOINT = args[i + 1];
    } else if (args[i] === '--version' && args[i + 1]) {
      AGENT_VERSION = process.env.AGENT_VERSION = args[i + 1];
    } else if (args[i] === '--mesh-url' && args[i + 1]) {
      MESH_URL = process.env.MESH_URL = args[i + 1];
      WS_URL = MESH_URL.replace('http://', 'ws://').replace('https://', 'wss://');
    }
  }

  if (!AGENT_NAME) {
    console.error('Error: --agent-name is required');
    console.error('Usage: node auto-update-client.js --agent-name "AgentName" --endpoint "http://localhost:3000"');
    process.exit(1);
  }

  main().catch(console.error);
}

export { registerAgent, connectWebSocket, acknowledgeUpdate, applyUpdate, updateAgentCapabilities };
