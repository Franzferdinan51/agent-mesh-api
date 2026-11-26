import { useEffect, useState } from 'react';
import { mesh, errText, type Agent, type Group, type GroupDetail } from '../lib/mesh';
import { AgentSelect, PanelError, Section } from './shared';

export default function GroupsPanel({
  agents,
  actorId,
  tick,
  onChanged,
}: {
  agents: Agent[];
  actorId: string;
  tick: number;
  onChanged: () => void;
}) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [detail, setDetail] = useState<GroupDetail | null>(null);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [memberId, setMemberId] = useState('');
  const [broadcast, setBroadcast] = useState('');

  useEffect(() => {
    let cancelled = false;
    mesh
      .listGroups()
      .then((g) => {
        if (!cancelled) setGroups(g);
      })
      .catch((e) => {
        if (!cancelled) setError(errText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const openGroup = (id: string) => {
    mesh
      .getGroup(id)
      .then(setDetail)
      .catch((e) => setError(errText(e)));
  };

  return (
    <Section title="Groups">
      <PanelError error={error} />
      <div className="split">
        <div>
          {groups.length === 0 ? (
            <div className="empty-state">No groups yet</div>
          ) : (
            groups.map((g) => (
              <div key={g.id} className={`skill-card ${detail?.id === g.id ? 'selected-card' : ''}`} onClick={() => openGroup(g.id)}>
                <div className="skill-header">
                  <span className="skill-name">{g.name}</span>
                  <span className="badge">{g.member_count ?? 0} members</span>
                </div>
                <div className="skill-details">
                  {g.description || 'No description'}
                  <div className="skill-endpoint">{g.id}</div>
                </div>
              </div>
            ))
          )}
          <div className="message-form">
            <h3>Create group (as acting agent)</h3>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Group name" />
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description (optional)" />
            <button
              className="btn-primary"
              disabled={!name.trim() || !actorId}
              onClick={async () => {
                try {
                  await mesh.createGroup({ name: name.trim(), description: description.trim() || undefined, createdBy: actorId });
                  setName('');
                  setDescription('');
                  onChanged();
                } catch (e) {
                  setError(errText(e));
                }
              }}
            >
              Create Group
            </button>
            {!actorId && <p className="hint">Select an acting agent in the Agents panel first.</p>}
          </div>
        </div>

        <div>
          {!detail ? (
            <div className="empty-state">Select a group to see members</div>
          ) : (
            <>
              <h3 className="subhead">{detail.name} — members</h3>
              {detail.members.length === 0 ? (
                <div className="empty-state">No members</div>
              ) : (
                detail.members.map((m) => (
                  <div key={m.agent_id} className="list-row">
                    <span>{m.name} <span className="hint">({m.role || 'member'})</span></span>
                    <button
                      className="btn-secondary btn-small"
                      onClick={async () => {
                        try {
                          await mesh.removeGroupMember(detail.id, m.agent_id);
                          openGroup(detail.id);
                          onChanged();
                        } catch (e) {
                          setError(errText(e));
                        }
                      }}
                    >
                      Remove
                    </button>
                  </div>
                ))
              )}
              <div className="message-form">
                <h3>Add member</h3>
                <AgentSelect agents={agents} value={memberId} onChange={setMemberId} />
                <button
                  className="btn-primary"
                  disabled={!memberId}
                  onClick={async () => {
                    try {
                      await mesh.addGroupMember(detail.id, memberId);
                      setMemberId('');
                      openGroup(detail.id);
                      onChanged();
                    } catch (e) {
                      setError(errText(e));
                    }
                  }}
                >
                  Add Member
                </button>
              </div>
              <div className="message-form">
                <h3>Group broadcast (from acting agent)</h3>
                <textarea value={broadcast} onChange={(e) => setBroadcast(e.target.value)} rows={3} placeholder="Message to all members…" />
                <button
                  className="btn-primary"
                  disabled={!actorId || !broadcast.trim()}
                  onClick={async () => {
                    try {
                      await mesh.groupBroadcast(detail.id, { from: actorId, content: broadcast });
                      setBroadcast('');
                      onChanged();
                    } catch (e) {
                      setError(errText(e));
                    }
                  }}
                >
                  Broadcast to Group
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </Section>
  );
}
