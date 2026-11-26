import { useEffect, useState } from 'react';
import { mesh, agentName, errText, formatRelativeTime, type Agent, type ScheduledMessage } from '../lib/mesh';
import { AgentSelect, PanelError, Section } from './shared';

const STATUSES = ['all', 'pending', 'sent', 'failed', 'cancelled'];

export default function ScheduledPanel({
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
  const [rows, setRows] = useState<ScheduledMessage[]>([]);
  const [status, setStatus] = useState('all');
  const [detail, setDetail] = useState<ScheduledMessage | null>(null);
  const [lookupId, setLookupId] = useState('');
  const [error, setError] = useState('');
  const [toId, setToId] = useState('');
  const [content, setContent] = useState('');
  const [sendAt, setSendAt] = useState('');

  useEffect(() => {
    let cancelled = false;
    mesh
      .listScheduled(status)
      .then((r) => {
        if (!cancelled) setRows(r);
      })
      .catch((e) => {
        if (!cancelled) setError(errText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [status, tick]);

  const lookup = (id: string) => {
    mesh
      .getScheduled(id)
      .then(setDetail)
      .catch((e) => setError(errText(e)));
  };

  return (
    <Section title="Scheduled Messages">
      <PanelError error={error} />
      <div className="messages-controls">
        <div className="row">
          {STATUSES.map((s) => (
            <button key={s} className={`chip ${status === s ? 'chip-mine' : ''}`} onClick={() => setStatus(s)}>
              {s}
            </button>
          ))}
        </div>
        <span className="hint">Filter maps to GET /api/messages/scheduled?status= (server default without a param is pending; this panel always passes one explicitly).</span>
      </div>

      <div className="split">
        <div className="messages-list tall">
          {rows.length === 0 ? (
            <div className="empty-state">No scheduled messages with status “{status}”</div>
          ) : (
            rows.map((r) => (
              <div key={r.id} className="message-item" onClick={() => lookup(r.id)}>
                <div className="message-header">
                  <span className={`badge badge-${r.status === 'pending' ? 'busy' : r.status === 'sent' ? 'approved' : r.status === 'failed' ? 'offline' : ''}`}>{r.status}</span>
                  <span className="message-from">{agentName(agents, r.from_agent)}</span>
                  <span className="message-arrow">→</span>
                  <span className="message-to">{r.to_group ? `group ${r.to_group.slice(0, 8)}…` : agentName(agents, r.to_agent)}</span>
                  <span className="message-time">due {formatRelativeTime(r.scheduled_at)}</span>
                </div>
                <div className="message-content">{r.content}</div>
                {r.status === 'pending' && (
                  <div className="reaction-row" onClick={(e) => e.stopPropagation()}>
                    <button
                      className="chip chip-warn"
                      onClick={async () => {
                        try {
                          await mesh.cancelScheduled(r.id);
                          onChanged();
                        } catch (e) {
                          setError(errText(e));
                        }
                      }}
                    >
                      cancel
                    </button>
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        <div>
          <div className="message-form">
            <h3>Detail by ID</h3>
            <input value={lookupId} onChange={(e) => setLookupId(e.target.value)} placeholder="Scheduled message ID" />
            <button className="btn-secondary" disabled={!lookupId.trim()} onClick={() => lookup(lookupId.trim())}>
              Fetch GET /api/messages/scheduled/:id
            </button>
            {detail && (
              <pre className="mono detail-pre">{JSON.stringify(detail, null, 2)}</pre>
            )}
          </div>
          <div className="message-form">
            <h3>Schedule a message (from acting agent)</h3>
            <AgentSelect agents={agents} label="To" value={toId} onChange={setToId} />
            <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={3} placeholder="Content…" />
            <label className="field">
              <span>Send at</span>
              <input type="datetime-local" value={sendAt} onChange={(e) => setSendAt(e.target.value)} />
            </label>
            <button
              className="btn-primary"
              disabled={!actorId || !toId || !content.trim() || !sendAt}
              onClick={async () => {
                try {
                  await mesh.scheduleMessage({
                    from: actorId,
                    to: toId,
                    content,
                    sendAt: new Date(sendAt).toISOString(),
                  });
                  setContent('');
                  setSendAt('');
                  onChanged();
                } catch (e) {
                  setError(errText(e));
                }
              }}
            >
              Schedule
            </button>
          </div>
        </div>
      </div>
    </Section>
  );
}
