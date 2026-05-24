import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import * as path from 'path';
import { fileURLToPath } from 'url';
import { teammatePlugin, TeammateFactory } from './plugins/teammates.js';
import {
  describeConfiguredProjectTools,
  executeConfiguredProjectTool,
  getConfiguredProjectToolNames,
  getHarnessRegisteredProjectToolNames,
  getNativePiExtensionProjectToolNames,
  registerConfiguredProjectTools
} from './plugins/projectTools.js';
import type { HarnessConfig } from './core/ConfigLoader.js';
import { SignalingServer } from './core/SignalingServer.js';
import { Bead, BeadId } from './types/index.js';
import {
  TeammateEvent,
  createTeammateEventIdempotencyKey,
  isStatusMutatingTeammateEvent
} from './core/TeammateEvents.js';
import { getProjectRoot, setProjectRoot } from './core/Paths.js';
import { Logger } from './core/Logger.js';
import { Observability, SpanStatusValue, type SpanCompletion, type SpanContext } from './core/Observability.js';
import type { ChecklistItem } from './core/ProtocolParser.js';
import { deriveChecklistItems, mergeChecklistItems, missingMandatoryChecklistItems } from './core/ChecklistRequirements.js';
import { ProgressManager } from './core/ProgressManager.js';
import { WorklogManager } from './core/WorklogManager.js';
import { SDLCState, TeammateAction } from './core/domain/StateModels.js';
import {
  BeadStatus,
  ApiPath,
  DomainEventName,
  EventName,
  ExtensionCommandAction,
  HttpMethod,
  RestartKind,
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
  NativeReadPolicyDefaults
} from './constants/index.js';
import { Supervisor } from './core/Supervisor.js';
import { Teammate } from './core/Teammate.js';
import { getConfiguredPiToolNames, getObservedPiToolNames, resolvePiSkillPaths } from './core/PiIntegration.js';
import { createRuntimeServices, type RuntimeServices } from './core/RuntimeServices.js';

/**
 * Orr Else Extension
 * High-reliability agentic harness with obsessive, rehearsed resilience.
 */

let supervisor: Supervisor | null = null;
let activeRun: ActiveRun | null = null;
let artifactPathsToolRegistered = false;
let compatibilityContextToolRegistered = false;
let piToolObserverRegistered = false;
let agentLifecycleObserverRegistered = false;
let piToolObservability: Observability | null = null;
let observedPiTools = new Set<string>();
let blockedObservedPiToolCallIds = new Set<string>();
let observedPiToolSpans = new Map<string, SpanContext>();
let checklistMutationQueue: Promise<unknown> = Promise.resolve();
let currentFlowOptions: FlowOptions | null = null;
let agentFailureSignaled = false;
let processLifecycleObserversRegistered = false;

interface FlowOptions {
  maxSlots: number;
  autoContinue: boolean;
  beadId?: string;
  configPath?: string;
}

interface ActiveRun {
  beadId: BeadId;
  stateId: string;
  state: SDLCState;
  action: TeammateAction;
  requiredItems: ChecklistItem[];
  startedAt: number;
  worktreePath?: string;
  progressManager?: ProgressManager;
  worklogManager: WorklogManager;
  checkpointAccepted: boolean;
  parentSequenceCompleted: boolean;
  completedActionIds: string[];
}

interface ChecklistTickInput {
  text: string;
  evidence: string;
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

function toolResult(value: any) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return {
    content: [{ type: 'text' as const, text }],
    details: value
  };
}

function summarizeForEvent(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    return value.length > WorkerDefaults.EVENT_PREVIEW_CHARS
      ? `${value.slice(0, WorkerDefaults.EVENT_PREVIEW_CHARS)}...`
      : value;
  }
  try {
    const json = JSON.stringify(value);
    return json.length > WorkerDefaults.EVENT_PREVIEW_CHARS
      ? { preview: `${json.slice(0, WorkerDefaults.EVENT_PREVIEW_CHARS)}...`, truncated: true, bytes: json.length }
      : value;
  } catch {
    return String(value);
  }
}

function beadIdFromToolParams(params: any): string | undefined {
  return params?.beadId || params?.id || params?.arguments?.beadId || params?.arguments?.id || activeRun?.beadId || process.env[EnvVars.BEAD_ID];
}

function externalPiToolResultFromEvent(event: any): Record<string, unknown> {
  const failed = externalPiToolEventIndicatesFailure(event);
  return {
    tool: event.toolName,
    status: failed ? ToolResultStatus.REJECTED : ToolResultStatus.PASSED,
    isError: failed,
    content: summarizeForEvent(event.content),
    details: summarizeForEvent(event.details)
  };
}

function textIndicatesFailure(text: string): boolean {
  return text.startsWith('Error') || text.startsWith('Failed') || text.startsWith('REJECTED');
}

function contentIndicatesFailure(content: unknown): boolean {
  if (typeof content === 'string') return textIndicatesFailure(content.trim());
  if (!Array.isArray(content)) return false;
  return content.some(item => isRecord(item) && typeof item.text === 'string' && textIndicatesFailure(item.text.trim()));
}

function nestedResultIndicatesFailure(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.isError === true || value.success === false) return true;
  if (value.status === ToolResultStatus.REJECTED || value.status === ToolResultStatus.UNAVAILABLE) return true;
  if (typeof value.error === 'string' && value.error.length > 0) return true;
  if (contentIndicatesFailure(value.content)) return true;
  return nestedResultIndicatesFailure(value.details) || nestedResultIndicatesFailure(value.mcpResult);
}

function externalPiToolEventIndicatesFailure(event: any): boolean {
  return event.isError === true || nestedResultIndicatesFailure(event.details) || contentIndicatesFailure(event.content);
}

function normalizeStopReason(value: unknown): string | null {
  return typeof value === 'string' ? value.toLowerCase() : null;
}

function agentMessageError(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const stopReason = normalizeStopReason(value.stopReason || value.stop_reason);
  const errorMessage = typeof value.errorMessage === 'string'
    ? value.errorMessage
    : typeof value.error_message === 'string'
      ? value.error_message
      : typeof value.error === 'string'
        ? value.error
        : null;
  if (stopReason === 'error' || errorMessage) {
    return errorMessage || `Agent turn ended with stop reason: ${stopReason}`;
  }
  return null;
}

function agentEventError(event: any): string | null {
  const direct = typeof event?.error === 'string'
    ? event.error
    : isRecord(event?.error) && typeof event.error.errorMessage === 'string'
      ? event.error.errorMessage
      : null;
  if (direct) return direct;

  const candidates = [
    event?.message,
    ...(Array.isArray(event?.messages) ? event.messages : [])
  ];
  for (const candidate of candidates) {
    const messageError = agentMessageError(candidate);
    if (messageError) return messageError;
  }
  return null;
}

