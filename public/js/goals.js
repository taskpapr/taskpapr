async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
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

let goals = [];
let taskCounts = {};

async function loadData() {
  try {
    const [fetchedGoals, tasks] = await Promise.all([
      api('GET', '/api/goals'),
      api('GET', '/api/tasks'),
    ]);
    goals = fetchedGoals;
    taskCounts = {};
    tasks.forEach(t => {
      if (t.goal_id) taskCounts[t.goal_id] = (taskCounts[t.goal_id] || 0) + 1;
    });
    renderGoals();
  } catch (err) {
    const list = document.getElementById('goals-list');
    list.textContent = '';
    const p = document.createElement('p');
    p.style.color = 'var(--danger)';
    p.style.fontSize = '13px';
    p.style.padding = '12px 0';
    p.textContent = `Error loading goals: ${err.message}`;
    list.appendChild(p);
  }
}

function renderGoals() {
  const list = document.getElementById('goals-list');
  if (goals.length === 0) {
    list.innerHTML = '<p class="empty">No goals yet. Add one below.</p>';
    return;
  }
  list.innerHTML = '';
  goals.forEach(goal => {
    const count = taskCounts[goal.id] || 0;
    const item = document.createElement('div');
    item.className = 'list-item';
    item.innerHTML = `
      <span class="goal-name">${escHtml(goal.title)}</span>
      <span class="task-count${count === 0 ? ' zero' : ''}" title="${count} task${count !== 1 ? 's' : ''} linked">
        ${count} task${count !== 1 ? 's' : ''}
      </span>
      <button class="btn-danger" data-id="${goal.id}" data-name="${escHtml(goal.title)}">✕</button>
    `;
    // addEventListener instead of an inline onclick attribute — injected
    // inline handlers are blocked under CSP script-src 'self'.
    item.querySelector('.btn-danger').addEventListener('click', e => deleteGoal(e.currentTarget));
    list.appendChild(item);
  });
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function paprConfirm(message, { okLabel = 'OK', danger = false } = {}) {
  return new Promise(resolve => {
    const backdrop = document.createElement('div');
    backdrop.className = 'taskpapr-dialog-backdrop';
    backdrop.innerHTML = `
      <div class="taskpapr-dialog" role="dialog" aria-modal="true">
        <p>${message}</p>
        <div class="taskpapr-dialog-btns">
          <button class="btn-cancel">Cancel</button>
          <button class="${danger ? 'btn-danger' : 'btn-ok'}">${okLabel}</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    const [cancelBtn, okBtn] = backdrop.querySelectorAll('button');
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

async function deleteGoal(btn) {
  const id   = parseInt(btn.dataset.id);
  const name = btn.dataset.name;
  const count = taskCounts[id] || 0;
  const msg = count > 0
    ? `Delete goal "${name}"? It is linked to ${count} task${count !== 1 ? 's' : ''} (those tasks will have no goal).`
    : `Delete goal "${name}"?`;
  const ok = await paprConfirm(msg, { okLabel: 'Delete', danger: true });
  if (!ok) return;
  try {
    await api('DELETE', `/api/goals/${id}`);
    goals = goals.filter(g => g.id !== id);
    delete taskCounts[id];
    renderGoals();
    toast('Goal deleted');
  } catch (err) {
    toast('Error: ' + err.message);
  }
}

document.getElementById('add-goal-form').addEventListener('submit', async e => {
  e.preventDefault();
  const input = document.getElementById('new-goal-input');
  const title = input.value.trim();
  if (!title) return;
  try {
    const goal = await api('POST', '/api/goals', { title });
    goals.push(goal);
    renderGoals();
    input.value = '';
    input.focus();
    toast('Goal added');
  } catch (err) {
    toast('Error: ' + err.message);
  }
});

async function loadMe() {
  try {
    const me = await api('GET', '/api/me');
    if (me.is_admin) document.getElementById('admin-link').style.display = '';
    if (me.single_user) document.getElementById('logout-btn').style.display = 'none';
  } catch (_) {}
}

loadMe();
loadData();
