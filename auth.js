/**
 * taskpapr — auth.js
 * Passport.js GitHub OAuth + SQLite session store
 */

const passport       = require('passport');
const GitHubStrategy = require('passport-github2').Strategy;
const OidcStrategy   = require('passport-openidconnect');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session        = require('express-session');
const rateLimit      = require('express-rate-limit');
const { Store }      = require('express-session');
const crypto         = require('crypto');
const { queries, seedDefaultTiles, queryRun, queryOne } = require('./db');

// Auth routes are also rate-limited in server.js, but we apply an explicit limiter
// here so static analyzers (and future refactors) can't miss the protection.
const authRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_AUTH || '20'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts — please slow down.' },
});

// ── Trial end date helper ─────────────────────────────────────
// Sets trial_ends_at = today + 14 days for a newly created user.
// Only writes the date if Stripe is configured (STRIPE_SECRET_KEY set) AND
// the column doesn't already have a value — safe to call multiple times.
async function setTrialEndDate(userId, extraDays = 0) {
  if (!process.env.STRIPE_SECRET_KEY) return; // self-hosted — no trial needed
  const user = await queries.users.byId.get(userId);
  if (!user || user.trial_ends_at) return; // already set
  const trialEnd = new Date();
  trialEnd.setUTCDate(trialEnd.getUTCDate() + 14 + extraDays);
  const trialEndStr = trialEnd.toISOString().slice(0, 10);
  await queryRun('UPDATE users SET trial_ends_at = ? WHERE id = ?', [trialEndStr, userId]);
}

// Generate a short unique referral code for a user, e.g. "james-x7k2"
// Falls back to a random code if display_name is absent or too short.
async function generateReferralCode(userId) {
  const user = await queries.users.byId.get(userId);
  const base = (user?.display_name || user?.email || 'user')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 10) || 'user';

  const suffix = () => Math.random().toString(36).slice(2, 6);
  // Try up to 5 times to find a unique code
  for (let i = 0; i < 5; i++) {
    const code = `${base}-${suffix()}`;
    const existing = await queryOne('SELECT id FROM users WHERE referral_code = ?', [code]);
    if (!existing) {
      await queryRun('UPDATE users SET referral_code = ? WHERE id = ?', [code, userId]);
      return code;
    }
  }
  // Ultimate fallback: userId-based
  const code = `user${userId}-${suffix()}`;
  await queryRun('UPDATE users SET referral_code = ? WHERE id = ?', [code, userId]);
  return code;
}

// Apply a referral: link referee to referrer, extend trial by 16 days (30 total)
// Called after new user creation when a pending ref code is in the session.
async function applyReferral(refereeId, refCode) {
  const referrer = await queryOne('SELECT * FROM users WHERE referral_code = ?', [refCode]);
  if (!referrer) return; // code not found — silent no-op
  if (referrer.id === refereeId) return; // can't refer yourself

  // Check not already referred
  const already = await queryOne('SELECT id FROM referrals WHERE referee_id = ?', [refereeId]);
  if (already) return;

  await queryRun('UPDATE users SET referred_by_user_id = ? WHERE id = ?', [referrer.id, refereeId]);
  await queryRun(
    'INSERT INTO referrals (referrer_id, referee_id, code_used) VALUES (?, ?, ?)',
    [referrer.id, refereeId, refCode]
  );
  // Extend trial from 14 → 30 days (add 16 extra days)
  const referee = await queries.users.byId.get(refereeId);
  if (referee && referee.trial_ends_at) {
    // Already set — extend it by 16 days
    const current = new Date(referee.trial_ends_at + 'T00:00:00Z');
    current.setUTCDate(current.getUTCDate() + 16);
    await queryRun('UPDATE users SET trial_ends_at = ? WHERE id = ?', [current.toISOString().slice(0, 10), refereeId]);
  }
  // If not yet set, it will be set with 30 days by setTrialEndDate(id, 16)
  console.log(`[referral] user ${refereeId} referred by user ${referrer.id} (code: ${refCode})`);
}

// ============================================================
// Strategy registration tracking
// ============================================================
let _oidcRegistered   = false;
let _githubRegistered = false;
let _googleRegistered = false;

// ============================================================
// Custom SQLite session store (uses node:sqlite — no native deps)
// ============================================================
class SQLiteStore extends Store {
  constructor(options = {}) {
    super(options);
    this.ttl = options.ttl || 86400; // seconds — default 1 day
    // Prune expired sessions every 15 minutes
    setInterval(() => {
      queries.sessions.prune.run(Date.now()).catch(() => {});
    }, 15 * 60 * 1000).unref();
  }

