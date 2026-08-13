#!/usr/bin/env node
'use strict';

// Generates a taskpapr demo-data import payload — see docs/api.md's
// `POST /api/import` section for the format. Timestamps are computed
// relative to "now" on every run, so the four "Recurring examples" tasks
// always land at the same *relative* points on the spinning-plates urgency
// gradient (public/app.js computeUrgency()) regardless of when this script
// actually runs — a static, dated JSON snapshot would drift out of that
// range within days and start showing the wrong colours.
//
// Usage:
//   node demo-data/generate.js > board.json
//   node demo-data/generate.js | curl -X POST 'http://localhost:3033/api/import?mode=replace' \
//     -H "Authorization: Bearer tp_..." -H "Content-Type: application/json" --data-binary @-
//
// mode=replace wipes the target account's existing board first — point this
// at a throwaway instance, never a real/long-lived one.
//
// See demo-data/README.md for what's in this board and why.

function hoursAgo(h) {
  return new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
}

const payload = {
  version: '2',
  goals: [
    { title: 'Launch MVP', notes: null, position: 1 },
  ],
  tiles: [
    {
      name: 'Work', x: 40, y: 40, width: 280, color: null, position: 1,
      tasks: [
        { title: 'Review proposal', status: 'active', position: 0 },
        { title: 'Email client',    status: 'active', position: 1 },
        { title: 'Deep work block', status: 'active', position: 2, today_flag: 1 },
      ],
    },
    {
      name: 'Personal', x: 360, y: 40, width: 260, color: null, position: 2,
      tasks: [
        { title: 'Book dentist', status: 'active', position: 0, today_flag: 1 },
      ],
    },
    {
      name: 'Project', x: 40, y: 380, width: 280, color: null, position: 3,
      tasks: [
        { title: 'Wireframes',   status: 'wip',    goal: 'Launch MVP', position: 0 },
        { title: 'Landing copy', status: 'done',   goal: 'Launch MVP', position: 1 },
        { title: 'Beta invite',  status: 'active', goal: 'Launch MVP', position: 2 },
      ],
    },
    {
      name: 'Errands', x: 360, y: 380, width: 260, color: null, position: 4,
      tasks: [
        { title: 'Return library book', status: 'active',  position: 0 },
        { title: 'Renew passport',      status: 'dormant', position: 1 },
        { title: 'Dentist follow-up',   status: 'dormant', position: 2 },
      ],
    },
    {
      // Four daily-recurring tasks tuned to the calm / amber / orange / red
      // steps of the urgency gradient (urgency = hours elapsed / 24, daily
      // recurrence): ~1h ago -> ~0.04 (calm), ~14h -> ~0.58 (amber),
      // ~20h -> ~0.83 (orange), ~30h -> ~1.25 (red, gradient caps at 1.5).
      name: 'Recurring examples', x: 700, y: 40, width: 300, color: null, position: 5,
      tasks: [
        { title: 'Water plants',    status: 'active', recurrence: 'daily', position: 0, created_at: hoursAgo(1) },
        { title: 'Standup notes',   status: 'active', recurrence: 'daily', position: 1, created_at: hoursAgo(14) },
        { title: 'Backup database', status: 'active', recurrence: 'daily', position: 2, created_at: hoursAgo(20) },
        { title: 'Pay invoice',     status: 'active', recurrence: 'daily', position: 3, created_at: hoursAgo(30) },
      ],
    },
  ],
};

process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
