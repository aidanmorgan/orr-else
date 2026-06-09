import type {
  AgentEndEvent,
  BeforeAgentStartEvent,
  BeforeProviderRequestEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionStartEvent,
  ToolCallEvent,
  ToolResultEvent,
  TurnEndEvent,
  TurnStartEvent
} from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
// createHash moved to ./extension/RawToolResultStore.ts
import { v7 as uuidv7 } from 'uuid';
import { computeBuildProvenance, computeHarnessFingerprint, runStalenessPreflightWarn } from './core/BuildProvenance.js';
import { Command } from 'commander';
import { parse as parseShellCommand } from 'shell-quote';
import { z } from 'zod';
import escapeStringRegexp from 'escape-string-regexp';
import { teammatePlugin, TeammateFactory } from './plugins/teammates.js';
import type { MergeResult } from './core/RuntimeServices.js';
import {
  executeConfiguredProjectTool,
  getConfiguredProjectToolNames,
  getHarnessRegisteredProjectToolNames,
  getNativePiExtensionProjectToolNames,
  projectToolFailureLimitSuggestedOutcome,
  registerConfiguredProjectTools,
} from './plugins/projectTools.js';
// describeConfiguredProjectTools, resolveToolPromptProfileId moved to ./extension/WorkerContextResolver.ts
// PLUGIN_RAW_FILE_NAME moved to ./extension/RawToolResultStore.ts
import { runStartupProbeAdmission } from './plugins/projectTools/readinessProbe.js';
import type { ToolResultBase } from './contract.js';
// evaluateRetry moved to ./extension/ToolExecutionWrapper.ts
// ToolResultRecorder moved to ./extension/ToolExecutionWrapper.ts
import { registerBuiltInVerifiers } from './tools/index.js';
// assembleAndWriteBuiltInHandle, buildRejectedBuiltInHandle moved to ./extension/ToolExecutionWrapper.ts
// getBuiltInRtkSummaryFactory moved to ./extension/ToolExecutionWrapper.ts
// ToolCallPathFactory moved to ./extension/RawToolResultStore.ts (type-only)
import type { HarnessConfig } from './core/ConfigLoader.js';
import { resolveProviderName } from './core/ConfigLoader.js';
import { SignalingServer, type SignalAck } from './core/SignalingServer.js';
import { loadCoordinatorWorkerExtensions } from './core/CoordinatorExtensionLoader.js';
import { evaluateCoordinatorGate, validateRequiredToolVerifiers } from './core/CoordinatorVerifierGate.js';
import { Bead, BeadId, asBeadId, asStateId, asWorkerId, asActionId } from './types/index.js';
import {
  TeammateEvent,
  createTeammateEventIdempotencyKey,
  decideTeammateEventProcessing,
  findAppliedTeammateSignal,
  isStatusMutatingTeammateEvent
} from './core/TeammateEvents.js';
import { validateHandoffPayload, HandoffSchemaId } from './core/HandoffSchemas.js';
import { capAnthropicMaxTokens, resolveMaxOutputTokens, type CappableAnthropicPayload } from './core/ProviderRequestCap.js';
import { buildTurnUsageRecord } from './core/TokenUsage.js';
// buildToolTokenAccounting, serializeToolResultText moved to ./extension/ToolExecutionWrapper.ts
import { registerClaudeCodeLiveLogin } from './plugins/claudeCodeAuth.js';
import { postHarnessSignal } from './core/HarnessApiClient.js';
import { Logger } from './core/Logger.js';
import { Observability, type SpanAttributes, type SpanContext } from './core/Observability.js';
// SpanStatusValue, SpanCompletion moved to ./extension/ToolExecutionWrapper.ts
import type { ChecklistItem } from './core/ProtocolParser.js';
import { deriveChecklistItems, mergeChecklistItems, missingMandatoryChecklistItems, resolveChecklistTickText } from './core/ChecklistRequirements.js';
import { ProgressManager } from './core/ProgressManager.js';
import { WorklogManager } from './core/WorklogManager.js';
import type { DomainEvent } from './core/EventStore.js';
import { SDLCState, TeammateAction, RequiredTool } from './core/domain/StateModels.js';
import {
  BeadStatus,
  DomainEventName,
  EventName,
  ExtensionCommandAction,
  RestartKind,
  TeammateEventDecisionAction,
  TeammateEventType,
  EnvVars,
  Component,
  Defaults,
  BuiltInToolName,
  ActionRunContext,
  ActionContextMode,
  ActionType,
  PluginToolName,
  ToolResultStatus,
  ToolEvidenceSource,
  // ToolValidationCondition moved to ./extension/ToolExecutionWrapper.ts
  ChecklistItemType,
  WorkerDefaults,
  SupervisorDefaults,
  CliOption,
  Numeric,
  TimeMs,
  App,
  ProcessFlag,
  HttpHeader,
  PiEventName,
  NativePiToolName,
  PiToolPolicyDefaults,
  ActionCompletionKey,
  ProjectToolType,
  AgentFailureCode,
  AgentFailureSummary,
  OperationalLogPath,
  OperationalArtifactPath,
  NativeReadPolicyDefaults,
  FileMutationPolicyDefaults,
  ReviewArtifactKind,
  ReviewArtifactStore,
  // ToolDefaults moved to ./extension/ToolExecutionWrapper.ts
  ProjectToolDefaults,
  LLMProviderName,
  OtelAttr,
  PathContextDefaults,
  PromptProvenanceDefaults
} from './constants/index.js';
import { Supervisor } from './core/Supervisor.js';
import { Orchestrator } from './core/Orchestrator.js';
import { RetentionScheduler } from './core/RetentionScheduler.js';
import { checkMcpBridgeHealth, mcpBackedRequiredToolNames } from './core/McpTransportPreflight.js';
import { runV2SubstratePreflight } from './core/V2SubstratePreflight.js';
import { validateNativePiExtensionProjectToolInventory } from './core/PiHostInventory.js';
import { resolveHostSdkFingerprint } from './core/PackageConformance.js';
import { requireTool } from './core/ToolRegistry.js';
import { Teammate, type WorkerContext } from './core/Teammate.js';
// resolveActiveToolSet moved to ./extension/WorkerContextResolver.ts
import { nodeRuntimeEnvironment } from './core/RuntimeEnvironment.js';
import { getConfiguredPiToolNames, getObservedPiToolNames, resolvePiSkillPaths } from './core/WorkerResourceResolver.js';
import { resolvePromptProvenance, detectStaleProvenanceEntries, computeCurrentStateConfigHash, type PromptProvenanceEntry } from './core/PromptProvenanceService.js';
// resolvePiSkillPathsForState moved to ./extension/WorkerContextResolver.ts
// digestStableBlock / StableBootstrapInputs moved to ./extension/WorkerContextResolver.ts
import { admitPiBasePrompt, PiBasePromptRuleCode } from './core/PiBasePromptAdmission.js';
import { computePromptSizing, evaluatePromptBudgetAdmission } from './core/PromptBudgetAdmission.js';
// evaluateToolPayloadBudget moved to ./extension/ToolExecutionWrapper.ts
import { RuntimeBudgetTracker, createRuntimeBudgetTracker, resolveRuntimeBudgetPolicy } from './core/RuntimeBudgetTracker.js';
import { LoopDetector } from './core/LoopDetector.js';
import { computeRequestSizing } from './core/ProviderBudgetPreflight.js';
import { systemClock } from './core/Clock.js';
import { createRuntimeServices, type RuntimeServices } from './composition/createRuntimeServices.js';
import { assertDeclaredOutcome, isAdvanceOutcome, isTerminalState, buildV2EventVocabulary, v2ApplyTransition } from './core/FlowManager.js';
import { emitActionRouteEvent } from './core/ActionRouteEventEmitter.js';
import { computeConfigFingerprint } from './core/RouteEventContract.js';
import { ArtifactQuery } from './core/ArtifactQuery.js';
import { HarnessEventQuery } from './core/HarnessEventQuery.js';
import { ToolOutputQuery } from './core/ToolOutputQuery.js';
import { PathContext } from './core/PathContext.js';
import type { ActiveRun } from './extension/SessionTypes.js';
import {
  isRecord,
  summarizeForEvent,
  stringifySpanAttribute,
  textIndicatesFailure,
  contentIndicatesFailure,
  nestedResultIndicatesFailure,
  resultIndicatesFailure,
  resultIndicatesSuccess,
  externalPiToolEventIndicatesFailure,
  externalPiToolResultFromEvent,
  agentEventError,
  eventToolCallId
} from './extension/PiEventAdapters.js';
import {
  buildWorkerEventFrom,
  teammateSignalEventData,
  hasAppliedTeammateSignal,
  postWorkerSignal
} from './extension/SignalController.js';
import {
  isContextOverflowFailure,
  isUsageLimitFailure,
  isHarnessTransientFailureInternal,
  compactLifecycleFailureSummary,
  handleAgentLifecycleFailure
} from './extension/AgentLifecycleController.js';
import {
  deriveRestartId,
  computeRestartAttempt,
  extractRestartCorrelation
} from './core/RestartCorrelation.js';
import {
  validateRestartHandoffContract,
  resolveCompactionPointer,
  buildRestartEventPayload,
  type RestartEvidenceRef,
  type RestartHandoffContract
} from './core/RestartHandoffValidation.js';
import {
  nativeToolPath,
  toSlashPath,
  relativeOperationalPath,
  pathWithin,
  isProgressOrWorklogPath,
  isOperationalReadPath,
  isProjectToolCallOutputPath,
  isOperationalMutationPath,
  nativeOperationalMutationPolicyRejection,
  gitSubcommand,
  shellOperationalMutationPolicyRejection,
  shellPolicyRejection,
  mcpPolicyRejection,
  operationalArtifactReadPolicyRejection,
  oversizedReadPolicyRejection
} from './extension/NativeToolPolicy.js';
import {
  registerProviderRequestCap,
  registerPiToolObservers,
  recordTurnUsage,
  registerAgentLifecycleObservers
} from './extension/PiObservers.js';
import { registerProcessLifecycleObservers } from './extension/ProcessLifecycleObserver.js';
import { persistPluginToolRawResult } from './extension/RawToolResultStore.js';
import { buildStateSystemPrompt, type StateSystemPromptResult } from './extension/WorkerContextResolver.js';
import { wrapPluginTool, checkToolValidationRules } from './extension/ToolExecutionWrapper.js';
import { bootstrapExtension } from './extension/ExtensionBootstrap.js';
import {
  isTerminalFailureLimitPayload,
  terminalFailureLimitDataFromResult,
  scanTerminalFailureLimit,
  preloadTerminalFailureLimit,
  terminalFailureLimitContext,
  terminalFailureLimitRejection,
  evaluateGateReadiness,
  type GateReadiness,
  type RequiredToolAuditEntry,
  type TerminalFailureLimitAudit,
  type TerminalFailureLimitContext
} from './extension/WorkerRunController.js';
import {
  actionRunContext,
  actionCompletionKey,
  isActionCompleted,
  selectActiveAction,
  nextSequencedAction,
  appendCompletedActionId,
  dynamicChecklistItemsForRun,
  teammateEventTypeForOutcome,
  shouldPersistBlockedBeadStatus as shouldPersistBlockedBeadStatusInternal,
  computeContextPolicyFingerprint
} from './extension/CoordinatorController.js';
import { SignalNoiseCoalescer } from './core/SignalNoiseCoalescer.js';
import {
  PiLifecycleEvent,
  PiLifecycleState,
  RunMode,
  SupervisorHealthStage,
  applyTransition,
  buildLifecycleEventFields,
  buildResourcesDiscoverFailure,
  createLifecycleMachineState,
  transition,
  type LifecycleMachineState,
} from './core/PiLifecycleStateMachine.js';

/**
 * Orr Else Extension
 * High-reliability agentic harness with obsessive, rehearsed resilience.
 */

/** Rate-limits repeated duplicate/out-of-order decision log entries (r06o AC1).
 * Fingerprinted by (decision, event type, beadId, stateId).
 * Durable TEAMMATE_EVENT event-store records are NEVER gated by this coalescer. */
const duplicateDecisionCoalescer = new SignalNoiseCoalescer(TimeMs.MINUTE);

const CYCLE_CAP_DEFAULT = 3;

const FrameworkToolCallSchema = z.object({
  tool: z.string(),
  arguments: z.record(z.string(), z.unknown())
}).passthrough();
const FrameworkToolCallListSchema = z.array(FrameworkToolCallSchema);

/**
 * Per-invocation session state for orrElseExtension.
 *
 * Each call to orrElseExtension() creates a fresh ExtensionSession so that
 * registration guards and run state from one invocation never bleed into a
 * second invocation against a different `pi` instance.
 */
interface ExtensionSession {
  // ── lifecycle state machine (pi-experiment-1elr.10) ──────────────────────
  /**
   * Deterministic Pi lifecycle state machine.  Every lifecycle handler
   * (RESOURCES_DISCOVER, SESSION_START, BEFORE_AGENT_START, SESSION_SHUTDOWN,
   * tool events, reload, restart) calls transition() on this machine BEFORE
   * mutating session state or registering tools.  Invalid ordering produces
   * a LIFECYCLE_VIOLATION diagnostic via the n8fg taxonomy.
   */
  lifecycleMachine: LifecycleMachineState;
  // ── coordinator ──────────────────────────────────────────────────────────
  supervisor: Supervisor | null;
  currentFlowOptions: FlowOptions | null;
  /**
   * Shared TeammateFactory built once in SESSION_START and reused by
   * startOrrElse (coordinator) and the spawn_teammate tool (all processes).
   *
   * Lifecycle note: SESSION_START always fires before the user can invoke
   * /orr-else, so this field is populated before startOrrElse ever runs.
   * In worker processes startOrrElse never runs; the tool still reads it here.
   */
  teammateFactory: TeammateFactory | null;
  // ── worker run state ─────────────────────────────────────────────────────
  activeRun: ActiveRun | null;
  agentFailureSignaled: boolean;
  checklistMutationQueue: Promise<unknown>;
  currentTurnStartMs: number | undefined;
  // ── coordinator cycle-cap ─────────────────────────────────────────────────
  /** Per-(bead, state, blocker-fingerprint) re-entry counter. */
  stateCycleCounter: Map<string, number>;
  /**
   * Per-bead RuntimeBudgetTracker instances for the coordinator-side verifier gate
   * (coordinator mode only). One tracker is created per beadId on first verifier
   * failure and reused on subsequent failures for that bead. Replaces the former
   * parallel `verifierFailureCounts` raw counter map (pi-experiment-6q0y.48).
   * Using the tracker unifies verifierFailureCount enforcement on the same mechanism
   * as all other runtime budget dimensions.
   */
  verifierBudgetTrackers: Map<string, RuntimeBudgetTracker>;
  /**
   * Always-on structural loop detector (pi-experiment-6q0y.49).
   *
   * Created lazily on the first coordinator or worker spend that needs it.
   * Null before services are available; set at SESSION_START.
   * Fingerprint state is rebuilt from the event store on restart (AC7).
   */
  loopDetector: LoopDetector | null;
  // ── tool execution ────────────────────────────────────────────────────────
  /**
   * Per-(bead, tool) consecutive-failure counter.  Worker mode only.
   * Cleared on initializeWorkerRun.
   */
  toolBreakerFailures: Map<string, number>;
  /**
   * Digest IDs already recorded as STATE_PROMPT_ASSEMBLED in the current run.
   * Dedups the record+warn so each unique stable-block digest is emitted at most
   * once per run.  Cleared on initializeWorkerRun alongside toolBreakerFailures.
   */
  recordedPromptDigestIds: Set<string>;
  /**
   * The Pi base prompt hash admitted on the first BEFORE_AGENT_START call in a run.
   * Used to detect drift on subsequent turns: if event.systemPrompt hashes to a
   * different value, a PI_BASE_PROMPT_DRIFT event is emitted (hashes/sizes/rule codes
   * only — no prompt body) before the prompt is re-admitted.
   * Cleared on initializeWorkerRun.
   */
  admittedPiBasePromptHash: string | null;
  /**
   * Compact harness fingerprint derived from BuildProvenance at SESSION_START.
   * Format: `sha256:<DIGEST_ID_LENGTH-char hex>`.
   * Added to STATE_RUN_INITIALIZED and STATE_PROMPT_ASSEMBLED events (AC3).
   * Undefined until SESSION_START resolves provenance; best-effort (undefined when
   * provenance computation failed).
   */
  admittedHarnessFingerprint: string | undefined;
  /**
   * Pending STATE_RUN_INITIALIZED payload set by initializeWorkerRun.
   * Held until the first BEFORE_AGENT_START call computes the finalPromptHash,
   * at which point the payload is enriched with finalPromptHash +
   * admittedHarnessFingerprint and recorded as STATE_RUN_INITIALIZED.
   * Cleared after recording.
   */
  pendingRunInitPayload: Record<string, unknown> | undefined;
  /**
   * In-session result memoisation for cacheable project tools.
   * Key: `${toolName}|${JSON.stringify(params)}`.
   * Cleared on fresh worker run and after any non-cacheable tool call.
   * The ToolResultBase handle is stored alongside the result so cache-hit
   * TOOL_INVOCATION_SUCCEEDED events carry the durable outputFile + status.
   */
  toolResultCache: Map<string, { result: unknown; recordedAt: number; toolResult: ToolResultBase }>;
  // ── pi-tool observability ─────────────────────────────────────────────────
  piToolObservability: Observability | null;
  observedPiTools: Set<string>;
  blockedObservedPiToolCallIds: Set<string>;
  observedPiToolSpans: Map<string, SpanContext>;
  /** Maps Pi toolCallId → harness toolInvocationId (generated at TOOL_CALL time). */
  observedPiToolInvocationIds: Map<string, string>;
  /**
   * Per-worker-run runtime budget tracker (pi-experiment-6q0y.48).
   * Null when no runtime budget is configured (true no-op, AC1).
   * Created in initializeWorkerRun; cleared at the start of each new run.
   */
  runtimeBudgetTracker: RuntimeBudgetTracker | null;
  // ── registration guards (reset each invocation so a second call re-registers) ──
  artifactPathsToolRegistered: boolean;
  queryArtifactToolRegistered: boolean;
  queryHarnessEventsToolRegistered: boolean;
  queryToolOutputToolRegistered: boolean;
  readPathContextToolRegistered: boolean;
  preSignalAuditToolRegistered: boolean;
  piToolObserverRegistered: boolean;
  providerRequestCapRegistered: boolean;
  claudeCodeLoginRegistered: boolean;
  agentLifecycleObserverRegistered: boolean;
  // NOTE: processLifecycleObserversRegistered is intentionally NOT here — it is
  // a module-level global because it guards process.on() calls on the
  // process-global object, which must not be registered more than once per
  // process regardless of how many times orrElseExtension is invoked.
}

function createExtensionSession(): ExtensionSession {
  return {
    lifecycleMachine: createLifecycleMachineState(),
    supervisor: null,
    currentFlowOptions: null,
    teammateFactory: null,
    activeRun: null,
    agentFailureSignaled: false,
    checklistMutationQueue: Promise.resolve(),
    currentTurnStartMs: undefined,
    stateCycleCounter: new Map(),
    verifierBudgetTrackers: new Map(),
    loopDetector: null,
    toolBreakerFailures: new Map(),
    toolResultCache: new Map(),
    recordedPromptDigestIds: new Set(),
    admittedPiBasePromptHash: null,
    admittedHarnessFingerprint: undefined,
    pendingRunInitPayload: undefined,
    runtimeBudgetTracker: null,
    piToolObservability: null,
    observedPiTools: new Set(),
    blockedObservedPiToolCallIds: new Set(),
    observedPiToolSpans: new Map(),
    observedPiToolInvocationIds: new Map(),
    artifactPathsToolRegistered: false,
    queryArtifactToolRegistered: false,
    queryHarnessEventsToolRegistered: false,
    queryToolOutputToolRegistered: false,
    readPathContextToolRegistered: false,
    preSignalAuditToolRegistered: false,
    piToolObserverRegistered: false,
    providerRequestCapRegistered: false,
    claudeCodeLoginRegistered: false,
    agentLifecycleObserverRegistered: false,
  };
}

// processLifecycleObserversRegistered guard lives in ./extension/ProcessLifecycleObserver.ts.

const TERMINAL_FAILURE_ALLOWED_TOOLS = new Set<string>([
  BuiltInToolName.ADD_CHECKLIST_ITEM,
  BuiltInToolName.TICK_ITEMS,
  BuiltInToolName.GET_OUTSTANDING_TASKS,
  BuiltInToolName.SUBMIT_CHECKPOINT,
  BuiltInToolName.SUBMIT_ACTION_EVIDENCE,
  BuiltInToolName.SUBMIT_REVIEW_ARTIFACT,
  BuiltInToolName.SIGNAL_COMPLETION,
  BuiltInToolName.REQUEST_CONTEXT_RESTART,
  BuiltInToolName.REQUEST_HARNESS_RESTART,
  BuiltInToolName.PRE_SIGNAL_AUDIT
]);

interface FlowOptions {
  maxSlots: number;
  autoContinue: boolean;
  beadId?: string;
  configPath?: string;
}

// ActiveRun is imported from ./extension/SessionTypes.js

interface ChecklistTickInput {
  text: string;
  evidence?: string;
  evidencePath?: string;
}

// TerminalFailureLimitContext, routingHintSuggestedOutcomeFromResult are in ./extension/WorkerRunController.js

function getObservability(services: RuntimeServices): Observability {
  return services.observability;
}

// registerProcessLifecycleObservers is now in ./extension/ProcessLifecycleObserver.ts.

async function initializeObservability(services: RuntimeServices): Promise<Observability> {
  const runtimeObservability = getObservability(services);
  await runtimeObservability.initialize();
  services.eventStore.setSessionId(runtimeObservability.getSessionId());
  return runtimeObservability;
}

// toolResult, beadIdFromToolParams, activeSpanAttributes, toolSpanAttributes
// moved to ./extension/ToolExecutionWrapper.ts.
// beadIdFromToolParams and toolSpanAttributes remain accessible here for
// the PiObservers callbacks — they are rebuilt as closures over `session`.

function beadIdFromToolParams(params: Record<string, unknown> | undefined, session: ExtensionSession): string | undefined {
  if (!params) return session.activeRun?.beadId || process.env[EnvVars.BEAD_ID];
  const args = isRecord(params.arguments) ? params.arguments : undefined;
  return (
    (typeof params.beadId === 'string' ? params.beadId : undefined) ||
    (typeof params.id === 'string' ? params.id : undefined) ||
    (args && typeof args.beadId === 'string' ? args.beadId : undefined) ||
    (args && typeof args.id === 'string' ? args.id : undefined) ||
    session.activeRun?.beadId ||
    process.env[EnvVars.BEAD_ID]
  );
}

function activeSpanAttributes(beadId: string | undefined, session: ExtensionSession): SpanAttributes {
  return {
    [OtelAttr.ORR_ELSE_BEAD_ID]: beadId || session.activeRun?.beadId || process.env[EnvVars.BEAD_ID],
    [OtelAttr.ORR_ELSE_STATE_ID]: session.activeRun?.stateId || process.env[EnvVars.STATE_ID],
    [OtelAttr.ORR_ELSE_ACTION_ID]: session.activeRun?.action?.id || process.env[EnvVars.ACTION_ID],
    [OtelAttr.ORR_ELSE_WORKER_ID]: process.env[EnvVars.WORKER_ID]
  };
}

function toolSpanAttributes(toolName: string, params: unknown, beadId: string | undefined, session: ExtensionSession, externalPiTool = false, toolInvocationId?: string): SpanAttributes {
  return {
    'tool.name': toolName,
    'tool.params': stringifySpanAttribute(summarizeForEvent(params)),
    'tool.external_pi': externalPiTool || undefined,
    [OtelAttr.ORR_ELSE_TOOL_INVOCATION_ID]: toolInvocationId,
    ...activeSpanAttributes(beadId, session)
  };
}

// requiredToolsForRun, RequiredToolAuditEntry, TerminalFailureLimitAudit, GateReadiness,
// evaluateGateReadiness are in ./extension/WorkerRunController.js

// summarizeForEvent and related helpers are imported from ./extension/PiEventAdapters.js

// externalPiToolResultFromEvent, textIndicatesFailure, contentIndicatesFailure,
// nestedResultIndicatesFailure, externalPiToolEventIndicatesFailure are imported
// from ./extension/PiEventAdapters.js

// agentEventError, isContextOverflowFailure, isUsageLimitFailure,
// compactLifecycleFailureSummary are imported from ./extension/AgentLifecycleController.js

/**
 * Public export for test consumers — delegates to the controller module.
 * The function body stays here to preserve the re-export contract.
 */
export function isHarnessTransientFailure(error: string): boolean {
  return isHarnessTransientFailureInternal(error);
}

// usageLimitResetMs is private in ./extension/AgentLifecycleController.js

// stringifySpanAttribute is imported from ./extension/PiEventAdapters.js

function commandMatchesPattern(command: string, pattern: string): boolean {
  try {
    return new RegExp(pattern).test(command);
  } catch {
    return new RegExp(escapeStringRegexp(pattern)).test(command);
  }
}

function commandInvokesToolName(command: string, toolName: string, services: RuntimeServices): boolean {
  try {
    return services.shellCommandParser.commandBasenames(command).some(commandHead => commandHead === toolName);
  } catch {
    return false;
  }
}

// isTerminalFailureLimitPayload, terminalFailureLimitDataFromResult, scanTerminalFailureLimit,
// preloadTerminalFailureLimit are imported from ./extension/WorkerRunController.js

// NativeToolPolicy constants and functions are imported from ./extension/NativeToolPolicy.js

// teammateEventTypeForOutcome and shouldPersistBlockedBeadStatus are imported
// from ./extension/CoordinatorController.js

/**
 * Public re-export for test consumers — the implementation lives in CoordinatorController.
 * Config is optional; when omitted the function uses the default vocabulary
 * (FAILURE/BLOCKED/SUCCESS), reproducing previous literal-comparison behaviour.
 */
export function shouldPersistBlockedBeadStatus(
  eventType: string,
  nextState: string,
  config?: import('./core/ConfigLoader.js').HarnessConfig
): boolean {
  return shouldPersistBlockedBeadStatusInternal(eventType, nextState, config ?? ({} as import('./core/ConfigLoader.js').HarnessConfig));
}

// shellPolicyRejection, mcpPolicyRejection, operationalArtifactReadPolicyRejection,
// oversizedReadPolicyRejection are imported from ./extension/NativeToolPolicy.js

// registerProviderRequestCap, registerPiToolObservers, recordTurnUsage,
// registerAgentLifecycleObservers are imported from ./extension/PiObservers.js

// resultIndicatesFailure and resultIndicatesSuccess are imported from ./extension/PiEventAdapters.js

