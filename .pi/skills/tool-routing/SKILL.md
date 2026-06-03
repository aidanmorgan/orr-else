# Tool Routing Skill

## Raw-Output / Minimal-Schema Contract

Every Orr Else tool follows a uniform archival contract:

- **Complete raw output** is persisted to harness-managed tool-calls storage at
  `PI_TOOL_CALL_DIR/{beadId}/{stateId}/{actionId}/{toolName}/{toolInvocationId}`.
- **The model-facing return value** is the tool's own minimal schema — not a
  generic shared envelope. There is no universal `resultPreview`, `outputArchive`,
  or `truncation` field across all tools.
- **To inspect raw output**: issue an explicit follow-up operation naming the
  specific missing fact (e.g. re-run the tool with narrower arguments). Do not
  assume a generic archive path exists or that a preview field carries the full
  result.

**Forbidden interpretation patterns** (do not rely on these as universal behavior):
- `resultPreview`, `diagnosticPreview`, `outputPreview` — not required by any
  Orr Else bundled tool.
- `outputArchive` / `artifactRef` as a universal return key — not present in
  bundled tool schemas.
- Truncation flags (`stdoutTruncated`, `stderrTruncated`) — not emitted by
  bundled tools.
- `inlineResultBytes`, byte-budget, or output-limit fields — removed from all
  bundled tools.
- Sample arrays or `items[0..N]` caps as the primary output-control mechanism.

---

## Built-In Control-Plane Tools

These tools are registered in `src/extension.ts` and have `rawOutputLocation:
none_minimal` (their native result is already minimal, no separate archive
step required) unless noted.

### orr_else
- **Schema fields**: opaque acknowledgement record.
- **Raw-output file/ref**: none (none_minimal).
- **Pass/fail authority**: not applicable — routing/dispatch tool.
- **Rerun strategy**: not applicable.

### tick_item / tick_items / add_checklist_item
- **Schema fields**: ack with item text and checked state.
- **Raw-output file/ref**: none (none_minimal).
- **Pass/fail authority**: harness validates evidence on each tick; rejected ticks
  return an error message.
- **Rerun strategy**: re-call with corrected evidence text. Do not re-tick an
  already-checked item.

### get_outstanding_tasks
- **Schema fields**: array of outstanding mandatory checklist items; each item
  has `text`, `mandatory`, `type`, `checked`.
- **Raw-output file/ref**: tool_calls_dir archive (deterministicCompaction: true).
- **Pass/fail authority**: returns the live checklist state — caller decides whether
  outstanding items constitute a blocker.
- **Rerun strategy**: re-call to refresh after ticking items.

### submit_checkpoint
- **Schema fields**: ack with checkpoint ID and recorded evidence summary.
- **Raw-output file/ref**: none (none_minimal).
- **Pass/fail authority**: harness validates that evidence is present and non-empty;
  empty evidence causes rejection.
- **Rerun strategy**: re-call with more specific evidence text or richer artifact refs.

### signal_completion
- **Schema fields**: outcome ack (SUCCESS / FAILURE) or rejection message.
- **Raw-output file/ref**: none (none_minimal).
- **Pass/fail authority**: harness programmatically rejects SUCCESS until all
  mandatory checklist items are checked and a checkpoint exists.
- **Rerun strategy**: address blockers reported in the rejection message, then rerun.

### request_context_restart / request_harness_restart
- **Schema fields**: minimal ack; harness initiates the restart.
- **Raw-output file/ref**: none (none_minimal).
- **Pass/fail authority**: harness controls restart execution; tool always acks.
- **Rerun strategy**: do not retry restart requests — one call is sufficient.

### get_artifact_paths
- **Schema fields**: named artifact slots (`plan`, `post_review`, etc.) each with
  a resolved absolute file path and, optionally, a size estimate.
- **Raw-output file/ref**: tool_calls_dir archive (deterministicCompaction: true).
- **Pass/fail authority**: caller; absent slot = artifact not yet created for this Bead.
- **Rerun strategy**: single call per artifact lookup; use `query_artifact` to read
  specific fields from large artifacts.

