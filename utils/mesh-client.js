/**
 * Simple Mesh API Client
 * Lightweight REST client for agent-mesh-api v4.0
 */
export function createClient({ baseURL = 'http://localhost:4000', apiKey = 'openclaw-mesh-default-key' } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'X-API-Key': apiKey,
    'Authorization': `Bearer ${apiKey}`,
  };

  async function request(method, path, body) {
    const url = `${baseURL}${path}`;
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error(data.error || 'request failed'), { status: res.status, data });
    return data;
  }

  return {
    // Agents
    async registerAgent(data) { return request('POST', '/api/agents/register', data); },
    async getAgents(params) { return request('GET', '/api/agents'); },
    async getAgent(id) { return request('GET', `/api/agents/${id}`); },
    async getAgentPresence(id) { return request('GET', `/api/agents/${id}/presence`); },
    async updatePresence(id, data) { return request('PATCH', `/api/agents/${id}/presence`, data); },
    async pingAgent(id) { return request('POST', `/api/agents/${id}/ping`, {}); },

    // Messages
    async sendMessage(data) { return request('POST', '/api/messages', data); },
    async getMessages(params) { return request('GET', '/api/messages', params); },
    async sendBroadcast(data) { return request('POST', '/api/broadcast', data); },

    // Groups
    async createGroup(data) { return request('POST', '/api/groups', data); },
    async getGroups() { return request('GET', '/api/groups'); },
    async getGroup(id) { return request('GET', `/api/groups/${id}`); },
    async addGroupMember(groupId, agentId) { return request('POST', `/api/groups/${groupId}/members`, { agentId }); },
    async removeGroupMember(groupId, agentId) { return request('DELETE', `/api/groups/${groupId}/members/${agentId}`); },
    async groupBroadcast(groupId, data) { return request('POST', `/api/groups/${groupId}/broadcast`, data); },
    async groupRequest(groupId) { return request('POST', `/api/groups/${groupId}/request`, {}); },
    async groupInviteRespond(groupId, agentId, status) { return request('PATCH', `/api/groups/${groupId}/request/${agentId}`, { status }); },
    async groupRequests(groupId) { return request('GET', `/api/groups/${groupId}/requests`); },
    async subscribeGroup(groupId, data) { return request('POST', `/api/groups/${groupId}/subscribe`, data); },

    // Collective Memory
    async storeMemory(groupId, data) { return request('POST', `/api/groups/${groupId}/memory`, data); },
    async getMemory(groupId, key) { return request('GET', key ? `/api/groups/${groupId}/memory/${key}` : `/api/groups/${groupId}/memory`); },

    // Activity
    async logActivity(groupId, data) { return request('POST', `/api/groups/${groupId}/activity`, data); },
    async getActivity(groupId, limit) { return request('GET', `/api/groups/${groupId}/activity`, limit ? { limit } : {}); },

    // Tasks
    async createTask(data) { return request('POST', '/api/tasks', data); },
    async getTasks(params) { return request('GET', '/api/tasks', params || {}); },
    async updateTask(taskId, data) { return request('PATCH', `/api/tasks/${taskId}`, data); },
    async handoffTask(taskId, toAgentId, note) { return request('POST', `/api/tasks/${taskId}/handoff`, { toAgentId, note }); },

    // Threads
    async createThread(data) { return request('POST', '/api/threads', data); },
    async getThreads(params) { return request('GET', '/api/threads', params || {}); },
    async getThread(id) { return request('GET', `/api/threads/${id}`); },
    async sendThreadMessage(threadId, data) { return request('POST', `/api/threads/${threadId}/messages`, data); },

    // Reactions
    async addReaction(messageId, emoji) { return request('POST', `/api/messages/${messageId}/reactions`, { emoji }); },
    async getReactions(messageId) { return request('GET', `/api/messages/${messageId}/reactions`); },

    // Scheduled Messages
    async scheduleMessage(data) { return request('POST', '/api/messages/scheduled', data); },
    async getScheduled() { return request('GET', '/api/messages/scheduled'); },
    async cancelScheduled(id) { return request('DELETE', `/api/messages/scheduled/${id}`); },

    // Capabilities
    async getCapabilities() { return request('GET', '/api/capabilities'); },
    async getPresence(params) { return request('GET', '/api/presence', params || {}); },

    // Decisions
    async logDecision(data) { return request('POST', '/api/decisions', data); },
    async getDecisions(params) { return request('GET', '/api/decisions', params || {}); },

    // Routing
    async routeTask(data) { return request('POST', '/api/mesh/route', data); },
    async orchestrate(data) { return request('POST', '/api/mesh/orchestrate', data); },

    // Meta-agent
    async metaStatus() { return request('GET', '/status'); },
    async metaOrchestrate(data) { return request('POST', '/orchestrate', data); },

    // Health
    async health() { return request('GET', '/health'); },
    async stats() { return request('GET', '/api/stats'); },
  };
}
