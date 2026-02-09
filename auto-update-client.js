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

const MESH_URL = process.env.MESH_URL || 'http://localhost:4000';
const WS_URL = MESH_URL.replace('http://', 'ws://').replace('https://', 'wss://');
const AGENT_NAME = process.env.AGENT_NAME;
const AGENT_ENDPOINT = process.env.AGENT_ENDPOINT;
const API_KEY = process.env.AGENT_MESH_API_KEY || 'openclaw-mesh-default-key';
const AGENT_VERSION = process.env.AGENT_VERSION || '1.0.0';

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
 */
async function acknowledgeUpdate(updateId) {
  console.log(`[Auto-Update] Acknowledging update: ${updateId}`);

  const response = await fetch(`${MESH_URL}/api/updates/${updateId}/acknowledge`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY
    },
    body: JSON.stringify({
      agentId: agentId,
      status: 'accepted',
      agentVersion: AGENT_VERSION,
      notes: 'Auto-acknowledged by auto-update client'
    })
  });

  if (response.ok) {
    console.log('[Auto-Update] ✅ Update acknowledged');
  } else {
    console.error('[Auto-Update] ❌ Failed to acknowledge update');
  }
}

/**
 * Apply update (this is where agents implement their own update logic)
 * Override this function in your agent to implement custom update logic
 */
async function applyUpdate(update) {
  console.log('[Auto-Update] Applying update...');

  // Check if update is compatible
  if (update.requiredVersion && !isVersionCompatible(AGENT_VERSION, update.requiredVersion)) {
    console.log(`[Auto-Update] ⚠️ Update requires minimum version: ${update.requiredVersion}`);
    console.log(`[Auto-Update] Current version: ${AGENT_VERSION}`);
    console.log('[Auto-Update] Skipping update - manual upgrade required');
    return;
  }

  // Check breaking changes
  if (update.breakingChange) {
    console.log('[Auto-Update] ⚠️ Breaking change detected!');
    console.log('[Auto-Update] Review update announcement before proceeding');
    console.log(`[Auto-Update] Announcement: ${update.announcement || 'None provided'}`);
    // For breaking changes, you might want to prompt for confirmation
  }

  // Implement your custom update logic here
  // Examples:
  // - Pull new code from Git
  // - Update configuration files
  // - Install new dependencies
  // - Restart services

  console.log('[Auto-Update] Update logic not implemented (override applyUpdate function)');
  console.log('[Auto-Update] Update acknowledged but not applied');

  // Update agent capabilities if needed
  // await updateAgentCapabilities();

  // Re-register with new capabilities (identity preserved)
  // await registerAgent();
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
      process.env.AGENT_NAME = args[i + 1];
    } else if (args[i] === '--endpoint' && args[i + 1]) persistence = args[i + 1];
    else if (args[i] === '--version' && args[i + 1]) {
      process.env.AGENT_VERSION = args[i + 1];
    } else if (args[i] === '--mesh-url' && args[i + 1]) {
      process.env.MESH_URL = args[i + 1];
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
