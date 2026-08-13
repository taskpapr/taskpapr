require('dotenv').config({ quiet: true });
require('express-async-errors');

const express = require('express');
const path    = require('path');
const helmet  = require('helmet');

const {
  queries,
  queryRun,
  withSchedulerLock,
  pool,
} = require('./db');

const {
  setupAuth,
  setupAuthRoutes,
  requireAuth,
  apiKeyAuth,
  isSingleUserMode,
  _isWhitelistRequired,
} = require('./auth');

const { rateLimitGlobal, rateLimitAuth } = require('./lib/rateLimits');
const {
  createDebugDateMiddleware,
  getTodayStr,
  getDebugDate,
  refreshPostgresJobDebugDate,
} = require('./lib/date');
const { addConnection, removeConnection, emitUserChange } = require('./lib/events');

const { wakeDormantTasks }         = require('./services/dormancy');
const { scheduleDailyNotifications } = require('./services/notifications');

// Route modules
const taskRoutes     = require('./routes/tasks');
const columnRoutes   = require('./routes/columns');
const goalRoutes     = require('./routes/goals');
const bookmarkRoutes = require('./routes/bookmarks');
const billing        = require('./routes/billing');
const adminRoutes    = require('./routes/admin');
const telegram       = require('./routes/telegram');
const webhookRoutes  = require('./routes/webhook');
const exportRoutes   = require('./routes/export');

// Stripe presence check (no import needed — billing.js owns the instance)
const stripeConfigured = !!process.env.STRIPE_SECRET_KEY;

const app  = express();
const PORT = process.env.PORT || 3033;

// ── Trust proxy ───────────────────────────────────────────────
app.set('trust proxy', 1);

// ── Security headers ──────────────────────────────────────────
// All page scripts are external files under /js (no build step, no inline
// <script> blocks), so script-src can be 'self' — injected inline scripts,
// the main XSS vector, are blocked. Styles stay 'unsafe-inline': pages use
// <style> blocks and generated style="" attributes, which CSS can't be
// exploited through the way script can. img-src allows https for OAuth
// avatars (GitHub/Google/any OIDC IdP host).
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'"],
      styleSrc:       ["'self'", "'unsafe-inline'"],
      imgSrc:         ["'self'", 'data:', 'https:'],
      connectSrc:     ["'self'"],
      objectSrc:      ["'none'"],
      baseUri:        ["'self'"],
      formAction:     ["'self'"],
      frameAncestors: ["'self'"],
    },
  },
}));

// ── Global rate limit ─────────────────────────────────────────
app.use(rateLimitGlobal);

// ── Body parser ───────────────────────────────────────────────
// Skip the Stripe webhook path — it verifies the signature against the raw
// request body (see routes/billing.js), which requires the bytes to reach
// its own express.raw() middleware untouched. Parsing JSON globally first
// would consume the stream and break signature verification on every call.
app.use((req, res, next) => {
  if (req.originalUrl === '/api/stripe/webhook') return next();
  express.json({ limit: '200kb' })(req, res, next);
});

// ── Postgres debug date — 30-second cached middleware ────────
app.use(createDebugDateMiddleware());

// ── requireSubscription middleware ───────────────────────────
function requireSubscription(req, res, next) {
  if (!stripeConfigured || isSingleUserMode()) return next();
  const u = req.user;
  if (!u) return next();
  if (u.is_admin)       return next();
  if (u.complimentary)  return next();
  const status = u.subscription_status || 'trialing';
  if (status === 'active') return next();
  if (status === 'trialing') {
    if (!u.trial_ends_at) return next();
    if (u.trial_ends_at >= getTodayStr()) return next();
  }
  if (req.path.startsWith('/api/')) {
    return res.status(402).json({
      error:   'subscription_required',
      message: 'Your trial has ended. Please subscribe to continue using taskpapr.',
    });
  }
  return res.redirect('/pricing');
}

// ── Public routes (before requireAuth) ───────────────────────
// Favicon — the static middleware mounts behind requireAuth, so public pages
// (/login, /pricing) need this served explicitly or logged-out visitors get
// a redirect instead of an icon.
app.get('/favicon.svg', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'favicon.svg')));

// Page scripts — served before requireAuth because /login and /pricing load
// theirs while logged out. Nothing under /js is secret (the repo is public).
app.use('/js', express.static(path.join(__dirname, 'public', 'js')));

// Brand icons — same reasoning as /js: /login and /pricing reference
// /icons/mark.svg while logged out. Nothing under /icons is secret.
app.use('/icons', express.static(path.join(__dirname, 'public', 'icons')));

// Pricing pages — expired-trial users must reach /pricing
app.get('/pricing', (req, res) => {
  if (req.query.ref && req.session) req.session.pending_ref = req.query.ref;
  res.sendFile(path.join(__dirname, 'public', 'pricing.html'));
});
app.get('/pricing/success',  (_req, res) => res.sendFile(path.join(__dirname, 'public', 'pricing-success.html')));
app.get('/pricing/canceled', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'pricing-canceled.html')));

