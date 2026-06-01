import { EventStore } from './EventStore.js';
import { Logger } from './Logger.js';
import { Component, DomainEventName } from '../constants/index.js';

export const DomainEvent = {
  BEAD_CLAIMED: DomainEventName.BEAD_CLAIMED,
  PHASE_STARTED: DomainEventName.STATE_RUN_INITIALIZED
} as const;

export type DomainEvent = typeof DomainEvent[keyof typeof DomainEvent] | string;
export type DomainEventHook = (data: unknown) => Promise<void> | void;

export class DomainEventEmitter {
  private readonly handlers = new Map<string, DomainEventHook[]>();

  constructor(private readonly eventStore: EventStore) {}

  public registerHook(event: DomainEvent, handler: DomainEventHook): void {
    const eventHandlers = this.handlers.get(event) || [];
    eventHandlers.push(handler);
    this.handlers.set(event, eventHandlers);
  }

  public clearHooks(): void {
    this.handlers.clear();
  }

  public async emitEvent(event: DomainEvent, data: unknown): Promise<void> {
    Logger.debug(Component.CORE, `Emitting event: ${event}`, { data });
    await this.eventStore.record(event, data);
    await Promise.all((this.handlers.get(event) || []).map(handler => handler(data)));
  }
}

export class DomainEvents {
  constructor(private readonly emitter: DomainEventEmitter) {}

  public async emit(event: DomainEvent, data: unknown): Promise<void> {
    await this.emitter.emitEvent(event, data);
  }
}
