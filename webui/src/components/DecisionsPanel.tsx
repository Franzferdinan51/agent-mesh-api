import { useEffect, useState } from 'react';
import {
  mesh,
  agentName,
  errText,
  formatRelativeTime,
  type Agent,
  type Decision,
  type DecisionDetail,
} from '../lib/mesh';
import { PanelError, Section } from './shared';

function Tally({ d }: { d: Decision }) {
  const total = Math.max(1, d.tally.approve + d.tally.reject + d.tally.abstain);
  return (
    <div className="tally">
      <div className="tally-bar">
        <span className="tally-approve" style={{ width: `${(d.tally.approve / total) * 100}%` }} />
        <span className="tally-reject" style={{ width: `${(d.tally.reject / total) * 100}%` }} />
        <span className="tally-abstain" style={{ width: `${(d.tally.abstain / total) * 100}%` }} />
      </div>
      <span className="hint">
        approve {d.tally.approve} · reject {d.tally.reject} · abstain {d.tally.abstain}
      </span>
    </div>
  );
}

export default function DecisionsPanel({
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
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [detail, setDetail] = useState<DecisionDetail | null>(null);
  const [error, setError] = useState('');
  const [content, setContent] = useState('');
  const [context, setContext] = useState('');

  useEffect(() => {
    let cancelled = false;
    mesh
      .listDecisions(statusFilter)
      .then((d) => {
        if (!cancelled) setDecisions(d);
      })
      .catch((e) => {
        if (!cancelled) setError(errText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [statusFilter, tick]);

  const openDetail = (id: string) => {
    mesh
      .getDecision(id)
      .then(setDetail)
      .catch((e) => setError(errText(e)));
  };

  const act = async (fn: () => Promise<unknown>, id?: string) => {
    try {
      await fn();
      onChanged();
      if (id) openDetail(id);
    } catch (e) {
      setError(errText(e));
    }
  };

  return (
    <Section title="Decisions">
      <PanelError error={error} />
      <div className="messages-controls">
        <label className="field inline">
          <span>Status</span>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">all</option>
            <option value="open">open</option>
            <option value="approved">approved</option>
            <option value="rejected">rejected</option>
            <option value="closed">closed</option>
          </select>
        </label>
        <span className="hint">Voting and closing act as the selected acting agent. Closed decisions reject votes/closes with 409 — buttons are disabled from the API status.</span>
      </div>

      <div className="split">
        <div className="messages-list tall">
          {decisions.length === 0 ? (
            <div className="empty-state">No decisions</div>
          ) : (
            decisions.map((d) => (
              <div key={d.id} className={`message-item ${detail?.id === d.id ? 'selected-card' : ''}`} onClick={() => openDetail(d.id)}>
                <div className="message-header">
                  <span className={`badge badge-${d.status === 'open' ? 'online' : d.status === 'approved' ? 'approved' : 'offline'}`}>{d.status}</span>
                  <span className="message-time">{formatRelativeTime(d.createdAt)} · by {agentName(agents, d.proposedBy)}</span>
                </div>
                <div className="message-content">{d.content}</div>
                {d.context ? <div className="hint">{d.context}</div> : null}
                <Tally d={d} />
                {d.status === 'open' && (
                  <div className="reaction-row" onClick={(e) => e.stopPropagation()}>
                    <button className="chip" disabled={!actorId} onClick={() => void act(() => mesh.voteDecision(d.id, { agentId: actorId, vote: 'approve' }), d.id)}>👍 approve</button>
                    <button className="chip" disabled={!actorId} onClick={() => void act(() => mesh.voteDecision(d.id, { agentId: actorId, vote: 'reject' }), d.id)}>👎 reject</button>
                    <button className="chip" disabled={!actorId} onClick={() => void act(() => mesh.voteDecision(d.id, { agentId: actorId, vote: 'abstain' }), d.id)}>abstain</button>
                    <button className="chip chip-warn" disabled={!actorId} onClick={() => void act(() => mesh.closeDecision(d.id, { decidedBy: actorId }), d.id)}>close (tally decides)</button>
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        <div>
          {detail ? (
            <div className="message-form">
              <h3>Decision detail</h3>
              <p>{detail.content}</p>
              <p className="hint">
                status {detail.status}
                {detail.closedAt ? ` · closed ${formatRelativeTime(detail.closedAt)}` : ''} · proposed by {agentName(agents, detail.proposedBy)}
              </p>
              <Tally d={detail} />
              <h4 className="subhead">Votes</h4>
              {!detail.votes?.length ? (
                <p className="hint">No votes yet</p>
              ) : (
                detail.votes.map((v, i) => (
                  <div key={i} className="list-row">
                    <span>{v.agentName || v.agentId}</span>
                    <span className="badge">{v.vote}</span>
                  </div>
                ))
              )}
            </div>
          ) : (
            <div className="empty-state">Select a decision for its votes</div>
          )}
          <div className="message-form">
            <h3>Propose decision (as acting agent)</h3>
            <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={3} placeholder="Decision / proposal…" />
            <input value={context} onChange={(e) => setContext(e.target.value)} placeholder="Context (optional)" />
            <button
              className="btn-primary"
              disabled={!actorId || !content.trim()}
              onClick={async () => {
                try {
                  await mesh.proposeDecision({ content: content.trim(), context: context.trim() || undefined, decidedBy: actorId });
                  setContent('');
                  setContext('');
                  onChanged();
                } catch (e) {
                  setError(errText(e));
                }
              }}
            >
              Propose
            </button>
          </div>
        </div>
      </div>
    </Section>
  );
}
