# taskpapr × n8n — Workflow Automation Guide

n8n is an open-source workflow automation tool. It can push tasks into taskpapr in response to almost any external event — starred emails, GitHub issues, calendar reminders, Slack mentions, form submissions, and more.

No custom plugin or node is required. taskpapr exposes a standard REST API and a webhook endpoint that n8n's built-in **HTTP Request** node handles natively.

---

## Prerequisites

1. **A running taskpapr instance** (local or EC2 — must be reachable from your n8n instance)
2. **An API key** — generate one in Settings → API keys (or `/admin` → API keys if you are admin)
3. **n8n** — self-hosted (`npx n8n`) or n8n Cloud

---

## Connection pattern

All taskpapr automation uses the **HTTP Request** node. There are two patterns:

| Pattern | When to use |
|---|---|
| `POST /api/webhook` | Push a task in response to an event (simplest) |
| `POST /api/tasks`, `PATCH /api/tasks/:id`, etc. | Full CRUD — when you need more control |

Both require the same header:

```
Authorization: Bearer tp_<your-key>
```

---

## Pattern A — Webhook (simplest)

### HTTP Request node settings

| Field | Value |
|---|---|
| Method | `POST` |
| URL | `https://your-taskpapr-instance/api/webhook` |
| Authentication | Header Auth → `Authorization` → `Bearer tp_...` |
| Body Content Type | JSON |

### Body (add_task)

```json
{
  "action": "add_task",
  "tile": "Work",
  "title": "{{ $json.subject }}"
}
```

`tile` is matched case-insensitively and partially — `"work"` matches a tile called `"Work stuff"`.

### Supported webhook actions

| `action` | Required fields | Optional |
|---|---|---|
| `add_task` | `title`, `tile` | `goal` (partial name match) |
| `complete` | `title` OR `id` | — |
| `mark_wip` | `title` OR `id` | — |
| `delete_task` | `title` OR `id` | — |

---

## Recipe: Forward an email to taskpapr

> **Design note:** Email parsing is intentionally not a native taskpapr feature. HTML emails, threading, quoted text, attachments, and MIME types are a rabbit hole that would bloat the core. n8n is the correct middleware layer — it handles the messy email world cleanly, and the taskpapr webhook handles the structured result.

This recipe covers the end-to-end "forward an email to create a task" use case. Two trigger patterns are documented: IMAP polling and webhook-based forwarding via Cloudmailin or Mailgun inbound routes (recommended).

---

### Trigger option A — IMAP polling

Use the **Email (IMAP)** node to poll a dedicated inbox on a schedule.

```
[Email Trigger (IMAP)]
  Host: imap.yourdomain.com  (or imap.gmail.com)
  Port: 993 (SSL)
  User: tasks@yourdomain.com
  Password: <app password>
  Mailbox: INBOX
  Action: "Mark as Read" after polling
  ↓ [Code node — clean subject] ↓
[HTTP Request → taskpapr]
```

**n8n IMAP field mappings:**

| n8n output field | Use as |
|---|---|
| `$json.subject` | task title |
| `$json.text` | notes (plain-text body) |
| `$json.from.value[0].address` | sender (for filtering) |

**Limitations:** polls every N minutes (not real-time); requires an app password; use a dedicated capture address — not your main inbox.

---

### Trigger option B — Webhook (Cloudmailin / Mailgun inbound) ✦ recommended

Configure a forwarding service to POST inbound emails to an n8n **Webhook** node. Real-time, more reliable, works with any email client's forward button.

**Cloudmailin setup:**
1. Create a free Cloudmailin address (e.g. `abc123@cloudmailin.net`)
2. Set the delivery target to your n8n Webhook node URL, format: **JSON**
3. In n8n: add a **Webhook** node (HTTP method: POST) and paste its URL into Cloudmailin

**Mailgun inbound setup:**
1. Add your domain to Mailgun; configure inbound routing
2. Create a route: match `tasks@yourdomain.com` → forward to your n8n Webhook URL

**Cloudmailin JSON field mappings:**

