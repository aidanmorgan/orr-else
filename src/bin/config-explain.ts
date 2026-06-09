/**
 * orr-else config explain
 *
 * pi-experiment-vzp7: Static config admission + deterministic expansion for resolved v2 config.
 *
 * Runs static config admission/resolution ONLY via ConfigLoader.load().
 * Does NOT call V2SubstratePreflight, Supervisor, model providers, project tools,
 * project-tool readiness probes, or backend health checks.
 *
 * The resolved config is serialized as deterministic JSON (keys + collections sorted).
 * Prompt bodies are NEVER inlined — only path, byteCount, sha256, and actionId appear.
 *
 * Usage: orr-else config explain [--json] [--config <path>] [--cwd <dir>]
 *
 * Exit codes:
 *   0 — config admitted and expanded successfully.
 *   1 — config admission failed (same static diagnostic as startup validation).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { ConfigLoader } from '../core/ConfigLoader.js';
import { Logger } from '../core/Logger.js';
import { buildV2EventVocabulary } from '../core/FlowManager.js';
import {
  ALLOWLISTED_STATE_FIELDS,
  ALLOWLISTED_TOOL_FIELDS,
  NON_COMPRESSIBLE_STATE_FIELDS,
  NON_COMPRESSIBLE_TOOL_FIELDS,
} from '../core/domain/StateModels.js';
import type { HarnessConfig, RequiredTool } from '../core/domain/StateModels.js';

// ---------------------------------------------------------------------------
// Deterministic JSON serialisation
// ---------------------------------------------------------------------------

/**
 * Sort all object keys (recursively), and sort arrays of strings.
 * Arrays of non-string items are preserved in their resolved order
 * (already deterministic from ConfigLoader's sorted expansion).
 *
 * Guarantees byte-stable JSON output across repeated runs:
 * no map-iteration-order nondeterminism, no Date.now(), no Math.random().
 */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = (value as unknown[]).map(sortDeep);
    if (items.every(i => typeof i === 'string')) {
      return [...(items as string[])].sort();
    }
    return items;
  }
  if (value !== null && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(rec).sort()) {
      sorted[key] = sortDeep(rec[key]);
    }
    return sorted;
  }
  return value;
}

function deterministicJson(value: unknown): string {
  return JSON.stringify(sortDeep(value), null, 2);
}

// ---------------------------------------------------------------------------
// Config fingerprint (sha256 of raw config file bytes)
// ---------------------------------------------------------------------------

function computeConfigFingerprint(configPath: string): string {
  try {
    const content = fs.readFileSync(configPath);
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
  } catch {
    return '(unavailable)';
  }
}

// ---------------------------------------------------------------------------
// Verifier registration metadata (static — no tool execution)
// ---------------------------------------------------------------------------

/**
 * Collect tools that require a verify() callback, detectable statically.
 * Reports tools with `expectsVerify: true` in requiredTools across all states
 * and actions. This is metadata available without executing any tools.
 */
function requiresVerify(rt: RequiredTool): boolean {
  return typeof rt !== 'string' && rt.expectsVerify === true;
}

function rtName(rt: RequiredTool): string {
  return typeof rt === 'string' ? rt : rt.name;
}

function collectVerifierMetadata(config: HarnessConfig): Record<string, unknown>[] {
  const seen = new Map<string, { stateIds: string[]; actionIds: string[] }>();

  for (const [stateId, state] of Object.entries(config.states || {})) {
    for (const rt of state.requiredTools || []) {
      if (!requiresVerify(rt)) continue;
      const name = rtName(rt);
      if (!seen.has(name)) seen.set(name, { stateIds: [], actionIds: [] });
      seen.get(name)!.stateIds.push(stateId);
    }
    for (const action of state.actions || []) {
      for (const rt of action.requiredTools || []) {
        if (!requiresVerify(rt)) continue;
        const name = rtName(rt);
        if (!seen.has(name)) seen.set(name, { stateIds: [], actionIds: [] });
        seen.get(name)!.actionIds.push(`${stateId}/${action.id}`);
      }
    }
  }

  return [...seen.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([toolName, locs]) => ({
      toolName,
      expectsVerify: true,
      declaredInStates: [...locs.stateIds].sort(),
      declaredInActions: [...locs.actionIds].sort(),
    }));
}

// ---------------------------------------------------------------------------
// Allowed inherited source paths
// ---------------------------------------------------------------------------

function buildAllowedInheritedSourcePaths(): Record<string, unknown> {
  return {
    state: [...ALLOWLISTED_STATE_FIELDS].sort(),
    tool: [...ALLOWLISTED_TOOL_FIELDS].sort(),
    nonCompressible: {
      state: [...NON_COMPRESSIBLE_STATE_FIELDS].sort(),
      tool: [...NON_COMPRESSIBLE_TOOL_FIELDS].sort(),
    },
  };
}

// ---------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------

/**
 * Non-compressible route table: for each state, map declared event names to
 * target states. Sorted deterministically by state key then event key.
 */
