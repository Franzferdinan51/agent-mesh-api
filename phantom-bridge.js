/**
 * Agent Mesh Phantom Bridge
 * Reticulum Phantom integration for decentralized P2P file transfer
 * 
 * Wraps the Phantom CLI (python3 /path/to/phantom.py) with mesh API routes
 * Usage: POST /api/phantom/seed, /api/phantom/download, /api/phantom/status, /api/phantom/identity
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to Phantom CLI and venv python
const PHANTOM_PATH = process.env.PHANTOM_PATH || 
  path.join(process.env.HOME || '', 'Desktop', 'AgentTeam-GitHub', 'reticulum-phantom', 'phantom.py');
const PHANTOM_PYTHON = process.env.PHANTOM_PYTHON || 
  '/tmp/rns-venv/bin/python';
const PHANTOM_IDENTITY_FILE = process.env.PHANTOM_IDENTITY || 
  path.join(process.env.HOME || '', '.reticulum', 'identities', 'default');

/**
 * Run a phantom command and return structured result
 */
export async function runPhantom(args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    // Check if phantom python exists, fallback to system python3
    const python = fs.existsSync(PHANTOM_PYTHON) ? PHANTOM_PYTHON : 'python3';
    
    const proc = spawn(python, [PHANTOM_PATH, ...args], {
      timeout: timeoutMs,
      env: { ...process.env, PYTHONPATH: '/tmp/rns-venv/lib/python3.14/site-packages' }
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      resolve({
        success: code === 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code
      });
    });

    proc.on('error', (err) => {
      resolve({
        success: false,
        stdout: '',
        stderr: err.message,
        exitCode: -1
      });
    });
  });
}

/**
 * Seed a file on the Reticulum mesh
 * POST /api/phantom/seed { filepath }
 */
export async function phantomSeed(filepath) {
  if (!filepath) {
    return { success: false, error: 'filepath is required' };
  }

  // First create the ghost file, then seed it
  const createResult = await runPhantom(['create', filepath]);
  if (!createResult.success) {
    return { success: false, error: 'Failed to create ghost: ' + createResult.stderr };
  }

  const seedResult = await runPhantom(['seed', filepath]);
  if (!seedResult.success) {
    return { 
      success: false, 
      error: 'Ghost created but seeding failed: ' + seedResult.stderr,
      ghostCreated: true,
      ghostPath: filepath + '.ghost'
    };
  }

  // Parse ghost path from output
  const ghostPath = filepath + '.ghost';
  let ghostHash = '';
  
  try {
    if (fs.existsSync(ghostPath)) {
      const ghostContent = fs.readFileSync(ghostPath);
      const msgpack = await import('msgpackjs').catch(() => null);
      // Ghost hash is first 16 bytes of SHA256
      const crypto = await import('crypto');
      const hash = crypto.createHash('sha256').update(ghostContent).digest();
      ghostHash = hash.toString('hex').substring(0, 32);
    }
  } catch (e) { /* ignore parse errors */ }

  return {
    success: true,
    filepath,
    ghostPath,
    ghostHash,
    message: seedResult.stdout || 'Seeding started'
  };
}

/**
 * Download a file from the Reticulum mesh
 * POST /api/phantom/download { ghostFile, outputDir }
 */
export async function phantomDownload(ghostFile, outputDir) {
  if (!ghostFile) {
    return { success: false, error: 'ghostFile is required' };
  }

  const args = ['download', ghostFile];
  if (outputDir) {
    args.push('-o', outputDir);
  }

  const result = await runPhantom(args);

  // Parse output for downloaded path
  let downloadedPath = '';
  const match = result.stdout.match(/saved to[:\s]+(.+)/i) || 
                 result.stdout.match(/downloaded[:\s]+(.+)/i);
  if (match) downloadedPath = match[1].trim();

  return {
    success: result.success,
    ghostFile,
    outputDir: outputDir || '.',
    downloadedPath,
    message: result.stdout || result.stderr
  };
}

/**
 * Get Phantom node identity
 */
export async function phantomIdentity() {
  const result = await runPhantom(['identity']);
  
  // Parse identity info from output
  let destHash = '';
  let publicKey = '';
  
  const destMatch = result.stdout.match(/destination[:\s]+([a-f0-9]+)/i);
  if (destMatch) destHash = destMatch[1];
  
  const keyMatch = result.stdout.match(/(?:public.?key|key)[:\s]+([a-f0-9]+)/i);
  if (keyMatch) publicKey = keyMatch[1];

  return {
    success: result.success,
    destHash: destHash || '(not connected)',
    publicKey: publicKey || '(not connected)',
    rawOutput: result.stdout
  };
}

/**
 * Get Phantom/Reticulum status
 */
export async function phantomStatus() {
  // Try probe first (lightweight)
  const probeResult = await runPhantom(['probe'], 10000);
  
  // Try identity to see if Reticulum is configured
  const idResult = await runPhantom(['identity'], 5000);
  
  const isConnected = idResult.success && 
    (idResult.stdout.includes('destination') || idResult.stdout.includes('hash'));

  return {
    success: true,
    reticulumeConnected: isConnected,
    probeOutput: probeResult.stdout.substring(0, 500),
    identityOutput: idResult.stdout.substring(0, 300),
    note: isConnected 
      ? 'Reticulum mesh is connected' 
      : 'Reticulum not connected — run "phantom probe" to test connectivity'
  };
}

/**
 * Seed all files in a directory
 */
export async function phantomSeedAll(dirPath) {
  if (!dirPath) {
    return { success: false, error: 'dirPath is required' };
  }

  const result = await runPhantom(['seed-all', dirPath]);
  return {
    success: result.success,
    output: result.stdout,
    error: result.stderr
  };
}

/**
 * Get ghost file info
 */
export async function phantomInfo(ghostFile) {
  if (!ghostFile) {
    return { success: false, error: 'ghostFile is required' };
  }

  const result = await runPhantom(['info', ghostFile]);
  return {
    success: result.success,
    info: result.stdout,
    error: result.stderr
  };
}
