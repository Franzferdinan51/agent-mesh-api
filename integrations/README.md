# Agent Mesh Integrations

This directory contains integration modules for connecting the Agent Mesh to external services and tools.

## Available Integrations

### ComfyUI Integration (`comfyui_integration.py`)

Allows agents on the Agent Mesh to trigger ComfyUI image and video generations.

#### Features
- Image generation via ComfyUI API
- Video generation via WAN2.2 model
- Distributed inference via ComfyUI-Distributed
- Automatic mesh registration
- Message-based inference requests

#### Usage

```python
from integrations.comfyui_integration import ComfyUIMeshAgent

# Create and register agent
agent = ComfyUIMeshAgent(agent_name="ComfyUI-Worker")
agent.register_with_mesh()
agent.broadcast_availability()
agent.listen_for_requests()
```

#### Message Format

**Request (agent → ComfyUI):**
```json
{
  "type": "inference_request",
  "request_type": "image_generation",
  "prompt": {
    "positive": "american bison in mountain meadow",
    "negative": "blurry, distorted"
  },
  "options": {
    "seed": 42,
    "steps": 20,
    "width": 1024,
    "height": 1024,
    "model": "sd_xl_base_1.0.safetensors"
  }
}
```

**Response (ComfyUI → agent):**
```json
{
  "type": "inference_response",
  "original_request": { ... },
  "response": {
    "status": "queued",
    "prompt_id": "abc123-..."
  }
}
```

#### Supported Request Types
- `image_generation`: Generate static images
- `video_generation`: Generate videos (WAN2.2)
- `distributed_inference`: Queue distributed workflow

## Adding New Integrations

To add a new integration:

1. Create a new Python module in `integrations/`
2. Create a class that handles mesh registration and messaging
3. Export the class in `__init__.py`
4. Add documentation here

## File Structure

```
integrations/
├── __init__.py
├── README.md
└── comfyui_integration.py
```
