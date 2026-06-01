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
import { computeBuildProvenance, runStalenessPreflightWarn } from './core/BuildProvenance.js';
import { Command } from 'commander';
import { parse as parseShellCommand } from 'shell-quote';
import { z } from 'zod';
import escapeStringRegexp from 'escape-string-regexp';
import { teammatePlugin, TeammateFactory } from './plugins/teammates.js';
import type { MergeResult } from './core/RuntimeServices.js';
import {
  describeConfiguredProjectTools,
  executeConfiguredProjectTool,
  getConfiguredProjectToolNames,
  getHarnessRegisteredProjectToolNames,
  getNativePiExtensionProjectToolNames,
  projectToolFailureLimitSuggestedOutcome,
  registerConfiguredProjectTools
} from './plugins/projectTools.js';
import type { HarnessConfig } from './core/ConfigLoader.js';
import { resolveProviderName } from './core/ConfigLoader.js';
import { SignalingServer } from './core/SignalingServer.js';
import { Bead, BeadId } from './types/index.js';
import {
  TeammateEvent,
  createTeammateEventIdempotencyKey,
  decideTeammateEventProcessing,
  findAppliedTeammateSignal,
  isStatusMutatingTeammateEvent
} from './core/TeammateEvents.js';
import { capAnthropicMaxTokens, resolveMaxOutputTokens, type CappableAnthropicPayload } from './core/ProviderRequestCap.js';
import { buildTurnUsageRecord } from './core/TokenUsage.js';
import { registerClaudeCodeLiveLogin } from './plugins/claudeCodeAuth.js';
import { postHarnessSignal } from './core/HarnessApiClient.js';
import { Logger } from './core/Logger.js';
import { Observability, SpanStatusValue, type SpanAttributes, type SpanCompletion, type SpanContext } from './core/Observability.js';
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
  ToolValidationCondition,
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
  ProcessEventName,
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
  ToolDefaults,
  LLMProviderName,
  OtelAttr
} from './constants/index.js';
import { Supervisor } from './core/Supervisor.js';
import { requireTool } from './core/ToolRegistry.js';
import { Teammate, type WorkerContext } from './core/Teammate.js';
import { nodeRuntimeEnvironment } from './core/RuntimeEnvironment.js';
import { getConfiguredPiToolNames, getObservedPiToolNames, resolvePiSkillPaths } from './core/PiIntegration.js';
import { createRuntimeServices, type RuntimeServices } from './composition/createRuntimeServices.js';
import { ArtifactQuery } from './core/ArtifactQuery.js';
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

/**
 * Orr Else Extension
 * High-reliability agentic harness with obsessive, rehearsed resilience.
 */

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
  // ── tool execution ────────────────────────────────────────────────────────
  /**
   * Per-(bead, tool) consecutive-failure counter.  Worker mode only.
   * Cleared on initializeWorkerRun.
   */
  toolBreakerFailures: Map<string, number>;
  /**
   * In-session result memoisation for cacheable project tools.
   * Key: `${toolName}|${JSON.stringify(params)}`.
   * Cleared on fresh worker run and after any non-cacheable tool call.
   */
  toolResultCache: Map<string, { result: unknown; recordedAt: number }>;
  // ── pi-tool observability ─────────────────────────────────────────────────
  piToolObservability: Observability | null;
  observedPiTools: Set<string>;
  blockedObservedPiToolCallIds: Set<string>;
  observedPiToolSpans: Map<string, SpanContext>;
  // ── registration guards (reset each invocation so a second call re-registers) ──
  artifactPathsToolRegistered: boolean;
  queryArtifactToolRegistered: boolean;
  compatibilityContextToolRegistered: boolean;
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
    supervisor: null,
    currentFlowOptions: null,
    teammateFactory: null,
    activeRun: null,
    agentFailureSignaled: false,
    checklistMutationQueue: Promise.resolve(),
    currentTurnStartMs: undefined,
    stateCycleCounter: new Map(),
    toolBreakerFailures: new Map(),
    toolResultCache: new Map(),
    piToolObservability: null,
    observedPiTools: new Set(),
    blockedObservedPiToolCallIds: new Set(),
    observedPiToolSpans: new Map(),
    artifactPathsToolRegistered: false,
    queryArtifactToolRegistered: false,
    compatibilityContextToolRegistered: false,
    piToolObserverRegistered: false,
    providerRequestCapRegistered: false,
    claudeCodeLoginRegistered: false,
    agentLifecycleObserverRegistered: false,
  };
}

/**
 * Process-global guard for registerProcessLifecycleObservers.
 *
 * Intentionally NOT part of ExtensionSession: it guards process.on() calls on
 * the Node.js `process` object, which is shared across all invocations within
 * the same OS process.  Moving it to ExtensionSession (always false at session
 * creation) would cause a second orrElseExtension() call to add four duplicate
 * permanent process listeners, triggering MaxListenersExceededWarning and
 * leaking listeners on every subsequent re-invocation.
 */
let processLifecycleObserversRegistered = false;

