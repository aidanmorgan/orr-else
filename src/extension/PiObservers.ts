/**
 * Pi event observer registration functions.
 *
 * Encapsulates registerProviderRequestCap, registerPiToolObservers,
 * recordTurnUsage, and registerAgentLifecycleObservers.
 *
 * Process.env reads are confined to this file only where they are inherently
 * part of the runtime identity (BEAD_ID, STATE_ID, etc. for telemetry).
 * The isWorker flag and buildWorkerEvent callback are provided by extension.ts.
 */

import type {
  AgentEndEvent,
  BeforeProviderRequestEvent,
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
  TurnEndEvent,
  TurnStartEvent
} from '@earendil-works/pi-coding-agent';
import { capAnthropicMaxTokens, resolveMaxOutputTokens, type CappableAnthropicPayload } from '../core/ProviderRequestCap.js';
import { buildTurnUsageRecord } from '../core/TokenUsage.js';
import { Logger } from '../core/Logger.js';
import { type Observability, SpanStatusValue } from '../core/Observability.js';
import type { RuntimeServices } from '../core/RuntimeServices.js';
import type { HarnessConfig } from '../core/ConfigLoader.js';
import type { TeammateEvent } from '../core/TeammateEvents.js';
import {
  DomainEventName,
  Component,
  EnvVars,
  App,
  OtelAttr,
  PiEventName,
  ToolResultStatus,
  TeammateEventType
} from '../constants/index.js';
import {
  isRecord,
  summarizeForEvent,
  stringifySpanAttribute,
  eventToolCallId,
  externalPiToolResultFromEvent
} from './PiEventAdapters.js';
import {
  shellPolicyRejection,
  mcpPolicyRejection,
  shellOperationalMutationPolicyRejection,
  operationalArtifactReadPolicyRejection,
  nativeOperationalMutationPolicyRejection,
  oversizedReadPolicyRejection
} from './NativeToolPolicy.js';
import { handleAgentLifecycleFailure } from './AgentLifecycleController.js';
import type { ActiveRun } from './SessionTypes.js';

// ── context bags passed from extension.ts ────────────────────────────────────

/**
 * Subset of ExtensionSession needed by registerPiToolObservers.
 * Avoids importing the full ExtensionSession type into this module.
 */
export interface PiToolObserverSession {
  piToolObservability: Observability | null;
  observedPiTools: Set<string>;
  blockedObservedPiToolCallIds: Set<string>;
  observedPiToolSpans: Map<string, import('../core/Observability.js').SpanContext>;
  piToolObserverRegistered: boolean;
  activeRun: ActiveRun | null;
}

/**
 * Subset of ExtensionSession needed by registerProviderRequestCap.
 */
export interface ProviderRequestCapSession {
  providerRequestCapRegistered: boolean;
}

/**
 * Subset of ExtensionSession needed by registerAgentLifecycleObservers.
 */
export interface AgentLifecycleObserverSession {
  agentLifecycleObserverRegistered: boolean;
  currentTurnStartMs: number | undefined;
  activeRun: ActiveRun | null;
  agentFailureSignaled: boolean;
}

/**
 * Callbacks injected from extension.ts into PiObservers to keep policy
 * helpers (which reference session state) in extension.ts.
 */
export interface PiToolObserverCallbacks {
  beadIdFromToolParams: (input: Record<string, unknown>) => string | undefined;
  toolSpanAttributes: (toolName: string, params: unknown, beadId: string | undefined, externalPiTool?: boolean) => import('../core/Observability.js').SpanAttributes;
  terminalFailureLimitRejection: (toolName: string) => Promise<string | null>;
  checkToolValidationRules: (toolName: string, config: HarnessConfig, obs: Observability) => Promise<string | null>;
  getObservability: () => Observability;
  isWorkerMode: () => boolean;
  commandInvokesToolName: (command: string, toolName: string, services: RuntimeServices) => boolean;
  commandMatchesPattern: (command: string, pattern: string) => boolean;
}

