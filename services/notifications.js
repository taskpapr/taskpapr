'use strict';
const { queries, queryOne, queryAll, upsertSetting, withSchedulerLock } = require('../db');
const { getTodayStr, getNow, getDebugDate, refreshPostgresJobDebugDate } = require('../lib/date');

// Sends a Telegram message via the Bot API (fire-and-forget, logs errors).
async function sendTelegram(text, chatId) {
  const token           = process.env.TELEGRAM_BOT_TOKEN;
  const resolvedChatId  = chatId || process.env.TELEGRAM_CHAT_ID;
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

// Check tasks due today/tomorrow for all users (or a single user in test mode).
// Options:
//   testMode: true  → send a synthetic ping; don't record last-sent
//   userId: N       → only check tasks for that user
async function checkDueTasks(opts = {}) {
  const { testMode = false, userId = null } = opts;
  const token = process.env.TELEGRAM_BOT_TOKEN;

  const todayStr    = getTodayStr();
  const tomorrowMs  = new Date(getNow());
  tomorrowMs.setUTCDate(tomorrowMs.getUTCDate() + 1);
  const tomorrowStr = tomorrowMs.toISOString().slice(0, 10);

  let recipients;
  if (userId !== null) {
    const u = await queries.users.byId.get(userId);
    const chatId = u?.telegram_chat_id || (testMode ? process.env.TELEGRAM_CHAT_ID : null);
    recipients = u ? [{ ...u, effective_chat_id: chatId }] : [];
  } else {
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
      results.push({ user_id: user.id, sent: false, note: 'TELEGRAM_BOT_TOKEN not set' });
      continue;
    }

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
      const testMsg = `✅ taskpapr Telegram is working!\n\n<i>This is a test notification from taskpapr settings.</i>`;
      await sendTelegram(testMsg, user.effective_chat_id);
      results.push({ user_id: user.id, sent: true, message: testMsg });
    } else {
      await sendTelegram(message, user.effective_chat_id);
      results.push({ user_id: user.id, sent: true, message });
    }
  }

  if (testMode && results.length === 1) return results[0];

  if (!testMode) {
    await upsertSetting('telegram_last_sent', getTodayStr());
  }

  return { sent: true, results };
}

// Schedule daily notification at a target hour (default 08:00 local time).
// Runs once shortly after startup, then every 24h aligned to the target hour.
function scheduleDailyNotifications() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log('[telegram] TELEGRAM_BOT_TOKEN not set — notifications disabled');
    return;
  }

  const targetHour = parseInt(process.env.TELEGRAM_NOTIFY_HOUR || '8', 10);

  function msUntilNextRun() {
    const now  = new Date();
    const next = new Date(now);
    next.setHours(targetHour, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next - now;
  }

  function scheduleNext() {
    const delay   = msUntilNextRun();
    const nextRun = new Date(Date.now() + delay);
    console.log(`[telegram] next notification scheduled for ${nextRun.toLocaleString()} (in ${Math.round(delay / 60000)} min)`);
    setTimeout(async () => {
      // Catch so a failed send neither crashes the process (unhandled
      // rejection) nor breaks the scheduling chain — scheduleNext() must
      // always run again.
      try {
        await withSchedulerLock(async () => {
          await refreshPostgresJobDebugDate();
          await checkDueTasks();
        });
      } catch (err) {
        console.error('[telegram] daily notification failed:', err);
      }
      scheduleNext();
    }, delay);
  }

  scheduleNext();

  // Startup check: fire if today's digest hasn't been sent yet and we're past the target hour.
  setTimeout(async () => {
    try {
      const todayStr  = getTodayStr();
      const lastSent  = await queryOne("SELECT value FROM settings WHERE key = 'telegram_last_sent'");
      const alreadySent  = lastSent?.value === todayStr;
      const currentHour  = new Date().getHours();

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
    } catch (err) {
      console.error('[telegram] startup digest check failed:', err);
    }
  }, 10_000);
}

module.exports = { sendTelegram, checkDueTasks, scheduleDailyNotifications };
