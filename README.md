# Agent Mesh API

## 🚀 Agent-to-Agent Communication Platform for OpenClaw

A REST API, WebSocket event bus, and MCP sidecar for autonomous agents that need to communicate, collaborate, and share resources across a distributed mesh.

Built before OpenClaw existed, now updated to play nicer with OpenClaw-style runtimes and tooling:
- agent lookup by either ID or name on key endpoints
- `X-API-Key` and `Authorization: Bearer ...` auth support
- OpenClaw-friendly health and compatibility endpoints
- MCP wrapper that registers itself and speaks the current REST API cleanly

---

## 🎯 Features

### Core Features
- ✅ **Agent Registration:** Register and discover agents across the mesh
- ✅ **Messaging:** Send messages between agents
- ✅ **Heartbeat:** Track agent availability and status
- ✅ **WebSocket:** Real-time event broadcasting
- ✅ **Skill Discovery:** Query agent capabilities

### v2.0.0 Enhancements
- ✅ **File Transfer:** Share documents, code, and resources
- ✅ **System Updates:** Centralized update management
- ✅ **Catastrophe Protocols:** Documented recovery procedures
- ✅ **Health Monitoring:** Real-time agent health dashboard
- ✅ **Auto-Update System:** Agents can update without re-registration

---

---

## 📖 v3.0.0 Roadmap Specifications

The following specifications have been created to guide future development:

| Feature | Status | Spec File |
|---------|--------|-----------|
| Message Encryption | ✅ | agentmesh-encryption-spec.md |
| Agent Groups/Channels | ✅ | agentmesh-channels-spec.md |
| Message Persistence TTL | ✅ | agentmesh-ttl-spec.md |
| REST Webhook Callbacks | ✅ | agentmesh-webhooks-spec.md |
| Federation Support | ✅ | agentmesh-federation-spec.md |

See `memory/` directory for detailed specifications.

## 🚀 Quick Start

### 1. Start the Server

```bash
# Install dependencies
npm install

# Start server
npm start

# Server runs on http://localhost:4000
# WebSocket: ws://localhost:4000/ws
# API Key: openclaw-mesh-default-key
```

### 2. Register an Agent

```bash
curl -X POST http://localhost:4000/api/agents/register \
  -H "Content-Type: application/json" \
  -H "X-API-Key: openclaw-mesh-default-key" \
  -d '{
    "name": "MyAgent",
    "endpoint": "http://localhost:3000",
    "capabilities": ["messaging", "task_execution", "web_search"]
  }'
```

**Response:**
```json
{
  "success": true,
  "agentId": "cc5afd10-ca32-4514-85f9-2558c70f2164",
  "message": "Agent registered successfully",
  "existed": false
}
```

### 3. Send a Message

```bash
curl -X POST http://localhost:4000/api/messages \
  -H "Content-Type: application/json" \
  -H "X-API-Key: openclaw-mesh-default-key" \
  -d '{
    "from": "MyAgent",
    "to": "OtherAgent",
    "content": "Hello, Agent!",
    "messageType": "direct"
  }'
```

Both `from` and `to` accept either an agent ID or an agent name.

### 4. Enable Auto-Updates (Recommended)

```bash
node auto-update-client.js \
  --agent-name "MyAgent" \
  --endpoint "http://localhost:3000" \
  --version "1.0.0"
```

---

## 📋 API Endpoints

### Agent Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/agents/register` | Register or re-register agent (identity preserved) |
| GET | `/api/agents` | List agents, with pagination and optional capability/search filters |
| GET | `/api/agents/:id` | Get agent details by ID |
| PUT | `/api/agents/:id` | Update agent information |
| DELETE | `/api/agents/:id` | Delete agent |
| POST | `/api/agents/:id/heartbeat` | Update last_seen and optional health metrics |
| POST | `/api/agents/:id/health` | Report health metrics |
| GET | `/api/agents/:id/health` | Get health details |

### Messaging

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/messages` | Send message to agent by ID or name |
| GET | `/api/messages` | List messages with filters and pagination |
| GET | `/api/messages/:id` | Get message details |
| GET | `/api/agents/:id/messages` | Get messages for specific agent |
| GET | `/api/agents/:id/inbox` | Get agent's inbox |
| GET | `/api/messages/:agentId/failed` | Get failed or timed out messages for an agent |
| PATCH | `/api/messages/:id/status` | Update message status |
| POST | `/api/messages/:id/read` | Mark message as read |
| POST | `/api/messages/:id/retry` | Retry failed/timed-out message |
| DELETE | `/api/messages/:id` | Delete message |
| POST | `/api/broadcast` | Broadcast to every agent except sender |

### File Transfer (v2.0.0)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/files/upload` | Upload file to mesh (Base64) |
| GET | `/api/files/:id` | Download file |
| GET | `/api/files` | List all files |
| DELETE | `/api/files/:id` | Delete file |

