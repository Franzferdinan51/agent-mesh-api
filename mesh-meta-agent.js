#!/usr/bin/env node
/**
 * Mesh Meta-Agent — v4.0
 * Lightweight orchestrator for agent-mesh-api
 * Runs Gemma 4 E2B locally via LM Studio for fast mesh intelligence
 * 
 * What it does:
 * - Maintains mesh state cache (registry, capabilities, tasks)
 * - Routes tasks to best-fit agents
 * - Manages handoffs and context handoffs
 * - Tracks decisions and activity
 * - Provides summarization and status
 * 
 * Start: node mesh-meta-agent.js [--port 4001] [--mesh-url http://localhost:4000]
 */

import { WebSocketServer } from 'ws';
import { createClient } from './utils/mesh-client.js';

const META_AGENT_ID = 'MESH_META';
const META_AGENT_NAME = 'MeshMeta';
const PORT = parseInt(process.env.META_PORT || '4001');
const MESH_URL = process.env.MESH_URL || 'http://localhost:4000';
const API_KEY = process.env.AGENT_MESH_API_KEY || 'openclaw-mesh-default-key';
const LM_STUDIO_URL = process.env.LM_STUDIO_URL || 'http://localhost:1234';
const LM_STUDIO_KEY = process.env.LM_STUDIO_KEY || 'sk-lm-xxx';

const META_CAPABILITIES = [
  'mesh_orchestration', 'task_routing', 'capability_discovery',
  'decision_tracking', 'activity_monitoring', 'context_summarization',
  'handoff_management', 'mesh_intelligence'
];

// ─── State Cache ────────────────────────────────────────────────
const state = {
  agents: new Map(),        // agentId → { name, capabilities, state, lastSeen }
  groups: new Map(),         // groupId → { name, memberCount }
  tasks: new Map(),         // taskId → { state, assignedId, priority }
  decisions: [],            // recent decisions
  meshEvents: [],          // recent events for pattern detection
};

// ─── LM Studio Client ────────────────────────────────────────────
async function lmComplete(prompt, maxTokens = 256) {
  try {
    const resp = await fetch(`${LM_STUDIO_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LM_STUDIO_KEY}` },
      body: JSON.stringify({
        model: 'google/gemma-4-e2b-it',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature: 0.3,
      }),
    });
    if (!resp.ok) throw new Error(`LM Studio ${resp.status}`);
    const data = await resp.json();
    return data.choices?.[0]?.message?.content?.trim() || '';
  } catch (e) {
    return `[meta: lm error ${e.message}]`;
  }
}

// ─── Mesh Client ─────────────────────────────────────────────────
const mesh = createClient({ baseURL: MESH_URL, apiKey: API_KEY });

async function refreshState() {
  try {
    // Sync agents
    const agents = await mesh.getAgents();
    agents.forEach(a => state.agents.set(a.id, a));
    
    // Sync tasks
    const tasks = await mesh.getTasks({ state: 'pending' });
    tasks.forEach(t => state.tasks.set(t.id, t));
  } catch (e) {
    console.error('[meta] State refresh failed:', e.message);
  }
}

// ─── Intelligence Functions ─────────────────────────────────────
async function routeTask(task, requires) {
  const caps = requires ? requires.split(',').map(s => s.trim()) : [];
  const scored = [];
  
  for (const [id, agent] of state.agents) {
    const agentCaps = Array.isArray(agent.capabilities) ? agent.capabilities : [];
    const score = caps.filter(c => agentCaps.includes(c)).length
      + (agent.state === 'online' ? 5 : 0)
      + (agent.state === 'busy' ? -2 : 0);
    if (score > 0 || caps.length === 0) {
      scored.push({ id, name: agent.name, score, state: agent.state, capabilities: agentCaps });
    }
  }
  
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 3);
}

async function summarizeActivity(groupId, messageCount = 20) {
  const events = state.meshEvents.filter(e => e.groupId === groupId).slice(-messageCount);
  const prompt = `Summarize this group activity in 2-3 sentences:\n${events.map(e => `• ${e.action} by ${e.actor || 'unknown'}`).join('\n')}`;
  return lmComplete(prompt, 128);
}

