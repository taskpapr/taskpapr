#!/usr/bin/env node
/**
 * taskpapr MCP smoke test
 *
 * Drives the real mcp/server.js over actual MCP stdio (the same transport
 * Claude Desktop and other MCP clients use) against a throwaway HTTP server
 * + scoped SQLite DB, exercising the happy path of all 16 MCP tools plus
 * the safety-behavior assertions around delete_task confirmation, add_task
 * duplicate detection, and ambiguous title_match rejection.
 *
 * Usage: node test/mcp-smoke.js
 *        (or: bash test/mcp-smoke.sh)
 *
 * Exit code: 0 = all passed, 1 = one or more failures.
 */

'use strict';

const path          = require('path');
const fs            = require('fs');
const os            = require('os');
const { spawn, execSync } = require('child_process');

const { Client }               = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const REPO_ROOT = path.join(__dirname, '..');

// ── Colours (matches test/smoke.sh style) ───────────────────────
const GREEN  = '\x1b[0;32m';
const RED    = '\x1b[0;31m';
const YELLOW = '\x1b[1;33m';
const NC     = '\x1b[0m';

let PASS = 0;
let FAIL = 0;
const ERRORS = [];

function ok(label) {
  console.log(`  ${GREEN}✓${NC}  ${label}`);
  PASS++;
}

function fail(label) {
  console.log(`  ${RED}✗${NC}  ${label}`);
  FAIL++;
  ERRORS.push(label);
}

function info(label) {
  console.log(`  ${YELLOW}→${NC}  ${label}`);
}

function section(title) {
  console.log('');
  console.log(`── ${title} ─`.padEnd(44, '─'));
}

function assertTrue(label, cond, detail) {
  if (cond) {
    ok(label);
  } else {
    fail(detail ? `${label} — ${detail}` : label);
  }
}

function assertIncludes(label, haystack, needle) {
  const hay = String(haystack ?? '');
  if (hay.includes(needle)) {
    ok(label);
  } else {
    fail(`${label} — expected to find ${JSON.stringify(needle)} in: ${hay.slice(0, 300)}`);
  }
}

function assertNotIncludes(label, haystack, needle) {
  const hay = String(haystack ?? '');
  if (!hay.includes(needle)) {
    ok(label);
  } else {
    fail(`${label} — did NOT expect to find ${JSON.stringify(needle)} in: ${hay.slice(0, 300)}`);
  }
}

