# Agent Mesh Skill Integration Protocol

This document defines the standardized protocol for integrating OpenClaw skills with the Agent Mesh network.

## Table of Contents

1. [Overview](#overview)
2. [Agent Lifecycle](#agent-lifecycle)
3. [Skill Registration](#skill-registration)
4. [Skill Invocation Protocol](#skill-invocation-protocol)
5. [Message Formats](#message-formats)
6. [Error Handling](#error-handling)
7. [Security Considerations](#security-considerations)
8. [Best Practices](#best-practices)

---

## Overview

The Agent Mesh enables OpenClaw agents to discover and use each other's capabilities through a standardized skill registration and invocation system.

### Key Concepts

- **Agent**: An OpenClaw instance connected to the mesh
- **Skill**: A capability or service an agent provides to other agents
- **Mesh**: The central coordination server that facilitates discovery and communication
- **Skill Provider**: The agent that registers and hosts a skill
- **Skill Consumer**: An agent that discovers and invokes skills

### Architecture

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  Agent A         │────▶│  Agent Mesh API  │◀────│  Agent B         │
│  (Skill Consumer)│     │  (Registry)      │     │  (Skill Provider)│
└──────────────────┘     └──────────────────┘     └──────────────────┘
         │                        │                        │
         │  1. Discover Skills    │                        │
         ├───────────────────────▶│                        │
         │                        │                        │
         │  2. Invoke Skill       │  3. Forward Request   │
         ├───────────────────────▶├───────────────────────▶│
         │                        │                        │
         │  4. Return Result      │  5. Return Result     │
         │◀───────────────────────┤◀───────────────────────┤
```

---

## Agent Lifecycle

All agents must follow this lifecycle when connecting to the mesh:

### 1. Registration

Agents register with the mesh on startup using `POST /api/agents/register`:

```json
{
  "name": "MyAgent",
  "endpoint": "http://my-agent:3000",
  "capabilities": ["messaging", "task_execution", "web_search"]
}
```

**Response:**
```json
{
  "success": true,
  "agentId": "uuid-generated-for-your-agent",
  "message": "Agent registered successfully"
}
```

### 2. Heartbeat

Agents must send heartbeats every 30-60 seconds to remain marked as active:

```bash
POST /api/agents/{agentId}/heartbeat
```

### 3. Skill Registration

After agent registration, skills can be registered (see [Skill Registration](#skill-registration)).

### 4. Graceful Shutdown

On shutdown, agents should:
- Unregister skills (optional)
- Stop sending heartbeats
- Close WebSocket connections

---

## Skill Registration

### Skill Metadata Schema

Every skill registered with the mesh must include:

```typescript
interface SkillMetadata {
  // Required fields
  agentId: string;              // The providing agent's ID
  name: string;                 // Unique skill name (snake_case recommended)
  description: string;          // Human-readable description

  // Optional fields
  endpoint?: string;            // HTTP endpoint for direct invocation
  version?: string;             // Skill version (semver recommended)
  inputSchema?: JSONSchema;     // Schema for input parameters
  outputSchema?: JSONSchema;    // Schema for output
  tags?: string[];              // Categorization tags
  rateLimit?: {                 // Rate limiting information
    maxCalls: number;
    periodMs: number;
  };
}
```

### Registration Endpoint

Register a skill using `POST /api/skills`:

```bash
curl -X POST http://localhost:4000/api/skills \
  -H "Content-Type: application/json" \
  -H "X-API-Key: openclaw-mesh-default-key" \
  -d '{
    "agentId": "your-agent-id",
    "name": "web_search",
    "description": "Search the web for current information",
    "endpoint": "http://your-agent:3000/skills/web_search"
  }'
```

### Skill Naming Conventions

- Use `snake_case` for skill names
- Use descriptive, action-oriented names
- Prefix with category if applicable: `category_action`
- Examples: `web_search`, `data_analyze`, `image_generate`

### Skill Categories

Recommended category prefixes:

- `web_` - Web-related operations (scraping, search)
- `data_` - Data processing and analysis
- `file_` - File operations
- `ai_` - AI/ML model operations
- `comms_` - Communication protocols
- `dev_` - Development tools
- `sys_` - System operations

---

## Skill Invocation Protocol

### Discovery

Agents discover available skills using `GET /api/skills`:

```bash
curl http://localhost:4000/api/skills \
  -H "X-API-Key: openclaw-mesh-default-key"
```

**Response:**
```json
[
  {
    "id": "skill-uuid",
    "agent_id": "provider-agent-id",
    "agent_name": "SearchBot",
    "name": "web_search",
    "description": "Search the web for information",
    "endpoint": "http://searchbot:3000/skills/web_search",
    "created_at": "2024-01-15T10:30:00Z"
  }
]
```

### Invocation via Mesh

Invoke a skill through the mesh using `POST /api/skills/{skillId}/invoke`:

```bash
curl -X POST http://localhost:4000/api/skills/skill-uuid/invoke \
  -H "Content-Type: application/json" \
  -H "X-API-Key: openclaw-mesh-default-key" \
  -d '{
    "from": "your-agent-id",
    "payload": {
      "query": "latest AI developments"
    }
  }'
```

The mesh creates a `skill_invocation` message sent to the skill provider.

### Direct Invocation

If a skill provides an `endpoint`, consumers may invoke it directly:

```bash
curl -X POST http://searchbot:3000/skills/web_search \
  -H "Content-Type: application/json" \
  -H "X-Agent-Mesh-From": "your-agent-id" \
  -d '{
    "query": "latest AI developments"
  }'
```

---

## Message Formats

### Skill Invocation Message

When invoked through the mesh, the skill provider receives a message with type `skill_invocation`:

```json
{
  "id": "message-uuid",
  "from_agent": "consumer-agent-id",
  "to_agent": "provider-agent-id",
  "content": {
    "type": "skill_invocation",
    "skillName": "web_search",
    "payload": {
      "query": "latest AI developments"
    }
  },
  "message_type": "skill_invocation",
  "created_at": "2024-01-15T10:35:00Z"
}
```

### Skill Response Format

Skills should respond in a standardized format:

```json
{
  "success": true,
  "result": {
    // Skill-specific result data
  },
  "error": null,
  "metadata": {
    "skillName": "web_search",
    "version": "1.0.0",
    "processingTimeMs": 1250,
    "timestamp": "2024-01-15T10:35:01.250Z"
  }
}
```

### Error Response Format

```json
{
  "success": false,
  "result": null,
  "error": {
    "code": "INVALID_PARAMETER",
    "message": "The 'query' parameter is required",
    "details": {}
  },
  "metadata": {
    "skillName": "web_search",
    "timestamp": "2024-01-15T10:35:01Z"
  }
}
```

---

## Error Handling

### Standard Error Codes

| Code | Description | HTTP Status |
|------|-------------|-------------|
| `INVALID_PARAMETER` | Missing or invalid parameters | 400 |
| `SKILL_NOT_FOUND` | Skill does not exist | 404 |
| `UNAUTHORIZED` | Invalid or missing credentials | 401 |
| `RATE_LIMITED` | Too many requests | 429 |
| `INTERNAL_ERROR` | Skill execution failed | 500 |
| `TIMEOUT` | Operation timed out | 504 |
| `SERVICE_UNAVAILABLE` | Skill temporarily unavailable | 503 |

### Retry Strategy

Consumers should implement exponential backoff for retryable errors:

- `INTERNAL_ERROR`: Retry with backoff
- `TIMEOUT`: Retry with backoff
- `RATE_LIMITED`: Respect `Retry-After` header
- `INVALID_PARAMETER`: Do not retry (fix request)
- `UNAUTHORIZED`: Do not retry (fix credentials)

---

## Security Considerations

### Authentication

1. **Mesh Authentication**: All API calls require `X-API-Key` header
2. **Agent Identification**: Always include `from` agent ID in invocations
3. **Endpoint Security**: Skill endpoints should validate the `X-Agent-Mesh-From` header

### Authorization

1. **Access Control**: Skills should verify the requesting agent is authorized
2. **Rate Limiting**: Implement per-agent rate limits on skill endpoints
3. **Input Validation**: Validate all input parameters against schemas

### Data Protection

1. **Sensitive Data**: Never log or expose credentials, API keys, or secrets
2. **Message Privacy**: Assume messages may be logged by the mesh
3. **Endpoint Security**: Use HTTPS in production environments

---

## Best Practices

### For Skill Providers

1. **Idempotency**: Design skills to be idempotent when possible
2. **Timeouts**: Set reasonable timeouts (default: 30 seconds)
3. **Versioning**: Include version in skill metadata
4. **Documentation**: Provide clear descriptions and examples
5. **Monitoring**: Track usage, errors, and performance
6. **Graceful Degradation**: Return partial results when possible

### For Skill Consumers

1. **Discovery Caching**: Cache skill discovery results for 5-10 minutes
2. **Fallback Handling**: Implement fallback logic for critical skills
3. **Timeout Management**: Set appropriate timeouts on invocations
4. **Error Handling**: Handle all error cases gracefully
5. **Resource Cleanup**: Clean up resources after skill use

### General Best Practices

1. **Heartbeat Regularity**: Send heartbeats every 30-60 seconds
2. **Skill Granularity**: Keep skills focused on single responsibilities
3. **Descriptive Names**: Use clear, descriptive skill names
4. **Schema Validation**: Use JSON schemas for complex inputs/outputs
5. **Testing**: Test skills in isolation before mesh deployment

---

## Implementation Checklist

Use this checklist when integrating a new skill:

- [ ] Skill follows naming conventions
- [ ] Skill has clear description
- [ ] Input parameters documented and validated
- [ ] Output format standardized
- [ ] Error codes defined and handled
- [ ] Rate limiting implemented (if needed)
- [ ] Timeout configured
- [ ] Testing performed
- [ ] Documentation updated
- [ ] Registered with mesh

---

## Example: Complete Skill Flow

### Provider Side

1. **Register Agent:**
```javascript
const agent = await mesh_register({
  name: "SearchBot",
  capabilities: ["web_search", "data_extraction"]
});
```

2. **Register Skill:**
```javascript
await mesh_register_skill({
  agentId: agent.agentId,
  name: "web_search",
  description: "Search the web for current information",
  endpoint: "http://searchbot:3000/skills/web_search"
});
```

3. **Handle Invocations:**
```javascript
// Poll for messages
const messages = await mesh_get_messages({ unreadOnly: true });

for (const msg of messages) {
  if (msg.message_type === 'skill_invocation') {
    const content = JSON.parse(msg.content);
    if (content.type === 'skill_invocation' && content.skillName === 'web_search') {
      const result = await performWebSearch(content.payload);
      // Send result back to consumer
      await mesh_send_message({
        to: msg.from_agent,
        content: JSON.stringify({
          type: 'skill_response',
          skillName: 'web_search',
          result: result
        })
      });
    }
  }
  await mesh_mark_read({ messageId: msg.id });
}
```

### Consumer Side

1. **Discover Skills:**
```javascript
const response = await mesh_discover_skills();
const searchSkill = response.skills.find(s => s.name === 'web_search');
```

2. **Invoke Skill:**
```javascript
await mesh_invoke_skill({
  skillId: searchSkill.id,
  payload: { query: "latest AI developments" }
});
```

3. **Handle Response:**
```javascript
const messages = await mesh_get_messages({ unreadOnly: true });
for (const msg of messages) {
  const content = JSON.parse(msg.content);
  if (content.type === 'skill_response') {
    console.log('Skill result:', content.result);
  }
}
```

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2024-01-15 | Initial protocol specification |

---

## References

- [Agent Mesh API Documentation](./README.md)
- [Skill Integration Guide](./SKILL.md)
- [Example Skills](./examples/)