async function suggestHandoff(task) {
  const prompt = `A task titled "${task.title || task}" needs to be handed off. Current assignee: ${task.assignedId || 'none'}. Available agents: ${Array.from(state.agents.values()).map(a => `${a.name}(${a.state})`).join(', ')}. Which agent should take this? Answer with just the agent name or 'none'.`;
  return lmComplete(prompt, 32);
}

async function detectPatterns() {
  if (state.meshEvents.length < 10) return null;
  const recent = state.meshEvents.slice(-20);
  const idleAgents = Array.from(state.agents.values()).filter(a => a.state === 'idle');
  const pendingTasks = Array.from(state.tasks.values()).filter(t => t.state === 'pending');
  
  if (idleAgents.length > 0 && pendingTasks.length > 0) {
    return `Idle agents available (${idleAgents.length}). Consider routing ${pendingTasks.length} pending tasks.`;
  }
  return null;
}

// ─── WebSocket to Mesh ───────────────────────────────────────────
let meshWs = null;

function connectMeshWS() {
  try {
    meshWs = new WebSocket(`ws://localhost:4000/ws`);
    
    meshWs.on('open', () => {
      console.log('[meta:ws] Connected to mesh');
      // Register as mesh meta agent
      meshWs.send(JSON.stringify({
        type: 'register',
        agentId: META_AGENT_ID,
        name: META_AGENT_NAME,
        capabilities: META_CAPABILITIES,
        endpoint: `http://localhost:${PORT}`,
      }));
    });
    
    meshWs.on('message', (data) => {
      try {
        const event = JSON.parse(data);
        state.meshEvents.push({ ...event, ts: Date.now() });
        if (state.meshEvents.length > 200) state.meshEvents.shift();
        
        // Update state from events
        if (event.type === 'agent_registered') state.agents.set(event.agentId, { id: event.agentId, name: event.name, state: 'online', capabilities: event.capabilities || [] });
        if (event.type === 'presence_changed') { const a = state.agents.get(event.agentId); if (a) a.state = event.state; }
        if (event.type === 'task_routed' || event.type === 'task_updated') refreshState();
      } catch (e) {}
    });
    
    meshWs.on('close', () => {
      console.log('[meta:ws] Disconnected, reconnecting in 10s...');
      setTimeout(connectMeshWS, 10000);
    });
    
    meshWs.on('error', () => meshWs.close());
  } catch (e) {
    setTimeout(connectMeshWS, 10000);
  }
}

// ─── Meta Agent HTTP API ────────────────────────────────────────
import http from 'http';

