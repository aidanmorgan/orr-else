/**
 * RtkContract — per-tool RTK (token-minimisation) contract model for Orr Else.
 *
 * DESIGN INTENT
 * -------------
 * Each tool owns its minimal return schema and interpretation rules.  There is
 * intentionally NO shared public return envelope — structuredResult/resultPreview
 * are project-tool fields; they are NOT required by any other tool class.
 *
 * The harness manages raw-output persistence (PI_TOOL_CALL_DIR), path injection,
 * timeouts, and telemetry.  It MUST NOT impose generic byte caps, output-limit
 * knobs, or truncation envelopes on every tool.  See docs/raw-output-contract.md
 * for the full policy statement.
 *
 * INVENTORY COVERAGE
 * ------------------
 * Every model-call tool exposed by Orr Else is listed here:
 *   - Built-in control-plane tools  (BuiltInToolName)
 *   - Bundled runtime plugin tools  (PluginToolName)
 *   - Native Pi tools observed by policy (NativePiToolName)
 *   - Project-configured tools (config-driven; zero in the bare harness)
 *
 * REGRESSION GUARDRAIL
 * --------------------
 * Call `assertRtkInventoryComplete(registeredNames)` to fail fast when a newly
 * registered tool has no inventory entry.  See tests/rtk_inventory.test.ts.
 */

import { BuiltInToolName, NativePiToolName, PluginToolName } from '../constants/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Which category a tool belongs to (determines registration path).
 *
 *   built_in         — hardcoded in extension.ts, registered via pi.registerTool()
 *   plugin           — bundled runtime plugin (bd.ts, git.ts, quality.ts, …)
 *   native_pi        — Pi's own built-in tools observed by harness policy
 *   project_configured — config-driven tools from harness.yaml `tools:` section
 */
export type RtkToolClass =
  | 'built_in'
  | 'plugin'
  | 'native_pi'
  | 'project_configured';

/**
 * Whether the tool honours AbortSignal cancellation (zog2.9).
 *
 *   supported     — the tool executor propagates cancellation (AbortSignal) and
 *                   terminates early when the signal fires.
 *   not_supported — the tool runs to completion regardless of cancellation.
 */
export type RtkCancellationPolicy = 'supported' | 'not_supported';

/**
 * Retry-safety classification (zog2.9).
 *
 *   idempotent     — calling the tool multiple times with the same arguments
 *                    produces the same outcome; safe to retry.
 *   non_idempotent — a second call with the same arguments produces a different
 *                    or harmful outcome; MUST NOT be retried automatically.
 *   at_least_once  — safe to retry, but may produce duplicates (e.g. event append).
 */
export type RtkIdempotencyClass = 'idempotent' | 'non_idempotent' | 'at_least_once';

/**
 * Where the complete raw output of a tool invocation is persisted by the harness.
 *
 *   tool_calls_dir  — written to PI_TOOL_CALL_DIR under the standard
 *                     {beadId}/{stateId}/{actionId}/{toolName}/{toolInvocationId} path.
 *                     This is the default for all command, MCP, and diagnostic tools
 *                     whose raw output may be large.
 *   tool_output_dir — written to PI_TOOL_OUTPUT_DIR (used for structured artifact
 *                     exports such as JSONL dumps where the output is a named file).
 *   none_minimal    — the tool's entire native result is already minimal (e.g. a
 *                     pure acknowledgement / signal with no data payload); no
 *                     separate archive step is required.
 */
export type RtkRawOutputLocation =
  | 'tool_calls_dir'
  | 'tool_output_dir'
  | 'none_minimal';

/**
 * Per-tool RTK contract entry.
 *
 * Fields
 * ------
 *   toolName              Tool name string as registered with Pi.
 *   toolClass             Category (see RtkToolClass).
 *   owningFile            Source file that defines/registers the tool (repo-relative).
 *   schemaTypeName        TypeScript type/interface name for the tool's return schema, or
 *                         'untyped_record' when the return is Record<string,unknown>.
 *                         Schema types are owned by each tool (or the consuming project for project tools).
 *   skillPath             Path to the SKILL.md that documents model-facing usage
 *                         (planned path prefix '.pi/skills/' when file not yet created).
 *   rawOutputLocation     Where the harness persists the complete raw output of each
 *                         invocation (see RtkRawOutputLocation).
 *   deterministicCompaction  Whether this tool performs deterministic, non-LLM compaction
 *                         of its raw output into its minimal schema before returning.
 *                         true  — the tool itself reduces raw output to its schema without
 *                                 any LLM involvement (e.g. structured extraction, field
 *                                 selection, counting).
 *                         false — the tool passes raw output unchanged; harness or caller
 *                                 is responsible for any further reduction.
 *   mutating              Whether calling the tool causes a side-effect (writes to
 *                         git, beads, filesystem, tmux, …).
 */
