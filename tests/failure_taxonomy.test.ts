/**
 * pi-experiment-n8fg: FailureTaxonomy golden tests.
 *
 * AC1: Taxonomy covers all required failure classes.
 * AC2: Routing table is exhaustive (every class covered for every phase).
 * AC3: Each table row maps deterministically to exactly ONE next action.
 * AC4: No LLM / prompt text in any routing path — pure TypeScript.
 * AC5: Compact descriptor exposes class, rowId, and next action.
 * AC6: Local/ad-hoc categories cannot bypass or redefine the central taxonomy.
 */

import { describe, it, expect } from 'vitest';
import {
  FailureClass,
  LifecyclePhase,
  RetryBudget,
  AuthorityLevel,
  NextAction,
  ALL_FAILURE_CLASSES,
  ALL_LIFECYCLE_PHASES,
  routeFailure,
  compactDescriptor,
  type RoutingKey,
  type RoutingResult,
  type CompactDescriptor,
} from '../src/core/FailureTaxonomy.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function key(
  failureClass: FailureClass,
  lifecyclePhase: LifecyclePhase,
  retryBudget: RetryBudget = RetryBudget.AVAILABLE,
  authorityLevel: AuthorityLevel = AuthorityLevel.HARNESS
): RoutingKey {
  return { failureClass, lifecyclePhase, retryBudget, authorityLevel };
}

// ---------------------------------------------------------------------------
// AC1: All required failure classes are present in the enum
// ---------------------------------------------------------------------------

describe('AC1: failure class coverage', () => {
  const required: FailureClass[] = [
    FailureClass.CONFIG_ERROR,
    FailureClass.STARTUP_SUBSTRATE,
    FailureClass.BACKEND_READINESS,
    FailureClass.PROVIDER_LIMIT,
    FailureClass.TRANSIENT_TRANSPORT,
    FailureClass.WORKER_PROCESS_LOSS,
    FailureClass.VERIFIER_GATE,
    FailureClass.EVENT_STORE,
    FailureClass.RETENTION_PRESSURE,
    FailureClass.SANDBOX_PERMISSION,
    FailureClass.LIFECYCLE_VIOLATION,
    FailureClass.OPERATOR_BLOCKER,
  ];

  it('exports all required failure classes', () => {
    for (const cls of required) {
      expect(ALL_FAILURE_CLASSES).toContain(cls);
    }
  });

  it('has at least 12 failure classes', () => {
    expect(ALL_FAILURE_CLASSES.length).toBeGreaterThanOrEqual(12);
  });
});

// ---------------------------------------------------------------------------
// AC2 + AC3: Exhaustive routing — every class × every phase resolves to
// exactly one NextAction without throwing.
// ---------------------------------------------------------------------------

