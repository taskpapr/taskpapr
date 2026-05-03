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

// ── Tool: add_task ───────────────────────────────────────────
server.tool(
  'add_task',
  'Add a new task to a tile on the taskpapr board.',
  {
    title:     z.string().describe('The task title/description.'),
    tile:      z.string().describe('Name of the tile to add the task to. If unsure, use "Work" or "Personal". Must match an existing tile name.'),
    goal:      z.string().optional().describe('Optional: goal title to associate with this task. Must match an existing goal name.'),
  },
  async ({ title, tile, goal }) => {
    const columns = await api('GET', '/api/columns');
    const col     = columns.find(c => c.name.toLowerCase().includes(tile.toLowerCase()));
    if (!col) {
      return { content: [{ type: 'text', text: `No tile found matching "${tile}". Available tiles: ${columns.map(c => c.name).join(', ')}` }] };
    }

    let goalId = null;
    if (goal) {
      const goals  = await api('GET', '/api/goals');
      const goalObj = goals.find(g => g.title.toLowerCase().includes(goal.toLowerCase()));
      if (goalObj) goalId = goalObj.id;
    }

    const task = await api('POST', '/api/tasks', {
      title:     title.trim(),
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

// ── Tool: delete_task ────────────────────────────────────────
server.tool(
  'delete_task',
  'Permanently delete a task. Use with care. Can find it by id or title.',
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
      : tasks.find(t => t.title.toLowerCase().includes(title.toLowerCase()));

    if (!task) {
      return { content: [{ type: 'text', text: `Task not found: ${id ? `id ${id}` : `"${title}"`}` }] };
    }

    await api('DELETE', `/api/tasks/${task.id}`);
    return { content: [{ type: 'text', text: `✓ Deleted: "${task.title}"` }] };
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