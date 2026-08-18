#!/usr/bin/env node
/**
 * taskpapr MCP server
 *
 * Exposes taskpapr as an MCP tool server so any MCP-compatible LLM client
 * (Claude Desktop, etc.) can read and manage your task board conversationally.
 *
 * Usage (stdio transport — used by Claude Desktop and most MCP clients):
 *   node mcp/server.js
 *
 * Required environment variables:
 *   TASKPAPR_URL      Base URL of your taskpapr instance
 *                     Defaults to http://localhost:3033
 *   TASKPAPR_API_KEY  API key created in /admin (Authorization: Bearer)
 *
 * Example Claude Desktop config (~/.claude/claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "taskpapr": {
 *         "command": "node",
 *         "args": ["/path/to/taskpapr/mcp/server.js"],
 *         "env": {
 *           "TASKPAPR_URL": "https://your-instance.example.com",
 *           "TASKPAPR_API_KEY": "tp_..."
 *         }
 *       }
 *     }
 *   }
 */

const { McpServer }           = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z }                    = require('zod');

const BASE_URL = (process.env.TASKPAPR_URL || 'http://localhost:3033').replace(/\/$/, '');
const API_KEY  = process.env.TASKPAPR_API_KEY || '';

if (!API_KEY) {
  process.stderr.write('[taskpapr-mcp] WARNING: TASKPAPR_API_KEY is not set. API calls will likely fail.\n');
}