describe('AC2+AC3: exhaustive deterministic routing', () => {
  for (const cls of ALL_FAILURE_CLASSES) {
    for (const phase of ALL_LIFECYCLE_PHASES) {
      it(`routes ${cls} × ${phase} (budget=AVAILABLE) to exactly one action`, () => {
        const result = routeFailure(key(cls, phase));
        expect(result).toBeDefined();
        // Must be a known NextAction value
        expect(Object.values(NextAction)).toContain(result.nextAction);
        // rowId must be a non-empty string
        expect(typeof result.rowId).toBe('string');
        expect(result.rowId.length).toBeGreaterThan(0);
      });

      it(`routes ${cls} × ${phase} (budget=EXHAUSTED) to exactly one action`, () => {
        const result = routeFailure(key(cls, phase, RetryBudget.EXHAUSTED));
        expect(result).toBeDefined();
        expect(Object.values(NextAction)).toContain(result.nextAction);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Spot-checks: known behaviours that must match specific next-actions
// ---------------------------------------------------------------------------

describe('specific routing expectations', () => {
  it('CONFIG_ERROR at STARTUP → STARTUP_FAIL', () => {
    const result = routeFailure(key(FailureClass.CONFIG_ERROR, LifecyclePhase.STARTUP));
    expect(result.nextAction).toBe(NextAction.STARTUP_FAIL);
  });

  it('PROVIDER_LIMIT at RUNNING → SCHEDULING_PAUSE', () => {
    const result = routeFailure(key(FailureClass.PROVIDER_LIMIT, LifecyclePhase.RUNNING));
    expect(result.nextAction).toBe(NextAction.SCHEDULING_PAUSE);
  });

  it('TRANSIENT_TRANSPORT at RUNNING, budget AVAILABLE → BOUNDED_RETRY', () => {
    const result = routeFailure(key(FailureClass.TRANSIENT_TRANSPORT, LifecyclePhase.RUNNING, RetryBudget.AVAILABLE));
    expect(result.nextAction).toBe(NextAction.BOUNDED_RETRY);
  });

  it('TRANSIENT_TRANSPORT at RUNNING, budget EXHAUSTED → SCHEDULING_PAUSE', () => {
    const result = routeFailure(key(FailureClass.TRANSIENT_TRANSPORT, LifecyclePhase.RUNNING, RetryBudget.EXHAUSTED));
    expect(result.nextAction).toBe(NextAction.SCHEDULING_PAUSE);
  });

  it('WORKER_PROCESS_LOSS at RUNNING → BOUNDED_RETRY (budget available)', () => {
    const result = routeFailure(key(FailureClass.WORKER_PROCESS_LOSS, LifecyclePhase.RUNNING, RetryBudget.AVAILABLE));
    expect(result.nextAction).toBe(NextAction.BOUNDED_RETRY);
  });

  it('WORKER_PROCESS_LOSS at RUNNING, budget EXHAUSTED → QUARANTINE', () => {
    const result = routeFailure(key(FailureClass.WORKER_PROCESS_LOSS, LifecyclePhase.RUNNING, RetryBudget.EXHAUSTED));
    expect(result.nextAction).toBe(NextAction.QUARANTINE);
  });

  it('VERIFIER_GATE at TRANSITION → STATE_TRANSITION_BLOCK', () => {
    const result = routeFailure(key(FailureClass.VERIFIER_GATE, LifecyclePhase.TRANSITION));
    expect(result.nextAction).toBe(NextAction.STATE_TRANSITION_BLOCK);
  });

  it('BACKEND_READINESS at STARTUP → STARTUP_FAIL', () => {
    const result = routeFailure(key(FailureClass.BACKEND_READINESS, LifecyclePhase.STARTUP));
    expect(result.nextAction).toBe(NextAction.STARTUP_FAIL);
  });

  it('BACKEND_READINESS at SPAWN → QUARANTINE', () => {
    const result = routeFailure(key(FailureClass.BACKEND_READINESS, LifecyclePhase.SPAWN));
    expect(result.nextAction).toBe(NextAction.QUARANTINE);
  });

  it('EVENT_STORE at STARTUP → STARTUP_FAIL', () => {
    const result = routeFailure(key(FailureClass.EVENT_STORE, LifecyclePhase.STARTUP));
    expect(result.nextAction).toBe(NextAction.STARTUP_FAIL);
  });

  it('EVENT_STORE at RUNNING → WARNING', () => {
    const result = routeFailure(key(FailureClass.EVENT_STORE, LifecyclePhase.RUNNING));
    expect(result.nextAction).toBe(NextAction.WARNING);
  });

  it('RETENTION_PRESSURE at RUNNING → WARNING', () => {
    const result = routeFailure(key(FailureClass.RETENTION_PRESSURE, LifecyclePhase.RUNNING));
    expect(result.nextAction).toBe(NextAction.WARNING);
  });

  it('SANDBOX_PERMISSION at TRANSITION → TERMINAL_REJECT', () => {
    const result = routeFailure(key(FailureClass.SANDBOX_PERMISSION, LifecyclePhase.TRANSITION));
    expect(result.nextAction).toBe(NextAction.TERMINAL_REJECT);
  });

  it('LIFECYCLE_VIOLATION at RUNNING → TERMINAL_REJECT', () => {
    const result = routeFailure(key(FailureClass.LIFECYCLE_VIOLATION, LifecyclePhase.RUNNING));
    expect(result.nextAction).toBe(NextAction.TERMINAL_REJECT);
  });

  it('OPERATOR_BLOCKER at RUNNING → STATE_TRANSITION_BLOCK', () => {
    const result = routeFailure(key(FailureClass.OPERATOR_BLOCKER, LifecyclePhase.RUNNING));
    expect(result.nextAction).toBe(NextAction.STATE_TRANSITION_BLOCK);
  });

  it('STARTUP_SUBSTRATE at STARTUP → STARTUP_FAIL', () => {
    const result = routeFailure(key(FailureClass.STARTUP_SUBSTRATE, LifecyclePhase.STARTUP));
    expect(result.nextAction).toBe(NextAction.STARTUP_FAIL);
  });

  it('STARTUP_SUBSTRATE at SPAWN → QUARANTINE', () => {
    const result = routeFailure(key(FailureClass.STARTUP_SUBSTRATE, LifecyclePhase.SPAWN));
    expect(result.nextAction).toBe(NextAction.QUARANTINE);
  });
});

// ---------------------------------------------------------------------------
// AC3: Routing is pure + deterministic — same key always yields same rowId
// ---------------------------------------------------------------------------

describe('AC3: determinism — same key always produces the same rowId and action', () => {
  const testKey = key(FailureClass.PROVIDER_LIMIT, LifecyclePhase.RUNNING);

  it('returns identical results on repeated calls', () => {
    const r1 = routeFailure(testKey);
    const r2 = routeFailure(testKey);
    expect(r1.nextAction).toBe(r2.nextAction);
    expect(r1.rowId).toBe(r2.rowId);
  });
});

// ---------------------------------------------------------------------------
// AC4: No LLM / prompt authority — routeFailure is pure TypeScript
// ---------------------------------------------------------------------------

describe('AC4: no LLM routing authority', () => {
  it('routeFailure accepts no async context, callback, or prompt param', () => {
    // routeFailure must be a synchronous function accepting only a RoutingKey
    const result = routeFailure(key(FailureClass.CONFIG_ERROR, LifecyclePhase.STARTUP));
    // If this executed synchronously without awaiting, it is not async
    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof result.nextAction).toBe('string');
  });

  it('unknown failure class throws rather than falling back to model inference', () => {
    expect(() => routeFailure({
      failureClass: 'INVENTED_CLASS' as FailureClass,
      lifecyclePhase: LifecyclePhase.RUNNING,
      retryBudget: RetryBudget.AVAILABLE,
      authorityLevel: AuthorityLevel.HARNESS,
    })).toThrow();
  });

  it('unknown lifecycle phase throws rather than falling back to model inference', () => {
    expect(() => routeFailure({
      failureClass: FailureClass.CONFIG_ERROR,
      lifecyclePhase: 'INVENTED_PHASE' as LifecyclePhase,
      retryBudget: RetryBudget.AVAILABLE,
      authorityLevel: AuthorityLevel.HARNESS,
    })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC5: Compact descriptor shape
// ---------------------------------------------------------------------------

describe('AC5: compact descriptor', () => {
  it('returns class, rowId, and nextAction as strings', () => {
    const result = routeFailure(key(FailureClass.PROVIDER_LIMIT, LifecyclePhase.RUNNING));
    const desc: CompactDescriptor = compactDescriptor(result);
    expect(typeof desc.cls).toBe('string');
    expect(typeof desc.rowId).toBe('string');
    expect(typeof desc.action).toBe('string');
    expect(desc.cls).toBe(FailureClass.PROVIDER_LIMIT);
    expect(desc.action).toBe(NextAction.SCHEDULING_PAUSE);
  });

  it('fits within 128 characters when serialized', () => {
    const result = routeFailure(key(FailureClass.TRANSIENT_TRANSPORT, LifecyclePhase.RUNNING));
    const desc = compactDescriptor(result);
    const serialized = `${desc.cls}|${desc.rowId}|${desc.action}`;
    expect(serialized.length).toBeLessThanOrEqual(128);
  });
});

// ---------------------------------------------------------------------------
// AC6: Local / ad-hoc categories cannot bypass or redefine the taxonomy
// ---------------------------------------------------------------------------

describe('AC6: bypass prevention', () => {
  it('ALL_FAILURE_CLASSES is a frozen readonly array — no runtime mutation', () => {
    expect(() => {
      // Attempt to push onto the exported array; should throw or be ignored
      (ALL_FAILURE_CLASSES as unknown as FailureClass[]).push('hacked' as FailureClass);
    }).toThrow();
  });

  it('ALL_LIFECYCLE_PHASES is a frozen readonly array — no runtime mutation', () => {
    expect(() => {
      (ALL_LIFECYCLE_PHASES as unknown as LifecyclePhase[]).push('hacked' as LifecyclePhase);
    }).toThrow();
  });

  it('FailureClass values are string literals — not numeric enums that can be cast', () => {
    for (const cls of ALL_FAILURE_CLASSES) {
      expect(typeof cls).toBe('string');
    }
  });

  it('routeFailure throws on an unlisted class from a local ad-hoc category', () => {
    // Simulates a parallel bead trying to inject its own class name
    const localAdHoc = 'LOCAL_BEAD_SPECIFIC_ERROR' as FailureClass;
    expect(() => routeFailure({
      failureClass: localAdHoc,
      lifecyclePhase: LifecyclePhase.RUNNING,
      retryBudget: RetryBudget.AVAILABLE,
      authorityLevel: AuthorityLevel.HARNESS,
    })).toThrow(/unknown.*class|not.*valid|unrecognized/i);
  });

  it('NextAction values are a fixed closed set — cannot be extended externally at runtime', () => {
    const knownActions = new Set(Object.values(NextAction));
    // Every row in the routing table must use an action from the known set
    for (const cls of ALL_FAILURE_CLASSES) {
      for (const phase of ALL_LIFECYCLE_PHASES) {
        const result = routeFailure(key(cls, phase));
        expect(knownActions.has(result.nextAction)).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// ALL_FAILURE_CLASSES × ALL_LIFECYCLE_PHASES table completeness audit
// ---------------------------------------------------------------------------

describe('table completeness audit', () => {
  it('every class+phase combination resolves without error (full matrix)', () => {
    const errors: string[] = [];
    for (const cls of ALL_FAILURE_CLASSES) {
      for (const phase of ALL_LIFECYCLE_PHASES) {
        for (const budget of Object.values(RetryBudget)) {
          try {
            const result = routeFailure(key(cls, phase, budget));
            if (!Object.values(NextAction).includes(result.nextAction)) {
              errors.push(`${cls}×${phase}×${budget}: unknown action ${result.nextAction}`);
            }
          } catch (e) {
            errors.push(`${cls}×${phase}×${budget}: threw ${String(e)}`);
          }
        }
      }
    }
    expect(errors).toEqual([]);
  });

  it('every NextAction value is reachable by at least one table row', () => {
    const reachable = new Set<NextAction>();
    for (const cls of ALL_FAILURE_CLASSES) {
      for (const phase of ALL_LIFECYCLE_PHASES) {
        for (const budget of Object.values(RetryBudget)) {
          try {
            reachable.add(routeFailure(key(cls, phase, budget)).nextAction);
          } catch {
            // ignore invalid combos
          }
        }
      }
    }
    for (const action of Object.values(NextAction)) {
      expect(reachable.has(action)).toBe(true);
    }
  });
});
