# Harness Rules

These rules apply to all agents running in this project.

## Core Principles

1. **Always use checklist items** — register checklist items with `add_checklist_item`
   before performing work. Tick them with `tick_items` (one or more at once) providing concrete evidence.

2. **Signal explicitly** — call `signal_completion` when your state's work is done.
   Never assume the harness will infer completion.

3. **Evidence is required** — every checklist tick must include inline evidence or
   an `evidencePath` pointing to an artifact file.

4. **Stay in scope** — do not modify files outside your assigned bead's scope
   unless the plan explicitly requires it.

5. **Request restarts cleanly** — if you need a context restart, call
   `request_context_restart` with a clear resumption handover.

## Prohibited Actions

- Do NOT call `merge_and_commit` from a worker/teammate process.
- Do NOT skip checklist items without evidence.
- Do NOT write directly to `.pi/events/` or `.pi/logs/` — these are harness-managed.
