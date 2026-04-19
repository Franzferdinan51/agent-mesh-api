# Agent Mesh MCP Server

MCP wrapper for Agent Mesh, updated to match the current REST API and OpenClaw-style integrations.

## What it does
- lists registered mesh agents
- sends direct messages by agent name
- broadcasts to all agents
- checks mesh-wide health or per-agent health
- auto-registers the MCP bridge as a sender when it needs to send traffic

## Requirements

```bash
pip install fastmcp httpx
```

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

## Tools
- `list_agents(limit=50)`
- `mesh_health(agent_name="")`
- `send_to_agent(agent_name, message)`
- `broadcast_message(message)`
- `get_agent_status(limit=50)`

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
