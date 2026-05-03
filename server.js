require('dotenv').config();

const { AsyncLocalStorage } = require('async_hooks');
const express    = require('express');
const path       = require('path');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const {
  queries,
  transaction,
  queryOne,
  queryAll,
  queryRun,
  isPostgres,
  sqlNowExpr,
  upsertSetting,
  withSchedulerLock,
} = require('./db');

const debugDateStorage = new AsyncLocalStorage();
const { setupAuth, setupAuthRoutes, requireAuth, requireAdmin, generateApiKey, apiKeyAuth, isSingleUserMode, applyReferral } = require('./auth');

// ── Stripe (loaded conditionally — only when STRIPE_SECRET_KEY is set) ───────
// This means self-hosted installs without the key never require the stripe package
// to be configured, and the requireSubscription middleware is a no-op for them.
const stripe = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;

const app  = express();
const PORT = process.env.PORT || 3033;

// ── Trust proxy ───────────────────────────────────────────────
// The app runs behind Traefik (or any reverse proxy) which sets
// X-Forwarded-For. Without this, express-rate-limit throws a
// ValidationError and the app crashes. '1' = trust one hop.
app.set('trust proxy', 1);

// ── Security headers ──────────────────────────────────────────
// Helmet defaults include a strict CSP that blocks inline <script> tags.
// Our pages use inline scripts (no build step — intentional), so we disable
// the default CSP. All other helmet protections (X-Frame-Options, nosniff,
// Referrer-Policy, HSTS, etc.) remain active.
app.use(helmet({ contentSecurityPolicy: false }));

// ── Resource & field limits (all overridable via env vars) ────
const LIMITS = {
  tasks:     parseInt(process.env.LIMIT_TASKS     || '2000'),
  tiles:     parseInt(process.env.LIMIT_TILES     || '50'),
  goals:     parseInt(process.env.LIMIT_GOALS     || '50'),
  bookmarks: parseInt(process.env.LIMIT_BOOKMARKS || '20'),
  titleLen:  parseInt(process.env.LIMIT_TITLE_LEN || '500'),
  nameLen:   parseInt(process.env.LIMIT_NAME_LEN  || '100'),
  notesLen:  parseInt(process.env.LIMIT_NOTES_LEN || '50000'),
};

// ── Rate limiters ─────────────────────────────────────────────
const rateLimitGlobal = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_GLOBAL || '300'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please slow down.' },
});

const rateLimitWrites = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_WRITES || '30'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many write requests — please slow down.' },
});

const rateLimitAuth = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_AUTH || '20'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts — please slow down.' },
});

// Apply global limiter to all routes
app.use(rateLimitGlobal);

// ── Body parser (explicit limit) ──────────────────────────────
app.use(express.json({ limit: '200kb' }));

// ── Hosted Postgres: debug date lives in DB only (survives LB switching instances)
app.use(async (req, res, next) => {
  if (!isPostgres) return next();
  try {
    const row = await queryOne("SELECT value FROM settings WHERE key = 'debug_date'");
    const debugDate = row?.value ?? null;
    debugDateStorage.run({ debugDate }, () => next());
  } catch (err) {
    next(err);
  }
});

// ── Input validation helpers ──────────────────────────────────
function validateLen(value, max, fieldName) {
  if (typeof value === 'string' && value.length > max) {
    return `${fieldName} must be ${max} characters or fewer (got ${value.length})`;
  }
  return null;
}

function asTrimmedString(value) {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t ? t : null;
}

function asLowerTrimmedString(value) {
  const t = asTrimmedString(value);
  return t ? t.toLowerCase() : null;
}

async function checkQuota(table, userIdCol, userId, limit, resource) {
  const row = await queryOne(`SELECT COUNT(*) as c FROM ${table} WHERE ${userIdCol} = ?`, [userId]);
  if (row && row.c >= limit) {
    return `${resource} limit reached (max ${limit})`;
  }
  return null;
}

// ── Debug date override ────────────────────────────────────────
// SQLite: in-memory + mirrored to settings (cleared on startup in db-sqlite.js).
// Postgres (HA): settings table only; per-request value via AsyncLocalStorage;
// background jobs use _pgJobDebugDate refreshed before scheduled work.
let _debugDate = null;
let _pgJobDebugDate = null;

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
  const store = debugDateStorage.getStore();
  if (store) store.debugDate = val;
  _pgJobDebugDate = val;
}

async function refreshPostgresJobDebugDate() {
  if (!isPostgres) return;
  const row = await queryOne("SELECT value FROM settings WHERE key = 'debug_date'");
  _pgJobDebugDate = row?.value ?? null;
}

function getNow() {
  const d = getDebugDate();
  if (d) return new Date(d + 'T12:00:00Z').getTime();
  return Date.now();
}

function getTodayStr() {
  return new Date(getNow()).toISOString().slice(0, 10);
}

