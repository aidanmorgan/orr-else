/**
 * preflightProjectTool — WI-12: preflight checks extracted from executeConfiguredProjectTool.
 *
 * Handles: extension-type rejection, backpressure check, failure-limit check.
 * Returns:
 *   - { tag: 'ready', result } when a short-circuit result is available (no execution needed)
 *   - { tag: 'proceed', failureLimit } when all checks pass and execution should proceed
 *
 * The CALLER is responsible for:
 *   1. Calling reserveProjectToolCall BEFORE calling preflightProjectTool (except extension path)
 *   2. Releasing the reservation in a finally block on ALL non-extension paths
 *
 * Package-internal — do not import from outside src/plugins/.
 */
import { EventStore, type DomainEvent } from '../../core/EventStore.js';
import { asBeadId } from '../../types/ids.js';
import { isRestartTransition } from '../../core/EventUtils.js';
import type { ProjectToolConfig } from '../../core/domain/StateModels.js';
import type { ProjectToolBackpressure } from '../../core/RuntimeServices.js';
import { DomainEventName, ProjectToolType, TeammateEventType, ToolResultStatus } from '../../constants/domain.js';
import { ProjectToolDefaults } from '../../constants/infra.js';
import { ProjectToolFailureCategory, isInfrastructureProjectToolFailure } from './failureCategory.js';
import { ProjectToolResultKey } from './constants.js';
import { summarizeToolResult, attachFailureCategory } from './resultEnvelope.js';
import { reserveProjectToolCall, projectToolBackpressureResult } from './contextHelpers.js';
import type { ProjectToolExecutionContext, ProjectToolFailureLimitResult } from './types.js';
import { isJsonRecord } from './utils.js';
import { ToolResultRecorder } from '../../core/ToolResultRecorder.js';
import { ToolCallPathFactory } from '../../core/ToolCallPathFactory.js';
import { Logger, type LoggerPort } from '../../core/Logger.js';
// projectToolFailureLimitSuggestedOutcome lives in core so that core
// orchestration (Supervisor) can use it without a core->plugin import.
// Re-exported here to preserve the existing plugin/barrel import surface.
import { projectToolFailureLimitSuggestedOutcome } from '../../core/ProjectToolFailureLimit.js';

// ---- failure-limit helpers (exported) ----

export { projectToolFailureLimitSuggestedOutcome };

export function buildProjectToolFailureLimitResult(
  definition: ProjectToolConfig,
  failureCount: number,
  maxFailures: number,
  stateId?: string,
  actionId?: string,
  suggestedOutcomeOverride?: string
): Record<string, unknown> {
  const configuredSuggestedOutcome = projectToolFailureLimitSuggestedOutcome(definition, stateId, actionId);
  const suggestedOutcome = suggestedOutcomeOverride || configuredSuggestedOutcome;
  const terminal = definition.failureLimit?.terminal === true;
  const message = suggestedOutcomeOverride && suggestedOutcomeOverride !== configuredSuggestedOutcome
    ? `Failure limit reached for project tool ${definition.name}. Route the state with ${suggestedOutcome} based on the project-tool routing hint instead of retrying this verifier.`
    : definition.failureLimit?.message
    || `Failure limit reached for project tool ${definition.name}. Route the state with ${suggestedOutcome} instead of retrying this verifier.`;

  return {
    tool: definition.name,
    status: ToolResultStatus.REJECTED,
    message,
    failureLimit: {
      failureCount,
      maxFailures,
      suggestedOutcome,
      terminal
    }
  };
}

export function attachProjectToolFailureLimit(
  result: unknown,
  failureLimitResult: Record<string, unknown>
): unknown {
  const limit = failureLimitResult.failureLimit;
  if (!isJsonRecord(result)) {
    return {
      ...failureLimitResult,
      result
    };
  }

  return {
    ...result,
    message: typeof result.message === 'string' ? result.message : failureLimitResult.message,
    failureLimit: limit
  };
}

// ---- failure window boundary helpers ----

function nestedRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isJsonRecord(value)) return undefined;
  return isJsonRecord(value[key]) ? value[key] as Record<string, unknown> : undefined;
}

export function routingHintSuggestedOutcome(value: unknown): string | undefined {
  if (!isJsonRecord(value)) return undefined;
  const candidates = [
    nestedRecord(value, 'routingHint'),
    nestedRecord(nestedRecord(value, ProjectToolResultKey.STRUCTURED_RESULT), 'routingHint'),
    nestedRecord(nestedRecord(value, 'result'), 'routingHint'),
    nestedRecord(nestedRecord(nestedRecord(value, 'result'), ProjectToolResultKey.STRUCTURED_RESULT), 'routingHint')
  ];
  for (const candidate of candidates) {
    if (isJsonRecord(candidate) && typeof candidate.suggestedOutcome === 'string') {
      return candidate.suggestedOutcome;
    }
  }
  return undefined;
}