export interface AgentLifecycleCallbacks {
  isWorkerMode: () => boolean;
  buildWorkerEvent: (type: TeammateEventType, fields: Partial<TeammateEvent> & Record<string, unknown>) => TeammateEvent;
  setAgentFailureSignaled: (v: boolean) => void;
}

// ── observer registration ─────────────────────────────────────────────────────

export function registerProviderRequestCap(pi: ExtensionAPI, session: ProviderRequestCapSession): void {
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

export function registerPiToolObservers(
  pi: ExtensionAPI,
  services: RuntimeServices,
  session: PiToolObserverSession,
  callbacks: PiToolObserverCallbacks
): void {
  if (session.piToolObserverRegistered) return;
  session.piToolObserverRegistered = true;

  pi.on(PiEventName.TOOL_CALL, async (event: ToolCallEvent) => {
    if (!session.observedPiTools.has(event.toolName)) return;
    const runtimeObservability = session.piToolObservability;
    const toolCallId = eventToolCallId(event);
    const fileMutationPolicyResult = await services.fileMutationPolicy.apply(event);
    const input = event.input as Record<string, unknown>;
    const beadId = callbacks.beadIdFromToolParams(input);
    runtimeObservability?.recordToolInvocation(event.toolName);
    const span = runtimeObservability?.startSpan(`tool:${event.toolName}`, callbacks.toolSpanAttributes(event.toolName, input, beadId, true));
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
    const workerMode = callbacks.isWorkerMode();
    const rejection = fileMutationPolicyResult?.rejection
      || await callbacks.terminalFailureLimitRejection(event.toolName)
      || shellPolicyRejection(event, config, services, workerMode, callbacks.commandInvokesToolName, callbacks.commandMatchesPattern)
      || mcpPolicyRejection(event, config, workerMode)
      || shellOperationalMutationPolicyRejection(event, services, workerMode)
      || operationalArtifactReadPolicyRejection(event, workerMode)
      || nativeOperationalMutationPolicyRejection(event, workerMode)
      || oversizedReadPolicyRejection(event, workerMode)
      || await callbacks.checkToolValidationRules(event.toolName, config, runtimeObservability || callbacks.getObservability());
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
    const beadId = callbacks.beadIdFromToolParams(event.input as Record<string, unknown>);
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

export async function recordTurnUsage(event: TurnEndEvent, services: RuntimeServices, session: { currentTurnStartMs: number | undefined }): Promise<void> {
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

export function registerAgentLifecycleObservers(
  pi: ExtensionAPI,
  services: RuntimeServices,
  session: AgentLifecycleObserverSession,
  callbacks: AgentLifecycleCallbacks
): void {
  if (session.agentLifecycleObserverRegistered) return;
  session.agentLifecycleObserverRegistered = true;

  pi.on(PiEventName.TURN_START, async (event: TurnStartEvent) => {
    session.currentTurnStartMs = typeof event.timestamp === 'number' ? event.timestamp : Date.now();
  });

  pi.on(PiEventName.TURN_END, async (event: TurnEndEvent, ctx: ExtensionContext) => {
    await handleAgentLifecycleFailure(event, ctx, PiEventName.TURN_END, services, {
      isWorker: callbacks.isWorkerMode(),
      activeRun: session.activeRun,
      agentFailureSignaled: session.agentFailureSignaled,
      setAgentFailureSignaled: callbacks.setAgentFailureSignaled,
      buildWorkerEvent: callbacks.buildWorkerEvent
    });
    await recordTurnUsage(event, services, session);
  });

  pi.on(PiEventName.AGENT_END, async (event: AgentEndEvent, ctx: ExtensionContext) => {
    await handleAgentLifecycleFailure(event, ctx, PiEventName.AGENT_END, services, {
      isWorker: callbacks.isWorkerMode(),
      activeRun: session.activeRun,
      agentFailureSignaled: session.agentFailureSignaled,
      setAgentFailureSignaled: callbacks.setAgentFailureSignaled,
      buildWorkerEvent: callbacks.buildWorkerEvent
    });
    Logger.info(Component.OBSERVABILITY, 'Session token usage summary', services.telemetryStore.getSummary());
  });
}
