/**
 * taskpapr — db-sqlite.js
 * Async adapter over Node.js 22 built-in sqlite (node:sqlite / DatabaseSync).
 *
 * Every method returns a Promise so server.js can await uniformly across
 * both the SQLite and PostgreSQL adapters without branching.
 *
 * The underlying calls are still synchronous — Promise.resolve() wraps them.
 * For a single-process Node server this is zero-overhead.
 */

'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs   = require('fs');

const DB_PATH = process.env.DB_PATH || (() => {
  const DATA_DIR = path.join(__dirname, 'data');
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  return path.join(DATA_DIR, 'taskpapr.db');
})();

const _db = new DatabaseSync(DB_PATH);
_db.exec('PRAGMA foreign_keys = ON');

// ── Schema ────────────────────────────────────────────────────
_db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    provider        TEXT NOT NULL,
    provider_id     TEXT NOT NULL,
    email           TEXT,
    display_name    TEXT,
    avatar_url      TEXT,
    is_admin        INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    last_login_at   TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(provider, provider_id)
  );
  CREATE TABLE IF NOT EXISTS whitelist (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    email     TEXT NOT NULL UNIQUE COLLATE NOCASE,
    note      TEXT,
    added_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    sid      TEXT PRIMARY KEY,
    sess     TEXT NOT NULL,
    expired  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS goals (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    notes      TEXT,
    position   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS columns (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    position   INTEGER NOT NULL DEFAULT 0,
    x          REAL NOT NULL DEFAULT 0,
    y          REAL NOT NULL DEFAULT 0,
    width      REAL NOT NULL DEFAULT 260,
    color      TEXT DEFAULT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS api_keys (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    key_hash     TEXT NOT NULL UNIQUE,
    key_prefix   TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title        TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'active',
    column_id    INTEGER NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
    position     INTEGER NOT NULL DEFAULT 0,
    goal_id      INTEGER REFERENCES goals(id) ON DELETE SET NULL,
    recurrence   TEXT,
    next_due     TEXT,
    last_done_at TEXT,
    notes        TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS bookmarks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    x          REAL NOT NULL DEFAULT 0,
    y          REAL NOT NULL DEFAULT 0,
    zoom       REAL NOT NULL DEFAULT 1,
    position   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS referrals (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    referrer_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    referee_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_used        TEXT NOT NULL,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    converted_at     TEXT,
    credit_applied_at TEXT
  );
  CREATE TABLE IF NOT EXISTS telegram_link_codes (
    code       TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_telegram_link_codes_expires ON telegram_link_codes(expires_at);
  CREATE INDEX IF NOT EXISTS idx_telegram_link_codes_user ON telegram_link_codes(user_id);
`);

// ── Migrations ────────────────────────────────────────────────
function addColumnIfMissing(table, column, definition) {
  const info = _db.prepare(`PRAGMA table_info(${table})`).all();
  if (!info.find(c => c.name === column)) {
    _db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

addColumnIfMissing('columns', 'x',       'REAL NOT NULL DEFAULT 0');
addColumnIfMissing('columns', 'y',       'REAL NOT NULL DEFAULT 0');
addColumnIfMissing('columns', 'width',   'REAL NOT NULL DEFAULT 260');
addColumnIfMissing('columns', 'color',   'TEXT DEFAULT NULL');
addColumnIfMissing('columns', 'user_id', 'INTEGER REFERENCES users(id) ON DELETE CASCADE');
addColumnIfMissing('columns', 'hidden',     'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('columns', 'scale',      'REAL NOT NULL DEFAULT 1');
addColumnIfMissing('columns', 'updated_at', "TEXT NOT NULL DEFAULT ''");

addColumnIfMissing('tasks', 'user_id',              'INTEGER REFERENCES users(id) ON DELETE CASCADE');
addColumnIfMissing('tasks', 'last_done_at',         'TEXT');
addColumnIfMissing('tasks', 'visibility_days',      'INTEGER NOT NULL DEFAULT 3');
addColumnIfMissing('tasks', 'last_acknowledged_at', 'TEXT');
addColumnIfMissing('tasks', 'no_rot',               'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('tasks', 'rot_interval',         "TEXT NOT NULL DEFAULT 'weekly'");
addColumnIfMissing('tasks', 'color',                'TEXT DEFAULT NULL');
addColumnIfMissing('tasks', 'snooze_until',         'TEXT');
addColumnIfMissing('tasks', 'today_flag',           'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('tasks', 'today_order',          'INTEGER');

addColumnIfMissing('goals', 'user_id', 'INTEGER REFERENCES users(id) ON DELETE CASCADE');

addColumnIfMissing('users', 'telegram_chat_id',      'TEXT');
addColumnIfMissing('users', 'telegram_capture_tile', 'TEXT');
addColumnIfMissing('users', 'subscription_status',   "TEXT NOT NULL DEFAULT 'trialing'");
addColumnIfMissing('users', 'subscription_tier',     'TEXT');
addColumnIfMissing('users', 'stripe_customer_id',    'TEXT');
addColumnIfMissing('users', 'trial_ends_at',         'TEXT');
addColumnIfMissing('users', 'tos_accepted_at',       'TEXT');
addColumnIfMissing('users', 'referred_by_user_id',   'INTEGER');
addColumnIfMissing('users', 'referral_code',         'TEXT');
addColumnIfMissing('users', 'complimentary',         'INTEGER NOT NULL DEFAULT 0');

addColumnIfMissing('bookmarks', 'x',          'REAL NOT NULL DEFAULT 0');
addColumnIfMissing('bookmarks', 'y',          'REAL NOT NULL DEFAULT 0');
addColumnIfMissing('bookmarks', 'zoom',       'REAL NOT NULL DEFAULT 1');
addColumnIfMissing('bookmarks', 'position',   'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('bookmarks', 'created_at', 'TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP');

// Clear debug date on startup
_db.prepare("DELETE FROM settings WHERE key = 'debug_date'").run();

// ── Async shim helpers ────────────────────────────────────────
// Wrap a prepared statement so its .get/.all/.run return Promises.
// This lets server.js use `await` uniformly without branching on adapter type.
function wrap(stmt) {
  return {
    get:  (...args) => Promise.resolve(stmt.get(...args) ?? null),
    all:  (...args) => Promise.resolve(stmt.all(...args)),
    run:  (...args) => {
      const r = stmt.run(...args);
      return Promise.resolve({ id: r.lastInsertRowid ?? null, changes: r.changes ?? 0 });
    },
  };
}

// ── Raw query helpers (for ad-hoc inline DB calls in server.js) ───────────────
// These replace the inline db.prepare(...).get/all/run patterns.
function queryOne(sql, params = []) {
  return Promise.resolve(_db.prepare(sql).get(...params) ?? null);
}
function queryAll(sql, params = []) {
  return Promise.resolve(_db.prepare(sql).all(...params));
}
function queryRun(sql, params = []) {
  const r = _db.prepare(sql).run(...params);
  return Promise.resolve({ id: r.lastInsertRowid ?? null, changes: r.changes ?? 0 });
}
function exec(sql) {
  _db.exec(sql);
  return Promise.resolve();
}

// ── Transaction ───────────────────────────────────────────────
async function transaction(fn) {
  _db.exec('BEGIN');
  try {
    await fn();
    _db.exec('COMMIT');
  } catch (err) {
    _db.exec('ROLLBACK');
    throw err;
  }
}

// ── HA: SQLite is always single-process — no cross-instance lock needed
async function withSchedulerLock(fn) {
  await fn();
}

// ── Prepared queries ──────────────────────────────────────────
const queries = {
  users: {
    byId:         wrap(_db.prepare('SELECT * FROM users WHERE id = ?')),
    byProvider:   wrap(_db.prepare('SELECT * FROM users WHERE provider = ? AND provider_id = ?')),
    count:        wrap(_db.prepare('SELECT COUNT(*) as c FROM users')),
    insert:       wrap(_db.prepare(`
      INSERT INTO users (provider, provider_id, email, display_name, avatar_url, is_admin)
      VALUES (?, ?, ?, ?, ?, ?)
    `)),
    updateLogin:  wrap(_db.prepare(`UPDATE users SET last_login_at = datetime('now'), email = ?, display_name = ?, avatar_url = ? WHERE id = ?`)),
    setAdmin:     wrap(_db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?')),
    all:          wrap(_db.prepare('SELECT * FROM users ORDER BY created_at ASC')),
    setTelegram:  wrap(_db.prepare('UPDATE users SET telegram_chat_id = ? WHERE id = ?')),
    withTelegram: wrap(_db.prepare("SELECT * FROM users WHERE telegram_chat_id IS NOT NULL AND telegram_chat_id != ''")),
  },

  whitelist: {
    all:     wrap(_db.prepare('SELECT * FROM whitelist ORDER BY added_at DESC')),
    byEmail: wrap(_db.prepare('SELECT * FROM whitelist WHERE email = ? COLLATE NOCASE')),
    insert:  wrap(_db.prepare('INSERT INTO whitelist (email, note) VALUES (?, ?)')),
    delete:  wrap(_db.prepare('DELETE FROM whitelist WHERE id = ?')),
  },

  sessions: {
    get:     wrap(_db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expired > ?')),
    set:     wrap(_db.prepare('INSERT OR REPLACE INTO sessions (sid, sess, expired) VALUES (?, ?, ?)')),
    destroy: wrap(_db.prepare('DELETE FROM sessions WHERE sid = ?')),
    touch:   wrap(_db.prepare('UPDATE sessions SET expired = ? WHERE sid = ?')),
    prune:   wrap(_db.prepare('DELETE FROM sessions WHERE expired <= ?')),
  },

  columns: {
    all:       wrap(_db.prepare('SELECT * FROM columns WHERE user_id = ? ORDER BY position ASC')),
    byId:      wrap(_db.prepare('SELECT * FROM columns WHERE id = ? AND user_id = ?')),
    insert:    wrap(_db.prepare('INSERT INTO columns (user_id, name, position, x, y, width, color) VALUES (?, ?, (SELECT COALESCE(MAX(position),0)+1 FROM columns WHERE user_id = ?), ?, ?, ?, ?)')),
    rename:    wrap(_db.prepare('UPDATE columns SET name = ? WHERE id = ? AND user_id = ?')),
    reorder:   wrap(_db.prepare('UPDATE columns SET position = ? WHERE id = ? AND user_id = ?')),
    move:      wrap(_db.prepare('UPDATE columns SET x = ?, y = ? WHERE id = ? AND user_id = ?')),
    resize:    wrap(_db.prepare('UPDATE columns SET width = ? WHERE id = ? AND user_id = ?')),
    setColor:  wrap(_db.prepare('UPDATE columns SET color = ? WHERE id = ? AND user_id = ?')),
    setHidden: wrap(_db.prepare('UPDATE columns SET hidden = ? WHERE id = ? AND user_id = ?')),
    setScale:  wrap(_db.prepare('UPDATE columns SET scale = ? WHERE id = ? AND user_id = ?')),
    delete:    wrap(_db.prepare('DELETE FROM columns WHERE id = ? AND user_id = ?')),
  },

  tasks: {
    all:               wrap(_db.prepare('SELECT * FROM tasks WHERE user_id = ? ORDER BY column_id ASC, position ASC')),
    byId:              wrap(_db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?')),
    insert:            wrap(_db.prepare(`
      INSERT INTO tasks (user_id, title, status, column_id, position, goal_id)
      VALUES (?, ?, 'active', ?, (SELECT COALESCE(MAX(position),0)+1 FROM tasks WHERE column_id = ?), ?)
    `)),
    updateStatus:      wrap(_db.prepare("UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?")),
    updateTitle:       wrap(_db.prepare("UPDATE tasks SET title = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?")),
    updateGoal:        wrap(_db.prepare("UPDATE tasks SET goal_id = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?")),
    updatePosition:    wrap(_db.prepare("UPDATE tasks SET position = ?, column_id = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?")),
    ack:               wrap(_db.prepare("UPDATE tasks SET last_acknowledged_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND user_id = ?")),
    delete:            wrap(_db.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?')),
    deleteCompleted:   wrap(_db.prepare("DELETE FROM tasks WHERE column_id = ? AND user_id = ? AND status = 'done'")),
    deleteAllCompleted:wrap(_db.prepare("DELETE FROM tasks WHERE user_id = ? AND status = 'done'")),
  },

  goals: {
    all:    wrap(_db.prepare('SELECT * FROM goals WHERE user_id = ? ORDER BY position ASC')),
    byId:   wrap(_db.prepare('SELECT * FROM goals WHERE id = ? AND user_id = ?')),
    insert: wrap(_db.prepare('INSERT INTO goals (user_id, title, notes, position) VALUES (?, ?, ?, (SELECT COALESCE(MAX(position),0)+1 FROM goals WHERE user_id = ?))')),
    update: wrap(_db.prepare("UPDATE goals SET title = ?, notes = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?")),
    delete: wrap(_db.prepare('DELETE FROM goals WHERE id = ? AND user_id = ?')),
  },

  apiKeys: {
    allForUser: wrap(_db.prepare('SELECT id, user_id, name, key_prefix, created_at, last_used_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC')),
    byHash:     wrap(_db.prepare('SELECT * FROM api_keys WHERE key_hash = ?')),
    insert:     wrap(_db.prepare('INSERT INTO api_keys (user_id, name, key_hash, key_prefix) VALUES (?, ?, ?, ?)')),
    delete:     wrap(_db.prepare('DELETE FROM api_keys WHERE id = ? AND user_id = ?')),
    touchUsed:  wrap(_db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?")),
  },

  bookmarks: {
    all:    wrap(_db.prepare('SELECT * FROM bookmarks WHERE user_id = ? ORDER BY position ASC, id ASC')),
    byId:   wrap(_db.prepare('SELECT * FROM bookmarks WHERE id = ? AND user_id = ?')),
    insert: wrap(_db.prepare('INSERT INTO bookmarks (user_id, name, x, y, zoom, position) VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position),0)+1 FROM bookmarks WHERE user_id = ?))')),
    rename: wrap(_db.prepare('UPDATE bookmarks SET name = ? WHERE id = ? AND user_id = ?')),
    delete: wrap(_db.prepare('DELETE FROM bookmarks WHERE id = ? AND user_id = ?')),
  },

  telegramLinkCodes: {
    insert:        wrap(_db.prepare('INSERT OR REPLACE INTO telegram_link_codes (code, user_id, expires_at) VALUES (?, ?, ?)')),
    deleteForUser: wrap(_db.prepare('DELETE FROM telegram_link_codes WHERE user_id = ?')),
    pruneExpired:  wrap(_db.prepare('DELETE FROM telegram_link_codes WHERE expires_at <= ?')),
  },
};

// ── Seed default tiles ────────────────────────────────────────
async function seedDefaultTiles(userId) {
  const defaults = ['Work', 'Personal', 'Errands', 'Side Business'];
  for (let i = 0; i < defaults.length; i++) {
    await queries.columns.insert.run(userId, defaults[i], userId, i * 290, 40, 260, null);
  }
}

// Expose the raw _db handle for auth.js (SQLite session store needs it synchronously)
module.exports = {
  db: _db,
  queries,
  transaction,
  seedDefaultTiles,
  queryOne,
  queryAll,
  queryRun,
  exec,
  withSchedulerLock,
};
