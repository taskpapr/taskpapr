// ── Custom dialog helpers ────────────────────────────────────
function paprConfirm(message, { okLabel = 'OK', danger = false } = {}) {
  return new Promise(resolve => {
    const backdrop = document.createElement('div');
    backdrop.className = 'taskpapr-dialog-backdrop';

    const dialog = document.createElement('div');
    dialog.className = 'taskpapr-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');

    const p = document.createElement('p');
    p.textContent = String(message);

    const btnRow = document.createElement('div');
    btnRow.className = 'taskpapr-dialog-btns';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-cancel';
    cancelBtn.textContent = 'Cancel';

    const okBtn = document.createElement('button');
    okBtn.className = danger ? 'btn-danger' : 'btn-ok';
    okBtn.textContent = String(okLabel);

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(okBtn);

    dialog.appendChild(p);
    dialog.appendChild(btnRow);
    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);
    const close = r => { backdrop.remove(); resolve(r); };
    cancelBtn.addEventListener('click', () => close(false));
    okBtn.addEventListener('click',     () => close(true));
    backdrop.addEventListener('click', e => { if (e.target === backdrop) close(false); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { document.removeEventListener('keydown', esc); close(false); }
    });
    okBtn.focus();
  });
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}

// Show Admin link + hide logout in single-user mode; init Telegram state
async function loadMe() {
  try {
    const me = await api('GET', '/api/me');
    if (me.is_admin) document.getElementById('admin-link').style.display = '';
    if (me.single_user) document.getElementById('logout-btn').style.display = 'none';
    setTelegramState(me.telegram_chat_id || null, me.telegram_capture_tile || null);
    renderSubscriptionPanel(me);
  } catch (_) {}
}

// ── Subscription panel ────────────────────────────────────────
function renderSubscriptionPanel(me) {
  // Only show when Stripe is configured and not in single-user mode
  if (!me.stripe_configured || me.single_user) return;

  const panel = document.getElementById('subscription-panel');
  const body  = document.getElementById('subscription-body');
  panel.style.display = '';

  const status = me.subscription_status || 'trialing';
  const tier   = me.subscription_tier   || null;
  const days   = me.trial_days_left;
  const hasBilling = me.has_billing_account;

  function getSafeRedirectUrl(url) {
    if (!url || typeof url !== 'string') return null;
    let u;
    try {
      u = new URL(url, location.origin);
    } catch (_) {
      return null;
    }
    if (u.origin === location.origin) return u.href;
    if (u.protocol === 'https:' && (u.hostname === 'stripe.com' || u.hostname.endsWith('.stripe.com'))) return u.href;
    return null;
  }

  body.textContent = '';
  const row = document.createElement('div');
  row.style.display = 'flex';
  row.style.alignItems = 'center';
  row.style.gap = '12px';
  row.style.flexWrap = 'wrap';

  const statusEl = document.createElement('span');
  statusEl.style.fontSize = '13px';
  statusEl.style.fontWeight = '600';

  const linkBtn = (href, text) => {
    const a = document.createElement('a');
    a.href = href;
    a.className = 'btn btn-primary';
    a.style.fontSize = '12px';
    a.style.padding = '5px 14px';
    a.textContent = text;
    return a;
  };

  const portalButton = (text) => {
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    btn.id = 'billing-portal-btn';
    btn.style.fontSize = '12px';
    btn.style.padding = '5px 12px';
    btn.textContent = text;
    return btn;
  };

  const portalStatus = document.createElement('span');
  portalStatus.id = 'billing-portal-status';
  portalStatus.style.fontSize = '12px';
  portalStatus.style.color = 'var(--ink-faint)';

  if (status === 'active') {
    const tierLabel = tier === 'solo' ? 'Solo plan' : (tier || 'Active');
    statusEl.style.color = '#065f46';
    statusEl.textContent = `✓ ${tierLabel}`;
    row.appendChild(statusEl);
    if (hasBilling) {
      row.style.gap = '16px';
      row.appendChild(portalButton('Manage subscription →'));
      row.appendChild(portalStatus);
    }
  } else if (status === 'trialing') {
    const expired = days !== null && days <= 0;
    if (expired) {
      statusEl.style.color = '#b91c1c';
      statusEl.textContent = 'Trial ended';
      row.appendChild(statusEl);
      row.appendChild(linkBtn('/pricing', 'Subscribe →'));
    } else {
      statusEl.style.color = 'var(--ink)';
      statusEl.textContent = 'Free trial';
      row.appendChild(statusEl);
      const info = document.createElement('span');
      info.style.fontSize = '12px';
      info.style.color = 'var(--ink-mid)';
      const daysText = days !== null ? `${days} day${days !== 1 ? 's' : ''} remaining` : 'Free trial active';
      info.textContent = daysText;
      row.appendChild(info);
      row.appendChild(linkBtn('/pricing', 'Upgrade →'));
    }
  } else if (status === 'past_due') {
    statusEl.style.color = '#b91c1c';
    statusEl.textContent = '⚠ Payment failed';
    row.appendChild(statusEl);
    const info = document.createElement('span');
    info.style.fontSize = '12px';
    info.style.color = 'var(--ink-mid)';
    info.textContent = 'Please update your payment method to keep access.';
    row.appendChild(info);
    if (hasBilling) {
      row.appendChild(portalButton('Update payment →'));
      row.appendChild(portalStatus);
    } else {
      row.appendChild(linkBtn('/pricing', 'Renew →'));
    }
  } else if (status === 'canceled') {
    statusEl.style.color = 'var(--ink-mid)';
    statusEl.style.fontWeight = '500';
    statusEl.textContent = 'Subscription canceled';
    row.appendChild(statusEl);
    row.appendChild(linkBtn('/pricing', 'Resubscribe →'));
  }

  body.appendChild(row);

  // Wire up billing portal button if present
  const portalBtn = document.getElementById('billing-portal-btn');
  if (portalBtn) {
    portalBtn.addEventListener('click', async () => {
      const statusEl = document.getElementById('billing-portal-status');
      const originalText = portalBtn.textContent;
      portalBtn.disabled = true;
      portalBtn.textContent = 'Redirecting…';
      try {
        const r = await api('GET', '/api/billing/portal');
        const safeUrl = getSafeRedirectUrl(r.url);
        if (safeUrl) location.href = safeUrl;
        else throw new Error('Unsafe redirect URL');
      } catch (err) {
        if (statusEl) statusEl.textContent = 'Error: ' + err.message;
        portalBtn.disabled = false;
        portalBtn.textContent = originalText;
      }
    });
  }
}

