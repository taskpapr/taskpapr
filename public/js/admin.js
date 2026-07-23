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

async function loadRegistrationStatus() {
  const s = await api('GET', '/api/admin/registration-status');
  const el = document.getElementById('reg-status');
  const wlPanel = document.getElementById('whitelist-panel');
  el.textContent = '';
  const p = document.createElement('p');
  p.style.margin = '0';
  p.style.fontSize = '13px';

  if (s.open_registration) {
    const dot = document.createElement('span');
    dot.style.color = '#059669';
    dot.style.fontWeight = '700';
    dot.textContent = '● Open registration';
    p.appendChild(dot);
    p.appendChild(document.createTextNode(` — anyone can sign up with GitHub${s.oidc_trust_idp ? ' or SSO' : ''}.`));
    if (!s.require_whitelist_env) {
      const auto = document.createElement('span');
      auto.style.color = 'var(--ink-mid)';
      auto.style.marginLeft = '8px';
      auto.textContent = '(auto — STRIPE_SECRET_KEY is set)';
      p.appendChild(document.createTextNode(' '));
      p.appendChild(auto);
    }
    wlPanel.style.display = 'none';
  } else {
    const lock = document.createElement('span');
    lock.style.fontWeight = '700';
    lock.textContent = '🔒 Whitelist-only';
    p.appendChild(lock);
    p.appendChild(document.createTextNode(' — only pre-approved emails can sign up. '));
    const hint = document.createElement('span');
    hint.style.color = 'var(--ink-mid)';
    hint.style.marginLeft = '8px';
    hint.textContent = 'Set REQUIRE_WHITELIST=false to open registration.';
    p.appendChild(hint);
    wlPanel.style.display = '';
  }

  el.appendChild(p);
}

async function loadWhitelist() {
  const items = await api('GET', '/api/admin/whitelist');
  const el = document.getElementById('whitelist-list');
  el.textContent = '';
  if (!items.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'No emails added yet.';
    el.appendChild(p);
    return;
  }

  for (const w of items) {
    const row = document.createElement('div');
    row.className = 'list-item';
    row.dataset.id = String(w.id);

    const main = document.createElement('div');
    main.className = 'main';

    const emailText = document.createTextNode(String(w.email || ''));
    main.appendChild(emailText);

    if (w.note) {
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = String(w.note);
      main.appendChild(sub);
    }

    const btn = document.createElement('button');
    btn.className = 'btn btn-danger';
    btn.textContent = 'Remove';
    btn.addEventListener('click', () => removeWhitelist(w.id));

    row.appendChild(main);
    row.appendChild(btn);
    el.appendChild(row);
  }
}

async function loadUsers() {
  const users = await api('GET', '/api/admin/users');
  const el = document.getElementById('users-list');
  el.textContent = '';
  if (!users.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'No users yet.';
    el.appendChild(p);
    return;
  }

  for (const u of users) {
    const row = document.createElement('div');
    row.className = 'list-item';

    if (u.avatar_url) {
      const img = document.createElement('img');
      img.className = 'avatar';
      img.alt = '';
      img.src = String(u.avatar_url);
      row.appendChild(img);
    }

    const main = document.createElement('div');
    main.className = 'main';

    const name = (u.display_name || u.email || 'Unknown');
    main.appendChild(document.createTextNode(String(name)));

    if (u.is_admin) {
      const badge = document.createElement('span');
      badge.className = 'badge admin';
      badge.textContent = 'admin';
      main.appendChild(document.createTextNode(' '));
      main.appendChild(badge);
    }

    if (u.complimentary) {
      const badge = document.createElement('span');
      badge.className = 'badge comp';
      badge.textContent = '✓ comp';
      main.appendChild(document.createTextNode(' '));
      main.appendChild(badge);
    }

    const sub = document.createElement('div');
    sub.className = 'sub';
    const email = u.email || '';
    const provider = u.provider || '';
    const lastLogin = u.last_login_at ? String(u.last_login_at).slice(0, 10) : '';
    sub.textContent = `${email} · via ${provider} · last login ${lastLogin}`;
    main.appendChild(sub);

    row.appendChild(main);

    if (!u.is_admin) {
      const btn = document.createElement('button');
      btn.className = `btn btn-sm ${u.complimentary ? 'btn-danger' : 'btn-secondary'}`;
      btn.textContent = u.complimentary ? '✗ Revoke' : '✓ Comp';
      btn.title = u.complimentary
        ? 'Revoke complimentary access'
        : 'Grant complimentary (lifetime free) access';
      btn.addEventListener('click', () => toggleComplimentary(u.id, !u.complimentary));
      row.appendChild(btn);
    }

    el.appendChild(row);
  }
}

async function toggleComplimentary(userId, grant) {
  try {
    await api('PATCH', `/api/admin/users/${userId}/complimentary`, { complimentary: grant });
    toast(grant ? '✓ Complimentary access granted' : 'Complimentary access revoked');
    loadUsers();
  } catch (err) {
    toast('Error: ' + err.message);
  }
}

async function removeWhitelist(id) {
  await api('DELETE', `/api/admin/whitelist/${id}`);
  toast('Removed from whitelist');
  loadWhitelist();
}

document.getElementById('add-whitelist-form').addEventListener('submit', async e => {
  e.preventDefault();
  const email = document.getElementById('wl-email').value.trim();
  try {
    await api('POST', '/api/admin/whitelist', { email });
    document.getElementById('wl-email').value = '';
    toast('Added to whitelist');
    loadWhitelist();
  } catch (err) {
    toast(err.message.includes('409') ? 'Already whitelisted' : 'Error: ' + err.message);
  }
});

// ── Debug date ────────────────────────────────────────────────
async function loadDebugDate() {
  try {
    const me = await api('GET', '/api/me');
    if (me.debug_date) {
      document.getElementById('debug-date-input').value = me.debug_date;
      document.getElementById('debug-status').textContent = `Active: date override is ${me.debug_date}`;
      document.getElementById('debug-status').style.color = '#92400e';
    }
  } catch (_) {}
}

document.getElementById('debug-set-btn').addEventListener('click', async () => {
  const date = document.getElementById('debug-date-input').value;
  const statusEl = document.getElementById('debug-status');
  if (!date) { statusEl.textContent = 'Pick a date first.'; return; }
  try {
    await api('POST', '/api/admin/debug/date', { date });
    statusEl.style.color = '#92400e';
    statusEl.textContent = `✓ Date override set to ${date}. Reload the board to see the effect.`;
    toast('Debug date set to ' + date);
  } catch (err) {
    statusEl.style.color = 'var(--danger)';
    statusEl.textContent = 'Error: ' + err.message;
  }
});

document.getElementById('debug-clear-btn').addEventListener('click', async () => {
  const statusEl = document.getElementById('debug-status');
  try {
    await fetch('/api/admin/debug/date', { method: 'DELETE' });
    document.getElementById('debug-date-input').value = '';
    statusEl.style.color = 'var(--ink-mid)';
    statusEl.textContent = '✓ Date override cleared — using real system date.';
    toast('Debug date cleared');
  } catch (err) {
    statusEl.style.color = 'var(--danger)';
    statusEl.textContent = 'Error: ' + err.message;
  }
});

loadRegistrationStatus();
loadWhitelist();
loadUsers();
loadDebugDate();
