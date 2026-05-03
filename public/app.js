/* ============================================================
   taskpapr — app.js (canvas edition)
   Infinite pan/zoom whiteboard with draggable columns
   ============================================================ */

// ── State ────────────────────────────────────────────────────
let state = {
  columns:   [],
  tasks:     [],
  goals:     [],
  bookmarks: [],
  user:      null,
  showDormantForCol: new Set(), // column IDs where dormant tasks are temporarily revealed
  showHiddenTiles:   false,     // board-level toggle for hidden (parked) tiles
  showGoalTiles:     false,     // board-level toggle for goal smart-tiles
  goalTilePositions: {},        // goalId → {x, y} — session positions for goal tiles
  showTodayTile:     false,     // toggle for floating Today smart-tile
};

// ── Colour palette for tasks ─────────────────────────────────
const TASK_COLOURS = [
  { value: null,      label: 'None' },
  { value: '#fff0f0', label: 'Red tint' },
  { value: '#fff8e8', label: 'Amber' },
  { value: '#fffde8', label: 'Yellow' },
  { value: '#f0fff4', label: 'Mint' },
  { value: '#e8f4fd', label: 'Sky' },
  { value: '#f0e8ff', label: 'Lavender' },
  { value: '#fde8f0', label: 'Rose' },
  { value: '#e8ede8', label: 'Sage' },
];

// ── Colour palette for tiles ─────────────────────────────────
const TILE_COLOURS = [
  { value: null,      label: 'None' },
  { value: '#fef9e7', label: 'Cream' },
  { value: '#fce4d6', label: 'Peach' },
  { value: '#fde8f0', label: 'Rose' },
  { value: '#e8f4fd', label: 'Sky' },
  { value: '#e8f8e8', label: 'Mint' },
  { value: '#f0e8ff', label: 'Lavender' },
  { value: '#fff0cc', label: 'Honey' },
  { value: '#e0ede0', label: 'Sage' },
  { value: '#f5e6d3', label: 'Sand' },
];

// ── Canvas / viewport state ──────────────────────────────────
const view = {
  panX: 40,
  panY: 40,
  zoom: 1,
  MIN_ZOOM: 0.25,
  MAX_ZOOM: 2.5,
};

// Z-index manager — clicking any tile brings it to front
let zTop = 10;
function bringToFront(colEl) {
  zTop++;
  colEl.style.zIndex = zTop;
}

const canvas   = document.getElementById('board-canvas');
const viewport = document.getElementById('board-viewport');

// ── View-state persistence (localStorage) ────────────────────
// Saves pan, zoom, and layer toggles so refreshing or navigating away and
// back doesn't lose the user's position. Per-device intentionally — correct
// behaviour (a 27" zoom level shouldn't follow you to a 13" laptop).

const VIEW_STATE_KEY = 'taskpapr:viewState';
let   viewSaveTimer  = null;

function saveViewState() {
  clearTimeout(viewSaveTimer);
  viewSaveTimer = setTimeout(() => {
    try {
      localStorage.setItem(VIEW_STATE_KEY, JSON.stringify({
        panX:              view.panX,
        panY:              view.panY,
        zoom:              view.zoom,
        showGoalTiles:     state.showGoalTiles,
        showHiddenTiles:   state.showHiddenTiles,
        goalTilePositions: state.goalTilePositions,
      }));
    } catch (_) { /* storage quota exceeded or private mode — silently ignore */ }
  }, 300);
}

