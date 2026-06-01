I'll synthesize the 71 verified findings into a deduped, prioritized work-item report. Let me analyze the clusters and dependencies.

The findings cluster naturally around several themes. Let me produce the report directly.

# Orr Else Harness — Code-Quality Audit Plan (Deduped & Prioritized)

71 verified findings collapse into **24 work items**. Ordered by severity, then blast-radius. Three large refactor clusters are flagged explicitly so they are not split into busywork.

---

## Foundational enabler (do this first — unblocks 11 downstream items)

### WI-1 — Introduce shared `RuntimeEnvironment` injection across env-reading classes
- **Category:** dependency-injection · **Severity:** P1 · **Effort:** M
- **Files:** `Observability.ts` (156-157, 299-302, 373-374, 410), `EventStore.ts` (125), `ConfigLoader.ts` (118), `ArtifactPaths.ts` (82-83), `FileAccessPolicy.ts` (81, 264-270), `bd.ts` (33), `teammates.ts` (191, 268), `projectTools.ts` (965-983, 992-998)
- **Surgical fix:** The `RuntimeEnvironment` port already exists and is proven with the defaulted-arg pattern in `HarnessApiClient.ts:21` and `SignalingServer.ts:44`. Add `private readonly env: RuntimeEnvironment = nodeRuntimeEnvironment` to each constructor and replace direct `process.env[...]` reads with `this.env.env(...)`, preserving existing `getProjectRoot()`/`cwd()` fallbacks and args-first precedence. Resolve constructor-stable values once (sessionId, span attrs, OBSERVABILITY_FILE_NAME); keep call-time reads (TRACE_ID/SPAN_ID inbound trace context) reading through the port at call time.
- **Acceptance:** Every listed file has zero direct `process.env` reads (verify with `rg "process\.env" src/core/Observability.ts src/core/EventStore.ts src/core/ConfigLoader.ts src/core/ArtifactPaths.ts` → no matches except the `nodeRuntimeEnvironment` default). A unit test constructs each class with a stub `RuntimeEnvironment` and asserts the injected value flows through (e.g. `sessionId`, config path, policy gating) without mutating `process.env`. All existing callers compile unchanged.
- **Note:** This is one cohesive enabler. Ships as one PR or a tight series; do **not** split per-file — the value is the consistent port adoption. Subsumes original findings on Observability (×4), EventStore.sessionId, ConfigLoader, ArtifactPaths, FileAccessPolicy env reads, bd.ts, teammates.ts PROJECT_ROOT, projectTools fallbacks.

---

## P1 — High severity

### WI-2 — Thread `projectRoot` through RuntimeServices instead of the mutable `Paths` module global
- **Category:** statics-singletons · **Severity:** P1 · **Effort:** M
- **Files:** `Paths.ts` (17-28), 16 consumers (EventStore, ConfigLoader, PlanWriteSet, FileAccessPolicy, RequiredToolResolver, ArtifactPaths, InstructionLoader, Mailbox, ToolCallPathFactory, Observability, bd.ts, teammates.ts, projectTools.ts, extension.ts, Logger.ts, PiIntegration.ts), `tests/pi_extension.test.ts`
- **Surgical fix:** Keep `PATH_INSTALL_ROOT`; make `resolveProject`/`resolveInstall` pure functions taking an explicit root. Add `projectRoot: string` to `RuntimeServices`, set once in `createRuntimeServices` from `process.env[PROJECT_ROOT] || cwd()`, and pass to the constructors already built there. Leave the separate-process `Teammate.ts:55` path reading its own root.
- **Acceptance:** `get/setProjectRoot` removed (or reduced to the Teammate-process bootstrap only); `tests/pi_extension.test.ts` no longer imports `setProjectRoot`/`getProjectRoot`. A test instantiates services with two different roots in the same process and confirms no cross-talk. Logger output dir is derived from the injected root, not the global.
- **Coordinate with WI-1** (FileAccessPolicy/ArtifactPaths/bd already touched there) and **WI-3** (Logger dir). Sequence: WI-1 → WI-2.

