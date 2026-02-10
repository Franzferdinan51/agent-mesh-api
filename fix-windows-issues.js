#!/usr/bin/env node
/**
 * Windows-specific fixes for Agent Mesh API
 * Run this on Windows to fix SQLite and other issues
 */

import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function fixWindowsIssues() {
  console.log('='.repeat(60));
  console.log('🔧 Agent Mesh Windows Fix Tool');
  console.log('='.repeat(60));
  console.log();

  // 1. Remove old database if exists
  const dbPath = join(__dirname, 'agent-mesh.db');
  if (fs.existsSync(dbPath)) {
    console.log('🗑️  Removing old database...');
    fs.unlinkSync(dbPath);
    console.log('   ✅ Removed agent-mesh.db');
  }

  // 2. Remove WAL files
  const walFiles = ['agent-mesh.db-shm', 'agent-mesh.db-wal'];
  walFiles.forEach(file => {
    const filePath = join(__dirname, file);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`🗑️  Removed ${file}`);
    }
  });

  // 3. Create database with Windows-safe settings
  console.log('');
  console.log('🔨 Creating database with Windows-safe settings...');

  const db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });

  await db.exec('PRAGMA journal_mode = DELETE;');
  await db.exec('PRAGMA synchronous = FULL;');
  await db.exec('PRAGMA temp_store = MEMORY;');
  await db.exec('PRAGMA locking_mode = NORMAL;');
  await db.exec('PRAGMA page_size = 4096;');
  await db.exec('PRAGMA cache_size = -2000;');

  console.log('   ✅ journal_mode = DELETE (Windows-safe)');
  console.log('   ✅ synchronous = FULL (Windows-safe)');
  console.log('   ✅ temp_store = MEMORY (Performance)');
  console.log('   ✅ locking_mode = NORMAL (No locking)');
  console.log('   ✅ Database created successfully');

  await db.close();

  console.log('');
  console.log('='.repeat(60));
  console.log('✅ Windows issues fixed!');
  console.log('='.repeat(60));
  console.log('');
  console.log('Now start the server:');
  console.log('  node server.js');
  console.log('');
  console.log('Or test HTTP endpoint:');
  console.log('  curl http://localhost:4000/api/agents');
  console.log('');
}

fixWindowsIssues().catch(err => {
  console.error('❌ Error fixing Windows issues:', err);
  process.exit(1);
});
