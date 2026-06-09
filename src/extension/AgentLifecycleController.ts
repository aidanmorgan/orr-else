/**
 * Agent lifecycle observer controller.
 *
 * Encapsulates handleAgentLifecycleFailure and the failure classification
 * helpers. Receives injected services and session state references.
 *
 * No process.env reads — env-derived values are passed in via the context
 * parameter bag; the composition root resolves them from process.env.
 */

import type { AgentEndEvent, TurnEndEvent, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { TeammateEvent } from '../core/TeammateEvents.js';
import { Logger } from '../core/Logger.js';
import type { RuntimeServices } from '../core/RuntimeServices.js';
import { DomainEventName, EventName, TeammateEventType } from '../constants/domain.js';
import { AgentFailureCode, AgentFailureSummary, Component, Numeric, PiEventName, SupervisorDefaults, TimeMs, WorkerDefaults } from '../constants/infra.js';
import type { ActiveRun } from './SessionTypes.js';
import { postWorkerSignal } from './SignalController.js';
import { agentEventError } from './PiEventAdapters.js';

// ── failure classification ────────────────────────────────────────────────────

export function isContextOverflowFailure(error: string): boolean {
  const normalized = error.toLowerCase();
  return normalized.includes(AgentFailureCode.CONTEXT_LENGTH_EXCEEDED)
    || normalized.includes('context length exceeded')
    || normalized.includes('context window')
    || normalized.includes('too many compactions')
    || normalized.includes('auto-compact')
    || normalized.includes('auto compact');
}

export function isUsageLimitFailure(error: string): boolean {
  const normalized = error.toLowerCase();
  return normalized.includes(AgentFailureCode.USAGE_LIMIT_REACHED)
    || normalized.includes('usage limit has been reached');
}

export function isHarnessTransientFailureInternal(error: string): boolean {
  const normalized = error.toLowerCase();
  return normalized.includes(AgentFailureCode.WEBSOCKET_ERROR)
    || normalized.includes(AgentFailureCode.WEBSOCKET_CLOSED)
    || normalized.includes(AgentFailureCode.CONNECTION_RESET)
    || normalized.includes(AgentFailureCode.NETWORK_ERROR)
    || normalized.includes(AgentFailureCode.RESPONSE_HEADERS_TIMEOUT);
}

function usageLimitResetMs(error: string): number | undefined {
  const resetMatch = /"resets_at"\s*:\s*(\d+)/.exec(error)
    || /"X-Codex-Primary-Reset-At"\s*:\s*"?(\d+)"?/.exec(error);
  if (!resetMatch) return undefined;
  const parsed = Number.parseInt(resetMatch[1], Numeric.DECIMAL_RADIX);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  // Values > UNIX_SECONDS_MS_THRESHOLD are already milliseconds; smaller values are Unix seconds.
  return parsed > Numeric.UNIX_SECONDS_MS_THRESHOLD ? parsed : parsed * TimeMs.SECOND;
}

export function compactLifecycleFailureSummary(source: PiEventName, error: string): string {
  if (isUsageLimitFailure(error)) {
    return `${AgentFailureSummary.USAGE_LIMIT} Source: ${source}. ${AgentFailureSummary.EVENT_STORE_DETAILS}`;
  }
  if (isContextOverflowFailure(error)) {
    return `${AgentFailureSummary.CONTEXT_OVERFLOW} Source: ${source}. ${AgentFailureSummary.EVENT_STORE_DETAILS}`;
  }
  if (isHarnessTransientFailureInternal(error)) {
    return `${AgentFailureSummary.HARNESS_TRANSIENT} Source: ${source}. ${AgentFailureSummary.EVENT_STORE_DETAILS}`;
  }
  const compactError = error.length > WorkerDefaults.EVENT_PREVIEW_CHARS
    ? `${error.slice(0, WorkerDefaults.EVENT_PREVIEW_CHARS)}...`
    : error;
  return `Agent lifecycle failure during ${source}: ${compactError}`;
}

// ── context bag for handleAgentLifecycleFailure ───────────────────────────────

export interface AgentLifecycleFailureContext {
  /** Resolved from isWorkerMode() in extension.ts */
  isWorker: boolean;
  activeRun: ActiveRun | null;
  agentFailureSignaled: boolean;
  setAgentFailureSignaled: (v: boolean) => void;
  /**
   * Callback that builds a TeammateEvent with the process-env-resolved worker
   * identity. Provided by the composition root (extension.ts) so this module
   * never reads process.env itself.
   */
  buildWorkerEvent: (type: TeammateEventType, fields: Record<string, unknown>) => TeammateEvent;
}

// ── agent lifecycle failure handler ──────────────────────────────────────────

export async function handleAgentLifecycleFailure(
  event: AgentEndEvent | TurnEndEvent,
  ctx: ExtensionContext,
  source: PiEventName,
  services: RuntimeServices,
  context: AgentLifecycleFailureContext
): Promise<void> {
  if (!context.isWorker || !context.activeRun || context.agentFailureSignaled) return;
  const error = agentEventError(event);
  if (!error) return;

  context.setAgentFailureSignaled(true);
  const activeRun = context.activeRun;
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

    const exitedEvent = context.buildWorkerEvent(TeammateEventType.TEAMMATE_EXITED, {
      beadId: activeRun.beadId,
      stateId: activeRun.stateId,
      summary,
      capacityLimited: true,
      pauseUntilMs
    });
    await postWorkerSignal(services, exitedEvent).catch(signalError => {
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
  const isHarnessRestart = isHarnessTransientFailureInternal(error);
  const config = await services.configLoader.load();
  const teammateEventType = isContextRestart
    ? TeammateEventType.CONTEXT_RESTART_REQUESTED
    : isHarnessRestart
      ? TeammateEventType.HARNESS_RESTART_REQUESTED
      : TeammateEventType.STATE_BLOCKED;
  const teammateEvent = context.buildWorkerEvent(teammateEventType, {
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
  await postWorkerSignal(services, teammateEvent).catch(signalError => {
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
