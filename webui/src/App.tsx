import { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import './App.css';
import { mesh, type Agent, type MeshMessage, type Skill, isAgentOnline, formatRelativeTime } from './lib/mesh';

function Section({ title, children, className = '' }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`section ${className}`}>
      <h2 className="section-title">{title}</h2>
      {children}
    </section>
  );
}

function StatusIndicator({ online, lastSeen }: { online: boolean; lastSeen?: string }) {
  return (
    <div className={`status-indicator ${online ? 'online' : 'offline'}`} title={lastSeen ? `Last seen: ${lastSeen}` : 'Never seen'}>
      <span className="status-dot"></span>
      <span className="status-text">{online ? 'Online' : 'Offline'}</span>
    </div>
  );
}

function AgentCard({ agent, isSelected, onClick }: { agent: Agent; isSelected: boolean; onClick: () => void }) {
  const online = isAgentOnline(agent.last_seen);
  const relativeTime = formatRelativeTime(agent.last_seen);

  return (
    <div
      className={`agent-card ${isSelected ? 'selected' : ''} ${online ? 'online' : 'offline'}`}
      onClick={onClick}
    >
      <div className="agent-card-header">
        <div className="agent-name">{agent.name}</div>
        <StatusIndicator online={online} lastSeen={relativeTime} />
      </div>
      <div className="agent-details">
        <div className="agent-id">ID: {agent.id.slice(0, 12)}...</div>
        <div className="agent-capabilities">
          {agent.capabilities?.slice(0, 3).map((cap, i) => (
            <span key={i} className="capability-tag">{cap}</span>
          ))}
          {agent.capabilities?.length > 3 && (
            <span className="capability-tag">+{agent.capabilities.length - 3}</span>
          )}
        </div>
      </div>
      <div className="agent-footer">
        <span className="agent-lastseen">{relativeTime}</span>
      </div>
    </div>
  );
}

function MessageItem({ message, agents }: { message: MeshMessage; agents: Agent[] }) {
  const fromAgent = agents.find(a => a.id === message.from_agent);
  const toAgent = agents.find(a => a.id === message.to_agent);

  return (
    <div className={`message-item ${message.read ? 'read' : 'unread'}`}>
      <div className="message-header">
        <span className="message-from">{fromAgent?.name || message.from_agent.slice(0, 8)}</span>
        <span className="message-arrow">→</span>
        <span className="message-to">{toAgent?.name || message.to_agent.slice(0, 8)}</span>
        <span className="message-time">{formatRelativeTime(message.created_at)}</span>
      </div>
      <div className="message-content">{message.content}</div>
    </div>
  );
}

