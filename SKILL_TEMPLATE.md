# Skill Registration Template

Use this template to create new skills for the Agent Mesh network. Copy this template and customize it for your skill.

## Quick Start

1. Copy this template to a new file named after your skill
2. Fill in all required fields (marked with `REQUIRED`)
3. Follow the naming conventions and best practices
4. Test your skill before registering with the mesh

---

## Skill Metadata

### Basic Information

```yaml
skill:
  # REQUIRED: Unique identifier (use snake_case, category prefix recommended)
  name: category_skill_name

  # REQUIRED: Human-readable description (what does this skill do?)
  description: A clear, concise description of what this skill does and when to use it.

  # REQUIRED: Version (use semantic versioning)
  version: 1.0.0

  # REQUIRED: Skill category (web, data, file, ai, comms, dev, sys, or custom)
  category: web

  # Optional: Tags for discovery (comma-separated)
  tags: search,api,external

  # Optional: Authored by
  author: Your Name or Organization

  # Optional: Homepage or documentation URL
  homepage: https://github.com/your-repo
```

### Endpoint Configuration

```yaml
endpoint:
  # REQUIRED: HTTP endpoint where skill can be invoked
  url: http://your-agent:3000/skills/skill_name

  # Optional: HTTP method (default: POST)
  method: POST

  # Optional: Expected request format
  requestFormat: json

  # Optional: Expected response format
  responseFormat: json
```

### Rate Limiting

```yaml
rateLimit:
  # Optional: Maximum calls per period
  maxCalls: 100

  # Optional: Period in milliseconds
  periodMs: 60000
```

---

## Input Schema

Define what parameters your skill accepts:

```json
{
  "type": "object",
  "properties": {
    "parameter_name": {
      "type": "string",
      "description": "Description of what this parameter does",
      "required": true
    },
    "optional_parameter": {
      "type": "number",
      "description": "Description of optional parameter",
      "default": 42,
      "required": false
    }
  },
  "required": ["parameter_name"]
}
```

### Example Input

```json
{
  "parameter_name": "example value",
  "optional_parameter": 100
}
```

---

## Output Schema

Define what your skill returns:

```json
{
  "type": "object",
  "properties": {
    "success": {
      "type": "boolean",
      "description": "Whether the operation succeeded"
    },
    "result": {
      "type": "object",
      "description": "The result data"
    },
    "error": {
      "type": "object",
      "description": "Error details if success is false"
    },
    "metadata": {
      "type": "object",
      "description": "Execution metadata (time, version, etc.)"
    }
  }
}
```

### Example Output

Success response:
```json
{
  "success": true,
  "result": {
    "data": "The actual result data"
  },
  "error": null,
  "metadata": {
    "skillName": "category_skill_name",
    "version": "1.0.0",
    "processingTimeMs": 150,
    "timestamp": "2024-01-15T10:30:00Z"
  }
}
```

Error response:
```json
{
  "success": false,
  "result": null,
  "error": {
    "code": "INVALID_PARAMETER",
    "message": "The 'query' parameter is required",
    "details": {
      "missingFields": ["query"]
    }
  },
  "metadata": {
    "skillName": "category_skill_name",
    "version": "1.0.0",
    "timestamp": "2024-01-15T10:30:00Z"
  }
}
```

---

## Error Codes

Define error codes your skill may return:

| Error Code | Description | HTTP Status | Retryable |
|------------|-------------|-------------|-----------|
| `INVALID_PARAMETER` | Missing or invalid parameters | 400 | No |
| `RESOURCE_NOT_FOUND` | Requested resource not found | 404 | No |
| `UNAUTHORIZED` | Authentication/authorization failed | 401 | No |
| `RATE_LIMITED` | Too many requests | 429 | Yes |
| `EXTERNAL_API_ERROR` | External service failure | 502 | Yes |
| `INTERNAL_ERROR` | Skill execution failed | 500 | Yes |
| `TIMEOUT` | Operation timed out | 504 | Yes |

---

## Implementation Template

