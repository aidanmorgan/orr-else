# Orr Else

Orr Else is a `pi.dev` agentic engineering harness. It runs as a Pi extension, keeps the starting Pi session as the coordinator, and launches teammate Pi processes in `tmux` to execute configured statechart states against Beads tasks.

The harness is designed around deterministic control:

- Beads is the source of truth for task state.
- `harness.yaml` defines the workflow, prompts, providers, checklists, tools, and transitions.
- Teammates are state executions, not long-lived reusable agents.
- Completion is accepted only through tool-recorded evidence and typed lifecycle signals.
- Work is isolated through per-bead Git worktrees (provisioned per the configurable worktree-allocation policy) and harness-owned merge steps.
- Observability, logs, worklogs, and JSONL exports make runs auditable.

## Runtime Flow

1. Load the extension in Pi:

   ```bash
   pi -e .pi/extensions/orr-else.ts
   ```

2. Start the coordinator inside that Pi session:

   ```text
   /orr-else
   ```

3. The coordinator starts a local signaling server, reads `harness.yaml`, and fills up to `settings.maxConcurrentSlots` teammate slots.

4. The supervisor polls `bd_ready`, scores available Beads, claims work through `bd_claim`, prepares the workspace, and spawns teammate Pi processes in `tmux`.

5. Each teammate receives environment variables such as `PI_BEAD_ID`, `PI_STATE_ID`, `PI_WORKER_ID`, `PI_WORKTREE_PATH`, `PI_SESSION_STATE_ID`, and `ORR_ELSE_API_BASE`.

6. The teammate receives a generated state prompt containing its identity, state instructions, checklist protocol, project tools, provider metadata, paths, rules, and action prompt.

7. The teammate records evidence with `tick_item`, writes checkpoints with `submit_checkpoint`, and finishes by calling `signal_completion`.

8. The coordinator receives a typed event, validates idempotency, advances the Bead through the configured state transition, releases the lease, and replenishes slots.

9. On terminal success, the coordinator owns the commit, merge, Bead closure, and worktree cleanup.

Useful command variants:

```text
/orr-else --max-slots 6
/orr-else --bead <id>
/orr-else --config <path>
/orr-else status
/orr-else stop
```

Attach to teammate panes with:

```bash
tmux attach -t orr-else
```

## Core Concepts

### Pi Extension

The harness is loaded through Pi's extension system. `src/extension.ts` registers the `/orr-else` command, built-in control tools, plugin tools, state prompt injection hooks, teammate mode startup, and shutdown handling.

The package also exposes a CLI entry point named `orr-else`, but the real orchestrator is the Pi command registered by the extension.

### Path Resolution

`src/core/Paths.ts` separates the project root from the harness install root. Project paths resolve from `PI_PROJECT_ROOT` or the current working directory. Install paths resolve from the package location so schema and default resources can be found when the harness is installed elsewhere.

### Environment Variables

The runtime uses explicit `PI_*` and `ORR_ELSE_*` variables to connect coordinator and teammate processes:

- `PI_PROJECT_ROOT`
- `PI_BEAD_ID`
- `PI_STATE_ID`
- `PI_WORKER_ID`
- `PI_ACTION_ID`
- `PI_WORKTREE_PATH`
- `PI_ORR_ELSE_WORKER`
- `PI_SESSION_STATE_ID`
- `PI_TRACE_ID`
- `PI_SPAN_ID`
- `PI_OBSERVABILITY_SESSION_ID`
- `PI_OBSERVABILITY_FILE_NAME`
- `ORR_ELSE_CONFIG`
- `ORR_ELSE_API_PORT`
- `ORR_ELSE_API_BASE`
- `LOG_LEVEL`

### Coordinator Session

The Pi session that runs `/orr-else` becomes the coordinator. It does not perform individual state work. It supervises flow control, owns Bead transitions, starts the signaling server, spawns teammates, and performs terminal merge and cleanup actions.

### Teammate Session

A teammate is a separate Pi process launched in `tmux`. It executes one Bead in one configured state. Teammate mode is activated by `PI_ORR_ELSE_WORKER=1` plus the assigned Bead and state environment variables.

