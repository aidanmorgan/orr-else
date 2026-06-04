import { vi } from 'vitest';
import type { ProjectionCapableStore } from '../../src/core/EventStoreTypes.js';

/**
 * Build a test double for the narrow {@link ProjectionCapableStore} surface the
 * Supervisor (and the coordinator artifact-presence gate) consume.
 *
 * The return type is `ProjectionCapableStore`, so this factory is the single
 * compile-time enforcement point for the mock: if the interface grows a method,
 * this factory stops compiling until the new method is stubbed here, and a
 * test that omits a required method (without `@ts-expect-error`) is a tsc error
 * rather than a runtime "is not a function" crash. Every method defaults to a
 * benign empty result; pass `overrides` to supply test-specific behaviour
 * (e.g. a `record` that captures emitted events).
 */
export function fakeProjectionStore(
  overrides: Partial<ProjectionCapableStore> = {}
): ProjectionCapableStore {
  return {
    record: vi.fn(async () => undefined),
    readAll: vi.fn(async () => []),
    projectBead: vi.fn(async () => ({})),
    eventsForBead: vi.fn(async () => []),
    eventsForBeads: vi.fn(async () => new Map()),
    latestEventsForBeads: vi.fn(async () => new Map()),
    latestEventByType: vi.fn(async () => undefined),
    latestProjectToolFailureLimitEvent: vi.fn(async () => undefined),
    latestToolResultEvent: vi.fn(async () => undefined),
    ...overrides
  };
}
