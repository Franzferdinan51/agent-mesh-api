export type Agent = {
  id: string;
  name: string;
  endpoint: string;
  capabilities: string[];
  last_seen?: string;
  created_at?: string;
};

export type MeshMessage = {
  id: string;
  from_agent: string;
  to_agent: string;
  content: string;
  message_type: string;
  read: number;
  created_at: string;
};

export type Skill = {
  id: string;
  agent_id: string;
  name: string;
  description?: string;
  endpoint: string;
  created_at?: string;
};

function getBaseUrl() {
  return localStorage.getItem('mesh.baseUrl') || 'http://100.74.88.40:4000';
}

function getApiKey() {
  return localStorage.getItem('mesh.apiKey') || '';
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const baseUrl = getBaseUrl().replace(/\/$/, '');
  const url = `${baseUrl}${path}`;

  const apiKey = getApiKey();
  const headers = new Headers(init.headers || {});
  headers.set('Accept', 'application/json');
  if (!headers.has('Content-Type') && init.body) headers.set('Content-Type', 'application/json');
  if (apiKey) headers.set('X-API-Key', apiKey);

  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}${text ? `: ${text}` : ''}`);
  }
  return (await res.json()) as T;
}

export const mesh = {
  getBaseUrl,
  getApiKey,
  setBaseUrl: (v: string) => localStorage.setItem('mesh.baseUrl', v),
  setApiKey: (v: string) => localStorage.setItem('mesh.apiKey', v),

  listAgents: () => api<Agent[]>('/api/agents'),
  registerAgent: (body: { name: string; endpoint: string; capabilities: string[] }) =>
    api<{ success: boolean; agentId: string; message: string }>('/api/agents/register', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  listMessages: (agentId: string, unreadOnly = false) =>
    api<MeshMessage[]>(`/api/messages/${encodeURIComponent(agentId)}${unreadOnly ? '?unreadOnly=true' : ''}`),
  sendMessage: (body: { from: string; to: string; content: string }) =>
    api<any>('/api/messages', { method: 'POST', body: JSON.stringify(body) }),
  broadcast: (body: { from: string; content: string }) =>
    api<any>('/api/broadcast', { method: 'POST', body: JSON.stringify(body) }),

  listSkills: () => api<Skill[]>('/api/skills'),
  registerSkill: (body: { agentId: string; name: string; description?: string; endpoint: string }) =>
    api<any>('/api/skills', { method: 'POST', body: JSON.stringify(body) }),
};
