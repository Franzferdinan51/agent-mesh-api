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
        headers={"X-API-Key": API_KEY},
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


if __name__ == "__main__":
    mcp.run()