function buildRouteTable(config: HarnessConfig): Record<string, Record<string, string>> {
  const table: Record<string, Record<string, string>> = {};
  for (const [stateId, state] of Object.entries(config.states || {}).sort(([a], [b]) => a.localeCompare(b))) {
    const transitions = state.transitions || {};
    const keys = Object.keys(transitions).sort();
    if (keys.length === 0) continue;
    const sorted: Record<string, string> = {};
    for (const k of keys) sorted[k] = transitions[k];
    table[stateId] = sorted;
  }
  return table;
}

// ---------------------------------------------------------------------------
// Route-event emitter mappings
// ---------------------------------------------------------------------------

/**
 * For each action that declares an `emits` mapping, collect its emitter contract.
 * Sorted by stateId then actionId for determinism.
 */
function buildRouteEmitters(config: HarnessConfig): Record<string, unknown>[] {
  const emitters: Record<string, unknown>[] = [];
  for (const [stateId, state] of Object.entries(config.states || {}).sort(([a], [b]) => a.localeCompare(b))) {
    for (const action of [...(state.actions || [])].sort((a, b) => a.id.localeCompare(b.id))) {
      const actionRec = action as unknown as Record<string, unknown>;
      const emits = actionRec['emits'];
      if (!emits || typeof emits !== 'object') continue;
      emitters.push({ stateId, actionId: action.id, emits });
    }
  }
  return emitters;
}

// ---------------------------------------------------------------------------
// Prompt metadata (digest present, body absent — AC4)
// ---------------------------------------------------------------------------

