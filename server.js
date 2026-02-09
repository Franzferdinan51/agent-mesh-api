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

// Optional: Serve the Web UI build (webui/dist)
// This is convenience for LAN/Tailscale usage.
try {
  const webuiDist = join(__dirname, 'webui', 'dist');
  app.use('/', express.static(webuiDist));
} catch (e) {
  // ignore
}

// Initialize SQLite
let db;
async function initDb() {
  const dbPath = join(__dirname, 'agent-mesh.db');

  db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });

  // Windows-safe SQLite settings (WAL mode has issues on Windows)
  await db.exec('PRAGMA journal_mode = DELETE;');
  await db.exec('PRAGMA synchronous = FULL;');
  await db.exec('PRAGMA busy_timeout = 5000;');
  await db.exec('PRAGMA foreign_keys = ON;');
  await db.exec('PRAGMA temp_store = MEMORY;');
  await db.exec('PRAGMA locking_mode = NORMAL;');

  console.log(`[DB] SQLite initialized: ${dbPath}`);
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
      to_agent TEXT NOT NULL,
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

// Auth middleware
function requireApiKey(req, res, next) {
  // Try multiple sources for the API key (header, query param, Authorization Bearer token)
  let key = req.headers['x-api-key'] || req.query.apiKey;

  // Also support Authorization: Bearer <token> header
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    key = authHeader.substring(7);
  }

  // Trim whitespace and validate
  if (!key || key.trim() !== API_KEY) {
    return res.status(401).json({
      error: 'Invalid or missing API key',
      expected: API_KEY,
      received: key ? `${key.substring(0, 3)}...` : 'none'
    });
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

// === AGENT GROUPS ===

// Create a new agent group
app.post('/api/groups', requireApiKey, async (req, res) => {
  try {
    const { name, description, createdBy, metadata } = req.body;

    if (!name || !createdBy) {
      return res.status(400).json({ error: 'name and createdBy are required' });
    }

    const id = uuidv4();
    await db.run(
      'INSERT INTO agent_groups (id, name, description, metadata, created_by) VALUES (?, ?, ?, ?, ?)',
      [id, name, description || null, JSON.stringify(metadata || {}), createdBy]
    );

    broadcast({
      type: 'group_created',
      group: { id, name, description, createdBy, metadata }
    });

    res.json({
      success: true,
      groupId: id,
      message: 'Agent group created successfully'
    });
  } catch (error) {
    console.error('[Error] Create group:', error);
    res.status(500).json({ error: error.message });
  }
});

// List all agent groups
app.get('/api/groups', requireApiKey, async (req, res) => {
  try {
    const groups = await db.all(`
      SELECT g.*,
        (SELECT COUNT(*) FROM agent_group_members WHERE group_id = g.id) as member_count
      FROM agent_groups g
      ORDER BY g.created_at DESC
    `);

    res.json(groups.map(g => ({
      ...g,
      metadata: JSON.parse(g.metadata || '{}')
    })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get specific group details with members
app.get('/api/groups/:id', requireApiKey, async (req, res) => {
  try {
    const group = await db.get('SELECT * FROM agent_groups WHERE id = ?', req.params.id);

    if (!group) {
      return res.status(404).json({ error: 'Group not found' });
    }

    const members = await db.all(`
      SELECT agm.*, a.name, a.endpoint, a.capabilities, a.last_seen
      FROM agent_group_members agm
      JOIN agents a ON agm.agent_id = a.id
      WHERE agm.group_id = ?
      ORDER BY agm.joined_at ASC
    `, req.params.id);

    res.json({
      ...group,
      metadata: JSON.parse(group.metadata || '{}'),
      members: members.map(m => ({
        ...m,
        capabilities: JSON.parse(m.capabilities || '[]')
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

    // Verify group exists
    const group = await db.get('SELECT id FROM agent_groups WHERE id = ?', req.params.groupId);
    if (!group) {
      return res.status(404).json({ error: 'Group not found' });
    }

    // Verify agent exists
    const agent = await db.get('SELECT id FROM agents WHERE id = ?', agentId);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    // Check if already a member
    const existing = await db.get(
      'SELECT * FROM agent_group_members WHERE group_id = ? AND agent_id = ?',
      [req.params.groupId, agentId]
    );

    if (existing) {
      return res.status(409).json({ error: 'Agent is already a member of this group' });
    }

    await db.run(
      'INSERT INTO agent_group_members (group_id, agent_id, role) VALUES (?, ?, ?)',
      [req.params.groupId, agentId, role]
    );

    broadcast({
      type: 'group_member_added',
      groupId: req.params.groupId,
      agentId,
      role
    });

    res.json({
      success: true,
      message: 'Agent added to group successfully'
    });
  } catch (error) {
    console.error('[Error] Add group member:', error);
    res.status(500).json({ error: error.message });
  }
});

// Remove agent from group
app.delete('/api/groups/:groupId/members/:agentId', requireApiKey, async (req, res) => {
  try {
    const result = await db.run(
      'DELETE FROM agent_group_members WHERE group_id = ? AND agent_id = ?',
      [req.params.groupId, req.params.agentId]
    );

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Group member not found' });
    }

    broadcast({
      type: 'group_member_removed',
      groupId: req.params.groupId,
      agentId: req.params.agentId
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
    const groups = await db.all(`
      SELECT g.*, agm.role
      FROM agent_groups g
      JOIN agent_group_members agm ON g.id = agm.group_id
      WHERE agm.agent_id = ?
      ORDER BY g.created_at DESC
    `, req.params.agentId);

    res.json(groups.map(g => ({
      ...g,
      metadata: JSON.parse(g.metadata || '{}')
    })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Discover agents in a group (for targeting)
app.get('/api/groups/:groupId/agents', requireApiKey, async (req, res) => {
  try {
    const agents = await db.all(`
      SELECT a.*, agm.role
      FROM agents a
      JOIN agent_group_members agm ON a.id = agm.agent_id
      WHERE agm.group_id = ?
      ORDER BY a.name ASC
    `, req.params.groupId);

    res.json(agents.map(a => ({
      ...a,
      capabilities: JSON.parse(a.capabilities || '[]')
    })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Send message to entire group
app.post('/api/groups/:groupId/broadcast', requireApiKey, async (req, res) => {
  try {
    const { from, content, messageType = 'direct' } = req.body;

    if (!from || !content) {
      return res.status(400).json({ error: 'from and content are required' });
    }

    // Get all agents in group except sender
    const agents = await db.all(`
      SELECT agm.agent_id
      FROM agent_group_members agm
      WHERE agm.group_id = ? AND agm.agent_id != ?
    `, [req.params.groupId, from]);

    if (agents.length === 0) {
      return res.status(404).json({ error: 'No agents found in group' });
    }

    const messageIds = [];
    for (const agent of agents) {
      const id = uuidv4();
      await db.run(
        'INSERT INTO messages (id, from_agent, to_agent, content, message_type, status) VALUES (?, ?, ?, ?, ?, ?)',
        [id, from, agent.agent_id, content, messageType, 'delivered']
      );
      messageIds.push(id);
    }

    broadcast({
      type: 'group_broadcast',
      groupId: req.params.groupId,
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
    console.error('[Error] Group broadcast:', error);
    res.status(500).json({ error: error.message });
  }
});

// === COLLECTIVE MEMORY ===

// Store shared memory in a group
app.post('/api/groups/:groupId/memory', requireApiKey, async (req, res) => {
  try {
    const { agentId, key, value, memoryType = 'shared' } = req.body;

    if (!agentId || !key || value === undefined) {
      return res.status(400).json({ error: 'agentId, key, and value are required' });
    }

    // Verify group exists and agent is a member
    const membership = await db.get(
      'SELECT * FROM agent_group_members WHERE group_id = ? AND agent_id = ?',
      [req.params.groupId, agentId]
    );

    if (!membership) {
      return res.status(403).json({ error: 'Agent is not a member of this group' });
    }

    // Check if memory key already exists
    const existing = await db.get(
      'SELECT * FROM collective_memory WHERE group_id = ? AND key = ?',
      [req.params.groupId, key]
    );

    let memoryId;
    if (existing) {
      // Update existing memory with version increment
      memoryId = existing.id;
      await db.run(
        'UPDATE collective_memory SET value = ?, agent_id = ?, memory_type = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [JSON.stringify(value), agentId, memoryType, memoryId]
      );
    } else {
      // Create new memory entry
      memoryId = uuidv4();
      await db.run(
        'INSERT INTO collective_memory (id, group_id, agent_id, key, value, memory_type) VALUES (?, ?, ?, ?, ?, ?)',
        [memoryId, req.params.groupId, agentId, key, JSON.stringify(value), memoryType]
      );
    }

    broadcast({
      type: 'memory_updated',
      groupId: req.params.groupId,
      memoryId,
      key,
      agentId
    });

    res.json({
      success: true,
      memoryId,
      version: existing ? existing.version + 1 : 1
    });
  } catch (error) {
    console.error('[Error] Store memory:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all memory keys for a group
app.get('/api/groups/:groupId/memory', requireApiKey, async (req, res) => {
  try {
    const { keys, memoryType } = req.query;
    let query = 'SELECT * FROM collective_memory WHERE group_id = ?';
    const params = [req.params.groupId];

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
      value: JSON.parse(m.value)
    })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get specific memory key
app.get('/api/groups/:groupId/memory/:key', requireApiKey, async (req, res) => {
  try {
    const memory = await db.get(
      'SELECT * FROM collective_memory WHERE group_id = ? AND key = ?',
      [req.params.groupId, req.params.key]
    );

    if (!memory) {
      return res.status(404).json({ error: 'Memory key not found' });
    }

    res.json({
      ...memory,
      value: JSON.parse(memory.value)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete memory key
app.delete('/api/groups/:groupId/memory/:key', requireApiKey, async (req, res) => {
  try {
    const { agentId } = req.body;

    if (!agentId) {
      return res.status(400).json({ error: 'agentId is required' });
    }

    // Verify membership
    const membership = await db.get(
      'SELECT * FROM agent_group_members WHERE group_id = ? AND agent_id = ?',
      [req.params.groupId, agentId]
    );

    if (!membership) {
      return res.status(403).json({ error: 'Agent is not a member of this group' });
    }

    const result = await db.run(
      'DELETE FROM collective_memory WHERE group_id = ? AND key = ?',
      [req.params.groupId, req.params.key]
    );

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Memory key not found' });
    }

    broadcast({
      type: 'memory_deleted',
      groupId: req.params.groupId,
      key: req.params.key,
      agentId
    });

    res.json({
      success: true,
      message: 'Memory deleted successfully'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get memory history (versions) for a key
app.get('/api/groups/:groupId/memory/:key/history', requireApiKey, async (req, res) => {
  try {
    // For full version history, we'd need a separate version table
    // For now, return current version info
    const memory = await db.get(
      'SELECT * FROM collective_memory WHERE group_id = ? AND key = ?',
      [req.params.groupId, req.params.key]
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
    res.status(500).json({ error: error.message });
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

    const validStatuses = ['pending', 'delivered', 'processing', 'completed', 'failed', 'timeout'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
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
    const messages = await db.all(`
      SELECT * FROM messages
      WHERE to_agent = ? AND status IN ('failed', 'timeout')
      ORDER BY created_at DESC
      LIMIT 50
    `, req.params.agentId);

    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: error.message });
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
    const { agentId, filename, fileType, fileData, description } = req.body;

    if (!agentId || !filename || !fileData) {
      return res.status(400).json({ error: 'agentId, filename, and fileData are required' });
    }

    // Verify agent exists
    const agent = await db.get('SELECT * FROM agents WHERE id = ?', agentId);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const id = uuidv4();
    const fileSize = Buffer.from(fileData, 'base64').length;

    await db.run(
      'INSERT INTO agent_files (id, agent_id, filename, file_type, file_size, file_data, description) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, agentId, filename, fileType || null, fileSize, fileData, description || null]
    );

    console.log(`[File Upload] Agent "${agent.name}" uploaded file: ${filename} (${fileSize} bytes)`);

    // Broadcast file availability
    broadcast({
      type: 'file_available',
      file: { id, agentId, filename, fileType, fileSize, description }
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
    res.status(500).json({ error: error.message });
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
    const { agentId } = req.query;

    let query = 'SELECT * FROM agent_files ORDER BY created_at DESC';
    let params = [];

    if (agentId) {
      query = 'SELECT * FROM agent_files WHERE agent_id = ? ORDER BY created_at DESC';
      params = [agentId];
    }

    const files = await db.all(query, params);
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
    const { agentId } = req.body;

    if (!agentId) {
      return res.status(400).json({ error: 'agentId is required for deletion' });
    }

    const file = await db.get('SELECT * FROM agent_files WHERE id = ?', req.params.id);

    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Verify ownership
    if (file.agent_id !== agentId) {
      return res.status(403).json({ error: 'You can only delete your own files' });
    }

    await db.run('DELETE FROM agent_files WHERE id = ?', req.params.id);

    console.log(`[File Delete] File deleted: ${req.params.id}`);

    res.json({
      success: true,
      message: 'File deleted successfully'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// === SYSTEM UPDATES ===

// Create system update
app.post('/api/updates', requireApiKey, async (req, res) => {
  try {
    const { version, updateType, title, description, requiredVersion, breakingChange, announcement } = req.body;

    if (!version || !updateType || !title) {
      return res.status(400).json({ error: 'version, updateType, and title are required' });
    }

    const id = uuidv4();
    await db.run(
      'INSERT INTO system_updates (id, version, update_type, title, description, required_version, breaking_change, announcement, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, version, updateType, title, description || null, requiredVersion || null, breakingChange || false, announcement || null, 'DuckBot']
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

    let query = 'SELECT * FROM system_updates ORDER BY created_at DESC';
    let params = [];

    if (since) {
      query = 'SELECT * FROM system_updates WHERE created_at > ? ORDER BY created_at DESC';
      params = [since];
    }

    if (activeOnly === 'true') {
      query = 'SELECT * FROM system_updates WHERE expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP ORDER BY created_at DESC';
    }

    const updates = await db.all(query, params);
    res.json(updates);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Acknowledge update
app.post('/api/updates/:id/acknowledge', requireApiKey, async (req, res) => {
  try {
    const { agentId, status, agentVersion, notes } = req.body;

    if (!agentId || !status) {
      return res.status(400).json({ error: 'agentId and status are required' });
    }

    // Check if update exists
    const update = await db.get('SELECT * FROM system_updates WHERE id = ?', req.params.id);
    if (!update) {
      return res.status(404).json({ error: 'Update not found' });
    }

    const id = uuidv4();
    await db.run(
      'INSERT INTO update_acknowledgments (id, update_id, agent_id, agent_version, status, notes) VALUES (?, ?, ?, ?, ?, ?)',
      [id, req.params.id, agentId, agentVersion || null, status, notes || null]
    );

    console.log(`[Update Acknowledgment] Agent ${agentId} acknowledged update ${req.params.id}: ${status}`);

    res.json({
      success: true,
      message: 'Update acknowledged',
      acknowledgmentId: id
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
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

    let query = 'SELECT * FROM catastrophe_events ORDER BY occurred_at DESC';
    let params = [];

    if (statusFilter) {
      query = 'SELECT * FROM catastrophe_events WHERE status = ? ORDER BY occurred_at DESC';
      params = [statusFilter];
    }

    if (severityFilter) {
      query = 'SELECT * FROM catastrophe_events WHERE severity = ? ORDER BY occurred_at DESC';
      params = [severityFilter];
    }

    const catastrophes = await db.all(query, params);
    res.json(catastrophes.map(c => ({
      ...c,
      affectedAgents: JSON.parse(c.affected_agents || '[]')
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

// Enhanced heartbeat with health metrics
app.post('/api/agents/:id/health', requireApiKey, async (req, res) => {
  try {
    const { status, uptimeSeconds, cpuUsage, memoryUsage, customMetrics } = req.body;

    await db.run(
      `INSERT OR REPLACE INTO agent_health_status
       (agent_id, status, last_heartbeat, uptime_seconds, cpu_usage, memory_usage, custom_metrics, last_updated)
       VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [req.params.id, status || 'healthy', uptimeSeconds || null, cpuUsage || null, memoryUsage || null, JSON.stringify(customMetrics || {})]
    );

    // Broadcast health status change
    broadcast({
      type: 'agent_health_change',
      agentId: req.params.id,
      status: status || 'healthy',
      metrics: { uptimeSeconds, cpuUsage, memoryUsage, customMetrics }
    });

    res.json({ success: true, message: 'Health status updated' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get agent health details
app.get('/api/agents/:id/health', requireApiKey, async (req, res) => {
  try {
    const health = await db.get('SELECT * FROM agent_health_status WHERE agent_id = ?', req.params.id);

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
      customMetrics: JSON.parse(health.custom_metrics || '{}'),
      lastUpdated: health.last_updated
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health dashboard summary
app.get('/api/health/dashboard', requireApiKey, async (req, res) => {
  try {
    // Get health summary
    const healthSummary = await db.all(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'healthy') as healthy,
        COUNT(*) FILTER (WHERE status = 'degraded') as degraded,
        COUNT(*) FILTER (WHERE status = 'unhealthy') as unhealthy,
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

    // Calculate offline agents (no heartbeat in 5 minutes)
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const offlineCount = await db.get(
      'SELECT COUNT(*) as count FROM agents WHERE last_seen < ?',
      [fiveMinutesAgo]
    );

    res.json({
      totalAgents: healthSummary[0].total || 0,
      healthy: healthSummary[0].healthy || 0,
      degraded: healthSummary[0].degraded || 0,
      unhealthy: healthSummary[0].unhealthy || 0,
      offline: offlineCount.count || 0,
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

// === TIMEOUT HANDLING UTILITIES ===

// Check for timed out messages (runs periodically)
const MESSAGE_TIMEOUT = parseInt(process.env.MESSAGE_TIMEOUT || '300000'); // 5 minutes default

async function checkMessageTimeouts() {
  try {
    const timeoutDate = new Date(Date.now() - MESSAGE_TIMEOUT).toISOString();

    const timedOutMessages = await db.all(`
      SELECT * FROM messages
      WHERE status IN ('pending', 'processing')
      AND created_at < ?
      AND timeout_ms IS NOT NULL
    `, timeoutDate);

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
        createdAt: msg.created_at
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
setInterval(checkMessageTimeouts, 60000);

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
╚══════════════════════════════════════════════════════════╝
    `);
  });
}

start().catch(console.error);
