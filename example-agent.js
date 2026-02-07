/**
 * Example OpenClaw Agent using Agent Mesh
 * Demonstrates how to connect and communicate with other agents
 */

import tools from './tools.js';
import { MeshWebSocketClient } from './websocket-client.js';

async function main() {
  console.log('=== OpenClaw Agent Mesh Example ===\n');

  // Step 1: Register with the mesh
  console.log('1. Registering with Agent Mesh...');
  const registerResult = await tools.mesh_register({
    name: 'ExampleAgent',
    endpoint: 'http://localhost:3000',
    capabilities: ['messaging', 'task_execution', 'web_search']
  });

  if (!registerResult.success) {
    console.error('Registration failed:', registerResult.error);
    return;
  }

  console.log('   Registered! Agent ID:', registerResult.agentId);

  // Step 2: List other agents
  console.log('\n2. Discovering other agents...');
  const agentsResult = await tools.mesh_list_agents();
  if (agentsResult.success) {
    console.log(`   Found ${agentsResult.count} agents:`);
    agentsResult.agents.forEach(agent => {
      console.log(`   - ${agent.name} (${agent.id})`);
    });
  }

  // Step 3: Check for messages
  console.log('\n3. Checking for messages...');
  const messagesResult = await tools.mesh_get_messages({ unreadOnly: true });
  if (messagesResult.success && messagesResult.messages.length > 0) {
    console.log(`   Found ${messagesResult.count} unread messages:`);
    messagesResult.messages.forEach(msg => {
      console.log(`   [${msg.from}]: ${msg.content}`);
      // Mark as read
      tools.mesh_mark_read({ messageId: msg.id });
    });
  } else {
    console.log('   No unread messages');
  }

  // Step 4: Send a test message (if there are other agents)
  if (agentsResult.success && agentsResult.agents.length > 1) {
    const otherAgent = agentsResult.agents.find(a => a.id !== registerResult.agentId);
    if (otherAgent) {
      console.log(`\n4. Sending test message to ${otherAgent.name}...`);
      const sendResult = await tools.mesh_send_message({
        to: otherAgent.id,
        content: 'Hello from ExampleAgent! This is a test message.'
      });

      if (sendResult.success) {
        console.log('   Message sent! ID:', sendResult.messageId);
      }
    }
  }

  // Step 5: Start WebSocket for real-time messages
  console.log('\n5. Starting WebSocket for real-time messages...');
  const wsClient = new MeshWebSocketClient();

  wsClient.on('message', (msg) => {
    console.log('\n📨 New message received:');
    console.log(`   From: ${msg.from}`);
    console.log(`   Content: ${msg.content}`);
    console.log('');
  });

  wsClient.on('broadcast', (msg) => {
    console.log('\n📢 Broadcast received:');
    console.log(`   From: ${msg.from}`);
    console.log(`   Content: ${msg.content}`);
    console.log('');
  });

  await wsClient.loadAgentId();
  wsClient.connect();

  // Step 6: Regular heartbeat
  console.log('6. Starting heartbeat...');
  setInterval(() => {
    tools.mesh_heartbeat();
  }, 30000);

  // Step 7: Regular message polling (fallback)
  console.log('7. Starting message polling (every 60s)...');
  setInterval(async () => {
    const result = await tools.mesh_get_messages({ unreadOnly: true });
    if (result.success && result.messages.length > 0) {
      console.log(`\n📬 Polled ${result.count} new messages`);
      result.messages.forEach(msg => {
        console.log(`   [${msg.from}]: ${msg.content.substring(0, 50)}...`);
        tools.mesh_mark_read({ messageId: msg.id });
      });
    }
  }, 60000);

  console.log('\n✅ Agent is running! Press Ctrl+C to stop.\n');
}

main().catch(console.error);
