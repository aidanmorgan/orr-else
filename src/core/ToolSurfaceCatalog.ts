/**
 * ToolSurfaceCatalog — single source of truth for every tool/command surface.
 *
 * pi-experiment-amq0.15
 *
 * PURPOSE
 * -------
 * Tool-surface ownership is spread across ToolRegistry, extension bootstrap
 * registration, wrapped/observed native tool handling, and project-tool
 * registration.  Required-tool admission, prompt surface, RTK inventory, and
 * Pi registration can drift because they are built from separate lists.
 *
 * This module introduces ONE ToolSurfaceCatalog created at composition time
 * and consumed by registration, prompt, admission, conformance, and startup
 * lint.  It is the ONLY place where the complete tool/command surface is
 * enumerated.
 *
 * SURFACE KINDS
 * -------------
 *   BUILTIN_TOOL     — hardcoded built-in tools registered via pi.registerTool()
 *   PLUGIN_TOOL      — bundled runtime plugin tools (bd, git, teammates, mailbox, meta, quality)
 *   PROJECT_TOOL     — config-driven tools from harness.yaml `tools:` section
 *                      (sub-kinds: COMMAND, MCP, EXTENSION non-observeOnly)
 *   NATIVE_PI_TOOL   — Pi's own built-in tools observed by harness policy
 *   EXTENSION_TOOL   — observeOnly extension tools (recorded, not enforced)
 *   COMMAND          — pi.registerCommand() surfaces (NOT model-callable tools)
 *
 * COMMAND vs MODEL-CALLABLE TOOL (pi-experiment-2xho)
 * -----------------------------------------------------
 * COMMAND entries CANNOT satisfy requiredTools or be activated via setActiveTools
 * unless a separate explicit tool descriptor also exists for the same name.
 * orr-else is a COMMAND surface only — it has no TOOL entry.
 *
 * NATIVE TOOL MATCHING
 * --------------------
 * Native extension tools (PROJECT_TOOL with type:extension) match by name PLUS
 * sourceInfo/provenance (not name only).  The catalog enforces that all non-
 * observeOnly extension tools have non-empty sourceInfo at startup.
 *
 * FAIL-CLOSED CHECKS (enforced by validateCatalog())
 * ---------------------------------------------------
 *   - Duplicate names (same kind)
 *   - Command/tool name collisions (a COMMAND name cannot appear as a TOOL name)
 *   - Missing sourceInfo for native extension tools (non-observeOnly)
 *   - Command names that also appear in requiredTools configs
 *   - Inventory mismatch between catalog and Pi getAllTools/getActiveTools
 */

import type { HarnessConfig } from './ConfigLoader.js';
import { BuiltInToolName, PluginToolName, ProjectToolType } from '../constants/domain.js';
import { DEFAULT_OBSERVED_PI_TOOLS, NativePiToolName } from '../constants/infra.js';
import type { ProjectToolConfig } from './domain/StateModels.js';

// ---------------------------------------------------------------------------
// Surface kind
// ---------------------------------------------------------------------------

/**
 * Which kind of surface this entry represents.
 *
 *   BUILTIN_TOOL    — pi.registerTool(), hardcoded in extension.ts
 *   PLUGIN_TOOL     — bundled runtime plugin (bd, git, etc.)
 *   PROJECT_TOOL    — config.tools entry with type COMMAND or MCP
 *   EXTENSION_TOOL  — config.tools entry with type EXTENSION (non-observeOnly)
 *   NATIVE_PI_TOOL  — Pi's own built-in tools observed by harness policy
 *   OBSERVE_ONLY    — observeOnly:true extension tools (recorded, not enforced)
 *   COMMAND         — pi.registerCommand() surface (NOT a model-callable tool)
 */
export type ToolSurfaceKind =
  | 'BUILTIN_TOOL'
  | 'PLUGIN_TOOL'
  | 'PROJECT_TOOL'
  | 'EXTENSION_TOOL'
  | 'NATIVE_PI_TOOL'
  | 'OBSERVE_ONLY'
  | 'COMMAND';

