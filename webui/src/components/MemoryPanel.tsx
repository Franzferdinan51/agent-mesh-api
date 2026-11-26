import { useEffect, useState } from 'react';
import { mesh, agentName, errText, formatRelativeTime, type Agent as AgentType, type Group, type MemoryEntry } from '../lib/mesh';
import { PanelError, Section } from './shared';

export default function MemoryPanel({
  agents,
  actorId,
  tick,
  onChanged,
}: {
  agents: AgentType[];
  actorId: string;
  tick: number;
  onChanged: () => void;
}) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupId, setGroupId] = useState('');
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [error, setError] = useState('');
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');

  useEffect(() => {
    let cancelled = false;
    mesh
      .listGroups()
      .then((g) => {
        if (!cancelled) {
          setGroups(g);
          if (!groupId && g.length) setGroupId(g[0].id);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(errText(e));
      });
    return () => {
      cancelled = true;
    };
    // groupId intentionally read once per refresh tick
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  useEffect(() => {
    if (!groupId) return;
    let cancelled = false;
    mesh
      .listMemory(groupId)
      .then((m) => {
        if (!cancelled) setEntries(m);
      })
      .catch((e) => {
        if (!cancelled) setError(errText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [groupId, tick]);

  return (
    <Section title="Collective Memory">
      <PanelError error={error} />
      <p className="hint">Shared key/value memory is scoped per group (GET/POST/DELETE /api/groups/:groupId/memory). Writing requires the acting agent to be a group member — the server returns 403 otherwise.</p>
      <label className="field">
        <span>Group</span>
        <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
          <option value="">Select group…</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </select>
      </label>
      <div className="messages-list tall">
        {!groupId ? (
          <div className="empty-state">Select a group</div>
        ) : entries.length === 0 ? (
          <div className="empty-state">No memory entries in this group</div>
        ) : (
          entries.map((m) => (
            <div key={m.id} className="message-item">
              <div className="message-header">
                <span className="message-from">{m.key}</span>
                <span className="badge">{m.memory_type} · v{m.version}</span>
                <span className="message-time">by {agentName(agents, m.agent_id)} · {formatRelativeTime(m.updated_at)}</span>
              </div>
              <div className="message-content mono">{typeof m.value === 'string' ? m.value : JSON.stringify(m.value, null, 2)}</div>
              <div className="reaction-row">
                <button
                  className="chip"
                  disabled={!actorId}
                  onClick={async () => {
                    try {
                      await mesh.deleteMemory(groupId, m.key, actorId);
                      onChanged();
                    } catch (e) {
                      setError(errText(e));
                    }
                  }}
                >
                  delete (as acting agent)
                </button>
              </div>
            </div>
          ))
        )}
      </div>
      <div className="message-form">
        <h3>Set memory (acting agent must be a member)</h3>
        <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="Key" />
        <textarea value={value} onChange={(e) => setValue(e.target.value)} rows={3} placeholder='Value — JSON if it parses, otherwise stored as a string' />
        <button
          className="btn-primary"
          disabled={!groupId || !actorId || !key.trim()}
          onClick={async () => {
            let parsed: unknown = value;
            try {
              parsed = JSON.parse(value);
            } catch {
              /* keep raw string */
            }
            try {
              await mesh.setMemory(groupId, { agentId: actorId, key: key.trim(), value: parsed });
              setKey('');
              setValue('');
              onChanged();
            } catch (e) {
              setError(errText(e));
            }
          }}
        >
          Set Memory
        </button>
      </div>
    </Section>
  );
}