// spanCompletionForToolResult, checkToolValidationRules, lookupToolGuards, lookupRetryPolicy,
// lookupIdempotencyClass, toolCacheKey, breakerKey, runWithWrapperTimeout
// moved to ./extension/ToolExecutionWrapper.ts.

// terminalFailureLimitContext and terminalFailureLimitRejection are imported
// from ./extension/WorkerRunController.js

// ---- Raw plugin-tool result persistence (s3wp.26) ----
// persistPluginToolRawResult is now in ./extension/RawToolResultStore.ts.

// applyToolPayloadBudget and wrapPluginTool moved to ./extension/ToolExecutionWrapper.ts.

function isWorkerMode(): boolean {
  return process.env[EnvVars.WORKER_MODE] === ProcessFlag.TRUE && !!process.env[EnvVars.BEAD_ID] && !!process.env[EnvVars.STATE_ID];
}

/**
 * Emit a LIFECYCLE_VIOLATION diagnostic log from a failed transition.
 *
 * This is the central fail-closed path for all lifecycle violations (AC3).
 * Called by each lifecycle handler after transition() returns ok:false.
 * The handler then decides whether to return early or continue (for shutdown
 * which must always proceed even if the machine disagrees).
 *
 * pi-experiment-1elr.10: uses the n8fg taxonomy result from the machine,
 * not a parallel classification.
 */
function emitLifecycleViolation(
  violation: import('./core/PiLifecycleStateMachine.js').TransitionFailure,
  context: Record<string, unknown> = {}
): void {
  Logger.warn(Component.ORR_ELSE, 'Lifecycle violation detected', {
    kind: violation.kind,
    fromState: violation.fromState,
    event: violation.event,
    description: violation.description,
    taxonomyRowId: violation.routingResult.rowId,
    taxonomyNextAction: violation.routingResult.nextAction,
    idempotencyKey: violation.idempotencyKey,
    ...context,
  });
}

// isRecord is imported from ./extension/PiEventAdapters.js

function parseJsonIfString(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function extractFrameworkToolCalls(value: unknown): Array<{ tool: string; arguments?: Record<string, unknown> }> {
  const parsed = parseJsonIfString(value);
  if (Array.isArray(parsed)) return FrameworkToolCallListSchema.safeParse(parsed).data || [];
  const single = FrameworkToolCallSchema.safeParse(parsed);
  if (single.success) return [single.data];
  if (!isRecord(parsed)) return [];

  if (Array.isArray(parsed.toolCalls)) return extractFrameworkToolCalls(parsed.toolCalls);
  if (Array.isArray(parsed.frameworkToolCalls)) return extractFrameworkToolCalls(parsed.frameworkToolCalls);
  if (isRecord(parsed.details)) return extractFrameworkToolCalls(parsed.details);
  if (typeof parsed.stdout === 'string') return extractFrameworkToolCalls(parsed.stdout);
  if (typeof parsed.result === 'string' || isRecord(parsed.result)) return extractFrameworkToolCalls(parsed.result);
  return [];
}

function normalizeChecklistItem(raw: Record<string, unknown>): ChecklistItem | null {
  if (typeof raw.text !== 'string' || raw.text.trim() === '') return null;
  return {
    ...raw,
    text: raw.text.trim(),
    mandatory: raw.mandatory !== false,
    type: typeof raw.type === 'string' ? raw.type as any : ChecklistItemType.MANUAL
  } as ChecklistItem;
}

// teammateSignalEventData, hasAppliedTeammateSignal, postWorkerSignal are
// imported from ./extension/SignalController.js

// actionRunContext, actionCompletionKey, isActionCompleted, selectActiveAction,
// nextSequencedAction, appendCompletedActionId, dynamicChecklistItemsForRun
// are imported from ./extension/CoordinatorController.js

async function addChecklistItem(rawItem: Record<string, unknown>, source: string, services: RuntimeServices, session: ExtensionSession): Promise<Record<string, unknown>> {
  const operation = session.checklistMutationQueue.then(
    () => addChecklistItemInner(rawItem, source, services, session),
    () => addChecklistItemInner(rawItem, source, services, session)
  );
  session.checklistMutationQueue = operation.catch(() => undefined);
  return operation;
}

async function addChecklistItemInner(rawItem: Record<string, unknown>, source: string, services: RuntimeServices, session: ExtensionSession): Promise<Record<string, unknown>> {
  const activeRun = session.activeRun;
  if (!activeRun) return { status: ToolResultStatus.REJECTED, message: 'No active run.' };

  const checklistItem = normalizeChecklistItem(rawItem);
  if (!checklistItem) {
    return { status: ToolResultStatus.REJECTED, message: 'Checklist item requires non-empty text.' };
  }

  const activeMerge = mergeChecklistItems(activeRun.requiredItems, [checklistItem]);
  const activeChanged = activeMerge.addedItems.length > 0 || activeMerge.upgradedItems.length > 0;

  activeRun.requiredItems = activeMerge.requiredItems;

  if (!activeChanged) {
    return {
      status: ToolResultStatus.PASSED,
      added: [],
      existing: activeMerge.existingItems.map(item => item.text),
      upgraded: [],
      totalRequiredItems: activeRun.requiredItems.length
    };
  }

  await services.eventStore.record(DomainEventName.CHECKLIST_ITEM_ADDED, {
    beadId: activeRun.beadId,
    stateId: activeRun.stateId,
    actionId: activeRun.action.id,
    actionKey: actionCompletionKey(await services.configLoader.load(), activeRun.stateId, activeRun.action.id),
    source,
    item: checklistItem
  });

  await activeRun.worklogManager.appendEntry(
    activeRun.beadId,
    activeRun.stateId,
    `Added checklist item: ${checklistItem.text}`,
    JSON.stringify({ source, item: checklistItem }, null, 2)
  );

  if (activeRun.progressManager) {
    await activeRun.progressManager.appendLog(`Added checklist item from ${source}: ${checklistItem.text}`);
  }

  return {
    status: ToolResultStatus.PASSED,
    added: activeMerge.addedItems.map(item => item.text),
    existing: activeMerge.existingItems.map(item => item.text),
    upgraded: activeMerge.upgradedItems.map(item => item.text),
    totalRequiredItems: activeRun.requiredItems.length
  };
}

async function resolveEvidenceFromPath(rawPath: string, session: ExtensionSession): Promise<{ ok: true; evidence: string } | { ok: false; error: string }> {
  const run = session.activeRun;
  if (!run || !run.worktreePath) {
    return { ok: false, error: 'No active worktree to resolve evidencePath against.' };
  }
  const worktreeRoot = path.resolve(run.worktreePath);
  const resolved = path.resolve(worktreeRoot, rawPath);
  if (!resolved.startsWith(worktreeRoot + path.sep) && resolved !== worktreeRoot) {
    return { ok: false, error: `evidencePath must stay inside the worktree (${run.worktreePath}).` };
  }
  try {
    const evidence = await fs.promises.readFile(resolved, 'utf8');
    if (!evidence.trim()) return { ok: false, error: `evidencePath resolved to an empty file: ${rawPath}` };
    return { ok: true, evidence };
  } catch (error) {
    return { ok: false, error: `Failed to read evidencePath ${rawPath}: ${String(error)}` };
  }
}

async function tickChecklistItems(items: ChecklistTickInput[], services: RuntimeServices, session: ExtensionSession): Promise<Record<string, unknown>> {
  const run = session.activeRun;
  if (!run) return { status: ToolResultStatus.REJECTED, message: 'No active run.' };
  if (!Array.isArray(items) || items.length === 0) {
    return { status: ToolResultStatus.REJECTED, message: 'At least one checklist item is required.' };
  }

  const evidenceResolution = await Promise.all(items.map(async item => {
    if (item.evidence && item.evidence.trim().length > 0) return { ok: true, item };
    if (item.evidencePath && item.evidencePath.trim().length > 0) {
      const resolution = await resolveEvidenceFromPath(item.evidencePath, session);
      if (!resolution.ok) {
        return { ok: false as const, originalText: item.text, error: resolution.error };
      }
      return { ok: true, item: { ...item, evidence: resolution.evidence } };
    }
    return {
      ok: false as const,
      originalText: item.text,
      error: 'Either `evidence` (inline) or `evidencePath` (artifact path) must be supplied.'
    };
  }));
  const evidenceFailures = evidenceResolution.filter((entry): entry is { ok: false; originalText: string; error: string } => !entry.ok);
  if (evidenceFailures.length > 0) {
    return {
      status: ToolResultStatus.REJECTED,
      message: `Evidence resolution failed: ${evidenceFailures.map(f => `${f.originalText}: ${f.error}`).join('; ')}`
    };
  }
  const itemsWithEvidence = evidenceResolution
    .filter((entry): entry is { ok: true; item: ChecklistTickInput & { evidence: string } } => entry.ok)
    .map(entry => entry.item);

  const resolvedItems = itemsWithEvidence.map(item => ({
    ...item,
    originalText: item.text,
    text: resolveChecklistTickText(run.requiredItems, item.text) || item.text.trim()
  }));
  const uniqueItems = Array.from(new Map(resolvedItems.map(item => [item.text, item])).values());
  const rejected = uniqueItems
    .filter(item => !run.requiredItems.some(required => required.text === item.text))
    .map(item => item.originalText);
  if (rejected.length > 0) {
    const validItems = run.requiredItems.map(item => item.text);
    return {
      status: ToolResultStatus.REJECTED,
      message: `Checklist item is not in the current phase checklist: ${rejected.join(', ')}. Retry with exact text from validItems.`,
      rejectedItems: rejected,
      validItems
    };
  }

  const actionKey = actionCompletionKey(await services.configLoader.load(), run.stateId, run.action.id);
  for (const item of uniqueItems) {
    await services.eventStore.record(DomainEventName.CHECKLIST_ITEM_TICKED, {
      beadId: run.beadId,
      stateId: run.stateId,
      actionId: run.action.id,
      actionKey,
      text: item.text,
      evidence: item.evidence
    });
  }

  await run.worklogManager.appendEntry(
    run.beadId,
    run.stateId,
    `Ticked ${uniqueItems.length} checklist item${uniqueItems.length === 1 ? '' : 's'}`,
    uniqueItems.map(item => `- ${item.text}: ${item.evidence}`).join('\n')
  );

  if (run.progressManager) {
    await run.progressManager.appendLog(
      `Checked ${uniqueItems.length} checklist item${uniqueItems.length === 1 ? '' : 's'}: ${uniqueItems.map(item => item.text).join(', ')}`
    );
  }

  return {
    status: ToolResultStatus.PASSED,
    checked: uniqueItems.map(item => item.text),
    count: uniqueItems.length
  };
}

async function executeFrameworkToolCall(
  toolCall: { tool: string; arguments?: Record<string, unknown> },
  source: string,
  runtimeObservability: Observability,
  services: RuntimeServices,
  session: ExtensionSession
): Promise<Record<string, unknown>> {
  if (toolCall.tool !== BuiltInToolName.ADD_CHECKLIST_ITEM) {
    return {
      status: ToolResultStatus.REJECTED,
      message: `Unsupported framework tool call from ${source}: ${toolCall.tool}`
    };
  }
  const result = await addChecklistItem(toolCall.arguments || {}, source, services, session);
  runtimeObservability.recordToolInvocation(BuiltInToolName.ADD_CHECKLIST_ITEM, result);
  return result;
}

async function runParentSequenceActionsBeforeActive(
  config: HarnessConfig,
  ctx: ExtensionContext,
  runtimeObservability: Observability,
  services: RuntimeServices,
  session: ExtensionSession
): Promise<void> {
  const run = session.activeRun;
  if (!run || run.parentSequenceCompleted) return;
  const activeIndex = run.state.actions.findIndex(action => action.id === run.action.id);
  const precedingActions = activeIndex <= 0 ? [] : run.state.actions.slice(0, activeIndex);

  for (const action of precedingActions) {
    if (isActionCompleted(config, run.stateId, action, run.completedActionIds)) continue;

    if (actionRunContext(action, run.state, config) === ActionRunContext.FRESH) {
      throw new Error(`Action ${action.id} requests fresh context but has not completed before ${run.action.id}.`);
    }

    if (action.type !== ActionType.TOOL || !action.tool) {
      throw new Error(`Parent-context sequenced action ${action.id} must be a tool action when it runs before the active prompt action.`);
    }
    const definition = (config.tools || []).find(tool => tool.name === action.tool);
    if (!definition) throw new Error(`Sequenced action ${action.id} references unknown project tool: ${action.tool}`);
    if (definition.type === ProjectToolType.EXTENSION) {
      throw new Error(
        `Sequenced parent action ${action.id} references native Pi extension tool ${action.tool}. ` +
        `Native extension tools are model-call tools registered with pi.registerTool(); use command or mcp for harness-executed parent actions.`
      );
    }

    const result = await executeConfiguredProjectTool(services.eventStore, services.toolCallPathFactory, definition, {
      beadId: run.beadId,
      stateId: run.stateId,
      actionId: action.id,
      arguments: action.arguments || {}
    }, ctx, undefined, services.projectToolBackpressure, services.projectRoot);
    runtimeObservability.recordToolInvocation(action.tool, result);

    // Extract framework toolCalls from the explicit inline result only.
    // Hidden outputFile backchannels must not drive framework mutations.
    const inlineRecord = isRecord(result) ? result as Record<string, unknown> : undefined;
    const inlineToolCalls = inlineRecord
      ? (Array.isArray(inlineRecord.toolCalls) ? inlineRecord.toolCalls
        : Array.isArray(inlineRecord.frameworkToolCalls) ? inlineRecord.frameworkToolCalls
        : undefined)
      : undefined;
    const sequencedToolCalls: unknown[] = Array.isArray(inlineToolCalls) ? inlineToolCalls : [];

    // Fail closed when the action declares it generates framework toolCalls but
    // the returned result omits explicit toolCalls/frameworkToolCalls.
    if (action.generatesFrameworkToolCalls && sequencedToolCalls.length === 0) {
      throw new Error(
        `Sequenced action ${action.id} declares generatesFrameworkToolCalls but the returned result ` +
        `contains no explicit toolCalls or frameworkToolCalls. ` +
        `Failing closed to prevent silent checklist mutations from being skipped.`
      );
    }

    // Pass explicit toolCalls directly, or fall back to full result-based extraction
    // for non-generator tools that embed framework calls in other shapes.
    const frameworkCallSource = sequencedToolCalls.length > 0 ? sequencedToolCalls : result;
    for (const toolCall of extractFrameworkToolCalls(frameworkCallSource)) {
      const toolResult = await executeFrameworkToolCall(toolCall, action.tool, runtimeObservability, services, session);
      if (toolResult.status !== ToolResultStatus.PASSED) {
        throw new Error(`Sequenced action ${action.id} framework tool call failed: ${JSON.stringify(toolResult)}`);
      }
    }

    if (resultIndicatesFailure(result)) {
      throw new Error(`Sequenced action ${action.id} failed: ${JSON.stringify(result).slice(0, WorkerDefaults.TOOL_AUDIT_PREVIEW_CHARS)}`);
    }

    const actionKey = actionCompletionKey(config, run.stateId, action.id);
    const completedActionIds = appendCompletedActionId(run.completedActionIds, run.stateId, action.id, config);
    run.completedActionIds = completedActionIds;
    await services.eventStore.record(DomainEventName.ACTION_COMPLETED, {
      beadId: run.beadId,
      stateId: run.stateId,
      actionId: action.id,
      actionKey,
      tool: action.tool,
      result: summarizeForEvent(result),
      generatedToolCallsApplied: sequencedToolCalls.length
    });
  }

  run.parentSequenceCompleted = true;
}

/**
 * Build a TeammateEvent. Resolves env values here (extension.ts is the
 * allowed boundary for process.env) and delegates to buildWorkerEventFrom
 * in SignalController.ts which is env-free.
 */
function buildWorkerEvent(type: TeammateEventType, fields: Record<string, unknown>): TeammateEvent {
  return buildWorkerEventFrom(type, fields, {
    workerId: process.env[EnvVars.WORKER_ID] || `worker-${process.pid}`,
    sessionStateId: process.env[EnvVars.SESSION_STATE_ID],
    beadId: process.env[EnvVars.BEAD_ID],
    stateId: process.env[EnvVars.STATE_ID]
  }, WorkerDefaults.UNKNOWN_STATE_ID);
}

function seedCompletedActionToolEvidence(
  runtimeObservability: Observability,
  state: SDLCState,
  config: HarnessConfig,
  stateId: string,
  completedActionIds: string[]
): void {
  for (const action of state.actions) {
    if (!action.tool || !isActionCompleted(config, stateId, action, completedActionIds)) continue;
    runtimeObservability.recordToolInvocation(action.tool, {
      status: ToolResultStatus.PASSED,
      source: ToolEvidenceSource.EVENT_STORE_COMPLETED_ACTION,
      actionId: action.id
    });
  }
}

async function initializeWorkerRun(runtimeObservability: Observability, services: RuntimeServices, session: ExtensionSession): Promise<void> {
  const beadId = process.env[EnvVars.BEAD_ID] as BeadId | undefined;
  const stateId = process.env[EnvVars.STATE_ID];
  if (!beadId || !stateId) return;
  // A fresh worker run starts with a clean tool-breaker and tool-cache state.
  // Both are session-scoped; they do not carry across the bead transition
  // that ended the prior run.
  session.toolBreakerFailures.clear();
  session.toolResultCache.clear();
  session.recordedPromptDigestIds.clear();
  session.admittedPiBasePromptHash = null;
  session.pendingRunInitPayload = undefined;
  // pi-experiment-6q0y.48: reset runtime budget tracker for each new run (AC1 no-op when no policy).
  session.runtimeBudgetTracker = null;

  const config = await services.configLoader.load();
  const state = config.states[stateId];
  if (!state) throw new Error(`Configured state not found: ${stateId}`);

  const actionId = process.env[EnvVars.ACTION_ID];
  const beadProjection = await services.eventStore.projectBead(beadId, { includeDetails: true });
  const completedActionIds = Array.isArray(beadProjection.completedActionIds)
    ? beadProjection.completedActionIds
    : [];
  const action = selectActiveAction(config, stateId, state, actionId, completedActionIds);
  if (!action) throw new Error(`State ${stateId} has no configured actions.`);

  // pi-experiment-6q0y.48: create runtime budget tracker for this run.
  // No-op (null) when no policy is configured at any scope (AC1).
  session.runtimeBudgetTracker = createRuntimeBudgetTracker(config, {
    beadId,
    stateId,
    actionId: action.id,
    clock: systemClock,
  });

  const worktreePath = process.env[EnvVars.WORKTREE_PATH] || process.cwd();
  const configuredRequiredItems = deriveChecklistItems(state, action, config, stateId);
  const requiredItems = mergeChecklistItems(
    configuredRequiredItems,
    dynamicChecklistItemsForRun(beadProjection as Bead, stateId, action.id)
  ).requiredItems;
  const worklogManager = new WorklogManager(services.eventStore, services.projectRoot);
  const progressManager = new ProgressManager(worktreePath, services.eventStore, { beadId, stateId });

  // Generate directories for declared artifact types (ensureDir:true) so a teammate
  // can write them before any plan write set exists (e.g. lesson capture). g9ye.
  await services.artifactPaths.ensureArtifactDirs({ beadId, stateId, actionId: action.id }).catch(error => {
    Logger.warn(Component.ORR_ELSE, 'Failed to ensure declared artifact directories', { beadId, stateId, error: String(error) });
  });

  session.activeRun = {
    beadId,
    stateId,
    state,
    action,
    requiredItems,
    startedAt: Date.now(),
    worktreePath,
    progressManager,
    worklogManager,
    checkpointAccepted: false,
    parentSequenceCompleted: false,
    completedActionIds
  };
  preloadTerminalFailureLimit(session.activeRun, services);
  session.agentFailureSignaled = false;
  seedCompletedActionToolEvidence(runtimeObservability, state, config, stateId, completedActionIds);

  await progressManager?.ensureExists(beadId, `Started ${stateId}/${action.id}.`);
  await worklogManager.appendEntry(beadId, stateId, 'State started', `Action: ${action.id}`);

  // Resolve prompt provenance: file-level path + SHA-256 for each source prompt/config
  // file at run-start time. The completion gate re-hashes these files to detect drift.
  //
  // Resolution is throw-safe: resolvePromptProvenance guards each entry individually
  // so a bad compat path or missing skill directory degrades to a missing entry rather
  // than aborting the whole resolution.  We additionally guard the outer call so that
  // any unforeseen error never breaks run initialization.
  //
  // If resolution fails (resolutionFailed: true or caught exception), we record a
  // `promptProvenanceResolutionFailed: true` marker on the event so the completion gate
  // can distinguish "resolution failed at init (warn, do NOT hard-block)" from
  // "provenance recorded and a prompt file later drifted (block)".  Blocking a run
  // whose provenance could not be resolved at init would punish the agent for a
  // harness-level problem, so we deliberately do not hard-reject in that case.
  const projectRoot = process.env[EnvVars.PROJECT_ROOT] || services.projectRoot;
  const configPath = services.configLoader.getConfigPath();
  let promptProvenance: { entries: PromptProvenanceEntry[]; harnessConfigVersion: string | undefined } | undefined;
  let promptProvenanceResolutionFailed = false;
  let promptProvenanceConfiguredSourceFailed = false;
  try {
    const resolved = resolvePromptProvenance(config, projectRoot, stateId, configPath);
    promptProvenance = resolved;
    if (resolved.configuredSourceFailed) {
      // A CONFIGURED/author-declared required source (skill, prompt file) could not
      // be resolved.  Record this flag so the completion gate hard-blocks SUCCESS.
      promptProvenanceConfiguredSourceFailed = true;
      Logger.warn(Component.ORR_ELSE, 'Prompt provenance: a configured required source (skill or prompt file) could not be resolved; gate will hard-block SUCCESS for this run.');
    }
    if (resolved.resolutionFailed) {
      // Unexpected harness-level resolution error — warn-only (agent not penalised).
      promptProvenanceResolutionFailed = true;
      Logger.warn(Component.ORR_ELSE, 'Prompt provenance resolution reported failure; provenance gate will warn-only for this run.');
    }
  } catch (err) {
    // resolvePromptProvenance should not throw (all internal errors are caught),
    // but guard defensively in case something slips through.
    promptProvenanceResolutionFailed = true;
    Logger.warn(Component.ORR_ELSE, `Prompt provenance resolution threw unexpectedly: ${String(err)}. Gate will warn-only for this run.`);
  }

  // Extract restart correlation from the event history (pi-experiment-nyug).
  // If the most recent event for this bead+state is a restart request (and no
  // STATE_RUN_INITIALIZED has followed it yet), carry restartId + previousRunId
  // forward so operators can chain: restart event → this run → terminal outcome.
  // The current worker's sessionStateId serves as the new run's identity (runId).
  let restartCorrelation: { restartId: string; previousRunId?: string } | undefined;
  try {
    const beadEventsForCorrelation = await services.eventStore.eventsForBead(beadId);
    restartCorrelation = extractRestartCorrelation(beadEventsForCorrelation, beadId, stateId);
  } catch (err) {
    Logger.warn(Component.ORR_ELSE, `Failed to extract restart correlation: ${String(err)}`);
  }
  const runId = process.env[EnvVars.SESSION_STATE_ID];

  // Stage the run-init event payload without recording it yet.  The first
  // BEFORE_AGENT_START call will enrich it with finalPromptHash +
  // admittedHarnessFingerprint (both unavailable here, before the Pi base
  // prompt arrives) and then record STATE_RUN_INITIALIZED (AC3).
  session.pendingRunInitPayload = {
    beadId,
    stateId,
    actionId: action.id,
    actionKey: actionCompletionKey(config, stateId, action.id),
    workflowVersion: config.settings.workflowVersion,
    worktreePath,
    requiredChecklistItems: requiredItems.map(item => item.text),
    // Prompt provenance: complementary to STATE_PROMPT_ASSEMBLED (which records an
    // assembled-prompt digest). This records the SOURCE file paths + hashes.
    promptProvenance: promptProvenance
      ? {
          entries: promptProvenance.entries,
          harnessConfigVersion: promptProvenance.harnessConfigVersion
        }
      : undefined,
    // Set when provenance resolution itself failed at init time — signals the
    // completion gate to warn only rather than hard-reject (the agent should not
    // be penalised for a harness resolution error).
    promptProvenanceResolutionFailed: promptProvenanceResolutionFailed || undefined,
    // Set when a CONFIGURED required source (skill, prompt file) could not be
    // resolved — signals the completion gate to hard-block SUCCESS.
    promptProvenanceConfiguredSourceFailed: promptProvenanceConfiguredSourceFailed || undefined,
    // Restart lifecycle correlation (pi-experiment-nyug): present only when this
    // run was initiated by a restart request. runId identifies this worker session.
    runId: runId || undefined,
    restartId: restartCorrelation?.restartId,
    previousRunId: restartCorrelation?.previousRunId
  };
}

// StateSystemPromptResult and buildStateSystemPrompt moved to ./extension/WorkerContextResolver.ts.

/**
 * Combined state + completed-action + route-level requiredTools for the
 * COORDINATOR gate. Returns the unresolved RequiredTool entries for the
 * completing (state, action, transitionEvent); the gate's RequiredToolResolver
 * applies any `when` conditions and de-dupes. Empty list ⇒ unguarded transition
 * (gate is a no-op).
 *
 * pi-experiment-6q0y.46: also merges state.routeEvidence[transitionEvent] so
 * that per-route required-tool evidence is enforced at both advance AND terminal
 * transitions. This is the SINGLE collection point for all required-tool inputs
 * to the gate — no additional check sites needed.
 */
function coordinatorGateRequiredTools(
  config: import('./core/ConfigLoader.js').HarnessConfig,
  stateId: string,
  actionId: string | undefined,
  transitionEvent?: string
): import('./core/domain/StateModels.js').RequiredTool[] {
  const state = config.states[stateId];
  if (!state) return [];
  const action = actionId ? (state.actions || []).find(a => a.id === actionId) : undefined;
  // Merge route-level evidence (case-insensitive key match against transitionEvent).
  let routeTools: import('./core/domain/StateModels.js').RequiredTool[] = [];
  if (transitionEvent && state.routeEvidence) {
    const upperEvent = transitionEvent.toUpperCase();
    const matched = Object.entries(state.routeEvidence).find(
      ([key]) => key.toUpperCase() === upperEvent
    );
    if (matched) routeTools = matched[1];
  }
  return [
    ...(state.requiredTools || []),
    ...(action?.requiredTools || []),
    ...routeTools
  ];
}

/**
 * pi-experiment-6q0y.46 FAIL-CLOSED: Returns true if the config has at least one
 * non-empty evidence declaration (state.requiredTools, action.requiredTools, or
 * routeEvidence) across ALL states.
 *
 * Configs with ZERO evidence declarations are legacy configs that predate the
 * artifact-first system. The fail-closed gate only activates for configs that have
 * opted into the evidence system — otherwise integration tests and minimal test
 * fixtures without evidence would all be blocked.
 */
function configHasAnyEvidence(
  config: import('./core/ConfigLoader.js').HarnessConfig
): boolean {
  for (const state of Object.values(config.states || {})) {
    if ((state.requiredTools || []).length > 0) return true;
    if ((state.actions || []).some(a => (a.requiredTools || []).length > 0)) return true;
    if (state.routeEvidence) {
      if (Object.values(state.routeEvidence).some(tools => (tools || []).length > 0)) return true;
    }
  }
  return false;
}

/**
 * Resolve the worktree path the coordinator gate should use for write-set
 * resolution, reading the latest WORKTREE_PROVISIONED event for the bead. Returns
 * undefined when none is recorded (the gate then falls back to the project root).
 */
async function latestWorktreePathForBead(services: RuntimeServices, beadId: string): Promise<string | undefined> {
  try {
    const events = await services.eventStore.eventsForBead(beadId as import('./types/ids.js').BeadId);
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event.type === DomainEventName.WORKTREE_PROVISIONED) {
        const worktreePath = (event.data as Record<string, unknown> | undefined)?.worktreePath;
        if (typeof worktreePath === 'string' && worktreePath) return worktreePath;
      }
    }
  } catch (error) {
    Logger.warn(Component.ORR_ELSE, 'Failed to resolve worktree path for coordinator gate', { beadId, error: String(error) });
  }
  return undefined;
}

