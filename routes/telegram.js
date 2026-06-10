'use strict';

const { randomBytes }                              = require('crypto');
const { queries, queryOne, queryRun }              = require('../db');
const { LIMITS, asTrimmedString, checkQuota, escapeHtml } = require('../lib/helpers');
const { checkDueTasks, sendTelegram }              = require('../services/notifications');
const { requireAuth, requireAdmin }                = require('../auth');

// ── Helpers ────────────────────────────────────────────────────

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0/I/1 lookalikes
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[randomBytes(1)[0] % chars.length];
  return code;
}

// ── Public routes (must be registered before requireAuth) ──────

function registerPublic(app) {
  // POST /api/telegram/webhook — Telegram Bot API webhook
  // Telegram servers POST updates here. No session or API key is present.
  // Auth is handled by TELEGRAM_WEBHOOK_SECRET header validation (optional but recommended).
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
    const text   = msg.text.trim();
    const chatId = String(msg.chat.id);

    // ── /start <CODE> — account linking ─────────────────────────
    const startMatch = text.match(/^\/start\s+([A-Z0-9]{6})$/i);
    if (startMatch) {
      const code  = startMatch[1].toUpperCase();
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
      const linkedUser  = await queries.users.byId.get(userId);
      const displayName = linkedUser?.display_name || linkedUser?.email || 'user';
      console.log('[telegram/webhook] linked chat to user', { chatId, userId, displayName });
      sendTelegram(`✅ Connected! Daily task reminders will now be sent to this chat.\n\nThis is your taskpapr account: ${escapeHtml(displayName)}\n\n<i>Tip: send me any message to add it as a task in your Inbox tile. Use <b>TileName: task title</b> to send to a specific tile.</i>`, chatId);
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
    let taskTitle      = text;
    const prefixMatch  = text.match(/^([^:\n]{1,50}):\s+(.+)$/s);
    if (prefixMatch) {
      targetTileName = prefixMatch[1].trim();
      taskTitle      = prefixMatch[2].trim();
    }

    // Find tile by case-insensitive partial name match (same as /api/webhook)
    const allCols   = await queries.columns.all.all(knownUser.id);
    let captureTile = allCols.find(c => c.name.toLowerCase().includes(targetTileName.toLowerCase()));

    if (!captureTile) {
      if (prefixMatch) {
        // User named a tile that doesn't exist — tell them
        sendTelegram(
          `❌ Tile not found: "<b>${escapeHtml(targetTileName)}</b>"\n\nAvailable tiles:\n${allCols.map(c => `• ${escapeHtml(c.name)}`).join('\n')}`,
          chatId
        );
        return;
      }
      // Default capture tile doesn't exist → auto-create it
      const defaultName = knownUser.telegram_capture_tile || 'Inbox';
      const info        = await queries.columns.insert.run(knownUser.id, defaultName, knownUser.id, 40, 40, 260, null);
      captureTile       = await queries.columns.byId.get(info.id, knownUser.id);
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
    sendTelegram(`✅ Added to <b>${escapeHtml(captureTile.name)}</b>: ${escapeHtml(taskTitle)}`, chatId);
  });
}

// ── Protected routes (registered after requireAuth) ────────────

function registerAuth(app) {
  // POST /api/telegram/connect — generate a link code for the calling user
  // Pending codes in `telegram_link_codes` (DB) so HA load balancers can route
  // connect vs webhook to different instances.
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

  // Update Telegram capture tile preference
  app.patch('/api/users/me/telegram-capture-tile', requireAuth, async (req, res) => {
    const tile = asTrimmedString(req.body.capture_tile) || null;
    await queryRun('UPDATE users SET telegram_capture_tile = ? WHERE id = ?', [tile, req.user.id]);
    res.json({ ok: true, telegram_capture_tile: tile });
  });

  // POST /api/telegram/test — send a test notification to the calling user's chat
  app.post('/api/telegram/test', requireAuth, async (req, res) => {
    const result = await checkDueTasks({ testMode: true, userId: req.user.id });
    res.json(result);
  });

  // Keep legacy admin path as alias so existing admin.html JS still works
  app.post('/api/admin/telegram/test', requireAdmin, async (req, res) => {
    const result = await checkDueTasks({ testMode: true, userId: req.user.id });
    res.json(result);
  });
}

module.exports = { registerPublic, registerAuth };
