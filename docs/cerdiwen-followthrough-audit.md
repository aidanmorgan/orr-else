# Cerdiwen Follow-Through Audit

**Bead**: pi-experiment-6q0y.50 — Require graph-enforced Cerdiwen usage follow-through for Orr Else harness changes
**Date**: 2026-06-08
**Status**: IN_PROGRESS

## Purpose

Every open Orr Else harness bead that can affect Cerdiwen runtime behavior must have either:
- A **graph-enforced follow-through bead edge** (harness bead `depends-on` or `blocks` a cerdiwen-consumer bead), or
- An **explicit no-impact note** with a deterministic reason Cerdiwen is unaffected.

This document is the human-readable companion to `tests/fixtures/cerdiwen-followthrough/harness-bead-audit.json`.

## Impact-Area Vocabulary (AC2)

The following areas are in scope for cerdiwen impact:

`statechart` · `active-tools` · `prompt-profiles` · `tool-evidence` · `schemas` · `budgets` · `startup-lint` · `context-policy` · `fan-out-join` · `loop-detection` · `terminal-transition-admission` · `project-tool-contracts` · `readiness-probes` · `scheduler` · `query-tool-usage`

## AC7 Beads (Orchestrator-Classified)

These four beads were explicitly classified by the 6q0y.50 orchestrator before this bead closed:

| Bead ID | Title | Coverage | Detail |
|---------|-------|----------|--------|
| `l3sw` | Remove global skillPaths fallback and legacy resolvePiSkillPaths API | **edge** → `6q0y.10` | l3sw blocks 6q0y.10 (Cerdiwen adopts state/action skill profiles before fallback is removed) |
| `t6gw` | Add harness-owned tool retry pipeline for idempotency enforcement | **no-impact** | Cerdiwen declares no retryPolicy on any tool; retry pipeline is a verified no-op for Cerdiwen |
| `85bl` | Add project-tool readiness-probe execution path for startup admission | **edge** → `6q0y.34` | 85bl blocks 6q0y.34 (Cerdiwen backend readiness manifest wiring) |
| `0ipk` | Wire probeContext and idempotency enforcement into project-tool probes and retries | **edge** → `6q0y.34` | 0ipk depends-on 6q0y.34 (probe side); idempotency side is no-impact (Cerdiwen has no retryPolicy) |

## Full Harness Bead Audit Table

107 harness beads audited: 40 edge, 67 no-impact.

For entries marked **edge (existing)**: the follow-through relationship exists in the bd graph but in the reverse direction (cerdiwen consumer already depends on the harness bead, so adding the governance reverse would create a cycle). The existing edge ensures cerdiwen cannot complete until the harness bead is done.

