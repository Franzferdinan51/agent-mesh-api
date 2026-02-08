/**
 * Web Search Skill - Agent Mesh Example
 *
 * This demonstrates the standardized skill integration protocol for Agent Mesh.
 * Follow this pattern when creating your own skills.
 */

import express from 'express';
import rateLimit from 'express-rate-limit';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

// Configuration
const SKILL_NAME = 'web_search';
const SKILL_VERSION = '1.0.0';
const SKILL_CATEGORY = 'web';

// Rate limiting
const searchLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Input Schema
 */
const inputSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      minLength: 1,
      description: 'The search query'
    },
    max_results: {
      type: 'number',
      minimum: 1,
      maximum: 100,
      default: 10,
      description: 'Maximum number of results to return'
    },
    language: {
      type: 'string',
      enum: ['en', 'es', 'fr', 'de', 'it', 'pt', 'ru', 'ja', 'zh', 'ko'],
      default: 'en',
      description: 'Language for search results'
    }
  },
  required: ['query']
};

/**
 * Error Codes
 */
const ErrorCodes = {
  INVALID_PARAMETER: 'INVALID_PARAMETER',
  RATE_LIMITED: 'RATE_LIMITED',
  SEARCH_API_ERROR: 'SEARCH_API_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  TIMEOUT: 'TIMEOUT'
};

/**
 * Validate input against schema
 */
function validateInput(input) {
  const errors = [];

  // Check required fields
  if (!input.query || typeof input.query !== 'string' || input.query.trim().length === 0) {
    errors.push({
      field: 'query',
      message: 'query is required and must be a non-empty string'
    });
  }

  // Validate max_results
  if (input.max_results !== undefined) {
    if (typeof input.max_results !== 'number') {
      errors.push({
        field: 'max_results',
        message: 'max_results must be a number'
      });
    } else if (input.max_results < 1 || input.max_results > 100) {
      errors.push({
        field: 'max_results',
        message: 'max_results must be between 1 and 100'
      });
    }
  }

  // Validate language
  if (input.language !== undefined) {
    const validLanguages = ['en', 'es', 'fr', 'de', 'it', 'pt', 'ru', 'ja', 'zh', 'ko'];
    if (!validLanguages.includes(input.language)) {
      errors.push({
        field: 'language',
        message: `language must be one of: ${validLanguages.join(', ')}`
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Perform the actual web search
 * In a real implementation, this would call a search API (Google, Bing, etc.)
 */
async function performWebSearch(query, maxResults, language) {
  // Simulated search - in production, integrate with real search API
  // Example APIs: Google Custom Search, Bing Search API, DuckDuckGo

  return new Promise((resolve, reject) => {
    // Simulate API delay
    setTimeout(() => {
      // Mock search results
      const results = [];
      for (let i = 0; i < Math.min(maxResults, 5); i++) {
        results.push({
          title: `Search Result ${i + 1} for "${query}"`,
          url: `https://example.com/result-${i + 1}`,
          snippet: `This is a mock search result snippet for the query "${query}"...`,
          source: 'example.com'
        });
      }

      resolve({
        query,
        results,
        totalResults: Math.floor(Math.random() * 10000000),
        searchTime: Math.random() * 0.5
      });
    }, 500 + Math.random() * 500);
  });
}

/**
 * Main skill endpoint
 */
router.post('/skills/web_search', searchLimiter, async (req, res) => {
  const requestId = uuidv4();
  const startTime = Date.now();

  console.log(`[${requestId}] ${SKILL_NAME} invoked:`, JSON.stringify(req.body));

  try {
    // Validate input
    const validation = validateInput(req.body);

    if (!validation.valid) {
      console.log(`[${requestId}] Validation failed:`, validation.errors);

      return res.status(400).json({
        success: false,
        result: null,
        error: {
          code: ErrorCodes.INVALID_PARAMETER,
          message: 'Invalid parameters provided',
          details: {
            errors: validation.errors
          }
        },
        metadata: {
          skillName: SKILL_NAME,
          version: SKILL_VERSION,
          category: SKILL_CATEGORY,
          processingTimeMs: Date.now() - startTime,
          timestamp: new Date().toISOString(),
          requestId
        }
      });
    }

    // Extract parameters with defaults
    const {
      query,
      max_results = 10,
      language = 'en'
    } = req.body;

    // Execute search
    console.log(`[${requestId}] Executing search: query="${query}", max_results=${max_results}, language=${language}`);

    const searchResult = await performWebSearch(query, max_results, language);

    const processingTime = Date.now() - startTime;
    console.log(`[${requestId}] Search completed in ${processingTime}ms`);

    // Return success response
    return res.json({
      success: true,
      result: searchResult,
      error: null,
      metadata: {
        skillName: SKILL_NAME,
        version: SKILL_VERSION,
        category: SKILL_CATEGORY,
        processingTimeMs: processingTime,
        timestamp: new Date().toISOString(),
        requestId
      }
    });

  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error(`[${requestId}] Error after ${processingTime}ms:`, error);

    // Determine error type
    let errorCode = ErrorCodes.INTERNAL_ERROR;
    let errorMessage = 'An internal error occurred';
    let httpStatus = 500;

    // Handle specific error types
    if (error.message && error.message.includes('timeout')) {
      errorCode = ErrorCodes.TIMEOUT;
      errorMessage = 'Search operation timed out';
      httpStatus = 504;
    } else if (error.message && error.message.includes('API')) {
      errorCode = ErrorCodes.SEARCH_API_ERROR;
      errorMessage = 'External search API error';
      httpStatus = 502;
    }

    return res.status(httpStatus).json({
      success: false,
      result: null,
      error: {
        code: errorCode,
        message: errorMessage,
        details: process.env.NODE_ENV === 'development' ? {
          message: error.message,
          stack: error.stack
        } : undefined
      },
      metadata: {
        skillName: SKILL_NAME,
        version: SKILL_VERSION,
        category: SKILL_CATEGORY,
        processingTimeMs: processingTime,
        timestamp: new Date().toISOString(),
        requestId
      }
    });
  }
});

/**
 * Health check endpoint
 */
router.get('/skills/web_search/health', (req, res) => {
  res.json({
    skillName: SKILL_NAME,
    version: SKILL_VERSION,
    category: SKILL_CATEGORY,
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

/**
 * Schema endpoint for documentation
 */
router.get('/skills/web_search/schema', (req, res) => {
  res.json({
    skillName: SKILL_NAME,
    version: SKILL_VERSION,
    category: SKILL_CATEGORY,
    description: 'Search the web for current information',
    inputSchema,
    errorCodes: Object.values(ErrorCodes),
    rateLimit: {
      maxRequests: 100,
      windowMs: 60000
    }
  });
});

export default router;

/**
 * Integration Example:
 *
 * In your Express app:
 *
 * import webSearchSkill from './examples/web-search-skill/implementation.js';
 * app.use('/', webSearchSkill);
 *
 * Then register with mesh:
 *
 * await mesh_register_skill({
 *   agentId: agentId,
 *   name: 'web_search',
 *   description: 'Search the web for current information',
 *   endpoint: 'http://your-agent:3000/skills/web_search'
 * });
 */
