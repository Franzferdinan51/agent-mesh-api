# Web Search Skill

An example skill demonstrating the Agent Mesh skill integration protocol.

## Description

Performs web searches using a search API and returns results. This skill demonstrates:
- Standardized input/output schemas
- Error handling with standard error codes
- Metadata tracking (version, processing time)
- Rate limiting
- Complete documentation

## Category

`web` - Web-related operations

## Version

1.0.0

## Parameters

| Parameter | Type | Required | Description | Default |
|-----------|------|----------|-------------|---------|
| query | string | Yes | The search query | - |
| max_results | number | No | Maximum number of results | 10 |
| language | string | No | Result language (en, es, fr, etc.) | en |

## Usage

### Registration

First, register this skill with the mesh:

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

### Invocation

```javascript
await mesh_invoke_skill({
  skillId: 'web-search-skill-id',
  payload: {
    query: 'latest AI developments',
    max_results: 5,
    language: 'en'
  }
});
```

## Response

### Success Response

```json
{
  "success": true,
  "result": {
    "query": "latest AI developments",
    "results": [
      {
        "title": "Example Article",
        "url": "https://example.com/article",
        "snippet": "Article snippet...",
        "source": "example.com"
      }
    ],
    "totalResults": 15000000,
    "searchTime": 0.45
  },
  "error": null,
  "metadata": {
    "skillName": "web_search",
    "version": "1.0.0",
    "processingTimeMs": 1250,
    "timestamp": "2024-01-15T10:30:00Z"
  }
}
```

### Error Response

```json
{
  "success": false,
  "result": null,
  "error": {
    "code": "INVALID_PARAMETER",
    "message": "The 'query' parameter is required and must be a non-empty string",
    "details": {
      "parameter": "query",
      "constraint": "non-empty string"
    }
  },
  "metadata": {
    "skillName": "web_search",
    "version": "1.0.0",
    "processingTimeMs": 5,
    "timestamp": "2024-01-15T10:30:00Z"
  }
}
```

## Error Codes

| Error Code | Description | HTTP Status | Retryable |
|------------|-------------|-------------|-----------|
| `INVALID_PARAMETER` | Missing or invalid parameters | 400 | No |
| `RATE_LIMITED` | Too many search requests | 429 | Yes |
| `SEARCH_API_ERROR` | External search API failure | 502 | Yes |
| `INTERNAL_ERROR` | Skill execution failed | 500 | Yes |
| `TIMEOUT` | Search operation timed out | 504 | Yes |

## Rate Limits

- Maximum 100 searches per minute per agent
- Maximum 1000 searches per hour per agent

## Implementation

See [implementation.js](./implementation.js) for the complete implementation following the Agent Mesh skill protocol.

## Testing

```bash
# Test the skill endpoint
curl -X POST http://localhost:3000/skills/web_search \
  -H "Content-Type: application/json" \
  -d '{
    "query": "test search",
    "max_results": 5
  }'

# Test with invalid input
curl -X POST http://localhost:3000/skills/web_search \
  -H "Content-Type: application/json" \
  -d '{
    "max_results": 5
  }'
```

## Integration with Agent Mesh

1. Ensure your agent is registered with the mesh
2. Start your skill endpoint
3. Register the skill using the registration endpoint
4. Other agents can now discover and invoke your skill

## Dependencies

- Express.js (or similar web framework)
- Axios (for HTTP requests to search API)
- Rate limiting library (e.g., express-rate-limit)

## See Also

- [Skill Protocol Specification](../../SKILL_PROTOCOL.md)
- [Skill Template](../../SKILL_TEMPLATE.md)
- [Agent Mesh Documentation](../../README.md)