// ---------------------------------------------------------------------------
// Catalog entry
// ---------------------------------------------------------------------------

/**
 * A single entry in the ToolSurfaceCatalog.
 *
 * Fields
 * ------
 *   name             — the tool/command name as registered with Pi.
 *   kind             — surface kind (see ToolSurfaceKind).
 *   owner            — which module/plugin owns this entry.
 *   sourceInfo       — provenance string (non-empty for EXTENSION_TOOL; empty otherwise).
 *   callable         — whether the tool is callable as a model-facing tool.
 *                      Always false for COMMAND entries.
 *   admissibleForRequiredTools — whether this surface can appear in state.requiredTools.
 *                      COMMAND and OBSERVE_ONLY entries cannot.
 *   hidden           — whether the tool is hidden from the model's tool list.
 *   deprecated       — whether the tool is deprecated.
 *   observeOnly      — true only for OBSERVE_ONLY entries.
 *   rtkToolClass     — the RtkContract toolClass for this surface, or undefined.
 *   promptSnippet    — optional: if this tool adds text to the system prompt.
 *   sideEffectContract — 'mutating' | 'read_only' | 'unknown'.
 *   configEntry      — raw config entry for PROJECT_TOOL/EXTENSION_TOOL/OBSERVE_ONLY.
 */
export interface ToolSurfaceEntry {
  readonly name: string;
  readonly kind: ToolSurfaceKind;
  readonly owner: string;
  readonly sourceInfo: string;
  readonly callable: boolean;
  readonly admissibleForRequiredTools: boolean;
  readonly hidden: boolean;
  readonly deprecated: boolean;
  readonly observeOnly: boolean;
  readonly rtkToolClass: 'built_in' | 'plugin' | 'native_pi' | 'project_configured' | undefined;
  readonly sideEffectContract: 'mutating' | 'read_only' | 'unknown';
  readonly configEntry: ProjectToolConfig | undefined;
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/**
 * Violation detected during catalog validation.
 */
export interface CatalogViolation {
  readonly kind: 'DUPLICATE_NAME' | 'COMMAND_TOOL_COLLISION' | 'MISSING_SOURCE_INFO' | 'COMMAND_IN_REQUIRED_TOOLS';
  readonly name: string;
  readonly message: string;
}

/**
 * The ToolSurfaceCatalog: a read-only enumeration of all tool and command
 * surfaces, with derived views for each consumer site.
 */
export class ToolSurfaceCatalog {
  private readonly _entries: ReadonlyArray<ToolSurfaceEntry>;
  private readonly _byName: ReadonlyMap<string, ToolSurfaceEntry>;
  private readonly _toolNames: ReadonlySet<string>;
  private readonly _commandNames: ReadonlySet<string>;
  /** Names from settings.pi.tools (model-callable Pi tools), preserved as-is for setActiveTools + prompt. */
  private readonly _configuredPiToolNames: ReadonlyArray<string>;

  constructor(entries: readonly ToolSurfaceEntry[], configuredPiToolNames: readonly string[] = []) {
    this._entries = entries;
    this._byName = new Map(entries.map(e => [e.name, e]));
    this._toolNames = new Set(
      entries.filter(e => e.kind !== 'COMMAND').map(e => e.name)
    );
    this._commandNames = new Set(
      entries.filter(e => e.kind === 'COMMAND').map(e => e.name)
    );
    this._configuredPiToolNames = configuredPiToolNames;
  }

  /** All entries (tools + commands). */
  get entries(): ReadonlyArray<ToolSurfaceEntry> { return this._entries; }

  /** Look up an entry by name. Returns undefined if not found. */
  get(name: string): ToolSurfaceEntry | undefined { return this._byName.get(name); }

  /** All tool entries (non-COMMAND). */
  getToolEntries(): ReadonlyArray<ToolSurfaceEntry> {
    return this._entries.filter(e => e.kind !== 'COMMAND');
  }

  /** All COMMAND entries (not model-callable). */
  getCommandEntries(): ReadonlyArray<ToolSurfaceEntry> {
    return this._entries.filter(e => e.kind === 'COMMAND');
  }