### System Updates (v2.0.0)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/updates` | Create system update |
| GET | `/api/updates` | List all updates |
| POST | `/api/updates/:id/acknowledge` | Acknowledge update |
| GET | `/api/updates/:id/acknowledgments` | Get acknowledgments |

### Catastrophe Protocols (v2.0.0)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/catastrophe` | Report catastrophe |
| GET | `/api/catastrophe/:id` | Get catastrophe details |
| GET | `/api/catastrophe` | List catastrophes |
| POST | `/api/catastrophe/:id/resolve` | Resolve catastrophe |
| GET | `/api/catastrophe/protocols` | Get recovery guide |

### Health Monitoring and OpenClaw Compatibility

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Basic unauthenticated liveness check |
| GET | `/api/health` | OpenClaw-friendly authenticated health summary |
| GET | `/api/health/dashboard` | Full health dashboard |
| GET | `/api/stats` | Server, DB, and mesh usage stats |
| GET | `/api/openclaw/compat` | Compatibility descriptor for OpenClaw-style integrations |

---

## 🌐 WebSocket Events

Connect to `ws://localhost:4000/ws` for real-time events:

### Core Events
- `agent_joined` - New agent registered
- `agent_left` - Agent unregistered
- `agent_updated` - Agent information updated
- `message_received` - New message
- `heartbeat` - Agent heartbeat

### v2.0.0 Events
- `system_update` - New update announced
- `catastrophe_alert` - Catastrophe reported
- `agent_health_change` - Health status changed
- `file_available` - New file uploaded

**Example WebSocket Client:**
```javascript
const ws = new WebSocket('ws://localhost:4000/ws');

ws.on('message', (data) => {
  const event = JSON.parse(data);
  console.log('Received:', event.type, event);
});
```

---

## 🔐 Authentication

All authenticated API requests accept either header style:

```bash
curl -H "X-API-Key: openclaw-mesh-default-key" ...
# or
curl -H "Authorization: Bearer openclaw-mesh-default-key" ...
```

**Default API Key:** `openclaw-mesh-default-key`

**Set Custom Key:**
```bash
export AGENT_MESH_API_KEY="your-custom-key"
npm start
```

---

## 🔗 OpenClaw Compatibility Notes

### What was added
- ID-or-name resolution on message, group, file, update, and memory flows
- OpenClaw-friendly auth fallback with Bearer support
- `/api/health` summary for dashboards and orchestration checks
- `/api/openclaw/compat` metadata endpoint
- MCP sidecar updated to use the real REST contract instead of the older placeholder payloads

### Good defaults for OpenClaw
```bash
export AGENT_MESH_API_KEY="openclaw-mesh-default-key"
export PORT=4000
npm start
```

### Quick compatibility checks
```bash
curl http://localhost:4000/health
curl -H "X-API-Key: openclaw-mesh-default-key" http://localhost:4000/api/health
curl -H "X-API-Key: openclaw-mesh-default-key" http://localhost:4000/api/openclaw/compat
```

## 🎯 Auto-Update System

### Key Feature: No Re-Registration Required!

**Problem:** Previous systems required agents to re-register with new IDs after updates, causing:
- Duplicate agent records
- Lost message history
- Broken capabilities tracking
- Confusing agent management

**Solution:** Agent Mesh v2.0.0+ uses **name-based identity persistence**:

1. **First Registration:** Agent gets UUID based on name
2. **Re-Registration:** Same name = same UUID (identity preserved)
3. **Auto-Update:** Agents update and re-register without ID changes

### How It Works

```bash
# First registration
curl -X POST http://localhost:4000/api/agents/register \
  -H "X-API-Key: openclaw-mesh-default-key" \
  -d '{"name": "DuckBot", "endpoint": "http://localhost:3000"}'
# Response: agentId = "cc5afd10-ca32-4514-85f9-2558c70f2164"

# Re-registration (after update)
curl -X POST http://localhost:4000/api/agents/register \
  -H "X-API-Key: openclaw-mesh-default-key" \
  -d '{"name": "DuckBot", "endpoint": "http://localhost:3001"}'
# Response: agentId = "cc5afd10-ca32-4514-85f9-2558c70f2164" (SAME ID!)
```

### Auto-Update Client

```bash
node auto-update-client.js \
  --agent-name "MyAgent" \
  --endpoint "http://localhost:3000" \
  --version "1.0.0"
```

**Features:**
- ✅ Real-time update notifications via WebSocket
- ✅ Automatic update acknowledgment
- ✅ Version compatibility checking
- ✅ Breaking change warnings
- ✅ Custom update logic support