function restoreViewState() {
  try {
    const raw = localStorage.getItem(VIEW_STATE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (typeof saved.panX  === 'number') view.panX = saved.panX;
    if (typeof saved.panY  === 'number') view.panY = saved.panY;
    if (typeof saved.zoom  === 'number') view.zoom = Math.max(view.MIN_ZOOM, Math.min(view.MAX_ZOOM, saved.zoom));
    if (saved.showGoalTiles)   state.showGoalTiles   = true;
    if (saved.showHiddenTiles) state.showHiddenTiles = true;
    if (saved.goalTilePositions && typeof saved.goalTilePositions === 'object') {
      // Convert keys back to integers (JSON stringify turns object keys to strings)
      Object.entries(saved.goalTilePositions).forEach(([k, v]) => {
        if (v && typeof v.x === 'number' && typeof v.y === 'number') {
          state.goalTilePositions[parseInt(k)] = v;
        }
      });
    }
  } catch (_) { /* corrupt storage — silently ignore */ }
}

function applyTransform() {
  canvas.style.transform = `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`;
  document.getElementById('zoom-label').textContent = Math.round(view.zoom * 100) + '%';
  saveViewState();
  updateOffscreenIndicators();
}

// ── Off-screen content beacons ────────────────────────────────
// Shows directional pill indicators when tiles exist outside the visible
// viewport area. Clicking navigates to the nearest off-screen tile in that
// direction (by Euclidean distance from viewport centre in canvas space).

function getVisibleTileBounds() {
  // Returns array of { canvasCx, canvasCy } (centre of each currently visible tile)
  const tiles = [];

  // Regular columns (shown + hidden-when-toggled)
  state.columns.forEach(col => {
    if (col.hidden && !state.showHiddenTiles) return;
    const el = canvas.querySelector(`.column[data-col-id="${col.id}"]`);
    const h = el ? el.offsetHeight : 300;
    const w = col.width || 260;
    const s = col.scale || 1;
    tiles.push({
      canvasX: col.x || 0,
      canvasY: col.y || 0,
      // Visual footprint on canvas is scaled: w*s × h*s
      w: w * s,
      h: h * s,
      canvasCx: (col.x || 0) + (w * s) / 2,
      canvasCy: (col.y || 0) + (h * s) / 2,
    });
  });

  // Goal smart-tiles (shown when toggled)
  if (state.showGoalTiles) {
    // Mirror the same auto-position fallback used by renderGoalTiles() so that
    // goal tiles which have never been dragged (no saved position) still
    // contribute to beacon counts.
    const allCols = state.columns;
    const baseY = allCols.length > 0
      ? Math.max(...allCols.map(c => (c.y || 0) + 340)) + 40
      : 40;
    const TILE_W = 260;
    const GAP    = 30;

    state.goals.forEach((goal, idx) => {
      const saved = state.goalTilePositions[goal.id];
      const x = saved ? saved.x : 40 + idx * (TILE_W + GAP);
      const y = saved ? saved.y : baseY;

      // Try to read the actual rendered height from the DOM; fall back to estimate
      const goalEls = canvas.querySelectorAll('.column--goal');
      let h = 200;
      goalEls.forEach(ge => {
        const titleEl = ge.querySelector('.column-title');
        if (titleEl && titleEl.textContent === goal.title) h = ge.offsetHeight;
      });
      const w = TILE_W;
      tiles.push({
        canvasX: x,
        canvasY: y,
        w,
        h,
        canvasCx: x + w / 2,
        canvasCy: y + h / 2,
      });
    });
  }

  return tiles;
}

function updateOffscreenIndicators() {
  const vpRect = viewport.getBoundingClientRect();
  const vpW = vpRect.width;
  const vpH = vpRect.height;

  const tiles = getVisibleTileBounds();

  // Classify each tile: is it fully off-screen in a given direction?
  const counts = { top: 0, bottom: 0, left: 0, right: 0 };

  tiles.forEach(t => {
    const left   = t.canvasX * view.zoom + view.panX;
    const top    = t.canvasY * view.zoom + view.panY;
    const right  = left + t.w * view.zoom;
    const bottom = top  + t.h * view.zoom;

    if (right  < 0)   counts.left++;
    if (left   > vpW) counts.right++;
    if (bottom < 0)   counts.top++;
    if (top    > vpH) counts.bottom++;
  });

  ['top', 'bottom', 'left', 'right'].forEach(dir => {
    const el = document.getElementById(`beacon-${dir}`);
    if (!el) return;
    const countEl = el.querySelector('.beacon-count');
    if (counts[dir] > 0) {
      el.classList.remove('beacon-hidden');
      if (countEl) countEl.textContent = counts[dir] > 1 ? counts[dir] : '';
    } else {
      el.classList.add('beacon-hidden');
    }
  });
}

function panToNearestOffscreen(dir) {
  const vpRect = viewport.getBoundingClientRect();
  const vpW = vpRect.width;
  const vpH = vpRect.height;

  const tiles = getVisibleTileBounds();

  // Current viewport centre in canvas space
  const vcx = (vpW / 2 - view.panX) / view.zoom;
  const vcy = (vpH / 2 - view.panY) / view.zoom;

  // Filter to tiles that are fully off-screen in the requested direction
  const candidates = tiles.filter(t => {
    const left   = t.canvasX * view.zoom + view.panX;
    const top    = t.canvasY * view.zoom + view.panY;
    const right  = left + t.w * view.zoom;
    const bottom = top  + t.h * view.zoom;
    if (dir === 'left')   return right  < 0;
    if (dir === 'right')  return left   > vpW;
    if (dir === 'top')    return bottom < 0;
    if (dir === 'bottom') return top    > vpH;
    return false;
  });

  if (candidates.length === 0) return;

  // Find nearest by Euclidean distance from current viewport centre
  const nearest = candidates.reduce((best, t) => {
    const dx = t.canvasCx - vcx;
    const dy = t.canvasCy - vcy;
    const dist = dx * dx + dy * dy;
    return dist < best.dist ? { t, dist } : best;
  }, { t: candidates[0], dist: Infinity }).t;

  // Pan so the nearest tile's centre lands at viewport centre
  view.panX = vpW / 2 - nearest.canvasCx * view.zoom;
  view.panY = vpH / 2 - nearest.canvasCy * view.zoom;
  applyTransform();
}

// Wire up beacon click handlers (run once at boot)
function bindBeaconEvents() {
  ['top', 'bottom', 'left', 'right'].forEach(dir => {
    const el = document.getElementById(`beacon-${dir}`);
    if (el) el.addEventListener('click', () => panToNearestOffscreen(dir));
  });
}

// ── API helpers ──────────────────────────────────────────────
async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

const get   = p      => api('GET',    p);
const post  = (p, b) => api('POST',   p, b);
const patch = (p, b) => api('PATCH',  p, b);
const del   = p      => api('DELETE', p);

// ── Bootstrap ────────────────────────────────────────────────
async function init() {
  const [columns, tasks, goals, user, bookmarks] = await Promise.all([
    get('/api/columns'),
    get('/api/tasks'),
    get('/api/goals'),
    get('/api/me'),
    get('/api/bookmarks'),
  ]);
  state.columns   = columns;
  state.tasks     = tasks;
  state.goals     = goals;
  state.user      = user;
  state.bookmarks = bookmarks;

  restoreViewState();

  // Record when data was first loaded so the sync stamp can show "just now"
  lastSyncedAt = Date.now();

  renderUser();
  renderDebugPill();
  renderHiddenTileButton();
  updateGoalsButton();
  renderBoard();
  applyTransform();
  bindCanvasEvents();
  bindGlobalEvents();
  bindZoomControls();
  bindBeaconEvents();
  bindUserMenuEvents();
  bindBookmarkEvents();
  renderBookmarkList();
  updateSyncStamp();
  startSyncStampTicker();
}

// ── User menu (bound once at boot) ───────────────────────────
// Must NOT be inside renderUser() — that function is called on every poll
// refresh, which would pile up duplicate listeners and cause the menu to
// open-and-immediately-close after a few polling cycles.
function bindUserMenuEvents() {
  const trigger = document.getElementById('user-trigger');
  if (!trigger) return;
  trigger.addEventListener('click', e => {
    e.stopPropagation();
    document.getElementById('user-dropdown').classList.toggle('hidden');
  });
  document.addEventListener('click', () => {
    document.getElementById('user-dropdown').classList.add('hidden');
  });
}

// ── User avatar / menu ────────────────────────────────────────
function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function renderUser() {
  const u = state.user;
  if (!u) return;

  // Version badge
  const verEl = document.getElementById('app-version');
  if (verEl && u.version) verEl.textContent = 'v' + u.version;

  // Avatar / initials
  const avatar   = document.getElementById('user-avatar');
  const initials = document.getElementById('user-initials');
  const nameLabel = document.getElementById('user-display-name');
  const nameEl   = document.getElementById('user-name');
  const adminLink = document.getElementById('admin-link');
  const logoutForm = document.getElementById('logout-form');

  const displayName = u.display_name || u.email || 'You';
  nameLabel.textContent = displayName;
  nameEl.textContent    = displayName;

  if (u.avatar_url) {
    avatar.src   = u.avatar_url;
    avatar.alt   = displayName;
    avatar.style.display = 'block';
    initials.style.display = 'none';
    // Hide initials if avatar fails to load
    avatar.addEventListener('error', () => {
      avatar.style.display = 'none';
      initials.style.display = 'flex';
      initials.textContent = getInitials(displayName);
    }, { once: true });
  } else {
    avatar.style.display   = 'none';
    initials.style.display = 'flex';
    initials.textContent   = getInitials(displayName);
  }

  if (u.is_admin) adminLink.classList.remove('hidden');

  // In single-user mode, hide sign-out (there's no session to end)
  if (u.single_user && logoutForm) logoutForm.style.display = 'none';

  // ── Trial countdown ───────────────────────────────────────
  // Non-intrusive one-liner in the user dropdown.
  // Only shown when Stripe is configured AND the user is on a trial.
  // Consistent with DESIGN.md tenet 6 (no noise) — no banners, no popups.
  const trialEl = document.getElementById('trial-countdown');
  if (trialEl) {
    const status = u.subscription_status || 'trialing';
    if (u.stripe_configured && status === 'trialing' && !u.single_user) {
      const days = u.trial_days_left;
      let html = '';
      if (days === null || days === undefined) {
        // No expiry set — no countdown needed
      } else if (days <= 0) {
        html = `<span style="color:#b91c1c">Trial ended</span> · <a href="/pricing" style="color:#2c5f8a;font-weight:600">Upgrade →</a>`;
      } else if (days <= 3) {
        html = `<span style="color:#b45309">Trial: ${days}d left</span> · <a href="/pricing" style="color:#2c5f8a;font-weight:600">Upgrade →</a>`;
      } else {
        html = `Trial: ${days}d left · <a href="/pricing" style="color:#2c5f8a">Upgrade →</a>`;
      }
      if (html) {
        trialEl.innerHTML = html;
        trialEl.style.display = '';
      } else {
        trialEl.style.display = 'none';
      }
    } else if (u.stripe_configured && status === 'past_due' && !u.single_user) {
      trialEl.innerHTML = `<span style="color:#b91c1c">Payment failed</span> · <a href="/pricing" style="color:#2c5f8a;font-weight:600">Update card →</a>`;
      trialEl.style.display = '';
    } else {
      trialEl.style.display = 'none';
    }
  }

  // Note: user menu click events are bound once at boot in bindUserMenuEvents()
  // — do NOT add event listeners here, as renderUser() is called on every poll
  // refresh and would accumulate duplicate listeners causing the menu to
  // open-and-immediately-close after the first few polling cycles.
}

// ── Rendering ────────────────────────────────────────────────

function syncGoalsButton() {
  const btn = document.getElementById('btn-goals');
  if (!btn) return;
  btn.classList.toggle('active', state.showGoalTiles);
}

// ── Today button sync ────────────────────────────────────────
function syncTodayButton() {
  const btn     = document.getElementById('btn-today');
  const countEl = document.getElementById('today-task-count');
  if (!btn) return;
  const flagged = state.tasks.filter(t => t.today_flag && t.status !== 'done').length;
  // Always visible — count badge shown when tasks are flagged, empty otherwise
  countEl.textContent = flagged > 0 ? flagged : '';
  btn.classList.toggle('active', state.showTodayTile);
  // Note: we deliberately do NOT auto-close the tile when flagged === 0 here.
  // If the user explicitly opened it and there are no tasks, the empty state
  // message is the honest, correct response (Design Tenet 5).
  // Auto-close is handled in toggleDone() when the last flagged task completes.
}

function renderBoard() {
  // Re-render all columns in place (preserve existing DOM elements for smooth UX)
  const existing = new Map();
  canvas.querySelectorAll('.column:not(.column--goal)').forEach(el => {
    existing.set(parseInt(el.dataset.colId), el);
  });

  const seen = new Set();
  state.columns.forEach(col => {
    // Hidden tiles are only rendered when the board-level toggle is on
    if (col.hidden && !state.showHiddenTiles) {
      seen.add(col.id); // mark as seen so we don't remove the element prematurely
      const el = existing.get(col.id);
      if (el) el.style.display = 'none';
      return;
    }

    seen.add(col.id);
    let el = existing.get(col.id);
    if (!el) {
      el = buildColumn(col);
      canvas.appendChild(el);
    } else {
      el.style.display = '';
      refreshColumn(el, col);
    }
    // Mark hidden tiles with CSS class
    el.classList.toggle('column--hidden', !!col.hidden);
    // Always update position
    el.style.left = col.x + 'px';
    el.style.top  = col.y + 'px';
  });

  // Remove columns that no longer exist
  existing.forEach((el, id) => {
    if (!seen.has(id)) el.remove();
  });

  // Render / remove goal smart-tiles
  renderGoalTiles();

  // Update off-screen navigation beacons
  updateOffscreenIndicators();

  // Keep header buttons in sync with state
  syncGoalsButton();
  syncTodayButton();
  renderHiddenTileButton();
  if (state.showTodayTile) renderTodayTile();
}

// ── Goal smart-tiles ─────────────────────────────────────────

function renderGoalTiles() {
  // Remove all existing goal tiles first (they're always fully rebuilt)
  canvas.querySelectorAll('.column--goal').forEach(el => el.remove());

  if (!state.showGoalTiles || state.goals.length === 0) return;

  // Compute a baseline Y below ALL columns (visible or not) so goal tiles
  // don't jump when hidden-tile visibility is toggled
  const allCols = state.columns;
  const baseY = allCols.length > 0
    ? Math.max(...allCols.map(c => (c.y || 0) + 340)) + 40
    : 40;

  const TILE_W = 260;
  const GAP    = 30;

  state.goals.forEach((goal, idx) => {
    // Reuse saved position if the user has dragged this tile; default to auto-row
    const saved = state.goalTilePositions[goal.id];
    const x = saved ? saved.x : 40 + idx * (TILE_W + GAP);
    const y = saved ? saved.y : baseY;
    const el = buildGoalTile(goal, x, y, TILE_W);
    canvas.appendChild(el);
  });
}

function buildGoalTile(goal, x, y, width) {
  const linkedTasks = state.tasks
    .filter(t => t.goal_id === goal.id && t.status !== 'dormant')
    .sort((a, b) => {
      const order = { wip: 0, active: 1, done: 2 };
      return (order[a.status] ?? 3) - (order[b.status] ?? 3) || a.position - b.position;
    });

  const el = document.createElement('div');
  el.className = 'column column--goal';
  el.style.left  = x + 'px';
  el.style.top   = y + 'px';
  el.style.width = width + 'px';

  // Header
  const header = document.createElement('div');
  header.className = 'column-header column-header--goal';

  const titleEl = document.createElement('span');
  titleEl.className = 'column-title';
  titleEl.textContent = goal.title;
  titleEl.title = `Goal: ${goal.title}`;
  header.appendChild(titleEl);

  const count = document.createElement('span');
  count.className = 'goal-tile-count';
  count.textContent = linkedTasks.length;
  count.title = `${linkedTasks.length} task${linkedTasks.length !== 1 ? 's' : ''}`;
  header.appendChild(count);

  el.appendChild(header);

  // Task list (read-only)
  const list = document.createElement('div');
  list.className = 'task-list task-list--goal';

  if (linkedTasks.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'empty-column-hint';
    hint.textContent = 'No tasks for this goal';
    list.appendChild(hint);
  } else {
    linkedTasks.forEach(task => {
      const col = state.columns.find(c => c.id === task.column_id);
      const row = document.createElement('div');
      row.className = `task-item ${task.status} goal-tile-task`;
      row.title = col ? `In: ${col.name}` : '';

      const titleSpan = document.createElement('span');
      titleSpan.className = 'task-title';
      titleSpan.textContent = task.title;

      // Tile badge — shows which tile this task lives in
      if (col) {
        const tileBadge = document.createElement('span');
        tileBadge.className = 'goal-tile-origin';
        tileBadge.textContent = col.name;
        row.appendChild(titleSpan);
        row.appendChild(tileBadge);
      } else {
        row.appendChild(titleSpan);
      }

      // Status badge for done/wip
      if (task.status === 'wip') {
        const badge = document.createElement('span');
        badge.className = 'wip-badge';
        badge.textContent = 'WIP';
        row.appendChild(badge);
      } else if (task.status === 'done') {
        titleSpan.style.textDecoration = 'line-through';
        titleSpan.style.color = 'var(--done-colour)';
      }

      // Click → open notes panel (task still lives in its real tile)
      // Checkbox — marks task done (works from goal tile without leaving the board)
      const goalCheck = document.createElement('input');
      goalCheck.type = 'checkbox';
      goalCheck.className = 'task-check';
      goalCheck.checked = task.status === 'done';
      goalCheck.title = task.status === 'done' ? 'Mark active' : 'Mark done';
      goalCheck.addEventListener('change', async e => {
        e.stopPropagation();
        await toggleDone(task.id, goalCheck.checked);
      });
      goalCheck.addEventListener('mousedown', e => e.stopPropagation());
      goalCheck.addEventListener('click', e => e.stopPropagation());
      row.insertBefore(goalCheck, row.firstChild);

      row.addEventListener('click', e => {
        if (e.target === goalCheck) return;
        openNotesPanel(task.id);
      });
      row.addEventListener('mousedown', e => e.stopPropagation());
      list.appendChild(row);
    });
  }

  el.appendChild(list);

  // Goal notes (if any)
  if (goal.notes) {
    const notes = document.createElement('div');
    notes.className = 'goal-tile-notes';
    notes.textContent = goal.notes;
    el.appendChild(notes);
  }

  // Allow dragging the goal tile around the canvas; save position in state
  setupGoalTileDrag(el, goal.id);

  return el;
}

function setupGoalTileDrag(colEl, goalId) {
  const header = colEl.querySelector('.column-header--goal');
  if (!header) return;

  header.style.cursor = 'grab';

  header.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    if (e.target.closest('button')) return;
    e.preventDefault();
    e.stopPropagation();

    const startMouseX = e.clientX;
    const startMouseY = e.clientY;
    const startX = parseFloat(colEl.style.left) || 0;
    const startY = parseFloat(colEl.style.top)  || 0;

    header.style.cursor = 'grabbing';

    const onMove = e => {
      const dx = (e.clientX - startMouseX) / view.zoom;
      const dy = (e.clientY - startMouseY) / view.zoom;
      colEl.style.left = (startX + dx) + 'px';
      colEl.style.top  = (startY + dy) + 'px';
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      header.style.cursor = 'grab';
      // Save position so it survives renderBoard() re-renders and page refreshes
      if (goalId) {
        state.goalTilePositions[goalId] = {
          x: parseFloat(colEl.style.left) || 0,
          y: parseFloat(colEl.style.top)  || 0,
        };
        saveViewState();
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function applyTileScale(el, col) {
  const s = col.scale || 1;
  el.style.transform       = s !== 1 ? `scale(${s})` : '';
  el.style.transformOrigin = 'top left';
}

function buildColumn(col) {
  const el = document.createElement('div');
  el.className = 'column';
  el.dataset.colId = col.id;
  el.style.left  = col.x + 'px';
  el.style.top   = col.y + 'px';
  el.style.width = (col.width || 260) + 'px';
  if (col.color) el.style.background = col.color;
  applyTileScale(el, col);

  el.appendChild(buildColumnHeader(col));
  el.appendChild(buildTaskList(col));
  el.appendChild(buildAddTaskRow(col));

  const doneTasks = state.tasks.filter(t => t.column_id === col.id && t.status === 'done');
  if (doneTasks.length > 0) el.appendChild(buildClearDoneRow(col.id, doneTasks.length));

  // Resize handle
  el.appendChild(buildResizeHandle(el, col));

  // Bring to front on any interaction
  el.addEventListener('mousedown', () => bringToFront(el), true);

  setupColumnDrag(el, col);
  setupTilePinch(el, col);
  return el;
}

function refreshColumn(el, col) {
  // Rebuild the inner content but keep the element itself (so drag state isn't lost)
  const wasDragging = el.classList.contains('col-dragging');

  // Bring to front on any interaction (re-attach after refresh)
  el.addEventListener('mousedown', () => bringToFront(el), true);

  // Replace header
  const oldHeader = el.querySelector('.column-header');
  const newHeader = buildColumnHeader(col);
  el.replaceChild(newHeader, oldHeader);
  setupColumnDrag(el, col);

  // Replace task list
  const oldList = el.querySelector('.task-list');
  const newList = buildTaskList(col);
  el.replaceChild(newList, oldList);

  // Replace add-task row
  const oldAdd = el.querySelector('.add-task-row');
  const newAdd = buildAddTaskRow(col);
  el.replaceChild(newAdd, oldAdd);

  // Clear done row
  const oldClear = el.querySelector('.clear-done-row');
  if (oldClear) oldClear.remove();
  const doneTasks = state.tasks.filter(t => t.column_id === col.id && t.status === 'done');
  if (doneTasks.length > 0) el.appendChild(buildClearDoneRow(col.id, doneTasks.length));

  // Update colour, width, scale
  el.style.width = (col.width || 260) + 'px';
  el.style.background = col.color || '';
  applyTileScale(el, col);

  // Ensure resize handle exists
  if (!el.querySelector('.tile-resize-handle')) el.appendChild(buildResizeHandle(el, col));

  if (wasDragging) el.classList.add('col-dragging');
}

function buildColumnHeader(col) {
  const header = document.createElement('div');
  header.className = 'column-header';

  const titleEl = document.createElement('span');
  titleEl.className = 'column-title';
  titleEl.textContent = col.name;
  titleEl.title = 'Click to rename';

  titleEl.addEventListener('click', e => {
    if (e.target._wasDragged) return;
    startRenameColumn(col.id, titleEl);
  });
  header.appendChild(titleEl);

  // Dormant ghost pill — always present when there are sleeping tasks,
  // positioned immediately after the title so it's always visible
  const dormantCount = state.tasks.filter(t => t.column_id === col.id && t.status === 'dormant').length;
  if (dormantCount > 0) {
    const showing = state.showDormantForCol.has(col.id);
    const pill = document.createElement('span');
    pill.className = 'dormant-pill' + (showing ? ' dormant-pill--on' : '');
    pill.textContent = `👻 ${dormantCount}`;
    pill.title = showing
      ? `Showing ${dormantCount} hidden task${dormantCount !== 1 ? 's' : ''} — click to hide`
      : `${dormantCount} hidden task${dormantCount !== 1 ? 's' : ''} — click to reveal`;
    const toggleDormantPill = () => {
      if (state.showDormantForCol.has(col.id)) {
        state.showDormantForCol.delete(col.id);
      } else {
        state.showDormantForCol.add(col.id);
      }
      notesPanelColRevealedByPanel = false;
      renderBoard();
    };
    pill.addEventListener('click', e => { e.stopPropagation(); toggleDormantPill(); });
    pill.addEventListener('touchend', e => { e.stopPropagation(); e.preventDefault(); toggleDormantPill(); }, { passive: false });
    header.appendChild(pill);
  }

  // ── Scroll wheel on header = zoom tile in/out ─────────────────
  // stopPropagation prevents the canvas wheel handler from also firing.
  header.addEventListener('wheel', e => {
    e.preventDefault();
    e.stopPropagation();
    // Positive deltaY = scroll down = shrink; negative = scroll up = grow
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    adjustTileScale(col.id, delta);
  }, { passive: false });

  header.title = 'Scroll to resize tile';

  // ── Scale badge — shown when tile is not at default (1×) scale ───────────
  // Clicking or tapping resets to 1×. Always visible (not hover-only) so
  // the user can immediately see why a tile looks small/large and fix it.
  const currentScale = col.scale || 1;
  if (Math.round(currentScale * 10) !== 10) {
    const scaleBadge = document.createElement('span');
    scaleBadge.className = 'col-scale-badge';
    scaleBadge.textContent = currentScale.toFixed(1) + '×';
    scaleBadge.title = 'Click to reset to 1×';
    const doReset = () => adjustTileScale(col.id, 1 - currentScale);
    scaleBadge.addEventListener('click', e => { e.stopPropagation(); doReset(); });
    scaleBadge.addEventListener('touchend', e => { e.stopPropagation(); e.preventDefault(); doReset(); }, { passive: false });
    header.appendChild(scaleBadge);
  }

  // Hover actions (colour picker + hide + delete) — always built the same way
  const actions = document.createElement('div');
  actions.className = 'column-actions';

  const colourBtn = document.createElement('button');
  colourBtn.className = 'col-btn';
  colourBtn.textContent = '🎨';
  colourBtn.title = 'Set tile colour';
  colourBtn.addEventListener('click', e => { e.stopPropagation(); showColourPicker(e, col, header); });
  colourBtn.addEventListener('touchend', e => { e.stopPropagation(); e.preventDefault(); showColourPicker(e.changedTouches[0], col, header); }, { passive: false });

  // Hide/unhide toggle for this tile
  const hideBtn = document.createElement('button');
  hideBtn.className = 'col-btn';
  hideBtn.textContent = col.hidden ? '🙉' : '🙈';
  hideBtn.title = col.hidden ? 'Unhide tile (move to main board)' : 'Hide tile (park)';
  hideBtn.addEventListener('click', async e => { e.stopPropagation(); await toggleTileHidden(col.id); });
  hideBtn.addEventListener('touchend', async e => { e.stopPropagation(); e.preventDefault(); await toggleTileHidden(col.id); }, { passive: false });

  const delBtn = document.createElement('button');
  delBtn.className = 'col-btn danger';
  delBtn.textContent = '✕';
  delBtn.title = 'Delete tile';
  delBtn.addEventListener('click', e => { e.stopPropagation(); deleteColumn(col.id); });
  delBtn.addEventListener('touchend', e => { e.stopPropagation(); e.preventDefault(); deleteColumn(col.id); }, { passive: false });

  actions.appendChild(colourBtn);
  actions.appendChild(hideBtn);
  actions.appendChild(delBtn);
  header.appendChild(actions);
  return header;
}

// ── Colour picker ─────────────────────────────────────────────
function showColourPicker(e, col, anchorEl) {
  // Remove any existing picker
  document.querySelectorAll('.color-picker-popup').forEach(p => p.remove());

  const popup = document.createElement('div');
  popup.className = 'color-picker-popup';

  TILE_COLOURS.forEach(({ value, label }) => {
    const swatch = document.createElement('div');
    swatch.className = 'color-swatch' + (col.color === value ? ' active' : '');
    if (value) {
      swatch.style.background = value;
    } else {
      swatch.classList.add('none');
      swatch.textContent = '✕';
    }
    swatch.title = label;
    swatch.addEventListener('click', async ev => {
      ev.stopPropagation();
      popup.remove();
      const updated = await patch(`/api/columns/${col.id}`, { color: value });
      const idx = state.columns.findIndex(c => c.id === col.id);
      if (idx !== -1) state.columns[idx] = updated;
      renderBoard();
    });
    popup.appendChild(swatch);
  });

  // Position relative to the anchor (column header)
  anchorEl.style.position = 'relative';
  anchorEl.appendChild(popup);

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', () => popup.remove(), { once: true });
  }, 0);
}

// ── Tile resize ────────────────────────────────────────────────
function buildResizeHandle(colEl, col) {
  const handle = document.createElement('div');
  handle.className = 'tile-resize-handle';

  // ── Mouse resize (desktop) ──────────────────────────────────
  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    e.stopPropagation();

    const startX     = e.clientX;
    const startWidth = col.width || 260;

    const onMove = e => {
      const dx = (e.clientX - startX) / view.zoom;
      col.width = Math.max(180, startWidth + dx);
      colEl.style.width = col.width + 'px';
    };

    const onUp = async () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      try {
        await patch(`/api/columns/${col.id}`, { width: col.width });
      } catch (err) {
        console.error('Resize failed', err);
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // ── Touch resize (iPad/iPhone) ──────────────────────────────
  // The handle is a dedicated touch target so resize begins immediately
  // on touchstart — no long-press required (unlike tile drag).
  let resizeTouchId    = null;
  let resizeTouchStartX = 0;
  let resizeStartWidth  = 0;

  handle.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    e.stopPropagation(); // prevent tile header long-press from also firing
    const t = e.touches[0];
    resizeTouchId     = t.identifier;
    resizeTouchStartX = t.clientX;
    resizeStartWidth  = col.width || 260;
  }, { passive: true });

  handle.addEventListener('touchmove', e => {
    const t = Array.from(e.touches).find(t => t.identifier === resizeTouchId);
    if (!t) return;
    e.preventDefault();
    e.stopPropagation();
    const dx = (t.clientX - resizeTouchStartX) / view.zoom;
    col.width = Math.max(180, resizeStartWidth + dx);
    colEl.style.width = col.width + 'px';
  }, { passive: false });

  handle.addEventListener('touchend', async e => {
    const t = Array.from(e.changedTouches).find(t => t.identifier === resizeTouchId);
    if (!t) return;
    resizeTouchId = null;
    try {
      await patch(`/api/columns/${col.id}`, { width: col.width });
    } catch (err) {
      console.error('Resize touch save failed', err);
    }
  }, { passive: true });

  handle.addEventListener('touchcancel', () => {
    resizeTouchId = null; // discard without saving
  }, { passive: true });

  return handle;
}

function buildTaskList(col) {
  const showDormant = state.showDormantForCol.has(col.id);
  const tasks = state.tasks
    .filter(t => t.column_id === col.id && (t.status !== 'dormant' || showDormant))
    .sort((a, b) => a.position - b.position);

  const list = document.createElement('div');
  list.className = 'task-list';
  list.dataset.colId = col.id;

  if (tasks.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'empty-column-hint';
    hint.textContent = 'No tasks yet';
    list.appendChild(hint);
  } else {
    tasks.forEach(t => list.appendChild(buildTask(t)));
  }

  setupDragTarget(list);
  return list;
}

function buildAddTaskRow(col) {
  const addRow = document.createElement('div');
  addRow.className = 'add-task-row';

  const addInput = document.createElement('input');
  addInput.type = 'text';
  addInput.className = 'add-task-input';
  addInput.placeholder = '+ Add task…';
  addInput.autocomplete = 'off';
  addInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const title = addInput.value.trim();
      if (title) { addTask(title, col.id); addInput.value = ''; }
    }
    if (e.key === 'Escape') { addInput.value = ''; addInput.blur(); }
  });
  // Prevent canvas pan when clicking/touching input
  addInput.addEventListener('mousedown', e => e.stopPropagation());
  // On iOS the viewport touchstart calls preventDefault() which suppresses
  // the synthetic focus event. Stop propagation so the viewport handler
  // never sees this touch, then focus the input explicitly.
  addInput.addEventListener('touchstart', e => {
    e.stopPropagation();
    addInput.focus();
  }, { passive: true });

  addRow.appendChild(addInput);
  return addRow;
}

