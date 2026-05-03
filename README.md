# taskpapr

A minimal, paper-inspired task board. No noise, no friction.

**Current version:** v0.45.0

## The idea

Designed for people who always come back to a blank sheet of paper. Freely draggable tiles on an infinite canvas, tasks you can cross off (and they stay visible), a WIP state, recurring tasks with urgency heat, and a Goals view for the bigger picture.

## Features

- **Infinite canvas** — drag tiles anywhere, zoom 25–250%, pan freely
- **Tasks** — add, check off (strikethrough stays visible), WIP state, inline edit, drag-to-reorder
- **Notes & Markdown** — click any task to open a slide-in panel with auto-saving notes
- **Due dates & recurrence** — optional `next_due` + recurrence interval; recurring tasks sleep between cycles (`dormant` status) and wake automatically
- **Spinning plates / urgency heat** — recurring tasks that haven't been done heat from amber to red as they age
- **Task rot** — non-recurring tasks gradually fade to parchment if untouched, surfacing forgotten items
- **Today tile** — flag tasks to a floating viewport-pinned Today view; drag to reorder
- **Snooze** — hide any task for 24h without changing its due date
- **Goals** — smart-tiles showing all tasks under a goal across all tiles
- **Search** — ⌘K command palette; searches all tasks including dormant ones
- **Canvas bookmarks** — save/jump to named viewport positions (⌘1–9)
- **Hidden tiles** — "Someday/Maybe" tiles hidden from the main board; park tasks with one click
- **Off-screen beacons** — directional indicators when tiles are outside the visible area
- **Per-tile colour & zoom** — background colour picker and independent zoom per tile
- **Per-task colour** — 8-colour palette for urgent/important visual signalling
- **Export / Import** — JSON backup; merge or replace modes
- **API keys** — machine-readable access (`tp_…` bearer tokens) for automation
- **Webhook** — push tasks from n8n, Zapier, IFTTT, Make via `POST /api/webhook`
- **MCP server** — use taskpapr as a tool in Claude Desktop or Cline
- **Telegram bot** — daily digest notifications + quick-capture from any chat
- **Multi-user** — GitHub OAuth, Google OAuth, OIDC/SSO, or single-user mode (no config needed)
- **Docker** — official multi-arch image at `ghcr.io/taskpapr/taskpapr`

---

## Modes of operation

### Single-user mode (default — no config needed)
If no auth environment variables are set, taskpapr starts in single-user mode: no login page, no session, opens straight to the board.

### Multi-user mode
Set any combination of the following to enable login:

| Provider | Environment variables |
|---|---|
| GitHub | `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET` |
| Google | `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` |
| SSO (OIDC) | `OIDC_ISSUER` + `OIDC_CLIENT_ID` + `OIDC_CLIENT_SECRET` |

Multiple providers can be active simultaneously. See [`docs/auth-setup.md`](docs/auth-setup.md) for full configuration instructions.

---

## Requirements

- Node.js 22.5+ (uses the built-in `node:sqlite` module — no native compilation needed)
- npm

The app itself runs on any platform Node runs on. macOS-specific extras (launchd auto-start) are noted separately below.

---

## Quick start

```bash
git clone https://github.com/taskpapr/taskpapr.git
cd taskpapr
npm install
npm start
```

Then open **http://localhost:3033** in your browser.

Copy `.env.example` to `.env` to configure auth, Telegram, Stripe, and other options.

---

## Docker

```bash
# Pull and run (SQLite, single-user, no config)
docker run -p 3033:3033 -v $(pwd)/data:/app/data ghcr.io/taskpapr/taskpapr:latest
```

For a full Docker Compose setup with Traefik reverse proxy, see [`deploy/README.md`](deploy/README.md).

Multi-arch image (linux/amd64 + linux/arm64) built and pushed automatically on every push to `main`.

---

## macOS auto-start (launchd)

taskpapr can run as a background service that starts automatically at login:

```bash
cp com.taskpapr.server.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.taskpapr.server.plist
```

To stop:
```bash
launchctl unload ~/Library/LaunchAgents/com.taskpapr.server.plist
```

Logs: `~/Library/Logs/taskpapr.log` and `~/Library/Logs/taskpapr.error.log`.

**Alfred shortcut (recommended):** Add a Web Search or Simple URL workflow:
- Keyword: `td`
- URL: `http://localhost:3033`

---

## Self-hosting on a server

