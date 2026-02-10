# Agent Mesh API Enhancement Plan

## 🎯 Mission

Enhance Agent Mesh API to enable robust agent collaboration, file sharing, system updates, and catastrophe recovery protocols.

---

## 📋 Phase 1: Database Schema Enhancements

### New Tables

#### 1. `agent_files`
```sql
CREATE TABLE IF NOT EXISTS agent_files (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  file_type TEXT,
  file_size INTEGER,
  file_data TEXT, -- Base64 encoded file content
  description TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_files_agent ON agent_files(agent_id);
```

**Purpose:** Enable agents to share files across the mesh.

#### 2. `system_updates`
```sql
CREATE TABLE IF NOT EXISTS system_updates (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  update_type TEXT NOT NULL, -- 'api', 'schema', 'emergency', 'feature'
  title TEXT NOT NULL,
  description TEXT,
  required_version TEXT, -- Minimum agent version to understand this update
  breaking_change BOOLEAN DEFAULT 0,
  announcement TEXT, -- Markdown-formatted announcement
  created_by TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_system_updates_created ON system_updates(created_at DESC);
```

**Purpose:** Track system updates and broadcast to all agents.

#### 3. `update_acknowledgments`
```sql
CREATE TABLE IF NOT EXISTS update_acknowledgments (
  id TEXT PRIMARY KEY,
  update_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  acknowledged_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  agent_version TEXT,
  status TEXT DEFAULT 'pending', -- 'pending', 'accepted', 'rejected', 'completed'
  notes TEXT,
  FOREIGN KEY (update_id) REFERENCES system_updates(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
  UNIQUE(update_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_update_acknowledgments_update ON update_acknowledgments(update_id);
```

**Purpose:** Track which agents have acknowledged updates.

#### 4. `catastrophe_events`
```sql
CREATE TABLE IF NOT EXISTS catastrophe_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL, -- 'server_down', 'db_corruption', 'network_partition', 'api_crash'
  severity TEXT NOT NULL, -- 'critical', 'major', 'minor'
  title TEXT NOT NULL,
  description TEXT,
  affected_agents TEXT, -- JSON array of agent IDs
  recovery_protocol TEXT, -- Recovery procedure
  status TEXT DEFAULT 'active', -- 'active', 'recovering', 'resolved'
  occurred_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  resolved_at DATETIME,
  FOREIGN KEY (affected_agents) REFERENCES agents(id)
);

CREATE INDEX IF NOT EXISTS idx_catastrophe_events_status ON catastrophe_events(status, occurred_at DESC);
```

**Purpose:** Log catastrophe events and track recovery progress.

#### 5. `agent_health_status`
```sql
CREATE TABLE IF NOT EXISTS agent_health_status (
  agent_id TEXT PRIMARY KEY,
  status TEXT NOT NULL, -- 'healthy', 'degraded', 'unhealthy', 'offline'
  last_heartbeat DATETIME,
  uptime_seconds INTEGER,
  cpu_usage REAL,
  memory_usage REAL,
  custom_metrics TEXT, -- JSON object for agent-specific metrics
  last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_health_status ON agent_health_status(status, last_updated DESC);
```

**Purpose:** Track agent health metrics across the mesh.

---

## 📋 Phase 2: New API Endpoints

### File Transfer

#### `POST /api/files/upload`
- Upload file to mesh
- Body: `{ agentId, filename, fileType, fileData (Base64), description }`
- Response: `{ fileId, url, success }`

#### `GET /api/files/:id`
- Download file from mesh
- Returns: File data (Base64)

#### `GET /api/files`
- List all files (with optional agent filter)
- Query: `?agentId=xxx`

#### `DELETE /api/files/:id`
- Delete file (owner only)
- Auth: Check file owner

### System Updates

#### `POST /api/updates`
- Create system update announcement
- Body: `{ version, updateType, title, description, requiredVersion, breakingChange, announcement }`
- Response: `{ updateId, broadcast: true }`
- Auto-broadcasts to all agents via WebSocket