// ── HTTP helper ──────────────────────────────────────────────
async function api(method, path, body) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${API_KEY}`,
  };
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`taskpapr API error ${res.status}: ${text}`);
  }
  return res.json();
}

// ── Server setup ─────────────────────────────────────────────
const server = new McpServer({
  name:    'taskpapr',
  version: '0.4.0',
});

// ── Tool: get_board_summary ──────────────────────────────────
server.tool(
  'get_board_summary',
  'Get a natural-language summary of the current taskpapr board — all tiles, task counts, and active/WIP tasks.',
  {},
  async () => {
    const [columns, tasks, goals] = await Promise.all([
      api('GET', '/api/columns'),
      api('GET', '/api/tasks'),
      api('GET', '/api/goals'),
    ]);

    const lines = [];
    lines.push(`# Board summary (${new Date().toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })})`);
    lines.push('');

    if (goals.length > 0) {
      lines.push(`**Goals (${goals.length}):** ${goals.map(g => g.title).join(', ')}`);
      lines.push('');
    }

    for (const col of columns) {
      const colTasks = tasks.filter(t => t.column_id === col.id);
      const active   = colTasks.filter(t => t.status === 'active');
      const wip      = colTasks.filter(t => t.status === 'wip');
      const done     = colTasks.filter(t => t.status === 'done');

      lines.push(`## ${col.name} (${active.length + wip.length} active, ${done.length} done)`);

      if (wip.length > 0) {
        lines.push('**In progress:**');
        wip.forEach(t => lines.push(`  - [WIP] ${t.title}`));
      }
      if (active.length > 0) {
        lines.push('**To do:**');
        active.forEach(t => {
          const goal = goals.find(g => g.id === t.goal_id);
          lines.push(`  - ${t.title}${goal ? ` ← ${goal.title}` : ''}`);
        });
      }
      if (done.length > 0) {
        lines.push(`*(${done.length} completed task${done.length !== 1 ? 's' : ''} not shown)*`);
      }
      lines.push('');
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

// ── Tool: list_tiles ─────────────────────────────────────────
server.tool(
  'list_tiles',
  'List all tiles (columns) on the taskpapr board with task counts.',
  {},
  async () => {
    const [columns, tasks] = await Promise.all([
      api('GET', '/api/columns'),
      api('GET', '/api/tasks'),
    ]);

    const result = columns.map(col => {
      const colTasks = tasks.filter(t => t.column_id === col.id);
      return {
        id:     col.id,
        name:   col.name,
        active: colTasks.filter(t => t.status === 'active').length,
        wip:    colTasks.filter(t => t.status === 'wip').length,
        done:   colTasks.filter(t => t.status === 'done').length,
      };
    });

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

// ── Tool: list_tasks ─────────────────────────────────────────
server.tool(
  'list_tasks',
  'List tasks from the taskpapr board. Optionally filter by tile name and/or status.',
  {
    tile:   z.string().optional().describe('Tile (column) name to filter by. Case-insensitive partial match.'),
    status: z.enum(['active', 'wip', 'done', 'all']).optional().default('active').describe('Task status filter. Defaults to active (excludes done).'),
  },
  async ({ tile, status = 'active' }) => {
    const [columns, tasks, goals] = await Promise.all([
      api('GET', '/api/columns'),
      api('GET', '/api/tasks'),
      api('GET', '/api/goals'),
    ]);

    let filtered = tasks;

    if (tile) {
      const col = columns.find(c => c.name.toLowerCase().includes(tile.toLowerCase()));
      if (!col) {
        return { content: [{ type: 'text', text: `No tile found matching "${tile}". Available tiles: ${columns.map(c => c.name).join(', ')}` }] };
      }
      filtered = filtered.filter(t => t.column_id === col.id);
    }

    if (status !== 'all') {
      filtered = filtered.filter(t => t.status === status);
    }

    const result = filtered.map(t => {
      const col  = columns.find(c => c.id === t.column_id);
      const goal = goals.find(g => g.id === t.goal_id);
      return {
        id:     t.id,
        title:  t.title,
        status: t.status,
        tile:   col?.name || '?',
        goal:   goal?.title || null,
      };
    });

    if (result.length === 0) {
      return { content: [{ type: 'text', text: `No ${status === 'all' ? '' : status + ' '}tasks found${tile ? ` in "${tile}"` : ''}.` }] };
    }

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

// ── Tool: search_tasks ───────────────────────────────────────
server.tool(
  'search_tasks',
  'Search tasks by title (and optionally notes) substring, with optional tile/goal/status ' +
  'filters. Use this to find a task before a follow-up call like update_task or delete_task — ' +
  'results include id, title, tile, status, and goal so you can pick the right one safely. ' +
  'Defaults to non-done tasks (active, wip, dormant); pass status: "all" to include done tasks too.',
  {
    query:         z.string().describe('Substring to search for, case-insensitive. Matched against task titles, and also against notes when include_notes is true.'),
    status:        z.enum(['active', 'wip', 'done', 'dormant', 'all']).optional().describe('Filter by status. Defaults to all non-done statuses (active, wip, dormant).'),
    tile:          z.string().optional().describe('Tile (column) name to filter by. Case-insensitive partial match.'),
    goal:          z.string().optional().describe('Goal title to filter by. Case-insensitive partial match.'),
    include_notes: z.boolean().optional().describe('Also match query against task notes, not just titles. Defaults to false (titles only).'),
    limit:         z.number().int().positive().optional().describe('Maximum number of results to return, applied after filtering.'),
  },
  async ({ query, status, tile, goal, include_notes, limit }) => {
    const [columns, tasks, goals] = await Promise.all([
      api('GET', '/api/columns'),
      api('GET', '/api/tasks'),
      api('GET', '/api/goals'),
    ]);

    let filtered = tasks;

    if (status === 'all') {
      // no status filter
    } else if (status) {
      filtered = filtered.filter(t => t.status === status);
    } else {
      filtered = filtered.filter(t => t.status !== 'done');
    }

    if (tile) {
      const col = columns.find(c => c.name.toLowerCase().includes(tile.toLowerCase()));
      if (!col) {
        return { content: [{ type: 'text', text: `No tile found matching "${tile}". Available tiles: ${columns.map(c => c.name).join(', ')}` }] };
      }
      filtered = filtered.filter(t => t.column_id === col.id);
    }

    if (goal) {
      const goalMatches = goals.filter(g => g.title.toLowerCase().includes(goal.toLowerCase()));
      if (goalMatches.length === 0) {
        return { content: [{ type: 'text', text: `No goal found matching "${goal}". Available goals: ${goals.map(g => g.title).join(', ')}` }] };
      }
      const goalIds = new Set(goalMatches.map(g => g.id));
      filtered = filtered.filter(t => goalIds.has(t.goal_id));
    }

    const needle = query.toLowerCase();
    filtered = filtered.filter(t => {
      if (t.title.toLowerCase().includes(needle)) return true;
      if (include_notes && (t.notes || '').toLowerCase().includes(needle)) return true;
      return false;
    });

    if (filtered.length === 0) {
      return { content: [{ type: 'text', text: `No matches for "${query}"${tile ? ` in "${tile}"` : ''}${goal ? ` with goal "${goal}"` : ''}.` }] };
    }

    const totalMatches = filtered.length;
    if (limit !== undefined) {
      filtered = filtered.slice(0, limit);
    }

    const result = filtered.map(t => {
      const col      = columns.find(c => c.id === t.column_id);
      const goalObj  = goals.find(g => g.id === t.goal_id);
      return {
        id:     t.id,
        title:  t.title,
        status: t.status,
        tile:   col?.name || '?',
        goal:   goalObj?.title || null,
      };
    });

    const header = totalMatches > result.length
      ? `Showing ${result.length} of ${totalMatches} matches (limit applied):\n`
      : '';
    return { content: [{ type: 'text', text: header + JSON.stringify(result, null, 2) }] };
  }
);

// ── Tool: add_task ───────────────────────────────────────────
server.tool(
  'add_task',
  'Add a new task to a tile on the taskpapr board.',
  {
    title:           z.string().describe('The task title/description.'),
    tile:            z.string().describe('Name of the tile to add the task to. If unsure, use "Work" or "Personal". Must match an existing tile name.'),
    goal:            z.string().optional().describe('Optional: goal title to associate with this task. Must match an existing goal name.'),
    allow_duplicate: z.boolean().optional().default(false).describe('Set true to skip the exact-match duplicate check and create the task anyway.'),
  },
  async ({ title, tile, goal, allow_duplicate }) => {
    const columns = await api('GET', '/api/columns');
    const col     = columns.find(c => c.name.toLowerCase().includes(tile.toLowerCase()));
    if (!col) {
      return { content: [{ type: 'text', text: `No tile found matching "${tile}". Available tiles: ${columns.map(c => c.name).join(', ')}` }] };
    }

    const trimmedTitle = title.trim();

    if (!allow_duplicate) {
      const tasks = await api('GET', '/api/tasks');
      const dup = tasks.find(t =>
        t.column_id === col.id &&
        t.status !== 'done' &&
        t.title.trim().toLowerCase() === trimmedTitle.toLowerCase()
      );
      if (dup) {
        return { content: [{ type: 'text', text: `⚠ Possible duplicate: an existing task in "${col.name}" already has this exact title — "${dup.title}" (id: ${dup.id}, status: ${dup.status}). Task not created. Pass allow_duplicate: true to add it anyway.` }] };
      }
    }

    let goalId = null;
    if (goal) {
      const goals  = await api('GET', '/api/goals');
      const goalObj = goals.find(g => g.title.toLowerCase().includes(goal.toLowerCase()));
      if (goalObj) goalId = goalObj.id;
    }

    const task = await api('POST', '/api/tasks', {
      title:     trimmedTitle,
      column_id: col.id,
      goal_id:   goalId,
    });

    return { content: [{ type: 'text', text: `✓ Task added to "${col.name}": "${task.title}" (id: ${task.id})` }] };
  }
);

// ── Tool: complete_task ──────────────────────────────────────
server.tool(
  'complete_task',
  'Mark a task as done. Can find it by id or by matching its title.',
  {
    id:    z.number().int().optional().describe('Task id (preferred if known).'),
    title: z.string().optional().describe('Partial title match to find the task (used if id not provided).'),
  },
  async ({ id, title }) => {
    if (!id && !title) {
      return { content: [{ type: 'text', text: 'Provide either id or title.' }] };
    }

    let task;
    if (id) {
      const tasks = await api('GET', '/api/tasks');
      task = tasks.find(t => t.id === id);
    } else {
      const tasks = await api('GET', '/api/tasks');
      task = tasks.find(t => t.title.toLowerCase().includes(title.toLowerCase()) && t.status !== 'done');
    }

    if (!task) {
      return { content: [{ type: 'text', text: `Task not found: ${id ? `id ${id}` : `"${title}"`}` }] };
    }

    await api('PATCH', `/api/tasks/${task.id}`, { status: 'done' });
    return { content: [{ type: 'text', text: `✓ Marked as done: "${task.title}"` }] };
  }
);

// ── Tool: mark_wip ───────────────────────────────────────────
server.tool(
  'mark_wip',
  'Mark a task as Work In Progress (WIP). Can find it by id or by matching its title.',
  {
    id:    z.number().int().optional().describe('Task id (preferred if known).'),
    title: z.string().optional().describe('Partial title match to find the task.'),
  },
  async ({ id, title }) => {
    if (!id && !title) {
      return { content: [{ type: 'text', text: 'Provide either id or title.' }] };
    }

    const tasks = await api('GET', '/api/tasks');
    const task  = id
      ? tasks.find(t => t.id === id)
      : tasks.find(t => t.title.toLowerCase().includes(title.toLowerCase()) && t.status !== 'done');

    if (!task) {
      return { content: [{ type: 'text', text: `Task not found: ${id ? `id ${id}` : `"${title}"`}` }] };
    }

    await api('PATCH', `/api/tasks/${task.id}`, { status: 'wip' });
    return { content: [{ type: 'text', text: `✓ Marked as WIP: "${task.title}"` }] };
  }
);

// ── Tool: update_task ────────────────────────────────────────
server.tool(
  'update_task',
  'Update an existing task: rename it, move it to a different tile, assign or clear its goal, ' +
  'change its status, or replace its notes. This is a partial update — only the fields you ' +
  'supply are changed. Find the task by id (preferred) or by matching its current title via ' +
  'title_match, which must resolve to exactly one task or the call returns candidates instead ' +
  'of guessing. Note: notes here REPLACES the notes field entirely — to append to existing ' +
  'notes use the append_task_note tool instead.',
  {
    id:          z.number().int().optional().describe('Task id (preferred if known). Unambiguous.'),
    title_match: z.string().optional().describe('Partial, case-insensitive match against the task\'s CURRENT title, used to find it if id is not provided. Must resolve to exactly one task.'),
    title:       z.string().optional().describe('New title to rename the task to.'),
    tile:        z.string().optional().describe('Name of the tile to move the task to. Case-insensitive partial match against existing tile names.'),
    goal:        z.union([z.string(), z.null()]).optional().describe('Goal title to assign (case-insensitive partial match against existing goals), or null to clear the task\'s goal.'),
    status:      z.enum(['active', 'wip', 'done', 'dormant']).optional().describe('New status for the task.'),
    notes:       z.string().optional().describe('Replaces the task\'s notes entirely. Does not append.'),
  },
  async ({ id, title_match, title, tile, goal, status, notes }) => {
    if (!id && !title_match) {
      return { content: [{ type: 'text', text: 'Provide either id or title_match to identify the task.' }] };
    }

    const hasUpdate = title !== undefined || tile !== undefined || goal !== undefined ||
      status !== undefined || notes !== undefined;
    if (!hasUpdate) {
      return { content: [{ type: 'text', text: 'Provide at least one field to update: title, tile, goal, status, or notes.' }] };
    }

    const [tasks, columns] = await Promise.all([
      api('GET', '/api/tasks'),
      api('GET', '/api/columns'),
    ]);

    let task;
    if (id) {
      task = tasks.find(t => t.id === id);
      if (!task) {
        return { content: [{ type: 'text', text: `Task not found: id ${id}` }] };
      }
    } else {
      const needle  = title_match.toLowerCase();
      const matches = tasks.filter(t => t.title.toLowerCase().includes(needle));

      if (matches.length === 0) {
        return { content: [{ type: 'text', text: `Task not found: "${title_match}"` }] };
      }
      if (matches.length > 1) {
        const candidates = matches.map(t => ({
          id:    t.id,
          title: t.title,
          tile:  columns.find(c => c.id === t.column_id)?.name || '?',
        }));
        return {
          content: [{
            type: 'text',
            text: `"${title_match}" matches ${matches.length} tasks — ambiguous, nothing updated. ` +
                  `Retry with a specific id:\n${JSON.stringify(candidates, null, 2)}`,
          }],
        };
      }
      task = matches[0];
    }

    const patch = {};
    let destTileName;

    if (title !== undefined) {
      patch.title = title.trim();
    }

    if (tile !== undefined) {
      const col = columns.find(c => c.name.toLowerCase().includes(tile.toLowerCase()));
      if (!col) {
        return { content: [{ type: 'text', text: `No tile found matching "${tile}". Available tiles: ${columns.map(c => c.name).join(', ')}` }] };
      }
      const destTasks = tasks.filter(t => t.column_id === col.id);
      const maxPos = destTasks.reduce((max, t) => Math.max(max, t.position || 0), 0);
      patch.column_id = col.id;
      patch.position  = maxPos + 1;
      destTileName    = col.name;
    }

    if (goal !== undefined) {
      if (goal === null) {
        patch.goal_id = null;
      } else {
        const goals       = await api('GET', '/api/goals');
        const goalMatches = goals.filter(g => g.title.toLowerCase().includes(goal.toLowerCase()));
        if (goalMatches.length === 0) {
          return { content: [{ type: 'text', text: `No goal found matching "${goal}". Available goals: ${goals.map(g => g.title).join(', ')}` }] };
        }
        if (goalMatches.length > 1) {
          return {
            content: [{
              type: 'text',
              text: `"${goal}" matches ${goalMatches.length} goals — ambiguous, nothing updated. ` +
                    `Retry with a more specific name:\n${JSON.stringify(goalMatches.map(g => ({ id: g.id, title: g.title })), null, 2)}`,
            }],
          };
        }
        patch.goal_id = goalMatches[0].id;
      }
    }

    if (status !== undefined) {
      patch.status = status;
    }

    if (notes !== undefined) {
      patch.notes = notes;
    }

    const updated = await api('PATCH', `/api/tasks/${task.id}`, patch);

    const changes = [];
    if (title !== undefined)  changes.push(`title → "${updated.title}"`);
    if (tile !== undefined)   changes.push(`tile → "${destTileName}"`);
    if (goal !== undefined)   changes.push(goal === null ? 'goal cleared' : `goal → "${goal}"`);
    if (status !== undefined) changes.push(`status → ${status}`);
    if (notes !== undefined)  changes.push('notes replaced');

    return { content: [{ type: 'text', text: `✓ Updated task ${task.id} "${updated.title}": ${changes.join(', ')}` }] };
  }
);

// ── Tool: append_task_note ───────────────────────────────────
server.tool(
  'append_task_note',
  'Append text to a task\'s notes, preserving whatever is already there. The appended text is ' +
  'prefixed with a provenance marker ("— via MCP, YYYY-MM-DD") so it\'s visibly distinguishable ' +
  'from notes the user typed themselves. To replace notes entirely instead of appending, use ' +
  'update_task\'s notes field. Find the task by id (preferred) or by matching its current title ' +
  'via title_match, which must resolve to exactly one task or the call returns candidates instead ' +
  'of guessing.',
  {
    id:          z.number().int().optional().describe('Task id (preferred if known). Unambiguous.'),
    title_match: z.string().optional().describe('Partial, case-insensitive match against the task\'s CURRENT title, used to find it if id is not provided. Must resolve to exactly one task.'),
    note:        z.string().describe('The note text to append.'),
  },
  async ({ id, title_match, note }) => {
    if (!id && !title_match) {
      return { content: [{ type: 'text', text: 'Provide either id or title_match to identify the task.' }] };
    }

    if (!note || !note.trim()) {
      return { content: [{ type: 'text', text: 'Provide non-empty note text to append.' }] };
    }

    const [tasks, columns] = await Promise.all([
      api('GET', '/api/tasks'),
      api('GET', '/api/columns'),
    ]);

    let task;
    if (id) {
      task = tasks.find(t => t.id === id);
      if (!task) {
        return { content: [{ type: 'text', text: `Task not found: id ${id}` }] };
      }
    } else {
      const needle  = title_match.toLowerCase();
      const matches = tasks.filter(t => t.title.toLowerCase().includes(needle));

      if (matches.length === 0) {
        return { content: [{ type: 'text', text: `Task not found: "${title_match}"` }] };
      }
      if (matches.length > 1) {
        const candidates = matches.map(t => ({
          id:    t.id,
          title: t.title,
          tile:  columns.find(c => c.id === t.column_id)?.name || '?',
        }));
        return {
          content: [{
            type: 'text',
            text: `"${title_match}" matches ${matches.length} tasks — ambiguous, nothing appended. ` +
                  `Retry with a specific id:\n${JSON.stringify(candidates, null, 2)}`,
          }],
        };
      }
      task = matches[0];
    }

    const today  = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const marker = `— via MCP, ${today}`;
    const entry  = `${marker}\n${note.trim()}`;

    const existingNotes = (task.notes || '').trim();
    const newNotes = existingNotes ? `${existingNotes}\n\n${entry}` : entry;

    await api('PATCH', `/api/tasks/${task.id}`, { notes: newNotes });

    return { content: [{ type: 'text', text: `✓ Appended note to task ${task.id} "${task.title}" (marked "${marker}")` }] };
  }
);

// ── Tool: snooze_task ────────────────────────────────────────
server.tool(
  'snooze_task',
  'Snooze a task — hide it from the active board until a later date, without touching its due ' +
  'date. With no duration argument, this is the existing fixed 24h snooze (same as clicking ' +
  '"Snooze" in the app). Pass hours and/or days to snooze for a specific duration from now ' +
  '(combined additively if both given), or an explicit until date (ISO, e.g. "2026-09-01") to ' +
  'snooze until that exact date — until takes priority over hours/days if more than one is given. ' +
  'Find the task by id (preferred) or by matching its current title via title_match, which must ' +
  'resolve to exactly one non-done task or the call returns candidates instead of guessing. ' +
  'Cannot snooze an already-completed task.',
  {
    id:          z.number().int().optional().describe('Task id (preferred if known). Unambiguous.'),
    title_match: z.string().optional().describe('Partial, case-insensitive match against the task\'s CURRENT title, used to find it if id is not provided. Must resolve to exactly one non-done task.'),
    until:       z.string().optional().describe('ISO date to snooze until, e.g. "2026-09-01". Takes priority over hours/days if both are given.'),
    hours:       z.number().optional().describe('Snooze for this many hours from now. Combines additively with days if both are given. Ignored if until is given.'),
    days:        z.number().optional().describe('Snooze for this many days from now. Combines additively with hours if both are given. Ignored if until is given.'),
  },
  async ({ id, title_match, until, hours, days }) => {
    if (!id && !title_match) {
      return { content: [{ type: 'text', text: 'Provide either id or title_match to identify the task.' }] };
    }

    const tasks = await api('GET', '/api/tasks');

    let task;
    if (id) {
      task = tasks.find(t => t.id === id);
      if (!task) {
        return { content: [{ type: 'text', text: `Task not found: id ${id}` }] };
      }
    } else {
      const needle  = title_match.toLowerCase();
      const matches = tasks.filter(t => t.status !== 'done' && t.title.toLowerCase().includes(needle));

      if (matches.length === 0) {
        return { content: [{ type: 'text', text: `Task not found: "${title_match}"` }] };
      }
      if (matches.length > 1) {
        const columns    = await api('GET', '/api/columns');
        const candidates = matches.map(t => ({
          id:    t.id,
          title: t.title,
          tile:  columns.find(c => c.id === t.column_id)?.name || '?',
        }));
        return {
          content: [{
            type: 'text',
            text: `"${title_match}" matches ${matches.length} tasks — ambiguous, nothing snoozed. ` +
                  `Retry with a specific id:\n${JSON.stringify(candidates, null, 2)}`,
          }],
        };
      }
      task = matches[0];
    }

    if (task.status === 'done') {
      return { content: [{ type: 'text', text: `Cannot snooze task ${task.id} "${task.title}" — it's already done.` }] };
    }

    const hasDuration = until !== undefined || hours !== undefined || days !== undefined;

    let updated;
    if (!hasDuration) {
      // No duration supplied — unchanged fixed 24h snooze behaviour.
      updated = await api('POST', `/api/tasks/${task.id}/snooze`);
    } else {
      let targetDate;
      if (until !== undefined) {
        targetDate = new Date(until);
        if (isNaN(targetDate.getTime())) {
          return { content: [{ type: 'text', text: `"${until}" is not a valid date.` }] };
        }
      } else {
        const ms = (days || 0) * 24 * 60 * 60 * 1000 + (hours || 0) * 60 * 60 * 1000;
        if (ms <= 0) {
          return { content: [{ type: 'text', text: 'Provide a positive hours and/or days value, or an until date.' }] };
        }
        targetDate = new Date(Date.now() + ms);
      }
      const snoozeUntil = targetDate.toISOString().slice(0, 10);
      updated = await api('PATCH', `/api/tasks/${task.id}`, { snooze_until: snoozeUntil });
    }

    return { content: [{ type: 'text', text: `✓ Snoozed task ${task.id} "${task.title}" — reappears on ${updated.snooze_until}.` }] };
  }
);

// ── Tool: list_today_tasks ───────────────────────────────────
server.tool(
  'list_today_tasks',
  'List tasks flagged for Today, in Today order. Ordering matches the app\'s Today tile exactly ' +
  '(public/app.js): ascending by today_order, with a missing today_order treated as 9999 (so it ' +
  'sorts before a task freshly added via add_task_to_today, which is stamped with a much larger ' +
  'timestamp), tiebroken by position within its tile. Completed (done) tasks are excluded even if ' +
  'still flagged, matching what the Today tile actually shows on the board.',
  {},
  async () => {
    const [tasks, columns, goals] = await Promise.all([
      api('GET', '/api/tasks'),
      api('GET', '/api/columns'),
      api('GET', '/api/goals'),
    ]);

    const today = tasks
      .filter(t => t.today_flag && t.status !== 'done')
      .sort((a, b) => {
        const oa = a.today_order != null ? a.today_order : 9999;
        const ob = b.today_order != null ? b.today_order : 9999;
        return oa - ob || (a.position || 0) - (b.position || 0);
      });

    if (today.length === 0) {
      return { content: [{ type: 'text', text: 'No tasks in Today.' }] };
    }

    const result = today.map(t => {
      const col  = columns.find(c => c.id === t.column_id);
      const goal = goals.find(g => g.id === t.goal_id);
      return {
        id:          t.id,
        title:       t.title,
        status:      t.status,
        tile:        col?.name || '?',
        goal:        goal?.title || null,
        today_order: t.today_order ?? null,
      };
    });

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

// ── Tool: add_task_to_today ──────────────────────────────────
server.tool(
  'add_task_to_today',
  'Add an existing task to Today by setting its today_flag. Find the task by id (preferred) or by ' +
  'matching its current title via title_match, which must resolve to exactly one task or the call ' +
  'returns candidates instead of guessing. The task is appended to the end of Today — stamped with ' +
  'a fresh order value newer than anything already there, the same way the app\'s Today toggle ' +
  'behaves — so it lands last; use reorder_today_tasks afterward for a specific position. A no-op ' +
  '(reported, not an error) if the task is already in Today.',
  {
    id:          z.number().int().optional().describe('Task id (preferred if known). Unambiguous.'),
    title_match: z.string().optional().describe('Partial, case-insensitive match against the task\'s CURRENT title, used to find it if id is not provided. Must resolve to exactly one task.'),
  },
  async ({ id, title_match }) => {
    if (!id && !title_match) {
      return { content: [{ type: 'text', text: 'Provide either id or title_match to identify the task.' }] };
    }

    const [tasks, columns] = await Promise.all([
      api('GET', '/api/tasks'),
      api('GET', '/api/columns'),
    ]);

    let task;
    if (id) {
      task = tasks.find(t => t.id === id);
      if (!task) {
        return { content: [{ type: 'text', text: `Task not found: id ${id}` }] };
      }
    } else {
      const needle  = title_match.toLowerCase();
      const matches = tasks.filter(t => t.title.toLowerCase().includes(needle));

      if (matches.length === 0) {
        return { content: [{ type: 'text', text: `Task not found: "${title_match}"` }] };
      }
      if (matches.length > 1) {
        const candidates = matches.map(t => ({
          id:    t.id,
          title: t.title,
          tile:  columns.find(c => c.id === t.column_id)?.name || '?',
        }));
        return {
          content: [{
            type: 'text',
            text: `"${title_match}" matches ${matches.length} tasks — ambiguous, nothing added to Today. ` +
                  `Retry with a specific id:\n${JSON.stringify(candidates, null, 2)}`,
          }],
        };
      }
      task = matches[0];
    }

    if (task.today_flag) {
      return { content: [{ type: 'text', text: `Task ${task.id} "${task.title}" is already in Today.` }] };
    }

    const updated = await api('PATCH', `/api/tasks/${task.id}`, { today_flag: true, today_order: Date.now() });
    return { content: [{ type: 'text', text: `✓ Added to Today: task ${updated.id} "${updated.title}"` }] };
  }
);

// ── Tool: remove_task_from_today ─────────────────────────────
server.tool(
  'remove_task_from_today',
  'Remove a task from Today by clearing its today_flag. Also clears today_order (sets it to null) ' +
  'so the task doesn\'t carry stale ordering if it\'s re-added later — matches the app\'s Today ' +
  'toggle behavior exactly. Find the task by id (preferred) or by matching its current title via ' +
  'title_match, which must resolve to exactly one task or the call returns candidates instead of ' +
  'guessing. A no-op (reported, not an error) if the task isn\'t in Today.',
  {
    id:          z.number().int().optional().describe('Task id (preferred if known). Unambiguous.'),
    title_match: z.string().optional().describe('Partial, case-insensitive match against the task\'s CURRENT title, used to find it if id is not provided. Must resolve to exactly one task.'),
  },
  async ({ id, title_match }) => {
    if (!id && !title_match) {
      return { content: [{ type: 'text', text: 'Provide either id or title_match to identify the task.' }] };
    }

    const [tasks, columns] = await Promise.all([
      api('GET', '/api/tasks'),
      api('GET', '/api/columns'),
    ]);

    let task;
    if (id) {
      task = tasks.find(t => t.id === id);
      if (!task) {
        return { content: [{ type: 'text', text: `Task not found: id ${id}` }] };
      }
    } else {
      const needle  = title_match.toLowerCase();
      const matches = tasks.filter(t => t.title.toLowerCase().includes(needle));

      if (matches.length === 0) {
        return { content: [{ type: 'text', text: `Task not found: "${title_match}"` }] };
      }
      if (matches.length > 1) {
        const candidates = matches.map(t => ({
          id:    t.id,
          title: t.title,
          tile:  columns.find(c => c.id === t.column_id)?.name || '?',
        }));
        return {
          content: [{
            type: 'text',
            text: `"${title_match}" matches ${matches.length} tasks — ambiguous, nothing removed from Today. ` +
                  `Retry with a specific id:\n${JSON.stringify(candidates, null, 2)}`,
          }],
        };
      }
      task = matches[0];
    }

    if (!task.today_flag) {
      return { content: [{ type: 'text', text: `Task ${task.id} "${task.title}" is not in Today.` }] };
    }

    const updated = await api('PATCH', `/api/tasks/${task.id}`, { today_flag: false, today_order: null });
    return { content: [{ type: 'text', text: `✓ Removed from Today: task ${updated.id} "${updated.title}"` }] };
  }
);

// ── Tool: reorder_today_tasks ────────────────────────────────
server.tool(
  'reorder_today_tasks',
  'Reorder the tasks currently in Today. Pass task_ids as the full desired order (an array of task ' +
  'ids, first to last); each task\'s today_order is set to its 0-based index in that array (first ' +
  'id → 0, second → 1, ...) — the same 0-based scheme the app\'s drag-to-reorder in the Today tile ' +
  'uses. Every id must already be flagged for Today: this tool will NOT silently flag a task into ' +
  'Today just because it appears in task_ids — call add_task_to_today first for anything not ' +
  'already there. All ids are validated against the current task list before anything is changed: ' +
  'if any id doesn\'t exist, or exists but isn\'t currently in Today, the whole call is rejected ' +
  'with a clear message listing the offending ids and nothing is updated.',
  {
    task_ids: z.array(z.number().int()).describe('Task ids in the desired Today order, first to last. Each must already be flagged for Today (today_flag true).'),
  },
  async ({ task_ids }) => {
    if (!task_ids || task_ids.length === 0) {
      return { content: [{ type: 'text', text: 'Provide a non-empty task_ids array.' }] };
    }

    const tasks = await api('GET', '/api/tasks');
    const byId  = new Map(tasks.map(t => [t.id, t]));

    const missing = task_ids.filter(id => !byId.has(id));
    if (missing.length > 0) {
      return { content: [{ type: 'text', text: `Task id(s) not found: ${missing.join(', ')}. Nothing reordered.` }] };
    }

    const notInToday = task_ids.filter(id => !byId.get(id).today_flag);
    if (notInToday.length > 0) {
      const details = notInToday.map(id => ({ id, title: byId.get(id).title }));
      return {
        content: [{
          type: 'text',
          text: `Task id(s) not currently in Today: ${JSON.stringify(details, null, 2)}. ` +
                `Add them to Today first with add_task_to_today, then retry. Nothing reordered.`,
        }],
      };
    }

    const updates = [];
    for (let i = 0; i < task_ids.length; i++) {
      const id      = task_ids[i];
      const updated = await api('PATCH', `/api/tasks/${id}`, { today_order: i });
      updates.push({ id: updated.id, title: updated.title, today_order: updated.today_order });
    }

    return { content: [{ type: 'text', text: `✓ Reordered Today (${updates.length} tasks):\n${JSON.stringify(updates, null, 2)}` }] };
  }
);

// ── Tool: delete_task ────────────────────────────────────────
server.tool(
  'delete_task',
  'PERMANENTLY delete a task. This cannot be undone. Deleting by id is unambiguous ' +
  'and happens immediately. Deleting by title requires the title to match exactly ' +
  'one active/wip/dormant task — if it matches more than one, no task is deleted and ' +
  'the candidate matches are returned instead so you can retry with a specific id. ' +
  'Even with a single title match, deletion only proceeds once confirm:true is passed ' +
  '— the first call without confirm returns the matched task for you to verify before ' +
  'confirming.',
  {
    id:      z.number().int().optional().describe('Task id (preferred if known). Unambiguous — deletes immediately, no confirm needed.'),
    title:   z.string().optional().describe('Partial title match to find the task. Must resolve to exactly one active/wip/dormant task.'),
    confirm: z.boolean().optional().describe('Required to be true to actually delete when matching by title. Not needed when deleting by id.'),
  },
  async ({ id, title, confirm }) => {
    if (!id && !title) {
      return { content: [{ type: 'text', text: 'Provide either id or title.' }] };
    }

    const tasks = await api('GET', '/api/tasks');

    if (id) {
      const task = tasks.find(t => t.id === id);
      if (!task) {
        return { content: [{ type: 'text', text: `Task not found: id ${id}` }] };
      }
      await api('DELETE', `/api/tasks/${task.id}`);
      return { content: [{ type: 'text', text: `✓ Deleted task ${task.id}: "${task.title}"` }] };
    }

    const columns  = await api('GET', '/api/columns');
    const needle   = title.toLowerCase();
    const matches  = tasks.filter(t => t.status !== 'done' && t.title.toLowerCase().includes(needle));

    if (matches.length === 0) {
      return { content: [{ type: 'text', text: `Task not found: "${title}"` }] };
    }

    if (matches.length > 1) {
      const candidates = matches.map(t => ({
        id:    t.id,
        title: t.title,
        tile:  columns.find(c => c.id === t.column_id)?.name || '?',
      }));
      return {
        content: [{
          type: 'text',
          text: `"${title}" matches ${matches.length} tasks — ambiguous, nothing deleted. ` +
                `Retry with a specific id:\n${JSON.stringify(candidates, null, 2)}`,
        }],
      };
    }

    const task = matches[0];

    if (!confirm) {
      return {
        content: [{
          type: 'text',
          text: `Found one match: id ${task.id} "${task.title}". This is permanent. ` +
                `Call delete_task again with id ${task.id} (or title + confirm: true) to delete it.`,
        }],
      };
    }

    await api('DELETE', `/api/tasks/${task.id}`);
    return { content: [{ type: 'text', text: `✓ Deleted task ${task.id}: "${task.title}"` }] };
  }
);

// ── Tool: list_goals ─────────────────────────────────────────
server.tool(
  'list_goals',
  'List all goals defined in taskpapr, with the number of tasks linked to each.',
  {},
  async () => {
    const [goals, tasks] = await Promise.all([
      api('GET', '/api/goals'),
      api('GET', '/api/tasks'),
    ]);

    if (goals.length === 0) {
      return { content: [{ type: 'text', text: 'No goals defined yet.' }] };
    }

    const result = goals.map(g => ({
      id:    g.id,
      title: g.title,
      tasks: tasks.filter(t => t.goal_id === g.id).length,
    }));

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

// ── Tool: add_goal ───────────────────────────────────────────
server.tool(
  'add_goal',
  'Create a new goal in taskpapr.',
  {
    title: z.string().describe('The goal title.'),
  },
  async ({ title }) => {
    const goal = await api('POST', '/api/goals', { title: title.trim() });
    return { content: [{ type: 'text', text: `✓ Goal created: "${goal.title}" (id: ${goal.id})` }] };
  }
);

// ── Start ────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[taskpapr-mcp] Connected to ${BASE_URL}\n`);
}

main().catch(err => {
  process.stderr.write(`[taskpapr-mcp] Fatal: ${err.message}\n`);
  process.exit(1);
});