export default function App() {
  const [baseUrl, setBaseUrl] = useState(mesh.getBaseUrl());
  const [apiKey, setApiKey] = useState(mesh.getApiKey());

  const [agents, setAgents] = useState<Agent[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [error, setError] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshInterval, setRefreshInterval] = useState(5000);

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

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevMessagesRef = useRef<MeshMessage[]>([]);

  function persistConfig(nextBaseUrl: string, nextApiKey: string) {
    mesh.setBaseUrl(nextBaseUrl);
    mesh.setApiKey(nextApiKey);
    setBaseUrl(nextBaseUrl);
    setApiKey(nextApiKey);
  }

  const refreshAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [a, s] = await Promise.all([mesh.listAgents(), mesh.listSkills()]);
      setAgents(a);
      setSkills(s);
      if (!selectedAgentId && a.length) setSelectedAgentId(a[0].id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [selectedAgentId]);

  const refreshMessages = useCallback(async (agentId: string) => {
    setLoading(true);
    setError('');
    try {
      const m = await mesh.listMessages(agentId, unreadOnly);
      setMessages(m);
      prevMessagesRef.current = m;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [unreadOnly]);

  // Auto-refresh effect
  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(() => {
        refreshAll();
        if (selectedAgentId) {
          refreshMessages(selectedAgentId);
        }
      }, refreshInterval);

      return () => {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
        }
      };
    }
  }, [autoRefresh, refreshInterval, selectedAgentId, refreshAll, refreshMessages]);

  useEffect(() => {
    refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (selectedAgentId) refreshMessages(selectedAgentId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAgentId, unreadOnly]);

  // Update relative times every second
  useEffect(() => {
    const timer = setInterval(() => {
      // Force re-render by updating a dummy state
      setAgents(prev => [...prev]);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const onlineAgents = agents.filter(a => isAgentOnline(a.last_seen));
  const offlineAgents = agents.filter(a => !isAgentOnline(a.last_seen));

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-content">
          <div className="header-title">
            <h1>Agent Mesh</h1>
            <p className="header-subtitle">Real-time dashboard for agent communication</p>
          </div>
          <div className="header-stats">
            <div className="stat">
              <span className="stat-value">{agents.length}</span>
              <span className="stat-label">Agents</span>
            </div>
            <div className="stat">
              <span className="stat-value">{onlineAgents.length}</span>
              <span className="stat-label">Online</span>
            </div>
            <div className="stat">
              <span className="stat-value">{skills.length}</span>
              <span className="stat-label">Skills</span>
            </div>
          </div>
        </div>
      </header>

      <div className="main-content">
        <Section title="Connection" className="connection-section">
          <div className="connection-form">
            <div className="form-group">
              <label>Mesh Base URL</label>
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://100.74.88.40:4000" />
            </div>
            <div className="form-group">
              <label>API Key (X-API-Key)</label>
              <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="openclaw-mesh-default-key" />
            </div>
            <button className="btn-primary" onClick={() => persistConfig(baseUrl, apiKey)}>
              Save Config
            </button>
          </div>

          <div className="connection-controls">
            <div className="auto-refresh-toggle">
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={autoRefresh}
                  onChange={(e) => setAutoRefresh(e.target.checked)}
                />
                <span>Auto-refresh</span>
              </label>
              {autoRefresh && (
                <select
                  value={refreshInterval}
                  onChange={(e) => setRefreshInterval(Number(e.target.value))}
                  className="refresh-select"
                >
                  <option value={3000}>3s</option>
                  <option value={5000}>5s</option>
                  <option value={10000}>10s</option>
                  <option value={30000}>30s</option>
                </select>
              )}
            </div>
            <div className="manual-refresh">
              <button onClick={refreshAll} disabled={loading} className="btn-secondary">
                {loading ? 'Refreshing...' : 'Refresh Now'}
              </button>
            </div>
          </div>

          {error ? (
            <div className="error-message">
              <strong>Error:</strong> {error}
            </div>
          ) : null}
        </Section>

        <div className="grid-layout">
          <Section title="Agents" className="agents-section">
            <div className="agents-container">
              <div className="agents-list">
                {agents.length === 0 ? (
                  <div className="empty-state">No agents registered</div>
                ) : (
                  <>
                    {onlineAgents.length > 0 && (
                      <div className="agent-group">
                        <div className="agent-group-title">Online ({onlineAgents.length})</div>
                        {onlineAgents.map(agent => (
                          <AgentCard
                            key={agent.id}
                            agent={agent}
                            isSelected={selectedAgentId === agent.id}
                            onClick={() => setSelectedAgentId(agent.id)}
                          />
                        ))}
                      </div>
                    )}
                    {offlineAgents.length > 0 && (
                      <div className="agent-group">
                        <div className="agent-group-title">Offline ({offlineAgents.length})</div>
                        {offlineAgents.map(agent => (
                          <AgentCard
                            key={agent.id}
                            agent={agent}
                            isSelected={selectedAgentId === agent.id}
                            onClick={() => setSelectedAgentId(agent.id)}
                          />
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>

              <div className="agent-registration">
                <h3>Register Agent</h3>
                <input
                  value={regName}
                  onChange={(e) => setRegName(e.target.value)}
                  placeholder="Agent name (e.g., duckbot-linux)"
                />
                <input
                  value={regEndpoint}
                  onChange={(e) => setRegEndpoint(e.target.value)}
                  placeholder="Endpoint (e.g., http://100.106.80.61:18789)"
                />
                <input
                  value={regCaps}
                  onChange={(e) => setRegCaps(e.target.value)}
                  placeholder="Capabilities (comma-separated)"
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
                      setRegName('');
                      setRegEndpoint('');
                      await refreshAll();
                    } catch (e) {
                      setError(e instanceof Error ? e.message : String(e));
                    }
                  }}
                  className="btn-primary"
                >
                  Register Agent
                </button>
              </div>
            </div>
          </Section>

          <Section title="Messages" className="messages-section">
            <div className="messages-container">
              <div className="messages-controls">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={unreadOnly}
                    onChange={(e) => setUnreadOnly(e.target.checked)}
                  />
                  <span>Unread only</span>
                </label>
                {selectedAgent && (
                  <div className="selected-agent-info">
                    Showing messages for: <strong>{selectedAgent.name}</strong>
                  </div>
                )}
              </div>

              <div className="messages-list">
                {!selectedAgentId ? (
                  <div className="empty-state">Select an agent to view messages</div>
                ) : messages.length === 0 ? (
                  <div className="empty-state">No messages found</div>
                ) : (
                  messages.map((m) => (
                    <MessageItem key={m.id} message={m} agents={agents} />
                  ))
                )}
              </div>

              <div className="message-forms">
                <div className="message-form">
                  <h3>Send Direct Message</h3>
                  <input
                    value={fromId}
                    onChange={(e) => setFromId(e.target.value)}
                    placeholder="From agent ID"
                  />
                  <input
                    value={toId}
                    onChange={(e) => setToId(e.target.value)}
                    placeholder="To agent ID"
                  />
                  <textarea
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    placeholder="Message content..."
                    rows={4}
                  />
                  <button
                    onClick={async () => {
                      setError('');
                      try {
                        await mesh.sendMessage({ from: fromId, to: toId, content });
                        setContent('');
                        await refreshMessages(toId);
                      } catch (e) {
                        setError(e instanceof Error ? e.message : String(e));
                      }
                    }}
                    className="btn-primary"
                  >
                    Send Message
                  </button>
                </div>

                <div className="message-form">
                  <h3>Broadcast Message</h3>
                  <input
                    value={broadcastFrom}
                    onChange={(e) => setBroadcastFrom(e.target.value)}
                    placeholder="From agent ID"
                  />
                  <textarea
                    value={broadcastContent}
                    onChange={(e) => setBroadcastContent(e.target.value)}
                    placeholder="Broadcast content..."
                    rows={3}
                  />
                  <button
                    onClick={async () => {
                      setError('');
                      try {
                        await mesh.broadcast({ from: broadcastFrom, content: broadcastContent });
                        setBroadcastContent('');
                      } catch (e) {
                        setError(e instanceof Error ? e.message : String(e));
                      }
                    }}
                    className="btn-primary"
                  >
                    Broadcast
                  </button>
                </div>
              </div>
            </div>
          </Section>

          <Section title="Skills" className="skills-section">
            <div className="skills-container">
              <div className="skills-list">
                {skills.length === 0 ? (
                  <div className="empty-state">No skills registered</div>
                ) : (
                  skills.map((s) => (
                    <div key={s.id} className="skill-card">
                      <div className="skill-header">
                        <span className="skill-name">{s.name}</span>
                        <span className="skill-id">{s.id.slice(0, 8)}...</span>
                      </div>
                      <div className="skill-details">
                        <div>Agent: {agents.find(a => a.id === s.agent_id)?.name || s.agent_id.slice(0, 8)}</div>
                        <div className="skill-endpoint">{s.endpoint}</div>
                        {s.description && <div className="skill-description">{s.description}</div>}
                      </div>
                    </div>
                  ))
                )}
              </div>

              <div className="skill-registration">
                <h3>Register Skill</h3>
                <input
                  value={skillAgentId}
                  onChange={(e) => setSkillAgentId(e.target.value)}
                  placeholder="Agent ID (owner)"
                />
                <input
                  value={skillName}
                  onChange={(e) => setSkillName(e.target.value)}
                  placeholder="Skill name"
                />
                <input
                  value={skillDesc}
                  onChange={(e) => setSkillDesc(e.target.value)}
                  placeholder="Description (optional)"
                />
                <input
                  value={skillEndpoint}
                  onChange={(e) => setSkillEndpoint(e.target.value)}
                  placeholder="Skill endpoint URL"
                />
                <button
                  onClick={async () => {
                    setError('');
                    try {
                      await mesh.registerSkill({
                        agentId: skillAgentId,
                        name: skillName,
                        description: skillDesc || undefined,
                        endpoint: skillEndpoint
                      });
                      setSkillAgentId('');
                      setSkillName('');
                      setSkillDesc('');
                      setSkillEndpoint('');
                      await refreshAll();
                    } catch (e) {
                      setError(e instanceof Error ? e.message : String(e));
                    }
                  }}
                  className="btn-primary"
                >
                  Register Skill
                </button>
              </div>
            </div>
          </Section>
        </div>
      </div>

      <footer className="app-footer">
        <p>Tip: API key is stored in localStorage. Leave it blank and paste only when needed for enhanced security.</p>
      </footer>
    </div>
  );
}