### query_artifact
- **Schema fields**: projection result — the requested field(s) extracted from the
  artifact JSON, with per-projection `byteCount` and `tokenEstimate`.
- **Raw-output file/ref**: tool_calls_dir archive (deterministicCompaction: true).
- **Pass/fail authority**: caller; missing field = projection not present in artifact.
- **Rerun strategy**: re-call with `summary: true` first to get size estimates, then
  request only the named projections needed.

### get_compatibility_context
- **Schema fields**: compatibility rules and agent path configuration for the current
  project (e.g. Claude/Codex rules, hook paths).
- **Raw-output file/ref**: tool_calls_dir archive (deterministicCompaction: true).
- **Pass/fail authority**: caller; empty result = no compatibility config present.
- **Rerun strategy**: single call; result is stable within a session.

### read_path_context
- **Schema fields**: `exists`, `totalLines`, `validOffsetRange`,
  `correctedOffsetHint` (when offset is out of range), `nearestMatches` (when
  file not found).
- **Raw-output file/ref**: tool_calls_dir archive (deterministicCompaction: false —
  raw output may be large for large files).
- **Pass/fail authority**: caller; use `exists: false` to avoid ENOENT retries.
- **Rerun strategy**: use the `correctedOffsetHint` or `nearestMatches` from the
  prior result before retrying.

### harness_status
- **Schema fields**: configured tool counts, active slot counts, state machine
  summary, and health indicators.
- **Raw-output file/ref**: tool_calls_dir archive (deterministicCompaction: true).
- **Pass/fail authority**: caller; use to verify tool availability and slot capacity.
- **Rerun strategy**: single call to check status; re-call only if status may have
  changed (e.g. after a spawn/release cycle).

### pre_signal_audit
- **Schema fields**: `gateReady` (bool), `missingChecklistItems`, `requiredTools`
  (with pass/fail/never_invoked per tool), `checkpointStatus`,
  `terminalFailureLimitState`, and `blockingEvidence`.
- **Raw-output file/ref**: tool_calls_dir archive (deterministicCompaction: true).
- **Pass/fail authority**: caller; call this BEFORE `submit_checkpoint` or
  `signal_completion` to confirm gate readiness and address all blockers.
- **Rerun strategy**: resolve each blocking item listed, then re-call to confirm
  `gateReady: true` before proceeding.

---

## Beads (bd) Plugin Tools

Plugin source: `src/plugins/bd.ts`.

### bd_ready
- **Schema fields**: array of `Bead` records — each with `id`, `title`, `status`,
  `priority`, `assigned_to`, `dependencies`, `lastActivity`, `retryCount`,
  `compactionCount`, `totalExecutionTimeMs`.
- **Raw-output file/ref**: tool_calls_dir archive (deterministicCompaction: true).
- **Pass/fail authority**: caller; empty array = no unblocked work.
- **Rerun strategy**: re-call with a smaller `limit` if the result set is too large
  for immediate processing.

### bd_list
- **Schema fields**: `{ total, returned, truncated, filters, items[] }`. Each item
  has `id`, `title`, `status`, `priority`, `assigned_to`, `dependencies`,
  `lastActivity`, `retryCount`, `compactionCount`, `totalExecutionTimeMs`,
  `restartRequested`, lease fields, and optional `notesPreview`.
  `truncated: true` indicates the full list was larger than `limit`.
- **Raw-output file/ref**: tool_calls_dir archive (deterministicCompaction: true).
- **Pass/fail authority**: caller; use `truncated` only to decide whether to narrow
  the query — not as a signal of error.
- **Rerun strategy**: reduce `limit` or add a `status`/`stateId` filter; use
  `bd_get_bead` for full detail on a specific item.

### bd_export_jsonl
- **Schema fields**: `{ outputPath, recordCount, sha256 }`. The JSONL content is
  written to `outputPath` (in `tool_output_dir`); it is never returned inline.
- **Raw-output file/ref**: tool_output_dir — `outputPath` is the absolute path to
  the written file. Inspect the file via native Read if needed.
