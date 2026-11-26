import { useEffect, useState } from 'react';
import {
  mesh,
  errText,
  formatRelativeTime,
  isAgentOnline,
  type Agent,
  type Presence,
} from '../lib/mesh';
import { PanelError, Section } from './shared';

const PRESENCE_STATES = ['online', 'busy', 'idle', 'away', 'offline'];

export default function AgentsPanel({
  agents,
  selectedAgentId,
  onSelect,
  tick,
  onChanged,
}: {
  agents: Agent[];
  selectedAgentId: string;
  onSelect: (id: string) => void;
  tick: number;
  onChanged: () => void;
}) {
  const [presence, setPresence] = useState<Presence[]>([]);
  const [error, setError] = useState('');
  const [regName, setRegName] = useState('');
  const [regEndpoint, setRegEndpoint] = useState('');
  const [regCaps, setRegCaps] = useState('openclaw,monitoring');
  const [presenceState, setPresenceState] = useState('online');
  const [presenceMsg, setPresenceMsg] = useState('');

  useEffect(() => {
    let cancelled = false;
    mesh
      .listPresence()
      .then((p) => {
        if (!cancelled) setPresence(p);
      })
      .catch((e) => {
        if (!cancelled) setError(errText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const presenceFor = (id: string) => presence.find((p) => p.agent_id === id);
  const online = agents.filter((a) => isAgentOnline(a.last_seen));

  return (
    <Section title="Agents">
      <PanelError error={error} />
      <div className="agents-container">
        <div className="agents-list">
          {agents.length === 0 ? (
            <div className="empty-state">No agents registered</div>
          ) : (
            agents.map((agent) => {
              const p = presenceFor(agent.id);
              const isOnline = isAgentOnline(agent.last_seen);
              const state = p?.state || (isOnline ? 'online' : 'offline');
              return (
                <div
                  key={agent.id}
                  className={`agent-card ${selectedAgentId === agent.id ? 'selected' : ''} ${isOnline ? 'online' : 'offline'}`}
                  onClick={() => onSelect(agent.id)}
                >
                  <div className="agent-card-header">
                    <div className="agent-name">{agent.name}</div>
                    <span className={`badge badge-${state}`}>{state}</span>
                  </div>
                  <div className="agent-details">
                    <div className="agent-id">ID: {agent.id}</div>
                    {p?.status_message ? <div className="hint">“{p.status_message}”</div> : null}
                    <div className="agent-capabilities">
                      {(p?.capabilities?.length ? p.capabilities : agent.capabilities)?.slice(0, 4).map((cap, i) => (
                        <span key={i} className="capability-tag">{cap}</span>
                      ))}
                    </div>
                  </div>
                  <div className="agent-footer">
                    <span className="agent-lastseen">
                      last seen {formatRelativeTime(agent.last_seen)}
                      {agent.status ? ` · health: ${agent.status}` : ''}
                    </span>
                  </div>
                </div>
              );
            })
          )}
          <p className="hint">{online.length} of {agents.length} agents seen in the last 5 minutes. Presence comes from GET /api/presence; click a card to make it the acting agent for the other panels.</p>
        </div>

        <div className="stack">
          <div className="agent-registration">
            <h3>Register Agent</h3>
            <input value={regName} onChange={(e) => setRegName(e.target.value)} placeholder="Agent name" />
            <input value={regEndpoint} onChange={(e) => setRegEndpoint(e.target.value)} placeholder="Endpoint (optional)" />
            <input value={regCaps} onChange={(e) => setRegCaps(e.target.value)} placeholder="Capabilities (comma-separated)" />
            <button
              className="btn-primary"
              disabled={!regName.trim()}
              onClick={async () => {
                try {
                  await mesh.registerAgent({
                    name: regName.trim(),
                    endpoint: regEndpoint.trim(),
                    capabilities: regCaps.split(',').map((s) => s.trim()).filter(Boolean),
                  });
                  setRegName('');
                  setRegEndpoint('');
                  onChanged();
                } catch (e) {
                  setError(errText(e));
                }
              }}
            >
              Register Agent
            </button>
          </div>

          <div className="agent-registration">
            <h3>Set presence (acting agent)</h3>
            <select value={presenceState} onChange={(e) => setPresenceState(e.target.value)}>
              {PRESENCE_STATES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <input value={presenceMsg} onChange={(e) => setPresenceMsg(e.target.value)} placeholder="Status message (optional)" />
            <div className="row">
              <button
                className="btn-primary"
                disabled={!selectedAgentId}
                onClick={async () => {
                  try {
                    await mesh.setPresence(selectedAgentId, { state: presenceState, statusMessage: presenceMsg });
                    onChanged();
                  } catch (e) {
                    setError(errText(e));
                  }
                }}
              >
                Update presence
              </button>
              <button
                className="btn-secondary"
                disabled={!selectedAgentId}
                onClick={async () => {
                  try {
                    await mesh.heartbeat(selectedAgentId);
                    onChanged();
                  } catch (e) {
                    setError(errText(e));
                  }
                }}
              >
                Heartbeat
              </button>
            </div>
          </div>
        </div>
      </div>
    </Section>
  );
}