function buildClearDoneRow(colId, count) {
  const row = document.createElement('div');
  row.className = 'clear-done-row';
  const btn = document.createElement('button');
  btn.className = 'clear-done-btn';
  btn.textContent = `Clear ${count} done`;
  btn.addEventListener('click', () => clearDone(colId));
  btn.addEventListener('mousedown', e => e.stopPropagation());
  // iOS: stop propagation + fire action directly on touchend
  btn.addEventListener('touchend', e => {
    e.stopPropagation();
    e.preventDefault();
    clearDone(colId);
  }, { passive: false });
  row.appendChild(btn);
  return row;
}

function buildTask(task) {
  const goal = task.goal_id ? state.goals.find(g => g.id === task.goal_id) : null;

  const el = document.createElement('div');
  el.className = `task-item ${task.status}`;
  el.dataset.taskId = task.id;
  el.draggable = true;

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'task-check';
  check.checked = task.status === 'done';
  check.addEventListener('change', () => toggleDone(task.id, check.checked));
  check.addEventListener('mousedown', e => e.stopPropagation());
  // iOS: viewport touchstart calls preventDefault() which suppresses synthetic
  // click/change events. Stop propagation and toggle directly on touchend.
  check.addEventListener('touchend', e => {
    e.stopPropagation();
    e.preventDefault(); // prevent the synthetic click from also firing
    check.checked = !check.checked;
    toggleDone(task.id, check.checked);
  }, { passive: false });

  const titleEl = document.createElement('span');
  titleEl.className = 'task-title';
  titleEl.textContent = task.title;
  titleEl.addEventListener('dblclick', () => startEditTask(task.id, titleEl));
  titleEl.addEventListener('mousedown', e => e.stopPropagation());

  if (task.status === 'wip') {
    const badge = document.createElement('span');
    badge.className = 'wip-badge';
    badge.textContent = 'WIP';
    el.appendChild(check);
    el.appendChild(titleEl);
    el.appendChild(badge);
  } else {
    el.appendChild(check);
    el.appendChild(titleEl);
  }

  if (goal) {
    const tag = document.createElement('span');
    tag.className = 'task-goal-tag';
    tag.textContent = goal.title;
    tag.title = goal.title;
    el.appendChild(tag);
  }

  // Due-date label — quiet, colour-coded by urgency
  if (task.next_due) {
    const today    = new Date(getNow()).toISOString().slice(0, 10);
    const dueLabel = document.createElement('span');
    dueLabel.className = 'task-due-label';
    dueLabel.textContent = task.next_due;

    if (task.next_due < today) {
      dueLabel.classList.add('overdue');
      dueLabel.title = 'Overdue';
    } else if (task.next_due === today) {
      dueLabel.classList.add('due-soon');
      dueLabel.title = 'Due today';
    } else {
      // Due within 3 days = amber
      const daysAway = Math.round((new Date(task.next_due) - new Date(today)) / 86400000);
      if (daysAway <= 3) dueLabel.classList.add('due-soon');
    }
    el.appendChild(dueLabel);
  }

  // Recurrence indicator (shown for active/wip/dormant recurring tasks)
  if (task.recurrence && task.status !== 'done') {
    const recurInd = document.createElement('span');
    recurInd.className = 'task-recur-indicator';
    recurInd.textContent = '↺';
    recurInd.title = `Repeats: ${task.recurrence}${task.status === 'dormant' ? ' · dormant' : ''}`;
    if (task.status === 'dormant') recurInd.style.opacity = '0.4';
    el.appendChild(recurInd);
  }
  // Dormant visual treatment
  if (task.status === 'dormant') {
    el.style.opacity = '0.5';
    el.style.fontStyle = 'italic';
  }

  // WIP badge — clicking it clears WIP → active
  if (task.status === 'wip') {
    const wipBadge = el.querySelector('.wip-badge');
    if (wipBadge) {
      wipBadge.title = 'WIP — click to mark active';
      wipBadge.style.cursor = 'pointer';
      wipBadge.addEventListener('click', async e => {
        e.stopPropagation();
        await setTaskStatus(task.id, 'active');
      });
      wipBadge.addEventListener('mousedown', e => e.stopPropagation());
    }
  }

  // Left-border strip — bidirectional WIP toggle:
  //   active tasks:  strip appears on hover → click to mark WIP
  //   wip tasks:     strip always visible (amber) → click to clear WIP
  if (task.status === 'active' || task.status === 'wip') {
    const wipTrigger = document.createElement('div');
    wipTrigger.className = 'wip-trigger';
    wipTrigger.title = task.status === 'wip' ? 'WIP — click to clear' : 'Click to mark WIP';
    wipTrigger.addEventListener('click', async e => {
      e.stopPropagation();
      await setTaskStatus(task.id, task.status === 'wip' ? 'active' : 'wip');
    });
    wipTrigger.addEventListener('mousedown', e => e.stopPropagation());
    el.appendChild(wipTrigger);
  }

  // Right-edge Today strip — bidirectional toggle (mirrors WIP left-strip pattern):
  //   unflagged tasks: strip appears on hover → click to flag for Today
  //   flagged tasks:   strip always visible (amber) → click to unflag
  if (task.status !== 'dormant') {
    const todayStrip = document.createElement('div');
    todayStrip.className = 'today-flag-strip';
    todayStrip.title = task.today_flag ? 'In Today — click to remove' : 'Click to add to Today';
    todayStrip.addEventListener('click', async e => {
      e.stopPropagation();
      await toggleTodayFlag(task.id, !task.today_flag);
    });
    todayStrip.addEventListener('mousedown', e => e.stopPropagation());
    el.appendChild(todayStrip);
  }

  // 📅 badge — visible when task is flagged for today
  if (task.today_flag) {
    const todayBadge = document.createElement('span');
    todayBadge.className = 'today-badge';
    todayBadge.textContent = '📅';
    todayBadge.title = 'Flagged for today';
    el.appendChild(todayBadge);
    el.classList.add('today-flagged');
  }

  // ¶ indicator — visible when task has notes
  if (task.notes) {
    const noteInd = document.createElement('span');
    noteInd.className = 'task-notes-indicator';
    noteInd.textContent = '¶';
    noteInd.title = 'Has notes';
    el.appendChild(noteInd);
  }

  const menuBtn = document.createElement('button');
  menuBtn.className = 'task-menu-btn';
  menuBtn.textContent = '⋯';
  menuBtn.title = 'Options';
  menuBtn.addEventListener('click', e => { e.stopPropagation(); showContextMenu(e, task.id); });
  menuBtn.addEventListener('mousedown', e => e.stopPropagation());
  // iOS: trigger context menu on touchend so preventDefault() on viewport doesn't swallow it
  menuBtn.addEventListener('touchend', e => {
    e.stopPropagation();
    e.preventDefault();
    showContextMenu(e.changedTouches[0], task.id);
  }, { passive: false });
  el.appendChild(menuBtn);

  // Attach drag + click events for ALL statuses (including dormant)
  el.addEventListener('dragstart', onDragStart);
  el.addEventListener('dragend',   onDragEnd);
  el.addEventListener('mousedown', e => e.stopPropagation());

  el.addEventListener('click', e => {
    if (e.target.closest('.task-check'))    return;
    if (e.target.closest('.task-menu-btn')) return;
    if (e.target.closest('[contenteditable]')) return;
    openNotesPanel(task.id);
  });

  // Touch: the viewport's touchstart calls preventDefault() which suppresses
  // synthetic mouse/click events on iOS. Add explicit touchend handler so
  // tapping a task opens the details panel on iPad/iPhone.
  el.addEventListener('touchend', e => {
    // Ignore multi-touch (pinch etc.)
    if (e.changedTouches.length !== 1) return;
    if (e.target.closest('.task-check'))    return;
    if (e.target.closest('.task-menu-btn')) return;
    if (e.target.closest('[contenteditable]')) return;
    // Only open panel if the finger didn't move much (i.e. it was a tap, not a scroll)
    const touch = e.changedTouches[0];
    const startTouch = el._touchStart;
    if (startTouch) {
      const dx = touch.clientX - startTouch.x;
      const dy = touch.clientY - startTouch.y;
      if (Math.abs(dx) > 10 || Math.abs(dy) > 10) return; // moved too far — was a scroll
    }
    e.preventDefault(); // stop the synthetic click from also firing
    openNotesPanel(task.id);
  }, { passive: false });

  el.addEventListener('touchstart', e => {
    if (e.touches.length === 1) {
      el._touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
  }, { passive: true });

  // Urgency heat (spinning plates) or rot — dormant tasks skip both
  if (task.status === 'dormant') {
    // Still apply user colour for dormant tasks (they're shown semi-transparent)
    if (task.color) el.style.background = task.color;
    return el;
  }

  const urgency = computeUrgency(task);
  const urgencyC = task.status !== 'wip' ? urgencyColour(urgency) : null;
  if (urgencyC) {
    // Layer urgency heat on top of user colour if one is set.
    // Both are semi-transparent rgba values so they blend naturally:
    // low urgency → user colour dominates; high urgency → heat bleeds through.
    el.style.background = task.color
      ? `${urgencyC}, ${task.color}`
      : urgencyC;
    if (urgency >= 1.0 && task.status !== 'wip') {
      const heatR = Math.round(234 + (185 - 234) * Math.min((urgency - 1.0) / 0.5, 1));
      const heatG = Math.round(88  + (28  - 88)  * Math.min((urgency - 1.0) / 0.5, 1));
      const heatB = Math.round(12  + (28  - 12)  * Math.min((urgency - 1.0) / 0.5, 1));
      el.style.borderLeftColor = `rgb(${heatR},${heatG},${heatB})`;
    }
  } else if (task.color) {
    // No urgency — just apply user colour
    el.style.background = task.color;
  } else {
    // No urgency, no user colour — apply rot if active
    const rot  = computeRot(task);
    const rotC = rotColour(rot);
    if (rotC) el.style.background = rotC;
  }

  return el;
}

// ── Debug date / getNow() ─────────────────────────────────────
// Returns the timestamp to use for "now" — respects server debug_date if set.
function getNow() {
  if (state.user && state.user.debug_date) {
    return new Date(state.user.debug_date + 'T12:00:00Z').getTime();
  }
  return Date.now();
}

function renderDebugPill() {
  const existing = document.getElementById('debug-date-pill');
  if (state.user && state.user.debug_date) {
    if (existing) {
      existing.textContent = '🔧 ' + state.user.debug_date;
    } else {
      const pill = document.createElement('span');
      pill.id = 'debug-date-pill';
      pill.className = 'debug-date-pill';
      pill.textContent = '🔧 ' + state.user.debug_date;
      pill.title = 'Debug date override active';
      document.querySelector('.header-actions').prepend(pill);
    }
  } else {
    if (existing) existing.remove();
  }
}

// ── Hidden tiles ─────────────────────────────────────────────

function renderHiddenTileButton() {
  const btn       = document.getElementById('btn-toggle-hidden');
  const countEl   = document.getElementById('hidden-tile-count');
  const hidden    = state.columns.filter(c => c.hidden);
  if (hidden.length === 0) {
    btn.style.display = 'none';
    return;
  }
  btn.style.display = '';
  countEl.textContent = hidden.length;
  btn.title = state.showHiddenTiles
    ? `Hide parked tiles (${hidden.length})`
    : `Show parked tiles (${hidden.length})`;
  btn.classList.toggle('active', state.showHiddenTiles);
}

async function parkTask(taskId) {
  hideAllMenus();
  const result = await api('POST', `/api/tasks/${taskId}/park`);
  // Server may have created a new "Someday/Maybe" tile
  if (result.column && !state.columns.find(c => c.id === result.column.id)) {
    state.columns.push(result.column);
  } else if (result.column) {
    const idx = state.columns.findIndex(c => c.id === result.column.id);
    if (idx !== -1) state.columns[idx] = result.column;
  }
  updateTaskInState(result.task);
  // Close detail panel if the parked task was open
  if (notesPanelTaskId === taskId) closeNotesPanel();
  renderHiddenTileButton();
  renderBoard();
}

async function toggleTileHidden(colId) {
  const col = state.columns.find(c => c.id === colId);
  if (!col) return;
  const updated = await patch(`/api/columns/${colId}`, { hidden: !col.hidden });
  const idx = state.columns.findIndex(c => c.id === colId);
  if (idx !== -1) state.columns[idx] = updated;
  renderHiddenTileButton();
  renderBoard();
}

document.getElementById('btn-toggle-hidden').addEventListener('click', () => {
  state.showHiddenTiles = !state.showHiddenTiles;
  saveViewState();
  renderHiddenTileButton();
  renderBoard();
});

// ── Task snooze ─────────────────────────────────────────────
// Hides the task for 24h without touching its next_due date.
async function snoozeTask(taskId) {
  hideAllMenus();
  const updated = await api('POST', `/api/tasks/${taskId}/snooze`, {});
  updateTaskInState(updated);
  // Close the notes panel if this task was open
  if (notesPanelTaskId === taskId) closeNotesPanel();
  renderBoard();
}

// ── Task ACK (dead man's handle) ─────────────────────────────
async function ackTask(taskId) {
  const updated = await api('POST', `/api/tasks/${taskId}/ack`);
  updateTaskInState(updated);
  if (notesPanelTaskId === taskId) {
    renderTouchedInfo(updated);
  }
  renderBoard();
}

// ── Task rot ──────────────────────────────────────────────────
// Returns the rot interval in milliseconds
function rotIntervalToMs(rotInterval) {
  const r = (rotInterval || 'weekly').toLowerCase().trim();
  const DAY = 86400000;
  if (r === 'daily'   || r === '1d') return DAY;
  if (r === 'weekly'  || r === '1w') return 7  * DAY;
  if (r === 'monthly' || r === '1m') return 30.44 * DAY;
  const match = r.match(/^(\d+)([dwm])$/);
  if (match) {
    const n = parseInt(match[1]);
    const unit = match[2];
    if (unit === 'd') return n * DAY;
    if (unit === 'w') return n * 7 * DAY;
    if (unit === 'm') return n * 30.44 * DAY;
  }
  return 7 * DAY; // default weekly
}

// Returns rot ratio 0.0 → 1.5+
// Only applies to active/wip non-recurring tasks with rot enabled
function computeRot(task) {
  if (task.no_rot) return 0;
  if (task.recurrence) return 0; // spinning plates handles recurring
  if (task.status === 'done' || task.status === 'dormant') return 0;
  const interval  = rotIntervalToMs(task.rot_interval || 'weekly');
  const refTime   = task.last_acknowledged_at
    ? new Date(task.last_acknowledged_at).getTime()
    : new Date(task.created_at).getTime();
  const elapsed   = getNow() - refTime;
  return elapsed / interval;
}

// Returns an rgba() CSS string for the given rot ratio (cool grey palette)
// Rot stages (ratio = elapsed / interval):
//   0.0 – 0.5 : invisible (grace period)
//   0.5 – 1.0 : faint cool-grey wash appears (0 → 0.25 alpha)
//   1.0 – 1.5 : grey shifts to aged-parchment yellow, deepens (0.25 → 0.55)
//   1.5+      : fully aged parchment, capped at 0.60 alpha
// Alpha values are intentionally strong so users actually notice the decay.
function rotColour(rot) {
  if (rot <= 0.5) return null; // invisible below 0.5

  let r, g, b, a;

  if (rot < 1.0) {
    // 0.5 → 1.0: grey wash ramps up from invisible to clearly visible
    const t = (rot - 0.5) / 0.5;
    a = 0.25 * t; // 0 → 0.25
    [r, g, b] = [110, 108, 102];
  } else if (rot < 1.5) {
    // 1.0 → 1.5: grey shifts to parchment yellow and darkens noticeably
    const t = (rot - 1.0) / 0.5;
    a = 0.25 + 0.30 * t; // 0.25 → 0.55
    [r, g, b] = [
      Math.round(110 + (210 - 110) * t),  // grey → parchment yellow
      Math.round(108 + (195 - 108) * t),
      Math.round(102 + (148 - 102) * t),
    ];
  } else {
    // 1.5+: fully aged parchment, capped
    a = 0.60;
    [r, g, b] = [210, 195, 148];
  }

  return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}

// ── Spinning plates: urgency heat ────────────────────────────
// Converts a recurrence string to milliseconds (approximate)
function recurrenceToMs(recurrence) {
  const r = (recurrence || '').toLowerCase().trim();
  const DAY = 86400000;
  if (r === 'daily'   || r === '1d') return DAY;
  if (r === 'weekly'  || r === '1w') return 7  * DAY;
  if (r === 'monthly' || r === '1m') return 30.44 * DAY;
  const match = r.match(/^(\d+)([dwm])$/);
  if (match) {
    const n = parseInt(match[1]);
    const unit = match[2];
    if (unit === 'd') return n * DAY;
    if (unit === 'w') return n * 7 * DAY;
    if (unit === 'm') return n * 30.44 * DAY;
  }
  return 7 * DAY; // unknown — default to weekly
}

// Returns urgency ratio 0.0 → 1.5+
// Reference point = most recent of (last_done_at, created_at) so urgency
// fires on the first occurrence even before the task has ever been completed.
function computeUrgency(task) {
  if (!task.recurrence) return 0;
  if (task.status === 'done') return 0;
  const interval   = recurrenceToMs(task.recurrence);
  const lastDoneMs = task.last_done_at ? new Date(task.last_done_at).getTime() : 0;
  const createdMs  = task.created_at   ? new Date(task.created_at).getTime()   : 0;
  const refTime    = Math.max(lastDoneMs, createdMs);
  if (!refTime) return 0;
  const elapsed    = getNow() - refTime;
  return elapsed / interval;
}

// Interpolates between two RGB colours by ratio t ∈ [0, 1]
function lerpRGB(r1, g1, b1, r2, g2, b2, t) {
  return [
    Math.round(r1 + (r2 - r1) * t),
    Math.round(g1 + (g2 - g1) * t),
    Math.round(b1 + (b2 - b1) * t),
  ];
}

// Returns an rgba() CSS string for the given urgency ratio
function urgencyColour(urgency) {
  if (urgency <= 0)   return null;

  // Stages:
  //   0.0 → 0.5 : invisible  → faint amber tint
  //   0.5 → 1.0 : amber tint → orange tint
  //   1.0 → 1.5+: orange     → deep red  (capped at 1.5)

  let r, g, b, a;

  if (urgency < 0.5) {
    // Transparent → very faint amber
    const t = urgency / 0.5;
    a = 0.06 * t;
    [r, g, b] = [251, 191, 36]; // amber-400
  } else if (urgency < 1.0) {
    // Faint amber → orange
    const t = (urgency - 0.5) / 0.5;
    a = 0.06 + 0.12 * t;        // 0.06 → 0.18
    [r, g, b] = lerpRGB(251, 191, 36, 234, 88, 12, t); // amber → orange-600
  } else {
    // Orange → deep red (cap at urgency = 1.5)
    const t = Math.min((urgency - 1.0) / 0.5, 1);
    a = 0.18 + 0.17 * t;        // 0.18 → 0.35
    [r, g, b] = lerpRGB(234, 88, 12, 185, 28, 28, t); // orange-600 → red-700
  }

  return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}

// ── Task CRUD ────────────────────────────────────────────────

async function addTask(title, columnId) {
  const task = await post('/api/tasks', { title, column_id: columnId });
  state.tasks.push(task);
  renderBoard();
  setTimeout(() => {
    const input = canvas.querySelector(`.column[data-col-id="${columnId}"] .add-task-input`);
    if (input) input.focus();
  }, 0);
}

async function toggleDone(taskId, isDone) {
  const updated = await patch(`/api/tasks/${taskId}`, { status: isDone ? 'done' : 'active' });
  updateTaskInState(updated);
  renderBoard();
}

async function setTaskStatus(taskId, status) {
  const updated = await patch(`/api/tasks/${taskId}`, { status });
  updateTaskInState(updated);
  renderBoard();
}

async function deleteTask(taskId) {
  await del(`/api/tasks/${taskId}`);
  state.tasks = state.tasks.filter(t => t.id !== taskId);
  renderBoard();
}

async function clearDone(columnId) {
  // ── Clear desk ceremony ───────────────────────────────────
  // 1. Find the DOM elements for done tasks in the relevant column(s).
  // 2. Stagger the erase animation across them (cap total duration at ~600ms).
  // 3. Wait for the last animation to finish, then delete + re-render.

  const doneEls = columnId
    ? Array.from(canvas.querySelectorAll(
        `.column[data-col-id="${columnId}"] .task-item.done`))
    : Array.from(canvas.querySelectorAll('.task-item.done'));

  if (doneEls.length > 0) {
    const ANIM_MS  = 280; // matches CSS animation duration
    const MAX_STAGGER_MS = 600;
    const stagger = doneEls.length > 1
      ? Math.min(Math.floor((MAX_STAGGER_MS - ANIM_MS) / (doneEls.length - 1)), 60)
      : 0;

    doneEls.forEach((el, i) => {
      setTimeout(() => el.classList.add('task-erasing'), i * stagger);
    });

    // Wait for the last task's animation to fully complete before removing
    await new Promise(resolve =>
      setTimeout(resolve, (doneEls.length - 1) * stagger + ANIM_MS + 20)
    );
  }

  // Now delete server-side and update local state
  const url = columnId ? `/api/tasks?column_id=${columnId}` : '/api/tasks';
  await api('DELETE', url);
  if (columnId) {
    state.tasks = state.tasks.filter(t => !(t.column_id === columnId && t.status === 'done'));
  } else {
    state.tasks = state.tasks.filter(t => t.status !== 'done');
  }
  renderBoard();
}

function startEditTask(taskId, titleEl) {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task || task.status === 'done') return;

  titleEl.contentEditable = 'true';
  titleEl.focus();
  const range = document.createRange();
  range.selectNodeContents(titleEl);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  // Collapse newlines/BR elements to a single space — contentEditable can
  // insert <br> on Enter or when multi-line text is pasted.
  const cleanTitle = () => titleEl.innerText.replace(/[\r\n]+/g, ' ').trim();

  let committed = false;
  const finish = async () => {
    if (committed) return;
    committed = true;
    titleEl.contentEditable = 'false';
    const newTitle = cleanTitle();
    if (newTitle && newTitle !== task.title) {
      const updated = await patch(`/api/tasks/${taskId}`, { title: newTitle });
      updateTaskInState(updated);
    } else {
      titleEl.textContent = task.title;
    }
  };

  // Strip newlines from pasted content immediately so they never land in the DOM
  titleEl.addEventListener('paste', e => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData)
      .getData('text').replace(/[\r\n]+/g, ' ').trim();
    document.execCommand('insertText', false, text);
  }, { once: false });

  titleEl.addEventListener('blur', finish, { once: true });
  // NOTE: { once: true } intentionally removed — the listener must survive
  // every keystroke for the entire edit session, not just the first keypress.
  titleEl.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); titleEl.blur(); }
    if (e.key === 'Escape') { committed = true; titleEl.textContent = task.title; titleEl.blur(); }
  });
}