  get(sid, cb) {
    queries.sessions.get.get(sid, Date.now())
      .then(row => {
        if (!row) return cb(null, null);
        try { cb(null, JSON.parse(row.sess)); } catch { cb(null, null); }
      })
      .catch(err => cb(err));
  }

  set(sid, sess, cb) {
    const maxAge  = sess.cookie?.maxAge || this.ttl * 1000;
    const expired = Date.now() + maxAge;
    queries.sessions.set.run(sid, JSON.stringify(sess), expired)
      .then(() => cb(null))
      .catch(err => cb(err));
  }

  destroy(sid, cb) {
    queries.sessions.destroy.run(sid)
      .then(() => cb(null))
      .catch(err => cb(err));
  }

  touch(sid, sess, cb) {
    const maxAge  = sess.cookie?.maxAge || this.ttl * 1000;
    const expired = Date.now() + maxAge;
    queries.sessions.touch.run(expired, sid)
      .then(() => cb(null))
      .catch(err => cb(err));
  }
}

// ============================================================
// Passport serialisation
// ============================================================
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
  queries.users.byId.get(id)
    .then(user => done(null, user || false))
    .catch(err => done(err));
});

// ============================================================
// Open registration helper
// ============================================================
// Returns true if whitelist enforcement is active.
// Whitelist is OFF (open registration) when:
//   - REQUIRE_WHITELIST=false explicitly, OR
//   - STRIPE_SECRET_KEY is set AND REQUIRE_WHITELIST is not explicitly 'true'
// Whitelist is ON (default) for all self-hosted installs without Stripe.
function isWhitelistRequired() {
  const explicit = process.env.REQUIRE_WHITELIST;
  if (explicit === 'false') return false;
  if (explicit === 'true')  return true;
  // Auto-disable when Stripe is configured (hosted SaaS)
  if (process.env.STRIPE_SECRET_KEY) return false;
  return true; // default: whitelist on
}

module.exports._isWhitelistRequired = isWhitelistRequired;

// ============================================================
// GitHub strategy
// ============================================================
function setupGitHubStrategy() {
  const clientID     = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  const callbackURL  = process.env.GITHUB_CALLBACK_URL || 'http://localhost:3033/auth/github/callback';

  if (!clientID || !clientSecret) {
    console.warn('[auth] GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET not set — GitHub login disabled');
    return;
  }

  passport.use('github', new GitHubStrategy(
    { clientID, clientSecret, callbackURL, scope: ['user:email'] },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const email = (profile.emails?.[0]?.value || '').toLowerCase().trim();

        // Check whitelist (skip if first user, or if open registration is on)
        const countRow = await queries.users.count.get();
        const userCount = countRow.c;
        if (userCount > 0 && isWhitelistRequired()) {
          if (!email) return done(null, false, { message: 'no_email' });
          const allowed = await queries.whitelist.byEmail.get(email);
          if (!allowed) return done(null, false, { message: 'not_invited' });
        }

        const isFirstUser = userCount === 0;
        let user = await queries.users.byProvider.get('github', String(profile.id));

        if (!user) {
          const info = await queries.users.insert.run(
            'github', String(profile.id), email || null,
            profile.displayName || profile.username || null,
            profile.photos?.[0]?.value || null,
            isFirstUser ? 1 : 0
          );
          user = await queries.users.byId.get(info.id);
          await seedDefaultTiles(user.id);
          await generateReferralCode(user.id);
          await setTrialEndDate(user.id);
        } else {
          await queries.users.updateLogin.run(
            email || user.email,
            profile.displayName || profile.username || user.display_name,
            profile.photos?.[0]?.value || user.avatar_url,
            user.id
          );
          user = await queries.users.byId.get(user.id);
        }

        if (isFirstUser && !user.is_admin) {
          await queries.users.setAdmin.run(user.id);
          user = await queries.users.byId.get(user.id);
        }

        done(null, user);
      } catch (err) {
        done(err);
      }
    }
  ));
  _githubRegistered = true;
}