// ── Auth (must come before static + routes) ──────────────────
// setupAuth is async (fetches OIDC discovery document if OIDC is configured)
async function start() {
  await setupAuth(app);
  setupAuthRoutes(app, async (user) => {
    // Extra fields injected into /api/me for all auth modes
    const fresh   = await queries.users.byId.get(user.id) || user;
    const todayStr = getTodayStr();

    // Trial days remaining (null when not on trial)
    let trialDaysLeft = null;
    if (fresh.subscription_status === 'trialing' && fresh.trial_ends_at) {
      const msLeft = new Date(fresh.trial_ends_at + 'T23:59:59Z') - new Date(todayStr + 'T00:00:00Z');
      trialDaysLeft = Math.max(0, Math.ceil(msLeft / 86400000));
    }

    return {
      single_user:             isSingleUserMode(),
      debug_date:              getDebugDate() || null,
      telegram_chat_id:        fresh.telegram_chat_id        || process.env.TELEGRAM_CHAT_ID || null,
      telegram_capture_tile:   fresh.telegram_capture_tile   || null,
      // Billing / subscription fields
      stripe_configured:       !!stripe,
      subscription_status:     fresh.subscription_status  || 'trialing',
      subscription_tier:       fresh.subscription_tier    || null,
      trial_ends_at:           fresh.trial_ends_at        || null,
      trial_days_left:         trialDaysLeft,
      has_billing_account:     !!fresh.stripe_customer_id,
    };
  });

// ── Rate limiters on auth redirect endpoints ─────────────────
app.use('/auth/github', rateLimitAuth);
app.use('/auth/google', rateLimitAuth);
app.use('/auth/oidc',   rateLimitAuth);

// ── Login page (public) ───────────────────────────────────────
app.get('/login', async (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/');
  const error = req.query.error;
  const githubEnabled = !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
  const googleEnabled = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  const oidcEnabled   = !!(process.env.OIDC_ISSUER && process.env.OIDC_CLIENT_ID && process.env.OIDC_CLIENT_SECRET);
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>taskpapr — sign in</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #f5f0e8;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .card {
      background: #faf7f2;
      border: 1px solid #ddd6c8;
      border-radius: 8px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.08);
      padding: 40px 36px;
      width: 320px;
      text-align: center;
    }
    h1 {
      font-family: 'SFMono-Regular', Menlo, Consolas, monospace;
      font-size: 22px;
      letter-spacing: -0.5px;
      color: #1a1a1a;
      margin-bottom: 6px;
    }
    .tagline {
      font-size: 13px;
      color: #888;
      margin-bottom: 28px;
    }
    .error {
      background: #fee2e2;
      border: 1px solid #fca5a5;
      border-radius: 6px;
      color: #b91c1c;
      font-size: 13px;
      padding: 10px 12px;
      margin-bottom: 20px;
    }
    .btn-github {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      width: 100%;
      padding: 11px 16px;
      background: #24292e;
      color: white;
      border: none;
      border-radius: 6px;
      font-size: 14px;
      font-family: inherit;
      cursor: pointer;
      text-decoration: none;
      transition: background 0.15s;
    }
    .btn-github:hover { background: #1a1f23; }
    .btn-github svg { flex-shrink: 0; }
    .btn-google {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      width: 100%;
      padding: 11px 16px;
      background: #fff;
      color: #3c4043;
      border: 1px solid #dadce0;
      border-radius: 6px;
      font-size: 14px;
      font-family: inherit;
      cursor: pointer;
      text-decoration: none;
      transition: background 0.15s, box-shadow 0.15s;
    }
    .btn-google:hover { background: #f8f9fa; box-shadow: 0 1px 4px rgba(0,0,0,0.12); }
    .btn-google svg { flex-shrink: 0; }
    .btn-sso {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      width: 100%;
      padding: 11px 16px;
      background: #2c5f8a;
      color: white;
      border: none;
      border-radius: 6px;
      font-size: 14px;
      font-family: inherit;
      cursor: pointer;
      text-decoration: none;
      transition: background 0.15s;
    }
    .btn-sso:hover { background: #24527a; }
    .btn-sso svg { flex-shrink: 0; }
    .disabled-note {
      font-size: 12px;
      color: #aaa;
      margin-top: 16px;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>taskpapr</h1>
    <p class="tagline">A minimal task board for the frictionless mind.</p>
    ${error === 'not_invited' ? `<div class="error">Your account isn't on the invite list. Contact the admin.</div>` : ''}
    ${error === 'no_email'    ? `<div class="error">Your account didn't provide an email address. Please try a different sign-in method.</div>` : ''}
    ${githubEnabled
      ? `<a href="/auth/github" class="btn-github">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="white"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
          Sign in with GitHub
        </a>`
      : ''
    }
    ${googleEnabled
      ? `<a href="/auth/google" class="btn-google" style="margin-top:${githubEnabled ? '8px' : '0'}">
          <svg width="18" height="18" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
          Sign in with Google
        </a>`
      : ''
    }
    ${oidcEnabled
      ? `<a href="/auth/oidc" class="btn-sso" style="margin-top:${(githubEnabled || googleEnabled) ? '8px' : '0'}">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/><path d="M3.05 11a9 9 0 1 0 .5-2.6"/></svg>
          Sign in with SSO
        </a>`
      : ''
    }
    ${!githubEnabled && !googleEnabled && !oidcEnabled
      ? `<p class="disabled-note">Login not configured. Set GITHUB_CLIENT_ID, GOOGLE_CLIENT_ID, or OIDC_ISSUER environment variables.</p>`
      : ''
    }
  </div>
</body>
</html>`);
});

// ── Recurrence helper ─────────────────────────────────────────
// Returns YYYY-MM-DD of the next due date given a current date and recurrence string.
// Supported formats: daily, weekly, monthly, Nd, Nw, Nm (e.g. "7d", "2w", "1m")
function advanceDate(fromDateStr, recurrence) {
  const d = new Date(fromDateStr + 'T12:00:00Z'); // noon UTC avoids DST edge cases
  const r = (typeof recurrence === 'string' ? recurrence : '').toLowerCase().trim();

  if (r === 'daily'  || r === '1d') { d.setUTCDate(d.getUTCDate() + 1); }
  else if (r === 'weekly' || r === '1w') { d.setUTCDate(d.getUTCDate() + 7); }
  else if (r === 'monthly' || r === '1m') { d.setUTCMonth(d.getUTCMonth() + 1); }
  else {
    const match = r.match(/^(\d+)([dwm])$/);
    if (match) {
      const n = parseInt(match[1]);
      const unit = match[2];
      if (unit === 'd') d.setUTCDate(d.getUTCDate() + n);
      else if (unit === 'w') d.setUTCDate(d.getUTCDate() + n * 7);
      else if (unit === 'm') d.setUTCMonth(d.getUTCMonth() + n);
    } else {
      // Unknown format — default to +7 days
      d.setUTCDate(d.getUTCDate() + 7);
    }
  }
  return d.toISOString().slice(0, 10);
}

// ── Pricing pages — PUBLIC (no auth required) ────────────────
// Must be before requireAuth so expired-trial users can reach /pricing.
// If a ?ref= code is present, store it in the session for pickup at OAuth callback.
app.get('/pricing', (req, res) => {
  if (req.query.ref && req.session) {
    req.session.pending_ref = req.query.ref;
  }
  res.sendFile(path.join(__dirname, 'public', 'pricing.html'));
});
app.get('/pricing/success',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'pricing-success.html')));
app.get('/pricing/canceled', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pricing-canceled.html')));

// GET /api/pricing — public endpoint; returns pricing config from pricing.json
// Prices are never in the source code or git history — they live in pricing.json
// which is gitignored. Falls back to zeros if the file is absent (self-hosted default).
app.get('/api/pricing', async (req, res) => {
  let config = { currency_symbol: '', monthly: 0, annual: 0, annual_monthly_equivalent: 0, trial_days: 14 };
  try {
    const raw = require('fs').readFileSync(path.join(__dirname, 'pricing.json'), 'utf8');
    config = { ...config, ...JSON.parse(raw) };
  } catch (_) { /* file absent or unreadable — return zeros */ }
  res.json(config);
});

// ── API key auth (runs before requireAuth — populates req.user from Bearer token)
app.use(apiKeyAuth);

// ── Telegram bot webhook — PUBLIC, must be before requireAuth ─
// Telegram servers POST updates here. No session or API key is present.
// Auth is handled by TELEGRAM_WEBHOOK_SECRET header validation (optional but recommended).
// Declared here so requireAuth does not intercept it.
app.post('/api/telegram/webhook', async (req, res) => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret) {
    const provided = req.headers['x-telegram-bot-api-secret-token'];
    if (provided !== secret) {
      console.warn('[telegram/webhook] invalid secret token');
      return res.status(401).json({ error: 'unauthorized' });
    }
  }

  // Always respond 200 quickly so Telegram doesn't retry
  res.json({ ok: true });

  const update = req.body;
  const msg    = update?.message;
  if (!msg || !msg.text) return;

  if (typeof msg.text !== 'string') return;
  const text = msg.text.trim();
  const chatId = String(msg.chat.id);

  // ── /start <CODE> — account linking ─────────────────────────
  const startMatch = text.match(/^\/start\s+([A-Z0-9]{6})$/i);
  if (startMatch) {
    const code = startMatch[1].toUpperCase();
    const claim = await queryOne(
      `DELETE FROM telegram_link_codes WHERE code = ? AND expires_at > ? RETURNING user_id`,
      [code, Date.now()]
    );
    const userId = claim?.user_id;

    if (!userId) {
      console.log('[telegram/webhook] code not found or expired', { code });
      sendTelegram('❌ That code has expired or is invalid. Please go back to taskpapr settings and request a new one.', chatId);
      return;
    }

    await queries.users.setTelegram.run(chatId, userId);
    const linkedUser = await queries.users.byId.get(userId);
    const displayName = linkedUser?.display_name || linkedUser?.email || 'user';
    console.log('[telegram/webhook] linked chat to user', { chatId, userId, displayName });
    sendTelegram(`✅ Connected! Daily task reminders will now be sent to this chat.\n\nThis is your taskpapr account: ${displayName}\n\n<i>Tip: send me any message to add it as a task in your Inbox tile. Use <b>TileName: task title</b> to send to a specific tile.</i>`, chatId);
    return;
  }

  // Ignore all other /commands (e.g. /help, /start without a code)
  if (text.startsWith('/')) return;

  // ── Quick-capture — plain text from a linked user ─────────────
  // Security: only act on messages from chat IDs already linked to an account.
  // Unknown senders are silently ignored (no reply — prevents enumeration).
  const knownUser = await queryOne('SELECT * FROM users WHERE telegram_chat_id = ?', [chatId]);
  if (!knownUser) {
    console.log('[telegram/webhook] quick-capture: unknown chat_id — ignored', { chatId });
    return;
  }

  // Parse optional prefix: "TileName: task title" routes to a named tile.
  // Bare text goes to the user's configured capture tile (default: Inbox).
  let targetTileName = knownUser.telegram_capture_tile || 'Inbox';
  let taskTitle = text;
  const prefixMatch = text.match(/^([^:\n]{1,50}):\s+(.+)$/s);
  if (prefixMatch) {
    targetTileName = prefixMatch[1].trim();
    taskTitle      = prefixMatch[2].trim();
  }

  // Find tile by case-insensitive partial name match (same as /api/webhook)
  const allCols = await queries.columns.all.all(knownUser.id);
  let captureTile = allCols.find(c => c.name.toLowerCase().includes(targetTileName.toLowerCase()));

  if (!captureTile) {
    if (prefixMatch) {
      // User named a tile that doesn't exist — tell them
      sendTelegram(
        `❌ Tile not found: "<b>${targetTileName}</b>"\n\nAvailable tiles:\n${allCols.map(c => `• ${c.name}`).join('\n')}`,
        chatId
      );
      return;
    }
    // Default capture tile doesn't exist → auto-create it
    const defaultName = knownUser.telegram_capture_tile || 'Inbox';
    const info = await queries.columns.insert.run(knownUser.id, defaultName, knownUser.id, 40, 40, 260, null);
    captureTile = await queries.columns.byId.get(info.id, knownUser.id);
    console.log(`[telegram/webhook] auto-created capture tile "${defaultName}" for user ${knownUser.id}`);
  }

  // Enforce task quota for Telegram quick-capture
  const tgQuotaErr = await checkQuota('tasks', 'user_id', knownUser.id, LIMITS.tasks, 'Task');
  if (tgQuotaErr) {
    sendTelegram(`❌ ${tgQuotaErr} — clean up some tasks first.`, chatId);
    return;
  }
  await queries.tasks.insert.run(knownUser.id, taskTitle, captureTile.id, captureTile.id, null);
  console.log('[telegram/webhook] quick-capture', { userId: knownUser.id, taskTitle, tile: captureTile.name });
  sendTelegram(`✅ Added to <b>${captureTile.name}</b>: ${taskTitle}`, chatId);
});

// ── Stripe webhook — PUBLIC, must be before requireAuth and express.json() ──
// Stripe requires the raw request body to verify the signature.
// We mount this before the json body-parser middleware has run on this route
// by using express.raw() as inline middleware on this specific route only.
app.post('/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    // If Stripe is not configured, acknowledge and ignore
    if (!stripe) return res.json({ received: true, note: 'Stripe not configured' });

    const sig    = req.headers['stripe-signature'];
    const secret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!secret) {
      console.warn('[stripe/webhook] STRIPE_WEBHOOK_SECRET not set — skipping verification');
      return res.status(400).json({ error: 'webhook secret not configured' });
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, secret);
    } catch (err) {
      console.warn('[stripe/webhook] signature verification failed:', err.message);
      return res.status(400).json({ error: `webhook error: ${err.message}` });
    }

    // Always respond 200 quickly so Stripe doesn't retry while we process
    res.json({ received: true });

    console.log(`[stripe/webhook] event: ${event.type}`);

    try {
      await handleStripeEvent(event);
    } catch (err) {
      console.error('[stripe/webhook] handler error:', err.message);
    }
  }
);

// Process a verified Stripe event and update the user's subscription state
async function handleStripeEvent(event) {
  const obj = event.data.object;

  // Helper: find user by Stripe customer ID
  const userByCustomer = async (customerId) =>
    await queryOne('SELECT * FROM users WHERE stripe_customer_id = ?', [customerId]);

  // Helper: update subscription fields on a user
  const updateSub = async (userId, fields) => {
    const setClauses = Object.keys(fields).map(k => `${k} = ?`).join(', ');
    const values     = [...Object.values(fields), userId];
    await queryRun(`UPDATE users SET ${setClauses} WHERE id = ?`, values);
  };

  switch (event.type) {

    // ── subscription.created / updated ─────────────────────
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const customerId = obj.customer;
      const status     = obj.status; // trialing | active | past_due | canceled | unpaid
      // Map Stripe status to our internal status
      const ourStatus = ['active', 'trialing'].includes(status) ? status
                      : status === 'past_due' ? 'past_due'
                      : 'canceled';
      // Determine tier from price metadata or product name — default 'solo'
      const tier = 'solo'; // v0.39+ will read from price metadata

      const user = await userByCustomer(customerId);
      if (!user) {
        console.warn(`[stripe/webhook] no user found for customer ${customerId}`);
        return;
      }
      await updateSub(user.id, { subscription_status: ourStatus, subscription_tier: tier });
      console.log(`[stripe/webhook] user ${user.id} subscription → ${ourStatus} (${tier})`);
      break;
    }

    // ── subscription.deleted (cancelled at period end) ──────
    case 'customer.subscription.deleted': {
      const customerId = obj.customer;
      const user = await userByCustomer(customerId);
      if (!user) return;
      await updateSub(user.id, { subscription_status: 'canceled', subscription_tier: null });
      console.log(`[stripe/webhook] user ${user.id} subscription → canceled`);
      break;
    }

    // ── payment failed ───────────────────────────────────────
    case 'invoice.payment_failed': {
      const customerId = obj.customer;
      const user = await userByCustomer(customerId);
      if (!user) return;
      await updateSub(user.id, { subscription_status: 'past_due' });
      console.log(`[stripe/webhook] user ${user.id} payment failed → past_due`);
      break;
    }

    // ── payment succeeded (clears past_due; triggers referral credit) ──
    case 'invoice.payment_succeeded': {
      const customerId = obj.customer;
      const user = await userByCustomer(customerId);
      if (!user) return;
      // Only update if they were past_due — don't overwrite trialing/active
      if (user.subscription_status === 'past_due') {
        await updateSub(user.id, { subscription_status: 'active' });
        console.log(`[stripe/webhook] user ${user.id} payment recovered → active`);
      }
      // ── Referral credit: first successful payment by a referred user ──
      if (stripe && user.referred_by_user_id) {
        const referral = await queryOne(
          'SELECT * FROM referrals WHERE referee_id = ? AND converted_at IS NULL',
          [user.id]
        );
        if (referral) {
          await queryRun(
            `UPDATE referrals SET converted_at = ${sqlNowExpr()} WHERE id = ?`,
            [referral.id]
          );
          const referrer = await queryOne(
            'SELECT id, stripe_customer_id FROM users WHERE id = ?',
            [user.referred_by_user_id]
          );
          if (referrer?.stripe_customer_id) {
            try {
              const creditAmount = -(obj.amount_paid || 0);
              if (creditAmount < 0) {
                await stripe.customers.createBalanceTransaction(referrer.stripe_customer_id, {
                  amount:      creditAmount,
                  currency:    obj.currency || 'gbp',
                  description: `Referral credit: user ${user.id} converted`,
                });
              }
              await queryRun(
                `UPDATE referrals SET credit_applied_at = ${sqlNowExpr()} WHERE id = ?`,
                [referral.id]
              );
              console.log(`[referral] credited referrer user ${referrer.id} for converting user ${user.id}`);
            } catch (err) {
              console.error('[referral] failed to apply Stripe credit', { referrerId: referrer.id, error: err.message });
            }
          } else {
            console.log(`[referral] referrer user ${user.referred_by_user_id} has no Stripe customer — credit skipped`);
          }
        }
      }
      break;
    }

    // ── checkout session completed (first-time checkout) ─────
    // Links the new Stripe customer to the taskpapr user account.
    case 'checkout.session.completed': {
      const customerId = obj.customer;
      const clientRef  = obj.client_reference_id; // we send userId as client_reference_id
      if (!clientRef) return;
      const userId = parseInt(clientRef);
      if (isNaN(userId)) return;
      // Store the Stripe customer ID against this user
      await queryRun('UPDATE users SET stripe_customer_id = ? WHERE id = ?', [customerId, userId]);
      console.log(`[stripe/webhook] linked customer ${customerId} to user ${userId}`);
      break;
    }

    default:
      // Unhandled event type — ignore silently
      break;
  }
}

// ── requireSubscription middleware ───────────────────────────
// Gate: allow if any of the following:
//   1. Stripe is not configured (self-hosted install — never gate)
//   2. Single-user mode (SINGLE_USER_MODE env var, or auto-detected)
//   3. User is admin
//   4. User has subscription_status 'trialing' + trial_ends_at in the future
//   5. User has subscription_status 'active'
//
// Otherwise: redirect to /pricing (or return 402 for API routes)
function requireSubscription(req, res, next) {
  // Bypass 1 & 2: no Stripe or single-user mode
  if (!stripe || isSingleUserMode()) return next();

  const u = req.user;
  if (!u) return next(); // requireAuth will handle the redirect

  // Bypass 3: admins
  if (u.is_admin) return next();

  // Bypass 4: complimentary accounts (lifetime free, admin-granted)
  if (u.complimentary) return next();

  const status = u.subscription_status || 'trialing';

  // Allow active subscriptions
  if (status === 'active') return next();

  // Allow valid trials
  if (status === 'trialing') {
    if (!u.trial_ends_at) return next(); // no expiry set → allow (legacy users)
    if (u.trial_ends_at >= getTodayStr()) return next();
    // Trial expired — fall through to redirect
  }

  // API routes return 402, page routes redirect to /pricing
  if (req.path.startsWith('/api/')) {
    return res.status(402).json({
      error: 'subscription_required',
      message: 'Your trial has ended. Please subscribe to continue using taskpapr.',
    });
  }
  return res.redirect('/pricing');
}

// ── Main app (auth-protected static files) ────────────────────
app.use(requireAuth);
app.use(requireSubscription);
app.use(express.static(path.join(__dirname, 'public')));

// ── Billing API endpoints ────────────────────────────────────
// These sit inside requireAuth so we always have req.user.

// POST /api/billing/create-checkout — create a Stripe Checkout session
// Returns { url } for the browser to redirect to.
app.post('/api/billing/create-checkout', async (req, res) => {
  if (!stripe) return res.status(400).json({ error: 'Stripe not configured' });

  const { interval = 'monthly' } = req.body; // 'monthly' | 'annual'
  const priceId = interval === 'annual'
    ? process.env.STRIPE_SOLO_ANNUAL_PRICE_ID
    : process.env.STRIPE_SOLO_MONTHLY_PRICE_ID;

  if (!priceId) {
    return res.status(400).json({ error: `Stripe price ID not configured for interval: ${interval}` });
  }

  const appUrl   = process.env.APP_URL || `http://localhost:${PORT}`;
  const user     = req.user;

  try {
    // Reuse existing Stripe customer if we have one; otherwise Stripe creates one at checkout
    const checkoutParams = {
      mode:                 'subscription',
      line_items:           [{ price: priceId, quantity: 1 }],
      success_url:          `${appUrl}/pricing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:           `${appUrl}/pricing/canceled`,
      client_reference_id:  String(user.id), // used in checkout.session.completed event
      allow_promotion_codes: true,
      // Pre-fill email from the user's profile
      ...(user.email ? { customer_email: user.email } : {}),
      // Reuse existing customer if linked
      ...(user.stripe_customer_id ? { customer: user.stripe_customer_id } : {}),
      // Stripe Tax — calculates UK VAT + EU digital services tax automatically
      automatic_tax: { enabled: !!process.env.STRIPE_TAX_ENABLED },
    };

    const session = await stripe.checkout.sessions.create(checkoutParams);
    res.json({ url: session.url });
  } catch (err) {
    console.error('[billing/create-checkout] error:', err.message);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// GET /api/billing/portal — redirect to Stripe Customer Portal
// Allows users to manage payment methods, view invoices, cancel, etc.
app.get('/api/billing/portal', async (req, res) => {
  if (!stripe) return res.status(400).json({ error: 'Stripe not configured' });

  const user = req.user;
  if (!user.stripe_customer_id) {
    return res.status(400).json({ error: 'No billing account linked to this user' });
  }

  const appUrl = process.env.APP_URL || `http://localhost:${PORT}`;
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer:   user.stripe_customer_id,
      return_url: `${appUrl}/settings`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[billing/portal] error:', err.message);
    res.status(500).json({ error: 'Failed to create billing portal session' });
  }
});

// GET /api/referral/stats — referral link + counts for the settings page
app.get('/api/referral/stats', async (req, res) => {
  const user = await queryOne('SELECT referral_code FROM users WHERE id = ?', [req.user.id]);
  const code = user?.referral_code || null;
  const appUrl = process.env.APP_URL || `http://localhost:${PORT}`;
  const referralLink = code ? `${appUrl}/pricing?ref=${encodeURIComponent(code)}` : null;

  const referred  = await queryOne('SELECT COUNT(*) as c FROM referrals WHERE referrer_id = ?', [req.user.id]);
  const converted = await queryOne('SELECT COUNT(*) as c FROM referrals WHERE referrer_id = ? AND converted_at IS NOT NULL', [req.user.id]);
  const credited  = await queryOne('SELECT COUNT(*) as c FROM referrals WHERE referrer_id = ? AND credit_applied_at IS NOT NULL', [req.user.id]);

  res.json({
    referral_code:   code,
    referral_link:   referralLink,
    total_referred:  referred?.c  || 0,
    total_converted: converted?.c || 0,
    months_earned:   credited?.c  || 0,
  });
});

// GET /api/billing/status — returns the calling user's subscription status
// Used by the settings page and user menu to display trial countdown / plan info.
app.get('/api/billing/status', async (req, res) => {
  const u = await queryOne('SELECT subscription_status, subscription_tier, trial_ends_at, stripe_customer_id FROM users WHERE id = ?', [req.user.id]);
  const stripeConfigured = !!stripe;
  const todayStr = getTodayStr();

  let trialDaysLeft = null;
  if (u.subscription_status === 'trialing' && u.trial_ends_at) {
    const msLeft = new Date(u.trial_ends_at + 'T23:59:59Z') - new Date(todayStr + 'T00:00:00Z');
    trialDaysLeft = Math.max(0, Math.ceil(msLeft / 86400000));
  }

  res.json({
    stripe_configured:    stripeConfigured,
    subscription_status:  u.subscription_status  || 'trialing',
    subscription_tier:    u.subscription_tier    || null,
    trial_ends_at:        u.trial_ends_at        || null,
    trial_days_left:      trialDaysLeft,
    has_billing_account:  !!u.stripe_customer_id,
  });
});

// ============================================================
// Admin routes
// ============================================================

app.get('/api/admin/registration-status', requireAdmin, async (req, res) => {
  const { _isWhitelistRequired } = require('./auth');
  const open = !_isWhitelistRequired();
  res.json({
    open_registration:  open,
    whitelist_required: !open,
    require_whitelist_env: process.env.REQUIRE_WHITELIST || null,
    stripe_configured:  !!process.env.STRIPE_SECRET_KEY,
    oidc_trust_idp:     process.env.OIDC_TRUST_IDP === 'true',
  });
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  res.json(await queries.users.all.all());
});

// PATCH /api/admin/users/:id/complimentary — grant or revoke a complimentary account
// complimentary=true  → user bypasses requireSubscription for life (or until revoked)
// complimentary=false → user falls back to normal trial/subscription check
app.patch('/api/admin/users/:id/complimentary', requireAdmin, async (req, res) => {
  const id    = parseInt(req.params.id);
  const grant = req.body.complimentary === true || req.body.complimentary === 1;
  if (isNaN(id)) return res.status(400).json({ error: 'invalid user id' });
  const user = await queryOne('SELECT id, display_name, email FROM users WHERE id = ?', [id]);
  if (!user) return res.status(404).json({ error: 'user not found' });
  await queryRun('UPDATE users SET complimentary = ? WHERE id = ?', [grant ? 1 : 0, id]);
  console.log(`[admin] user ${id} (${user.display_name || user.email}) complimentary → ${grant}`);
  res.json({ ok: true, user_id: id, complimentary: grant });
});

app.get('/api/admin/whitelist', requireAdmin, async (req, res) => {
  res.json(await queries.whitelist.all.all());
});

app.post('/api/admin/whitelist', requireAdmin, async (req, res) => {
  const { email, note } = req.body;
  const emailTrim = asLowerTrimmedString(email);
  if (!emailTrim) return res.status(400).json({ error: 'email required' });
  try {
    const noteVal = (typeof note === 'string' && note) ? note : null;
    const info = await queries.whitelist.insert.run(emailTrim, noteVal);
    res.json({ id: info.id, email: emailTrim, note: noteVal });
  } catch (err) {
    if (err.message?.includes('UNIQUE')) return res.status(409).json({ error: 'already whitelisted' });
    throw err;
  }
});

app.delete('/api/admin/whitelist/:id', requireAdmin, async (req, res) => {
  await queries.whitelist.delete.run(parseInt(req.params.id));
  res.json({ ok: true });
});

// API key management (admin or self)
app.get('/api/admin/api-keys', requireAdmin, async (req, res) => {
  res.json(await queries.apiKeys.allForUser.all(req.user.id));
});

app.post('/api/admin/api-keys', requireAdmin, async (req, res) => {
  const { name } = req.body;
  const nameTrim = asTrimmedString(name);
  if (!nameTrim) return res.status(400).json({ error: 'name required' });
  const { raw, hash, prefix } = generateApiKey();
  await queries.apiKeys.insert.run(req.user.id, nameTrim, hash, prefix);
  // Return the raw key ONCE — it is never retrievable again
  res.json({ name: nameTrim, key: raw, prefix, note: 'Save this key — it will not be shown again.' });
});

app.delete('/api/admin/api-keys/:id', requireAdmin, async (req, res) => {
  await queries.apiKeys.delete.run(parseInt(req.params.id), req.user.id);
  res.json({ ok: true });
});

// Admin UI page
app.get('/admin', requireAdmin, async (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Settings page — any authenticated user
app.get('/goals', requireAuth, async (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'goals.html'));
});

app.get('/settings', requireAuth, async (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'settings.html'));
});

// ── Per-user API key management (requireAuth, scoped to own keys) ──
// Mirrors /api/admin/api-keys but available to all users for their own keys.
app.get('/api/keys', requireAuth, async (req, res) => {
  res.json(await queries.apiKeys.allForUser.all(req.user.id));
});

app.post('/api/keys', requireAuth, async (req, res) => {
  const { name } = req.body;
  const nameTrim = asTrimmedString(name);
  if (!nameTrim) return res.status(400).json({ error: 'name required' });
  const { raw, hash, prefix } = generateApiKey();
  await queries.apiKeys.insert.run(req.user.id, nameTrim, hash, prefix);
  res.json({ name: nameTrim, key: raw, prefix, note: 'Save this key — it will not be shown again.' });
});

app.delete('/api/keys/:id', requireAuth, async (req, res) => {
  // Scoped to own keys — the DELETE query already filters by user_id
  await queries.apiKeys.delete.run(parseInt(req.params.id), req.user.id);
  res.json({ ok: true });
});

// ── Telegram self-service bot flow ────────────────────────────
// Pending codes in `telegram_link_codes` (DB) so HA load balancers can route
// connect vs webhook to different instances.

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0/I/1 lookalikes
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// POST /api/telegram/connect — generate a link code for the calling user
app.post('/api/telegram/connect', requireAuth, async (req, res) => {
  await queries.telegramLinkCodes.pruneExpired.run(Date.now());
  await queries.telegramLinkCodes.deleteForUser.run(req.user.id);
  const code = generateCode();
  await queries.telegramLinkCodes.insert.run(code, req.user.id, Date.now() + 10 * 60 * 1000);
  const botUsername = process.env.TELEGRAM_BOT_USERNAME || null;
  res.json({ code, bot_username: botUsername, expires_in_seconds: 600 });
});

// DELETE /api/telegram/disconnect — clear the calling user's Telegram chat ID
app.delete('/api/telegram/disconnect', requireAuth, async (req, res) => {
  await queries.users.setTelegram.run(null, req.user.id);
  res.json({ ok: true });
});

// LEGACY: keep old manual chat ID endpoint so existing installs don't break
app.patch('/api/users/me/telegram', requireAuth, async (req, res) => {
  const chatId = asTrimmedString(req.body.telegram_chat_id) || null;
  await queries.users.setTelegram.run(chatId, req.user.id);
  res.json({ ok: true, telegram_chat_id: chatId });
});

// ── Debug date endpoints (admin only) ─────────────────────────
app.post('/api/admin/debug/date', requireAdmin, async (req, res) => {
  const { date } = req.body;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }
  await setDebugDate(date);
  console.log(`[debug] date override set to ${date}`);
  res.json({ ok: true, debug_date: date });
});

app.delete('/api/admin/debug/date', requireAdmin, async (req, res) => {
  await setDebugDate(null);
  console.log('[debug] date override cleared');
  res.json({ ok: true, debug_date: null });
});

// ── Test notification endpoint — any authenticated user (sends to their own chat) ──
app.post('/api/telegram/test', requireAuth, async (req, res) => {
  const result = await checkDueTasks({ testMode: true, userId: req.user.id });
  res.json(result);
});

// Keep legacy admin path as alias so existing admin.html JS still works
app.post('/api/admin/telegram/test', requireAdmin, async (req, res) => {
  const result = await checkDueTasks({ testMode: true, userId: req.user.id });
  res.json(result);
});

// ============================================================
// Webhook — push-based automation (n8n, IFTTT, Zapier, Make)
// Auth: Authorization: Bearer <api-key>  (same as REST API)
//
// Actions:
//   add_task    { action, title, tile, goal? }
//   complete    { action, title? / id? }
//   mark_wip    { action, title? / id? }
//   delete_task { action, title? / id? }
// ============================================================

app.post('/api/webhook', rateLimitWrites, async (req, res) => {
  // Must be authenticated via API key — session auth is NOT sufficient for webhooks.
  // This prevents any process that can reach port 3033 from pushing tasks without a key,
  // even in single-user mode where req.user is always pre-populated.
  if (!req.apiKeyAuthenticated) return res.status(401).json({ error: 'unauthorized — provide Authorization: Bearer <api-key>' });

  const uid = req.user.id;
  const { action, title, tile, goal, id } = req.body || {};

  if (!action) return res.status(400).json({ error: 'action required' });

  // ── add_task ────────────────────────────────────────────
  if (action === 'add_task') {
    const titleTrim = asTrimmedString(title);
    const tileTrim  = asTrimmedString(tile);
    if (!titleTrim) return res.status(400).json({ error: 'title required' });
    if (!tileTrim)  return res.status(400).json({ error: 'tile required' });

    const titleLenErr = validateLen(titleTrim, LIMITS.titleLen, 'Task title');
    if (titleLenErr) return res.status(400).json({ error: titleLenErr });
    const quotaErr = await checkQuota('tasks', 'user_id', uid, LIMITS.tasks, 'Task');
    if (quotaErr) return res.status(429).json({ error: quotaErr });

    // Find tile by case-insensitive partial name match
    const allCols = await queries.columns.all.all(uid);
    const tileLower = tileTrim.toLowerCase();
    const col = allCols.find(c => c.name.toLowerCase().includes(tileLower));
    if (!col) {
      return res.status(404).json({
        error: `tile not found: "${tileTrim}"`,
        available: allCols.map(c => c.name),
      });
    }

    // Optional goal association
    let goalId = null;
    if (goal) {
      const allGoals = await queries.goals.all.all(uid);
      const goalStr = (typeof goal === 'string') ? goal : String(goal);
      const g = allGoals.find(g => g.title.toLowerCase().includes(goalStr.toLowerCase()));
      if (g) goalId = g.id;
    }

    const info = await queries.tasks.insert.run(uid, titleTrim, col.id, col.id, goalId);
    const task = await queries.tasks.byId.get(info.id, uid);
    return res.json({ ok: true, task });
  }

  // ── complete / mark_wip / delete_task ───────────────────
  if (action === 'complete' || action === 'mark_wip' || action === 'delete_task') {
    if (!id && !title) return res.status(400).json({ error: 'provide id or title' });

    const allTasks = await queries.tasks.all.all(uid);
    const task = id
      ? allTasks.find(t => t.id === parseInt(id))
      : allTasks.find(t => t.title.toLowerCase().includes(title.toLowerCase()) && t.status !== 'done');

    if (!task) {
      return res.status(404).json({ error: `task not found: ${id ? `id ${id}` : `"${title}"`}` });
    }

    if (action === 'complete') {
      await queries.tasks.updateStatus.run('done', task.id, uid);
      return res.json({ ok: true, task: { ...task, status: 'done' } });
    }
    if (action === 'mark_wip') {
      await queries.tasks.updateStatus.run('wip', task.id, uid);
      return res.json({ ok: true, task: { ...task, status: 'wip' } });
    }
    if (action === 'delete_task') {
      await queries.tasks.delete.run(task.id, uid);
      return res.json({ ok: true, deleted: task });
    }
  }

  return res.status(400).json({
    error: `unknown action: "${action}"`,
    supported: ['add_task', 'complete', 'mark_wip', 'delete_task'],
  });
});

// ============================================================
// Export / Import
// ============================================================

app.get('/api/export', async (req, res) => {
  const uid = req.user.id;
  const goals   = await queries.goals.all.all(uid);
  const columns = await queries.columns.all.all(uid);
  const tasks   = await queries.tasks.all.all(uid);

  const payload = {
    version:           '1',
    exported_at:       new Date().toISOString(),
    taskpapr_version:  require('./package.json').version,
    goals: goals.map(g => ({
      title:    g.title,
      notes:    g.notes || null,
      position: g.position,
    })),
    tiles: columns.map(col => ({
      name:     col.name,
      x:        col.x,
      y:        col.y,
      width:    col.width,
      color:    col.color || null,
      position: col.position,
      tasks:    tasks
        .filter(t => t.column_id === col.id)
        .map(t => {
          const goal = goals.find(g => g.id === t.goal_id);
          return {
            title:       t.title,
            status:      t.status,
            position:    t.position,
            goal:        goal ? goal.title : null,
            notes:       t.notes       || null,
            next_due:    t.next_due    || null,
            recurrence:  t.recurrence  || null,
            created_at:  t.created_at,
          };
        }),
    })),
  };

  const date     = new Date().toISOString().slice(0, 10);
  const filename = `taskpapr-export-${date}.json`;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.json(payload);
});

app.post('/api/import', express.json({ limit: '10mb' }), async (req, res) => {
  const uid  = req.user.id;
  const mode = (typeof req.query.mode === 'string' ? req.query.mode : 'merge').toLowerCase();

  if (mode !== 'merge' && mode !== 'replace') {
    return res.status(400).json({ error: 'mode must be "merge" or "replace"' });
  }

  const data = req.body;

  // Basic validation
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'request body must be a JSON object' });
  }
  if (!Array.isArray(data.tiles)) {
    return res.status(400).json({ error: 'import data must contain a "tiles" array' });
  }

  const counts = { goals: 0, tiles: 0, tasks: 0, skipped: 0 };

  await transaction(async () => {
    // ── Replace mode: wipe everything ──────────────────────
    if (mode === 'replace') {
      // Delete tasks first (FK), then columns, then goals
      await queryRun('DELETE FROM tasks   WHERE user_id = ?', [uid]);
      await queryRun('DELETE FROM columns WHERE user_id = ?', [uid]);
      await queryRun('DELETE FROM goals   WHERE user_id = ?', [uid]);
    }

    // ── Import goals ────────────────────────────────────────
    const goalMap = {}; // title → new id

    if (Array.isArray(data.goals)) {
      for (const g of data.goals) {
        if (typeof g.title !== 'string' || !g.title.trim()) { counts.skipped++; continue; }

        if (mode === 'merge') {
          // Skip if a goal with this title already exists
          const existing = (await queries.goals.all.all(uid)).find(
            eg => eg.title.toLowerCase() === g.title.toLowerCase()
          );
          if (existing) { goalMap[g.title] = existing.id; continue; }
        }

        const info = await queries.goals.insert.run(uid, g.title.trim(), (typeof g.notes === 'string' && g.notes) ? g.notes : null, uid);
        goalMap[g.title] = info.id;
        counts.goals++;
      }
    }

    // ── Import tiles + tasks ────────────────────────────────
    for (const tile of data.tiles) {
      if (typeof tile.name !== 'string' || !tile.name.trim()) { counts.skipped++; continue; }

      let colId;

      if (mode === 'merge') {
        // Reuse existing tile with same name if present
        const existing = (await queries.columns.all.all(uid)).find(
          ec => ec.name.toLowerCase() === tile.name.toLowerCase()
        );
        if (existing) {
          colId = existing.id;
        } else {
          const info = await queries.columns.insert.run(
            uid, tile.name.trim(), uid,
            tile.x ?? 40, tile.y ?? 40, tile.width ?? 260, tile.color || null
          );
          colId = info.id;
          counts.tiles++;
        }
      } else {
        const info = await queries.columns.insert.run(
          uid, tile.name.trim(), uid,
          tile.x ?? 40, tile.y ?? 40, tile.width ?? 260, tile.color || null
        );
        colId = info.id;
        counts.tiles++;
      }

      // Apply tile-level hidden flag if present
      if (tile.hidden) {
        await queryRun('UPDATE columns SET hidden = 1 WHERE id = ? AND user_id = ?', [colId, uid]);
      }

      // Import tasks for this tile
      if (Array.isArray(tile.tasks)) {
        for (const t of tile.tasks) {
          if (typeof t.title !== 'string' || !t.title.trim()) { counts.skipped++; continue; }

          const validStatuses = ['active', 'wip', 'done'];
          const status  = validStatuses.includes(t.status) ? t.status : 'active';
          const goalId  = (t.goal && goalMap[t.goal]) ? goalMap[t.goal] : null;

          await queries.tasks.insert.run(uid, t.title.trim(), colId, colId, goalId);

          // Fetch the task we just inserted so we can patch extended fields
          const newTask = await queryOne(
            'SELECT id FROM tasks WHERE user_id = ? AND column_id = ? ORDER BY id DESC LIMIT 1',
            [uid, colId]
          );

          if (newTask) {
            // Patch status (insert always sets 'active')
            if (status !== 'active') {
              await queries.tasks.updateStatus.run(status, newTask.id, uid);
            }
            // Patch notes, next_due, recurrence if provided in the import
            if (t.notes)      await queryRun("UPDATE tasks SET notes      = ? WHERE id = ? AND user_id = ?", [t.notes,      newTask.id, uid]);
            if (t.next_due)   await queryRun("UPDATE tasks SET next_due   = ? WHERE id = ? AND user_id = ?", [t.next_due,   newTask.id, uid]);
            if (t.recurrence) await queryRun("UPDATE tasks SET recurrence = ? WHERE id = ? AND user_id = ?", [t.recurrence, newTask.id, uid]);
          }
          counts.tasks++;
        }
      }
    }
  });

  // Run dormancy check immediately so imported tasks with future due dates
  // get the correct status (dormant/active) without waiting for the hourly tick.
  wakeDormantTasks();

  res.json({ ok: true, mode, imported: counts });
});

