# taskpapr API reference

All API endpoints require authentication — either a browser session or an API key.

## Authentication

### Browser session
Normal login via GitHub OAuth or OIDC. Session cookie is set automatically.

### API key (Bearer token)
Create keys in the Admin UI (`/admin` → API keys section) or via:
```
POST /api/admin/api-keys   {"name": "my key"}
```
Use in requests:
```
Authorization: Bearer tp_<your key>
```

Keys are one-way hashed — the raw value is shown once on creation. Store it securely.

---

## Endpoints

### `/api/me`
**GET** — Returns the current authenticated user.

Response:
```json
{
  "id": 1,
  "display_name": "John Example",
  "email": "john@example.com",
  "avatar_url": "https://...",
  "is_admin": 1,
  "single_user": true,
  "version": "0.4.0"
}
```

---

### Tiles (columns)

#### `GET /api/columns`
Returns all tiles for the current user, ordered by position.

```json
[
  { "id": 1, "name": "Work", "x": 40, "y": 40, "width": 260, "color": null, "position": 1 }
]
```

#### `POST /api/columns`
Create a tile.

Body: `{ "name": "Work", "x": 40, "y": 40, "width": 260, "color": "#fef9e7" }`
- `name` required
- `x`, `y`, `width`, `color` optional

#### `PATCH /api/columns/:id`
Update one or more tile properties. Send only the fields you want to change.

Body (all optional): `{ "name": "...", "x": 0, "y": 0, "width": 260, "color": "#fef9e7", "position": 2 }`

#### `DELETE /api/columns/:id`
Delete a tile and all its tasks.

---

### Tasks

#### `GET /api/tasks`
Returns all tasks for the current user, ordered by column and position.

```json
[
  {
    "id": 1,
    "title": "Write proposal",
    "status": "active",
    "column_id": 1,
    "position": 0,
    "goal_id": null,
    "created_at": "2026-02-27 09:00:00",
    "updated_at": "2026-02-27 09:00:00"
  }
]
```

**Task statuses:** `active` | `wip` | `done`

#### `POST /api/tasks`
Create a task.

Body: `{ "title": "Write proposal", "column_id": 1, "goal_id": null }`
- `title` and `column_id` required

#### `PATCH /api/tasks/:id`
Update a task. Send only the fields you want to change.

Body (all optional): `{ "title": "...", "status": "wip", "goal_id": 2, "position": 0, "column_id": 1 }`

#### `DELETE /api/tasks/:id`
Delete a single task.

#### `DELETE /api/tasks?column_id=<id>`
Delete all completed (`done`) tasks in a tile.

#### `DELETE /api/tasks`
Delete all completed (`done`) tasks across all tiles.

#### `POST /api/tasks/reorder`
Reorder and/or move tasks between tiles in a single transaction.

Body: array of `{ "id": <task_id>, "position": <int>, "column_id": <int> }`

```json
[
  { "id": 3, "position": 0, "column_id": 1 },
  { "id": 1, "position": 1, "column_id": 1 }
]
```

---

### Goals

#### `GET /api/goals`
Returns all goals for the current user.

```json
[{ "id": 1, "title": "Launch MVP", "notes": null, "position": 1 }]
```

#### `POST /api/goals`
Create a goal.

Body: `{ "title": "Launch MVP", "notes": "optional notes" }`

#### `PATCH /api/goals/:id`
Update a goal. Body: `{ "title": "...", "notes": "..." }`

#### `DELETE /api/goals/:id`
Delete a goal. Tasks linked to it have their `goal_id` set to null.

---

### Admin

All admin endpoints require `is_admin: true` on the authenticated user.

#### `GET /api/admin/users`
List all registered users.

#### `GET /api/admin/whitelist`
List the invite whitelist.

#### `POST /api/admin/whitelist`
Add an email to the whitelist.

Body: `{ "email": "user@example.com", "note": "optional note" }`

#### `DELETE /api/admin/whitelist/:id`
Remove an entry from the whitelist.

#### `GET /api/admin/api-keys`
List all API keys for the current user (never returns raw key values — only prefix, name, dates).

#### `POST /api/admin/api-keys`
Create an API key.

Body: `{ "name": "Claude Desktop" }`

Response (raw key shown **once only**):
```json
{
  "name": "Claude Desktop",
  "key": "tp_abc123...",
  "prefix": "tp_abc123…",
  "note": "Save this key — it will not be shown again."
}
```

#### `DELETE /api/admin/api-keys/:id`
Revoke an API key immediately.

---

### Webhook

