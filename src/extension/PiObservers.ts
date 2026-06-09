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
import { buildTurnUsageRecord, buildPromptCacheObservabilityEvent } from '../core/TokenUsage.js';
import {
  type ProviderBudgetPolicy,
  computeRequestSizing,
  resolveCeiling,
  checkBudgetCeilings,
  buildBudgetRejectionEvent
} from '../core/ProviderBudgetPreflight.js';
import { Logger } from '../core/Logger.js';
import { type Observability, SpanStatusValue } from '../core/Observability.js';
import type { RuntimeServices } from '../core/RuntimeServices.js';
import type { HarnessConfig } from '../core/ConfigLoader.js';
import type { TeammateEvent } from '../core/TeammateEvents.js';
import { App, DomainEventName, TeammateEventType, ToolResultStatus } from '../constants/domain.js';
import { Component, EnvVars, OtelAttr, PiEventName, SpanName } from '../constants/infra.js';
import {
  isRecord,
  summarizeForEvent,
  stringifySpanAttribute,
  eventToolCallId,
  externalPiToolResultFromEvent,
  mapPiToolCallIdToInvocationId
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
import { ToolResultRecorder } from '../core/ToolResultRecorder.js';
import { v7 as uuidv7 } from 'uuid';

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
  /** Maps Pi toolCallId → harness toolInvocationId (generated at TOOL_CALL time). */
  observedPiToolInvocationIds: Map<string, string>;
  piToolObserverRegistered: boolean;
  activeRun: ActiveRun | null;
}

/**
 * Subset of ExtensionSession needed by registerProviderRequestCap.
 *
 * recordedPromptDigestIds is populated by BEFORE_AGENT_START (in extension.ts)
 * before any BEFORE_PROVIDER_REQUEST fires.  The set is cleared at each
 * initializeWorkerRun so it holds exactly the digest IDs seen in the current
 * run.  The hook reads the most-recently-added entry (last in insertion order)
 * as the current stable-block digest ID.
 */
export interface ProviderRequestCapSession {
  providerRequestCapRegistered: boolean;
  /** Stable-block digest IDs recorded in the current worker run (insertion-ordered Set). */
  recordedPromptDigestIds: Set<string>;
  /**
   * Optional provider budget policy (pi-experiment-6q0y.16).
   * When absent or `enabled: false`, the preflight is a no-op and existing
   * behaviour is fully preserved (default-off).
   */
  providerBudgetPolicy?: ProviderBudgetPolicy;
}

// ---------------------------------------------------------------------------
// Provider prompt cache key constants
// ---------------------------------------------------------------------------

/**
 * Prefix for the deterministic prompt cache key injected into OpenAI Responses
 * and OpenAI-Codex provider payloads.  The full key is
 * `${PROVIDER_CACHE_KEY_PREFIX}:<stableBlockDigestId>`.
 */
export const PROVIDER_CACHE_KEY_PREFIX = 'orr-else';

// ---------------------------------------------------------------------------
// Anthropic system cache-block split
// ---------------------------------------------------------------------------

/**
 * The separator that marks the boundary between the stable Orr Else block and
 * the volatile suffix in the fully assembled system prompt.
 *
 * ContextInjector constructs the prompt as:
 *   stableBlock + "\n\n" + [piBase + "\n\n"] + volatileSuffix
 * where volatileSuffix always starts with "### RUN CONTEXT".
 *
 * Splitting at this boundary lets the Anthropic provider cache the stable
 * prefix without the volatile bead ID, worktree path, or checklist.
 */
export const ANTHROPIC_VOLATILE_BOUNDARY = '\n\n### RUN CONTEXT';

// ---------------------------------------------------------------------------
// OpenAI Responses / Codex cache-key injection
// ---------------------------------------------------------------------------

/**
 * Returns true when `payload` is shaped like an OpenAI Responses or
 * OpenAI-Codex request: it is a non-null object that carries an `input` field
 * (the Responses-API messages array) instead of the Anthropic `messages` field,
 * and does NOT carry a numeric `max_tokens` (the Anthropic-specific field that
 * the existing max-token cap already guards).
 *
 * This is the minimal structural discriminator that avoids mutating Anthropic
 * or unknown payloads while targeting both OpenAI provider shapes.
 */
export function isOpenAIResponsesPayload(payload: unknown): payload is Record<string, unknown> {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  // Must have `input` (the Responses-API message list).
  if (!('input' in p)) return false;
  // Must NOT have a numeric `max_tokens` (Anthropic-exclusive field).
  if (typeof p['max_tokens'] === 'number') return false;
  return true;
}