// ============================================================
// Google OAuth strategy
// ============================================================
function setupGoogleStrategy() {
  const clientID     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const callbackURL  = process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3033/auth/google/callback';

  if (!clientID || !clientSecret) {
    console.warn('[auth] GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set — Google login disabled');
    return;
  }

  passport.use('google', new GoogleStrategy(
    { clientID, clientSecret, callbackURL },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const email = (profile.emails?.[0]?.value || '').toLowerCase().trim();

        // Check whitelist (skip if first user, or if open registration is on)
        const countRow = await queries.users.count.get();
        const userCount = countRow.c;
        if (userCount > 0 && isWhitelistRequired()) {
          if (!email) return done(null, false, { message: 'no_email' });
          const allowed = await queries.whitelist.byEmail.get(email);
          if (!allowed) return done(null, false, { message: 'not_invited' });
        }

        const isFirstUser = userCount === 0;
        let user = await queries.users.byProvider.get('google', String(profile.id));

        if (!user) {
          const info = await queries.users.insert.run(
            'google', String(profile.id), email || null,
            profile.displayName || null,
            profile.photos?.[0]?.value || null,
            isFirstUser ? 1 : 0
          );
          user = await queries.users.byId.get(info.id);
          await seedDefaultTiles(user.id);
          await generateReferralCode(user.id);
          await setTrialEndDate(user.id);
        } else {
          await queries.users.updateLogin.run(
            email || user.email,
            profile.displayName || user.display_name,
            profile.photos?.[0]?.value || user.avatar_url,
            user.id
          );
          user = await queries.users.byId.get(user.id);
        }

        if (isFirstUser && !user.is_admin) {
          await queries.users.setAdmin.run(user.id);
          user = await queries.users.byId.get(user.id);
        }

        done(null, user);
      } catch (err) {
        done(err);
      }
    }
  ));
  _googleRegistered = true;
  console.log('[auth] Google OAuth strategy registered');
}

// ============================================================
// OIDC strategy (Authentik / any standards-compliant IdP)
// ============================================================