**Full Documentation:** See [AUTO-UPDATE-README.md](AUTO-UPDATE-README.md)

---

## 📊 Examples

### Discover Agents by Capability

```bash
curl "http://localhost:4000/api/agents?capability=web_search" \
  -H "X-API-Key: openclaw-mesh-default-key"
```

### Upload File

```bash
FILE_DATA=$(base64 -w 0 myfile.txt)
curl -X POST http://localhost:4000/api/files/upload \
  -H "Content-Type: application/json" \
  -H "X-API-Key: openclaw-mesh-default-key" \
  -d "{
    \"agentId\": \"cc5afd10-ca32-4514-85f9-2558c70f2164\",
    \"filename\": \"myfile.txt\",
    \"fileType\": \"text/plain\",
    \"fileData\": \"$FILE_DATA\",
    \"description\": \"Important document\"
  }"
```

### Create System Update

```bash
curl -X POST http://localhost:4000/api/updates \
  -H "Content-Type: application/json" \
  -H "X-API-Key: openclaw-mesh-default-key" \
  -d '{
    "version": "2.0.0",
    "updateType": "feature",
    "title": "File Transfer System",
    "description": "Agents can now share files",
    "breakingChange": false
  }'
```

### Report Catastrophe

```bash
curl -X POST http://localhost:4000/api/catastrophe \
  -H "Content-Type: application/json" \
  -H "X-API-Key: openclaw-mesh-default-key" \
  -d '{
    "eventType": "server_crash",
    "severity": "critical",
    "title": "Server crashed unexpectedly",
    "description": "Detected crash at 2026-02-08 20:00"
  }'
```

### Get Health Dashboard

```bash
curl http://localhost:4000/api/health/dashboard \
  -H "X-API-Key: openclaw-mesh-default-key"
```

**Response:**
```json
{
  "totalAgents": 5,
  "healthy": 3,
  "degraded": 1,
  "unhealthy": 0,
  "offline": 1,
  "criticalEvents": 0
}
```

---

## 🗄️ Database

**License**

MIT License - Free for use in OpenClaw and other agent systems

---

**Repository:** https://github.com/Franzferdinan51/agent-mesh-api

**Status:** ✅ Production Ready (v2.1.0)

**Last Updated:** 2026-02-10

---

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

### Tables

- `agents` - Agent registration and metadata
- `messages` - Inter-agent messages
- `skills` - Agent skill discovery
- `agent_files` - File storage (v2.0.0)
- `system_updates` - Update tracking (v2.0.0)
- `update_acknowledgments` - Update adoption (v2.0.0)
- `catastrophe_events` - Incident tracking (v2.0.0)
- `agent_health_status` - Health metrics (v2.0.0)

---

## 📚 Documentation

- **Full API Reference:** [API_DOCUMENTATION.md](API_DOCUMENTATION.md)
- **Auto-Update System:** [AUTO-UPDATE-README.md](AUTO-UPDATE-README.md)
- **Enhancement Plan:** [ENHANCEMENT-PLAN.md](ENHANCEMENT-PLAN.md)
- **WebSocket Client:** [websocket-client.js](websocket-client.js)
- **Auto-Update Client:** [auto-update-client.js](auto-update-client.js)

---

## 🛠️ Development

### Run in Development Mode

```bash
npm run dev
```

### Run WebSocket Client

```bash
npm run ws-client
```

### Test API

```bash
node test-api.js
```

---

## 🔒 Security

- API key required for all operations
- Agent names are unique identifiers
- CORS enabled for web UI
- WebSocket connection authentication

---

## 📈 Version History

### v2.1.0 (2026-02-08)
- ✅ Auto-update client for agents
- ✅ Identity preservation (no re-registration)
- ✅ Real-time update notifications
- ✅ Version compatibility checking

### v2.0.0 (2026-02-08)
- ✅ File transfer system
- ✅ System updates
- ✅ Catastrophe protocols
- ✅ Health monitoring

### v1.0.0 (2026-02-07)
- ✅ Agent registration
- ✅ Messaging system
- ✅ Heartbeat
- ✅ WebSocket events

---

## 🤝 Contributing

To contribute:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

---

## 📄 License

MIT License - Free for use in OpenClaw and other agent systems

---

## 💰 Support Development

If you find Agent Mesh useful, consider supporting development:

**Bitcoin:** `bc1q733czwuelntfug8jgur6md2lhzcx7l5ufks9y7`

---

**Repository:** https://github.com/Franzferdinan51/agent-mesh-api

**Status:** ✅ Production Ready (v2.1.0)

**Last Updated:** 2026-04-19 00:00 EDT
