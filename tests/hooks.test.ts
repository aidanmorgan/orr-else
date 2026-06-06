import { describe, it, expect, beforeEach } from 'vitest';
import { DomainEventEmitter, DomainEvent } from '../src/core/DomainEvents.js';
import { fakeProjectionStore } from './support/fakeProjectionStore.js';

// hooks.test.ts verifies hook wiring only — event persistence is not under test
// here. Use fakeProjectionStore so tests don't go through production validation.
describe('DomainEventEmitter', () => {
  let emitter: DomainEventEmitter;

  beforeEach(() => {
    emitter = new DomainEventEmitter(fakeProjectionStore() as any);
    emitter.clearHooks();
  });

  it('should emit events and trigger registered hooks', async () => {
    let hookTriggered = false;
    let hookData = null;

    emitter.registerHook(DomainEvent.BEAD_CLAIMED, async data => {
      hookTriggered = true;
      hookData = data;
    });

    await emitter.emitEvent(DomainEvent.BEAD_CLAIMED, { test: 'data' });

    expect(hookTriggered).toBe(true);
    expect(hookData).toMatchObject({ test: 'data' });
  });

  it('should support multiple hooks for the same event', async () => {
    let count = 0;

    emitter.registerHook(DomainEvent.PHASE_STARTED, async () => { count++; });
    emitter.registerHook(DomainEvent.PHASE_STARTED, async () => { count++; });

    await emitter.emitEvent(DomainEvent.PHASE_STARTED, {});

    expect(count).toBe(2);
  });
});