/**
 * pi-experiment-x0zh: v2 deterministic positive transition path.
 *
 * Called by handleTeammateEvent when an ACTION_EVIDENCE_SUBMITTED signal arrives
 * and config.version === 2.  Runs the coordinator's deterministic gate, maps the
 * verdict through the action's emits mapping, emits ROUTE_EVENT_EMITTED, and
 * writes STATE_TRANSITION_APPLIED — all harness-owned, no model-supplied routing.
 *
 * DETERMINISM: no Date.now()/Math.random() in route/verdict/event selection.
 * uuidv7() runtime IDs inside applyV2RouteEvent are correct (not a hash input).
 */
async function applyV2EvidenceDrivenTransition(
  beadId: string,
  event: TeammateEvent,
  config: HarnessConfig,
  services: RuntimeServices,
  session: ExtensionSession,
  ctx: ExtensionContext,
  releaseTool: { execute: (params: unknown) => unknown | Promise<unknown> },
  ack: import('./core/SignalingServer.js').SignalAck | undefined
): Promise<void> {
  const stateId = event.stateId;
  const actionId = (event as unknown as Record<string, unknown>)['actionId'] as string | undefined;
  const state = config.states[stateId];
  const action = actionId ? (state?.actions || []).find(a => a.id === actionId) : undefined;

  // No emits mapping → v2 action has no deterministic route; log and release.
  if (!action?.emits) {
    Logger.warn(Component.ORR_ELSE, 'v2 ACTION_EVIDENCE_SUBMITTED: action has no emits mapping; cannot route', {
      beadId, stateId, actionId
    });
    ack?.send({ pass: false, failures: [], rejectMessage: `v2 action "${actionId}" has no emits mapping; cannot apply deterministic transition` });
    await Promise.resolve(releaseTool.execute({ id: beadId })).catch(() => {});
    session.supervisor?.markBeadExited(beadId as import('./types/ids.js').BeadId);
    return;
  }

  // Resolve required tools for the gate (state + action requiredTools).
  const gateRequiredTools = coordinatorGateRequiredTools(config, stateId, actionId, undefined);

  // Run the deterministic gate.
  let gateOutcome: import('./core/CoordinatorVerifierGate.js').CoordinatorGateOutcome;
  try {
    const worktreePath = await latestWorktreePathForBead(services, beadId);
    gateOutcome = await evaluateCoordinatorGate(
      {
        eventStore: services.eventStore,
        artifactPaths: services.artifactPaths,
        requiredToolResolver: services.requiredToolResolver,
        planWriteSet: services.planWriteSet,
        projectRoot: services.projectRoot,
        config
      },
      {
        beadId,
        stateId,
        actionId: actionId || '',
        requiredTools: gateRequiredTools,
        worktreePath
      }
    );
  } catch (gateError) {
    Logger.error(Component.ORR_ELSE, 'v2 evidence gate threw; treating as fail', { beadId, stateId, actionId, error: String(gateError) });
    gateOutcome = { ran: true, pass: false, failures: [], rejectMessage: String(gateError), perTool: [], evaluatedTools: [] };
  }

  // Map gate verdict to action emits verdict.
  const verdict: import('./core/ActionRouteEventEmitter.js').ActionVerdict =
    (!gateOutcome.ran || gateOutcome.pass) ? 'pass' : 'fail';

  // Build v2 vocabulary + compute next state.
  const v2Vocab = buildV2EventVocabulary(config);
  const emitsEventName = verdict === 'pass' ? action.emits.pass : action.emits.fail;
  const v2NextState = state ? v2ApplyTransition(state, emitsEventName, v2Vocab) : null;

  // Emit ROUTE_EVENT_EMITTED via the hutg contract.
  const configFingerprint = computeConfigFingerprint(services.configLoader.getConfigPath() || 'v2-config');
  const runId = (event as unknown as Record<string, unknown>)['sessionStateId'] as string || uuidv7();
  const routeResult = await emitActionRouteEvent({
    emits: action.emits,
    verdict,
    emitterType: 'gate',
    emitterId: 'evaluateCoordinatorGate',
    beadId,
    stateId,
    actionId: actionId || '',
    runId,
    configFingerprint,
    v2Vocab,
    v2NextState,
    evidenceRefs: [],   // coordinator gate produces no artifact refs; evidence is in the event store
    store: services.eventStore
  });

  if (!routeResult.emitted) {
    Logger.warn(Component.ORR_ELSE, 'v2 evidence gate: emitActionRouteEvent rejected emit', {
      beadId, stateId, actionId, rejectReason: routeResult.rejectReason, verdict
    });
    ack?.send({ pass: false, failures: [], rejectMessage: `v2 route event not emitted: ${routeResult.rejectReason}` });
    await Promise.resolve(releaseTool.execute({ id: beadId })).catch(() => {});
    session.supervisor?.markBeadExited(beadId as import('./types/ids.js').BeadId);
    return;
  }

  // Write STATE_TRANSITION_APPLIED referencing the routeEventId.
  const nextState = routeResult.nextState ?? stateId;
  await services.eventStore.record(DomainEventName.STATE_TRANSITION_APPLIED, {
    beadId,
    workerId: event.workerId,
    sessionStateId: (event as unknown as Record<string, unknown>)['sessionStateId'] as string | undefined,
    idempotencyKey: event.idempotencyKey,
    fromState: stateId,
    nextState,
    transitionEvent: routeResult.transitionKey ?? emitsEventName,
    actionId,
    actionKey: actionId ? actionCompletionKey(config, stateId, actionId) : undefined,
    routeEventId: routeResult.routeEventId,
    v2Driven: true
  });

  Logger.info(Component.ORR_ELSE, 'v2 deterministic transition applied', {
    beadId, stateId, actionId, verdict, nextState, routeEventId: routeResult.routeEventId
  });

  ack?.send({ pass: verdict === 'pass', failures: gateOutcome.failures ?? [], rejectMessage: gateOutcome.rejectMessage ?? '' });

  // Terminal state handling for v2 advance transitions.
  if (verdict === 'pass' && nextState !== stateId && isTerminalState(nextState, config)) {
    const mergeTool = requireTool(services.plugins.git, PluginToolName.MERGE_AND_COMMIT);
    const mergeResult = await mergeTool.execute({ beadId, closeAfterMerge: true, closeReason: 'v2 evidence-driven terminal transition' }, ctx) as MergeResult;
    if (mergeResult.success !== true) {
      await requireTool(services.plugins.bd, PluginToolName.BD_UPDATE_STATUS).execute({
        id: beadId,
        status: BeadStatus.BLOCKED,
        notes: `Harness-owned terminal merge failed (v2): ${JSON.stringify(mergeResult)}`
      }, ctx);
    } else {
      await requireTool(services.plugins.git, PluginToolName.REMOVE_WORKTREE).execute({ beadId, force: true }, ctx);
    }
  }

  await Promise.resolve(releaseTool.execute({ id: beadId })).catch(() => {});
  session.supervisor?.markBeadExited(beadId as import('./types/ids.js').BeadId);
}