/**
 * Inject `prompt_cache_key` into an OpenAI Responses or Codex payload so the
 * provider uses a deterministic, stable-block-derived cache key instead of a
 * volatile session ID.
 *
 * The injected value is `orr-else:<digestId>`.  When `digestId` is undefined
 * (BEFORE_AGENT_START has not yet fired — should not happen in practice) the
 * payload is left unchanged.
 *
 * @returns The mutated payload, or `undefined` when no mutation was needed.
 */
export function injectOpenAIPromptCacheKey(
  payload: Record<string, unknown>,
  digestId: string | undefined
): Record<string, unknown> | undefined {
  if (!digestId) return undefined;
  const cacheKey = `${PROVIDER_CACHE_KEY_PREFIX}:${digestId}`;
  if (payload['prompt_cache_key'] === cacheKey) return undefined;
  payload['prompt_cache_key'] = cacheKey;
  return payload;
}

/**
 * An Anthropic system text block as it appears in `payload.system`.
 * `cache_control` is present when the provider has already marked the block
 * for caching (e.g. Anthropic's `{ type: 'ephemeral' }`).
 */
interface AnthropicSystemTextBlock {
  type: 'text';
  text: string;
  cache_control?: Record<string, unknown>;
}

/**
 * Narrow `payload` to an Anthropic request whose `system` field is an array
 * containing exactly one text block.  Returns the block, or `null` if the
 * payload does not match that shape.
 *
 * Detection heuristic: Anthropic requests carry a numeric `max_tokens` field;
 * OpenAI Responses/Codex requests carry `input` instead.  This discriminator
 * matches the one used by `capAnthropicMaxTokens` and `isOpenAIResponsesPayload`.
 */
export function extractSingleAnthropicSystemBlock(
  payload: unknown
): AnthropicSystemTextBlock | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (typeof p['max_tokens'] !== 'number') return null;
  const system = p['system'];
  if (!Array.isArray(system) || system.length !== 1) return null;
  const block = system[0] as Record<string, unknown>;
  if (block['type'] !== 'text' || typeof block['text'] !== 'string') return null;
  return block as unknown as AnthropicSystemTextBlock;
}

/**
 * Split the Anthropic system block that contains the Orr Else stable/volatile
 * boundary so only the stable prefix is cache-controlled.
 *
 * Handles both provider shapes:
 *   - API-key shape: system = [{harness systemPrompt, cache_control}]  (length 1)
 *   - OAuth shape:   system = [{Claude Code identity, cache_control}, {harness systemPrompt, cache_control}]  (length 2)
 *
 * The first block whose `text` contains `ANTHROPIC_VOLATILE_BOUNDARY`
 * (`\n\n### RUN CONTEXT`) is split in place into two consecutive blocks:
 *   [i]   `{ type: 'text', text: stableText, cache_control: <original block's> }`
 *   [i+1] `{ type: 'text', text: volatileText }` — no cache_control
 *
 * All other blocks are preserved unchanged (e.g. the Claude Code identity block
 * under OAuth keeps its own cache_control).
 *
 * The original separator (`\n\n`) is consumed; concatenating the two new block
 * texts with that separator reproduces the original block text byte-for-byte:
 *   `blocks[i].text + '\n\n' + blocks[i+1].text === originalText`
 *
 * @returns The mutated payload when a split was applied, or `null` when:
 *   - The payload is not an Anthropic request (no numeric `max_tokens`).
 *   - `system` is not an array or is empty.
 *   - No block's text contains the volatile boundary marker.
 *   - The split point falls at position 0 (no stable content before the boundary).
 */
export function splitAnthropicSystemCacheBlock(
  payload: unknown
): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (typeof p['max_tokens'] !== 'number') return null;
  const system = p['system'];
  if (!Array.isArray(system) || system.length === 0) return null;

  // Find the first block containing the volatile boundary.
  for (let i = 0; i < system.length; i++) {
    const block = system[i] as Record<string, unknown>;
    if (block['type'] !== 'text' || typeof block['text'] !== 'string') continue;
    const text = block['text'] as string;
    const boundaryIdx = text.indexOf(ANTHROPIC_VOLATILE_BOUNDARY);
    // No boundary in this block, or boundary at position 0 (no stable content before it).
    if (boundaryIdx <= 0) continue;

    const stableText = text.slice(0, boundaryIdx);
    // Skip the '\n\n' separator (2 chars) to get the volatile text starting with '### RUN CONTEXT'.
    const volatileText = text.slice(boundaryIdx + 2);
    const cacheControl = block['cache_control'] as Record<string, unknown> | undefined;

    // Replace the boundary block with stable + volatile; preserve all other blocks.
    const newSystem = [
      ...system.slice(0, i),
      { type: 'text', text: stableText, ...(cacheControl ? { cache_control: cacheControl } : {}) },
      { type: 'text', text: volatileText },
      ...system.slice(i + 1)
    ];
    p['system'] = newSystem;
    return p;
  }

  return null;
}