### WI-3 — Make `LoggerService` transports and log level injectable (keep module default)
- **Category:** statics-singletons · **Severity:** P1 · **Effort:** M
- **Files:** `Logger.ts` (28, 35, 96)
- **Surgical fix:** Read `LOG_LEVEL` through `RuntimeEnvironment` (node default); add a `configure(level)` seam and an optional injectable transports/sink arg defaulting to the current daily-rotate-file + console. Keep `export const Logger` as the production default. Do **not** constructor-thread an `ILogger` through the 14 importers.
- **Acceptance:** A test points the singleton at an in-memory transport and asserts log capture with **zero filesystem writes** under the log dir. Log level is settable via `configure()` without mutating `process.env`. The 14 import sites are untouched.

### WI-4 — Encapsulate `extension.ts` session state in a per-invocation object; reset registration guards
- **Category:** statics-singletons · **Severity:** P1 · **Effort:** L
- **Files:** `extension.ts` (97-135; guards set at 210/816/836/984/2500/2591/2609)
- **Surgical fix:** Introduce a per-invocation session object created at the top of `orrElseExtension` owning the run-state group (`activeRun`, `toolBreakerFailures`, `toolResultCache`, `stateCycleCounter`, `agentFailureSignaled`, `checklistMutationQueue`, `currentTurnStartMs`, pi-tool observability set, `supervisor`, `currentFlowOptions`) and the six never-reset registration guards. Handler closures capture it. Formalize the reset already partially done in `initializeWorkerRun`.
- **Acceptance:** Calling `orrElseExtension(pi2, services)` a second time with a fresh `pi` registers all tools again (no guard short-circuit) and shares no run state with the first invocation. A test asserts a second invocation re-registers the artifact-paths/pi-tool-observer/etc. tools.
- **Largest single item.** Self-contained in one in-process module; no cross-process path.

### WI-5 — Inject project-tool name resolver into core `Teammate` (remove core→plugin import)
- **Category:** core-plugin-boundary · **Severity:** P1 · **Effort:** M
- **Files:** `Teammate.ts` (22, 73, 3005), `extension.ts` (14, 2985, 3005)
- **Surgical fix:** Define `ProjectToolNameResolver = (config: HarnessConfig) => string[]` in core; add it to `Teammate`'s constructor. Wire `getConfiguredProjectToolNames` as the concrete impl at the `extension.ts:2985` construction site (it already imports the symbol). Leave `getConfiguredPiToolNames` (already in core) as-is.
- **Acceptance:** `rg "from '../plugins/" src/core/Teammate.ts` returns no matches. `Teammate` constructs with an injected resolver in tests without importing `projectTools`. Merges the two duplicate findings (core-plugin-boundary + pidev-harness) describing this same import.

### WI-6 — Add `WorkerContext` value object to `Teammate` (remove runtime env reads)
- **Category:** dependency-injection · **Severity:** P1 · **Effort:** M
- **Files:** `Teammate.ts` (45-48, 144, 157-160)
- **Surgical fix:** Pass a `WorkerContext { beadId, stateId, projectRoot, worktreePath, workerId, actionId }` into the constructor, resolved by `extension.ts:2985` (which already holds these). Replace the six scattered `process.env` reads + fallbacks in `startInner`/`sendHeartbeat`/auto-restart.
- **Acceptance:** `startInner`/`sendHeartbeat` have zero `process.env` reads; a test drives a heartbeat with a stub `WorkerContext` and asserts the emitted worker/action IDs. Coordinates with WI-5 (same constructor) and WI-13 (same setup methods).

### WI-7 — Pass API port/base explicitly to the spawn path (remove `process.env` write-back)
- **Category:** dependency-injection · **Severity:** P1 · **Effort:** M
- **Files:** `extension.ts` (2422-2423), `teammates.ts` (277-278)
- **Surgical fix:** Hand the bound `apiPort`/`apiBase` to `TeammateFactory` (constructor or spawn arg); inject `API_PORT`/`API_BASE` into the explicit child-env array already built at `teammates.ts:284+`. Delete the `process.env[API_PORT]=`/`[API_BASE]=` writes.
- **Acceptance:** `rg "process.env\[EnvVars.API_(PORT|BASE)\] =" src/extension.ts` → no matches. A spawn test asserts the child env array contains the port/base passed in, with the parent `process.env` unmodified. End-to-end pairing of the write/read finding. Coordinate with WI-1 (teammates PROJECT_ROOT) and WI-20.