// ============================================================
// Columns (tiles)
// ============================================================

// ── Last-modified timestamp (used by frontend polling to detect changes) ──
// Returns the max updated_at across tasks + columns for the current user.
// Cheap single-query check — no full data transfer on every poll.
app.get('/api/last-modified', async (req, res) => {
  const uid = req.user.id;
  const row = await queryOne(`
    SELECT MAX(t) AS t FROM (
      SELECT MAX(updated_at) AS t FROM tasks   WHERE user_id = ?
      UNION ALL
      SELECT MAX(updated_at) AS t FROM columns WHERE user_id = ?
    )
  `, [uid, uid]);
  res.json({ t: row?.t || null });
});

app.get('/api/columns', async (req, res) => {
  res.json(await queries.columns.all.all(req.user.id));
});

app.post('/api/columns', rateLimitWrites, async (req, res) => {
  const { name, x, y, width, color } = req.body;
  const nameTrim = asTrimmedString(name);
  if (!nameTrim) return res.status(400).json({ error: 'name required' });
  const uid = req.user.id;
  const lenErr = validateLen(nameTrim, LIMITS.nameLen, 'Tile name');
  if (lenErr) return res.status(400).json({ error: lenErr });
  const quotaErr = await checkQuota('columns', 'user_id', uid, LIMITS.tiles, 'Tile');
  if (quotaErr) return res.status(429).json({ error: quotaErr });
  const info = await queries.columns.insert.run(uid, nameTrim, uid, x ?? 0, y ?? 0, width ?? 260, color ?? null);
  res.json(await queries.columns.byId.get(info.id, uid));
});

