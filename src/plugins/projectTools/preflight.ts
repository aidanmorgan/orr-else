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
import { isRestartTransition } from '../../core/EventUtils.js';
import type { ProjectToolConfig } from '../../core/domain/StateModels.js';
import type { ProjectToolBackpressure } from '../../core/RuntimeServices.js';
import { DomainEventName, ProjectToolDefaults, ProjectToolType, TeammateEventType, ToolResultStatus } from '../../constants/index.js';
import { ProjectToolFailureCategory, isInfrastructureProjectToolFailure } from './failureCategory.js';
import { ProjectToolResultKey } from './constants.js';
import { summarizeToolResult, attachFailureCategory, attachProjectToolSteering, transferResultAccounting } from './resultEnvelope.js';
import { reserveProjectToolCall, projectToolBackpressureResult } from './contextHelpers.js';
import type { ProjectToolExecutionContext, ProjectToolFailureLimitResult } from './types.js';
import { isJsonRecord } from './utils.js';
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
    const newResult = {
      ...failureLimitResult,
      result
    };
    // (9g8z) Preserve accounting across the spread — re-register on the new object.
    // See NOTE (9g8z fragility) in resultEnvelope.ts: every pipeline spread site must
    // call transferResultAccounting to keep the WeakMap entry reachable.
    transferResultAccounting(result, newResult);
    return newResult;
  }

  const newResult = {
    ...result,
    message: typeof result.message === 'string' ? result.message : failureLimitResult.message,
    failureLimit: limit
  };
  // (9g8z) Preserve accounting across the spread — re-register on the new object.
  transferResultAccounting(result, newResult);
  return newResult;
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
  const failureLimit = event.data?.result?.failureLimit;
  return isJsonRecord(failureLimit) && typeof failureLimit.suggestedOutcome === 'string'
    ? failureLimit.suggestedOutcome
    : routingHintSuggestedOutcome(event.data?.result);
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
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (isProjectToolFailureWindowBoundary(event, stateId, actionId)) {
      startIndex = index + 1;
      terminalOutcomeAcknowledged = false;
      continue;
    }
    if (isProjectToolTerminalOutcomeAcknowledged(event, stateId, actionId)) {
      terminalOutcomeAcknowledged = true;
      continue;
    }
    if (terminalOutcomeAcknowledged && isProjectToolStateRunStart(event, stateId, actionId)) {
      startIndex = index + 1;
      terminalOutcomeAcknowledged = false;
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
  const events = await eventStore.eventsForBead(beadId);
  const activeRunEvents = eventsForActiveProjectToolRun(events, stateId, actionId);
  const matchingFailures = activeRunEvents.filter(event => {
    const data = event.data || {};
    if (event.type !== DomainEventName.PROJECT_TOOL_FAILED) return false;
    if (data.tool !== definition.name) return false;
    if (stateId && data.stateId !== stateId) return false;
    if (actionId && data.actionId !== actionId) return false;
    if (data.failureCategory === ProjectToolFailureCategory.BACKPRESSURE || data.result?.failureCategory === ProjectToolFailureCategory.BACKPRESSURE) return false;
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
  actionId: string | undefined
): Promise<PreflightOutcome> {
  // 1. Extension-type rejection — no reservation needed
  if (definition.type === ProjectToolType.EXTENSION) {
    const result = {
      tool: definition.name,
      status: ToolResultStatus.REJECTED,
      message: `Project tool ${definition.name} is registered by a Pi extension and cannot be executed directly by Orr Else. Use it as a model tool call, or configure a command/mcp tool for harness-run parent actions.`
    };
    const finalResult = attachProjectToolSteering(definition, attachFailureCategory(definition, result));
    await eventStore.record(DomainEventName.PROJECT_TOOL_FAILED, {
      beadId,
      stateId,
      actionId,
      tool: definition.name,
      type: definition.type,
      status: result.status,
      result: summarizeToolResult(finalResult)
    }).catch(() => {});
    return { tag: 'ready', result: finalResult };
  }

  // 2. Backpressure reservation
  const reservation = reserveProjectToolCall(backpressure, definition, context);

  if (reservation.existing) {
    const result = attachProjectToolSteering(
      definition,
      attachFailureCategory(definition, projectToolBackpressureResult(definition, context, reservation.existing))
    );
    await eventStore.record(DomainEventName.PROJECT_TOOL_FAILED, {
      beadId,
      stateId,
      actionId,
      tool: definition.name,
      type: definition.type,
      status: ToolResultStatus.REJECTED,
      failureCategory: ProjectToolFailureCategory.BACKPRESSURE,
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