async function handleTeammateEvent(pi: ExtensionAPI, ctx: ExtensionContext, event: TeammateEvent, services: RuntimeServices, session: ExtensionSession, ack?: SignalAck) {
  const currentSupervisor = session.supervisor;
  if (!currentSupervisor) return;

  const beadId = event.beadId as BeadId;

  if (event.type === TeammateEventType.HEARTBEAT) {
    Logger.debug(Component.ORR_ELSE, 'Received teammate heartbeat', { beadId: event.beadId, workerId: event.workerId });
    return;
  }

  // AC3 (pi-experiment-0yt5.20): a STATE_TRANSITIONED signal is the only
  // status-mutating completion signal that can hit the COORDINATOR-side verifier
  // gate. Hold the HTTP response SYNCHRONOUSLY (before any await) so the gate's
  // structured verdict round-trips back to the caller instead of a fire-and-forget
  // {ok:true}. Every other signal leaves the response on its immediate path.
  //
  // pi-experiment-x0zh: also hold for STATE_FAILED/STATE_BLOCKED and
  // ACTION_EVIDENCE_SUBMITTED in v2 configs so the v2 rejection and gate verdict
  // round-trips back to the caller synchronously. The config check (version===2)
  // cannot happen here (it requires an await), so we hold pre-emptively for
  // these event types. The ack is released in the appropriate handler branch.
  if (ack && (
    event.type === TeammateEventType.STATE_TRANSITIONED ||
    event.type === TeammateEventType.STATE_FAILED ||
    event.type === TeammateEventType.STATE_BLOCKED ||
    event.type === TeammateEventType.ACTION_EVIDENCE_SUBMITTED
  )) {
    ack.hold();
  }

  const priorEvents = await services.eventStore.eventsForBead(beadId);

  // pi-experiment-6q0y.49 AC7: rebuild loop detector counters from the event
  // store so fingerprint state survives harness/context restart. Called once
  // per bead per event (idempotent: rebuildFromEvents takes the MAX seen count
  // per fingerprint, so re-calling with the same events is safe).
  if (session.loopDetector) {
    session.loopDetector.rebuildFromEvents(priorEvents);
  }

  const appliedEvent = findAppliedTeammateSignal(priorEvents, event);
  const beadProjection = await services.eventStore.projectBead(beadId, { includeDetails: false }).catch((error: unknown) => {
    Logger.warn(Component.ORR_ELSE, 'Failed to project bead during teammate event handling', { beadId, error: String(error) });
    return undefined;
  });
  const currentStateId = beadProjection?.status;
  const processedKeys = new Set<string>();
  if (currentSupervisor.isSignalProcessed(event.idempotencyKey)) processedKeys.add(event.idempotencyKey);
  const decision = appliedEvent
    ? { action: TeammateEventDecisionAction.DUPLICATE, reason: `Signal already applied by ${appliedEvent.type}` }
    : decideTeammateEventProcessing(event, processedKeys, currentStateId);

  await services.eventStore.record(DomainEventName.TEAMMATE_EVENT, {
    ...event,
    processingDecision: decision.action,
    processingReason: decision.reason
  });

  if (decision.action !== TeammateEventDecisionAction.ACCEPT) {
    const logDuplicateDecision = decision.action === TeammateEventDecisionAction.DUPLICATE
      ? Logger.info.bind(Logger)
      : Logger.warn.bind(Logger);
    // Enrich the log with outcome/failure context so operators can distinguish
    // a benign idempotency duplicate from a repeated terminal failure signal.
    const anyEvent = event as unknown as Record<string, unknown>;
    // Rate-limit repeated identical duplicate/out-of-order decisions to ONE log
    // per fingerprint per minute (r06o AC1). Durable TEAMMATE_EVENT records above
    // are NEVER suppressed — only this human-facing log call is coalesced.
    const fp = `${decision.action}:${event.type}:${beadId}:${event.stateId}`;
    const { shouldLog, suppressedCount } = duplicateDecisionCoalescer.observe(fp);
    if (shouldLog) {
      logDuplicateDecision(Component.ORR_ELSE, 'Ignoring teammate signal after durable processing decision', {
        beadId,
        type: event.type,
        stateId: event.stateId,
        idempotencyKey: event.idempotencyKey,
        decision: decision.action,
        reason: decision.reason,
        // Outcome/failure routing context — present on status-mutating events.
        transitionEvent: anyEvent.transitionEvent,
        summary: anyEvent.summary,
        actionId: anyEvent.actionId,
        // The bead's current projected state (may differ from signal's stateId if out-of-order).
        currentStateId,
        // Applied event that triggered the DUPLICATE decision (if projection-derived).
        appliedEventType: appliedEvent?.type,
        ...(suppressedCount > 0 ? { suppressedCount } : {})
      });
    }

    // pi-experiment-6q0y.49: loop detection for repeated coordinator-side DUPLICATE signals.
    // Duplicates still represent the model repeatedly attempting the same failed transition,
    // so loop counters must accumulate even when the coordinator deduplicates the transition.
    if (
      decision.action === TeammateEventDecisionAction.DUPLICATE &&
      session.loopDetector &&
      (event as unknown as Record<string, unknown>).transitionEvent &&
      (event.type === TeammateEventType.STATE_TRANSITIONED ||
       event.type === TeammateEventType.STATE_FAILED ||
       event.type === TeammateEventType.STATE_BLOCKED)
    ) {
      let dupConfig: ReturnType<typeof services.configLoader.load> | undefined;
      try { dupConfig = services.configLoader.load(); } catch { dupConfig = undefined; }
      if (dupConfig) {
        const loopDetector = session.loopDetector;
        const loopCtx = { beadId: beadId as string, stateId: event.stateId, actionId: event.actionId || undefined };
        // For STATE_TRANSITIONED duplicates previously gate-blocked: verifier loop detection.
        if (event.type === TeammateEventType.STATE_TRANSITIONED) {
          const gateBlockedApplied = (appliedEvent?.data as Record<string, unknown> | undefined)?.gateBlocked === true;
          if (gateBlockedApplied) {
            const gateFailures = (appliedEvent?.data as Record<string, unknown> | undefined)?.gateFailures;
            const verifierIds = Array.isArray(gateFailures)
              ? (gateFailures as Array<Record<string, unknown>>).map(f => f.tool).filter(Boolean).sort().join(',')
              : undefined;
            const verifierCheck = loopDetector.checkVerifierFail({
              beadId: beadId as string, stateId: event.stateId, verifierId: verifierIds || undefined,
            });
            if (verifierCheck.exceeded) {
              const firstRoute = await loopDetector.emitLoopDetected(verifierCheck, loopCtx);
              if (firstRoute && verifierCheck.routeEvent) {
                const vfSummary = `Loop detected (${verifierCheck.scope}): repeated verifier failures for "${event.stateId}" (${verifierCheck.count}/${verifierCheck.max}). Route: ${verifierCheck.routeEvent}`;
                const loopRouteEvent = buildWorkerEvent(teammateEventTypeForOutcome(verifierCheck.routeEvent, dupConfig), {
                  beadId: beadId as string, stateId: event.stateId, actionId: event.actionId,
                  transitionEvent: verifierCheck.routeEvent, summary: vfSummary, evidence: vfSummary, handover: vfSummary,
                });
                await postWorkerSignal(services, loopRouteEvent).catch(() => {});
              }
            } else if (verifierCheck.fingerprint && !verifierCheck.warningEmitted && verifierCheck.count !== undefined && verifierCheck.max !== undefined && verifierCheck.count >= verifierCheck.max - 1 && verifierCheck.max > 1) {
              await loopDetector.emitWarning(verifierCheck, loopCtx);
            }
          }
        }
        // For STATE_BLOCKED: check blocker FIRST (summary fingerprint), then failedRoute.
        if (event.type === TeammateEventType.STATE_BLOCKED) {
          const anySignal = event as unknown as Record<string, unknown>;
          const blockerCheck = loopDetector.checkBlocker({
            beadId: beadId as string, stateId: event.stateId,
            summary: (anySignal.summary as string | undefined) || (anySignal.evidence as string | undefined),
          });
          if (blockerCheck.exceeded) {
            const firstRoute = await loopDetector.emitLoopDetected(blockerCheck, loopCtx);
            if (firstRoute && blockerCheck.routeEvent) {
              const bkSummary = `Loop detected (${blockerCheck.scope}): repeated same-state blocker in "${event.stateId}" (${blockerCheck.count}/${blockerCheck.max}). Route: ${blockerCheck.routeEvent}`;
              const loopRouteEvent = buildWorkerEvent(teammateEventTypeForOutcome(blockerCheck.routeEvent, dupConfig), {
                beadId: beadId as string, stateId: event.stateId, actionId: event.actionId,
                transitionEvent: blockerCheck.routeEvent, summary: bkSummary, evidence: bkSummary, handover: bkSummary,
              });
              await postWorkerSignal(services, loopRouteEvent).catch(() => {});
            }
          } else if (blockerCheck.fingerprint && !blockerCheck.warningEmitted && blockerCheck.count !== undefined && blockerCheck.max !== undefined && blockerCheck.count >= blockerCheck.max - 1 && blockerCheck.max > 1) {
            await loopDetector.emitWarning(blockerCheck, loopCtx);
          }
        }
        // For STATE_FAILED/STATE_BLOCKED: failedRoute detection (after blocker for BLOCKED).
        if (event.type === TeammateEventType.STATE_FAILED || event.type === TeammateEventType.STATE_BLOCKED) {
          const failedRouteCheck = loopDetector.checkFailedRoute({
            beadId: beadId as string, stateId: event.stateId, routeEvent: event.transitionEvent,
          });
          if (failedRouteCheck.exceeded) {
            const firstRoute = await loopDetector.emitLoopDetected(failedRouteCheck, loopCtx);
            if (firstRoute && failedRouteCheck.routeEvent) {
              const frSummary = `Loop detected (${failedRouteCheck.scope}): repeated failed route "${event.transitionEvent}" from "${event.stateId}" (${failedRouteCheck.count}/${failedRouteCheck.max}). Route: ${failedRouteCheck.routeEvent}`;
              const loopRouteEvent = buildWorkerEvent(teammateEventTypeForOutcome(failedRouteCheck.routeEvent, dupConfig), {
                beadId: beadId as string, stateId: event.stateId, actionId: event.actionId,
                transitionEvent: failedRouteCheck.routeEvent, summary: frSummary, evidence: frSummary, handover: frSummary,
              });
              await postWorkerSignal(services, loopRouteEvent).catch(() => {});
            }
          } else if (failedRouteCheck.fingerprint && !failedRouteCheck.warningEmitted && failedRouteCheck.count !== undefined && failedRouteCheck.max !== undefined && failedRouteCheck.count >= failedRouteCheck.max - 1 && failedRouteCheck.max > 1) {
            await loopDetector.emitWarning(failedRouteCheck, loopCtx);
          }
        }
      }
    }
    // Release any held ack for the held event types (STATE_FAILED/STATE_BLOCKED
    // held above for v2 verdict round-trip). On the duplicate/ignore path, no
    // verdict → fire-and-forget {ok:true} response equivalent.
    ack?.send();
    return;
  }

  if (ctx.hasUI) ctx.ui.setStatus(Component.ORR_ELSE.toLowerCase(), `Processing ${event.type} for ${beadId}`);

  currentSupervisor.markSignalProcessed(event.idempotencyKey);

  if (event.type === TeammateEventType.TEAMMATE_EXITED) {
    currentSupervisor.markBeadExited(beadId);
    const releaseTool = requireTool(services.plugins.bd, PluginToolName.BD_RELEASE);
    const pauseUntilMs = typeof event.pauseUntilMs === 'number' ? event.pauseUntilMs : undefined;
    if (event.capacityLimited === true && pauseUntilMs) {
      currentSupervisor.pauseSchedulingUntil(pauseUntilMs, event.summary || 'Harness capacity limit reached');
    }
    await Promise.resolve(releaseTool.execute({ id: beadId })).catch((error: unknown) => {
      Logger.warn(Component.ORR_ELSE, 'Unable to release Bead lease after teammate exit', { beadId: beadId, error: String(error) });
    });
    return;
  }

  // ── pi-experiment-x0zh: v2 positive transition path ─────────────────────
  // ACTION_EVIDENCE_SUBMITTED signals are the v2 coordinator gate trigger:
  // worker calls submit_action_evidence → coordinator runs its deterministic
  // gate (evaluateCoordinatorGate) → maps verdict through action emits mapping
  // → emitActionRouteEvent → ROUTE_EVENT_EMITTED → STATE_TRANSITION_APPLIED.
  // No model-supplied route authority.  Version-gated: v1 configs unaffected.
  if (event.type === TeammateEventType.ACTION_EVIDENCE_SUBMITTED) {
    const v2Config = await services.configLoader.load();
    const v2ReleaseTool = requireTool(services.plugins.bd, PluginToolName.BD_RELEASE);
    if (v2Config.version === 2) {
      // ack was already held synchronously at the prelude above.
      await applyV2EvidenceDrivenTransition(
        beadId as string, event, v2Config, services, session, ctx, v2ReleaseTool, ack
      );
    } else {
      // v1: evidence-submitted signal is a no-op at the coordinator level.
      // Release the held ack with no verdict ({ok:true}).
      ack?.send();
      await Promise.resolve(v2ReleaseTool.execute({ id: beadId })).catch(() => {});
      currentSupervisor.markBeadExited(beadId);
    }
    return;
  }

  if (!isStatusMutatingTeammateEvent(event)) return;

  if (ctx.hasUI) {
    ctx.ui.notify(`Teammate ${event.type}: ${beadId}`, event.type === TeammateEventType.STATE_FAILED || event.type === TeammateEventType.STATE_BLOCKED ? 'warning' : 'info');
  }

  Logger.info(Component.ORR_ELSE, `Teammate signal received: ${event.type} for ${beadId}`);

  const config = await services.configLoader.load();
  const releaseTool = requireTool(services.plugins.bd, PluginToolName.BD_RELEASE);

  // ── pi-experiment-x0zh: v2 route-authority stripping for status-mutating signals ──
  // In v2 configs (version === 2) any worker/model-supplied route field on
  // STATE_TRANSITIONED, STATE_FAILED, or STATE_BLOCKED signals is rejected as
  // route authority before projection.  The signal has already been recorded as
  // a TEAMMATE_EVENT (dedup) above — this gate fires AFTER recording to preserve
  // the event log, but BEFORE any workflow state transition or bead status
  // mutation.  A V2_MODEL_ROUTE_REJECTED diagnostic is appended (at most once
  // per attempt).  Only a schema-valid deterministic ROUTE_EVENT_EMITTED may
  // trigger a STATE_TRANSITION_APPLIED in v2.
  //
  // v1 configs (incl. real cerdiwen harness.yaml, no version field) are
  // COMPLETELY UNAFFECTED — this branch only runs when version === 2.
  if (
    config.version === 2 &&
    (event.type === TeammateEventType.STATE_TRANSITIONED ||
     event.type === TeammateEventType.STATE_FAILED ||
     event.type === TeammateEventType.STATE_BLOCKED)
  ) {
    const anyEvent = event as unknown as Record<string, unknown>;
    const rejectedRoute = typeof anyEvent['transitionEvent'] === 'string' ? anyEvent['transitionEvent'] : undefined;
    const surface = event.type === TeammateEventType.STATE_TRANSITIONED
      ? 'STATE_TRANSITIONED'
      : event.type === TeammateEventType.STATE_FAILED
        ? 'STATE_FAILED'
        : 'STATE_BLOCKED';
    Logger.warn(Component.ORR_ELSE, `v2: ${surface} route authority rejected before projection`, {
      beadId, stateId: event.stateId, rejectedRoute
    });
    await services.eventStore.record(DomainEventName.V2_MODEL_ROUTE_REJECTED, {
      beadId,
      stateId: event.stateId,
      actionId: event.actionId || undefined,
      surface,
      rejectedRoute,
      reason: `v2 configs do not permit model-selected route authority via ${surface} signals; routing requires a schema-valid deterministic ROUTE_EVENT_EMITTED`
    }).catch(() => {});
    await Promise.resolve(releaseTool.execute({ id: beadId })).catch((error: unknown) => {
      Logger.warn(Component.ORR_ELSE, 'Unable to release Bead lease after v2 route rejection', { beadId, error: String(error) });
    });
    currentSupervisor.markBeadExited(beadId);
    ack?.send({ pass: false, failures: [], rejectMessage: `v2 route authority rejected: ${surface} signal does not drive state transitions in v2 configs` });
    return;
  }

  if (event.type === TeammateEventType.STATE_TRANSITIONED) {
    const state = config.states[event.stateId];

    // ── AC2: strict-mode undeclared-outcome guard (pi-experiment-lgwk) ───────────
    // The coordinator is the SOLE binding authority.  In strict mode (explicit
    // outcome vocabulary declared) an undeclared transitionEvent must NOT advance,
    // mutate completedActionIds, or record STATE_TRANSITION_APPLIED.  We block
    // immediately — before any state mutation — and surface the rejection so the
    // worker can remediate.
    if (event.transitionEvent) {
      try {
        assertDeclaredOutcome(event.transitionEvent, config, `state "${event.stateId}" [coordinator binding]`);
      } catch (declaredError) {
        Logger.warn(Component.ORR_ELSE, 'Coordinator rejected undeclared outcome — not advancing', {
          beadId,
          stateId: event.stateId,
          transitionEvent: event.transitionEvent,
          error: String(declaredError)
        });
        ack?.send({
          pass: false,
          failures: [{ tool: 'outcome-vocabulary', kind: 'undeclared', verdict: 'FAIL' }],
          rejectMessage: String(declaredError)
        });
        await Promise.resolve(releaseTool.execute({ id: beadId })).catch((error: unknown) => {
          Logger.warn(Component.ORR_ELSE, 'Unable to release Bead lease after undeclared-outcome rejection', { beadId, error: String(error) });
        });
        currentSupervisor.markBeadExited(beadId);
        return;
      }
    }

    // ── COORDINATOR-side artifact-presence gate (pi-experiment-0yt5.20 / 6q0y.46) ──
    // The BINDING authority (decision B): before applying an ADVANCE transition,
    // re-evaluate the completing (state, action) coordinator-side against durable
    // state. A transition declaring NO required tools is a NO-OP (evaluate returns
    // ran:false) so unguarded routing is byte-identical to its prior behaviour.
    // On a block we do NOT advance; we route the bead to BLOCKED via the existing
    // worker-remediation surface (the model picks the recovery edge — failureOutcome
    // is advisory only, never auto-routed).
    //
    // pi-experiment-6q0y.46: coordinatorGateRequiredTools now also merges
    // state.routeEvidence[transitionEvent] so route-level evidence requirements
    // are enforced without a separate check site. Both advance AND terminal
    // transitions run this gate when routeEvidence is configured.
    if (isAdvanceOutcome(event.transitionEvent, config)) {
      const gateRequiredTools = coordinatorGateRequiredTools(config, event.stateId, event.actionId, event.transitionEvent);
      if (gateRequiredTools.length === 0 && configHasAnyEvidence(config)) {
        // pi-experiment-6q0y.46 FAIL-CLOSED: an advance/terminal route with zero
        // evidence (state.requiredTools ∪ action.requiredTools ∪ routeEvidence[outcome]
        // all empty) is REJECTED when the config has opted into the evidence system
        // (at least one state declares non-empty evidence). Prose-only progress is never
        // admitted for configs that use the artifact-first system.
        // The startup lint (ConfigLoader.validateEmptyAdvanceEvidence) catches this
        // at load time; this admission site is the runtime enforcement layer.
        const rejectMessage = `Route "${event.transitionEvent}" on state "${event.stateId}" declares no artifact evidence (requiredTools + routeEvidence are empty). Artifact-first enforcement requires at least one tool in requiredTools or routeEvidence for every advance/terminal route.`;
        Logger.warn(Component.ORR_ELSE, 'Advance route BLOCKED — zero evidence declared (fail-closed)', {
          beadId, stateId: event.stateId, actionId: event.actionId, route: event.transitionEvent
        });
        await services.eventStore.record(DomainEventName.ROUTE_ADMISSION_REJECTED, {
          beadId,
          stateId: event.stateId,
          actionId: event.actionId || '',
          routeEvent: event.transitionEvent,
          missingIds: [],
          remediationHint: rejectMessage
        }).catch(() => {});
        ack?.send({ pass: false, failures: [], rejectMessage });
        await services.eventStore.record(DomainEventName.STATE_TRANSITION_APPLIED, {
          beadId,
          workerId: event.workerId,
          sessionStateId: event.sessionStateId,
          idempotencyKey: event.idempotencyKey,
          fromState: event.stateId,
          nextState: event.stateId,
          transitionEvent: event.transitionEvent,
          actionId: event.actionId,
          actionKey: event.actionId ? actionCompletionKey(config, event.stateId, event.actionId) : undefined,
          summary: event.summary,
          evidence: event.evidence,
          handover: event.handover,
          gateBlocked: true,
          gateFailures: [],
          gateRejectMessage: rejectMessage
        });
        const updateStatusZero = services.plugins.bd.tools.find(t => t.name === PluginToolName.BD_UPDATE_STATUS);
        if (updateStatusZero) {
          await Promise.resolve(updateStatusZero.execute({
            id: beadId,
            status: BeadStatus.BLOCKED,
            notes: `Artifact-first fail-closed: no evidence declared for advance route ${event.stateId}/${event.transitionEvent}`
          }, ctx)).catch((error: unknown) => {
            Logger.warn(Component.ORR_ELSE, 'Failed to persist BLOCKED status after zero-evidence rejection', {
              beadId, stateId: event.stateId, error: String(error)
            });
          });
        }
        await Promise.resolve(releaseTool.execute({ id: beadId })).catch((error: unknown) => {
          Logger.warn(Component.ORR_ELSE, 'Unable to release Bead lease after zero-evidence rejection', { beadId, error: String(error) });
        });
        currentSupervisor.markBeadExited(beadId);
        return;
      } else if (gateRequiredTools.length > 0) {
        const worktreePath = await latestWorktreePathForBead(services, beadId);
        const gateOutcome = await evaluateCoordinatorGate(
          {
            eventStore: services.eventStore,
            artifactPaths: services.artifactPaths,
            requiredToolResolver: services.requiredToolResolver,
            planWriteSet: services.planWriteSet,
            projectRoot: services.projectRoot,
            config
          },
          {
            beadId,
            stateId: event.stateId,
            actionId: event.actionId || '',
            requiredTools: gateRequiredTools,
            worktreePath
          }
        );

        if (gateOutcome.ran && !gateOutcome.pass) {
          // pi-experiment-6q0y.48: route verifier failure count through the
          // RuntimeBudgetTracker (unified mechanism — replaces the former parallel
          // session.verifierFailureCounts raw counter). One tracker per bead is
          // created on first failure; reused on subsequent failures.
          {
            let verifierTracker = session.verifierBudgetTrackers.get(beadId as string);
            if (!verifierTracker) {
              const newTracker = createRuntimeBudgetTracker(config, {
                beadId: beadId as string,
                stateId: event.stateId,
                actionId: event.actionId || undefined,
                clock: systemClock,
              });
              if (newTracker) {
                verifierTracker = newTracker;
                // Persist so the count accumulates across subsequent gate failures.
                session.verifierBudgetTrackers.set(beadId as string, verifierTracker);
              }
            }
            if (verifierTracker) {
              verifierTracker.recordVerifierFailure();
              const verifierBudgetCheck = verifierTracker.checkPreVerifier();
              if (verifierBudgetCheck.exceeded) {
                await verifierTracker.emitExceededEvent(verifierBudgetCheck, services.eventStore);
                Logger.warn(Component.ORR_ELSE, 'Runtime budget exceeded: maxVerifierFailures — routing bead', {
                  beadId, stateId: event.stateId, dimension: 'verifierFailureCount',
                  currentValue: verifierBudgetCheck.currentValue, limit: verifierBudgetCheck.limit,
                  route: verifierBudgetCheck.route,
                });
                // Route through configured outcome (AC4).
                const budgetRoute = verifierBudgetCheck.route!;
                const summary = `Runtime budget exceeded (verifierFailureCount: ${verifierBudgetCheck.currentValue} >= ${verifierBudgetCheck.limit}). Route: ${budgetRoute}`;
                const routeEvent = buildWorkerEvent(teammateEventTypeForOutcome(budgetRoute, config), {
                  beadId: beadId as string, stateId: event.stateId, actionId: event.actionId,
                  transitionEvent: budgetRoute, summary, evidence: summary, handover: summary,
                });
                await postWorkerSignal(services, routeEvent).catch(() => {});
              }
            }
          }

          // pi-experiment-6q0y.49: always-on loop detection for verifier failures (AC3 class 4).
          {
            const loopDetector = session.loopDetector;
            if (loopDetector) {
              const verifierIds = gateOutcome.failures.map(f => f.tool).sort().join(',');
              const loopCtx = { beadId: beadId as string, stateId: event.stateId, actionId: event.actionId || undefined };
              const verifierCheck = loopDetector.checkVerifierFail({
                beadId: beadId as string, stateId: event.stateId, verifierId: verifierIds || undefined,
              });
              if (verifierCheck.exceeded) {
                // AC5: emit route exactly once per fingerprint (routed-once guard).
                const firstRoute = await loopDetector.emitLoopDetected(verifierCheck, loopCtx);
                if (firstRoute && verifierCheck.routeEvent) {
                  const summary = `Loop detected (${verifierCheck.scope}): repeated verifier failures for "${event.stateId}" (${verifierCheck.count}/${verifierCheck.max}). Route: ${verifierCheck.routeEvent}`;
                  const loopRouteEvent = buildWorkerEvent(teammateEventTypeForOutcome(verifierCheck.routeEvent, config), {
                    beadId: beadId as string, stateId: event.stateId, actionId: event.actionId,
                    transitionEvent: verifierCheck.routeEvent, summary, evidence: summary, handover: summary,
                  });
                  await postWorkerSignal(services, loopRouteEvent).catch(() => {});
                }
              } else if (verifierCheck.fingerprint && !verifierCheck.warningEmitted && verifierCheck.count !== undefined && verifierCheck.max !== undefined && verifierCheck.count >= verifierCheck.max - 1 && verifierCheck.max > 1) {
                await loopDetector.emitWarning(verifierCheck, loopCtx);
              }
            }
          }

          Logger.warn(Component.ORR_ELSE, 'Coordinator verifier gate BLOCKED the transition', {
            beadId,
            stateId: event.stateId,
            actionId: event.actionId,
            failures: gateOutcome.failures.map(f => ({ tool: f.tool, kind: f.kind, verdict: f.verdict })),
            evaluatedTools: gateOutcome.evaluatedTools
          });

          // pi-experiment-6q0y.46 AC3: emit ROUTE_ADMISSION_REJECTED BEFORE
          // sending the ack so the event is durable when the response arrives.
          // No raw prompt or tool-output bodies — only identity + missing IDs + hint.
          {
            const missingIds = gateOutcome.failures.map(f => f.tool);
            const remediationHint = `Route "${event.transitionEvent}" requires artifact evidence. Invoke the required tools and produce their artifacts before re-signaling. Missing: ${missingIds.join(', ')}.`;
            await services.eventStore.record(DomainEventName.ROUTE_ADMISSION_REJECTED, {
              beadId,
              stateId: event.stateId,
              actionId: event.actionId || '',
              routeEvent: event.transitionEvent,
              missingIds,
              remediationHint
            }).catch(() => {});
          }

          // AC3: round-trip the structured rejection to the caller SYNCHRONOUSLY
          // (before the slow BLOCKED-status side effects) so the worker receives
          // the verdict + reasons and can remediate — not a bare {ok:true}.
          ack?.send({
            pass: false,
            failures: gateOutcome.failures,
            rejectMessage: gateOutcome.rejectMessage
          });

          // Block: record a STATE_TRANSITION_APPLIED that does NOT advance (the
          // bead stays in its current state — a self-loop) and persist BLOCKED
          // status carrying the structured reject so the model can remediate and
          // pick a recovery edge. This reuses the existing block surface; no new
          // routing path is invented.
          await services.eventStore.record(DomainEventName.STATE_TRANSITION_APPLIED, {
            beadId,
            workerId: event.workerId,
            sessionStateId: event.sessionStateId,
            idempotencyKey: event.idempotencyKey,
            fromState: event.stateId,
            nextState: event.stateId,
            transitionEvent: event.transitionEvent,
            actionId: event.actionId,
            actionKey: event.actionId ? actionCompletionKey(config, event.stateId, event.actionId) : undefined,
            summary: event.summary,
            evidence: event.evidence,
            handover: event.handover,
            gateBlocked: true,
            gateFailures: gateOutcome.failures,
            gateRejectMessage: gateOutcome.rejectMessage
          });

          const updateStatus = services.plugins.bd.tools.find(t => t.name === PluginToolName.BD_UPDATE_STATUS);
          if (updateStatus) {
            await Promise.resolve(updateStatus.execute({
              id: beadId,
              status: BeadStatus.BLOCKED,
              notes: `Coordinator verifier gate blocked ${event.stateId}/${event.actionId || ''}: ${gateOutcome.rejectMessage}`
            }, ctx)).catch((error: unknown) => {
              Logger.warn(Component.ORR_ELSE, 'Failed to persist BLOCKED status after coordinator gate block', {
                beadId, stateId: event.stateId, error: String(error)
              });
            });
          }

          await Promise.resolve(releaseTool.execute({ id: beadId })).catch((error: unknown) => {
            Logger.warn(Component.ORR_ELSE, 'Unable to release Bead lease after coordinator gate block', { beadId, error: String(error) });
          });
          currentSupervisor.markBeadExited(beadId);
          return;
        }

        // AC3: the gate ran and PASSed — round-trip the advance verdict to the
        // caller before continuing the (slow) advance side effects.
        if (gateOutcome.ran) {
          ack?.send({ pass: true, failures: [], rejectMessage: '' });
        }
      }
    } else if (event.transitionEvent) {
      // ── pi-experiment-6q0y.46: routeEvidence gate for NON-advance routes ──
      // Non-advance routes (custom, failed, blocked) may also declare routeEvidence.
      // We run the same coordinator gate when routeEvidence is configured for this
      // route — so the artifact-first invariant covers EVERY configured route, not
      // just advance outcomes. The gate is a NO-OP (ran:false) when no routeEvidence
      // is declared for this route.
      const nonAdvanceRouteTools = coordinatorGateRequiredTools(config, event.stateId, event.actionId, event.transitionEvent);
      // Only run if there are route-level tools (state/action-level requiredTools
      // are advance-outcome-only by design; only routeEvidence applies here).
      const stateForRoute = config.states[event.stateId];
      const hasRouteEvidence = stateForRoute?.routeEvidence &&
        Object.keys(stateForRoute.routeEvidence).some(
          k => k.toUpperCase() === (event.transitionEvent || '').toUpperCase()
        );
      if (hasRouteEvidence && nonAdvanceRouteTools.length > 0) {
        const worktreePath = await latestWorktreePathForBead(services, beadId);
        const routeGateOutcome = await evaluateCoordinatorGate(
          {
            eventStore: services.eventStore,
            artifactPaths: services.artifactPaths,
            requiredToolResolver: services.requiredToolResolver,
            planWriteSet: services.planWriteSet,
            projectRoot: services.projectRoot,
            config
          },
          {
            beadId,
            stateId: event.stateId,
            actionId: event.actionId || '',
            requiredTools: nonAdvanceRouteTools,
            worktreePath
          }
        );
        if (routeGateOutcome.ran && !routeGateOutcome.pass) {
          const missingIds = routeGateOutcome.failures.map(f => f.tool);
          const remediationHint = `Route "${event.transitionEvent}" requires artifact evidence. Invoke the required tools and produce their artifacts before re-signaling. Missing: ${missingIds.join(', ')}.`;
          // AC3: no-body rejection event — only identity + missing IDs + hint.
          await services.eventStore.record(DomainEventName.ROUTE_ADMISSION_REJECTED, {
            beadId,
            stateId: event.stateId,
            actionId: event.actionId || '',
            routeEvent: event.transitionEvent,
            missingIds,
            remediationHint
          }).catch(() => {});
          Logger.warn(Component.ORR_ELSE, 'Route admission gate BLOCKED non-advance transition', {
            beadId, stateId: event.stateId, actionId: event.actionId,
            routeEvent: event.transitionEvent, missingIds
          });
          ack?.send({
            pass: false,
            failures: routeGateOutcome.failures,
            rejectMessage: routeGateOutcome.rejectMessage
          });
          await services.eventStore.record(DomainEventName.STATE_TRANSITION_APPLIED, {
            beadId,
            workerId: event.workerId,
            sessionStateId: event.sessionStateId,
            idempotencyKey: event.idempotencyKey,
            fromState: event.stateId,
            nextState: event.stateId,
            transitionEvent: event.transitionEvent,
            actionId: event.actionId,
            actionKey: event.actionId ? actionCompletionKey(config, event.stateId, event.actionId) : undefined,
            summary: event.summary,
            evidence: event.evidence,
            handover: event.handover,
            gateBlocked: true,
            gateFailures: routeGateOutcome.failures,
            gateRejectMessage: routeGateOutcome.rejectMessage
          });
          const updateStatus = services.plugins.bd.tools.find(t => t.name === PluginToolName.BD_UPDATE_STATUS);
          if (updateStatus) {
            await Promise.resolve(updateStatus.execute({
              id: beadId,
              status: BeadStatus.BLOCKED,
              notes: `Route admission gate blocked ${event.stateId}/${event.transitionEvent}: ${routeGateOutcome.rejectMessage}`
            }, ctx)).catch(() => {});
          }
          await Promise.resolve(releaseTool.execute({ id: beadId })).catch(() => {});
          currentSupervisor.markBeadExited(beadId);
          return;
        }
      }
    }

    const actionKey = event.actionId ? actionCompletionKey(config, event.stateId, event.actionId) : undefined;
    const bead = await requireTool(services.plugins.bd, PluginToolName.BD_GET_BEAD).execute({ id: beadId, includeDetails: true }) as Bead;
    const completedActionIds = isAdvanceOutcome(event.transitionEvent, config)
      ? appendCompletedActionId(bead.completedActionIds || [], event.stateId, event.actionId, config)
      : (bead.completedActionIds || []);
    const nextAction = state && isAdvanceOutcome(event.transitionEvent, config)
      ? nextSequencedAction(config, event.stateId, state, event.actionId, completedActionIds)
      : undefined;

    if (nextAction) {
      await services.eventStore.record(DomainEventName.STATE_TRANSITION_APPLIED, {
        beadId,
        workerId: event.workerId,
        sessionStateId: event.sessionStateId,
        idempotencyKey: event.idempotencyKey,
        fromState: event.stateId,
        nextState: event.stateId,
        nextActionId: nextAction.id,
        transitionEvent: event.transitionEvent,
        actionId: event.actionId,
        actionKey,
        summary: event.summary,
        evidence: event.evidence,
        handover: event.handover
      });

      await Promise.resolve(releaseTool.execute({ id: beadId })).catch((error: unknown) => {
        Logger.warn(Component.ORR_ELSE, 'Unable to release Bead lease after sequenced action', { beadId: beadId, error: String(error) });
      });
      currentSupervisor.markBeadExited(beadId);
      return;
    }

    const nextState = state ? services.flowManager.nextState(state, event.transitionEvent, event.stateId) : event.stateId;
    const transitionEventData = {
      beadId,
      workerId: event.workerId,
      sessionStateId: event.sessionStateId,
      idempotencyKey: event.idempotencyKey,
      fromState: event.stateId,
      nextState,
      transitionEvent: event.transitionEvent,
      actionId: event.actionId,
      actionKey,
      summary: event.summary,
      evidence: event.evidence,
      handover: event.handover
    };

    // pi-experiment-3b5e: fail-closed dispatch-side validation for terminal/state transitions.
    // The terminalTransition schema guards STATE_TRANSITION_APPLIED records before they
    // are written to the event log. A malformed payload is a deterministic BLOCKED signal —
    // the record is NOT written and the coordinator throws rather than advancing state silently.
    const terminalValidation = validateHandoffPayload(
      HandoffSchemaId.TERMINAL_TRANSITION,
      transitionEventData,
      { beadId, stateId: event.stateId, actionId: event.actionId }
    );
    if (!terminalValidation.valid) {
      const { diagnostic } = terminalValidation;
      Logger.error(Component.ORR_ELSE, 'Dispatch-side terminalTransition schema validation FAILED — blocking record', {
        beadId,
        stateId: event.stateId,
        actionId: event.actionId,
        schemaId: diagnostic.schemaId,
        failurePath: diagnostic.failurePath
      });
      throw new Error(
        `Handoff schema violation [${diagnostic.schemaId}] for beadId=${beadId} stateId=${event.stateId} actionId=${event.actionId ?? ''}: ${diagnostic.failurePath.join('; ')}`
      );
    }

    await services.eventStore.record(DomainEventName.STATE_TRANSITION_APPLIED, transitionEventData);

    // pi-experiment-6q0y.49 AC3b: reset loop counters on genuine state progress.
    // A loop is "stuck repeating within a state without progressing"; once the bead
    // advances to a new state, all prior loop accumulators are stale.
    if (isAdvanceOutcome(event.transitionEvent, config) && nextState !== event.stateId) {
      session.loopDetector?.resetOnAdvance(beadId as string);
    }

    if (isTerminalState(nextState, config) && isAdvanceOutcome(event.transitionEvent, config)) {
      const mergeTool = requireTool(services.plugins.git, PluginToolName.MERGE_AND_COMMIT);
      const mergeResult = await mergeTool.execute({
        beadId,
        closeAfterMerge: true,
        closeReason: event.summary
      }, ctx) as MergeResult;
      if (mergeResult.success !== true) {
        await requireTool(services.plugins.bd, PluginToolName.BD_UPDATE_STATUS).execute({
          id: beadId,
          status: BeadStatus.BLOCKED,
          notes: `Harness-owned terminal merge failed: ${JSON.stringify(mergeResult)}`
        }, ctx);
        await Promise.resolve(releaseTool.execute({ id: beadId })).catch((error: unknown) => {
          Logger.warn(Component.ORR_ELSE, 'Unable to release Bead lease after merge failure', { beadId: beadId, error: String(error) });
        });
        currentSupervisor.markBeadExited(beadId);
        return;
      }

      await requireTool(services.plugins.git, PluginToolName.REMOVE_WORKTREE).execute({ beadId, force: true }, ctx);
      currentSupervisor.markBeadExited(beadId);
      return;
    }
  }

  if (event.type === TeammateEventType.STATE_FAILED || event.type === TeammateEventType.STATE_BLOCKED) {
    const state = config.states[event.stateId];
    const nextState = state ? services.flowManager.nextState(state, event.transitionEvent, event.stateId) : event.stateId;
    await services.eventStore.record(DomainEventName.STATE_TRANSITION_APPLIED, {
      beadId,
      workerId: event.workerId,
      sessionStateId: event.sessionStateId,
      idempotencyKey: event.idempotencyKey,
      fromState: event.stateId,
      nextState,
      transitionEvent: event.transitionEvent,
      actionId: event.actionId,
      actionKey: event.actionId ? actionCompletionKey(config, event.stateId, event.actionId) : undefined,
      summary: event.summary,
      evidence: event.evidence,
      handover: event.handover
    });

    // pi-experiment-6q0y.49: always-on loop detection for failed route events (AC3 class 3).
    // A STATE_FAILED/STATE_BLOCKED that keeps re-entering the SAME route from the SAME state
    // is a structural loop — the model/worker is stuck on the same failure pattern.
    {
      const loopDetector = session.loopDetector;
      if (loopDetector && event.transitionEvent) {
        const loopCtx = { beadId: beadId as string, stateId: event.stateId, actionId: event.actionId || undefined };
        const failedRouteCheck = loopDetector.checkFailedRoute({
          beadId: beadId as string, stateId: event.stateId, routeEvent: event.transitionEvent,
        });
        if (failedRouteCheck.exceeded) {
          // AC5: emit route exactly once per fingerprint (routed-once guard).
          const firstRoute = await loopDetector.emitLoopDetected(failedRouteCheck, loopCtx);
          if (firstRoute && failedRouteCheck.routeEvent) {
            const summary = `Loop detected (${failedRouteCheck.scope}): repeated failed route "${event.transitionEvent}" from "${event.stateId}" (${failedRouteCheck.count}/${failedRouteCheck.max}). Route: ${failedRouteCheck.routeEvent}`;
            const loopRouteEvent = buildWorkerEvent(teammateEventTypeForOutcome(failedRouteCheck.routeEvent, config), {
              beadId: beadId as string, stateId: event.stateId, actionId: event.actionId,
              transitionEvent: failedRouteCheck.routeEvent, summary, evidence: summary, handover: summary,
            });
            await postWorkerSignal(services, loopRouteEvent).catch(() => {});
          }
        } else if (failedRouteCheck.fingerprint && !failedRouteCheck.warningEmitted && failedRouteCheck.count !== undefined && failedRouteCheck.max !== undefined && failedRouteCheck.count >= failedRouteCheck.max - 1 && failedRouteCheck.max > 1) {
          await loopDetector.emitWarning(failedRouteCheck, loopCtx);
        }
      }
    }

    if (shouldPersistBlockedBeadStatus(event.type, nextState, config)) {
      const updateStatus = services.plugins.bd.tools.find(t => t.name === PluginToolName.BD_UPDATE_STATUS);
      if (updateStatus) {
        await Promise.resolve(updateStatus.execute({
          id: beadId,
          status: BeadStatus.BLOCKED,
          notes: `Blocked in ${event.stateId} via ${event.transitionEvent}: ${event.summary}`
        }, ctx)).catch(error => {
          Logger.warn(Component.ORR_ELSE, 'Failed to update bead status after blocked teammate outcome', {
            beadId,
            stateId: event.stateId,
            transitionEvent: event.transitionEvent,
            error: String(error)
          });
        });
      }
    }

    // pi-experiment-6q0y.49: always-on blocker loop detection (AC3 class 5).
    // Self-loops with the same blocker summary fingerprint are structural loops.
    if (nextState === event.stateId) {
      const loopDetector = session.loopDetector;
      if (loopDetector) {
        const loopCtx = { beadId: beadId as string, stateId: event.stateId, actionId: event.actionId || undefined };
        const blockerCheck = loopDetector.checkBlocker({
          beadId: beadId as string, stateId: event.stateId, summary: event.summary || event.evidence,
        });
        if (blockerCheck.exceeded) {
          // AC5: emit route exactly once per fingerprint (routed-once guard).
          const firstRoute = await loopDetector.emitLoopDetected(blockerCheck, loopCtx);
          if (firstRoute && blockerCheck.routeEvent) {
            const summary = `Loop detected (${blockerCheck.scope}): repeated same-state blocker in "${event.stateId}" (${blockerCheck.count}/${blockerCheck.max}). Route: ${blockerCheck.routeEvent}`;
            const loopRouteEvent = buildWorkerEvent(teammateEventTypeForOutcome(blockerCheck.routeEvent, config), {
              beadId: beadId as string, stateId: event.stateId, actionId: event.actionId,
              transitionEvent: blockerCheck.routeEvent, summary, evidence: summary, handover: summary,
            });
            await postWorkerSignal(services, loopRouteEvent).catch(() => {});
          }
        } else if (blockerCheck.fingerprint && !blockerCheck.warningEmitted && blockerCheck.count !== undefined && blockerCheck.max !== undefined && blockerCheck.count >= blockerCheck.max - 1 && blockerCheck.max > 1) {
          await loopDetector.emitWarning(blockerCheck, loopCtx);
        }
      }
    }

    // Cycle-cap escalation. A self-loop with the same blocker means the LLM
    // is grinding on something it can't unblock alone.
    if (nextState === event.stateId) {
      const fingerprint = (event.summary || event.evidence || '').slice(0, 200);
      const cycleKey = `${beadId}|${event.stateId}|${fingerprint}`;
      // Sweep counters for OTHER fingerprints in this (bead, state) — once we
      // change blocker reason, any prior streak no longer matches the rule.
      for (const key of session.stateCycleCounter.keys()) {
        if (key.startsWith(`${beadId}|${event.stateId}|`) && key !== cycleKey) {
          session.stateCycleCounter.delete(key);
        }
      }
      const next = (session.stateCycleCounter.get(cycleKey) ?? 0) + 1;
      session.stateCycleCounter.set(cycleKey, next);
      const cap = config.settings.cycleCap ?? CYCLE_CAP_DEFAULT;
      if (next >= cap) {
        Logger.warn(Component.ORR_ELSE, 'Cycle cap reached; escalating bead to TeamLead', {
          beadId, stateId: event.stateId, cycle: next, fingerprint
        });
        const sendMessage = services.plugins.mailbox.tools.find(t => t.name === PluginToolName.SEND_MAILBOX_MESSAGE);
        if (sendMessage) {
          await Promise.resolve(sendMessage.execute({
            to: 'TeamLead',
            beadId,
            type: 'BLOCKER',
            content: `Cycle cap reached: ${beadId} re-entered ${event.stateId} ${next} times with the same blocker. Latest blocker: ${fingerprint}`
          })).catch(error => {
            Logger.warn(Component.ORR_ELSE, 'Failed to send cycle-cap mailbox message', { error: String(error) });
          });
        }
        const updateStatus = services.plugins.bd.tools.find(t => t.name === PluginToolName.BD_UPDATE_STATUS);
        if (updateStatus) {
          await Promise.resolve(updateStatus.execute({
            id: beadId,
            status: BeadStatus.BLOCKED,
            notes: `Auto-blocked after ${next} same-blocker re-entries in ${event.stateId}. Last blocker: ${fingerprint}`
          })).catch(error => {
            Logger.warn(Component.ORR_ELSE, 'Failed to update bead status after cycle cap', { error: String(error) });
          });
        }
        session.stateCycleCounter.delete(cycleKey);
      }
    } else {
      // Bead is leaving this state — drop any cycle counters scoped to it.
      for (const key of session.stateCycleCounter.keys()) {
        if (key.startsWith(`${beadId}|${event.stateId}|`)) session.stateCycleCounter.delete(key);
      }
    }
  }

  if (event.type === TeammateEventType.CONTEXT_RESTART_REQUESTED) {
    const state = config.states[event.stateId];
    const nextState = services.flowManager.restartTargetState(state, event.stateId, event.transitionEvent);
    const beadEventsForRestart = await services.eventStore.eventsForBead(beadId);
    const restartAttempt = computeRestartAttempt(beadEventsForRestart, beadId, event.stateId);

    // pi-experiment-6q0y.36: evidence-aware handoff validation before admission.
    // A restart carrying ONLY narrative (no evidenceRefs, no handoff/compaction
    // artifact) is REJECTED here — before signal/event admission (AC1/AC3).
    // Validation is fail-closed: any rejection blocks the record write.
    {
      const anyEvent = event as unknown as Record<string, unknown>;
      const evidenceRefs = Array.isArray(anyEvent.evidenceRefs)
        ? (anyEvent.evidenceRefs as RestartEvidenceRef[])
        : [];
      const handoverArtifactPath =
        typeof anyEvent.handoverArtifactPath === 'string'
          ? anyEvent.handoverArtifactPath
          : undefined;
      const contract: RestartHandoffContract = {
        evidenceRefs,
        handoverArtifactPath,
        narrativeSummary: event.summary
      };
      const validationResult = validateRestartHandoffContract(contract, beadEventsForRestart);
      if (!validationResult.admitted) {
        const reasons = validationResult.rejections.map(r => `${r.reason}: ${r.diagnostic}`).join(' | ');
        Logger.warn(Component.ORR_ELSE, 'CONTEXT_RESTART_REQUESTED rejected: evidence-aware handoff validation failed', {
          beadId,
          stateId: event.stateId,
          actionId: event.actionId,
          rejections: validationResult.rejections.map(r => r.reason),
          diagnostic: reasons
        });
        await services.eventStore.record(DomainEventName.RESTART_HANDOFF_REJECTED, {
          beadId,
          stateId: event.stateId,
          actionId: event.actionId ?? undefined,
          transitionEvent: event.transitionEvent,
          idempotencyKey: event.idempotencyKey,
          rejections: validationResult.rejections.map(r => ({ reason: r.reason, diagnostic: r.diagnostic })),
          diagnostic: reasons
        }).catch(() => {});
        ack?.send();
        await Promise.resolve(releaseTool.execute({ id: beadId })).catch((error: unknown) => {
          Logger.warn(Component.ORR_ELSE, 'Unable to release Bead lease after restart rejection', { beadId, error: String(error) });
        });
        currentSupervisor.markBeadExited(beadId);
        return;
      }

      // Admitted: build evidence-aware event payload (AC4: narrative stored separately).
      const compactionPointer = resolveCompactionPointer(beadEventsForRestart);
      const restartPayload = buildRestartEventPayload({
        beadId: String(beadId),
        workerId: String(event.workerId),
        sessionStateId: event.sessionStateId,
        idempotencyKey: event.idempotencyKey,
        stateId: event.stateId,
        targetState: nextState,
        transitionEvent: event.transitionEvent,
        actionId: event.actionId,
        narrativeSummary: event.summary,
        narrativeHandover: event.handover,
        evidenceRefs,
        handoverArtifactPath,
        compactionPointer,
        restartId: deriveRestartId(event.idempotencyKey),
        previousRunId: event.sessionStateId,
        attempt: restartAttempt
      });
      await services.eventStore.record(DomainEventName.CONTEXT_RESTART_REQUESTED, restartPayload);
      // Fall through to cleanup (ack?.send, releaseTool, markBeadExited).
    }
  }

  if (event.type === TeammateEventType.HARNESS_RESTART_REQUESTED) {
    const state = config.states[event.stateId];
    const nextState = services.flowManager.restartTargetState(state, event.stateId, event.transitionEvent);
    const beadEventsForRestart = await services.eventStore.eventsForBead(beadId);
    const restartAttempt = computeRestartAttempt(beadEventsForRestart, beadId, event.stateId);

    // pi-experiment-6q0y.36: evidence-aware handoff validation before admission.
    // Same gate as CONTEXT_RESTART_REQUESTED (AC1/AC3).
    {
      const anyEvent = event as unknown as Record<string, unknown>;
      const evidenceRefs = Array.isArray(anyEvent.evidenceRefs)
        ? (anyEvent.evidenceRefs as RestartEvidenceRef[])
        : [];
      const handoverArtifactPath =
        typeof anyEvent.handoverArtifactPath === 'string'
          ? anyEvent.handoverArtifactPath
          : undefined;
      const contract: RestartHandoffContract = {
        evidenceRefs,
        handoverArtifactPath,
        narrativeSummary: event.summary
      };
      const validationResult = validateRestartHandoffContract(contract, beadEventsForRestart);
      if (!validationResult.admitted) {
        const reasons = validationResult.rejections.map(r => `${r.reason}: ${r.diagnostic}`).join(' | ');
        Logger.warn(Component.ORR_ELSE, 'HARNESS_RESTART_REQUESTED rejected: evidence-aware handoff validation failed', {
          beadId,
          stateId: event.stateId,
          actionId: event.actionId,
          rejections: validationResult.rejections.map(r => r.reason),
          diagnostic: reasons
        });
        await services.eventStore.record(DomainEventName.RESTART_HANDOFF_REJECTED, {
          beadId,
          stateId: event.stateId,
          actionId: event.actionId ?? undefined,
          transitionEvent: event.transitionEvent,
          idempotencyKey: event.idempotencyKey,
          rejections: validationResult.rejections.map(r => ({ reason: r.reason, diagnostic: r.diagnostic })),
          diagnostic: reasons
        }).catch(() => {});
        ack?.send();
        await Promise.resolve(releaseTool.execute({ id: beadId })).catch((error: unknown) => {
          Logger.warn(Component.ORR_ELSE, 'Unable to release Bead lease after restart rejection', { beadId, error: String(error) });
        });
        currentSupervisor.markBeadExited(beadId);
        return;
      }

      // Admitted: build evidence-aware event payload (AC4: narrative stored separately).
      const compactionPointer = resolveCompactionPointer(beadEventsForRestart);
      const restartPayload = buildRestartEventPayload({
        beadId: String(beadId),
        workerId: String(event.workerId),
        sessionStateId: event.sessionStateId,
        idempotencyKey: event.idempotencyKey,
        stateId: event.stateId,
        targetState: nextState,
        transitionEvent: event.transitionEvent,
        actionId: event.actionId,
        narrativeSummary: event.summary,
        narrativeHandover: event.handover,
        evidenceRefs,
        handoverArtifactPath,
        compactionPointer,
        restartId: deriveRestartId(event.idempotencyKey),
        previousRunId: event.sessionStateId,
        attempt: restartAttempt
      });
      await services.eventStore.record(DomainEventName.HARNESS_RESTART_REQUESTED, restartPayload);
      // Fall through to cleanup (ack?.send, releaseTool, markBeadExited).
    }
  }

  // pi-experiment-x0zh: release any held ack for STATE_FAILED/STATE_BLOCKED
  // (now held synchronously for v2 verdict round-trip). In v1 configs this is
  // a no-op send (no verdict = {ok:true} response, preserving existing behavior).
  // In v2 configs the ack was already sent by the stripping block (returns early).
  ack?.send();

  await Promise.resolve(releaseTool.execute({ id: beadId })).catch((error: unknown) => {
    Logger.warn(Component.ORR_ELSE, 'Unable to release Bead lease after event', { beadId: beadId, error: String(error) });
  });
  currentSupervisor.markBeadExited(beadId);
}

