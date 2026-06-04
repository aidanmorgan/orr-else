/**
 * UniqueId – an injectable source of process-unique tokens.
 *
 * Used where code needs a collision-resistant suffix (e.g. a temp filename
 * before an atomic rename) without reaching for `process.pid` + `Math.random()`
 * directly. Injecting it keeps the consuming class deterministic under test:
 * a fake provider returns a fixed token so the temp path is predictable.
 */
export interface UniqueId {
  /** Returns a process-unique token suitable for embedding in a temp filename. */
  token(): string;
}

import { randomUUID } from 'crypto';

export const systemUniqueId: UniqueId = {
  // pid disambiguates concurrent processes; randomUUID disambiguates within a
  // process (and across same-millisecond calls), replacing the old
  // `process.pid + Date.now() + Math.random()` triple.
  token: () => `${process.pid}.${randomUUID()}`
};
