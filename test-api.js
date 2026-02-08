#!/usr/bin/env node
/**
 * API Test Script
 * Tests all new agent group discovery and collective memory endpoints
 */

import { createWriteStream } from 'fs';
const API_KEY = process.env.AGENT_MESH_API_KEY || 'openclaw-mesh-default-key';
const BASE_URL = process.env.API_URL || 'http://localhost:4000';

// Test with both X-API-Key header (primary) and Authorization Bearer (fallback)
const headers = {
  'Content-Type': 'application/json',
  'X-API-Key': API_KEY,
  'Authorization': `Bearer ${API_KEY}` // Also include Bearer token for testing
};

let testAgent1, testAgent2, testGroup, testMemory;

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

async function runTests() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Agent Mesh API - Enhanced Features Test Suite');
  console.log('═══════════════════════════════════════════════════════════');

  const results = [];

  // Health check
  results.push(await test('Health check', async () => {
    const health = await get('/health');
    if (health.status !== 'ok') throw new Error('Health check failed');
  }));

  // Register test agents
  results.push(await test('Register Agent 1', async () => {
    const agent = await post('/api/agents/register', {
      name: 'TestAgent1',
      endpoint: 'http://localhost:3001',
      capabilities: ['messaging', 'groups', 'memory']
    });
    testAgent1 = agent.agentId;
    console.log(`  → Agent ID: ${testAgent1}`);
  }));

  results.push(await test('Register Agent 2', async () => {
    const agent = await post('/api/agents/register', {
      name: 'TestAgent2',
      endpoint: 'http://localhost:3002',
      capabilities: ['messaging', 'processing']
    });
    testAgent2 = agent.agentId;
    console.log(`  → Agent ID: ${testAgent2}`);
  }));

  // Test identity persistence - re-register Agent 1 with same name
  results.push(await test('Identity Persistence - Re-register Agent 1', async () => {
    const agent = await post('/api/agents/register', {
      name: 'TestAgent1',
      endpoint: 'http://localhost:3001',
      capabilities: ['messaging', 'groups', 'memory', 'updated']
    });
    if (agent.agentId !== testAgent1) throw new Error(`Agent ID mismatch! Expected ${testAgent1}, got ${agent.agentId}`);
    if (!agent.existed) throw new Error('Expected existed flag to be true');
    console.log(`  → Re-registered with same ID: ${agent.agentId}`);
  }));

  // Test agent groups
  results.push(await test('Create agent group', async () => {
    const group = await post('/api/groups', {
      name: 'Test Research Group',
      description: 'A group for testing collective memory',
      createdBy: testAgent1,
      metadata: { project: 'test', tags: ['test'] }
    });
    testGroup = group.groupId;
    console.log(`  → Group ID: ${testGroup}`);
  }));

  results.push(await test('List all groups', async () => {
    const groups = await get('/api/groups');
    if (!Array.isArray(groups)) throw new Error('Expected array of groups');
    console.log(`  → Found ${groups.length} group(s)`);
  }));

  results.push(await test('Get group details', async () => {
    const group = await get(`/api/groups/${testGroup}`);
    if (group.id !== testGroup) throw new Error('Group ID mismatch');
    console.log(`  → Group: ${group.name}`);
  }));

  results.push(await test('Add agent to group', async () => {
    await post(`/api/groups/${testGroup}/members`, {
      agentId: testAgent2,
      role: 'member'
    });
  }));

  results.push(await test('Add another agent to group', async () => {
    await post(`/api/groups/${testGroup}/members`, {
      agentId: testAgent1,
      role: 'admin'
    });
  }));

  results.push(await test('Get group members', async () => {
    const members = await get(`/api/groups/${testGroup}/agents`);
    if (!Array.isArray(members)) throw new Error('Expected array of members');
    console.log(`  → Found ${members.length} member(s)`);
  }));

  results.push(await test('Get agent groups', async () => {
    const groups = await get(`/api/agents/${testAgent1}/groups`);
    if (!Array.isArray(groups)) throw new Error('Expected array of groups');
  }));

  // Test collective memory
  results.push(await test('Store collective memory', async () => {
    const memory = await post(`/api/groups/${testGroup}/memory`, {
      agentId: testAgent1,
      key: 'test_config',
      value: { setting1: 'value1', setting2: 42 },
      memoryType: 'shared'
    });
    testMemory = memory.memoryId;
    console.log(`  → Memory ID: ${testMemory}, Version: ${memory.version}`);
  }));

  results.push(await test('Get specific memory key', async () => {
    const memory = await get(`/api/groups/${testGroup}/memory/test_config`);
    if (memory.key !== 'test_config') throw new Error('Key mismatch');
    if (memory.value.setting1 !== 'value1') throw new Error('Value mismatch');
  }));

  results.push(await test('Get all memory for group', async () => {
    const memories = await get(`/api/groups/${testGroup}/memory`);
    if (!Array.isArray(memories)) throw new Error('Expected array of memories');
  }));

  results.push(await test('Update existing memory', async () => {
    const memory = await post(`/api/groups/${testGroup}/memory`, {
      agentId: testAgent2,
      key: 'test_config',
      value: { setting1: 'updated', setting3: 'new' },
      memoryType: 'shared'
    });
    if (memory.version !== 2) throw new Error('Version should be 2');
    console.log(`  → Updated to version ${memory.version}`);
  }));

  results.push(await test('Get memory history', async () => {
    const history = await get(`/api/groups/${testGroup}/memory/test_config/history`);
    if (history.currentVersion !== 2) throw new Error('Version should be 2');
  }));

  results.push(await test('Store another memory key', async () => {
    await post(`/api/groups/${testGroup}/memory`, {
      agentId: testAgent1,
      key: 'project_status',
      value: { phase: 'testing', progress: 75 },
      memoryType: 'shared'
    });
  }));

  results.push(await test('Filter memory by keys', async () => {
    const memories = await get(`/api/groups/${testGroup}/memory?keys=test_config,project_status`);
    if (memories.length !== 2) throw new Error('Expected 2 memories');
  }));

  // Test group broadcasting
  results.push(await test('Broadcast to group', async () => {
    const result = await post(`/api/groups/${testGroup}/broadcast`, {
      from: testAgent1,
      content: 'Hello group!',
      messageType: 'direct'
    });
    console.log(`  → Sent to ${result.recipientCount} recipient(s)`);
  }));

  // Test enhanced messaging with timeout handling
  results.push(await test('Send message with timeout handling', async () => {
    const message = await post('/api/messages', {
      from: testAgent1,
      to: testAgent2,
      content: 'Test message with timeout',
      messageType: 'direct'
    });
    console.log(`  → Message ID: ${message.messageId}`);

    // Update message status
    await patch(`/api/messages/${message.messageId}/status`, {
      status: 'delivered'
    });
  }));

  results.push(await test('Update message status to completed', async () => {
    // Send a new message
    const message = await post('/api/messages', {
      from: testAgent1,
      to: testAgent2,
      content: 'Another test message',
      messageType: 'direct'
    });

    // Update to completed
    await patch(`/api/messages/${message.messageId}/status`, {
      status: 'completed'
    });
  }));

  results.push(await test('Test message timeout status', async () => {
    // Send a message
    const message = await post('/api/messages', {
      from: testAgent1,
      to: testAgent2,
      content: 'Timeout test message',
      messageType: 'direct'
    });

    // Mark as timeout
    await patch(`/api/messages/${message.messageId}/status`, {
      status: 'timeout',
      error: 'Simulated timeout'
    });

    // Check for failed messages
    const failed = await get(`/api/messages/${testAgent2}/failed`);
    if (!Array.isArray(failed)) throw new Error('Expected array of failed messages');
  }));

  results.push(await test('Retry failed message', async () => {
    // Send a message
    const message = await post('/api/messages', {
      from: testAgent1,
      to: testAgent2,
      content: 'Retry test message',
      messageType: 'direct'
    });

    // Mark as failed
    await patch(`/api/messages/${message.messageId}/status`, {
      status: 'failed',
      error: 'Processing failed'
    });

    // Retry it
    await post(`/api/messages/${message.messageId}/retry`);
  }));

  // Test cleanup
  results.push(await test('Delete memory key', async () => {
    await del(`/api/groups/${testGroup}/memory/project_status`, {
      agentId: testAgent1
    });
  }));

  results.push(await test('Remove agent from group', async () => {
    await del(`/api/groups/${testGroup}/members/${testAgent2}`);
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