function updateTaskInState(updated) {
  const idx = state.tasks.findIndex(t => t.id === updated.id);
  if (idx !== -1) state.tasks[idx] = updated;
}

// ── Column CRUD ──────────────────────────────────────────────

async function addColumn(name) {
  // Auto-position: to the right of the rightmost visible column
  const visibleCols = state.columns.filter(c => !c.hidden);
  let x = 40, y = 40;
  if (visibleCols.length > 0) {
    const maxX = Math.max(...visibleCols.map(c => (c.x || 0)));
    x = maxX + 290;
    y = visibleCols.find(c => (c.x || 0) === maxX)?.y ?? 40;
  }
  const col = await post('/api/columns', { name, x, y });
  state.columns.push(col);
  renderBoard();
}

async function deleteColumn(colId) {
  const col = state.columns.find(c => c.id === colId);
  const taskCount = state.tasks.filter(t => t.column_id === colId).length;
  const msg = taskCount > 0
    ? `Delete tile "${col.name}" and its ${taskCount} task(s)?`
    : `Delete tile "${col.name}"?`;
  const ok = await paprConfirm(msg, { okLabel: 'Delete', danger: true });
  if (!ok) return;
  await del(`/api/columns/${colId}`);
  state.columns = state.columns.filter(c => c.id !== colId);
  state.tasks   = state.tasks.filter(t => t.column_id !== colId);
  renderHiddenTileButton(); // update count before renderBoard (which also calls it, but belt+braces)
  renderBoard();
}

function startRenameColumn(colId, titleEl) {
  const col = state.columns.find(c => c.id === colId);
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'column-title-input';
  input.value = col.name;
  titleEl.replaceWith(input);
  input.focus();
  input.select();
  input.addEventListener('mousedown', e => e.stopPropagation());

  const finish = async () => {
    const newName = input.value.trim();
    if (newName && newName !== col.name) {
      await patch(`/api/columns/${colId}`, { name: newName });
      col.name = newName;
    }
    renderBoard();
  };

  input.addEventListener('blur', finish, { once: true });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = col.name; input.blur(); }
  });
}

// ── Column drag (move in XY space) ───────────────────────────

function setupColumnDrag(colEl, col) {
  const header = colEl.querySelector('.column-header');

  // ── Mouse drag (desktop) ──────────────────────────────────
  header.addEventListener('mousedown', e => {
    // Only on left-click, not on buttons inside header
    if (e.button !== 0) return;
    if (e.target.closest('button')) return;
    if (e.target.closest('input')) return;

    e.preventDefault();
    e.stopPropagation();

    colEl.classList.add('col-dragging');

    const startMouseX = e.clientX;
    const startMouseY = e.clientY;
    const startColX   = col.x || 0;
    const startColY   = col.y || 0;
    let moved = false;

    const onMove = e => {
      const dx = (e.clientX - startMouseX) / view.zoom;
      const dy = (e.clientY - startMouseY) / view.zoom;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
      col.x = startColX + dx;
      col.y = startColY + dy;
      colEl.style.left = col.x + 'px';
      colEl.style.top  = col.y + 'px';
    };

    const onUp = async () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
      colEl.classList.remove('col-dragging');

      // Mark that a drag occurred so click handler doesn't fire rename
      if (moved) {
        const titleEl = colEl.querySelector('.column-title');
        if (titleEl) {
          titleEl._wasDragged = true;
          setTimeout(() => { titleEl._wasDragged = false; }, 200);
        }
        // Persist position
        try {
          await patch(`/api/columns/${col.id}`, { x: col.x, y: col.y });
        } catch (err) {
          console.error('Column move failed', err);
        }
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });

  // ── Touch drag (iPad/iPhone) — long-press on header to initiate ──
  // A short tap on the header is reserved for rename; a press-and-hold
  // (≥400ms without moving) starts a tile drag.
  let touchDragTimer  = null;
  let touchDragActive = false;
  let headerTouchStartX = 0;
  let headerTouchStartY = 0;
  let headerTouchStartColX = 0;
  let headerTouchStartColY = 0;
  let headerTouchId = null;

  const cancelTouchDragTimer = () => {
    if (touchDragTimer) { clearTimeout(touchDragTimer); touchDragTimer = null; }
  };

  header.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) { cancelTouchDragTimer(); return; }
    if (e.target.closest('button') || e.target.closest('input')) return;

    const t = e.touches[0];
    headerTouchStartX    = t.clientX;
    headerTouchStartY    = t.clientY;
    headerTouchStartColX = col.x || 0;
    headerTouchStartColY = col.y || 0;
    headerTouchId        = t.identifier;

    touchDragTimer = setTimeout(() => {
      touchDragTimer  = null;
      touchDragActive = true;
      colEl.classList.add('col-dragging');
      bringToFront(colEl);
    }, 400);
  }, { passive: true });

  header.addEventListener('touchmove', e => {
    if (!touchDragActive && touchDragTimer) {
      // Check if finger has moved too far — cancel long-press window
      const t = Array.from(e.touches).find(t => t.identifier === headerTouchId);
      if (t) {
        const dx = t.clientX - headerTouchStartX;
        const dy = t.clientY - headerTouchStartY;
        if (Math.abs(dx) > 8 || Math.abs(dy) > 8) cancelTouchDragTimer();
      }
      return;
    }
    if (!touchDragActive) return;

    e.preventDefault();
    e.stopPropagation();

    const t = Array.from(e.touches).find(t => t.identifier === headerTouchId);
    if (!t) return;

    const dx = (t.clientX - headerTouchStartX) / view.zoom;
    const dy = (t.clientY - headerTouchStartY) / view.zoom;
    col.x = headerTouchStartColX + dx;
    col.y = headerTouchStartColY + dy;
    colEl.style.left = col.x + 'px';
    colEl.style.top  = col.y + 'px';
  }, { passive: false });

  header.addEventListener('touchend', async e => {
    cancelTouchDragTimer();
    if (!touchDragActive) return;
    touchDragActive = false;
    colEl.classList.remove('col-dragging');
    try {
      await patch(`/api/columns/${col.id}`, { x: col.x, y: col.y });
    } catch (err) {
      console.error('Column touch-drag save failed', err);
    }
  }, { passive: true });

  header.addEventListener('touchcancel', () => {
    cancelTouchDragTimer();
    touchDragActive = false;
    colEl.classList.remove('col-dragging');
  }, { passive: true });
}

// ── Per-tile scale ────────────────────────────────────────────

async function adjustTileScale(colId, delta) {
  const col = state.columns.find(c => c.id === colId);
  if (!col) return;
  const current = col.scale || 1;
  const newScale = Math.round(Math.max(0.5, Math.min(2.0, current + delta)) * 10) / 10;
  if (newScale === current) return;
  col.scale = newScale;
  // Apply CSS transform immediately for a snappy feel — persist in background
  const el = canvas.querySelector(`.column[data-col-id="${colId}"]`);
  if (el) {
    applyTileScale(el, col);
    // Rebuild the header so the scale badge is always in sync with col.scale.
    // Direct DOM injection was unreliable; a clean header rebuild is definitive
    // and matches exactly what renderBoard() produces.
    const oldHeader = el.querySelector('.column-header');
    if (oldHeader) {
      const newHeader = buildColumnHeader(col);
      el.replaceChild(newHeader, oldHeader);
      setupColumnDrag(el, col);
    }
  }
  updateOffscreenIndicators();
  try {
    const updated = await patch(`/api/columns/${colId}`, { scale: newScale });
    const idx = state.columns.findIndex(c => c.id === colId);
    if (idx !== -1) state.columns[idx] = updated;
  } catch (err) {
    console.error('Scale save failed', err);
  }
}