app.patch('/api/columns/:id', async (req, res) => {
  const id  = parseInt(req.params.id);
  const uid = req.user.id;
  const { name, position, x, y, width, color, hidden, scale } = req.body;
  if (name !== undefined) {
    const nameTrim = asTrimmedString(name);
    if (!nameTrim) return res.status(400).json({ error: 'name cannot be empty' });
    const lenErr = validateLen(nameTrim, LIMITS.nameLen, 'Tile name');
    if (lenErr) return res.status(400).json({ error: lenErr });
  }
  if (name     !== undefined) await queries.columns.rename.run(asTrimmedString(name), id, uid);
  if (position !== undefined) await queries.columns.reorder.run(position, id, uid);
  if (x !== undefined && y !== undefined) await queries.columns.move.run(x, y, id, uid);
  if (width    !== undefined) await queries.columns.resize.run(width, id, uid);
  if (color    !== undefined) await queries.columns.setColor.run(color, id, uid);
  if (hidden   !== undefined) await queries.columns.setHidden.run(hidden ? 1 : 0, id, uid);
  if (scale    !== undefined) await queries.columns.setScale.run(Math.max(0.5, Math.min(2.0, Number(scale))), id, uid);
  res.json(await queries.columns.byId.get(id, uid));
});

app.delete('/api/columns/:id', async (req, res) => {
  await queries.columns.delete.run(parseInt(req.params.id), req.user.id);
  res.json({ ok: true });
});