  // ── Consumer-facing derived views ────────────────────────────────────────

  /**
   * Returns all tool names that the harness wraps (BUILTIN_TOOL + PLUGIN_TOOL +
   * PROJECT_TOOL).  Used to filter native Pi tool observers so a native tool that
   * is also a harness-wrapped tool is not double-observed.
   *
   * Replaces: the ad-hoc `wrappedToolNames` Set built in extension.ts SESSION_START.
   */
  getWrappedToolNames(): ReadonlySet<string> {
    return new Set(
      this._entries
        .filter(e => e.kind === 'BUILTIN_TOOL' || e.kind === 'PLUGIN_TOOL' || e.kind === 'PROJECT_TOOL')
        .map(e => e.name)
    );
  }

  /**
   * Returns native Pi tool names that should be OBSERVED (but not wrapped).
   * These are NATIVE_PI_TOOL + EXTENSION_TOOL + OBSERVE_ONLY entries that are NOT
   * in the wrapped set.
   *
   * Replaces: the ad-hoc set built from getObservedPiToolNames + getNativePiExtensionProjectToolNames
   * filtered by wrappedToolNames.
   */
  getObservedPiToolNames(): ReadonlySet<string> {
    const wrapped = this.getWrappedToolNames();
    return new Set(
      this._entries
        .filter(e =>
          (e.kind === 'NATIVE_PI_TOOL' || e.kind === 'EXTENSION_TOOL' || e.kind === 'OBSERVE_ONLY')
          && !wrapped.has(e.name)
        )
        .map(e => e.name)
    );
  }

  /**
   * Returns harness-registered project tool names (PROJECT_TOOL only — not EXTENSION_TOOL).
   * These are registered via pi.registerTool() by the harness, not by Pi extensions.
   *
   * Replaces: getHarnessRegisteredProjectToolNames(config).
   */
  getHarnessRegisteredProjectToolNames(): ReadonlyArray<string> {
    return this._entries
      .filter(e => e.kind === 'PROJECT_TOOL')
      .map(e => e.name);
  }

  /**
   * Returns all configured project tool names (PROJECT_TOOL + EXTENSION_TOOL + OBSERVE_ONLY).
   * Used to build the setActiveTools call.
   *
   * Replaces: getConfiguredProjectToolNames(config).
   */
  getConfiguredProjectToolNames(): ReadonlyArray<string> {
    return this._entries
      .filter(e => e.kind === 'PROJECT_TOOL' || e.kind === 'EXTENSION_TOOL' || e.kind === 'OBSERVE_ONLY')
      .map(e => e.name);
  }

  /**
   * Returns native Pi extension tool names from config (non-observeOnly EXTENSION_TOOL entries).
   * Used to add these to observedPiTools so they are observed rather than wrapped.
   *
   * Replaces: getNativePiExtensionProjectToolNames(config).
   */
  getNativePiExtensionProjectToolNames(): ReadonlyArray<string> {
    return this._entries
      .filter(e => e.kind === 'EXTENSION_TOOL')
      .map(e => e.name);
  }

  /**
   * Returns model-callable Pi tool names from settings.pi.tools.
   * Used for setActiveTools and prompt tool names.
   *
   * Replaces: getConfiguredPiToolNames(config) — exact list from config.settings.pi.tools.
   * Preserved separately because some settings.pi.tools names may overlap with
   * DEFAULT_OBSERVED_PI_TOOLS and we want the original ordered set, not a filtered view.
   */
  getConfiguredPiToolNames(): ReadonlyArray<string> {
    return this._configuredPiToolNames;
  }

  /**
   * Returns all tool names that are admissible in requiredTools declarations.
   * COMMAND and OBSERVE_ONLY entries are excluded.
   *
   * Used by requiredTool lint to detect invalid tool names in config.
   */
  getAdmissibleRequiredToolNames(): ReadonlySet<string> {
    return new Set(
      this._entries
        .filter(e => e.admissibleForRequiredTools)
        .map(e => e.name)
    );
  }

