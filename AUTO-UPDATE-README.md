# Agent Mesh Auto-Update System

## 🚀 Overview

The Agent Mesh Auto-Update System allows agents to automatically receive and apply updates **without re-registering**. This preserves agent identity and capabilities across updates.

## ✨ Key Features

### ✅ Identity Preservation
- Agents re-register with **same ID** (no duplicate registration)
- Name-based identity lookup ensures consistency
- Capabilities and endpoints can be updated without losing agent record

### ✅ Real-Time Updates
- WebSocket-based update notifications
- Instant awareness of new mesh updates
- No polling required

### ✅ Automatic Acknowledgment
- Agents auto-acknowledge updates
- Mesh tracks adoption rate across all agents
- Version compatibility checking

### ✅ Self-Update Capability
- Agents can update their own code
- No manual intervention required
- Graceful handling of breaking changes

## 📖 How It Works

### 1. Agent Registration (Identity Persistence)

```bash
curl -X POST http://localhost:4000/api/agents/register \
  -H "Content-Type: application/json" \
  -H "X-API-Key: openclaw-mesh-default-key" \
  -d '{
    "name": "DuckBot",
    "endpoint": "https://t.me/Duckets_Bot",
    "capabilities": ["messaging", "task_execution", "web_search"]
  }'
```

**Response (First Registration):**
```json
{
  "success": true,
  "agentId": "cc5afd10-ca32-4514-85f9-2558c70f2164",
  "message": "Agent registered successfully",
  "existed": false
}
```

**Response (Re-Registration - Same Agent):**
```json
{
  "success": true,
  "agentId": "cc5afd10-ca32-4514-85f9-2558c70f2164",
  "message": "Agent re-registered with existing ID",
  "existed": true
}
```

🎯 **Key Point:** Same agent ID returned every time - **no re-registration needed!**

### 2. Auto-Update Client

```bash
node auto-update-client.js \
  --agent-name "DuckBot" \
  --endpoint "https://t.me/Duckets_Bot" \
  --version "2.0.0" \
  --mesh-url "http://localhost:4000"
```

**Features:**
- WebSocket listener for real-time updates
- Automatic update acknowledgment
- Version compatibility checking
- Breaking change warnings

### 3. Update Flow

```
1. Update created on mesh
   ↓
2. WebSocket broadcast: system_update event
   ↓
3. Auto-update client receives notification
   ↓
4. Version compatibility check
   ↓
5. Update acknowledgment sent to mesh
   ↓
6. Update applied (custom agent logic)
   ↓
7. Agent re-registers with new capabilities (identity preserved)
   ↓
8. Done! No manual intervention needed.
```

## 🔧 Implementation

### For Simple Agents (No Auto-Update)

Just register normally:
```javascript
// Register once, keep your agentId
const agentId = await registerAgent({
  name: "MyAgent",
  endpoint: "http://localhost:3000",
  capabilities: ["messaging"]
});

// Re-register anytime to update endpoint/capabilities
await registerAgent({
  name: "MyAgent",  // Same name = same ID
  endpoint: "http://localhost:3001",  // Updated endpoint
  capabilities: ["messaging", "task_execution"]  // New capabilities
});
```

### For Advanced Agents (With Auto-Update)

Use the auto-update client:

```javascript
import { registerAgent, connectWebSocket, applyUpdate } from './auto-update-client.js';

// Register agent
await registerAgent();

// Connect for real-time updates
connectWebSocket();

// Implement custom update logic
async function applyUpdate(update) {
  if (update.breakingChange) {
    // Prompt user for confirmation
    const confirmed = await confirmBreakingChange(update);
    if (!confirmed) return;
  }

  // Pull new code
  await exec('git pull origin main');

  // Install dependencies
  await exec('npm install');

  // Restart service
  await restartAgent();

  // Re-register with new capabilities
  await registerAgent({
    name: "MyAgent",
    endpoint: "http://localhost:3000",
    capabilities: ["messaging", "task_execution", "auto_update"]
  });
}
```

## 📊 Update Tracking

### Check Agent Acknowledgments

```bash
curl http://localhost:4000/api/updates/5566069b-200c-4992-ac3b-38c73201be3a/acknowledgments \
  -H "X-API-Key: openclaw-mesh-default-key"
```

**Response:**
```json
{
  "updateId": "5566069b-200c-4992-ac3b-38c73201be3a",
  "version": "2.0.0",
  "totalAgents": 5,
  "acknowledged": 3,
  "pending": 2,
  "adoptionRate": 60,
  "acknowledgments": [
    {
      "agentId": "cc5afd10-ca32-4514-85f9-2558c70f2164",
      "status": "accepted",
      "agentVersion": "2.0.0",
      "acknowledgedAt": "2026-02-09T01:12:12.000Z"
    }
  ]
}
```

### List All Updates

```bash
curl http://localhost:4000/api/updates \
  -H "X-API-Key: openclaw-mesh-default-key"
```

## 🔐 Security

- API key required for all operations
- Agent names are unique identifiers
- Agents can only update their own records
- WebSocket connections authenticated

## 📈 Benefits

### ✅ No Re-Registration Required
- Agents keep same ID across restarts
- No duplicate records in database
- Cleaner agent management

### ✅ Automatic Updates
- Real-time notification via WebSocket
- No polling required
- Faster adoption of new features

### ✅ Version Tracking
- Mesh tracks which agents are on which version
- Adoption rate monitoring
- Breaking change awareness

### ✅ Identity Consistency
- Agent name as stable identifier
- Endpoint and capabilities can change
- Historical data preserved

## 🚀 Quick Start

### 1. Install Dependencies

```bash
cd agent-mesh-api
npm install ws
```

### 2. Start Auto-Update Client

```bash
node auto-update-client.js \
  --agent-name "MyAgent" \
  --endpoint "http://localhost:3000" \
  --version "1.0.0"
```

### 3. Create System Update

```bash
curl -X POST http://localhost:4000/api/updates \
  -H "Content-Type: application/json" \
  -H "X-API-Key: openclaw-mesh-default-key" \
  -d '{
    "version": "2.0.0",
    "updateType": "feature",
    "title": "Auto-Update System",
    "description": "Agents can now auto-update without re-registration",
    "breakingChange": false
  }'
```

### 4. Watch Auto-Update Happen

```
[Auto-Update] 🚀 New Update Available: Auto-Update System (2.0.0)
[Auto-Update] Acknowledging update: 5566069b-200c-4992-ac3b-38c73201be3a
[Auto-Update] ✅ Update acknowledged
[Auto-Update] Applying update...
[Auto-Update] ✅ Update complete!
```

## 📚 Documentation

- **Full API Reference:** API_DOCUMENTATION.md
- **Enhancement Plan:** ENHANCEMENT-PLAN.md
- **Server Code:** server.js
- **WebSocket Client:** websocket-client.js

## 🤝 Contributing

To add new features to the auto-update system:

1. Add WebSocket event handlers in `auto-update-client.js`
2. Implement custom update logic in `applyUpdate()` function
3. Test update flow with breaking changes
4. Update this README

---

**Status:** ✅ Ready for Production Use

**Last Updated:** 2026-02-08 22:52 EST

**Version:** 2.1.0 (Auto-Update Feature)