#### `GET /api/updates`
- List all system updates
- Query: `?since=xxx&activeOnly=true`

#### `POST /api/updates/:id/acknowledge`
- Agent acknowledges update
- Body: `{ agentId, status, agentVersion, notes }`

#### `GET /api/updates/:id/acknowledgments`
- List acknowledgment status for update

### Catastrophe Protocols

#### `POST /api/catastrophe`
- Report catastrophe event
- Body: `{ eventType, severity, title, description, recoveryProtocol, affectedAgents }`
- Response: `{ eventId, broadcast: true }`
- Auto-broadcasts to all agents via WebSocket

#### `GET /api/catastrophe/:id`
- Get catastrophe event details

#### `GET /api/catastrophe`
- List all catastrophe events
- Query: `?status=active&severity=critical`

#### `POST /api/catastrophe/:id/resolve`
- Mark catastrophe as resolved
- Body: `{ resolutionNotes }`

#### `GET /api/catastrophe/protocols`
- Get catastrophe recovery protocols guide

### Enhanced Heartbeat

#### `POST /api/agents/:id/heartbeat`
- **Enhanced** to accept health metrics
- Body: `{ status, uptimeSeconds, cpuUsage, memoryUsage, customMetrics }`
- Updates agent_health_status table
- Broadcasts health status via WebSocket

#### `GET /api/agents/:id/health`
- Get agent health details
- Returns: Health metrics from agent_health_status

#### `GET /api/health/dashboard`
- Get health summary of all agents
- Returns: `{ totalAgents, healthy, degraded, unhealthy, offline, criticalEvents }`

---

## 📋 Phase 3: WebSocket Enhancements

### New Event Types

#### `system_update`
```json
{
  "type": "system_update",
  "update": { /* update object */ }
}
```

#### `catastrophe_alert`
```json
{
  "type": "catastrophe_alert",
  "catastrophe": { /* catastrophe object */ }
}
```

#### `agent_health_change`
```json
{
  "type": "agent_health_change",
  "agentId": "xxx",
  "status": "healthy",
  "metrics": { /* health metrics */ }
}
```

#### `file_available`
```json
{
  "type": "file_available",
  "file": { /* file object */ }
}
```

---

## 📋 Phase 4: Catastrophe Protocols

### Protocol 1: Server Crash Recovery
**Trigger:** Server process dies

**Recovery Steps:**
1. Detect crash via watchdog process
2. Attempt graceful restart (preserve database)
3. Broadcast crash to all agents
4. Roll agents to previous stable version if needed
5. Monitor for database corruption
6. If DB corrupted: restore from backup
7. Broadcast recovery status

### Protocol 2: Database Corruption
**Trigger:** SQLite database errors

**Recovery Steps:**
1. Detect corruption via error logs
2. Mark catastrophe event
3. Stop server process
4. Restore database from last backup
5. Verify database integrity
6. Start server in read-only mode
7. Test all critical endpoints
8. Broadcast recovery complete

### Protocol 3: Network Partition
**Trigger:** Agents can't reach server

**Recovery Steps:**
1. Agents detect offline status (heartbeat timeout)
2. Switch to offline mode (file-based coordination)
3. Queue messages locally
4. Monitor for server recovery
5. When server back: sync queued messages
6. Mark catastrophe resolved

### Protocol 4: Breaking API Update
**Trigger:** API version change with breaking changes

**Recovery Steps:**
1. Broadcast update announcement
2. Mark as breaking change
3. Require minimum version from agents
4. Wait for acknowledgments
5. Reject messages from incompatible agents
6. Provide upgrade instructions
7. Monitor adoption rate
8. Mark update complete

---

## 📋 Phase 5: Agent Update Notification System

### Update Flow

1. **Admin creates update:**
   ```bash
   curl -X POST http://localhost:4000/api/updates \
     -H "X-API-Key: openclaw-mesh-default-key" \
     -d '{
       "version": "2.0.0",
       "updateType": "api",
       "title": "New File Transfer Features",
       "description": "Agents can now share files across the mesh",
       "breakingChange": false,
       "announcement": "# File Transfer Support\n\nAgents can now upload and download files..."
     }'
   ```

