/**
 * ConfigReferenceResolver — file-backed field resolution, tool profile expansion,
 * and v2 LLM prompt provenance recording.
 *
 * Owns: expandToolProfiles(), resolveFileBackedFields(), resolveV2LlmPromptProvenance(),
 * and private helpers resolveConfigPath(), resolveTextReference(), resolveChecklistReference().
 *
 * Extracted from ConfigLoader as part of pi-experiment-amq0.5 decomposition.
 * ConfigLoader remains the public facade; this class holds only the reference-resolution concern.
 */
import { createHash } from 'node:crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import {
  HarnessConfig,
  ToolProfileConfig,
  ProjectCommandToolConfig,
  V2PromptFileProvenance
} from './domain/StateModels.js';
import { ChecklistItem } from './ProtocolParser.js';
import { resolveProjectFrom } from './Paths.js';
import { isRecord } from './RecordUtils.js';

export class ConfigReferenceResolver {
  constructor(private readonly projectRoot: string) {}

  public resolveV2LlmPromptProvenance(config: HarnessConfig): void {
    if (config.version !== 2) return;

    for (const [, state] of Object.entries(config.states || {})) {
      for (const action of state.actions || []) {
        const actionRecord = action as unknown as Record<string, unknown>;
        const llmRaw = actionRecord['llm'];
        if (!isRecord(llmRaw)) continue;

        const llm = llmRaw as Record<string, unknown>;
        const promptFile = llm['promptFile'];
        if (typeof promptFile !== 'string' || !promptFile.trim()) continue;

        // Resolve to absolute path within projectRoot (already validated safe).
        const resolved = path.resolve(this.projectRoot, promptFile);

        // Compute normalized project-relative path (canonical form).
        let realRoot: string;
        try {
          realRoot = fs.realpathSync(this.projectRoot);
        } catch {
          realRoot = path.resolve(this.projectRoot);
        }
        const realResolved = fs.realpathSync(resolved);
        const normalizedPath = path.relative(realRoot, realResolved);

        // Read file contents to compute digest + byte count. Body is NOT stored.
        const contents = fs.readFileSync(resolved);
        const byteCount = contents.length;
        const sha256 = createHash('sha256').update(contents).digest('hex');

        const provenance: V2PromptFileProvenance = {
          normalizedPath,
          byteCount,
          sha256,
          actionId: action.id
        };

        // Store provenance on the action (AC3). Body is never stored (AC4).
        (action as unknown as Record<string, unknown>)['v2PromptProvenance'] = provenance;
      }
    }
  }