export interface RtkContractEntry {
  readonly toolName: string;
  readonly toolClass: RtkToolClass;
  readonly owningFile: string;
  readonly schemaTypeName: string;
  readonly skillPath: string;
  readonly rawOutputLocation: RtkRawOutputLocation;
  readonly deterministicCompaction: boolean;
  readonly mutating: boolean;
  /** Whether the tool honours AbortSignal cancellation (zog2.9). */
  readonly cancellationPolicy: RtkCancellationPolicy;
  /** Retry-safety classification (zog2.9). */
  readonly idempotencyClass: RtkIdempotencyClass;
  /**
   * Non-null string means tools sharing this key must not run concurrently (zog2.9).
   * null means no cross-tool serialization constraint.
   */
  readonly serializationKey: string | null;
  /**
   * false = this tool is rejected in review/read-only statechart action contexts (zog2.9).
   */
  readonly allowedInReadOnlyContext: boolean;
  /**
   * false = this tool must not be called during a harness readiness probe (zog2.9).
   */
  readonly safeForReadinessProbe: boolean;
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

/**
 * Complete RTK inventory for all model-call tools exposed by Orr Else.
 *
 * Rules:
 *  - Every BuiltInToolName value must have exactly one entry.
 *  - Every PluginToolName value must have exactly one entry.
 *  - Every DEFAULT_OBSERVED_PI_TOOLS (NativePiToolName) value must have an entry.
 *  - Project-configured tools (config-driven) are registered here with class
 *    'project_configured'; the bare harness currently has zero.
 *  - No entry may demand a structuredResult/resultPreview return
 *    shape unless the tool is a project-configured command/mcp tool that already
 *    uses those fields.
 *  - No entry uses a byteBudget or any other generic byte-cap field — see
 *    docs/raw-output-contract.md for the full forbidden list.
 */
export const RTK_INVENTORY: readonly RtkContractEntry[] = [

  // =========================================================================
  // BUILT-IN control-plane tools
  // Registered in: src/extension.ts via pi.registerTool()
  // =========================================================================

  {
    toolName: BuiltInToolName.ORR_ELSE,
    toolClass: 'built_in',
    owningFile: 'src/extension.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'none_minimal',
    deterministicCompaction: false,
    mutating: false,
    cancellationPolicy: 'supported',
    idempotencyClass: 'idempotent',
    serializationKey: null,
    allowedInReadOnlyContext: true,
    safeForReadinessProbe: true
  },

  {
    toolName: BuiltInToolName.TICK_ITEMS,
    toolClass: 'built_in',
    owningFile: 'src/extension.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'none_minimal',
    deterministicCompaction: false,
    mutating: true,
    cancellationPolicy: 'not_supported',
    idempotencyClass: 'idempotent',
    serializationKey: null,
    allowedInReadOnlyContext: true,
    safeForReadinessProbe: false
  },

  {
    toolName: BuiltInToolName.GET_OUTSTANDING_TASKS,
    toolClass: 'built_in',
    owningFile: 'src/extension.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'tool_calls_dir',
    deterministicCompaction: true,
    mutating: false,
    cancellationPolicy: 'not_supported',
    idempotencyClass: 'idempotent',
    serializationKey: null,
    allowedInReadOnlyContext: true,
    safeForReadinessProbe: true
  },

  {
    toolName: BuiltInToolName.ADD_CHECKLIST_ITEM,
    toolClass: 'built_in',
    owningFile: 'src/extension.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'none_minimal',
    deterministicCompaction: false,
    mutating: true,
    cancellationPolicy: 'not_supported',
    idempotencyClass: 'idempotent',
    serializationKey: null,
    allowedInReadOnlyContext: true,
    safeForReadinessProbe: false
  },

  {
    toolName: BuiltInToolName.SUBMIT_CHECKPOINT,
    toolClass: 'built_in',
    owningFile: 'src/extension.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'none_minimal',
    deterministicCompaction: false,
    mutating: true,
    cancellationPolicy: 'not_supported',
    idempotencyClass: 'idempotent',
    serializationKey: null,
    allowedInReadOnlyContext: true,
    safeForReadinessProbe: false
  },

  {
    toolName: BuiltInToolName.SUBMIT_REVIEW_ARTIFACT,
    toolClass: 'built_in',
    owningFile: 'src/extension.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/reviewer/SKILL.md',
    rawOutputLocation: 'none_minimal',
    deterministicCompaction: false,
    mutating: true,
    cancellationPolicy: 'not_supported',
    idempotencyClass: 'idempotent',
    serializationKey: null,
    allowedInReadOnlyContext: false,
    safeForReadinessProbe: false
  },

  // pi-experiment-x0zh: v2 evidence-only completion surface (no route field).
  {
    toolName: BuiltInToolName.SUBMIT_ACTION_EVIDENCE,
    toolClass: 'built_in',
    owningFile: 'src/extension.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'none_minimal',
    deterministicCompaction: false,
    mutating: true,
    cancellationPolicy: 'not_supported',
    idempotencyClass: 'idempotent',
    serializationKey: null,
    allowedInReadOnlyContext: false,
    safeForReadinessProbe: false
  },

  {
    toolName: BuiltInToolName.SIGNAL_COMPLETION,
    toolClass: 'built_in',
    owningFile: 'src/extension.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'none_minimal',
    deterministicCompaction: false,
    mutating: true,
    cancellationPolicy: 'not_supported',
    idempotencyClass: 'idempotent',
    serializationKey: null,
    allowedInReadOnlyContext: false,
    safeForReadinessProbe: false
  },

  {
    toolName: BuiltInToolName.REQUEST_CONTEXT_RESTART,
    toolClass: 'built_in',
    owningFile: 'src/extension.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'none_minimal',
    deterministicCompaction: false,
    mutating: true,
    cancellationPolicy: 'not_supported',
    idempotencyClass: 'idempotent',
    serializationKey: null,
    allowedInReadOnlyContext: true,
    safeForReadinessProbe: false
  },

  {
    toolName: BuiltInToolName.REQUEST_HARNESS_RESTART,
    toolClass: 'built_in',
    owningFile: 'src/extension.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'none_minimal',
    deterministicCompaction: false,
    mutating: true,
    cancellationPolicy: 'not_supported',
    idempotencyClass: 'idempotent',
    serializationKey: null,
    allowedInReadOnlyContext: true,
    safeForReadinessProbe: false
  },

  {
    toolName: BuiltInToolName.GET_ARTIFACT_PATHS,
    toolClass: 'built_in',
    owningFile: 'src/extension.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/artifact-evidence/SKILL.md',
    rawOutputLocation: 'tool_calls_dir',
    deterministicCompaction: true,
    mutating: false,
    cancellationPolicy: 'not_supported',
    idempotencyClass: 'idempotent',
    serializationKey: null,
    allowedInReadOnlyContext: true,
    safeForReadinessProbe: true
  },

  {
    toolName: BuiltInToolName.QUERY_ARTIFACT,
    toolClass: 'built_in',
    owningFile: 'src/extension.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/artifact-evidence/SKILL.md',
    rawOutputLocation: 'tool_calls_dir',
    deterministicCompaction: true,
    mutating: false,
    cancellationPolicy: 'not_supported',
    idempotencyClass: 'idempotent',
    serializationKey: null,
    allowedInReadOnlyContext: true,
    safeForReadinessProbe: true
  },

  {
    toolName: BuiltInToolName.READ_PATH_CONTEXT,
    toolClass: 'built_in',
    owningFile: 'src/extension.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'tool_calls_dir',
    deterministicCompaction: false,
    mutating: false,
    cancellationPolicy: 'not_supported',
    idempotencyClass: 'idempotent',
    serializationKey: null,
    allowedInReadOnlyContext: true,
    safeForReadinessProbe: true
  },

  {
    toolName: BuiltInToolName.HARNESS_STATUS,
    toolClass: 'built_in',
    owningFile: 'src/extension.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'tool_calls_dir',
    deterministicCompaction: true,
    mutating: false,
    cancellationPolicy: 'not_supported',
    idempotencyClass: 'idempotent',
    serializationKey: null,
    allowedInReadOnlyContext: true,
    safeForReadinessProbe: true
  },

  {
    toolName: BuiltInToolName.PRE_SIGNAL_AUDIT,
    toolClass: 'built_in',
    owningFile: 'src/extension.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'tool_calls_dir',
    deterministicCompaction: true,
    mutating: false,
    cancellationPolicy: 'not_supported',
    idempotencyClass: 'idempotent',
    serializationKey: null,
    allowedInReadOnlyContext: true,
    safeForReadinessProbe: true
  },

  {
    toolName: BuiltInToolName.QUERY_HARNESS_EVENTS,
    toolClass: 'built_in',
    owningFile: 'src/core/HarnessEventQuery.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'tool_calls_dir',
    deterministicCompaction: true,
    mutating: false,
    cancellationPolicy: 'not_supported',
    idempotencyClass: 'idempotent',
    serializationKey: null,
    allowedInReadOnlyContext: true,
    safeForReadinessProbe: true
  },

  {
    toolName: BuiltInToolName.QUERY_TOOL_OUTPUT,
    toolClass: 'built_in',
    owningFile: 'src/core/ToolOutputQuery.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'tool_calls_dir',
    deterministicCompaction: true,
    mutating: false,
    cancellationPolicy: 'not_supported',
    idempotencyClass: 'idempotent',
    serializationKey: null,
    allowedInReadOnlyContext: true,
    safeForReadinessProbe: true
  },

  // =========================================================================
  // PLUGIN tools — bundled runtime plugins
  // =========================================================================

  // -- Beads (bd) plugin — src/plugins/bd.ts --

  {
    toolName: PluginToolName.BD_HEARTBEAT,
    toolClass: 'plugin',
    owningFile: 'src/plugins/bd.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'none_minimal',
    deterministicCompaction: false,
    mutating: true,
    cancellationPolicy: 'not_supported',
    idempotencyClass: 'idempotent',
    serializationKey: null,
    allowedInReadOnlyContext: true,
    safeForReadinessProbe: false
  },

  {
    toolName: PluginToolName.BD_READY,
    toolClass: 'plugin',
    owningFile: 'src/plugins/bd.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'tool_calls_dir',
    deterministicCompaction: true,
    mutating: false,
    cancellationPolicy: 'not_supported',
    idempotencyClass: 'idempotent',
    serializationKey: null,
    allowedInReadOnlyContext: true,
    safeForReadinessProbe: true
  },

  {
    toolName: PluginToolName.BD_LIST,
    toolClass: 'plugin',
    owningFile: 'src/plugins/bd.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'tool_calls_dir',
    deterministicCompaction: true,
    mutating: false,
    cancellationPolicy: 'not_supported',
    idempotencyClass: 'idempotent',
    serializationKey: null,
    allowedInReadOnlyContext: true,
    safeForReadinessProbe: true
  },

  {
    toolName: PluginToolName.BD_EXPORT_JSONL,
    toolClass: 'plugin',
    owningFile: 'src/plugins/bd.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'tool_output_dir',
    deterministicCompaction: true,
    mutating: false,
    cancellationPolicy: 'not_supported',
    idempotencyClass: 'idempotent',
    serializationKey: null,
    allowedInReadOnlyContext: true,
    safeForReadinessProbe: false
  },

  {
    toolName: PluginToolName.BD_IMPORT_JSONL,
    toolClass: 'plugin',
    owningFile: 'src/plugins/bd.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'none_minimal',
    deterministicCompaction: false,
    mutating: true,
    cancellationPolicy: 'not_supported',
    idempotencyClass: 'idempotent',
    serializationKey: null,
    allowedInReadOnlyContext: false,
    safeForReadinessProbe: false
  },

  {
    toolName: PluginToolName.BD_CREATE,
    toolClass: 'plugin',
    owningFile: 'src/plugins/bd.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'none_minimal',
    deterministicCompaction: false,
    mutating: true,
    cancellationPolicy: 'not_supported',
    idempotencyClass: 'non_idempotent',
    serializationKey: null,
    allowedInReadOnlyContext: false,
    safeForReadinessProbe: false
  },

  {
    toolName: PluginToolName.BD_GET_BEAD,
    toolClass: 'plugin',
    owningFile: 'src/plugins/bd.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'tool_calls_dir',
    deterministicCompaction: true,
    mutating: false,
    cancellationPolicy: 'not_supported',
    idempotencyClass: 'idempotent',
    serializationKey: null,
    allowedInReadOnlyContext: true,
    safeForReadinessProbe: true
  },

  {
    toolName: PluginToolName.BD_GET_STATE_CHART,
    toolClass: 'plugin',
    owningFile: 'src/plugins/bd.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'tool_calls_dir',
    deterministicCompaction: true,
    mutating: false,
    cancellationPolicy: 'not_supported',
    idempotencyClass: 'idempotent',
    serializationKey: null,
    allowedInReadOnlyContext: true,
    safeForReadinessProbe: true
  },

  {
    toolName: PluginToolName.BD_CLAIM,
    toolClass: 'plugin',
    owningFile: 'src/plugins/bd.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'none_minimal',
    deterministicCompaction: false,
    mutating: true,
    cancellationPolicy: 'not_supported',
    idempotencyClass: 'non_idempotent',
    serializationKey: null,
    allowedInReadOnlyContext: false,
    safeForReadinessProbe: false
  },

  {
    toolName: PluginToolName.BD_RELEASE,
    toolClass: 'plugin',
    owningFile: 'src/plugins/bd.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'none_minimal',
    deterministicCompaction: false,
    mutating: true,
    cancellationPolicy: 'not_supported',
    idempotencyClass: 'idempotent',
    serializationKey: null,
    allowedInReadOnlyContext: true,
    safeForReadinessProbe: false
  },

  {
    toolName: PluginToolName.BD_UPDATE_STATUS,
    toolClass: 'plugin',
    owningFile: 'src/plugins/bd.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'none_minimal',
    deterministicCompaction: false,
    mutating: true,
    cancellationPolicy: 'not_supported',
    idempotencyClass: 'idempotent',
    serializationKey: null,
    allowedInReadOnlyContext: false,
    safeForReadinessProbe: false
  },

  {
    toolName: PluginToolName.BD_GET_HEARTBEATS,
    toolClass: 'plugin',
    owningFile: 'src/plugins/bd.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'tool_calls_dir',
    deterministicCompaction: true,
    mutating: false,
    cancellationPolicy: 'not_supported',
    idempotencyClass: 'idempotent',
    serializationKey: null,
    allowedInReadOnlyContext: true,
    safeForReadinessProbe: true
  },

  // -- Git plugin — src/plugins/git.ts --

  {
    toolName: PluginToolName.CREATE_WORKTREE,
    toolClass: 'plugin',
    owningFile: 'src/plugins/git.ts',
    schemaTypeName: 'WorktreeResult',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'none_minimal',
    deterministicCompaction: false,
    mutating: true,
    cancellationPolicy: 'not_supported',
    idempotencyClass: 'non_idempotent',
    serializationKey: null,
    allowedInReadOnlyContext: false,
    safeForReadinessProbe: false
  },

  {
    toolName: PluginToolName.REMOVE_WORKTREE,
    toolClass: 'plugin',
    owningFile: 'src/plugins/git.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'none_minimal',
    deterministicCompaction: false,
    mutating: true,
    cancellationPolicy: 'not_supported',
    idempotencyClass: 'idempotent',
    serializationKey: null,
    allowedInReadOnlyContext: false,
    safeForReadinessProbe: false
  },

  {
    toolName: PluginToolName.MERGE_AND_COMMIT,
    toolClass: 'plugin',
    owningFile: 'src/plugins/git.ts',
    schemaTypeName: 'MergeResult',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'tool_calls_dir',
    deterministicCompaction: true,
    mutating: true,
    cancellationPolicy: 'not_supported',
    idempotencyClass: 'non_idempotent',
    serializationKey: 'git_merge',
    allowedInReadOnlyContext: false,
    safeForReadinessProbe: false
  },

  // -- Mailbox plugin — src/plugins/mailbox.ts --

  {
    toolName: PluginToolName.SEND_MAILBOX_MESSAGE,
    toolClass: 'plugin',
    owningFile: 'src/plugins/mailbox.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'none_minimal',
    deterministicCompaction: false,
    mutating: true,
    cancellationPolicy: 'not_supported',
    idempotencyClass: 'non_idempotent',
    serializationKey: null,
    allowedInReadOnlyContext: false,
    safeForReadinessProbe: false
  },

  {
    toolName: PluginToolName.CHECK_MAILBOX,
    toolClass: 'plugin',
    owningFile: 'src/plugins/mailbox.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'tool_calls_dir',
    deterministicCompaction: true,
    mutating: false,
    cancellationPolicy: 'not_supported',
    idempotencyClass: 'idempotent',
    serializationKey: null,
    allowedInReadOnlyContext: true,
    safeForReadinessProbe: true
  },

  {
    toolName: PluginToolName.FETCH_MAILBOX_MESSAGE,
    toolClass: 'plugin',
    owningFile: 'src/plugins/mailbox.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'tool_calls_dir',
    deterministicCompaction: true,
    mutating: false,
    cancellationPolicy: 'not_supported',
    idempotencyClass: 'idempotent',
    serializationKey: null,
    allowedInReadOnlyContext: true,
    safeForReadinessProbe: true
  },

  // -- Quality plugin — src/plugins/quality.ts --

  {
    toolName: PluginToolName.COMPRESS_SESSION_LOGS,
    toolClass: 'plugin',
    owningFile: 'src/plugins/quality.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'none_minimal',
    deterministicCompaction: false,
    mutating: true,
    cancellationPolicy: 'not_supported',
    idempotencyClass: 'idempotent',
    serializationKey: null,
    allowedInReadOnlyContext: true,
    safeForReadinessProbe: false
  },

  // -- Teammates plugin — src/plugins/teammates.ts --

  {
    toolName: PluginToolName.SPAWN_TEAMMATE,
    toolClass: 'plugin',
    owningFile: 'src/plugins/teammates.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'none_minimal',
    deterministicCompaction: false,
    mutating: true,
    cancellationPolicy: 'not_supported',
    idempotencyClass: 'non_idempotent',
    serializationKey: null,
    allowedInReadOnlyContext: false,
    safeForReadinessProbe: false
  },

  // -- Meta plugin — src/plugins/meta.ts --

  {
    toolName: PluginToolName.CREATE_NEW_PLUGIN,
    toolClass: 'plugin',
    owningFile: 'src/plugins/meta.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'none_minimal',
    deterministicCompaction: false,
    mutating: true,
    cancellationPolicy: 'not_supported',
    idempotencyClass: 'non_idempotent',
    serializationKey: null,
    allowedInReadOnlyContext: false,
    safeForReadinessProbe: false
  },

  // =========================================================================
  // NATIVE PI tools — Pi's own built-in tools observed by harness policy
  // Policy defined in: src/constants/index.ts (DEFAULT_OBSERVED_PI_TOOLS)
  // =========================================================================

  {
    toolName: NativePiToolName.BASH,
    toolClass: 'native_pi',
    owningFile: 'src/constants/index.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'tool_calls_dir',
    deterministicCompaction: false,
    mutating: true,
    cancellationPolicy: 'supported',
    idempotencyClass: 'non_idempotent',
    serializationKey: null,
    allowedInReadOnlyContext: false,
    safeForReadinessProbe: false
  },

  {
    toolName: NativePiToolName.EDIT,
    toolClass: 'native_pi',
    owningFile: 'src/constants/index.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'none_minimal',
    deterministicCompaction: false,
    mutating: true,
    cancellationPolicy: 'supported',
    idempotencyClass: 'non_idempotent',
    serializationKey: null,
    allowedInReadOnlyContext: false,
    safeForReadinessProbe: false
  },

  {
    toolName: NativePiToolName.FIND,
    toolClass: 'native_pi',
    owningFile: 'src/constants/index.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'tool_calls_dir',
    deterministicCompaction: false,
    mutating: false,
    cancellationPolicy: 'supported',
    idempotencyClass: 'idempotent',
    serializationKey: null,
    allowedInReadOnlyContext: true,
    safeForReadinessProbe: true
  },

  {
    toolName: NativePiToolName.GREP,
    toolClass: 'native_pi',
    owningFile: 'src/constants/index.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'tool_calls_dir',
    deterministicCompaction: false,
    mutating: false,
    cancellationPolicy: 'supported',
    idempotencyClass: 'idempotent',
    serializationKey: null,
    allowedInReadOnlyContext: true,
    safeForReadinessProbe: true
  },

  {
    toolName: NativePiToolName.LS,
    toolClass: 'native_pi',
    owningFile: 'src/constants/index.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'tool_calls_dir',
    deterministicCompaction: false,
    mutating: false,
    cancellationPolicy: 'supported',
    idempotencyClass: 'idempotent',
    serializationKey: null,
    allowedInReadOnlyContext: true,
    safeForReadinessProbe: true
  },

  {
    toolName: NativePiToolName.MCP,
    toolClass: 'native_pi',
    owningFile: 'src/constants/index.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'tool_calls_dir',
    deterministicCompaction: false,
    mutating: true,
    cancellationPolicy: 'supported',
    idempotencyClass: 'non_idempotent',
    serializationKey: null,
    allowedInReadOnlyContext: false,
    safeForReadinessProbe: false
  },

  {
    toolName: NativePiToolName.READ,
    toolClass: 'native_pi',
    owningFile: 'src/constants/index.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'tool_calls_dir',
    deterministicCompaction: false,
    mutating: false,
    cancellationPolicy: 'supported',
    idempotencyClass: 'idempotent',
    serializationKey: null,
    allowedInReadOnlyContext: true,
    safeForReadinessProbe: true
  },

  {
    toolName: NativePiToolName.WRITE,
    toolClass: 'native_pi',
    owningFile: 'src/constants/index.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'none_minimal',
    deterministicCompaction: false,
    mutating: true,
    cancellationPolicy: 'supported',
    idempotencyClass: 'non_idempotent',
    serializationKey: null,
    allowedInReadOnlyContext: false,
    safeForReadinessProbe: false
  }

  // =========================================================================
  // PROJECT-CONFIGURED tools (config-driven; none in the bare harness)
  // When the harness.yaml `tools:` section is populated, add entries here
  // following the pattern:
  //
  // {
  //   toolName: '<name from harness.yaml>',
  //   toolClass: 'project_configured',
  //   owningFile: 'harness.yaml',
  //   schemaTypeName: 'ModelFacingProjectToolResult',
  //   skillPath: '.pi/skills/tool-routing/SKILL.md',
  //   rawOutputLocation: 'tool_calls_dir',
  //   deterministicCompaction: true,  // set false for pass-through commands
  //   mutating: false  // set true for write/mutation commands
  // }
  //
  // NOTE: project-configured tools MAY use structuredResult/resultPreview — those
  // are not required of other tool classes.  outputArchive has been removed (55lu).
  // =========================================================================

] as const;

// ---------------------------------------------------------------------------
// Index helpers
// ---------------------------------------------------------------------------


/**
 * Map from toolName -> RtkContractEntry for O(1) lookup.
 * Built once at module load; safe to reuse across calls.
 */
export const RTK_INVENTORY_BY_NAME: ReadonlyMap<string, RtkContractEntry> = new Map(
  RTK_INVENTORY.map(entry => [entry.toolName, entry])
);

/**
 * Return the RTK contract entry for a tool, or undefined when not registered.
 */
export function getRtkContractEntry(toolName: string): RtkContractEntry | undefined {
  return RTK_INVENTORY_BY_NAME.get(toolName);
}

// ---------------------------------------------------------------------------
// Regression guardrail
// ---------------------------------------------------------------------------

/**
 * RtkInventoryViolation — details of a missing-inventory registration.
 */
export interface RtkInventoryViolation {
  toolName: string;
  message: string;
}

/**
 * Assert that every name in `registeredToolNames` has an RTK inventory entry.
 *
 * Returns an array of violations (empty = all tools covered).  Callers that
 * want a hard failure should throw when the array is non-empty — see
 * tests/rtk_inventory.test.ts for the canonical pattern.
 *
 * This function does NOT require any specific return-key shape; it only checks
 * that a contract entry exists for each registered tool name.
 */
export function checkRtkInventoryCoverage(registeredToolNames: readonly string[]): RtkInventoryViolation[] {
  const violations: RtkInventoryViolation[] = [];
  for (const name of registeredToolNames) {
    if (!RTK_INVENTORY_BY_NAME.has(name)) {
      violations.push({
        toolName: name,
        message:
          `Tool "${name}" is registered as a model-call tool but has no RTK inventory entry. ` +
          `Add an entry to RTK_INVENTORY in src/core/RtkContract.ts.`
      });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Cerdiwen required-tool evidence-class classification (pi-experiment-zog2.19)
// ---------------------------------------------------------------------------

/**
 * The three evidence classes a required tool can produce.
 *
 * VERIFIER_BACKED_SEMANTIC_ARTIFACT
 *   A registered verify() callback reads the tool's durable output artifact and
 *   returns a non-trivial PASS / FAIL verdict. The gate enforces both artifact
 *   presence AND the verifier's semantic judgment. Absence always blocks; a FAIL
 *   verdict blocks even when the tool ran.
 *
 *   In Cerdiwen: requirements_schema, plan_contract, run_quality_checks,
 *   sonarqube, git_history (harness-owned).
 *
 * CONTROL_PLANE_ACK
 *   A registered verify() callback confirms the tool produced a parseable output,
 *   but the verdict is always PASS when the tool ran (control-plane confirmation,
 *   not a semantic gate). The gate enforces artifact presence + parse success;
 *   the CONTENT of the output does not determine pass/fail.
 *
 *   In Cerdiwen: codemap, python_lsp, reference_docs, ast_grep, smt_lib.
 *   (smt_lib can return NOT_APPLICABLE for non-formalizable beads — treated as
 *   non-blocking control-plane confirmation in those cases.)
 *
 * PRESENCE_ONLY
 *   No verify() callback is registered. The gate enforces only that the tool was
 *   called and produced a non-empty result in the current bead/state/action.
 *   Model prose, OTel traces, tmux text, and implicit log records cannot satisfy
 *   this gate — a durable tool-call event in the EventStore is required — but
 *   the gate does NOT inspect or validate the output content.
 *
 *   In Cerdiwen: coding_standards, add_checklist_item, tick_items,
 *   submit_review_artifact, pytest, semgrep.
 */
export type EvidenceClass =
  | 'VERIFIER_BACKED_SEMANTIC_ARTIFACT'
  | 'CONTROL_PLANE_ACK'
  | 'PRESENCE_ONLY';

/**
 * Per-tool evidence-class classification entry for a Cerdiwen required tool.
 *
 * Fields
 * ------
 *   toolName       — the tool name as declared in cerdiwen harness.yaml requiredTools.
 *   evidenceClass  — which class of evidence this tool produces (see EvidenceClass).
 *   expectsVerify  — mirrors the `expectsVerify` field in harness.yaml (true = gate
 *                    enforces a registered verify() callback; false/absent = presence-only).
 *   hasVerifyCallback — whether a verify() is registered in the harness verifier registry
 *                    for this tool at runtime. Tools with CONTROL_PLANE_ACK have a verify()
 *                    but are NOT declared expectsVerify:true in requiredTools; the verify()
 *                    still runs when the gate sees a tool-call record. PRESENCE_ONLY tools
 *                    have no verify() callback registered.
 *   verifyOwner    — which file owns the verify() callback ('harness' = src/tools/;
 *                    'cerdiwen-extension' = cerdiwen .pi/extensions/cerdiwen.ts;
 *                    'none' = no verify() registered).
 *   notes          — brief rationale for the classification.
 */
export interface CerdiwenToolClassificationEntry {
  readonly toolName: string;
  readonly evidenceClass: EvidenceClass;
  readonly expectsVerify: boolean;
  readonly hasVerifyCallback: boolean;
  readonly verifyOwner: 'harness' | 'cerdiwen-extension' | 'none';
  readonly notes: string;
}

/**
 * Authoritative evidence-class classification for every required tool declared
 * in Cerdiwen's harness.yaml requiredTools (pi-experiment-zog2.19).
 *
 * This fixture is the CLASSIFICATION CONTRACT that makes the subsequent removal
 * of presence-only implicit evidence (zog2.8) safe and intentional. Any tool
 * not listed here, or any tool listed as PRESENCE_ONLY that subsequently gains
 * a verify() without updating this inventory, constitutes a classification drift.
 *
 * Source: /bankwest/cerdiwen/harness.yaml (states.*.requiredTools) +
 *         /bankwest/cerdiwen/.pi/extensions/cerdiwen.ts (verifier.register calls) +
 *         /pi-experiment/src/tools/index.ts (harness-owned verify registrations).
 *
 * NOTE: auto_fix and codemod are tsProjectTool definitions in cerdiwen harness.yaml
 * but do NOT appear in any state's requiredTools block. They are NOT included here.
 * This inventory covers only the 15 tools that appear in at least one
 * states.*.requiredTools entry.
 *
 * Ordered: verifier-backed → control-plane-ack → presence-only.
 */
export const CERDIWEN_REQUIRED_TOOL_CLASSIFICATIONS: readonly CerdiwenToolClassificationEntry[] = [

  // =========================================================================
  // VERIFIER_BACKED_SEMANTIC_ARTIFACT
  // verify() reads artifact content and returns a non-trivial PASS/FAIL verdict.
  // =========================================================================

  {
    toolName: 'requirements_schema',
    evidenceClass: 'VERIFIER_BACKED_SEMANTIC_ARTIFACT',
    expectsVerify: true,
    hasVerifyCallback: true,
    verifyOwner: 'cerdiwen-extension',
    notes:
      'verify() validates the requirementsAnalysis JSON artifact schema ' +
      '(EARS structure, no legacy vocabulary, reference-docs evidence). ' +
      'Any REJECTED check returns FAIL; absent artifact returns NOT_APPLICABLE.',
  },

  {
    toolName: 'plan_contract',
    evidenceClass: 'VERIFIER_BACKED_SEMANTIC_ARTIFACT',
    expectsVerify: true,
    hasVerifyCallback: true,
    verifyOwner: 'cerdiwen-extension',
    notes:
      'verify() validates the planContract JSON artifact structure ' +
      '(implementationSteps/writeSet linkage, traceability, zero compiler-lowering). ' +
      'Any REJECTED check returns FAIL; absent artifact returns NOT_APPLICABLE.',
  },

  {
    toolName: 'run_quality_checks',
    evidenceClass: 'VERIFIER_BACKED_SEMANTIC_ARTIFACT',
    expectsVerify: true,
    hasVerifyCallback: true,
    verifyOwner: 'cerdiwen-extension',
    notes:
      'verify() reads the structuredResult and returns FAIL when blocking_count > 0. ' +
      'Gates the Implementation→AdversarialPostReview transition (pi-experiment-ij1f).',
  },

  {
    toolName: 'sonarqube',
    evidenceClass: 'VERIFIER_BACKED_SEMANTIC_ARTIFACT',
    expectsVerify: true,
    hasVerifyCallback: true,
    verifyOwner: 'cerdiwen-extension',
    notes:
      'verify() reads the persisted SonarQube API response and returns FAIL when ' +
      'qualityGateStatus === "ERROR". Gates AdversarialPostReview (pi-experiment-s3ss).',
  },

  {
    toolName: 'git_history',
    evidenceClass: 'VERIFIER_BACKED_SEMANTIC_ARTIFACT',
    expectsVerify: false,   // declared as plain string in harness.yaml (no expectsVerify:true)
    hasVerifyCallback: true,
    verifyOwner: 'harness',
    notes:
      'Harness-owned (pi-experiment-srpk AC2): the harness self-registers ' +
      'gitHistoryVerify() from src/tools/git_history.ts. verify() validates that ' +
      'a canonical ToolEvidenceHandle exists with runStatus=PASSED; REJECTED runs ' +
      'return FAIL; absent artifact returns NOT_APPLICABLE. NOT declared expectsVerify ' +
      'in harness.yaml (plain string form), so the config fail-fast does not require ' +
      'the extension — the harness registers it unconditionally.',
  },

  // =========================================================================
  // CONTROL_PLANE_ACK
  // verify() confirms tool ran + output is parseable; verdict is always PASS
  // when the tool ran (content does not drive FAIL). NOT declared expectsVerify.
  // =========================================================================

  {
    toolName: 'codemap',
    evidenceClass: 'CONTROL_PLANE_ACK',
    expectsVerify: false,
    hasVerifyCallback: true,
    verifyOwner: 'cerdiwen-extension',
    notes:
      'verify() returns PASS when a parseable output exists for this run, ' +
      'NOT_APPLICABLE when absent. The codemap query content does not drive FAIL; ' +
      'the gate confirms the tool was called, not that any specific claim was found.',
  },

  {
    toolName: 'python_lsp',
    evidenceClass: 'CONTROL_PLANE_ACK',
    expectsVerify: false,
    hasVerifyCallback: true,
    verifyOwner: 'cerdiwen-extension',
    notes:
      'verify() returns PASS for a clean MCP response, FAIL for MCP-level errors, ' +
      'NOT_APPLICABLE when absent. The diagnostic count does not drive FAIL ' +
      '(the python_lsp tool owns the blocking gate, not verify()).',
  },

  {
    toolName: 'reference_docs',
    evidenceClass: 'CONTROL_PLANE_ACK',
    expectsVerify: false,
    hasVerifyCallback: true,
    verifyOwner: 'cerdiwen-extension',
    notes:
      'verify() returns PASS for a clean MCP response (query ran and returned ' +
      'evidence), FAIL for MCP-level errors, NOT_APPLICABLE when absent. ' +
      'Semantic claim quality is not gated by verify().',
  },

  {
    toolName: 'ast_grep',
    evidenceClass: 'CONTROL_PLANE_ACK',
    expectsVerify: false,
    hasVerifyCallback: true,
    verifyOwner: 'cerdiwen-extension',
    notes:
      'verify() returns PASS when parseable output exists (match count is irrelevant; ' +
      'zero matches is still a valid query result). NOT_APPLICABLE when absent.',
  },

  {
    toolName: 'smt_lib',
    evidenceClass: 'CONTROL_PLANE_ACK',
    expectsVerify: false,
    hasVerifyCallback: true,
    verifyOwner: 'cerdiwen-extension',
    notes:
      'verify() returns NOT_APPLICABLE for non-formalizable beads (formalizable:false), ' +
      'PASS when all check-sat results are unsat, FAIL when any sat/unknown appears. ' +
      'Classified CONTROL_PLANE_ACK because the gate verdict is driven by the ' +
      'harness-injected formalizable flag, not by independent semantic audit of model output.',
  },

  // =========================================================================
  // PRESENCE_ONLY
  // No verify() registered. Gate enforces a durable tool-call EventStore record
  // only. Model prose, OTel traces, tmux text, and implicit log records cannot
  // satisfy this gate — only a PASSED PROJECT_TOOL event can.
  // =========================================================================

  {
    toolName: 'coding_standards',
    evidenceClass: 'PRESENCE_ONLY',
    expectsVerify: false,
    hasVerifyCallback: false,
    verifyOwner: 'none',
    notes:
      'No verify() registered. Gate confirms the tool was called and returned a ' +
      'PASSED status; rule document selection is model-guidance, not a semantic gate.',
  },

  {
    toolName: 'add_checklist_item',
    evidenceClass: 'PRESENCE_ONLY',
    expectsVerify: false,
    hasVerifyCallback: false,
    verifyOwner: 'none',
    notes:
      'Built-in control-plane tool (BuiltInToolName.ADD_CHECKLIST_ITEM). No verify() ' +
      'registered. Gate confirms the tool was invoked; the content of checklist items ' +
      'is not subject to a verifier verdict. Required by AdversarialPostReview.',
  },

  {
    toolName: 'tick_items',
    evidenceClass: 'PRESENCE_ONLY',
    expectsVerify: false,
    hasVerifyCallback: false,
    verifyOwner: 'none',
    notes:
      'Built-in control-plane tool (BuiltInToolName.TICK_ITEMS). No verify() registered. ' +
      'Gate confirms the model called tick_items (batch-ticking mandatory checklist items ' +
      'with evidence) and the run PASSED; wrapPluginTool records TOOL_INVOCATION_SUCCEEDED ' +
      'with an outputFile (persistPluginToolRawResult), satisfying presence-only evidence ' +
      'per zog2.8. Required by RequirementsClarification (6q0y.51 no-deadlock fix).',
  },

  {
    toolName: 'submit_review_artifact',
    evidenceClass: 'PRESENCE_ONLY',
    expectsVerify: false,
    hasVerifyCallback: false,
    verifyOwner: 'none',
    notes:
      'Built-in control-plane tool (BuiltInToolName.SUBMIT_REVIEW_ARTIFACT). No verify() ' +
      'registered. Gate confirms the artifact was submitted; the review content is not ' +
      'subject to a verifier verdict (review quality is enforced upstream by the reviewer).',
  },

  {
    toolName: 'pytest',
    evidenceClass: 'PRESENCE_ONLY',
    expectsVerify: false,
    hasVerifyCallback: false,
    verifyOwner: 'none',
    notes:
      'No verify() registered. Tool execution outcome (exit code) is surfaced via ' +
      'runStatus (PASSED/REJECTED); a non-zero exit code produces REJECTED which blocks ' +
      'the gate via artifact-presence failure. No separate semantic verifier.',
  },

  {
    toolName: 'semgrep',
    evidenceClass: 'PRESENCE_ONLY',
    expectsVerify: false,
    hasVerifyCallback: false,
    verifyOwner: 'none',
    notes:
      'No verify() registered despite semgrep having a failureLimit in harness.yaml. ' +
      'Gate confirms the tool was called; finding interpretation is model-responsibility. ' +
      'A verify() is NOT registered in cerdiwen.ts — presence-only before zog2.8.',
  },

] as const;

/**
 * Map from toolName → CerdiwenToolClassificationEntry for O(1) lookup.
 */
export const CERDIWEN_CLASSIFICATION_BY_NAME: ReadonlyMap<string, CerdiwenToolClassificationEntry> =
  new Map(CERDIWEN_REQUIRED_TOOL_CLASSIFICATIONS.map(e => [e.toolName, e]));

/**
 * The complete set of Cerdiwen required tool names (from harness.yaml),
 * used as the authoritative enumeration for classification coverage tests.
 *
 * This list is derived from all state.requiredTools entries across all states
 * in /bankwest/cerdiwen/harness.yaml. Only tools that appear in at least one
 * state's requiredTools block are listed here. auto_fix and codemod are
 * tsProjectTool definitions in harness.yaml but are NOT in any requiredTools
 * block and therefore are NOT listed here.
 */
export const CERDIWEN_REQUIRED_TOOL_NAMES: readonly string[] = [
  'semgrep',
  'pytest',
  'coding_standards',
  'add_checklist_item',
  'tick_items',
  'submit_review_artifact',
  'requirements_schema',
  'plan_contract',
  'run_quality_checks',
  'sonarqube',
  'reference_docs',
  'git_history',
  'smt_lib',
  'codemap',
  'python_lsp',
  'ast_grep',
] as const;
