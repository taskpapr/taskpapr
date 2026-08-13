# Demo data

A small, curated board for demos, local exploration, and capturing
consistent documentation screenshots — this is the exact layout behind the
images on [docs.taskpapr.com](https://docs.taskpapr.com).

## What's in it

- **Work** / **Personal** — a couple of plain tasks, one flagged for Today
  in each tile (📅)
- **Project** — three tasks assigned to a "Launch MVP" goal (one WIP, one
  done, one active) — for the goals smart-tile view (`G`)
- **Errands** — one active task plus two dormant ones — for the 👻
  ghost-pill on a tile header
- **Recurring examples** — four daily-recurring tasks tuned to land at each
  step of the spinning-plates urgency gradient: calm → amber → orange → red

## Usage

Generate fresh JSON — timestamps are computed relative to *now* on every
run, so the urgency gradient always lands in the right place regardless of
when you run this (a dated, static snapshot would drift out of range within
days):

```bash
node demo-data/generate.js > board.json
```

Import it into a **throwaway instance only** — `mode=replace` deletes the
target account's existing tiles, tasks, and goals first:

```bash
PORT=3099 DB_PATH=/tmp/taskpapr-demo.db node server.js &

node demo-data/generate.js | curl -X POST 'http://localhost:3099/api/import?mode=replace' \
  -H "Content-Type: application/json" --data-binary @-
```

Against a multi-user instance, add `-H "Authorization: Bearer tp_..."` (an
API key, see Settings → API keys) — single-user mode needs no auth header.

See [`docs/api.md`](../docs/api.md) for the full `POST /api/import` format.

## Why this exists

Built while capturing the screenshots for the docs site — the recurring
urgency examples originally needed a workaround (patching `created_at`
directly in SQLite after import) because `POST /api/import` silently
dropped that field. That's fixed now (`created_at` round-trips properly),
so this script produces a working demo board with a single `curl` call —
no manual DB surgery required.
