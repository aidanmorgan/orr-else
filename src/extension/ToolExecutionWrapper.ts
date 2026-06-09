/**
 * ToolExecutionWrapper — the wrapPluginTool behavior with injected ports.
 *
 * pi-experiment-amq0.1: extracted from extension.ts.
 *
 * Wraps a plugin tool with:
 *   - programmatic validation rules
 *   - worker-merge guard
 *   - in-session result cache (cacheable tools)
 *   - circuit breaker (consecutive failure limit)
 *   - runtime budget pre-tool-call check (6q0y.48)
 *   - always-on loop detection (6q0y.49)
 *   - terminal failure limit check
 *   - retry pipeline (t6gw)
 *   - raw persistence (s3wp.26/0yt5.27) via RawToolResultStore
 *   - RTK summary / evidence handle assembly (zog2.2)
 *   - yhec _canonicalEvidenceHandle strip from model-facing result
 *   - token accounting (s3wp.16)
 *   - tool-payload budget (6q0y.18)
 *   - observability span recording
 *
 * The behavior is VERBATIM from extension.ts wrapPluginTool — only the dependency
 * access changes from direct globals/closures to injected ports.
 */
import * as path from 'path';
import { v7 as uuidv7 } from 'uuid';
import { Type } from '@earendil-works/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { HarnessConfig } from '../core/ConfigLoader.js';
import type { RuntimeServices } from '../composition/createRuntimeServices.js';
import type { ToolExecutionSession } from './SessionTypes.js';
import { ToolResultRecorder } from '../core/ToolResultRecorder.js';
import { evaluateRetry } from '../core/ToolRetryPipeline.js';
import {
  assembleAndWriteBuiltInHandle,
  buildRejectedBuiltInHandle,
} from '../tools/builtin_handles.js';
import { getBuiltInRtkSummaryFactory } from '../tools/builtin_rtk_registry.js';
import { persistPluginToolRawResult } from './RawToolResultStore.js';
import {
  DomainEventName,
  PluginToolName,
  ToolResultStatus,
  ToolValidationCondition,
  ToolDefaults,
  EnvVars,
  OtelAttr,
} from '../constants/index.js';
import { buildToolTokenAccounting, serializeToolResultText } from '../core/TokenUsage.js';
import { evaluateToolPayloadBudget } from '../core/ToolPayloadBudget.js';
import type { Observability, SpanAttributes, SpanCompletion } from '../core/Observability.js';
import { SpanStatusValue } from '../core/Observability.js';
import { isRecord, summarizeForEvent, stringifySpanAttribute, resultIndicatesFailure, resultIndicatesSuccess } from './PiEventAdapters.js';
import { terminalFailureLimitDataFromResult, terminalFailureLimitRejection } from './WorkerRunController.js';
import { postWorkerSignal } from './SignalController.js';
import { teammateEventTypeForOutcome } from './CoordinatorController.js';
import type { ToolResultBase } from '../contract.js';
import type { TeammateEvent, TeammateEventType } from '../core/TeammateEvents.js';

// ────────────────────────────────────────────────────────────────────────────
// Injected ports
// ────────────────────────────────────────────────────────────────────────────

/**
 * Injected ports for ToolExecutionWrapper.
 *
 * These are the external IO/infrastructure dependencies the wrapper needs.
 * Session state (toolBreakerFailures, toolResultCache, etc.) is still passed
 * through the session parameter of wrap() since it's mutable runtime state,
 * not an infrastructure port.
 */
export interface ToolExecutionWrapperPorts {
  /** Access to the event store for recording tool events. */
  eventStore: RuntimeServices['eventStore'];
  /** Tool call path factory for raw-result persistence. */
  toolCallPathFactory: RuntimeServices['toolCallPathFactory'];
  /** Config loader to resolve tool guards, retry policy, etc. */
  configLoader: RuntimeServices['configLoader'];
  /** Signal services (for postWorkerSignal). */
  services: RuntimeServices;
  /** Whether the current process is a worker process. */
  isWorkerMode: () => boolean;
  /** Resolve the active project root (env-first). */
  projectRoot: string;
  /** Set of tool names that are allowed even in terminal-failure-limit mode. */
  terminalFailureAllowedTools: Set<string>;
  /**
   * Build a TeammateEvent for posting a worker signal.
   * Injected so ToolExecutionWrapper avoids reading process.env directly.
   */
  buildWorkerEvent: (type: TeammateEventType, fields: Record<string, unknown>) => TeammateEvent;
}

// ────────────────────────────────────────────────────────────────────────────
// Private helpers (all verbatim from extension.ts)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Serialize a tool result value and wrap it in the Pi-expected format.
 *
 * Uses serializeToolResultText() — the single canonical serializer shared with
 * byte accounting — so content[0].text always matches the metered bytes exactly
 * (pi-experiment-6q0y.18 AC1: no drift between accounting and payload).
 */
function toolResult(value: unknown) {
  const text = serializeToolResultText(value);
  return {
    content: [{ type: 'text' as const, text }],
    details: value
  };
}

