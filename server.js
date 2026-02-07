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
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 4000;
const API_KEY = process.env.AGENT_MESH_API_KEY || 'openclaw-mesh-default-key';

// Middleware
app.use(cors());
app.use(express.json());

// Initialize SQLite
let db;
async function initDb() {
  db = await open({
    filename: join(__dirname, 'agent-mesh.db'),
    driver: sqlite3.Database
  });
  
  await db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      endpoint TEXT,
      capabilities TEXT,
      last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      content TEXT NOT NULL,
      message_type TEXT DEFAULT 'direct',
      read BOOLEAN DEFAULT 0,
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
  `);
  
  console.log('[DB] SQLite initialized');
}

// Auth middleware
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.apiKey;
  if (key !== API_KEY) {
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }
  next();
}

// === AGENT REGISTRY ===

// Register agent
app.post('/api/agents/register', requireApiKey, async (req, res) => {
  try {
    const { name, endpoint, capabilities } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }
    
    const id = uuidv4();
    await db.run(
      'INSERT INTO agents (id, name, endpoint, capabilities) VALUES (?, ?, ?, ?)',
      [id, name, endpoint || null, JSON.stringify(capabilities || [])]
    );
    
    // Broadcast to all connected WebSocket clients
    broadcast({
      type: 'agent_joined',
      agent: { id, name, endpoint, capabilities }
    });
    
    res.json({ 
      success: true, 
      agentId: id,
      message: 'Agent registered successfully'
    });
  } catch (error) {
    console.error('[Error] Register agent:', error);
    res.status(500).json({ error: error.message });
  }
});

// List agents
app.get('/api/agents', requireApiKey, async (req, res) => {
  try {
    const agents = await db.all('SELECT * FROM agents ORDER BY last_seen DESC');
    res.json(agents.map(a => ({
      ...a,
      capabilities: JSON.parse(a.capabilities || '[]')
    })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get single agent
app.get('/api/agents/:id', requireApiKey, async (req, res) => {
  try {
    const agent = await db.get('SELECT * FROM agents WHERE id = ?', req.params.id);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    res.json({
      ...agent,
      capabilities: JSON.parse(agent.capabilities || '[]')
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Heartbeat - update last_seen
app.post('/api/agents/:id/heartbeat', requireApiKey, async (req, res) => {
  try {
    await db.run(
      'UPDATE agents SET last_seen = CURRENT_TIMESTAMP WHERE id = ?',
      req.params.id
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// === MESSAGING ===

// Send message
app.post('/api/messages', requireApiKey, async (req, res) => {
  try {
    const { from, to, content, messageType = 'direct' } = req.body;
    
    if (!from || !to || !content) {
      return res.status(400).json({ error: 'from, to, and content are required' });
    }
    
    const id = uuidv4();
    await db.run(
      'INSERT INTO messages (id, from_agent, to_agent, content, message_type) VALUES (?, ?, ?, ?, ?)',
      [id, from, to, content, messageType]
    );
    
    const message = { id, from, to, content, messageType, createdAt: new Date().toISOString() };
    
    // WebSocket broadcast
    broadcast({
      type: 'new_message',
      message
    });
    
    res.json({ success: true, messageId: id, message });
  } catch (error) {
    console.error('[Error] Send message:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get messages for agent
app.get('/api/messages/:agentId', requireApiKey, async (req, res) => {
  try {
    const { since, unreadOnly } = req.query;
    
    let query = 'SELECT * FROM messages WHERE to_agent = ?';
    const params = [req.params.agentId];
    
    if (since) {
      query += ' AND created_at > ?';
      params.push(since);
    }
    
    if (unreadOnly === 'true') {
      query += ' AND read = 0';
    }
    
    query += ' ORDER BY created_at DESC';
    
    const messages = await db.all(query, params);
    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Mark message as read
app.post('/api/messages/:id/read', requireApiKey, async (req, res) => {
  try {
    await db.run('UPDATE messages SET read = 1 WHERE id = ?', req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Broadcast to all agents
app.post('/api/broadcast', requireApiKey, async (req, res) => {
  try {
    const { from, content } = req.body;
    
    if (!from || !content) {
      return res.status(400).json({ error: 'from and content are required' });
    }
    
    // Get all agents
    const agents = await db.all('SELECT id FROM agents WHERE id != ?', from);
    
    const messageIds = [];
    for (const agent of agents) {
      const id = uuidv4();
      await db.run(
        'INSERT INTO messages (id, from_agent, to_agent, content, message_type) VALUES (?, ?, ?, ?, ?)',
        [id, from, agent.id, content, 'broadcast']
      );
      messageIds.push(id);
    }
    
    // WebSocket broadcast
    broadcast({
      type: 'broadcast',
      from,
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
    res.status(500).json({ error: error.message });
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
    const { from, payload } = req.body;
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
      [messageId, from, skill.agent_id, content, 'skill_invocation']
    );
    
    broadcast({
      type: 'skill_invoked',
      skillId: skill.id,
      skillName: skill.name,
      from,
      to: skill.agent_id
    });
    
    res.json({ success: true, invocationId: messageId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'agent-mesh-api',
    timestamp: new Date().toISOString()
  });
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
  
  server.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║  Agent Mesh API Server                                   ║
║  Agent-to-Agent Communication for OpenClaw               ║
╠══════════════════════════════════════════════════════════╣
║  HTTP:  http://localhost:${PORT}                         ║
║  WS:    ws://localhost:${PORT}/ws                        ║
╠══════════════════════════════════════════════════════════╣
║  Endpoints:                                              ║
║    POST /api/agents/register   - Register agent          ║
║    GET  /api/agents            - List agents             ║
║    POST /api/messages          - Send message            ║
║    GET  /api/messages/:id      - Get messages            ║
║    POST /api/broadcast         - Broadcast to all        ║
║    POST /api/skills            - Register skill          ║
║    GET  /api/skills            - Discover skills         ║
║    POST /api/skills/:id/invoke - Invoke skill            ║
╚══════════════════════════════════════════════════════════╝
    `);
  });
}

start().catch(console.error);
