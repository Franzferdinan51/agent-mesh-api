# Agent Mesh Web UI

This folder adds a minimal web dashboard for Agent Mesh API.

## Goals
- List agents
- View messages for an agent (unread-only toggle)
- Send direct messages
- Broadcast
- List/register skills

## Dev

```bash
cd webui
npm install
npm run dev
```

Then open the dev server URL shown by Vite.

In the UI, set:
- Mesh Base URL (e.g. `http://100.74.88.40:4000`)
- API key (e.g. `openclaw-mesh-default-key`)

Both are stored in localStorage.

## Next
- Add WebSocket live updates (`ws://<mesh>/ws`)
- Add message "mark as read" buttons
- Add safer auth (server-side proxy so key isn’t stored client-side)
