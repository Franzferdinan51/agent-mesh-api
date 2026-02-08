#!/usr/bin/env node
/**
 * Database Migration Script
 * Migrates existing agent-mesh.db to new schema with groups and collective memory
 */

import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, renameSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const dbPath = join(__dirname, 'agent-mesh.db');
const backupPath = join(__dirname, `agent-mesh.db.backup-${Date.now()}`);

async function migrate() {
  console.log('[Migration] Starting database migration...');

  // Check if database exists
  if (!existsSync(dbPath)) {
    console.log('[Migration] No existing database found. Will create new schema on next start.');
    return;
  }

  // Backup existing database
  console.log(`[Migration] Creating backup: ${backupPath}`);
  try {
    renameSync(dbPath, backupPath);
  } catch (error) {
    console.error('[Migration] Failed to create backup:', error);
    process.exit(1);
  }

  // Open backup database
  let oldDb;
  try {
    oldDb = await open({
      filename: backupPath,
      driver: sqlite3.Database
    });
  } catch (error) {
    console.error('[Migration] Failed to open backup database:', error);
    process.exit(1);
  }

  // Create new database with updated schema
  let newDb;
  try {
    newDb = await open({
      filename: dbPath,
      driver: sqlite3.Database
    });

    await newDb.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        endpoint TEXT,
        capabilities TEXT,
        last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        content TEXT NOT NULL,
        message_type TEXT DEFAULT 'direct',
        read BOOLEAN DEFAULT 0,
        status TEXT DEFAULT 'pending',
        timeout_ms INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        endpoint TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS agent_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        metadata TEXT,
        created_by TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS agent_group_members (
        group_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        role TEXT DEFAULT 'member',
        joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (group_id, agent_id),
        FOREIGN KEY (group_id) REFERENCES agent_groups(id) ON DELETE CASCADE,
        FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS collective_memory (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        memory_type TEXT DEFAULT 'shared',
        version INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (group_id) REFERENCES agent_groups(id) ON DELETE CASCADE,
        FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_messages_to_agent ON messages(to_agent);
      CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
      CREATE INDEX IF NOT EXISTS idx_agent_groups_group ON agent_group_members(group_id);
      CREATE INDEX IF NOT EXISTS idx_collective_memory_group ON collective_memory(group_id);
      CREATE INDEX IF NOT EXISTS idx_collective_memory_key ON collective_memory(group_id, key);
    `);

    console.log('[Migration] New schema created');

    // Migrate agents
    const agents = await oldDb.all('SELECT * FROM agents');
    console.log(`[Migration] Migrating ${agents.length} agents...`);

    for (const agent of agents) {
      await newDb.run(
        'INSERT INTO agents (id, name, endpoint, capabilities, last_seen, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [agent.id, agent.name, agent.endpoint, agent.capabilities, agent.last_seen, agent.created_at]
      );
    }

    // Migrate messages (with new status field defaulting to 'delivered' for old messages)
    const messages = await oldDb.all('SELECT * FROM messages');
    console.log(`[Migration] Migrating ${messages.length} messages...`);

    for (const msg of messages) {
      await newDb.run(
        'INSERT INTO messages (id, from_agent, to_agent, content, message_type, read, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [msg.id, msg.from_agent, msg.to_agent, msg.content, msg.message_type, msg.read, 'delivered', msg.created_at]
      );
    }

    // Migrate skills
    const skills = await oldDb.all('SELECT * FROM skills');
    console.log(`[Migration] Migrating ${skills.length} skills...`);

    for (const skill of skills) {
      await newDb.run(
        'INSERT INTO skills (id, agent_id, name, description, endpoint, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [skill.id, skill.agent_id, skill.name, skill.description, skill.endpoint, skill.created_at]
      );
    }

    await oldDb.close();
    await newDb.close();

    console.log('[Migration] ✓ Migration completed successfully!');
    console.log(`[Migration] Backup saved to: ${backupPath}`);
  } catch (error) {
    console.error('[Migration] Error during migration:', error);

    // Restore backup on failure
    try {
      if (existsSync(dbPath)) {
        renameSync(dbPath, `${dbPath}.failed`);
      }
      renameSync(backupPath, dbPath);
      console.log('[Migration] Backup restored due to migration failure');
    } catch (restoreError) {
      console.error('[Migration] Failed to restore backup:', restoreError);
    }

    process.exit(1);
  }
}

migrate().catch(console.error);