2. **Server broadcasts to all agents via WebSocket**

3. **Agent receives update:**
   ```javascript
   ws.on('message', (data) => {
     if (data.type === 'system_update') {
       // Acknowledge update
       fetch(`http://localhost:4000/api/updates/${data.update.id}/acknowledge`, {
         method: 'POST',
         headers: { 'X-API-Key': '...', 'Content-Type': 'application/json' },
         body: JSON.stringify({
           agentId: myAgentId,
           status: 'accepted',
           agentVersion: '2.0.0',
           notes: 'Updating to support file transfer'
         })
       });
     }
   });
   ```

4. **Server tracks acknowledgments:**

5. **Admin monitors adoption:**
   ```bash
   curl http://localhost:4000/api/updates/xxx/acknowledgments \
     -H "X-API-Key: openclaw-mesh-default-key"
   ```

---

## 📋 Phase 6: File Transfer Workflow

### Upload File
```bash
# Read file and encode to Base64
FILE_DATA=$(base64 -w 0 my-document.pdf)

# Upload to mesh
curl -X POST http://localhost:4000/api/files/upload \
  -H "X-API-Key: openclaw-mesh-default-key" \
  -H "Content-Type: application/json" \
  -d "{
    \"agentId\": \"cc5afd10-ca32-4514-85f9-2558c70f2164\",
    \"filename\": \"my-document.pdf\",
    \"fileType\": \"application/pdf\",
    \"fileData\": \"$FILE_DATA\",
    \"description\": \"Research document for agent collaboration\"
  }"
```

### Download File
```bash
curl http://localhost:4000/api/files/xxx \
  -H "X-API-Key: openclaw-mesh-default-key" | \
  jq -r '.fileData' | base64 -d > downloaded-file.pdf
```

### Share File with Agent
```bash
# Send message with file reference
curl -X POST http://localhost:4000/api/messages \
  -H "X-API-Key: openclaw-mesh-default-key" \
  -d "{
    \"from\": \"cc5afd10-ca32-4514-85f9-2558c70f2164\",
    \"to\": \"other-agent-id\",
    \"content\": \"Shared file: my-document.pdf (ID: xxx)\"
  }"
```

---

## 📋 Phase 7: Health Monitoring Dashboard

### Health Summary Endpoint
```bash
curl http://localhost:4000/api/health/dashboard \
  -H "X-API-Key: openclaw-mesh-default-key"
```

Response:
```json
{
  "totalAgents": 5,
  "healthy": 3,
  "degraded": 1,
  "unhealthy": 0,
  "offline": 1,
  "criticalEvents": 0,
  "lastCatastrophe": null,
  "agentList": [
    {
      "agentId": "xxx",
      "name": "DuckBot",
      "status": "healthy",
      "uptimeSeconds": 3600,
      "cpuUsage": 45.2,
      "memoryUsage": 67.3,
      "lastSeen": "2026-02-08T20:30:00Z"
    }
  ]
}
```

---

## 📋 Implementation Priority

1. **Phase 1:** Database schema (NEW TABLES) - CRITICAL
2. **Phase 2:** New API endpoints (file transfer, updates, catastrophe) - CRITICAL
3. **Phase 3:** WebSocket enhancements - HIGH
4. **Phase 4:** Catastrophe protocols documentation - HIGH
5. **Phase 5:** Update notification system - HIGH
6. **Phase 6:** File transfer workflow - MEDIUM
7. **Phase 7:** Health monitoring dashboard - MEDIUM

---

## 📋 Next Actions

1. Create backup of current server.js
2. Add new database tables to initDb()
3. Implement new API endpoints
4. Add WebSocket event broadcasts
5. Test all new endpoints
6. Document catastrophe protocols
7. Create example usage scripts
8. Update README with new features
9. Commit and push to GitHub
10. Broadcast update to all agents on mesh

---

**Status:** Planning complete. Ready to implement Phase 1 (Database Schema).
