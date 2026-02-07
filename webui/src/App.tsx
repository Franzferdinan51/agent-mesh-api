import { useEffect, useMemo, useState } from 'react';
import './App.css';
import { mesh, type Agent, type MeshMessage, type Skill } from './lib/mesh';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ border: '1px solid #333', borderRadius: 12, padding: 16, marginBottom: 16 }}>
      <h2 style={{ marginTop: 0 }}>{title}</h2>
      {children}
    </section>
  );
}

export default function App() {
  const [baseUrl, setBaseUrl] = useState(mesh.getBaseUrl());
  const [apiKey, setApiKey] = useState(mesh.getApiKey());

  const [agents, setAgents] = useState<Agent[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [error, setError] = useState<string>('');
  const [loading, setLoading] = useState(false);

  const [selectedAgentId, setSelectedAgentId] = useState<string>('');
  const selectedAgent = useMemo(() => agents.find((a) => a.id === selectedAgentId), [agents, selectedAgentId]);

  const [messages, setMessages] = useState<MeshMessage[]>([]);
  const [unreadOnly, setUnreadOnly] = useState(true);

  // send message form
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [content, setContent] = useState('');

  // broadcast
  const [broadcastFrom, setBroadcastFrom] = useState('');
  const [broadcastContent, setBroadcastContent] = useState('');

  // register agent
  const [regName, setRegName] = useState('');
  const [regEndpoint, setRegEndpoint] = useState('');
  const [regCaps, setRegCaps] = useState('openclaw,monitoring');

  // register skill
  const [skillAgentId, setSkillAgentId] = useState('');
  const [skillName, setSkillName] = useState('');
  const [skillDesc, setSkillDesc] = useState('');
  const [skillEndpoint, setSkillEndpoint] = useState('');

  function persistConfig(nextBaseUrl: string, nextApiKey: string) {
    mesh.setBaseUrl(nextBaseUrl);
    mesh.setApiKey(nextApiKey);
    setBaseUrl(nextBaseUrl);
    setApiKey(nextApiKey);
  }

  async function refreshAll() {
    setLoading(true);
    setError('');
    try {
      const [a, s] = await Promise.all([mesh.listAgents(), mesh.listSkills()]);
      setAgents(a);
      setSkills(s);
      if (!selectedAgentId && a.length) setSelectedAgentId(a[0].id);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  async function refreshMessages(agentId: string) {
    setLoading(true);
    setError('');
    try {
      const m = await mesh.listMessages(agentId, unreadOnly);
      setMessages(m);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (selectedAgentId) refreshMessages(selectedAgentId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAgentId, unreadOnly]);

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: 16 }}>
      <h1>Agent Mesh Web UI</h1>
      <p style={{ opacity: 0.8, marginTop: -8 }}>
        Minimal dashboard for Agent Mesh API (agents/messages/skills). Stores Base URL + API key in localStorage.
      </p>

      <Section title="Connection">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 12, alignItems: 'end' }}>
          <div>
            <label>Mesh Base URL</label>
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://100.74.88.40:4000" />
          </div>
          <div>
            <label>API Key (X-API-Key)</label>
            <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="openclaw-mesh-default-key" />
          </div>
          <button onClick={() => persistConfig(baseUrl, apiKey)}>Save</button>
        </div>

        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <button onClick={refreshAll} disabled={loading}>
            Refresh agents/skills
          </button>
          <button
            onClick={() => selectedAgentId && refreshMessages(selectedAgentId)}
            disabled={loading || !selectedAgentId}
          >
            Refresh messages
          </button>
        </div>

        {error ? (
          <pre style={{ background: '#2a0000', padding: 12, borderRadius: 8, overflow: 'auto' }}>{error}</pre>
        ) : null}
      </Section>

      <Section title="Agents">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div>
            <label>Registered agents</label>
            <select value={selectedAgentId} onChange={(e) => setSelectedAgentId(e.target.value)}>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} — {a.id}
                </option>
              ))}
            </select>
            <div style={{ marginTop: 8, fontSize: 14, opacity: 0.9 }}>
              {selectedAgent ? (
                <>
                  <div>
                    <b>Endpoint:</b> {selectedAgent.endpoint}
                  </div>
                  <div>
                    <b>Capabilities:</b> {selectedAgent.capabilities?.join(', ')}
                  </div>
                  <div>
                    <b>Last seen:</b> {selectedAgent.last_seen || '(n/a)'}
                  </div>
                </>
              ) : (
                '(no agent selected)'
              )}
            </div>
          </div>

          <div>
            <label>Register agent (optional)</label>
            <input value={regName} onChange={(e) => setRegName(e.target.value)} placeholder="duckbot-linux" />
            <input
              value={regEndpoint}
              onChange={(e) => setRegEndpoint(e.target.value)}
              placeholder="http://100.106.80.61:18789"
            />
            <input
              value={regCaps}
              onChange={(e) => setRegCaps(e.target.value)}
              placeholder="openclaw,monitoring"
            />
            <button
              onClick={async () => {
                setError('');
                try {
                  await mesh.registerAgent({
                    name: regName,
                    endpoint: regEndpoint,
                    capabilities: regCaps.split(',').map((s) => s.trim()).filter(Boolean),
                  });
                  await refreshAll();
                } catch (e: any) {
                  setError(e?.message || String(e));
                }
              }}
            >
              Register
            </button>
          </div>
        </div>
      </Section>

      <Section title="Messages">
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 8 }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />
            Unread only
          </label>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div>
            <label>Inbox for selected agent</label>
            <div style={{ maxHeight: 260, overflow: 'auto', border: '1px solid #333', borderRadius: 8, padding: 8 }}>
              {messages.length ? (
                messages.map((m) => (
                  <div key={m.id} style={{ padding: 8, borderBottom: '1px solid #222' }}>
                    <div style={{ fontSize: 12, opacity: 0.8 }}>
                      {m.created_at} · from {m.from_agent} → {m.to_agent}
                    </div>
                    <div style={{ whiteSpace: 'pre-wrap' }}>{m.content}</div>
                  </div>
                ))
              ) : (
                <div style={{ opacity: 0.7 }}>(no messages)</div>
              )}
            </div>
          </div>

          <div>
            <label>Send direct message</label>
            <input value={fromId} onChange={(e) => setFromId(e.target.value)} placeholder="from agentId" />
            <input value={toId} onChange={(e) => setToId(e.target.value)} placeholder="to agentId" />
            <textarea value={content} onChange={(e) => setContent(e.target.value)} placeholder="message" rows={5} />
            <button
              onClick={async () => {
                setError('');
                try {
                  await mesh.sendMessage({ from: fromId, to: toId, content });
                  setContent('');
                } catch (e: any) {
                  setError(e?.message || String(e));
                }
              }}
            >
              Send
            </button>

            <div style={{ height: 16 }} />

            <label>Broadcast</label>
            <input value={broadcastFrom} onChange={(e) => setBroadcastFrom(e.target.value)} placeholder="from agentId" />
            <textarea
              value={broadcastContent}
              onChange={(e) => setBroadcastContent(e.target.value)}
              placeholder="broadcast content"
              rows={3}
            />
            <button
              onClick={async () => {
                setError('');
                try {
                  await mesh.broadcast({ from: broadcastFrom, content: broadcastContent });
                  setBroadcastContent('');
                } catch (e: any) {
                  setError(e?.message || String(e));
                }
              }}
            >
              Broadcast
            </button>
          </div>
        </div>
      </Section>

      <Section title="Skills">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div>
            <label>Registered skills</label>
            <div style={{ maxHeight: 220, overflow: 'auto', border: '1px solid #333', borderRadius: 8, padding: 8 }}>
              {skills.length ? (
                skills.map((s) => (
                  <div key={s.id} style={{ padding: 8, borderBottom: '1px solid #222' }}>
                    <div>
                      <b>{s.name}</b> <span style={{ opacity: 0.7 }}>({s.id})</span>
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.8 }}>agent: {s.agent_id}</div>
                    <div style={{ fontSize: 12, opacity: 0.8 }}>endpoint: {s.endpoint}</div>
                    {s.description ? <div style={{ opacity: 0.9 }}>{s.description}</div> : null}
                  </div>
                ))
              ) : (
                <div style={{ opacity: 0.7 }}>(no skills)</div>
              )}
            </div>
          </div>

          <div>
            <label>Register skill</label>
            <input
              value={skillAgentId}
              onChange={(e) => setSkillAgentId(e.target.value)}
              placeholder="agentId (owner)"
            />
            <input value={skillName} onChange={(e) => setSkillName(e.target.value)} placeholder="skill name" />
            <input value={skillDesc} onChange={(e) => setSkillDesc(e.target.value)} placeholder="description (optional)" />
            <input value={skillEndpoint} onChange={(e) => setSkillEndpoint(e.target.value)} placeholder="http://.../skills/..." />
            <button
              onClick={async () => {
                setError('');
                try {
                  await mesh.registerSkill({ agentId: skillAgentId, name: skillName, description: skillDesc || undefined, endpoint: skillEndpoint });
                  await refreshAll();
                } catch (e: any) {
                  setError(e?.message || String(e));
                }
              }}
            >
              Register
            </button>
          </div>
        </div>
      </Section>

      <div style={{ opacity: 0.7, fontSize: 12 }}>
        Tip: If you don’t want to store the API key, leave it blank and paste it only when needed.
      </div>
    </div>
  );
}
