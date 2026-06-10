'use strict';
const { queries, queryRun, sqlNowExpr } = require('../db');
const { advanceDate } = require('../lib/helpers');
const { getTodayStr } = require('../lib/date');

// The single canonical "mark done" path — used by the PATCH route and the
// automation webhook so recurrence behaves identically everywhere
// (Design Tenet 3: one way per action).
//
// Non-recurring: status='done'.
// Recurring: advance next_due from the current due date (or today);
//   visibility_days -1/null = always visible → straight back to 'active'
//   (spinning-plates style), otherwise 'dormant' until the next window.
// Either way the task leaves the Today view: today_flag is cleared
// (today_order is left in place — harmless, reused if the task is un-done).
async function completeTask(task, userId) {
  if (task.recurrence) {
    const nextDue       = advanceDate(task.next_due || getTodayStr(), task.recurrence);
    const alwaysVisible = (task.visibility_days === -1 || task.visibility_days == null);
    const newStatus     = alwaysVisible ? 'active' : 'dormant';
    await queryRun(
      `UPDATE tasks SET status = ?, last_done_at = ${sqlNowExpr()}, next_due = ?, updated_at = ${sqlNowExpr()} WHERE id = ? AND user_id = ?`,
      [newStatus, nextDue, task.id, userId]
    );
  } else {
    await queries.tasks.updateStatus.run('done', task.id, userId);
  }
  await queryRun('UPDATE tasks SET today_flag = 0 WHERE id = ? AND user_id = ?', [task.id, userId]);
}

module.exports = { completeTask };