| Field | Use as |
|---|---|
| `$json.headers.subject` | task title |
| `$json.plain` | notes (plain-text body) |
| `$json.envelope.from` | sender address |

**Mailgun inbound field mappings:**

| Field | Use as |
|---|---|
| `$json.subject` | task title |
| `$json["body-plain"]` | notes (plain-text body) |
| `$json.sender` | sender address |

---

### Core flow: extract subject → POST to taskpapr

```
[Email trigger (IMAP or Webhook)]
  ↓
[Code node — clean subject]
  const raw = $input.first().json.subject         // IMAP + Mailgun
           || $input.first().json.headers.subject; // Cloudmailin
  const clean = (raw || 'Untitled email')
    .replace(/^(Re|Fwd?|FW|RE):\s*/i, '')
    .replace(/\s+/g, ' ').trim().substring(0, 120);
  return [{ json: { title: clean } }];
  ↓
[HTTP Request]
  Method: POST
  URL: https://your-taskpapr-instance/api/webhook
  Authorization: Bearer tp_...
  Body: { "action": "add_task", "tile": "Inbox", "title": "{{ $json.title }}" }
```

**Result:** The email subject becomes a task in your Inbox tile.

---

### Optional: map email body to task notes (two-step)

The webhook `add_task` action does not accept a `notes` field. Create the task first, then PATCH notes via REST:

```
[HTTP Request #1 → POST /api/webhook]
  { "action": "add_task", "tile": "Inbox", "title": "{{ $json.title }}" }
  → returns { "ok": true, "task": { "id": 42, ... } }
  ↓
[HTTP Request #2 → PATCH /api/tasks/:id]
  Method: PATCH
  URL: .../api/tasks/{{ $('Create task in Inbox').item.json.task.id }}
  Body: { "notes": "{{ $('Code').item.json.body.substring(0, 2000) }}" }
```

> **Tip:** Truncate body to ~2 000 chars and strip quoted/forwarded blocks in the Code node before writing to notes.

---

### Filtering — avoid noise from automated senders

Add an **IF** node before the HTTP Request:

```
[IF node]
  Condition 1: {{ $json.from }} does NOT contain "noreply"
  Condition 2: {{ $json.from }} does NOT contain "no-reply"
  (combinator: AND)
  ↓ true branch only
[HTTP Request → taskpapr]
```

Route to different tiles by sender domain:

```javascript
// Code node: choose tile by sender domain
const from = $input.first().json.envelope?.from || $input.first().json.from || '';
const domain = from.split('@')[1] || '';
let tile = 'Inbox';
if (domain.includes('github.com'))    tile = 'Work';
if (domain.includes('mycompany.com')) tile = 'Work';
if (domain.includes('bank'))          tile = 'Finance';
return [{ json: { ...$input.first().json, tile } }];
```

Use `{{ $json.tile }}` as the `tile` value in the webhook body.

---

### Sample exportable n8n workflow JSON

Import via **Workflows → Import from JSON**. Implements the Cloudmailin webhook trigger with sender filtering and optional notes-from-body.

After importing:
1. Update both **HTTP Request** node `url` values to your taskpapr instance
2. Replace `tp_YOUR_API_KEY_HERE` with your real API key (both nodes)
3. Paste your n8n Webhook node URL into Cloudmailin as the delivery target

The complete importable workflow is in [`docs/n8n-email-workflow.json`](./n8n-email-workflow.json).

**To skip notes** (subject-only): remove the **"Set notes from email body"** node and the connection to it.

**To use IMAP instead of Cloudmailin:**
1. Replace the **Cloudmailin Webhook** node with an **Email Trigger (IMAP)** node
2. In the Code node: `item.headers?.subject` → `item.subject`; `item.plain` → `item.text`

---

### End-to-end user flow

With the Cloudmailin variant running:

1. You receive an email worth acting on — a meeting request, a support ticket, an article to read
2. You **forward it** to your Cloudmailin address (e.g. `abc123@cloudmailin.net`)
3. Cloudmailin POSTs the parsed email to n8n within seconds
4. n8n strips `Re:`/`Fwd:` prefixes, filters automated senders, creates the task, and optionally writes the body to the task's notes panel
5. The task appears in your **Inbox** tile immediately — subject as title, body in notes if you enabled the two-step flow

