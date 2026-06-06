import { describe, it, expect, beforeEach } from 'vitest';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { DomainEventEmitter, DomainEvent } from '../src/core/DomainEvents.js';
import { EventStore } from '../src/core/EventStore.js';

describe('DomainEventEmitter', () => {
  let emitter: DomainEventEmitter;

  beforeEach(() => {
    emitter = new DomainEventEmitter(new EventStore(new ConfigLoader()));
    emitter.clearHooks();
  });

  it('should emit events and trigger registered hooks', async () => {
    let hookTriggered = false;
    let hookData = null;

    emitter.registerHook(DomainEvent.BEAD_CLAIMED, async data => {
      hookTriggered = true;
      hookData = data;
    });

    await emitter.emitEvent(DomainEvent.BEAD_CLAIMED, { test: 'data', synthetic: true });

    expect(hookTriggered).toBe(true);
    expect(hookData).toMatchObject({ test: 'data' });
  });

  it('should support multiple hooks for the same event', async () => {
    let count = 0;

    emitter.registerHook(DomainEvent.PHASE_STARTED, async () => { count++; });
    emitter.registerHook(DomainEvent.PHASE_STARTED, async () => { count++; });

    await emitter.emitEvent(DomainEvent.PHASE_STARTED, { synthetic: true });

    expect(count).toBe(2);
  });
});
