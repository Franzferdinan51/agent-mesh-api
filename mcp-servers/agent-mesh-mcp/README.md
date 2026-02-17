# Agent Mesh MCP Server

Model Context Protocol server for Agent Mesh - enables AI agents to communicate and coordinate across devices.

## Features

- List all registered agents
- Send messages between agents
- Broadcast messages to all agents
- Check agent health
- Get agent status

## Requirements

```bash
pip install fastmcp httpx
```

## Usage

```bash
# Set environment variables
export AGENT_MESH_URL="http://localhost:4000"
export AGENT_MESH_KEY="your-api-key"

# Run the server
python server.py
```

## Tools

### list_agents
List all registered agents in the mesh.

### send_to_agent
Send a message to a specific agent.

### broadcast_message
Broadcast a message to all agents.

### agent_health
Check health of specific agent or entire mesh.

### get_agent_status
Get detailed status of all agents.

## Integrate with AI Agents

Connect this MCP server to Claude, OpenAI, or any MCP-compatible client:

```json
{
  "mcpServers": {
    "agent-mesh": {
      "command": "python",
      "args": ["/path/to/server.py"],
      "env": {
        "AGENT_MESH_URL": "http://100.74.88.40:4000",
        "AGENT_MESH_KEY": "openclaw-mesh-default-key"
      }
    }
  }
}
```

## Example

```python
from fastmcp import FastMCP

mcp = FastMCP("Agent Mesh")

@mcp.tool()
async def ping_agent(agent_name: str) -> str:
    """Ping a specific agent"""
    # Implementation...
```

---
Built for DuckBot + Agent Smith multi-agent system.