Teammates get a restricted tool set for their role: checklist tools, checkpointing, signaling, Beads access, mailbox communication, quality checks, non-merge Git tools, configured project tools, and artifact path helpers.

### Beads

Beads is the task database and workflow source of truth. The harness accesses it only through the Beads tool layer, which delegates to the `bd` CLI from the project root.

Important Bead data includes:

- `id`, `title`, `description`, `notes`, assignee, dependencies, and comments from Beads.
- Harness metadata stored under `metadata.orr_else`.
- Harness status, worktree path, checklist evidence, handovers, completed action IDs, restart data, retry count, compaction count, total execution time, and lease metadata.

The Beads plugin exposes:

- `bd_ready`
- `bd_list`
- `bd_get_bead`
- `bd_create`
- `bd_claim`
- `bd_release`
- `bd_update_metadata`
- `bd_update_status`
- `bd_heartbeat`
- `bd_get_heartbeats`
- `bd_export_jsonl`
- `bd_import_jsonl`

### Bead Status

The harness recognizes these standard statuses:

- `ready`
- `in_progress`
- `completed`
- `blocked`
- `deferred`
- `failed`

If a Bead is `ready`, the flow manager starts it at the configured initial state. Otherwise, a status that matches a configured state is treated as the current state.

### Beads JSONL Interop

`bd_export_jsonl` and `bd_import_jsonl` preserve Beads' newline-delimited JSON import/export behavior. Exports can be returned inline for small outputs or written to a file for large databases.

### Leases

`bd_claim` records harness lease metadata with an owner and expiry. `bd_release` removes that lease and reopens an in-progress Bead when necessary. The default lease duration comes from `settings.agentTurnTimeoutMs`.

### Statechart Workflow

The workflow is configured in `harness.yaml` under `states`. Each state defines:

- `identity`: role, expertise, and constraints.
- `baseInstructions`: state-specific operating instructions.
- `actions`: prompt, checklist, tool, or script actions.
- `checklist`: state-level checklist items.
- `transitions`: at least `SUCCESS` and `FAILURE`.
- Optional provider, model, thinking level, skills, rule categories, restart prompts, required tools, and context settings.

State-level execution knobs include `defaultActionContextMode`, `maxContextTokens`, `handoverRequired`, `contextRotThreshold`, `worktree`, and `qualityCheckCommand`. These fields let a harness config describe how much context a state should use, whether handover is mandatory, and what execution or quality policy should apply.

The default flow is:

```text
Planning -> AdversarialPreReview -> Implementation -> AdversarialPostReview -> completed
```

Default failure paths route:

```text
Planning FAILURE -> Planning
AdversarialPreReview FAILURE -> Planning
Implementation FAILURE -> Implementation
AdversarialPostReview FAILURE -> Implementation
```

### States As Agents

The harness models agents as statechart states. A Planner, Implementer, or Reviewer is not a global profile; it is the identity and instruction bundle for the current state execution.

This keeps model choice, tools, checklist, and transition rules tied to the workflow phase rather than to a reusable profile label.

### Actions

Actions are ordered per-state sub-state steps. The schema supports:

- `prompt`: inject prompt text inline or from a file.
- `checklist`: checklist-centered state work.
- `tool`: tool-driven action definitions.
- `script`: script-driven action definitions.

Actions run in YAML order. Each action may set `context: parent` or `context: fresh`; omitted contexts default to `parent`. Parent-context tool actions that appear before the selected prompt action run in the current worker before the prompt is injected. Fresh-context actions run as isolated sub-state turns: a successful non-final action records completion, keeps the Bead in the parent state, releases the lease, and lets the coordinator spawn the next pending action.

### Outcomes And Transitions

`signal_completion` accepts an `outcome`, commonly `SUCCESS`, `FAILURE`, or `BLOCKED`. `FlowManager.nextState` maps the outcome through:

- `state.on[outcome]` for explicit custom routes.
- `state.transitions[outcome]` for standard routes.
- `completed` as the terminal success status.
- `blocked` as the terminal blocked status.

### Initial State

The initial state is `settings.startState`. It must name a state configured in the statechart.

### Scheduler

The scheduler sorts ready Beads before they are claimed. It scores work from:

