'use strict';

const path = require('path');
const { queries, queryOne, queryRun } = require('../db');
const { asTrimmedString, asLowerTrimmedString } = require('../lib/helpers');
const { setDebugDate } = require('../lib/date');
const { requireAuth, requireAdmin, generateApiKey } = require('../auth');

module.exports = function register(app) {

  app.get('/api/admin/registration-status', requireAdmin, async (req, res) => {
    const { _isWhitelistRequired } = require('../auth');
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

  // API key management lives at /api/keys (below) — one canonical route for
  // all users, scoped to their own keys. The old /api/admin/api-keys trio was
  // an exact duplicate and is gone (Design Tenet 3).

  // Admin UI page
  app.get('/admin', requireAdmin, async (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
  });

  // Settings page — any authenticated user
  app.get('/goals', requireAuth, async (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'goals.html'));
  });

  app.get('/settings', requireAuth, async (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'settings.html'));
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

};