// ============================================================
// Tasks
// ============================================================

app.get('/api/tasks', async (req, res) => {
  res.json(await queries.tasks.all.all(req.user.id));
});

app.post('/api/tasks', rateLimitWrites, async (req, res) => {
  const { title, column_id, goal_id } = req.body;
  const uid = req.user.id;
  const titleTrim = asTrimmedString(title);
  if (!titleTrim) return res.status(400).json({ error: 'title required' });
  if (!column_id) return res.status(400).json({ error: 'column_id required' });
  const lenErr = validateLen(titleTrim, LIMITS.titleLen, 'Task title');
  if (lenErr) return res.status(400).json({ error: lenErr });
  const quotaErr = await checkQuota('tasks', 'user_id', uid, LIMITS.tasks, 'Task');
  if (quotaErr) return res.status(429).json({ error: quotaErr });
  const info = await queries.tasks.insert.run(uid, titleTrim, column_id, column_id, goal_id || null);
  res.json(await queries.tasks.byId.get(info.id, uid));
});

app.patch('/api/tasks/:id', async (req, res) => {
  const id  = parseInt(req.params.id);
  const uid = req.user.id;
  const { status, title, goal_id, position, column_id } = req.body;
  const needsCurrent =
    status !== undefined ||
    title !== undefined ||
    goal_id !== undefined ||
    position !== undefined ||
    column_id !== undefined ||
    req.body.notes !== undefined ||
    req.body.next_due !== undefined ||
    req.body.recurrence !== undefined ||
    req.body.visibility_days !== undefined ||
    req.body.no_rot !== undefined ||
    req.body.rot_interval !== undefined ||
    req.body.color !== undefined ||
    req.body.today_flag !== undefined ||
    req.body.today_order !== undefined ||
    req.body._ack;
  const current = needsCurrent ? await queries.tasks.byId.get(id, uid) : null;
  if (needsCurrent && !current) return res.status(404).json({ error: 'task not found' });

  if (title !== undefined && typeof title !== 'string') return res.status(400).json({ error: 'title must be a string' });

  if (status !== undefined) {
    if (status === 'done') {
      if (current && current.recurrence) {
        // Recurring task completed:
        // -1 = always visible → reset to active immediately (spinning-plates style)
        // ≥0 = hide until next_due window → set dormant
        const nextDue = advanceDate(current.next_due || getTodayStr(), current.recurrence);
        const alwaysVisible = (current.visibility_days === -1 || current.visibility_days == null);
        const newStatus = alwaysVisible ? 'active' : 'dormant';
        await queryRun(`UPDATE tasks SET status=?, last_done_at=${sqlNowExpr()}, next_due=?, updated_at=${sqlNowExpr()} WHERE id=? AND user_id=?`, [newStatus, nextDue, id, uid]);
      } else {
        await queries.tasks.updateStatus.run(status, id, uid);
      }
      // Completing a task removes it from the Today view immediately.
      // today_flag is cleared; today_order is left in place (harmless, reused if
      // the task is un-done). For recurring tasks the flag also clears — the
      // reset task starts the next cycle unflagged.
      await queryRun("UPDATE tasks SET today_flag = 0 WHERE id = ? AND user_id = ?", [id, uid]);
    } else {
      await queries.tasks.updateStatus.run(status, id, uid);
    }
  }
  if (title !== undefined) {
    const trimmed = title.trim();
    const lenErr = validateLen(trimmed, LIMITS.titleLen, 'Task title');
    if (lenErr) return res.status(400).json({ error: lenErr });
    if (current && trimmed && trimmed !== current.title) {
      await queries.tasks.updateTitle.run(trimmed, id, uid);
    }
  }
  if (goal_id !== undefined) {
    const goalVal = (goal_id === null || goal_id === '') ? null : goal_id;
    if (current && (current.goal_id ?? null) !== (goalVal ?? null)) {
      await queries.tasks.updateGoal.run(goalVal, id, uid);
    }
  }
  if (req.body.notes !== undefined) {
    const notesLenErr = validateLen(req.body.notes || '', LIMITS.notesLen, 'Notes');
    if (notesLenErr) return res.status(400).json({ error: notesLenErr });
    const nextNotes = req.body.notes || null;
    if ((current.notes || null) !== nextNotes) {
      await queryRun(`UPDATE tasks SET notes = ?, updated_at = ${sqlNowExpr()} WHERE id = ? AND user_id = ?`, [nextNotes, id, uid]);
    }
  }
  if (req.body.next_due !== undefined) {
    const nextDue = req.body.next_due || null;
    if ((current.next_due || null) !== nextDue) {
      await queryRun(`UPDATE tasks SET next_due = ?, updated_at = ${sqlNowExpr()} WHERE id = ? AND user_id = ?`, [nextDue, id, uid]);
      await syncDormantState(id, uid);
    }
  }
  if (req.body.recurrence !== undefined) {
    const nextRecurrence = req.body.recurrence || null;
    if ((current.recurrence || null) !== nextRecurrence) {
      await queryRun(`UPDATE tasks SET recurrence = ?, updated_at = ${sqlNowExpr()} WHERE id = ? AND user_id = ?`, [nextRecurrence, id, uid]);
    }
  }
  if (req.body.visibility_days !== undefined) {
    const vd = parseInt(req.body.visibility_days);
    const nextVd = isNaN(vd) ? 3 : vd;
    if ((current.visibility_days ?? 3) !== nextVd) {
      await queryRun(`UPDATE tasks SET visibility_days = ?, updated_at = ${sqlNowExpr()} WHERE id = ? AND user_id = ?`, [nextVd, id, uid]);
      await syncDormantState(id, uid);
    }
  }
  if (req.body.no_rot !== undefined) {
    const nextNoRot = req.body.no_rot ? 1 : 0;
    if ((current.no_rot ? 1 : 0) !== nextNoRot) {
      await queryRun(`UPDATE tasks SET no_rot = ?, updated_at = ${sqlNowExpr()} WHERE id = ? AND user_id = ?`, [nextNoRot, id, uid]);
    }
  }
  if (req.body.rot_interval !== undefined) {
    const nextRot = req.body.rot_interval || 'weekly';
    if ((current.rot_interval || 'weekly') !== nextRot) {
      await queryRun(`UPDATE tasks SET rot_interval = ?, updated_at = ${sqlNowExpr()} WHERE id = ? AND user_id = ?`, [nextRot, id, uid]);
    }
  }
  if (req.body.color !== undefined) {
    const nextColor = req.body.color || null;
    if ((current.color || null) !== nextColor) {
      await queryRun(`UPDATE tasks SET color = ?, updated_at = ${sqlNowExpr()} WHERE id = ? AND user_id = ?`, [nextColor, id, uid]);
    }
  }
  if (req.body.today_flag !== undefined) {
    const nextFlag = req.body.today_flag ? 1 : 0;
    if ((current.today_flag ? 1 : 0) !== nextFlag) {
      await queryRun(`UPDATE tasks SET today_flag = ?, updated_at = ${sqlNowExpr()} WHERE id = ? AND user_id = ?`, [nextFlag, id, uid]);
    }
  }
  if (req.body.today_order !== undefined) {
    const ord = req.body.today_order === null ? null : parseInt(req.body.today_order);
    const nextOrd = isNaN(ord) ? null : ord;
    if ((current.today_order ?? null) !== nextOrd) {
      await queryRun(`UPDATE tasks SET today_order = ?, updated_at = ${sqlNowExpr()} WHERE id = ? AND user_id = ?`, [nextOrd, id, uid]);
    }
  }
  // Only an explicit Touch action (_ack) bumps last_acknowledged_at.
  // Saving notes or title is a content edit, not a deliberate "touch".
  if (req.body._ack) {
    await queryRun(`UPDATE tasks SET last_acknowledged_at = ${sqlNowExpr()}, updated_at = ${sqlNowExpr()} WHERE id = ? AND user_id = ?`, [id, uid]);
  }
  if (position  !== undefined && column_id !== undefined) {
    await queries.tasks.updatePosition.run(position, column_id, id, uid);
  }
  res.json(await queries.tasks.byId.get(id, uid));
});