// Fetch OIDC discovery document with retry+backoff.
// Retries up to `maxAttempts` times, waiting `baseDelayMs` * attempt before each retry.
async function fetchOidcDiscovery(discoveryUrl, maxAttempts = 4, baseDelayMs = 5000) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await fetch(discoveryUrl);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const doc = await resp.json();
      if (attempt > 1) console.log(`[auth] OIDC discovery succeeded on attempt ${attempt}`);
      return doc;
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        const wait = baseDelayMs * attempt;
        console.warn(`[auth] OIDC discovery attempt ${attempt}/${maxAttempts} failed (${err.message}) — retrying in ${wait / 1000}s`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

async function setupOidcStrategy() {
  const issuer       = process.env.OIDC_ISSUER;
  const clientID     = process.env.OIDC_CLIENT_ID;
  const clientSecret = process.env.OIDC_CLIENT_SECRET;
  const callbackURL  = process.env.OIDC_CALLBACK_URL || 'http://localhost:3033/auth/oidc/callback';
  // When true, skip whitelist for OIDC logins (your IdP is the trust boundary)
  const trustIdp     = process.env.OIDC_TRUST_IDP === 'true';

  if (!issuer || !clientID || !clientSecret) {
    console.warn('[auth] OIDC_ISSUER / OIDC_CLIENT_ID / OIDC_CLIENT_SECRET not set — SSO login disabled');
    return;
  }

  // passport-openidconnect does not auto-discover — fetch the OIDC discovery document
  const discoveryUrl = issuer.replace(/\/$/, '') + '/.well-known/openid-configuration';
  let discovery;
  try {
    discovery = await fetchOidcDiscovery(discoveryUrl);
    console.log('[auth] OIDC discovery loaded from', discoveryUrl);
  } catch (err) {
    console.error('[auth] Failed to fetch OIDC discovery document from', discoveryUrl, 'after all retries —', err.message);
    console.error('[auth] SSO login will be unavailable until next successful setup attempt');
    return;
  }

  passport.use('oidc', new OidcStrategy(
    {
      issuer,
      authorizationURL: discovery.authorization_endpoint,
      tokenURL:         discovery.token_endpoint,
      userInfoURL:      discovery.userinfo_endpoint,
      clientID,
      clientSecret,
      callbackURL,
      scope: 'openid email profile',
    },
    async (issuer, profile, done) => {
      try {
        const email = (
          profile.emails?.[0]?.value ||
          profile._json?.email ||
          ''
        ).toLowerCase().trim();

        const countRow = await queries.users.count.get();
        const userCount = countRow.c;
        const isFirstUser = userCount === 0;

        if (!isFirstUser && !trustIdp && isWhitelistRequired()) {
          if (!email) return done(null, false, { message: 'no_email' });
          const allowed = await queries.whitelist.byEmail.get(email);
          if (!allowed) return done(null, false, { message: 'not_invited' });
        }

        const providerId = profile.id || profile._json?.sub || String(profile.id);
        let user = await queries.users.byProvider.get('oidc', providerId);

        if (!user) {
          const info = await queries.users.insert.run(
            'oidc', providerId, email || null,
            profile.displayName || profile._json?.name || null,
            profile._json?.picture || null,
            isFirstUser ? 1 : 0
          );
          user = await queries.users.byId.get(info.id);
          await seedDefaultTiles(user.id);
          await generateReferralCode(user.id);
          await setTrialEndDate(user.id);
        } else {
          await queries.users.updateLogin.run(
            email || user.email,
            profile.displayName || profile._json?.name || user.display_name,
            profile._json?.picture || user.avatar_url,
            user.id
          );
          user = await queries.users.byId.get(user.id);
        }

        if (isFirstUser && !user.is_admin) {
          await queries.users.setAdmin.run(user.id);
          user = await queries.users.byId.get(user.id);
        }

        done(null, user);
      } catch (err) {
        done(err);
      }
    }
  ));
  _oidcRegistered = true;
}

// ============================================================
// Single-user mode detection
// ============================================================
function isSingleUserMode() {
  // Explicit override
  if (process.env.SINGLE_USER_MODE === 'true')  return true;
  if (process.env.SINGLE_USER_MODE === 'false') return false;
  // Auto-detect: no auth providers configured → single-user mode
  const hasGitHub = !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
  const hasGoogle = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  const hasOidc   = !!(process.env.OIDC_ISSUER && process.env.OIDC_CLIENT_ID && process.env.OIDC_CLIENT_SECRET);
  return !hasGitHub && !hasGoogle && !hasOidc;
}

// Ensure the local user exists in the DB (called on startup in single-user mode)
async function ensureLocalUser() {
  let user = await queries.users.byProvider.get('local', 'local');
  if (!user) {
    const info = await queries.users.insert.run('local', 'local', null, 'Local User', null, 1);
    user = await queries.users.byId.get(info.id);
    await seedDefaultTiles(user.id);
    console.log('[auth] Single-user mode: created local user (id=%d)', user.id);
  }
  return user;
}

// ============================================================
// Express middleware setup — call once in server.js (async)
// ============================================================
async function setupAuth(app) {
  if (isSingleUserMode()) {
    console.log('[auth] Single-user mode — auth disabled');
    const localUser = await ensureLocalUser();
    // Inject local user into every request — no session, no login
    app.use((req, _res, next) => { req.user = localUser; next(); });
    return;
  }

  setupGitHubStrategy();
  setupGoogleStrategy();
  await setupOidcStrategy();

  app.use(session({
    store:             new SQLiteStore({ ttl: 30 * 24 * 60 * 60 }), // 30 days
    secret:            process.env.SESSION_SECRET || 'dev-secret-change-me-in-production',
    resave:            false,
    saveUninitialized: false,
    name:              'taskpapr.sid',
    cookie: {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      maxAge:   30 * 24 * 60 * 60 * 1000, // 30 days
      sameSite: 'lax',
    },
  }));

  app.use(passport.initialize());
  app.use(passport.session());
}

// ============================================================
// Auth routes — attach to app in server.js
// ============================================================
function setupAuthRoutes(app, getMeExtra) {
  // getMeExtra(user) — optional callback returning extra fields to merge into /api/me
  const extra = getMeExtra || (() => ({}));

  // In single-user mode, minimal routes only
  if (isSingleUserMode()) {
    app.get('/login', (_req, res) => res.redirect('/'));
    app.post('/auth/logout', (_req, res) => res.redirect('/'));
    // /api/me still needed by frontend
    app.get('/api/me', async (req, res) => {
      const { id, display_name, avatar_url, email, is_admin } = req.user;
      const extraFields = await extra(req.user);
      res.json({ id, display_name, avatar_url, email, is_admin, single_user: true,
        version: require('./package.json').version, ...extraFields });
    });
    return;
  }

  // Google OAuth — only if strategy was successfully registered
  if (_googleRegistered) {
    app.get('/auth/google',
      authRateLimit,
      passport.authenticate('google', { scope: ['email', 'profile'] })
    );
    app.get('/auth/google/callback',
      authRateLimit,
      passport.authenticate('google', { failureRedirect: '/login?error=not_invited' }),
      async (req, res) => {
        if (req.session?.pending_ref && req.user) {
          await applyReferral(req.user.id, req.session.pending_ref).catch(() => {});
          delete req.session.pending_ref;
        }
        res.redirect('/');
      }
    );
  }

  // GitHub OAuth — only if strategy was successfully registered
  if (_githubRegistered) {
    app.get('/auth/github',
      authRateLimit,
      passport.authenticate('github', { scope: ['user:email'] })
    );
    app.get('/auth/github/callback',
      authRateLimit,
      passport.authenticate('github', { failureRedirect: '/login?error=not_invited' }),
      async (req, res) => {
        if (req.session?.pending_ref && req.user) {
          await applyReferral(req.user.id, req.session.pending_ref).catch(() => {});
          delete req.session.pending_ref;
        }
        res.redirect('/');
      }
    );
  }

  // OIDC (Authentik / generic SSO)
  if (process.env.OIDC_ISSUER) {
    // Self-healing: if discovery failed at startup, retry when the user actually
    // tries to sign in. If Authentik has recovered by then, this succeeds and
    // the strategy is registered on the spot — no restart needed.
    app.get('/auth/oidc', async (req, res, next) => {
      authRateLimit(req, res, async () => {
      if (!_oidcRegistered) {
        console.log('[auth] /auth/oidc hit but strategy not registered — attempting recovery…');
        await setupOidcStrategy();
      }
      if (_oidcRegistered) {
        passport.authenticate('oidc')(req, res, next);
      } else {
        res.status(503).send(
          'SSO is temporarily unavailable — the identity provider could not be reached. ' +
          'Please try again in a few minutes.'
        );
      }
      });
    });
    app.get('/auth/oidc/callback', (req, res, next) => {
      if (!_oidcRegistered) {
        return res.status(503).send('SSO temporarily unavailable.');
      }
      authRateLimit(req, res, () => passport.authenticate('oidc', { failureRedirect: '/login?error=not_invited' })(req, res, async () => {
        if (req.session?.pending_ref && req.user) {
          await applyReferral(req.user.id, req.session.pending_ref).catch(() => {});
          delete req.session.pending_ref;
        }
        res.redirect('/');
      }));
    });
  }

  // Logout
  app.post('/auth/logout', (req, res) => {
    req.logout(err => {
      if (err) console.error('[auth] logout error', err);
      res.redirect('/login');
    });
  });

  // Current user (for frontend)
  app.get('/api/me', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'not authenticated' });
    const { id, display_name, avatar_url, email, is_admin } = req.user;
    const extraFields = await extra(req.user);
    res.json({ id, display_name, avatar_url, email, is_admin,
      version: require('./package.json').version, ...extraFields });
  });
}

