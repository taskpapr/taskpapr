'use strict';

const path = require('path');
const { queries, queryRun, transaction } = require('../db');
const { rateLimitWrites } = require('../lib/rateLimits');
const { wakeDormantTasks } = require('../services/dormancy');
const { emitUserChange } = require('../lib/events');

module.exports = function register(app) {

  // ============================================================
  // Export / Import
  // ============================================================

  app.get('/api/export', async (req, res) => {
    const uid = req.user.id;
    const goals   = await queries.goals.all.all(uid);
    const columns = await queries.columns.all.all(uid);
    const tasks   = await queries.tasks.all.all(uid);

    // v2: includes every user-visible field so export → import round-trips
    // without losing tile visibility/scale or task rot/colour/today settings
    // (Design Tenet 5: the board tells the truth). v1 files remain importable.
    const payload = {
      version:           '2',
      exported_at:       new Date().toISOString(),
      taskpapr_version:  require(path.join(__dirname, '..', 'package.json')).version,
      goals: goals.map(g => ({
        title:    g.title,
        notes:    g.notes || null,
        position: g.position,
      })),
      tiles: columns.map(col => ({
        name:     col.name,
        x:        col.x,
        y:        col.y,
        width:    col.width,
        color:    col.color || null,
        position: col.position,
        hidden:   col.hidden ? 1 : 0,
        scale:    col.scale ?? 1,
        tasks:    tasks
          .filter(t => t.column_id === col.id)
          .map(t => {
            const goal = goals.find(g => g.id === t.goal_id);
            return {
              title:                t.title,
              status:               t.status,
              position:             t.position,
              goal:                 goal ? goal.title : null,
              notes:                t.notes       || null,
              next_due:             t.next_due    || null,
              recurrence:           t.recurrence  || null,
              color:                t.color       || null,
              visibility_days:      t.visibility_days ?? 3,
              no_rot:               t.no_rot ? 1 : 0,
              rot_interval:         t.rot_interval || 'weekly',
              today_flag:           t.today_flag ? 1 : 0,
              snooze_until:         t.snooze_until || null,
              last_acknowledged_at: t.last_acknowledged_at || null,
              created_at:           t.created_at,
            };
          }),
      })),
    };

    const date     = new Date().toISOString().slice(0, 10);
    const filename = `taskpapr-export-${date}.json`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.json(payload);
  });

  app.post('/api/import', rateLimitWrites, require('express').json({ limit: '10mb' }), async (req, res) => {
    const uid  = req.user.id;
    const mode = (typeof req.query.mode === 'string' ? req.query.mode : 'merge').toLowerCase();

    if (mode !== 'merge' && mode !== 'replace') {
      return res.status(400).json({ error: 'mode must be "merge" or "replace"' });
    }

    const data = req.body;

    // Basic validation
    if (!data || typeof data !== 'object') {
      return res.status(400).json({ error: 'request body must be a JSON object' });
    }
    if (!Array.isArray(data.tiles)) {
      return res.status(400).json({ error: 'import data must contain a "tiles" array' });
    }

    const counts = { goals: 0, tiles: 0, tasks: 0, skipped: 0 };

    await transaction(async () => {
      // ── Replace mode: wipe everything ──────────────────────
      if (mode === 'replace') {
        // Delete tasks first (FK), then columns, then goals
        await queryRun('DELETE FROM tasks   WHERE user_id = ?', [uid]);
        await queryRun('DELETE FROM columns WHERE user_id = ?', [uid]);
        await queryRun('DELETE FROM goals   WHERE user_id = ?', [uid]);
      }

      // Pre-load existing data once (O(1) per lookup vs O(N) per item in loop)
      const existingGoals = mode === 'merge' ? await queries.goals.all.all(uid) : [];
      const existingCols  = mode === 'merge' ? await queries.columns.all.all(uid) : [];
      const goalsByTitle  = new Map(existingGoals.map(g => [g.title.toLowerCase(), g]));
      const colsByName    = new Map(existingCols.map(c => [c.name.toLowerCase(), c]));

      // ── Import goals ────────────────────────────────────────
      const goalMap = {}; // title → new id

      if (Array.isArray(data.goals)) {
        for (const g of data.goals) {
          if (typeof g.title !== 'string' || !g.title.trim()) { counts.skipped++; continue; }

          if (mode === 'merge') {
            const existing = goalsByTitle.get(g.title.toLowerCase());
            if (existing) { goalMap[g.title] = existing.id; continue; }
          }

          const info = await queries.goals.insert.run(uid, g.title.trim(), (typeof g.notes === 'string' && g.notes) ? g.notes : null, uid);
          goalMap[g.title] = info.id;
          goalsByTitle.set(g.title.toLowerCase(), { id: info.id, title: g.title });
          counts.goals++;
        }
      }

      // ── Import tiles + tasks ────────────────────────────────
      for (const tile of data.tiles) {
        if (typeof tile.name !== 'string' || !tile.name.trim()) { counts.skipped++; continue; }

        let colId;

        if (mode === 'merge') {
          // Reuse existing tile with same name if present
          const existing = colsByName.get(tile.name.toLowerCase());
          if (existing) {
            colId = existing.id;
          } else {
            const info = await queries.columns.insert.run(
              uid, tile.name.trim(), uid,
              tile.x ?? 40, tile.y ?? 40, tile.width ?? 260, tile.color || null
            );
            colId = info.id;
            counts.tiles++;
          }
        } else {
          const info = await queries.columns.insert.run(
            uid, tile.name.trim(), uid,
            tile.x ?? 40, tile.y ?? 40, tile.width ?? 260, tile.color || null
          );
          colId = info.id;
          counts.tiles++;
        }

        // Apply tile-level hidden flag and scale if present (v2 exports)
        if (tile.hidden) {
          await queryRun('UPDATE columns SET hidden = 1 WHERE id = ? AND user_id = ?', [colId, uid]);
        }
        if (typeof tile.scale === 'number' && tile.scale !== 1) {
          const scale = Math.max(0.5, Math.min(2.0, tile.scale));
          await queryRun('UPDATE columns SET scale = ? WHERE id = ? AND user_id = ?', [scale, colId, uid]);
        }

        // Import tasks for this tile
        if (Array.isArray(tile.tasks)) {
          for (const t of tile.tasks) {
            if (typeof t.title !== 'string' || !t.title.trim()) { counts.skipped++; continue; }

            const validStatuses = ['active', 'wip', 'done', 'dormant'];
            const status  = validStatuses.includes(t.status) ? t.status : 'active';
            const goalId  = (t.goal && goalMap[t.goal]) ? goalMap[t.goal] : null;

            const info      = await queries.tasks.insert.run(uid, t.title.trim(), colId, colId, goalId);
            const newTaskId = info.id;

            // Patch status (insert always sets 'active')
            if (status !== 'active') {
              await queries.tasks.updateStatus.run(status, newTaskId, uid);
            }

            // Extended fields — absent in v1 files, so every field falls back
            // to the schema default the insert already produced
            const vd = parseInt(t.visibility_days);
            await queryRun(
              `UPDATE tasks SET
                 notes = ?, next_due = ?, recurrence = ?, color = ?,
                 visibility_days = ?, no_rot = ?, rot_interval = ?,
                 today_flag = ?, snooze_until = ?, last_acknowledged_at = ?
               WHERE id = ? AND user_id = ?`,
              [
                (typeof t.notes      === 'string' && t.notes)      ? t.notes      : null,
                (typeof t.next_due   === 'string' && t.next_due)   ? t.next_due   : null,
                (typeof t.recurrence === 'string' && t.recurrence) ? t.recurrence : null,
                (typeof t.color      === 'string' && t.color)      ? t.color      : null,
                isNaN(vd) ? 3 : vd,
                t.no_rot ? 1 : 0,
                (typeof t.rot_interval === 'string' && t.rot_interval) ? t.rot_interval : 'weekly',
                t.today_flag ? 1 : 0,
                (typeof t.snooze_until === 'string' && t.snooze_until) ? t.snooze_until : null,
                (typeof t.last_acknowledged_at === 'string' && t.last_acknowledged_at) ? t.last_acknowledged_at : null,
                newTaskId, uid,
              ]
            );
            counts.tasks++;
          }
        }
      }
    });

    // Run dormancy check immediately so imported tasks with future due dates
    // get the correct status (dormant/active) without waiting for the hourly tick.
    // Fire-and-forget, but must catch: an unhandled rejection kills the process.
    wakeDormantTasks().catch(err => console.error('[import] dormancy sync failed:', err));

    emitUserChange(uid);

    res.json({ ok: true, mode, imported: counts });
  });

};
