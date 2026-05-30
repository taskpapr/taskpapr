'use strict';
const { queries, queryRun, queryAll, sqlNowExpr } = require('../db');
const { getTodayStr } = require('../lib/date');

function shouldBeDormant(t) {
  if (!t.next_due) return false;
  if (t.visibility_days == null || t.visibility_days < 0) return false;
  const todayStr = getTodayStr();
  const vd = isNaN(t.visibility_days) ? 3 : t.visibility_days;
  const wakeDate = new Date(t.next_due + 'T12:00:00Z');
  wakeDate.setUTCDate(wakeDate.getUTCDate() - vd);
  return todayStr < wakeDate.toISOString().slice(0, 10);
}

async function syncDormantState(taskId, userId) {
  const t = await queries.tasks.byId.get(taskId, userId);
  if (!t || t.status === 'done') return;
  if (t.status !== 'dormant' && shouldBeDormant(t)) {
    await queries.tasks.updateStatus.run('dormant', taskId, userId);
  } else if (t.status === 'dormant' && !shouldBeDormant(t)) {
    await queries.tasks.updateStatus.run('active', taskId, userId);
  }
}

// Runs on startup and every hour.
// Two cross-user SELECTs replace per-user loops — O(2) fetches regardless of
// user count, then O(changed tasks) individual UPDATEs.
async function wakeDormantTasks() {
  const todayStr = getTodayStr();
  let woken = 0, slept = 0;

  // Pass 1: wake dormant tasks across all users
  const dormant = await queryAll(`SELECT * FROM tasks WHERE status = 'dormant'`);

  for (const t of dormant) {
    if (t.snooze_until) {
      if (todayStr >= t.snooze_until) {
        await queryRun(
          `UPDATE tasks SET snooze_until = NULL, status = 'active', updated_at = ${sqlNowExpr()} WHERE id = ?`,
          [t.id]
        );
        woken++;
      }
      continue;
    }
    if (!t.next_due) continue;
    if (t.visibility_days === -1) {
      await queries.tasks.updateStatus.run('active', t.id, t.user_id);
      woken++;
      continue;
    }
    const vd = (t.visibility_days == null || isNaN(t.visibility_days)) ? 3 : t.visibility_days;
    const wakeDate = new Date(t.next_due + 'T12:00:00Z');
    wakeDate.setUTCDate(wakeDate.getUTCDate() - vd);
    if (todayStr >= wakeDate.toISOString().slice(0, 10)) {
      await queries.tasks.updateStatus.run('active', t.id, t.user_id);
      woken++;
    }
  }

  // Pass 2: sleep active/wip tasks across all users
  const candidates = await queryAll(
    `SELECT * FROM tasks WHERE status IN ('active','wip') AND next_due IS NOT NULL`
  );
  for (const t of candidates) {
    if (shouldBeDormant(t)) {
      await queries.tasks.updateStatus.run('dormant', t.id, t.user_id);
      slept++;
    }
  }

  if (woken > 0 || slept > 0) {
    console.log(`[dormant] woke ${woken}, slept ${slept} task(s) (today=${todayStr})`);
  }
}

module.exports = { shouldBeDormant, syncDormantState, wakeDormantTasks };
