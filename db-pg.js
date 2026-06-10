/**
 * taskpapr — db-pg.js
 * Async PostgreSQL adapter using the `pg` package (node-postgres).
 *
 * Activated when DATABASE_URL is set in the environment.
 * Exports the same interface as db-sqlite.js:
 *   { db, queries, transaction, seedDefaultTiles, queryOne, queryAll, queryRun, exec }
 *
 * SQL differences vs SQLite:
 *   - Placeholders: $1, $2, … instead of ?
 *   - Auto-increment: GENERATED ALWAYS AS IDENTITY
 *   - Current time: NOW() instead of datetime('now')
 *   - Upsert: INSERT … ON CONFLICT DO UPDATE instead of INSERT OR REPLACE
 *   - Case-insensitive text: ILIKE / LOWER() instead of COLLATE NOCASE
 *   - Inserted row ID: RETURNING id instead of lastInsertRowid
 *   - Schema check: information_schema instead of PRAGMA table_info
 */

'use strict';

const { Pool, types } = require('pg');
const { AsyncLocalStorage } = require('async_hooks');

// node-pg returns BIGINT (int8) values — ids, COUNT(*) — as strings to avoid
// precision loss beyond 2^53. Our ids and counts never approach that, and
// string ids break strict comparisons everywhere (webhook id lookup, frontend
// element matching). Parse to Number so PG mode returns the same types as the
// SQLite adapter.
types.setTypeParser(types.builtins.INT8, v => parseInt(v, 10));

// DATE columns (next_due, snooze_until, trial_ends_at) must stay 'YYYY-MM-DD'
// strings — the app compares them lexicographically and concatenates them into
// ISO timestamps. node-pg's default Date-object parsing breaks both.
types.setTypeParser(types.builtins.DATE, v => v);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

pool.on('error', (err) => {
  console.error('[pg] idle client error:', err.message);
});

// ── Transaction context ───────────────────────────────────────
// Holds the transaction's dedicated client for the duration of a
// transaction(fn) call. Every query helper below routes through dbConn() so
// that queries issued inside fn — including via the prepared `queries`
// objects — run on the transaction client, not the pool. Without this, BEGIN/COMMIT
// would wrap nothing: pool.query() hands each statement to whichever
// connection is free, outside the transaction.
const txStorage = new AsyncLocalStorage();

function dbConn() {
  return txStorage.getStore() || pool;
}