- **Pass/fail authority**: non-zero `recordCount` = records exported. Zero = nothing
  to export or bd returned no data.
- **Rerun strategy**: re-call with different flags (`--all`, `--scrub`, etc.);
  provide an explicit `outputPath` to avoid timestamp-based filename collisions.

### bd_import_jsonl
- **Schema fields**: `{ created, updated, skipped? }` — import operation counts.
- **Raw-output file/ref**: none (none_minimal).
- **Pass/fail authority**: caller; zero `created + updated` with non-zero input
  indicates a dedup / dry-run situation.
- **Rerun strategy**: re-call with `dryRun: true` to preview before committing;
  use `dedup: true` to skip duplicate titles.

### bd_create
- **Schema fields**: full `Bead` record of the created item (id, title, status,
  priority, description, notes, dependencies, metadata).
- **Raw-output file/ref**: none (none_minimal — Beads stores the record).
- **Pass/fail authority**: success = record returned; failure throws.
- **Rerun strategy**: do not retry; check if the Bead was already created via
  `bd_list` before re-calling.

### bd_get_bead
- **Schema fields**: full `Bead` record. With `includeDetails: true`, also includes
  `checklists`, `dynamicChecklists`, `handovers`, `completedActionIds`, and their
  `*Truncated` companion flags (each indicates whether the list was trimmed for
  context budget). Use `bd_get_state_chart` for targeted statechart details.
- **Raw-output file/ref**: tool_calls_dir archive (deterministicCompaction: true).
- **Pass/fail authority**: missing record throws; caller interprets `status` and
  metadata fields.
- **Rerun strategy**: call with `includeDetails: true` when checklist/handover
  detail is needed; use `bd_get_state_chart` for event-store projection.

### bd_get_state_chart
- **Schema fields (compact default)**: `beadId`, `currentState`, `previousState`,
  `beadStatus`, `activeActionId`, `assignedTo`, `lease`, `worktreePath`,
  `handoverCount`, `recentHandovers`, `compactionCount`, `restartRequested`,
  `mergeAndCommit`, `lastEventId`, `lastUpdatedAt`, `completedActionCount`,
  `recentCompletedActionIds`, `checkedItemCount`, `addedChecklistItemCount`,
  `checkpointCount`, `recentCheckpoints`, `transitionCount`, `recentTransitions`.
  With `includeDetails: true`, `recentXxx` fields are replaced by bounded full
  arrays with `*Truncated` companion flags.
- **Raw-output file/ref**: tool_calls_dir archive (deterministicCompaction: true).
- **Pass/fail authority**: caller; reflects the authoritative event-store projection.
- **Rerun strategy**: re-call with `includeDetails: true` for full checklist,
  checkpoint, transition, and handover arrays. The `*Truncated` flags indicate
  whether bounded windows trimmed older entries — not data loss.

### bd_claim
- **Schema fields**: minimal ack — `{ id, status, lease, restartRequested?,
  restartKind?, restartEvent?, restartFromState?, restartTargetState? }`.
  Full record available via `bd_get_bead`.
- **Raw-output file/ref**: none (none_minimal).
- **Pass/fail authority**: success = claim recorded; failure throws (already
  claimed by another worker).
- **Rerun strategy**: do not retry; check the existing claim via `bd_get_state_chart`.

### bd_release
- **Schema fields**: minimal ack — `{ id, status }` or `{ id, tombstoned: true }`
  when the Bead was deleted from the task store.
- **Raw-output file/ref**: none (none_minimal).
- **Pass/fail authority**: success = release recorded; tombstone = Bead purged.
- **Rerun strategy**: do not retry; release is idempotent at the event-store level.

### bd_update_status
- **Schema fields**: minimal ack — `{ id, status }`. Only coarse `BeadStatus`
  values are accepted (`ready`, `in_progress`, `completed`, `blocked`, `deferred`,
  `failed`). Statechart state names are rejected at the tool boundary.
- **Raw-output file/ref**: none (none_minimal).
- **Pass/fail authority**: throws on invalid status; success = harness recorded the
  coarse lifecycle transition.