### Node.js/TypeScript Example

```typescript
/**
 * Category: Skill Name
 * Description: A clear description of what this skill does
 */

import { Request, Response } from 'express';

interface SkillInput {
  parameter_name: string;
  optional_parameter?: number;
}

interface SkillResult {
  // Define your result structure
  data: any;
}

interface SkillError {
  code: string;
  message: string;
  details?: any;
}

interface SkillResponse {
  success: boolean;
  result?: SkillResult;
  error?: SkillError;
  metadata: {
    skillName: string;
    version: string;
    processingTimeMs: number;
    timestamp: string;
  };
}

// Input validation
function validateInput(input: any): { valid: boolean; error?: string } {
  if (!input.parameter_name) {
    return { valid: false, error: 'parameter_name is required' };
  }
  return { valid: true };
}

// Main skill logic
async function executeSkill(input: SkillInput): Promise<SkillResult> {
  // Implement your skill logic here
  return {
    data: `Processed: ${input.parameter_name}`
  };
}

// HTTP handler
export async function skillHandler(req: Request, res: Response): Promise<void> {
  const startTime = Date.now();
  const version = '1.0.0';
  const skillName = 'category_skill_name';

  try {
    // Validate input
    const validation = validateInput(req.body);
    if (!validation.valid) {
      res.status(400).json({
        success: false,
        result: null,
        error: {
          code: 'INVALID_PARAMETER',
          message: validation.error
        },
        metadata: {
          skillName,
          version,
          processingTimeMs: Date.now() - startTime,
          timestamp: new Date().toISOString()
        }
      });
      return;
    }

    // Execute skill
    const result = await executeSkill(req.body);

    // Return success response
    res.json({
      success: true,
      result,
      error: null,
      metadata: {
        skillName,
        version,
        processingTimeMs: Date.now() - startTime,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    // Return error response
    res.status(500).json({
      success: false,
      result: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: error.message,
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      },
      metadata: {
        skillName,
        version,
        processingTimeMs: Date.now() - startTime,
        timestamp: new Date().toISOString()
      }
    });
  }
}
```

### Python Example

```python
"""
Category: Skill Name
Description: A clear description of what this skill does
"""

from datetime import datetime
from typing import Optional, Dict, Any
import time

class SkillInput:
    parameter_name: str
    optional_parameter: Optional[int] = None

class SkillResult:
    data: Any

class SkillError:
    code: str
    message: str
    details: Optional[Dict[str, Any]] = None

class SkillResponse:
    success: bool
    result: Optional[SkillResult]
    error: Optional[SkillError]
    metadata: Dict[str, Any]

def validate_input(data: Dict[str, Any]) -> tuple[bool, Optional[str]]:
    """Validate input parameters"""
    if 'parameter_name' not in data:
        return False, 'parameter_name is required'
    return True, None

def execute_skill(input_data: SkillInput) -> SkillResult:
    """Execute the main skill logic"""
    # Implement your skill logic here
    return SkillResult(data=f"Processed: {input_data.parameter_name}")

def skill_handler(request_data: Dict[str, Any]) -> SkillResponse:
    """HTTP request handler"""
    start_time = time.time()
    version = "1.0.0"
    skill_name = "category_skill_name"

    # Validate input
    valid, error = validate_input(request_data)
    if not valid:
        return SkillResponse(
            success=False,
            result=None,
            error=SkillError(
                code="INVALID_PARAMETER",
                message=error
            ),
            metadata={
                "skillName": skill_name,
                "version": version,
                "processingTimeMs": int((time.time() - start_time) * 1000),
                "timestamp": datetime.utcnow().isoformat()
            }
        )

    # Execute skill
    try:
        result = execute_skill(SkillInput(**request_data))
        return SkillResponse(
            success=True,
            result=result,
            error=None,
            metadata={
                "skillName": skill_name,
                "version": version,
                "processingTimeMs": int((time.time() - start_time) * 1000),
                "timestamp": datetime.utcnow().isoformat()
            }
        )
    except Exception as e:
        return SkillResponse(
            success=False,
            result=None,
            error=SkillError(
                code="INTERNAL_ERROR",
                message=str(e)
            ),
            metadata={
                "skillName": skill_name,
                "version": version,
                "processingTimeMs": int((time.time() - start_time) * 1000),
                "timestamp": datetime.utcnow().isoformat()
            }
        )

# Flask route example
@app.route('/skills/skill_name', methods=['POST'])
def handle_skill():
    return skill_handler(request.get_json())
```