- Waiting time since last activity.
- Prior execution time.
- Progress through the configured statechart.
- Retry and context-rotation penalties.

The weights live in `scheduler.weights`:

```yaml
scheduler:
  weights:
    waitTime: 1.0
    executionTime: 0.5
    progress: 2.0
    penalty: 1.0
```

### Supervisor

The supervisor is the coordinator loop. It checks available teammate slots, reads the ready backlog, asks the scheduler to sort it, claims Beads, resolves the current state, prepares a worktree, spawns teammate processes, tracks started Beads, and ignores duplicate signals.

### Orchestrator Helper

`Orchestrator` is a plugin-native backlog helper. It reads ready Beads, filters inactive terminal work, uses the scheduler, and returns the sorted slice that fits the configured slot count. The live `/orr-else` flow uses `Supervisor` for the full claim/spawn loop.

### Parallel Slots

`settings.maxConcurrentSlots` controls the number of teammate panes the coordinator may keep active. The default is `6`.

The `TeammateFactory` counts active panes by title in the `orr-else:Agents` tmux window.

### tmux Process Model

The teammate factory creates an `orr-else` tmux session with an `Agents` window. Each teammate is launched with:

- `pi --no-extensions`
- `-e <extension path>`
- `--provider <provider>`
- `--model <model>`
- `--thinking <level>`
- `--no-session`
- Harness environment variables for Bead, state, worker, worktree, config, API base, and trace context.

Pane titles use the `orr-else-agent:` prefix so active teammates can be counted reliably.

### Provider Routing

Provider routing is configured in `settings.modelProviders` and optionally overridden per state.

Example:

```yaml
settings:
  defaultProvider: openai
  defaultModel: gpt-5.5
  modelProviders:
    claude:
      provider: anthropic
      model: claude-opus-4-5
      thinking: high
    openai:
      provider: openai
      model: gpt-5.5
      thinking: xhigh
```

Before spawning a teammate, the coordinator resolves provider, model, and thinking level and passes them to Pi.

### Thinking Levels

The harness has standard thinking levels:

- `off`
- `minimal`
- `low`
- `medium`
- `high`
- `xhigh`

### Worktree Isolation

The Git plugin creates one branch and worktree per Bead:

- Branch: `bead/<beadId>`
- Worktree path: `worktrees/<beadId>`

Teammates receive `PI_WORKTREE_PATH`, and prompts expose it as `WORKING_DIRECTORY`. Project command tools can choose `cwd: project` or `cwd: worktree`.

The supervisor resolves whether to provision a worktree for each state using `resolveWorktreeProvisioning`. The decision follows a two-level priority: a per-state `provisionWorktree` boolean overrides the harness-wide `settings.worktreePolicy.default` (`'always'` | `'never'`, defaulting to `'always'`). With the default policy every state receives an isolated worktree; to restrict worktrees to specific states, set `worktreePolicy.default: 'never'` and add `provisionWorktree: true` on the states that need one (e.g. Implementation), or set `provisionWorktree: false` on read-only states and leave the default as `'always'`.

### Git Locking

Git operations use a local `.git-harness.lock` file to serialize worktree creation, removal, commits, and merges. This prevents concurrent teammate activity from interleaving repository-level Git commands.

### Harness-Owned Merge

Teammates cannot call `merge_and_commit`. The wrapper rejects that tool in worker mode.

On terminal success, the coordinator:

- Commits dirty worktree changes if needed.
- Switches to the target branch, defaulting to `main`.
- Merges `bead/<beadId>` with `--no-ff`.
- Closes the Bead.
- Removes the worktree.

### Core vs Plugin Boundary

Core modules contain harness abstractions: configuration, scheduling, flow, prompt injection, events, observability, progress, and state models.

Plugin modules expose external capabilities: Beads, Git worktrees, teammate spawning, mailbox, quality checks, project tools, signaling, and plugin creation.

Review states are expected to reject changes that mix these boundaries without an explicit plan.

## Prompt And Instruction System

### Configuration Loader

`ConfigLoader` reads `harness.yaml` or the path from `/orr-else --config <path>` or `ORR_ELSE_CONFIG`. It deep-merges defaults, resolves file-backed prompts and checklists, validates against `harness.schema.json`, caches the result, and resolves state-specific LLM settings.