function isContextOverflowFailure(error: string): boolean {
  const normalized = error.toLowerCase();
  return normalized.includes(AgentFailureCode.CONTEXT_LENGTH_EXCEEDED)
    || normalized.includes('context length exceeded')
    || normalized.includes('context window')
    || normalized.includes('too many compactions')
    || normalized.includes('auto-compact')
    || normalized.includes('auto compact');
}

function isUsageLimitFailure(error: string): boolean {
  const normalized = error.toLowerCase();
  return normalized.includes(AgentFailureCode.USAGE_LIMIT_REACHED)
    || normalized.includes('usage limit has been reached');
}

function isHarnessTransientFailure(error: string): boolean {
  const normalized = error.toLowerCase();
  return normalized.includes(AgentFailureCode.WEBSOCKET_ERROR)
    || normalized.includes(AgentFailureCode.WEBSOCKET_CLOSED)
    || normalized.includes(AgentFailureCode.CONNECTION_RESET)
    || normalized.includes(AgentFailureCode.NETWORK_ERROR);
}

function compactLifecycleFailureSummary(source: PiEventName, error: string): string {
  if (isUsageLimitFailure(error)) {
    return `${AgentFailureSummary.USAGE_LIMIT} Source: ${source}. ${AgentFailureSummary.EVENT_STORE_DETAILS}`;
  }
  if (isContextOverflowFailure(error)) {
    return `${AgentFailureSummary.CONTEXT_OVERFLOW} Source: ${source}. ${AgentFailureSummary.EVENT_STORE_DETAILS}`;
  }
  if (isHarnessTransientFailure(error)) {
    return `${AgentFailureSummary.HARNESS_TRANSIENT} Source: ${source}. ${AgentFailureSummary.EVENT_STORE_DETAILS}`;
  }
  const compactError = error.length > WorkerDefaults.EVENT_PREVIEW_CHARS
    ? `${error.slice(0, WorkerDefaults.EVENT_PREVIEW_CHARS)}...`
    : error;
  return `Agent lifecycle failure during ${source}: ${compactError}`;
}

function usageLimitResetMs(error: string): number | undefined {
  const resetMatch = /"resets_at"\s*:\s*(\d+)/.exec(error)
    || /"X-Codex-Primary-Reset-At"\s*:\s*"?(\d+)"?/.exec(error);
  if (!resetMatch) return undefined;
  const parsed = Number.parseInt(resetMatch[1], Numeric.DECIMAL_RADIX);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed > Numeric.UNIX_SECONDS_MS_THRESHOLD ? parsed : parsed * TimeMs.SECOND;
}

function stringifySpanAttribute(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function commandMatchesPattern(command: string, pattern: string): boolean {
  try {
    return new RegExp(pattern).test(command);
  } catch {
    return command.includes(pattern);
  }
}

function commandInvokesToolName(command: string, toolName: string): boolean {
  return commandHeads(command).some(commandHead => commandHead === toolName);
}

const SHELL_CONTROL_OPERATORS = new Set(['&', '|', ';', '\n']);
const SHELL_QUOTES = new Set(["'", '"']);
const SHELL_ESCAPE = '\\';
const SHELL_ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: string | null = null;
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === SHELL_ESCAPE && quote !== "'") {
      current += char;
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) quote = null;
      current += char;
      continue;
    }

    if (SHELL_QUOTES.has(char)) {
      quote = char;
      current += char;
      continue;
    }

    if (SHELL_CONTROL_OPERATORS.has(char)) {
      if (current.trim()) segments.push(current.trim());
      current = '';
      while (command[index + 1] === char && char !== '\n') index += 1;
      continue;
    }

    current += char;
  }

  if (current.trim()) segments.push(current.trim());
  return segments;
}

function splitShellTokens(segment: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: string | null = null;
  let escaped = false;

  for (const char of segment) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === SHELL_ESCAPE && quote !== "'") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }

    if (SHELL_QUOTES.has(char)) {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  if (current) tokens.push(current);
  return tokens;
}

