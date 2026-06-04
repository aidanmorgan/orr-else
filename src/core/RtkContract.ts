/**
 * RtkContract — per-tool RTK (token-minimisation) contract model for Orr Else.
 *
 * DESIGN INTENT
 * -------------
 * Each tool owns its minimal return schema and interpretation rules.  There is
 * intentionally NO shared public return envelope — structuredResult/resultPreview/
 * outputArchive are project-tool compatibility fields that remain where they are
 * already used; they are NOT required by any other tool class.
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
 *  - No entry may demand a structuredResult/resultPreview/outputArchive return
 *    shape unless the tool is a project-configured command/mcp tool that already
 *    uses those compatibility fields.
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
    mutating: false
  },

  {
    toolName: BuiltInToolName.TICK_ITEM,
    toolClass: 'built_in',
    owningFile: 'src/extension.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'none_minimal',
    deterministicCompaction: false,
    mutating: true
  },

  {
    toolName: BuiltInToolName.TICK_ITEMS,
    toolClass: 'built_in',
    owningFile: 'src/extension.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'none_minimal',
    deterministicCompaction: false,
    mutating: true
  },

  {
    toolName: BuiltInToolName.GET_OUTSTANDING_TASKS,
    toolClass: 'built_in',
    owningFile: 'src/extension.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'tool_calls_dir',
    deterministicCompaction: true,
    mutating: false
  },

  {
    toolName: BuiltInToolName.ADD_CHECKLIST_ITEM,
    toolClass: 'built_in',
    owningFile: 'src/extension.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'none_minimal',
    deterministicCompaction: false,
    mutating: true
  },

  {
    toolName: BuiltInToolName.SUBMIT_CHECKPOINT,
    toolClass: 'built_in',
    owningFile: 'src/extension.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'none_minimal',
    deterministicCompaction: false,
    mutating: true
  },

  {
    toolName: BuiltInToolName.SUBMIT_REVIEW_ARTIFACT,
    toolClass: 'built_in',
    owningFile: 'src/extension.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/reviewer/SKILL.md',
    rawOutputLocation: 'none_minimal',
    deterministicCompaction: false,
    mutating: true
  },

  {
    toolName: BuiltInToolName.SIGNAL_COMPLETION,
    toolClass: 'built_in',
    owningFile: 'src/extension.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'none_minimal',
    deterministicCompaction: false,
    mutating: true
  },

  {
    toolName: BuiltInToolName.REQUEST_CONTEXT_RESTART,
    toolClass: 'built_in',
    owningFile: 'src/extension.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'none_minimal',
    deterministicCompaction: false,
    mutating: true
  },

  {
    toolName: BuiltInToolName.REQUEST_HARNESS_RESTART,
    toolClass: 'built_in',
    owningFile: 'src/extension.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'none_minimal',
    deterministicCompaction: false,
    mutating: true
  },

  {
    toolName: BuiltInToolName.GET_ARTIFACT_PATHS,
    toolClass: 'built_in',
    owningFile: 'src/extension.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/artifact-evidence/SKILL.md',
    rawOutputLocation: 'tool_calls_dir',
    deterministicCompaction: true,
    mutating: false
  },

  {
    toolName: BuiltInToolName.QUERY_ARTIFACT,
    toolClass: 'built_in',
    owningFile: 'src/extension.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/artifact-evidence/SKILL.md',
    rawOutputLocation: 'tool_calls_dir',
    deterministicCompaction: true,
    mutating: false
  },

  {
    toolName: BuiltInToolName.GET_COMPATIBILITY_CONTEXT,
    toolClass: 'built_in',
    owningFile: 'src/extension.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'tool_calls_dir',
    deterministicCompaction: true,
    mutating: false
  },

  {
    toolName: BuiltInToolName.READ_PATH_CONTEXT,
    toolClass: 'built_in',
    owningFile: 'src/extension.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'tool_calls_dir',
    deterministicCompaction: false,
    mutating: false
  },

  {
    toolName: BuiltInToolName.HARNESS_STATUS,
    toolClass: 'built_in',
    owningFile: 'src/extension.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'tool_calls_dir',
    deterministicCompaction: true,
    mutating: false
  },

  {
    toolName: BuiltInToolName.PRE_SIGNAL_AUDIT,
    toolClass: 'built_in',
    owningFile: 'src/extension.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'tool_calls_dir',
    deterministicCompaction: true,
    mutating: false
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
    mutating: true
  },

  {
    toolName: PluginToolName.BD_READY,
    toolClass: 'plugin',
    owningFile: 'src/plugins/bd.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'tool_calls_dir',
    deterministicCompaction: true,
    mutating: false
  },

  {
    toolName: PluginToolName.BD_LIST,
    toolClass: 'plugin',
    owningFile: 'src/plugins/bd.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'tool_calls_dir',
    deterministicCompaction: true,
    mutating: false
  },

  {
    toolName: PluginToolName.BD_EXPORT_JSONL,
    toolClass: 'plugin',
    owningFile: 'src/plugins/bd.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'tool_output_dir',
    deterministicCompaction: true,
    mutating: false
  },

  {
    toolName: PluginToolName.BD_IMPORT_JSONL,
    toolClass: 'plugin',
    owningFile: 'src/plugins/bd.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'none_minimal',
    deterministicCompaction: false,
    mutating: true
  },

  {
    toolName: PluginToolName.BD_CREATE,
    toolClass: 'plugin',
    owningFile: 'src/plugins/bd.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'none_minimal',
    deterministicCompaction: false,
    mutating: true
  },

  {
    toolName: PluginToolName.BD_GET_BEAD,
    toolClass: 'plugin',
    owningFile: 'src/plugins/bd.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'tool_calls_dir',
    deterministicCompaction: true,
    mutating: false
  },

  {
    toolName: PluginToolName.BD_GET_STATE_CHART,
    toolClass: 'plugin',
    owningFile: 'src/plugins/bd.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'tool_calls_dir',
    deterministicCompaction: true,
    mutating: false
  },

  {
    toolName: PluginToolName.BD_CLAIM,
    toolClass: 'plugin',
    owningFile: 'src/plugins/bd.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'none_minimal',
    deterministicCompaction: false,
    mutating: true
  },

  {
    toolName: PluginToolName.BD_RELEASE,
    toolClass: 'plugin',
    owningFile: 'src/plugins/bd.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'none_minimal',
    deterministicCompaction: false,
    mutating: true
  },

  {
    toolName: PluginToolName.BD_UPDATE_STATUS,
    toolClass: 'plugin',
    owningFile: 'src/plugins/bd.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'none_minimal',
    deterministicCompaction: false,
    mutating: true
  },

  {
    toolName: PluginToolName.BD_GET_HEARTBEATS,
    toolClass: 'plugin',
    owningFile: 'src/plugins/bd.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'tool_calls_dir',
    deterministicCompaction: true,
    mutating: false
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
    mutating: true
  },

  {
    toolName: PluginToolName.REMOVE_WORKTREE,
    toolClass: 'plugin',
    owningFile: 'src/plugins/git.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'none_minimal',
    deterministicCompaction: false,
    mutating: true
  },

  {
    toolName: PluginToolName.MERGE_AND_COMMIT,
    toolClass: 'plugin',
    owningFile: 'src/plugins/git.ts',
    schemaTypeName: 'MergeResult',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'tool_calls_dir',
    deterministicCompaction: true,
    mutating: true
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
    mutating: true
  },

  {
    toolName: PluginToolName.CHECK_MAILBOX,
    toolClass: 'plugin',
    owningFile: 'src/plugins/mailbox.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'tool_calls_dir',
    deterministicCompaction: true,
    mutating: false
  },

  {
    toolName: PluginToolName.FETCH_MAILBOX_MESSAGE,
    toolClass: 'plugin',
    owningFile: 'src/plugins/mailbox.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'tool_calls_dir',
    deterministicCompaction: true,
    mutating: false
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
    mutating: true
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
    mutating: true
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
    mutating: true
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
    mutating: true
  },

  {
    toolName: NativePiToolName.EDIT,
    toolClass: 'native_pi',
    owningFile: 'src/constants/index.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'none_minimal',
    deterministicCompaction: false,
    mutating: true
  },

  {
    toolName: NativePiToolName.FIND,
    toolClass: 'native_pi',
    owningFile: 'src/constants/index.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'tool_calls_dir',
    deterministicCompaction: false,
    mutating: false
  },

  {
    toolName: NativePiToolName.GREP,
    toolClass: 'native_pi',
    owningFile: 'src/constants/index.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'tool_calls_dir',
    deterministicCompaction: false,
    mutating: false
  },

  {
    toolName: NativePiToolName.LS,
    toolClass: 'native_pi',
    owningFile: 'src/constants/index.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'tool_calls_dir',
    deterministicCompaction: false,
    mutating: false
  },

  {
    toolName: NativePiToolName.MCP,
    toolClass: 'native_pi',
    owningFile: 'src/constants/index.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'tool_calls_dir',
    deterministicCompaction: false,
    mutating: true
  },

  {
    toolName: NativePiToolName.READ,
    toolClass: 'native_pi',
    owningFile: 'src/constants/index.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'tool_calls_dir',
    deterministicCompaction: false,
    mutating: false
  },

  {
    toolName: NativePiToolName.WRITE,
    toolClass: 'native_pi',
    owningFile: 'src/constants/index.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    rawOutputLocation: 'none_minimal',
    deterministicCompaction: false,
    mutating: true
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
  // NOTE: project-configured tools MAY use the compatibility envelope fields
  // (structuredResult/resultPreview/outputArchive) — those are not required
  // of other tool classes.
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