### WI-8 — Gate Claude Code keychain login on macOS + configured Anthropic provider
- **Category:** pidev-harness · **Severity:** P1 · **Effort:** S
- **Files:** `claudeCodeAuth.ts` (19-44), `extension.ts` (2499-2502)
- **Surgical fix:** (1) In `readClaudeCodeAccessToken`, add `if (process.platform !== 'darwin') throw new Error('... only available on macOS (ENOTSUP)')` before `execFileSync('security', ...)`. (2) Move `registerClaudeCodeLiveLogin(pi)` to after config load and gate on `config…providerKey === 'anthropic'`.
- **Acceptance:** On a non-darwin platform the keychain read throws a clear ENOTSUP error (test via `process.platform` stub). With a non-Anthropic configured provider, `registerProvider` is **not** called (assert no Anthropic override). Login no longer fires before config load.

### WI-9 — Continue pane-kill loop on tmux failure and always record `TEAMMATE_PROCESS_EXITED`
- **Category:** error-handling · **Severity:** P1 · **Effort:** S
- **Files:** `teammates.ts` (386-388)
- **Surgical fix:** Wrap only the `kill-pane` call in a per-pane try/catch that warn-logs `{paneId, beadId}` and continues, mirroring `removeDeadTeammatePanes` (156-165). Keep `record(TEAMMATE_PROCESS_EXITED)` reachable. Do **not** add lease-release (the sole caller at `Supervisor.ts:725-730` already releases).
- **Acceptance:** A test where the first pane's `kill-pane` rejects (already-dead pane) asserts remaining panes are still killed and `TEAMMATE_PROCESS_EXITED` is recorded exactly once.

### WI-10 — Emit a durable failure event when worker-mode `teammate.start()` fails
- **Category:** error-handling · **Severity:** P1 · **Effort:** S
- **Files:** `extension.ts` (2997)
- **Surgical fix:** In the catch, record `AGENT_TURN_FAILED` (or post `TEAMMATE_EXITED` via the existing signaling path) for the bead before returning, so the coordinator sees the dead worker rather than waiting for the no-progress timeout. Do **not** bare re-throw (unhandled rejection, no event trail).
- **Acceptance:** A test forcing `start()` to reject asserts a coordinator-visible failure event is recorded for the bead before bootstrap returns.

---

## P1 — Large refactor cluster (Supervisor / projectTools dispatch)

> **Cluster note:** WI-11 and WI-12 are the two genuinely large method-decomposition items. Keep each as a single PR; do **not** fragment into sub-extractions, and do **not** bundle them together. Their type-safety siblings (WI-15) can land independently.

### WI-11 — Decompose `Supervisor.scanAndSpawn` and cache tool handles
- **Category:** clarity-srp · **Severity:** P1 · **Effort:** M
- **Files:** `Supervisor.ts` (329-435)
- **Surgical fix:** Extract `claimAndSpawnBead(bead, config)` owning claim→worktree→record→spawn→failure-release for one bead; `scanAndSpawn` becomes the slot/exclusion/loop driver. Cache `BD_CLAIM`/`BD_RELEASE`/`CREATE_WORKTREE` handles once instead of 5 inline `.find()` calls. **Preserve** the post-claim (389) and post-worktree (410) pause checks — they release an already-claimed lease; only remove the redundant loop-top check (367).
- **Acceptance:** `scanAndSpawn` body ≤ ~40 lines; `.find()` for BD_CLAIM/RELEASE/CREATE_WORKTREE appears at most once each. Existing supervisor tests pass unchanged, including the pause-during-claim lease-release path.