function failureLimitSuggestedOutcomeFromEvent(event: DomainEvent): string | undefined {
  const result = isJsonRecord(event.data.result) ? event.data.result : undefined;
  const failureLimit = result?.failureLimit;
  return isJsonRecord(failureLimit) && typeof failureLimit.suggestedOutcome === 'string'
    ? failureLimit.suggestedOutcome
    : routingHintSuggestedOutcome(result);
}

function isProjectToolFailureWindowBoundary(
  event: DomainEvent,
  stateId: string,
  actionId?: string
): boolean {
  if (event.type !== DomainEventName.STATE_TRANSITION_APPLIED) return false;
  const data = event.data || {};
  if (isRestartTransition(data.transitionEvent)) return false;
  if (data.fromState !== stateId && data.nextState !== stateId) return false;
  if (actionId && data.actionId && data.actionId !== actionId) return false;
  return true;
}

function isProjectToolTerminalOutcomeAcknowledged(
  event: DomainEvent,
  stateId: string,
  actionId?: string
): boolean {
  if (event.type !== DomainEventName.SIGNAL_ACKNOWLEDGED) return false;
  const data = event.data || {};
  if (
    data.type !== TeammateEventType.STATE_FAILED
    && data.type !== TeammateEventType.STATE_BLOCKED
    && data.type !== TeammateEventType.STATE_TRANSITIONED
  ) {
    return false;
  }
  if (isRestartTransition(data.transitionEvent)) return false;
  if (data.stateId !== stateId) return false;
  if (actionId && data.actionId && data.actionId !== actionId) return false;
  return true;
}

function isProjectToolStateRunStart(
  event: DomainEvent,
  stateId: string,
  actionId?: string
): boolean {
  if (event.type !== DomainEventName.STATE_RUN_INITIALIZED) return false;
  const data = event.data || {};
  if (data.stateId !== stateId) return false;
  if (actionId && data.actionId && data.actionId !== actionId) return false;
  return true;
}

function eventsForActiveProjectToolRun(
  events: DomainEvent[],
  stateId?: string,
  actionId?: string
): DomainEvent[] {
  if (!stateId) return events;
  let startIndex = 0;
  let terminalOutcomeAcknowledged = false;
  // pi-experiment-ejv1: track the index immediately after the acknowledgment event.
  // When STATE_RUN_INITIALIZED follows in the deferral gap, we set startIndex to
  // ackWindowStart (not index + 1) so that PROJECT_TOOL_FAILED events recorded
  // between the acknowledgment and the deferred STATE_RUN_INITIALIZED are attributed
  // to the correct (new) run window.
  let ackWindowStart = 0;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (isProjectToolFailureWindowBoundary(event, stateId, actionId)) {
      startIndex = index + 1;
      terminalOutcomeAcknowledged = false;
      ackWindowStart = 0;
      continue;
    }
    if (isProjectToolTerminalOutcomeAcknowledged(event, stateId, actionId)) {
      terminalOutcomeAcknowledged = true;
      ackWindowStart = index + 1;
      continue;
    }
    if (terminalOutcomeAcknowledged && isProjectToolStateRunStart(event, stateId, actionId)) {
      // Use ackWindowStart so failures in the deferral gap (recorded after the
      // acknowledgment but before STATE_RUN_INITIALIZED) fall inside the active window.
      startIndex = ackWindowStart;
      terminalOutcomeAcknowledged = false;
      ackWindowStart = 0;
    }
  }
  return events.slice(startIndex);
}