function commandHeads(command: string): string[] {
  return splitShellSegments(command)
    .map(segment => splitShellTokens(segment).find(token => !SHELL_ENV_ASSIGNMENT.test(token)) || '')
    .map(token => path.basename(token.replace(/^['"]|['"]$/g, '')))
    .filter(Boolean);
}

function teammateEventTypeForOutcome(outcome: string): TeammateEventType {
  const normalized = outcome.toUpperCase();
  if (normalized === EventName.FAILURE) return TeammateEventType.STATE_FAILED;
  if (normalized === EventName.BLOCKED) return TeammateEventType.STATE_BLOCKED;
  return TeammateEventType.STATE_TRANSITIONED;
}

function shellPolicyRejection(event: any, config: HarnessConfig): string | null {
  if (!isWorkerMode() || event.toolName !== NativePiToolName.BASH) return null;

  const policy = config.settings.pi?.shell;
  const command = typeof event.input?.command === 'string' ? event.input.command : '';
  if (!command.trim()) return null;

  for (const pattern of policy?.blockedCommandPatterns || []) {
    if (commandMatchesPattern(command, pattern)) {
      return `PROTOCOL VIOLATION: \`${NativePiToolName.BASH}\` may not invoke configured project-tool capability matching \`${pattern}\`. Use the corresponding Orr Else/Pi tool call from harness.yaml.`;
    }
  }

  const disallowProjectToolFallback = policy?.disallowProjectToolFallback ?? PiToolPolicyDefaults.DISALLOW_PROJECT_TOOL_FALLBACK;
  if (!disallowProjectToolFallback) return null;

  for (const tool of config.tools || []) {
    if (commandInvokesToolName(command, tool.name)) {
      return `PROTOCOL VIOLATION: \`${NativePiToolName.BASH}\` may not invoke configured project tool \`${tool.name}\`. Use the \`${tool.name}\` tool call from harness.yaml.`;
    }
  }

  return null;
}

function operationalLogReadPolicyRejection(event: any): string | null {
  if (!isWorkerMode() || event.toolName !== NativePiToolName.READ) return null;
  const requestedPath = typeof event.input?.path === 'string' ? event.input.path : '';
  if (!requestedPath.trim()) return null;

  const normalizedPath = requestedPath.replaceAll(path.sep, '/');
  const fileName = path.posix.basename(normalizedPath);
  const readsProgressLog = fileName === OperationalLogPath.PROGRESS_FILE;
  const readsWorklog = normalizedPath.split('/').includes(OperationalLogPath.WORKLOG_DIR)
    && fileName.endsWith(OperationalLogPath.WORKLOG_FILE_SUFFIX);
  if (!readsProgressLog && !readsWorklog) return null;

  return `PROTOCOL VIOLATION: \`${NativePiToolName.READ}\` may not read raw operational logs ` +
    `(\`${OperationalLogPath.PROGRESS_FILE}\` or \`${OperationalLogPath.WORKLOG_DIR}/*${OperationalLogPath.WORKLOG_FILE_SUFFIX}\`) ` +
    'inside a teammate context. Use `bd_get_state_chart`, `bd_get_bead`, `get_artifact_paths`, and configured artifacts for state reconstruction.';
}

function oversizedReadPolicyRejection(event: any): string | null {
  if (!isWorkerMode() || event.toolName !== NativePiToolName.READ) return null;
  const limit = Number(event.input?.limit);
  if (!Number.isFinite(limit) || limit <= NativeReadPolicyDefaults.MAX_LIMIT_LINES) return null;

  return `PROTOCOL VIOLATION: \`${NativePiToolName.READ}\` limit ${Math.floor(limit)} exceeds ` +
    `${NativeReadPolicyDefaults.MAX_LIMIT_LINES} lines inside a teammate context. ` +
    'Use smaller targeted reads, codemap, ast_grep, reference_docs, or artifact validators instead of loading broad file slices.';
}

function eventToolCallId(event: any): string | undefined {
  return typeof event.toolCallId === 'string' ? event.toolCallId : undefined;
}

function registerPiToolObservers(pi: ExtensionAPI, services: RuntimeServices): void {
  if (piToolObserverRegistered) return;
  piToolObserverRegistered = true;

  pi.on(PiEventName.TOOL_CALL, async (event: any) => {
    if (!observedPiTools.has(event.toolName)) return;
    const runtimeObservability = piToolObservability;
    const beadId = beadIdFromToolParams(event.input);
    const toolCallId = eventToolCallId(event);
    runtimeObservability?.recordToolInvocation(event.toolName);
    const span = runtimeObservability?.startSpan(`tool:${event.toolName}`, {
      'tool.name': event.toolName,
      'tool.external_pi': true,
      'tool.params': stringifySpanAttribute(summarizeForEvent(event.input))
    });
    if (span && toolCallId) observedPiToolSpans.set(toolCallId, span);

    await services.eventStore.record(DomainEventName.TOOL_INVOCATION_STARTED, {
      beadId,
      tool: event.toolName,
      externalPiTool: true,
      toolCallId,
      params: summarizeForEvent(event.input)
    }).catch(error => {
      Logger.warn(Component.ORR_ELSE, 'Failed to record Pi tool invocation start', {
        tool: event.toolName,
        error: String(error)
      });
    });

    const config = await services.configLoader.load();
    const rejection = shellPolicyRejection(event, config)
      || operationalLogReadPolicyRejection(event)
      || oversizedReadPolicyRejection(event)
      || await checkToolValidationRules(event.toolName, config, runtimeObservability || getObservability(services));
    if (!rejection) return;

    if (toolCallId) blockedObservedPiToolCallIds.add(toolCallId);
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
    return { block: true, reason: rejection };
  });

  pi.on(PiEventName.TOOL_RESULT, async (event: any) => {
    if (!observedPiTools.has(event.toolName)) return;
    const runtimeObservability = piToolObservability;
    const beadId = beadIdFromToolParams(event.input);
    const toolCallId = eventToolCallId(event);
    if (toolCallId && blockedObservedPiToolCallIds.delete(toolCallId)) {
      observedPiToolSpans.delete(toolCallId);
      return;
    }
    const result = externalPiToolResultFromEvent(event);
    runtimeObservability?.recordToolInvocation(event.toolName, result);
    const span = toolCallId ? observedPiToolSpans.get(toolCallId) : undefined;
    if (span) {
      runtimeObservability?.endSpan(
        span.spanId,
        result.isError ? SpanStatusValue.ERROR : SpanStatusValue.OK,
        result.isError ? stringifySpanAttribute(result) : undefined
      );
      observedPiToolSpans.delete(toolCallId!);
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

function registerAgentLifecycleObservers(pi: ExtensionAPI, services: RuntimeServices): void {
  if (agentLifecycleObserverRegistered) return;
  agentLifecycleObserverRegistered = true;

  pi.on(PiEventName.TURN_END, async (event: any, ctx: ExtensionContext) => {
    await handleAgentLifecycleFailure(event, ctx, PiEventName.TURN_END, services);
  });

  pi.on(PiEventName.AGENT_END, async (event: any, ctx: ExtensionContext) => {
    await handleAgentLifecycleFailure(event, ctx, PiEventName.AGENT_END, services);
  });
}

async function handleAgentLifecycleFailure(event: any, ctx: ExtensionContext, source: PiEventName, services: RuntimeServices): Promise<void> {
  if (!isWorkerMode() || !activeRun || agentFailureSignaled) return;
  const error = agentEventError(event);
  if (!error) return;

  agentFailureSignaled = true;
  const summary = compactLifecycleFailureSummary(source, error);
  await services.eventStore.record(DomainEventName.AGENT_TURN_FAILED, {
    beadId: activeRun.beadId,
    stateId: activeRun.stateId,
    actionId: activeRun.action.id,
    source,
    summary,
    error
  }).catch(recordError => {
    Logger.warn(Component.ORR_ELSE, 'Failed to record agent lifecycle failure', {
      beadId: activeRun?.beadId,
      error: String(recordError)
    });
  });

  await activeRun.worklogManager.appendEntry(activeRun.beadId, activeRun.stateId, 'Agent lifecycle failure', summary).catch(() => undefined);
  await activeRun.progressManager?.appendLog(summary).catch(() => undefined);

  if (isUsageLimitFailure(error)) {
    const pauseUntilMs = usageLimitResetMs(error) || Date.now() + SupervisorDefaults.CAPACITY_LIMIT_FALLBACK_PAUSE_MS;
    await services.eventStore.record(DomainEventName.HARNESS_CAPACITY_LIMIT_REACHED, {
      beadId: activeRun.beadId,
      stateId: activeRun.stateId,
      actionId: activeRun.action.id,
      pauseUntil: new Date(pauseUntilMs).toISOString(),
      error
    }).catch(recordError => {
      Logger.warn(Component.ORR_ELSE, 'Failed to record harness capacity limit', {
        beadId: activeRun?.beadId,
        error: String(recordError)
      });
    });

    const exitedEvent = buildWorkerEvent(TeammateEventType.TEAMMATE_EXITED, {
      beadId: activeRun.beadId,
      stateId: activeRun.stateId,
      summary,
      capacityLimited: true,
      pauseUntilMs
    });
    await apiRequest(ApiPath.SIGNAL, HttpMethod.POST, exitedEvent).catch(signalError => {
      Logger.error(Component.ORR_ELSE, 'Failed to signal harness capacity limit', {
        beadId: activeRun?.beadId,
        error: String(signalError)
      });
    });

    setTimeout(() => {
      if (ctx.hasUI) ctx.ui.setStatus(Component.ORR_ELSE.toLowerCase(), 'Shutting down after capacity limit...');
      ctx.shutdown();
    }, WorkerDefaults.SHUTDOWN_AFTER_SIGNAL_MS);
    return;
  }

  const isContextRestart = isContextOverflowFailure(error);
  const isHarnessRestart = isHarnessTransientFailure(error);
  const config = await services.configLoader.load();
  const teammateEventType = isContextRestart
    ? TeammateEventType.CONTEXT_RESTART_REQUESTED
    : isHarnessRestart
      ? TeammateEventType.HARNESS_RESTART_REQUESTED
      : TeammateEventType.STATE_BLOCKED;
  const teammateEvent = buildWorkerEvent(teammateEventType, {
    beadId: activeRun.beadId,
    stateId: activeRun.stateId,
    actionId: activeRun.action.id,
    transitionEvent: isContextRestart
      ? config.settings.contextRestartEvent || EventName.CONTEXT_RESTART
      : isHarnessRestart
        ? config.settings.harnessRestartEvent || EventName.HARNESS_RESTART
      : EventName.BLOCKED,
    summary,
    evidence: summary,
    handover: summary
  });
  await apiRequest(ApiPath.SIGNAL, HttpMethod.POST, teammateEvent).catch(signalError => {
    Logger.error(Component.ORR_ELSE, 'Failed to signal agent lifecycle failure', {
      beadId: activeRun?.beadId,
      error: String(signalError)
    });
  });

  setTimeout(() => {
    if (ctx.hasUI) {
      const status = isContextRestart
        ? 'Shutting down for context restart...'
        : isHarnessRestart
          ? 'Shutting down for harness restart...'
          : 'Shutting down after agent failure...';
      ctx.ui.setStatus(Component.ORR_ELSE.toLowerCase(), status);
    }
    ctx.shutdown();
  }, WorkerDefaults.SHUTDOWN_AFTER_SIGNAL_MS);
}

function resultIndicatesFailure(result: unknown): boolean {
  if (typeof result === 'string') return textIndicatesFailure(result);
  if (!isRecord(result)) return false;
  return nestedResultIndicatesFailure(result);
}

function resultIndicatesSuccess(result: unknown): boolean {
  if (!isRecord(result)) return false;
  return result.success === true || result.status === ToolResultStatus.PASSED;
}

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

    if (rule.condition === ToolValidationCondition.PASSED && result?.status !== ToolResultStatus.PASSED) {
      return rule.message || `PROTOCOL VIOLATION: Tool \`${toolName}\` requires \`${rule.tool}\` to have returned a \`PASSED\` status.`;
    }

    if (rule.condition === ToolValidationCondition.SUCCEEDED && !resultIndicatesSuccess(result)) {
      return rule.message || `PROTOCOL VIOLATION: Tool \`${toolName}\` requires \`${rule.tool}\` to have succeeded.`;
    }
  }

  return null;
}

function wrapPluginTool(
  tool: { name: string, description: string, parameters: any, execute: Function },
  runtimeObservability: Observability,
  services: RuntimeServices
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

      const beadId = beadIdFromToolParams(params);
      await services.eventStore.record(DomainEventName.TOOL_INVOCATION_STARTED, {
        beadId,
        tool: tool.name,
        params: summarizeForEvent(params)
      });

      const tracedExecute = runtimeObservability.tracedAsync(
        `tool:${tool.name}`,
        {
          'tool.name': tool.name,
          'tool.params': JSON.stringify(params)
        },
        async (p: any, c: ExtensionContext) => {
          if (c.hasUI) c.ui.setWorkingMessage(`Executing ${tool.name}...`);
          const result = await tool.execute(p || {}, c);
          if (c.hasUI) c.ui.setWorkingMessage(undefined);

          // Record invocation and result for audit
          runtimeObservability.recordToolInvocation(tool.name, result);

          if (resultIndicatesFailure(result)) {
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

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

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
  if (Array.isArray(parsed)) {
    return parsed.filter((item): item is { tool: string; arguments?: Record<string, unknown> } =>
      isRecord(item) && typeof item.tool === 'string'
    );
  }
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

async function apiRequest(path: string, method: string, body?: any) {
  const apiPort = process.env[EnvVars.API_PORT] || Defaults.API_PORT;
  const apiBase = process.env[EnvVars.API_BASE] || `http://${Defaults.API_HOST}:${apiPort}`;
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: { [HttpHeader.CONTENT_TYPE]: HttpHeader.APPLICATION_JSON },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  if (!response.ok) throw new Error(`API Error: ${response.status}`);
  return await response.json();
}

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

async function addChecklistItem(rawItem: Record<string, unknown>, source: string, services: RuntimeServices): Promise<Record<string, unknown>> {
  const operation = checklistMutationQueue.then(
    () => addChecklistItemInner(rawItem, source, services),
    () => addChecklistItemInner(rawItem, source, services)
  );
  checklistMutationQueue = operation.catch(() => undefined);
  return operation;
}

async function addChecklistItemInner(rawItem: Record<string, unknown>, source: string, services: RuntimeServices): Promise<Record<string, unknown>> {
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

async function tickChecklistItems(items: ChecklistTickInput[], services: RuntimeServices): Promise<Record<string, unknown>> {
  if (!activeRun) return { status: ToolResultStatus.REJECTED, message: 'No active run.' };
  if (!Array.isArray(items) || items.length === 0) {
    return { status: ToolResultStatus.REJECTED, message: 'At least one checklist item is required.' };
  }

  const uniqueItems = Array.from(new Map(items.map(item => [item.text, item])).values());
  const rejected = uniqueItems
    .filter(item => !activeRun!.requiredItems.some(required => required.text === item.text))
    .map(item => item.text);
  if (rejected.length > 0) {
    return {
      status: ToolResultStatus.REJECTED,
      message: `Checklist item is not in the current phase checklist: ${rejected.join(', ')}`
    };
  }

  const actionKey = actionCompletionKey(await services.configLoader.load(), activeRun.stateId, activeRun.action.id);
  for (const item of uniqueItems) {
    await services.eventStore.record(DomainEventName.CHECKLIST_ITEM_TICKED, {
      beadId: activeRun.beadId,
      stateId: activeRun.stateId,
      actionId: activeRun.action.id,
      actionKey,
      text: item.text,
      evidence: item.evidence
    });
  }

  await activeRun.worklogManager.appendEntry(
    activeRun.beadId,
    activeRun.stateId,
    `Ticked ${uniqueItems.length} checklist item${uniqueItems.length === 1 ? '' : 's'}`,
    uniqueItems.map(item => `- ${item.text}: ${item.evidence}`).join('\n')
  );

  if (activeRun.progressManager) {
    await activeRun.progressManager.appendLog(
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
  services: RuntimeServices
): Promise<Record<string, unknown>> {
  if (toolCall.tool !== BuiltInToolName.ADD_CHECKLIST_ITEM) {
    return {
      status: ToolResultStatus.REJECTED,
      message: `Unsupported framework tool call from ${source}: ${toolCall.tool}`
    };
  }
  const result = await addChecklistItem(toolCall.arguments || {}, source, services);
  runtimeObservability.recordToolInvocation(BuiltInToolName.ADD_CHECKLIST_ITEM, result);
  return result;
}

async function runParentSequenceActionsBeforeActive(
  config: HarnessConfig,
  ctx: ExtensionContext,
  runtimeObservability: Observability,
  services: RuntimeServices
): Promise<void> {
  if (!activeRun || activeRun.parentSequenceCompleted) return;
  const activeIndex = activeRun.state.actions.findIndex(action => action.id === activeRun!.action.id);
  const precedingActions = activeIndex <= 0 ? [] : activeRun.state.actions.slice(0, activeIndex);

  for (const action of precedingActions) {
    if (actionRunContext(action) === ActionRunContext.FRESH) {
      throw new Error(`Action ${action.id} requests fresh context but has not completed before ${activeRun.action.id}.`);
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
      beadId: activeRun.beadId,
      stateId: activeRun.stateId,
      actionId: action.id,
      arguments: action.arguments || {}
    }, ctx);
    runtimeObservability.recordToolInvocation(action.tool, result);

    for (const toolCall of extractFrameworkToolCalls(result)) {
      const toolResult = await executeFrameworkToolCall(toolCall, action.tool, runtimeObservability, services);
      if (toolResult.status !== ToolResultStatus.PASSED) {
        throw new Error(`Sequenced action ${action.id} framework tool call failed: ${JSON.stringify(toolResult)}`);
      }
    }

    if (resultIndicatesFailure(result)) {
      throw new Error(`Sequenced action ${action.id} failed: ${JSON.stringify(result).slice(0, WorkerDefaults.TOOL_AUDIT_PREVIEW_CHARS)}`);
    }

    const actionKey = actionCompletionKey(config, activeRun.stateId, action.id);
    const completedActionIds = appendCompletedActionId(activeRun.completedActionIds, activeRun.stateId, action.id, config);
    activeRun.completedActionIds = completedActionIds;
    await services.eventStore.record(DomainEventName.ACTION_COMPLETED, {
      beadId: activeRun.beadId,
      stateId: activeRun.stateId,
      actionId: action.id,
      actionKey,
      tool: action.tool,
      result: summarizeForEvent(result)
    });
  }

  activeRun.parentSequenceCompleted = true;
}

function buildWorkerEvent(type: TeammateEventType, fields: any): TeammateEvent {
  const timestamp = Date.now();
  const workerId = process.env[EnvVars.WORKER_ID] || `worker-${process.pid}`;
  const sessionStateId = process.env[EnvVars.SESSION_STATE_ID];
  const event: Partial<TeammateEvent> = {
    ...fields,
    type,
    beadId: fields.beadId || process.env[EnvVars.BEAD_ID],
    workerId,
    sessionStateId,
    stateId: fields.stateId || process.env[EnvVars.STATE_ID] || fields.nextPhase || WorkerDefaults.UNKNOWN_STATE_ID,
    timestamp
  };
  event.idempotencyKey = createTeammateEventIdempotencyKey(event);
  return event as TeammateEvent;
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

async function initializeWorkerRun(runtimeObservability: Observability, services: RuntimeServices): Promise<void> {
  const beadId = process.env[EnvVars.BEAD_ID] as BeadId | undefined;
  const stateId = process.env[EnvVars.STATE_ID];
  if (!beadId || !stateId) return;

  const config = await services.configLoader.load();
  const state = config.states[stateId];
  if (!state) throw new Error(`Configured state not found: ${stateId}`);

  const actionId = process.env[EnvVars.ACTION_ID];
  const bead = await services.plugins.bd.tools.find(t => t.name === PluginToolName.BD_GET_BEAD)!.execute({ id: beadId }) as Bead;
  const completedActionIds = bead.completedActionIds || [];
  const action = selectActiveAction(config, stateId, state, actionId, completedActionIds);
  if (!action) throw new Error(`State ${stateId} has no configured actions.`);

  const worktreePath = process.env[EnvVars.WORKTREE_PATH] || process.cwd();
  const configuredRequiredItems = deriveChecklistItems(state, action, config, stateId);
  const requiredItems = mergeChecklistItems(
    configuredRequiredItems,
    dynamicChecklistItemsForRun(bead, stateId, action.id)
  ).requiredItems;
  const worklogManager = new WorklogManager(services.eventStore);
  const progressManager = new ProgressManager(worktreePath, services.eventStore, { beadId, stateId });

  activeRun = {
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
  agentFailureSignaled = false;
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

function buildStateSystemPrompt(config: HarnessConfig, services: RuntimeServices): string {
  if (!activeRun) return '';
  const stateInstructions = services.instructionLoader.assemble(activeRun.state, config);
  const protocol = services.protocolInjector.inject(activeRun.state, config);
  const checklistProtocol = services.protocolParser.generatePrompt(activeRun.requiredItems);
  const projectTools = describeConfiguredProjectTools(config);
  const actionPrompt = activeRun.action.prompt || '';
  const llm = services.configLoader.resolveLLMConfig(activeRun.stateId, config);

  return services.contextInjector.inject(
    [stateInstructions, protocol, checklistProtocol, projectTools, actionPrompt].filter(Boolean).join('\n\n'),
    {
      beadId: activeRun.beadId,
      projectRoot: process.env[EnvVars.PROJECT_ROOT] || getProjectRoot(),
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
      timestamp: new Date().toISOString()
    }
  );
}

async function handleTeammateEvent(pi: ExtensionAPI, ctx: ExtensionContext, event: TeammateEvent, services: RuntimeServices) {
  const currentSupervisor = supervisor;
  if (!currentSupervisor) return;

  await services.eventStore.record(DomainEventName.TEAMMATE_EVENT, event);

  if (event.type === TeammateEventType.HEARTBEAT) {
    Logger.info(Component.ORR_ELSE, 'Received teammate heartbeat', { beadId: event.beadId, workerId: event.workerId });
    return;
  }

  const beadId = event.beadId as BeadId;
  if (ctx.hasUI) ctx.ui.setStatus(Component.ORR_ELSE.toLowerCase(), `Processing ${event.type} for ${beadId}`);

  if (currentSupervisor.isSignalProcessed(event.idempotencyKey)) return;
  currentSupervisor.markSignalProcessed(event.idempotencyKey);

  if (event.type === TeammateEventType.TEAMMATE_EXITED) {
    currentSupervisor.markBeadExited(beadId);
    const releaseTool = services.plugins.bd.tools.find(t => t.name === PluginToolName.BD_RELEASE)!;
    const pauseUntilMs = typeof (event as any).pauseUntilMs === 'number' ? (event as any).pauseUntilMs : undefined;
    if ((event as any).capacityLimited === true && pauseUntilMs) {
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
  const releaseTool = services.plugins.bd.tools.find(t => t.name === PluginToolName.BD_RELEASE)!;

  if (event.type === TeammateEventType.STATE_TRANSITIONED) {
    const state = config.states[event.stateId];
    const actionKey = event.actionId ? actionCompletionKey(config, event.stateId, event.actionId) : undefined;
    const bead = await services.plugins.bd.tools.find(t => t.name === PluginToolName.BD_GET_BEAD)!.execute({ id: beadId }) as Bead;
    const completedActionIds = event.transitionEvent === EventName.SUCCESS
      ? appendCompletedActionId(bead.completedActionIds || [], event.stateId, event.actionId, config)
      : (bead.completedActionIds || []);
    const nextAction = state && event.transitionEvent === EventName.SUCCESS
      ? nextSequencedAction(config, event.stateId, state, event.actionId, completedActionIds)
      : undefined;

    if (nextAction) {
      await services.eventStore.record(DomainEventName.STATE_TRANSITION_APPLIED, {
        beadId,
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
      const mergeTool = services.plugins.git.tools.find(t => t.name === PluginToolName.MERGE_AND_COMMIT)!;
      const mergeResult = await mergeTool.execute({ beadId }, ctx);
      if ((mergeResult as any)?.success !== true) {
        await services.plugins.bd.tools.find(t => t.name === PluginToolName.BD_UPDATE_STATUS)!.execute({
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

      await services.plugins.bd.tools.find(t => t.name === PluginToolName.BD_UPDATE_STATUS)!.execute({
        id: beadId,
        status: BeadStatus.COMPLETED,
        notes: event.summary
      }, ctx);
      await services.plugins.git.tools.find(t => t.name === PluginToolName.REMOVE_WORKTREE)!.execute({ beadId, force: true }, ctx);
      currentSupervisor.markBeadExited(beadId);
      return;
    }
  }

  if (event.type === TeammateEventType.STATE_FAILED || event.type === TeammateEventType.STATE_BLOCKED) {
    const state = config.states[event.stateId];
    const nextState = state ? services.flowManager.nextState(state, event.transitionEvent) : event.stateId;
    await services.eventStore.record(DomainEventName.STATE_TRANSITION_APPLIED, {
      beadId,
      fromState: event.stateId,
      nextState,
      transitionEvent: event.transitionEvent,
      actionId: event.actionId,
      actionKey: event.actionId ? actionCompletionKey(config, event.stateId, event.actionId) : undefined,
      summary: event.summary,
      evidence: event.evidence,
      handover: event.handover
    });
  }

  if (event.type === TeammateEventType.CONTEXT_RESTART_REQUESTED) {
    const state = config.states[event.stateId];
    const nextState = state ? services.flowManager.nextState(state, event.transitionEvent) : event.stateId;
    await services.eventStore.record(DomainEventName.CONTEXT_RESTART_REQUESTED, {
      beadId,
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

function flowStatus(services: RuntimeServices): string {
  if (activeRun) {
    const elapsedSeconds = Math.round((Date.now() - activeRun.startedAt) / TimeMs.SECOND);
    return [
      'Orr Else teammate active.',
      `Bead: ${activeRun.beadId}`,
      `State: ${activeRun.stateId}`,
      `Action: ${activeRun.action.id}`,
      `Project root: ${process.env[EnvVars.PROJECT_ROOT] || getProjectRoot()}`,
      `Config path: ${process.env[EnvVars.CONFIG_PATH] || services.configLoader.getConfigPath()}`,
      `Worktree: ${activeRun.worktreePath || process.cwd()}`,
      `Elapsed: ${elapsedSeconds}s`,
      `Checklist items loaded: ${activeRun.requiredItems.length}`,
      `Completed actions known: ${activeRun.completedActionIds.length}`,
      `Checkpoint accepted: ${activeRun.checkpointAccepted ? 'yes' : 'no'}`
    ].join('\n');
  }

  if (supervisor) {
    return [
      'Orr Else coordinator active.',
      `Requested bead: ${currentFlowOptions?.beadId || 'backlog'}`,
      `Max slots: ${currentFlowOptions?.maxSlots ?? Defaults.MAX_SLOTS}`,
      `Auto-continue: ${currentFlowOptions?.autoContinue === false ? 'no' : 'yes'}`,
      `Config: ${currentFlowOptions?.configPath || services.configLoader.getConfigPath()}`
    ].join('\n');
  }

  return 'Orr Else is not running.';
}

async function startOrrElse(pi: ExtensionAPI, ctx: ExtensionContext, options: FlowOptions, services: RuntimeServices): Promise<string> {
  if (isWorkerMode()) return 'This Pi process is an Orr Else teammate, not the coordinator.';
  if (supervisor) return flowStatus(services);

  if (ctx.hasUI) ctx.ui.notify('Starting Orr Else coordinator...', 'info');
  if (options.configPath) services.configLoader.setConfigPath(options.configPath);
  currentFlowOptions = { ...options };
  const runtimeObservability = await initializeObservability(services);
  await services.eventStore.record(DomainEventName.HARNESS_STARTED, {
    beadId: options.beadId,
    maxSlots: options.maxSlots,
    autoContinue: options.autoContinue
  });

  const server = new SignalingServer(event => handleTeammateEvent(pi, ctx, event, services), runtimeObservability, services.eventStore);
  await server.start();

  const factory = new TeammateFactory(
    runtimeObservability,
    services.configLoader,
    services.eventStore,
    options.maxSlots || Defaults.MAX_SLOTS,
    Defaults.TMUX_SESSION,
    fileURLToPath(import.meta.url)
  );
  await factory.ensureAgentsWindow();
  
  supervisor = new Supervisor(pi, ctx, server, factory, runtimeObservability, services, {
    maxSlots: options.maxSlots,
    requestedBeadId: options.beadId
  });
  
  await supervisor.start();

  return `${flowStatus(services)}\nAttach with: tmux attach -t orr-else`;
}

type OrrElseParsedArgs = FlowOptions | ExtensionCommandAction.STATUS | ExtensionCommandAction.STOP;

function parseOrrElseArgs(rawArgs: string, config?: HarnessConfig): OrrElseParsedArgs {
  const tokens = rawArgs.trim().split(/\s+/).filter(Boolean);
  const options: FlowOptions = {
    maxSlots: config?.settings?.maxConcurrentSlots || Defaults.MAX_SLOTS,
    autoContinue: true
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === ExtensionCommandAction.STATUS) return ExtensionCommandAction.STATUS;
    if (token === ExtensionCommandAction.STOP) return ExtensionCommandAction.STOP;
    if (token === CliOption.CONFIG && tokens[i + 1]) {
      options.configPath = tokens[++i];
    } else if (token === CliOption.BEAD && tokens[i + 1]) {
      options.beadId = tokens[++i];
    } else if (token === CliOption.MAX_SLOTS && tokens[i + 1]) {
      options.maxSlots = parseInt(tokens[++i], Numeric.DECIMAL_RADIX);
    }
  }
  return options;
}

export default async function orrElseExtension(pi: ExtensionAPI, providedServices?: RuntimeServices) {
  registerProcessLifecycleObservers();
  Logger.info(Component.ORR_ELSE, 'Orr Else extension loading', { version: App.VERSION });
  
  const projectRoot = process.env[EnvVars.PROJECT_ROOT] || process.cwd();
  setProjectRoot(projectRoot);
  const services = providedServices || createRuntimeServices();

  const seenTools = new Set<string>();

  pi.registerCommand(BuiltInToolName.ORR_ELSE, {
    description: `Start Orr Else coordinator. Usage: /orr-else [status|stop] [${CliOption.CONFIG} path] [${CliOption.BEAD} id] [${CliOption.MAX_SLOTS} n].`,
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      try {
        const preliminary = parseOrrElseArgs(args);
        
        if (preliminary === ExtensionCommandAction.STATUS) {
          ctx.ui.notify(flowStatus(services), 'info');
          return;
        }
        
        if (preliminary === ExtensionCommandAction.STOP) {
          if (supervisor) supervisor.stop();
          supervisor = null;
          currentFlowOptions = null;
          ctx.ui.notify('Orr Else stopped.', 'info');
          return;
        }

        if (preliminary.configPath) services.configLoader.setConfigPath(preliminary.configPath);
        const config = await services.configLoader.load();
        const parsed = parseOrrElseArgs(args, config);

        if (typeof parsed === 'object') {
          const result = await startOrrElse(pi, ctx as any, parsed, services);
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
    if (supervisor) supervisor.stop();
    supervisor = null;
    currentFlowOptions = null;
    piToolObservability = null;
    observedPiTools = new Set<string>();
    blockedObservedPiToolCallIds = new Set<string>();
    observedPiToolSpans = new Map<string, SpanContext>();
    const runtimeObservability = services.observability;
    void runtimeObservability?.forceFlush().finally(() => runtimeObservability.shutdown());
  });

  pi.on(PiEventName.BEFORE_AGENT_START, async (event: any) => {
    if (!isWorkerMode()) return;
    const config = await services.configLoader.load();
    if (!activeRun) await initializeWorkerRun(services.observability, services);
    const statePrompt = buildStateSystemPrompt(config, services);
    if (!statePrompt) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${statePrompt}` };
  });

  pi.on(PiEventName.RESOURCES_DISCOVER, async () => {
    const config = await services.configLoader.load();
    const projectRoot = process.env[EnvVars.PROJECT_ROOT] || getProjectRoot();
    const skillPaths = resolvePiSkillPaths(config, projectRoot);
    return skillPaths.length > 0 ? { skillPaths } : {};
  });

  pi.on(PiEventName.SESSION_START, async (_event: any, ctx: any) => {
    const config = await services.configLoader.load();
    const runtimeObservability = await initializeObservability(services);
    piToolObservability = runtimeObservability;
    const wrappedToolNames = new Set<string>([
      ...Object.values(BuiltInToolName),
      ...Object.values(PluginToolName),
      ...getHarnessRegisteredProjectToolNames(config)
    ]);
    observedPiTools = new Set([
      ...getObservedPiToolNames(config),
      ...getNativePiExtensionProjectToolNames(config)
    ].filter(toolName => !wrappedToolNames.has(toolName)));
    registerPiToolObservers(pi, services);
    registerAgentLifecycleObservers(pi, services);
    const wrapRuntimeTool = (tool: { name: string, description: string, parameters: any, execute: Function }) =>
      wrapPluginTool(tool, runtimeObservability, services);

    if (!artifactPathsToolRegistered) {
      artifactPathsToolRegistered = true;
      pi.registerTool(wrapRuntimeTool({
        name: BuiltInToolName.GET_ARTIFACT_PATHS,
        description: 'Resolve configured stable artifact paths for the current Bead/state/action.',
        parameters: Type.Object({
          beadId: Type.String({ description: 'The Bead ID' }),
          stateId: Type.String({ description: 'Optional state ID', optional: true }),
          actionId: Type.String({ description: 'Optional action ID', optional: true }),
          artifactId: Type.String({ description: 'Optional artifact ID for template expansion', optional: true })
        }),
        execute: async (params: any) => services.artifactPaths.resolve(params)
      }) as any);
    }

    if (!compatibilityContextToolRegistered) {
      compatibilityContextToolRegistered = true;
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

    const teammateToolFactory = new TeammateFactory(
      runtimeObservability,
      services.configLoader,
      services.eventStore,
      config.settings.maxConcurrentSlots || Defaults.MAX_SLOTS,
      Defaults.TMUX_SESSION,
      fileURLToPath(import.meta.url)
    );
    const harnessPlugins = [
      services.plugins.bd,
      services.plugins.git,
      teammatePlugin(teammateToolFactory),
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
    registerConfiguredProjectTools(services.eventStore, services.toolCallPathFactory, pi, config, seenTools, wrapRuntimeTool, () => activeRun
      ? {
        beadId: activeRun.beadId,
        stateId: activeRun.stateId,
        actionId: activeRun.action.id
      }
      : undefined);
    validateNativePiExtensionProjectTools(pi, config);

    pi.registerTool(wrapRuntimeTool({
      name: BuiltInToolName.TICK_ITEM,
      description: 'Tick one mandatory or optional checklist item for the current phase. Prefer tick_items for batched checklist updates.',
      parameters: Type.Object({
        text: Type.String({ description: 'The EXACT text of the checklist item' }),
        evidence: Type.String({ description: 'Specific evidence of completion (commands run, files changed, etc.)' })
      }),
      execute: async ({ text, evidence }: { text: string, evidence: string }, ctx: ExtensionContext) => {
        const result = await tickChecklistItems([{ text, evidence }], services);
        if (result.status === ToolResultStatus.PASSED) return `Successfully ticked: ${text}`;
        return `Error: ${result.message || 'Checklist item was rejected.'}`;
      }
    }));

    pi.registerTool(wrapRuntimeTool({
      name: BuiltInToolName.TICK_ITEMS,
      description: 'Batch tick mandatory or optional checklist items for the current phase using event-store-backed state.',
      parameters: Type.Object({
        items: Type.Array(Type.Object({
          text: Type.String({ description: 'The EXACT text of the checklist item' }),
          evidence: Type.String({ description: 'Specific evidence of completion (commands run, files changed, etc.)' })
        }), { description: 'Checklist items to mark complete.' })
      }),
      execute: async ({ items }: { items: ChecklistTickInput[] }, ctx: ExtensionContext) => tickChecklistItems(items, services)
    }));

    pi.registerTool(wrapRuntimeTool({
      name: BuiltInToolName.GET_OUTSTANDING_TASKS,
      description: 'Get the list of mandatory checklist items that still need to be completed.',
      parameters: Type.Object({}),
      execute: async (_params: any, ctx: ExtensionContext) => {
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
      execute: async (params: Record<string, unknown>) => addChecklistItem(params, BuiltInToolName.ADD_CHECKLIST_ITEM, services)
    }));

    pi.registerTool(wrapRuntimeTool({
      name: BuiltInToolName.SUBMIT_CHECKPOINT,
      description: 'Submit a formal checkpoint of your work, including evidence and summary.',
      parameters: Type.Object({
        summary: Type.String({ description: 'A detailed summary of progress' }),
        evidence: Type.String({ description: 'Detailed evidence (logs, output, etc.)' })
      }),
      execute: async ({ summary, evidence }: { summary: string, evidence: string }, ctx: ExtensionContext) => {
        if (!activeRun) return 'Error: No active run.';
        
        await activeRun.worklogManager.appendEntry(activeRun.beadId, activeRun.stateId, summary, evidence);
        
        const event = buildWorkerEvent(TeammateEventType.CHECKPOINT_ACCEPTED, {
          beadId: activeRun.beadId,
          stateId: activeRun.stateId,
          actionId: activeRun.action.id,
          summary,
          evidence
        });

        await services.eventStore.record(DomainEventName.CHECKPOINT_SUBMITTED, {
          beadId: activeRun.beadId,
          stateId: activeRun.stateId,
          actionId: activeRun.action.id,
          actionKey: actionCompletionKey(await services.configLoader.load(), activeRun.stateId, activeRun.action.id),
          summary,
          evidence
        });
        
        await apiRequest(ApiPath.SIGNAL, HttpMethod.POST, event);
        
        if (activeRun.progressManager) {
          await activeRun.progressManager.appendLog(`Checkpoint: ${summary.slice(0, WorkerDefaults.CHECKLIST_EVIDENCE_PREVIEW_CHARS)}...`);
        }

        return 'Checkpoint accepted and recorded.';
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
        if (!activeRun) return 'Error: No active run.';
	        try {
	          services.flowManager.nextState(activeRun.state, outcome);
	        } catch (error) {
	          return `REJECTED: ${String(error)}`;
	        }
	        
	        if (outcome === EventName.SUCCESS) {
          const projection = await services.eventStore.projectBead(activeRun.beadId);
          const missing = missingMandatoryChecklistItems(activeRun.requiredItems, projection.checklists as any);
          if (missing.length > 0) {
             return `REJECTED: You cannot signal SUCCESS yet. The following mandatory checklist items are missing:\n${missing.map(m => `- ${m}`).join('\n')}\nUse the \`${BuiltInToolName.TICK_ITEMS}\` tool to complete them in a batch.`;
          }

          const requiredTools = activeRun.state.requiredTools || [];
          const auditFailures: string[] = [];
          for (const toolName of requiredTools) {
            const result = runtimeObservability.getToolResult(toolName);
            if (result === undefined) auditFailures.push(`Tool \`${toolName}\` was NEVER invoked.`);
            else if (typeof result === 'string' && (result.startsWith('Error') || result.startsWith('Failed'))) {
              auditFailures.push(`Tool \`${toolName}\` failed: ${result}`);
            } else if (resultIndicatesFailure(result)) {
              auditFailures.push(`Tool \`${toolName}\` did not pass: ${JSON.stringify(result).slice(0, WorkerDefaults.TOOL_AUDIT_PREVIEW_CHARS)}`);
            }
          }
          if (auditFailures.length > 0) {
            return `REJECTED: Protocol Violation. Programmatic audit failed:\n${auditFailures.map(f => `- ${f}`).join('\n')}\nYou MUST satisfy all programmatic gates before signaling completion.`;
          }
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

        await apiRequest(ApiPath.SIGNAL, HttpMethod.POST, event);
        
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
        
        await apiRequest(ApiPath.SIGNAL, HttpMethod.POST, event);
        
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

        await apiRequest(ApiPath.SIGNAL, HttpMethod.POST, event);

        setTimeout(() => ctx.shutdown(), WorkerDefaults.SHUTDOWN_AFTER_SIGNAL_MS);
        return 'Harness restart requested. Session will shutdown.';
      }
    }));

    pi.registerTool(wrapRuntimeTool({
      name: BuiltInToolName.HARNESS_STATUS,
      description: 'Report the active Orr Else flow and state turn.',
      parameters: Type.Object({}),
      execute: async () => flowStatus(services)
    }));

    if (isWorkerMode()) {
      await initializeWorkerRun(runtimeObservability, services);
      await runParentSequenceActionsBeforeActive(config, ctx, runtimeObservability, services);
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
        services.plugins.quality
      );
      await teammate.start().catch(err => Logger.error(Component.ORR_ELSE, 'Teammate start failed', { err: String(err) }));
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