- **Rerun strategy**: pass a valid `BeadStatus` value; statechart states must be
  written only via the event store, not via this tool.

### bd_heartbeat
- **Schema fields**: minimal ack — `{ workerId, beadId, accepted: true }`.
- **Raw-output file/ref**: none (none_minimal).
- **Pass/fail authority**: accepted = signal posted; failure throws.
- **Rerun strategy**: re-call at the configured heartbeat interval; do not fan out.

### bd_get_heartbeats
- **Schema fields**: array of live heartbeat records (worker/bead/state/pid metadata
  from the signaling API).
- **Raw-output file/ref**: tool_calls_dir archive (deterministicCompaction: true).
- **Pass/fail authority**: caller; empty array = no active heartbeats.
- **Rerun strategy**: single call to snapshot current heartbeat state.

---

## Git Plugin Tools

Plugin source: `src/plugins/git.ts`.

### create_worktree
- **Schema fields**: `WorktreeResult` — `{ success: true, path }` or
  `{ success: false, error }`. `path` is the absolute worktree path.
- **Raw-output file/ref**: none (none_minimal).
- **Pass/fail authority**: `success` field; `error` contains the git error message.
- **Rerun strategy**: do not retry on `success: false` without resolving the
  underlying git error; re-call is safe if the worktree was never created
  (existing worktree is reused, not re-created).

### remove_worktree
- **Schema fields**: `MergeResult` — `{ success: true }` or
  `{ success: false, error }`.
- **Raw-output file/ref**: none (none_minimal).
- **Pass/fail authority**: `success` field.
- **Rerun strategy**: idempotent — a missing worktree returns `success: true`.

### merge_and_commit
- **Schema fields**: `MergeResult` — `{ success: true }` or
  `{ success: false, error }`. Merge commit happens on the target branch; the
  worktree branch is auto-removed if all gates pass.
- **Raw-output file/ref**: tool_calls_dir archive (deterministicCompaction: true —
  git output is reduced to success/error).
- **Pass/fail authority**: `success` field; `error` names the conflict or git error.
- **Rerun strategy**: resolve merge conflicts or stage changes before retrying. Do
  not retry concurrently.

---

## Mailbox Plugin Tools

Plugin source: `src/plugins/mailbox.ts`.

### send_mailbox_message
- **Schema fields**: minimal ack — `{ messageId, status: "sent" }`. Full body is
  archived by the harness.
- **Raw-output file/ref**: none (none_minimal).
- **Pass/fail authority**: success = ack returned; failure throws.
- **Rerun strategy**: do not resend without verifying the recipient has not already
  received the original message.

### check_mailbox
- **Schema fields**: array of message routing records — each with `messageId`,
  `from`, `to`, `type`, `timestamp`. No inline message bodies.
- **Raw-output file/ref**: tool_calls_dir archive (deterministicCompaction: true).
- **Pass/fail authority**: caller; empty array = no pending messages.
- **Rerun strategy**: re-call to poll; use `fetch_mailbox_message` to retrieve the
  body of a specific message by ID.

### fetch_mailbox_message
- **Schema fields**: `{ messageId, found, message? }`.
  - `messageId`: the ID requested.
  - `found`: `true` when the message exists in the mailbox store; `false` otherwise.
  - `message`: the full message record (present when `found: true`) — includes
    `from`, `to`, `type`, `timestamp`, and the complete inline body.
- **Raw-output file/ref**: tool_calls_dir archive (deterministicCompaction: true).
- **Pass/fail authority**: `found` field; `found: false` = message not present
  (not yet delivered, or ID incorrect).
- **Rerun strategy**: `check_mailbox` first to obtain valid `messageId` values;
  then call `fetch_mailbox_message` once per message whose body is needed.
  This is the fetch-selector complement to `check_mailbox`: `check_mailbox`
  returns routing metadata for all pending messages; `fetch_mailbox_message`
  fetches one full body by ID.

---

## Quality Plugin Tools