### File-Backed Prompts

State and action prompts can be inline strings or file paths. Existing files are read and injected as prompt text.

The default harness points to `.pi/prompts/...` files for planner, implementer, and reviewer actions.

### File-Backed Checklists

State, action, and validation-gate checklists can be inline arrays or YAML/JSON files. File-backed checklists must contain either an array or an object with an `items` array.

### Instruction Assembly

`InstructionLoader` assembles:

- State identity.
- State constraints.
- Base instructions.
- `.pi/harness_rules.md` when present.
- Rule category files under `.pi/rules/<category>`.
- Compatibility-mode rule files.

### Protocol Injection

`ProtocolInjector` adds the generic harness protocol to the state prompt. It points teammates at:

- `.pi/docs/protocol/CORE_MANDATES.md`
- `.pi/docs/protocol/CONTROL_PLANE.md`
- `PROGRESS.md` in the assigned worktree

### Checklist Prompt

`ProtocolParser` renders active checklist items into a mandatory prompt section and labels each item as mandatory, optional, tool-checked, or script-checked.

### Context Injection

`ContextInjector` adds runtime context to the prompt:

- Bead ID.
- Working directory.
- Timestamp.
- State ID and identity.
- Provider key, provider, model, and thinking level.
- Paths for progress, handover, feature list, recent worklog history, skills, rules, and documentation.

### Skills

The repository includes local skill sheets under `.pi/skills` as generic examples. Project-specific role prompts or specialist instructions should live in the consuming project configuration.

### Compatibility Mode

The schema supports compatibility discovery fields for external project conventions:

- `masterRules`
- `ruleDirs`
- `hookDirs`
- `docsDirs`
- `agentDirs`

The current instruction assembly injects discovered master rules and rule directory markdown files.

## Checklists, Gates, And Completion

### Checklist Items

A checklist item has:

- `text`
- `mandatory`
- Optional `type`: `manual`, `tool`, or `script`
- Optional `tool`
- Optional `script`

Checklist evidence is recorded in Bead metadata by exact item text.

### Checklist Derivation

The active checklist for a state turn is derived from:

1. Required validation gates that apply to the state.
2. State-level checklist items.
3. Action-level checklist items.

Duplicate item text is deduplicated. The first item keeps its metadata, and `mandatory: true` wins if any duplicate is mandatory.

### Validation Gates

`validationGates` define reusable checklist gates that apply to all states or selected states through:

- `states`
- `beforeStates`
- `afterStates`

Required gates contribute checklist items to the active turn contract.

### Required Tools

States may declare `requiredTools`. On `SUCCESS`, `signal_completion` checks that each required tool was invoked in the current session before accepting the transition.

### Dynamic Checklist Items

Runtime tools may add checklist items after a state starts by calling `add_checklist_item`. Project-specific tools may also return JSON `toolCalls` or `frameworkToolCalls` entries that invoke `add_checklist_item`; ordered parent-context tool actions execute those calls before the selected prompt action starts. Added items are appended to the active turn checklist, persisted in Bead metadata under `dynamicChecklists`, and then enforced by `tick_item`, `get_outstanding_tasks`, and `signal_completion`.

### Tool Validation Rules

Configured project tools can declare `validationRules`. Before a wrapped Orr Else tool executes, or before an observed native Pi extension project tool is allowed to run, the harness checks prior tool results recorded by observability.

Supported conditions:

- `called`
- `passed`
- `succeeded`

Example:

```yaml
tools:
  - name: merge_ready_check
    type: command
    command: npm
    defaultArgs: ["test"]
    validationRules:
      - tool: build_check
        condition: passed
        message: "Quality checks must pass first."
```

### `tick_item`

`tick_item(text, evidence)` marks an exact checklist item complete and stores concrete evidence in Bead metadata. It also appends to the state worklog and `PROGRESS.md`.

### `get_outstanding_tasks`

`get_outstanding_tasks()` lists mandatory checklist items that have not been ticked.

### `submit_checkpoint`

