/**
 * Agent Mesh WebSocket Client
 * Real-time messaging for OpenClaw agents
 */

import WebSocket from 'ws';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const WS_URL = process.env.AGENT_MESH_WS_URL || 'ws://localhost:4000/ws';
const RECONNECT_INTERVAL = 5000;
const HEARTBEAT_INTERVAL = 30000;

class MeshWebSocketClient {
  constructor() {
    this.ws = null;
    this.agentId = null;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.messageHandlers = [];
    this.isConnected = false;
  }

  async loadAgentId() {
    try {
      const savedId = await fs.readFile(
        path.join(__dirname, '.agent-id'),
        'utf8'
      );
      this.agentId = savedId.trim();
      console.log(`[WS] Loaded agent ID: ${this.agentId}`);
    } catch (e) {
      console.log('[WS] No saved agent ID found. Register first.');
    }
  }

  connect() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    console.log(`[WS] Connecting to ${WS_URL}...`);

    this.ws = new WebSocket(WS_URL);

    this.ws.on('open', () => {
      console.log('[WS] Connected to Agent Mesh');
      this.isConnected = true;

      // Register with agent ID if available
      if (this.agentId) {
        this.send({
          type: 'register_agent',
          agentId: this.agentId
        });
      }

      // Start heartbeat
      this.startHeartbeat();

      // Notify handlers
      this.emit('connected');
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        console.log('[WS] Received:', msg.type);

        // Handle different message types
        if (msg.type === 'new_message') {
          this.emit('message', msg.message);
        } else if (msg.type === 'broadcast') {
          this.emit('broadcast', msg);
        } else if (msg.type === 'skill_invoked') {
          this.emit('skill_invoked', msg);
        } else if (msg.type === 'connected') {
          console.log('[WS] Server acknowledged connection:', msg.clientId);
        }

        // Notify all handlers
        this.messageHandlers.forEach(handler => handler(msg));
      } catch (error) {
        console.error('[WS] Error parsing message:', error);
      }
    });

    this.ws.on('error', (error) => {
      console.error('[WS] Error:', error.message);
      this.emit('error', error);
    });

    this.ws.on('close', () => {
      console.log('[WS] Disconnected');
      this.isConnected = false;
      this.stopHeartbeat();
      this.emit('disconnected');

      // Auto-reconnect
      console.log(`[WS] Reconnecting in ${RECONNECT_INTERVAL}ms...`);
      this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_INTERVAL);
    });
  }

  send(data) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    } else {
      console.log('[WS] Cannot send - not connected');
    }
  }

  startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: 'heartbeat' });
    }, HEARTBEAT_INTERVAL);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  disconnect() {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  // Event handling
  on(event, handler) {
    if (!this._events) this._events = {};
    if (!this._events[event]) this._events[event] = [];
    this._events[event].push(handler);
  }

  emit(event, data) {
    if (this._events?.[event]) {
      this._events[event].forEach(handler => handler(data));
    }
  }

  // Add message handler
  addMessageHandler(handler) {
    this.messageHandlers.push(handler);
  }

  removeMessageHandler(handler) {
    this.messageHandlers = this.messageHandlers.filter(h => h !== handler);
  }
}

// Run as standalone client
if (import.meta.url === `file://${process.argv[1]}`) {
  const client = new MeshWebSocketClient();

  // Load agent ID and connect
  await client.loadAgentId();

  // Handle incoming messages
  client.on('message', (msg) => {
    console.log('\n[New Message]');
    console.log(`From: ${msg.from}`);
    console.log(`Content: ${msg.content}`);
    console.log('');
  });

  client.on('broadcast', (msg) => {
    console.log('\n[Broadcast]');
    console.log(`From: ${msg.from}`);
    console.log(`Content: ${msg.content}`);
    console.log('');
  });

  client.on('connected', () => {
    console.log('[Status] Connected and ready');
  });

  client.on('disconnected', () => {
    console.log('[Status] Disconnected, reconnecting...');
  });

  // Connect
  client.connect();

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n[WS] Shutting down...');
    client.disconnect();
    process.exit(0);
  });

  // Keep process alive
  console.log('[WS] Client running. Press Ctrl+C to stop.');
}

export default MeshWebSocketClient;
export { MeshWebSocketClient };