  /**
   * Returns all names of COMMAND entries (pi.registerCommand surfaces).
   * Used to detect and reject command names appearing in requiredTools.
   */
  getCommandNames(): ReadonlySet<string> { return this._commandNames; }

  /**
   * Returns all callable model-tool names (all non-COMMAND, non-OBSERVE_ONLY entries).
   */
  getCallableToolNames(): ReadonlySet<string> {
    return new Set(
      this._entries
        .filter(e => e.callable)
        .map(e => e.name)
    );
  }

  /**
   * Returns a fingerprint string over all tool/command names sorted alphabetically.
   * Used for startup fingerprinting — any change to the catalog surface changes this string.
   */
  computeSurfaceFingerprint(): string {
    const names = this._entries.map(e => `${e.kind}:${e.name}`).sort().join('|');
    return names;
  }

  // ── Validation ────────────────────────────────────────────────────────────

  /**
   * Validate the catalog and return violations.
   *
   * Checks:
   *  1. No duplicate tool names within the tool set (non-COMMAND entries).
   *  2. No duplicate command names within the command set.
   *  3. No name appears as both a COMMAND and a non-COMMAND (collision).
   *  4. All non-observeOnly EXTENSION_TOOL entries have non-empty sourceInfo.
   */
  validate(): ReadonlyArray<CatalogViolation> {
    const violations: CatalogViolation[] = [];

    // 1. Duplicate tool names
    const toolNamesSeen = new Map<string, number>();
    for (const e of this._entries.filter(e => e.kind !== 'COMMAND')) {
      toolNamesSeen.set(e.name, (toolNamesSeen.get(e.name) || 0) + 1);
    }
    for (const [name, count] of toolNamesSeen) {
      if (count > 1) {
        violations.push({
          kind: 'DUPLICATE_NAME',
          name,
          message: `Duplicate tool name "${name}" appears ${count} times in ToolSurfaceCatalog.`
        });
      }
    }

    // 2. Duplicate command names
    const cmdNamesSeen = new Map<string, number>();
    for (const e of this._entries.filter(e => e.kind === 'COMMAND')) {
      cmdNamesSeen.set(e.name, (cmdNamesSeen.get(e.name) || 0) + 1);
    }
    for (const [name, count] of cmdNamesSeen) {
      if (count > 1) {
        violations.push({
          kind: 'DUPLICATE_NAME',
          name,
          message: `Duplicate command name "${name}" appears ${count} times in ToolSurfaceCatalog.`
        });
      }
    }

    // 3. Command/tool name collision
    for (const cmdName of this._commandNames) {
      if (this._toolNames.has(cmdName)) {
        violations.push({
          kind: 'COMMAND_TOOL_COLLISION',
          name: cmdName,
          message: `"${cmdName}" is registered as both a COMMAND and a model-callable TOOL. ` +
            `Commands cannot also be tools — use distinct names.`
        });
      }
    }

    // 4. Missing sourceInfo for non-observeOnly EXTENSION_TOOL entries
    for (const e of this._entries.filter(e => e.kind === 'EXTENSION_TOOL' && !e.observeOnly)) {
      if (!e.sourceInfo) {
        violations.push({
          kind: 'MISSING_SOURCE_INFO',
          name: e.name,
          message: `Extension tool "${e.name}" is non-observeOnly but has no sourceInfo/provenance. ` +
            `Set provenance on the Pi host getAllTools inventory entry.`
        });
      }
    }

    return violations;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the ToolSurfaceCatalog from the current config.
 *
 * Called at SESSION_START composition time with the loaded config so that
 * all consumer sites (registration, prompt, admission, RTK, conformance,
 * startup fingerprint) read from the SAME catalog instance.
 *
 * Parameters
 * ----------
 * @param config         Loaded HarnessConfig (post-validation).
 * @param piToolNames    Names from settings.pi.tools (model-callable Pi tools).
 * @param observedPiTools Extra observed Pi tool names (settings.pi.observedTools + defaults).
 */
export function buildToolSurfaceCatalog(
  config: HarnessConfig,
  piToolNames: readonly string[],
  observedPiTools: readonly string[]
): ToolSurfaceCatalog {
  const entries: ToolSurfaceEntry[] = [];

  // ── 1. COMMAND entries ───────────────────────────────────────────────────
  // Only one command surface: orr-else (/orr-else).
  // This is the ONLY COMMAND entry. It is NOT a model-callable tool.
  entries.push({
    name: BuiltInToolName.ORR_ELSE,
    kind: 'COMMAND',
    owner: 'src/extension.ts',
    sourceInfo: '',
    callable: false,
    admissibleForRequiredTools: false,
    hidden: false,
    deprecated: false,
    observeOnly: false,
    rtkToolClass: undefined,
    sideEffectContract: 'read_only',
    configEntry: undefined,
  });

  // ── 2. BUILTIN_TOOL entries ──────────────────────────────────────────────
  // All BuiltInToolName values EXCEPT ORR_ELSE (which is a COMMAND above).
  const builtInTools: Array<{ name: BuiltInToolName; mutating: boolean }> = [
    { name: BuiltInToolName.TICK_ITEMS, mutating: true },
    { name: BuiltInToolName.GET_OUTSTANDING_TASKS, mutating: false },
    { name: BuiltInToolName.ADD_CHECKLIST_ITEM, mutating: true },
    { name: BuiltInToolName.SUBMIT_CHECKPOINT, mutating: true },
    { name: BuiltInToolName.SUBMIT_REVIEW_ARTIFACT, mutating: true },
    { name: BuiltInToolName.SUBMIT_ACTION_EVIDENCE, mutating: true },
    { name: BuiltInToolName.SIGNAL_COMPLETION, mutating: true },
    { name: BuiltInToolName.REQUEST_CONTEXT_RESTART, mutating: true },
    { name: BuiltInToolName.REQUEST_HARNESS_RESTART, mutating: true },
    { name: BuiltInToolName.GET_ARTIFACT_PATHS, mutating: false },
    { name: BuiltInToolName.QUERY_ARTIFACT, mutating: false },
    { name: BuiltInToolName.READ_PATH_CONTEXT, mutating: false },
    { name: BuiltInToolName.HARNESS_STATUS, mutating: false },
    { name: BuiltInToolName.PRE_SIGNAL_AUDIT, mutating: false },
    { name: BuiltInToolName.QUERY_HARNESS_EVENTS, mutating: false },
    { name: BuiltInToolName.QUERY_TOOL_OUTPUT, mutating: false },
    { name: BuiltInToolName.QUERY_HARNESS_LOGS, mutating: false },
    { name: BuiltInToolName.QUERY_TMUX_TRANSCRIPTS, mutating: false },
    { name: BuiltInToolName.QUERY_OTEL_SPANS, mutating: false },
  ];

  for (const { name, mutating } of builtInTools) {
    entries.push({
      name,
      kind: 'BUILTIN_TOOL',
      owner: 'src/extension.ts',
      sourceInfo: '',
      callable: true,
      admissibleForRequiredTools: true,
      hidden: false,
      deprecated: false,
      observeOnly: false,
      rtkToolClass: 'built_in',
      sideEffectContract: mutating ? 'mutating' : 'read_only',
      configEntry: undefined,
    });
  }

  // ── 3. PLUGIN_TOOL entries ───────────────────────────────────────────────
  const pluginTools: Array<{ name: PluginToolName; owner: string; mutating: boolean }> = [
    // Beads plugin
    { name: PluginToolName.BD_HEARTBEAT, owner: 'src/plugins/bd.ts', mutating: true },
    { name: PluginToolName.BD_READY, owner: 'src/plugins/bd.ts', mutating: false },
    { name: PluginToolName.BD_LIST, owner: 'src/plugins/bd.ts', mutating: false },
    { name: PluginToolName.BD_EXPORT_JSONL, owner: 'src/plugins/bd.ts', mutating: false },
    { name: PluginToolName.BD_IMPORT_JSONL, owner: 'src/plugins/bd.ts', mutating: true },
    { name: PluginToolName.BD_CREATE, owner: 'src/plugins/bd.ts', mutating: true },
    { name: PluginToolName.BD_GET_BEAD, owner: 'src/plugins/bd.ts', mutating: false },
    { name: PluginToolName.BD_GET_STATE_CHART, owner: 'src/plugins/bd.ts', mutating: false },
    { name: PluginToolName.BD_CLAIM, owner: 'src/plugins/bd.ts', mutating: true },
    { name: PluginToolName.BD_RELEASE, owner: 'src/plugins/bd.ts', mutating: true },
    { name: PluginToolName.BD_UPDATE_STATUS, owner: 'src/plugins/bd.ts', mutating: true },
    { name: PluginToolName.BD_GET_HEARTBEATS, owner: 'src/plugins/bd.ts', mutating: false },
    // Git plugin
    { name: PluginToolName.CREATE_WORKTREE, owner: 'src/plugins/git.ts', mutating: true },
    { name: PluginToolName.REMOVE_WORKTREE, owner: 'src/plugins/git.ts', mutating: true },
    { name: PluginToolName.MERGE_AND_COMMIT, owner: 'src/plugins/git.ts', mutating: true },
    // Mailbox plugin
    { name: PluginToolName.SEND_MAILBOX_MESSAGE, owner: 'src/plugins/mailbox.ts', mutating: true },
    { name: PluginToolName.CHECK_MAILBOX, owner: 'src/plugins/mailbox.ts', mutating: false },
    { name: PluginToolName.FETCH_MAILBOX_MESSAGE, owner: 'src/plugins/mailbox.ts', mutating: false },
    // Teammates plugin
    { name: PluginToolName.SPAWN_TEAMMATE, owner: 'src/plugins/teammates.ts', mutating: true },
    // Quality plugin
    { name: PluginToolName.COMPRESS_SESSION_LOGS, owner: 'src/plugins/quality.ts', mutating: false },
    // Meta plugin
    { name: PluginToolName.CREATE_NEW_PLUGIN, owner: 'src/plugins/meta.ts', mutating: true },
  ];

  for (const { name, owner, mutating } of pluginTools) {
    entries.push({
      name,
      kind: 'PLUGIN_TOOL',
      owner,
      sourceInfo: '',
      callable: true,
      admissibleForRequiredTools: false, // plugin tools cannot be in requiredTools
      hidden: false,
      deprecated: false,
      observeOnly: false,
      rtkToolClass: 'plugin',
      sideEffectContract: mutating ? 'mutating' : 'read_only',
      configEntry: undefined,
    });
  }

  // ── 4. NATIVE_PI_TOOL entries from DEFAULT_OBSERVED_PI_TOOLS ─────────────
  const defaultObservedSet = new Set<string>(DEFAULT_OBSERVED_PI_TOOLS);
  for (const name of DEFAULT_OBSERVED_PI_TOOLS) {
    entries.push({
      name,
      kind: 'NATIVE_PI_TOOL',
      owner: 'pi-host',
      sourceInfo: 'pi-native',
      callable: true,
      admissibleForRequiredTools: true,
      hidden: false,
      deprecated: false,
      observeOnly: false,
      rtkToolClass: 'native_pi',
      sideEffectContract: name === NativePiToolName.BASH || name === NativePiToolName.EDIT || name === NativePiToolName.WRITE ? 'mutating' : 'read_only',
      configEntry: undefined,
    });
  }

  // ── 5. NATIVE_PI_TOOL entries from settings.pi.tools ─────────────────────
  // These are additional Pi tools configured by the project (not in the default set).
  for (const name of piToolNames) {
    if (defaultObservedSet.has(name)) continue; // already added above
    entries.push({
      name,
      kind: 'NATIVE_PI_TOOL',
      owner: 'settings.pi.tools',
      sourceInfo: 'pi-native',
      callable: true,
      admissibleForRequiredTools: true,
      hidden: false,
      deprecated: false,
      observeOnly: false,
      rtkToolClass: 'native_pi',
      sideEffectContract: 'unknown',
      configEntry: undefined,
    });
  }

  // ── 6. NATIVE_PI_TOOL entries from settings.pi.observedTools ─────────────
  // Extra observed tools that are not in pi.tools nor the default set.
  const piToolNamesSet = new Set(piToolNames);
  for (const name of observedPiTools) {
    if (defaultObservedSet.has(name)) continue;
    if (piToolNamesSet.has(name)) continue;
    entries.push({
      name,
      kind: 'NATIVE_PI_TOOL',
      owner: 'settings.pi.observedTools',
      sourceInfo: 'pi-native',
      callable: true,
      admissibleForRequiredTools: true,
      hidden: false,
      deprecated: false,
      observeOnly: false,
      rtkToolClass: 'native_pi',
      sideEffectContract: 'unknown',
      configEntry: undefined,
    });
  }

  // ── 7. PROJECT_TOOL, EXTENSION_TOOL, and OBSERVE_ONLY entries from config ──
  for (const tool of config.tools || []) {
    if (tool.type === ProjectToolType.EXTENSION) {
      const isObserveOnly = !!(tool as { observeOnly?: boolean }).observeOnly;
      entries.push({
        name: tool.name,
        kind: isObserveOnly ? 'OBSERVE_ONLY' : 'EXTENSION_TOOL',
        owner: 'harness.yaml',
        sourceInfo: '', // sourceInfo is resolved from Pi host getAllTools at runtime
        callable: !isObserveOnly,
        admissibleForRequiredTools: !isObserveOnly,
        hidden: false,
        deprecated: false,
        observeOnly: isObserveOnly,
        rtkToolClass: 'project_configured',
        sideEffectContract: 'unknown',
        configEntry: tool,
      });
    } else {
      // COMMAND or MCP type — harness-registered project tools
      entries.push({
        name: tool.name,
        kind: 'PROJECT_TOOL',
        owner: 'harness.yaml',
        sourceInfo: '',
        callable: true,
        admissibleForRequiredTools: true,
        hidden: false,
        deprecated: false,
        observeOnly: false,
        rtkToolClass: 'project_configured',
        sideEffectContract: 'unknown',
        configEntry: tool,
      });
    }
  }

  return new ToolSurfaceCatalog(entries, Array.from(piToolNames));
}

// ---------------------------------------------------------------------------
// Startup validation helper
// ---------------------------------------------------------------------------

/**
 * Validate the catalog and throw on any violation.
 *
 * Called at SESSION_START startup (fail-closed).  Each violation becomes an
 * error message; if any violations exist, throws with all messages combined.
 *
 * This is the STARTUP LINT for:
 *   - Duplicate names
 *   - Command/tool collisions
 *   - Missing sourceInfo for native tools
 */
export function assertCatalogValid(catalog: ToolSurfaceCatalog): void {
  const violations = catalog.validate();
  if (violations.length > 0) {
    const messages = violations.map(v => v.message).join('\n');
    throw new Error(
      `ToolSurfaceCatalog startup validation failed (${violations.length} violation(s)):\n${messages}`
    );
  }
}

/**
 * Check that a requiredTools list contains no COMMAND names.
 *
 * Commands cannot satisfy requiredTools.  This check is applied per-state
 * and per-action by the requiredTool lint (validateRequiredToolVerifiers).
 *
 * Returns violation messages (empty if none).
 */
export function checkRequiredToolsForCommandCollisions(
  requiredToolNames: readonly string[],
  catalog: ToolSurfaceCatalog,
  location: string
): string[] {
  const commandNames = catalog.getCommandNames();
  const violations: string[] = [];
  for (const name of requiredToolNames) {
    if (commandNames.has(name)) {
      violations.push(
        `${location} references requiredTool "${name}" which is a COMMAND surface (pi.registerCommand), ` +
        `not a model-callable tool. Commands cannot satisfy requiredTools.`
      );
    }
  }
  return violations;
}
