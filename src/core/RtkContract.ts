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
 * The harness MAY add runtime-path injection, timeouts, telemetry, accounting,
 * and last-resort byte-budget caps.  It MUST NOT require every tool to return a
 * generic structure.
 *
 * INVENTORY COVERAGE
 * ------------------
 * Every model-call tool exposed by Orr Else is listed here:
 *   - Built-in control-plane tools  (BuiltInToolName)
 *   - Bundled runtime plugin tools  (PluginToolName)
 *   - Native Pi tools observed by policy (NativePiToolName)
 *   - Project-configured tools (config-driven; zero in the Cerdiwen harness)
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
 * How the tool minimises model-facing token cost for large raw outputs.
 *
 *   none                — output is inherently small; no strategy required
 *   byte_budget_cap     — harness enforces a hard byte budget before returning
 *   structured_preview  — returns a compact preview/counts envelope instead of raw
 *   archive_with_ref    — raw output archived; model receives an opaque artifactRef
 *   sampling            — representative samples returned; remainder archived
 *   pass_through        — raw output passed unchanged; caller/harness responsible
 */
export type RtkArchiveStrategy =
  | 'none'
  | 'byte_budget_cap'
  | 'structured_preview'
  | 'archive_with_ref'
  | 'sampling'
  | 'pass_through';

/**
 * Per-tool RTK contract entry.
 *
 * Fields
 * ------
 *   toolName          Tool name string as registered with Pi.
 *   toolClass         Category (see RtkToolClass).
 *   owningFile        Source file that defines/registers the tool (repo-relative).
 *   schemaTypeName    TypeScript type/interface name for the tool's return schema, or
 *                     'untyped_record' when the return is Record<string,unknown>.
 *   skillPath         Path to the SKILL.md that documents model-facing usage
 *                     (planned path prefix '.pi/skills/' when file not yet created).
 *   byteBudget        Approximate model-facing byte budget for the inline result.
 *                     0 = not applicable (tool returns an acknowledgement/signal,
 *                     not data). Negative values are not used.
 *   archiveStrategy   Token-minimisation approach for large outputs.
 *   mutating          Whether calling the tool causes a side-effect (writes to
 *                     git, beads, filesystem, tmux, …).
 */
