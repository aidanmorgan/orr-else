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
import { WorkerPromptIdentityBuilder, formatSkillDuplicationDiagnostic } from '../core/WorkerPromptIdentityBuilder.js';
import { Logger } from '../core/Logger.js';
import { EnvVars, Component } from '../constants/index.js';
import type { ToolSurfaceCatalog } from '../core/ToolSurfaceCatalog.js';

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
  /**
   * pi-experiment-amq0.15: tool-surface catalog (required).
   * The single source of truth for configured Pi tool names
   * (used in the stable identity for prompt digest computation).
   * Built at SESSION_START; always present before BEFORE_AGENT_START fires.
   */
  toolSurfaceCatalog: ToolSurfaceCatalog;
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

  // Compute the base protocol label at state+action level (includes action.toolPromptProfile).
  // The caller (WorkerContextResolver, in the composition layer) resolves this — the core
  // builder receives it as a pre-resolved string, keeping core free of plugin imports.
  const baseProtocolLabel = profileId
    ? `ORR_ELSE_PROTOCOL_v1|profile:${profileId}`
    : 'ORR_ELSE_PROTOCOL_v1';

  // pi-experiment-amq0.10: build the stable identity via the single WorkerPromptIdentityBuilder.
  // This replaces the prior ad-hoc skill resolution + identity assembly and ensures
  // the prompt-assembly identity uses the same inputs as the spawn bootstrap digest.
  // The catalog is passed so Pi tool names come from the single source of truth.
  const promptIdentity = WorkerPromptIdentityBuilder.build({
    projectRoot,
    configPath,
    stateId: activeRun.stateId,
    config,
    toolSurfaceCatalog: ports.toolSurfaceCatalog,
    protocolLabel: baseProtocolLabel
  });
  if (promptIdentity.skillDuplications.length > 0) {
    Logger.warn(Component.TEAMMATE, formatSkillDuplicationDiagnostic(promptIdentity.skillDuplications), {
      beadId: activeRun.beadId,
      stateId: activeRun.stateId,
      duplications: promptIdentity.skillDuplications
    });
  }

  // 6q0y.2: fold sorted active tool names into the protocol label so that two states
  // with different active sets always produce different digest/cache-keys (AC3).
  let { protocolLabel } = promptIdentity.identity;
  if (resolvedActiveToolNames !== undefined) {
    // Append sorted active-tool fingerprint so cache-key changes when the active set changes.
    protocolLabel = `${protocolLabel}|activeTools:${resolvedActiveToolNames.join(',')}`;
  }
  const identity = { ...promptIdentity.identity, protocolLabel };

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
