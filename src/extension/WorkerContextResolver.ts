/**
 * WorkerContextResolver — worker system prompt assembly.
 *
 * pi-experiment-amq0.1: extracted from extension.ts.
 *
 * Assembles the worker system prompt from config/state/action/checklist and
 * computes the stable-block digest used for cache-eligible prompt leading spans.
 */
import * as path from 'path';
import type { HarnessConfig } from '../core/ConfigLoader.js';
import type { RuntimeServices } from '../composition/createRuntimeServices.js';
import type { ActiveRun } from './SessionTypes.js';
import { resolveActiveToolSet } from '../core/ActiveToolSetResolver.js';
import { describeConfiguredProjectTools, resolveToolPromptProfileId } from '../plugins/projectTools.js';
import { getConfiguredPiToolNames, resolvePiSkillPathsForState } from '../core/PiIntegration.js';
import { type StableBootstrapInputs } from '../core/BootstrapDigest.js';
import { EnvVars } from '../constants/index.js';

/**
 * Shape returned by buildStateSystemPrompt.
 *
 * Exposed so the BEFORE_AGENT_START handler can compose the final worker prompt as
 * stableBlock + Pi-base-prompt + volatileSuffix, ensuring stableBlock leads contiguously.
 */
export interface StateSystemPromptResult {
  /** Fully assembled worker system prompt: stable block + volatile suffix. */
  prompt: string;
  /** Leading, cache-eligible span of the prompt. Byte-identical across same-identity runs. */
  stableBlock: string;
  /**
   * The volatile suffix rendered by ContextInjector: beadId, workdir, run paths, checklist.
   * Exposed so the BEFORE_AGENT_START handler can compose the final worker prompt as
   * stableBlock + Pi-base-prompt + volatileSuffix, ensuring stableBlock leads contiguously.
   */
  volatileSuffix: string;
  /** Deterministic digest over the stable identity + stableBlock text. */
  digestId: string;
  /** Rough token estimate for the stable block. */
  estimatedTokens: number;
  /** True when estimatedTokens exceeds the default budget. */
  overBudget: boolean;
  /**
   * Sorted active tool names included in the assembled prompt, or undefined when the full
   * default tool set is used (no activeTools declared on the state/action).
   * 6q0y.2: recorded on STATE_PROMPT_ASSEMBLED for observability (no prompt body).
   */
  activeToolNames: string[] | undefined;
}

/**
 * Injected ports for WorkerContextResolver.
 *
 * The resolver reads process.env[EnvVars.PROJECT_ROOT] for the project root so
 * it accesses the env through the injected port, not a bare process.env read.
 */
export interface WorkerContextResolverPorts {
  /** Project root — resolved by caller (env-first, then services.projectRoot). */
  projectRoot: string;
  services: Pick<
    RuntimeServices,
    | 'instructionLoader'
    | 'protocolInjector'
    | 'protocolParser'
    | 'configLoader'
    | 'contextInjector'
  >;
}

/**
 * Assembles the worker system prompt and computes the stable-block digest.
 *
 * The returned prompt is exactly [stableBlock]+[volatileSuffix].  The stableBlock
 * is the leading, cache-eligible span — byte-identical across any two runs that
 * share the same (projectRoot, configPath, stateId, toolNames, skillNames,
 * rulePaths) but differ only in beadId/worktreePath.  The digest is computed
 * by digestStableBlock() over the ACTUAL assembled stableBlock text (no duplicate
 * rendering of tool/skill/rule guidance).
 *
 * Callers (BEFORE_AGENT_START) should record digestId + estimatedTokens +
 * overBudget on the STATE_RUN_INITIALIZED event and Logger.warn when overBudget.
 */