// Park task — moves task to the user's first hidden tile.
// If no hidden tile exists, creates one called "Someday/Maybe".
app.post('/api/tasks/:id/park', async (req, res) => {
  const id  = parseInt(req.params.id);
  const uid = req.user.id;
  const task = await queries.tasks.byId.get(id, uid);
  if (!task) return res.status(404).json({ error: 'task not found' });

  // Find first existing hidden tile
  const cols = await queries.columns.all.all(uid);
  let hiddenCol = cols.find(c => c.hidden);

  if (!hiddenCol) {
    // Create a "Someday/Maybe" tile, positioned below the lowest visible tile
    const maxY = cols.length > 0 ? Math.max(...cols.map(c => (c.y || 0) + 200)) : 40;
    const info = await queries.columns.insert.run(uid, 'Someday/Maybe', uid, 40, maxY + 40, 260, null);
    await queries.columns.setHidden.run(1, info.id, uid);
    hiddenCol = await queries.columns.byId.get(info.id, uid);
  }

  // Move the task to the hidden tile, reset to active so it's visible when revealed
  const posRow = await queryOne('SELECT COALESCE(MAX(position),0)+1 AS next_pos FROM tasks WHERE column_id = ?', [hiddenCol.id]);
  await queries.tasks.updatePosition.run(
    posRow ? posRow.next_pos : 1,
    hiddenCol.id,
    id,
    uid
  );
  if (task.status === 'done') {
    await queries.tasks.updateStatus.run('active', id, uid);
  }

  res.json({
    task: await queries.tasks.byId.get(id, uid),
    column: hiddenCol,
  });
});