const metaServer = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  
  // Auth
  const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  if (apiKey !== API_KEY) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid API key' })); return; }
  
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  
  let body = '';
  req.on('data', d => body += d);
  await new Promise(r => req.on('end', r));
  let json = {};
  try { json = body ? JSON.parse(body) : {}; } catch (e) {}
  
  res.setHeader('Content-Type', 'application/json');
  
  try {
    // GET /status — mesh status
    if (path === '/status' && req.method === 'GET') {
      const agents = Array.from(state.agents.values());
      const groups = Array.from(state.groups.values());
      const tasks = Array.from(state.tasks.values());
      res.writeHead(200);
      res.end(JSON.stringify({
        service: 'mesh-meta-agent', version: '4.0', agentId: META_AGENT_ID,
        uptime: process.uptime(),
        mesh: { agents: agents.length, online: agents.filter(a => a.state === 'online').length, busy: agents.filter(a => a.state === 'busy').length },
        groups: groups.length,
        tasks: { total: tasks.length, pending: tasks.filter(t => t.state === 'pending').length },
        patterns: await detectPatterns(),
      }));
      return;
    }
    
    // POST /orchestrate — main meta-agent endpoint
    if (path === '/orchestrate' && req.method === 'POST') {
      const { action, payload } = json;
      
      if (action === 'route_task') {
        const { task, requires } = payload || {};
        const candidates = await routeTask(task, requires);
        const best = candidates[0];
        if (best) {
          // Create task in mesh
          const result = await mesh.createTask({ title: task, assignedId: best.id, priority: 5, createdBy: META_AGENT_ID });
          res.writeHead(200); res.end(JSON.stringify({ success: true, routedTo: best.name, taskId: result.id, candidates }));
        } else {
          res.writeHead(200); res.end(JSON.stringify({ success: false, error: 'No suitable agents found' }));
        }
        return;
      }
      
      if (action === 'summarize_activity') {
        const { groupId, messageCount } = payload || {};
        const summary = await summarizeActivity(groupId, messageCount || 20);
        res.writeHead(200); res.end(JSON.stringify({ success: true, summary, groupId }));
        return;
      }
      
      if (action === 'suggest_handoff') {
        const { taskId } = payload || {};
        const task = state.tasks.get(taskId);
        const suggestion = task ? await suggestHandoff(task) : '[task not found]';
        res.writeHead(200); res.end(JSON.stringify({ success: true, suggestion, taskId }));
        return;
      }
      
      if (action === 'mesh_insight') {
        const insight = await lmComplete(
          `You are MeshMeta, a mesh intelligence agent. Current state: ${state.agents.size} agents, ${state.tasks.size} tasks pending. Give one actionable insight for improving mesh coordination. Be brief (1 sentence).`,
          128
        );
        res.writeHead(200); res.end(JSON.stringify({ success: true, insight }));
        return;
      }
      
      res.writeHead(400); res.end(JSON.stringify({ error: `Unknown action: ${action}` }));
      return;
    }
    
    // GET /agents — cached agent list
    if (path === '/agents' && req.method === 'GET') {
      res.writeHead(200); res.end(JSON.stringify(Array.from(state.agents.values())));
      return;
    }
    
    // GET /tasks — cached task list
    if (path === '/tasks' && req.method === 'GET') {
      res.writeHead(200); res.end(JSON.stringify(Array.from(state.tasks.values())));
      return;
    }
    
    // GET /health
    if (path === '/health') {
      res.writeHead(200); res.end(JSON.stringify({ status: 'ok', service: 'mesh-meta-agent', ws: meshWs?.readyState === 1 ? 'connected' : 'disconnected' }));
      return;
    }
    
    res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
  } catch (e) {
    res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
  }
});

// ─── Boot ────────────────────────────────────────────────────────
async function main() {
  console.log(`[meta] Mesh Meta-Agent v4.0 starting...`);
  console.log(`[meta] Connecting to mesh at ${MESH_URL}`);
  console.log(`[meta] LM Studio: ${LM_STUDIO_URL}`);
  
  // Register on mesh
  try {
    await mesh.registerAgent({
      name: META_AGENT_NAME,
      endpoint: `http://localhost:${PORT}`,
      capabilities: META_CAPABILITIES,
    });
    console.log('[meta] Registered on mesh');
  } catch (e) {
    console.warn('[meta] Mesh registration failed:', e.message);
  }
  
  // Connect WebSocket
  connectMeshWS();
  
  // Initial state sync
  await refreshState();
  setInterval(refreshState, 30000); // refresh every 30s
  
  // Start HTTP API
  metaServer.listen(PORT, () => {
    console.log(`[meta] HTTP API: http://localhost:${PORT}`);
    console.log(`[meta] Endpoints:`);
    console.log(`[meta]   GET  /health           — health check`);
    console.log(`[meta]   GET  /status           — mesh intelligence summary`);
    console.log(`[meta]   GET  /agents           — cached agent list`);
    console.log(`[meta]   GET  /tasks            — cached task list`);
    console.log(`[meta]   POST /orchestrate      — meta-agent actions`);
    console.log(`[meta] Actions: route_task, summarize_activity, suggest_handoff, mesh_insight`);
  });
}

main().catch(console.error);