// ============================================================
// Auth guard middleware
// ============================================================
function requireAuth(req, res, next) {
  // Single-user mode: req.user is always set by the inject middleware
  if (req.user) return next();
  if (req.isAuthenticated()) return next();
  if (req.xhr || req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'not authenticated' });
  }
  res.redirect('/login');
}

function requireAdmin(req, res, next) {
  // Single-user mode: req.user is always the local admin
  if (req.user?.is_admin) return next();
  res.status(403).json({ error: 'admin only' });
}

// ============================================================
// API key helpers — used by server.js routes + middleware
// ============================================================

// Generate a new API key: returns { raw, hash, prefix }
// raw is shown to the user once; only hash is stored
function generateApiKey() {
  const raw    = 'tp_' + crypto.randomBytes(32).toString('hex');
  const hash   = crypto.createHash('sha256').update(raw).digest('hex');
  const prefix = raw.slice(0, 10) + '…';
  return { raw, hash, prefix };
}

// Middleware: resolve req.user from Bearer token if not already set by session
// Sets req.apiKeyAuthenticated = true when a valid key is used, so routes that
// require explicit key auth (e.g. /api/webhook) can enforce it even in single-user mode.
function apiKeyAuth(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) return next();

  const raw  = authHeader.slice(7).trim();
  const hash = crypto.createHash('sha256').update(raw).digest('hex');

  queries.apiKeys.byHash.get(hash).then(key => {
    if (!key) return next();
    return queries.users.byId.get(key.user_id).then(user => {
      if (!user) return next();
      // Update last_used_at (fire and forget — non-blocking)
      queries.apiKeys.touchUsed.run(key.id).catch(() => {});
      req.user                = user;
      req.apiKeyAuthenticated = true;
      next();
    });
  }).catch(() => next());
}

module.exports = { setupAuth, setupAuthRoutes, requireAuth, requireAdmin, generateApiKey, apiKeyAuth, isSingleUserMode, generateReferralCode, applyReferral, _isGoogleRegistered: () => _googleRegistered };