---

## Mesh Registration

### Registration Request

Once your skill endpoint is implemented, register it with the mesh:

```bash
curl -X POST http://localhost:4000/api/skills \
  -H "Content-Type: application/json" \
  -H "X-API-Key: openclaw-mesh-default-key" \
  -d '{
    "agentId": "your-agent-id",
    "name": "category_skill_name",
    "description": "A clear, concise description of what this skill does",
    "endpoint": "http://your-agent:3000/skills/skill_name"
  }'
```

### Registration Response

```json
{
  "success": true,
  "skillId": "skill-uuid-generated-here"
}
```

Save the `skillId` for future reference.

---

## Testing Checklist

Before registering your skill, ensure:

- [ ] Input validation works correctly
- [ ] Required parameters are enforced
- [ ] Optional parameters have proper defaults
- [ ] Success responses match the output schema
- [ ] Error responses match the error schema
- [ ] All defined error codes are used appropriately
- [ ] Processing time is measured and included
- [ ] Timestamp is included in all responses
- [ ] Skill version is included in metadata
- [ ] Endpoint is accessible from the network
- [ ] Rate limiting is implemented (if applicable)
- [ ] Timeout handling is implemented
- [ ] Logging is appropriate (not too verbose, not too quiet)
- [ ] Tests cover success and failure cases
- [ ] Documentation is clear and complete

---

## Usage Examples

### Example 1: Basic Usage

```javascript
// Consumer side
await mesh_invoke_skill({
  skillId: 'skill-uuid',
  payload: {
    parameter_name: 'example value'
  }
});
```

### Example 2: With Optional Parameters

```javascript
await mesh_invoke_skill({
  skillId: 'skill-uuid',
  payload: {
    parameter_name: 'example value',
    optional_parameter: 100
  }
});
```

### Example 3: Error Handling

```javascript
const response = await mesh_invoke_skill({
  skillId: 'skill-uuid',
  payload: {
    parameter_name: 'example value'
  }
});

if (response.success) {
  console.log('Result:', response.result);
} else {
  console.error('Error:', response.error.code, response.error.message);
  // Handle specific error codes
  switch (response.error.code) {
    case 'INVALID_PARAMETER':
      // Fix and retry
      break;
    case 'RATE_LIMITED':
      // Wait and retry
      break;
    default:
      // Log and handle
  }
}
```

---

## Documentation Template

Copy this section into your skill's README or documentation:

```markdown
# Skill Name

A brief description of what this skill does.

## Description

Detailed description of the skill's purpose, use cases, and behavior.

## Parameters

| Parameter | Type | Required | Description | Default |
|-----------|------|----------|-------------|---------|
| param1 | string | Yes | Description | - |
| param2 | number | No | Description | 42 |

## Usage

```javascript
await mesh_invoke_skill({
  skillId: 'your-skill-id',
  payload: {
    param1: 'value',
    param2: 100
  }
});
```

## Response

Success:
```json
{
  "success": true,
  "result": {
    "data": "result data"
  }
}
```

Error:
```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Error description"
  }
}
```

## Error Codes

- `INVALID_PARAMETER`: Invalid input parameters
- `INTERNAL_ERROR`: Skill execution failed

## Rate Limits

Max 100 calls per minute.

## Version

1.0.0
```

---

## Additional Resources

- [Skill Integration Protocol](./SKILL_PROTOCOL.md)
- [Agent Mesh Documentation](./README.md)
- [Example Skills](./examples/)