function spanCompletionForToolResult(result: unknown): SpanCompletion {
  if (!resultIndicatesFailure(result)) return { status: SpanStatusValue.OK };
  return {
    status: SpanStatusValue.ERROR,
    message: stringifySpanAttribute(summarizeForEvent(result))
  };
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

function lookupRetryPolicy(
  toolName: string,
  config: HarnessConfig
): import('../core/domain/StateModels.js').ToolRetryPolicy | undefined {
  const toolConfig = config.tools?.find(t => t.name === toolName);
  return (toolConfig as { retryPolicy?: import('../core/domain/StateModels.js').ToolRetryPolicy } | undefined)?.retryPolicy;
}

function lookupIdempotencyClass(
  toolName: string,
  config: HarnessConfig
): 'idempotent' | 'non_idempotent' | 'at_least_once' | undefined {
  // Project-configured tools: sideEffectContract.idempotencyClass wins.
  const toolConfig = config.tools?.find(t => t.name === toolName);
  if (toolConfig) {
    const contract = (toolConfig as { sideEffectContract?: { idempotencyClass?: 'idempotent' | 'non_idempotent' | 'at_least_once' } }).sideEffectContract;
    if (contract?.idempotencyClass) return contract.idempotencyClass;
  }
  return undefined;
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

/**
 * Evaluate the optional tool-payload budget and build the model-facing result.
 *
 * When no budget is configured, behaves identically to toolResult(value) (AC2 no-op).
 * When a budget IS configured and the payload exceeds the limit, emits a
 * TOOL_PAYLOAD_BUDGET_REJECTED event and returns a semantic rejection message
 * instead of the raw payload (AC5). The rejection message includes the artifact
 * path (outputFile) when available so the coordinator gate can still reach the
 * artifact without the model receiving the raw body (AC6).
 *
 * The exact byte count from evaluateToolPayloadBudget() equals the byte length
 * of content[0].text because both use serializeToolResultText() (AC1).
 */
async function applyToolPayloadBudget(
  toolName: string,
  value: unknown,
  config: HarnessConfig,
  context: {
    beadId: string | undefined;
    stateId: string | undefined;
    actionId: string | undefined;
    toolInvocationId: string;
    outputFile?: string;
  },
  eventStore: RuntimeServices['eventStore']
): Promise<ReturnType<typeof toolResult>> {
  const budget = evaluateToolPayloadBudget(toolName, value, config);

  if (!budget.exceeded) {
    // No-op: return the normal result using the pre-computed serialized text.
    return {
      content: [{ type: 'text' as const, text: budget.serializedText }],
      details: value
    };
  }

  // Budget exceeded — emit rejection event (no raw body, AC6) and return semantic rejection.
  await eventStore.record(DomainEventName.TOOL_PAYLOAD_BUDGET_REJECTED, {
    tool: toolName,
    beadId: context.beadId,
    stateId: context.stateId,
    actionId: context.actionId,
    toolInvocationId: context.toolInvocationId,
    actualBytes: budget.actualBytes,
    limitBytes: budget.resolvedPolicy!.maxBytes,
    outputFile: context.outputFile,
    decision: 'REJECTED',
    route: budget.route,
  }).catch(() => {});

  // Return semantic rejection: route + byte info + artifact ref when available (AC5).
  const artifactRef = context.outputFile ? ` Artifact: ${context.outputFile}.` : '';
  const rejection = `TOOL_PAYLOAD_BUDGET_EXCEEDED: \`${toolName}\` result is ${budget.actualBytes} bytes, exceeding the configured limit of ${budget.resolvedPolicy!.maxBytes} bytes. The model-facing payload has been suppressed.${artifactRef} Route: ${budget.route}.`;
  return toolResult(rejection);
}

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

/**
 * Wrap a plugin tool with the full harness execution pipeline.
 *
 * This is the ToolExecutionWrapper's single public method.
 * The behavior is VERBATIM from extension.ts wrapPluginTool; only the
 * external IO deps come from the injected ports.
 *
 * @param tool - The plugin tool to wrap.
 * @param runtimeObservability - Observability instance for span recording.
 * @param ports - Injected IO/infrastructure ports.
 * @param session - Per-invocation session state (mutable runtime state).
 * @param beadIdFromParams - Resolve beadId from tool params (passed in so
 *   the wrapper doesn't duplicate the resolution logic that PiObservers also uses).
 * @param toolSpanAttrs - Build span attributes for a tool call.
 */
export function wrapPluginTool(
  tool: { name: string, description: string, parameters: unknown, execute(params: unknown, ctx?: unknown, signal?: AbortSignal): unknown | Promise<unknown> },
  runtimeObservability: Observability,
  ports: ToolExecutionWrapperPorts,
  session: ToolExecutionSession,
  beadIdFromParams: (params: Record<string, unknown> | undefined) => string | undefined,
  toolSpanAttrs: (toolName: string, params: unknown, beadId: string | undefined, externalPiTool?: boolean, toolInvocationId?: string) => SpanAttributes
) {
  const { services, isWorkerMode, terminalFailureAllowedTools } = ports;
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.parameters || Type.Object({}),
    execute: async (_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: any, ctx: ExtensionContext) => {
      // zog2.16: generate toolInvocationId and resolve context vars at invocation
      // start so ALL exit paths (early short-circuits included) can record durable
      // evidence artifacts via the ToolResultRecorder.
      // pi-experiment-t6gw: let (not const) so retry attempts can generate a new invocationId.
      let toolInvocationId = uuidv7();
      const projectRoot = process.env[EnvVars.PROJECT_ROOT] || ports.projectRoot;
      const stateIdForPersist = process.env[EnvVars.STATE_ID] || session.activeRun?.stateId;
      const actionIdForPersist = process.env[EnvVars.ACTION_ID] || session.activeRun?.action?.id;
      const toolResultRecorder = new ToolResultRecorder(services.toolCallPathFactory, projectRoot);

      // 1. Programmatic Behavioral Rules (Pre-conditions)
      const config = await services.configLoader.load();
      const ruleError = await checkToolValidationRules(tool.name, config, runtimeObservability);
      if (ruleError) {
        const beadIdEarly = beadIdFromParams(params);
        // zog2.16: persist durable evidence so verifier gate sees INVOKED-BUT-REJECTED
        const validationHandle = await toolResultRecorder.recordShortCircuit({
          toolName: tool.name, invocationId: toolInvocationId,
          beadId: beadIdEarly, stateId: stateIdForPersist, actionId: actionIdForPersist,
          status: ToolResultStatus.REJECTED, failureCategory: 'INPUT',
          rejectionReason: ruleError,
        });
        runtimeObservability.recordToolInvocation(tool.name, { status: ToolResultStatus.REJECTED, isError: true, message: ruleError });
        await services.eventStore.record(DomainEventName.TOOL_INVOCATION_FAILED, {
          beadId: beadIdEarly, tool: tool.name, toolName: tool.name, toolInvocationId,
          stateId: stateIdForPersist, actionId: actionIdForPersist,
          result: { status: ToolResultStatus.REJECTED, isError: true, message: ruleError, reason: 'validation-reject' },
          toolResult: validationHandle,
        }).catch(() => {});
        if (ctx.hasUI) ctx.ui.notify(ruleError, 'error');
        return toolResult(ruleError);
      }

      // Framework-level safety: teammates cannot merge
      if (tool.name === PluginToolName.MERGE_AND_COMMIT && isWorkerMode()) {
        const error = `PROTOCOL VIOLATION: \`${PluginToolName.MERGE_AND_COMMIT}\` is team-leader/harness-only and cannot be called by a teammate.`;
        const beadIdEarly = beadIdFromParams(params);
        // zog2.16: persist durable evidence so verifier gate sees INVOKED-BUT-REJECTED
        const mergeGuardHandle = await toolResultRecorder.recordShortCircuit({
          toolName: tool.name, invocationId: toolInvocationId,
          beadId: beadIdEarly, stateId: stateIdForPersist, actionId: actionIdForPersist,
          status: ToolResultStatus.REJECTED, failureCategory: 'INFRA',
          rejectionReason: error,
        });
        runtimeObservability.recordToolInvocation(tool.name, { status: ToolResultStatus.REJECTED, isError: true, message: error });
        await services.eventStore.record(DomainEventName.TOOL_INVOCATION_FAILED, {
          beadId: beadIdEarly, tool: tool.name, toolName: tool.name, toolInvocationId,
          stateId: stateIdForPersist, actionId: actionIdForPersist,
          result: { status: ToolResultStatus.REJECTED, isError: true, message: error, reason: 'worker-merge-guard' },
          toolResult: mergeGuardHandle,
        }).catch(() => {});
        if (ctx.hasUI) ctx.ui.notify(error, 'error');
        return toolResult(error);
      }

      const beadId = beadIdFromParams(params);
      const { timeoutMs, maxFailures, cacheable } = lookupToolGuards(tool.name, config);
      const breakerEnabled = isWorkerMode();
      const key = breakerKey(beadId, tool.name);
      const cacheKey = toolCacheKey(tool.name, params);
      // dl9r: toolInvocationId already generated above (moved to top for zog2.16 short-circuit coverage).

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
            toolName: tool.name,
            toolInvocationId,
            stateId: stateIdForPersist,
            actionId: actionIdForPersist,
            result: summarizeForEvent(hit.result),
            toolResult: hit.toolResult,
            cached: true,
            cacheAgeMs: ageMs
          }).catch(() => {});
          // s3wp.16: record token accounting for cached result — fire-and-forget, never blocks.
          void services.eventStore.record(DomainEventName.TOKEN_USAGE_RECORDED, buildToolTokenAccounting(
            tool.name, beadId,
            process.env[EnvVars.STATE_ID] || session.activeRun?.stateId,
            process.env[EnvVars.ACTION_ID] || session.activeRun?.action?.id,
            hit.result, true, toolInvocationId
          )).catch(() => {});
          // pi-experiment-6q0y.18: enforce optional payload budget on cache-hit path (AC3).
          return applyToolPayloadBudget(
            tool.name, hit.result, config,
            { beadId, stateId: stateIdForPersist, actionId: actionIdForPersist,
              toolInvocationId, outputFile: hit.toolResult.outputFile },
            services.eventStore
          );
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
          // zog2.16: write durable artifact so verifier gate sees TOOL_REJECTED, not TOOL_NOT_INVOKED
          const circuitHandle = await toolResultRecorder.recordShortCircuit({
            toolName: tool.name, invocationId: toolInvocationId,
            beadId, stateId: stateIdForPersist, actionId: actionIdForPersist,
            status: ToolResultStatus.REJECTED, failureCategory: 'INFRA',
            rejectionReason: message,
          });
          await services.eventStore.record(DomainEventName.TOOL_INVOCATION_FAILED, {
            beadId,
            tool: tool.name,
            toolName: tool.name,
            toolInvocationId,
            stateId: stateIdForPersist,
            actionId: actionIdForPersist,
            result: { status: ToolResultStatus.REJECTED, isError: true, message, reason: 'circuit-open' },
            toolResult: circuitHandle,
          }).catch(() => {});
          if (ctx.hasUI) ctx.ui.notify(message, 'error');
          return toolResult(message);
        }
      }

      // pi-experiment-6q0y.48: check tool-failure budget BEFORE the tool runs.
      // This is the pre-spend hook for accumulated tool failures: if the bead has
      // already reached the configured maxToolFailures, block before the next attempt.
      {
        const preToolBudgetCheck = session.runtimeBudgetTracker?.checkPreToolResult({ toolFailures: true });
        if (preToolBudgetCheck?.exceeded) {
          await session.runtimeBudgetTracker!.emitExceededEvent(preToolBudgetCheck, services.eventStore);
          const activeRun = session.activeRun;
          if (activeRun && preToolBudgetCheck.route) {
            const summary = `Runtime budget exceeded (${preToolBudgetCheck.dimension}: ${preToolBudgetCheck.currentValue} >= ${preToolBudgetCheck.limit}). Route: ${preToolBudgetCheck.route}`;
            const routeEvent = ports.buildWorkerEvent(teammateEventTypeForOutcome(preToolBudgetCheck.route, config), {
              beadId: activeRun.beadId, stateId: activeRun.stateId, actionId: activeRun.action.id,
              transitionEvent: preToolBudgetCheck.route, summary, evidence: summary, handover: summary,
            });
            await postWorkerSignal(services, routeEvent).catch(() => {});
          }
          return toolResult(`RUNTIME_BUDGET_EXCEEDED: ${preToolBudgetCheck.dimension} limit (${preToolBudgetCheck.limit}) reached. Route: ${preToolBudgetCheck.route}`);
        }
      }

      await services.eventStore.record(DomainEventName.TOOL_INVOCATION_STARTED, {
        beadId,
        tool: tool.name,
        toolInvocationId,
        params: summarizeForEvent(params)
      });

      // pi-experiment-6q0y.49: always-on loop detection for tool calls (AC2/AC3).
      // Fires BEFORE the tool executes — stops repeated spend at the point of call.
      // Checks both identical (exact args) and semantic (structural args) fingerprints.
      {
        const loopDetector = session.loopDetector;
        if (loopDetector) {
          const loopCtx = { beadId, stateId: stateIdForPersist, actionId: actionIdForPersist };
          const loopArgs = { toolName: tool.name, args: params, ...loopCtx };

          // Check identical fingerprint (AC3 class 1)
          const identicalCheck = loopDetector.checkToolCall(loopArgs);
          if (identicalCheck.exceeded) {
            // AC5: emit route exactly once per fingerprint (routed-once guard).
            const firstRoute = await loopDetector.emitLoopDetected(identicalCheck, loopCtx);
            if (firstRoute) {
              const activeRun = session.activeRun;
              if (activeRun && identicalCheck.routeEvent) {
                const summary = `Loop detected (${identicalCheck.scope}): repeated identical tool call "${tool.name}" (${identicalCheck.count}/${identicalCheck.max}). Route: ${identicalCheck.routeEvent}`;
                const loopRouteEvent = ports.buildWorkerEvent(teammateEventTypeForOutcome(identicalCheck.routeEvent, config), {
                  beadId: activeRun.beadId, stateId: activeRun.stateId, actionId: activeRun.action.id,
                  transitionEvent: identicalCheck.routeEvent, summary, evidence: summary, handover: summary,
                });
                await postWorkerSignal(services, loopRouteEvent).catch(() => {});
              }
            }
            // Still BLOCK the repeated call to the model (return LOOP_DETECTED) even after first route.
            return toolResult(`LOOP_DETECTED: repeated identical tool call "${tool.name}" (${identicalCheck.count}/${identicalCheck.max}). Route: ${identicalCheck.routeEvent}`);
          } else if (identicalCheck.fingerprint && !identicalCheck.warningEmitted && identicalCheck.count !== undefined && identicalCheck.max !== undefined && identicalCheck.count >= identicalCheck.max - 1 && identicalCheck.max > 1) {
            await loopDetector.emitWarning(identicalCheck, loopCtx);
          }

          // Check semantic fingerprint (AC3 class 2)
          const semanticCheck = loopDetector.checkToolCallSemantic(loopArgs);
          if (semanticCheck.exceeded) {
            // AC5: emit route exactly once per fingerprint (routed-once guard).
            const firstRoute = await loopDetector.emitLoopDetected(semanticCheck, loopCtx);
            if (firstRoute) {
              const activeRun = session.activeRun;
              if (activeRun && semanticCheck.routeEvent) {
                const summary = `Loop detected (${semanticCheck.scope}): repeated semantically-equivalent tool call "${tool.name}" (${semanticCheck.count}/${semanticCheck.max}). Route: ${semanticCheck.routeEvent}`;
                const loopRouteEvent = ports.buildWorkerEvent(teammateEventTypeForOutcome(semanticCheck.routeEvent, config), {
                  beadId: activeRun.beadId, stateId: activeRun.stateId, actionId: activeRun.action.id,
                  transitionEvent: semanticCheck.routeEvent, summary, evidence: summary, handover: summary,
                });
                await postWorkerSignal(services, loopRouteEvent).catch(() => {});
              }
            }
            // Still BLOCK the repeated call to the model (return LOOP_DETECTED) even after first route.
            return toolResult(`LOOP_DETECTED: repeated semantically-equivalent tool call "${tool.name}" (${semanticCheck.count}/${semanticCheck.max}). Route: ${semanticCheck.routeEvent}`);
          } else if (semanticCheck.fingerprint && !semanticCheck.warningEmitted && semanticCheck.count !== undefined && semanticCheck.max !== undefined && semanticCheck.count >= semanticCheck.max - 1 && semanticCheck.max > 1) {
            await loopDetector.emitWarning(semanticCheck, loopCtx);
          }
        }
      }

      const terminalRejection = await terminalFailureLimitRejection(tool.name, services, session, isWorkerMode(), terminalFailureAllowedTools);
      if (terminalRejection) {
        runtimeObservability.recordToolInvocation(tool.name, {
          status: ToolResultStatus.REJECTED,
          isError: true,
          message: terminalRejection
        });
        // zog2.16: write durable artifact so verifier gate sees TOOL_REJECTED, not TOOL_NOT_INVOKED
        const terminalHandle = await toolResultRecorder.recordShortCircuit({
          toolName: tool.name, invocationId: toolInvocationId,
          beadId, stateId: stateIdForPersist, actionId: actionIdForPersist,
          status: ToolResultStatus.REJECTED, failureCategory: 'INFRA',
          rejectionReason: terminalRejection,
        });
        await services.eventStore.record(DomainEventName.TOOL_INVOCATION_FAILED, {
          beadId,
          tool: tool.name,
          toolName: tool.name,
          toolInvocationId,
          stateId: stateIdForPersist,
          actionId: actionIdForPersist,
          result: {
            status: ToolResultStatus.REJECTED,
            isError: true,
            message: terminalRejection
          },
          toolResult: terminalHandle,
        });
        if (ctx.hasUI) ctx.ui.notify(terminalRejection, 'error');
        return toolResult(terminalRejection);
      }

      // zog2.16: projectRoot, stateIdForPersist, actionIdForPersist are declared
      // at the top of the execute closure (moved up to serve short-circuit exits).

      // pi-experiment-t6gw: retry pipeline — wrap execution in a loop.
      // Default: zero retries (no retryPolicy). Non-idempotent tools: SUPPRESS (body ran once).
      // idempotencyClass check is load-bearing: evaluateRetry returns REJECT_NO_IDEMPOTENCY_CLASS
      // when absent for a retry attempt, and SUPPRESS for non_idempotent tools.
      const retryPolicy = lookupRetryPolicy(tool.name, config);
      const idempotencyClass = lookupIdempotencyClass(tool.name, config);
      let attempt = 1;
      // pi-experiment-6q0y.18: capture the last persisted outputFile so the
      // payload-budget rejection event can reference the semantic artifact (AC6).
      // Reset each iteration of the retry loop alongside currentInvocationId.
      let capturedOutputFile: string | undefined;

      // eslint-disable-next-line no-constant-condition
      while (true) {
        // Rebuild tracedExecute each attempt so span attributes and all closures
        // capture the current toolInvocationId (pi-experiment-t6gw retry loop).
        capturedOutputFile = undefined;
        const currentInvocationId = toolInvocationId;
        const tracedExecute = runtimeObservability.tracedAsync(
          `tool:${tool.name}`,
          toolSpanAttrs(tool.name, params, beadId, false, currentInvocationId),
          async (p: any, c: ExtensionContext) => {
            if (c.hasUI) c.ui.setWorkingMessage(`Executing ${tool.name}...`);
            const result = await runWithWrapperTimeout(tool.name, timeoutMs, () => Promise.resolve(tool.execute(p || {}, c, _signal)));
            if (c.hasUI) c.ui.setWorkingMessage(undefined);

            // Record invocation and result for audit
            runtimeObservability.recordToolInvocation(tool.name, result);
            const terminalFailureLimitData = terminalFailureLimitDataFromResult(result);
            const run = session.activeRun;
            if (terminalFailureLimitData && run !== null && run.beadId === beadId) {
              run.terminalFailureLimitResult = terminalFailureLimitData;
              run.terminalFailureLimitScanned = true;
            }

            const failed = resultIndicatesFailure(result);
            // 0yt5.27: persist the raw result to the single PROJECT-scoped tool-output
            // location and record the typed ToolResultBase (tool/status/outputFile/
            // outputFileBytes) ON the tool-result event — like command/MCP. status here
            // means "did the tool RUN to completion". A returned failure result still
            // RAN (status PASSED); only a thrown exception (catch block below) is a
            // REJECTED run. The semantic verdict is the verifier's job, not this field.
            const toolResultHandle = await persistPluginToolRawResult(
              { toolCallPathFactory: services.toolCallPathFactory },
              tool.name, beadId, stateIdForPersist, actionIdForPersist, projectRoot, result,
              ToolResultStatus.PASSED, undefined, currentInvocationId
            );
            // pi-experiment-6q0y.18: capture for payload-budget rejection event (AC6).
            capturedOutputFile = toolResultHandle.outputFile;

            // zog2.2 (producer-side): look up this tool's RTK summary factory in the
            // registry. If registered, call the factory with the result + params to get
            // the tool-local summary, assemble the canonical ToolEvidenceHandle, write
            // the semantic artifact to disk, and attach the handle to the event-store
            // record. The model-facing result is never modified — the handle is coordinator/
            // event-store only (AC: MODEL-FACING responses contain NO raw artifact paths
            // or the full canonical handle).
            //
            // runStatus correctness (AC5 / zog2.2): two distinct paths:
            //   SUCCEEDED — assembleAndWriteBuiltInHandle with runStatus='PASSED' (tool ran, result is good).
            //   FAILED    — buildRejectedBuiltInHandle with runStatus='REJECTED' (tool ran but returned
            //               failure; replay/verifier must see REJECTED, not a PASSED summary handle).
            let succeededEvidenceHandle: import('../core/ToolEvidenceHandle.js').ToolEvidenceHandle | undefined;
            let failedEvidenceHandle: import('../core/ToolEvidenceHandle.js').ToolEvidenceHandle | undefined;
            // yhec: for command tools that emit a canonical evidenceHandle in their
            // stdout JSON, projectTools.ts attaches _canonicalEvidenceHandle to the
            // result. Thread it into the TOOL_INVOCATION_SUCCEEDED event so the gate
            // can find it regardless of which event is "latest".
            if (!failed && isRecord(result) && isRecord(result['_canonicalEvidenceHandle'])) {
              succeededEvidenceHandle = result['_canonicalEvidenceHandle'] as import('../core/ToolEvidenceHandle.js').ToolEvidenceHandle;
            }
            // yhec zog2.2: strip _canonicalEvidenceHandle from the model-facing result
            // AFTER extracting it into succeededEvidenceHandle above. The handle is
            // recorded coordinator-side on the TOOL_INVOCATION_SUCCEEDED event; it must
            // NOT appear in the model-facing response (content/details/serialized text),
            // which would expose absolute semanticArtifactPath, toolOutputRoot,
            // semanticArtifactSha256, and admittedHarnessFingerprint to the model.
            const resultForModel = (isRecord(result) && '_canonicalEvidenceHandle' in result)
              ? (() => { const { _canonicalEvidenceHandle: _s, ...rest } = result as Record<string, unknown>; return rest; })() as typeof result
              : result;
            const rtkFactory = getBuiltInRtkSummaryFactory(tool.name);
            if (rtkFactory && !succeededEvidenceHandle) {
              try {
                const outputDir = toolResultHandle.outputFile
                  ? path.dirname(toolResultHandle.outputFile)
                  : undefined;
                if (!failed && outputDir) {
                  // SUCCEEDED path: assemble a full PASSED handle with the RTK summary.
                  const rtkSummary = rtkFactory(result, params);
                  succeededEvidenceHandle = assembleAndWriteBuiltInHandle({
                    toolName: tool.name,
                    invocationId: currentInvocationId,
                    outputDir,
                    rtkSummary,
                  });
                } else if (failed) {
                  // FAILED path: the tool ran but returned failure — record a REJECTED handle
                  // so replay/verifiers see the correct runStatus, not a misleading PASSED summary.
                  failedEvidenceHandle = buildRejectedBuiltInHandle({
                    toolName: tool.name,
                    invocationId: currentInvocationId,
                    noSummaryReason: 'tool ran to completion but returned a failure result',
                  });
                }
              } catch {
                // RTK handle build failure is swallowed — the tool result is never blocked.
              }
            }

            if (failed) {
              if (breakerEnabled) {
                session.toolBreakerFailures.set(key, (session.toolBreakerFailures.get(key) ?? 0) + 1);
              }
              await services.eventStore.record(DomainEventName.TOOL_INVOCATION_FAILED, {
                beadId,
                tool: tool.name,
                toolName: tool.name,
                toolInvocationId: currentInvocationId,
                stateId: stateIdForPersist,
                actionId: actionIdForPersist,
                result: summarizeForEvent(result),
                toolResult: toolResultHandle,
                ...(failedEvidenceHandle ? { evidenceHandle: failedEvidenceHandle } : {}),
              });
              if (typeof result === 'string') {
                if (c.hasUI) c.ui.notify(result, 'error');
              } else if (isRecord(result)) {
                if (c.hasUI) c.ui.notify(result.error || `Tool ${tool.name} failed`, 'error');
              }
            } else {
              if (breakerEnabled) session.toolBreakerFailures.delete(key);
              if (cacheable && isWorkerMode()) {
                session.toolResultCache.set(cacheKey, { result: resultForModel, recordedAt: Date.now(), toolResult: toolResultHandle });
              }
              await services.eventStore.record(DomainEventName.TOOL_INVOCATION_SUCCEEDED, {
                beadId,
                tool: tool.name,
                toolName: tool.name,
                toolInvocationId: currentInvocationId,
                stateId: stateIdForPersist,
                actionId: actionIdForPersist,
                result: summarizeForEvent(result),
                toolResult: toolResultHandle,
                ...(succeededEvidenceHandle ? { evidenceHandle: succeededEvidenceHandle } : {}),
              });
            }
            return resultForModel;
          },
          spanCompletionForToolResult
        );

        try {
          const result = await tracedExecute(params, ctx);
          // 0yt5.27: raw persistence + typed ToolResultBase event already happened
          // inside tracedExecute (success branch). No second persist here — the
          // single PROJECT-scoped tool-output archive is written exactly once.
          // s3wp.16: record per-tool model-facing token estimate as telemetry — fire-and-forget.
          // Does NOT mutate `result`; accounting is harness-side only.
          void services.eventStore.record(DomainEventName.TOKEN_USAGE_RECORDED, buildToolTokenAccounting(
            tool.name, beadId, stateIdForPersist, actionIdForPersist, result, false, currentInvocationId
          )).catch(() => {});

          if (resultIndicatesFailure(result)) {
            // pi-experiment-6q0y.48: accumulate tool failure count for runtime budget.
            // The PRE-TOOL check (above) fires on the NEXT invocation after this failure.
            session.runtimeBudgetTracker?.recordToolFailure();

            // Tool ran but returned a failure — consult the retry pipeline only
            // when a retryPolicy is configured. No policy → plain failure return
            // with no TOOL_RETRY_DECISION event (no-op-when-unconfigured intent).
            if (retryPolicy) {
              // pi-experiment-6q0y.48: check retry budget BEFORE admitting the retry.
              const retryBudgetCheck = session.runtimeBudgetTracker?.checkPreRetry();
              if (retryBudgetCheck?.exceeded) {
                await session.runtimeBudgetTracker!.emitExceededEvent(retryBudgetCheck, services.eventStore);
                const activeRun = session.activeRun;
                if (activeRun && retryBudgetCheck.route) {
                  const summary = `Runtime budget exceeded (${retryBudgetCheck.dimension}: ${retryBudgetCheck.currentValue} >= ${retryBudgetCheck.limit}). Route: ${retryBudgetCheck.route}`;
                  const routeEvent = ports.buildWorkerEvent(teammateEventTypeForOutcome(retryBudgetCheck.route, config), {
                    beadId: activeRun.beadId, stateId: activeRun.stateId, actionId: activeRun.action.id,
                    transitionEvent: retryBudgetCheck.route, summary, evidence: summary, handover: summary,
                  });
                  await postWorkerSignal(services, routeEvent).catch(() => {});
                }
                return toolResult(`RUNTIME_BUDGET_EXCEEDED: ${retryBudgetCheck.dimension} limit (${retryBudgetCheck.limit}) reached. Route: ${retryBudgetCheck.route}`);
              }
              // Admit retry: record the retry attempt in the tracker.
              session.runtimeBudgetTracker?.recordRetry();
              const retryDecision = await evaluateRetry({
                tool: tool.name,
                invocationId: currentInvocationId,
                attempt,
                failureCategory: 'INFRA',
                retryPolicy,
                idempotencyClass
              }, services.eventStore);
              if (retryDecision.nextRoute === 'retry') {
                attempt++;
                // Generate a new invocationId for the retry attempt.
                toolInvocationId = uuidv7();
                continue;
              }
            }
          }

          // pi-experiment-6q0y.18: enforce optional tool-payload budget BEFORE
          // the result reaches the model. No-op when no budget is configured (AC2).
          // pi-experiment-6q0y.48: also check runtime tool-payload-bytes budget.
          if (session.runtimeBudgetTracker && !resultIndicatesFailure(result)) {
            const serializedText = serializeToolResultText(result);
            const payloadBytes = Buffer.byteLength(serializedText, 'utf8');
            const payloadBudgetCheck = session.runtimeBudgetTracker.checkPreToolResult({ payloadBytes });
            if (payloadBudgetCheck.exceeded) {
              await session.runtimeBudgetTracker.emitExceededEvent(payloadBudgetCheck, services.eventStore);
              const activeRun = session.activeRun;
              if (activeRun && payloadBudgetCheck.route) {
                const summary = `Runtime budget exceeded (${payloadBudgetCheck.dimension}: ${payloadBudgetCheck.currentValue} >= ${payloadBudgetCheck.limit}). Route: ${payloadBudgetCheck.route}`;
                const routeEvent = ports.buildWorkerEvent(teammateEventTypeForOutcome(payloadBudgetCheck.route, config), {
                  beadId: activeRun.beadId, stateId: activeRun.stateId, actionId: activeRun.action.id,
                  transitionEvent: payloadBudgetCheck.route, summary, evidence: summary, handover: summary,
                });
                await postWorkerSignal(services, routeEvent).catch(() => {});
              }
              return toolResult(`RUNTIME_BUDGET_EXCEEDED: ${payloadBudgetCheck.dimension} limit (${payloadBudgetCheck.limit}) reached. Route: ${payloadBudgetCheck.route}`);
            }
            // Accumulate payload bytes now that we've cleared the check.
            session.runtimeBudgetTracker.recordToolPayloadBytes(payloadBytes);
          }

          return applyToolPayloadBudget(
            tool.name, result, config,
            { beadId, stateId: stateIdForPersist, actionId: actionIdForPersist,
              toolInvocationId: currentInvocationId, outputFile: capturedOutputFile },
            services.eventStore
          );
        } catch (error) {
          if (breakerEnabled) {
            session.toolBreakerFailures.set(key, (session.toolBreakerFailures.get(key) ?? 0) + 1);
          }
          // 0yt5.27: a thrown exception is a tool that could NOT run to completion —
          // persist the error envelope to the single PROJECT-scoped location and
          // record the typed ToolResultBase with status:REJECTED + failureCategory:INFRA.
          const errorHandle = await persistPluginToolRawResult(
            { toolCallPathFactory: services.toolCallPathFactory },
            tool.name, beadId, stateIdForPersist, actionIdForPersist, projectRoot,
            {
              error: String(error),
              errorType: error instanceof Error ? error.constructor.name : typeof error,
              tool: tool.name
            },
            ToolResultStatus.REJECTED,
            'INFRA',
            currentInvocationId
          );
          await services.eventStore.record(DomainEventName.TOOL_INVOCATION_FAILED, {
            beadId,
            tool: tool.name,
            toolName: tool.name,
            toolInvocationId: currentInvocationId,
            stateId: stateIdForPersist,
            actionId: actionIdForPersist,
            error: String(error),
            toolResult: errorHandle
          }).catch(() => {});

          // pi-experiment-6q0y.48: accumulate tool failure count (exception path).
          // The PRE-TOOL check fires on the NEXT invocation.
          session.runtimeBudgetTracker?.recordToolFailure();

          // Consult the retry pipeline for thrown exceptions only when a
          // retryPolicy is configured. No policy → plain error return with
          // no TOOL_RETRY_DECISION event (no-op-when-unconfigured intent).
          if (retryPolicy) {
            // pi-experiment-6q0y.48: check retry budget before admitting the retry (exception path).
            const retryBudgetCheckEx = session.runtimeBudgetTracker?.checkPreRetry();
            if (retryBudgetCheckEx?.exceeded) {
              await session.runtimeBudgetTracker!.emitExceededEvent(retryBudgetCheckEx, services.eventStore);
              const activeRun = session.activeRun;
              if (activeRun && retryBudgetCheckEx.route) {
                const sum = `Runtime budget exceeded (${retryBudgetCheckEx.dimension}: ${retryBudgetCheckEx.currentValue} >= ${retryBudgetCheckEx.limit}). Route: ${retryBudgetCheckEx.route}`;
                const routeEventEx = ports.buildWorkerEvent(teammateEventTypeForOutcome(retryBudgetCheckEx.route, config), {
                  beadId: activeRun.beadId, stateId: activeRun.stateId, actionId: activeRun.action.id,
                  transitionEvent: retryBudgetCheckEx.route, summary: sum, evidence: sum, handover: sum,
                });
                await postWorkerSignal(services, routeEventEx).catch(() => {});
              }
              return toolResult(`RUNTIME_BUDGET_EXCEEDED: ${retryBudgetCheckEx.dimension} limit (${retryBudgetCheckEx.limit}) reached. Route: ${retryBudgetCheckEx.route}`);
            }
            session.runtimeBudgetTracker?.recordRetry();
            const retryDecision = await evaluateRetry({
              tool: tool.name,
              invocationId: currentInvocationId,
              attempt,
              failureCategory: 'INFRA',
              retryPolicy,
              idempotencyClass
            }, services.eventStore);
            if (retryDecision.nextRoute === 'retry') {
              attempt++;
              toolInvocationId = uuidv7();
              continue;
            }
          }

          if (ctx.hasUI) {
            ctx.ui.setWorkingMessage(undefined);
            ctx.ui.notify(`Tool ${tool.name} error: ${String(error)}`, 'error');
          }
          return toolResult(`Error: ${String(error)}`);
        }
      }
    }
  };
}

/**
 * Re-export checkToolValidationRules for use by PiObservers (which receives it as a callback).
 * The implementation lives here (canonical location) and is passed as an injected callback.
 */
export { checkToolValidationRules };