// Explicit ACK — dead man's handle: resets rot clock without requiring content change
app.post('/api/tasks/:id/ack', async (req, res) => {
  const id  = parseInt(req.params.id);
  const uid = req.user.id;
  await queries.tasks.ack.run(id, uid);
  res.json(await queries.tasks.byId.get(id, uid));
});

// Snooze task — hide for 24h without touching next_due.
// Sets status=dormant and snooze_until=tomorrow.
// wakeDormantTasks() wakes it when today >= snooze_until and clears the field.
app.post('/api/tasks/:id/snooze', requireAuth, async (req, res) => {
  const id  = parseInt(req.params.id);
  const uid = req.user.id;
  const task = await queries.tasks.byId.get(id, uid);
  if (!task) return res.status(404).json({ error: 'task not found' });
  if (task.status === 'done') return res.status(400).json({ error: 'cannot snooze a completed task' });

  const tomorrowMs = new Date(getNow());
  tomorrowMs.setUTCDate(tomorrowMs.getUTCDate() + 1);
  const tomorrowStr = tomorrowMs.toISOString().slice(0, 10);

  await queryRun(`UPDATE tasks SET snooze_until = ?, status = 'dormant', updated_at = ${sqlNowExpr()} WHERE id = ? AND user_id = ?`, [tomorrowStr, id, uid]);

  res.json(await queries.tasks.byId.get(id, uid));
});

// Update Telegram capture tile preference
app.patch('/api/users/me/telegram-capture-tile', requireAuth, async (req, res) => {
  const tile = asTrimmedString(req.body.capture_tile) || null;
  await queryRun('UPDATE users SET telegram_capture_tile = ? WHERE id = ?', [tile, req.user.id]);
  res.json({ ok: true, telegram_capture_tile: tile });
});

app.delete('/api/tasks/:id', async (req, res) => {
  await queries.tasks.delete.run(parseInt(req.params.id), req.user.id);
  res.json({ ok: true });
});

app.delete('/api/tasks', async (req, res) => {
  const uid = req.user.id;
  const { column_id } = req.query;
  if (column_id) {
    await queries.tasks.deleteCompleted.run(parseInt(column_id), uid);
  } else {
    await queries.tasks.deleteAllCompleted.run(uid);
  }
  res.json({ ok: true });
});

app.post('/api/tasks/reorder', async (req, res) => {
  const uid   = req.user.id;
  const items = req.body;
  const stmt  = queries.tasks.updatePosition;
  await transaction(async () => {
    for (const item of items) {
      await stmt.run(item.position, item.column_id, item.id, uid);
    }
  });
  res.json({ ok: true });
});

// ============================================================
// Goals
// ============================================================

app.get('/api/goals', async (req, res) => {
  res.json(await queries.goals.all.all(req.user.id));
});

app.post('/api/goals', rateLimitWrites, async (req, res) => {
  const { title, notes } = req.body;
  const uid = req.user.id;
  const titleTrim = asTrimmedString(title);
  if (!titleTrim) return res.status(400).json({ error: 'title required' });
  const lenErr = validateLen(titleTrim, LIMITS.nameLen, 'Goal title');
  if (lenErr) return res.status(400).json({ error: lenErr });
  const quotaErr = await checkQuota('goals', 'user_id', uid, LIMITS.goals, 'Goal');
  if (quotaErr) return res.status(429).json({ error: quotaErr });
  const notesVal = (typeof notes === 'string' && notes) ? notes : null;
  const info = await queries.goals.insert.run(uid, titleTrim, notesVal, uid);
  res.json(await queries.goals.byId.get(info.id, uid));
});

app.patch('/api/goals/:id', async (req, res) => {
  const id  = parseInt(req.params.id);
  const uid = req.user.id;
  const { title, notes } = req.body;
  const current = await queries.goals.byId.get(id, uid);
  if (!current) return res.status(404).json({ error: 'not found' });
  if (title !== undefined && typeof title !== 'string') return res.status(400).json({ error: 'title must be a string' });
  await queries.goals.update.run(
    title !== undefined ? (title.trim() || current.title) : current.title,
    notes !== undefined ? ((typeof notes === 'string' && notes) ? notes : null) : current.notes,
    id,
    uid
  );
  res.json(await queries.goals.byId.get(id, uid));
});

app.delete('/api/goals/:id', async (req, res) => {
  await queries.goals.delete.run(parseInt(req.params.id), req.user.id);
  res.json({ ok: true });
});

// ============================================================
// Bookmarks
// ============================================================

app.get('/api/bookmarks', async (req, res) => {
  res.json(await queries.bookmarks.all.all(req.user.id));
});

app.post('/api/bookmarks', rateLimitWrites, async (req, res) => {
  const { name, x, y, zoom } = req.body;
  const uid = req.user.id;
  const nameTrim = asTrimmedString(name);
  if (!nameTrim) return res.status(400).json({ error: 'name required' });
  if (typeof x !== 'number' || typeof y !== 'number' || typeof zoom !== 'number') {
    return res.status(400).json({ error: 'x, y, zoom must be numbers' });
  }
  const lenErr = validateLen(nameTrim, LIMITS.nameLen, 'Bookmark name');
  if (lenErr) return res.status(400).json({ error: lenErr });
  const quotaErr = await checkQuota('bookmarks', 'user_id', uid, LIMITS.bookmarks, 'Bookmark');
  if (quotaErr) return res.status(429).json({ error: quotaErr });
  const info = await queries.bookmarks.insert.run(uid, nameTrim, x, y, zoom, uid);
  res.json(await queries.bookmarks.byId.get(info.id, uid));
});

app.patch('/api/bookmarks/:id', async (req, res) => {
  const id  = parseInt(req.params.id);
  const uid = req.user.id;
  const current = await queries.bookmarks.byId.get(id, uid);
  if (!current) return res.status(404).json({ error: 'not found' });
  const { name } = req.body;
  if (name !== undefined) {
    const nameTrim = asTrimmedString(name);
    if (!nameTrim) return res.status(400).json({ error: 'name cannot be empty' });
    await queries.bookmarks.rename.run(nameTrim, id, uid);
  }
  res.json(await queries.bookmarks.byId.get(id, uid));
});

app.delete('/api/bookmarks/:id', async (req, res) => {
  await queries.bookmarks.delete.run(parseInt(req.params.id), req.user.id);
  res.json({ ok: true });
});

// ============================================================
// Telegram notifications
// ============================================================

// Sends a message via the Telegram Bot API (fire-and-forget, logs errors)
async function sendTelegram(text, chatId) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const resolvedChatId = chatId || process.env.TELEGRAM_CHAT_ID;
  if (!token || !resolvedChatId) return;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    const https = require('https');
    const body  = JSON.stringify({ chat_id: resolvedChatId, text, parse_mode: 'HTML' });
    await new Promise((resolve, reject) => {
      const req = https.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode !== 200) {
            console.warn('[telegram] non-200 response:', res.statusCode, data);
          }
          resolve();
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  } catch (err) {
    console.warn('[telegram] send failed:', err.message);
  }
}

