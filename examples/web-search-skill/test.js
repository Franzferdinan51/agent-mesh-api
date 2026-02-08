/**
 * Web Search Skill Test Suite
 *
 * Run these tests to verify your skill implementation
 * follows the Agent Mesh protocol correctly.
 */

import axios from 'axios';

const SKILL_ENDPOINT = process.env.SKILL_ENDPOINT || 'http://localhost:3000';

// ANSI color codes for output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[36m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// Test cases
const tests = [
  {
    name: 'Valid search request',
    request: {
      query: 'test search',
      max_results: 5
    },
    expectedStatus: 200,
    validator: (response) => {
      assert(response.data.success === true, 'Response should be successful');
      assert(response.data.result !== null, 'Result should not be null');
      assert(response.data.error === null, 'Error should be null');
      assert(response.data.metadata.skillName === 'web_search', 'Skill name should be web_search');
      assert(response.data.metadata.version === '1.0.0', 'Version should be 1.0.0');
      assert(response.data.metadata.processingTimeMs >= 0, 'Processing time should be non-negative');
      assert(response.data.metadata.timestamp, 'Timestamp should be present');
      assert(response.data.result.results !== undefined, 'Results should be present');
      assert(Array.isArray(response.data.result.results), 'Results should be an array');
      assert(response.data.result.query === 'test search', 'Query should match input');
    }
  },

  {
    name: 'Missing required parameter (query)',
    request: {
      max_results: 5
    },
    expectedStatus: 400,
    validator: (response) => {
      assert(response.data.success === false, 'Response should not be successful');
      assert(response.data.result === null, 'Result should be null');
      assert(response.data.error !== null, 'Error should not be null');
      assert(response.data.error.code === 'INVALID_PARAMETER', 'Error code should be INVALID_PARAMETER');
      assert(response.data.error.details.errors !== undefined, 'Error details should include errors array');
    }
  },

  {
    name: 'Invalid max_results (too high)',
    request: {
      query: 'test',
      max_results: 150
    },
    expectedStatus: 400,
    validator: (response) => {
      assert(response.data.success === false, 'Response should not be successful');
      assert(response.data.error.code === 'INVALID_PARAMETER', 'Error code should be INVALID_PARAMETER');
    }
  },

  {
    name: 'Invalid max_results (negative)',
    request: {
      query: 'test',
      max_results: -5
    },
    expectedStatus: 400,
    validator: (response) => {
      assert(response.data.success === false, 'Response should not be successful');
      assert(response.data.error.code === 'INVALID_PARAMETER', 'Error code should be INVALID_PARAMETER');
    }
  },

  {
    name: 'Invalid language',
    request: {
      query: 'test',
      language: 'invalid'
    },
    expectedStatus: 400,
    validator: (response) => {
      assert(response.data.success === false, 'Response should not be successful');
      assert(response.data.error.code === 'INVALID_PARAMETER', 'Error code should be INVALID_PARAMETER');
    }
  },

  {
    name: 'Valid search with all optional parameters',
    request: {
      query: 'advanced test',
      max_results: 20,
      language: 'es'
    },
    expectedStatus: 200,
    validator: (response) => {
      assert(response.data.success === true, 'Response should be successful');
      assert(response.data.result.results.length <= 20, 'Should respect max_results limit');
    }
  },

  {
    name: 'Empty query string',
    request: {
      query: '   '
    },
    expectedStatus: 400,
    validator: (response) => {
      assert(response.data.success === false, 'Response should not be successful');
      assert(response.data.error.code === 'INVALID_PARAMETER', 'Error code should be INVALID_PARAMETER');
    }
  }
];

// Health check test
async function testHealthCheck() {
  log('\n=== Testing Health Check Endpoint ===', 'blue');

  try {
    const response = await axios.get(`${SKILL_ENDPOINT}/skills/web_search/health`);

    assert(response.status === 200, 'Health check should return 200');
    assert(response.data.skillName === 'web_search', 'Skill name should match');
    assert(response.data.version === '1.0.0', 'Version should match');
    assert(response.data.status === 'healthy', 'Status should be healthy');
    assert(response.data.timestamp, 'Timestamp should be present');

    log('✓ Health check passed', 'green');
    return true;
  } catch (error) {
    log(`✗ Health check failed: ${error.message}`, 'red');
    return false;
  }
}

// Schema endpoint test
async function testSchemaEndpoint() {
  log('\n=== Testing Schema Endpoint ===', 'blue');

  try {
    const response = await axios.get(`${SKILL_ENDPOINT}/skills/web_search/schema`);

    assert(response.status === 200, 'Schema endpoint should return 200');
    assert(response.data.skillName === 'web_search', 'Skill name should match');
    assert(response.data.inputSchema !== undefined, 'Input schema should be present');
    assert(response.data.errorCodes !== undefined, 'Error codes should be present');
    assert(Array.isArray(response.data.errorCodes), 'Error codes should be an array');

    log('✓ Schema endpoint passed', 'green');
    return true;
  } catch (error) {
    log(`✗ Schema endpoint failed: ${error.message}`, 'red');
    return false;
  }
}

// Run all tests
async function runTests() {
  log('\n╔══════════════════════════════════════════════════════════╗', 'blue');
  log('║  Web Search Skill Test Suite                            ║', 'blue');
  log('║  Agent Mesh Protocol Validation                         ║', 'blue');
  log('╚══════════════════════════════════════════════════════════╝', 'blue');

  let passed = 0;
  let failed = 0;

  // Test health and schema first
  const healthOk = await testHealthCheck();
  const schemaOk = await testSchemaEndpoint();

  if (!healthOk || !schemaOk) {
    log('\n✗ Preliminary checks failed. Skipping main tests.', 'red');
    process.exit(1);
  }

  // Run main test suite
  log('\n=== Running Main Test Suite ===', 'blue');

  for (const test of tests) {
    try {
      log(`\n▶ Test: ${test.name}`, 'yellow');
      const response = await axios.post(`${SKILL_ENDPOINT}/skills/web_search`, test.request);

      // Check status code
      assert(response.status === test.expectedStatus,
        `Expected status ${test.expectedStatus}, got ${response.status}`);

      // Run custom validator
      test.validator(response);

      log(`✓ Passed (${response.data.metadata.processingTimeMs}ms)`, 'green');
      passed++;

    } catch (error) {
      if (error.response) {
        // Server responded with error status
        const actualStatus = error.response.status;
        const expectedStatus = test.expectedStatus;

        if (actualStatus === expectedStatus) {
          // Error response was expected
          try {
            test.validator(error.response);
            log(`✓ Passed (error as expected)`, 'green');
            passed++;
            continue;
          } catch (validationError) {
            // Validation failed
          }
        }
      }

      log(`✗ Failed: ${error.message}`, 'red');
      if (error.response) {
        log(`  Response: ${JSON.stringify(error.response.data, null, 2)}`, 'red');
      }
      failed++;
    }
  }

  // Summary
  log('\n=== Test Summary ===', 'blue');
  log(`Total tests: ${tests.length + 2}`, 'blue');
  log(`Passed: ${passed}`, 'green');
  log(`Failed: ${failed}`, failed > 0 ? 'red' : 'green');

  if (failed === 0) {
    log('\n✓ All tests passed! Skill is ready for mesh registration.', 'green');
    process.exit(0);
  } else {
    log('\n✗ Some tests failed. Please fix the issues before registering.', 'red');
    process.exit(1);
  }
}

// Run tests
runTests().catch(error => {
  log(`\n✗ Test suite error: ${error.message}`, 'red');
  console.error(error);
  process.exit(1);
});