// Auth providers endpoint — consumed by login.html to show/hide OAuth buttons
app.get('/api/auth-providers', (_req, res) => {
  res.json({
    github: !!(process.env.GITHUB_CLIENT_ID  && process.env.GITHUB_CLIENT_SECRET),
    google: !!(process.env.GOOGLE_CLIENT_ID  && process.env.GOOGLE_CLIENT_SECRET),
    oidc:   !!(process.env.OIDC_ISSUER       && process.env.OIDC_CLIENT_ID && process.env.OIDC_CLIENT_SECRET),
  });
});

// API key auth populates req.user from Bearer token before session auth
app.use(apiKeyAuth);

// Public webhook routes (no session — must be before requireAuth)
billing.registerPublic(app);
telegram.registerPublic(app);

// ── Start (async because OIDC discovery is async) ─────────────
async function start() {
  await setupAuth(app);

  setupAuthRoutes(app, async (user) => {
    const fresh    = await queries.users.byId.get(user.id) || user;
    const todayStr = getTodayStr();
    let trialDaysLeft = null;
    if (fresh.subscription_status === 'trialing' && fresh.trial_ends_at) {
      const msLeft = new Date(fresh.trial_ends_at + 'T23:59:59Z') - new Date(todayStr + 'T00:00:00Z');
      trialDaysLeft = Math.max(0, Math.ceil(msLeft / 86400000));
    }
    return {
      single_user:           isSingleUserMode(),
      debug_date:            getDebugDate() || null,
      telegram_chat_id:      fresh.telegram_chat_id      || process.env.TELEGRAM_CHAT_ID || null,
      telegram_capture_tile: fresh.telegram_capture_tile || null,
      stripe_configured:     stripeConfigured,
      subscription_status:   fresh.subscription_status   || 'trialing',
      subscription_tier:     fresh.subscription_tier     || null,
      trial_ends_at:         fresh.trial_ends_at         || null,
      trial_days_left:       trialDaysLeft,
      has_billing_account:   !!fresh.stripe_customer_id,
    };
  });

  // Rate-limit auth redirect endpoints (auth module applies its own limiter too)
  app.use('/auth/github', rateLimitAuth);
  app.use('/auth/google', rateLimitAuth);
  app.use('/auth/oidc',   rateLimitAuth);

  // Login page (public — served before requireAuth)
  app.get('/login', (req, res) => {
    if (req.isAuthenticated()) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
  });

  // ── Health check (unauthenticated) ──────────────────────────
  // Liveness only — no DB round-trip. Render polls this path continuously
  // for the life of every running instance, well under Neon's 5-minute
  // scale-to-zero idle timeout, so a per-request SELECT 1 here keeps the
  // database compute permanently active instead of suspending (Neon's own
  // cost-optimization guide flags exactly this pattern). A DB blip should
  // surface through real request errors, not through the liveness probe.
  app.get('/health', (req, res) => {
    res.json({ ok: true, uptime: process.uptime() });
  });

  // ── Auth + subscription gate ────────────────────────────────
  app.use(requireAuth);
  app.use(requireSubscription);
  app.use(express.static(path.join(__dirname, 'public')));

  // ── SSE — real-time change notifications ───────────────────
  // Long-lived GET connection; server pushes `data: change\n\n` after every write.
  // Uses session auth (cookie) — no Bearer token needed for browser clients.
  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable nginx/Traefik response buffering
    res.flushHeaders();
    res.write(': connected\n\n');

    const uid       = req.user.id;
    addConnection(uid, res);

    const heartbeat = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch (_) { /* disconnected */ }
    }, 30_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      removeConnection(uid, res);
    });
  });

  // ── Protected routes ────────────────────────────────────────
  taskRoutes(app);
  columnRoutes(app);
  goalRoutes(app);
  bookmarkRoutes(app);
  billing.registerAuth(app);
  adminRoutes(app);
  telegram.registerAuth(app);
  webhookRoutes(app);
  exportRoutes(app);

  // ── Global error handler ────────────────────────────────────
  // express-async-errors forwards unhandled async rejections here.
  app.use((err, req, res, _next) => {
    console.error('[error]', err);
    res.status(500).json({ error: 'internal_server_error' });
  });

  // ── Start listening ─────────────────────────────────────────
  const server = app.listen(PORT, () => {
    console.log(`taskpapr running at http://localhost:${PORT}`);
    scheduleDailyNotifications();

    // Wake dormant tasks on startup, then hourly
    // (Postgres: single replica via advisory lock)
    // Must catch: an unhandled rejection here (e.g. DB briefly down during the
    // hourly tick) would terminate the whole process.
    const runDormancySweep = () => {
      withSchedulerLock(async () => {
        await refreshPostgresJobDebugDate();
        await wakeDormantTasks();
      }).catch(err => console.error('[dormant] sweep failed:', err));
    };

    runDormancySweep();
    const dormancyInterval = setInterval(runDormancySweep, 60 * 60 * 1000);

    function shutdown() {
      clearInterval(dormancyInterval);
      server.close(() => {
        if (pool) pool.end().then(() => process.exit(0)).catch(() => process.exit(1));
        else process.exit(0);
      });
    }
    process.on('SIGTERM', shutdown);
    process.on('SIGINT',  shutdown);
  });
}

start().catch(err => {
  console.error('[startup] Fatal error:', err);
  process.exit(1);
});