// ── Mobile two-finger pinch to scale tile ────────────────────
// Both touch points must start within the tile's bounding rect so that a
// normal canvas pinch-to-zoom (fingers on the background) is not mistakenly
// captured here.  We track the starting scale and distance independently of
// the canvas-level touch handler which handles the viewport zoom.

function setupTilePinch(colEl, col) {
  let pinchActive    = false;
  let pinchStartDist = 0;
  let pinchStartScale = 1;

  function touchDist(a, b) {
    const dx = a.clientX - b.clientX;
    const dy = a.clientY - b.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function bothTouchesInTile(t1, t2) {
    const rect = colEl.getBoundingClientRect();
    function inRect(t) {
      return t.clientX >= rect.left && t.clientX <= rect.right &&
             t.clientY >= rect.top  && t.clientY <= rect.bottom;
    }
    return inRect(t1) && inRect(t2);
  }

  colEl.addEventListener('touchstart', e => {
    if (e.touches.length !== 2) { pinchActive = false; return; }
    const t1 = e.touches[0];
    const t2 = e.touches[1];
    // Only claim this gesture if both fingers land on this tile
    if (!bothTouchesInTile(t1, t2)) { pinchActive = false; return; }
    e.stopPropagation(); // prevent canvas touchstart from resetting its pinch state
    pinchActive     = true;
    pinchStartDist  = touchDist(t1, t2);
    pinchStartScale = col.scale || 1;
  }, { passive: true });

  colEl.addEventListener('touchmove', e => {
    if (!pinchActive || e.touches.length !== 2) return;
    e.preventDefault();  // prevent canvas pan/zoom during tile pinch
    e.stopPropagation();
    const currentDist = touchDist(e.touches[0], e.touches[1]);
    const ratio       = currentDist / pinchStartDist;
    // Snap to 0.1 steps within [0.5, 2.0]
    const raw      = pinchStartScale * ratio;
    const newScale = Math.round(Math.max(0.5, Math.min(2.0, raw)) * 10) / 10;
    if (newScale === (col.scale || 1)) return;
    col.scale = newScale;
    applyTileScale(colEl, col);
    updateOffscreenIndicators();
  }, { passive: false });

  colEl.addEventListener('touchend', async e => {
    if (!pinchActive) return;
    if (e.touches.length < 2) {
      pinchActive = false;
      // Persist final scale
      try {
        const updated = await patch(`/api/columns/${col.id}`, { scale: col.scale || 1 });
        const idx = state.columns.findIndex(c => c.id === col.id);
        if (idx !== -1) state.columns[idx] = updated;
      } catch (err) {
        console.error('Tile pinch scale save failed', err);
      }
    }
  }, { passive: true });

  colEl.addEventListener('touchcancel', () => {
    pinchActive = false;
  }, { passive: true });
}

// ── Goals ────────────────────────────────────────────────────

async function addGoal(title) {
  const goal = await post('/api/goals', { title });
  state.goals.push(goal);
  updateGoalsButton();
  renderBoard();
  return goal;
}

async function assignGoalToTask(taskId, goalId) {
  const updated = await patch(`/api/tasks/${taskId}`, { goal_id: goalId });
  updateTaskInState(updated);
  renderBoard();
}

// ── Context menu ─────────────────────────────────────────────

let contextTaskId = null;

function showContextMenu(e, taskId) {
  contextTaskId = taskId;
  const menu = document.getElementById('context-menu');
  hideAllMenus();
  menu.classList.remove('hidden');
  const x = Math.min(e.clientX, window.innerWidth  - 180);
  const y = Math.min(e.clientY, window.innerHeight - 200);
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
  e.preventDefault();
}

function hideAllMenus() {
  document.getElementById('context-menu').classList.add('hidden');
  document.getElementById('goal-picker').classList.add('hidden');
}

document.addEventListener('click', e => {
  if (!e.target.closest('.context-menu')) hideAllMenus();
});
// iOS: synthetic click is suppressed by viewport preventDefault().
// Add a touchstart listener so tapping outside the menu closes it.
document.addEventListener('touchstart', e => {
  if (!e.target.closest('.context-menu') && !e.target.closest('.task-menu-btn')) {
    hideAllMenus();
  }
}, { passive: true });

document.getElementById('context-menu').addEventListener('click', async e => {
  const btn = e.target.closest('button[data-action]');
  if (!btn || !contextTaskId) return;
  const action = btn.dataset.action;

  if (action === 'properties') { hideAllMenus(); openNotesPanel(contextTaskId); return; }
  if (action === 'wip')        await setTaskStatus(contextTaskId, 'wip');
  if (action === 'ack')        await ackTask(contextTaskId);
  if (action === 'snooze')     await snoozeTask(contextTaskId);
  if (action === 'park')       await parkTask(contextTaskId);
  if (action === 'delete')     await deleteTask(contextTaskId);

  if (action === 'today')       await toggleTodayFlag(contextTaskId, !state.tasks.find(t=>t.id===contextTaskId)?.today_flag);
  if (action === 'assign-goal') { showGoalPicker(e, contextTaskId); return; }
  if (action === 'colour')      { showTaskColourPicker(e, contextTaskId); return; }
  hideAllMenus();
});

function showTaskColourPicker(e, taskId) {
  document.querySelectorAll('.color-picker-popup').forEach(p => p.remove());
  hideAllMenus();

  const task = state.tasks.find(t => t.id === taskId);
  const popup = document.createElement('div');
  popup.className = 'color-picker-popup task-colour-popup';

  TASK_COLOURS.forEach(({ value, label }) => {
    const swatch = document.createElement('div');
    swatch.className = 'color-swatch' + (task && task.color === value ? ' active' : '');
    if (value) {
      swatch.style.background = value;
    } else {
      swatch.classList.add('none');
      swatch.textContent = '✕';
    }
    swatch.title = label;
    swatch.addEventListener('click', async ev => {
      ev.stopPropagation();
      popup.remove();
      const updated = await patch(`/api/tasks/${taskId}`, { color: value });
      const idx = state.tasks.findIndex(t => t.id === taskId);
      if (idx !== -1) state.tasks[idx] = updated;
      renderBoard();
    });
    popup.appendChild(swatch);
  });

  // Position near the click
  document.body.appendChild(popup);
  const x = Math.min(e.clientX, window.innerWidth  - 200);
  const y = Math.min(e.clientY, window.innerHeight - 80);
  popup.style.position = 'fixed';
  popup.style.left = x + 'px';
  popup.style.top  = y + 'px';
  popup.style.zIndex = '9999';

  setTimeout(() => {
    document.addEventListener('click', () => popup.remove(), { once: true });
  }, 0);
}

function showGoalPicker(e, taskId) {
  const picker = document.getElementById('goal-picker');
  picker.innerHTML = '';

  if (state.goals.length > 0) {
    const noneBtn = document.createElement('button');
    noneBtn.textContent = '— None';
    noneBtn.addEventListener('click', async () => { await assignGoalToTask(taskId, null); hideAllMenus(); });
    picker.appendChild(noneBtn);

    state.goals.forEach(goal => {
      const btn = document.createElement('button');
      btn.textContent = goal.title;
      btn.addEventListener('click', async () => { await assignGoalToTask(taskId, goal.id); hideAllMenus(); });
      picker.appendChild(btn);
    });

    const hr = document.createElement('hr');
    picker.appendChild(hr);
  }

  // ＋ Add new goal — inline creation without leaving the board
  const addBtn = document.createElement('button');
  addBtn.textContent = '＋ Add new goal…';
  addBtn.style.cssText = 'color:var(--accent);font-style:italic;';
  addBtn.addEventListener('click', e => {
    e.stopPropagation();
    // Replace picker content with an inline input
    picker.innerHTML = '';
    const inputRow = document.createElement('div');
    inputRow.style.cssText = 'display:flex;gap:6px;padding:8px 10px;';
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.placeholder = 'Goal name…';
    inp.style.cssText = 'flex:1;border:1px solid var(--border);border-radius:4px;padding:4px 7px;font-size:12px;font-family:inherit;outline:none;';
    inp.addEventListener('mousedown', ev => ev.stopPropagation());
    const okBtn = document.createElement('button');
    okBtn.textContent = 'Add';
    okBtn.style.cssText = 'background:var(--accent);color:white;border-radius:4px;padding:4px 8px;font-size:12px;';
    const doAdd = async () => {
      const title = inp.value.trim();
      if (!title) return;
      const goal = await post('/api/goals', { title });
      state.goals.push(goal);
      updateGoalsButton();
      await assignGoalToTask(taskId, goal.id);
      hideAllMenus();
    };
    okBtn.addEventListener('click', doAdd);
    inp.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') { ev.preventDefault(); doAdd(); }
      if (ev.key === 'Escape') hideAllMenus();
    });
    inputRow.appendChild(inp);
    inputRow.appendChild(okBtn);
    picker.appendChild(inputRow);
    setTimeout(() => inp.focus(), 30);
  });
  picker.appendChild(addBtn);

  picker.classList.remove('hidden');
  const rect = document.getElementById('context-menu').getBoundingClientRect();
  picker.style.left = (rect.right + 4) + 'px';
  picker.style.top  = rect.top + 'px';
}

// ── Search overlay ────────────────────────────────────────────

const searchOverlay  = document.getElementById('search-overlay');
const searchInput    = document.getElementById('search-input');
const searchResults  = document.getElementById('search-results');
let searchActiveIdx  = -1;

function openSearch() {
  searchOverlay.classList.remove('hidden');
  searchInput.value = '';
  searchResults.innerHTML = '';
  searchActiveIdx = -1;
  setTimeout(() => searchInput.focus(), 30);
}

function closeSearch() {
  searchOverlay.classList.add('hidden');
  searchInput.value = '';
  searchResults.innerHTML = '';
  searchActiveIdx = -1;
}

function highlightMatch(text, query) {
  if (!query) return document.createTextNode(text);
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return document.createTextNode(text);
  const span = document.createElement('span');
  span.appendChild(document.createTextNode(text.slice(0, idx)));
  const mark = document.createElement('mark');
  mark.textContent = text.slice(idx, idx + query.length);
  span.appendChild(mark);
  span.appendChild(document.createTextNode(text.slice(idx + query.length)));
  return span;
}

function runSearch(query) {
  searchActiveIdx = -1;
  const q = query.trim().toLowerCase();
  searchResults.innerHTML = '';

  if (!q) return;

  // Score each task: title match = 2, notes match = 1
  const scored = state.tasks
    .map(t => {
      const titleMatch = t.title.toLowerCase().includes(q);
      const notesMatch = t.notes && t.notes.toLowerCase().includes(q);
      const score = (titleMatch ? 2 : 0) + (notesMatch ? 1 : 0);
      return { task: t, score, titleMatch };
    })
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score || a.task.title.localeCompare(b.task.title));

  if (scored.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'search-empty';
    empty.textContent = `No tasks matching "${query}"`;
    searchResults.appendChild(empty);
    return;
  }

  scored.forEach(({ task, titleMatch }) => {
    const col = state.columns.find(c => c.id === task.column_id);
    const row = document.createElement('div');
    row.className = 'search-result';
    row.dataset.taskId = task.id;

    // Title with highlight
    const titleEl = document.createElement('span');
    titleEl.className = 'search-result-title';
    titleEl.appendChild(highlightMatch(task.title, titleMatch ? query : ''));
    row.appendChild(titleEl);

    // Tile name
    if (col) {
      const tileEl = document.createElement('span');
      tileEl.className = 'search-result-tile';
      tileEl.textContent = col.name;
      row.appendChild(tileEl);
    }

    // Status badges (only non-active states)
    const badges = document.createElement('span');
    badges.className = 'search-result-badges';
    if (task.status !== 'active') {
      const badge = document.createElement('span');
      badge.className = `search-badge ${task.status}`;
      badge.textContent = task.status;
      badges.appendChild(badge);
    }
    if (badges.children.length > 0) row.appendChild(badges);

    row.addEventListener('click', () => openTaskFromSearch(task.id));
    searchResults.appendChild(row);
  });
}

function setSearchActive(idx) {
  const rows = searchResults.querySelectorAll('.search-result');
  rows.forEach(r => r.classList.remove('active'));
  if (idx >= 0 && idx < rows.length) {
    rows[idx].classList.add('active');
    rows[idx].scrollIntoView({ block: 'nearest' });
  }
  searchActiveIdx = idx;
}

function openTaskFromSearch(taskId) {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return;
  closeSearch();
  // If dormant, temporarily reveal it in its tile
  if (task.status === 'dormant') {
    state.showDormantForCol.add(task.column_id);
    renderBoard();
  }
  openNotesPanel(taskId);
}

searchInput.addEventListener('input', () => runSearch(searchInput.value));

searchInput.addEventListener('keydown', e => {
  const rows = searchResults.querySelectorAll('.search-result');
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    setSearchActive(Math.min(searchActiveIdx + 1, rows.length - 1));
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    setSearchActive(Math.max(searchActiveIdx - 1, 0));
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (searchActiveIdx >= 0 && rows[searchActiveIdx]) {
      const id = parseInt(rows[searchActiveIdx].dataset.taskId);
      openTaskFromSearch(id);
    } else if (rows.length === 1) {
      const id = parseInt(rows[0].dataset.taskId);
      openTaskFromSearch(id);
    }
  } else if (e.key === 'Escape') {
    closeSearch();
  }
});

// Close on backdrop click (outside the search box)
searchOverlay.addEventListener('click', e => {
  if (e.target === searchOverlay) closeSearch();
});

document.getElementById('btn-search').addEventListener('click', openSearch);

// ── Goal tiles toggle ─────────────────────────────────────────

function toggleGoalTiles() {
  if (state.goals.length === 0) return; // no-op when no goals
  state.showGoalTiles = !state.showGoalTiles;
  saveViewState();
  renderBoard(); // syncGoalsButton() is called inside renderBoard()
}

function updateGoalsButton() {
  const btn = document.getElementById('btn-goals');
  const hasGoals = state.goals.length > 0;
  btn.disabled = !hasGoals;
  btn.style.opacity = hasGoals ? '' : '0.4';
  btn.style.cursor  = hasGoals ? '' : 'default';
  btn.title = hasGoals
    ? 'Show/hide goal tiles (G)'
    : 'No goals yet — add them from the menu (user icon → Goals)';
}

document.getElementById('btn-goals').addEventListener('click', () => toggleGoalTiles());

// ── Add column modal ─────────────────────────────────────────

function openColumnModal() {
  document.getElementById('column-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('new-column-input').focus(), 50);
}

function closeColumnModal() {
  document.getElementById('column-modal').classList.add('hidden');
  document.getElementById('new-column-input').value = '';
}

document.getElementById('btn-add-column').addEventListener('click', openColumnModal);
document.getElementById('btn-close-column-modal').addEventListener('click', closeColumnModal);
document.getElementById('column-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('column-modal')) closeColumnModal();
});
document.getElementById('add-column-form').addEventListener('submit', async e => {
  e.preventDefault();
  const input = document.getElementById('new-column-input');
  const name  = input.value.trim();
  if (!name) return;
  await addColumn(name);
  closeColumnModal();
});

// ── Clear all done ────────────────────────────────────────────

document.getElementById('btn-clear-all').addEventListener('click', async () => {
  const count = state.tasks.filter(t => t.status === 'done').length;
  if (!count) return;
  if (await paprConfirm(`Clear all ${count} completed task(s)?`, { okLabel: 'Clear', danger: true })) clearDone(null);
});

// ── Canvas pan (drag on empty space) ─────────────────────────