`submit_checkpoint(summary, evidence)` records state progress in the worklog and emits a `CHECKPOINT_ACCEPTED` typed event. It does not advance the state by itself.

### `signal_completion`

`signal_completion(outcome, summary)` is the transition tool. For `SUCCESS`, it validates mandatory checklist completion and required tool calls before sending a `STATE_TRANSITIONED` event to the coordinator.

### `request_context_restart`

`request_context_restart(summary)` emits `CONTEXT_RESTART_REQUESTED`, records handover evidence, and shuts down the teammate so the coordinator can route the Bead through the configured context restart event.

## Signaling And Events

### Signaling Server

The coordinator starts a local HTTP server, defaulting to `127.0.0.1:3000`. The base URL can be configured through `ORR_ELSE_API_BASE` or `ORR_ELSE_API_PORT`.

Typed teammate events are accepted on:

- `POST /signal`
- `POST /signals`
- `POST /events`

Heartbeat endpoints are:

- `POST /heartbeat`
- `GET /heartbeats`

Malformed event payloads and syntactically invalid JSON are rejected with HTTP `400` before coordinator mutation code runs.

### Teammate Event Fields

Every typed teammate event includes:

- `type`
- `beadId`
- `workerId`
- `stateId`
- `timestamp`
- `idempotencyKey`

Most terminal or checkpoint events also include:

- `actionId`
- `transitionEvent`
- `summary`
- `evidence`
- `handover`

### Event Types

Supported teammate event types:

- `TEAMMATE_STARTED`
- `STATE_STARTED`
- `CHECKPOINT_ACCEPTED`
- `STATE_TRANSITIONED`
- `STATE_FAILED`
- `STATE_BLOCKED`
- `CONTEXT_RESTART_REQUESTED`
- `HEARTBEAT`
- `TEAMMATE_EXITED`

### Idempotency

The harness creates event idempotency keys from event type, Bead ID, worker ID, and timestamp. The supervisor keeps a processed-key set and ignores duplicates.

### Status-Mutating Events

Only these event types mutate Bead status or state metadata:

- `STATE_TRANSITIONED`
- `STATE_FAILED`
- `STATE_BLOCKED`
- `CONTEXT_RESTART_REQUESTED`

Heartbeats and startup events are accepted without changing Bead state.

### Event Store

`EventStore` writes JSONL audit entries when enabled. The default location is `.pi/events/{{projectName}}.jsonl`, so the event stream survives Pi session restarts. Each event record includes the current `sessionId`.

The store is also the replay source for Bead statechart state. `projectBeadStateChart(beadId)` and the `bd_get_state_chart` tool rebuild current state, previous state, transitions, completed actions, handovers, checklist ticks, restart intent, worktree path, merge status, and last event metadata from the events for that Bead.

### Domain Events And Mediator

`DomainEvents` records named events through `EventStore`. `Mediator` adds in-process pub/sub handlers on top of domain event recording.

## Restart And Recovery Concepts

### Harness Restart

Harness restart means the coordinator or process lifecycle was interrupted. The schema supports:

- `settings.harnessRestartEvent`
- `settings.harnessRestartPrompt`
- State-level `harnessRestartPrompt`

### Context Restart

Context restart means a teammate session needs a fresh Pi process while the Bead remains in workflow. The schema supports:

- `settings.contextRestartEvent`
- `settings.contextRestartPrompt`
- State-level `contextRestartPrompt`
- `settings.contextRestartRequirements`

### Context Health

`Teammate` listens for Pi `session_compact` events. If compaction count reaches `settings.contextMonitor.autoRestartCompactionCount`, the teammate emits a context restart request and shuts down.

The schema also includes state and harness context-rotation thresholds for workflow-level policies.

### Handover Template

`settings.handoverTemplate` defines the shape of resumption handovers. State and teammate tools record dense summaries in worklogs and Bead metadata so a later state execution can resume with evidence.

### Retry And Circuit Breaker Helper

`FlowManager` includes retry/circuit-breaker logic that increments retry count and can block a Bead after repeated failures. This supports deterministic failure handling in state transitions.

## Observability And Audit Trail

### OpenTelemetry

`Observability` creates OpenTelemetry spans for supervisor steps, teammate spawning, tool calls, and signals.

