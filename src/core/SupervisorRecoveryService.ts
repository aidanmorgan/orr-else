/**
 * SupervisorRecoveryService — owns startup replay, rehydration, and idempotency
 * reconstruction for the coordinator.
 *
 * pi-experiment-amq0.2: extracted from Supervisor so recovery logic is testable
 * in isolation with a fake event store, no tmux, no bd.
 *
 * Responsibilities:
 *   - Rebuild processedSignals set from durable TEAMMATE_EVENT ACCEPT records.
 *   - Reconcile unacknowledged SIGNAL_INTENT_RECORDED entries after restart.
 *   - Restore the capacity-pause state from SCHEDULING_PAUSED events.
 */

import { Logger } from './Logger.js';
import { DomainEventName, TeammateEventDecisionAction, TeammateEventType } from '../constants/domain.js';
import { Component } from '../constants/infra.js';
import type { DomainEvent, ProjectionCapableStore } from './EventStoreTypes.js';

export class SupervisorRecoveryService {
  constructor(private readonly eventStore: ProjectionCapableStore) {}

  /**
   * Rebuilds `processedSignals` from durable TEAMMATE_EVENT records so that
   * idempotency survives a coordinator restart. Returns the set of rebuilt keys.
   */
  async rebuildProcessedSignalsFromEvents(events?: DomainEvent[]): Promise<Set<string>> {
    const rebuilt = new Set<string>();
    let count = 0;
    try {
      const allEvents = events ?? await this.eventStore.readAll();
      for (const event of allEvents) {
        if (event.type !== DomainEventName.TEAMMATE_EVENT) continue;
        const data = event.data || {};
        if (data.processingDecision !== TeammateEventDecisionAction.ACCEPT) continue;
        const key = String(data.idempotencyKey || '');
        if (!key) continue;
        rebuilt.add(key);
        count++;
      }
      if (count > 0) {
        Logger.info(Component.SUPERVISOR, 'Rebuilt processed-signal idempotency set from event store', { rebuilt: count });
      }
    } catch (error) {
      Logger.warn(Component.SUPERVISOR, 'Unable to rebuild processed-signal set from event store; idempotency layer is in-memory only this session', { error: String(error) });
    }
    return rebuilt;
  }

  /**
   * Reconciles SIGNAL_INTENT_RECORDED events that have no corresponding
   * processed TEAMMATE_EVENT (by idempotencyKey). Emits SIGNAL_INTENT_RECONCILED
   * for each unacknowledged intent. Idempotent — skips already-reconciled intents.
   */
  async reconcileUnacknowledgedSignalIntents(events?: DomainEvent[]): Promise<void> {
    try {
      const allEvents = events ?? await this.eventStore.readAll();

      const processedKeys = new Set<string>();
      const reconciledKeys = new Set<string>();
      const intentsByKey = new Map<string, DomainEvent>();

      for (const event of allEvents) {
        const data = event.data || {};
        const key = String(data.idempotencyKey || '');
        if (!key) continue;

        if (event.type === DomainEventName.SIGNAL_INTENT_RECORDED) {
          if (!intentsByKey.has(key)) intentsByKey.set(key, event);
          continue;
        }
        if (event.type === DomainEventName.TEAMMATE_EVENT && data.processingDecision === TeammateEventDecisionAction.ACCEPT) {
          processedKeys.add(key);
          continue;
        }
        if (event.type === DomainEventName.SIGNAL_ACKNOWLEDGED) {
          processedKeys.add(key);
          continue;
        }
        if (event.type === DomainEventName.SIGNAL_INTENT_RECONCILED) {
          reconciledKeys.add(key);
        }
      }

      const unacknowledgedKeys = [...intentsByKey.keys()].filter(
        key => !processedKeys.has(key) && !reconciledKeys.has(key)
      );

      for (const key of unacknowledgedKeys) {
        const intentEvent = intentsByKey.get(key)!;
        const intentData = intentEvent.data || {};
        Logger.warn(Component.SUPERVISOR, 'Reconciling unacknowledged signal intent on startup', {
          idempotencyKey: key,
          beadId: intentData.beadId,
          type: intentData.type,
          stateId: intentData.stateId
        });
        await this.eventStore.record(DomainEventName.SIGNAL_INTENT_RECONCILED, {
          idempotencyKey: key,
          beadId: intentData.beadId,
          type: intentData.type,
          stateId: intentData.stateId,
          intentTimestamp: intentEvent.timestamp,
          reason: 'No processed TEAMMATE_EVENT or SIGNAL_ACKNOWLEDGED found for this intent after coordinator restart'
        }).catch(() => {});
      }

      if (unacknowledgedKeys.length > 0) {
        Logger.info(Component.SUPERVISOR, 'Signal intent reconciliation complete', { unacknowledgedCount: unacknowledgedKeys.length });
      }
    } catch (error) {
      Logger.warn(Component.SUPERVISOR, 'Unable to reconcile unacknowledged signal intents', { error: String(error) });
    }
  }

  /**
   * Restore the capacity-pause state from SCHEDULING_PAUSED events.
   * Returns { pauseUntilMs, reason } if an active pause was found, undefined otherwise.
   */
  async restoreCapacityPauseFromStore(clockNow: () => number): Promise<{ pauseUntilMs: number; reason: string } | undefined> {
    const latestPausedEvent = await this.eventStore.latestEventByType(DomainEventName.SCHEDULING_PAUSED).catch((error: unknown) => {
      Logger.warn(Component.SUPERVISOR, 'Unable to restore capacity pause from event store', { error: String(error) });
      return undefined;
    });
    const pauseUntilMs = Date.parse(String(latestPausedEvent?.data?.pauseUntil || ''));
    if (!Number.isFinite(pauseUntilMs) || pauseUntilMs <= clockNow()) return undefined;

    const reason = String(latestPausedEvent?.data?.reason || 'Scheduling paused');
    Logger.warn(Component.SUPERVISOR, 'Restored scheduling pause from event store', {
      pauseUntil: new Date(pauseUntilMs).toISOString(),
      reason
    });
    return { pauseUntilMs, reason };
  }
}