// ── Export ───────────────────────────────────────────────────
document.getElementById('export-btn').addEventListener('click', async () => {
  const statusEl = document.getElementById('export-status');
  try {
    statusEl.textContent = 'Preparing…';
    const res = await fetch('/api/export');
    if (!res.ok) throw new Error(await res.text());
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    const cd   = res.headers.get('Content-Disposition') || '';
    const fnMatch = cd.match(/filename="([^"]+)"/);
    a.download = fnMatch ? fnMatch[1] : 'taskpapr-export.json';
    a.href = url;
    a.click();
    URL.revokeObjectURL(url);
    statusEl.textContent = `Downloaded ${a.download}`;
    setTimeout(() => statusEl.textContent = '', 4000);
  } catch (err) {
    statusEl.textContent = 'Export failed: ' + err.message;
    statusEl.style.color = 'var(--danger)';
  }
});

// ── Import ───────────────────────────────────────────────────
document.getElementById('import-btn').addEventListener('click', async () => {
  const fileEl   = document.getElementById('import-file');
  const statusEl = document.getElementById('import-status');
  const mode     = document.querySelector('input[name="import-mode"]:checked').value;

  if (!fileEl.files.length) {
    statusEl.textContent = 'Please select a file first.';
    statusEl.style.color = 'var(--danger)';
    return;
  }
  if (mode === 'replace') {
    const ok = await paprConfirm('Replace mode will DELETE all existing tiles, tasks, and goals, then load the file. Are you sure?', { okLabel: 'Replace everything', danger: true });
    if (!ok) return;
  }
  statusEl.textContent = 'Importing…';
  statusEl.style.color = 'var(--ink-mid)';
  try {
    const text = await fileEl.files[0].text();
    const data = JSON.parse(text);
    const res  = await fetch(`/api/import?mode=${mode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || res.statusText);
    const { imported } = result;
    statusEl.style.color = '#2d6a1e';
    statusEl.textContent =
      `✓ Imported ${imported.goals} goal${imported.goals !== 1 ? 's' : ''}, ` +
      `${imported.tiles} tile${imported.tiles !== 1 ? 's' : ''}, ` +
      `${imported.tasks} task${imported.tasks !== 1 ? 's' : ''}` +
      (imported.skipped ? ` (${imported.skipped} skipped)` : '');
    fileEl.value = '';
    toast(`Import complete — ${imported.tasks} tasks loaded`);
  } catch (err) {
    statusEl.style.color = 'var(--danger)';
    statusEl.textContent = 'Import failed: ' + err.message;
  }
});

// ── API Keys ─────────────────────────────────────────────────
async function loadApiKeys() {
  const keys = await api('GET', '/api/keys');
  const el = document.getElementById('apikeys-list');
  el.textContent = '';
  if (!keys.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'No API keys yet.';
    el.appendChild(p);
    return;
  }

  for (const k of keys) {
    const row = document.createElement('div');
    row.className = 'list-item';
    row.dataset.id = String(k.id);

    const main = document.createElement('div');
    main.className = 'main';

    const strong = document.createElement('strong');
    strong.textContent = String(k.name || '');

    const prefix = document.createElement('span');
    prefix.className = 'key-prefix';
    prefix.textContent = String(k.key_prefix || '');

    const sub = document.createElement('div');
    sub.className = 'sub';
    const created = k.created_at ? String(k.created_at).slice(0, 10) : '';
    const used = k.last_used_at ? String(k.last_used_at).slice(0, 10) : null;
    sub.textContent = `Created ${created}${used ? ` · Last used ${used}` : ' · Never used'}`;

    main.appendChild(strong);
    main.appendChild(document.createTextNode(' '));
    main.appendChild(prefix);
    main.appendChild(sub);

    const btn = document.createElement('button');
    btn.className = 'btn btn-danger';
    btn.textContent = 'Revoke';
    btn.addEventListener('click', () => revokeApiKey(k.id, k.name));

    row.appendChild(main);
    row.appendChild(btn);
    el.appendChild(row);
  }
}

async function revokeApiKey(id, name) {
  const ok = await paprConfirm(`Revoke key "${name}"? Any clients using it will immediately lose access.`, { okLabel: 'Revoke', danger: true });
  if (!ok) return;
  await api('DELETE', `/api/keys/${id}`);
  toast('Key revoked');
  document.getElementById('apikeys-reveal').textContent = '';
  loadApiKeys();
}

document.getElementById('add-apikey-form').addEventListener('submit', async e => {
  e.preventDefault();
  const name = document.getElementById('ak-name').value.trim();
  try {
    const result = await api('POST', '/api/keys', { name });
    document.getElementById('ak-name').value = '';
    const revealEl = document.getElementById('apikeys-reveal');
    revealEl.textContent = '';
    const wrap = document.createElement('div');
    wrap.className = 'key-reveal';
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = '⚠️ Copy this key now — it will not be shown again';
    const raw = document.createElement('div');
    raw.id = 'raw-key';
    raw.textContent = String(result.key || '');
    wrap.appendChild(label);
    wrap.appendChild(raw);
    revealEl.appendChild(wrap);

    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn btn-primary';
    copyBtn.style.marginBottom = '12px';
    copyBtn.textContent = 'Copy key';
    copyBtn.addEventListener('click', () => copyKey(result.key));
    revealEl.appendChild(copyBtn);
    toast('Key created — copy it now!');
    loadApiKeys();
  } catch (err) {
    toast('Error: ' + err.message);
  }
});

function copyKey(key) {
  navigator.clipboard.writeText(key).then(() => toast('Copied to clipboard'));
}

// ── Telegram self-service flow ────────────────────────────────
// State machine: disconnected ↔ pending ↔ connected
// Polling: every 3s while pending, stops on connect or cancel.

let tgPollTimer    = null;
let tgCountdownInt = null;
let tgExpiresAt    = null; // ms timestamp

function setTelegramState(chatId, captureTile) {
  const disconnected = document.getElementById('tg-state-disconnected');
  const connected    = document.getElementById('tg-state-connected');
  const pending      = document.getElementById('tg-pending');

  if (chatId) {
    disconnected.style.display = 'none';
    connected.style.display    = '';
    document.getElementById('tg-connected-chat-id').textContent = 'chat id: ' + chatId;
    // Populate capture tile input (blank = default "Inbox")
    const captureInput = document.getElementById('tg-capture-tile-input');
    if (captureInput) captureInput.value = captureTile || '';
    stopTgPoll();
  } else {
    disconnected.style.display = '';
    connected.style.display    = 'none';
    pending.style.display      = 'none';
  }
}

function stopTgPoll() {
  if (tgPollTimer)    { clearInterval(tgPollTimer);    tgPollTimer    = null; }
  if (tgCountdownInt) { clearInterval(tgCountdownInt); tgCountdownInt = null; }
}

// Start the connect flow: request a code, show instructions, begin polling
document.getElementById('tg-connect-btn').addEventListener('click', async () => {
  const statusEl = document.getElementById('tg-connect-status');
  statusEl.textContent = 'Generating code…';
  try {
    const r = await api('POST', '/api/telegram/connect', {});
    statusEl.textContent = '';

    // Populate UI
    const botName    = r.bot_username ? '@' + r.bot_username : 'the bot';
    const startCmd   = `/start ${r.code}`;
    document.getElementById('tg-bot-name').textContent    = botName;
    document.getElementById('tg-start-cmd').textContent   = startCmd;
    document.getElementById('tg-pending').style.display   = '';
    document.getElementById('tg-poll-status').textContent = 'Waiting for you to send the message…';

    // Countdown timer
    tgExpiresAt = Date.now() + r.expires_in_seconds * 1000;
    stopTgPoll();

    tgCountdownInt = setInterval(() => {
      const remaining = Math.max(0, Math.round((tgExpiresAt - Date.now()) / 1000));
      const m = Math.floor(remaining / 60);
      const s = remaining % 60;
      document.getElementById('tg-countdown').textContent =
        remaining > 0 ? `Code expires in ${m}:${String(s).padStart(2, '0')}` : 'Code expired';
      if (remaining === 0) stopTgPoll();
    }, 1000);

    // Poll /api/me every 3s to detect when chat ID has been linked
    tgPollTimer = setInterval(async () => {
      if (Date.now() >= tgExpiresAt) { stopTgPoll(); return; }
      try {
        const me = await api('GET', '/api/me');
        if (me.telegram_chat_id) {
          stopTgPoll();
          setTelegramState(me.telegram_chat_id, me.telegram_capture_tile || null);
          toast('✓ Telegram connected!');
        }
      } catch (_) { /* ignore poll errors */ }
    }, 3000);

  } catch (err) {
    statusEl.style.color = 'var(--danger)';
    statusEl.textContent = 'Error: ' + err.message;
  }
});

// Cancel the pending flow
document.getElementById('tg-cancel-btn').addEventListener('click', () => {
  stopTgPoll();
  document.getElementById('tg-pending').style.display      = 'none';
  document.getElementById('tg-connect-status').textContent = '';
  document.getElementById('tg-poll-status').textContent    = '';
});

// Disconnect
document.getElementById('tg-disconnect-btn').addEventListener('click', async () => {
  const ok = await paprConfirm('Disconnect Telegram? You will stop receiving daily notifications.', { okLabel: 'Disconnect', danger: true });
  if (!ok) return;
  try {
    await api('DELETE', '/api/telegram/disconnect');
    setTelegramState(null);
    toast('Telegram disconnected');
  } catch (err) {
    toast('Error: ' + err.message);
  }
});

// Test notification
document.getElementById('tg-test-btn').addEventListener('click', async () => {
  const resultEl  = document.getElementById('tg-test-result');
  const messageEl = document.getElementById('tg-test-message');
  resultEl.textContent = 'Sending…';
  messageEl.style.display = 'none';
  try {
    const r = await api('POST', '/api/telegram/test', {});
    if (r.sent) {
      resultEl.style.color = '#2d6a1e';
      resultEl.textContent = '✓ Sent!';
      messageEl.style.display = 'block';
      messageEl.style.background = '#f0f7e8';
      messageEl.style.border = '1px solid #b7d9a0';
      messageEl.style.color = '#2d6a1e';
      messageEl.textContent = 'Message sent:\n' + (r.message || '').replace(/<[^>]+>/g, '');
    } else {
      resultEl.style.color = 'var(--ink-mid)';
      resultEl.textContent = 'Nothing to send';
      messageEl.style.display = 'block';
      messageEl.style.background = '#fef9e7';
      messageEl.style.border = '1px solid #fcd34d';
      messageEl.style.color = '#92400e';
      messageEl.textContent = r.note || 'No tasks due today or tomorrow with this date setting.';
    }
    setTimeout(() => resultEl.textContent = '', 5000);
  } catch (err) {
    resultEl.style.color = 'var(--danger)';
    resultEl.textContent = 'Error: ' + err.message;
  }
});

// Capture tile save
document.getElementById('tg-capture-tile-save').addEventListener('click', async () => {
  const input    = document.getElementById('tg-capture-tile-input');
  const statusEl = document.getElementById('tg-capture-tile-status');
  const val      = input.value.trim() || null;
  statusEl.textContent = 'Saving…';
  statusEl.style.color = 'var(--ink-faint)';
  try {
    await api('PATCH', '/api/users/me/telegram-capture-tile', { capture_tile: val });
    statusEl.style.color = '#2d6a1e';
    statusEl.textContent = '✓ Saved';
    toast('Capture tile updated');
    setTimeout(() => { statusEl.textContent = ''; }, 3000);
  } catch (err) {
    statusEl.style.color = 'var(--danger)';
    statusEl.textContent = 'Save failed: ' + err.message;
  }
});

// Allow Enter key in capture tile input to save
document.getElementById('tg-capture-tile-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); document.getElementById('tg-capture-tile-save').click(); }
});

// ── Referral panel ───────────────────────────────────────────
async function loadReferralPanel() {
  let stats;
  try { stats = await api('GET', '/api/referral/stats'); }
  catch (_) { return; } // endpoint absent (old server) — hide panel silently

  const panel = document.getElementById('referral-panel');
  const body  = document.getElementById('referral-body');
  panel.style.display = '';

  const link = stats.referral_link || '';
  body.textContent = '';

  const p = document.createElement('p');
  p.style.fontSize = '13px';
  p.style.color = 'var(--ink-mid)';
  p.style.marginBottom = '14px';
  p.appendChild(document.createTextNode('Share your unique link. Each friend who signs up via your link gets a '));
  const strong1 = document.createElement('strong');
  strong1.textContent = '30-day free trial';
  p.appendChild(strong1);
  p.appendChild(document.createTextNode(' instead of the default 14 days. When they subscribe, you earn '));
  const strong2 = document.createElement('strong');
  strong2.textContent = '1 month free';
  p.appendChild(strong2);
  p.appendChild(document.createTextNode(' as a credit on your next invoice.'));
  body.appendChild(p);

  const linkRow = document.createElement('div');
  linkRow.style.display = 'flex';
  linkRow.style.gap = '8px';
  linkRow.style.alignItems = 'center';
  linkRow.style.marginBottom = '16px';
  linkRow.style.flexWrap = 'wrap';

  const input = document.createElement('input');
  input.id = 'referral-link-input';
  input.readOnly = true;
  input.value = link;
  input.style.flex = '1';
  input.style.minWidth = '200px';
  input.style.border = '1px solid var(--border)';
  input.style.borderRadius = 'var(--radius)';
  input.style.padding = '6px 10px';
  input.style.fontSize = '13px';
  input.style.fontFamily = "'SFMono-Regular',Menlo,monospace";
  input.style.background = '#f9f9f9';
  input.style.color = 'var(--ink)';
  input.style.outline = 'none';
  input.style.cursor = 'text';
  input.addEventListener('click', () => input.select());

  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn btn-primary';
  copyBtn.id = 'copy-referral-btn';
  copyBtn.style.whiteSpace = 'nowrap';
  copyBtn.textContent = 'Copy link';

  linkRow.appendChild(input);
  linkRow.appendChild(copyBtn);
  body.appendChild(linkRow);

  const statsRow = document.createElement('div');
  statsRow.style.display = 'flex';
  statsRow.style.gap = '24px';
  statsRow.style.flexWrap = 'wrap';

  const stat = (value, label, color) => {
    const box = document.createElement('div');
    box.style.textAlign = 'center';
    const v = document.createElement('div');
    v.style.fontSize = '22px';
    v.style.fontWeight = '700';
    v.style.color = color || 'var(--ink)';
    v.textContent = String(value ?? 0);
    const l = document.createElement('div');
    l.style.fontSize = '11px';
    l.style.color = 'var(--ink-faint)';
    l.style.textTransform = 'uppercase';
    l.style.letterSpacing = '0.4px';
    l.textContent = label;
    box.appendChild(v);
    box.appendChild(l);
    return box;
  };

  statsRow.appendChild(stat(stats.total_referred, 'Friends referred'));
  statsRow.appendChild(stat(stats.total_converted, 'Converted to paid'));
  statsRow.appendChild(stat(stats.months_earned, 'Months earned', '#2d6a1e'));
  body.appendChild(statsRow);

  document.getElementById('copy-referral-btn').addEventListener('click', () => {
    navigator.clipboard.writeText(link).then(() => toast('Referral link copied!'));
  });
}

loadMe();
loadApiKeys();
loadReferralPanel();