By default spans are written to JSONL under `.pi/otel` using a session-named file. A configured OTLP HTTP collector can also receive spans.

Example:

```yaml
settings:
  observability:
    enabled: true
    dir: .pi/otel
    fileName: traces-{{sessionId}}.jsonl
    retentionDays: 7
```

### Session And Trace IDs

Each process receives a UUIDv7 session ID. Teammates inherit trace context through `PI_TRACE_ID` and `PI_SPAN_ID`, and state attempts get `PI_SESSION_STATE_ID`.

### Tool Invocation Audit

Every wrapped tool execution is recorded by name and result. Completion checks and validation rules use this in-memory audit record to determine whether required tools were called and whether prerequisite tools passed.

### Structured Logs

`Logger` writes structured Winston logs to `state/logs/orr-else-<date>.log` and emits console output for Pi's debug stream.

### Worklogs

`WorklogManager` appends state summaries and handovers to:

```text
worklogs/<beadId>.log.md
```

### Progress Files

`ProgressManager` creates and appends to:

```text
<worktree>/PROGRESS.md
```

This gives each teammate a local timeline for the assigned Bead.

### Mailbox

`NativeMailbox` stores asynchronous messages as JSON files under `state/mailbox`. Teammates and the coordinator can exchange `REQUEST`, `INFO`, `BLOCKER`, and `STEER` messages.

### Telemetry Store

`TelemetryStore` records per-turn timing, token, and cost metadata when used by callers. It includes a simple loop detector for repeated short turns on the same action.

### Feature List Manager

`FeatureListManager` is a worktree-local utility for `feature_list.json`. It can load, save, and update feature records with `todo`, `in-progress`, `completed`, or `failed` status.

## Project Tool System

### Built-In Control Tools

These are protocol-level tools:

- `orr-else`
- `harness_status`
- `tick_item`
- `get_outstanding_tasks`
- `add_checklist_item`
- `submit_checkpoint`
- `signal_completion`
- `request_context_restart`
- `get_artifact_paths`

`/orr-else status` and `harness_status` are registered status surfaces. In the current implementation, detailed flow status reporting is still represented by a placeholder response.

### System Plugin Tools

The harness ships plugin tools for its own control plane:

- Beads orchestration.
- Git worktrees and merge.
- tmux teammate spawning.
- Mailbox communication.
- Signaling compatibility.
- Plugin creation.

### Common Tools The Harness Owns

Beyond the control-plane plugins above, the generic harness ships exactly three **common project tools** that it owns and that are useful to any consuming project, regardless of language or framework:

- `git_history` — read-only Git history/blame inspection (implementation lives in the orr-else source).
- `artifact_validator` — a generic artifact-presence/validation tool. It is framework-agnostic; the consuming project configures which artifacts it gates.
- `read_path_context` — resolves path existence, total lines, valid read offsets, and nearest matches before a read.

The harness self-registers each common tool's `verify()` callback at load, so their evidence participates in `requiredTools`/`validationRules` and artifact gating without any per-project wiring.

Every other domain-specific tool — `codemap`, `python_lsp`, `sonarqube`, `ast_grep`, `reference_docs`, `pytest`, `semgrep`, `coding_standards`, `smt_lib`, `codemod`, `auto_fix`, and similar — is **not** shipped by the generic harness. Those are cerdiwen-owned project tools (see "Cerdiwen-Owned Project Tools" below).

### Tool Result Contract

Tools are **dual-mode**: each is a standalone CLI (a `main` entry point invokable on the command line) and also exports a `verify()` callback the harness can call directly. The harness does **no** result truncation, no result recognition, and no result steering: it does not parse, summarize, or rewrite a tool's output, and it does not inject tool-specific decision logic. Each tool is responsible for its own bounded output and for the structured evidence it returns; the harness only records that evidence and applies the configured validation rules.

### Configured Command Tools

`harness.yaml` can define project-specific command tools:

```yaml
tools:
  - name: run_static_check
    type: command
    command: npm
    defaultArgs: ["run", "build"]
    argsMode: append
    allowArgs: true
    cwd: worktree
    timeoutMs: 60000
    maxOutputBytes: 1048576
```