interface ProjectToolStatusSummary {
  total: number;
  mcpBacked: number;
  mcpBackedToolNames: string[];
  command: number;
  nativeExtension: number;
  nativeMcpFooterMeaning: string;
}

interface ActiveAssignmentSummary {
  beadId: string;
  stateId: string;
}

interface SignalingHealthSummary {
  port: number | undefined;
  healthy: boolean;
}

// 0yt5.16/0yt5.22: the legacy per-artifact validator gate (the structured gate
// status that derived per-artifact validation from a hard-coded validator tool
// result) has been removed.  Gating is now decided by the COORDINATOR-side
// artifact-presence gate (0yt5.20) plus the registered generic artifact_validator
// verify() callback (0yt5.22) — not by harness-side recognition of a validator tool
// result.  The pre_signal_audit readiness surface replacement is owned by bead 0yt5.33.

interface FlowStatusDetails {
  mode: 'teammate' | 'coordinator' | 'inactive';
  beadId?: string;
  stateId?: string;
  actionId?: string;
  projectRoot?: string;
  configPath?: string;
  worktreePath?: string;
  elapsedSeconds?: number;
  requestedBead?: string;
  maxSlots?: number;
  autoContinue?: boolean;
  checklist?: {
    loaded: number;
    mandatoryOutstanding?: number;
  };
  completedActionsKnown?: number;
  checkpoint?: {
    accepted: boolean;
  };
  configuredProjectTools?: ProjectToolStatusSummary;
  nextHarnessAction: string;
  /** Per-teammate assignments (coordinator mode only). Sourced from event store — not Beads metadata. */
  teammates?: ActiveAssignmentSummary[];
  /** Most recent coordinator-level domain event (coordinator mode only). */
  latestEvent?: { type: string; timestamp: string };
  /** Signaling server health (coordinator mode only). */
  signaling?: SignalingHealthSummary;
  /** MCP bridge health (coordinator mode only — s3wp.32).
   *  Present when at least one MCP-backed tool preflight has been run.
   *  healthy=false means the @modelcontextprotocol/sdk bridge failed to load;
   *  affectedToolNames lists the project tools that could not be verified;
   *  message + remediation describe the failure once (not per-worker). */
  mcpBridgeHealth?: {
    healthy: boolean;
    affectedToolNames: string[];
    message?: string;
    remediation?: string;
  };
}

async function configuredProjectToolStatus(services: RuntimeServices): Promise<ProjectToolStatusSummary | undefined> {
  try {
    const config = await services.configLoader.load();
    const tools = config.tools || [];
    if (tools.length === 0) return undefined;
    const mcpTools = tools.filter(tool => tool.type === ProjectToolType.MCP);
    return {
      total: tools.length,
      mcpBacked: mcpTools.length,
      mcpBackedToolNames: mcpTools.map(t => t.name),
      command: tools.filter(tool => tool.type === ProjectToolType.COMMAND).length,
      nativeExtension: tools.filter(tool => tool.type === ProjectToolType.EXTENSION).length,
      nativeMcpFooterMeaning: 'Pi UI MCP count is native-adapter-only and does not report Orr Else configured MCP-backed project tools.'
    };
  } catch {
    return undefined;
  }
}

function projectToolStatusText(status: ProjectToolStatusSummary | undefined): string | undefined {
  if (!status) return undefined;
  const mcpNames = status.mcpBackedToolNames.length > 0
    ? ` [${status.mcpBackedToolNames.join(', ')}]`
    : '';
  return `Configured project tools: ${status.total} total (${status.mcpBacked} Orr Else MCP-backed${mcpNames}, ${status.command} command, ${status.nativeExtension} native extension). ${status.nativeMcpFooterMeaning}`;
}

async function activeRunOutstandingMandatoryCount(services: RuntimeServices, run: ActiveRun): Promise<number | undefined> {
  try {
    const projection = await services.eventStore.projectBead(run.beadId);
    return missingMandatoryChecklistItems(run.requiredItems, projection.checklists as any).length;
  } catch {
    return undefined;
  }
}

async function flowStatusDetails(services: RuntimeServices, session: ExtensionSession): Promise<FlowStatusDetails> {
  const projectToolStatus = await configuredProjectToolStatus(services);
  const { activeRun, supervisor, currentFlowOptions } = session;

  if (activeRun) {
    const elapsedSeconds = Math.round((Date.now() - activeRun.startedAt) / TimeMs.SECOND);
    const mandatoryOutstanding = await activeRunOutstandingMandatoryCount(services, activeRun);
    const nextHarnessAction = !activeRun.checkpointAccepted
      ? `call ${BuiltInToolName.SUBMIT_CHECKPOINT} with durable evidence before terminal completion`
      : typeof mandatoryOutstanding === 'number' && mandatoryOutstanding > 0
        ? `complete ${mandatoryOutstanding} mandatory checklist item(s) with ${BuiltInToolName.TICK_ITEMS}`
        : `continue the phase objective; when evidence is complete, use ${BuiltInToolName.SIGNAL_COMPLETION} with the configured outcome`;
    return {
      mode: 'teammate',
      beadId: activeRun.beadId,
      stateId: activeRun.stateId,
      actionId: activeRun.action.id,
      projectRoot: process.env[EnvVars.PROJECT_ROOT] || services.projectRoot,
      configPath: process.env[EnvVars.CONFIG_PATH] || services.configLoader.getConfigPath(),
      worktreePath: activeRun.worktreePath || process.cwd(),
      elapsedSeconds,
      checklist: {
        loaded: activeRun.requiredItems.length,
        mandatoryOutstanding
      },
      completedActionsKnown: activeRun.completedActionIds.length,
      checkpoint: {
        accepted: activeRun.checkpointAccepted
      },
      configuredProjectTools: projectToolStatus,
      nextHarnessAction
    };
  }

  if (supervisor) {
    const teammates = await supervisor.getActiveAssignments().catch(() => [] as Array<{ beadId: string; stateId: string }>);
    const signaling = supervisor.getSignalingHealth();
    let latestEvent: { type: string; timestamp: string } | undefined;
    try {
      const last = await services.eventStore.latestEvent();
      if (last) latestEvent = { type: last.type, timestamp: last.timestamp };
    } catch {
      // best-effort
    }
    return {
      mode: 'coordinator',
      requestedBead: currentFlowOptions?.beadId || 'backlog',
      maxSlots: currentFlowOptions?.maxSlots ?? Defaults.MAX_SLOTS,
      autoContinue: currentFlowOptions?.autoContinue !== false,
      configPath: currentFlowOptions?.configPath || services.configLoader.getConfigPath(),
      configuredProjectTools: projectToolStatus,
      nextHarnessAction: 'monitor active teammate slots and process teammate signals',
      teammates,
      latestEvent,
      signaling,
      mcpBridgeHealth: supervisor.getMcpBridgeHealth()
    };
  }

  return {
    mode: 'inactive',
    nextHarnessAction: 'start Orr Else with /orr-else'
  };
}

function flowStatusText(details: FlowStatusDetails): string {
  const projectToolStatus = projectToolStatusText(details.configuredProjectTools);

  if (details.mode === 'teammate') {
    return [
      'Orr Else teammate active.',
      `Bead: ${details.beadId}`,
      `State: ${details.stateId}`,
      `Action: ${details.actionId}`,
      `Project root: ${details.projectRoot}`,
      `Config path: ${details.configPath}`,
      `Worktree: ${details.worktreePath}`,
      `Elapsed: ${details.elapsedSeconds}s`,
      `Checklist items loaded: ${details.checklist?.loaded ?? 0}`,
      `Mandatory checklist outstanding: ${details.checklist?.mandatoryOutstanding ?? 'unknown'}`,
      `Completed actions known: ${details.completedActionsKnown ?? 0}`,
      `Checkpoint accepted: ${details.checkpoint?.accepted ? 'yes' : 'no'}`,
      `Next harness action: ${details.nextHarnessAction}`,
      projectToolStatus
    ].filter(Boolean).join('\n');
  }

  if (details.mode === 'coordinator') {
    const teammateLines = (details.teammates ?? []).map(
      (t, i) => `  [${i + 1}] ${t.beadId} — state: ${t.stateId}`
    );
    const signalingLine = details.signaling
      ? `Signaling: ${details.signaling.healthy ? 'healthy' : 'not listening'} (port ${details.signaling.port ?? 'none'})`
      : undefined;
    const latestEventLine = details.latestEvent
      ? `Latest event: ${details.latestEvent.type} at ${details.latestEvent.timestamp}`
      : undefined;
    const tmuxLine = 'Attach with: tmux attach -t orr-else';
    let mcpBridgeLine: string | undefined;
    if (details.mcpBridgeHealth) {
      if (details.mcpBridgeHealth.healthy) {
        mcpBridgeLine = 'MCP bridge: healthy';
      } else {
        const affectedList = details.mcpBridgeHealth.affectedToolNames.join(', ') || 'none';
        mcpBridgeLine = [
          `MCP bridge: UNAVAILABLE (affected tools: ${affectedList})`,
          details.mcpBridgeHealth.message ? `  Error: ${details.mcpBridgeHealth.message}` : undefined,
          details.mcpBridgeHealth.remediation ? `  Remediation: ${details.mcpBridgeHealth.remediation}` : undefined
        ].filter(Boolean).join('\n');
      }
    }
    return [
      'Orr Else coordinator active.',
      `Requested bead: ${details.requestedBead}`,
      `Max slots: ${details.maxSlots}`,
      `Auto-continue: ${details.autoContinue ? 'yes' : 'no'}`,
      `Config: ${details.configPath}`,
      `Active teammates: ${(details.teammates ?? []).length}/${details.maxSlots ?? 0}`,
      ...teammateLines,
      signalingLine,
      latestEventLine,
      mcpBridgeLine,
      `Next harness action: ${details.nextHarnessAction}`,
      projectToolStatus,
      tmuxLine
    ].filter(Boolean).join('\n');
  }

  return 'Orr Else is not running.';
}

async function flowStatus(services: RuntimeServices, session: ExtensionSession, format: 'json' | 'text' = 'json'): Promise<FlowStatusDetails | string> {
  const details = await flowStatusDetails(services, session);
  return format === 'text' ? flowStatusText(details) : details;
}

async function startOrrElse(pi: ExtensionAPI, ctx: ExtensionContext, options: FlowOptions, services: RuntimeServices, session: ExtensionSession): Promise<string> {
  if (isWorkerMode()) return 'This Pi process is an Orr Else teammate, not the coordinator.';
  if (session.supervisor) return (await flowStatus(services, session, 'text')) as string;

  if (ctx.hasUI) ctx.ui.notify('Starting Orr Else coordinator...', 'info');
  if (options.configPath) services.configLoader.setConfigPath(options.configPath);
  session.currentFlowOptions = { ...options };
  const runtimeObservability = await initializeObservability(services);

  // Build provenance: best-effort, never blocks startup.
  const buildProvenance = await computeBuildProvenance(services.configLoader.getConfigPath()).catch(() => undefined);
  if (buildProvenance) {
    await runStalenessPreflightWarn(buildProvenance, services.eventStore).catch(() => {});
  }

  // Host-SDK fingerprint: recorded alongside build provenance for audit/drift detection.
  const hostSdkFingerprint = resolveHostSdkFingerprint();

  await services.eventStore.record(DomainEventName.HARNESS_STARTED, {
    beadId: options.beadId,
    maxSlots: options.maxSlots,
    autoContinue: options.autoContinue,
    buildProvenance,
    hostSdkFingerprint
  });

  const startupConfig = await services.configLoader.load();

  // ── AC5 (pi-experiment-6q0y.44): emit deterministic context-policy fingerprint ──
  // Compute and record the SHA-256 fingerprint of the resolved context-policy table
  // immediately after config is loaded so every startup leaves a durable audit
  // record.  A fingerprint change between runs means the policy table changed.
  try {
    const { digest: contextPolicyDigest, table: contextPolicyTable } = computeContextPolicyFingerprint(startupConfig);
    await services.eventStore.record(DomainEventName.CONTEXT_POLICY_FINGERPRINT_RECORDED, {
      digest: contextPolicyDigest,
      table: contextPolicyTable,
      stateCount: contextPolicyTable.length
    }).catch(() => {});
    Logger.info(Component.ORR_ELSE, 'Context-policy fingerprint recorded at startup (AC5)', {
      digest: contextPolicyDigest,
      stateCount: contextPolicyTable.length
    });
  } catch (error) {
    Logger.warn(Component.ORR_ELSE, 'Context-policy fingerprint computation failed at startup', { error: String(error) });
  }

  // ── COORDINATOR-side verifier gate bootstrap (pi-experiment-0yt5.20) ──────────
  // Decision A (AC2): load the consumer pi.workerExtensions in THIS (coordinator)
  // process so their verify() callbacks register in the SAME process that runs the
  // binding gate. The harness's own built-in verifiers self-register at import; the
  // coordinator's own extension is skipped (already loaded). Then fail fast (AC4):
  // every required tool that declares expectsVerify:true MUST resolve to a
  // registered callback in this process.
  const coordinatorExtensionPath = fileURLToPath(import.meta.url);
  await loadCoordinatorWorkerExtensions(startupConfig, services.projectRoot, coordinatorExtensionPath).catch((error: unknown) => {
    Logger.warn(Component.ORR_ELSE, 'Coordinator worker-extension load encountered an error', { error: String(error) });
    return undefined;
  });
  validateRequiredToolVerifiers(startupConfig);

  // ── AC5 (pi-experiment-8ieq): startup readiness-probe admission ───────────
  // Run all probeContext:true tools before model/pi spawn. A required-tool probe
  // that returns gateDec:'DENY' causes runStartupProbeAdmission to throw, which
  // aborts startup here — before SignalingServer, Supervisor, and any pi spawn.
  // Configs with no probeContext:true tools (e.g. cerdiwen) return immediately.
  await runStartupProbeAdmission(
    startupConfig.tools ?? [],
    services.configLoader.getConfigPath(),
    services.eventStore
  );

  // ── pi-experiment-ek2j: v2 runtime substrate preflight ────────────────────
  // VERSION-GATED: only runs for version===2 configs. v1 startup and cerdiwen
  // are completely unaffected by this block.
  // Verifies tmux and git-worktree substrates are usable BEFORE SignalingServer
  // start, Supervisor creation, and any worker spawn. Throws + records a
  // V2_SUBSTRATE_PREFLIGHT_FAILED event if either substrate is missing/unusable,
  // aborting startup fail-closed before any model spend.
  if (startupConfig.version === 2) {
    await runV2SubstratePreflight(services.projectRoot, services.eventStore);
  }

  const server = new SignalingServer((event, ack) => handleTeammateEvent(pi, ctx, event, services, session, ack), runtimeObservability, services.eventStore, {
    allowedCustomEvents: startupConfig.statechart?.customEvents
  });
  const apiPort = await server.start();
  const apiBase = `http://${Defaults.API_HOST}:${apiPort}`;
  await services.eventStore.record(DomainEventName.HARNESS_API_BOUND, {
    apiBase,
    apiPort
  });

  // Mutate the shared ApiAddress holder so ALL factories (supervisor, tool, services)
  // see the bound port at spawn time without needing per-instance setApiAddress calls.
  services.apiAddress.port = String(apiPort);
  services.apiAddress.base = apiBase;

  // SESSION_START always fires before /orr-else can be invoked, so
  // session.teammateFactory is already populated by the SESSION_START handler.
  // Use ??= so that the same instance is shared everywhere (spawn_teammate tool
  // and Supervisor both operate on one factory).  If SESSION_START somehow did
  // not run first (should not happen), we construct defensively here.
  session.teammateFactory ??= new TeammateFactory(
    runtimeObservability,
    services.configLoader,
    services.eventStore,
    services.apiAddress,
    options.maxSlots || Defaults.MAX_SLOTS,
    Defaults.TMUX_SESSION,
    fileURLToPath(import.meta.url)
  );
  // Apply the CLI-resolved maxSlots to the (possibly reused) factory so that
  // `--max-slots N` overrides the config value baked in at SESSION_START time.
  // The Supervisor already receives options.maxSlots directly; this call keeps
  // the factory's internal slot cap (used by getAvailableSlots / spawn guards)
  // consistent with the operator's explicit CLI intent.
  session.teammateFactory.setMaxSlots(options.maxSlots || Defaults.MAX_SLOTS);
  const factory = session.teammateFactory;
  const windowSetup = await factory.ensureAgentsWindow();
  if (!windowSetup.ok) {
    // Log the hard failure but allow the supervisor to start. The Supervisor's
    // pane scan suppression will prevent repeated noise; the operator must
    // fix the tmux environment and restart.
    Logger.error('OrrElse', 'Agents window setup failed at startup — pane scans suppressed until resolved', {
      error: windowSetup.error
    });
  }

  // pi-experiment-amq0.2: construct and inject required Orchestrator + RetentionScheduler
  // at the composition root — no construct-fallback inside Supervisor.
  const supervisorOrchestrator = new Orchestrator(
    runtimeObservability,
    services.configLoader,
    services.flowManager,
    services.scheduler,
    services.beadsPort,
    options.maxSlots
  );
  const supervisorRetentionScheduler = new RetentionScheduler(
    services.projectRoot,
    { now: () => Date.now(), date: (ms?: number) => new Date(ms ?? Date.now()) },
    services.eventStore,
    services.configLoader,
    factory
  );

  session.supervisor = new Supervisor(pi, ctx, server, factory, runtimeObservability, services, {
    maxSlots: options.maxSlots,
    requestedBeadId: options.beadId,
    orchestrator: supervisorOrchestrator,
    retentionScheduler: supervisorRetentionScheduler
  });

  // pi-experiment-1elr.10: reflect supervisor active state on the lifecycle machine.
  session.lifecycleMachine.supervisorHealthStage = SupervisorHealthStage.ACTIVE;

  await session.supervisor.start();

  return `${(await flowStatus(services, session, 'text')) as string}\nAttach with: tmux attach -t orr-else`;
}

type OrrElseParsedArgs = FlowOptions | ExtensionCommandAction.STATUS | ExtensionCommandAction.STOP;

function splitOrrElseCommandLine(rawArgs: string): string[] {
  return parseShellCommand(rawArgs)
    .map(part => {
      if (typeof part === 'string') return part;
      throw new Error(`Unsupported shell token in /orr-else arguments: ${JSON.stringify(part)}`);
    })
    .filter(Boolean);
}

