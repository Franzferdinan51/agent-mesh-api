import { useCallback, useEffect, useState } from 'react';
import {
  mesh,
  agentName,
  errText,
  formatRelativeTime,
  REACTION_EMOJIS,
  type Agent,
  type MeshMessage,
  type Reaction,
} from '../lib/mesh';
import { AgentSelect, PanelError, Section } from './shared';

function MessageItem({
  message,
  agents,
  actorId,
  onChanged,
  onError,
}: {
  message: MeshMessage;
  agents: Agent[];
  actorId: string;
  onChanged: () => void;
  onError: (s: string) => void;
}) {
  const [reactions, setReactions] = useState<Reaction[]>([]);
  const [showPicker, setShowPicker] = useState(false);

  const loadReactions = useCallback(() => {
    mesh
      .getReactions(message.id)
      .then((r) => setReactions(r.reactions))
      .catch(() => setReactions([]));
  }, [message.id]);

  useEffect(() => {
    let cancelled = false;
    mesh
      .getReactions(message.id)
      .then((r) => {
        if (!cancelled) setReactions(r.reactions);
      })
      .catch(() => {
        if (!cancelled) setReactions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [message.id]);

  const mine = (emoji: string) => reactions.some((r) => r.agent_id === actorId && r.emoji === emoji);

  return (
    <div className={`message-item ${message.read ? 'read' : 'unread'}`}>
      <div className="message-header">
        <span className="message-from">{agentName(agents, message.from)}</span>
        <span className="message-arrow">→</span>
        <span className="message-to">{agentName(agents, message.to)}</span>
        {message.status ? <span className="badge">{message.status}</span> : null}
        <span className="message-time">{formatRelativeTime(message.createdAt)}</span>
      </div>
      <div className="message-content">{message.content}</div>
      <div className="reaction-row">
        {reactions.map((r) => (
          <button
            key={r.id}
            className={`chip ${r.agent_id === actorId ? 'chip-mine' : ''}`}
            title={`${agentName(agents, r.agent_id)} — ${r.semantic}${r.agent_id === actorId ? ' (click to remove)' : ''}`}
            onClick={async () => {
              if (r.agent_id !== actorId) return;
              try {
                await mesh.removeReaction(message.id, { agentId: actorId, emoji: r.emoji });
                loadReactions();
                onChanged();
              } catch (e) {
                onError(errText(e));
              }
            }}
          >
            {r.emoji} {r.semantic}
          </button>
        ))}
        <button className="chip chip-add" onClick={() => setShowPicker((s) => !s)} disabled={!actorId} title={actorId ? 'Add reaction as acting agent' : 'Select an acting agent first'}>
          + react
        </button>
        {!message.read && (
          <button
            className="chip"
            onClick={async () => {
              try {
                await mesh.markRead(message.id);
                onChanged();
              } catch (e) {
                onError(errText(e));
              }
            }}
          >
            mark read
          </button>
        )}
      </div>
      {showPicker && (
        <div className="reaction-picker">
          {REACTION_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              className="emoji-btn"
              onClick={async () => {
                try {
                  if (mine(emoji)) {
                    await mesh.removeReaction(message.id, { agentId: actorId, emoji });
                  } else {
                    await mesh.addReaction(message.id, { agentId: actorId, emoji });
                  }
                  setShowPicker(false);
                  loadReactions();
                  onChanged();
                } catch (e) {
                  onError(errText(e));
                }
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function MessagesPanel({
  agents,
  selectedAgentId,
  tick,
  onChanged,
}: {
  agents: Agent[];
  selectedAgentId: string;
  tick: number;
  onChanged: () => void;
}) {
  const [messages, setMessages] = useState<MeshMessage[]>([]);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [error, setError] = useState('');
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [content, setContent] = useState('');
  const [broadcastContent, setBroadcastContent] = useState('');

  const effectiveFrom = fromId || selectedAgentId;

  useEffect(() => {
    if (!selectedAgentId) return;
    let cancelled = false;
    mesh
      .listMessages(selectedAgentId, unreadOnly)
      .then((m) => {
        if (!cancelled) setMessages(m);
      })
      .catch((e) => {
        if (!cancelled) setError(errText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedAgentId, unreadOnly, tick]);

  return (
    <Section title="Messages">
      <PanelError error={error} />
      <div className="messages-controls">
        <label className="checkbox-label">
          <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />
          <span>Unread only</span>
        </label>
        <span className="selected-agent-info">
          Inbox of: <strong>{agentName(agents, selectedAgentId)}</strong> · reactions are added/removed as this acting agent
        </span>
      </div>
      <div className="messages-list">
        {!selectedAgentId ? (
          <div className="empty-state">Select an agent in the Agents panel</div>
        ) : messages.length === 0 ? (
          <div className="empty-state">No messages found</div>
        ) : (
          messages.map((m) => (
            <MessageItem key={m.id} message={m} agents={agents} actorId={selectedAgentId} onChanged={onChanged} onError={setError} />
          ))
        )}
      </div>

      <div className="message-forms">
        <div className="message-form">
          <h3>Send Direct Message</h3>
          <AgentSelect agents={agents} label="From" value={effectiveFrom} onChange={setFromId} />
          <AgentSelect agents={agents} label="To" value={toId} onChange={setToId} />
          <textarea value={content} onChange={(e) => setContent(e.target.value)} placeholder="Message content…" rows={4} />
          <button
            className="btn-primary"
            disabled={!effectiveFrom || !toId || !content.trim()}
            onClick={async () => {
              try {
                await mesh.sendMessage({ from: effectiveFrom, to: toId, content });
                setContent('');
                onChanged();
              } catch (e) {
                setError(errText(e));
              }
            }}
          >
            Send Message
          </button>
        </div>
        <div className="message-form">
          <h3>Broadcast Message</h3>
          <p className="hint">From the acting/from agent above, to every agent on the mesh.</p>
          <textarea value={broadcastContent} onChange={(e) => setBroadcastContent(e.target.value)} placeholder="Broadcast content…" rows={4} />
          <button
            className="btn-primary"
            disabled={!effectiveFrom || !broadcastContent.trim()}
            onClick={async () => {
              try {
                await mesh.broadcast({ from: effectiveFrom, content: broadcastContent });
                setBroadcastContent('');
                onChanged();
              } catch (e) {
                setError(errText(e));
              }
            }}
          >
            Broadcast
          </button>
        </div>
      </div>
    </Section>
  );
}