Command arguments can be supplied as an array, a string, or an object whose keys become `--kebab-case` flags.

### Configured Native Pi Extension Tools

`harness.yaml` can also declare project tools that are registered by a normal Pi extension:

```yaml
tools:
  - name: project_extension_query
    type: extension
    description: Query a project-owned extension tool.
```

The example tool name above is a placeholder. Project-specific tools such as `reference_docs_query` are not shipped by the generic harness; they are owned by the consuming project and registered via that project's Pi extension (see "Cerdiwen-Owned Project Tools" below).

The tool implementation must be registered with `pi.registerTool()` from a Pi-supported extension location: `.pi/extensions/*.ts`, `.pi/extensions/*/index.ts`, `~/.pi/agent/extensions`, or an installed Pi package. Orr Else does not register or execute these tools directly. It activates them for teammates, observes their `tool_call`/`tool_result` events, records event-store and OTEL evidence, and enforces `requiredTools`/`validationRules` from the observed result.

Native Pi extension tools cannot be used for harness-executed parent-context tool actions because Pi exposes them as model-call tools, not direct framework calls. Use `type: command` or `type: mcp` for ordered parent actions that Orr Else must execute before the active prompt starts.

### Configured MCP Tools

`harness.yaml` can also define MCP-backed tools:

```yaml
tools:
  - name: project_mcp_query
    type: mcp
    server: docs
    configPath: "{{projectRoot}}/.pi/mcp/config.json"
    operations: ["query"]
    optional: true
```

MCP-backed tools read the configured MCP server from `configPath` and call the selected MCP operation directly. If no operation is configured, the caller must pass `operation`. Optional tools report `UNAVAILABLE` for missing infrastructure; required tools report `REJECTED`.

An MCP server named in `server` is a raw backend, not a harness tool. For example, a Chroma vector store sits *behind* a project-owned `reference_docs` tool as an MCP backend; Chroma itself is never registered or listed as a harness tool. See "Cerdiwen-Owned Project Tools" below.

### CWD Modes

Project command tools can run in:

- `project`: the project root.
- `worktree`: the assigned worktree.
- A configured explicit path.

### Session Log Compression

`compress_session_logs` returns an instruction asking the model to compress logs into a short state summary. It is a lightweight helper for handovers.

### Plugin Creation

`create_new_plugin` writes a new TypeScript plugin file into `src/plugins`. It enforces a single `.ts` filename and is intended for extending harness capabilities.

### Cerdiwen-Owned Project Tools (registered via the cerdiwen pi extension)

The cerdiwen project configures a set of domain-specific tools that are **not** part of the generic harness. They are owned by cerdiwen and registered through the cerdiwen Pi extension; the harness only activates, observes, and gates them like any other configured project tool. Examples include:

- `codemap` — project structure / dependency mapping.
- `python_lsp` — language-server symbols, diagnostics, hover, definitions, references.
- `sonarqube`, `semgrep`, `coding_standards` — static analysis and standards checks.
- `ast_grep`, `codemod`, `auto_fix` — structural code queries and rewrites.
- `reference_docs` — documentation lookup. It is backed by a raw Chroma MCP vector store: Chroma is the MCP backend *behind* `reference_docs` and is **not** itself a tool.
- `pytest` — test execution.
- `smt_lib` — SMT solver integration.

A consuming project that is not cerdiwen does not get these tools. To add equivalent capabilities, register them from your own project's Pi extension and declare them in `harness.yaml` as `type: extension`, `type: command`, or `type: mcp` tools.

## Artifact Concepts

`get_artifact_paths` resolves stable artifact paths from `settings.artifacts`. The framework ships no project-specific artifact names; configure templates in the consuming project.

Custom templates can use:

- `{{baseDir}}`
- `{{beadId}}`
- `{{stateId}}`
- `{{actionId}}`
- `{{artifactId}}`

## Advanced Configuration Concepts

### Team Lead Prompt And Project Objective

`settings.teamLeadSystemPrompt` describes coordinator behavior for the starting Pi session. `settings.projectObjective` records the high-level goal that the configured harness is meant to pursue.

### Harness Defaults

`ConfigLoader` supplies defaults for slots, timeouts, restart events, provider mappings, scheduler weights, and observability when a config omits them.