function bindCanvasEvents() {
  let panning  = false;
  let startX   = 0;
  let startY   = 0;
  let startPanX = 0;
  let startPanY = 0;

  viewport.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    // Only start pan if clicking on the viewport/canvas background, not a column
    if (e.target.closest('.column')) return;
    // Close notes panel when clicking on blank canvas
    if (notesPanelTaskId !== null) {
      closeNotesPanel();
      return; // don't start panning on the same click
    }
    // Blur any active rename input so it commits before pan starts
    if (document.activeElement && document.activeElement !== document.body) {
      document.activeElement.blur();
    }
    e.preventDefault();
    panning = true;
    startX    = e.clientX;
    startY    = e.clientY;
    startPanX = view.panX;
    startPanY = view.panY;
    viewport.classList.add('panning');
  });

  document.addEventListener('mousemove', e => {
    if (!panning) return;
    view.panX = startPanX + (e.clientX - startX);
    view.panY = startPanY + (e.clientY - startY);
    applyTransform();
  });

  document.addEventListener('mouseup', e => {
    if (!panning) return;
    panning = false;
    viewport.classList.remove('panning');
  });
}

// ── Touch support (pan + pinch-to-zoom) ──────────────────────

(function bindTouchEvents() {
  let touch1 = null; // first touch point
  let touch2 = null; // second touch point (pinch)

  // Snapshot of view state at gesture start
  let touchStartPanX  = 0;
  let touchStartPanY  = 0;
  let touchStartZoom  = 1;
  let pinchStartDist  = 0;
  let pinchMidX       = 0; // midpoint in viewport coords at gesture start
  let pinchMidY       = 0;
  let pinchCanvasX    = 0; // canvas point under midpoint
  let pinchCanvasY    = 0;

  function dist(a, b) {
    const dx = a.clientX - b.clientX;
    const dy = a.clientY - b.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  viewport.addEventListener('touchstart', e => {
    // Always prevent default on the canvas viewport so the page doesn't scroll
    e.preventDefault();

    if (e.touches.length === 1) {
      touch1 = e.touches[0];
      touch2 = null;
      touchStartPanX = view.panX;
      touchStartPanY = view.panY;
    } else if (e.touches.length === 2) {
      touch1 = e.touches[0];
      touch2 = e.touches[1];
      touchStartZoom  = view.zoom;
      touchStartPanX  = view.panX;
      touchStartPanY  = view.panY;
      pinchStartDist  = dist(touch1, touch2);
      const rect      = viewport.getBoundingClientRect();
      pinchMidX       = (touch1.clientX + touch2.clientX) / 2 - rect.left;
      pinchMidY       = (touch1.clientY + touch2.clientY) / 2 - rect.top;
      pinchCanvasX    = (pinchMidX - view.panX) / view.zoom;
      pinchCanvasY    = (pinchMidY - view.panY) / view.zoom;
    }
  }, { passive: false });

  viewport.addEventListener('touchmove', e => {
    e.preventDefault();

    if (e.touches.length === 1 && touch2 === null) {
      // Single-finger pan
      const t = e.touches[0];
      view.panX = touchStartPanX + (t.clientX - touch1.clientX);
      view.panY = touchStartPanY + (t.clientY - touch1.clientY);
      applyTransform();

    } else if (e.touches.length === 2) {
      // Two-finger pinch-to-zoom + pan simultaneously
      const a = e.touches[0];
      const b = e.touches[1];
      const currentDist = dist(a, b);
      const scale = currentDist / pinchStartDist;
      const newZoom = Math.max(view.MIN_ZOOM, Math.min(view.MAX_ZOOM, touchStartZoom * scale));

      // Midpoint pan delta
      const rect     = viewport.getBoundingClientRect();
      const midX     = (a.clientX + b.clientX) / 2 - rect.left;
      const midY     = (a.clientY + b.clientY) / 2 - rect.top;

      // Keep the canvas point under the pinch midpoint
      view.zoom = newZoom;
      view.panX = midX - pinchCanvasX * newZoom;
      view.panY = midY - pinchCanvasY * newZoom;
      applyTransform();
    }
  }, { passive: false });

  viewport.addEventListener('touchend', e => {
    e.preventDefault();
    if (e.touches.length === 0) {
      touch1 = null;
      touch2 = null;
    } else if (e.touches.length === 1) {
      // One finger lifted during pinch — restart single-finger pan
      touch1 = e.touches[0];
      touch2 = null;
      touchStartPanX = view.panX;
      touchStartPanY = view.panY;
    }
  }, { passive: false });
})();

// ── Zoom (scroll wheel, centred on cursor) ───────────────────

viewport.addEventListener('wheel', e => {
  e.preventDefault();

  const ZOOM_SPEED = 0.001;
  const delta = -e.deltaY * ZOOM_SPEED;
  const newZoom = Math.max(view.MIN_ZOOM, Math.min(view.MAX_ZOOM, view.zoom * (1 + delta)));

  if (newZoom === view.zoom) return;

  // Zoom towards cursor position
  const rect = viewport.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  // Point on canvas under cursor (before zoom)
  const canvasX = (mouseX - view.panX) / view.zoom;
  const canvasY = (mouseY - view.panY) / view.zoom;

  view.zoom = newZoom;

  // Adjust pan so the canvas point stays under the cursor
  view.panX = mouseX - canvasX * view.zoom;
  view.panY = mouseY - canvasY * view.zoom;

  applyTransform();
}, { passive: false });

function bindZoomControls() {
  const STEP = 0.15;

  document.getElementById('btn-zoom-in').addEventListener('click', () => {
    zoomToCenter(Math.min(view.MAX_ZOOM, view.zoom + STEP));
  });

  document.getElementById('btn-zoom-out').addEventListener('click', () => {
    zoomToCenter(Math.max(view.MIN_ZOOM, view.zoom - STEP));
  });

  document.getElementById('btn-zoom-reset').addEventListener('click', () => {
    view.zoom = 1;
    view.panX = 40;
    view.panY = 40;
    applyTransform(); // also calls saveViewState()
  });
}

function zoomToCenter(newZoom) {
  const rect    = viewport.getBoundingClientRect();
  const centerX = rect.width  / 2;
  const centerY = rect.height / 2;
  const canvasX = (centerX - view.panX) / view.zoom;
  const canvasY = (centerY - view.panY) / view.zoom;
  view.zoom = newZoom;
  view.panX = centerX - canvasX * view.zoom;
  view.panY = centerY - canvasY * view.zoom;
  applyTransform();
}

// ── Keyboard shortcuts ────────────────────────────────────────

function bindGlobalEvents() {
  document.addEventListener('keydown', e => {
    // ⌘K / Ctrl+K — open search from anywhere
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      openSearch();
      return;
    }

    // ⌘1-9 / Ctrl+1-9 — jump to bookmark by position
    if ((e.metaKey || e.ctrlKey) && e.key >= '1' && e.key <= '9') {
      const idx = parseInt(e.key) - 1; // 0-based
      const bm  = state.bookmarks && state.bookmarks[idx];
      if (bm) {
        e.preventDefault();
        jumpToBookmark(bm);
      }
      return;
    }

    const tag = document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement.contentEditable === 'true') return;

    if (e.key === 'd' || e.key === 'D') { toggleTodayTile(); }
    if (e.key === 'g' || e.key === 'G') { if (state.goals.length > 0) toggleGoalTiles(); }
    if (e.key === 'Escape') {
      hideAllMenus();
      closeSearch();
      closeColumnModal();
      closeBookmarkDropdown();
      if (notesPanelTaskId !== null) closeNotesPanel();
      if (state.showGoalTiles) {
        state.showGoalTiles = false;
        document.getElementById('btn-goals').classList.remove('active');
        renderBoard();
      }
      // Note: goals overlay removed — managed via /goals page
    }
  });
}

// ── Task drag-and-drop (within/between columns) ───────────────

let dragTaskId    = null;
let dragSourceCol = null;
let placeholder   = null;

function onDragStart(e) {
  dragTaskId    = parseInt(e.currentTarget.dataset.taskId);
  dragSourceCol = parseInt(e.currentTarget.closest('.task-list').dataset.colId);
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';

  placeholder = document.createElement('div');
  placeholder.className = 'drag-placeholder';

  // Fix drag ghost image when canvas is scaled via CSS transform.
  // The browser computes ghost offset from the element's screen-space
  // bounding rect but renders the ghost at natural (unscaled) element
  // dimensions — so at zoom ≠ 1 the ghost appears misaligned.
  // Solution: clone the element, place it off-screen at its natural size
  // (no transform), and provide cursor-relative offsets divided by zoom
  // so the hotspot is correct at any zoom level.
  const el   = e.currentTarget;
  const rect = el.getBoundingClientRect();
  const clone = el.cloneNode(true);
  clone.style.cssText = [
    'position:fixed',
    'top:-9999px',
    'left:-9999px',
    `width:${el.offsetWidth}px`,
    'transform:none',
    'pointer-events:none',
    'z-index:-1',
  ].join(';');
  document.body.appendChild(clone);
  const offsetX = Math.round((e.clientX - rect.left) / view.zoom);
  const offsetY = Math.round((e.clientY - rect.top)  / view.zoom);
  e.dataTransfer.setDragImage(clone, offsetX, offsetY);
  // Remove the clone after the browser has captured the ghost image
  setTimeout(() => clone.remove(), 0);
}

function onDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  if (placeholder && placeholder.parentNode) placeholder.parentNode.removeChild(placeholder);
  placeholder   = null;
  dragTaskId    = null;
  dragSourceCol = null;
  canvas.querySelectorAll('.task-list').forEach(l => l.classList.remove('drag-over'));
}

function setupDragTarget(list) {
  list.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    list.classList.add('drag-over');
    const afterEl = getDragAfterElement(list, e.clientY);
    if (afterEl == null) {
      list.appendChild(placeholder);
    } else {
      list.insertBefore(placeholder, afterEl);
    }
  });

  list.addEventListener('dragleave', e => {
    if (!list.contains(e.relatedTarget)) list.classList.remove('drag-over');
  });

  list.addEventListener('drop', async e => {
    e.preventDefault();
    list.classList.remove('drag-over');
    if (dragTaskId == null) return;

    const targetColId = parseInt(list.dataset.colId);
    const items = Array.from(list.querySelectorAll('.task-item:not(.dragging)'));
    const placeholderIdx = Array.from(list.children).indexOf(placeholder);

    const colTasks = items.map(el => parseInt(el.dataset.taskId));
    colTasks.splice(placeholderIdx < 0 ? colTasks.length : placeholderIdx, 0, dragTaskId);

    if (dragSourceCol !== targetColId) {
      state.tasks.forEach(t => { if (t.id === dragTaskId) t.column_id = targetColId; });
    }

    const payload = colTasks.map((id, idx) => ({ id, position: idx, column_id: targetColId }));

    payload.forEach(({ id, position, column_id }) => {
      const t = state.tasks.find(t => t.id === id);
      if (t) { t.position = position; t.column_id = column_id; }
    });

    renderBoard();

    try {
      await post('/api/tasks/reorder', payload);
    } catch (err) {
      console.error('Reorder failed', err);
    }
  });
}

function getDragAfterElement(container, y) {
  const els = Array.from(container.querySelectorAll('.task-item:not(.dragging)'));
  return els.reduce((closest, child) => {
    const box    = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) return { offset, element: child };
    return closest;
  }, { offset: Number.NEGATIVE_INFINITY }).element;
}

// ── Notes panel ──────────────────────────────────────────────

let notesPanelTaskId         = null;
let notesSaveTimer           = null;
let titleSaveTimer           = null;
let notesPanelColRevealedByPanel = false; // true if we auto-showed dormant for this column

const notesPanel              = document.getElementById('notes-panel');
const notesTitleInput         = document.getElementById('notes-title-input');
const notesTextarea           = document.getElementById('notes-textarea');
const notesPreview            = document.getElementById('notes-preview');
const notesSaveStatus         = document.getElementById('notes-save-status');
const notesDateInput          = document.getElementById('notes-date-input');
const notesRecurSelect        = document.getElementById('notes-recurrence-select');
const notesVisibilityField    = document.getElementById('notes-visibility-field');
const notesVisibilitySelect   = document.getElementById('notes-visibility-select');
const notesRotIntervalSelect  = document.getElementById('notes-rot-interval-select');
const notesNoRotCheck         = document.getElementById('notes-no-rot-check');
const notesTouchedInfo        = document.getElementById('notes-touched-info');
const notesGoalSelect         = document.getElementById('notes-goal-select');
const notesColourSwatches     = document.getElementById('notes-colour-swatches');

// Populate/refresh the goal dropdown in the notes panel
function renderPanelGoalSelect(task) {
  notesGoalSelect.innerHTML = '<option value="">— none —</option>';
  state.goals.forEach(g => {
    const opt = document.createElement('option');
    opt.value = g.id;
    opt.textContent = g.title;
    notesGoalSelect.appendChild(opt);
  });
  // Add new goal inline option
  const addOpt = document.createElement('option');
  addOpt.value = '__add__';
  addOpt.textContent = '＋ Add new goal…';
  notesGoalSelect.appendChild(addOpt);

  notesGoalSelect.value = task.goal_id ? String(task.goal_id) : '';
}

// Render colour swatches inline in the notes panel
function renderPanelColourSwatches(task) {
  notesColourSwatches.innerHTML = '';
  TASK_COLOURS.forEach(({ value, label }) => {
    const swatch = document.createElement('div');
    swatch.className = 'color-swatch' + (task.color === value ? ' active' : '');
    if (value) {
      swatch.style.background = value;
    } else {
      swatch.classList.add('none');
      swatch.textContent = '✕';
    }
    swatch.title = label;
    swatch.addEventListener('click', async () => {
      if (notesPanelTaskId == null) return;
      const current = state.tasks.find(t => t.id === notesPanelTaskId);
      if (current && (current.color || null) === (value || null)) return; // no-op
      const updated = await patch(`/api/tasks/${notesPanelTaskId}`, { color: value });
      updateTaskInState(updated);
      renderTouchedInfo(updated);
      renderBoard();
      renderPanelColourSwatches(updated);
    });
    notesColourSwatches.appendChild(swatch);
  });
}

// "Find on board" — pan canvas so the task's tile is centred, then pulse the task element
function findOnBoard(taskId) {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return;
  const col = state.columns.find(c => c.id === task.column_id);
  if (!col) return;

  // Target canvas point: centre of the tile
  const tileW = col.width || 260;
  const tileH = 200; // approximate tile height
  const targetCanvasX = (col.x || 0) + tileW / 2;
  const targetCanvasY = (col.y || 0) + tileH / 2;

  // Pan so that canvas point lands at viewport centre
  const rect = viewport.getBoundingClientRect();
  view.panX = rect.width  / 2 - targetCanvasX * view.zoom;
  view.panY = rect.height / 2 - targetCanvasY * view.zoom;
  applyTransform();

  // Also ensure tile is visible if hidden
  if (col.hidden && !state.showHiddenTiles) {
    state.showHiddenTiles = true;
    renderHiddenTileButton();
    renderBoard();
  }
  if (task.status === 'dormant' && !state.showDormantForCol.has(col.id)) {
    state.showDormantForCol.add(col.id);
    renderBoard();
  }

  // Pulse the task element after a brief delay (allow renderBoard to complete)
  setTimeout(() => {
    const el = canvas.querySelector(`.task-item[data-task-id="${taskId}"]`);
    if (el) {
      el.classList.remove('task-pulse');
      // Force reflow so re-adding the class restarts the animation
      void el.offsetWidth;
      el.classList.add('task-pulse');
      el.addEventListener('animationend', () => el.classList.remove('task-pulse'), { once: true });
    }
  }, 80);
}

function updateVisibilityFieldVisibility() {
  // Show visibility field whenever a due date is set (recurrence is irrelevant)
  notesVisibilityField.style.display = notesDateInput.value ? '' : 'none';
}

// ── Custom dialog helpers (replace browser confirm/prompt) ───
// paprConfirm(message, { okLabel, danger }) → Promise<boolean>
// paprPrompt(message, defaultValue)         → Promise<string|null>
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
    const close = (result) => { backdrop.remove(); resolve(result); };
    cancelBtn.addEventListener('click', () => close(false));
    okBtn.addEventListener('click',     () => close(true));
    backdrop.addEventListener('click', e => { if (e.target === backdrop) close(false); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { document.removeEventListener('keydown', esc); close(false); }
    });
    okBtn.focus();
  });
}

