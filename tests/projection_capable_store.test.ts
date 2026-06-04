/**
 * pi-experiment-3etu: ProjectionCapableStore is the narrow read/record surface
 * the Supervisor consumes instead of the concrete EventStore class.
 *
 * The LOAD-BEARING compile-time binding lives in src/, not here: the Supervisor
 * reads the store through a getter typed as ProjectionCapableStore, so removing
 * a method it calls (e.g. latestProjectToolFailureLimitEvent) is a `tsc
 * --noEmit` error in src/core/Supervisor.ts. (`npx tsc --noEmit` excludes
 * tests/ — see tsconfig.json — so the `@ts-expect-error` directive below is NOT
 * enforced by any build command; it documents the interface contract and would
 * catch drift only if tests/ were added to the typecheck.)
 *
 * What THIS file enforces at runtime: that the real EventStore satisfies the
 * interface (the `_check` assignment, which also type-checks because src/ is
 * compiled) and that the shared mock double provides every method.
 */
import { describe, expect, it } from 'vitest';
import { EventStore } from '../src/core/EventStore.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import type { ProjectionCapableStore } from '../src/core/EventStoreTypes.js';
import { fakeProjectionStore } from './support/fakeProjectionStore.js';

describe('ProjectionCapableStore contract (3etu)', () => {
  it('the real EventStore structurally satisfies ProjectionCapableStore', () => {
    const realEventStore = new EventStore(new ConfigLoader());
    // Compile-time conformance: this assignment only type-checks because the
    // concrete EventStore implements every method the narrow interface declares.
    const _check: ProjectionCapableStore = realEventStore;
    expect(typeof _check.latestProjectToolFailureLimitEvent).toBe('function');
    expect(typeof _check.record).toBe('function');
    expect(typeof _check.projectBead).toBe('function');
  });

  it('documents that a ProjectionCapableStore literal missing latestProjectToolFailureLimitEvent is a type error', () => {
    // @ts-expect-error — a ProjectionCapableStore literal MUST include
    // latestProjectToolFailureLimitEvent; omitting it is a type error. NOTE:
    // tests/ is excluded from `npx tsc --noEmit` (tsconfig.json), so this
    // directive is documentation, not an enforced gate — the enforced binding
    // is the narrow-typed getter in src/core/Supervisor.ts.
    const incomplete: ProjectionCapableStore = {
      record: async () => undefined,
      readAll: async () => [],
      projectBead: async () => ({}),
      eventsForBead: async () => [],
      eventsForBeads: async () => new Map(),
      latestEventsForBeads: async () => new Map(),
      latestEventByType: async () => undefined
      // latestProjectToolFailureLimitEvent intentionally omitted
    };
    expect(incomplete.record).toBeTypeOf('function');
  });

  it('the shared fakeProjectionStore double satisfies the full contract', () => {
    const store = fakeProjectionStore();
    const required: Array<keyof ProjectionCapableStore> = [
      'record',
      'readAll',
      'projectBead',
      'eventsForBead',
      'eventsForBeads',
      'latestEventsForBeads',
      'latestEventByType',
      'latestProjectToolFailureLimitEvent'
    ];
    for (const method of required) {
      expect(store[method]).toBeTypeOf('function');
    }
  });
});
