# Tool-Validated State Protocol

Orr Else runs as a pi.dev extension. `/orr-else` starts the coordinator in the current Pi session. The coordinator claims ready Beads, provisions per-bead worktrees according to the configured worktree-allocation policy, spawns teammate Pi processes in tmux, receives completion signals, updates Beads, and replenishes available slots.

## Completion Protocol

Each teammate process automatically enters teammate mode when launched with `PI_ORR_ELSE_WORKER=1`, `PI_BEAD_ID`, and `PI_STATE_ID`. The extension injects the configured state prompt and enables these tools:

- `tick_item`: mark an exact checklist item complete with concrete evidence.
- `get_outstanding_tasks`: list mandatory items still missing evidence.
- `add_checklist_item`: add a runtime checklist item to the active state turn.
- `submit_checkpoint`: finalize the state with a dense summary, handover evidence, and an `outcome`.
- `request_context_restart`: hand off to a fresh state agent through the configured context-restart event after repeated context compaction or rotation.

The state turn must tick every mandatory item before a `SUCCESS` checkpoint can be accepted. In teammate mode, `submit_checkpoint` records the worklog/handover and emits typed teammate events to the coordinator through the `signal_completion` tool. The coordinator alone advances Bead status and starts the next state or ready Bead.

Checklist items are owned by the configured harness YAML file, which defaults to `harness.yaml` and can be changed with `/orr-else --config <path>` or `ORR_ELSE_CONFIG`. A state-level `checklist` applies to every action in that state, and an action-level `checklist` adds items for that action only. Either value can be an inline YAML array or a file path to a YAML/JSON checklist. The runtime derives the active list from required validation gates, state items, and action items, with exact-text de-duplication; the first item's metadata is preserved and `mandatory: true` wins across duplicates.

States can also add dynamic checklist items after startup. `add_checklist_item` accepts one item at a time, appends it to the active checklist, persists it in Bead metadata, and makes it enforceable by `tick_item`, `get_outstanding_tasks`, and `signal_completion`. A project-specific sequenced tool action may return JSON `toolCalls` or `frameworkToolCalls` entries that invoke `add_checklist_item`; the framework executes those generic tool calls without knowing the project tool's purpose.

Actions are ordered sub-state steps inside the parent state. An action may declare `context: parent` or `context: fresh`; omitted context defaults to `parent`. Parent-context tool actions before the selected prompt run in the current worker. Fresh-context actions run as isolated sub-state turns: successful non-final actions are recorded as completed while the Bead remains in the parent state, then the coordinator spawns the next pending action.

## Teammate Events

The coordinator accepts typed events on `/signal`, `/signals`, and `/events`. Every event has `type`, `beadId`, `workerId`, `stateId`, `timestamp`, and `idempotencyKey`.

Valid event types are `TEAMMATE_STARTED`, `STATE_STARTED`, `CHECKPOINT_ACCEPTED`, `STATE_TRANSITIONED`, `STATE_FAILED`, `STATE_BLOCKED`, `CONTEXT_RESTART_REQUESTED`, `HEARTBEAT`, and `TEAMMATE_EXITED`. Checkpoint, terminal state, and context-restart events also include `actionId`, `transitionEvent`, `summary`, `evidence`, and `handover`.

`signal_completion` is the public teammate tool for provider portability. Malformed typed event payloads are rejected with HTTP `400` before coordinator mutation code runs, and syntactically invalid JSON on typed signal endpoints also returns `400`.

## State Flow

The bundled example flow uses provider-portable states:

- `Planning`: codebase/history/rules exploration and surgical plan.
- `AdversarialPreReview`: independent plan critique before implementation.
- `Implementation`: execution of the approved plan; receives a worktree by default (configurable via `provisionWorktree`).
- `AdversarialPostReview`: independent implementation audit before completion.

## Provider Routing

Provider/model routing is configured in `harness.yaml`:

- `settings.modelProviders.claude` maps to Pi's `anthropic` provider.
- `settings.modelProviders.openai` maps to Pi's `openai` provider.
- Each state can set `llmProvider`, `model`, and `thinking`.

Before spawning a teammate, the coordinator resolves the state provider and starts the teammate Pi process with the matching `--provider`, `--model`, and `--thinking` flags.

## Process Lifecycle

1. `ORCHESTRATE`: `/orr-else` starts the coordinator and signaling server.
2. `CLAIM`: the coordinator reads `bd_ready`, sorts work, and claims a Bead with `bd_claim`.
3. `PREPARE`: states that resolve `provisionWorktree` as `true` (per the worktree-allocation policy) create a worktree through `create_worktree`.
4. `SPAWN`: `spawn_teammate` starts a Pi process in tmux with teammate environment variables.
5. `EXECUTE`: the teammate injects state identity, provider metadata, rules, docs, history, and checklist protocol.
6. `VALIDATE`: `submit_checkpoint` verifies mandatory evidence and records a worklog/handover.
7. `SIGNAL`: the teammate sends typed lifecycle/checkpoint/terminal events to the coordinator over the local signaling server.
8. `TRANSITION`: the coordinator advances the Bead through the configured state transition. On terminal success it commits dirty worktree changes, merges the Bead branch into the target branch, closes the Bead, removes the worktree, and replenishes slots.

Harness process restarts and context exhaustion are separate concepts. An already claimed Bead resumes through `settings.harnessRestartEvent` (default `HARNESS_RESTART`) and can receive `settings.harnessRestartPrompt`. A teammate that has compacted or rotated context too many times calls `request_context_restart`, which emits `CONTEXT_RESTART_REQUESTED` and routes through `settings.contextRestartEvent` (default `CONTEXT_RESTART`) with optional `settings.contextRestartPrompt`.

## JSONL Interop

The Beads tool layer exposes `bd_export_jsonl` and `bd_import_jsonl`. These delegate directly to `bd export` and `bd import`, preserving Beads' newline-delimited JSON compatibility and upsert semantics while keeping agents inside the typed tool surface. Large exports are bounded when returned inline; pass `outputPath` when a full database export is required.