**Client tip:** Save your Cloudmailin address as a contact named `📥 taskpapr`. Forwarding becomes: forward → type "taskpapr" → send. Three gestures, zero friction.

---

## Example workflows

### 1 — Starred Gmail → task

**Trigger:** Gmail node, "Message Received" with label `STARRED`  
**Goal:** Any starred email becomes a task in your **Inbox** tile

```
[Gmail Trigger]
  label: STARRED
  ↓
[HTTP Request]
  POST /api/webhook
  {
    "action": "add_task",
    "tile": "Inbox",
    "title": "Email: {{ $json.subject }}"
  }
```

**Tips:**
- Add an `IF` node before the HTTP Request to filter out automated/noreply senders
- Use n8n's Gmail "Mark as Read" node after creating the task to avoid re-triggering

---

### 2 — GitHub issue assigned to me → task

**Trigger:** GitHub node, "Issue Assigned" event  
**Goal:** Any issue assigned to you lands in your **Work** tile

```
[GitHub Trigger]
  event: issues
  action: assigned
  ↓
[IF]
  assignee.login == "your-github-username"
  ↓ (true branch)
[HTTP Request]
  POST /api/webhook
  {
    "action": "add_task",
    "tile": "Work",
    "title": "GH#{{ $json.issue.number }}: {{ $json.issue.title }}",
    "goal": "Open Source"
  }
```

---

### 3 — Monday morning weekly review task

**Trigger:** Schedule node, every Monday at 08:30  
**Goal:** Create a recurring "Weekly review" prompt

```
[Schedule Trigger]
  Interval: Every week
  Day: Monday
  Time: 08:30
  ↓
[HTTP Request]
  POST /api/webhook
  {
    "action": "add_task",
    "tile": "Personal",
    "title": "Weekly review"
  }
```

**Note:** This is separate from taskpapr's built-in recurrence. Use n8n for calendar-driven prompts; use taskpapr's `recurrence` field for habit-style spinning-plates tasks.

---

### 4 — Typeform / Tally submission → task

**Trigger:** Webhook node (Typeform/Tally sends POST to n8n)  
**Goal:** Form submissions (bug reports, client requests, etc.) become tasks

```
[Webhook Trigger]
  (copy the webhook URL into your form tool's "Responses" integration)
  ↓
[HTTP Request]
  POST /api/webhook
  {
    "action": "add_task",
    "tile": "Client Requests",
    "title": "{{ $json.answers[0].text }}"
  }
```

---

### 5 — Automated daily export backup (REST API)

**Trigger:** Schedule node, daily at 02:00  
**Goal:** Save a JSON backup of your board to a file or cloud storage

```
[Schedule Trigger]
  Daily at 02:00
  ↓
[HTTP Request]
  GET /api/export
  Authorization: Bearer tp_...
  ↓
[Write Binary File]  (or Google Drive / S3 node)
  filename: taskpapr-{{ $now.format('YYYY-MM-DD') }}.json
```

The export endpoint returns the full board as JSON (goals + tiles + nested tasks). No `Content-Disposition` issue when called from n8n — you get the JSON body directly.

---

### 6 — Todoist / Things migration (one-off import)

If you have an existing task list in Todoist, Things, or another tool that can export CSV/JSON:

```
[Read Binary File / HTTP Request to Todoist API]
  ↓
[Code node]  — transform to taskpapr import format
  {
    "tiles": [
      {
        "name": "Work",
        "tasks": [
          { "title": "Task title", "status": "active" },
          ...
        ]
      }
    ]
  }
  ↓
[HTTP Request]
  POST /api/import?mode=merge
  Authorization: Bearer tp_...
  body: <transformed JSON>
```

---

## Pattern B — Full REST API

For more complex automations, use the REST endpoints directly.

### Create a task with a due date

```
POST /api/tasks
{
  "title": "Pay VAT return",
  "column_id": 3
}
```

