"""Agent Mesh MCP Server.

OpenClaw-friendly MCP wrapper around the Agent Mesh REST API.
"""

from fastmcp import FastMCP
import httpx
import os

mcp = FastMCP("Agent Mesh")

MESH_URL = os.environ.get("AGENT_MESH_URL", "http://localhost:4000")
API_KEY = os.environ.get("AGENT_MESH_KEY", "openclaw-mesh-default-key")
SENDER_NAME = os.environ.get("AGENT_MESH_SENDER", "OpenClaw-MCP")


def format_agent(agent: dict) -> str:
    capabilities = agent.get("capabilities") or []
    caps = ", ".join(capabilities[:6]) if capabilities else "none"
    return (
        f"• {agent.get('name', 'Unknown')} [{agent.get('status', 'unknown')}]\n"
        f"  id: {agent.get('id', 'n/a')}\n"
        f"  endpoint: {agent.get('endpoint', 'n/a')}\n"
        f"  capabilities: {caps}\n"
        f"  last seen: {agent.get('last_seen', 'never')}"
    )


async def get_client():
    return httpx.AsyncClient(
        base_url=MESH_URL,
        headers={
            "X-API-Key": API_KEY,
            "Authorization": f"Bearer {API_KEY}",
        },
        timeout=20.0,
    )


async def ensure_sender(client: httpx.AsyncClient) -> str:
    resp = await client.post(
        "/api/agents/register",
        json={
            "name": SENDER_NAME,
            "endpoint": "mcp://agent-mesh",
            "capabilities": ["mcp", "mesh", "routing"],
        },
    )
    resp.raise_for_status()
    return resp.json()["agentId"]


@mcp.tool()
async def list_agents(limit: int = 50) -> str:
    """List registered agents in the mesh."""
    async with await get_client() as client:
        try:
            resp = await client.get("/api/agents", params={"limit": limit})
            resp.raise_for_status()
            agents = resp.json()
            if not agents:
                return "No agents registered in the mesh."
            return "🤖 Agent Mesh\n\n" + "\n\n".join(format_agent(a) for a in agents)
        except Exception as e:
            return f"Error: {str(e)}"


@mcp.tool()
async def mesh_health(agent_name: str = "") -> str:
    """Check mesh health, or a specific agent if a name is provided."""
    async with await get_client() as client:
        try:
            if agent_name:
                agents_resp = await client.get("/api/agents", params={"search": agent_name, "limit": 20})
                agents_resp.raise_for_status()
                agents = agents_resp.json()
                for agent in agents:
                    if agent.get("name") == agent_name:
                        detail = await client.get(f"/api/agents/{agent['id']}/health")
                        if detail.status_code == 404:
                            return f"{agent_name}: no health report yet"
                        detail.raise_for_status()
                        health = detail.json()
                        return (
                            f"{agent_name}: {health.get('status', 'unknown')}\n"
                            f"uptime: {health.get('uptimeSeconds', 'n/a')}\n"
                            f"cpu: {health.get('cpuUsage', 'n/a')}\n"
                            f"memory: {health.get('memoryUsage', 'n/a')}"
                        )
                return f"Agent {agent_name} not found"

            resp = await client.get("/api/health")
            resp.raise_for_status()
            health = resp.json()
            return (
                f"Mesh status: {health.get('status', 'unknown')}\n"
                f"version: {health.get('version', 'unknown')}\n"
                f"agents: {health.get('totalAgents', 0)} total, {health.get('healthy', 0)} healthy, "
                f"{health.get('degraded', 0)} degraded, {health.get('unhealthy', 0)} unhealthy\n"
                f"websocket clients: {health.get('websocketClients', 0)}"
            )
        except Exception as e:
            return f"Error: {str(e)}"


@mcp.tool()
async def send_to_agent(agent_name: str, message: str) -> str:
    """Send a direct message to another agent by name."""
    async with await get_client() as client:
        try:
            sender_id = await ensure_sender(client)
            resp = await client.post(
                "/api/messages",
                json={
                    "from": sender_id,
                    "to": agent_name,
                    "message": message,
                },
            )
            resp.raise_for_status()
            payload = resp.json()
            return f"✓ Message sent to {agent_name} ({payload.get('messageId', 'no-id')})"
        except Exception as e:
            return f"Error: {str(e)}"


