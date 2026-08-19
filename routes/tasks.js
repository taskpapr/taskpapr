'use strict';

const { queries, queryOne, queryRun, queryAll, transaction, sqlNowExpr } = require('../db');
const { LIMITS, validateLen, asTrimmedString, checkQuota } = require('../lib/helpers');
const { getTodayStr, getNow } = require('../lib/date');
const { syncDormantState } = require('../services/dormancy');
const { completeTask } = require('../services/tasks');
const { rateLimitWrites } = require('../lib/rateLimits');
const { emitUserChange } = require('../lib/events');

module.exports = function register(app) {

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
      ) AS sub
    `, [uid, uid]);
    res.json({ t: row?.t || null });
  });

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
    const destCol = await queries.columns.byId.get(column_id, uid);
    if (!destCol) return res.status(403).json({ error: 'forbidden' });
    const info = await queries.tasks.insert.run(uid, titleTrim, column_id, column_id, goal_id || null);
    emitUserChange(uid);
    res.json(await queries.tasks.byId.get(info.id, uid));
  });

  app.patch('/api/tasks/:id', async (req, res) => {
    const id  = parseInt(req.params.id);
    const uid = req.user.id;
    const { status, title, goal_id, position, column_id } = req.body;

    // ── 1. Type-check inputs before any DB access ────────────────
    if (title !== undefined && typeof title !== 'string') {
      return res.status(400).json({ error: 'title must be a string' });
    }

    // Pre-parse all optional fields so validation runs before any SQL
    const titleTrimmed   = title     !== undefined ? title.trim()              : undefined;
    const nextNotes      = req.body.notes        !== undefined ? (req.body.notes        || null) : undefined;
    const nextDue        = req.body.next_due      !== undefined ? (req.body.next_due      || null) : undefined;
    const nextSnoozeUntil = req.body.snooze_until !== undefined ? (req.body.snooze_until  || null) : undefined;
    const nextRecurrence = req.body.recurrence    !== undefined ? (req.body.recurrence    || null) : undefined;
    const vdParsed       = req.body.visibility_days !== undefined ? parseInt(req.body.visibility_days) : undefined;
    const nextVd         = vdParsed  !== undefined ? (isNaN(vdParsed) ? 3 : vdParsed)  : undefined;
    const nextNoRot      = req.body.no_rot        !== undefined ? (req.body.no_rot        ? 1 : 0)  : undefined;
    const nextRot        = req.body.rot_interval  !== undefined ? (req.body.rot_interval  || 'weekly') : undefined;
    const nextColor      = req.body.color         !== undefined ? (req.body.color         || null) : undefined;
    const nextFlag       = req.body.today_flag    !== undefined ? (req.body.today_flag    ? 1 : 0)  : undefined;
    const ordParsed      = req.body.today_order   !== undefined && req.body.today_order !== null
      ? parseInt(req.body.today_order) : req.body.today_order;
    const nextOrd        = req.body.today_order   !== undefined ? (isNaN(ordParsed) ? null : (ordParsed ?? null)) : undefined;

    // ── 2. Length validation before any SQL ──────────────────────
    if (titleTrimmed !== undefined) {
      const lenErr = validateLen(titleTrimmed, LIMITS.titleLen, 'Task title');
      if (lenErr) return res.status(400).json({ error: lenErr });
    }
    if (nextNotes !== undefined && nextNotes !== null) {
      const notesLenErr = validateLen(nextNotes, LIMITS.notesLen, 'Notes');
      if (notesLenErr) return res.status(400).json({ error: notesLenErr });
    }

    // ── 3. Load current task + verify column ownership ───────────
    const needsCurrent =
      status !== undefined || title !== undefined || goal_id !== undefined ||
      position !== undefined || column_id !== undefined || nextNotes !== undefined ||
      nextDue !== undefined || nextRecurrence !== undefined || nextVd !== undefined ||
      nextNoRot !== undefined || nextRot !== undefined || nextColor !== undefined ||
      nextFlag !== undefined || nextOrd !== undefined || nextSnoozeUntil !== undefined || req.body._ack;
    const current = needsCurrent ? await queries.tasks.byId.get(id, uid) : null;
    if (needsCurrent && !current) return res.status(404).json({ error: 'task not found' });

    if (position !== undefined && column_id !== undefined) {
      const destCol = await queries.columns.byId.get(column_id, uid);
      if (!destCol) return res.status(403).json({ error: 'forbidden' });
    }

    // Setting a new snooze (not clearing) on an already-done task makes no
    // sense — mirrors the same check in POST /api/tasks/:id/snooze.
    if (nextSnoozeUntil !== undefined && nextSnoozeUntil && current.status === 'done') {
      return res.status(400).json({ error: 'cannot snooze a completed task' });
    }

    // ── 4. All mutations in a single transaction ─────────────────
    // Validation is complete — no early returns inside the transaction block.
    await transaction(async () => {
      if (status !== undefined) {
        if (status === 'done') {
          await completeTask(current, uid);
        } else {
          await queries.tasks.updateStatus.run(status, id, uid);
        }
      }
      if (titleTrimmed !== undefined && titleTrimmed && titleTrimmed !== current.title) {
        await queries.tasks.updateTitle.run(titleTrimmed, id, uid);
      }
      if (goal_id !== undefined) {
        const goalVal = (goal_id === null || goal_id === '') ? null : goal_id;
        if ((current.goal_id ?? null) !== (goalVal ?? null)) {
          await queries.tasks.updateGoal.run(goalVal, id, uid);
        }
      }
      if (nextNotes !== undefined && (current.notes || null) !== nextNotes) {
        await queryRun(`UPDATE tasks SET notes = ?, updated_at = ${sqlNowExpr()} WHERE id = ? AND user_id = ?`, [nextNotes, id, uid]);
      }
      if (nextDue !== undefined && (current.next_due || null) !== nextDue) {
        await queryRun(`UPDATE tasks SET next_due = ?, updated_at = ${sqlNowExpr()} WHERE id = ? AND user_id = ?`, [nextDue, id, uid]);
        await syncDormantState(id, uid);
      }
      // snooze_until is a distinct mechanism from next_due/visibility_days-based
      // dormancy (see services/dormancy.js) — it's handled by its own branch in
      // wakeDormantTasks(), which only scans status='dormant' rows. So, mirroring
      // POST /api/tasks/:id/snooze, setting a new snooze date also flips status
      // to 'dormant' directly here. We deliberately do NOT call syncDormantState()
      // afterward: it judges dormancy purely off next_due/visibility_days and would
      // immediately flip status back to 'active' for a task with no next_due,
      // undoing the snooze. Clearing snooze_until (setting it to null) leaves
      // status untouched — callers/the sweep own status transitions from there.
      if (nextSnoozeUntil !== undefined && (current.snooze_until || null) !== nextSnoozeUntil) {
        if (nextSnoozeUntil) {
          await queryRun(`UPDATE tasks SET snooze_until = ?, status = 'dormant', updated_at = ${sqlNowExpr()} WHERE id = ? AND user_id = ?`, [nextSnoozeUntil, id, uid]);
        } else {
          await queryRun(`UPDATE tasks SET snooze_until = ?, updated_at = ${sqlNowExpr()} WHERE id = ? AND user_id = ?`, [nextSnoozeUntil, id, uid]);
        }
      }
      if (nextRecurrence !== undefined && (current.recurrence || null) !== nextRecurrence) {
        await queryRun(`UPDATE tasks SET recurrence = ?, updated_at = ${sqlNowExpr()} WHERE id = ? AND user_id = ?`, [nextRecurrence, id, uid]);
      }
      if (nextVd !== undefined && (current.visibility_days ?? 3) !== nextVd) {
        await queryRun(`UPDATE tasks SET visibility_days = ?, updated_at = ${sqlNowExpr()} WHERE id = ? AND user_id = ?`, [nextVd, id, uid]);
        await syncDormantState(id, uid);
      }
      if (nextNoRot !== undefined && (current.no_rot ? 1 : 0) !== nextNoRot) {
        await queryRun(`UPDATE tasks SET no_rot = ?, updated_at = ${sqlNowExpr()} WHERE id = ? AND user_id = ?`, [nextNoRot, id, uid]);
      }
      if (nextRot !== undefined && (current.rot_interval || 'weekly') !== nextRot) {
        await queryRun(`UPDATE tasks SET rot_interval = ?, updated_at = ${sqlNowExpr()} WHERE id = ? AND user_id = ?`, [nextRot, id, uid]);
      }
      if (nextColor !== undefined && (current.color || null) !== nextColor) {
        await queryRun(`UPDATE tasks SET color = ?, updated_at = ${sqlNowExpr()} WHERE id = ? AND user_id = ?`, [nextColor, id, uid]);
      }
      if (nextFlag !== undefined && (current.today_flag ? 1 : 0) !== nextFlag) {
        await queryRun(`UPDATE tasks SET today_flag = ?, updated_at = ${sqlNowExpr()} WHERE id = ? AND user_id = ?`, [nextFlag, id, uid]);
      }
      if (nextOrd !== undefined && (current.today_order ?? null) !== nextOrd) {
        await queryRun(`UPDATE tasks SET today_order = ?, updated_at = ${sqlNowExpr()} WHERE id = ? AND user_id = ?`, [nextOrd, id, uid]);
      }
      // Only an explicit Touch action (_ack) bumps last_acknowledged_at.
      // Saving notes or title is a content edit, not a deliberate "touch".
      if (req.body._ack) {
        await queryRun(`UPDATE tasks SET last_acknowledged_at = ${sqlNowExpr()}, updated_at = ${sqlNowExpr()} WHERE id = ? AND user_id = ?`, [id, uid]);
      }
      if (position !== undefined && column_id !== undefined) {
        await queries.tasks.updatePosition.run(position, column_id, id, uid);
      }
    });

    emitUserChange(uid);
    res.json(await queries.tasks.byId.get(id, uid));
  });

  app.delete('/api/tasks/:id', async (req, res) => {
    const uid = req.user.id;
    await queries.tasks.delete.run(parseInt(req.params.id), uid);
    emitUserChange(uid);
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
    emitUserChange(uid);
    res.json({ ok: true });
  });

  app.post('/api/tasks/reorder', async (req, res) => {
    const uid   = req.user.id;
    const items = req.body;

    if (!Array.isArray(items)) {
      return res.status(400).json({ error: 'body must be an array of {id, position, column_id}' });
    }
    if (items.length > LIMITS.tasks) {
      return res.status(400).json({ error: `too many items (max ${LIMITS.tasks})` });
    }

    const parsed = [];
    for (const item of items) {
      const id        = parseInt(item?.id);
      const position  = parseInt(item?.position);
      const column_id = parseInt(item?.column_id);
      if (isNaN(id) || isNaN(position) || isNaN(column_id)) {
        return res.status(400).json({ error: 'each item needs integer id, position, column_id' });
      }
      parsed.push({ id, position, column_id });
    }

    // Every referenced column must belong to the caller — otherwise a user
    // could point their tasks at another user's columns.
    const colIds = [...new Set(parsed.map(i => i.column_id))];
    for (const colId of colIds) {
      const col = await queries.columns.byId.get(colId, uid);
      if (!col) return res.status(403).json({ error: 'forbidden' });
    }

    const stmt = queries.tasks.updatePosition;
    await transaction(async () => {
      for (const item of parsed) {
        await stmt.run(item.position, item.column_id, item.id, uid);
      }
    });
    emitUserChange(uid);
    res.json({ ok: true });
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

    emitUserChange(uid);
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
    emitUserChange(uid);
    res.json(await queries.tasks.byId.get(id, uid));
  });

  // Snooze task — hide for 24h without touching next_due.
  // Sets status=dormant and snooze_until=tomorrow.
  // wakeDormantTasks() wakes it when today >= snooze_until and clears the field.
  app.post('/api/tasks/:id/snooze', async (req, res) => {
    const id  = parseInt(req.params.id);
    const uid = req.user.id;
    const task = await queries.tasks.byId.get(id, uid);
    if (!task) return res.status(404).json({ error: 'task not found' });
    if (task.status === 'done') return res.status(400).json({ error: 'cannot snooze a completed task' });

    const tomorrowMs = new Date(getNow());
    tomorrowMs.setUTCDate(tomorrowMs.getUTCDate() + 1);
    const tomorrowStr = tomorrowMs.toISOString().slice(0, 10);

    await queryRun(`UPDATE tasks SET snooze_until = ?, status = 'dormant', updated_at = ${sqlNowExpr()} WHERE id = ? AND user_id = ?`, [tomorrowStr, id, uid]);

    emitUserChange(uid);
    res.json(await queries.tasks.byId.get(id, uid));
  });

};
