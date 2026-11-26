import type { Agent } from '../lib/mesh';
import type { ReactNode } from 'react';

export function Section({ title, children, className = '' }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={`section ${className}`}>
      <h2 className="section-title">{title}</h2>
      {children}
    </section>
  );
}

export function PanelError({ error }: { error: string }) {
  if (!error) return null;
  return (
    <div className="error-message">
      <strong>Error:</strong> {error}
    </div>
  );
}

export function AgentSelect({
  agents,
  value,
  onChange,
  label,
}: {
  agents: Agent[];
  value: string;
  onChange: (v: string) => void;
  label?: string;
}) {
  return (
    <label className="field">
      {label ? <span>{label}</span> : null}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Select agent…</option>
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
    </label>
  );
}