@mcp.tool()
async def broadcast_message(message: str) -> str:
    """Broadcast a message to all registered agents."""
    async with await get_client() as client:
        try:
            sender_id = await ensure_sender(client)
            resp = await client.post(
                "/api/broadcast",
                json={"from": sender_id, "content": message},
            )
            resp.raise_for_status()
            payload = resp.json()
            return f"✓ Broadcast sent to {payload.get('recipientCount', 0)} agents"
        except Exception as e:
            return f"Error: {str(e)}"


@mcp.tool()
async def get_agent_status(limit: int = 50) -> str:
    """Get a detailed status report for agents in the mesh."""
    async with await get_client() as client:
        try:
            resp = await client.get("/api/agents", params={"limit": limit})
            resp.raise_for_status()
            agents = resp.json()
            if not agents:
                return "No agents registered in the mesh."
            return "📊 Agent Status\n\n" + "\n\n".join(format_agent(a) for a in agents)
        except Exception as e:
            return f"Error: {str(e)}"


@mcp.tool()
async def mesh_group_create(name: str, description: str = "") -> str:
    """Create a new agent group on the mesh."""
    async with await get_client() as client:
        try:
            resp = await client.post("/api/groups", json={"name": name, "description": description})
            resp.raise_for_status()
            data = resp.json()
            return f"Group created: {name} (id: {data.get('id', 'n/a')})"
        except Exception as e:
            return f"Error: {str(e)}"


@mcp.tool()
async def mesh_group_broadcast(group_id_or_name: str, message: str) -> str:
    """Broadcast a message to all members of a group."""
    async with await get_client() as client:
        try:
            sender_id = await ensure_sender(client)
            resp = await client.post(f"/api/groups/{group_id_or_name}/broadcast", 
                json={"from": sender_id, "content": message})
            resp.raise_for_status()
            data = resp.json()
            return f"Broadcast sent to group {group_id_or_name} ({data.get('recipientCount', 0)} members)"
        except Exception as e:
            return f"Error: {str(e)}"


@mcp.tool()
async def mesh_list_groups() -> str:
    """List all agent groups on the mesh."""
    async with await get_client() as client:
        try:
            resp = await client.get("/api/groups")
            resp.raise_for_status()
            groups = resp.json()
            if not groups:
                return "No groups created yet."
            lines = [f"Groups ({len(groups)}):"]
            for g in groups:
                lines.append(f"  • {g.get('name', '?')} [{g.get('id', '?')}]")
                if g.get('description'):
                    lines.append(f"    {g['description']}")
            return "\n".join(lines)
        except Exception as e:
            return f"Error: {str(e)}"


@mcp.tool()
async def mesh_memory_store(group_id_or_name: str, key: str, value: str) -> str:
    """Store a key-value pair in a group's collective memory."""
    async with await get_client() as client:
        try:
            resp = await client.post(f"/api/groups/{group_id_or_name}/memory",
                json={"key": key, "value": value})
            resp.raise_for_status()
            data = resp.json()
            return f"Stored '{key}' in group {group_id_or_name} (version {data.get('version', '?')})"
        except Exception as e:
            return f"Error: {str(e)}"


@mcp.tool()
async def mesh_memory_get(group_id_or_name: str, key: str = "") -> str:
    """Get values from a group's collective memory. Omit key to get all."""
    async with await get_client() as client:
        try:
            if key:
                resp = await client.get(f"/api/groups/{group_id_or_name}/memory/{key}")
            else:
                resp = await client.get(f"/api/groups/{group_id_or_name}/memory")
            resp.raise_for_status()
            data = resp.json()
            return f"Memory for group {group_id_or_name}:\n{str(data)}"
        except Exception as e:
            return f"Error: {str(e)}"