function extractPromptMetadata(config: HarnessConfig): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
  for (const [stateId, state] of Object.entries(config.states || {}).sort(([a], [b]) => a.localeCompare(b))) {
    for (const action of [...(state.actions || [])].sort((a, b) => a.id.localeCompare(b.id))) {
      const actionRec = action as unknown as Record<string, unknown>;
      const prov = actionRec['v2PromptProvenance'] as Record<string, unknown> | undefined;
      if (!prov) continue;
      results.push({
        stateId,
        actionId: action.id,
        normalizedPath: prov['normalizedPath'],
        byteCount: prov['byteCount'],
        sha256: prov['sha256'],
        // prompt body NOT included (AC4)
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Main explain logic
// ---------------------------------------------------------------------------

export interface ExplainOptions {
  json: boolean;
  configPath?: string;
  projectRoot: string;
}

export async function runConfigExplain(opts: ExplainOptions): Promise<void> {
  const { json: jsonMode, configPath, projectRoot } = opts;

  // Suppress info/warn logger output so --json stdout is clean JSON.
  // Admission errors are still surfaced via the caught exception below.
  Logger.configure('error');

  // Pass the global Logger so Logger.configure('error') above suppresses its
  // output — without this, ConfigLoader's default logger is a fresh instance
  // that does not inherit the 'error' level setting.
  const loader = new ConfigLoader(undefined, projectRoot, Logger);

  let config: HarnessConfig;
  try {
    // ConfigLoader.load() runs the full static admission + resolution pipeline:
    //   preValidateV2Admission → expandV2DefaultsAndProfiles →
    //   validateAndExpandV2ToolSets → validateV2MapCollections →
    //   normalizeV2MapCollections → expandTsProjectToolsInRaw →
    //   AJV schema validation → expandToolProfiles → resolveFileBackedFields →
    //   resolveV2LlmPromptProvenance
    //
    // NOT called: V2SubstratePreflight, Supervisor, model providers,
    //             project tools, backend health checks.
    config = loader.load(configPath);
  } catch (err) {
    // AC5: on admission failure, exit non-zero with static diagnostic.
    process.stderr.write(`orr-else config explain: config admission failed\n${String(err)}\n`);
    process.exit(1);
  }

  const resolvedConfigPath = loader.getConfigPath();
  const fingerprint = computeConfigFingerprint(resolvedConfigPath);

  // Resolved v2 event vocabulary (empty for v1 configs)
  const vocab = buildV2EventVocabulary(config);
  const resolvedVocabulary: Record<string, string[]> = {};
  for (const [eventName, category] of vocab) {
    if (!resolvedVocabulary[category]) resolvedVocabulary[category] = [];
    resolvedVocabulary[category].push(eventName);
  }
  for (const cat of Object.keys(resolvedVocabulary)) {
    resolvedVocabulary[cat].sort();
  }

  // Resolved states — actions include prompt metadata (digest only), no bodies
  const resolvedStates: Record<string, unknown> = {};
  for (const [stateId, state] of Object.entries(config.states || {}).sort(([a], [b]) => a.localeCompare(b))) {
    const actions = [...(state.actions || [])].sort((a, b) => a.id.localeCompare(b.id)).map(action => {
      const actionRec = action as unknown as Record<string, unknown>;
      const prov = actionRec['v2PromptProvenance'] as Record<string, unknown> | undefined;
      const summary: Record<string, unknown> = { id: action.id, type: action.type };
      if (action.tool !== undefined) summary['tool'] = action.tool;
      if (actionRec['emits'] !== undefined) summary['emits'] = actionRec['emits'];
      if (action.requiredTools !== undefined) summary['requiredTools'] = action.requiredTools;
      if (action.activeTools !== undefined) summary['activeTools'] = action.activeTools;
      if (prov) {
        // Digest present, body absent (AC4)
        summary['promptMetadata'] = {
          normalizedPath: prov['normalizedPath'],
          byteCount: prov['byteCount'],
          sha256: prov['sha256'],
        };
      }
      return summary;
    });

    const stateSummary: Record<string, unknown> = {
      id: stateId,
      transitions: state.transitions || {},
      actions,
    };
    if (state.requiredTools !== undefined) stateSummary['requiredTools'] = state.requiredTools;
    if (state.activeTools !== undefined) stateSummary['activeTools'] = state.activeTools;
    if (state.routeEvidence !== undefined) stateSummary['routeEvidence'] = state.routeEvidence;

    resolvedStates[stateId] = stateSummary;
  }

  // Resolved tools (sorted by name, all fields)
  const resolvedTools: Record<string, unknown> = {};
  for (const tool of [...(config.tools || [])].sort((a, b) => {
    const na = (a as unknown as Record<string, unknown>)['name'] as string ?? '';
    const nb = (b as unknown as Record<string, unknown>)['name'] as string ?? '';
    return na.localeCompare(nb);
  })) {
    const t = tool as unknown as Record<string, unknown>;
    const name = t['name'] as string;
    const toolSummary: Record<string, unknown> = {};
    for (const key of Object.keys(t).sort()) {
      toolSummary[key] = t[key];
    }
    resolvedTools[name] = toolSummary;
  }

  // Resolved gates (sorted by id)
  const resolvedGates: Record<string, unknown> = {};
  for (const gate of [...(config.validationGates || [])].sort((a, b) => a.id.localeCompare(b.id))) {
    resolvedGates[gate.id] = gate as unknown as Record<string, unknown>;
  }

  const output: Record<string, unknown> = {
    schemaId: 'harness.configExplain',
    schemaVersion: '1.0.0',
    configVersion: config.version ?? 1,
    configPath: resolvedConfigPath,
    configFingerprint: fingerprint,
    events: config.events ?? null,
    resolvedVocabulary: Object.keys(resolvedVocabulary).length > 0 ? resolvedVocabulary : null,
    statechart: config.statechart ?? null,
    states: resolvedStates,
    tools: resolvedTools,
    gates: resolvedGates,
    profiles: config.profiles ?? null,
    defaults: config.defaults ?? null,
    toolSets: config.toolSets ?? null,
    routeTable: buildRouteTable(config),
    routeEmitters: buildRouteEmitters(config),
    promptMetadata: extractPromptMetadata(config),
    allowedInheritedSourcePaths: buildAllowedInheritedSourcePaths(),
    verifierRegistrationMetadata: collectVerifierMetadata(config),
  };

  if (jsonMode) {
    process.stdout.write(deterministicJson(output) + '\n');
  } else {
    // Human-readable summary layered on top (not the stable contract)
    const stateIds = Object.keys(config.states || {}).sort();
    process.stdout.write(`orr-else config explain\n`);
    process.stdout.write(`  config:      ${resolvedConfigPath}\n`);
    process.stdout.write(`  version:     ${config.version ?? 1}\n`);
    process.stdout.write(`  fingerprint: ${fingerprint}\n`);
    process.stdout.write(`  states:      ${stateIds.join(', ')}\n`);
    if (config.events) {
      const evCount = Object.values(config.events).flat().length;
      process.stdout.write(`  events:      ${evCount} declared\n`);
    }
    process.stdout.write(`  tools:       ${(config.tools || []).length}\n`);
    process.stdout.write(`  gates:       ${(config.validationGates || []).length}\n`);
    process.stdout.write(`\nRun with --json for the stable deterministic output contract.\n`);
  }
}

// ---------------------------------------------------------------------------
// Commander command registration (called from init.ts)
// ---------------------------------------------------------------------------

import { Command } from 'commander';

export function registerConfigExplainCommand(program: Command): void {
  const configCmd = new Command('config')
    .description('Config admission and inspection commands');

  const explainCmd = new Command('explain')
    .description('Static config admission + deterministic expansion (no runtime preflight, no substrate checks)')
    .option('--json', 'Output stable deterministic JSON (the stable contract)', false)
    .option('--config <path>', 'Path to harness.yaml (default: harness.yaml in cwd or ORR_ELSE_CONFIG_PATH)')
    .option('--cwd <dir>', 'Project root directory (default: process.cwd())', process.cwd())
    .action(async (opts: { json: boolean; config?: string; cwd: string }) => {
      const projectRoot = path.resolve(opts.cwd);
      await runConfigExplain({
        json: opts.json,
        configPath: opts.config,
        projectRoot,
      });
    });

  configCmd.addCommand(explainCmd);
  program.addCommand(configCmd);
}
