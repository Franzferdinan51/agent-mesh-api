import { useState } from 'react';
import { mesh, openApiUrl, type Health, type Stats } from '../lib/mesh';

export default function SystemBar({
  health,
  stats,
  wsOpen,
  lastEvent,
  agentCount,
  onlineCount,
  onRefresh,
}: {
  health: Health | null;
  stats: Stats | null;
  wsOpen: boolean;
  lastEvent: string;
  agentCount: number;
  onlineCount: number;
  onRefresh: () => void;
}) {
  const [baseUrl, setBaseUrl] = useState(mesh.getBaseUrl());
  const [apiKey, setApiKey] = useState(mesh.getApiKey());
  const [showConfig, setShowConfig] = useState(false);

  return (
    <header className="app-header">
      <div className="header-content">
        <div className="header-title">
          <h1>Agent Mesh</h1>
          <p className="header-subtitle">
            <span className={`dot ${health ? 'dot-ok' : 'dot-bad'}`} />{' '}
            {health ? `${health.service} v${health.version} — ${health.status}` : 'unreachable'}
            {' · '}
            <span className={`dot ${wsOpen ? 'dot-ok' : 'dot-bad'}`} /> WebSocket {wsOpen ? 'live' : 'down'}
            {lastEvent ? ` · last event: ${lastEvent}` : ''}
          </p>
        </div>
        <div className="header-stats">
          <div className="stat">
            <span className="stat-value">{agentCount}</span>
            <span className="stat-label">Agents</span>
          </div>
          <div className="stat">
            <span className="stat-value">{onlineCount}</span>
            <span className="stat-label">Online</span>
          </div>
          <div className="stat">
            <span className="stat-value">{stats ? stats.counts.messages : '—'}</span>
            <span className="stat-label">Messages</span>
          </div>
          <div className="stat">
            <span className="stat-value">{stats ? stats.counts.groups : '—'}</span>
            <span className="stat-label">Groups</span>
          </div>
          <div className="stat">
            <span className="stat-value">{stats ? `${Math.floor(stats.uptimeSeconds / 60)}m` : '—'}</span>
            <span className="stat-label">Uptime</span>
          </div>
        </div>
        <div className="header-actions">
          <button className="btn-secondary" onClick={onRefresh}>Refresh</button>
          <button className="btn-secondary" onClick={() => setShowConfig((s) => !s)}>
            {showConfig ? 'Hide connection' : 'Connection'}
          </button>
          <a className="btn-secondary btn-link" href={openApiUrl()} target="_blank" rel="noreferrer">
            /openapi.json
          </a>
        </div>
      </div>
      {showConfig && (
        <div className="connection-form header-config">
          <div className="form-group">
            <label>Mesh Base URL</label>
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://localhost:4000" />
          </div>
          <div className="form-group">
            <label>API Key (X-API-Key)</label>
            <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="openclaw-mesh-default-key" />
          </div>
          <button
            className="btn-primary"
            onClick={() => {
              mesh.setBaseUrl(baseUrl);
              mesh.setApiKey(apiKey);
              onRefresh();
              // Rebuild the socket + all fetches against the new config.
              window.location.reload();
            }}
          >
            Save + reconnect
          </button>
          <p className="hint">Base URL and API key persist in localStorage (same convention as the v4.2 UI).</p>
        </div>
      )}
    </header>
  );
}
