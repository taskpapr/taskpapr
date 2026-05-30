'use strict';

const { queries } = require('../db');
const { LIMITS, validateLen, asTrimmedString, checkQuota } = require('../lib/helpers');
const { rateLimitWrites } = require('../lib/rateLimits');
const { emitUserChange } = require('../lib/events');

// ============================================================
// Webhook — push-based automation (n8n, IFTTT, Zapier, Make)
// Auth: Authorization: Bearer <api-key>  (same as REST API)
//
// Actions:
//   add_task    { action, title, tile, goal? }
//   complete    { action, title? / id? }
//   mark_wip    { action, title? / id? }
//   delete_task { action, title? / id? }
// ============================================================

module.exports = function register(app) {
  app.post('/api/webhook', rateLimitWrites, async (req, res) => {
    // Must be authenticated via API key — session auth is NOT sufficient for webhooks.
    // This prevents any process that can reach port 3033 from pushing tasks without a key,
    // even in single-user mode where req.user is always pre-populated.
    if (!req.apiKeyAuthenticated) return res.status(401).json({ error: 'unauthorized — provide Authorization: Bearer <api-key>' });

    const uid = req.user.id;
    const { action, title, tile, goal, id } = req.body || {};

    if (!action) return res.status(400).json({ error: 'action required' });

    // ── add_task ────────────────────────────────────────────
    if (action === 'add_task') {
      const titleTrim = asTrimmedString(title);
      const tileTrim  = asTrimmedString(tile);
      if (!titleTrim) return res.status(400).json({ error: 'title required' });
      if (!tileTrim)  return res.status(400).json({ error: 'tile required' });

      const titleLenErr = validateLen(titleTrim, LIMITS.titleLen, 'Task title');
      if (titleLenErr) return res.status(400).json({ error: titleLenErr });
      const quotaErr = await checkQuota('tasks', 'user_id', uid, LIMITS.tasks, 'Task');
      if (quotaErr) return res.status(429).json({ error: quotaErr });

      // Find tile by case-insensitive partial name match
      const allCols = await queries.columns.all.all(uid);
      const tileLower = tileTrim.toLowerCase();
      const col = allCols.find(c => c.name.toLowerCase().includes(tileLower));
      if (!col) {
        return res.status(404).json({
          error: `tile not found: "${tileTrim}"`,
          available: allCols.map(c => c.name),
        });
      }

      // Optional goal association
      let goalId = null;
      if (goal) {
        const allGoals = await queries.goals.all.all(uid);
        const goalStr = (typeof goal === 'string') ? goal : String(goal);
        const g = allGoals.find(g => g.title.toLowerCase().includes(goalStr.toLowerCase()));
        if (g) goalId = g.id;
      }

      const info = await queries.tasks.insert.run(uid, titleTrim, col.id, col.id, goalId);
      const task = await queries.tasks.byId.get(info.id, uid);
      emitUserChange(uid);
      return res.json({ ok: true, task });
    }

    // ── complete / mark_wip / delete_task ───────────────────
    if (action === 'complete' || action === 'mark_wip' || action === 'delete_task') {
      if (!id && !title) return res.status(400).json({ error: 'provide id or title' });

      const allTasks = await queries.tasks.all.all(uid);
      const task = id
        ? allTasks.find(t => t.id === parseInt(id))
        : allTasks.find(t => t.title.toLowerCase().includes(title.toLowerCase()) && t.status !== 'done');

      if (!task) {
        return res.status(404).json({ error: `task not found: ${id ? `id ${id}` : `"${title}"`}` });
      }

      if (action === 'complete') {
        await queries.tasks.updateStatus.run('done', task.id, uid);
        emitUserChange(uid);
        return res.json({ ok: true, task: { ...task, status: 'done' } });
      }
      if (action === 'mark_wip') {
        await queries.tasks.updateStatus.run('wip', task.id, uid);
        emitUserChange(uid);
        return res.json({ ok: true, task: { ...task, status: 'wip' } });
      }
      if (action === 'delete_task') {
        await queries.tasks.delete.run(task.id, uid);
        emitUserChange(uid);
        return res.json({ ok: true, deleted: task });
      }
    }

    return res.status(400).json({
      error: `unknown action: "${action}"`,
      supported: ['add_task', 'complete', 'mark_wip', 'delete_task'],
    });
  });
};
