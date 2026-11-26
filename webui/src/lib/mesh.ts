// Agent Mesh API client + WebSocket helper.
// Auth convention (unchanged from v4.2 UI): a single API key sent as the
// `X-API-Key` header; base URL + key are persisted in localStorage.
// Field shapes below are taken from server.js normalizers / route handlers:
//  - messages are normalized to { id, from, to, content, messageType, read, status, timeoutMs, createdAt }
//  - decisions are normalized to { id, groupId, content, context, proposedBy, status, tally, createdAt, closedAt }
//  - agents / groups / memory / scheduled rows are raw DB rows (snake_case).

export type Agent = {
  id: string;
  name: string;
  endpoint: string;
  capabilities: string[];
  last_seen?: string;
  created_at?: string;
  status?: string; // health status joined from agent_health_status ('unknown' if none)
};

export type Presence = {
  agent_id: string;
  agent_name?: string;
  state: 'online' | 'busy' | 'idle' | 'away' | 'offline' | string;
  status_message?: string;
  capabilities: string[];
  last_ping?: number;
};

export type MeshMessage = {
  id: string;
  from: string;
  to: string;
  content: string;
  messageType: string;
  read: boolean;
  status?: string;
  timeoutMs?: number | null;
  createdAt: string;
};

export type Reaction = {
  id: string;
  message_id: string;
  agent_id: string;
  agent_name?: string;
  emoji: string;
  semantic: string;
  created_at?: string;
};

export type ReactionsResponse = {
  reactions: Reaction[];
  semantics: Record<string, string[]>;
};

export type Skill = {
  id: string;
  agent_id: string;
  agent_name?: string;
  name: string;
  description?: string;
  endpoint: string;
  created_at?: string;
};

export type Group = {
  id: string;
  name: string;
  description?: string | null;
  metadata?: Record<string, unknown>;
  created_by: string;
  created_at?: string;
  member_count?: number;
};

export type GroupMember = {
  agent_id: string;
  name: string;
  endpoint?: string;
  role?: string;
  joined_at?: string;
};

export type GroupDetail = Group & { members: GroupMember[] };

export type MemoryEntry = {
  id: string;
  group_id: string;
  agent_id: string;
  key: string;
  value: unknown;
  memory_type: string;
  version: number;
  created_at?: string;
  updated_at?: string;
};

export type DecisionTally = { approve: number; reject: number; abstain: number };

export type Decision = {
  id: string;
  groupId: string | null;
  content: string;
  context?: string | null;
  proposedBy?: string | null;
  status: 'open' | 'approved' | 'rejected' | 'closed' | string;
  tally: DecisionTally;
  createdAt?: string;
  closedAt?: string | null;
};

export type DecisionVote = { agentId: string; agentName: string | null; vote: string; createdAt?: string };
export type DecisionDetail = Decision & { votes?: DecisionVote[] };

export type ScheduledMessage = {
  id: string;
  from_agent?: string | null;
  to_agent?: string | null;
  to_group?: string | null;
  content: string;
  intent?: string;
  priority?: number;
  scheduled_at: string;
  status: 'pending' | 'sent' | 'failed' | 'cancelled' | string;
  created_at?: string;
};

export type Health = {
  status: string;
  service: string;
  version: string;
  websocketPath?: string;
  timestamp: string;
};

export type Stats = {
  service: string;
  version: string;
  uptimeSeconds: number;
  websocketClients: number;
  counts: { agents: number; messages: number; groups: number; files: number; updates: number; activeCatastrophes: number };
};

export type MeshEvent = { type: string; [key: string]: unknown };

export const REACTION_EMOJIS = ['👍', '👎', '🔄', '✅', '❌', '⚠️', '🎯', '💡', '🔥', '🤝', '❓', '📌'];

function getBaseUrl() {
  return localStorage.getItem('mesh.baseUrl') || 'http://localhost:4000';
}