### WI-12 — Flatten `executeConfiguredProjectTool` via a `preflightProjectTool` extraction
- **Category:** clarity-srp · **Severity:** P1 · **Effort:** M
- **Files:** `projectTools.ts` (3250-3362)
- **Surgical fix:** Extract `preflightProjectTool(...)` returning a ready-to-return result or null-to-continue, absorbing extension/backpressure/failure-limit checks (3255-3307). Remaining body: `record-started` → flat `try { run+persist+record-success } catch { record-failure }` → `finally release`. Keep `releaseProjectToolCall` in `finally`.
- **Acceptance:** Nesting depth ≤ 1 try/finally in the main body; reservation is released on every path (test the extension-reject, backpressure-reject, failure-limit, success, and execution-error paths all release exactly once).

---

## P2 — Medium severity

### WI-13 — Extract compaction-monitor and heartbeat setup from `Teammate.startInner`; add compaction teardown
- **Category:** clarity-srp · **Severity:** P2 · **Effort:** M
- **Files:** `Teammate.ts` (77-138)
- **Surgical fix:** Extract `setupCompactionMonitor(...)` and `setupHeartbeat(...)`, each owning its counter and returning a cleanup function; register **both** cleanups on the abort signal (fixes the missing compaction-listener teardown). Coordinate with WI-6.
- **Acceptance:** On abort, both the heartbeat interval is cleared **and** the `SESSION_COMPACT` listener is removed (test asserts `pi.off`/listener count returns to baseline).

### WI-14 — Replace duck-typing/casts on `eventStore` in Supervisor with a narrow interface
- **Category:** typescript/clarity-srp · **Severity:** P2 · **Effort:** S
- **Files:** `Supervisor.ts` (229-289, 230, 460)
- **Surgical fix:** For `restartDetailsForMissingStartedBead` (229-289): delete the `as any` and both `typeof === 'function'` guards — `projectBead`/`eventsForBead` are statically public on the concrete `EventStore`; the existing try/catch stays. For the projection casts (230, 460): define `interface ProjectionCapableStore { projectBead(...); eventsForBeads(...) }` and cast once.
- **Acceptance:** No `as any` on `eventStore` in `Supervisor.ts`; compiles with strict null checks; supervisor tests unchanged. Merges the two Supervisor eventStore findings.

### WI-15 — Strengthen tool-return and dispatch type contracts (typed results, no `any`/`Function`)
- **Category:** typescript · **Severity:** P2 · **Effort:** S–M
- **Files:** `RuntimeServices.ts` (32), `extension.ts` (1262, 2587, 2102, 403-406 via git plugin), `Supervisor.ts` (403-406), `projectTools.ts` (3244), `git plugin`
- **Surgical fix:** `RuntimeTool.execute` → `(params: unknown, ctx?: unknown) => unknown | Promise<unknown>`; replace `execute: Function` in `wrapPluginTool`/`wrapRuntimeTool` with the same signature. Define `WorktreeResult { success; path?; error? }` and `MergeResult { success; error? }` in the **git plugin** and have `CREATE_WORKTREE`/`MERGE_AND_COMMIT` return them, removing the four `(result as any)?` casts (Supervisor 403-406, extension 2102). `executeConfiguredProjectTool` param → `Record<string, unknown>` with explicit `Promise<unknown>` return.
- **Acceptance:** `rg "as any" ` count drops at the listed sites to zero; `execute: Function` eliminated; `tsc --noEmit` clean. Result-shape interfaces live in the git plugin (boundary preserved).
- **Note:** Coherent type-tightening batch; can ship as one PR. Depends on nothing.

### WI-16 — Replace remaining isolated `as any`/`any` annotations with declared types
- **Category:** typescript · **Severity:** P2–P3 · **Effort:** S
- **Files:** `TeammateEvents.ts` (267, 276, 178-185), `ConfigLoader.ts` (157-160, 227/233/237), `extension.ts` (2022-2023, 2171), `EventStore.ts` (817/994, 958-971), `bd.ts` (404/411/415/417), `teammates.ts` (416), `mailbox.ts` (20/31), `FlowManager.ts` (92), `StateModels.ts` (219), `harness.schema.json`
- **Surgical fix:** `validateTeammateEvent(value: unknown)` + `requireStrings(obj: Record<string, unknown>)`; `ConfigLoader.validate` → `asserts config is HarnessConfig` (drops the double-cast) and `resolveChecklistReference` return `ChecklistItem[] | undefined` (drops 3 casts); add `pauseUntilMs?`/`capacityLimited?` to `TeammateExitedEvent`; add `cycleCap?: number` to the inline settings type at `StateModels.ts:219` **and** to `harness.schema.json`; type EventStore projection accumulator as `Partial<HarnessBeadMetadata>` + local `DynamicChecklistItem` interface; add the four optional fields to `Bead`; schema-type the SPAWN_TEAMMATE/mailbox params; `Partial<ActiveToolsAPI>` cast in FlowManager.
- **Acceptance:** `tsc --noEmit` clean with the casts removed; `cycleCap` settable from config (schema validates it). Group of mechanical schema-backed fixes — one PR.