Then immediately patch with due date:

```
PATCH /api/tasks/{{ $json.id }}
{
  "next_due": "2026-01-31",
  "recurrence": "3m"
}
```

### Complete a task by ID

```
PATCH /api/tasks/42
{
  "status": "done"
}
```

### List all tasks (e.g. to build a daily digest in Slack)

```
GET /api/tasks
→ filter in Code node: tasks where next_due === today
→ Slack node: post formatted message
```

---

## Finding tile and task IDs

Use the `GET /api/columns` endpoint to find tile IDs:

```
GET /api/columns
→ array of { id, name, x, y, ... }
```

Or add an HTTP Request node early in your workflow to look up the tile by name:

```javascript
// Code node: find tile ID by name
const cols = $('Get Columns').all();
const tile = cols[0].json.find(c =>
  c.name.toLowerCase().includes('work')
);
return [{ json: { tile_id: tile.id } }];
```

---

## Authentication in n8n

**Option A — Header Auth credential (recommended)**

1. n8n → Credentials → Add credential → "Header Auth"
2. Name: `Authorization`
3. Value: `Bearer tp_<your-key>`
4. Use this credential in every HTTP Request node pointing at taskpapr

**Option B — Inline (quick testing)**

Set the header directly in the HTTP Request node's "Headers" section:
- Name: `Authorization`
- Value: `Bearer tp_<your-key>`

---

## Error handling

The webhook returns structured errors:

| Situation | Status | Body |
|---|---|---|
| Missing or invalid API key | 401 | `{ "error": "unauthorized …" }` |
| Tile not found | 404 | `{ "error": "tile not found: \"X\"", "available": ["Work", …] }` |
| Task not found | 404 | `{ "error": "task not found: \"X\"" }` |
| Unknown action | 400 | `{ "error": "unknown action: \"X\"", "supported": […] }` |

In n8n, add an **Error Trigger** node or use the "Continue on Fail" + **IF** node pattern to handle failures gracefully.

---

## Useful n8n expressions for taskpapr

```javascript
// Today's date as YYYY-MM-DD
{{ $now.format('YYYY-MM-DD') }}

// Truncate a long subject line to 80 chars
{{ $json.subject.substring(0, 80) }}

// Strip "Re: " / "Fwd: " prefixes from email subjects
{{ $json.subject.replace(/^(Re|Fwd|FW|RE):\s*/i, '') }}

// Use workflow name as goal (for multi-workflow setups)
{{ $workflow.name }}
```

---

## Self-hosting n8n alongside taskpapr (EC2)

If you're running taskpapr on EC2 and want n8n on the same server:

```bash
# Install n8n globally
npm install -g n8n

# Run as a systemd service (create /etc/systemd/system/n8n.service):
[Unit]
Description=n8n workflow automation
After=network.target

[Service]
Type=simple
User=taskpapr
WorkingDirectory=/opt/n8n
Environment=N8N_HOST=0.0.0.0
Environment=N8N_PORT=5678
Environment=N8N_PROTOCOL=https
Environment=WEBHOOK_URL=https://n8n.your-domain.com/
ExecStart=/usr/bin/n8n start
Restart=always

[Install]
WantedBy=multi-user.target
```

Point Traefik at port 5678 for HTTPS access. taskpapr and n8n can then call each other via `http://localhost:3033` and `http://localhost:5678` without leaving the server.

---

## Further reading

- [taskpapr API reference](./api.md) — full endpoint documentation
- [MCP server guide](./mcp-setup.md) — AI assistant integration (Claude Desktop / Cline)
- [Email → taskpapr workflow JSON](./n8n-email-workflow.json) — importable n8n workflow for the email-to-task recipe
- [n8n HTTP Request node docs](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.httprequest/)
- [n8n self-hosting guide](https://docs.n8n.io/hosting/)
- [Cloudmailin docs](https://docs.cloudmailin.com/) — inbound email HTTP POST service
- [Mailgun inbound routing docs](https://documentation.mailgun.com/docs/mailgun/user-manual/receive-forward-store/)