export interface RtkContractEntry {
  readonly toolName: string;
  readonly toolClass: RtkToolClass;
  readonly owningFile: string;
  readonly schemaTypeName: string;
  readonly skillPath: string;
  readonly byteBudget: number;
  readonly archiveStrategy: RtkArchiveStrategy;
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
 *    'project_configured'; the Cerdiwen harness currently has zero.
 *  - No entry may demand a structuredResult/resultPreview/outputArchive return
 *    shape unless the tool is a project-configured command/mcp tool that already
 *    uses those compatibility fields.
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
    byteBudget: 512,
    archiveStrategy: 'none',
    mutating: false
  },

  {
    toolName: BuiltInToolName.TICK_ITEM,
    toolClass: 'built_in',
    owningFile: 'src/extension.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    byteBudget: 256,
    archiveStrategy: 'none',
    mutating: true
  },

  {
    toolName: BuiltInToolName.TICK_ITEMS,
    toolClass: 'built_in',
    owningFile: 'src/extension.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    byteBudget: 256,
    archiveStrategy: 'none',
    mutating: true
  },

  {
    toolName: BuiltInToolName.GET_OUTSTANDING_TASKS,
    toolClass: 'built_in',
    owningFile: 'src/extension.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    byteBudget: 4096,
    archiveStrategy: 'byte_budget_cap',
    mutating: false
  },

  {
    toolName: BuiltInToolName.ADD_CHECKLIST_ITEM,
    toolClass: 'built_in',
    owningFile: 'src/extension.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    byteBudget: 256,
    archiveStrategy: 'none',
    mutating: true
  },

  {
    toolName: BuiltInToolName.SUBMIT_CHECKPOINT,
    toolClass: 'built_in',
    owningFile: 'src/extension.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    byteBudget: 512,
    archiveStrategy: 'none',
    mutating: true
  },

  {
    toolName: BuiltInToolName.SUBMIT_REVIEW_ARTIFACT,
    toolClass: 'built_in',
    owningFile: 'src/extension.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/reviewer/SKILL.md',
    byteBudget: 256,
    archiveStrategy: 'none',
    mutating: true
  },

  {
    toolName: BuiltInToolName.SIGNAL_COMPLETION,
    toolClass: 'built_in',
    owningFile: 'src/extension.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    byteBudget: 256,
    archiveStrategy: 'none',
    mutating: true
  },

  {
    toolName: BuiltInToolName.REQUEST_CONTEXT_RESTART,
    toolClass: 'built_in',
    owningFile: 'src/extension.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    byteBudget: 256,
    archiveStrategy: 'none',
    mutating: true
  },

  {
    toolName: BuiltInToolName.REQUEST_HARNESS_RESTART,
    toolClass: 'built_in',
    owningFile: 'src/extension.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    byteBudget: 256,
    archiveStrategy: 'none',
    mutating: true
  },

  {
    toolName: BuiltInToolName.GET_ARTIFACT_PATHS,
    toolClass: 'built_in',
    owningFile: 'src/extension.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/artifact-evidence/SKILL.md',
    byteBudget: 2048,
    archiveStrategy: 'byte_budget_cap',
    mutating: false
  },

  {
    toolName: BuiltInToolName.QUERY_ARTIFACT,
    toolClass: 'built_in',
    owningFile: 'src/extension.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/artifact-evidence/SKILL.md',
    // ArtifactQueryDefaults.RESULT_MAX_BYTES = 8 KiB
    byteBudget: 8192,
    archiveStrategy: 'sampling',
    mutating: false
  },

  {
    toolName: BuiltInToolName.GET_COMPATIBILITY_CONTEXT,
    toolClass: 'built_in',
    owningFile: 'src/extension.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    byteBudget: 4096,
    archiveStrategy: 'byte_budget_cap',
    mutating: false
  },

  {
    toolName: BuiltInToolName.READ_PATH_CONTEXT,
    toolClass: 'built_in',
    owningFile: 'src/extension.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    // PathContextDefaults.MAX_SLICE_LINES * ~80 chars/line ≈ 32 KiB cap
    byteBudget: 32768,
    archiveStrategy: 'byte_budget_cap',
    mutating: false
  },

  {
    toolName: BuiltInToolName.HARNESS_STATUS,
    toolClass: 'built_in',
    owningFile: 'src/extension.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    byteBudget: 4096,
    archiveStrategy: 'structured_preview',
    mutating: false
  },

  {
    toolName: BuiltInToolName.PRE_SIGNAL_AUDIT,
    toolClass: 'built_in',
    owningFile: 'src/extension.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    byteBudget: 2048,
    archiveStrategy: 'structured_preview',
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
    byteBudget: 256,
    archiveStrategy: 'none',
    mutating: true
  },

  {
    toolName: PluginToolName.BD_READY,
    toolClass: 'plugin',
    owningFile: 'src/plugins/bd.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    // BeadsDefaults.INLINE_JSONL_EXPORT_PREVIEW_BYTES = 4 KiB per bead, N beads
    byteBudget: 8192,
    archiveStrategy: 'byte_budget_cap',
    mutating: false
  },

  {
    toolName: PluginToolName.BD_LIST,
    toolClass: 'plugin',
    owningFile: 'src/plugins/bd.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    byteBudget: 8192,
    archiveStrategy: 'byte_budget_cap',
    mutating: false
  },

  {
    toolName: PluginToolName.BD_EXPORT_JSONL,
    toolClass: 'plugin',
    owningFile: 'src/plugins/bd.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    // BeadsDefaults.INLINE_JSONL_EXPORT_PREVIEW_BYTES = 4 KiB preview
    byteBudget: 4096,
    archiveStrategy: 'structured_preview',
    mutating: false
  },

  {
    toolName: PluginToolName.BD_IMPORT_JSONL,
    toolClass: 'plugin',
    owningFile: 'src/plugins/bd.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    byteBudget: 512,
    archiveStrategy: 'none',
    mutating: true
  },

  {
    toolName: PluginToolName.BD_CREATE,
    toolClass: 'plugin',
    owningFile: 'src/plugins/bd.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    byteBudget: 512,
    archiveStrategy: 'none',
    mutating: true
  },

  {
    toolName: PluginToolName.BD_GET_BEAD,
    toolClass: 'plugin',
    owningFile: 'src/plugins/bd.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    byteBudget: 4096,
    archiveStrategy: 'byte_budget_cap',
    mutating: false
  },

  {
    toolName: PluginToolName.BD_GET_STATE_CHART,
    toolClass: 'plugin',
    owningFile: 'src/plugins/bd.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    // StateChartToolDefaults drives bounded projections
    byteBudget: 8192,
    archiveStrategy: 'structured_preview',
    mutating: false
  },

  {
    toolName: PluginToolName.BD_CLAIM,
    toolClass: 'plugin',
    owningFile: 'src/plugins/bd.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    byteBudget: 512,
    archiveStrategy: 'none',
    mutating: true
  },

  {
    toolName: PluginToolName.BD_RELEASE,
    toolClass: 'plugin',
    owningFile: 'src/plugins/bd.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    byteBudget: 256,
    archiveStrategy: 'none',
    mutating: true
  },

  {
    toolName: PluginToolName.BD_UPDATE_STATUS,
    toolClass: 'plugin',
    owningFile: 'src/plugins/bd.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    byteBudget: 256,
    archiveStrategy: 'none',
    mutating: true
  },

  {
    toolName: PluginToolName.BD_GET_HEARTBEATS,
    toolClass: 'plugin',
    owningFile: 'src/plugins/bd.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    byteBudget: 4096,
    archiveStrategy: 'byte_budget_cap',
    mutating: false
  },

  // -- Git plugin — src/plugins/git.ts --

  {
    toolName: PluginToolName.CREATE_WORKTREE,
    toolClass: 'plugin',
    owningFile: 'src/plugins/git.ts',
    schemaTypeName: 'WorktreeResult',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    byteBudget: 512,
    archiveStrategy: 'none',
    mutating: true
  },

  {
    toolName: PluginToolName.REMOVE_WORKTREE,
    toolClass: 'plugin',
    owningFile: 'src/plugins/git.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    byteBudget: 256,
    archiveStrategy: 'none',
    mutating: true
  },

  {
    toolName: PluginToolName.MERGE_AND_COMMIT,
    toolClass: 'plugin',
    owningFile: 'src/plugins/git.ts',
    schemaTypeName: 'MergeResult',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    byteBudget: 2048,
    archiveStrategy: 'none',
    mutating: true
  },

  // -- Mailbox plugin — src/plugins/mailbox.ts --

  {
    toolName: PluginToolName.SEND_MAILBOX_MESSAGE,
    toolClass: 'plugin',
    owningFile: 'src/plugins/mailbox.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    byteBudget: 256,
    archiveStrategy: 'none',
    mutating: true
  },

  {
    toolName: PluginToolName.CHECK_MAILBOX,
    toolClass: 'plugin',
    owningFile: 'src/plugins/mailbox.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    byteBudget: 4096,
    archiveStrategy: 'byte_budget_cap',
    mutating: false
  },

  // -- Quality plugin — src/plugins/quality.ts --

  {
    toolName: PluginToolName.RUN_QUALITY_CHECKS,
    toolClass: 'plugin',
    owningFile: 'src/plugins/quality.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    byteBudget: 8192,
    archiveStrategy: 'structured_preview',
    mutating: false
  },

  {
    toolName: PluginToolName.COMPRESS_SESSION_LOGS,
    toolClass: 'plugin',
    owningFile: 'src/plugins/quality.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    byteBudget: 512,
    archiveStrategy: 'none',
    mutating: true
  },

  // -- Teammates plugin — src/plugins/teammates.ts --

  {
    toolName: PluginToolName.SPAWN_TEAMMATE,
    toolClass: 'plugin',
    owningFile: 'src/plugins/teammates.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    byteBudget: 512,
    archiveStrategy: 'none',
    mutating: true
  },

  // -- Meta plugin — src/plugins/meta.ts --

  {
    toolName: PluginToolName.CREATE_NEW_PLUGIN,
    toolClass: 'plugin',
    owningFile: 'src/plugins/meta.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    byteBudget: 1024,
    archiveStrategy: 'none',
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
    // NativeReadPolicyDefaults.MAX_LIMIT_LINES * ~80 chars = 32 KiB ceiling
    byteBudget: 32768,
    archiveStrategy: 'pass_through',
    mutating: true
  },

  {
    toolName: NativePiToolName.EDIT,
    toolClass: 'native_pi',
    owningFile: 'src/constants/index.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    byteBudget: 512,
    archiveStrategy: 'none',
    mutating: true
  },

  {
    toolName: NativePiToolName.FIND,
    toolClass: 'native_pi',
    owningFile: 'src/constants/index.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    byteBudget: 8192,
    archiveStrategy: 'pass_through',
    mutating: false
  },

  {
    toolName: NativePiToolName.GREP,
    toolClass: 'native_pi',
    owningFile: 'src/constants/index.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    byteBudget: 8192,
    archiveStrategy: 'pass_through',
    mutating: false
  },

  {
    toolName: NativePiToolName.LS,
    toolClass: 'native_pi',
    owningFile: 'src/constants/index.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    byteBudget: 4096,
    archiveStrategy: 'pass_through',
    mutating: false
  },

  {
    toolName: NativePiToolName.MCP,
    toolClass: 'native_pi',
    owningFile: 'src/constants/index.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    byteBudget: 16384,
    archiveStrategy: 'pass_through',
    mutating: true
  },

  {
    toolName: NativePiToolName.READ,
    toolClass: 'native_pi',
    owningFile: 'src/constants/index.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    // NativeReadPolicyDefaults.MAX_LIMIT_LINES * ~80 chars = 32 KiB ceiling
    byteBudget: 32768,
    archiveStrategy: 'byte_budget_cap',
    mutating: false
  },

  {
    toolName: NativePiToolName.WRITE,
    toolClass: 'native_pi',
    owningFile: 'src/constants/index.ts',
    schemaTypeName: 'untyped_record',
    skillPath: '.pi/skills/tool-routing/SKILL.md',
    byteBudget: 256,
    archiveStrategy: 'none',
    mutating: true
  }

  // =========================================================================
  // PROJECT-CONFIGURED tools (config-driven; none in the Cerdiwen harness)
  // When the harness.yaml `tools:` section is populated, add entries here
  // following the pattern:
  //
  // {
  //   toolName: '<name from harness.yaml>',
  //   toolClass: 'project_configured',
  //   owningFile: 'harness.yaml',
  //   schemaTypeName: 'ModelFacingProjectToolResult',
  //   skillPath: '.pi/skills/tool-routing/SKILL.md',
  //   byteBudget: 4096,  // ProjectToolDefaults.INLINE_RESULT_BYTES
  //   archiveStrategy: 'archive_with_ref',  // outputArchive + artifactRef
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
