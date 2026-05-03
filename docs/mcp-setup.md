# taskpapr MCP server setup

The taskpapr MCP server exposes your task board as tools for any MCP-compatible LLM client. Once connected, you can say things like:

> "What's on my board today?"
> "Add 'Review PR #42' to my Work tile"
> "Mark the proposal task as WIP"
> "What tasks are linked to the Launch MVP goal?"

## Prerequisites

1. taskpapr running (locally or on a server)
2. Node.js 22.5+ installed
3. An API key — create one in taskpapr at `/admin` → **API keys**

## Available tools

| Tool | Description |
|---|---|
| `get_board_summary` | Full board overview — all tiles, active/WIP tasks, goals |
| `list_tiles` | All tiles with task counts |
| `list_tasks` | Tasks, filterable by tile name and/or status |
| `add_task` | Add a task to a named tile |
| `complete_task` | Mark a task as done (by id or title match) |
| `mark_wip` | Mark a task as WIP (by id or title match) |
| `delete_task` | Delete a task (by id or title match) |
| `list_goals` | All goals with task counts |
| `add_goal` | Create a new goal |

## Claude Desktop setup

Claude Desktop uses the stdio MCP transport. Add this to your Claude Desktop config:

**Config file location (macOS):**
`~/Library/Application Support/Claude/claude_desktop_config.json`

**Config (local taskpapr on macOS):**
```json
{
  "mcpServers": {
    "taskpapr": {
      "command": "node",
      "args": ["/Users/your-username/taskpapr/mcp/server.js"],
      "env": {
        "TASKPAPR_URL": "http://localhost:3033",
        "TASKPAPR_API_KEY": "tp_your_key_here"
      }
    }
  }
}
```

**Config (remote EC2 instance):**
```json
{
  "mcpServers": {
    "taskpapr": {
      "command": "node",
      "args": ["/Users/your-username/taskpapr/mcp/server.js"],
      "env": {
        "TASKPAPR_URL": "https://your-instance.example.com",
        "TASKPAPR_API_KEY": "tp_your_key_here"
      }
    }
  }
}
```

After editing the config, restart Claude Desktop. You should see "taskpapr" appear in the tools list.

## Manual test

You can verify the MCP server connects correctly:

```bash
cd /path/to/taskpapr
TASKPAPR_URL=http://localhost:3033 \
TASKPAPR_API_KEY=tp_your_key_here \
node mcp/server.js &
# Should print: [taskpapr-mcp] Connected to http://localhost:3033
kill %1
```

## Cline (VS Code) setup

Cline also supports MCP servers. Add to your Cline MCP settings:

```json
{
  "taskpapr": {
    "command": "node",
    "args": ["/path/to/taskpapr/mcp/server.js"],
    "env": {
      "TASKPAPR_URL": "http://localhost:3033",
      "TASKPAPR_API_KEY": "tp_your_key_here"
    }
  }
}
```

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `TASKPAPR_API_KEY` | Yes | — | API key from `/admin` |
| `TASKPAPR_URL` | No | `http://localhost:3033` | Base URL of taskpapr instance |

## Troubleshooting

**"TASKPAPR_API_KEY is not set"** — You forgot to set the env var. Check your config.

**"taskpapr API error 401"** — The key is invalid or has been revoked. Create a new one in `/admin`.

**"taskpapr API error 403"** — The key exists but the user isn't an admin. API keys currently require admin access.

**Connection refused** — taskpapr isn't running. Start it with `npm start` in the taskpapr directory, or check the launchd service on macOS.