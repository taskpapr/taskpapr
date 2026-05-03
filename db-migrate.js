#!/usr/bin/env node
/**
 * taskpapr — db-migrate.js
 * PostgreSQL schema bootstrap / migration runner.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node db-migrate.js
 *
 * Safe to run repeatedly (CREATE TABLE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS).
 * Does not touch SQLite — only runs when DATABASE_URL is set.
 *
 * For SQLite installs the schema is managed automatically in db-sqlite.js
 * and this script is not needed.
 */

'use strict';

require('dotenv').config();

if (!process.env.DATABASE_URL) {
  console.error('[migrate] DATABASE_URL is not set — this script is for PostgreSQL only.');
  console.error('[migrate] For SQLite installs, schema is managed automatically by db-sqlite.js.');
  process.exit(1);
}

const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const client = await pool.connect();
  try {
    console.log('[migrate] Connected to PostgreSQL:', process.env.DATABASE_URL.replace(/:\/\/[^@]+@/, '://***@'));

    // ── Core schema ────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        provider             TEXT NOT NULL,
        provider_id          TEXT NOT NULL,
        email                TEXT,
        display_name         TEXT,
        avatar_url           TEXT,
        is_admin             BOOLEAN NOT NULL DEFAULT false,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_login_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        telegram_chat_id     TEXT,
        telegram_capture_tile TEXT,
        subscription_status  TEXT NOT NULL DEFAULT 'trialing',
        subscription_tier    TEXT,
        stripe_customer_id   TEXT,
        trial_ends_at        DATE,
        tos_accepted_at      TIMESTAMPTZ,
        referred_by_user_id  BIGINT,
        referral_code        TEXT,
        complimentary        BOOLEAN NOT NULL DEFAULT false,
        UNIQUE(provider, provider_id)
      )
    `);
    console.log('[migrate] ✓ users');

    await client.query(`
      CREATE TABLE IF NOT EXISTS whitelist (
        id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        email    TEXT NOT NULL,
        note     TEXT,
        added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(email)
      )
    `);
    console.log('[migrate] ✓ whitelist');

    await client.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid     TEXT PRIMARY KEY,
        sess    TEXT NOT NULL,
        expired BIGINT NOT NULL
      )
    `);
    console.log('[migrate] ✓ sessions');

    await client.query(`
      CREATE TABLE IF NOT EXISTS goals (
        id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title      TEXT NOT NULL,
        notes      TEXT,
        position   INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    console.log('[migrate] ✓ goals');

    await client.query(`
      CREATE TABLE IF NOT EXISTS columns (
        id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        position   INTEGER NOT NULL DEFAULT 0,
        x          DOUBLE PRECISION NOT NULL DEFAULT 0,
        y          DOUBLE PRECISION NOT NULL DEFAULT 0,
        width      DOUBLE PRECISION NOT NULL DEFAULT 260,
        color      TEXT,
        hidden     INTEGER NOT NULL DEFAULT 0,
        scale      DOUBLE PRECISION NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    console.log('[migrate] ✓ columns');

    await client.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name         TEXT NOT NULL,
        key_hash     TEXT NOT NULL UNIQUE,
        key_prefix   TEXT NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_used_at TIMESTAMPTZ
      )
    `);
    console.log('[migrate] ✓ api_keys');

    await client.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        user_id              BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title                TEXT NOT NULL,
        status               TEXT NOT NULL DEFAULT 'active',
        column_id            BIGINT NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
        position             INTEGER NOT NULL DEFAULT 0,
        goal_id              BIGINT REFERENCES goals(id) ON DELETE SET NULL,
        recurrence           TEXT,
        next_due             DATE,
        last_done_at         TIMESTAMPTZ,
        notes                TEXT,
        visibility_days      INTEGER NOT NULL DEFAULT 3,
        last_acknowledged_at TIMESTAMPTZ,
        no_rot               INTEGER NOT NULL DEFAULT 0,
        rot_interval         TEXT NOT NULL DEFAULT 'weekly',
        color                TEXT,
        snooze_until         DATE,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    console.log('[migrate] ✓ tasks');

    await client.query(`
      CREATE TABLE IF NOT EXISTS bookmarks (
        id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        x          DOUBLE PRECISION NOT NULL DEFAULT 0,
        y          DOUBLE PRECISION NOT NULL DEFAULT 0,
        zoom       DOUBLE PRECISION NOT NULL DEFAULT 1,
        position   INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    console.log('[migrate] ✓ bookmarks');

    await client.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT
      )
    `);
    console.log('[migrate] ✓ settings');

    await client.query(`
      CREATE TABLE IF NOT EXISTS telegram_link_codes (
        code       TEXT PRIMARY KEY,
        user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at BIGINT NOT NULL
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_telegram_link_codes_expires ON telegram_link_codes(expires_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_telegram_link_codes_user ON telegram_link_codes(user_id)`);
    console.log('[migrate] ✓ telegram_link_codes');

    await client.query(`
      CREATE TABLE IF NOT EXISTS referrals (
        id                BIGSERIAL PRIMARY KEY,
        referrer_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        referee_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_used         TEXT NOT NULL,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        converted_at      TIMESTAMPTZ,
        credit_applied_at TIMESTAMPTZ
      )
    `);
    console.log('[migrate] ✓ referrals');

    // ── Indexes ────────────────────────────────────────────────
    await client.query(`CREATE INDEX IF NOT EXISTS idx_tasks_user_id    ON tasks(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_tasks_column_id  ON tasks(column_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_columns_user_id  ON columns(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_goals_user_id    ON goals(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_bookmarks_user_id ON bookmarks(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sessions_expired  ON sessions(expired)`);
    console.log('[migrate] ✓ indexes');

    console.log('[migrate] Migration complete ✓');
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => {
  console.error('[migrate] Fatal error:', err.message);
  process.exit(1);
});