export function buildStateSystemPrompt(
  config: HarnessConfig,
  ports: WorkerContextResolverPorts,
  activeRun: ActiveRun
): StateSystemPromptResult {
  const { services, projectRoot } = ports;
  const stateInstructions = services.instructionLoader.assemble(activeRun.state, config);
  const protocol = services.protocolInjector.inject(activeRun.state, config);
  const checklistProtocol = services.protocolParser.generatePrompt(activeRun.requiredItems);
  const profileId = resolveToolPromptProfileId(config, activeRun.state, activeRun.action);

  // pi-experiment-6q0y.2: resolve the active tool set for this state/action pair so
  // only active tools appear in the stable prompt (token reduction for narrow states).
  //
  // Sentinel handling mirrors 6q0y.3 (Teammate.startInner): at the BEFORE_AGENT_START
  // boundary the action has already been selected by initializeWorkerRun via
  // selectActiveAction, so activeRun.action.id is a real action ID — not the sentinel.
  // We resolve at state+action level directly.  If the state is absent from
  // config.states (e.g. minimal test configs), fall back to the full tool set.
  let activeToolNamesSet: ReadonlySet<string> | undefined;
  let resolvedActiveToolNames: string[] | undefined;
  if (config.states[activeRun.stateId]) {
    try {
      const resolved = resolveActiveToolSet(activeRun.stateId, activeRun.action.id, config);
      if (!resolved.isDefault) {
        activeToolNamesSet = new Set(resolved.toolNames);
        resolvedActiveToolNames = resolved.toolNames; // already sorted
      }
    } catch {
      // Resolver errors (unknown names, duplicates) are startup-fatal at lint time;
      // if one slips through here, fall back to full tool set rather than crashing.
    }
  }

  const projectTools = describeConfiguredProjectTools(config, profileId, activeToolNamesSet);
  const actionPrompt = activeRun.action.prompt || '';
  const llm = services.configLoader.resolveLLMConfig(activeRun.stateId, config);
  const configPath = services.configLoader.getConfigPath();
  // Resolve skill names for the stable identity — best-effort; empty on error.
  let skillNames: string[] = [];
  try {
    skillNames = resolvePiSkillPathsForState(config, projectRoot, activeRun.stateId).map(s => s.name);
  } catch {
    skillNames = [];
  }

  // Build the stable identity for digest computation.  Arrays are sorted inside
  // digestStableBlock / canonicalise so insertion order is irrelevant.
  // The protocolLabel folds in the resolved profile ID so different profiles produce
  // different digest/cache-keys while identical runs remain deterministic.
  // 6q0y.2: also fold the sorted active tool names into the label so that two states
  // with different active sets always produce different digest/cache-keys (AC3).
  let protocolLabel = profileId ? `ORR_ELSE_PROTOCOL_v1|profile:${profileId}` : 'ORR_ELSE_PROTOCOL_v1';
  if (resolvedActiveToolNames !== undefined) {
    // Append sorted active-tool fingerprint so cache-key changes when the active set changes.
    protocolLabel = `${protocolLabel}|activeTools:${resolvedActiveToolNames.join(',')}`;
  }
  const identity: StableBootstrapInputs = {
    projectRoot,
    configIdentity: configPath,
    stateId: activeRun.stateId,
    toolNames: getConfiguredPiToolNames(config),
    skillNames,
    ruleCategories: [],
    protocolLabel
  };

  const injected = services.contextInjector.injectWithDigest(
    [stateInstructions, protocol, projectTools, actionPrompt].filter(Boolean).join('\n\n'),
    {
      beadId: activeRun.beadId,
      projectRoot,
      workdir: activeRun.worktreePath || process.cwd(),
      configPath,
      actionId: activeRun.action.id,
      identity: activeRun.state.identity.role,
      phase: activeRun.stateId,
      llmProviderKey: llm.providerKey,
      llmProvider: llm.provider,
      llmModel: llm.model,
      llmThinking: llm.thinking,
      progressPath: activeRun.worktreePath ? path.join(activeRun.worktreePath, 'PROGRESS.md') : undefined,
      historyPath: activeRun.worklogManager.getWorklogPath(activeRun.beadId),
      outstandingChecklist: checklistProtocol
    },
    identity
  );

  return {
    prompt: injected.prompt,
    stableBlock: injected.stableBlock,
    volatileSuffix: injected.volatileSuffix,
    digestId: injected.digestId,
    estimatedTokens: injected.estimatedTokens,
    overBudget: injected.overBudget,
    activeToolNames: resolvedActiveToolNames
  };
}