### Traceability

`settings.traceability` declares whether plans must trace to Beads and Beads must trace back to plans. It also names the evidence store.

### Transactional State

`settings.transactionalState` declares evidence requirements for read sets, write sets, assumptions, version dependencies, verifier obligations, and conflict policy. It supports a dedicated evidence store.

### Review Artifacts

`settings.reviewArtifacts.shipPostReview` describes the post-review artifact contract: state, storage path, event type, and whether the artifact is required.

### Artifact Base Directory

`settings.artifacts.baseDir` changes the root for generated artifact paths. `settings.artifacts.templates` adds or overrides named templates.

### Event Store

`settings.eventStore` controls JSONL domain event persistence:

```yaml
settings:
  eventStore:
    enabled: true
    dir: .pi/events
    name: project
    fileName: events.jsonl
```

Event-store paths must not include `{{sessionId}}`; use the event payload `sessionId` field for per-session attribution.

### Timeouts And Reaping

`settings.agentTurnTimeoutMs` controls Bead claim lease duration. `settings.processReapIntervalMs` is the configured process cleanup interval.

### Default Action Context Mode

The schema supports `same`, `oneShot`, and `subagent` action context modes at settings, state, and action levels. These fields describe the intended execution style for action orchestration.

## Tool Registry And Extension Surface

`ToolRegistry` groups tools for programmatic use:

- Orchestrator tools: Beads, Git, teammate spawning, mailbox, and plugin creation.
- State tools: mailbox, quality, and signaling.
- All tools: the combined tool surface.

The Pi extension registers these through its wrapper so validation rules, UI status, tracing, and tool result auditing are consistently applied.

## Repository Layout

```text
src/extension.ts              Pi extension and runtime tool registration
src/main.ts                   CLI help entry point
src/constants/                Shared status, event, tool, env, and default names
src/core/                     Harness core modules
src/core/domain/StateModels.ts Typed configuration and state models
src/plugins/                  Built-in plugin tool implementations
src/tools/run_checks_cli.ts   Deterministic build/test helper
harness.yaml                  Default workflow configuration
harness.schema.json           Harness configuration schema
docs/LLM_PROTOCOL.md          Provider-portable teammate protocol overview
.pi/docs/protocol/            Injected control-plane reference docs
.pi/prompts/                  File-backed state action prompts
.pi/skills/                   Local role skill sheets
state/logs/                   Structured daily logs
state/mailbox/                File-backed teammate messages
worklogs/                     Per-Bead state worklogs
worktrees/                    Per-Bead Git worktrees when created
```

## Pi Host SDK: peer dependencies

The orr-else harness is a Pi *plugin* — it runs inside the Pi host process. The Pi host platform packages are declared as `peerDependencies`:

- `@earendil-works/pi-ai` (required at runtime — imported by `dist/extension.js`)
- `@earendil-works/pi-coding-agent` (optional — type-only in source, host provides it)
- `@earendil-works/pi-agent-core` (optional — type-only in source, host provides it)

These packages are **not bundled** with the harness. The Pi host that loads the extension provides them in its own `node_modules/` tree. Consumer projects do not need to install them separately; they are resolved from the host's environment. With npm 7+, `npm install orr-else` will also auto-install them as peer deps.

See `docs/harness-packaging.md` §3.0 for the full peer-dependency contract.

## Development

Install dependencies:

```bash
npm install
```

Build:

```bash
npm run build
```

Run tests:

```bash
npm test
```

The default quality tool runs both build and tests.

## Prerequisites

The harness expects these tools to be available in the environment where the coordinator runs:

- `pi`
- `bd`
- `tmux`
- `git`
- Node.js and npm

## Default Harness Configuration

The included `harness.yaml` configures:

- Six concurrent teammate slots.
- OpenAI as the default provider.
- Claude and OpenAI provider mappings.
- A planning-heavy four-state workflow.
- Mandatory evidence checklists for every state.
- Scheduler weights for continuous flow prioritization.
- Handover instructions for fresh teammate sessions.

Use `/orr-else --config <path>` or `ORR_ELSE_CONFIG` to run a different harness file.
