'use strict';
const { AsyncLocalStorage } = require('async_hooks');
const { isPostgres, queryOne, queryRun, upsertSetting } = require('../db');

const debugDateStorage = new AsyncLocalStorage();
let _debugDate            = null;
let _pgJobDebugDate       = null;
let _pgDebugDateCache     = null;
let _pgDebugDateCacheTime = 0;

function getDebugDate() {
  if (isPostgres) {
    const store = debugDateStorage.getStore();
    if (store && Object.prototype.hasOwnProperty.call(store, 'debugDate')) {
      return store.debugDate ?? null;
    }
    return _pgJobDebugDate ?? null;
  }
  return _debugDate;
}

// Returns current time as ms timestamp, respecting debug date override.
function getNow() {
  const d = getDebugDate();
  if (d) return new Date(d + 'T12:00:00Z').getTime();
  return Date.now();
}

function getTodayStr() {
  return new Date(getNow()).toISOString().slice(0, 10);
}

async function setDebugDate(date) {
  const val = date || null;
  if (!isPostgres) {
    _debugDate = val;
    if (val) await upsertSetting('debug_date', val);
    else await queryRun("DELETE FROM settings WHERE key = 'debug_date'");
    return;
  }
  if (val) await upsertSetting('debug_date', val);
  else await queryRun("DELETE FROM settings WHERE key = 'debug_date'");
  _pgDebugDateCache     = val;
  _pgDebugDateCacheTime = Date.now();
  const store = debugDateStorage.getStore();
  if (store) store.debugDate = val;
  _pgJobDebugDate = val;
}

async function refreshPostgresJobDebugDate() {
  if (!isPostgres) return;
  const row = await queryOne("SELECT value FROM settings WHERE key = 'debug_date'");
  _pgJobDebugDate = row?.value ?? null;
}

// Express middleware: populates the AsyncLocalStorage store for per-request
// debug date access in Postgres mode. Caches the DB read for 30s.
function createDebugDateMiddleware() {
  return (req, res, next) => {
    if (!isPostgres) return next();
    const now = Date.now();
    if (now - _pgDebugDateCacheTime > 30_000) {
      queryOne("SELECT value FROM settings WHERE key = 'debug_date'")
        .then(row => {
          _pgDebugDateCache     = row?.value ?? null;
          _pgDebugDateCacheTime = Date.now();
          debugDateStorage.run({ debugDate: _pgDebugDateCache }, () => next());
        })
        .catch(err => next(err));
    } else {
      debugDateStorage.run({ debugDate: _pgDebugDateCache }, () => next());
    }
  };
}

module.exports = {
  debugDateStorage,
  getTodayStr,
  getNow,
  getDebugDate,
  setDebugDate,
  refreshPostgresJobDebugDate,
  createDebugDateMiddleware,
};