function assertEquals(label, expected, actual) {
  if (expected === actual) {
    ok(`${label} (${JSON.stringify(actual)})`);
  } else {
    fail(`${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ── Port + DB path scoping ──────────────────────────────────────
function isPortFree(port) {
  try {
    const out = execSync(`lsof -ti:${port}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return out === '';
  } catch {
    // Non-zero exit from lsof means nothing is listening on that port.
    return true;
  }
}

function findFreePort() {
  for (let port = 3100; port <= 3199; port++) {
    if (isPortFree(port)) return port;
  }
  throw new Error('No free port found in range 3100-3199');
}

// ── HTTP helpers against the throwaway server (fixture setup) ──
function apiUrl(base, p) {
  return `${base}${p}`;
}

async function apiGet(base, p) {
  const res = await fetch(apiUrl(base, p));
  if (!res.ok) throw new Error(`GET ${p} -> ${res.status}`);
  return res.json();
}

async function apiPost(base, p, body) {
  const res = await fetch(apiUrl(base, p), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error(`POST ${p} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── Wait for server readiness ───────────────────────────────────
async function waitForServer(base, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(apiUrl(base, '/health'));
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

// ── Tool call helper ─────────────────────────────────────────────
async function callTool(client, name, args) {
  const result = await client.callTool({ name, arguments: args || {} });
  const text = (result.content || []).map(c => c.text || '').join('\n');
  return { result, text };
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  const port    = findFreePort();
  const base    = `http://localhost:${port}`;
  const dbPath  = path.join(os.tmpdir(), `taskpapr-mcp-smoke-${process.pid}-${Date.now()}.db`);

  console.log('');
  console.log('taskpapr MCP smoke test');
  console.log(`Server: ${base}  DB: ${dbPath}`);
  console.log('─'.repeat(44));

  let serverProc = null;
  let mcpClient  = null;
  let mcpTransport = null;

  try {
    // ── Spawn throwaway server ────────────────────────────────
    section('Bootstrap');
    info(`Starting throwaway server on port ${port}`);
    serverProc = spawn('node', ['server.js'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        DB_PATH: dbPath,
        SINGLE_USER_MODE: 'true',
        // Fixture setup + all 16 tools' calls add up to well over the
        // default 30 writes/min — this is a throwaway instance so a high
        // ceiling is safe and keeps the test from flaking under the
        // production-tuned default.
        RATE_LIMIT_WRITES: '2000',
        RATE_LIMIT_GLOBAL: '5000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let serverOutput = '';
    serverProc.stdout.on('data', d => { serverOutput += d.toString(); });
    serverProc.stderr.on('data', d => { serverOutput += d.toString(); });
    serverProc.on('exit', (code, signal) => {
      if (code !== null && code !== 0) {
        process.stderr.write(`[mcp-smoke] server.js exited early (code ${code}, signal ${signal})\n${serverOutput}\n`);
      }
    });

    const ready = await waitForServer(base);
    assertTrue('Throwaway server became ready', ready, `server did not respond on ${base}/health within timeout. Output:\n${serverOutput}`);
    if (!ready) throw new Error('Server did not become ready — aborting.');

    // ── API key bootstrap (same pattern as test/smoke.sh) ─────
    const keyResp = await apiPost(base, '/api/keys', { name: 'mcp-smoke-test-key' });
    const apiKey  = keyResp.key;
    assertTrue('Created API key via POST /api/keys', !!apiKey, `response: ${JSON.stringify(keyResp)}`);
    if (!apiKey) throw new Error('Could not obtain API key — aborting.');

    // ── Fixture seed (direct API — known baseline state) ──────
    section('Fixture seed');

    const columns = await apiGet(base, '/api/columns');
    const workTile = columns.find(c => c.name === 'Work');
    assertTrue('Default "Work" tile exists (single-user seed)', !!workTile);

    const secondTile = await apiPost(base, '/api/columns', { name: 'Smoke Second Tile', x: 5000, y: 5000 });
    assertTrue('Created second tile via API', !!secondTile.id);

    // Two same-substring tasks in different tiles — used to exercise every
    // "ambiguous title_match" safety path below without ever mutating them.
    const ambigA = await apiPost(base, '/api/tasks', { title: 'Ambiguous Item A', column_id: workTile.id });
    const ambigB = await apiPost(base, '/api/tasks', { title: 'Ambiguous Item B', column_id: secondTile.id });
    assertTrue('Seeded ambiguous-pair task A', !!ambigA.id);
    assertTrue('Seeded ambiguous-pair task B', !!ambigB.id);

    info(`Work tile id=${workTile.id}, second tile id=${secondTile.id}`);
    info(`Ambiguous pair ids: A=${ambigA.id} B=${ambigB.id}`);

    // ── Connect real MCP stdio client to mcp/server.js ─────────
    section('MCP connect');
    mcpTransport = new StdioClientTransport({
      command: 'node',
      args: [path.join(REPO_ROOT, 'mcp', 'server.js')],
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        TASKPAPR_URL: base,
        TASKPAPR_API_KEY: apiKey,
      },
      stderr: 'pipe',
    });

    mcpClient = new Client({ name: 'mcp-smoke-test-client', version: '1.0.0' });
    await mcpClient.connect(mcpTransport);
    ok('MCP client connected to mcp/server.js over stdio');

    const toolsList = await mcpClient.listTools();
    const toolNames = new Set(toolsList.tools.map(t => t.name));
    const expectedTools = [
      'get_board_summary', 'list_tiles', 'list_tasks', 'add_task', 'complete_task',
      'mark_wip', 'delete_task', 'list_goals', 'add_goal', 'update_task',
      'search_tasks', 'append_task_note', 'snooze_task', 'list_today_tasks',
      'add_task_to_today', 'remove_task_from_today', 'reorder_today_tasks',
    ];
    // The issue text says "16 tools" but its own enumeration is 9 pre-existing +
    // 8 new from the #24 batch = 17 ("duplicate detection in add_task" is a
    // behavior, not a separate tool) — assert against that enumerated list
    // rather than hardcoding a count that contradicts it.
    assertEquals(`Server exposes exactly ${expectedTools.length} tools (9 pre-existing + 8 new from #24)`, expectedTools.length, toolsList.tools.length);
    for (const name of expectedTools) {
      assertTrue(`Tool registered: ${name}`, toolNames.has(name));
    }

    // ── get_board_summary ───────────────────────────────────────
    section('get_board_summary');
    {
      const { text } = await callTool(mcpClient, 'get_board_summary', {});
      assertIncludes('get_board_summary returns a board summary heading', text, '# Board summary');
      assertIncludes('get_board_summary lists the Work tile', text, 'Work');
    }

    // ── list_tiles ───────────────────────────────────────────────
    section('list_tiles');
    {
      const { text } = await callTool(mcpClient, 'list_tiles', {});
      const parsed = JSON.parse(text);
      assertTrue('list_tiles returns an array', Array.isArray(parsed));
      assertTrue('list_tiles includes the Work tile', parsed.some(t => t.name === 'Work'));
      assertTrue('list_tiles includes the second tile', parsed.some(t => t.name === 'Smoke Second Tile'));
    }

    // ── add_task happy path ───────────────────────────────────────
    section('add_task');
    let groceriesId;
    {
      const { text } = await callTool(mcpClient, 'add_task', { title: 'Buy groceries', tile: 'Work' });
      assertIncludes('add_task happy path succeeds', text, '✓ Task added to "Work"');
      const m = text.match(/id:\s*(\d+)/);
      groceriesId = m ? parseInt(m[1], 10) : null;
      assertTrue('add_task returns a new task id', !!groceriesId);
    }

    // ── add_task: duplicate detection (blocked by default) ────────
    {
      const tasksBefore = await apiGet(base, '/api/tasks');
      const countBefore = tasksBefore.filter(t => t.column_id === workTile.id && t.title === 'Buy groceries').length;

      const { text } = await callTool(mcpClient, 'add_task', { title: 'Buy groceries', tile: 'Work' });
      assertIncludes('add_task blocks exact-match duplicate by default', text, 'Possible duplicate');
      assertIncludes('add_task duplicate message says task not created', text, 'Task not created');

      const tasksAfter = await apiGet(base, '/api/tasks');
      const countAfter = tasksAfter.filter(t => t.column_id === workTile.id && t.title === 'Buy groceries').length;
      assertEquals('Duplicate block did not create a new task', countBefore, countAfter);
    }

    // ── add_task: allow_duplicate bypass ───────────────────────────
    {
      const { text } = await callTool(mcpClient, 'add_task', { title: 'Buy groceries', tile: 'Work', allow_duplicate: true });
      assertIncludes('add_task allow_duplicate:true bypasses the check', text, '✓ Task added to "Work"');

      const tasksAfter = await apiGet(base, '/api/tasks');
      const dupCount = tasksAfter.filter(t => t.column_id === workTile.id && t.title === 'Buy groceries').length;
      assertEquals('allow_duplicate:true actually created a second matching task', 2, dupCount);
    }

    // ── complete_task ────────────────────────────────────────────
    section('complete_task / mark_wip');
    const completeTarget = await apiPost(base, '/api/tasks', { title: 'Task to complete', column_id: workTile.id });
    {
      const { text } = await callTool(mcpClient, 'complete_task', { title: 'Task to complete' });
      assertIncludes('complete_task marks task done', text, '✓ Marked as done');
      const tasks = await apiGet(base, '/api/tasks');
      const t = tasks.find(x => x.id === completeTarget.id);
      assertEquals('Task status is done after complete_task', 'done', t.status);
    }

    // ── mark_wip ─────────────────────────────────────────────────
    const wipTarget = await apiPost(base, '/api/tasks', { title: 'Task to wip', column_id: workTile.id });
    {
      const { text } = await callTool(mcpClient, 'mark_wip', { title: 'Task to wip' });
      assertIncludes('mark_wip marks task WIP', text, '✓ Marked as WIP');
      const tasks = await apiGet(base, '/api/tasks');
      const t = tasks.find(x => x.id === wipTarget.id);
      assertEquals('Task status is wip after mark_wip', 'wip', t.status);
    }

    // ── list_tasks ───────────────────────────────────────────────
    section('list_tasks');
    {
      const { text } = await callTool(mcpClient, 'list_tasks', { tile: 'Work', status: 'all' });
      const parsed = JSON.parse(text);
      assertTrue('list_tasks(tile=Work, status=all) returns an array', Array.isArray(parsed));
      assertTrue('list_tasks includes "Buy groceries"', parsed.some(t => t.title === 'Buy groceries'));
    }

    // ── add_goal / list_goals ─────────────────────────────────────
    section('add_goal / list_goals');
    {
      const { text } = await callTool(mcpClient, 'add_goal', { title: 'Smoke Goal' });
      assertIncludes('add_goal creates a goal', text, '✓ Goal created');
    }
    {
      const { text } = await callTool(mcpClient, 'list_goals', {});
      const parsed = JSON.parse(text);
      assertTrue('list_goals returns an array', Array.isArray(parsed));
      const goal = parsed.find(g => g.title === 'Smoke Goal');
      assertTrue('list_goals includes "Smoke Goal"', !!goal);
    }

    // ── add_task with goal association ────────────────────────────
    const goalTaskResp = await callTool(mcpClient, 'add_task', { title: 'Task with goal', tile: 'Work', goal: 'Smoke Goal' });
    assertIncludes('add_task with goal succeeds', goalTaskResp.text, '✓ Task added to "Work"');

    // ── search_tasks ─────────────────────────────────────────────
    section('search_tasks');
    {
      const { text } = await callTool(mcpClient, 'search_tasks', { query: 'Task with goal' });
      const parsed = JSON.parse(text);
      assertTrue('search_tasks finds the seeded task', Array.isArray(parsed) && parsed.length > 0);
      const found = parsed.find(t => t.title === 'Task with goal');
      assertTrue('search_tasks result carries the goal title', !!found && found.goal === 'Smoke Goal');
    }
    {
      const { text } = await callTool(mcpClient, 'search_tasks', { query: 'zzz-no-such-task-zzz' });
      assertIncludes('search_tasks reports no matches for a nonsense query', text, 'No matches');
    }

    // ── update_task happy path ─────────────────────────────────────
    section('update_task');
    const updateTarget = await apiPost(base, '/api/tasks', { title: 'Task to update', column_id: workTile.id });
    {
      const { text } = await callTool(mcpClient, 'update_task', {
        title_match: 'Task to update',
        title: 'Task updated title',
        status: 'wip',
      });
      assertIncludes('update_task reports the rename', text, 'title → "Task updated title"');
      assertIncludes('update_task reports the status change', text, 'status → wip');

      const tasks = await apiGet(base, '/api/tasks');
      const t = tasks.find(x => x.id === updateTarget.id);
      assertEquals('update_task actually renamed the task', 'Task updated title', t.title);
      assertEquals('update_task actually changed status', 'wip', t.status);
    }

    // ── update_task: ambiguous title_match rejected ────────────────
    {
      const { text } = await callTool(mcpClient, 'update_task', { title_match: 'Ambiguous Item', title: 'should not apply' });
      assertIncludes('update_task rejects ambiguous title_match', text, 'ambiguous, nothing updated');
      assertIncludes('update_task ambiguous response lists both candidates', text, String(ambigA.id));
      assertIncludes('update_task ambiguous response lists both candidates (2)', text, String(ambigB.id));

      const tasks = await apiGet(base, '/api/tasks');
      const a = tasks.find(x => x.id === ambigA.id);
      const b = tasks.find(x => x.id === ambigB.id);
      assertEquals('Ambiguous task A untouched by update_task', 'Ambiguous Item A', a.title);
      assertEquals('Ambiguous task B untouched by update_task', 'Ambiguous Item B', b.title);
    }

    // ── append_task_note happy path ─────────────────────────────────
    section('append_task_note');
    const noteTarget = await apiPost(base, '/api/tasks', { title: 'Note task', column_id: workTile.id });
    {
      const { text } = await callTool(mcpClient, 'append_task_note', { title_match: 'Note task', note: 'first appended note' });
      assertIncludes('append_task_note succeeds', text, '✓ Appended note');
      assertIncludes('append_task_note mentions provenance marker', text, 'via MCP,');

      const tasks = await apiGet(base, '/api/tasks');
      const t = tasks.find(x => x.id === noteTarget.id);
      assertIncludes('Task notes now contain the provenance marker', t.notes, '— via MCP,');
      assertIncludes('Task notes now contain the appended text', t.notes, 'first appended note');
    }

    // ── append_task_note: ambiguous title_match rejected ─────────────
    {
      const { text } = await callTool(mcpClient, 'append_task_note', { title_match: 'Ambiguous Item', note: 'should not apply' });
      assertIncludes('append_task_note rejects ambiguous title_match', text, 'ambiguous, nothing appended');

      const tasks = await apiGet(base, '/api/tasks');
      const a = tasks.find(x => x.id === ambigA.id);
      const b = tasks.find(x => x.id === ambigB.id);
      assertTrue('Ambiguous task A notes still empty', !a.notes);
      assertTrue('Ambiguous task B notes still empty', !b.notes);
    }

    // ── snooze_task happy path (default 24h) ─────────────────────────
    section('snooze_task');
    const snoozeTarget = await apiPost(base, '/api/tasks', { title: 'Snooze task', column_id: workTile.id });
    {
      const { text } = await callTool(mcpClient, 'snooze_task', { title_match: 'Snooze task' });
      assertIncludes('snooze_task default snooze succeeds', text, '✓ Snoozed task');

      const tasks = await apiGet(base, '/api/tasks');
      const t = tasks.find(x => x.id === snoozeTarget.id);
      assertTrue('snooze_task set a snooze_until date', !!t.snooze_until);
      assertEquals('snooze_task set status to dormant', 'dormant', t.status);
    }

    // ── snooze_task with explicit duration ────────────────────────────
    {
      const { text } = await callTool(mcpClient, 'snooze_task', { title_match: 'Snooze task', days: 3 });
      assertIncludes('snooze_task with days= succeeds', text, '✓ Snoozed task');
    }

    // ── snooze_task: ambiguous title_match rejected ────────────────────
    {
      const { text } = await callTool(mcpClient, 'snooze_task', { title_match: 'Ambiguous Item' });
      assertIncludes('snooze_task rejects ambiguous title_match', text, 'ambiguous, nothing snoozed');

      const tasks = await apiGet(base, '/api/tasks');
      const a = tasks.find(x => x.id === ambigA.id);
      const b = tasks.find(x => x.id === ambigB.id);
      assertTrue('Ambiguous task A not snoozed', !a.snooze_until);
      assertTrue('Ambiguous task B not snoozed', !b.snooze_until);
    }

    // ── list_today_tasks: empty state ────────────────────────────────
    section('Today tools');
    {
      const { text } = await callTool(mcpClient, 'list_today_tasks', {});
      assertIncludes('list_today_tasks reports empty Today', text, 'No tasks in Today');
    }

    // ── add_task_to_today happy path ─────────────────────────────────
    const today1 = await apiPost(base, '/api/tasks', { title: 'Today task 1', column_id: workTile.id });
    const today2 = await apiPost(base, '/api/tasks', { title: 'Today task 2', column_id: workTile.id });
    {
      const { text } = await callTool(mcpClient, 'add_task_to_today', { title_match: 'Today task 1' });
      assertIncludes('add_task_to_today succeeds', text, '✓ Added to Today');
    }
    {
      const { text } = await callTool(mcpClient, 'add_task_to_today', { title_match: 'Today task 2' });
      assertIncludes('add_task_to_today succeeds for second task', text, '✓ Added to Today');
    }

    // ── add_task_to_today: no-op when already in Today ─────────────────
    {
      const { text } = await callTool(mcpClient, 'add_task_to_today', { id: today1.id });
      assertIncludes('add_task_to_today reports no-op when already in Today', text, 'is already in Today');
    }

    // ── add_task_to_today: ambiguous title_match rejected ────────────────
    {
      const { text } = await callTool(mcpClient, 'add_task_to_today', { title_match: 'Ambiguous Item' });
      assertIncludes('add_task_to_today rejects ambiguous title_match', text, 'ambiguous, nothing added to Today');

      const tasks = await apiGet(base, '/api/tasks');
      const a = tasks.find(x => x.id === ambigA.id);
      const b = tasks.find(x => x.id === ambigB.id);
      assertTrue('Ambiguous task A not added to Today', !a.today_flag);
      assertTrue('Ambiguous task B not added to Today', !b.today_flag);
    }

    // ── list_today_tasks: populated state ────────────────────────────
    {
      const { text } = await callTool(mcpClient, 'list_today_tasks', {});
      const parsed = JSON.parse(text);
      assertTrue('list_today_tasks returns an array', Array.isArray(parsed));
      assertTrue('list_today_tasks includes Today task 1', parsed.some(t => t.title === 'Today task 1'));
      assertTrue('list_today_tasks includes Today task 2', parsed.some(t => t.title === 'Today task 2'));
    }

    // ── reorder_today_tasks happy path ─────────────────────────────────
    {
      const { text } = await callTool(mcpClient, 'reorder_today_tasks', { task_ids: [today2.id, today1.id] });
      assertIncludes('reorder_today_tasks succeeds', text, '✓ Reordered Today');

      const tasks = await apiGet(base, '/api/tasks');
      const t1 = tasks.find(x => x.id === today1.id);
      const t2 = tasks.find(x => x.id === today2.id);
      assertEquals('reorder_today_tasks set today2 order to 0', 0, t2.today_order);
      assertEquals('reorder_today_tasks set today1 order to 1', 1, t1.today_order);
    }

    // ── reorder_today_tasks: validation rejects tasks not in Today ────────
    {
      const { text } = await callTool(mcpClient, 'reorder_today_tasks', { task_ids: [today1.id, ambigA.id] });
      assertIncludes('reorder_today_tasks rejects an id not currently in Today', text, 'not currently in Today');

      const tasks = await apiGet(base, '/api/tasks');
      const t1 = tasks.find(x => x.id === today1.id);
      assertEquals('reorder_today_tasks rejection left today1 order unchanged', 1, t1.today_order);
    }

    // ── reorder_today_tasks: validation rejects unknown ids ────────────────
    {
      const { text } = await callTool(mcpClient, 'reorder_today_tasks', { task_ids: [999999] });
      assertIncludes('reorder_today_tasks rejects a nonexistent id', text, 'not found');
    }

    // ── remove_task_from_today happy path ──────────────────────────────
    {
      const { text } = await callTool(mcpClient, 'remove_task_from_today', { title_match: 'Today task 1' });
      assertIncludes('remove_task_from_today succeeds', text, '✓ Removed from Today');

      const tasks = await apiGet(base, '/api/tasks');
      const t1 = tasks.find(x => x.id === today1.id);
      assertTrue('remove_task_from_today cleared today_flag', !t1.today_flag);
    }

    // ── remove_task_from_today: no-op when not in Today ─────────────────
    {
      const { text } = await callTool(mcpClient, 'remove_task_from_today', { id: today1.id });
      assertIncludes('remove_task_from_today reports no-op when not in Today', text, 'is not in Today');
    }

    // ── remove_task_from_today: ambiguous title_match rejected ────────────
    {
      const { text } = await callTool(mcpClient, 'remove_task_from_today', { title_match: 'Ambiguous Item' });
      assertIncludes('remove_task_from_today rejects ambiguous title_match', text, 'ambiguous, nothing removed from Today');
    }

    // ── delete_task ──────────────────────────────────────────────────
    section('delete_task safety behaviors');

    // Ambiguous title match: rejected with candidates, nothing deleted.
    {
      const { text } = await callTool(mcpClient, 'delete_task', { title: 'Ambiguous Item' });
      assertIncludes('delete_task rejects ambiguous title match', text, 'ambiguous, nothing deleted');
      assertIncludes('delete_task ambiguous response lists candidate A', text, String(ambigA.id));
      assertIncludes('delete_task ambiguous response lists candidate B', text, String(ambigB.id));

      const tasks = await apiGet(base, '/api/tasks');
      assertTrue('Ambiguous task A still exists', tasks.some(t => t.id === ambigA.id));
      assertTrue('Ambiguous task B still exists', tasks.some(t => t.id === ambigB.id));
    }

    // Unambiguous title match without confirm: returns match, does not delete.
    const deleteTarget = await apiPost(base, '/api/tasks', { title: 'Unique Delete Target', column_id: workTile.id });
    {
      const { text } = await callTool(mcpClient, 'delete_task', { title: 'Unique Delete Target' });
      assertIncludes('delete_task without confirm returns the match instead of deleting', text, 'Found one match');
      assertIncludes('delete_task without confirm asks for confirm:true', text, 'confirm: true');

      const tasks = await apiGet(base, '/api/tasks');
      assertTrue('Task NOT deleted without confirm:true', tasks.some(t => t.id === deleteTarget.id));
    }

    // Unambiguous title match with confirm:true: actually deletes.
    {
      const { text } = await callTool(mcpClient, 'delete_task', { title: 'Unique Delete Target', confirm: true });
      assertIncludes('delete_task with confirm:true deletes', text, '✓ Deleted task');

      const tasks = await apiGet(base, '/api/tasks');
      assertTrue('Task actually deleted after confirm:true', !tasks.some(t => t.id === deleteTarget.id));
    }

    // Delete by id: unambiguous, immediate, no confirm needed.
    const deleteByIdTarget = await apiPost(base, '/api/tasks', { title: 'Delete By Id Target', column_id: workTile.id });
    {
      const { text } = await callTool(mcpClient, 'delete_task', { id: deleteByIdTarget.id });
      assertIncludes('delete_task by id deletes immediately without confirm', text, '✓ Deleted task');

      const tasks = await apiGet(base, '/api/tasks');
      assertTrue('Task deleted by id', !tasks.some(t => t.id === deleteByIdTarget.id));
    }

    // ── Summary ────────────────────────────────────────────────────
    section('Summary');
    const total = PASS + FAIL;
    console.log(`Results: ${GREEN}${PASS}${NC} passed, ${RED}${FAIL}${NC} failed (${total} total)`);
    if (ERRORS.length > 0) {
      console.log('');
      console.log(`${RED}Failures:${NC}`);
      for (const e of ERRORS) console.log(`  • ${e}`);
    }
    console.log('');

    process.exitCode = FAIL === 0 ? 0 : 1;
  } catch (err) {
    fail(`Unhandled error: ${err && err.stack ? err.stack : err}`);
    process.exitCode = 1;
  } finally {
    // ── Cleanup: always runs, even on failure ─────────────────────
    section('Cleanup');

    if (mcpClient) {
      try { await mcpClient.close(); ok('Closed MCP client'); } catch (e) { info(`MCP client close: ${e.message}`); }
    }
    if (mcpTransport) {
      try { await mcpTransport.close(); } catch { /* already closed via client */ }
    }

    if (serverProc && serverProc.exitCode === null && !serverProc.killed) {
      const killed = await killProcess(serverProc);
      assertTrue('Killed throwaway server process', killed);
    }

    for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) {
      try {
        if (fs.existsSync(f)) {
          fs.unlinkSync(f);
        }
      } catch (e) {
        info(`Could not remove ${f}: ${e.message}`);
      }
    }
    const dbGone = !fs.existsSync(dbPath);
    assertTrue('Removed throwaway DB file', dbGone);
  }
}

function killProcess(proc) {
  return new Promise((resolve) => {
    let resolved = false;
    const done = (val) => { if (!resolved) { resolved = true; resolve(val); } };
    proc.once('exit', () => done(true));
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (!resolved) {
        try { proc.kill('SIGKILL'); } catch { /* already gone */ }
        // Give SIGKILL a moment to land, then resolve regardless.
        setTimeout(() => done(true), 300);
      }
    }, 2000);
  });
}

main();