/**
 * Subset of ExtensionSession needed by registerAgentLifecycleObservers.
 */
export interface AgentLifecycleObserverSession {
  agentLifecycleObserverRegistered: boolean;
  currentTurnStartMs: number | undefined;
  activeRun: ActiveRun | null;
  agentFailureSignaled: boolean;
  /**
   * Stable-block digest IDs recorded in the current worker run (insertion-ordered Set).
   * The most-recently-added entry is the current run's active digest.
   * Used by recordTurnUsage to attribute cache-read/write tokens to the prompt digest.
   * pi-experiment-6q0y.9.
   */
  recordedPromptDigestIds: Set<string>;
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
    // ── pi-experiment-6q0y.16: optional budget preflight (default-off) ────────
    // Compute sizing for every request (observability). Only enforce ceilings
    // when the policy is explicitly enabled — existing behaviour is fully
    // preserved when providerBudgetPolicy is absent or enabled: false.
    const budgetPolicy = session.providerBudgetPolicy;
    if (budgetPolicy?.enabled) {
      const digestIds = session.recordedPromptDigestIds;
      const digestId = digestIds.size > 0 ? [...digestIds].at(-1) : undefined;
      const sizing = computeRequestSizing(event.payload, digestId);
      const ceiling = resolveCeiling(budgetPolicy, sizing.provider, sizing.model);
      if (ceiling) {
        const violation = checkBudgetCeilings(sizing, ceiling);
        if (violation) {
          const rejectionEvent = buildBudgetRejectionEvent(sizing, violation);
          if (violation.action === 'block') {
            Logger.warn(Component.ORR_ELSE, 'Provider request budget ceiling exceeded — blocking request', rejectionEvent as unknown as Record<string, unknown>);
            throw new Error(
              `Provider request budget exceeded: ${violation.dimension} ${violation.actual} > ceiling ${violation.ceiling} (provider=${sizing.provider}, model=${sizing.model})`
            );
          } else {
            // warn — log but allow the request to continue
            Logger.warn(Component.ORR_ELSE, 'Provider request budget ceiling exceeded — warning only', rejectionEvent as unknown as Record<string, unknown>);
          }
        }
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    const cap = resolveMaxOutputTokens(process.env[EnvVars.MAX_OUTPUT_TOKENS]);
    const payload = event.payload;
    const originalMaxTokens =
      payload && typeof payload === 'object' ? (payload as { max_tokens?: unknown }).max_tokens : undefined;
    // capAnthropicMaxTokens guards payload shape internally (non-object → null).
    const capped = capAnthropicMaxTokens(payload as CappableAnthropicPayload, cap);
    if (capped) {
      Logger.info(Component.ORR_ELSE, 'Capped Anthropic max_tokens to fit subscription included quota', {
        originalMaxTokens,
        cappedMaxTokens: cap,
        thinkingBudget: capped.thinking?.budget_tokens
      });
      // Also split the system cache block on the same (already mutated) payload.
      splitAnthropicSystemCacheBlock(capped);
      return capped;
    }

    // Split the Anthropic system cache block at the Orr Else stable/volatile boundary.
    // When the payload is Anthropic (has max_tokens) and its system field is a single
    // text block containing the volatile-suffix marker, the block is replaced by two:
    //   [0] stable prefix — carries cache_control (deterministic across bead IDs).
    //   [1] volatile suffix — no cache_control (contains beadId, worktreePath, checklist).
    // This maximises prompt cache hits by keeping the volatile content out of the cached
    // prefix while preserving the original text byte-for-byte across the two blocks.
    const split = splitAnthropicSystemCacheBlock(payload);
    if (split !== null) return split;

    // Inject a deterministic prompt_cache_key into OpenAI Responses / Codex payloads.
    // The key is `orr-else:<stableBlockDigestId>` — stable across any two runs that
    // share the same (project, config, state, model, tools, skills, rules, stable text)
    // but differ in beadId, worktreePath, or date.  This lets the provider reuse its
    // prompt cache across workers without relying on a volatile session ID.
    if (isOpenAIResponsesPayload(payload)) {
      // The most-recently-added entry in insertion-ordered recordedPromptDigestIds is
      // the current run's digest (the set is cleared at initializeWorkerRun and
      // populated by BEFORE_AGENT_START before any provider request fires).
      const digestIds = session.recordedPromptDigestIds;
      const digestId = digestIds.size > 0
        ? [...digestIds].at(-1)
        : undefined;
      return injectOpenAIPromptCacheKey(payload, digestId) ?? undefined;
    }

    return undefined;
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
    // dsm2.12: generate a harness toolInvocationId for this Pi tool call and
    // store it keyed by toolCallId so TOOL_RESULT can retrieve it and populate
    // explicit identity on the result event.
    const piToolInvocationId = uuidv7();
    if (toolCallId) session.observedPiToolInvocationIds.set(toolCallId, piToolInvocationId);
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
    // zog2.16: write durable artifact so verifier gate sees TOOL_REJECTED, not TOOL_NOT_INVOKED
    const policyInvocationId = uuidv7();
    const policyProjectRoot = process.env[EnvVars.PROJECT_ROOT] || services.projectRoot;
    const policyRecorder = new ToolResultRecorder(services.toolCallPathFactory, policyProjectRoot, services.logger);
    const policyHandle = await policyRecorder.recordShortCircuit({
      toolName: event.toolName, invocationId: policyInvocationId,
      beadId, stateId: session.activeRun?.stateId, actionId: session.activeRun?.action?.id,
      status: ToolResultStatus.REJECTED, failureCategory: 'TRANSPORT',
      rejectionReason: rejection,
    }).catch(() => undefined);
    // dsm2.12: wire Pi adapter and populate explicit identity on the rejection event.
    const piRejectionMapping = mapPiToolCallIdToInvocationId(toolCallId, policyInvocationId);
    await services.eventStore.record(DomainEventName.TOOL_INVOCATION_FAILED, {
      beadId,
      tool: event.toolName,
      toolName: event.toolName,
      stateId: session.activeRun?.stateId,
      actionId: session.activeRun?.action?.id,
      externalPiTool: true,
      ...piRejectionMapping,
      result: {
        status: ToolResultStatus.REJECTED,
        isError: true,
        message: rejection
      },
      ...(policyHandle ? { toolResult: policyHandle } : {}),
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
      session.observedPiToolInvocationIds.delete(toolCallId);
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
    // dsm2.12: retrieve the harness toolInvocationId generated at TOOL_CALL time
    // and wire the Pi adapter to produce the canonical toolCallId↔toolInvocationId
    // mapping. This is the live wiring of mapPiToolCallIdToInvocationId.
    const rawInvocationId = toolCallId ? session.observedPiToolInvocationIds.get(toolCallId) : undefined;
    if (toolCallId) session.observedPiToolInvocationIds.delete(toolCallId);
    const toolInvocationId = rawInvocationId ?? uuidv7();
    const piIdMapping = mapPiToolCallIdToInvocationId(toolCallId, toolInvocationId);
    await services.eventStore.record(
      result.isError ? DomainEventName.TOOL_INVOCATION_FAILED : DomainEventName.TOOL_INVOCATION_SUCCEEDED,
      {
        beadId,
        tool: event.toolName,
        toolName: event.toolName,
        stateId: session.activeRun?.stateId,
        actionId: session.activeRun?.action?.id,
        externalPiTool: true,
        ...piIdMapping,
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

export async function recordTurnUsage(event: TurnEndEvent, services: RuntimeServices, session: { currentTurnStartMs: number | undefined; recordedPromptDigestIds: Set<string> }): Promise<void> {
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

  // pi-experiment-6q0y.9: cache-hit observability keyed by prompt digest.
  // Emit only when there are cache-read or cache-write tokens to attribute.
  // The digest is the most-recently-added entry in recordedPromptDigestIds
  // (set cleared at initializeWorkerRun, populated at BEFORE_AGENT_START).
  const cacheObsEvent = buildPromptCacheObservabilityEvent(
    record.event,
    session.recordedPromptDigestIds.size > 0 ? [...session.recordedPromptDigestIds].at(-1) : undefined
  );
  if (cacheObsEvent !== null) {
    await services.eventStore.record(DomainEventName.PROMPT_CACHE_OBSERVABILITY, cacheObsEvent).catch(error => {
      Logger.warn(Component.OBSERVABILITY, 'Failed to record cache observability event', { error: String(error) });
    });
  }

  try {
    services.observability.recordCompletedSpan(SpanName.LLM_TURN, {
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
    }, record.telemetry.startTime, record.telemetry.endTime);
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