function getApiKey() {
  return localStorage.getItem('mesh.apiKey') || '';
}

export function openApiUrl() {
  return `${getBaseUrl().replace(/\/$/, '')}/openapi.json`;
}

export function wsUrl() {
  const base = getBaseUrl().replace(/\/$/, '');
  return `${base.replace(/^http/, 'ws')}/ws`;
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const baseUrl = getBaseUrl().replace(/\/$/, '');
  const apiKey = getApiKey();
  const headers = new Headers(init.headers || {});
  headers.set('Accept', 'application/json');
  if (!headers.has('Content-Type') && init.body) headers.set('Content-Type', 'application/json');
  if (apiKey) headers.set('X-API-Key', apiKey);

  const res = await fetch(`${baseUrl}${path}`, { ...init, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}${text ? `: ${text}` : ''}`);
  }
  return (await res.json()) as T;
}

const enc = encodeURIComponent;

export const mesh = {
  getBaseUrl,
  getApiKey,
  setBaseUrl: (v: string) => localStorage.setItem('mesh.baseUrl', v),
  setApiKey: (v: string) => localStorage.setItem('mesh.apiKey', v),

  // System (health is unauthenticated on the server; stats needs the key)
  health: () => api<Health>('/health'),
  stats: () => api<Stats>('/api/stats'),

  // Agents + presence
  listAgents: () => api<Agent[]>('/api/agents'),
  registerAgent: (body: { name: string; endpoint: string; capabilities: string[] }) =>
    api<{ success: boolean; agentId: string; message: string }>('/api/agents/register', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  heartbeat: (id: string) => api<unknown>(`/api/agents/${enc(id)}/heartbeat`, { method: 'POST', body: '{}' }),
  listPresence: () => api<Presence[]>('/api/presence'),
  setPresence: (id: string, body: { state: string; statusMessage?: string }) =>
    api<{ success: boolean; state: string }>(`/api/agents/${enc(id)}/presence`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  // Messages + reactions
  listMessages: (agentId: string, unreadOnly = false) =>
    api<MeshMessage[]>(`/api/messages/${enc(agentId)}${unreadOnly ? '?unreadOnly=true' : ''}`),
  sendMessage: (body: { from: string; to: string; content: string }) =>
    api<unknown>('/api/messages', { method: 'POST', body: JSON.stringify(body) }),
  broadcast: (body: { from: string; content: string }) =>
    api<unknown>('/api/broadcast', { method: 'POST', body: JSON.stringify(body) }),
  markRead: (id: string) => api<unknown>(`/api/messages/${enc(id)}/read`, { method: 'POST', body: '{}' }),
  getReactions: (messageId: string) => api<ReactionsResponse>(`/api/messages/${enc(messageId)}/reactions`),
  addReaction: (messageId: string, body: { agentId: string; emoji: string }) =>
    api<{ success: boolean; id: string; semantic: string }>(`/api/messages/${enc(messageId)}/reactions`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  removeReaction: (messageId: string, body: { agentId: string; emoji?: string }) =>
    api<{ success: boolean; removed: number }>(`/api/messages/${enc(messageId)}/reactions`, {
      method: 'DELETE',
      body: JSON.stringify(body),
    }),

  // Scheduled messages
  listScheduled: (status = 'all') =>
    api<ScheduledMessage[]>(`/api/messages/scheduled?status=${enc(status)}`),
  getScheduled: (id: string) => api<ScheduledMessage>(`/api/messages/scheduled/${enc(id)}`),
  scheduleMessage: (body: { from: string; to?: string; toGroup?: string; content: string; sendAt: string }) =>
    api<{ success: boolean; id: string; scheduledAt: string }>('/api/messages/scheduled', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  cancelScheduled: (id: string) =>
    api<{ success: boolean }>(`/api/messages/scheduled/${enc(id)}`, { method: 'DELETE' }),

  // Groups + collective memory
  listGroups: () => api<Group[]>('/api/groups'),
  getGroup: (id: string) => api<GroupDetail>(`/api/groups/${enc(id)}`),
  createGroup: (body: { name: string; description?: string; createdBy: string }) =>
    api<{ success: boolean; groupId: string }>('/api/groups', { method: 'POST', body: JSON.stringify(body) }),
  addGroupMember: (groupId: string, agentId: string) =>
    api<unknown>(`/api/groups/${enc(groupId)}/members`, { method: 'POST', body: JSON.stringify({ agentId }) }),
  removeGroupMember: (groupId: string, agentId: string) =>
    api<unknown>(`/api/groups/${enc(groupId)}/members/${enc(agentId)}`, { method: 'DELETE' }),
  groupBroadcast: (groupId: string, body: { from: string; content: string }) =>
    api<unknown>(`/api/groups/${enc(groupId)}/broadcast`, { method: 'POST', body: JSON.stringify(body) }),
  listMemory: (groupId: string) => api<MemoryEntry[]>(`/api/groups/${enc(groupId)}/memory`),
  setMemory: (groupId: string, body: { agentId: string; key: string; value: unknown; memoryType?: string }) =>
    api<{ success: boolean; memoryId: string; version: number }>(`/api/groups/${enc(groupId)}/memory`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  deleteMemory: (groupId: string, key: string, agentId: string) =>
    api<unknown>(`/api/groups/${enc(groupId)}/memory/${enc(key)}`, {
      method: 'DELETE',
      body: JSON.stringify({ agentId }),
    }),

  // Decisions
  listDecisions: (status = '') =>
    api<Decision[]>(`/api/decisions?limit=100${status ? `&status=${enc(status)}` : ''}`),
  getDecision: (id: string) => api<DecisionDetail>(`/api/decisions/${enc(id)}`),
  proposeDecision: (body: { content: string; context?: string; groupId?: string; decidedBy?: string }) =>
    api<{ success: boolean; id: string; status: string }>('/api/decisions', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  voteDecision: (id: string, body: { agentId: string; vote: 'approve' | 'reject' | 'abstain' }) =>
    api<{ success: boolean; tally: DecisionTally }>(`/api/decisions/${enc(id)}/vote`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  closeDecision: (id: string, body: { status?: string; decidedBy?: string } = {}) =>
    api<{ success: boolean; id: string; status: string; tally: DecisionTally }>(`/api/decisions/${enc(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  // Skills
  listSkills: () => api<Skill[]>('/api/skills'),
  registerSkill: (body: { agentId: string; name: string; description?: string; endpoint: string }) =>
    api<unknown>('/api/skills', { method: 'POST', body: JSON.stringify(body) }),
};

/**
 * Connect to the mesh WebSocket (/ws). The server sends a `connected`
 * greeting and then broadcasts event objects ({ type, ... }).
 * Returns the socket; caller closes it on unmount/config change.
 * Reconnection is left to the caller (App re-creates it when config changes).
 */
export function connectMeshSocket(onEvent: (ev: MeshEvent) => void, onState: (open: boolean) => void): WebSocket {
  const ws = new WebSocket(wsUrl());
  ws.onopen = () => onState(true);
  ws.onclose = () => onState(false);
  ws.onerror = () => onState(false);
  ws.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(String(msg.data)) as MeshEvent);
    } catch {
      /* non-JSON frame — ignore */
    }
  };
  return ws;
}

export function agentName(agents: Agent[], id?: string | null): string {
  if (!id) return '—';
  return agents.find((a) => a.id === id)?.name || `${id.slice(0, 8)}…`;
}

export function isAgentOnline(lastSeen?: string): boolean {
  if (!lastSeen) return false;
  return new Date(lastSeen).getTime() > Date.now() - 5 * 60 * 1000;
}

export function formatRelativeTime(timestamp?: string | number): string {
  if (!timestamp) return 'never';
  const time = typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime();
  const diff = Date.now() - time;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (seconds < 60) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