function paprPrompt(message, defaultValue = '') {
  return new Promise(resolve => {
    const backdrop = document.createElement('div');
    backdrop.className = 'taskpapr-dialog-backdrop';
    backdrop.innerHTML = `
      <div class="taskpapr-dialog" role="dialog" aria-modal="true">
        <p>${message}</p>
        <input type="text" value="${defaultValue.replace(/"/g, '&quot;')}" />
        <div class="taskpapr-dialog-btns">
          <button class="btn-cancel">Cancel</button>
          <button class="btn-ok">OK</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    const input = backdrop.querySelector('input');
    const [cancelBtn, okBtn] = backdrop.querySelectorAll('button');
    const close = (result) => { backdrop.remove(); resolve(result); };
    cancelBtn.addEventListener('click', () => close(null));
    okBtn.addEventListener('click',     () => close(input.value));
    backdrop.addEventListener('click', e => { if (e.target === backdrop) close(null); });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); close(input.value); }
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
    });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { document.removeEventListener('keydown', esc); }
    });
    input.focus();
    input.select();
  });
}

// Formats a date (ISO string or Date) as a relative string like "3 days ago", "today"
// Uses calendar-date comparison in the local timezone so midnight correctly
// advances the label (e.g. something created at 11pm last night = "yesterday", not "today").
function relativeDate(isoStr) {
  if (!isoStr) return null;
  // Strip to local YYYY-MM-DD for both sides
  const toLocalDate = (ts) => {
    const d = new Date(ts);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  };
  const thenDay = toLocalDate(new Date(isoStr).getTime());
  const nowDay  = toLocalDate(getNow());
  const days = Math.round((nowDay - thenDay) / 86400000);
  if (days < 0)  return 'just now';
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30)  return `${days} days ago`;
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  return `${Math.round(days / 365)}y ago`;
}

function renderTouchedInfo(task) {
  if (!notesTouchedInfo) return;
  // "Touched" means "last time this task changed", not just an explicit ACK.
  // We use updated_at so edits (notes/title/etc.) correctly advance it.
  const touched = task.updated_at || task.created_at;
  const created = task.created_at;
  const touchedRel = relativeDate(touched);
  const createdRel = relativeDate(created);
  const touchedFull = touched ? new Date(touched).toLocaleString() : '';
  const createdFull = created ? new Date(created).toLocaleString() : '';
  notesTouchedInfo.innerHTML =
    `<span title="${touchedFull}">Touched: ${touchedRel}</span>` +
    (created ? ` · <span title="${createdFull}">Created: ${createdRel}</span>` : '');
}

function openNotesPanel(taskId) {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return;

  // Snapshot whether this column's dormant tasks were already visible before we opened
  notesPanelColRevealedByPanel = false;
  // (will be set to true if the task goes dormant while the panel is open)

  notesPanelTaskId            = taskId;
  notesTitleInput.value       = task.title;
  notesTextarea.value         = task.notes || '';
  notesDateInput.value        = task.next_due || '';
  notesRecurSelect.value      = task.recurrence || '';
  // visibility_days: default 3 if not set
  const vd = (task.visibility_days != null) ? task.visibility_days : 3;
  notesVisibilitySelect.value = String(vd);
  if (!notesVisibilitySelect.value) notesVisibilitySelect.value = '3'; // fallback
  // Rot settings
  notesRotIntervalSelect.value = task.rot_interval || 'weekly';
  notesNoRotCheck.checked      = !task.no_rot; // checked = "remind me" = rot enabled
  notesRotIntervalSelect.style.display = notesNoRotCheck.checked ? '' : 'none';
  updateVisibilityFieldVisibility();
  renderNotesPreview(task.notes || '');
  renderTouchedInfo(task);
  renderPanelGoalSelect(task);
  renderPanelColourSwatches(task);
  setSaveStatus('');

  notesPanel.classList.remove('hidden');
  setTimeout(() => notesTextarea.focus(), 50);
}

function closeNotesPanel() {
  // Flush any pending saves immediately
  if (notesSaveTimer)  { clearTimeout(notesSaveTimer);  saveNotes(notesTextarea.value); }
  if (titleSaveTimer)  { clearTimeout(titleSaveTimer);  saveTitle(notesTitleInput.value); }

  // If we auto-revealed dormant tasks for this column while the panel was open,
  // revert that reveal now (so the board goes back to its previous clean state)
  if (notesPanelColRevealedByPanel && notesPanelTaskId !== null) {
    const task = state.tasks.find(t => t.id === notesPanelTaskId);
    if (task) {
      state.showDormantForCol.delete(task.column_id);
    }
  }
  notesPanelColRevealedByPanel = false;

  notesPanel.classList.add('hidden');
  notesPanelTaskId = null;
  renderBoard(); // re-render to reflect any dormant visibility changes
}

function renderNotesPreview(text) {
  if (!text.trim()) {
    notesPreview.innerHTML = '';
    return;
  }
  // marked is loaded from CDN; fall back to plain text if not yet loaded
  if (typeof marked !== 'undefined') {
    notesPreview.innerHTML = marked.parse(text, { breaks: true });
  } else {
    notesPreview.textContent = text;
  }
}

function setSaveStatus(msg) {
  notesSaveStatus.textContent = msg;
}

async function saveNotes(value) {
  if (notesPanelTaskId == null) return;
  const task = state.tasks.find(t => t.id === notesPanelTaskId);
  if (task && value === (task.notes || '')) return; // unchanged — don't touch server
  try {
    const updated = await patch(`/api/tasks/${notesPanelTaskId}`, { notes: value });
    updateTaskInState(updated);
    renderTouchedInfo(updated);
    renderBoard();
    setSaveStatus('Saved');
    setTimeout(() => setSaveStatus(''), 2000);
  } catch (err) {
    setSaveStatus('Save failed');
    console.error('Notes save failed', err);
  }
}

async function saveTitle(value) {
  if (notesPanelTaskId == null) return;
  const trimmed = value.trim();
  if (!trimmed) return;
  const task = state.tasks.find(t => t.id === notesPanelTaskId);
  if (!task || trimmed === task.title) return;
  try {
    const updated = await patch(`/api/tasks/${notesPanelTaskId}`, { title: trimmed });
    updateTaskInState(updated);
    renderTouchedInfo(updated);
    renderBoard();
    setSaveStatus('Saved');
    setTimeout(() => setSaveStatus(''), 2000);
  } catch (err) {
    setSaveStatus('Save failed');
    console.error('Title save failed', err);
  }
}

// Auto-reveal helper: if task just became dormant while panel is open, show it in tile
function autoRevealIfDormant(updated) {
  if (updated.status === 'dormant' && notesPanelTaskId === updated.id) {
    if (!state.showDormantForCol.has(updated.column_id)) {
      state.showDormantForCol.add(updated.column_id);
      notesPanelColRevealedByPanel = true;
    }
  }
}

// Date field: save immediately on change, also toggle visibility field
// If date is cleared, also clear recurrence (recurrence requires a due date)
notesDateInput.addEventListener('change', async () => {
  if (notesPanelTaskId == null) return;
  const val = notesDateInput.value || null;
  updateVisibilityFieldVisibility();
  const payload = { next_due: val };
  if (!val && notesRecurSelect.value) {
    // Clearing the date → also clear recurrence
    notesRecurSelect.value = '';
    payload.recurrence = null;
  }
  const updated = await patch(`/api/tasks/${notesPanelTaskId}`, payload);
  updateTaskInState(updated);
  renderTouchedInfo(updated);
  autoRevealIfDormant(updated);
  renderBoard();
  setSaveStatus('Saved');
  setTimeout(() => setSaveStatus(''), 2000);
});
notesDateInput.addEventListener('mousedown', e => e.stopPropagation());

// Recurrence select: save immediately on change, toggle visibility field
// If a repeat is set but there is no due date, auto-fill today's date
notesRecurSelect.addEventListener('change', async () => {
  if (notesPanelTaskId == null) return;
  const val = notesRecurSelect.value || null;
  const payload = { recurrence: val };
  if (val && !notesDateInput.value) {
    // Auto-fill today as the first due date when recurrence is chosen without one
    const today = new Date(getNow()).toISOString().slice(0, 10);
    notesDateInput.value = today;
    payload.next_due = today;
  }
  updateVisibilityFieldVisibility();
  const updated = await patch(`/api/tasks/${notesPanelTaskId}`, payload);
  updateTaskInState(updated);
  renderTouchedInfo(updated);
  autoRevealIfDormant(updated);
  renderBoard();
  setSaveStatus('Saved');
  setTimeout(() => setSaveStatus(''), 2000);
});
notesRecurSelect.addEventListener('mousedown', e => e.stopPropagation());

// Visibility select: save immediately on change
notesVisibilitySelect.addEventListener('change', async () => {
  if (notesPanelTaskId == null) return;
  const val = parseInt(notesVisibilitySelect.value);
  const updated = await patch(`/api/tasks/${notesPanelTaskId}`, { visibility_days: val });
  updateTaskInState(updated);
  renderTouchedInfo(updated);
  autoRevealIfDormant(updated);
  renderBoard();
  setSaveStatus('Saved');
  setTimeout(() => setSaveStatus(''), 2000);
});
notesVisibilitySelect.addEventListener('mousedown', e => e.stopPropagation());

// Notes textarea: debounced auto-save + live preview
notesTextarea.addEventListener('input', () => {
  renderNotesPreview(notesTextarea.value);
  setSaveStatus('Unsaved…');
  clearTimeout(notesSaveTimer);
  notesSaveTimer = setTimeout(() => saveNotes(notesTextarea.value), 800);
});

// Prevent canvas pan when typing in panel
notesTextarea.addEventListener('mousedown', e => e.stopPropagation());
notesTitleInput.addEventListener('mousedown', e => e.stopPropagation());

// Title: debounced auto-save
notesTitleInput.addEventListener('input', () => {
  setSaveStatus('Unsaved…');
  clearTimeout(titleSaveTimer);
  titleSaveTimer = setTimeout(() => saveTitle(notesTitleInput.value), 800);
});

notesTitleInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); notesTextarea.focus(); }
});

// Rot interval select
notesRotIntervalSelect.addEventListener('change', async () => {
  if (notesPanelTaskId == null) return;
  const updated = await patch(`/api/tasks/${notesPanelTaskId}`, { rot_interval: notesRotIntervalSelect.value });
  updateTaskInState(updated);
  renderTouchedInfo(updated);
  renderBoard();
  setSaveStatus('Saved');
  setTimeout(() => setSaveStatus(''), 2000);
});
notesRotIntervalSelect.addEventListener('mousedown', e => e.stopPropagation());

// No-rot checkbox — note: checked = rot ON (no_rot = false)
notesNoRotCheck.addEventListener('change', async () => {
  if (notesPanelTaskId == null) return;
  notesRotIntervalSelect.style.display = notesNoRotCheck.checked ? '' : 'none';
  const updated = await patch(`/api/tasks/${notesPanelTaskId}`, { no_rot: !notesNoRotCheck.checked });
  updateTaskInState(updated);
  renderTouchedInfo(updated);
  renderBoard();
  setSaveStatus('Saved');
  setTimeout(() => setSaveStatus(''), 2000);
});

// Goal select in panel
notesGoalSelect.addEventListener('change', async () => {
  if (notesPanelTaskId == null) return;
  const val = notesGoalSelect.value;

  if (val === '__add__') {
    // Inline add: prompt, then create & assign
    const title = await paprPrompt('New goal name:');
    if (!title || !title.trim()) {
      // Revert select to previous value
      const task = state.tasks.find(t => t.id === notesPanelTaskId);
      notesGoalSelect.value = task.goal_id ? String(task.goal_id) : '';
      return;
    }
    const goal = await post('/api/goals', { title: title.trim() });
    state.goals.push(goal);
    updateGoalsButton();
    const updated = await patch(`/api/tasks/${notesPanelTaskId}`, { goal_id: goal.id });
    updateTaskInState(updated);
    renderTouchedInfo(updated);
    renderBoard();
    renderPanelGoalSelect(updated);
    setSaveStatus('Saved');
    setTimeout(() => setSaveStatus(''), 2000);
    return;
  }

  const goalId = val === '' ? null : parseInt(val);
  const updated = await patch(`/api/tasks/${notesPanelTaskId}`, { goal_id: goalId });
  updateTaskInState(updated);
  renderTouchedInfo(updated);
  renderBoard();
  setSaveStatus('Saved');
  setTimeout(() => setSaveStatus(''), 2000);
});
notesGoalSelect.addEventListener('mousedown', e => e.stopPropagation());

// ACK button in panel footer
document.getElementById('btn-ack').addEventListener('click', async () => {
  if (notesPanelTaskId == null) return;
  const updated = await ackTask(notesPanelTaskId);
  renderTouchedInfo(state.tasks.find(t => t.id === notesPanelTaskId));
});

// Park button in panel footer
document.getElementById('btn-park-task').addEventListener('click', async () => {
  if (notesPanelTaskId == null) return;
  await parkTask(notesPanelTaskId);
});

// Find on board button
document.getElementById('btn-find-on-board').addEventListener('click', () => {
  if (notesPanelTaskId == null) return;
  findOnBoard(notesPanelTaskId);
});

// Close button
document.getElementById('notes-panel-close').addEventListener('click', closeNotesPanel);

// ── Wake-on-visibility (handles laptop lid open / tab switch back) ────────
// When the browser tab becomes visible after being hidden for more than
// STALE_THRESHOLD ms, silently re-fetch state from the server and re-render.
// This handles the common case of opening the laptop in the morning and
// finding the board showing yesterday's dormant/urgency state.

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
let hiddenAt = null;

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'hidden') {
    hiddenAt = Date.now();
    return;
  }

  // Tab is now visible
  if (hiddenAt === null) return;
  const elapsed = Date.now() - hiddenAt;
  hiddenAt = null;

  if (elapsed < STALE_THRESHOLD_MS) return; // short switch — no need to refresh

  // Silent background refresh — don't disrupt the user if the panel is open
  try {
    const [columns, tasks, goals, user, bookmarks] = await Promise.all([
      get('/api/columns'),
      get('/api/tasks'),
      get('/api/goals'),
      get('/api/me'),
      get('/api/bookmarks'),
    ]);
    state.columns   = columns;
    state.tasks     = tasks;
    state.goals     = goals;
    state.user      = user;
    state.bookmarks = bookmarks;
    renderUser();
    renderDebugPill();
    renderHiddenTileButton();
    updateGoalsButton();
    renderBoard();
    renderBookmarkList();
  } catch (err) {
    // Server may be unreachable (e.g. laptop woke on a different network) — ignore silently
    console.warn('[taskpapr] visibility refresh failed:', err.message);
  }
});

// ── Sync timestamp display ────────────────────────────────────
// Shows "synced X ago" in the title bar so the user always knows when
// the board data was last fetched — without having to wonder whether
// they're looking at stale data from another device.
let lastSyncedAt = null;    // Date of last successful full data load
let _syncStampTimer = null; // interval handle for live tick

function updateSyncStamp(flashUpdated = false) {
  const el = document.getElementById('sync-stamp');
  if (!el) return;
  if (!lastSyncedAt) { el.textContent = ''; return; }

  const now     = Date.now();
  const diffSec = Math.round((now - lastSyncedAt) / 1000);
  let label;
  if (diffSec < 60)        label = 'just now';
  else if (diffSec < 3600) label = `${Math.floor(diffSec / 60)}m ago`;
  else if (diffSec < 86400) label = `${Math.floor(diffSec / 3600)}h ago`;
  else                      label = `${Math.floor(diffSec / 86400)}d ago`;

  el.textContent = label;
  el.title = `Board last loaded: ${new Date(lastSyncedAt).toLocaleTimeString()}`;

  if (flashUpdated) {
    el.classList.add('sync-stamp--updated');
    setTimeout(() => el.classList.remove('sync-stamp--updated'), 2000);
  }
}

function startSyncStampTicker() {
  if (_syncStampTimer) clearInterval(_syncStampTimer);
  // Tick every 30s so "X min ago" stays accurate without hammering the DOM
  _syncStampTimer = setInterval(() => updateSyncStamp(false), 30_000);
}

// ── 60-second cross-device polling ────────────────────────────
// Polls /api/last-modified every 60s when the tab is active and visible.
// Only does a full re-fetch if the server timestamp has advanced.
// This covers the case of editing on one device and viewing on another
// without needing to manually refresh.
let lastKnownModified = null;

async function pollForChanges() {
  if (document.visibilityState !== 'visible') return;
  try {
    const { t } = await get('/api/last-modified');
    if (t === null) return; // no data yet
    if (lastKnownModified === null) {
      // First poll — just record the current timestamp, don't re-render
      lastKnownModified = t;
      return;
    }
    if (t === lastKnownModified) return; // nothing changed
    // Something changed on the server — do a full silent refresh
    lastKnownModified = t;
    const [columns, tasks, goals, user, bookmarks] = await Promise.all([
      get('/api/columns'),
      get('/api/tasks'),
      get('/api/goals'),
      get('/api/me'),
      get('/api/bookmarks'),
    ]);
    state.columns   = columns;
    state.tasks     = tasks;
    state.goals     = goals;
    state.user      = user;
    state.bookmarks = bookmarks;
    renderUser();
    renderDebugPill();
    renderHiddenTileButton();
    updateGoalsButton();
    renderBoard();
    renderBookmarkList();
    lastSyncedAt = Date.now();
    updateSyncStamp(true); // flash "updated" to signal remote changes arrived
  } catch (_) {
    // Server unreachable — ignore silently, try again next tick
  }
}

setInterval(pollForChanges, 60_000);

// ── Canvas Bookmarks ──────────────────────────────────────────
// Saved views: store x/y/zoom in DB for cross-device sync.

// Smoothly animate the canvas to a target pan/zoom using requestAnimationFrame.
function animateTo(targetX, targetY, targetZoom, durationMs = 400) {
  const startX    = view.panX;
  const startY    = view.panY;
  const startZoom = view.zoom;
  const startTs   = performance.now();
  const clampedZoom = Math.max(view.MIN_ZOOM, Math.min(view.MAX_ZOOM, targetZoom));

  function ease(t) { return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2,3)/2; }

  function frame(now) {
    const t = Math.min((now - startTs) / durationMs, 1);
    const e = ease(t);
    view.panX = startX + (targetX - startX) * e;
    view.panY = startY + (targetY - startY) * e;
    view.zoom = startZoom + (clampedZoom - startZoom) * e;
    applyTransform();
    if (t < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function renderBookmarkList() {
  const list    = document.getElementById('bookmark-list');
  const emptyEl = document.getElementById('bookmark-empty');
  if (!list) return;

  list.innerHTML = '';
  const bm = state.bookmarks || [];

  if (bm.length === 0) {
    emptyEl.classList.remove('hidden');
    return;
  }
  emptyEl.classList.add('hidden');

  bm.forEach((bookmark, idx) => {
    const shortcutNum = idx < 9 ? idx + 1 : null;

    const item = document.createElement('div');
    item.className = 'bookmark-item';
    item.dataset.bookmarkId = bookmark.id;

    const shortcutEl = document.createElement('span');
    shortcutEl.className = 'bookmark-item-shortcut';
    shortcutEl.textContent = shortcutNum ? `⌘${shortcutNum}` : '';
    shortcutEl.title = shortcutNum ? `Press ⌘${shortcutNum} to jump` : '';
    item.appendChild(shortcutEl);

    const nameEl = document.createElement('span');
    nameEl.className = 'bookmark-item-name';
    nameEl.textContent = bookmark.name;
    nameEl.title = bookmark.name;
    item.appendChild(nameEl);

    const actions = document.createElement('span');
    actions.className = 'bookmark-item-actions';

    const renameBtn = document.createElement('button');
    renameBtn.className = 'bookmark-item-btn';
    renameBtn.textContent = '✎';
    renameBtn.title = 'Rename';
    renameBtn.addEventListener('click', async e => { e.stopPropagation(); await renameBookmark(bookmark.id); });
    actions.appendChild(renameBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'bookmark-item-btn danger';
    deleteBtn.textContent = '✕';
    deleteBtn.title = 'Delete bookmark';
    deleteBtn.addEventListener('click', async e => { e.stopPropagation(); await deleteBookmark(bookmark.id); });
    actions.appendChild(deleteBtn);

    item.appendChild(actions);

    item.addEventListener('click', () => { jumpToBookmark(bookmark); closeBookmarkDropdown(); });
    list.appendChild(item);
  });
}

function openBookmarkDropdown() {
  document.getElementById('bookmark-dropdown').classList.remove('hidden');
  document.getElementById('btn-bookmarks').classList.add('active');
}

function closeBookmarkDropdown() {
  document.getElementById('bookmark-dropdown').classList.add('hidden');
  document.getElementById('btn-bookmarks').classList.remove('active');
}

function jumpToBookmark(bookmark) {
  animateTo(bookmark.x, bookmark.y, bookmark.zoom);
}

async function saveBookmark() {
  const name = await paprPrompt('Name this view:', 'View ' + (state.bookmarks.length + 1));
  if (!name || !name.trim()) return;
  try {
    const bookmark = await post('/api/bookmarks', { name: name.trim(), x: view.panX, y: view.panY, zoom: view.zoom });
    state.bookmarks.push(bookmark);
    renderBookmarkList();
  } catch (err) { console.error('Failed to save bookmark:', err); }
}

async function renameBookmark(bookmarkId) {
  const bookmark = state.bookmarks.find(b => b.id === bookmarkId);
  if (!bookmark) return;
  const newName = await paprPrompt('Rename bookmark:', bookmark.name);
  if (!newName || !newName.trim() || newName.trim() === bookmark.name) return;
  try {
    const updated = await patch(`/api/bookmarks/${bookmarkId}`, { name: newName.trim() });
    const idx = state.bookmarks.findIndex(b => b.id === bookmarkId);
    if (idx !== -1) state.bookmarks[idx] = updated;
    renderBookmarkList();
  } catch (err) { console.error('Failed to rename bookmark:', err); }
}

async function deleteBookmark(bookmarkId) {
  const bookmark = state.bookmarks.find(b => b.id === bookmarkId);
  if (!bookmark) return;
  const ok = await paprConfirm(`Delete bookmark "${bookmark.name}"?`, { okLabel: 'Delete', danger: true });
  if (!ok) return;
  try {
    await del(`/api/bookmarks/${bookmarkId}`);
    state.bookmarks = state.bookmarks.filter(b => b.id !== bookmarkId);
    renderBookmarkList();
  } catch (err) { console.error('Failed to delete bookmark:', err); }
}

function bindBookmarkEvents() {
  const btn      = document.getElementById('btn-bookmarks');
  const dropdown = document.getElementById('bookmark-dropdown');
  const saveBtn  = document.getElementById('btn-save-bookmark');
  if (!btn) return;

  btn.addEventListener('click', e => {
    e.stopPropagation();
    if (dropdown.classList.contains('hidden')) openBookmarkDropdown();
    else closeBookmarkDropdown();
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('#bookmark-menu')) closeBookmarkDropdown();
  });

  saveBtn.addEventListener('click', async e => {
    e.stopPropagation();
    closeBookmarkDropdown();
    await saveBookmark();
  });
}

// ── Today smart-tile ─────────────────────────────────────────

let todayTilePos = { top: 60, right: 16, width: 280 }; // viewport-anchored position + width

// Show a brief auto-dismissing toast message (Design Tenet 15: honest feedback)
function showToast(message, durationMs = 2800) {
  // Remove any existing toast first
  document.querySelectorAll('.taskpapr-toast').forEach(t => t.remove());
  const toast = document.createElement('div');
  toast.className = 'taskpapr-toast';
  toast.textContent = message;
  // Click to dismiss early
  toast.addEventListener('click', () => toast.remove());
  document.body.appendChild(toast);
  // Auto-dismiss
  setTimeout(() => {
    toast.classList.add('taskpapr-toast--out');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  }, durationMs);
}

function toggleTodayTile() {
  const flagged = state.tasks.filter(t => t.today_flag && t.status !== 'done').length;

  // If tile is already open, close it regardless of task count
  if (state.showTodayTile) {
    state.showTodayTile = false;
    removeTodayTile();
    syncTodayButton();
    return;
  }

  // No tasks flagged — show toast instead of opening an empty tile
  if (flagged === 0) {
    showToast('No tasks flagged for today — right-click any task to add it.');
    return;
  }

  state.showTodayTile = true;
  renderTodayTile();
  syncTodayButton();
}

function removeTodayTile() {
  const existing = document.getElementById('today-tile');
  if (existing) existing.remove();
}

function renderTodayTile() {
  removeTodayTile();

  const tasks = state.tasks
    .filter(t => t.today_flag && t.status !== 'done')
    .sort((a, b) => {
      // today_order first, then position within tile
      const oa = a.today_order != null ? a.today_order : 9999;
      const ob = b.today_order != null ? b.today_order : 9999;
      return oa - ob || a.position - b.position;
    });

  const tile = document.createElement('div');
  tile.id = 'today-tile';
  tile.className = 'today-tile';
  tile.style.top   = todayTilePos.top  + 'px';
  tile.style.right = todayTilePos.right + 'px';
  tile.style.width = todayTilePos.width + 'px';

  // Header (draggable)
  const header = document.createElement('div');
  header.className = 'today-tile-header';

  const titleEl = document.createElement('span');
  titleEl.className = 'today-tile-title';
  titleEl.textContent = `📅 Today  (${tasks.length})`;
  header.appendChild(titleEl);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'today-tile-close';
  closeBtn.textContent = '✕';
  closeBtn.title = 'Close Today tile (D)';
  closeBtn.addEventListener('click', e => { e.stopPropagation(); state.showTodayTile = false; removeTodayTile(); syncTodayButton(); });
  header.appendChild(closeBtn);

  tile.appendChild(header);

  // Body
  const body = document.createElement('div');
  body.className = 'today-tile-body';

  if (tasks.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'today-tile-empty';
    empty.textContent = 'No tasks flagged for today';
    body.appendChild(empty);
  } else {
    tasks.forEach((task, idx) => {
      const col = state.columns.find(c => c.id === task.column_id);
      const row = document.createElement('div');
      row.className = 'today-task-row';
      row.dataset.taskId = task.id;
      row.dataset.todayIdx = idx;

      // Drag handle
      const handle = document.createElement('span');
      handle.className = 'today-drag-handle';
      handle.textContent = '⠿';
      handle.title = 'Drag to reorder';
      row.appendChild(handle);

      // Checkbox
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.className = 'today-task-check';
      check.checked = false;
      check.title = 'Mark done';
      check.addEventListener('change', async e => {
        e.stopPropagation();
        await toggleDone(task.id, true);
      });
      check.addEventListener('mousedown', e => e.stopPropagation());
      row.appendChild(check);

      // Title
      const titleSpan = document.createElement('span');
      titleSpan.className = 'today-task-title';
      titleSpan.textContent = task.title;
      titleSpan.title = task.title;
      titleSpan.addEventListener('click', () => openNotesPanel(task.id));
      row.appendChild(titleSpan);

      // Tile badge
      if (col) {
        const badge = document.createElement('span');
        badge.className = 'today-task-tile-badge';
        badge.textContent = col.name;
        badge.title = col.name;
        row.appendChild(badge);
      }

      // Unflag button (amber strip click)
      const unflag = document.createElement('button');
      unflag.style.cssText = 'background:none;border:none;cursor:pointer;color:#b45309;font-size:12px;padding:0 2px;flex-shrink:0;opacity:0.5;';
      unflag.textContent = '✕';
      unflag.title = 'Remove from Today';
      unflag.addEventListener('click', async e => {
        e.stopPropagation();
        await toggleTodayFlag(task.id, false);
      });
      unflag.addEventListener('mousedown', e => e.stopPropagation());
      row.appendChild(unflag);

      body.appendChild(row);
    });

    // Simple drag-to-reorder within Today tile
    setupTodayDragReorder(body);
  }

  tile.appendChild(body);
  document.body.appendChild(tile);

  // Make tile draggable (move within viewport) and resizable
  setupTodayTileDrag(tile, header);
  setupTodayTileResize(tile);
}

function setupTodayTileResize(tile) {
  const handle = document.createElement('div');
  handle.className = 'today-tile-resize-handle';
  tile.appendChild(handle);

  // ── Mouse resize ──────────────────────────────────────────
  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    e.stopPropagation();
    const startX     = e.clientX;
    const startWidth = todayTilePos.width;

    const onMove = e => {
      // Tile is right-anchored; dragging the bottom-right handle rightward = wider
      // (tile grows leftward since right edge is fixed)
      const dx = e.clientX - startX;
      todayTilePos.width = Math.max(200, startWidth + dx);
      tile.style.width = todayTilePos.width + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });

  // ── Touch resize ──────────────────────────────────────────
  let touchResizeId    = null;
  let touchResizeStartX = 0;
  let touchResizeStartWidth = 0;

  handle.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    e.stopPropagation();
    const t = e.touches[0];
    touchResizeId         = t.identifier;
    touchResizeStartX     = t.clientX;
    touchResizeStartWidth = todayTilePos.width;
  }, { passive: true });

  handle.addEventListener('touchmove', e => {
    const t = Array.from(e.touches).find(t => t.identifier === touchResizeId);
    if (!t) return;
    e.preventDefault();
    e.stopPropagation();
    // Handle is bottom-right; dragging right = wider (tile grows leftward, right edge fixed)
    const dx = t.clientX - touchResizeStartX;
    todayTilePos.width = Math.max(200, touchResizeStartWidth + dx);
    tile.style.width = todayTilePos.width + 'px';
  }, { passive: false });

  handle.addEventListener('touchend', () => { touchResizeId = null; }, { passive: true });
  handle.addEventListener('touchcancel', () => { touchResizeId = null; }, { passive: true });
}

function setupTodayTileDrag(tile, handle) {
  let startX = 0, startY = 0;
  let startRight = todayTilePos.right, startTop = todayTilePos.top;
  let dragging = false;

  handle.addEventListener('mousedown', e => {
    if (e.target.closest('button')) return;
    e.preventDefault();
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    startRight = todayTilePos.right;
    startTop   = todayTilePos.top;

    const onMove = e => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      todayTilePos.right = Math.max(0, startRight - dx);
      todayTilePos.top   = Math.max(0, startTop   + dy);
      tile.style.right = todayTilePos.right + 'px';
      tile.style.top   = todayTilePos.top   + 'px';
    };
    const onUp = () => {
      dragging = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });
}

function setupTodayDragReorder(body) {
  let dragSrc = null;

  body.addEventListener('dragstart', e => {
    const row = e.target.closest('.today-task-row');
    if (!row) return;
    dragSrc = row;
    e.dataTransfer.effectAllowed = 'move';
  });

  body.addEventListener('dragover', e => {
    e.preventDefault();
    const row = e.target.closest('.today-task-row');
    if (!row || row === dragSrc) return;
    body.querySelectorAll('.today-task-row').forEach(r => r.classList.remove('today-dragging-over'));
    row.classList.add('today-dragging-over');
  });

  body.addEventListener('dragleave', () => {
    body.querySelectorAll('.today-task-row').forEach(r => r.classList.remove('today-dragging-over'));
  });

  body.addEventListener('drop', async e => {
    e.preventDefault();
    body.querySelectorAll('.today-task-row').forEach(r => r.classList.remove('today-dragging-over'));
    const target = e.target.closest('.today-task-row');
    if (!target || !dragSrc || target === dragSrc) return;

    // Reorder rows in DOM
    const rows = Array.from(body.querySelectorAll('.today-task-row'));
    const srcIdx    = rows.indexOf(dragSrc);
    const targetIdx = rows.indexOf(target);
    if (srcIdx < targetIdx) {
      body.insertBefore(dragSrc, target.nextSibling);
    } else {
      body.insertBefore(dragSrc, target);
    }

    // Persist new order
    const newOrder = Array.from(body.querySelectorAll('.today-task-row'))
      .map((r, i) => ({ id: parseInt(r.dataset.taskId), today_order: i }));
    await Promise.all(newOrder.map(({ id, today_order }) =>
      patch(`/api/tasks/${id}`, { today_order }).then(u => updateTaskInState(u)).catch(() => {})
    ));
    dragSrc = null;
  });

  // Make rows draggable via handle
  body.querySelectorAll('.today-task-row').forEach(row => {
    row.draggable = true;
  });
}

// Toggle today_flag on a task
async function toggleTodayFlag(taskId, flagOn) {
  const updated = await patch(`/api/tasks/${taskId}`, {
    today_flag:  flagOn,
    today_order: flagOn ? Date.now() : null,
  });
  updateTaskInState(updated);
  renderBoard();
  if (state.showTodayTile) renderTodayTile();
}

// Context menu today action handler (wired below)
document.getElementById('context-menu').addEventListener('click', async e => {
  // handled in existing listener — we add today here via data-action check below
}, { capture: false }); // won't re-register; handled inside existing block above

// Wire Today header button
(function() {
  const btn = document.getElementById('btn-today');
  if (btn) btn.addEventListener('click', () => toggleTodayTile());
})();

// ── Boot ──────────────────────────────────────────────────────
init();
