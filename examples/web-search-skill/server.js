/**
 * Standalone server for the Web Search Skill
 *
 * This allows you to run the skill independently for testing
 * before integrating it with your agent.
 */

import express from 'express';
import webSearchSkill from './implementation.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Mount the skill router
app.use('/', webSearchSkill);

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Web Search Skill for Agent Mesh',
    version: '1.0.0',
    endpoints: {
      health: '/skills/web_search/health',
      schema: '/skills/web_search/schema',
      execute: '/skills/web_search'
    },
    documentation: './README.md'
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: err.message
    },
    metadata: {
      skillName: 'web_search',
      timestamp: new Date().toISOString()
    }
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║  Web Search Skill Server                                 ║
║  Agent Mesh Example Skill                                ║
╠══════════════════════════════════════════════════════════╣
║  URL:       http://localhost:${PORT}                     ║
║  Health:   http://localhost:${PORT}/skills/web_search/health     ║
║  Schema:   http://localhost:${PORT}/skills/web_search/schema     ║
║  Execute:  http://localhost:${PORT}/skills/web_search            ║
╠══════════════════════════════════════════════════════════╣
║  Available Commands:                                      ║
║    npm test          - Run test suite                     ║
║    npm start        - Start this server                  ║
╚══════════════════════════════════════════════════════════╝

Ready to accept requests...
  `);
});