| Orr Else Bead ID | Title | Impact Area(s) | Cerdiwen Surface | Coverage |
|-----------------|-------|---------------|-----------------|----------|
| `6q0y.5` | Add zero-net-token Pi tool snippets and promptGuidelines passthrough | prompt-profiles, active-tools | cerdiwen promptSnippet/promptGuidelines accounting | **edge** → `6q0y.10` |
| `6q0y.9` | Add cache-hit observability keyed by prompt digest | prompt-profiles | none | no-impact: harness-internal; bead note permits no-impact |
| `6q0y.17` | Add optional hard prompt budget admission disabled by default | budgets, startup-lint | harness.yaml budget policy + 6q0y.53 cerdiwen consumer | **edge** → `6q0y.53` |
| `6q0y.18` | Measure exact model-facing tool result bytes and optionally enforce payload budgets | budgets, tool-evidence | harness.yaml budget policy + 6q0y.53 cerdiwen consumer | **edge** → `6q0y.53` |
| `6q0y.19` | Persist compact budget ledger rollups that survive retention compaction | budgets | none | no-impact: harness-internal retention; bead note permits no-impact |
| `6q0y.24` | Add query_harness_logs progressive-disclosure tool | query-tool-usage | cerdiwen runtime query presets for query_harness_logs | **edge** → `6q0y.28` (existing, reverse direction) |
| `6q0y.25` | Add query_tmux_transcripts progressive-disclosure tool | query-tool-usage | cerdiwen runtime query presets for query_tmux_transcripts | **edge** → `6q0y.28` (existing, reverse direction) |
| `6q0y.26` | Add query_otel_spans progressive-disclosure tool | query-tool-usage | cerdiwen runtime query presets for query_otel_spans | **edge** → `6q0y.28` (existing, reverse direction) |
| `6q0y.32` | Delete deprecated project-tool runtime guards and stale compatibility prompt wording | prompt-profiles, active-tools | none | no-impact: cerdiwen cleanup covered by 6q0y.29 and 6q0y.30 |
| `6q0y.35` | Add optional per-state deterministic context compaction summary artifact | context-policy, statechart | harness.yaml compaction settings + cerdiwen.ts extension restart prompt | **edge** → `6q0y.38` |
| `6q0y.36` | Make context restart handoff evidence-aware | context-policy, tool-evidence | cerdiwen.ts extension restart prompt + harness.yaml evidence-aware handoff | **edge** → `6q0y.38` |
| `6q0y.37` | Add optional compaction warning and deterministic fallback restart flow | context-policy, statechart | harness.yaml compaction warning settings + cerdiwen.ts extension restart flow | **edge** → `6q0y.38` |
| `6q0y.39` | Add deterministic statechart fan-out and route-event join execution | fan-out-join, statechart | harness.yaml fan-out/join blocks + cerdiwen statechart fan-out configuration | **edge** → `6q0y.41` |
| `6q0y.40` | Schema-validate fan-out branch handoff artifacts and joined route events | fan-out-join, schemas | harness.yaml fan-out schema registry + cerdiwen branch handoff artifacts | **edge** → `6q0y.41` |
| `6q0y.46` | Enforce artifact-first terminal and advance route events in code | terminal-transition-admission, tool-evidence | cerdiwen statechart terminal/advance transitions + verifier registration | **edge** → `6q0y.51` |
| `6q0y.47` | Formalize Orr Else harness middleware pipeline boundaries | statechart, schemas, startup-lint | harness.yaml pipeline stage config + cerdiwen middleware ordering | **edge** → `6q0y.52` |
| `6q0y.48` | Add optional per-state runtime budget policies disabled by default | budgets, statechart | harness.yaml per-state budget policy + cerdiwen.ts budget config | **edge** → `6q0y.53` |
| `6q0y.49` | Add always-on structural loop detection with route-event routing | loop-detection, statechart | harness.yaml maxLoops config + cerdiwen loop-route event handling | **edge** → `6q0y.54` |
| `6q0y.50` | Require graph-enforced Cerdiwen usage follow-through for Orr Else harness changes | statechart | none | no-impact: governance/audit bead; no runtime surface |
| `l3sw` | Remove global skillPaths fallback and legacy resolvePiSkillPaths API | prompt-profiles, active-tools | harness.yaml skill profiles + cerdiwen.ts state/action skill resolution | **edge** → `6q0y.10` |
| `t6gw` | Add harness-owned tool retry pipeline for idempotency enforcement | project-tool-contracts | none | no-impact: Cerdiwen declares no retryPolicy |
| `85bl` | Add project-tool readiness-probe execution path for startup admission | readiness-probes, startup-lint | harness.yaml readiness probe declarations + cerdiwen backend manifest wiring | **edge** → `6q0y.34` |
| `0ipk` | Wire probeContext and idempotency enforcement into project-tool probes and retries | readiness-probes, project-tool-contracts | harness.yaml readiness probe enforcement + cerdiwen backend readiness manifest | **edge** → `6q0y.34` |
| `amq0.1` | Refactor extension bootstrap into injectable Pi lifecycle and tool services | statechart | none | no-impact: internal refactor |
| `amq0.2` | Split Supervisor into scheduling, spawning, recovery, and retention services | scheduler | none | no-impact: internal refactor |
| `amq0.3` | Instance-scope logger, contract registries, and MCP health state | statechart | none | no-impact: internal refactor |
| `amq0.4` | Centralize path scope, filesystem, git, process, and tmux adapters | statechart | none | no-impact: internal refactor |
| `amq0.5` | Decompose ConfigLoader into source, parser, normalizer, validator, and reference resolver | statechart | none | no-impact: internal refactor |
| `amq0.6` | Replace broad RuntimeServices consumers with narrow dependency interfaces | statechart | none | no-impact: internal refactor |
| `amq0.7` | Add strict TypeScript, lint, architecture, and dead-code quality gates | statechart | none | no-impact: internal quality gate |
| `amq0.8` | Prevent duplicate Orr Else extension activation on one Pi host | startup-lint | none | no-impact: internal lifecycle guard |
| `amq0.9` | Gate spawn_teammate on active coordinator signaling state | statechart | none | no-impact: internal lifecycle guard |
| `amq0.10` | Unify worker prompt identity and skill injection paths | prompt-profiles, active-tools | none | no-impact: internal refactor; cerdiwen skill/tool profile config unchanged |
| `amq0.11` | Centralize harness vocabularies into typed enums and discriminated unions | schemas | none | no-impact: internal type system refactor |
| `amq0.12` | Stop widening resolved config enums after validation | statechart | none | no-impact: internal config validation fix |
| `amq0.13` | Split PiIntegration into template, worker-resource, and prompt-provenance services | prompt-profiles | none | no-impact: internal service decomposition |
| `amq0.14` | Split domain vocabulary from infrastructure constants | schemas | none | no-impact: internal vocabulary layering refactor |
| `amq0.15` | Create a single tool-surface catalog for registration, prompt, and admission | active-tools, startup-lint, project-tool-contracts | none | no-impact: harness-internal catalog; cerdiwen is observed fixture |
| `amq0.16` | Separate project-tool registration adapter from execution pipeline | project-tool-contracts | none | no-impact: internal refactor |
| `amq0.17` | Decompose retention cleanup into planners, adapters, and reporter | scheduler | none | no-impact: internal retention service decomposition |
| `amq0.18` | Classify Knip-reported entrypoints and remove stale dead-code shims | startup-lint | none | no-impact: internal dead-code classification |
| `amq0.19` | Centralize project-tool root and path-scope type model | project-tool-contracts, startup-lint | none | no-impact: cerdiwen artifact/root templates are test fixtures |
| `amq0.20` | Add Cerdiwen extension projection and idempotency fixture | statechart, active-tools | none | no-impact: harness-side fixture; no Cerdiwen harness.yaml change |
| `1elr.1` | Run startup lint before HARNESS_STARTED, API bind, tmux, and supervisor work | startup-lint | none | no-impact: Cerdiwen already conforms to startup admission rules |
| `1elr.3` | Add required-tool callability and evidence-contract lint rules | startup-lint, tool-evidence | none | no-impact: Cerdiwen required-tool declarations already use canonical evidence handles |
| `1elr.4` | Add project asset and runtime readiness lint rules before worker spawn | startup-lint, readiness-probes | none | no-impact: Cerdiwen asset paths are already resolvable |
| `1elr.5` | Expose startup lint as a deterministic report and lint-only command | startup-lint | none | no-impact: adds lint-only CLI mode; uses Cerdiwen as observed fixture only |
| `1elr.6` | Fingerprint admitted config, statechart, tools, and schemas for every run | startup-lint, schemas | none | no-impact: Cerdiwen config/statechart/schemas are stable inputs |
| `1elr.7` | Define an admitted Pi API registration manifest and lifecycle idempotency check | startup-lint, active-tools | none | no-impact: Cerdiwen tool registrations are already correct |
| `1elr.10` | Define a deterministic Pi lifecycle state machine for Orr Else extension events | startup-lint, statechart | none | no-impact: Cerdiwen extension event handling follows normal Pi lifecycle |
| `1elr.11` | Admit Pi project trust, package, and active-tool policy into the harness fingerprint | startup-lint, active-tools | none | no-impact: Cerdiwen uses trusted project settings and pinned packages |
| `1elr.12` | Admit Pi sandbox, permission, and host-side execution policy before worker start | startup-lint | none | no-impact: Cerdiwen tool side-effect contracts are already declared |
| `6k8e` | Define v2 route-event domain schema and transition application contract | schemas, statechart | cerdiwen harness.yaml v2 route-event schema + event vocabulary conformance | **edge** → `ojxl` (existing, reverse direction) |
| `cfzu` | Implement category-first v2 event vocabulary validation | schemas, startup-lint, statechart | cerdiwen harness.yaml event category/vocabulary; old v1 outcome fields rejected | **edge** → `ojxl` (existing, reverse direction) |
| `0njv` | Require safe promptFile paths for every v2 LLM action | schemas, startup-lint, prompt-profiles | cerdiwen harness.yaml promptFile declarations must be resolvable safe paths | **edge** → `ojxl` (existing, reverse direction) |
| `0dgy` | Use canonical map-form collections in v2 config | schemas, startup-lint | cerdiwen harness.yaml collections must use v2 map form | **edge** → `ojxl` (existing, reverse direction) |
| `afdz` | Add v2 toolSets expansion for required tool composition only | schemas, startup-lint, active-tools | cerdiwen harness.yaml toolSets must use v2 composition-only form | **edge** → `ojxl` (existing, reverse direction) |
| `hutg` | Define deterministic v2 action event emission contracts | schemas, statechart, tool-evidence | cerdiwen action events must conform to v2 emission contracts | **edge** → `ojxl` (existing, reverse direction) |
| `ne2w` | Add deterministic v2 gate aggregation with explicit precedence | schemas, statechart | cerdiwen harness.yaml gate declarations must conform to v2 explicit precedence model | **edge** → `ojxl` (existing, reverse direction) |
| `w2tz` | Add v2 state and tool defaults/profile expansion with a non-routing allowlist | schemas, startup-lint, prompt-profiles | cerdiwen harness.yaml state/tool profile expansion must use v2 non-routing allowlist form | **edge** → `ojxl` (existing, reverse direction) |
| `x0zh` | Replace all model-selected outcome routing surfaces in v2 | schemas, statechart | cerdiwen harness.yaml model-selected routing must be replaced with v2 deterministic routing | **edge** → `ojxl` (existing, reverse direction) |
| `ux5e` | Reject configurable worker/workspace/worktree options in v2 config | schemas, startup-lint | cerdiwen harness.yaml must not use configurable worker/workspace/worktree options | **edge** → `ojxl` (existing, reverse direction) |
| `94u7` | Enable v2-only default config discovery after self and example migration | schemas, startup-lint | cerdiwen harness.yaml must be v2-valid before 94u7 enables v2-only discovery | **edge** → `ojxl` (bd edge: 94u7 depends-on ojxl) |
| `ek2j` | Preflight tmux and git worktree substrate for every v2 harness start | startup-lint | none | no-impact: Cerdiwen already relies on valid tmux and git worktree substrate |
| `e8cm` | Add v2 route-event replay quarantine and projection tests | schemas, statechart | none | no-impact: harness-side test infra; cerdiwen migration covered by ojxl |
| `jxdk` | Remove synthetic-event compatibility filters from production EventStore | statechart | none | no-impact: owner-held; Cerdiwen does not rely on synthetic event filtering |
| `w8rz` | Delete ToolResultBase migration-debt adapter and require full ToolEvidenceHandle | tool-evidence, schemas | cerdiwen project-tool wrappers must emit full ToolEvidenceHandle; legacy adapter removed | **edge** → `e6dc` |
| `yhec` | Replace path-only VerifyContext toolOutputs with canonical evidence handles | tool-evidence, schemas | cerdiwen verifier callbacks must consume canonical evidence handles | **edge** → `e6dc` (existing, reverse direction) |
| `6q0y.5` (see above) | | | | |
| `6q0y.9` (see above) | | | | |
| `6q0y.19` (see above) | | | | |
| `6q0y.24` (see above) | | | | |
| `6q0y.25` (see above) | | | | |
| `6q0y.26` (see above) | | | | |
| `6q0y.32` (see above) | | | | |
| `amq0.15` (see above) | | | | |
| `amq0.16` (see above) | | | | |
| `amq0.17` (see above) | | | | |
| `amq0.18` (see above) | | | | |
| `amq0.19` (see above) | | | | |
| `amq0.20` (see above) | | | | |
| `zog2.4` | Consume canonical tool evidence handles in verifier gate contexts | tool-evidence, schemas | cerdiwen verifier callbacks must receive canonical evidence handles | **edge** → `e6dc` (existing, reverse direction) |
| `zog2.5` | Add tool evidence conformance tests for every registered tool | tool-evidence, schemas | none | no-impact: harness conformance framework; cerdiwen-specific work in zog2.6 |
| `zog2.6` | Validate Cerdiwen project tools against the canonical Orr Else evidence pattern | tool-evidence, project-tool-contracts | cerdiwen project-tool wrappers + verifier callbacks must conform to canonical evidence pattern | **edge** → `e6dc` (existing, reverse direction) |
| `zog2.10` | Define gate semantics for native Pi extension project tools | project-tool-contracts, startup-lint | none | no-impact: Cerdiwen extension tools follow standard Pi extension semantics |
| `zog2.11` | Fail closed when verifier evidence handles cannot be validated | tool-evidence, schemas | cerdiwen verifier gates must pass canonical evidence handle validation | **edge** → `e6dc` (existing transitive, reverse direction) |
| `zog2.13` | Constrain Pi tool prompt surface and canonical schemas for token-efficient determinism | prompt-profiles, schemas, active-tools | none | no-impact: cerdiwen conformance captured by zog2.6 and zog2.5 |
| `zog2.14` | Control Pi MCP direct-tool exposure and metadata-cache readiness deterministically | project-tool-contracts, startup-lint, active-tools | none | no-impact: Cerdiwen MCP-backed tools are already declared as proxied wrappers |
| `zog2.17` | Replace Cerdiwen legacy contract bridge with canonical evidence contract fixture | tool-evidence, schemas | cerdiwen .pi/project-tools/_contract.ts must migrate from legacy ToolResultBase bridge | **edge** → `e6dc` |
| `zog2.20` | Surface canonical tool evidence in audit and status projections | tool-evidence, statechart | none | no-impact: harness-internal audit/status projection update |
| `zog2.21` | Replay and retain canonical tool evidence handles as replay-critical data | tool-evidence, statechart | none | no-impact: harness-internal replay and retention consumer update |
| `zog2.22` | Quarantine legacy tool-evidence consumer inputs in production paths | tool-evidence, schemas | none | no-impact: cerdiwen evidence migration covered by e6dc |
| `6iae` | Build a replayable deterministic progress projection for gate eligibility | statechart, tool-evidence | none | no-impact: harness-internal progress projection |
| `a9eq` | Reject command child-artifact legacy payloads and require direct canonical evidence | tool-evidence, project-tool-contracts | cerdiwen command/tsProjectTool wrappers must emit canonical evidence | **edge** → `e6dc` |
| `4ub5` | Report configured MCP-backed project-tool backend readiness separately from native Pi MCP counts | readiness-probes | none | no-impact: Cerdiwen configured backends are auto-detected; no harness.yaml change required |
| `cim5` | Register git_history as a callable built-in tool for requiredTools gates | active-tools, startup-lint | none | no-impact: Cerdiwen harness.yaml already requires git_history; harness registration makes it callable |
| `ixtf` | Reject project-tool operation aliases with canonical diagnostics | project-tool-contracts, active-tools | cerdiwen project-tool wrappers must use canonical operation names | **edge** → `6q0y.30` (existing, reverse direction) |
| `yp1w` | Make prelude tool actions explicitly satisfy or not satisfy prompt requiredTools | statechart, project-tool-contracts | none | no-impact: Cerdiwen uses fresh sub-agent context (6q0y.44 closed); no ambiguous prelude/requiredTool reuse |
| `2tb1` | Validate project-tool rule catalogs so missing rule documents cannot silently reduce guidance | project-tool-contracts, startup-lint | none | no-impact: harness adds catalog/file validation + CI tests; Cerdiwen catalog drift resolved within 2tb1's own AC; no harness.yaml config change required |
| `se6g` | Update v2 model-facing protocol for evidence-only completion and deterministic routing | schemas, statechart | cerdiwen harness.yaml model-facing protocol must conform to v2 evidence-only completion | **edge** → `ojxl` |
| `7ypp` | Move opinionated Orr Else examples and init templates out of runtime defaults | startup-lint, schemas | cerdiwen harness.yaml must be explicit v2 config rather than relying on runtime-discoverable defaults | **edge** → `ojxl` (existing, reverse direction) |
| `vzp7` | Add static orr-else config explain for resolved v2 config | schemas, startup-lint | none | no-impact: adds config explain CLI command; no Cerdiwen config change required |
| `ebzz` | Delete deprecated project-tool runtime guard after config admission proves unreachable | project-tool-contracts | none | no-impact: Cerdiwen does not rely on deprecated guard behavior |
| `ejv1` | Flush deferred STATE_RUN_INITIALIZED on failure/shutdown and restart-gap failure counting | statechart | none | no-impact: harness bug fix for deferred event flushing; Cerdiwen behavior unchanged |
| `isjk` | Rename v2 public schema terminology to generic framework language | schemas | cerdiwen harness.yaml must use updated v2 terminology after rename | **edge** → `ojxl` (existing, reverse direction) |
| `jfms` | Remove Orr Else tests that preserve legacy projection fallback semantics | statechart | none | no-impact: harness test cleanup; Cerdiwen extension tests remain responsible for its projection names |
| `migrated-hmp53.1` | Build a Pi JSON/RPC/SDK replay fixture for lifecycle and tool-event contracts | statechart, schemas | none | no-impact: harness replay fixture; migrated from cerdiwen as harness-side test asset |
| `nkiq` | Reject explicit legacy-v1 statechart configs missing terminalStates | schemas, startup-lint | none | no-impact: Cerdiwen uses v2 config (covered by ojxl) |
| `rm9x` | Make EventStore.scanTail use a bounded byte-offset read and handle oversized events | statechart | none | no-impact: harness EventStore bounded read fix; no Cerdiwen config change |
| `0iyt` | Remove RuntimeServices and ToolRegistry backward-compatible constructor shims | statechart | none | no-impact: harness dead-code removal; no cerdiwen-facing contract or config surface change |
| `dsm2.2` | Require per-tool JSON Schemas for calls, results, summaries, and artifacts | schemas, project-tool-contracts, tool-evidence | none | no-impact: harness enforcement mechanism; cerdiwen tool conformance covered by zog2.6 |
| `dsm2.4` | Schema-validate semantic artifact manifests before gates, replay, and retention | schemas, tool-evidence | none | no-impact: harness-internal validation; cerdiwen artifact conformance covered by zog2.6 and e6dc |
| `dsm2.5` | Add boundary schema conformance inventory and fail-closed startup lint | schemas, startup-lint | none | no-impact: harness-internal boundary schema conformance inventory |
| `dsm2.6` | Schema-validate structured logs and OTel payloads without making telemetry authoritative | schemas, startup-lint | none | no-impact: harness-internal log/OTel schema validation; Cerdiwen does not configure log or OTel schemas in harness.yaml; same class as all dsm2 siblings |
| `dsm2.7` | Persist tool evidence, artifact manifests, and progress events atomically | tool-evidence, statechart | none | no-impact: harness-internal atomic persistence |
| `dsm2.8` | Revalidate Pi tool_call mutations before recording or executing harness policy decisions | project-tool-contracts, statechart | none | no-impact: harness-internal tool_call mutation revalidation |
| `dsm2.9` | Persist durable evidence handles for tmux transcript based recovery decisions | tool-evidence, statechart | none | no-impact: harness-internal durable evidence handle persistence |
| `dsm2.10` | Keep Pi compaction and branch summaries non-authoritative for harness progress | statechart, context-policy | none | no-impact: harness-internal policy; no Cerdiwen config change |
| `dsm2.11` | Define Pi subagent child-session boundaries and artifact handoff contracts | statechart, schemas, tool-evidence | none | no-impact: harness-internal subagent boundary and handoff contract definition |
| `jvx3` | Define and enforce the deterministic LLM responsibility boundary | statechart, schemas | none | no-impact: harness-internal LLM boundary enforcement; Cerdiwen already follows deterministic routing |