function parseOrrElseArgs(rawArgs: string, config?: HarnessConfig): OrrElseParsedArgs {
  const tokens = splitOrrElseCommandLine(rawArgs);
  if (tokens[0] === ExtensionCommandAction.STATUS) return ExtensionCommandAction.STATUS;
  if (tokens[0] === ExtensionCommandAction.STOP) return ExtensionCommandAction.STOP;

  const command = new Command();
  command
    .name(BuiltInToolName.ORR_ELSE)
    .allowExcessArguments(false)
    .exitOverride()
    .configureOutput({
      writeOut: () => {},
      writeErr: () => {}
    })
    .option(`${CliOption.CONFIG} <path>`)
    .option(`${CliOption.BEAD} <id>`)
    .option(`${CliOption.MAX_SLOTS} <n>`, 'Maximum teammate slots', (value: string) => Number.parseInt(value, Numeric.DECIMAL_RADIX));

  command.parse(tokens, { from: 'user' });
  const parsed = command.opts<{ config?: string; bead?: string; maxSlots?: number }>();
  const maxSlots = parsed.maxSlots ?? config?.settings?.maxConcurrentSlots ?? Defaults.MAX_SLOTS;
  if (!Number.isInteger(maxSlots) || maxSlots <= 0) {
    throw new Error(`${CliOption.MAX_SLOTS} must be a positive integer`);
  }

  return {
    configPath: parsed.config,
    beadId: parsed.bead,
    maxSlots,
    autoContinue: true
  };
}