### WI-17 — Remove non-null assertions in favor of compiler-visible invariants
- **Category:** typescript · **Severity:** P2–P3 · **Effort:** S–M
- **Files:** `Logger.ts` (70/75/80/85), `Mediator.ts` (12), `extension.ts` (1716/1720/1788, 2046 + sibling `tools.find(...)!` sites 2021/2041/2096/2103/2115, Supervisor 401/405)
- **Surgical fix:** `Logger.init()` returns the winston logger → `this.init().info(...)`. `Mediator`: `const list = map.get(e) ?? []; list.push(h); map.set(e, list)`. `extension.ts` closures: `const run = activeRun;` after the outer guard. Add `requireTool(plugin, name): RuntimeTool` throwing a descriptive error and route the recurring `tools.find(...)!` pattern through it.
- **Acceptance:** Listed `!` assertions removed; missing-tool now throws a descriptive error (test) instead of `Cannot read properties of undefined`. `requireTool` is the single lookup path at the listed sites.

### WI-18 — Surface swallowed errors with warn-level logging (no control-flow change)
- **Category:** error-handling · **Severity:** P2 · **Effort:** S
- **Files:** `FeatureListManager.ts` (25-29), `teammates.ts` (229-243), `projectTools.ts` (3227-3229), `extension.ts` (1986), `TransactionalStateGuard.ts` (60-70, 115-124)
- **Surgical fix:** Add `Logger.warn(...)` with relevant context (filePath/sessionName/server/beadId/stateId + `String(error)`) in each catch, preserving return values and control flow. For `projectTools` MCP `finally`, keep both `close()` calls and log each failure.
- **Acceptance:** Each catch emits a warn with the documented context; behavior (returned value, cleanup order) unchanged — assert via a test that forces each error and checks for the log line plus unchanged return. Batch of additive logging — one PR.

### WI-19 — Return immutable event from `validateTeammateEvent` (stop mutating caller's body)
- **Category:** pidev-harness/error-handling · **Severity:** P2 · **Effort:** S
- **Files:** `TeammateEvents.ts` (276-305, line 301)
- **Surgical fix:** Replace the in-place `value.handover = truncateHandover(value.handover)` with `return { ok: true, event: { ...value, handover: truncateHandover(value.handover) } as TeammateEvent }`.
- **Acceptance:** A test passes a frozen object (or asserts referential inequality) and confirms the input body is unmodified while the returned event has a truncated handover. Pairs naturally with WI-16's `unknown` annotation change.

### WI-20 — Construct one configured `TeammateFactory`; stop rebuilding per agent-start event
- **Category:** dependency-injection · **Severity:** P2 · **Effort:** S
- **Files:** `extension.ts` (2429-2436, 2624-2631)
- **Surgical fix:** Build one configured factory in `startOrrElse`, store it module/session-scoped alongside `supervisor`, and reuse it in the `BEFORE_AGENT_START` handler. Do **not** force into `RuntimeServices` (its factory uses defaults for maxSlots/tmuxSession/extensionPath).
- **Acceptance:** Factory construction at the two `extension.ts` sites collapses to one; no `new TeammateFactory` inside the `BEFORE_AGENT_START` handler (test fires the event twice, asserts the same instance). Coordinate with WI-4 (session object) and WI-7.