@mcp.tool()
async def mesh_bulk_register(agents_json: str) -> str:
    """Bulk-register up to 50 agents. Pass JSON array: '[{"name":"A","capabilities":["x"]}]'."""
    async with await get_client() as client:
        try:
            import json
            agents = json.loads(agents_json)
            resp = await client.post("/api/agents/bulk-register", json={"agents": agents})
            resp.raise_for_status()
            data = resp.json()
            return f"Bulk registered: {len(data)} agents processed"
        except Exception as e:
            return f"Error: {str(e)}"


@mcp.tool()
async def mesh_batch_send(messages_json: str) -> str:
    """Batch-send up to 100 messages. Pass JSON array with {from,to,message} objects."""
    async with await get_client() as client:
        try:
            import json
            messages = json.loads(messages_json)
            resp = await client.post("/api/messages/batch", json={"messages": messages})
            resp.raise_for_status()
            data = resp.json()
            return f"Batch sent: {len(data)} results"
        except Exception as e:
            return f"Error: {str(e)}"


@mcp.tool()
async def mesh_stats() -> str:
    """Get mesh server statistics."""
    async with await get_client() as client:
        try:
            resp = await client.get("/api/stats")
            resp.raise_for_status()
            s = resp.json()
            counts = s.get("counts", {})
            return (
                f"Mesh Stats v{s.get('version', '?')}\n"
                f"  Uptime: {s.get('uptimeSeconds', 0)}s\n"
                f"  Agents: {counts.get('agents', 0)}\n"
                f"  Messages: {counts.get('messages', 0)}\n"
                f"  Groups: {counts.get('groups', 0)}\n"
                f"  Files: {counts.get('files', 0)}\n"
                f"  Active Catastrophes: {counts.get('activeCatastrophes', 0)}"
            )
        except Exception as e:
            return f"Error: {str(e)}"


@mcp.tool()
async def mesh_ping(agent_name_or_id: str) -> str:
    """Ping an agent to check if it's alive."""
    async with await get_client() as client:
        try:
            resp = await client.post(f"/api/agents/ping/{agent_name_or_id}")
            resp.raise_for_status()
            return f"Ping to {agent_name_or_id}: OK"
        except Exception as e:
            return f"Ping failed: {str(e)}"


@mcp.tool()
async def phantom_status() -> str:
    """Check Reticulum Phantom status and mesh connectivity."""
    try:
        import subprocess, json
        venv_python = "/tmp/rns-venv/bin/python"
        phantom_py = f"{os.path.expanduser('~')}/Desktop/AgentTeam-GitHub/reticulum-phantom/phantom.py"
        
        proc = subprocess.run(
            [venv_python, phantom_py, "identity"],
            capture_output=True, text=True, timeout=10,
            env={**os.environ, "PYTHONPATH": "/tmp/rns-venv/lib/python3.14/site-packages"}
        )
        output = proc.stdout + proc.stderr
        connected = "destination" in output.lower() or "hash" in output.lower()
        return f"Reticulum Phantom: {'CONNECTED' if connected else 'NOT CONNECTED'}\n{output[:300]}"
    except Exception as e:
        return f"Phantom error: {str(e)}"


@mcp.tool()
async def phantom_seed(filepath: str) -> str:
    """Seed a file on the Reticulum mesh. Creates .ghost and starts sharing."""
    try:
        import subprocess
        venv_python = "/tmp/rns-venv/bin/python"
        phantom_py = f"{os.path.expanduser('~')}/Desktop/AgentTeam-GitHub/reticulum-phantom/phantom.py"
        
        # create first
        subprocess.run([venv_python, phantom_py, "create", filepath],
            capture_output=True, timeout=30,
            env={**os.environ, "PYTHONPATH": "/tmp/rns-venv/lib/python3.14/site-packages"})
        
        # then seed
        proc = subprocess.run([venv_python, phantom_py, "seed", filepath],
            capture_output=True, text=True, timeout=30,
            env={**os.environ, "PYTHONPATH": "/tmp/rns-venv/lib/python3.14/site-packages"})
        
        ghost_path = filepath + ".ghost"
        return f"Seeding {filepath}\nGhost: {ghost_path}\n{proc.stdout[:200]}"
    except Exception as e:
        return f"Error: {str(e)}"



if __name__ == "__main__":
    mcp.run()
