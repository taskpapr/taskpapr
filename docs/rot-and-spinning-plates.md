# Task Rot & Spinning Plates

Two complementary features that give tasks a sense of urgency through **visual heat** — without requiring you to set due dates on everything.

---

## Task Rot

### The idea

A task that nobody has looked at in a long time quietly turns the colour of old paper. The longer it sits untouched, the more "aged" it looks. This makes neglected tasks stand out without any notifications or badges.

### How it works

Every task tracks a **last-acknowledged timestamp** (`last_acknowledged_at`). This is updated when you:
- Open the task detail panel and change anything (title, notes, date, etc.)
- Click the **✓ Touch** button in the panel footer
- Perform a **Touch** action from the right-click context menu

The rot ratio is calculated client-side each time the board renders:

```
rot ratio = time elapsed since last touch ÷ rot interval
```

The **rot interval** is per-task (default: weekly). The visual mapping:

| Ratio | Appearance |
|-------|-----------|
| 0 – 0.5 | No change (invisible) |
| 0.5 – 1.0 | Faint grey wash begins |
| 1.0 – 1.5 | Warm parchment/yellowed paper tint |
| 1.5+ | Fully aged parchment (capped) |

The colour progression deliberately mimics paper ageing — cool grey → warm yellow-brown — rather than alarming red, keeping the board calm.

### User journey

1. **New task created** — starts fresh, no tint.
2. **Days / weeks pass** — task gradually acquires a warm parchment tint if untouched.
3. **You notice the aged colour** — it's a gentle prompt: *"Have you thought about this recently?"*
4. **You open the task** — update it, add a note, or just click **✓ Touch** to confirm you've consciously decided to leave it.
5. **Tint resets** — the clock starts again from now.

### Per-task control

Open any task → detail panel → **Remind me if untouched** checkbox:

- ☑ **Checked** — rot is active. The speed selector appears to the right (Daily / Weekly / Every 2 weeks / Monthly / Every 3 months).
- ☐ **Unchecked** — rot is disabled for this task. The speed selector is hidden. The task will never age regardless of how long it sits.

**Recurring tasks** (spinning plates) are excluded from rot — they have their own urgency system (see below).

---

## Spinning Plates

### The idea

Recurring tasks — weekly reviews, monthly bills, repeat prescriptions — need to be done on a rhythm. Once completed, they should feel calm. As the next due date approaches (and especially if missed), they should feel increasingly urgent. Like spinning plates: you need to keep them going.

### How it works

Spinning plates activates automatically when a task has a recurrence interval set.

The urgency ratio is calculated client-side:

```
ref point     = most recent of (last_done_at, created_at)
urgency ratio = time since ref point ÷ recurrence interval
```

Using the later of the two timestamps means urgency fires correctly on the **first occurrence** of a task (before it has ever been completed), not just after it has been done at least once.

The visual mapping:

| Ratio | Appearance |
|-------|-----------|
| 0 – 0.5 | No tint (just completed, all good) |
| 0.5 – 1.0 | Faint amber tint (coming up) |
| 1.0 | Due now — orange tint, amber left border |
| 1.0 – 1.5 | Orange → deep red (overdue, escalating) |
| 1.5+ | Maximum red urgency (capped) |

The colour progression (amber → orange → red) is deliberately traffic-light — familiar, intuitive, impossible to ignore when a plate is about to fall.

### User journey

1. **Create a recurring task** — e.g. "Pay credit card". Set a recurrence (monthly). Optionally set a due date.
2. **Task appears calm** — no tint immediately after creation.
3. **Time passes** — as the recurrence interval approaches 100% elapsed since creation, the amber tint appears. After the full interval, it turns orange. Past due, it escalates to red. This works even before the task has been completed for the first time.
4. **Complete the task** (tick it off) — it resets: status returns to `active` (or `dormant` if you've set a visibility window), `last_done_at` is recorded, `next_due` advances by one interval.
5. **Time passes again** — urgency now counts from `last_done_at`. Same progression repeats.
6. **You complete it again** — tint resets to nothing. Plate is spinning safely again.

### Dormancy (optional)

For tasks you don't want cluttering the board until they're actually approaching:

- Open the task → set **Show task** to "3 days before due" (or any window).
- The task becomes **dormant** and disappears from the board.
- It reappears automatically N days before `next_due`.
- Dormant tasks are shown as a **👻 ghost pill** on the tile header — click it to peek at what's sleeping.

---

## How they differ

| | Task Rot | Spinning Plates |
|--|---------|----------------|
| **For** | One-off tasks you might forget about | Recurring tasks on a rhythm |
| **Trigger** | Time since last human touch | Time since last completion |
| **Palette** | Grey → warm parchment (subtle) | Amber → orange → red (urgent) |
| **Resets when** | You touch/acknowledge the task | You complete (tick) the task |
| **Opt-out** | Per task: uncheck "Remind me if untouched" | N/A — only activates on recurring tasks |
| **Applies to** | Non-recurring active/WIP tasks | Tasks with a recurrence interval |

Both are **purely visual** — no notifications, no badges, no noise. The board itself tells you what needs attention.