export async function projectToolFailureLimit(
  eventStore: EventStore,
  definition: ProjectToolConfig,
  context: ProjectToolExecutionContext
): Promise<ProjectToolFailureLimitResult> {
  const maxFailures = definition.failureLimit?.maxFailuresPerState;
  if (typeof maxFailures !== 'number' || !Number.isFinite(maxFailures) || maxFailures <= 0) {
    return { reached: false, failureCount: 0, maxFailures: 0 };
  }

  const beadId = context.templateContext.beadId;
  if (!beadId || beadId === ProjectToolDefaults.UNASSIGNED_BEAD_ID) {
    return { reached: false, failureCount: 0, maxFailures };
  }

  const stateId = context.templateContext.stateId;
  const actionId = context.templateContext.actionId;
  const events = await eventStore.eventsForBead(asBeadId(beadId));
  const activeRunEvents = eventsForActiveProjectToolRun(events, stateId, actionId);
  const matchingFailures = activeRunEvents.filter(event => {
    const data = event.data;
    if (event.type !== DomainEventName.PROJECT_TOOL_FAILED) return false;
    if (data.tool !== definition.name) return false;
    if (stateId && data.stateId !== stateId) return false;
    if (actionId && data.actionId !== actionId) return false;
    const result = isJsonRecord(data.result) ? data.result : undefined;
    if (data.failureCategory === ProjectToolFailureCategory.BACKPRESSURE || result?.failureCategory === ProjectToolFailureCategory.BACKPRESSURE) return false;
    if (isInfrastructureProjectToolFailure(data.error) || isInfrastructureProjectToolFailure(data.result)) return false;
    return true;
  });
  const failureCount = matchingFailures.length;

  if (failureCount < maxFailures) {
    return { reached: false, failureCount, maxFailures };
  }

  return {
    reached: true,
    failureCount,
    maxFailures,
    result: buildProjectToolFailureLimitResult(
      definition,
      failureCount,
      maxFailures,
      stateId,
      actionId,
      [...matchingFailures].reverse().map(failureLimitSuggestedOutcomeFromEvent).find(Boolean)
    )
  };
}

// ---- Side-effect contract gate (zog2.9) ----

/**
 * Check whether a tool's sideEffectContract allows invocation in the current context.
 *
 * Returns a rejection message string when blocked, or undefined when the tool may proceed.
 * Called from preflightProjectTool with the real readOnlyContext/probeContext flags
 * derived from the production execution path.
 */
export function checkSideEffectContractGates(
  definition: ProjectToolConfig,
  opts: { readOnlyContext?: boolean; probeContext?: boolean }
): string | undefined {
  const contract = definition.sideEffectContract;
  if (!contract) return undefined;
  if (opts.readOnlyContext && contract.allowedInReadOnlyContext === false) {
    return (
      `REJECTED: \`${definition.name}\` is not allowed in read-only review contexts ` +
      `(sideEffectContract.allowedInReadOnlyContext: false). ` +
      `This tool may only be called in action contexts that permit mutations.`
    );
  }
  if (opts.probeContext && contract.safeForReadinessProbe === false) {
    return (
      `REJECTED: \`${definition.name}\` may not be invoked during a harness readiness probe ` +
      `(sideEffectContract.safeForReadinessProbe: false). ` +
      `Readiness probes must only call tools that are safe without side-effects.`
    );
  }
  return undefined;
}

// ---- PreflightOutcome ----

export type PreflightOutcome =
  | { tag: 'ready'; result: unknown }
  | { tag: 'proceed'; failureLimit: ProjectToolFailureLimitResult };

/**
 * WI-12: Extracted preflight for executeConfiguredProjectTool.
 *
 * The caller MUST:
 * 1. Call reserveProjectToolCall BEFORE calling this (the caller controls when to reserve).
 * 2. Pass the reservation info to detect backpressure (via the context).
 * 3. Release in finally on ALL paths when tag === 'proceed'.
 *
 * When tag === 'ready': short-circuit, return result. No reservation was made (extension),
 * or reservation was rejected (backpressure collision). Caller should NOT release.
 * When tag === 'proceed': proceed with execution. Caller MUST release reservation in finally.
 */
