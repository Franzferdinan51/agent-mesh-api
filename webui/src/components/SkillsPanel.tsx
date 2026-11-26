import { useEffect, useState } from 'react';
import { mesh, agentName, errText, type Agent, type Skill } from '../lib/mesh';
import { AgentSelect, PanelError, Section } from './shared';

export default function SkillsPanel({
  agents,
  tick,
  onChanged,
}: {
  agents: Agent[];
  tick: number;
  onChanged: () => void;
}) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [error, setError] = useState('');
  const [agentId, setAgentId] = useState('');
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [endpoint, setEndpoint] = useState('');

  useEffect(() => {
    let cancelled = false;
    mesh
      .listSkills()
      .then((s) => {
        if (!cancelled) setSkills(s);
      })
      .catch((e) => {
        if (!cancelled) setError(errText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  return (
    <Section title="Skills">
      <PanelError error={error} />
      <div className="skills-container">
        <div className="skills-list">
          {skills.length === 0 ? (
            <div className="empty-state">No skills registered</div>
          ) : (
            skills.map((s) => (
              <div key={s.id} className="skill-card">
                <div className="skill-header">
                  <span className="skill-name">{s.name}</span>
                  <span className="skill-id">{s.id.slice(0, 8)}…</span>
                </div>
                <div className="skill-details">
                  <div>Agent: {s.agent_name || agentName(agents, s.agent_id)}</div>
                  <div className="skill-endpoint">{s.endpoint}</div>
                  {s.description && <div className="skill-description">{s.description}</div>}
                </div>
              </div>
            ))
          )}
        </div>
        <div className="skill-registration">
          <h3>Register Skill</h3>
          <AgentSelect agents={agents} label="Owner agent" value={agentId} onChange={setAgentId} />
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Skill name" />
          <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Description (optional)" />
          <input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="Skill endpoint URL" />
          <button
            className="btn-primary"
            disabled={!agentId || !name.trim()}
            onClick={async () => {
              try {
                await mesh.registerSkill({ agentId, name: name.trim(), description: desc || undefined, endpoint });
                setName('');
                setDesc('');
                setEndpoint('');
                onChanged();
              } catch (e) {
                setError(errText(e));
              }
            }}
          >
            Register Skill
          </button>
        </div>
      </div>
    </Section>
  );
}