export default async function orrElseExtension(pi: ExtensionAPI, providedServices?: RuntimeServices) {
  // Fresh per-invocation state — guards reset here so a second call to
  // orrElseExtension(pi2, services) re-registers tools on the new pi instance.
  const session = createExtensionSession();

  const services = providedServices || createRuntimeServices();
  const seenTools = new Set<string>();

  pi.registerCommand(BuiltInToolName.ORR_ELSE, {
    description: `Start Orr Else coordinator. Usage: /orr-else [status|stop] [${CliOption.CONFIG} path] [${CliOption.BEAD} id] [${CliOption.MAX_SLOTS} n].`,
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      try {
        const preliminary = parseOrrElseArgs(args);

        if (preliminary === ExtensionCommandAction.STATUS) {
          if (ctx.hasUI) ctx.ui.notify((await flowStatus(services, session, 'text')) as string, 'info');
          return;
        }

        if (preliminary === ExtensionCommandAction.STOP) {
          if (session.supervisor) session.supervisor.stop();
          session.supervisor = null;
          session.currentFlowOptions = null;
          if (ctx.hasUI) ctx.ui.notify('Orr Else stopped.', 'info');
          return;
        }

        if (preliminary.configPath) services.configLoader.setConfigPath(preliminary.configPath);
        const config = await services.configLoader.load();
        const parsed = parseOrrElseArgs(args, config);

        if (typeof parsed === 'object') {
          const result = await startOrrElse(pi, ctx as any, parsed, services, session);
          if (ctx.hasUI) ctx.ui.notify(result, 'info');
        }
      } catch (error) {
        Logger.error(Component.ORR_ELSE, 'Orr Else command failed', { error: String(error) });
        if (ctx.hasUI) ctx.ui.notify(`Orr Else failed: ${String(error)}`, 'error');
      }
    }
  });

  // ── ExtensionBootstrap: initial setup ────────────────────────────────────────
  // bootstrapExtension handles registerBuiltInVerifiers, Logger config,
  // processLifecycleObservers, and Logger.info.  Pi lifecycle callbacks are
  // registered below via the PiRegistrationService (registerPiLifecycleCallbacks)
  // called from bootstrapExtension with the inline handler closures.
  //
  // The handler closures are constructed first so they capture session/services
  // at orrElseExtension() call time.  bootstrapExtension then calls
  // registerPiLifecycleCallbacks which invokes pi.on() for each handler.
  bootstrapExtension(pi, {
    services,
    isWorkerMode,
    piEventNames: {
      SESSION_SHUTDOWN: PiEventName.SESSION_SHUTDOWN,
      BEFORE_AGENT_START: PiEventName.BEFORE_AGENT_START,
      RESOURCES_DISCOVER: PiEventName.RESOURCES_DISCOVER,
      SESSION_START: PiEventName.SESSION_START,
    }
  }, {
    onSessionShutdown: sessionShutdownHandler,
    onBeforeAgentStart: beforeAgentStartHandler,
    onResourcesDiscover: resourcesDiscoverHandler,
    onSessionStart: sessionStartHandler,
  });

  // ── Pi lifecycle handler implementations ─────────────────────────────────────
  // These handler functions are passed to bootstrapExtension (which routes them
  // through PiRegistrationService / pi.on()) and defined here as named functions
  // so they are hoisted and available at the bootstrapExtension call site above.

  function sessionShutdownHandler() {
    // pi-experiment-1elr.10: transition the lifecycle machine before side effects.
    // SESSION_SHUTDOWN always proceeds even on violation — cleanup must never be blocked.
    const shutdownResult = transition(session.lifecycleMachine, PiLifecycleEvent.SESSION_SHUTDOWN);
    if (!shutdownResult.ok) {
      emitLifecycleViolation(shutdownResult, { isWorker: isWorkerMode() });
      // Do NOT return early — shutdown must always run.
    } else {
      if (shutdownResult.shutdownWithActiveRun) {
        // AC3: shutdown-with-active-run diagnostic (LIFECYCLE_VIOLATION via taxonomy).
        Logger.warn(Component.ORR_ELSE, 'SESSION_SHUTDOWN arrived while a tool turn was active', {
          fromState: shutdownResult.fromState,
          isWorker: isWorkerMode(),
        });
      }
      applyTransition(session.lifecycleMachine, shutdownResult);
      session.lifecycleMachine.supervisorHealthStage = SupervisorHealthStage.STOPPED;
    }

    Logger.info(Component.ORR_ELSE, 'Pi session shutdown observed', { isWorker: isWorkerMode() });
    if (session.supervisor) session.supervisor.stop();
    session.supervisor = null;
    session.currentFlowOptions = null;
    session.piToolObservability = null;
    session.observedPiTools = new Set<string>();
    session.blockedObservedPiToolCallIds = new Set<string>();
    session.observedPiToolSpans = new Map<string, SpanContext>();
    session.observedPiToolInvocationIds = new Map<string, string>();
    const runtimeObservability = services.observability;
    // Return the cleanup promise so the Pi host can await it (pi-experiment-2xho AC5).
    // forceFlush drains any pending telemetry spans; shutdown closes the exporter.
    // On failure the promise resolves anyway (finally) — a bounded shutdown-failure
    // that does NOT block replacement/reload.
    return runtimeObservability?.forceFlush().finally(() => runtimeObservability.shutdown());
  }

  async function beforeAgentStartHandler(event: BeforeAgentStartEvent) {
    if (!isWorkerMode()) return;

    // pi-experiment-1elr.10: transition the lifecycle machine BEFORE initialising
    // the worker run or injecting prompts. Invalid ordering (e.g. BEFORE_AGENT_START
    // before SESSION_START) produces a LIFECYCLE_VIOLATION diagnostic and returns early
    // — workers must not start if the lifecycle gate rejects admission.
    const bafResult = transition(session.lifecycleMachine, PiLifecycleEvent.BEFORE_AGENT_START);
    if (!bafResult.ok) {
      emitLifecycleViolation(bafResult, {
        isWorker: true,
        beadId: process.env[EnvVars.BEAD_ID],
        stateId: process.env[EnvVars.STATE_ID],
      });
      return; // Do NOT start workers or inject prompts on lifecycle violation.
    }
    if (!bafResult.wasIdempotent) {
      applyTransition(session.lifecycleMachine, bafResult);
    }

    const config = await services.configLoader.load();
    if (!session.activeRun) await initializeWorkerRun(services.observability, services, session);
    if (!session.activeRun) return;
    const projectRootForPrompt = process.env[EnvVars.PROJECT_ROOT] || services.projectRoot;
    const promptResult = buildStateSystemPrompt(config, { projectRoot: projectRootForPrompt, services }, session.activeRun);

    // ── Pi base prompt admission + fingerprinting (pi-experiment-1elr.9) ────
    //
    // Compute stable hashes for all 4 prompt segments + the final assembled
    // prompt BEFORE any token spend.  Diagnostics carry hashes/sizes/rule codes
    // only — the prompt body is NEVER copied into events, logs, or model output.
    //
    // On the first call per run: record admission + STATE_PROMPT_ASSEMBLED with
    // final-prompt fingerprint.  On subsequent calls: detect Pi base prompt drift
    // (host-prompt change between turns) and emit PI_BASE_PROMPT_DRIFT (re-admit).
    const piBase = event.systemPrompt;
    const admission = admitPiBasePrompt({
      stableBlock: promptResult.stableBlock,
      piBasePrompt: piBase || undefined,
      volatileSuffix: promptResult.volatileSuffix,
    });

    // AC3: flush pending STATE_RUN_INITIALIZED on the first BEFORE_AGENT_START
    // call after run init.  We now have finalPromptHash + admittedHarnessFingerprint
    // and can record the event with both fields (pi-experiment-1elr.9).
    if (session.pendingRunInitPayload) {
      const payload = session.pendingRunInitPayload;
      session.pendingRunInitPayload = undefined;
      await services.eventStore.record(DomainEventName.STATE_RUN_INITIALIZED, {
        ...payload,
        finalPromptHash: admission.finalPromptHash.sha256,
        admittedHarnessFingerprint: session.admittedHarnessFingerprint,
      }).catch(() => {});
    }

    // Drift detection: compare current Pi base hash against admitted hash.
    // First turn: session.admittedPiBasePromptHash is null → no drift check.
    const currentPiBaseHash = admission.piBasePromptHash.sha256;
    const isDrift = session.admittedPiBasePromptHash !== null &&
      session.admittedPiBasePromptHash !== currentPiBaseHash;

    if (isDrift) {
      // AC4: emit structured drift event — hashes/sizes/rule codes ONLY, no bodies.
      await services.eventStore.record(DomainEventName.PI_BASE_PROMPT_DRIFT, {
        beadId: session.activeRun?.beadId,
        stateId: session.activeRun?.stateId,
        admittedHash: session.admittedPiBasePromptHash,
        currentHash: currentPiBaseHash,
        currentByteLength: admission.piBasePromptHash.byteLength,
        currentEstimatedTokens: admission.piBasePromptHash.estimatedTokens,
        ruleCode: PiBasePromptRuleCode.DRIFT,
        newFinalPromptHash: admission.finalPromptHash.sha256,
      }).catch(() => {});
      Logger.warn(Component.ORR_ELSE, 'Pi base prompt drifted between turns — re-admitting', {
        beadId: session.activeRun?.beadId,
        stateId: session.activeRun?.stateId,
        admittedHash: session.admittedPiBasePromptHash,
        currentHash: currentPiBaseHash,
        ruleCode: PiBasePromptRuleCode.DRIFT,
      });
      // Re-admit: update the tracked hash to the new value.
      session.admittedPiBasePromptHash = currentPiBaseHash;
    } else if (session.admittedPiBasePromptHash === null) {
      // First call: record the admitted hash.
      session.admittedPiBasePromptHash = currentPiBaseHash;
    }

    // Record the stable-block digest once per (run, digestId) — not on every turn.
    // BEFORE_AGENT_START fires on every user/agent turn; the stable block is typically
    // identical within a run, so we dedup by digestId to avoid per-turn event spam.
    // When the digest changes (e.g. config/state rebuilt the stable block) a new record
    // is emitted; repeated turns with the same digest emit nothing.
    // 1elr.9: also record finalPromptHash and piBasePromptHash on STATE_PROMPT_ASSEMBLED.
    if (!session.recordedPromptDigestIds.has(promptResult.digestId)) {
      session.recordedPromptDigestIds.add(promptResult.digestId);
      await services.eventStore.record(DomainEventName.STATE_PROMPT_ASSEMBLED, {
        beadId: session.activeRun?.beadId,
        stateId: session.activeRun?.stateId,
        stableBlockDigestId: promptResult.digestId,
        stableBlockEstimatedTokens: promptResult.estimatedTokens,
        stableBlockOverBudget: promptResult.overBudget,
        // 1elr.9: Pi base prompt + final prompt fingerprints (hashes only, no bodies).
        piBasePromptHash: admission.piBasePromptHash.missing ? undefined : admission.piBasePromptHash.sha256,
        piBasePromptMissing: admission.piBasePromptHash.missing || undefined,
        piBasePromptOverBudget: admission.piBasePromptHash.overBudget || undefined,
        piBasePromptEstimatedTokens: admission.piBasePromptHash.missing ? undefined : admission.piBasePromptHash.estimatedTokens,
        finalPromptHash: admission.finalPromptHash.sha256,
        finalPromptEstimatedTokens: admission.finalPromptHash.estimatedTokens,
        admissionRuleCode: admission.ruleCode,
        // AC3: harness fingerprint binds this event to the running build (1elr.9).
        admittedHarnessFingerprint: session.admittedHarnessFingerprint,
        // 6q0y.2: active-tool telemetry — names only, no prompt bodies (AC5).
        // Absent when the full default tool set is used (no activeTools declared).
        ...(promptResult.activeToolNames !== undefined ? {
          activeToolNames: promptResult.activeToolNames,
          activeToolCount: promptResult.activeToolNames.length,
        } : {}),
      }).catch(() => {});

      if (promptResult.overBudget) {
        Logger.warn(Component.ORR_ELSE, 'Worker stable block exceeds token budget — consider reducing role/protocol guidance', {
          beadId: session.activeRun?.beadId,
          stateId: session.activeRun?.stateId,
          stableBlockDigestId: promptResult.digestId,
          stableBlockEstimatedTokens: promptResult.estimatedTokens
        });
      }
      if (admission.piBasePromptHash.overBudget) {
        Logger.warn(Component.ORR_ELSE, 'Pi base system prompt exceeds token budget', {
          beadId: session.activeRun?.beadId,
          stateId: session.activeRun?.stateId,
          piBasePromptEstimatedTokens: admission.piBasePromptHash.estimatedTokens,
          ruleCode: PiBasePromptRuleCode.OVER_BUDGET,
        });
      }
    }

    // ── Prompt-budget admission (pi-experiment-6q0y.17) ─────────────────────
    //
    // AC4: evaluate hard prompt-budget limits BEFORE the first model request.
    // Returning early here (throwing) prevents the provider from ever receiving
    // the prompt when a configured limit is exceeded. With no budget configured,
    // resolvePromptBudgetPolicy returns undefined → evaluatePromptBudgetAdmission
    // returns exceeded:false → this block is a complete no-op (AC1).
    //
    // We reuse the sizes already computed by admitPiBasePrompt to avoid re-hashing.
    const sizing = computePromptSizing({
      stableBlock: promptResult.stableBlock,
      piBasePrompt: piBase || undefined,
      volatileSuffix: promptResult.volatileSuffix,
    });
    const budgetResult = evaluatePromptBudgetAdmission(
      sizing,
      config,
      session.activeRun?.stateId,
      session.activeRun?.action?.id
    );

    if (budgetResult.exceeded) {
      const policy = budgetResult.resolvedPolicy!;
      const configPath = services.configLoader.getConfigPath();
      // AC5: emit the deterministic admission event — hashes/counts/route only,
      // NO prompt body.
      await services.eventStore.record(DomainEventName.PROMPT_BUDGET_ADMISSION, {
        beadId: session.activeRun?.beadId,
        stateId: session.activeRun?.stateId,
        actionId: session.activeRun?.action?.id,
        configPath,
        limitScope: budgetResult.limitScope,
        exceeded: true,
        route: budgetResult.route,
        ...(policy.maxBytes !== undefined ? { limitBytes: policy.maxBytes } : {}),
        ...(policy.maxTokens !== undefined ? { limitTokens: policy.maxTokens } : {}),
        stableBlockBytes: sizing.stableBlockBytes,
        stableBlockTokens: sizing.stableBlockTokens,
        stableBlockHash: sizing.stableBlockHash,
        piBasePromptBytes: sizing.piBasePromptBytes,
        piBasePromptTokens: sizing.piBasePromptTokens,
        piBasePromptHash: sizing.piBasePromptHash,
        volatileSuffixBytes: sizing.volatileSuffixBytes,
        volatileSuffixTokens: sizing.volatileSuffixTokens,
        volatileSuffixHash: sizing.volatileSuffixHash,
        finalPromptBytes: sizing.finalPromptBytes,
        finalPromptTokens: sizing.finalPromptTokens,
        finalPromptHash: sizing.finalPromptHash,
      }).catch(() => {});
      Logger.warn(Component.ORR_ELSE, 'Prompt budget exceeded — failing worker before model request', {
        beadId: session.activeRun?.beadId,
        stateId: session.activeRun?.stateId,
        actionId: session.activeRun?.action?.id,
        finalPromptBytes: sizing.finalPromptBytes,
        finalPromptTokens: sizing.finalPromptTokens,
        limitScope: budgetResult.limitScope,
        route: budgetResult.route,
      });
      // AC4: Route the bead through the configured deterministic outcome BEFORE
      // any provider request.
      //
      // HOW route→transition works (consumption mechanism):
      //   postWorkerSignal builds a TeammateEvent with transitionEvent = budgetResult.route
      //   (e.g. "FAILURE") and POSTs it to the harness coordinator via postHarnessSignal.
      //   The coordinator's handleTeammateEvent (extension.ts) calls
      //   services.flowManager.nextState(state, event.transitionEvent, ...) to resolve
      //   the next state, then records STATE_TRANSITION_APPLIED — exactly the same path
      //   as a normal worker outcome signal.  The route is NOT a dead string: it becomes
      //   the `transitionEvent` field that drives the actual bead state transition.
      //
      //   The throw that follows aborts the Pi BEFORE_AGENT_START handler so no model
      //   request is issued.  postWorkerSignal is best-effort (transport failures are
      //   caught and recorded); the throw is always issued regardless of signal success.
      const activeRun = session.activeRun;
      if (activeRun && budgetResult.route) {
        const summary =
          `Prompt budget exceeded at "${configPath}" (scope: ${budgetResult.limitScope}, ` +
          `final prompt: ${sizing.finalPromptBytes} bytes / ${sizing.finalPromptTokens} tokens). ` +
          `Routing through configured outcome: ${budgetResult.route}`;
        const routeEvent = buildWorkerEvent(teammateEventTypeForOutcome(budgetResult.route, config), {
          beadId: activeRun.beadId,
          stateId: activeRun.stateId,
          actionId: activeRun.action.id,
          transitionEvent: budgetResult.route,
          summary,
          evidence: summary,
          handover: summary,
        });
        await postWorkerSignal(services, routeEvent).catch(signalError => {
          Logger.warn(Component.ORR_ELSE, 'Failed to post budget-exceeded route signal — bead will be recovered by supervisor', {
            beadId: activeRun.beadId,
            stateId: activeRun.stateId,
            route: budgetResult.route,
            error: String(signalError),
          });
        });
      }
      // Throw AFTER signaling — aborts the turn before the provider receives the prompt.
      throw new Error(
        `Prompt budget exceeded at "${configPath}" (scope: ${budgetResult.limitScope}, ` +
        `final prompt: ${sizing.finalPromptBytes} bytes / ${sizing.finalPromptTokens} tokens, ` +
        `${policy.maxBytes !== undefined ? `maxBytes: ${policy.maxBytes}` : ''}` +
        `${policy.maxTokens !== undefined ? `${policy.maxBytes !== undefined ? ', ' : ''}maxTokens: ${policy.maxTokens}` : ''}). ` +
        `Route: ${budgetResult.route}`
      );
    }

    // Compose the final worker prompt so stableBlock is the CONTIGUOUS LEADING prefix.
    // Ordering: stableBlock → Pi base prompt (contains Pi's volatile date/cwd trailer)
    //           → volatileSuffix (beadId, workdir, run paths, checklist).
    //
    // This ensures the provider's prompt cache reuses the stableBlock prefix across
    // any two spawns that share the same (project/config/state/tools/skills/rules)
    // but differ only in bead/task/worktree/date.  Pi's volatile date/cwd trailer
    // sits in the middle — after the cache breakpoint — so it never pollutes it.
    //
    // NOTE: fingerprinting (above) does NOT modify this composition.
    const finalPrompt = piBase
      ? `${promptResult.stableBlock}\n\n${piBase}\n\n${promptResult.volatileSuffix}`
      : `${promptResult.stableBlock}\n\n${promptResult.volatileSuffix}`;
    return { systemPrompt: finalPrompt };
  }

  async function resourcesDiscoverHandler() {
    // pi-experiment-1elr.10: transition the lifecycle machine before resolving skills.
    const rdResult = transition(session.lifecycleMachine, PiLifecycleEvent.RESOURCES_DISCOVER);
    if (!rdResult.ok) {
      emitLifecycleViolation(rdResult);
      // Emit RESOURCES_DISCOVER_FAILURE diagnostic and return empty (fail-closed).
      const failureDiag = buildResourcesDiscoverFailure(session.lifecycleMachine);
      emitLifecycleViolation(failureDiag, { context: 'invalid-state-for-resources-discover' });
      return {};
    }
    if (!rdResult.wasIdempotent) {
      applyTransition(session.lifecycleMachine, rdResult);
    }

    let config;
    try {
      config = await services.configLoader.load();
    } catch (err) {
      const failureDiag = buildResourcesDiscoverFailure(session.lifecycleMachine);
      emitLifecycleViolation(failureDiag, { error: String(err) });
      return {};
    }
    const projectRoot = process.env[EnvVars.PROJECT_ROOT] || services.projectRoot;
    const skillPaths = resolvePiSkillPaths(config, projectRoot);
    return skillPaths.length > 0 ? { skillPaths } : {};
  }

  async function sessionStartHandler(_event: SessionStartEvent, ctx: ExtensionContext) {
    // pi-experiment-1elr.10: transition the lifecycle machine BEFORE registering tools,
    // initialising observability, or constructing the TeammateFactory. A duplicate
    // SESSION_START (invalid ordering) produces a LIFECYCLE_VIOLATION diagnostic and
    // returns early — duplicate observer registration is a structural harness error.
    const ssResult = transition(session.lifecycleMachine, PiLifecycleEvent.SESSION_START);
    if (!ssResult.ok) {
      emitLifecycleViolation(ssResult, { isWorker: isWorkerMode() });
      return; // Do NOT register tools or initialise observability on lifecycle violation.
    }
    applyTransition(session.lifecycleMachine, ssResult);
    // Determine run mode once, immutably, at SESSION_START.
    session.lifecycleMachine.runMode = isWorkerMode() ? RunMode.WORKER : RunMode.COORDINATOR;
    session.lifecycleMachine.supervisorHealthStage = SupervisorHealthStage.IDLE;

    const config = await services.configLoader.load();
    const runtimeObservability = await initializeObservability(services);
    session.piToolObservability = runtimeObservability;

    // pi-experiment-6q0y.49: create the always-on loop detector (AC2).
    // One detector per session, shared across tool-call + coordinator paths.
    // No-op for normal runs — detection only fires when a loop threshold is exceeded.
    session.loopDetector = new LoopDetector(config, services.eventStore);

    // Host-SDK fingerprint: best-effort, recorded once at SESSION_START for all modes.
    const hostSdkFingerprint = resolveHostSdkFingerprint();

    // Worker-mode startup provenance: best-effort, never blocks startup.
    if (isWorkerMode()) {
      const workerProvenance = await computeBuildProvenance(services.configLoader.getConfigPath()).catch(() => undefined);
      if (workerProvenance) {
        await runStalenessPreflightWarn(workerProvenance, services.eventStore).catch(() => {});
        await services.eventStore.record(DomainEventName.HARNESS_STARTED, {
          isWorker: true,
          beadId: process.env[EnvVars.BEAD_ID],
          stateId: process.env[EnvVars.STATE_ID],
          workerId: process.env[EnvVars.WORKER_ID],
          buildProvenance: workerProvenance,
          hostSdkFingerprint,
          // pi-experiment-1elr.10: typed lifecycle/health/runMode fields (AC5).
          ...buildLifecycleEventFields(session.lifecycleMachine),
        }).catch(() => {});
        // AC3: store the harness fingerprint for inclusion in STATE_RUN_INITIALIZED
        // and STATE_PROMPT_ASSEMBLED events (pi-experiment-1elr.9).
        session.admittedHarnessFingerprint = computeHarnessFingerprint(workerProvenance);
      }
    }

    const wrappedToolNames = new Set<string>([
      ...Object.values(BuiltInToolName),
      ...Object.values(PluginToolName),
      ...getHarnessRegisteredProjectToolNames(config)
    ]);
    session.observedPiTools = new Set([
      ...getObservedPiToolNames(config),
      ...getNativePiExtensionProjectToolNames(config)
    ].filter(toolName => !wrappedToolNames.has(toolName)));
    registerPiToolObservers(pi, services, session, {
      beadIdFromToolParams: (input) => beadIdFromToolParams(input, session),
      toolSpanAttributes: (toolName, params, beadId, externalPiTool) => toolSpanAttributes(toolName, params, beadId, session, externalPiTool),
      terminalFailureLimitRejection: (toolName) => terminalFailureLimitRejection(toolName, services, session, isWorkerMode(), TERMINAL_FAILURE_ALLOWED_TOOLS),
      checkToolValidationRules,
      getObservability: () => getObservability(services),
      isWorkerMode,
      commandInvokesToolName,
      commandMatchesPattern
    });
    registerProviderRequestCap(pi, session);

    // pi-experiment-6q0y.48: runtime budget pre-provider-request check (AC1/AC4).
    // Wired here (not in PiObservers.ts) so the full ExtensionSession is available.
    // No-op when session.runtimeBudgetTracker is null (no policy configured, AC1).
    pi.on(PiEventName.BEFORE_PROVIDER_REQUEST, async (event: BeforeProviderRequestEvent) => {
      const tracker = session.runtimeBudgetTracker;
      if (!tracker) return undefined; // no-op: no runtime budget configured (AC1)

      // pi-experiment-6q0y.48: feed estimatedInputTokens from the request payload
      // using the same estimator (ceil(bytes / CHARS_PER_TOKEN)) as ProviderBudgetPreflight.
      // Called BEFORE checkPreProviderRequest so the check sees the current request's tokens.
      const sizing = computeRequestSizing(event.payload, undefined);
      tracker.recordEstimatedInputTokens(sizing.estimatedInputTokens);

      // Check dimensions that apply before a provider request.
      const budgetCheck = tracker.checkPreProviderRequest();
      if (budgetCheck.exceeded) {
        await tracker.emitExceededEvent(budgetCheck, services.eventStore);
        Logger.warn(Component.ORR_ELSE, 'Runtime budget exceeded — failing before provider request', {
          budgetId: budgetCheck.budgetId,
          dimension: budgetCheck.dimension,
          currentValue: budgetCheck.currentValue,
          limit: budgetCheck.limit,
          route: budgetCheck.route,
        });
        // AC4: route to configured deterministic outcome BEFORE the provider request.
        const activeRun = session.activeRun;
        if (activeRun && budgetCheck.route) {
          const summary = `Runtime budget exceeded (${budgetCheck.dimension}: ${budgetCheck.currentValue} >= ${budgetCheck.limit}). Route: ${budgetCheck.route}`;
          const routeEvent = buildWorkerEvent(teammateEventTypeForOutcome(budgetCheck.route, await services.configLoader.load()), {
            beadId: activeRun.beadId,
            stateId: activeRun.stateId,
            actionId: activeRun.action.id,
            transitionEvent: budgetCheck.route,
            summary,
            evidence: summary,
            handover: summary,
          });
          await postWorkerSignal(services, routeEvent).catch(signalError => {
            Logger.warn(Component.ORR_ELSE, 'Failed to post runtime budget exceeded route signal', {
              beadId: activeRun.beadId,
              route: budgetCheck.route,
              error: String(signalError),
            });
          });
        }
        throw new Error(
          `Runtime budget exceeded (${budgetCheck.dimension}: ${budgetCheck.currentValue} >= ${budgetCheck.limit}). ` +
          `Route: ${budgetCheck.route}`
        );
      }

      // Budget not exceeded — record the model call now that we've cleared the pre-check.
      tracker.recordModelCall();
      return undefined;
    });

    registerAgentLifecycleObservers(pi, services, session, {
      isWorkerMode,
      buildWorkerEvent,
      setAgentFailureSignaled: (v) => { session.agentFailureSignaled = v; }
    });

    // pi-experiment-6q0y.48: accumulate provider-reported total tokens after each turn
    // so the runtime budget tracker can check the providerTotalTokens dimension.
    // Fire-and-forget: accumulation failure must never block normal execution.
    pi.on(PiEventName.TURN_END, async (event: TurnEndEvent) => {
      const tracker = session.runtimeBudgetTracker;
      if (!tracker) return;
      const msg = isRecord(event.message) ? (event.message as unknown as Record<string, unknown>) : {};
      const usage = isRecord(msg['usage']) ? (msg['usage'] as Record<string, unknown>) : undefined;
      if (usage) {
        const total = typeof usage['total_tokens'] === 'number' ? usage['total_tokens'] as number : 0;
        if (total > 0) tracker.recordProviderTotalTokens(total);
      }
    });

    if (!session.claudeCodeLoginRegistered && resolveProviderName(config.settings.defaultProvider) === LLMProviderName.ANTHROPIC) {
      session.claudeCodeLoginRegistered = true;
      registerClaudeCodeLiveLogin(pi);
    }

    const projectRootForWrap = process.env[EnvVars.PROJECT_ROOT] || services.projectRoot;
    const wrapperPorts = {
      eventStore: services.eventStore,
      toolCallPathFactory: services.toolCallPathFactory,
      configLoader: services.configLoader,
      services,
      isWorkerMode,
      projectRoot: projectRootForWrap,
      terminalFailureAllowedTools: TERMINAL_FAILURE_ALLOWED_TOOLS as Set<string>,
      buildWorkerEvent,
    };
    const beadIdFromParamsForWrap = (params: Record<string, unknown> | undefined) => beadIdFromToolParams(params, session);
    const toolSpanAttrsForWrap = (toolName: string, params: unknown, beadId: string | undefined, externalPiTool?: boolean, toolInvocationId?: string) =>
      toolSpanAttributes(toolName, params, beadId, session, externalPiTool, toolInvocationId);
    const wrapRuntimeTool = (tool: { name: string, description: string, parameters: unknown, execute(params: unknown, ctx?: unknown, signal?: AbortSignal): unknown | Promise<unknown> }) =>
      wrapPluginTool(tool, runtimeObservability, wrapperPorts, session, beadIdFromParamsForWrap, toolSpanAttrsForWrap);

    if (!session.artifactPathsToolRegistered) {
      session.artifactPathsToolRegistered = true;
      pi.registerTool(wrapRuntimeTool({
        name: BuiltInToolName.GET_ARTIFACT_PATHS,
        description:
          'Resolve configured stable artifact paths, existence, and deterministic file metadata (bytes + sha256) for the current Bead/state/action. ' +
          'Returns paths, existence flags, per-artifact metadata (bytes, sha256), and missing-artifact lists. ' +
          'Content is never inlined — use query_artifact with "summary":true to see per-projection size estimates, ' +
          'then query_artifact with "projection" or "selector" to read the content you need. ' +
          'Use this tool to confirm which artifacts exist and check their identity before fetching content.',
        parameters: Type.Object({
          beadId: Type.String({ description: 'The Bead ID' }),
          stateId: Type.Optional(Type.String({ description: 'Optional state ID' })),
          actionId: Type.Optional(Type.String({ description: 'Optional action ID' })),
          artifactId: Type.Optional(Type.String({ description: 'Optional artifact ID to resolve only that template entry' })),
          includeContent: Type.Optional(Type.Boolean({ description: 'When true (default), include deterministic file metadata (bytes, sha256) for existing artifacts. Set false to return only paths and existence flags.' }))
        }),
        execute: async (params: any) => services.artifactPaths.resolve(params)
      }) as any);
    }

    if (!session.queryArtifactToolRegistered) {
      session.queryArtifactToolRegistered = true;
      const artifactQuery = new ArtifactQuery(services.artifactPaths);
      pi.registerTool(wrapRuntimeTool({
        name: BuiltInToolName.QUERY_ARTIFACT,
        description:
          'Query a structured JSON artifact and return ONLY the requested subtree or named projection — not the whole blob. ' +
          'PREFERRED over get_artifact_paths for large JSON artifacts (planContract, requirementsAnalysis). ' +
          'WORKFLOW: (1) Call with "summary":true to get per-projection size estimates (byteCount + tokenEstimate) WITHOUT content — ' +
          'use this to decide which projections fit your context budget. ' +
          '(2) Call with "projection" for schema-aware named extractions: ' +
          'projection names are registered by the consuming project extension (e.g. planContract: writeSet, verifierObligations, planSteps, riskList, evidenceReferences, acceptanceCriteria; ' +
          'requirementsAnalysis: requirementsInventory, traceability, completenessGaps, clarificationQuestions, referenceCitations). ' +
          'Only registered current projection names are accepted; unregistered names reject with a structured error and validProjections list. ' +
          '(3) Call with "selector" for dot-path or JSON Pointer ad-hoc access (e.g. "planSteps.0" or "/planSteps/0"). ' +
          'Every successful result includes a sizeEstimate {byteCount, tokenEstimate} so you know the cost of what was returned. ' +
          'If the selected subtree exceeds the byte cap, the tool returns counts + representative samples + a narrower-selector hint instead of dumping the full subtree. ' +
          'Missing artifacts and invalid projections return structured rejections with validProjections and path/existence metadata.',
        parameters: Type.Object({
          beadId: Type.String({ description: 'The Bead ID' }),
          stateId: Type.Optional(Type.String({ description: 'Optional state ID for artifact template resolution' })),
          actionId: Type.Optional(Type.String({ description: 'Optional action ID for artifact template resolution' })),
          artifactId: Type.Optional(Type.String({ description: 'Artifact identifier matching a harness.yaml template key (e.g. "planContract", "requirementsAnalysis"). Mutually exclusive with artifactPath.' })),
          artifactPath: Type.Optional(Type.String({ description: 'Explicit filesystem path to the artifact JSON. Mutually exclusive with artifactId.' })),
          projection: Type.Optional(Type.String({ description: 'Named schema-aware projection registered by the consuming project extension (e.g. "writeSet", "planSteps" for planContract). Only registered current names are accepted. Mutually exclusive with selector and summary.' })),
          selector: Type.Optional(Type.String({ description: 'Dot-path or JSON Pointer selector into the artifact JSON (e.g. "writeSet", "planSteps.0.description", or "/writeSet/0"). Mutually exclusive with projection and summary. Empty string returns artifact root subject to byte cap.' })),
          summary: Type.Optional(Type.Boolean({ description: 'When true, return per-projection size estimates (byteCount + tokenEstimate) WITHOUT content. Use this first to see what is available and how large each projection is before fetching inline. Mutually exclusive with projection, selector, and schema.' })),
          schema: Type.Optional(Type.Boolean({ description: 'When true, return the recursive SHAPE of the artifact (object keys + value types + array lengths) with values dropped. Use this to navigate an unfamiliar large JSON before choosing a projection or selector. Mutually exclusive with projection, selector, and summary.' }))
        }),
        execute: async (params: any) => artifactQuery.query(params)
      }) as any);
    }

    if (!session.queryHarnessEventsToolRegistered) {
      session.queryHarnessEventsToolRegistered = true;
      const harnessEventQuery = new HarnessEventQuery(services.eventStore);
      pi.registerTool(wrapRuntimeTool({
        name: BuiltInToolName.QUERY_HARNESS_EVENTS,
        description:
          'Query harness domain events in a bounded, schema-shaped, progressive-disclosure way. ' +
          'DEFAULT mode (detail:false) returns event counts + latest event metadata WITHOUT full payloads — token-efficient for overview queries. ' +
          'DETAIL mode (detail:true) returns up to 100 events with string fields truncated to 300 characters. ' +
          'FILTERS: beadId (scope to one bead), eventTypes (array of type strings), stateId (data.stateId/fromState/nextState), actionId (data.actionId), fromTime/toTime (ISO 8601), limit (detail mode cap ≤ 100), cursor (pagination by event ID). ' +
          'WORKFLOW: (1) Call without detail:true to get counts + countByType + latestEvent metadata. ' +
          '(2) Call with detail:true + beadId/eventTypes to fetch bounded records. ' +
          '(3) Use nextCursor to page forward. ' +
          'Malformed records are reported as skippedCount — never inlined.',
        parameters: Type.Object({
          beadId: Type.Optional(Type.String({ description: 'Scope query to a single bead. When absent, all events are scanned.' })),
          eventTypes: Type.Optional(Type.Array(Type.String(), { description: 'Array of event type strings to include. When absent or empty, all types are returned.' })),
          stateId: Type.Optional(Type.String({ description: 'Filter by state ID (matches data.stateId, data.fromState, or data.nextState).' })),
          actionId: Type.Optional(Type.String({ description: 'Filter by action ID (data.actionId).' })),
          fromTime: Type.Optional(Type.String({ description: 'ISO 8601 lower bound — events at or after this time.' })),
          toTime: Type.Optional(Type.String({ description: 'ISO 8601 upper bound — events at or before this time.' })),
          limit: Type.Optional(Type.Number({ description: 'Max events in detail mode (capped at 100).' })),
          cursor: Type.Optional(Type.String({ description: 'Pagination cursor (event ID from previous nextCursor). Only events after this ID are returned.' })),
          detail: Type.Optional(Type.Boolean({ description: 'When true, return bounded event records (strings truncated to 300 chars, cap 100 events). Default false: return counts + metadata only.' }))
        }),
        execute: async (params: any) => harnessEventQuery.query(params)
      }) as any);
    }

    if (!session.queryToolOutputToolRegistered) {
      session.queryToolOutputToolRegistered = true;
      const toolOutputQuery = new ToolOutputQuery(services.eventStore);
      pi.registerTool(wrapRuntimeTool({
        name: BuiltInToolName.QUERY_TOOL_OUTPUT,
        description:
          'Query a tool\'s persisted output/evidence artifact in a bounded, progressive-disclosure way. ' +
          'Identity is resolved from recorded domain events — arbitrary filesystem paths are REJECTED (security). ' +
          'DEFAULT mode returns metadata only: outputFile path, size, sha256, isJson flag, and available projection modes. ' +
          'DETAIL modes: (1) selector — dot-path into a JSON artifact (e.g. "status", "result.0"); ' +
          '(2) schema — recursive type-shape of a JSON artifact (keys + types + array lengths, values dropped); ' +
          '(3) textTail — last N characters of any file (capped at 24,000 chars). ' +
          'All modes are capped below 24 KB. Raw archives remain complete on disk. ' +
          'WORKFLOW: (1) Call with beadId + stateId + actionId + toolName to get summary metadata. ' +
          '(2) Use selector or textTail to read specific content. ' +
          'Missing artifacts and mismatched identities return structured rejections.',
        parameters: Type.Object({
          beadId: Type.String({ description: 'Bead ID — combined with stateId + actionId + toolName to look up the latest tool result event.' }),
          stateId: Type.String({ description: 'State ID component of the tool invocation identity.' }),
          actionId: Type.String({ description: 'Action ID component of the tool invocation identity.' }),
          toolName: Type.String({ description: 'Tool name component of the tool invocation identity (e.g. "tsc", "git_commit").' }),
          selector: Type.Optional(Type.String({ description: 'Dot-path selector into a JSON artifact (e.g. "status", "result.0"). Empty string returns root (capped at 24 KB). Mutually exclusive with schema and textTail.' })),
          schema: Type.Optional(Type.Boolean({ description: 'When true, return the recursive type-shape of a JSON artifact (keys + types + array lengths, values dropped). Mutually exclusive with selector and textTail.' })),
          textTail: Type.Optional(Type.Number({ description: 'Return the last N characters of the artifact file (capped at 24,000). Mutually exclusive with selector and schema.' }))
        }),
        execute: async (params: any) => toolOutputQuery.query(params)
      }) as any);
    }

    if (!session.readPathContextToolRegistered) {
      session.readPathContextToolRegistered = true;
      const pathContext = new PathContext(services.projectRoot, services.env);
      pi.registerTool(wrapRuntimeTool({
        name: BuiltInToolName.READ_PATH_CONTEXT,
        description:
          'Resolve a candidate file path and validate optional read offsets BEFORE issuing a raw read call. ' +
          'Returns: existence, canonical relative path, total lines, valid offset range (min/max), whether the requested offset is valid, a corrected offset hint if out of range, and nearest existing file matches for ENOENT cases. ' +
          'Use this tool when a file path or line offset is uncertain — it eliminates wasted ENOENT retries and EOF errors. ' +
          'Paths outside the active worktree or project root return a structured out_of_scope rejection (no content leak). ' +
          `Up to ${PathContextDefaults.MAX_NEAR_MATCHES} nearest matches are returned. ` +
          `The optional slice parameter (offset + limit, capped at ${PathContextDefaults.MAX_SLICE_LINES} lines) returns bounded file content when both are valid. ` +
          'The optional skeleton parameter returns a structural skeleton (signatures/declarations with bodies elided); when no extractor is registered for the file extension, skeleton mode fails closed (skeletonContent null, skeletonFallback true) — use explicit offset+limit for raw reads instead.',
        parameters: Type.Object({
          filePath: Type.String({ description: 'The candidate file path to inspect. May be absolute or relative to cwd.' }),
          offset: Type.Optional(Type.Number({ description: '1-based line offset to validate. Response indicates whether this offset is within the file and provides the valid range.' })),
          limit: Type.Optional(Type.Number({ description: `Number of lines to request starting at offset. Capped at ${PathContextDefaults.MAX_SLICE_LINES}. Requires offset to be valid.` })),
          skeleton: Type.Optional(Type.Boolean({ description: 'When true, returns a structural skeleton of the file (signatures/declarations with bodies elided) in skeletonContent, dispatched by file extension to the harness skeletons registry. If no extractor is registered for the extension, fails closed: skeletonContent is null and skeletonFallback is true — use explicit offset+limit for raw reads. Mutually exclusive with offset/limit.' }))
        }),
        execute: async (params: { filePath: string; offset?: number; limit?: number; skeleton?: boolean }) => {
          const result = pathContext.resolve(params);
          // Emit a bounded domain event recording the avoided-retry category.
          // Best-effort: never blocks the tool response.
          services.eventStore.record(DomainEventName.PATH_CONTEXT_RESOLVED, {
            exists: result.status === 'found',
            outOfScope: result.status === 'out_of_scope',
            offsetCorrected: result.status === 'found' && result.correctedOffset !== null,
            beadId: process.env[EnvVars.BEAD_ID],
            stateId: process.env[EnvVars.STATE_ID]
          }).catch(() => {});
          return result;
        }
      }) as any);
    }

    if (!session.preSignalAuditToolRegistered) {
      session.preSignalAuditToolRegistered = true;
      pi.registerTool(wrapRuntimeTool({
        name: BuiltInToolName.PRE_SIGNAL_AUDIT,
        description:
          'Audit the current gate/checkpoint state BEFORE calling submit_checkpoint or signal_completion. ' +
          'Returns required tools (with pass/fail/never_invoked state), terminal failure-limit state, ' +
          'required outcome, and exact blocking evidence. ' +
          'Use this to confirm readiness and surface blockers without waiting for a REJECTED signal. ' +
          'Read-only and best-effort — safe to call at any time. ' +
          'Pass the optional outcome parameter (default: SUCCESS) to evaluate readiness for a specific ' +
          'outcome — non-SUCCESS outcomes skip the SUCCESS-only gates (checklist, required tools, ' +
          'write-set, transactional state) so ready:true accurately reflects what signal_completion ' +
          'would accept for that outcome.',
        parameters: Type.Object({
          outcome: Type.Optional(Type.String({
            description: 'Outcome to evaluate readiness for (e.g. SUCCESS, FAILURE, BLOCKED). Defaults to SUCCESS.'
          }))
        }),
        execute: async ({ outcome: auditOutcome }: { outcome?: string }) => {
          try {
            const activeRun = session.activeRun;
            if (!activeRun) {
              return { status: 'unavailable', reason: 'No active run.' };
            }

            const obs = session.piToolObservability || getObservability(services);
            const config = await services.configLoader.load();
            const outcome = auditOutcome || EventName.SUCCESS;

            // ── evaluate gate readiness using the shared predicate ────────────
            // This is the SAME function signal_completion uses for its gate
            // decision, guaranteeing audit.ready == real gate accept condition.
            const gate = await evaluateGateReadiness(activeRun, outcome, services, session, obs, config, isWorkerMode());

            // ── MCP bridge availability (s3wp.32 — 3rd required surface) ─────
            // Check whether the MCP bridge is healthy for this state's required
            // MCP-backed tools. When the bridge is down, mark those tools as
            // 'unavailable' in the required-tools audit so the agent sees the
            // infra blocker here rather than discovering it at call time.
            // Uses the shared mcpBackedRequiredToolNames helper to avoid
            // duplicating the Supervisor logic.
            const stateRequiredToolNames: string[] = [
              ...(activeRun.state.requiredTools || []).map(t =>
                typeof t === 'string' ? t : t.name
              ).filter((n): n is string => !!n),
              ...(activeRun.action.requiredTools || []).map(t =>
                typeof t === 'string' ? t : t.name
              ).filter((n): n is string => !!n)
            ];
            const requiredMcpToolNames = mcpBackedRequiredToolNames(
              stateRequiredToolNames,
              (config.tools || []) as Array<{ name: string; type: string }>
            );
            let requiredToolsWithMcpStatus = gate.requiredTools;
            const mcpBlockingEvidence: string[] = [];
            if (requiredMcpToolNames.length > 0) {
              const mcpHealth = await checkMcpBridgeHealth(
                requiredMcpToolNames,
                (data) => services.eventStore.record(DomainEventName.MCP_TRANSPORT_PREFLIGHT_FAILED, data)
              );
              if (!mcpHealth.healthy) {
                const unavailableSet = new Set(mcpHealth.affectedToolNames);
                requiredToolsWithMcpStatus = gate.requiredTools.map(entry =>
                  unavailableSet.has(entry.name)
                    ? {
                      ...entry,
                      state: 'unavailable' as const,
                      reason: `unavailable: MCP bridge down — ${mcpHealth.message ?? 'bridge module failed to load'}. ${mcpHealth.remediation ?? ''}`
                    }
                    : entry
                );
                // Also surface tool names that are MCP-required but not yet in
                // gate.requiredTools (e.g. non-SUCCESS outcomes skip the tool audit).
                const alreadyCovered = new Set(gate.requiredTools.map(e => e.name));
                for (const toolName of mcpHealth.affectedToolNames) {
                  if (!alreadyCovered.has(toolName)) {
                    requiredToolsWithMcpStatus = [
                      ...requiredToolsWithMcpStatus,
                      {
                        name: toolName,
                        state: 'unavailable' as const,
                        reason: `unavailable: MCP bridge down — ${mcpHealth.message ?? 'bridge module failed to load'}. ${mcpHealth.remediation ?? ''}`
                      }
                    ];
                  }
                  const evidenceMsg =
                    `Required tool \`${toolName}\` is unavailable: MCP bridge down — ` +
                    `${mcpHealth.message ?? 'bridge module failed to load'}. ` +
                    `${mcpHealth.remediation ?? ''}`.trimEnd();
                  mcpBlockingEvidence.push(evidenceMsg);
                }
              }
            }

            // 0yt5.16/0yt5.22: the legacy per-artifact validator blocking-evidence
            // (present-but-unknown / present-but-rejected, keyed on the hard-coded
            // artifact_validator tool result) has been removed.  Artifact gating is
            // now decided by the coordinator artifact-presence gate (0yt5.20) plus the
            // registered artifact_validator verify() (0yt5.22); the readiness-surface
            // replacement for this audit is owned by bead 0yt5.33.
            const blockingEvidence = [...gate.blockingEvidence, ...mcpBlockingEvidence];

            // ── final ready flag accounts for MCP blocking evidence ──────────
            const ready = gate.ready && mcpBlockingEvidence.length === 0;

            // ── domain event (best-effort) ────────────────────────────────────
            services.eventStore.record(DomainEventName.PRE_SIGNAL_AUDIT_PERFORMED, {
              beadId: activeRun.beadId,
              stateId: activeRun.stateId,
              actionId: activeRun.action.id,
              outcome,
              ready,
              blockingCount: blockingEvidence.length
            }).catch(() => {});

            return {
              ready,
              outcome,
              requiredTools: requiredToolsWithMcpStatus,
              terminalFailureLimit: gate.terminalFailureLimit,
              requiredOutcome: gate.requiredOutcome,
              missingChecklistItems: gate.missingChecklistItems,
              checkpointAccepted: gate.checkpointAccepted,
              writeSetValid: gate.writeSetValid,
              transactionalValid: gate.transactionalValid,
              blockingEvidence
            };
          } catch (err) {
            // Best-effort: never throw from the audit tool
            return {
              ready: false,
              error: String(err),
              blockingEvidence: [`Audit failed: ${String(err)}`]
            };
          }
        }
      }) as any);
    }

    // Build the factory once and store it on the session so that startOrrElse
    // (coordinator path, which always runs AFTER SESSION_START) can reuse the
    // same instance rather than constructing a second one.  Worker processes
    // never call startOrrElse, so this is their only construction site.
    session.teammateFactory = new TeammateFactory(
      runtimeObservability,
      services.configLoader,
      services.eventStore,
      services.apiAddress,
      config.settings.maxConcurrentSlots || Defaults.MAX_SLOTS,
      Defaults.TMUX_SESSION,
      fileURLToPath(import.meta.url)
    );
    const harnessPlugins = [
      services.plugins.bd,
      services.plugins.git,
      teammatePlugin(session.teammateFactory),
      services.plugins.mailbox,
      services.plugins.quality,
      services.plugins.meta
    ];
    const configuredProjectToolNames = new Set(getHarnessRegisteredProjectToolNames(config));
    for (const tool of harnessPlugins.flatMap(plugin => plugin.tools)) {
      if (configuredProjectToolNames.has(tool.name)) {
        Logger.info(Component.ORR_ELSE, 'Skipping generic harness tool because a configured project tool has the same name', { tool: tool.name });
        continue;
      }
      if (seenTools.has(tool.name)) continue;
      seenTools.add(tool.name);
      pi.registerTool(wrapRuntimeTool(tool as any) as any);
    }
    registerConfiguredProjectTools(services.eventStore, services.toolCallPathFactory, pi, config, seenTools, wrapRuntimeTool, () => session.activeRun
      ? {
        beadId: session.activeRun.beadId,
        stateId: session.activeRun.stateId,
        actionId: session.activeRun.action.id
      }
      : undefined, undefined, services.projectToolBackpressure, services.projectRoot);
    validateNativePiExtensionProjectToolInventory(pi, config);

    pi.registerTool(wrapRuntimeTool({
      name: BuiltInToolName.TICK_ITEMS,
      description: 'Batch tick mandatory or optional checklist items for the current phase using event-store-backed state. For each item, supply evidence either inline via `evidence` or by reference via `evidencePath` (preferred for long evidence — keeps your conversation history small).',
      parameters: Type.Object({
        items: Type.Array(Type.Object({
          text: Type.String({ description: 'The EXACT text of the checklist item' }),
          evidence: Type.Optional(Type.String({ description: 'Inline evidence of completion. Use this for short evidence (≲500 chars).' })),
          evidencePath: Type.Optional(Type.String({ description: 'Worktree-relative path to a file containing the evidence. Preferred for long evidence.' }))
        }), { description: 'Checklist items to mark complete.' })
      }),
      execute: async ({ items }: { items: ChecklistTickInput[] }, ctx: ExtensionContext) => tickChecklistItems(items, services, session)
    }));

    pi.registerTool(wrapRuntimeTool({
      name: BuiltInToolName.GET_OUTSTANDING_TASKS,
      description: 'Get the list of mandatory checklist items that still need to be completed.',
      parameters: Type.Object({}),
      execute: async (_params: any, ctx: ExtensionContext) => {
        const activeRun = session.activeRun;
        if (!activeRun) return 'Error: No active run.';
        const projection = await services.eventStore.projectBead(activeRun.beadId);
        const missing = missingMandatoryChecklistItems(activeRun.requiredItems, projection.checklists as any);
        if (missing.length === 0) return 'All mandatory tasks are completed.';
        return `The following mandatory tasks are still OUTSTANDING:\n${missing.map(m => `- ${m}`).join('\n')}`;
      }
    }));

    pi.registerTool(wrapRuntimeTool({
      name: BuiltInToolName.ADD_CHECKLIST_ITEM,
      description: 'Add a runtime checklist item to the current phase so it is enforced by tick_items/get_outstanding_tasks/signal_completion.',
      parameters: Type.Object({
        text: Type.String({ description: 'The checklist item text to add.' }),
        mandatory: Type.Optional(Type.Boolean({ description: 'Whether the item is mandatory. Defaults to true.' })),
        type: Type.Optional(Type.String({ description: 'Checklist item type. Defaults to manual.' })),
        metadata: Type.Optional(Type.Any({ description: 'Optional project-specific metadata for evidence and traceability.' }))
      }),
      execute: async (params: Record<string, unknown>) => addChecklistItem(params, BuiltInToolName.ADD_CHECKLIST_ITEM, services, session)
    }));

    pi.registerTool(wrapRuntimeTool({
      name: BuiltInToolName.SUBMIT_CHECKPOINT,
      description: 'Submit a formal checkpoint of your work, including evidence and summary.',
      parameters: Type.Object({
        summary: Type.String({ description: 'A detailed summary of progress' }),
        evidence: Type.String({ description: 'Detailed evidence (logs, output, etc.)' })
      }),
      execute: async ({ summary, evidence }: { summary: string, evidence: string }, ctx: ExtensionContext) => {
        const activeRun = session.activeRun;
        if (!activeRun) return 'Error: No active run.';

        await activeRun.worklogManager.appendEntry(activeRun.beadId, activeRun.stateId, summary, evidence);

        const event = buildWorkerEvent(TeammateEventType.CHECKPOINT_ACCEPTED, {
          beadId: activeRun.beadId,
          stateId: activeRun.stateId,
          actionId: activeRun.action.id,
          summary,
          evidence
        });

        const checkpointData = {
          beadId: activeRun.beadId,
          workerId: event.workerId,
          sessionStateId: event.sessionStateId,
          stateId: activeRun.stateId,
          actionId: activeRun.action.id,
          actionKey: actionCompletionKey(await services.configLoader.load(), activeRun.stateId, activeRun.action.id),
          idempotencyKey: event.idempotencyKey,
          summary,
          evidence
        };

        await postWorkerSignal(services, event);

        await services.eventStore.record(DomainEventName.CHECKPOINT_SUBMITTED, checkpointData);
        activeRun.checkpointAccepted = true;
        activeRun.handoverSummary = summary;

        if (activeRun.progressManager) {
          await activeRun.progressManager.appendLog(`Checkpoint: ${summary.slice(0, WorkerDefaults.CHECKLIST_EVIDENCE_PREVIEW_CHARS)}...`);
        }

        return 'Checkpoint accepted and recorded.';
      }
    }));

    // ── pi-experiment-x0zh: v2 evidence-only completion surface ─────────────
    // submit_action_evidence is the v2 completion surface for worker/LLM action
    // completion.  Workers submit artifact/evidence references with no
    // outcome/route field.  No workflow state transition results from this call
    // alone — transition requires a schema-valid deterministic ROUTE_EVENT_EMITTED
    // from a configured emitter (e.g. a tool verifier with an emits block).
    //
    // This tool is always registered (so workers can discover it regardless of
    // config version) but only meaningful in v2 configs.  In v1 configs workers
    // should continue to use signal_completion.
    pi.registerTool(wrapRuntimeTool({
      name: BuiltInToolName.SUBMIT_ACTION_EVIDENCE,
      description:
        'v2 only: Submit action evidence and artifact references for this phase. ' +
        'Does NOT trigger a state transition — routing is driven solely by a ' +
        'deterministic route event from a configured emitter. ' +
        'In v2 configs, use this tool instead of signal_completion to record ' +
        'that your action work is complete and artifacts are ready for evaluation.',
      parameters: Type.Object({
        summary: Type.String({ description: 'A dense summary of what was produced or accomplished.' }),
        artifactPaths: Type.Optional(Type.Array(Type.String(), { description: 'Paths to produced artifacts (evidence references).' })),
        evidence: Type.Optional(Type.String({ description: 'Inline evidence text (logs, test output, etc.).' }))
      }),
      execute: async ({ summary, artifactPaths, evidence }: { summary: string; artifactPaths?: string[]; evidence?: string }) => {
        const activeRun = session.activeRun;
        if (!activeRun) return { status: ToolResultStatus.REJECTED, message: 'No active run.' };

        const config = await services.configLoader.load();

        // Record the evidence submission — no route authority, no state mutation.
        await services.eventStore.record(DomainEventName.CHECKPOINT_SUBMITTED, {
          beadId: activeRun.beadId,
          workerId: process.env[EnvVars.WORKER_ID] || `worker-${process.pid}`,
          sessionStateId: process.env[EnvVars.SESSION_STATE_ID],
          stateId: activeRun.stateId,
          actionId: activeRun.action.id,
          actionKey: actionCompletionKey(config, activeRun.stateId, activeRun.action.id),
          idempotencyKey: `${activeRun.beadId}:${activeRun.stateId}:${activeRun.action.id}:evidence:${Date.now()}`,
          summary,
          evidence: evidence ?? summary,
          artifactPaths: artifactPaths ?? [],
          evidenceOnly: true
        });

        // Mark checkpoint accepted so signal_completion gate passes in v1 compat
        // flows; in v2 signal_completion is already blocked.
        activeRun.checkpointAccepted = true;
        activeRun.handoverSummary = summary;

        await activeRun.worklogManager.appendEntry(
          activeRun.beadId,
          activeRun.stateId,
          `Evidence submitted: ${summary.slice(0, WorkerDefaults.CHECKLIST_EVIDENCE_PREVIEW_CHARS)}`,
          [
            evidence ?? summary,
            ...(artifactPaths ?? []).map(p => `artifact: ${p}`)
          ].join('\n')
        );

        if (activeRun.progressManager) {
          await activeRun.progressManager.appendLog(`Evidence: ${summary.slice(0, WorkerDefaults.CHECKLIST_EVIDENCE_PREVIEW_CHARS)}...`);
        }

        // ── pi-experiment-x0zh: v2 coordinator gate trigger ────────────────
        // In v2 configs, post ACTION_EVIDENCE_SUBMITTED to the coordinator so
        // it can run its deterministic gate + emits mapping → ROUTE_EVENT_EMITTED
        // → STATE_TRANSITION_APPLIED. This is the ONLY path to a transition in v2.
        // v1 configs are completely unaffected (no signal posted).
        if (config.version === 2) {
          const workerId = process.env[EnvVars.WORKER_ID] || `worker-${process.pid}`;
          const evidenceSignal = {
            type: TeammateEventType.ACTION_EVIDENCE_SUBMITTED,
            beadId: activeRun.beadId,
            workerId,
            sessionStateId: process.env[EnvVars.SESSION_STATE_ID],
            stateId: activeRun.stateId,
            actionId: activeRun.action.id,
            summary,
            timestamp: Date.now(),
            idempotencyKey: `${activeRun.beadId}:${activeRun.stateId}:${activeRun.action.id}:evidence-gate:${uuidv7()}`
          };
          await postWorkerSignal(services, evidenceSignal as import('./core/TeammateEvents.js').TeammateEvent).catch((err: unknown) => {
            Logger.warn(Component.ORR_ELSE, 'v2: failed to post ACTION_EVIDENCE_SUBMITTED to coordinator', {
              beadId: activeRun.beadId, error: String(err)
            });
          });
        }

        return {
          status: ToolResultStatus.PASSED,
          message: 'Evidence recorded. Coordinator gate will now evaluate deterministic transition via route event.'
        };
      }
    }));

    pi.registerTool(wrapRuntimeTool({
      name: BuiltInToolName.SUBMIT_REVIEW_ARTIFACT,
      description: 'Persist the configured ship/post-review artifact to the Orr Else event store. Use this instead of native writes for event-store-backed review artifacts.',
      parameters: Type.Object({
        summary: Type.String({ description: 'Dense review artifact summary.' }),
        artifact: Type.Any({ description: 'Structured review artifact payload, including verdict, specialist passes, evidence audit, routing outcome, and blockers.' }),
        verdict: Type.Optional(Type.String({ description: 'Review verdict, for example APPROVED or REJECTED.' })),
        outcome: Type.Optional(Type.String({ description: 'Configured statechart outcome the review will use, for example SUCCESS or IMPLEMENTATION_DEFECT.' }))
      }),
      execute: async (
        { summary, artifact, verdict, outcome }: { summary: string; artifact: unknown; verdict?: string; outcome?: string },
        _ctx: ExtensionContext
      ) => {
        const activeRun = session.activeRun;
        if (!activeRun) return { status: ToolResultStatus.REJECTED, message: 'No active run.' };
        const config = await services.configLoader.load();
        const reviewArtifactConfig = config.settings.reviewArtifacts?.shipPostReview;
        const store = reviewArtifactConfig?.store || ReviewArtifactStore.EVENT_STORE;
        if (store !== ReviewArtifactStore.EVENT_STORE) {
          return {
            status: ToolResultStatus.REJECTED,
            message: `Configured ship/post-review store is ${store}; ${BuiltInToolName.SUBMIT_REVIEW_ARTIFACT} supports ${ReviewArtifactStore.EVENT_STORE}.`
          };
        }
        if (reviewArtifactConfig?.state && reviewArtifactConfig.state !== activeRun.stateId) {
          return {
            status: ToolResultStatus.REJECTED,
            message: `Ship/post-review artifact is configured for ${reviewArtifactConfig.state}, not ${activeRun.stateId}.`
          };
        }

        // ── pi-experiment-x0zh: v2 route-authority stripping ─────────────────
        // In v2 configs the review artifact `outcome` field is IGNORED as route
        // authority before projection — only a schema-valid ROUTE_EVENT_EMITTED
        // from a deterministic emitter may drive transitions.  The artifact itself
        // is still recorded as evidence (non-routing).
        const effectiveOutcome = config.version === 2 ? undefined : outcome;
        if (config.version === 2 && outcome) {
          await services.eventStore.record(DomainEventName.V2_MODEL_ROUTE_REJECTED, {
            beadId: activeRun.beadId,
            stateId: activeRun.stateId,
            actionId: activeRun.action.id,
            surface: 'submit_review_artifact.outcome',
            rejectedRoute: outcome,
            reason: 'v2 configs do not permit review-artifact outcome fields as route authority; routing requires a deterministic ROUTE_EVENT_EMITTED'
          }).catch(() => {});
        }

        const actionKey = actionCompletionKey(config, activeRun.stateId, activeRun.action.id);
        const eventType = reviewArtifactConfig?.eventType || DomainEventName.SHIP_POST_REVIEW;
        await services.eventStore.record(eventType, {
          beadId: activeRun.beadId,
          stateId: activeRun.stateId,
          actionId: activeRun.action.id,
          actionKey,
          artifactKind: ReviewArtifactKind.SHIP_POST_REVIEW,
          store,
          summary,
          verdict,
          outcome: effectiveOutcome,
          artifact
        });
        await activeRun.worklogManager.appendEntry(activeRun.beadId, activeRun.stateId, 'Ship/post-review artifact recorded', summary);

        return {
          status: ToolResultStatus.PASSED,
          artifactKind: ReviewArtifactKind.SHIP_POST_REVIEW,
          store,
          eventType,
          summary
        };
      }
    }));

    pi.registerTool(wrapRuntimeTool({
      name: BuiltInToolName.SIGNAL_COMPLETION,
      description: 'Signal that your work in this phase is complete and you are ready to transition.',
      parameters: Type.Object({
        outcome: Type.String({ description: 'Configured statechart outcome, for example SUCCESS, FAILURE, BLOCKED, or a project-specific rejection route' }),
        summary: Type.String({ description: 'A dense handover summary of what was accomplished' })
      }),
      execute: async ({ outcome, summary }: { outcome: string, summary: string }, ctx: ExtensionContext) => {
        const activeRun = session.activeRun;
        if (!activeRun) return 'Error: No active run.';

        // ── pi-experiment-x0zh: v2 route-authority stripping (FIRST CHECK) ──
        // In v2 configs (version === 2) the worker/model MUST NOT drive routing
        // via signal_completion(outcome). Reject immediately — before ALL gate
        // readiness checks — so the v2 rejection is unambiguous regardless of
        // checkpoint, checklist, or failure-limit state.  A V2_MODEL_ROUTE_REJECTED
        // diagnostic is appended; no workflow state mutation occurs.
        // v1 configs are completely unaffected.
        {
          const cfgForV2Check = await services.configLoader.load();
          if (cfgForV2Check.version === 2) {
            Logger.warn(Component.ORR_ELSE, 'v2: signal_completion outcome rejected as route authority', {
              beadId: activeRun.beadId, stateId: activeRun.stateId, actionId: activeRun.action.id, outcome
            });
            await services.eventStore.record(DomainEventName.V2_MODEL_ROUTE_REJECTED, {
              beadId: activeRun.beadId,
              stateId: activeRun.stateId,
              actionId: activeRun.action.id,
              surface: 'signal_completion',
              rejectedRoute: outcome,
              reason: 'v2 configs do not permit worker/model-supplied route authority via signal_completion; use submit_action_evidence and await a deterministic ROUTE_EVENT_EMITTED'
            }).catch(() => {});
            return `REJECTED: In v2 configs the \`outcome\` field of \`${BuiltInToolName.SIGNAL_COMPLETION}\` is not accepted as route authority. Use \`${BuiltInToolName.SUBMIT_ACTION_EVIDENCE}\` to record evidence; routing is driven solely by deterministic route events.`;
          }
        }

        // ── Gate evaluation (shared predicate) ─────────────────────────────
        // evaluateGateReadiness is the single source of truth for whether this
        // outcome would be accepted. signal_completion calls it here and maps
        // the result to its canonical REJECTED messages (behavior-preserving).
        // NOTE: For the transactional state check, evaluateGateReadiness calls
        // validateSuccessReadOnly (no auto-restore side effects). When the gate
        // PASSES, we then call validateSuccess below so that the auto-restore
        // logic fires exactly as it did before refactoring.
        const obs = session.piToolObservability || getObservability(services);
        const gateReadiness = await evaluateGateReadiness(activeRun, outcome, services, session, obs, config, isWorkerMode());

        if (!gateReadiness.transitionValid) {
          // transitionError is set when transitionValid is false
          return `REJECTED: ${gateReadiness.transitionError}`;
        }

        if (gateReadiness.terminalFailureLimit.reached && outcome !== gateReadiness.terminalFailureLimit.suggestedOutcome) {
          const terminal = gateReadiness.terminalFailureLimit;
          return `REJECTED: terminal failure limit already reached for project tool \`${terminal.failedTool}\` ` +
            `in ${activeRun.stateId}/${activeRun.action.id}. You MUST signal outcome ` +
            `\`${terminal.suggestedOutcome}\`; outcome \`${outcome}\` is not permitted after this terminal verifier failure.`;
        }

        if (isAdvanceOutcome(outcome, config)) {
          if (gateReadiness.missingChecklistItems.length > 0) {
            return `REJECTED: You cannot signal SUCCESS yet. The following mandatory checklist items are missing:\n${gateReadiness.missingChecklistItems.map(m => `- ${m}`).join('\n')}\nUse the \`${BuiltInToolName.TICK_ITEMS}\` tool to complete them in a batch.`;
          }

          if (gateReadiness.toolAuditFailures.length > 0) {
            return `REJECTED: Protocol Violation. Programmatic audit failed:\n${gateReadiness.toolAuditFailures.map(f => `- ${f}`).join('\n')}\nYou MUST satisfy all programmatic gates before signaling completion.`;
          }

          if (!gateReadiness.writeSetValid) {
            return `REJECTED: Plan write-set preflight failed.\n${gateReadiness.writeSetReason}\nRevise the plan contract before signaling SUCCESS.`;
          }

          if (!gateReadiness.provenanceValid) {
            return `REJECTED: ${gateReadiness.provenanceReason}. Re-run the harness so a fresh run is initialized with current prompt/config hashes before signaling SUCCESS.`;
          }

          // For the transactional state gate at signal time, call validateSuccess
          // (with auto-restore side effects) as the original code did. This is
          // separate from evaluateGateReadiness which uses validateSuccessReadOnly.
          const transactionalState = await services.transactionalStateGuard.validateSuccess(
            activeRun.beadId,
            activeRun.stateId,
            activeRun.worktreePath || process.cwd()
          );
          if (!transactionalState.passed) {
            return `REJECTED: Transactional state gate failed.\n${transactionalState.reason}\nUpdate the approved plan/write-set through the configured workflow or revert the unapproved files before signaling SUCCESS.`;
          }

          // ── Gate 6a: handoverRequired (enforcing) ─────────────────────────
          // evaluateGateReadiness (called above) already computed handoverSatisfied
          // and populated blockingEvidence for the handover gate. Reuse that result
          // directly — do NOT re-compute. This is the ENFORCING path that makes
          // handoverRequired actually binding on signal_completion (not just advisory
          // in pre_signal_audit). Fires only on advance outcomes (SUCCESS), never on
          // FAILURE/BLOCKED, and never when handoverRequired is false.
          if (!gateReadiness.handoverSatisfied) {
            const handoverEvidence = gateReadiness.blockingEvidence.find(e => e.includes('handoverRequired'));
            return `REJECTED: ${handoverEvidence ?? 'Action declares \`handoverRequired: true\` but no substantive checkpoint summary was recorded. Call \`${BuiltInToolName.SUBMIT_CHECKPOINT}\` with a detailed summary before signaling completion.'}`;
          }

          // ── Gate 5a: required ship/post-review artifact (enforcing) ──────────
          // evaluateGateReadiness computed reviewArtifactSatisfied and populated
          // blockingEvidence. Reuse that result — do NOT re-query the event store.
          if (!gateReadiness.reviewArtifactSatisfied) {
            const artifactEvidence = gateReadiness.blockingEvidence.find(e =>
              e.includes('SHIP_POST_REVIEW') || e.includes('ship/post-review artifact')
            );
            return `REJECTED: ${artifactEvidence ?? `Required ship/post-review artifact has not been recorded. Call \`${BuiltInToolName.SUBMIT_REVIEW_ARTIFACT}\` before signaling SUCCESS.`}`;
          }
        }

        if (!activeRun.checkpointAccepted) {
          return `REJECTED: You must call \`${BuiltInToolName.SUBMIT_CHECKPOINT}\` with durable evidence before signaling completion.`;
        }

        Logger.info(Component.ORR_ELSE, 'Teammate signaled turn completion', { beadId: activeRun.beadId, outcome, summary });

        const event = buildWorkerEvent(teammateEventTypeForOutcome(outcome, config), {
          beadId: activeRun.beadId,
          stateId: activeRun.stateId,
          actionId: activeRun.action.id,
          transitionEvent: outcome,
          summary,
          evidence: summary,
          handover: summary,
          usedTools: runtimeObservability.getCalledTools()
        });

        // pi-experiment-3b5e: fail-closed dispatch-side validation for worker completion.
        // The workerCompletion schema enforces beadId/stateId/outcome are present and
        // well-formed before the signal is sent. Fail closed — blocked, not heuristic.
        const completionValidation = validateHandoffPayload(
          HandoffSchemaId.WORKER_COMPLETION,
          { beadId: activeRun.beadId, stateId: activeRun.stateId, actionId: activeRun.action.id, workerId: event.workerId, outcome },
          { beadId: activeRun.beadId, stateId: activeRun.stateId, actionId: activeRun.action.id }
        );
        if (!completionValidation.valid) {
          const { diagnostic } = completionValidation;
          Logger.error(Component.ORR_ELSE, 'Dispatch-side workerCompletion schema validation FAILED — blocking signal', {
            beadId: activeRun.beadId,
            stateId: activeRun.stateId,
            actionId: activeRun.action.id,
            schemaId: diagnostic.schemaId,
            failurePath: diagnostic.failurePath
          });
          throw new Error(
            `Handoff schema violation [${diagnostic.schemaId}] for beadId=${activeRun.beadId} stateId=${activeRun.stateId} actionId=${activeRun.action.id}: ${diagnostic.failurePath.join('; ')}`
          );
        }

        await postWorkerSignal(services, event);

        if (ctx.hasUI) {
          ctx.ui.notify(`Turn completed with ${outcome}`, 'info');
        }

        setTimeout(() => {
          if (ctx.hasUI) ctx.ui.setStatus(Component.ORR_ELSE.toLowerCase(), 'Shutting down...');
          ctx.shutdown();
        }, WorkerDefaults.SHUTDOWN_AFTER_SIGNAL_MS);

        return `Completion signaled with outcome: ${outcome}. Teammate process will exit.`;
      }
    }));

    pi.registerTool(wrapRuntimeTool({
      name: BuiltInToolName.REQUEST_CONTEXT_RESTART,
      // pi-experiment-6q0y.36: evidence-aware restart. Requires evidenceRefs[] plus
      // either handoverArtifactPath OR a configured compaction-artifact pointer.
      // summary-only requests are REJECTED before admission (AC1/AC3).
      description: 'Request a fresh Pi session with an evidence-aware handoff to reset context pollution. Requires evidenceRefs[] (with schemaId, semanticArtifactPath, bytes, sha256) plus either handoverArtifactPath or a configured compaction-artifact pointer. Summary-only requests are rejected.',
      parameters: Type.Object({
        summary: Type.String({ description: 'Non-authoritative narrative preview for the next session (stored separately; never used for progress decisions)' }),
        evidenceRefs: Type.Array(
          Type.Object({
            schemaId: Type.String({ description: 'Registered schema ID for this artifact' }),
            semanticArtifactPath: Type.String({ description: 'Semantic path of the artifact' }),
            bytes: Type.Number({ description: 'Artifact size in bytes' }),
            sha256: Type.String({ description: 'SHA-256 hex digest of the artifact (64 chars)' }),
            sourceEventIds: Type.Optional(Type.Array(Type.String(), { description: 'Domain event IDs this ref was derived from' }))
          }),
          { description: 'Deterministic evidence refs (required; non-empty for admitted restarts)' }
        ),
        handoverArtifactPath: Type.Optional(Type.String({ description: 'Explicit handoff artifact path (optional when compaction pointer available)' }))
      }),
      execute: async ({ summary, evidenceRefs, handoverArtifactPath }: {
        summary: string;
        evidenceRefs: RestartEvidenceRef[];
        handoverArtifactPath?: string;
      }, ctx: ExtensionContext) => {
        const activeRun = session.activeRun;
        if (!activeRun) return 'Error: No active run.';
        const config = await services.configLoader.load();

        const event = buildWorkerEvent(TeammateEventType.CONTEXT_RESTART_REQUESTED, {
          beadId: activeRun.beadId,
          stateId: activeRun.stateId,
          actionId: activeRun.action.id,
          transitionEvent: config.settings.contextRestartEvent || EventName.CONTEXT_RESTART,
          summary,
          evidence: summary,
          handover: summary,
          // pi-experiment-6q0y.36: carry evidence-aware handoff contract fields.
          evidenceRefs,
          ...(handoverArtifactPath !== undefined ? { handoverArtifactPath } : {})
        });

        await postWorkerSignal(services, event);

        setTimeout(() => ctx.shutdown(), WorkerDefaults.SHUTDOWN_AFTER_SIGNAL_MS);
        return 'Context restart requested. Session will shutdown.';
      }
    }));

    pi.registerTool(wrapRuntimeTool({
      name: BuiltInToolName.REQUEST_HARNESS_RESTART,
      description: 'Request a fresh Pi harness session for transient harness or Pi transport failures without treating the Bead as blocked.',
      parameters: Type.Object({
        summary: Type.String({ description: 'Handover summary for the next harness session' })
      }),
      execute: async ({ summary }: { summary: string }, ctx: ExtensionContext) => {
        const activeRun = session.activeRun;
        if (!activeRun) return 'Error: No active run.';
        const config = await services.configLoader.load();

        const event = buildWorkerEvent(TeammateEventType.HARNESS_RESTART_REQUESTED, {
          beadId: activeRun.beadId,
          stateId: activeRun.stateId,
          actionId: activeRun.action.id,
          transitionEvent: config.settings.harnessRestartEvent || EventName.HARNESS_RESTART,
          summary,
          evidence: summary,
          handover: summary
        });

        await postWorkerSignal(services, event);

        setTimeout(() => ctx.shutdown(), WorkerDefaults.SHUTDOWN_AFTER_SIGNAL_MS);
        return 'Harness restart requested. Session will shutdown.';
      }
    }));

    pi.registerTool(wrapRuntimeTool({
      name: BuiltInToolName.HARNESS_STATUS,
      description: 'Report the active Orr Else flow and state turn.',
      parameters: Type.Object({}),
      execute: async () => flowStatus(services, session)
    }));

    if (isWorkerMode()) {
      await initializeWorkerRun(runtimeObservability, services, session);
      await runParentSequenceActionsBeforeActive(config, ctx, runtimeObservability, services, session);
      const env = nodeRuntimeEnvironment;
      const workerContext: WorkerContext = {
        beadId: env.env(EnvVars.BEAD_ID) as BeadId | undefined,
        stateId: env.env(EnvVars.STATE_ID) ? asStateId(env.env(EnvVars.STATE_ID)!) : undefined,
        projectRoot: env.env(EnvVars.PROJECT_ROOT) || process.cwd(),
        worktreePath: env.env(EnvVars.WORKTREE_PATH) || undefined,
        workerId: asWorkerId(env.env(EnvVars.WORKER_ID) || `worker-${process.pid}`),
        actionId: asActionId(env.env(EnvVars.ACTION_ID) || WorkerDefaults.AUTO_CONTEXT_RESTART_ACTION_ID)
      };
      const teammate = new Teammate(
        pi,
        ctx,
        runtimeObservability,
        services.configLoader,
        services.eventStore,
        services.flowManager,
        services.plugins.bd,
        services.plugins.git,
        services.plugins.mailbox,
        services.plugins.quality,
        workerContext,
        getConfiguredProjectToolNames
      );
      await teammate.start().catch(async err => {
        Logger.error(Component.ORR_ELSE, 'Teammate start failed', { err: String(err) });
        const activeRun = session.activeRun;
        if (!activeRun) return;
        session.agentFailureSignaled = true;
        const summary = `Teammate bootstrap failed: ${String(err)}`;
        await services.eventStore.record(DomainEventName.AGENT_TURN_FAILED, {
          beadId: activeRun.beadId,
          stateId: activeRun.stateId,
          actionId: activeRun.action.id,
          source: 'teammate-bootstrap',
          summary,
          error: String(err)
        }).catch(recordError => {
          Logger.warn(Component.ORR_ELSE, 'Failed to record teammate bootstrap failure', {
            beadId: activeRun?.beadId,
            error: String(recordError)
          });
        });
        const blockedEvent = buildWorkerEvent(TeammateEventType.STATE_BLOCKED, {
          beadId: activeRun.beadId,
          stateId: activeRun.stateId,
          actionId: activeRun.action.id,
          transitionEvent: EventName.BLOCKED,
          summary,
          evidence: summary,
          handover: summary
        });
        await postWorkerSignal(services, blockedEvent).catch(signalError => {
          Logger.error(Component.ORR_ELSE, 'Failed to signal teammate bootstrap failure', {
            beadId: activeRun?.beadId,
            error: String(signalError)
          });
        });
      });
      return;
    }

    // NOTE: BuiltInToolName.ORR_ELSE ('orr-else') is a Pi COMMAND registered via
    // pi.registerCommand(), not a model-callable tool. It must NOT appear in
    // setActiveTools or be counted as a callable requiredTool — the command
    // surface and the model-callable tool surface are distinct (pi-experiment-2xho).
    services.flowManager.activateTools(pi, [
      BuiltInToolName.HARNESS_STATUS,
      ...services.plugins.bd.tools.map(t => t.name),
      ...getConfiguredProjectToolNames(config),
      ...getConfiguredPiToolNames(config)
    ]);
  }
}
