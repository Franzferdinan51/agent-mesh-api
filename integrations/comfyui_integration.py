"""
Agent Mesh + ComfyUI Integration

This module allows agents on the Agent Mesh to trigger ComfyUI generations
and share inference resources across the mesh.

Usage:
    from integrations.comfyui_integration import ComfyUIMeshAgent
    
    agent = ComfyUIMeshAgent()
    agent.register_with_mesh()
    agent.listen_for_generation_requests()
"""

import requests
import json
import time
from typing import Optional, Dict, Any

# Agent Mesh settings
MESH_API_URL = "http://localhost:4000"
MESH_API_KEY = "openclaw-mesh-default-key"

# ComfyUI settings
COMFYUI_URL = "http://localhost:8188"
COMFYUI_DISTRIBUTED_URL = f"{COMFYUI_URL}/distributed"

# This agent's identity
AGENT_NAME = "ComfyUI-Mesh-Agent"


class ComfyUIMeshAgent:
    """Integrates ComfyUI with Agent Mesh for distributed inference."""
    
    def __init__(self, agent_name: str = None):
        self.mesh_url = MESH_API_URL
        self.mesh_key = MESH_API_KEY
        self.comfyui_url = COMFYUI_URL
        self.comfyui_distributed_url = COMFYUI_DISTRIBUTED_URL
        self.agent_name = agent_name or AGENT_NAME
        self.mesh_agent_id = None
        self.running = False
    
    def register_with_mesh(self) -> bool:
        """Register this agent with the Agent Mesh."""
        print(f"Registering {self.agent_name} with Agent Mesh...")
        
        payload = {
            "name": self.agent_name,
            "endpoint": "http://localhost:18789",
            "capabilities": [
                "comfyui_inference",
                "image_generation", 
                "video_generation",
                "distributed_inference"
            ]
        }
        
        try:
            resp = requests.post(
                f"{self.mesh_url}/api/agents/register",
                headers={"X-API-Key": self.mesh_key, "Content-Type": "application/json"},
                json=payload,
                timeout=10
            )
            
            if resp.status_code == 200:
                data = resp.json()
                self.mesh_agent_id = data.get("agentId")
                print(f"Registered with mesh! Agent ID: {self.mesh_agent_id}")
                return True
            else:
                print(f"Registration failed: {resp.status_code}")
                return False
        except Exception as e:
            print(f"Error registering with mesh: {e}")
            return False
    
    def broadcast_availability(self):
        """Broadcast that ComfyUI is available for inference."""
        payload = {
            "content": json.dumps({
                "type": "service_announcement",
                "service": "comfyui_distributed",
                "capabilities": [
                    "image_generation",
                    "video_generation",
                    "distributed_inference",
                    "multi_gpu_processing"
                ],
                "endpoint": self.comfyui_distributed_url,
                "api_endpoint": f"{self.comfyui_url}/api",
                "distributed_endpoint": self.comfyui_distributed_url,
                "status": "available",
                "gpu": "NVIDIA GeForce RTX 5060 Ti (16GB)"
            }),
            "sender": self.agent_name,
            "priority": "normal"
        }
        
        try:
            resp = requests.post(
                f"{self.mesh_url}/api/broadcast",
                headers={"X-API-Key": self.mesh_key, "Content-Type": "application/json"},
                json=payload,
                timeout=10
            )
            if resp.status_code == 200:
                print("Broadcast availability to mesh")
            else:
                print(f"Broadcast failed: {resp.status_code}")
        except Exception as e:
            print(f"Broadcast error: {e}")
    
    def check_mesh_messages(self) -> list:
        """Check for messages from other agents."""
        if not self.mesh_agent_id:
            return []
        
        try:
            resp = requests.get(
                f"{self.mesh_url}/api/messages/{self.mesh_agent_id}",
                headers={"X-API-Key": self.mesh_key},
                timeout=5
            )
            
            if resp.status_code == 200:
                return resp.json().get("messages", [])
            return []
        except:
            return []
    
    def process_inference_request(self, message: dict) -> Optional[Dict[str, Any]]:
        """Process an inference request from another agent."""
        try:
            content = json.loads(message.get("content", "{}"))
            
            if content.get("type") != "inference_request":
                return None
            
            request_type = content.get("request_type")
            prompt = content.get("prompt")
            options = content.get("options", {})
            
            print(f"Received {request_type} request from {message.get('sender')}")
            
            if request_type == "image_generation":
                return self.generate_image(prompt, options)
            elif request_type == "video_generation":
                return self.generate_video(prompt, options)
            elif request_type == "distributed_inference":
                return self.queue_distributed_workflow(prompt, options)
            else:
                return {"error": f"Unknown request type: {request_type}"}
                
        except Exception as e:
            return {"error": str(e)}
    
    def generate_image(self, prompt: dict, options: dict) -> Dict[str, Any]:
        """Generate an image via ComfyUI."""
        try:
            workflow = {
                "3": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt.get("positive", ""), "clip": ["4", 0]}},
                "4": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt.get("negative", "bad quality"), "clip": ["4", 0]}},
                "5": {"class_type": "KSampler", "inputs": {"seed": options.get("seed", 42), "steps": options.get("steps", 20), "cfg": options.get("cfg", 8), "sampler_name": options.get("sampler", "euler"), "scheduler": "normal", "model": ["6", 0], "positive": ["3", 0], "negative": ["4", 0], "latent_image": ["7", 0]}},
                "6": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": options.get("model", "sd_xl_base_1.0.safetensors")}},
                "7": {"class_type": "EmptyLatentImage", "inputs": {"width": options.get("width", 1024), "height": options.get("height", 1024), "batch_size": 1}},
                "8": {"class_type": "VAEDecode", "inputs": {"samples": ["5", 0], "vae": ["6", 0]}},
                "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0], "filename_prefix": options.get("filename", "mesh_generated")}}
            }
            
            resp = requests.post(
                f"{self.comfyui_url}/api/prompt",
                json={"prompt": workflow, "client_id": "mesh-agent"},
                timeout=10
            )
            
            if resp.status_code == 200:
                return {"status": "queued", "prompt_id": resp.json().get("prompt_id")}
            else:
                return {"error": f"ComfyUI error: {resp.status_code}"}
                
        except Exception as e:
            return {"error": str(e)}
    
    def generate_video(self, prompt: dict, options: dict) -> Dict[str, Any]:
        """Generate a video via ComfyUI (WAN2.2)."""
        try:
            workflow = {
                "unet": {"class_type": "UNETLoader", "inputs": {"unet_name": "wan2.2_ti2v_5B_fp16.safetensors"}},
                "clip": {"class_type": "CLIPLoader", "inputs": {"clip_name": "umt5_xxl_fp8_e4m3fn_scaled.safetensors", "type": "wan"}},
                "vae": {"class_type": "VAELoader", "inputs": {"vae_name": "wan2.2_vae.safetensors"}},
                "pos": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["clip", 0], "text": prompt.get("prompt", "")}},
                "neg": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["clip", 0], "text": "blurry, distorted, cartoon"}},
                "model_shift": {"class_type": "ModelSamplingSD3", "inputs": {"model": ["unet", 0], "shift": 8}},
                "i2v": {"class_type": "Wan22ImageToVideoLatent", "inputs": {"vae": ["vae", 0], "width": options.get("width", 1280), "height": options.get("height", 704), "length": options.get("frames", 125), "batch_size": 1}},
                "samp": {"class_type": "KSampler", "inputs": {"seed": options.get("seed", 77777), "steps": 20, "cfg": 5, "sampler_name": "uni_pc", "model": ["model_shift", 0], "positive": ["pos", 0], "negative": ["neg", 0], "latent_image": ["i2v", 0]}},
                "decode": {"class_type": "VAEDecode", "inputs": {"samples": ["samp", 0], "vae": ["vae", 0]}},
                "create_video": {"class_type": "CreateVideo", "inputs": {"images": ["decode", 0], "fps": 24}},
                "save": {"class_type": "SaveVideo", "inputs": {"video": ["create_video", 0], "filename_prefix": options.get("filename", "mesh_video"), "format": "mp4"}}
            }
            
            resp = requests.post(
                f"{self.comfyui_url}/api/prompt",
                json={"prompt": workflow, "client_id": "mesh-agent-video"},
                timeout=10
            )
            
            if resp.status_code == 200:
                return {"status": "queued", "prompt_id": resp.json().get("prompt_id")}
            else:
                return {"error": f"ComfyUI error: {resp.status_code}"}
                
        except Exception as e:
            return {"error": str(e)}
    
    def queue_distributed_workflow(self, workflow: dict, options: dict) -> Dict[str, Any]:
        """Queue a distributed workflow via ComfyUI-Distributed API."""
        try:
            payload = {
                "prompt": workflow,
                "client_id": "mesh-distributed",
                "delegate_master": options.get("delegate_master", False),
                "enabled_worker_ids": options.get("worker_ids", [])
            }
            
            resp = requests.post(
                f"{self.comfyui_distributed_url}/queue",
                json=payload,
                timeout=10
            )
            
            if resp.status_code == 200:
                data = resp.json()
                return {
                    "status": "distributed_queued",
                    "prompt_id": data.get("prompt_id"),
                    "worker_count": data.get("worker_count", 1)
                }
            else:
                return {"error": f"Distributed API error: {resp.status_code}"}
                
        except Exception as e:
            return {"error": str(e)}
    
    def send_response(self, original_message: dict, response: Dict[str, Any]):
        """Send response back to the requesting agent."""
        payload = {
            "content": json.dumps({
                "type": "inference_response",
                "original_request": json.loads(original_message.get("content", "{}")),
                "response": response
            }),
            "sender": self.agent_name,
            "recipient": original_message.get("sender"),
            "priority": "normal"
        }
        
        try:
            requests.post(
                f"{self.mesh_url}/api/messages/send",
                headers={"X-API-Key": self.mesh_key, "Content-Type": "application/json"},
                json=payload,
                timeout=10
            )
            print(f"Sent response to {original_message.get('sender')}")
        except Exception as e:
            print(f"Failed to send response: {e}")
    
    def listen_for_requests(self):
        """Listen for inference requests from mesh agents."""
        print(f"{self.agent_name} listening for mesh requests...")
        self.running = True
        
        while self.running:
            try:
                messages = self.check_mesh_messages()
                
                for msg in messages:
                    response = self.process_inference_request(msg)
                    
                    if response:
                        self.send_response(msg, response)
                
                time.sleep(10)  # Poll every 10 seconds
                
            except Exception as e:
                print(f"Error in listen loop: {e}")
                time.sleep(30)
    
    def start(self):
        """Start the mesh integration."""
        if self.register_with_mesh():
            self.broadcast_availability()
            self.listen_for_requests()
    
    def stop(self):
        """Stop the mesh integration."""
        self.running = False
        print(f"{self.agent_name} stopped")


def run_mesh_integration():
    """Run the ComfyUI mesh integration."""
    agent = ComfyUIMeshAgent()
    agent.start()


if __name__ == "__main__":
    run_mesh_integration()