const TERMINAL_FAILURE_ALLOWED_TOOLS = new Set<string>([
  BuiltInToolName.ADD_CHECKLIST_ITEM,
  BuiltInToolName.TICK_ITEM,
  BuiltInToolName.TICK_ITEMS,
  BuiltInToolName.GET_OUTSTANDING_TASKS,
  BuiltInToolName.SUBMIT_CHECKPOINT,
  BuiltInToolName.SUBMIT_REVIEW_ARTIFACT,
  BuiltInToolName.SIGNAL_COMPLETION,
  BuiltInToolName.REQUEST_CONTEXT_RESTART,
  BuiltInToolName.REQUEST_HARNESS_RESTART
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

interface TerminalFailureLimitContext {
  failedTool: string;
  suggestedOutcome: string;
  stateId: string;
  actionId: string;
}

function routingHintSuggestedOutcomeFromResult(result: Record<string, any>): string | undefined {
  const candidates = [
    result.routingHint,
    isRecord(result.structuredResult) ? result.structuredResult.routingHint : undefined,
    isRecord(result.result) ? result.result.routingHint : undefined,
    isRecord(result.result) && isRecord(result.result.structuredResult)
      ? result.result.structuredResult.routingHint
      : undefined
  ];
  for (const candidate of candidates) {
    if (isRecord(candidate) && typeof candidate.suggestedOutcome === 'string') {
      return candidate.suggestedOutcome;
    }
  }
  return undefined;
}

function getObservability(services: RuntimeServices): Observability {
  return services.observability;
}

function registerProcessLifecycleObservers(): void {
  if (processLifecycleObserversRegistered) return;
  processLifecycleObserversRegistered = true;

  process.on(ProcessEventName.BEFORE_EXIT, code => {
    Logger.warn(Component.ORR_ELSE, 'Pi process beforeExit observed', { code, isWorker: isWorkerMode() });
  });
  process.on(ProcessEventName.EXIT, code => {
    Logger.warn(Component.ORR_ELSE, 'Pi process exit observed', { code, isWorker: isWorkerMode() });
  });
  process.on(ProcessEventName.UNCAUGHT_EXCEPTION_MONITOR, error => {
    Logger.error(Component.ORR_ELSE, 'Uncaught exception observed', {
      error: String(error),
      stack: error instanceof Error ? error.stack : undefined,
      isWorker: isWorkerMode()
    });
  });
  process.on(ProcessEventName.UNHANDLED_REJECTION, reason => {
    Logger.error(Component.ORR_ELSE, 'Unhandled rejection observed', {
      error: String(reason),
      isWorker: isWorkerMode()
    });
  });
}

async function initializeObservability(services: RuntimeServices): Promise<Observability> {
  const runtimeObservability = getObservability(services);
  await runtimeObservability.initialize();
  services.eventStore.setSessionId(runtimeObservability.getSessionId());
  return runtimeObservability;
}

function toolResult(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return {
    content: [{ type: 'text' as const, text }],
    details: value
  };
}

function requiredToolsForRun(run: ActiveRun): RequiredTool[] | undefined {
  const requiredTools = [
    ...(run.state.requiredTools || []),
    ...(run.action.requiredTools || [])
  ];
  return requiredTools.length > 0 ? requiredTools : undefined;
}

// summarizeForEvent and related helpers are imported from ./extension/PiEventAdapters.js

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

function toolSpanAttributes(toolName: string, params: unknown, beadId: string | undefined, session: ExtensionSession, externalPiTool = false): SpanAttributes {
  return {
    'tool.name': toolName,
    'tool.params': stringifySpanAttribute(summarizeForEvent(params)),
    'tool.external_pi': externalPiTool || undefined,
    ...activeSpanAttributes(beadId, session)
  };
}

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

function isTerminalFailureLimitPayload(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && isRecord(value.failureLimit) && value.failureLimit.terminal === true;
}

function terminalFailureLimitDataFromResult(result: unknown): Record<string, unknown> | undefined {
  if (!isTerminalFailureLimitPayload(result)) return undefined;
  return {
    tool: typeof result.tool === 'string' ? result.tool : undefined,
    result
  };
}

function scanTerminalFailureLimit(run: ActiveRun, services: RuntimeServices): Promise<DomainEvent | undefined> {
  return services.eventStore.latestProjectToolFailureLimitEvent(run.beadId, {
    stateId: run.stateId,
    actionId: run.action.id,
    terminalOnly: true
  });
}

function preloadTerminalFailureLimit(run: ActiveRun, services: RuntimeServices): void {
  if (run.terminalFailureLimitScanned || run.terminalFailureLimitScan) return;
  run.terminalFailureLimitScan = scanTerminalFailureLimit(run, services)
    .then(event => {
      run.terminalFailureLimitScanned = true;
      if (event) run.terminalFailureLimitEvent = event;
      return event;
    })
    .catch(error => {
      run.terminalFailureLimitScan = undefined;
      Logger.warn(Component.ORR_ELSE, 'Unable to preload terminal project-tool failure limit', {
        beadId: run.beadId,
        stateId: run.stateId,
        actionId: run.action.id,
        error: String(error)
      });
      return undefined;
    });
}

const SHELL_OPERATIONAL_MUTATION_COMMANDS = new Set<string>([
  FileMutationPolicyDefaults.CP_COMMAND,
  FileMutationPolicyDefaults.MKDIR_COMMAND,
  FileMutationPolicyDefaults.MV_COMMAND,
  FileMutationPolicyDefaults.RM_COMMAND,
  FileMutationPolicyDefaults.RMDIR_COMMAND,
  FileMutationPolicyDefaults.SED_COMMAND,
  FileMutationPolicyDefaults.TEE_COMMAND,
  FileMutationPolicyDefaults.TOUCH_COMMAND,
  FileMutationPolicyDefaults.TRUNCATE_COMMAND
]);
const GIT_OPERATIONAL_MUTATION_SUBCOMMANDS = new Set<string>([
  FileMutationPolicyDefaults.GIT_ADD_SUBCOMMAND,
  FileMutationPolicyDefaults.GIT_CLEAN_SUBCOMMAND,
  FileMutationPolicyDefaults.GIT_MV_SUBCOMMAND,
  FileMutationPolicyDefaults.GIT_RM_SUBCOMMAND,
  FileMutationPolicyDefaults.GIT_RESTORE_SUBCOMMAND,
  FileMutationPolicyDefaults.GIT_CHECKOUT_SUBCOMMAND
]);
const NATIVE_PATH_INPUT_KEYS = [
  'path',
  'filePath',
  'file_path',
  'targetFile',
  'target_file'
] as const;
const NATIVE_OPERATIONAL_MUTATION_TOOLS = new Set<string>([
  NativePiToolName.EDIT,
  NativePiToolName.WRITE
]);
const OPERATIONAL_READ_DIRS = [
  OperationalArtifactPath.LEGACY_STATE_DIR,
  OperationalArtifactPath.PI_EVENTS_DIR,
  OperationalArtifactPath.PI_LOGS_DIR,
  OperationalArtifactPath.PI_MAILBOX_DIR,
  OperationalArtifactPath.PI_OTEL_DIR,
  OperationalArtifactPath.PI_ARTIFACTS_DIR,
  OperationalArtifactPath.PI_TOOL_OUTPUT_DIR
] as const;
const OPERATIONAL_MUTATION_DIRS = [
  OperationalArtifactPath.LEGACY_STATE_DIR,
  OperationalArtifactPath.PI_EVENTS_DIR,
  OperationalArtifactPath.PI_LOGS_DIR,
  OperationalArtifactPath.PI_MAILBOX_DIR,
  OperationalArtifactPath.PI_OTEL_DIR,
  OperationalArtifactPath.PI_TOOL_OUTPUT_DIR,
  OperationalArtifactPath.TEMP_DIR
] as const;
const PROJECT_TOOL_CALL_OUTPUT_DIR = `${OperationalArtifactPath.TEMP_DIR}/tool-calls`;
const PROJECT_TOOL_CALL_OUTPUT_READ_GUIDANCE =
  `PROTOCOL VIOLATION: \`${NativePiToolName.READ}\` may not read project-tool output archives directly. ` +
  'Use the inline project-tool result preview, rerun the configured project tool with narrower arguments, or use a harness-owned project-tool output preview when available.';

function nativeToolPath(event: ToolCallEvent): string {
  const input = event.input as Record<string, unknown>;
  for (const key of NATIVE_PATH_INPUT_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function toSlashPath(value: string): string {
  return value.replaceAll(path.sep, '/');
}

function relativeOperationalPath(requestedPath: string): string {
  const trimmed = requestedPath.trim();
  if (!trimmed) return '';

  if (!path.isAbsolute(trimmed)) return toSlashPath(trimmed).replace(/^\.\//, '');

  const absolutePath = path.resolve(trimmed);
  const roots = [
    process.env[EnvVars.WORKTREE_PATH],
    process.env[EnvVars.PROJECT_ROOT],
    process.cwd()
  ].filter((root): root is string => typeof root === 'string' && root.length > 0)
    .map(root => path.resolve(root));

  for (const root of roots) {
    const relativePath = path.relative(root, absolutePath);
    if (!relativePath || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))) {
      return toSlashPath(relativePath || '.');
    }
  }

  return toSlashPath(trimmed);
}

function pathWithin(relativePath: string, directory: string): boolean {
  const cleanPath = relativePath.replace(/^\.\//, '').replace(/^\/+/, '');
  const cleanDirectory = directory.replace(/^\/+|\/+$/g, '');
  return cleanPath === cleanDirectory || cleanPath.startsWith(`${cleanDirectory}/`);
}

function isProgressOrWorklogPath(relativePath: string): boolean {
  const normalizedPath = relativePath.replace(/^\.\//, '').replace(/^\/+/, '');
  const fileName = path.posix.basename(normalizedPath);
  const readsProgressLog = fileName === OperationalLogPath.PROGRESS_FILE;
  const readsWorklog = normalizedPath.split('/').includes(OperationalLogPath.WORKLOG_DIR)
    && fileName.endsWith(OperationalLogPath.WORKLOG_FILE_SUFFIX);
  return readsProgressLog || readsWorklog;
}

function isOperationalReadPath(requestedPath: string): boolean {
  const relativePath = relativeOperationalPath(requestedPath);
  return isProgressOrWorklogPath(relativePath)
    || OPERATIONAL_READ_DIRS.some(directory => pathWithin(relativePath, directory));
}

function isProjectToolCallOutputPath(requestedPath: string): boolean {
  return pathWithin(relativeOperationalPath(requestedPath), PROJECT_TOOL_CALL_OUTPUT_DIR);
}

function isOperationalMutationPath(requestedPath: string): boolean {
  const relativePath = relativeOperationalPath(requestedPath);
  return isProgressOrWorklogPath(relativePath)
    || OPERATIONAL_MUTATION_DIRS.some(directory => pathWithin(relativePath, directory));
}

function nativeOperationalMutationPolicyRejection(event: ToolCallEvent): string | null {
  if (!isWorkerMode() || !NATIVE_OPERATIONAL_MUTATION_TOOLS.has(event.toolName)) return null;
  const requestedPath = nativeToolPath(event);
  if (!requestedPath || !isOperationalMutationPath(requestedPath)) return null;

  return `PROTOCOL VIOLATION: \`${event.toolName}\` may not modify framework runtime artifacts ` +
    'inside a teammate context. Use harness tools for state, progress, events, tool outputs, and generated temporary files.';
}

function gitSubcommand(args: Array<{ text: string }>): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]?.text || '';
    if (token === FileMutationPolicyDefaults.ARG_SEPARATOR) continue;
    if (token === FileMutationPolicyDefaults.GIT_CHDIR_OPTION) {
      index += 1;
      continue;
    }
    if (!token.startsWith('-')) return token;
  }
  return undefined;
}

function shellOperationalMutationPolicyRejection(event: ToolCallEvent, services: RuntimeServices): string | null {
  if (!isWorkerMode() || event.toolName !== NativePiToolName.BASH) return null;
  const input = event.input as Record<string, unknown>;
  if (input[FileMutationPolicyDefaults.REWRITTEN_DELETE_FLAG]) return null;
  const command = typeof input.command === 'string' ? input.command : '';
  if (!command.trim()) return null;

  let commands;
  try {
    commands = services.shellCommandParser.parse(command).commands;
  } catch {
    return null;
  }
  for (const shellCommand of commands) {
    const effective = services.shellCommandParser.effectiveCommand(shellCommand);
    const commandName = effective.basename;
    const isMutation = SHELL_OPERATIONAL_MUTATION_COMMANDS.has(commandName)
      || (commandName === FileMutationPolicyDefaults.GIT_COMMAND && GIT_OPERATIONAL_MUTATION_SUBCOMMANDS.has(gitSubcommand(effective.args) || ''));
    if (!isMutation) continue;

    const target = [
      effective.name,
      ...effective.args.map(arg => arg.text),
      ...effective.redirects.map(redirect => redirect.file?.text || '')
    ].find(token => token && isOperationalMutationPath(token));
    if (!target) continue;

    return `PROTOCOL VIOLATION: \`${NativePiToolName.BASH}\` may not mutate framework runtime artifact path ` +
      `\`${target}\` inside a teammate context. Leave harness artifacts to Orr Else.`;
  }

  return null;
}

function teammateEventTypeForOutcome(outcome: string): TeammateEventType {
  const normalized = outcome.toUpperCase();
  if (normalized === EventName.FAILURE) return TeammateEventType.STATE_FAILED;
  if (normalized === EventName.BLOCKED) return TeammateEventType.STATE_BLOCKED;
  return TeammateEventType.STATE_TRANSITIONED;
}

export function shouldPersistBlockedBeadStatus(eventType: string, nextState: string): boolean {
  return eventType === TeammateEventType.STATE_BLOCKED || nextState === BeadStatus.BLOCKED;
}

function shellPolicyRejection(event: ToolCallEvent, config: HarnessConfig, services: RuntimeServices): string | null {
  if (!isWorkerMode() || event.toolName !== NativePiToolName.BASH) return null;
  const input = event.input as Record<string, unknown>;
  if (input[FileMutationPolicyDefaults.REWRITTEN_DELETE_FLAG]) return null;

  const policy = config.settings.pi?.shell;
  const command = typeof input.command === 'string' ? input.command : '';
  if (!command.trim()) return null;

  for (const pattern of policy?.blockedCommandPatterns || []) {
    if (commandMatchesPattern(command, pattern)) {
      return `PROTOCOL VIOLATION: \`${NativePiToolName.BASH}\` may not invoke configured project-tool capability matching \`${pattern}\`. Use the corresponding Orr Else/Pi tool call from harness.yaml.`;
    }
  }

  const disallowProjectToolFallback = policy?.disallowProjectToolFallback ?? PiToolPolicyDefaults.DISALLOW_PROJECT_TOOL_FALLBACK;
  if (!disallowProjectToolFallback) return null;

  for (const tool of config.tools || []) {
    if (commandInvokesToolName(command, tool.name, services)) {
      return `PROTOCOL VIOLATION: \`${NativePiToolName.BASH}\` may not invoke configured project tool \`${tool.name}\`. Use the \`${tool.name}\` tool call from harness.yaml.`;
    }
  }

  return null;
}

function mcpPolicyRejection(event: ToolCallEvent, config: HarnessConfig): string | null {
  if (!isWorkerMode() || event.toolName !== NativePiToolName.MCP) return null;
  const policy = config.settings.pi?.mcp;
  const input = event.input as Record<string, unknown>;
  const requestedTool = typeof input.tool === 'string' ? input.tool.trim() : '';
  const isMcpToolCall = requestedTool.length > 0;

  if (policy?.allowToolCalls === false) {
    const requestedDescription = isMcpToolCall ? ` tool call \`${requestedTool}\`` : ' access';
    return `PROTOCOL VIOLATION: direct Pi \`${NativePiToolName.MCP}\`${requestedDescription} is disabled by harness.yaml. Use the configured Orr Else project tool for this capability or route BLOCKED if none exists.`;
  }

  const blockedPatterns = policy?.blockedToolPatterns || [];
  for (const pattern of blockedPatterns) {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch (error) {
      return `PROTOCOL VIOLATION: invalid harness.yaml Pi MCP blockedToolPatterns entry \`${pattern}\`: ${String(error)}`;
    }
    if (!requestedTool || !regex.test(requestedTool)) continue;
    return `PROTOCOL VIOLATION: direct Pi \`${NativePiToolName.MCP}\` tool call \`${requestedTool}\` is blocked by harness.yaml. Use the configured Orr Else project tool for this capability or route BLOCKED if none exists.`;
  }

  return null;
}

function operationalArtifactReadPolicyRejection(event: ToolCallEvent): string | null {
  if (!isWorkerMode() || event.toolName !== NativePiToolName.READ) return null;
  const requestedPath = nativeToolPath(event);
  if (!requestedPath.trim()) return null;
  if (isProjectToolCallOutputPath(requestedPath)) return PROJECT_TOOL_CALL_OUTPUT_READ_GUIDANCE;
  if (!isOperationalReadPath(requestedPath)) return null;

  return `PROTOCOL VIOLATION: \`${NativePiToolName.READ}\` may not read framework runtime artifacts ` +
    `(\`${OperationalLogPath.PROGRESS_FILE}\`, \`${OperationalLogPath.WORKLOG_DIR}/*${OperationalLogPath.WORKLOG_FILE_SUFFIX}\`, ` +
    `\`${OperationalArtifactPath.LEGACY_STATE_DIR}/\`, \`${OperationalArtifactPath.PI_EVENTS_DIR}/\`, ` +
    `\`${OperationalArtifactPath.PI_LOGS_DIR}/\`, \`${OperationalArtifactPath.PI_MAILBOX_DIR}/\`, ` +
    `\`${OperationalArtifactPath.PI_OTEL_DIR}/\`, \`${OperationalArtifactPath.PI_ARTIFACTS_DIR}/\`, ` +
    `or \`${OperationalArtifactPath.PI_TOOL_OUTPUT_DIR}/\`) ` +
    'inside a teammate context. Use `bd_get_state_chart`, `bd_get_bead`, `get_artifact_paths`, and configured artifacts for state reconstruction.';
}

function oversizedReadPolicyRejection(event: ToolCallEvent): string | null {
  if (!isWorkerMode() || event.toolName !== NativePiToolName.READ) return null;
  const input = event.input as Record<string, unknown>;
  const limit = Number(input.limit);
  if (!Number.isFinite(limit) || limit <= NativeReadPolicyDefaults.MAX_LIMIT_LINES) return null;

  return `PROTOCOL VIOLATION: \`${NativePiToolName.READ}\` limit ${Math.floor(limit)} exceeds ` +
    `${NativeReadPolicyDefaults.MAX_LIMIT_LINES} lines inside a teammate context. ` +
    'Use smaller targeted reads, codemap, ast_grep, reference_docs, or artifact validators instead of loading broad file slices.';
}

// eventToolCallId is imported from ./extension/PiEventAdapters.js

function registerProviderRequestCap(pi: ExtensionAPI, session: ExtensionSession): void {
  if (session.providerRequestCapRegistered) return;
  session.providerRequestCapRegistered = true;

  pi.on(PiEventName.BEFORE_PROVIDER_REQUEST, async (event: BeforeProviderRequestEvent) => {
    const cap = resolveMaxOutputTokens(process.env[EnvVars.MAX_OUTPUT_TOKENS]);
    const payload = event.payload;
    const originalMaxTokens =
      payload && typeof payload === 'object' ? (payload as { max_tokens?: unknown }).max_tokens : undefined;
    // capAnthropicMaxTokens guards payload shape internally (non-object → null).
    const capped = capAnthropicMaxTokens(payload as CappableAnthropicPayload, cap);
    if (!capped) return undefined;
    Logger.info(Component.ORR_ELSE, 'Capped Anthropic max_tokens to fit subscription included quota', {
      originalMaxTokens,
      cappedMaxTokens: cap,
      thinkingBudget: capped.thinking?.budget_tokens
    });
    return capped;
  });
}

function registerPiToolObservers(pi: ExtensionAPI, services: RuntimeServices, session: ExtensionSession): void {
  if (session.piToolObserverRegistered) return;
  session.piToolObserverRegistered = true;

  pi.on(PiEventName.TOOL_CALL, async (event: ToolCallEvent) => {
    if (!session.observedPiTools.has(event.toolName)) return;
    const runtimeObservability = session.piToolObservability;
    const toolCallId = eventToolCallId(event);
    const fileMutationPolicyResult = await services.fileMutationPolicy.apply(event);
    const input = event.input as Record<string, unknown>;
    const beadId = beadIdFromToolParams(input, session);
    runtimeObservability?.recordToolInvocation(event.toolName);
    const span = runtimeObservability?.startSpan(`tool:${event.toolName}`, toolSpanAttributes(event.toolName, input, beadId, session, true));
    if (span && toolCallId) session.observedPiToolSpans.set(toolCallId, span);

    await services.eventStore.record(DomainEventName.TOOL_INVOCATION_STARTED, {
      beadId,
      tool: event.toolName,
      externalPiTool: true,
      toolCallId,
      params: summarizeForEvent(input)
    }).catch(error => {
      Logger.warn(Component.ORR_ELSE, 'Failed to record Pi tool invocation start', {
        tool: event.toolName,
        error: String(error)
      });
    });

    const config = await services.configLoader.load();
    const rejection = fileMutationPolicyResult?.rejection
      || await terminalFailureLimitRejection(event.toolName, services, session)
      || shellPolicyRejection(event, config, services)
      || mcpPolicyRejection(event, config)
      || shellOperationalMutationPolicyRejection(event, services)
      || operationalArtifactReadPolicyRejection(event)
      || nativeOperationalMutationPolicyRejection(event)
      || oversizedReadPolicyRejection(event)
      || await checkToolValidationRules(event.toolName, config, runtimeObservability || getObservability(services));
    if (!rejection) return;

    if (toolCallId) session.blockedObservedPiToolCallIds.add(toolCallId);
    runtimeObservability?.recordToolInvocation(event.toolName, {
      status: ToolResultStatus.REJECTED,
      isError: true,
      message: rejection
    });
    if (span) runtimeObservability?.endSpan(span.spanId, SpanStatusValue.ERROR, rejection);
    await services.eventStore.record(DomainEventName.TOOL_INVOCATION_FAILED, {
      beadId,
      tool: event.toolName,
      externalPiTool: true,
      toolCallId,
      result: {
        status: ToolResultStatus.REJECTED,
        isError: true,
        message: rejection
      }
    }).catch(error => {
      Logger.warn(Component.ORR_ELSE, 'Failed to record Pi tool policy rejection', {
        tool: event.toolName,
        error: String(error)
      });
    });
    return {
      block: true,
      reason: rejection,
      ...(fileMutationPolicyResult?.nextAction ? { nextAction: fileMutationPolicyResult.nextAction } : {}),
      ...(fileMutationPolicyResult?.recovery ? { recovery: fileMutationPolicyResult.recovery } : {})
    };
  });

  pi.on(PiEventName.TOOL_RESULT, async (event: ToolResultEvent) => {
    if (!session.observedPiTools.has(event.toolName)) return;
    const runtimeObservability = session.piToolObservability;
    const beadId = beadIdFromToolParams(event.input, session);
    const toolCallId = eventToolCallId(event);
    if (toolCallId && session.blockedObservedPiToolCallIds.delete(toolCallId)) {
      session.observedPiToolSpans.delete(toolCallId);
      return;
    }
    const result = externalPiToolResultFromEvent(event);
    runtimeObservability?.recordToolInvocation(event.toolName, result);
    const span = toolCallId ? session.observedPiToolSpans.get(toolCallId) : undefined;
    if (span) {
      runtimeObservability?.endSpan(
        span.spanId,
        result.isError ? SpanStatusValue.ERROR : SpanStatusValue.OK,
        result.isError ? stringifySpanAttribute(result) : undefined
      );
      session.observedPiToolSpans.delete(toolCallId!);
    }
    await services.eventStore.record(
      result.isError ? DomainEventName.TOOL_INVOCATION_FAILED : DomainEventName.TOOL_INVOCATION_SUCCEEDED,
      {
        beadId,
        tool: event.toolName,
        externalPiTool: true,
        toolCallId,
        result: summarizeForEvent(result)
      }
    ).catch(error => {
      Logger.warn(Component.ORR_ELSE, 'Failed to record Pi tool invocation result', {
        tool: event.toolName,
        error: String(error)
      });
    });
  });
}

async function recordTurnUsage(event: TurnEndEvent, services: RuntimeServices, session: ExtensionSession): Promise<void> {
  const endTimeMs = Date.now();
  const startTimeMs = session.currentTurnStartMs ?? endTimeMs;
  session.currentTurnStartMs = undefined;

  // message is AgentMessage (union of Message | CustomAgentMessages); usage/model are on AssistantMessage only.
  // Access through unknown so we don't depend on which union member is present at runtime.
  const msg: Record<string, unknown> = isRecord(event.message) ? (event.message as unknown as Record<string, unknown>) : {};
  const record = buildTurnUsageRecord(
    isRecord(msg.usage) ? (msg.usage as Parameters<typeof buildTurnUsageRecord>[0]) : undefined,
    {
      beadId: process.env[EnvVars.BEAD_ID] || App.COORDINATOR_ID,
      stateId: process.env[EnvVars.STATE_ID] || App.COORDINATOR_ID,
      actionId: process.env[EnvVars.ACTION_ID] || App.TURN_ACTION_ID,
      workerId: process.env[EnvVars.WORKER_ID] || App.COORDINATOR_ID,
      model: (typeof msg.model === 'string' ? msg.model : undefined) || process.env[EnvVars.LLM_MODEL] || App.UNKNOWN_MODEL,
      startTimeMs,
      endTimeMs
    }
  );
  if (!record) return;

  services.telemetryStore.recordTurn(record.telemetry);
  await services.eventStore.record(DomainEventName.TOKEN_USAGE_RECORDED, record.event).catch(error => {
    Logger.warn(Component.OBSERVABILITY, 'Failed to record token usage event', { error: String(error) });
  });

  try {
    const span = services.observability.startSpan('llm_turn', {
      'gen_ai.request.model': record.event.model,
      'gen_ai.usage.input_tokens': record.event.inputTokens,
      'gen_ai.usage.output_tokens': record.event.outputTokens,
      'gen_ai.usage.cache_read_tokens': record.event.cacheReadTokens,
      'gen_ai.usage.total_tokens': record.event.totalTokens,
      [OtelAttr.ORR_ELSE_BEAD_ID]: record.event.beadId,
      [OtelAttr.ORR_ELSE_STATE_ID]: record.event.stateId,
      [OtelAttr.ORR_ELSE_ACTION_ID]: record.event.actionId,
      [OtelAttr.ORR_ELSE_WORKER_ID]: record.event.workerId,
      [OtelAttr.ORR_ELSE_COST_TOTAL]: record.event.costTotal
    });
    services.observability.endSpan(span.spanId);
  } catch (error) {
    Logger.debug(Component.OBSERVABILITY, 'Skipped OTEL token-usage span', { error: String(error) });
  }
}

function registerAgentLifecycleObservers(pi: ExtensionAPI, services: RuntimeServices, session: ExtensionSession): void {
  if (session.agentLifecycleObserverRegistered) return;
  session.agentLifecycleObserverRegistered = true;

  pi.on(PiEventName.TURN_START, async (event: TurnStartEvent) => {
    session.currentTurnStartMs = typeof event.timestamp === 'number' ? event.timestamp : Date.now();
  });

  pi.on(PiEventName.TURN_END, async (event: TurnEndEvent, ctx: ExtensionContext) => {
    await dispatchAgentLifecycleFailure(event, ctx, PiEventName.TURN_END, services, session);
    await recordTurnUsage(event, services, session);
  });

  pi.on(PiEventName.AGENT_END, async (event: AgentEndEvent, ctx: ExtensionContext) => {
    await dispatchAgentLifecycleFailure(event, ctx, PiEventName.AGENT_END, services, session);
    Logger.info(Component.OBSERVABILITY, 'Session token usage summary', services.telemetryStore.getSummary());
  });
}

// handleAgentLifecycleFailure is imported from ./extension/AgentLifecycleController.js
// The local shim below wires the session-mutation callbacks and env-resolved
// buildWorkerEvent so the controller module remains process.env-free.
async function dispatchAgentLifecycleFailure(event: AgentEndEvent | TurnEndEvent, ctx: ExtensionContext, source: PiEventName, services: RuntimeServices, session: ExtensionSession): Promise<void> {
  await handleAgentLifecycleFailure(event, ctx, source, services, {
    isWorker: isWorkerMode(),
    activeRun: session.activeRun,
    agentFailureSignaled: session.agentFailureSignaled,
    setAgentFailureSignaled: (v: boolean) => { session.agentFailureSignaled = v; },
    buildWorkerEvent: (type, fields) => buildWorkerEvent(type, fields)
  });
}

// resultIndicatesFailure and resultIndicatesSuccess are imported from ./extension/PiEventAdapters.js

function spanCompletionForToolResult(result: unknown): SpanCompletion {
  if (!resultIndicatesFailure(result)) return { status: SpanStatusValue.OK };
  return {
    status: SpanStatusValue.ERROR,
    message: stringifySpanAttribute(summarizeForEvent(result))
  };
}

function validateNativePiExtensionProjectTools(pi: ExtensionAPI, config: HarnessConfig): void {
  const nativeProjectTools = getNativePiExtensionProjectToolNames(config);
  if (nativeProjectTools.length === 0) return;

  const api = pi as { getAllTools?: () => Array<{ name: string }> };
  if (typeof api.getAllTools !== 'function') return;

  const availableToolNames = new Set(api.getAllTools().map(tool => tool.name));
  const missing = nativeProjectTools.filter(toolName => !availableToolNames.has(toolName));
  if (missing.length > 0) {
    throw new Error(
      `Configured native Pi extension project tools are missing: ${missing.join(', ')}. ` +
      `Register them with pi.registerTool() from .pi/extensions/*.ts, .pi/extensions/*/index.ts, ` +
      `~/.pi/agent/extensions, or an installed Pi package before Orr Else starts.`
    );
  }
}

/**
 * Validates programmatic behavioral rules for a tool.
 */
async function checkToolValidationRules(toolName: string, config: HarnessConfig, runtimeObservability: Observability): Promise<string | null> {
  const toolConfig = (config.tools || []).find(t => t.name === toolName);
  if (!toolConfig?.validationRules) return null;

  for (const rule of toolConfig.validationRules) {
    const result = runtimeObservability.getToolResult(rule.tool);
    
    if (rule.condition === ToolValidationCondition.CALLED && result === undefined) {
      return rule.message || `PROTOCOL VIOLATION: Tool \`${toolName}\` requires \`${rule.tool}\` to be called first.`;
    }

    if (rule.condition === ToolValidationCondition.PASSED && !runtimeObservability.hasToolPassed(rule.tool)) {
      return rule.message || `PROTOCOL VIOLATION: Tool \`${toolName}\` requires \`${rule.tool}\` to have returned a \`PASSED\` status.`;
    }

    if (rule.condition === ToolValidationCondition.SUCCEEDED && !runtimeObservability.hasToolPassed(rule.tool) && !resultIndicatesSuccess(result)) {
      return rule.message || `PROTOCOL VIOLATION: Tool \`${toolName}\` requires \`${rule.tool}\` to have succeeded.`;
    }
  }

  return null;
}

async function terminalFailureLimitContext(services: RuntimeServices, session: ExtensionSession): Promise<TerminalFailureLimitContext | null> {
  const run = session.activeRun;
  if (!isWorkerMode() || !run) return null;

  let data = run.terminalFailureLimitEvent?.data || run.terminalFailureLimitResult;

  if (!data) {
    if (run.terminalFailureLimitScanned) return null;
    preloadTerminalFailureLimit(run, services);
    const limitEvent = await run.terminalFailureLimitScan;
    run.terminalFailureLimitScanned = true;
    run.terminalFailureLimitScan = undefined;
    if (!limitEvent) return null;
    run.terminalFailureLimitEvent = limitEvent;
    data = limitEvent.data || {};
  }

  const result = isRecord(data.result) ? data.result : {};
  const failureLimit = isRecord(result.failureLimit) ? result.failureLimit : {};
  const failedTool = typeof data.tool === 'string'
    ? data.tool
    : typeof result.tool === 'string'
      ? result.tool
      : 'unknown';
  const config = await services.configLoader.load();
  const failedToolDefinition = config.tools?.find(tool => tool.name === failedTool);
  const recordedSuggestedOutcome = typeof failureLimit.suggestedOutcome === 'string'
    ? failureLimit.suggestedOutcome
    : routingHintSuggestedOutcomeFromResult(result);
  const configuredSuggestedOutcome = projectToolFailureLimitSuggestedOutcome(
    failedToolDefinition,
    run.stateId,
    run.action.id
  );
  const suggestedOutcome = recordedSuggestedOutcome || configuredSuggestedOutcome || EventName.BLOCKED;
  return {
    failedTool,
    suggestedOutcome,
    stateId: run.stateId,
    actionId: run.action.id
  };
}

async function terminalFailureLimitRejection(toolName: string, services: RuntimeServices, session: ExtensionSession): Promise<string | null> {
  if (TERMINAL_FAILURE_ALLOWED_TOOLS.has(toolName)) return null;
  const terminal = await terminalFailureLimitContext(services, session);
  if (!terminal) return null;

  return `PROTOCOL VIOLATION: terminal failure limit already reached for project tool \`${terminal.failedTool}\` ` +
    `in ${terminal.stateId}/${terminal.actionId}. Do not call \`${toolName}\` or gather more evidence in this state. ` +
    `Use \`${BuiltInToolName.SUBMIT_CHECKPOINT}\` with the failure-limit evidence, then ` +
    `\`${BuiltInToolName.SIGNAL_COMPLETION}\` with outcome \`${terminal.suggestedOutcome}\`.`;
}

function lookupToolGuards(
  toolName: string,
  config: HarnessConfig
): { timeoutMs: number; maxFailures: number; cacheable: boolean } {
  const toolConfig = config.tools?.find(t => t.name === toolName);
  return {
    timeoutMs: toolConfig?.wrapperTimeoutMs ?? ToolDefaults.WRAPPER_TIMEOUT_MS,
    maxFailures: toolConfig?.maxConsecutiveFailures ?? ToolDefaults.MAX_CONSECUTIVE_FAILURES,
    cacheable: toolConfig?.cacheable === true
  };
}

function toolCacheKey(toolName: string, params: unknown): string {
  let serialised: string;
  try {
    serialised = JSON.stringify(params ?? {});
  } catch {
    serialised = '[unserialisable]';
  }
  return `${toolName}|${serialised}`;
}

function breakerKey(beadId: string | undefined, toolName: string): string {
  return `${beadId ?? '_'}|${toolName}`;
}

async function runWithWrapperTimeout<T>(toolName: string, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Tool ${toolName} exceeded harness wrapper timeout of ${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function wrapPluginTool(
  tool: { name: string, description: string, parameters: unknown, execute(params: unknown, ctx?: unknown): unknown | Promise<unknown> },
  runtimeObservability: Observability,
  services: RuntimeServices,
  session: ExtensionSession
) {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.parameters || Type.Object({}),
    execute: async (_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: any, ctx: ExtensionContext) => {
      // 1. Programmatic Behavioral Rules (Pre-conditions)
      const config = await services.configLoader.load();
      const ruleError = await checkToolValidationRules(tool.name, config, runtimeObservability);
      if (ruleError) {
        if (ctx.hasUI) ctx.ui.notify(ruleError, 'error');
        return toolResult(ruleError);
      }

      // Framework-level safety: teammates cannot merge
      if (tool.name === PluginToolName.MERGE_AND_COMMIT && isWorkerMode()) {
        const error = `PROTOCOL VIOLATION: \`${PluginToolName.MERGE_AND_COMMIT}\` is team-leader/harness-only and cannot be called by a teammate.`;
        if (ctx.hasUI) ctx.ui.notify(error, 'error');
        return toolResult(error);
      }

      const beadId = beadIdFromToolParams(params, session);
      const { timeoutMs, maxFailures, cacheable } = lookupToolGuards(tool.name, config);
      const breakerEnabled = isWorkerMode();
      const key = breakerKey(beadId, tool.name);
      const cacheKey = toolCacheKey(tool.name, params);

      // Serve cacheable tools from the in-session memo when present. Any call
      // to a non-cacheable tool below will clear the memo before executing,
      // because we treat non-cacheable tools as potentially mutating.
      if (cacheable && isWorkerMode()) {
        const hit = session.toolResultCache.get(cacheKey);
        if (hit) {
          const ageMs = Date.now() - hit.recordedAt;
          runtimeObservability.recordToolInvocation(tool.name, hit.result);
          await services.eventStore.record(DomainEventName.TOOL_INVOCATION_SUCCEEDED, {
            beadId,
            tool: tool.name,
            result: summarizeForEvent(hit.result),
            cached: true,
            cacheAgeMs: ageMs
          }).catch(() => {});
          return toolResult(hit.result);
        }
      } else if (isWorkerMode() && session.toolResultCache.size > 0) {
        session.toolResultCache.clear();
      }

      // Circuit breaker: short-circuit if this tool has failed maxFailures
      // times in a row for this bead within the session.
      if (breakerEnabled) {
        const failures = session.toolBreakerFailures.get(key) ?? 0;
        if (failures >= maxFailures) {
          const message = `REJECTED: \`${tool.name}\` circuit open after ${failures} consecutive failures. Pick a different approach; the breaker resets when the bead transitions.`;
          runtimeObservability.recordToolInvocation(tool.name, {
            status: ToolResultStatus.REJECTED,
            isError: true,
            message
          });
          await services.eventStore.record(DomainEventName.TOOL_INVOCATION_FAILED, {
            beadId,
            tool: tool.name,
            result: { status: ToolResultStatus.REJECTED, isError: true, message, reason: 'circuit-open' }
          }).catch(() => {});
          if (ctx.hasUI) ctx.ui.notify(message, 'error');
          return toolResult(message);
        }
      }

      await services.eventStore.record(DomainEventName.TOOL_INVOCATION_STARTED, {
        beadId,
        tool: tool.name,
        params: summarizeForEvent(params)
      });

      const terminalRejection = await terminalFailureLimitRejection(tool.name, services, session);
      if (terminalRejection) {
        runtimeObservability.recordToolInvocation(tool.name, {
          status: ToolResultStatus.REJECTED,
          isError: true,
          message: terminalRejection
        });
        await services.eventStore.record(DomainEventName.TOOL_INVOCATION_FAILED, {
          beadId,
          tool: tool.name,
          result: {
            status: ToolResultStatus.REJECTED,
            isError: true,
            message: terminalRejection
          }
        });
        if (ctx.hasUI) ctx.ui.notify(terminalRejection, 'error');
        return toolResult(terminalRejection);
      }

      const tracedExecute = runtimeObservability.tracedAsync(
        `tool:${tool.name}`,
        toolSpanAttributes(tool.name, params, beadId, session),
        async (p: any, c: ExtensionContext) => {
          if (c.hasUI) c.ui.setWorkingMessage(`Executing ${tool.name}...`);
          const result = await runWithWrapperTimeout(tool.name, timeoutMs, () => Promise.resolve(tool.execute(p || {}, c)));
          if (c.hasUI) c.ui.setWorkingMessage(undefined);

          // Record invocation and result for audit
          runtimeObservability.recordToolInvocation(tool.name, result);
          const terminalFailureLimitData = terminalFailureLimitDataFromResult(result);
          const run = session.activeRun;
          if (terminalFailureLimitData && run !== null && run.beadId === beadId) {
            run.terminalFailureLimitResult = terminalFailureLimitData;
            run.terminalFailureLimitScanned = true;
          }

          if (resultIndicatesFailure(result)) {
            if (breakerEnabled) {
              session.toolBreakerFailures.set(key, (session.toolBreakerFailures.get(key) ?? 0) + 1);
            }
            await services.eventStore.record(DomainEventName.TOOL_INVOCATION_FAILED, {
              beadId,
              tool: tool.name,
              result: summarizeForEvent(result)
            });
            if (typeof result === 'string') {
              if (c.hasUI) c.ui.notify(result, 'error');
            } else if (isRecord(result)) {
              if (c.hasUI) c.ui.notify(result.error || `Tool ${tool.name} failed`, 'error');
            }
          } else {
            if (breakerEnabled) session.toolBreakerFailures.delete(key);
            if (cacheable && isWorkerMode()) {
              session.toolResultCache.set(cacheKey, { result, recordedAt: Date.now() });
            }
            await services.eventStore.record(DomainEventName.TOOL_INVOCATION_SUCCEEDED, {
              beadId,
              tool: tool.name,
              result: summarizeForEvent(result)
            });
          }
          return result;
        },
        spanCompletionForToolResult
      );

      try {
        const result = await tracedExecute(params, ctx);
        return toolResult(result);
      } catch (error) {
        if (breakerEnabled) {
          session.toolBreakerFailures.set(key, (session.toolBreakerFailures.get(key) ?? 0) + 1);
        }
        await services.eventStore.record(DomainEventName.TOOL_INVOCATION_FAILED, {
          beadId,
          tool: tool.name,
          error: String(error)
        }).catch(() => {});
        if (ctx.hasUI) {
          ctx.ui.setWorkingMessage(undefined);
          ctx.ui.notify(`Tool ${tool.name} error: ${String(error)}`, 'error');
        }
        return toolResult(`Error: ${String(error)}`);
      }
    }
  };
}

function isWorkerMode(): boolean {
  return process.env[EnvVars.WORKER_MODE] === ProcessFlag.TRUE && !!process.env[EnvVars.BEAD_ID] && !!process.env[EnvVars.STATE_ID];
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

function actionRunContext(action: TeammateAction): ActionRunContext {
  if (action.context === ActionRunContext.FRESH || action.contextMode === ActionContextMode.SUBAGENT) {
    return ActionRunContext.FRESH;
  }
  return ActionRunContext.PARENT;
}

function actionCompletionKey(config: HarnessConfig, stateId: string, actionId: string): string {
  const workflowVersion = config.settings.workflowVersion?.trim();
  if (!workflowVersion) return actionId;
  return [
    `${ActionCompletionKey.WORKFLOW_PREFIX}=${workflowVersion}`,
    `${ActionCompletionKey.STATE_PREFIX}=${stateId}`,
    `${ActionCompletionKey.ACTION_PREFIX}=${actionId}`
  ].join(ActionCompletionKey.FIELD_SEPARATOR);
}

function isActionCompleted(
  config: HarnessConfig,
  stateId: string,
  action: TeammateAction,
  completedActionIds: string[] = []
): boolean {
  return new Set(completedActionIds).has(actionCompletionKey(config, stateId, action.id));
}

function selectActiveAction(
  config: HarnessConfig,
  stateId: string,
  state: SDLCState,
  actionId?: string,
  completedActionIds: string[] = []
): TeammateAction | undefined {
  if (actionId) return state.actions.find(candidate => candidate.id === actionId);
  const pending = state.actions.filter(candidate => !isActionCompleted(config, stateId, candidate, completedActionIds));
  const searchSpace = pending.length > 0 ? pending : state.actions;
  return searchSpace.find(candidate =>
    actionRunContext(candidate) === ActionRunContext.PARENT &&
    (candidate.type === ActionType.PROMPT || candidate.type === ActionType.CHECKLIST)
  ) || searchSpace.find(candidate => actionRunContext(candidate) === ActionRunContext.FRESH)
    || searchSpace.find(candidate => actionRunContext(candidate) === ActionRunContext.PARENT)
    || state.actions[0];
}

function nextSequencedAction(
  config: HarnessConfig,
  stateId: string,
  state: SDLCState,
  justCompletedActionId: string,
  completedActionIds: string[] = []
): TeammateAction | undefined {
  const completedIndex = state.actions.findIndex(action => action.id === justCompletedActionId);
  if (completedIndex < 0) return undefined;
  const nextCompletedActionIds = [
    ...completedActionIds,
    actionCompletionKey(config, stateId, justCompletedActionId)
  ];
  return state.actions.slice(completedIndex + 1).find(action =>
    !isActionCompleted(config, stateId, action, nextCompletedActionIds)
  );
}

function appendCompletedActionId(
  completedActionIds: string[] | undefined,
  stateId: string,
  actionId: string,
  config: HarnessConfig
): string[] {
  return [...new Set([
    ...(completedActionIds || []),
    actionCompletionKey(config, stateId, actionId)
  ])];
}

function dynamicChecklistItemsForRun(bead: Bead, stateId: string, actionId: string): ChecklistItem[] {
  const runKey = `${stateId}/${actionId}`;
  const dynamicItems = ((bead as any).dynamicChecklists || {})[runKey]?.items;
  return Array.isArray(dynamicItems) ? dynamicItems as ChecklistItem[] : [];
}

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

    if (actionRunContext(action) === ActionRunContext.FRESH) {
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

    for (const toolCall of extractFrameworkToolCalls(result)) {
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
      result: summarizeForEvent(result)
    });
  }

  run.parentSequenceCompleted = true;
}

/**
 * Build a TeammateEvent. Resolves env values here (extension.ts is the
 * allowed boundary for process.env) and delegates to buildWorkerEventFrom
 * in SignalController.ts which is env-free.
 */
function buildWorkerEvent(type: TeammateEventType, fields: Partial<TeammateEvent> & Record<string, unknown>): TeammateEvent {
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

  const worktreePath = process.env[EnvVars.WORKTREE_PATH] || process.cwd();
  const configuredRequiredItems = deriveChecklistItems(state, action, config, stateId);
  const requiredItems = mergeChecklistItems(
    configuredRequiredItems,
    dynamicChecklistItemsForRun(beadProjection as Bead, stateId, action.id)
  ).requiredItems;
  const worklogManager = new WorklogManager(services.eventStore);
  const progressManager = new ProgressManager(worktreePath, services.eventStore, { beadId, stateId });

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
  await services.eventStore.record(DomainEventName.STATE_RUN_INITIALIZED, {
    beadId,
    stateId,
    actionId: action.id,
    actionKey: actionCompletionKey(config, stateId, action.id),
    workflowVersion: config.settings.workflowVersion,
    worktreePath,
    requiredChecklistItems: requiredItems.map(item => item.text)
  });
}

function buildStateSystemPrompt(config: HarnessConfig, services: RuntimeServices, session: ExtensionSession): string {
  const activeRun = session.activeRun;
  if (!activeRun) return '';
  const stateInstructions = services.instructionLoader.assemble(activeRun.state, config);
  const protocol = services.protocolInjector.inject(activeRun.state, config);
  const checklistProtocol = services.protocolParser.generatePrompt(activeRun.requiredItems);
  const projectTools = describeConfiguredProjectTools(config);
  const actionPrompt = activeRun.action.prompt || '';
  const llm = services.configLoader.resolveLLMConfig(activeRun.stateId, config);

  return services.contextInjector.inject(
    [stateInstructions, protocol, projectTools, actionPrompt].filter(Boolean).join('\n\n'),
    {
      beadId: activeRun.beadId,
      projectRoot: process.env[EnvVars.PROJECT_ROOT] || services.projectRoot,
      workdir: activeRun.worktreePath || process.cwd(),
      configPath: services.configLoader.getConfigPath(),
      actionId: activeRun.action.id,
      identity: activeRun.state.identity.role,
      phase: activeRun.stateId,
      llmProviderKey: llm.providerKey,
      llmProvider: llm.provider,
      llmModel: llm.model,
      llmThinking: llm.thinking,
      compatibilityMode: config.settings.compatibilityMode || 'none',
      progressPath: activeRun.worktreePath ? path.join(activeRun.worktreePath, 'PROGRESS.md') : undefined,
      historyPath: activeRun.worklogManager.getWorklogPath(activeRun.beadId),
      rulePaths: services.instructionLoader.compatibilityPaths(config),
      outstandingChecklist: checklistProtocol
    }
  );
}

async function handleTeammateEvent(pi: ExtensionAPI, ctx: ExtensionContext, event: TeammateEvent, services: RuntimeServices, session: ExtensionSession) {
  const currentSupervisor = session.supervisor;
  if (!currentSupervisor) return;

  const beadId = event.beadId as BeadId;

  if (event.type === TeammateEventType.HEARTBEAT) {
    Logger.debug(Component.ORR_ELSE, 'Received teammate heartbeat', { beadId: event.beadId, workerId: event.workerId });
    return;
  }

  const priorEvents = await services.eventStore.eventsForBead(beadId);
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
    logDuplicateDecision(Component.ORR_ELSE, 'Ignoring teammate signal after durable processing decision', {
      beadId,
      type: event.type,
      stateId: event.stateId,
      idempotencyKey: event.idempotencyKey,
      decision: decision.action,
      reason: decision.reason
    });
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

  if (!isStatusMutatingTeammateEvent(event)) return;

  if (ctx.hasUI) {
    ctx.ui.notify(`Teammate ${event.type}: ${beadId}`, event.type === TeammateEventType.STATE_FAILED || event.type === TeammateEventType.STATE_BLOCKED ? 'warning' : 'info');
  }

  Logger.info(Component.ORR_ELSE, `Teammate signal received: ${event.type} for ${beadId}`);

  const config = await services.configLoader.load();
  const releaseTool = requireTool(services.plugins.bd, PluginToolName.BD_RELEASE);

  if (event.type === TeammateEventType.STATE_TRANSITIONED) {
    const state = config.states[event.stateId];
    const actionKey = event.actionId ? actionCompletionKey(config, event.stateId, event.actionId) : undefined;
    const bead = await requireTool(services.plugins.bd, PluginToolName.BD_GET_BEAD).execute({ id: beadId, includeDetails: true }) as Bead;
    const completedActionIds = event.transitionEvent === EventName.SUCCESS
      ? appendCompletedActionId(bead.completedActionIds || [], event.stateId, event.actionId, config)
      : (bead.completedActionIds || []);
    const nextAction = state && event.transitionEvent === EventName.SUCCESS
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

    const nextState = state ? services.flowManager.nextState(state, event.transitionEvent) : event.stateId;
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
    await services.eventStore.record(DomainEventName.STATE_TRANSITION_APPLIED, transitionEventData);

    if (nextState === BeadStatus.COMPLETED && event.transitionEvent === EventName.SUCCESS) {
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
    const nextState = state ? services.flowManager.nextState(state, event.transitionEvent) : event.stateId;
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

    if (shouldPersistBlockedBeadStatus(event.type, nextState)) {
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
    const nextState = state ? services.flowManager.nextState(state, event.transitionEvent) : event.stateId;
    await services.eventStore.record(DomainEventName.CONTEXT_RESTART_REQUESTED, {
      beadId,
      workerId: event.workerId,
      sessionStateId: event.sessionStateId,
      idempotencyKey: event.idempotencyKey,
      stateId: event.stateId,
      targetState: nextState,
      transitionEvent: event.transitionEvent,
      actionId: event.actionId,
      summary: event.summary,
      evidence: event.evidence,
      handover: event.handover
    });
  }

  if (event.type === TeammateEventType.HARNESS_RESTART_REQUESTED) {
    const state = config.states[event.stateId];
    const nextState = state ? services.flowManager.nextState(state, event.transitionEvent) : event.stateId;
    await services.eventStore.record(DomainEventName.HARNESS_RESTART_REQUESTED, {
      beadId,
      workerId: event.workerId,
      sessionStateId: event.sessionStateId,
      idempotencyKey: event.idempotencyKey,
      stateId: event.stateId,
      targetState: nextState,
      transitionEvent: event.transitionEvent,
      actionId: event.actionId,
      summary: event.summary,
      evidence: event.evidence,
      handover: event.handover
    });
  }

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
    return {
      mode: 'coordinator',
      requestedBead: currentFlowOptions?.beadId || 'backlog',
      maxSlots: currentFlowOptions?.maxSlots ?? Defaults.MAX_SLOTS,
      autoContinue: currentFlowOptions?.autoContinue !== false,
      configPath: currentFlowOptions?.configPath || services.configLoader.getConfigPath(),
      configuredProjectTools: projectToolStatus,
      nextHarnessAction: 'monitor active teammate slots and process teammate signals'
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
    return [
      'Orr Else coordinator active.',
      `Requested bead: ${details.requestedBead}`,
      `Max slots: ${details.maxSlots}`,
      `Auto-continue: ${details.autoContinue ? 'yes' : 'no'}`,
      `Config: ${details.configPath}`,
      `Next harness action: ${details.nextHarnessAction}`,
      projectToolStatus
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

  await services.eventStore.record(DomainEventName.HARNESS_STARTED, {
    beadId: options.beadId,
    maxSlots: options.maxSlots,
    autoContinue: options.autoContinue,
    buildProvenance
  });

  const server = new SignalingServer(event => handleTeammateEvent(pi, ctx, event, services, session), runtimeObservability, services.eventStore);
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
  await factory.ensureAgentsWindow();

  session.supervisor = new Supervisor(pi, ctx, server, factory, runtimeObservability, services, {
    maxSlots: options.maxSlots,
    requestedBeadId: options.beadId
  });

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
  // Point the Logger's rotating-file transport at the injected project root so
  // log files land under the correct directory regardless of process.cwd().
  Logger.configureProjectRoot(services.projectRoot);
  registerProcessLifecycleObservers();
  Logger.info(Component.ORR_ELSE, 'Orr Else extension loading', { version: App.VERSION });

  const seenTools = new Set<string>();

  pi.registerCommand(BuiltInToolName.ORR_ELSE, {
    description: `Start Orr Else coordinator. Usage: /orr-else [status|stop] [${CliOption.CONFIG} path] [${CliOption.BEAD} id] [${CliOption.MAX_SLOTS} n].`,
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      try {
        const preliminary = parseOrrElseArgs(args);

        if (preliminary === ExtensionCommandAction.STATUS) {
          ctx.ui.notify((await flowStatus(services, session, 'text')) as string, 'info');
          return;
        }
        
        if (preliminary === ExtensionCommandAction.STOP) {
          if (session.supervisor) session.supervisor.stop();
          session.supervisor = null;
          session.currentFlowOptions = null;
          ctx.ui.notify('Orr Else stopped.', 'info');
          return;
        }

        if (preliminary.configPath) services.configLoader.setConfigPath(preliminary.configPath);
        const config = await services.configLoader.load();
        const parsed = parseOrrElseArgs(args, config);

        if (typeof parsed === 'object') {
          const result = await startOrrElse(pi, ctx as any, parsed, services, session);
          ctx.ui.notify(result, 'info');
        }
      } catch (error) {
        Logger.error(Component.ORR_ELSE, 'Orr Else command failed', { error: String(error) });
        ctx.ui.notify(`Orr Else failed: ${String(error)}`, 'error');
      }
    }
  });

  pi.on(PiEventName.SESSION_SHUTDOWN, () => {
    Logger.info(Component.ORR_ELSE, 'Pi session shutdown observed', { isWorker: isWorkerMode() });
    if (session.supervisor) session.supervisor.stop();
    session.supervisor = null;
    session.currentFlowOptions = null;
    session.piToolObservability = null;
    session.observedPiTools = new Set<string>();
    session.blockedObservedPiToolCallIds = new Set<string>();
    session.observedPiToolSpans = new Map<string, SpanContext>();
    const runtimeObservability = services.observability;
    void runtimeObservability?.forceFlush().finally(() => runtimeObservability.shutdown());
  });

  pi.on(PiEventName.BEFORE_AGENT_START, async (event: BeforeAgentStartEvent) => {
    if (!isWorkerMode()) return;
    const config = await services.configLoader.load();
    if (!session.activeRun) await initializeWorkerRun(services.observability, services, session);
    const statePrompt = buildStateSystemPrompt(config, services, session);
    if (!statePrompt) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${statePrompt}` };
  });

  pi.on(PiEventName.RESOURCES_DISCOVER, async () => {
    const config = await services.configLoader.load();
    const projectRoot = process.env[EnvVars.PROJECT_ROOT] || services.projectRoot;
    const skillPaths = resolvePiSkillPaths(config, projectRoot);
    return skillPaths.length > 0 ? { skillPaths } : {};
  });

  pi.on(PiEventName.SESSION_START, async (_event: SessionStartEvent, ctx: ExtensionContext) => {
    const config = await services.configLoader.load();
    const runtimeObservability = await initializeObservability(services);
    session.piToolObservability = runtimeObservability;

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
          buildProvenance: workerProvenance
        }).catch(() => {});
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
    registerPiToolObservers(pi, services, session);
    registerProviderRequestCap(pi, session);
    registerAgentLifecycleObservers(pi, services, session);

    if (!session.claudeCodeLoginRegistered && resolveProviderName(config.settings.defaultProvider) === LLMProviderName.ANTHROPIC) {
      session.claudeCodeLoginRegistered = true;
      registerClaudeCodeLiveLogin(pi);
    }

    const wrapRuntimeTool = (tool: { name: string, description: string, parameters: unknown, execute(params: unknown, ctx?: unknown): unknown | Promise<unknown> }) =>
      wrapPluginTool(tool, runtimeObservability, services, session);

    if (!session.artifactPathsToolRegistered) {
      session.artifactPathsToolRegistered = true;
      pi.registerTool(wrapRuntimeTool({
        name: BuiltInToolName.GET_ARTIFACT_PATHS,
        description: 'Resolve configured stable artifact paths and bounded artifact content previews for the current Bead/state/action. Use this instead of native reads for .pi/artifacts files.',
        parameters: Type.Object({
          beadId: Type.String({ description: 'The Bead ID' }),
          stateId: Type.Optional(Type.String({ description: 'Optional state ID' })),
          actionId: Type.Optional(Type.String({ description: 'Optional action ID' })),
          artifactId: Type.Optional(Type.String({ description: 'Optional artifact ID for template expansion' })),
          includeContent: Type.Optional(Type.Boolean({ description: 'Include bounded content previews for existing artifacts. Defaults to true.' })),
          maxInlineBytes: Type.Optional(Type.Number({ description: 'Requested bytes to inline per artifact preview; the framework applies a hard safety cap.' })),
          maxTotalInlineBytes: Type.Optional(Type.Number({ description: 'Requested aggregate bytes to inline across artifact previews; the framework applies a hard safety cap.' }))
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
          'Use "projection" for schema-aware named extractions (planContract: writeSet, verifierObligations, implementationSteps, riskList, evidenceReferences, acceptanceCriteria; ' +
          'requirementsAnalysis: requirementsInventory, traceabilityReferences, gapFlags, referenceCitations, unresolvedQuestions). ' +
          'Use "selector" for dot-path ad-hoc access (e.g. "implementationSteps.0"). ' +
          'If the selected subtree exceeds the byte cap, the tool returns counts + representative samples + a narrower-selector hint instead of dumping the full subtree. ' +
          'Missing artifacts and invalid projections return structured rejections with validProjections and path/existence metadata.',
        parameters: Type.Object({
          beadId: Type.String({ description: 'The Bead ID' }),
          stateId: Type.Optional(Type.String({ description: 'Optional state ID for artifact template resolution' })),
          actionId: Type.Optional(Type.String({ description: 'Optional action ID for artifact template resolution' })),
          artifactId: Type.Optional(Type.String({ description: 'Artifact identifier matching a harness.yaml template key (e.g. "planContract", "requirementsAnalysis"). Mutually exclusive with artifactPath.' })),
          artifactPath: Type.Optional(Type.String({ description: 'Explicit filesystem path to the artifact JSON. Mutually exclusive with artifactId.' })),
          projection: Type.Optional(Type.String({ description: 'Named schema-aware projection (e.g. "writeSet", "implementationSteps" for planContract). Mutually exclusive with selector.' })),
          selector: Type.Optional(Type.String({ description: 'Dot-path selector into the artifact JSON (e.g. "writeSet", "implementationSteps.0.description"). Mutually exclusive with projection. Empty string returns artifact root subject to byte cap.' }))
        }),
        execute: async (params: any) => artifactQuery.query(params)
      }) as any);
    }

    if (!session.compatibilityContextToolRegistered) {
      session.compatibilityContextToolRegistered = true;
      pi.registerTool(wrapRuntimeTool({
        name: BuiltInToolName.GET_COMPATIBILITY_CONTEXT,
        description: 'Return the configured Claude/Codex compatibility path manifest for this project.',
        parameters: Type.Object({
          includeDocs: Type.Optional(Type.Boolean({ description: 'Include markdown files discovered under configured compatibility docs directories.' })),
          includeAgents: Type.Optional(Type.Boolean({ description: 'Include markdown files discovered under configured compatibility agent directories.' })),
          maxDocs: Type.Optional(Type.Number({ description: 'Maximum compatibility docs to return when includeDocs is true.' })),
          maxAgents: Type.Optional(Type.Number({ description: 'Maximum compatibility agent files to return when includeAgents is true.' }))
        }),
        execute: async (params: { includeDocs?: boolean; includeAgents?: boolean; maxDocs?: number; maxAgents?: number }) =>
          services.instructionLoader.compatibilityContext(await services.configLoader.load(), params)
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
    validateNativePiExtensionProjectTools(pi, config);

    pi.registerTool(wrapRuntimeTool({
      name: BuiltInToolName.TICK_ITEM,
      description: 'Tick one mandatory or optional checklist item for the current phase. Prefer tick_items for batched checklist updates. Supply evidence either inline via `evidence` or by reference via `evidencePath` (a worktree-relative path the harness reads; preferred for evidence larger than ~500 characters because the path stays small in your conversation history).',
      parameters: Type.Object({
        text: Type.String({ description: 'The EXACT text of the checklist item' }),
        evidence: Type.Optional(Type.String({ description: 'Inline evidence of completion. Use this for short evidence (≲500 chars).' })),
        evidencePath: Type.Optional(Type.String({ description: 'Worktree-relative path to a file containing the evidence. Preferred for long evidence — keeps the prompt cache stable and your subsequent turns cheaper.' }))
      }),
      execute: async ({ text, evidence, evidencePath }: { text: string, evidence?: string, evidencePath?: string }, ctx: ExtensionContext) => {
        const result = await tickChecklistItems([{ text, evidence, evidencePath }], services, session);
        if (result.status === ToolResultStatus.PASSED) return `Successfully ticked: ${text}`;
        return `Error: ${result.message || 'Checklist item was rejected.'}`;
      }
    }));

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
      description: 'Add a runtime checklist item to the current phase so it is enforced by tick_item/get_outstanding_tasks/signal_completion.',
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

        if (activeRun.progressManager) {
          await activeRun.progressManager.appendLog(`Checkpoint: ${summary.slice(0, WorkerDefaults.CHECKLIST_EVIDENCE_PREVIEW_CHARS)}...`);
        }

        return 'Checkpoint accepted and recorded.';
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
          outcome,
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
        try {
          services.flowManager.nextState(activeRun.state, outcome);
        } catch (error) {
          return `REJECTED: ${String(error)}`;
        }

        const terminal = await terminalFailureLimitContext(services, session);
        if (terminal && outcome !== terminal.suggestedOutcome) {
          return `REJECTED: terminal failure limit already reached for project tool \`${terminal.failedTool}\` ` +
            `in ${terminal.stateId}/${terminal.actionId}. You MUST signal outcome ` +
            `\`${terminal.suggestedOutcome}\`; outcome \`${outcome}\` is not permitted after this terminal verifier failure.`;
        }

        if (outcome === EventName.SUCCESS) {
          const projection = await services.eventStore.projectBead(activeRun.beadId);
          const missing = missingMandatoryChecklistItems(activeRun.requiredItems, projection.checklists as any);
          if (missing.length > 0) {
             return `REJECTED: You cannot signal SUCCESS yet. The following mandatory checklist items are missing:\n${missing.map(m => `- ${m}`).join('\n')}\nUse the \`${BuiltInToolName.TICK_ITEMS}\` tool to complete them in a batch.`;
          }

          const requiredToolResolution = await services.requiredToolResolver.resolve(requiredToolsForRun(activeRun), {
            beadId: activeRun.beadId,
            stateId: activeRun.stateId,
            worktreePath: activeRun.worktreePath,
            projectRoot: services.projectRoot,
            config
          });
          const requiredTools = requiredToolResolution.toolNames;
          const auditFailures: string[] = [];
          for (const toolName of requiredTools) {
            const result = runtimeObservability.getToolResult(toolName);
            if (result === undefined) {
              auditFailures.push(`Tool \`${toolName}\` was NEVER invoked.`);
            } else if (resultIndicatesSuccess(result)) {
              continue;
            } else if (typeof result === 'string' && (result.startsWith('Error') || result.startsWith('Failed'))) {
              auditFailures.push(`Tool \`${toolName}\` failed: ${result}`);
            } else if (resultIndicatesFailure(result)) {
              auditFailures.push(`Tool \`${toolName}\` did not pass: ${JSON.stringify(result).slice(0, WorkerDefaults.TOOL_AUDIT_PREVIEW_CHARS)}`);
            } else {
              auditFailures.push(`Tool \`${toolName}\` did not record a passing result: ${JSON.stringify(result).slice(0, WorkerDefaults.TOOL_AUDIT_PREVIEW_CHARS)}`);
            }
          }
          if (auditFailures.length > 0) {
            return `REJECTED: Protocol Violation. Programmatic audit failed:\n${auditFailures.map(f => `- ${f}`).join('\n')}\nYou MUST satisfy all programmatic gates before signaling completion.`;
          }

          const planWriteSetPreflight = await services.planWriteSet.validatePlanContract({
            beadId: activeRun.beadId,
            stateId: activeRun.stateId,
            worktreePath: activeRun.worktreePath || process.cwd(),
            projectRoot: services.projectRoot
          });
          if (!planWriteSetPreflight.passed) {
            return `REJECTED: Plan write-set preflight failed.\n${planWriteSetPreflight.reason}\nRevise the plan contract before signaling SUCCESS.`;
          }

          const transactionalState = await services.transactionalStateGuard.validateSuccess(
            activeRun.beadId,
            activeRun.stateId,
            activeRun.worktreePath || process.cwd()
          );
          if (!transactionalState.passed) {
            return `REJECTED: Transactional state gate failed.\n${transactionalState.reason}\nUpdate the approved plan/write-set through the configured workflow or revert the unapproved files before signaling SUCCESS.`;
          }
        }

        if (!activeRun.checkpointAccepted) {
          return `REJECTED: You must call \`${BuiltInToolName.SUBMIT_CHECKPOINT}\` with durable evidence before signaling completion.`;
        }

        Logger.info(Component.ORR_ELSE, 'Teammate signaled turn completion', { beadId: activeRun.beadId, outcome, summary });

        const event = buildWorkerEvent(teammateEventTypeForOutcome(outcome), {
          beadId: activeRun.beadId,
          stateId: activeRun.stateId,
          actionId: activeRun.action.id,
          transitionEvent: outcome,
          summary,
          evidence: summary,
          handover: summary,
          usedTools: runtimeObservability.getCalledTools()
        });

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
      description: 'Request a fresh Pi session with a dense handover to reset context pollution.',
      parameters: Type.Object({
        summary: Type.String({ description: 'Handover summary for the next session' })
      }),
      execute: async ({ summary }: { summary: string }, ctx: ExtensionContext) => {
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
          handover: summary
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
        stateId: env.env(EnvVars.STATE_ID),
        projectRoot: env.env(EnvVars.PROJECT_ROOT) || process.cwd(),
        worktreePath: env.env(EnvVars.WORKTREE_PATH) || undefined,
        workerId: env.env(EnvVars.WORKER_ID) || `worker-${process.pid}`,
        actionId: env.env(EnvVars.ACTION_ID) || WorkerDefaults.AUTO_CONTEXT_RESTART_ACTION_ID
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

    services.flowManager.activateTools(pi, [
      BuiltInToolName.ORR_ELSE,
      BuiltInToolName.HARNESS_STATUS,
      ...services.plugins.bd.tools.map(t => t.name),
      ...getConfiguredProjectToolNames(config),
      ...getConfiguredPiToolNames(config)
    ]);
  });
}
