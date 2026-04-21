/**
 * Agent Mesh Tools for OpenClaw
 * HTTP client for Agent Mesh API
 */
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load configuration
let config = {};
try {
  const data = await fs.readFile(path.join(__dirname, 'config.json'), 'utf8');
  config = JSON.parse(data);
} catch (e) { /* use defaults */ }

const MESH_URL = config.meshServerUrl || process.env.AGENT_MESH_URL || 'http://localhost:4000';
const API_KEY = config.apiKey || process.env.AGENT_MESH_API_KEY || 'openclaw-mesh-default-key';

const api = axios.create({
  baseURL: MESH_URL,
  headers: {
    'X-API-Key': API_KEY,
    'Content-Type': 'application/json'
  },
  timeout: 30000
});

let agentId = null;

export const tools = {
    async mesh_register(params = {}) {
      const name = params.name || config.agentName || 'OpenClawAgent';
      const endpoint = params.endpoint || config.agentEndpoint;
      const capabilities = params.capabilities || config.capabilities || ['messaging'];

      try {
        const response = await api.post('/api/agents/register', {
          name,
          endpoint,
          capabilities
        });

        agentId = response.data.agentId;

        // Save agent ID for future use
        try {
          await fs.writeFile(
            path.join(__dirname, '.agent-id'),
            agentId,
            'utf8'
          );
        } catch (e) {
          // Ignore write errors
        }

        return {
          success: true,
          agentId: agentId,
          message: response.data.message
        };
      } catch (error) {
        return {
          success: false,
          error: error.response?.data?.error || error.message
        };
      }
    },
    async mesh_send_message(params) {
      const from = agentId || params.from;
      const to = params.to;
      const content = params.content;

      if (!from || !to || !content) {
        return { error: 'from, to, and content are required' };
      }

      try {
        const response = await api.post('/api/messages', {
          from,
          to,
          content
        });

        return {
          success: true,
          messageId: response.data.messageId,
          message: response.data.message
        };
      } catch (error) {
        return {
          success: false,
          error: error.response?.data?.error || error.message
        };
      }
    },
    async mesh_get_messages(params = {}) {
      const id = agentId || params.agentId;

      if (!id) {
        return { error: 'Agent not registered. Call mesh_register first.' };
      }

      try {
        const queryParams = new URLSearchParams();
        if (params.unreadOnly) queryParams.append('unreadOnly', 'true');
        if (params.since) queryParams.append('since', params.since);

        const url = `/api/messages/${id}?${queryParams.toString()}`;
        const response = await api.get(url);

        return {
          success: true,
          messages: response.data,
          count: response.data.length
        };
      } catch (error) {
        return {
          success: false,
          error: error.response?.data?.error || error.message
        };
      }
    },
    async mesh_mark_read(params) {
      const messageId = params.messageId || params.id;

      if (!messageId) {
        return { error: 'messageId is required' };
      }

      try {
        await api.post(`/api/messages/${messageId}/read`);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error.response?.data?.error || error.message
        };
      }
    },
    async mesh_broadcast(params) {
      const from = agentId || params.from;
      const content = params.content;

      if (!from || !content) {
        return { error: 'from and content are required' };
      }

      try {
        const response = await api.post('/api/broadcast', {
          from,
          content
        });

        return {
          success: true,
          recipientCount: response.data.recipientCount
        };
      } catch (error) {
        return {
          success: false,
          error: error.response?.data?.error || error.message
        };
      }
    },
    async mesh_list_agents() {
      try {
        const response = await api.get('/api/agents');
        return {
          success: true,
          agents: response.data,
          count: response.data.length
        };
      } catch (error) {
        return {
          success: false,
          error: error.response?.data?.error || error.message
        };
      }
    },
    async mesh_heartbeat() {
      const id = agentId;

      if (!id) {
        return { error: 'Agent not registered' };
      }

      try {
        await api.post(`/api/agents/${id}/heartbeat`);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error.response?.data?.error || error.message
        };
      }
    },
    async mesh_register_skill(params) {
      const agentId = agentId || params.agentId;
      const name = params.name;
      const description = params.description;
      const endpoint = params.endpoint;

      if (!agentId || !name) {
        return { error: 'agentId and name are required' };
      }

      try {
        const response = await api.post('/api/skills', {
          agentId,
          name,
          description,
          endpoint
        });

        return {
          success: true,
          skillId: response.data.skillId
        };
      } catch (error) {
        return {
          success: false,
          error: error.response?.data?.error || error.message
        };
      }
    },
    async mesh_discover_skills() {
      try {
        const response = await api.get('/api/skills');
        return {
          success: true,
          skills: response.data,
          count: response.data.length
        };
      } catch (error) {
        return {
          success: false,
          error: error.response?.data?.error || error.message
        };
      }
    },
    async mesh_invoke_skill(params) {
      const skillId = params.skillId || params.id;
      const from = agentId || params.from;
      const payload = params.payload || {};

      if (!skillId || !from) {
        return { error: 'skillId and from are required' };
      }

      try {
        const response = await api.post(`/api/skills/${skillId}/invoke`, {
          from,
          payload
        });

        return {
          success: true,
          invocationId: response.data.invocationId
        };
      } catch (error) {
        return {
          success: false,
          error: error.response?.data?.error || error.message
        };
      }
    },
    async mesh_group_create(params) {
      const name = params.name;
      const description = params.description || '';
      if (!name) return { error: 'name is required' };
      try {
        const response = await api.post('/api/groups', { name, description });
        return { success: true, groupId: response.data.id, name };
      } catch (error) {
        return { success: false, error: error.response?.data?.error || error.message };
      }
    },
    async mesh_group_add_member(params) {
      const groupId = params.groupId || params.name;
      const agentId = params.agentId;
      if (!groupId || !agentId) return { error: 'groupId and agentId are required' };
      try {
        await api.post(`/api/groups/${groupId}/members`, { agentId });
        return { success: true };
      } catch (error) {
        return { success: false, error: error.response?.data?.error || error.message };
      }
    },
    async mesh_group_broadcast(params) {
      const groupId = params.groupId || params.name;
      const from = agentId || params.from;
      const content = params.content;
      if (!groupId || !from || !content) return { error: 'groupId, from, and content are required' };
      try {
        const response = await api.post(`/api/groups/${groupId}/broadcast`, { from, content });
        return { success: true, recipientCount: response.data.recipientCount };
      } catch (error) {
        return { success: false, error: error.response?.data?.error || error.message };
      }
    },
    async mesh_group_info(params) {
      const groupId = params.groupId || params.name;
      if (!groupId) return { error: 'groupId is required' };
      try {
        const response = await api.get(`/api/groups/${groupId}`);
        return { success: true, group: response.data };
      } catch (error) {
        return { success: false, error: error.response?.data?.error || error.message };
      }
    },
    async mesh_list_groups() {
      try {
        const response = await api.get('/api/groups');
        return { success: true, groups: response.data, count: response.data.length };
      } catch (error) {
        return { success: false, error: error.response?.data?.error || error.message };
      }
    },
    async mesh_memory_store(params) {
      const groupId = params.groupId || params.name;
      const key = params.key;
      const value = params.value;
      if (!groupId || !key || value === undefined) return { error: 'groupId, key, and value are required' };
      try {
        const response = await api.post(`/api/groups/${groupId}/memory`, { key, value });
        return { success: true, version: response.data.version };
      } catch (error) {
        return { success: false, error: error.response?.data?.error || error.message };
      }
    },
    async mesh_memory_get(params) {
      const groupId = params.groupId || params.name;
      const key = params.key;
      if (!groupId) return { error: 'groupId is required' };
      try {
        const url = key ? `/api/groups/${groupId}/memory/${key}` : `/api/groups/${groupId}/memory`;
        const response = await api.get(url);
        return { success: true, data: response.data };
      } catch (error) {
        return { success: false, error: error.response?.data?.error || error.message };
      }
    },
    async mesh_bulk_register(params) {
      const agents = params.agents;
      if (!agents || !Array.isArray(agents)) return { error: 'agents array is required' };
      try {
        const response = await api.post('/api/agents/bulk-register', { agents });
        return { success: true, results: response.data };
      } catch (error) {
        return { success: false, error: error.response?.data?.error || error.message };
      }
    },
    async mesh_batch_send(params) {
      const messages = params.messages;
      if (!messages || !Array.isArray(messages)) return { error: 'messages array is required' };
      try {
        const response = await api.post('/api/messages/batch', { messages });
        return { success: true, results: response.data };
      } catch (error) {
        return { success: false, error: error.response?.data?.error || error.message };
      }
    },
    async mesh_health_dashboard() {
      try {
        const response = await api.get('/api/health');
        return { success: true, health: response.data };
      } catch (error) {
        return { success: false, error: error.response?.data?.error || error.message };
      }
    },
    async mesh_stats() {
      try {
        const response = await api.get('/api/stats');
        return { success: true, stats: response.data };
      } catch (error) {
        return { success: false, error: error.response?.data?.error || error.message };
      }
    },
    async mesh_ping(params) {
      const agentIdOrName = params.agentId || params.name;
      if (!agentIdOrName) return { error: 'agentId or name is required' };
      try {
        const response = await api.post(`/api/agents/ping/${agentIdOrName}`);
        return { success: true, result: response.data };
      } catch (error) {
        return { success: false, error: error.response?.data?.error || error.message };
      }
    },
    async mesh_capabilities() {
      try {
        const response = await api.get('/api/capabilities');
        return { success: true, capabilities: response.data };
      } catch (error) {
        return { success: false, error: error.response?.data?.error || error.message };
      }
    },
    async mesh_presence_update(params = {}) {
      try {
        const { state, statusMessage, capabilities, bandwidthUpload, bandwidthDownload, storageFreeGb } = params;
        const response = await api.patch('/api/agents/' + agentId + '/presence', { state, statusMessage, capabilities, bandwidthUpload, bandwidthDownload, storageFreeGb });
        return response.data;
      } catch (error) { return { success: false, error: error.response?.data?.error || error.message }; }
    },
    async mesh_presence_get(params = {}) {
      try {
        const { targetAgentId } = params;
        const response = await api.get('/api/agents/' + targetAgentId + '/presence');
        return response.data;
      } catch (error) { return { success: false, error: error.response?.data?.error || error.message }; }
    },
    async mesh_presence_list(params = {}) {
      try {
        const { state, capability } = params;
        const p = {}; if (state) p.state = state; if (capability) p.capability = capability;
        const response = await api.get('/api/presence', { params: p });
        return { success: true, agents: response.data };
      } catch (error) { return { success: false, error: error.response?.data?.error || error.message }; }
    },
    async mesh_route_task(params = {}) {
      try {
        const { task, requiresCapabilities, priority } = params;
        const response = await api.post('/api/mesh/route', { task, requiresCapabilities, priority });
        return response.data;
      } catch (error) { return { success: false, error: error.response?.data?.error || error.message }; }
    },
    async mesh_thread_create(params = {}) {
      try {
        const { groupId, parentId, title, context } = params;
        const response = await api.post('/api/threads', { groupId, parentId, title, context, createdBy: agentId });
        return response.data;
      } catch (error) { return { success: false, error: error.response?.data?.error || error.message }; }
    },
    async mesh_thread_list(params = {}) {
      try {
        const { groupId, parentId } = params;
        const p = {}; if (groupId) p.groupId = groupId; if (parentId) p.parentId = parentId;
        const response = await api.get('/api/threads', { params: p });
        return { success: true, threads: response.data };
      } catch (error) { return { success: false, error: error.response?.data?.error || error.message }; }
    },
    async mesh_thread_get(params = {}) {
      try {
        const { threadId } = params;
        const response = await api.get('/api/threads/' + threadId);
        return response.data;
      } catch (error) { return { success: false, error: error.response?.data?.error || error.message }; }
    },
    async mesh_thread_message(params = {}) {
      try {
        const { threadId, to, content, intent, priority } = params;
        const response = await api.post('/api/threads/' + threadId + '/messages', { from: agentId, to, content, intent, priority });
        return response.data;
      } catch (error) { return { success: false, error: error.response?.data?.error || error.message }; }
    },
    async mesh_reaction_add(params = {}) {
      try {
        const { messageId, emoji } = params;
        const response = await api.post('/api/messages/' + messageId + '/reactions', { agentId, emoji });
        return response.data;
      } catch (error) { return { success: false, error: error.response?.data?.error || error.message }; }
    },
    async mesh_reaction_list(params = {}) {
      try {
        const { messageId } = params;
        const response = await api.get('/api/messages/' + messageId + '/reactions');
        return response.data;
      } catch (error) { return { success: false, error: error.response?.data?.error || error.message }; }
    },
    async mesh_activity_log(params = {}) {
      try {
        const { groupId, action, targetType, targetId, metadata } = params;
        const response = await api.post('/api/groups/' + groupId + '/activity', { actorId: agentId, action, targetType, targetId, metadata });
        return response.data;
      } catch (error) { return { success: false, error: error.response?.data?.error || error.message }; }
    },
    async mesh_activity_feed(params = {}) {
      try {
        const { groupId, limit } = params;
        const response = await api.get('/api/groups/' + groupId + '/activity', { params: { limit: limit || 50 } });
        return { success: true, feed: response.data };
      } catch (error) { return { success: false, error: error.response?.data?.error || error.message }; }
    },
    async mesh_subscribe(params = {}) {
      try {
        const { groupId, notifyJoin, notifyLeave, notifyBroadcast, notifyTask, notifyMessage } = params;
        const response = await api.post('/api/groups/' + groupId + '/subscribe', { agentId, notifyJoin, notifyLeave, notifyBroadcast, notifyTask, notifyMessage });
        return response.data;
      } catch (error) { return { success: false, error: error.response?.data?.error || error.message }; }
    },
    async mesh_subscriptions_list(params = {}) {
      try {
        const { targetAgentId } = params;
        const response = await api.get('/api/agents/' + targetAgentId + '/subscriptions');
        return { success: true, subscriptions: response.data };
      } catch (error) { return { success: false, error: error.response?.data?.error || error.message }; }
    },
    async mesh_task_create(params = {}) {
      try {
        const { groupId, title, description, priority, ownerId, assignedId, dependsOn, context } = params;
        const response = await api.post('/api/tasks', { groupId, title, description, priority, ownerId, assignedId, dependsOn, context, createdBy: agentId });
        return response.data;
      } catch (error) { return { success: false, error: error.response?.data?.error || error.message }; }
    },
    async mesh_task_update(params = {}) {
      try {
        const { taskId, state, assignedId, result, priority } = params;
        const response = await api.patch('/api/tasks/' + taskId, { state, assignedId, result, priority });
        return response.data;
      } catch (error) { return { success: false, error: error.response?.data?.error || error.message }; }
    },
    async mesh_task_list(params = {}) {
      try {
        const { groupId, state, assignedId, ownerId } = params;
        const p = {}; if (groupId) p.groupId = groupId; if (state) p.state = state; if (assignedId) p.assignedId = assignedId; if (ownerId) p.ownerId = ownerId;
        const response = await api.get('/api/tasks', { params: p });
        return { success: true, tasks: response.data };
      } catch (error) { return { success: false, error: error.response?.data?.error || error.message }; }
    },
    async mesh_task_handoff(params = {}) {
      try {
        const { taskId, toAgentId, note } = params;
        const response = await api.post('/api/tasks/' + taskId + '/handoff', { toAgentId, note });
        return response.data;
      } catch (error) { return { success: false, error: error.response?.data?.error || error.message }; }
    },
    async mesh_message_schedule(params = {}) {
      try {
        const { to, toGroup, content, intent, priority, sendAt } = params;
        const response = await api.post('/api/messages/scheduled', { from: agentId, to, toGroup, content, intent, priority, sendAt });
        return response.data;
      } catch (error) { return { success: false, error: error.response?.data?.error || error.message }; }
    },
    async mesh_scheduled_list() {
      try {
        const response = await api.get('/api/messages/scheduled');
        return { success: true, scheduled: response.data };
      } catch (error) { return { success: false, error: error.response?.data?.error || error.message }; }
    },
    async mesh_scheduled_cancel(params = {}) {
      try {
        const { messageId } = params;
        const response = await api.delete('/api/messages/scheduled/' + messageId);
        return response.data;
      } catch (error) { return { success: false, error: error.response?.data?.error || error.message }; }
    },
    async mesh_capability_directory() {
      try {
        const response = await api.get('/api/capabilities');
        return response.data;
      } catch (error) { return { success: false, error: error.response?.data?.error || error.message }; }
    },
    async mesh_decision_log(params = {}) {
      try {
        const { groupId, content, context } = params;
        const response = await api.post('/api/decisions', { groupId, content, context, decidedBy: agentId });
        return response.data;
      } catch (error) { return { success: false, error: error.response?.data?.error || error.message }; }
    },
    async mesh_decisions_get(params = {}) {
      try {
        const { groupId, limit } = params;
        const p = {}; if (groupId) p.groupId = groupId; if (limit) p.limit = limit;
        const response = await api.get('/api/decisions', { params: p });
        return { success: true, decisions: response.data };
      } catch (error) { return { success: false, error: error.response?.data?.error || error.message }; }
    },
    async mesh_group_request(params = {}) {
      try {
        const { groupId } = params;
        const response = await api.post('/api/groups/' + groupId + '/request', { agentId });
        return response.data;
      } catch (error) { return { success: false, error: error.response?.data?.error || error.message }; }
    },
    async mesh_group_invite_respond(params = {}) {
      try {
        const { groupId, agentId: tAgentId, status } = params;
        const response = await api.patch('/api/groups/' + groupId + '/request/' + tAgentId, { status });
        return response.data;
      } catch (error) { return { success: false, error: error.response?.data?.error || error.message }; }
    },
    async mesh_group_requests(params = {}) {
      try {
        const { groupId } = params;
        const response = await api.get('/api/groups/' + groupId + '/requests');
        return { success: true, requests: response.data };
      } catch (error) { return { success: false, error: error.response?.data?.error || error.message }; }
    },
    async mesh_meta_orchestrate(params = {}) {
      try {
        const { action, payload } = params;
        const response = await api.post('/api/mesh/orchestrate', { action, payload, agentId });
        return response.data;
      } catch (error) { return { success: false, error: error.response?.data?.error || error.message }; }
    },
    async mesh_meta_summarize(params = {}) {
      try {
        const { groupId } = params;
        const response = await api.post('/api/mesh/orchestrate', { action: 'summarize_group', payload: { groupId }, agentId });
        return response.data;
      } catch (error) { return { success: false, error: error.response?.data?.error || error.message }; }
    },
    async mesh_meta_status() {
      try {
        const response = await api.post('/api/mesh/orchestrate', { action: 'mesh_status', payload: {}, agentId });
        return response.data;
      } catch (error) { return { success: false, error: error.response?.data?.error || error.message }; }
    }

};

export default tools;
