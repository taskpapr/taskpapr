/**
 * taskpapr — db.js
 * Database adapter selector.
 *
 * DATABASE_URL set  → PostgreSQL (db-pg.js)
 * DATABASE_URL unset → SQLite    (db-sqlite.js, default)
 *
 * Both adapters export identical interfaces:
 *   { db, queries, transaction, seedDefaultTiles, queryOne, queryAll, queryRun, exec, withSchedulerLock }
 *
 * All query methods return Promises — server.js awaits uniformly.
 *
 * Also exports (same for both modes):
 *   isPostgres, sqlNowExpr(), upsertSetting(key, value)
 */

'use strict';

const isPostgres = !!process.env.DATABASE_URL;

if (isPostgres) console.log('[db] PostgreSQL mode (DATABASE_URL is set)');
else console.log('[db] SQLite mode (no DATABASE_URL)');

const adapter = isPostgres ? require('./db-pg') : require('./db-sqlite');

/** SQL fragment for “current timestamp” in UPDATE/INSERT expressions (SQLite vs PostgreSQL). */
function sqlNowExpr() {
  return isPostgres ? 'NOW()' : "datetime('now')";
}

/** Upsert a row in `settings` — works on SQLite (INSERT OR REPLACE) and Postgres (ON CONFLICT). */
async function upsertSetting(key, value) {
  if (isPostgres) {
    await adapter.queryRun(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value]
    );
  } else {
    await adapter.queryRun(
      'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
      [key, value]
    );
  }
}

module.exports = {
  ...adapter,
  isPostgres,
  sqlNowExpr,
  upsertSetting,
};