Plugin source: `src/plugins/quality.ts`.

### compress_session_logs
- **Schema fields**: `SessionLogSummary` — `{ rawLogFile, lineCount, byteCount,
  errorCount, warnCount, components[], recentErrors[] }`.
  - `rawLogFile`: absolute path to the archived log.
  - `recentErrors`: first up to 10 error lines (deterministic semantic selection).
  - `components`: up to 10 unique component names found in the log.
- **Raw-output file/ref**: `rawLogFile` — absolute path to the archived log file.
  Inspect via native Read only when a specific error line requires deeper context.
- **Pass/fail authority**: caller; `errorCount > 0` indicates issues in the session.
- **Rerun strategy**: single call per log archival — each call writes a new
  timestamped file. Do not re-archive the same log content.

---

## Teammates Plugin Tool

Plugin source: `src/plugins/teammates.ts`.

### spawn_teammate
- **Schema fields**: `{ success: true, paneId? }` or `{ success: false, error }`.
- **Raw-output file/ref**: none (none_minimal).
- **Pass/fail authority**: `success` field; `error` names the failure reason
  (no available slots, tmux error, etc.).
- **Rerun strategy**: do not retry immediately on slot exhaustion; check
  `harness_status` for available slots and wait for a release cycle.

---

## Meta Plugin Tool

Plugin source: `src/plugins/meta.ts`.

### create_new_plugin
- **Schema fields**: `CreatePluginResult` — `{ success: true, name, path }` or
  `{ success: false, error }`.
- **Raw-output file/ref**: none (none_minimal — the written file is the artifact).
- **Pass/fail authority**: `success` field.
- **Rerun strategy**: do not retry on `success: false` without fixing the name or
  content error; re-call with a corrected payload.

---

## Native Pi Tools

These are Pi's own built-in tools observed by the harness policy.
Source: `src/constants/index.ts` (DEFAULT_OBSERVED_PI_TOOLS).

### Bash
- **Schema fields**: Pi-native — `stdout`, `stderr`, `exitCode`.
- **Raw-output file/ref**: tool_calls_dir (harness archives complete output;
  `deterministicCompaction: false` — raw output is passed unchanged).
- **Pass/fail authority**: `exitCode`; zero = success.
- **Rerun strategy**: do not use Bash as a fallback for configured project-tool
  capabilities. Use native Pi tools (Read/Find/Grep/LS) and configured tools
  instead.

### Read / Write / Edit
- **Schema fields**: Pi-native operation ack or file content.
- **Raw-output file/ref**: Read archives to tool_calls_dir; Write/Edit are
  none_minimal (mutation ack).
- **Pass/fail authority**: Pi error message for ENOENT or invalid offset; use
  `read_path_context` first to verify path and offset range.
- **Rerun strategy**: call `read_path_context` to get `correctedOffsetHint` before
  retrying a failed Read.

### Find / Grep / LS
- **Schema fields**: Pi-native search results.
- **Raw-output file/ref**: tool_calls_dir archive (raw, no compaction).
- **Pass/fail authority**: caller; empty result = no match (not an error).
- **Rerun strategy**: narrow the pattern or path before retrying.

### MCP
- **Schema fields**: Pi-native MCP tool result (tool-specific schema).
- **Raw-output file/ref**: tool_calls_dir archive.
- **Pass/fail authority**: caller; MCP error response = tool failure.
- **Rerun strategy**: re-call with corrected arguments; do not fan out concurrent
  MCP calls for the same resource.

---

## Code Navigation Decision Flowchart

```
Need code overview?            → codemap
Need precise code match/edit?  → ast_grep (rg to shortlist first)
Need compiler symbol graph?    → LSP
Need library API docs?         → reference_docs
Need quality gate result?      → use configured project tools (see project SKILL.md)
Need change history/intent?    → Bash: git log/blame
Need harness artifact path?    → get_artifact_paths → query_artifact
Need raw output from a tool?   → re-run the tool with narrower arguments
                                  OR use native Read on rawLogFile / outputPath
                                  (never assume a generic archive path exists)
```
