# Agent Mesh MCP Server

MCP wrapper for Agent Mesh, updated to match the current REST API and OpenClaw-style integrations.

## What it does
- lists registered mesh agents and their status
- sends direct messages by agent name and broadcasts to all agents or a group
- creates and lists agent groups
- reads/writes group collective memory
- bulk-registers agents and batch-sends messages
- reports mesh health, per-agent health, stats, and ping
- bridges to the Reticulum Phantom stack (status + file seeding) when installed
- auto-registers the MCP bridge as a sender when it needs to send traffic

## Requirements

```bash
pip install -r requirements.txt
```

Pinned in `requirements.txt`: `fastmcp==4.2.6`, `httpx==0.28.1`
(verified: the server starts and answers `tools/list` with these versions).

## Environment

```bash
export AGENT_MESH_URL="http://localhost:4000"
export AGENT_MESH_KEY="openclaw-mesh-default-key"
export AGENT_MESH_SENDER="OpenClaw-MCP"
```

## Run

```bash
python server.py
```

## Tools (16)

Verified against the running server (`tools/list`, 2026-11-25). All tools return text.

### Agents & messaging
- `list_agents(limit=50)` — List registered agents in the mesh.
- `mesh_health(agent_name="")` — Check mesh health, or a specific agent if a name is provided.
- `send_to_agent(agent_name, message)` — Send a direct message to another agent by name.
- `broadcast_message(message)` — Broadcast a message to all registered agents.
- `get_agent_status(limit=50)` — Get a detailed status report for agents in the mesh.
- `mesh_ping(agent_name_or_id)` — Ping an agent to check if it's alive.
- `mesh_stats()` — Get mesh server statistics.

### Groups & memory
- `mesh_group_create(name, description="")` — Create a new agent group on the mesh.
- `mesh_group_broadcast(group_id_or_name, message)` — Broadcast a message to all members of a group.
- `mesh_list_groups()` — List all agent groups on the mesh.
- `mesh_memory_store(group_id_or_name, key, value)` — Store a key-value pair in a group's collective memory.
- `mesh_memory_get(group_id_or_name, key="")` — Get values from a group's collective memory. Omit key to get all.

### Bulk operations
- `mesh_bulk_register(agents_json)` — Bulk-register up to 50 agents. Pass a JSON array string: `'[{"name":"A","capabilities":["x"]}]'`.
- `mesh_batch_send(messages_json)` — Batch-send up to 100 messages. Pass a JSON array string with `{from,to,message}` objects.

### Phantom (Reticulum)
- `phantom_status()` — Check Reticulum Phantom status and mesh connectivity. Returns a clear "not available" message when the Phantom/rns stack is not installed.
- `phantom_seed(filepath)` — Seed a file on the Reticulum mesh. Creates `.ghost` and starts sharing. Same availability behavior as `phantom_status`.

## OpenClaw example

```json
{
  "mcpServers": {
    "agent-mesh": {
      "command": "python3",
      "args": ["/absolute/path/to/agent-mesh-api/mcp-servers/agent-mesh-mcp/server.py"],
      "env": {
        "AGENT_MESH_URL": "http://localhost:4000",
        "AGENT_MESH_KEY": "openclaw-mesh-default-key",
        "AGENT_MESH_SENDER": "OpenClaw-MCP"
      }
    }
  }
}
```

## Health checks

```bash
curl http://localhost:4000/health
curl -H "X-API-Key: openclaw-mesh-default-key" http://localhost:4000/api/health
curl -H "X-API-Key: openclaw-mesh-default-key" http://localhost:4000/api/openclaw/compat
```
