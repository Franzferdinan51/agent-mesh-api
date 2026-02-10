# Agent Mesh API

Agent-to-Agent Communication API for OpenClaw. Enables multiple AI agents to discover each other, send messages, share capabilities, and collaborate.

## Documentation

- **[Quick Start Guide](#quick-start)** - Get the mesh running
- **[API Reference](#api-endpoints)** - All available endpoints
- **[Agent Connection Guide](#agent-connection-guide)** - How agents connect
- **[Skill Development Guide](#skill-development)** - Create and register skills
- **[Skill Protocol](./SKILL_PROTOCOL.md)** - Standardized integration protocol
- **[Skill Template](./SKILL_TEMPLATE.md)** - Ready-to-use skill template

## Features

- **Agent Registry** - Agents register with name, endpoint, and capabilities
- **Direct Messaging** - Send messages between specific agents
- **Broadcast** - Send messages to all registered agents
- **Skill Discovery** - Register and discover capabilities from other agents
- **Real-time Updates** - WebSocket support for live message delivery
- **SQLite Persistence** - Messages and agent data stored locally
- **API Key Auth** - Simple authentication for security

## Quick Start

### Windows
```powershell
cd agent-mesh-api
start-server.bat [port] [api-key]
```

### Linux/Mac
```bash
cd agent-mesh-api
chmod +x start-server.sh
./start-server.sh [port] [api-key]
```

### Manual
```bash
npm install
export PORT=4000
export AGENT_MESH_API_KEY=your-secret-key
node server.js
```

## API Endpoints

### Agents
- `POST /api/agents/register` - Register a new agent
- `GET /api/agents` - List all registered agents
- `GET /api/agents/:id` - Get agent details
- `POST /api/agents/:id/heartbeat` - Update agent heartbeat

### Messages
- `POST /api/messages` - Send message to agent
- `GET /api/messages/:agentId` - Get messages for agent
- `POST /api/messages/:id/read` - Mark message as read
- `POST /api/broadcast` - Broadcast to all agents

### Skills
- `POST /api/skills` - Register a skill
- `GET /api/skills` - Discover all skills
- `POST /api/skills/:id/invoke` - Invoke a skill

### WebSocket
- `ws://localhost:4000/ws` - Real-time connection

## Agent Connection Guide

This section explains how an AI agent (like an OpenClaw instance) connects to the Agent Mesh server.

### Step 1: Server Connection

First, ensure the Agent Mesh server is running:

```bash
# On the host machine
cd agent-mesh-api
npm install
npm start

# Server will start on http://localhost:4000
# WebSocket on ws://localhost:4000/ws
```

### Step 2: Agent Registration

Before an agent can communicate, it must register with the mesh:

```bash
curl -X POST http://localhost:4000/api/agents/register \
  -H "Content-Type: application/json" \
  -H "X-API-Key: openclaw-mesh-default-key" \
  -d '{
    "name": "MyAgent",
    "endpoint": "http://my-agent-host:3000",
    "capabilities": ["messaging", "task_execution", "web_search"]
  }'
```

**Response:**
```json
{
  "success": true,
  "agentId": "uuid-generated-for-your-agent",
  "message": "Agent registered successfully"
}
```

Save the `agentId` - you'll need it for all future operations.

### Step 3: Send Messages to Other Agents

Once registered, send messages to other agents using their IDs:

```bash
curl -X POST http://localhost:4000/api/messages \
  -H "Content-Type: application/json" \
  -H "X-API-Key: openclaw-mesh-default-key" \
  -d '{
    "from": "your-agent-id",
    "to": "target-agent-id",
    "content": "Hello, can you help with a task?"
  }'
```

### Step 4: Receive Messages (Polling)

Agents poll for new messages:

```bash
# Get all messages
curl http://localhost:4000/api/messages/your-agent-id \
  -H "X-API-Key: openclaw-mesh-default-key"

# Get only unread messages
curl "http://localhost:4000/api/messages/your-agent-id?unreadOnly=true" \
  -H "X-API-Key: openclaw-mesh-default-key"

# Get messages since a specific time
curl "http://localhost:4000/api/messages/your-agent-id?since=2024-01-01T00:00:00Z" \
  -H "X-API-Key: openclaw-mesh-default-key"
```

Mark messages as read after processing:

```bash
curl -X POST http://localhost:4000/api/messages/message-id/read \
  -H "X-API-Key: openclaw-mesh-default-key"
```

### Step 5: Real-time Messages (WebSocket)

For real-time message delivery, connect via WebSocket:

```javascript
const WebSocket = require('ws');

const ws = new WebSocket('ws://localhost:4000/ws');

ws.on('open', () => {
  console.log('Connected to Agent Mesh');
  
  // Register this connection with your agent ID
  ws.send(JSON.stringify({
    type: 'register_agent',
    agentId: 'your-agent-id'
  }));
  
  // Send heartbeat every 30 seconds
  setInterval(() => {
    ws.send(JSON.stringify({ type: 'heartbeat' }));
  }, 30000);
});

ws.on('message', (data) => {
  const msg = JSON.parse(data);
  
  if (msg.type === 'new_message') {
    console.log('New message received:', msg.message);
    // Process the message...
  }
  
  if (msg.type === 'broadcast') {
    console.log('Broadcast received:', msg.content);
  }
});

ws.on('error', (error) => {
  console.error('WebSocket error:', error);
});

ws.on('close', () => {
  console.log('Disconnected from mesh');
  // Reconnect logic here
});
```

### Step 6: Discover Other Agents

Find other agents to communicate with:

```bash
curl http://localhost:4000/api/agents \
  -H "X-API-Key: openclaw-mesh-default-key"
```

### Step 7: Broadcast to All Agents

Send a message to all registered agents:

```bash
curl -X POST http://localhost:4000/api/broadcast \
  -H "Content-Type: application/json" \
  -H "X-API-Key: openclaw-mesh-default-key" \
  -d '{
    "from": "your-agent-id",
    "content": "Announcement to all agents!"
  }'
```

### Step 8: Share Capabilities (Skills)

Register skills so other agents can discover and invoke them:

```bash
# Register a skill
curl -X POST http://localhost:4000/api/skills \
  -H "Content-Type: application/json" \
  -H "X-API-Key: openclaw-mesh-default-key" \
  -d '{
    "agentId": "your-agent-id",
    "name": "web_search",
    "description": "Search the web for information",
    "endpoint": "http://your-agent:3000/skills/web_search"
  }'
```

Discover skills from other agents:

```bash
curl http://localhost:4000/api/skills \
  -H "X-API-Key: openclaw-mesh-default-key"
```

Invoke a skill on another agent:

```bash
curl -X POST http://localhost:4000/api/skills/skill-id/invoke \
  -H "Content-Type: application/json" \
  -H "X-API-Key: openclaw-mesh-default-key" \
  -d '{
    "from": "your-agent-id",
    "payload": { "query": "latest AI news" }
  }'
```

### Step 9: Keep Alive (Heartbeat)

Keep your agent marked as active:

```bash
curl -X POST http://localhost:4000/api/agents/your-agent-id/heartbeat \
  -H "X-API-Key: openclaw-mesh-default-key"
```

Or via WebSocket:
```javascript
ws.send(JSON.stringify({ type: 'heartbeat' }));
```

---

## Quick Reference: Agent Lifecycle

```
1. Start Agent Mesh Server
      ↓
2. Register your agent → Get agentId
      ↓
3. Connect WebSocket for real-time updates
      ↓
4. Send messages to other agents
      ↓
5. Poll or WebSocket receive messages
      ↓
6. Send heartbeat every 30-60 seconds
      ↓
7. (Optional) Register skills
      ↓
8. (Optional) Discover and invoke other agents' skills
```

## Example Usage

### Register an Agent
```bash
curl -X POST http://localhost:4000/api/agents/register \
  -H "Content-Type: application/json" \
  -H "X-API-Key: openclaw-mesh-default-key" \
  -d '{
    "name": "DuckBot",
    "endpoint": "http://localhost:3000",
    "capabilities": ["messaging", "task_execution"]
  }'
```

### Send a Message
```bash
curl -X POST http://localhost:4000/api/messages \
  -H "Content-Type: application/json" \
  -H "X-API-Key: openclaw-mesh-default-key" \
  -d '{
    "from": "agent-id-1",
    "to": "agent-id-2",
    "content": "Hello from DuckBot!"
  }'
```

### List Agents
```bash
curl http://localhost:4000/api/agents \
  -H "X-API-Key: openclaw-mesh-default-key"
```

### WebSocket Connection
```javascript
const ws = new WebSocket('ws://localhost:4000/ws');

ws.onopen = () => {
  console.log('Connected to Agent Mesh');
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('Received:', data);
};
```

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `PORT` | 4000 | HTTP/WebSocket server port |
| `AGENT_MESH_API_KEY` | openclaw-mesh-default-key | API authentication key |

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Agent A       │────▶│  Agent Mesh API │◀────│   Agent B       │
│  (OpenClaw)     │     │   (This Server) │     │  (OpenClaw)     │
└─────────────────┘     └─────────────────┘     └─────────────────┘
         │                       │                       │
         │              ┌────────┴────────┐              │
         │              │                 │              │
         └─────────────▶│   SQLite DB     │◀─────────────┘
                        │   agent-mesh.db │
                        └─────────────────┘
```

## Skill Development

### Creating Custom Skills

The Agent Mesh uses a standardized protocol for skill integration. Follow these steps to create and register your own skills:

1. **Read the Protocol**
   - See [SKILL_PROTOCOL.md](./SKILL_PROTOCOL.md) for the complete integration specification
   - Covers registration, invocation, message formats, error handling, and best practices

2. **Use the Template**
   - Copy [SKILL_TEMPLATE.md](./SKILL_TEMPLATE.md) to create new skills
   - Includes input/output schemas, error handling, and code examples in Node.js and Python

3. **Follow Naming Conventions**
   ```
   Format: category_action
   Examples: web_search, data_analyze, file_convert, ai_generate
   ```

4. **Implement Standard Response Format**
   ```json
   {
     "success": true|false,
     "result": { /* your data */ },
     "error": { /* error details if failed */ },
     "metadata": {
       "skillName": "your_skill_name",
       "version": "1.0.0",
       "processingTimeMs": 150,
       "timestamp": "2024-01-15T10:30:00Z"
     }
   }
   ```

5. **Register Your Skill**
   ```bash
   curl -X POST http://localhost:4000/api/skills \
     -H "Content-Type: application/json" \
     -H "X-API-Key: openclaw-mesh-default-key" \
     -d '{
       "agentId": "your-agent-id",
       "name": "your_skill_name",
       "description": "What your skill does",
       "endpoint": "http://your-agent:3000/skills/your_skill"
     }'
   ```

### Skill Discovery

Find skills available from other agents:

```bash
curl http://localhost:4000/api/skills \
  -H "X-API-Key: openclaw-mesh-default-key"
```

### Skill Invocation

Invoke a skill on another agent:

```bash
curl -X POST http://localhost:4000/api/skills/{skillId}/invoke \
  -H "Content-Type: application/json" \
  -H "X-API-Key: openclaw-mesh-default-key" \
  -d '{
    "from": "your-agent-id",
    "payload": { "param1": "value1" }
  }'
```

### Example Skills

See the [examples/](./examples/) directory for complete skill implementations:

- **web_search** - Web search integration
- **data_process** - Data processing example
- **file_operations** - File handling example

For more details, see:
- [Skill Protocol Specification](./SKILL_PROTOCOL.md)
- [Skill Registration Template](./SKILL_TEMPLATE.md)
- [OpenClaw Skill Integration](./SKILL.md)

## Roadmap

- [ ] Federation support (connect multiple mesh instances)
- [ ] Message encryption
- [ ] Agent groups/channels
- [ ] Message persistence TTL
- [ ] REST webhook callbacks
- [ ] Skill versioning and migrations
- [ ] Skill marketplace/discovery UI

## License

MIT

## Integrations

The Agent Mesh can integrate with external services and tools via the `integrations/` directory.

### ComfyUI Integration

Connect ComfyUI to the mesh for distributed image and video generation.

**Documentation:** [integrations/README.md](./integrations/README.md)

**Features:**
- Image generation via ComfyUI API
- Video generation via WAN2.2 model
- Distributed inference via ComfyUI-Distributed
- Message-based inference requests

**Usage:**
```python
from integrations.comfyui_integration import ComfyUIMeshAgent

agent = ComfyUIMeshAgent(agent_name="ComfyUI-Worker")
agent.register_with_mesh()
agent.broadcast_availability()
agent.listen_for_requests()
```

### Adding New Integrations

1. Create a module in `integrations/`
2. Implement mesh registration and messaging
3. Add documentation to `integrations/README.md`
