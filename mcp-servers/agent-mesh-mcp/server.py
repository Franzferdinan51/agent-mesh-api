"""
Agent Mesh MCP Server
Cross-agent communication and coordination
"""

from fastmcp import FastMCP
import httpx
import os

mcp = FastMCP("Agent Mesh")

# Agent Mesh API - update for your deployment
MESH_URL = os.environ.get("AGENT_MESH_URL", "http://localhost:4000")
API_KEY = os.environ.get("AGENT_MESH_KEY", "openclaw-mesh-default-key")

async def get_client():
    return httpx.AsyncClient(
        base_url=MESH_URL,
        headers={"X-API-Key": API_KEY}
    )

@mcp.tool()
async def list_agents() -> str:
    """List all registered agents in the mesh"""
    async with await get_client() as client:
        try:
            resp = await client.get("/api/agents")
            agents = resp.json()
            
            result = "🤖 Agent Mesh\n\n"
            for a in agents:
                name = a.get("name", "Unknown")
                status = a.get("status", "unknown")
                last_seen = a.get("last_seen", "Never")
                result += f"• {name} - {status}\n"
                result += f"  Last seen: {last_seen}\n\n"
            
            return result
        except Exception as e:
            return f"Error: {str(e)}"

@mcp.tool()
async def agent_health(agent_name: str = None) -> str:
    """Check health of a specific agent or all agents"""
    async with await get_client() as client:
        try:
            resp = await client.get("/api/health")
            health = resp.json()
            
            if agent_name:
                agents = await client.get("/api/agents")
                for a in agents.json():
                    if a.get("name") == agent_name:
                        return f"{agent_name}: {a.get('status', 'unknown')}"
                return f"Agent {agent_name} not found"
            
            return f"Mesh Status: {health.get('status', 'unknown')}"
        except Exception as e:
            return f"Error: {str(e)}"

@mcp.tool()
async def send_to_agent(agent_name: str, message: str) -> str:
    """Send a message to another agent"""
    async with await get_client() as client:
        try:
            data = {
                "to": agent_name,
                "message": message
            }
            resp = await client.post("/api/messages", json=data)
            
            if resp.status_code == 200:
                return f"✓ Message sent to {agent_name}"
            else:
                return f"Failed: {resp.text}"
        except Exception as e:
            return f"Error: {str(e)}"

@mcp.tool()
async def broadcast_message(message: str) -> str:
    """Broadcast a message to all agents"""
    async with await get_client() as client:
        try:
            agents = await client.get("/api/agents")
            sent = 0
            
            for a in agents.json():
                name = a.get("name")
                await client.post("/api/messages", json={
                    "to": name,
                    "message": f"[BROADCAST] {message}"
                })
                sent += 1
            
            return f"✓ Broadcast sent to {sent} agents"
        except Exception as e:
            return f"Error: {str(e)}"

@mcp.tool()
async def get_agent_status() -> str:
    """Get detailed status of all agents"""
    async with await get_client() as client:
        try:
            resp = await client.get("/api/agents")
            agents = resp.json()
            
            result = "📊 Agent Status\n\n"
            for a in agents:
                name = a.get("name", "Unknown")
                status = a.get("status", "unknown")
                last_seen = a.get("last_seen", "Never")
                result += f"**{name}**\n"
                result += f"  Status: {status}\n"
                result += f"  Last seen: {last_seen}\n\n"
            
            return result
        except Exception as e:
            return f"Error: {str(e)}"

if __name__ == "__main__":
    mcp.run()
