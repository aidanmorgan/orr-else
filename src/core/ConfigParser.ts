/**
 * ConfigParser — YAML parsing and tsProjectTool shorthand expansion.
 *
 * Owns: yaml.parse(), expandTsProjectToolsInRaw().
 * Does NOT validate or normalize map collections.
 *
 * Extracted from ConfigLoader as part of pi-experiment-amq0.5 decomposition.
 * ConfigLoader remains the public facade; this class holds only the parsing concern.
 */
import * as path from 'path';
import * as yaml from 'yaml';
import { isRecord } from './RecordUtils.js';
import { type TsProjectToolDefaults } from './domain/StateModels.js';

export class ConfigParser {
  constructor(private readonly projectRoot: string) {}

  /**
   * Parse raw YAML content into a plain object.
   */
  public parse(fileContent: string): unknown {
    return yaml.parse(fileContent) || {};
  }

  /**
   * s3wp.10: Expand tsProjectTool shorthand entries in the raw parsed config.
   *
   * Run before merging with DEFAULTS and before schema validation, so the
   * merged config only ever contains type: command tools.
   *
   * Expansion:
   *   type: command
   *   command: node
   *   defaultArgs: ["--experimental-strip-types", <resolvedScriptPath>]
   *   argsMode: append          (unless explicitly set on the tool)
   *   allowArgs: true           (unless explicitly set on the tool)
   *   + any other per-tool fields are preserved unchanged
   *
   * Script path resolution (highest priority first):
   *   1. tool.scriptPath (explicit per-tool path)
   *   2. settings.tsProjectToolDefaults.scriptDir/<toolName>.ts
   *   3. .pi/project-tools/<toolName>.ts  (built-in default)
   *
   * Paths may contain {{projectRoot}} which is replaced with this.projectRoot.
   *
   * Per-tool argsMode/allowArgs/cwd/timeoutMs/wrapperTimeoutMs win over
   * tsProjectToolDefaults which win over the defaults above.
   */
  public expandTsProjectToolsInRaw(parsed: unknown): void {
    if (typeof parsed !== 'object' || parsed === null) return;
    const record = parsed as Record<string, unknown>;
    const toolsList = record['tools'];
    if (!Array.isArray(toolsList)) return;

    // Extract tsProjectToolDefaults from the raw parsed config (before DEFAULTS merge)
    const settingsRaw = isRecord(record['settings']) ? record['settings'] as Record<string, unknown> : {};
    const tsDefs = isRecord(settingsRaw['tsProjectToolDefaults'])
      ? settingsRaw['tsProjectToolDefaults'] as Partial<TsProjectToolDefaults>
      : undefined;
    const scriptDir = (tsDefs?.scriptDir as string | undefined) ?? '.pi/project-tools';

    const resolveTemplate = (val: string): string =>
      val.replace(/\{\{projectRoot\}\}/g, this.projectRoot);

    for (let i = 0; i < toolsList.length; i++) {
      const tool = toolsList[i];
      if (!isRecord(tool) || tool['type'] !== 'tsProjectTool') continue;

      const toolRecord = tool as Record<string, unknown>;
      const toolName = typeof toolRecord['name'] === 'string' ? toolRecord['name'] : `tool_${i}`;

      // Resolve script path
      let scriptPath: string;
      if (typeof toolRecord['scriptPath'] === 'string') {
        scriptPath = resolveTemplate(toolRecord['scriptPath'] as string);
      } else {
        // Default: <scriptDir>/<toolName>.ts  — keep as a relative path so
        // {{projectRoot}}-style template substitution is handled at runtime by
        // the executor; we emit the literal projectRoot path here.
        const resolvedDir = resolveTemplate(scriptDir);
        scriptPath = path.isAbsolute(resolvedDir)
          ? path.join(resolvedDir, `${toolName}.ts`)
          : path.join(this.projectRoot, resolvedDir, `${toolName}.ts`);
      }

      // Collect per-tool overrides (fields that survive the tsProjectTool → command transform)
      const {
        type: _typeDiscard,
        scriptPath: _scriptPathDiscard,
        name,
        description,
        usageNotes,
        failureLimit,
        optional,
        validationRules,
        profile,
        defaultArgs: perToolExtraArgs,
        argsMode,
        allowArgs,
        argumentPathScope,
        cwd,
        allowCwdOverride,
        timeoutMs,
        wrapperTimeoutMs,
        acceptMaxBuffer,
        successExitCodes,
        env,
        serialize,
        ...rest
      } = toolRecord;

      // Build expanded command tool
      const expanded: Record<string, unknown> = {
        name,
        type: 'command',
        command: 'node',
        // defaultArgs: [--experimental-strip-types, <scriptPath>, ...perToolExtraArgs]
        defaultArgs: [
          '--experimental-strip-types',
          scriptPath,
          ...(Array.isArray(perToolExtraArgs) ? (perToolExtraArgs as string[]) : [])
        ],
        // argsMode: per-tool → tsProjectToolDefaults → 'append'
        argsMode: argsMode ?? tsDefs?.argsMode ?? 'append',
        // allowArgs: per-tool → tsProjectToolDefaults → true
        allowArgs: allowArgs ?? tsDefs?.allowArgs ?? true,
      };

      // Apply remaining per-tool fields (only if defined)
      if (description !== undefined) expanded['description'] = description;
      if (usageNotes !== undefined) expanded['usageNotes'] = usageNotes;
      if (failureLimit !== undefined) expanded['failureLimit'] = failureLimit;
      if (optional !== undefined) expanded['optional'] = optional;
      if (validationRules !== undefined) expanded['validationRules'] = validationRules;
      if (profile !== undefined) expanded['profile'] = profile;
      if (argumentPathScope !== undefined) expanded['argumentPathScope'] = argumentPathScope;
      if (env !== undefined) expanded['env'] = env;
      if (allowCwdOverride !== undefined) expanded['allowCwdOverride'] = allowCwdOverride;
      if (acceptMaxBuffer !== undefined) expanded['acceptMaxBuffer'] = acceptMaxBuffer;
      if (successExitCodes !== undefined) expanded['successExitCodes'] = successExitCodes;
      // serialize survives the tsProjectTool → command transform so the expanded
      // command tool acquires the generic cross-process lock (s3wp/0yt5.23).
      if (serialize !== undefined) expanded['serialize'] = serialize;

      // cwd: per-tool → tsProjectToolDefaults
      const resolvedCwd = cwd ?? tsDefs?.cwd;
      if (resolvedCwd !== undefined) expanded['cwd'] = resolvedCwd;

      // timeoutMs: per-tool → tsProjectToolDefaults
      const resolvedTimeoutMs = timeoutMs ?? tsDefs?.timeoutMs;
      if (resolvedTimeoutMs !== undefined) expanded['timeoutMs'] = resolvedTimeoutMs;

      // wrapperTimeoutMs: per-tool → tsProjectToolDefaults
      const resolvedWrapperTimeoutMs = wrapperTimeoutMs ?? tsDefs?.wrapperTimeoutMs;
      if (resolvedWrapperTimeoutMs !== undefined) expanded['wrapperTimeoutMs'] = resolvedWrapperTimeoutMs;

      // Preserve any unrecognized fields (forward compatibility)
      for (const [k, v] of Object.entries(rest)) {
        expanded[k] = v;
      }

      toolsList[i] = expanded;
    }
  }
}
