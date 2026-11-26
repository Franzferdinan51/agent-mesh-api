import { useCallback, useEffect, useRef, useState } from 'react';
import './App.css';
import {
  connectMeshSocket,
  errText,
  isAgentOnline,
  mesh,
  type Agent,
  type Health,
  type MeshEvent,
  type Stats,
} from './lib/mesh';
import SystemBar from './components/SystemBar';
import AgentsPanel from './components/AgentsPanel';
import MessagesPanel from './components/MessagesPanel';
import GroupsPanel from './components/GroupsPanel';
import MemoryPanel from './components/MemoryPanel';
import DecisionsPanel from './components/DecisionsPanel';
import ScheduledPanel from './components/ScheduledPanel';
import SkillsPanel from './components/SkillsPanel';

type Tab = 'agents' | 'messages' | 'groups' | 'memory' | 'decisions' | 'scheduled' | 'skills';

const TABS: { id: Tab; label: string }[] = [
  { id: 'agents', label: 'Agents' },
  { id: 'messages', label: 'Messages' },
  { id: 'groups', label: 'Groups' },
  { id: 'memory', label: 'Memory' },
  { id: 'decisions', label: 'Decisions' },
  { id: 'scheduled', label: 'Scheduled' },
  { id: 'skills', label: 'Skills' },
];

// WS event types that should trigger a data refresh (server.js broadcast()
// inventory + API_DOCUMENTATION.md WebSocket table). Includes the v4.2
// additions: reaction_removed, decision_vote, decision_closed.
const REFRESH_EVENTS = new Set([
  'connected',
  'agent_joined', 'agent_left', 'agent_updated', 'agent_ping', 'agent_health_change', 'presence_changed',
  'new_message', 'broadcast', 'group_broadcast', 'batch_sent', 'message_timeout', 'message_failed', 'message_retry',
  'thread_message', 'reaction_added', 'reaction_removed',
  'group_created', 'group_member_added', 'group_member_removed', 'group_member_joined',
  'group_join_request', 'group_invite_response', 'group_activity',
  'memory_updated', 'memory_deleted',
  'decision_vote', 'decision_closed',
  'task_created', 'task_updated', 'task_handoff', 'task_routed',
  'skill_invoked', 'skill_invocation', 'file_available', 'system_update', 'catastrophe_alert',
]);

export default function App() {
  const [tab, setTab] = useState<Tab>('agents');
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [health, setHealth] = useState<Health | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const [wsOpen, setWsOpen] = useState(false);
  const [lastEvent, setLastEvent] = useState('');
  const socketRef = useRef<WebSocket | null>(null);

  const bump = useCallback(() => setTick((t) => t + 1), []);

  // Initial + refresh loads. State is set only inside promise callbacks,
  // never synchronously in an effect body (react-hooks/set-state-in-effect).
  useEffect(() => {
    let cancelled = false;
    mesh
      .listAgents()
      .then((a) => {
        if (cancelled) return;
        setAgents(a);
        setSelectedAgentId((prev) => prev || a[0]?.id || '');
        setError('');
      })
      .catch((e) => {
        if (!cancelled) setError(errText(e));
      });
    mesh
      .health()
      .then((h) => {
        if (!cancelled) setHealth(h);
      })
      .catch(() => {
        if (!cancelled) setHealth(null);
      });
    mesh
      .stats()
      .then((s) => {
        if (!cancelled) setStats(s);
      })
      .catch(() => {
        if (!cancelled) setStats(null);
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  // Live updates over the mesh WebSocket.
  useEffect(() => {
    const onEvent = (ev: MeshEvent) => {
      setLastEvent(ev.type);
      if (REFRESH_EVENTS.has(ev.type)) bump();
    };
    const ws = connectMeshSocket(onEvent, setWsOpen);
    socketRef.current = ws;
    return () => {
      ws.close();
      socketRef.current = null;
    };
  }, [bump]);

  // Slow fallback poll in case the socket drops (WS state shown in header).
  useEffect(() => {
    const t = setInterval(() => bump(), 30000);
    return () => clearInterval(t);
  }, [bump]);

  const onlineCount = agents.filter((a) => isAgentOnline(a.last_seen)).length;

  return (
    <div className="app">
      <SystemBar
        health={health}
        stats={stats}
        wsOpen={wsOpen}
        lastEvent={lastEvent}
        agentCount={agents.length}
        onlineCount={onlineCount}
        onRefresh={bump}
      />
      <div className="main-content">
        {error ? (
          <div className="error-message">
            <strong>Error:</strong> {error}
          </div>
        ) : null}
        <nav className="tab-nav" aria-label="Panels">
          {TABS.map((t) => (
            <button key={t.id} className={`tab-btn ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>

        {tab === 'agents' && (
          <AgentsPanel agents={agents} selectedAgentId={selectedAgentId} onSelect={setSelectedAgentId} tick={tick} onChanged={bump} />
        )}
        {tab === 'messages' && (
          <MessagesPanel agents={agents} selectedAgentId={selectedAgentId} tick={tick} onChanged={bump} />
        )}
        {tab === 'groups' && <GroupsPanel agents={agents} actorId={selectedAgentId} tick={tick} onChanged={bump} />}
        {tab === 'memory' && <MemoryPanel agents={agents} actorId={selectedAgentId} tick={tick} onChanged={bump} />}
        {tab === 'decisions' && <DecisionsPanel agents={agents} actorId={selectedAgentId} tick={tick} onChanged={bump} />}
        {tab === 'scheduled' && <ScheduledPanel agents={agents} actorId={selectedAgentId} tick={tick} onChanged={bump} />}
        {tab === 'skills' && <SkillsPanel agents={agents} tick={tick} onChanged={bump} />}
      </div>
      <footer className="app-footer">
        <p>
          Acting agent: <strong>{agents.find((a) => a.id === selectedAgentId)?.name || 'none selected'}</strong> — reactions,
          votes, presence, group and memory writes are performed as this agent. API key is stored in localStorage.
        </p>
      </footer>
    </div>
  );
}