See [`deploy/README.md`](deploy/README.md) for an EC2 + Traefik deployment walkthrough.

---

## Usage

| Action | How |
|---|---|
| Add a task | Click `+ Add task…` in any tile, type, press Enter |
| Complete a task | Click the checkbox — it strikes through and stays visible |
| Mark WIP | Hover task → amber left strip, click it; or ⋯ → Mark WIP |
| Edit task title | Double-click the task text |
| Open notes panel | Click anywhere on a task (not checkbox or ⋯) |
| Add a due date / recurrence | Notes panel → Due date + Recurrence fields |
| Snooze a task | ⋯ → 💤 Snooze 24h (hides until tomorrow; next_due unchanged) |
| Flag for Today | Right-click task → 📅 Add to Today |
| Open Today tile | Click 📅 N in header, or press D |
| Park a task | ⋯ → 🗃 Park task (moves to hidden "Someday/Maybe" tile) |
| Show/hide parked tasks | Click 🗃 N in header |
| Clear completed | `Clear N done` at bottom of tile, or `✕ Clear done` in header |
| Delete a task | ⋯ → Delete |
| Reorder tasks | Drag and drop within or between tiles |
| Search | ⌘K (or Ctrl+K), or click 🔍 in header |
| Goals view | Click ⊙ Goals in header, or press G |
| Assign goal to task | ⋯ → Assign Goal… |
| Add a tile | Click + Tile in header |
| Move a tile | Drag by the tile header |
| Resize a tile | Drag the bottom-right handle |
| Colour a tile | Hover tile → click 🎨 |
| Zoom a tile | Scroll wheel on tile header; double-click to reset |
| Save canvas bookmark | Click 🔖 Views → Save current view |
| Jump to bookmark | Click 🔖 Views → bookmark name (⌘1–9 keyboard shortcuts) |
| Zoom canvas | Scroll wheel, pinch-to-zoom, or +/−/⌂ controls (bottom right) |
| Pan canvas | Click and drag on empty canvas area |
| Close overlays | Press Escape |
| Sign out | Click your name/avatar (top right) → Sign out |

---

## Automation & integrations

### API keys
Create keys in **Settings → API keys**. Use them as `Authorization: Bearer <key>` on any API endpoint.

### Webhook
`POST /api/webhook` (requires API key). Supported actions:

```jsonc
{ "action": "add_task",    "title": "Buy milk", "tile": "Personal" }
{ "action": "complete",    "id": 42 }
{ "action": "mark_wip",    "title": "Write report" }
{ "action": "delete_task", "id": 42 }
```

See [`docs/api.md`](docs/api.md) for the full REST API reference and [`docs/n8n.md`](docs/n8n.md) for automation recipes.

### MCP server
Use taskpapr as a tool in Claude Desktop or Cline:

```bash
node mcp/server.js
# Requires TASKPAPR_URL and TASKPAPR_API_KEY env vars
```

See [`docs/mcp-setup.md`](docs/mcp-setup.md) for setup instructions.

### Telegram
Receive a daily digest of tasks due today/tomorrow and add tasks by message. See [`docs/telegram-setup.md`](docs/telegram-setup.md).

---

## Documentation

| Document | Contents |
|---|---|
| [`docs/auth-setup.md`](docs/auth-setup.md) | GitHub, Google, OIDC auth configuration |
| [`docs/api.md`](docs/api.md) | Full REST API reference |
| [`docs/mcp-setup.md`](docs/mcp-setup.md) | MCP server setup (Claude Desktop + Cline) |
| [`docs/telegram-setup.md`](docs/telegram-setup.md) | Telegram bot setup |
| [`docs/n8n.md`](docs/n8n.md) | Webhook automation recipes |
| [`docs/deployment-security.md`](docs/deployment-security.md) | Security hardening + Cloudflare/Traefik pattern |
| [`docs/rot-and-spinning-plates.md`](docs/rot-and-spinning-plates.md) | Task rot + spinning plates feature reference |
| [`deploy/README.md`](deploy/README.md) | EC2 + Traefik deployment walkthrough |

---

## Data

The SQLite database lives at `data/taskpapr.db` (configurable via `DB_PATH` env var). It's a single portable file — back it up, move it, or point it at an iCloud/Dropbox folder for cheap cross-device sync.

All data is scoped to `user_id`. In single-user mode, everything belongs to the local user (id=1).