  public expandToolProfiles(config: HarnessConfig): void {
    const toolDefaults = config.settings.toolDefaults;
    const toolProfiles = config.settings.toolProfiles;

    const PROFILE_SCALAR_KEYS: Array<keyof ToolProfileConfig> = [
      'cwd', 'allowCwdOverride', 'timeoutMs', 'wrapperTimeoutMs',
      'argsMode', 'allowArgs', 'acceptMaxBuffer'
    ];

    for (const tool of config.tools || []) {
      if (tool.type !== 'command') continue;
      const cmdTool = tool as ProjectCommandToolConfig;

      // Resolve profile (if any)
      let profile: ToolProfileConfig | undefined;
      if (cmdTool.profile) {
        if (toolProfiles && cmdTool.profile in toolProfiles) {
          profile = toolProfiles[cmdTool.profile];
        } else {
          const available = toolProfiles ? Object.keys(toolProfiles).sort().join(', ') || '(none)' : '(none)';
          throw new Error(
            `Tool "${cmdTool.name}" references profile "${cmdTool.profile}" which is not defined in settings.toolProfiles. ` +
            `Available profiles: ${available}. ` +
            `Define the profile in settings.toolProfiles or remove the profile reference from the tool.`
          );
        }
      }

      // If no defaults or profile, and no profile reference, skip to avoid unnecessary iteration
      if (!toolDefaults && !profile) continue;

      // Merge scalar fields: default → profile → per-tool (per-tool wins when defined)
      for (const key of PROFILE_SCALAR_KEYS) {
        if (cmdTool[key] === undefined) {
          if (profile?.[key] !== undefined) {
            (cmdTool as unknown as Record<string, unknown>)[key] = profile[key];
          } else if (toolDefaults?.[key] !== undefined) {
            (cmdTool as unknown as Record<string, unknown>)[key] = toolDefaults[key];
          }
        }
      }

      // Merge `env` (shallow: default → profile → per-tool; per-tool keys win)
      const envDefault = toolDefaults?.env;
      const envProfile = profile?.env;
      const envTool = cmdTool.env;
      if (envDefault || envProfile || envTool) {
        cmdTool.env = { ...envDefault, ...envProfile, ...envTool };
      }

      // Merge `argumentPathScope` (shallow field-by-field)
      const apsDefault = toolDefaults?.argumentPathScope;
      const apsProfile = profile?.argumentPathScope;
      const apsTool = cmdTool.argumentPathScope;
      if (apsDefault || apsProfile || apsTool) {
        cmdTool.argumentPathScope = { ...apsDefault, ...apsProfile, ...apsTool };
      }

      // Merge `failureLimit` (shallow field-by-field)
      const flDefault = toolDefaults?.failureLimit;
      const flProfile = profile?.failureLimit;
      const flTool = cmdTool.failureLimit;
      if (flDefault || flProfile || flTool) {
        cmdTool.failureLimit = { ...flDefault, ...flProfile, ...flTool };
      }

      // Merge `successExitCodes` (replacement — per-tool wins if set)
      if (cmdTool.successExitCodes === undefined) {
        if (profile?.successExitCodes !== undefined) {
          cmdTool.successExitCodes = profile.successExitCodes;
        } else if (toolDefaults?.successExitCodes !== undefined) {
          cmdTool.successExitCodes = toolDefaults.successExitCodes;
        }
      }
    }
  }

  private resolveConfigPath(reference: string): string {
    return path.isAbsolute(reference) ? reference : resolveProjectFrom(this.projectRoot, reference);
  }

  private resolveTextReference(value: unknown): unknown {
    if (typeof value !== 'string' || !value.trim()) return value;
    const filePath = this.resolveConfigPath(value);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return value;
    return fs.readFileSync(filePath, 'utf8');
  }

  private resolveChecklistReference(value: unknown): ChecklistItem[] | undefined {
    if (value === undefined || value === null) return undefined;
    if (Array.isArray(value)) return value as ChecklistItem[];
    if (typeof value !== 'string' || !value.trim()) return undefined;

    const filePath = this.resolveConfigPath(value);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new Error(`Checklist file not found: ${value}`);
    }

    const parsed = yaml.parse(fs.readFileSync(filePath, 'utf8'));
    if (Array.isArray(parsed)) return parsed as ChecklistItem[];
    if (isRecord(parsed) && Array.isArray(parsed.items)) return parsed.items as ChecklistItem[];
    throw new Error(`Checklist file must contain an array or an { items: [...] } object: ${value}`);
  }

  public resolveFileBackedFields(config: HarnessConfig): void {
    config.settings.harnessRestartPrompt = this.resolveTextReference(config.settings.harnessRestartPrompt) as string | undefined;
    config.settings.contextRestartPrompt = this.resolveTextReference(config.settings.contextRestartPrompt) as string | undefined;

    for (const gate of config.validationGates || []) {
      gate.checklist = this.resolveChecklistReference(gate.checklist);
    }

    for (const [stateId, state] of Object.entries(config.states || {})) {
      state.id = state.id || stateId;
      state.harnessRestartPrompt = this.resolveTextReference(state.harnessRestartPrompt) as string | undefined;
      state.contextRestartPrompt = this.resolveTextReference(state.contextRestartPrompt) as string | undefined;
      state.checklist = this.resolveChecklistReference(state.checklist);

      for (const action of state.actions || []) {
        action.prompt = this.resolveTextReference(action.prompt) as string | undefined;
        action.checklist = this.resolveChecklistReference(action.checklist);
      }
    }

    // pi-experiment-0njv: compute and store v2 LLM action prompt file provenance.
    // Runs after all other field resolution; path safety was already enforced by
    // preValidateV2Admission → validateV2LlmActions (before-model-spend guarantee).
    this.resolveV2LlmPromptProvenance(config);
  }
}