### WI-21 — Scope `projectTools` in-flight backpressure map as an injected dependency
- **Category:** statics-singletons · **Severity:** P2 · **Effort:** S
- **Files:** `projectTools.ts` (341, 1100-1130)
- **Surgical fix:** Pass the in-flight map (or a small `ProjectToolBackpressure` holder) as an argument to `executeConfiguredProjectTool`/`registerConfiguredProjectTools`, created once in `createRuntimeServices`. `reserve`/`releaseProjectToolCall` take it as a parameter.
- **Acceptance:** No module-level `inFlightProjectToolCalls`; `tests/project_tools.test.ts` passes a fresh map per case and backpressure tests no longer rely on key uniqueness for isolation.

### WI-22 — Extract one `isRestartTransition` to core and import in both call sites
- **Category:** pidev-harness · **Severity:** P2 · **Effort:** S
- **Files:** `EventStore.ts` (529-533), `projectTools.ts` (1633-1637)
- **Surgical fix:** Move the byte-identical predicate to `src/core/EventUtils.ts` as an exported `isRestartTransition(transitionEvent: unknown): boolean`; import in both.
- **Acceptance:** One definition; both files import it; `rg "RESTART, .*CONTEXT_RESTART" src` shows a single body. Restart-boundary tests in both projections pass.

### WI-23 — Centralize magic values into existing constant homes
- **Category:** magic-values · **Severity:** P2–P3 · **Effort:** S (M for OTEL)
- **Files:** `Supervisor.ts` (260, 273; import `RestartKind`), `HarnessApiClient.ts` (41, 58; add 204/408/429 to `HttpStatus`), `ProviderRequestCap.ts` (40; add `ANTHROPIC_MIN_THINKING_BUDGET_TOKENS:1024`), `projectTools.ts` (1299-1345 `ProjectToolNextAction`; 1408/1409/1469/1476/1855/2555 + Set@168 tool-name consts; 1297/2151/2571 `NO_MATCH_STATUS`), OTEL keys across `SignalingServer.ts` (116-121), `Observability.ts` (299-302), `extension.ts` (342-345, 970-973), `teammates.ts` (248-249)
- **Surgical fix:** Use `RestartKind.HARNESS/CONTEXT`; extend `HttpStatus`/`ProviderRequestLimits` in `constants/index.ts`. Keep `projectTools` name/status/next-action consts **plugin-local** (mirror `ARTIFACT_VALIDATOR_TOOL_NAME`/`ProjectToolFailureCategory`) — do **not** promote to core. Add an `OtelAttr` const in `constants/index.ts` for project-owned `orr_else.*`/`agent.*` keys only; leave `gen_ai.*` GenAI-semantic-convention strings verbatim.
- **Acceptance:** No bare literals at the listed sites; `tsc` clean; a grep for each centralized literal finds it only in its constant definition. Behavior identical (values unchanged).
- **Note:** Can be split into core-constants vs plugin-local vs OTEL sub-PRs if desired, but they are independent and low-risk; treat as one tidy batch unless OTEL (M) is deferred.

---

## P3 — Low severity / cleanup

### WI-24 — Delete dead restart-field derivation in `projectBeadFromEvents`
- **Category:** clarity-srp · **Severity:** P3 (real defect: dead code) · **Effort:** S
- **Files:** `EventStore.ts` (893-947)
- **Surgical fix:** The switch-arm writes at 895-899 (and clears 888-891) are unconditionally overwritten by the state-chart projection at 943-947. Delete them, leaving `projectBeadStateChartFromEvents` as the single authority. Verify line 900's `if (data.targetState) projection.status = ...` against the separate status reconciliation at 930-931 and drop if redundant.
- **Acceptance:** Restart fields (`restartKind/restartEvent/restartFromState/restartTargetState`) are assigned exactly once (from stateChart); projection tests for restart beads produce identical output before/after.

### WI-25 — De-duplicate `FileAccessPolicy` operational-path and shell-target pipelines
- **Category:** clarity-srp · **Severity:** P2 · **Effort:** S–M
- **Files:** `FileAccessPolicy.ts` (476-492, 149-194)
- **Surgical fix:** (a) Extract `isOperationalLogPath(relativePath)` for the shared normalize+PROGRESS+worklog logic; each method keeps its own `<DIRS>.some(...)` call. (b) Extract `validateShellTarget(event, context, target, operation)` covering `recordAccessAttempt` + the four ordered checks; both `applyShellMutationPolicy` and `convertDeletion` call it, with `convertDeletion` keeping only its trailing glob check inline. Pass operation label (WRITE/DELETE) as a parameter.
- **Acceptance:** The verbatim 22-line and 4-stage blocks collapse to single shared predicates/method; policy tests (mutation, deletion, glob, write-set, worktree-scope rejections) pass unchanged with correct WRITE vs DELETE access-attempt labels.

