/**
 * Agent Mesh Tools for OpenClaw
 * Simple HTTP client for Agent Mesh API
 */

import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load configuration
let config = {};
try {
  const configPath = path.join(__dirname, 'config.json');
  const configData = await fs.readFile(configPath, 'utf8');
  config = JSON.parse(configData);
} catch (e) {
  // Use defaults
}

// Default configuration
const MESH_URL = config.meshServerUrl || process.env.AGENT_MESH_URL || 'http://localhost:4000';
const API_KEY = config.apiKey || process.env.AGENT_MESH_API_KEY || 'openclaw-mesh-default-key';

// Store agent ID after registration
let agentId = null;

// HTTP client with auth
const api = axios.create({
  baseURL: MESH_URL,
  headers: {
    'X-API-Key': API_KEY,
    'Content-Type': 'application/json'
  },
  timeout: 10000
});

// Tool implementations
export const tools = {
  /**
   * Register agent with mesh
   */
  async mesh_register(params = {}) {
    const name = params.name || config.agentName || 'OpenClawAgent';
    const endpoint = params.endpoint || config.agentEndpoint;
    const capabilities = params.capabilities || config.capabilities || ['messaging'];
    
    try {
      const response = await api.post('/api/agents/register', {
        name,
        endpoint,
        capabilities
      });
      
      agentId = response.data.agentId;
      
      // Save agent ID for future use
      try {
        await fs.writeFile(
          path.join(__dirname, '.agent-id'),
          agentId,
          'utf8'
        );
      } catch (e) {
        // Ignore write errors
      }
      
      return {
        success: true,
        agentId: agentId,
        message: response.data.message
      };
    } catch (error) {
      return {
        success: false,
        error: error.response?.data?.error || error.message
      };
    }
  },

  /**
   * Send message to another agent
   */
  async mesh_send_message(params) {
    const from = agentId || params.from;
    const to = params.to;
    const content = params.content;
    
    if (!from || !to || !content) {
      return { error: 'from, to, and content are required' };
    }
    
    try {
      const response = await api.post('/api/messages', {
        from,
        to,
        content
      });
      
      return {
        success: true,
        messageId: response.data.messageId,
        message: response.data.message
      };
    } catch (error) {
      return {
        success: false,
        error: error.response?.data?.error || error.message
      };
    }
  },

  /**
   * Get messages for this agent
   */
  async mesh_get_messages(params = {}) {
    const id = agentId || params.agentId;
    
    if (!id) {
      return { error: 'Agent not registered. Call mesh_register first.' };
    }
    
    try {
      const queryParams = new URLSearchParams();
      if (params.unreadOnly) queryParams.append('unreadOnly', 'true');
      if (params.since) queryParams.append('since', params.since);
      
      const url = `/api/messages/${id}?${queryParams.toString()}`;
      const response = await api.get(url);
      
      return {
        success: true,
        messages: response.data,
        count: response.data.length
      };
    } catch (error) {
      return {
        success: false,
        error: error.response?.data?.error || error.message
      };
    }
  },

  /**
   * Mark message as read
   */
  async mesh_mark_read(params) {
    const messageId = params.messageId || params.id;
    
    if (!messageId) {
      return { error: 'messageId is required' };
    }
    
    try {
      await api.post(`/api/messages/${messageId}/read`);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error.response?.data?.error || error.message
      };
    }
  },

  /**
   * Broadcast message to all agents
   */
  async mesh_broadcast(params) {
    const from = agentId || params.from;
    const content = params.content;
    
    if (!from || !content) {
      return { error: 'from and content are required' };
    }
    
    try {
      const response = await api.post('/api/broadcast', {
        from,
        content
      });
      
      return {
        success: true,
        recipientCount: response.data.recipientCount
      };
    } catch (error) {
      return {
        success: false,
        error: error.response?.data?.error || error.message
      };
    }
  },

  /**
   * List all registered agents
   */
  async mesh_list_agents() {
    try {
      const response = await api.get('/api/agents');
      return {
        success: true,
        agents: response.data,
        count: response.data.length
      };
    } catch (error) {
      return {
        success: false,
        error: error.response?.data?.error || error.message
      };
    }
  },

  /**
   * Send heartbeat to keep agent active
   */
  async mesh_heartbeat() {
    const id = agentId;
    
    if (!id) {
      return { error: 'Agent not registered' };
    }
    
    try {
      await api.post(`/api/agents/${id}/heartbeat`);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error.response?.data?.error || error.message
      };
    }
  },

  /**
   * Register a skill
   */
  async mesh_register_skill(params) {
    const agentId = agentId || params.agentId;
    const name = params.name;
    const description = params.description;
    const endpoint = params.endpoint;
    
    if (!agentId || !name) {
      return { error: 'agentId and name are required' };
    }
    
    try {
      const response = await api.post('/api/skills', {
        agentId,
        name,
        description,
        endpoint
      });
      
      return {
        success: true,
        skillId: response.data.skillId
      };
    } catch (error) {
      return {
        success: false,
        error: error.response?.data?.error || error.message
      };
    }
  },

  /**
   * Discover skills from all agents
   */
  async mesh_discover_skills() {
    try {
      const response = await api.get('/api/skills');
      return {
        success: true,
        skills: response.data,
        count: response.data.length
      };
    } catch (error) {
      return {
        success: false,
        error: error.response?.data?.error || error.message
      };
    }
  },

  /**
   * Invoke a skill on another agent
   */
  async mesh_invoke_skill(params) {
    const skillId = params.skillId || params.id;
    const from = agentId || params.from;
    const payload = params.payload || {};
    
    if (!skillId || !from) {
      return { error: 'skillId and from are required' };
    }
    
    try {
      const response = await api.post(`/api/skills/${skillId}/invoke`, {
        from,
        payload
      });
      
      return {
        success: true,
        invocationId: response.data.invocationId
      };
    } catch (error) {
      return {
        success: false,
        error: error.response?.data?.error || error.message
      };
    }
  }
};

// Load saved agent ID on startup
try {
  const savedId = await fs.readFile(
    path.join(__dirname, '.agent-id'),
    'utf8'
  );
  agentId = savedId.trim();
  console.log(`[Agent Mesh] Loaded agent ID: ${agentId}`);
} catch (e) {
  // No saved ID
}

export default tools;