// ── Low-level helpers ─────────────────────────────────────────
// Convert SQLite ? placeholders to PostgreSQL $1, $2, … placeholders.
function toPositional(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// Execute a query; return the first row or null.
async function queryOne(sql, params = []) {
  const { rows } = await dbConn().query(toPositional(sql), params);
  return rows[0] ?? null;
}

// Execute a query; return all rows.
async function queryAll(sql, params = []) {
  const { rows } = await dbConn().query(toPositional(sql), params);
  return rows;
}

// Execute a non-returning statement (INSERT/UPDATE/DELETE).
// Returns { id, changes } where id is from RETURNING id (if present in SQL) or null.
async function queryRun(sql, params = []) {
  const { rows, rowCount } = await dbConn().query(toPositional(sql), params);
  return { id: rows[0]?.id ?? null, changes: rowCount };
}

// Execute raw DDL (no params, no return).
async function exec(sql) {
  await dbConn().query(sql);
}

// ── Transaction ───────────────────────────────────────────────
// Runs fn with a dedicated client; all query helpers called inside fn
// (directly or via `queries`) join the transaction through txStorage.
async function transaction(fn) {
  // Nested call: already inside a transaction — just run in the outer one.
  if (txStorage.getStore()) return fn();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await txStorage.run(client, fn);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── Statement builder ─────────────────────────────────────────
// Creates an object with .get/.all/.run matching the SQLite adapter interface.
// Converts ? → $N placeholders once; routes through dbConn() so calls made
// inside transaction(fn) join the transaction.
function wrap(sql) {
  const pgSql = toPositional(sql);
  return {
    get:  async (...args) => {
      const { rows } = await dbConn().query(pgSql, args);
      return rows[0] ?? null;
    },
    all:  async (...args) => {
      const { rows } = await dbConn().query(pgSql, args);
      return rows;
    },
    run:  async (...args) => {
      // Extract RETURNING clause rows if present
      const { rows, rowCount } = await dbConn().query(pgSql, args);
      return { id: rows[0]?.id ?? null, changes: rowCount };
    },
  };
}

// ── Queries ───────────────────────────────────────────────────
// Mirrors db-sqlite.js queries exactly, translated to PostgreSQL SQL.
const queries = {
  users: {
    byId:         wrap('SELECT * FROM users WHERE id = ?'),
    byProvider:   wrap('SELECT * FROM users WHERE provider = ? AND provider_id = ?'),
    count:        wrap('SELECT COUNT(*) as c FROM users'),
    insert:       wrap(`
      INSERT INTO users (provider, provider_id, email, display_name, avatar_url, is_admin)
      VALUES (?, ?, ?, ?, ?, ?)
      RETURNING id
    `),
    updateLogin:  wrap(`UPDATE users SET last_login_at = NOW(), email = ?, display_name = ?, avatar_url = ? WHERE id = ?`),
    setAdmin:     wrap('UPDATE users SET is_admin = true WHERE id = ?'),
    all:          wrap('SELECT * FROM users ORDER BY created_at ASC'),
    setTelegram:  wrap('UPDATE users SET telegram_chat_id = ? WHERE id = ?'),
    withTelegram: wrap("SELECT * FROM users WHERE telegram_chat_id IS NOT NULL AND telegram_chat_id != ''"),
  },

  whitelist: {
    all:     wrap('SELECT * FROM whitelist ORDER BY added_at DESC'),
    byEmail: wrap('SELECT * FROM whitelist WHERE LOWER(email) = LOWER(?)'),
    insert:  wrap('INSERT INTO whitelist (email, note) VALUES (?, ?) RETURNING id'),
    delete:  wrap('DELETE FROM whitelist WHERE id = ?'),
  },

  sessions: {
    get:     wrap('SELECT sess FROM sessions WHERE sid = ? AND expired > ?'),
    set:     wrap(`
      INSERT INTO sessions (sid, sess, expired) VALUES (?, ?, ?)
      ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expired = EXCLUDED.expired
    `),
    destroy: wrap('DELETE FROM sessions WHERE sid = ?'),
    touch:   wrap('UPDATE sessions SET expired = ? WHERE sid = ?'),
    prune:   wrap('DELETE FROM sessions WHERE expired <= ?'),
  },

  columns: {
    all:       wrap('SELECT * FROM columns WHERE user_id = ? ORDER BY position ASC'),
    byId:      wrap('SELECT * FROM columns WHERE id = ? AND user_id = ?'),
    insert:    wrap(`
      INSERT INTO columns (user_id, name, position, x, y, width, color)
      VALUES (?, ?, (SELECT COALESCE(MAX(position),0)+1 FROM columns WHERE user_id = ?), ?, ?, ?, ?)
      RETURNING id
    `),
    rename:    wrap('UPDATE columns SET name = ?, updated_at = NOW() WHERE id = ? AND user_id = ?'),
    reorder:   wrap('UPDATE columns SET position = ?, updated_at = NOW() WHERE id = ? AND user_id = ?'),
    move:      wrap('UPDATE columns SET x = ?, y = ?, updated_at = NOW() WHERE id = ? AND user_id = ?'),
    resize:    wrap('UPDATE columns SET width = ?, updated_at = NOW() WHERE id = ? AND user_id = ?'),
    setColor:  wrap('UPDATE columns SET color = ?, updated_at = NOW() WHERE id = ? AND user_id = ?'),
    setHidden: wrap('UPDATE columns SET hidden = ?, updated_at = NOW() WHERE id = ? AND user_id = ?'),
    setScale:  wrap('UPDATE columns SET scale = ?, updated_at = NOW() WHERE id = ? AND user_id = ?'),
    delete:    wrap('DELETE FROM columns WHERE id = ? AND user_id = ?'),
  },

  tasks: {
    all:               wrap('SELECT * FROM tasks WHERE user_id = ? ORDER BY column_id ASC, position ASC'),
    byId:              wrap('SELECT * FROM tasks WHERE id = ? AND user_id = ?'),
    insert:            wrap(`
      INSERT INTO tasks (user_id, title, status, column_id, position, goal_id)
      VALUES (?, ?, 'active', ?, (SELECT COALESCE(MAX(position),0)+1 FROM tasks WHERE column_id = ?), ?)
      RETURNING id
    `),
    updateStatus:      wrap('UPDATE tasks SET status = ?, updated_at = NOW() WHERE id = ? AND user_id = ?'),
    updateTitle:       wrap('UPDATE tasks SET title = ?, updated_at = NOW() WHERE id = ? AND user_id = ?'),
    updateGoal:        wrap('UPDATE tasks SET goal_id = ?, updated_at = NOW() WHERE id = ? AND user_id = ?'),
    updatePosition:    wrap('UPDATE tasks SET position = ?, column_id = ?, updated_at = NOW() WHERE id = ? AND user_id = ?'),
    ack:               wrap('UPDATE tasks SET last_acknowledged_at = NOW(), updated_at = NOW() WHERE id = ? AND user_id = ?'),
    delete:            wrap('DELETE FROM tasks WHERE id = ? AND user_id = ?'),
    deleteCompleted:   wrap("DELETE FROM tasks WHERE column_id = ? AND user_id = ? AND status = 'done'"),
    deleteAllCompleted:wrap("DELETE FROM tasks WHERE user_id = ? AND status = 'done'"),
  },

  goals: {
    all:    wrap('SELECT * FROM goals WHERE user_id = ? ORDER BY position ASC'),
    byId:   wrap('SELECT * FROM goals WHERE id = ? AND user_id = ?'),
    insert: wrap(`
      INSERT INTO goals (user_id, title, notes, position)
      VALUES (?, ?, ?, (SELECT COALESCE(MAX(position),0)+1 FROM goals WHERE user_id = ?))
      RETURNING id
    `),
    update: wrap('UPDATE goals SET title = ?, notes = ?, updated_at = NOW() WHERE id = ? AND user_id = ?'),
    delete: wrap('DELETE FROM goals WHERE id = ? AND user_id = ?'),
  },

  apiKeys: {
    allForUser: wrap('SELECT id, user_id, name, key_prefix, created_at, last_used_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC'),
    byHash:     wrap('SELECT * FROM api_keys WHERE key_hash = ?'),
    insert:     wrap('INSERT INTO api_keys (user_id, name, key_hash, key_prefix) VALUES (?, ?, ?, ?) RETURNING id'),
    delete:     wrap('DELETE FROM api_keys WHERE id = ? AND user_id = ?'),
    touchUsed:  wrap('UPDATE api_keys SET last_used_at = NOW() WHERE id = ?'),
  },

  bookmarks: {
    all:    wrap('SELECT * FROM bookmarks WHERE user_id = ? ORDER BY position ASC, id ASC'),
    byId:   wrap('SELECT * FROM bookmarks WHERE id = ? AND user_id = ?'),
    insert: wrap(`
      INSERT INTO bookmarks (user_id, name, x, y, zoom, position)
      VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position),0)+1 FROM bookmarks WHERE user_id = ?))
      RETURNING id
    `),
    rename: wrap('UPDATE bookmarks SET name = ? WHERE id = ? AND user_id = ?'),
    delete: wrap('DELETE FROM bookmarks WHERE id = ? AND user_id = ?'),
  },

  telegramLinkCodes: {
    insert: wrap(`
      INSERT INTO telegram_link_codes (code, user_id, expires_at) VALUES (?, ?, ?)
      ON CONFLICT (code) DO UPDATE SET user_id = EXCLUDED.user_id, expires_at = EXCLUDED.expires_at
    `),
    deleteForUser: wrap('DELETE FROM telegram_link_codes WHERE user_id = ?'),
    pruneExpired:  wrap('DELETE FROM telegram_link_codes WHERE expires_at <= ?'),
  },
};

// ── Seed default tiles ────────────────────────────────────────
async function seedDefaultTiles(userId) {
  const defaults = ['Work', 'Personal', 'Errands', 'Side Business'];
  for (let i = 0; i < defaults.length; i++) {
    await queries.columns.insert.run(userId, defaults[i], userId, i * 290, 40, 260, null);
  }
}

// ── db shim ───────────────────────────────────────────────────
// The `db` export is only used by auth.js for the SQLite session store.
// With PostgreSQL, auth still uses the SQL session store via `queries` — `db` is unused.
const db = null;

// ── HA: single scheduler across replicas (session advisory lock on one pool connection)
const SCHEDULER_LOCK_KEY = 5829147331;

async function withSchedulerLock(fn) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [SCHEDULER_LOCK_KEY]);
    if (!rows[0].ok) {
      return;
    }
    try {
      await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [SCHEDULER_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

module.exports = {
  db,
  queries,
  transaction,
  seedDefaultTiles,
  queryOne,
  queryAll,
  queryRun,
  exec,
  pool,
  withSchedulerLock,
};