## Summary

| Category | Count | Coverage |
|----------|-------|----------|
| 6q0y epic harness beads | 19 | 14 edge, 5 no-impact |
| AC7 beads (l3sw, t6gw, 85bl, 0ipk) | 4 | 3 edge, 1 no-impact |
| amq0 modularization beads | 20 | 0 edge, 20 no-impact |
| 1elr startup-lint beads | 9 | 0 edge, 9 no-impact |
| v2 config/startup-lint beads | 14 | 12 edge, 2 no-impact |
| tool-evidence harness beads (jxdk, w8rz, yhec) | 3 | 2 edge, 1 no-impact |
| zog2 tool-evidence beads | 11 | 6 edge, 5 no-impact |
| dsm2 boundary-contract beads | 9 | 0 edge, 9 no-impact |
| cerdiwen-observed harness beads | 7 | 3 edge, 4 no-impact |
| additional harness beads | 11 | 0 edge, 11 no-impact |
| **Total** | **107** | **40 edge, 67 no-impact** |

## Cerdiwen Follow-Through Beads (Excluded from Harness Audit)

These are the follow-through TARGETS — they update Cerdiwen usage and are excluded from the harness-bead audit list:

- `6q0y.10` — Pilot Cerdiwen state/action skill, active-tool, and prompt profiles
- `6q0y.13` — Pilot Cerdiwen tool-local RTK summaries for run_quality_checks and codemap
- `6q0y.14` — Roll out Cerdiwen tool-local RTK summaries or explicit none declarations
- `6q0y.20` — Add optional Cerdiwen budget profile fixtures for high-volume tools and providers
- `6q0y.28` — Add Cerdiwen runtime query presets and advertised projection coverage
- `6q0y.29` — Remove Cerdiwen projection aliases and use canonical projection names only
- `6q0y.30` — Canonicalize Cerdiwen wrapper operation and argument names and reject aliases
- `6q0y.34` — Wire Cerdiwen backend readiness manifest into startup admission
- `6q0y.38` — Configure Cerdiwen context compaction and evidence-handle restart prompt
- `6q0y.41` — Update Cerdiwen statechart to run QualityGate before post-implementation fan-out
- `6q0y.42` — Split Cerdiwen post-implementation fan-out into deterministic route-event review branches
- `6q0y.43` — Add Cerdiwen active tool and prompt profiles for QualityGate and fan-out branches
- `6q0y.45` — Apply explicit context policies to Cerdiwen states and post-QualityGate fan-out branches
- `6q0y.51` — Update Cerdiwen usage for artifact-first terminal progress enforcement
- `6q0y.52` — Update Cerdiwen usage for the formal Orr Else middleware pipeline
- `6q0y.53` — Update Cerdiwen usage for optional runtime budget policies
- `6q0y.54` — Update Cerdiwen usage for structural loop detection and route events
- `2j35` — Wire Cerdiwen requirements and plan verifiers to v2 route events
- `7w79` — Compress Cerdiwen v2 harness.yaml without hiding route semantics
- `e6dc` — zog2.3 consumer-half: cerdiwen tools emit canonical evidence + verifier-gate consumes canonical handles end-to-end
- `gztb` — Verify Cerdiwen consumes the packaged v2 Orr Else harness end to end
- `lfjm` — Define Cerdiwen deterministic route-event mapping table
- `ljpj` — Remove Cerdiwen stale structuredResult and implementationSteps harness wording
- `n1w3` — Replace Cerdiwen stale FailureCategory type alias with current ToolFailureCategory
- `nk3m` — Wire Cerdiwen post-review security and suppression gates to v2 route events
- `ojxl` — Migrate Cerdiwen harness.yaml to explicit v2 structural single-file shape
- `paha` — Remove Cerdiwen pureReadVerify stale contract import path
- `pwoy` — Wire Cerdiwen quality and pytest gates to v2 route events
- `zog2.18` — Add Cerdiwen verifier-gate regression suite over canonical evidence
- `amq0.20` (cerdiwen-observed harness fixture — included in harness audit above)