The webhook endpoint is designed for push-based automation from tools like n8n, IFTTT, Zapier, or Make. Unlike the REST API, it requires an API key even in single-user mode — session authentication is not accepted.

#### `POST /api/webhook`

**Auth:** `Authorization: Bearer <api-key>` (required — session cookies not accepted)

**Body:**

```json
{ "action": "<action>", ...action-specific fields }
```

**Supported actions:**

| Action | Required fields | Optional fields |
|---|---|---|
| `add_task` | `title`, `tile` | `goal` |
| `complete` | `title` or `id` | — |
| `mark_wip` | `title` or `id` | — |
| `delete_task` | `title` or `id` | — |

- `tile` — partial case-insensitive match against tile names (e.g. `"work"` matches `"Work"`)
- `title` (for find operations) — partial case-insensitive match against task titles
- `goal` — partial case-insensitive match against goal titles (for `add_task`)
- `id` — exact task id (preferred over title when known)

**Examples:**

Add a task:
```bash
curl -X POST https://your-instance/api/webhook \
  -H "Authorization: Bearer tp_..." \
  -H "Content-Type: application/json" \
  -d '{"action":"add_task","title":"Review PR #42","tile":"Work"}'
```

Add a task and link to a goal:
```bash
curl -X POST https://your-instance/api/webhook \
  -H "Authorization: Bearer tp_..." \
  -H "Content-Type: application/json" \
  -d '{"action":"add_task","title":"Write draft","tile":"Work","goal":"Launch MVP"}'
```

Mark a task done:
```bash
curl -X POST https://your-instance/api/webhook \
  -H "Authorization: Bearer tp_..." \
  -H "Content-Type: application/json" \
  -d '{"action":"complete","title":"Review PR"}'
```

**Tile not found response (404):**
```json
{
  "error": "tile not found: \"Inbox\"",
  "available": ["Work", "Personal", "Errands", "Side Business"]
}
```

**n8n setup:** Use the HTTP Request node with method `POST`, URL `https://your-instance/api/webhook`, Header `Authorization: Bearer tp_...`, and a JSON body with the action payload.

---

### Export / Import

#### `GET /api/export`

Download a complete backup of the current user's board as a JSON file.

The response sets `Content-Disposition: attachment; filename="taskpapr-export-YYYY-MM-DD.json"` so browsers auto-download it. When called programmatically (e.g. from n8n for automated backups), just consume the JSON body directly.

**Response format (version 1):**

```json
{
  "version": "1",
  "exported_at": "2026-02-27T10:00:00.000Z",
  "taskpapr_version": "0.6.0",
  "goals": [
    { "title": "Launch MVP", "notes": null, "position": 1 }
  ],
  "tiles": [
    {
      "name": "Work",
      "x": 40, "y": 40, "width": 260,
      "color": null,
      "position": 1,
      "tasks": [
        {
          "title": "Write proposal",
          "status": "active",
          "position": 0,
          "goal": "Launch MVP",
          "notes": null,
          "created_at": "2026-02-27 09:00:00"
        }
      ]
    }
  ]
}
```

Goals are referenced by title (not internal id) so exports are portable across instances.

#### `POST /api/import`

Import a taskpapr JSON export file.

**Query parameter:** `?mode=merge` (default) or `?mode=replace`

- **merge** — adds tiles/tasks alongside existing data. If a tile with the same name already exists, tasks are added to it (no duplicate tiles). Safe to re-import the same file.
- **replace** — deletes all existing tiles, tasks, and goals for the user first, then imports. Use for restoring a backup or loading demo data.

**Body:** the JSON export object (same format as `GET /api/export` response)

**Response:**

```json
{
  "ok": true,
  "mode": "merge",
  "imported": {
    "goals": 0,
    "tiles": 0,
    "tasks": 3,
    "skipped": 0
  }
}
```

`skipped` counts tiles/goals/tasks that were missing required fields and were silently dropped.

**Error responses:**

- `400` — invalid `mode` parameter
- `400` — body is not a valid JSON object
- `400` — body is missing a `tiles` array

**curl examples:**

Export (save to file):
```bash
curl -s https://your-instance/api/export > taskpapr-backup.json
```

Import (merge):
```bash
curl -X POST 'https://your-instance/api/import?mode=merge' \
  -H "Content-Type: application/json" \
  -d @taskpapr-backup.json
```

Import (replace — full restore):
```bash
curl -X POST 'https://your-instance/api/import?mode=replace' \
  -H "Content-Type: application/json" \
  -d @taskpapr-backup.json
```