### WI-26 — Reuse `markBeadExited` in `releaseClaimedAfterPause`
- **Category:** clarity-srp · **Severity:** P2 · **Effort:** S
- **Files:** `Supervisor.ts` (157-172)
- **Surgical fix:** Replace the inline triple-delete (164-166) with `this.markBeadExited(claimed.id, { preserveInactiveRestartBackoff: true })`. Use `true` (not `false`) to preserve `inactiveRestartedAtMs` and current backoff behavior.
- **Acceptance:** Inline deletes removed; a test confirms a pause-time release does **not** reset `inactiveRestartedAtMs` (backoff preserved).

### WI-27 — Extract `collectSlotHealthSnapshot` from `Supervisor.recordSlotHealth`
- **Category:** clarity-srp · **Severity:** P2 · **Effort:** M
- **Files:** `Supervisor.ts` (534-625)
- **Surgical fix:** Extract only the measurement block (539-582) into `collectSlotHealthSnapshot(): Promise<SlotHealthSnapshot>` returning a typed VO. `recordSlotHealth` records/logs and forwards it to `recordCapacityUnderfill`/`recoverInactiveBeads`. Do **not** hoist the remediation calls to `step()` — they depend on `heartbeatByBead`/`latestProgressEvents`.
- **Acceptance:** `recordSlotHealth` no longer computes the snapshot inline; remediation calls receive the snapshot VO; slot-health tests pass unchanged.

### WI-28 — Builder for `executeCommandTool` result objects; consolidate arg-resolver triplets
- **Category:** clarity-srp · **Severity:** P2 · **Effort:** S
- **Files:** `projectTools.ts` (2696-2807; 965-983)
- **Surgical fix:** (a) Extract `buildCommandResult({...})` assembling the ~18-field shared shape/spreads; success and error branches pass only their differing fields (status, exitCode, maxBufferExceeded, timedOut/signal, bounded buffers). (b) Add `resolveContextField(args, keys, envVar?)` for bead/state/action ID lookups (one comment documenting `arguments.*` as canonical, top-level keys as legacy shims); fold `cwdOverrideFromArgs` only if trim/validate semantics are preserved.
- **Acceptance:** The two ~18-field literals reduce to per-branch differing fields; the three ID resolvers collapse to one helper with unchanged precedence (test bead/state/action resolution from top-level, nested `arguments`, and env).

---

## Cluster / sequencing notes

- **One large refactor, not many tickets — DI/env:** WI-1 is the *enabler*. WI-2 (Paths), WI-3 (Logger), WI-6 (WorkerContext), WI-7 (API port), WI-21 (backpressure) all touch constructors that WI-1 modifies. Sequence: **WI-1 → WI-2/WI-3 → WI-5/WI-6 (shared Teammate ctor) → WI-7/WI-20 (shared spawn path)**. Splitting WI-1 per-file would create churn and merge conflicts; keep it cohesive.
- **Teammate touches three items (WI-5, WI-6, WI-13)** all modifying its constructor/`startInner`. Land them as a short consecutive series on `Teammate.ts` to avoid repeated rebasing, but each is independently testable.
- **Supervisor decomposition (WI-11, WI-14, WI-26, WI-27)** are independent slices of the same file — do them in that order (type cleanup WI-14 first reduces noise for WI-11), but do **not** merge into one mega-PR.
- **projectTools** is the highest-churn file (WI-12, WI-15, WI-21, WI-22, WI-23, WI-28). WI-12 (flatten dispatch) should land before WI-28 (command-result builder) to avoid touching the same region twice.
- **Pure batches (low coordination):** WI-16/WI-17 (type annotations), WI-18 (logging), WI-23 (constants) are mechanical and can be parallelized across contributors.
