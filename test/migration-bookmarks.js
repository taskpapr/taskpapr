#!/usr/bin/env node
/**
 * taskpapr — migration confidence test (bookmarks)
 *
 * Simulates an older `bookmarks` table missing v0.34.0-required columns,
 * then loads `db.js` with DB_PATH pointing at the temp SQLite file.
 *
 * Exits non-zero if required columns are not present after migrations.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function assert(cond, msg) {
  if (!cond) fail(msg);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskpapr-migration-bookmarks-'));
const dbPath = path.join(tmpDir, 'taskpapr.db');

// Create an "old" bookmarks schema: only id, user_id, name.
const setupDb = new DatabaseSync(dbPath);
setupDb.exec(`
  CREATE TABLE bookmarks (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id  INTEGER NOT NULL,
    name     TEXT NOT NULL
  );
`);

try {
  // Force db.js to use the temp DB.
  process.env.DB_PATH = dbPath;
  // Clear from require cache in case of repeated test execution.
  delete require.cache[require.resolve('../db')];

  const { db } = require('../db');

  const info = db.prepare('PRAGMA table_info(bookmarks)').all();
  const cols = new Set(info.map(c => c.name));

  const required = ['x', 'y', 'zoom', 'position', 'created_at'];
  for (const col of required) {
    assert(cols.has(col), `Missing bookmarks column: ${col}`);
  }

  console.log('PASS: bookmarks migrations added required columns');
  process.exit(0);
} catch (err) {
  console.error(err);
  process.exit(1);
} finally {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup only.
  }
}