// Check tasks for due today / due tomorrow.
// Options:
//   testMode: true  → also return the message text; don't require recipients configured
//   userId: N       → only check tasks for that user (for test sends)
// In normal (scheduled) mode: iterates all users with a telegram_chat_id,
// falls back to env TELEGRAM_CHAT_ID for users without one.
async function checkDueTasks(opts = {}) {
  const { testMode = false, userId = null } = opts;
  const token = process.env.TELEGRAM_BOT_TOKEN;

  const todayStr    = getTodayStr();
  const tomorrowMs  = new Date(getNow());
  tomorrowMs.setUTCDate(tomorrowMs.getUTCDate() + 1);
  const tomorrowStr = tomorrowMs.toISOString().slice(0, 10);

  // Determine which users to notify
  let recipients;
  if (userId !== null) {
    // Targeted (test mode or per-user)
    const u = await queries.users.byId.get(userId);
    const chatId = u?.telegram_chat_id || (testMode ? process.env.TELEGRAM_CHAT_ID : null);
    recipients = u ? [{ ...u, effective_chat_id: chatId }] : [];
  } else {
    // All users with a chat ID, plus env fallback for users without one
    const allUsers = await queries.users.all.all();
    recipients = allUsers.map(u => ({
      ...u,
      effective_chat_id: u.telegram_chat_id || process.env.TELEGRAM_CHAT_ID || null,
    })).filter(u => u.effective_chat_id);
  }

  if (recipients.length === 0) {
    const msg = 'No Telegram recipients configured (set TELEGRAM_CHAT_ID in .env or add a chat ID in your profile)';
    console.log(`[telegram] ${msg}`);
    return { sent: false, message: null, note: msg };
  }

  const results = [];

  for (const user of recipients) {
    if (!token) {
      const msg = 'TELEGRAM_BOT_TOKEN not set';
      results.push({ user_id: user.id, sent: false, note: msg });
      continue;
    }

    // Include overdue tasks (next_due < today) as well as today and tomorrow.
    // Previously used IN (today, tomorrow) which silently dropped any task
    // whose due date had already passed without being completed.
    const tasks = await queryAll(`
      SELECT t.title, t.next_due, t.status, c.name AS tile
      FROM tasks t
      JOIN columns c ON c.id = t.column_id
      WHERE t.user_id = ?
        AND t.status != 'done'
        AND t.next_due IS NOT NULL
        AND t.next_due <= ?
      ORDER BY t.next_due ASC, t.id ASC
    `, [user.id, tomorrowStr]);

    if (tasks.length === 0) {
      console.log(`[telegram] user ${user.id} — no tasks due/overdue`);
      results.push({ user_id: user.id, sent: false, note: 'No tasks due or overdue', message: null });
      continue;
    }

    const overdue     = tasks.filter(t => t.next_due <  todayStr);
    const dueToday    = tasks.filter(t => t.next_due === todayStr);
    const dueTomorrow = tasks.filter(t => t.next_due === tomorrowStr);

    const lines = [];
    const dateLabel = getDebugDate() ? ` <i>(debug: ${getDebugDate()})</i>` : '';
    lines.push(`<b>📋 taskpapr reminder${dateLabel}</b>`);

    if (overdue.length > 0) {
      lines.push(`\n<b>⚠️ Overdue:</b>`);
      overdue.forEach(t => lines.push(`  • ${t.title} <i>[${t.tile}]</i> — was due ${t.next_due}`));
    }
    if (dueToday.length > 0) {
      lines.push(`\n<b>Due today (${todayStr}):</b>`);
      dueToday.forEach(t => lines.push(`  • ${t.title} <i>[${t.tile}]</i>`));
    }
    if (dueTomorrow.length > 0) {
      lines.push(`\n<b>Due tomorrow (${tomorrowStr}):</b>`);
      dueTomorrow.forEach(t => lines.push(`  • ${t.title} <i>[${t.tile}]</i>`));
    }

    const message = lines.join('\n');
    console.log(`[telegram] ${new Date().toISOString()} user ${user.id} — sending digest (${tasks.length} task(s))`);

    if (testMode) {
      // In test mode send a brief synthetic ping — never the real due-task digest.
      const testMsg = `✅ taskpapr Telegram is working!\n\n<i>This is a test notification from taskpapr settings.</i>`;
      await sendTelegram(testMsg, user.effective_chat_id);
      results.push({ user_id: user.id, sent: true, message: testMsg });
    } else {
      await sendTelegram(message, user.effective_chat_id);
      results.push({ user_id: user.id, sent: true, message });
    }
  }

  // For test endpoint: return first result (single user)
  if (testMode && results.length === 1) return results[0];

  // Record that we sent the scheduled digest today (used by startup check to
  // avoid re-sending if the server restarts after the scheduled window).
  // Only written for scheduled (non-test) sends.
  if (!testMode) {
    await upsertSetting('telegram_last_sent', getTodayStr());
  }

  return { sent: true, results };
}

// Schedule daily notification at a target hour (default 08:00 local time)
// Runs once shortly after startup, then every 24h aligned to the target hour.
function scheduleDailyNotifications() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log('[telegram] TELEGRAM_BOT_TOKEN not set — notifications disabled');
    return;
  }
  // Note: TELEGRAM_CHAT_ID is an optional env fallback for users who haven't
  // linked via the self-service bot flow. checkDueTasks() queries the DB for
  // per-user chat IDs and falls back to the env var automatically. We must
  // NOT gate scheduling on TELEGRAM_CHAT_ID here, or users who linked via
  // the settings page (and never set TELEGRAM_CHAT_ID) will never be notified.

  const targetHour = parseInt(process.env.TELEGRAM_NOTIFY_HOUR || '8', 10);

  function msUntilNextRun() {
    const now  = new Date();
    const next = new Date(now);
    next.setHours(targetHour, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1); // already passed today → tomorrow
    return next - now;
  }

  function scheduleNext() {
    const delay = msUntilNextRun();
    const nextRun = new Date(Date.now() + delay);
    console.log(`[telegram] next notification scheduled for ${nextRun.toLocaleString()} (in ${Math.round(delay / 60000)} min)`);
    setTimeout(async () => {
      await withSchedulerLock(async () => {
        await refreshPostgresJobDebugDate();
        await checkDueTasks();
      });
      scheduleNext(); // reschedule for the next day
    }, delay);
  }

  scheduleNext();

  // Startup check — fires if the daily digest hasn't been sent yet today AND
  // the current time is past the target hour. This catches the case where the
  // server was restarted after the scheduled send window (e.g. after a code
  // deploy). It deliberately does NOT re-send if we already sent today, so
  // frequent restarts during development don't spam users.
  setTimeout(async () => {
    const todayStr   = getTodayStr();
    const lastSent   = await queryOne("SELECT value FROM settings WHERE key = 'telegram_last_sent'");
    const alreadySent = lastSent?.value === todayStr;
    const currentHour = new Date().getHours();

    if (alreadySent) {
      console.log(`[telegram] startup check skipped — already sent today (${todayStr})`);
      return;
    }
    if (currentHour < targetHour) {
      console.log(`[telegram] startup check skipped — not yet ${targetHour}:00 (current hour: ${currentHour})`);
      return;
    }
    console.log('[telegram] startup check — sending missed digest…');
    await withSchedulerLock(async () => {
      await refreshPostgresJobDebugDate();
      await checkDueTasks();
    });
  }, 10_000);
}

// ── Dormant state helpers ─────────────────────────────────────
// Returns true if the task should currently be dormant:
//   - has a next_due date
//   - visibility_days >= 0 (not -1 = always visible)
//   - today is before the wake window (next_due - visibility_days)
function shouldBeDormant(t) {
  if (!t.next_due) return false;
  if (t.visibility_days == null || t.visibility_days < 0) return false;
  const todayStr = getTodayStr();
  const vd = isNaN(t.visibility_days) ? 3 : t.visibility_days;
  const wakeDate = new Date(t.next_due + 'T12:00:00Z');
  wakeDate.setUTCDate(wakeDate.getUTCDate() - vd);
  return todayStr < wakeDate.toISOString().slice(0, 10);
}

// After PATCH of next_due or visibility_days, immediately sync dormant state
// for a single task (works for both recurring and non-recurring).
async function syncDormantState(taskId, userId) {
  const t = await queries.tasks.byId.get(taskId, userId);
  if (!t || t.status === 'done') return;
  if (t.status !== 'dormant' && shouldBeDormant(t)) {
    await queries.tasks.updateStatus.run('dormant', taskId, userId);
  } else if (t.status === 'dormant' && !shouldBeDormant(t)) {
    await queries.tasks.updateStatus.run('active', taskId, userId);
  }
}

// ── Wake/sleep dormant tasks ──────────────────────────────────
// Runs on startup and every hour.
// Pass 1 — wake dormant tasks whose window has arrived.
// Pass 2 — put active/wip tasks to sleep if they should be dormant.
//   (Catches tasks set up before this feature existed, or created via API.)
async function wakeDormantTasks() {
  const todayStr = getTodayStr();
  const allUsers = await queries.users.all.all();
  let woken = 0, slept = 0;

  for (const user of allUsers) {
    // ── Pass 1: wake dormant tasks ─────────────────────────
    const dormant = await queryAll(
      `SELECT * FROM tasks WHERE user_id = ? AND status = 'dormant'`,
      [user.id]
    );

    for (const t of dormant) {
      // ── Snooze takes priority over all other dormancy logic ──
      // A snoozed task has snooze_until set. When the snooze expires, clear
      // it and wake. While active, skip normal dormancy wake logic entirely
      // so we don't accidentally interfere with next_due / visibility_days.
      if (t.snooze_until) {
        if (todayStr >= t.snooze_until) {
          await queryRun(`UPDATE tasks SET snooze_until = NULL, status = 'active', updated_at = ${sqlNowExpr()} WHERE id = ?`, [t.id]);
          woken++;
        }
        // Whether expired or not, this task is handled — skip normal logic.
        continue;
      }

      if (!t.next_due) continue;
      // visibility_days = -1 → always visible; wake immediately
      if (t.visibility_days === -1) {
        await queries.tasks.updateStatus.run('active', t.id, user.id);
        woken++;
        continue;
      }
      const vd = (t.visibility_days == null || isNaN(t.visibility_days)) ? 3 : t.visibility_days;
      const wakeDate = new Date(t.next_due + 'T12:00:00Z');
      wakeDate.setUTCDate(wakeDate.getUTCDate() - vd);
      if (todayStr >= wakeDate.toISOString().slice(0, 10)) {
        await queries.tasks.updateStatus.run('active', t.id, user.id);
        woken++;
      }
    }

    // ── Pass 2: put active/wip tasks to sleep if needed ────
    const candidates = await queryAll(
      `SELECT * FROM tasks WHERE user_id = ? AND status IN ('active','wip') AND next_due IS NOT NULL`,
      [user.id]
    );

    for (const t of candidates) {
      if (shouldBeDormant(t)) {
        await queries.tasks.updateStatus.run('dormant', t.id, user.id);
        slept++;
      }
    }
  }

  if (woken > 0 || slept > 0) {
    console.log(`[dormant] woke ${woken}, slept ${slept} task(s) (today=${todayStr})`);
  }
}

// ============================================================
// Start
// ============================================================
  app.listen(PORT, () => {
    console.log(`taskpapr running at http://localhost:${PORT}`);
    scheduleDailyNotifications();
    // Wake dormant tasks on startup, then hourly (Postgres: single replica via advisory lock)
    void (async () => {
      await withSchedulerLock(async () => {
        await refreshPostgresJobDebugDate();
        await wakeDormantTasks();
      });
    })();
    setInterval(() => {
      void (async () => {
        await withSchedulerLock(async () => {
          await refreshPostgresJobDebugDate();
          await wakeDormantTasks();
        });
      })();
    }, 60 * 60 * 1000);
  });
}

start().catch(err => {
  console.error('[startup] Fatal error:', err);
  process.exit(1);
});