export async function preflightProjectTool(
  eventStore: EventStore,
  definition: ProjectToolConfig,
  context: ProjectToolExecutionContext,
  backpressure: ProjectToolBackpressure,
  beadId: string | undefined,
  stateId: string | undefined,
  actionId: string | undefined,
  opts: { readOnlyContext?: boolean; probeContext?: boolean } = {},
  logger: LoggerPort = Logger
): Promise<PreflightOutcome> {
  // 0. Side-effect contract gate (zog2.9) — no reservation needed (pure policy check)
  const contractRejection = checkSideEffectContractGates(definition, opts);
  if (contractRejection) {
    const contractResult = attachFailureCategory(definition, {
      tool: definition.name,
      status: ToolResultStatus.REJECTED,
      message: contractRejection,
      failureCategory: ProjectToolFailureCategory.TOOL_INPUT_ERROR
    });
    const contractRecorder = new ToolResultRecorder(new ToolCallPathFactory(), context.templateContext.projectRoot, logger);
    const contractHandle = await contractRecorder.recordShortCircuit({
      toolName: definition.name, invocationId: context.templateContext.toolInvocationId ?? '',
      beadId, stateId, actionId,
      status: ToolResultStatus.REJECTED, failureCategory: 'INPUT',
      rejectionReason: contractRejection,
    }).catch(() => undefined);
    await eventStore.record(DomainEventName.PROJECT_TOOL_FAILED, {
      beadId,
      stateId,
      actionId,
      tool: definition.name,
      type: definition.type,
      status: ToolResultStatus.REJECTED,
      toolInvocationId: context.templateContext.toolInvocationId,
      ...(contractHandle?.outputFile ? { outputFile: contractHandle.outputFile } : {}),
      result: summarizeToolResult(contractResult)
    }).catch(() => {});
    return { tag: 'ready', result: contractResult };
  }

  // 1. Extension-type rejection — no reservation needed
  if (definition.type === ProjectToolType.EXTENSION) {
    const result = {
      tool: definition.name,
      status: ToolResultStatus.REJECTED,
      message: `Project tool ${definition.name} is registered by a Pi extension and cannot be executed directly by Orr Else. Use it as a model tool call, or configure a command/mcp tool for harness-run parent actions.`
    };
    const finalResult = attachFailureCategory(definition, result);
    // zog2.16: write durable artifact so latestToolResultEvent sees status=REJECTED,
    // not an absent event (TOOL_NOT_INVOKED)
    const extensionRecorder = new ToolResultRecorder(new ToolCallPathFactory(), context.templateContext.projectRoot, logger);
    const extensionHandle = await extensionRecorder.recordShortCircuit({
      toolName: definition.name, invocationId: context.templateContext.toolInvocationId ?? '',
      beadId, stateId, actionId,
      status: ToolResultStatus.REJECTED, failureCategory: 'INFRA',
      rejectionReason: result.message,
    }).catch(() => undefined);
    await eventStore.record(DomainEventName.PROJECT_TOOL_FAILED, {
      beadId,
      stateId,
      actionId,
      tool: definition.name,
      type: definition.type,
      status: result.status,
      toolInvocationId: context.templateContext.toolInvocationId,
      ...(extensionHandle?.outputFile ? { outputFile: extensionHandle.outputFile } : {}),
      result: summarizeToolResult(finalResult)
    }).catch(() => {});
    return { tag: 'ready', result: finalResult };
  }

  // 2. Backpressure reservation
  const reservation = reserveProjectToolCall(backpressure, definition, context);

  if (reservation.existing) {
    const rawBpResult = projectToolBackpressureResult(definition, context, reservation.existing);
    // Capsule results already carry failureCategory and must stay prose-free (<=80 est. tokens).
    // Skip attachFailureCategory for them — it would append verbose remediation prose that
    // defeats the capsule's on-wire budget (AC2) and reintroduces text the capsule replaces (AC3).
    const result = ('capsule' in rawBpResult)
      ? rawBpResult
      : attachFailureCategory(definition, rawBpResult);
    // zog2.16: write durable artifact so latestToolResultEvent sees status=REJECTED (not absent)
    const bpRecorder = new ToolResultRecorder(new ToolCallPathFactory(), context.templateContext.projectRoot, logger);
    const bpHandle = await bpRecorder.recordShortCircuit({
      toolName: definition.name, invocationId: context.templateContext.toolInvocationId ?? '',
      beadId, stateId, actionId,
      status: ToolResultStatus.REJECTED, failureCategory: 'INFRA',
      rejectionReason: 'backpressure: concurrent call already in progress',
    }).catch(() => undefined);
    await eventStore.record(DomainEventName.PROJECT_TOOL_FAILED, {
      beadId,
      stateId,
      actionId,
      tool: definition.name,
      type: definition.type,
      status: ToolResultStatus.REJECTED,
      toolInvocationId: context.templateContext.toolInvocationId,
      failureCategory: ProjectToolFailureCategory.BACKPRESSURE,
      ...(bpHandle?.outputFile ? { outputFile: bpHandle.outputFile } : {}),
      result: summarizeToolResult(result)
    }).catch(() => {});
    // Backpressure — reservation was NOT successfully made (existing found); caller should NOT release.
    return { tag: 'ready', result };
  }

  // 3. Failure-limit check (reservation is now held; caller MUST release in finally)
  const failureLimit = await projectToolFailureLimit(eventStore, definition, context);
  if (failureLimit.reached && failureLimit.result) {
    // Return ready result but tag as 'proceed' so caller knows to release
    // Actually: failure-limit IS a short-circuit — but the reservation WAS made.
    // We handle this by returning tag='ready' with a special "releaseNeeded" flag.
    // Simpler: return { tag: 'proceed', failureLimit } and let caller handle it.
  }

  // Return proceed — includes failureLimit for the caller to use
  return { tag: 'proceed', failureLimit };
}
