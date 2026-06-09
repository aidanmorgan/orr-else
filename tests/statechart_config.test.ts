/**
 * Tests for YAML statechart config: outcome classification, terminal detection,
 * FlowManager helpers, CoordinatorController, Scheduler, ConfigLoader validation.
 *
 * Two fixtures:
 *  - defaultConfig: statechart with SUCCESS/FAILURE/BLOCKED vocabulary and
 *    'completed' terminal state (mirrors harness.yaml defaults).
 *  - genericConfig: custom SDLC-agnostic statechart (Alpha→Bravo→done,
 *    outcomes ADVANCE/REWORK/HALT) to prove zero-code-edits portability.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  isTerminalState,
  outcomeCategory,
  isAdvanceOutcome,
  isDeclaredOutcome,
  assertDeclaredOutcome,
  declaredOutcomeVocabulary
} from '../src/core/FlowManager.js';
import {
  teammateEventTypeForOutcome,
  shouldPersistBlockedBeadStatus
} from '../src/extension/CoordinatorController.js';
import { Scheduler } from '../src/core/Scheduler.js';
import { FlowManager } from '../src/core/FlowManager.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { evaluateGateReadiness } from '../src/extension/WorkerRunController.js';
import { BeadStatus, EventName, TeammateEventType } from '../src/constants/domain.js';
import type { HarnessConfig } from '../src/core/ConfigLoader.js';
import type { SDLCState } from '../src/core/domain/StateModels.js';
import type { ActiveRun } from '../src/extension/SessionTypes.js';

// ── Shared fixture helpers ────────────────────────────────────────────────────

/**
 * Minimal HarnessConfig with the standard SUCCESS/FAILURE/BLOCKED vocabulary.
 *
 * Mirrors the harness.yaml defaults: SUCCESS→advance, FAILURE→failed,
 * BLOCKED→blocked, terminal state 'completed'. Statechart block is now
 * required; this fixture includes it so tests remain behaviorally equivalent.
 */
function makeDefaultConfig(overrides: Partial<HarnessConfig['statechart']> = {}): HarnessConfig {
  return {
    settings: {
      maxConcurrentSlots: 2,
      handoverTemplate: 'test',
      agentTurnTimeoutMs: 3600000,
      processReapIntervalMs: 60000,
      startState: 'Planning',
      harnessRestartEvent: EventName.HARNESS_RESTART,
      contextRestartEvent: EventName.CONTEXT_RESTART,
      defaultModel: 'gpt-4',
      defaultProvider: 'openai',
      modelProviders: {},
      stateContextRotThreshold: 10,
      harnessContextRotThreshold: 5
    },
    scheduler: { weights: { waitTime: 1, executionTime: 0.5, progress: 2, penalty: 1 } },
    statechart: {
      terminalStates: [BeadStatus.COMPLETED],
      advanceOutcomes: [EventName.SUCCESS],
      failedOutcomes: [EventName.FAILURE],
      blockedOutcomes: [EventName.BLOCKED],
      customOutcomes: [],
      ...overrides
    },
    states: {
      Planning: { transitions: { SUCCESS: 'Implementation', FAILURE: 'Planning', BLOCKED: 'Planning' }, on: {} } as any,
      Implementation: { transitions: { SUCCESS: 'completed', FAILURE: 'Planning', BLOCKED: 'Planning' }, on: {} } as any
    }
  } as unknown as HarnessConfig;
}

/**
 * Generic non-SDLC statechart:
 *   states: Alpha → Bravo → done
 *   outcomes: ADVANCE (advance), REWORK (failed), HALT (blocked)
 *   terminal: done
 */
function makeGenericConfig(): HarnessConfig {
  return {
    settings: {
      maxConcurrentSlots: 2,
      handoverTemplate: 'test',
      agentTurnTimeoutMs: 3600000,
      processReapIntervalMs: 60000,
      startState: 'Alpha',
      harnessRestartEvent: 'HARNESS_RESTART',
      contextRestartEvent: 'CONTEXT_RESTART',
      defaultModel: 'gpt-4',
      defaultProvider: 'openai',
      modelProviders: {},
      stateContextRotThreshold: 10,
      harnessContextRotThreshold: 5
    },
    scheduler: { weights: { waitTime: 1, executionTime: 0.5, progress: 2, penalty: 1 } },
    statechart: {
      initialState: 'Alpha',
      terminalStates: ['done'],
      advanceOutcomes: ['ADVANCE'],
      failedOutcomes: ['REWORK'],
      blockedOutcomes: ['HALT'],
      customOutcomes: []
    },
    states: {
      Alpha: { transitions: { ADVANCE: 'Bravo', REWORK: 'Alpha', HALT: 'done' }, on: {} } as any,
      Bravo: { transitions: { ADVANCE: 'done', REWORK: 'Alpha', HALT: 'done' }, on: {} } as any
    }
  } as unknown as HarnessConfig;
}

// ── FlowManager.isTerminalState ───────────────────────────────────────────────

describe('FlowManager.isTerminalState', () => {
  it('default config: "completed" is terminal', () => {
    expect(isTerminalState(BeadStatus.COMPLETED, makeDefaultConfig())).toBe(true);
  });

  it('default config: "Planning" is NOT terminal', () => {
    expect(isTerminalState('Planning', makeDefaultConfig())).toBe(false);
  });

  it('generic config: "done" is terminal', () => {
    expect(isTerminalState('done', makeGenericConfig())).toBe(true);
  });

  it('generic config: "Alpha" is NOT terminal', () => {
    expect(isTerminalState('Alpha', makeGenericConfig())).toBe(false);
  });

  it('generic config: "completed" is NOT terminal (only "done" is)', () => {
    expect(isTerminalState(BeadStatus.COMPLETED, makeGenericConfig())).toBe(false);
  });
});

// ── FlowManager.outcomeCategory ───────────────────────────────────────────────

describe('FlowManager.outcomeCategory', () => {
  describe('default config (SUCCESS/FAILURE/BLOCKED vocabulary)', () => {
    const cfg = makeDefaultConfig();

    it('SUCCESS → advance', () => expect(outcomeCategory('SUCCESS', cfg)).toBe('advance'));
    it('FAILURE → failed', () => expect(outcomeCategory('FAILURE', cfg)).toBe('failed'));
    it('BLOCKED → blocked', () => expect(outcomeCategory('BLOCKED', cfg)).toBe('blocked'));
    it('unknown outcome → failed (fail-closed; no advance fallback)', () => {
      expect(outcomeCategory('SOMETHING_ELSE', cfg)).toBe('failed');
    });
    it('case-insensitive: "success" → advance', () => {
      expect(outcomeCategory('success', cfg)).toBe('advance');
    });
  });

  describe('generic config', () => {
    const cfg = makeGenericConfig();

    it('ADVANCE → advance', () => expect(outcomeCategory('ADVANCE', cfg)).toBe('advance'));
    it('REWORK → failed', () => expect(outcomeCategory('REWORK', cfg)).toBe('failed'));
    it('HALT → blocked', () => expect(outcomeCategory('HALT', cfg)).toBe('blocked'));
    it('SUCCESS is NOT in generic config vocabulary → classified as failed (strict mode)', () => {
      // SUCCESS is not in any declared set.  In strict mode (explicit vocab declared)
      // an undeclared outcome is classified as 'failed', not 'advance', so it can
      // never count as progress (this is the root-cause fix for pi-experiment-lgwk).
      expect(outcomeCategory('SUCCESS', cfg)).toBe('failed');
    });
  });
});

// ── FlowManager.isAdvanceOutcome ──────────────────────────────────────────────

describe('FlowManager.isAdvanceOutcome', () => {
  describe('default config', () => {
    const cfg = makeDefaultConfig();
    it('SUCCESS is advance', () => expect(isAdvanceOutcome('SUCCESS', cfg)).toBe(true));
    it('FAILURE is not advance', () => expect(isAdvanceOutcome('FAILURE', cfg)).toBe(false));
    it('BLOCKED is not advance', () => expect(isAdvanceOutcome('BLOCKED', cfg)).toBe(false));
  });

  describe('generic config', () => {
    const cfg = makeGenericConfig();
    it('ADVANCE is advance', () => expect(isAdvanceOutcome('ADVANCE', cfg)).toBe(true));
    it('REWORK is not advance', () => expect(isAdvanceOutcome('REWORK', cfg)).toBe(false));
    it('HALT is not advance', () => expect(isAdvanceOutcome('HALT', cfg)).toBe(false));
  });
});

// ── CoordinatorController.teammateEventTypeForOutcome ─────────────────────────

describe('CoordinatorController.teammateEventTypeForOutcome', () => {
  describe('default config', () => {
    const cfg = makeDefaultConfig();
    it('SUCCESS → STATE_TRANSITIONED', () => {
      expect(teammateEventTypeForOutcome('SUCCESS', cfg)).toBe(TeammateEventType.STATE_TRANSITIONED);
    });
    it('FAILURE → STATE_FAILED', () => {
      expect(teammateEventTypeForOutcome('FAILURE', cfg)).toBe(TeammateEventType.STATE_FAILED);
    });
    it('BLOCKED → STATE_BLOCKED', () => {
      expect(teammateEventTypeForOutcome('BLOCKED', cfg)).toBe(TeammateEventType.STATE_BLOCKED);
    });
  });

  describe('generic config', () => {
    const cfg = makeGenericConfig();
    it('ADVANCE → STATE_TRANSITIONED', () => {
      expect(teammateEventTypeForOutcome('ADVANCE', cfg)).toBe(TeammateEventType.STATE_TRANSITIONED);
    });
    it('REWORK → STATE_FAILED', () => {
      expect(teammateEventTypeForOutcome('REWORK', cfg)).toBe(TeammateEventType.STATE_FAILED);
    });
    it('HALT → STATE_BLOCKED', () => {
      expect(teammateEventTypeForOutcome('HALT', cfg)).toBe(TeammateEventType.STATE_BLOCKED);
    });
  });
});

// ── Scheduler progress scores ─────────────────────────────────────────────────

describe('Scheduler with custom terminal state', () => {
  function makeScheduler(cfg: HarnessConfig): Scheduler {
    const configLoader = { load: () => cfg };
    return new Scheduler(configLoader as any, new FlowManager());
  }

  it('generic config: Alpha and Bravo both receive a non-zero progress score', async () => {
    // Uses a linear graph without shortcut edges so BFS distances are clear:
    // Alpha → Bravo → done  (ADVANCE only, no shortcuts to done from Alpha)
    const cfg = makeGenericConfig();
    // Override states to remove HALT (direct Alpha→done shortcut)
    cfg.states = {
      Alpha: { transitions: { ADVANCE: 'Bravo', REWORK: 'Alpha' }, on: {} } as any,
      Bravo: { transitions: { ADVANCE: 'done', REWORK: 'Alpha' }, on: {} } as any
    };

    const beads: any[] = [
      { id: 'b-alpha', status: 'Alpha', lastActivity: new Date().toISOString() },
      { id: 'b-bravo', status: 'Bravo', lastActivity: new Date().toISOString() }
    ];
    const sorted = await makeScheduler(cfg).sortBacklog(beads);
    const alphaScore = sorted.find(b => b.id === 'b-alpha')!.score;
    const bravoScore = sorted.find(b => b.id === 'b-bravo')!.score;

    // Both should be defined numbers
    expect(typeof alphaScore).toBe('number');
    expect(typeof bravoScore).toBe('number');

    // BFS from 'done': Bravo is at distance 1, Alpha at distance 2.
    // The progress weight ensures Bravo scores higher.
    expect(bravoScore).toBeGreaterThan(alphaScore);
  });

  it('default config: Implementation (closer to completed) scores higher than Planning', async () => {
    const cfg = makeDefaultConfig();
    const beads: any[] = [
      { id: 'b-plan', status: 'Planning', lastActivity: new Date().toISOString() },
      { id: 'b-impl', status: 'Implementation', lastActivity: new Date().toISOString() }
    ];
    const sorted = await makeScheduler(cfg).sortBacklog(beads);
    expect(sorted[0].id).toBe('b-impl');
  });
});

// ── ConfigLoader semantic validation ──────────────────────────────────────────

describe('ConfigLoader semantic validation', () => {
  const tempPath = path.join(process.cwd(), 'temp_statechart_test.yaml');

  afterEach(() => {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  });

  it('DEFAULT harness.yaml still validates and loads (golden test)', () => {
    const loader = new ConfigLoader();
    // Should NOT throw — harness.yaml has a statechart block with matching terminal
    expect(() => loader.load()).not.toThrow();
    const cfg = loader.load();
    expect(cfg.statechart?.terminalStates).toEqual(['completed']);
    expect(cfg.statechart?.advanceOutcomes).toEqual(['SUCCESS']);
    expect(cfg.statechart?.failedOutcomes).toEqual(['FAILURE']);
    expect(cfg.statechart?.blockedOutcomes).toEqual(['BLOCKED']);
  });

  it('throws when a transition target is not in states or terminals (statechart block present)', () => {
    const yaml = `
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test"
  defaultModel: "m1"
  startState: Alpha
  worktreePolicy:
    default: always
statechart:
  terminalStates: [done]
  advanceOutcomes: [ADVANCE]
  failedOutcomes: [REWORK]
  blockedOutcomes: [HALT]
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states:
  Alpha:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      - id: a1
        type: prompt
    transitions: { ADVANCE: "Nonexistent", REWORK: "Alpha" }
`;
    fs.writeFileSync(tempPath, yaml);
    expect(() => new ConfigLoader().load(tempPath)).toThrow(/not a defined state, declared terminal state, or recognized coarse sink status/);
  });

  it('accepts valid generic config (Alpha→Bravo→done)', () => {
    const yaml = `
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test"
  defaultModel: "m1"
  startState: Alpha
  worktreePolicy:
    default: always
statechart:
  terminalStates: [done]
  advanceOutcomes: [ADVANCE]
  failedOutcomes: [REWORK]
  blockedOutcomes: [HALT]
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states:
  Alpha:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      - id: a1
        type: prompt
    transitions: { ADVANCE: "Bravo", REWORK: "Alpha", HALT: "done" }
  Bravo:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      - id: a1
        type: prompt
    transitions: { ADVANCE: "done", REWORK: "Alpha", HALT: "done" }
`;
    fs.writeFileSync(tempPath, yaml);
    expect(() => new ConfigLoader().load(tempPath)).not.toThrow();
    const cfg = new ConfigLoader().load(tempPath);
    expect(cfg.statechart?.terminalStates).toEqual(['done']);
  });

  it('rejects config WITHOUT statechart block (statechart is now mandatory)', () => {
    const yaml = `
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test"
  defaultModel: "m1"
  startState: Alpha
  worktreePolicy:
    default: always
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states:
  Alpha:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      - id: a1
        type: prompt
    transitions: { SUCCESS: "done", FAILURE: "Alpha" }
`;
    fs.writeFileSync(tempPath, yaml);
    // No statechart block → startup-fatal error (legacy mode removed)
    expect(() => new ConfigLoader().load(tempPath))
      .toThrow(/statechart block is required|no-statechart legacy mode/i);
  });
});

// ── Default-equivalence / GOLDEN test ────────────────────────────────────────

describe('Default-equivalence golden tests', () => {
  const cfg = makeDefaultConfig();

  it('outcomeCategory with default config classifies declared outcomes correctly', () => {
    // Declared advance: SUCCESS → advance
    expect(isAdvanceOutcome(EventName.SUCCESS, cfg)).toBe(true);
    // Declared failed: FAILURE → failed (STATE_FAILED)
    expect(outcomeCategory(EventName.FAILURE, cfg)).toBe('failed');
    // Declared blocked: BLOCKED → blocked (STATE_BLOCKED)
    expect(outcomeCategory(EventName.BLOCKED, cfg)).toBe('blocked');
    // Undeclared outcome → failed (fail-closed; old "advance fallback" removed)
    expect(outcomeCategory('SOME_OTHER', cfg)).toBe('failed');
  });

  it('isTerminalState with default config reproduces old nextState === BeadStatus.COMPLETED check', () => {
    // Old code: nextState === 'completed'
    expect(isTerminalState('completed', cfg)).toBe(true);
    expect(isTerminalState('Planning', cfg)).toBe(false);
    expect(isTerminalState('Implementation', cfg)).toBe(false);
  });

  it('GOLDEN: AdversarialPostReview→completed is a terminal+advance combination', () => {
    // Reproduces the key check: nextState === BeadStatus.COMPLETED && transitionEvent === EventName.SUCCESS
    // Now expressed as: isTerminalState(nextState, config) && isAdvanceOutcome(transitionEvent, config)
    const nextState = BeadStatus.COMPLETED;  // 'completed'
    const transitionEvent = EventName.SUCCESS;  // 'SUCCESS'
    expect(isTerminalState(nextState, cfg) && isAdvanceOutcome(transitionEvent, cfg)).toBe(true);

    // The merge/close branch should NOT fire for non-terminal next states
    expect(isTerminalState('AdversarialPostReview', cfg) && isAdvanceOutcome(transitionEvent, cfg)).toBe(false);
    // Or for non-advance outcomes
    expect(isTerminalState(nextState, cfg) && isAdvanceOutcome(EventName.FAILURE, cfg)).toBe(false);
  });
});

// ── evaluateGateReadiness: SUCCESS still gates (default config) ───────────────

describe('evaluateGateReadiness gates with default config', () => {
  it('isAdvanceOutcome(SUCCESS, defaultConfig) is true — gates would fire', () => {
    // This is the critical property: with default config, SUCCESS triggers
    // all advance-outcome gates (checklist, required tools, write-set, provenance)
    // exactly as `outcome === EventName.SUCCESS` did before.
    const cfg = makeDefaultConfig();
    expect(isAdvanceOutcome('SUCCESS', cfg)).toBe(true);
    expect(isAdvanceOutcome('FAILURE', cfg)).toBe(false);
    expect(isAdvanceOutcome('BLOCKED', cfg)).toBe(false);
  });

  it('isAdvanceOutcome(ADVANCE, genericConfig) is true — custom advance triggers gates', () => {
    // Custom advance outcomes must ALSO trigger gates (closes latent bypass)
    const cfg = makeGenericConfig();
    expect(isAdvanceOutcome('ADVANCE', cfg)).toBe(true);
    expect(isAdvanceOutcome('REWORK', cfg)).toBe(false);
    expect(isAdvanceOutcome('HALT', cfg)).toBe(false);
  });
});

// ── SHOULD-FIX 1: null-safety — falsy/missing transitionEvent ─────────────────

describe('null-safety: falsy/missing transitionEvent', () => {
  const defaultCfg = makeDefaultConfig();
  const genericCfg = makeGenericConfig();

  // isAdvanceOutcome must return false for falsy/missing outcomes (old literal-
  // comparison semantics: `undefined === 'SUCCESS'` was false → no action-completion).

  it('isAdvanceOutcome(undefined) → false (default config)', () => {
    expect(isAdvanceOutcome(undefined as any, defaultCfg)).toBe(false);
  });

  it('isAdvanceOutcome(null) → false (default config)', () => {
    expect(isAdvanceOutcome(null as any, defaultCfg)).toBe(false);
  });

  it('isAdvanceOutcome("") → false (default config)', () => {
    expect(isAdvanceOutcome('' as any, defaultCfg)).toBe(false);
  });

  it('isAdvanceOutcome(undefined) → false (generic config)', () => {
    expect(isAdvanceOutcome(undefined as any, genericCfg)).toBe(false);
  });

  // outcomeCategory with a falsy outcome → 'failed' (fail-closed; no advance fallback).
  // teammateEventTypeForOutcome(falsy) → STATE_FAILED (fail-closed).

  it('outcomeCategory(undefined) → "failed" (fail-closed; no advance fallback)', () => {
    expect(outcomeCategory(undefined as any, defaultCfg)).toBe('failed');
  });

  it('outcomeCategory("") → "failed" (fail-closed; no advance fallback)', () => {
    expect(outcomeCategory('' as any, defaultCfg)).toBe('failed');
  });

  it('teammateEventTypeForOutcome(undefined) → STATE_FAILED (fail-closed)', () => {
    expect(teammateEventTypeForOutcome(undefined as any, defaultCfg)).toBe(TeammateEventType.STATE_FAILED);
  });

  it('teammateEventTypeForOutcome("") → STATE_FAILED (fail-closed)', () => {
    expect(teammateEventTypeForOutcome('' as any, defaultCfg)).toBe(TeammateEventType.STATE_FAILED);
  });
});

// ── Coarse-sink transition targets ────────────────────────────────────────────

describe('Coarse-sink transition targets: ConfigLoader + shouldPersistBlockedBeadStatus', () => {
  /**
   * Config with a 'blocked' coarse-sink transition target, matching the real
   * cerdiwen pattern: AdversarialPostReview --EXTERNAL_BLOCKER--> blocked.
   */
  function makeCoarseSinkConfig(): HarnessConfig {
    return {
      settings: {
        maxConcurrentSlots: 2,
        handoverTemplate: 'test',
        agentTurnTimeoutMs: 3600000,
        processReapIntervalMs: 60000,
        startState: 'Planning',
        harnessRestartEvent: EventName.HARNESS_RESTART,
        contextRestartEvent: EventName.CONTEXT_RESTART,
        defaultModel: 'gpt-4',
        defaultProvider: 'openai',
        modelProviders: {},
        stateContextRotThreshold: 10,
        harnessContextRotThreshold: 5
      },
      scheduler: { weights: { waitTime: 1, executionTime: 0.5, progress: 2, penalty: 1 } },
      statechart: {
        initialState: 'Planning',
        terminalStates: ['completed'],
        advanceOutcomes: ['SUCCESS'],
        failedOutcomes: ['FAILURE'],
        blockedOutcomes: ['EXTERNAL_BLOCKER'],
        customOutcomes: []
      },
      states: {
        Planning: { transitions: { SUCCESS: 'AdversarialPostReview', FAILURE: 'Planning' }, on: {} } as any,
        AdversarialPostReview: {
          transitions: { SUCCESS: 'completed', FAILURE: 'Planning', EXTERNAL_BLOCKER: 'blocked' },
          on: {}
        } as any
      }
    } as unknown as HarnessConfig;
  }

  it('outcomeCategory of EXTERNAL_BLOCKER is "blocked" (declared in blockedOutcomes)', () => {
    const cfg = makeCoarseSinkConfig();
    expect(outcomeCategory('EXTERNAL_BLOCKER', cfg)).toBe('blocked');
  });

  it('shouldPersistBlockedBeadStatus with STATE_BLOCKED + "blocked" nextState → true', () => {
    const cfg = makeCoarseSinkConfig();
    expect(shouldPersistBlockedBeadStatus(TeammateEventType.STATE_BLOCKED, BeadStatus.BLOCKED, cfg)).toBe(true);
  });

  it('shouldPersistBlockedBeadStatus with STATE_BLOCKED event type (any nextState) → true', () => {
    const cfg = makeCoarseSinkConfig();
    expect(shouldPersistBlockedBeadStatus(TeammateEventType.STATE_BLOCKED, 'AdversarialPostReview', cfg)).toBe(true);
  });

  it('shouldPersistBlockedBeadStatus with nextState === "blocked" (any event type) → true', () => {
    const cfg = makeCoarseSinkConfig();
    // Even if event type is STATE_FAILED, nextState === 'blocked' triggers BLOCKED coarse status
    expect(shouldPersistBlockedBeadStatus(TeammateEventType.STATE_FAILED, BeadStatus.BLOCKED, cfg)).toBe(true);
  });
});

// ── Scheduler robustness with non-state transition targets ────────────────────

describe('Scheduler robustness with coarse-sink transition targets', () => {
  function makeSchedulerWithBlockedTarget(): Scheduler {
    const cfg = {
      scheduler: { weights: { waitTime: 1.0, executionTime: 0.5, progress: 2.0, penalty: 1.0 } },
      settings: { startState: 'Planning' },
      statechart: { terminalStates: ['completed'] },
      states: {
        Planning: {
          transitions: { SUCCESS: 'Implementation', EXTERNAL_BLOCKER: 'blocked' },
          on: {}
        },
        Implementation: {
          transitions: { SUCCESS: 'completed', FAILURE: 'Planning', EXTERNAL_BLOCKER: 'blocked' },
          on: {}
        }
      }
    };
    const configLoader = { load: () => cfg };
    return new Scheduler(configLoader as any, new FlowManager());
  }

  it('sortBacklog produces finite non-NaN scores for real states when a "blocked" coarse-sink target exists in transitions', async () => {
    const sched = makeSchedulerWithBlockedTarget();
    const beads: any[] = [
      { id: 'b-planning', status: 'Planning', lastActivity: new Date().toISOString() },
      { id: 'b-impl', status: 'Implementation', lastActivity: new Date().toISOString() }
    ];
    const sorted = await sched.sortBacklog(beads);

    for (const bead of sorted) {
      expect(typeof bead.score).toBe('number');
      expect(isFinite(bead.score)).toBe(true);
      expect(isNaN(bead.score)).toBe(false);
    }
  });

  it('Implementation (closer to completed) scores higher than Planning even when "blocked" is a transition target', async () => {
    const sched = makeSchedulerWithBlockedTarget();
    const beads: any[] = [
      { id: 'b-planning', status: 'Planning', lastActivity: new Date().toISOString() },
      { id: 'b-impl', status: 'Implementation', lastActivity: new Date().toISOString() }
    ];
    const sorted = await sched.sortBacklog(beads);
    expect(sorted[0].id).toBe('b-impl');
  });
});

// ── SHOULD-FIX 2: shouldPersistBlockedBeadStatus — default + STATE_BLOCKED ────

describe('shouldPersistBlockedBeadStatus — default and custom cases', () => {
  const cfg = makeDefaultConfig();

  it('STATE_BLOCKED event type → true (default config)', () => {
    expect(shouldPersistBlockedBeadStatus(TeammateEventType.STATE_BLOCKED, 'Planning', cfg)).toBe(true);
  });

  it('nextState === BLOCKED → true regardless of event type', () => {
    expect(shouldPersistBlockedBeadStatus(TeammateEventType.STATE_FAILED, BeadStatus.BLOCKED, cfg)).toBe(true);
  });

  it('STATE_FAILED event + non-blocked nextState → false (default config)', () => {
    expect(shouldPersistBlockedBeadStatus(TeammateEventType.STATE_FAILED, 'Planning', cfg)).toBe(false);
  });

  it('STATE_TRANSITIONED event + non-blocked nextState → false (default config)', () => {
    expect(shouldPersistBlockedBeadStatus(TeammateEventType.STATE_TRANSITIONED, 'Implementation', cfg)).toBe(false);
  });

  it('generic config: STATE_BLOCKED + non-blocked nextState → true', () => {
    const genericCfg = makeGenericConfig();
    expect(shouldPersistBlockedBeadStatus(TeammateEventType.STATE_BLOCKED, 'Alpha', genericCfg)).toBe(true);
  });

  it('generic config: nextState === BLOCKED → true', () => {
    const genericCfg = makeGenericConfig();
    expect(shouldPersistBlockedBeadStatus(TeammateEventType.STATE_FAILED, BeadStatus.BLOCKED, genericCfg)).toBe(true);
  });
});

// ── Strict statechart outcome vocabulary ──────────────────────────────────────
// AC1: ConfigLoader fails on undeclared outcome in transition (strict mode)
// AC2: isDeclaredOutcome / assertDeclaredOutcome reject undeclared outcomes
// AC3: Typo like SECURITY_FAILUER is rejected in strict mode
// AC4: Legacy configs (no statechart block) preserve permissive behavior

describe('Strict statechart outcome vocabulary: declaredOutcomeVocabulary + isDeclaredOutcome + assertDeclaredOutcome', () => {
  // ── AC2 / AC3: isDeclaredOutcome ──────────────────────────────────────────
  it('AC2: isDeclaredOutcome returns true for every declared outcome in strict config', () => {
    const cfg = makeGenericConfig(); // statechart block with ADVANCE/REWORK/HALT
    expect(isDeclaredOutcome('ADVANCE', cfg)).toBe(true);
    expect(isDeclaredOutcome('REWORK', cfg)).toBe(true);
    expect(isDeclaredOutcome('HALT', cfg)).toBe(true);
  });

  it('AC2: isDeclaredOutcome returns false for an outcome not in the vocabulary (strict config)', () => {
    const cfg = makeGenericConfig();
    expect(isDeclaredOutcome('SUCCESS', cfg)).toBe(false); // not declared in genericConfig
    expect(isDeclaredOutcome('UNKNOWN_OUTCOME', cfg)).toBe(false);
  });

  it('AC3: SECURITY_FAILUER (typo) is not declared in a strict config that declares SECURITY_FAILURE', () => {
    const cfg: HarnessConfig = {
      ...makeDefaultConfig(),
      statechart: {
        terminalStates: ['completed'],
        advanceOutcomes: ['SUCCESS'],
        failedOutcomes: ['FAILURE', 'SECURITY_FAILURE'],
        blockedOutcomes: ['BLOCKED'],
        customOutcomes: []
      }
    } as unknown as HarnessConfig;
    expect(isDeclaredOutcome('SECURITY_FAILURE', cfg)).toBe(true);
    expect(isDeclaredOutcome('SECURITY_FAILUER', cfg)).toBe(false); // typo
  });

  it('AC4: isDeclaredOutcome only returns true for declared outcomes (no-statechart permissive removed)', () => {
    const cfg = makeDefaultConfig(); // SUCCESS/FAILURE/BLOCKED vocabulary
    expect(isDeclaredOutcome('SUCCESS', cfg)).toBe(true);
    expect(isDeclaredOutcome('FAILURE', cfg)).toBe(true);
    expect(isDeclaredOutcome('BLOCKED', cfg)).toBe(true);
    // Undeclared outcomes are NOT valid — fail-closed
    expect(isDeclaredOutcome('ANY_TYPO_OUTCOME', cfg)).toBe(false);
    expect(isDeclaredOutcome('SECURITY_FAILUER', cfg)).toBe(false);
  });

  it('AC2: assertDeclaredOutcome throws for undeclared outcome in strict mode', () => {
    const cfg = makeGenericConfig();
    expect(() => assertDeclaredOutcome('UNKNOWN', cfg, 'state "Alpha"')).toThrow(
      /Outcome "UNKNOWN" is not in the declared statechart vocabulary/
    );
  });

  it('AC2: assertDeclaredOutcome throws with the offending outcome and context in the message', () => {
    const cfg = makeGenericConfig();
    expect(() => assertDeclaredOutcome('SECURITY_FAILUER', cfg, 'state "Implementation"')).toThrow(
      /SECURITY_FAILUER.*state "Implementation"/
    );
  });

  it('AC3: assertDeclaredOutcome names the offending outcome key and the declared vocabulary', () => {
    const cfg = makeGenericConfig();
    let caught: Error | undefined;
    try {
      assertDeclaredOutcome('SECURITY_FAILUER', cfg, 'state "Planning"');
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/SECURITY_FAILUER/);
    expect(caught!.message).toMatch(/Declared outcomes:/);
  });

  it('AC4: assertDeclaredOutcome throws for undeclared outcomes (no legacy no-op)', () => {
    const cfg = makeDefaultConfig(); // SUCCESS/FAILURE/BLOCKED vocabulary
    expect(() => assertDeclaredOutcome('ANY_UNKNOWN', cfg, 'state "Planning"'))
      .toThrow(/Outcome "ANY_UNKNOWN" is not in the declared statechart vocabulary/);
  });

  it('AC2: declaredOutcomeVocabulary returns the declared set for default config (not null)', () => {
    const cfg = makeDefaultConfig(); // SUCCESS/FAILURE/BLOCKED vocabulary
    const vocab = declaredOutcomeVocabulary(cfg);
    expect(vocab).not.toBeNull();
    expect(vocab!.has('SUCCESS')).toBe(true);
    expect(vocab!.has('FAILURE')).toBe(true);
    expect(vocab!.has('BLOCKED')).toBe(true);
  });

  it('AC2: declaredOutcomeVocabulary returns the full declared set for strict config', () => {
    const cfg = makeGenericConfig();
    const vocab = declaredOutcomeVocabulary(cfg);
    expect(vocab).not.toBeNull();
    expect(vocab!.has('ADVANCE')).toBe(true);
    expect(vocab!.has('REWORK')).toBe(true);
    expect(vocab!.has('HALT')).toBe(true);
  });

  it('Restart events are always considered declared regardless of mode', () => {
    const cfg = makeGenericConfig(); // strict config, only ADVANCE/REWORK/HALT declared
    expect(isDeclaredOutcome('HARNESS_RESTART', cfg)).toBe(true);
    expect(isDeclaredOutcome('CONTEXT_RESTART', cfg)).toBe(true);
  });
});

// ── AC1: ConfigLoader strict validation — undeclared transition outcome → throw ─
describe('ConfigLoader strict validation: undeclared transition outcome throws (AC1)', () => {
  const tempPath = path.join(process.cwd(), 'temp_strict_vocab_test.yaml');

  afterEach(() => {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  });

  it('AC1: throws when a transition uses an outcome key not in the declared vocabulary', () => {
    const yaml = `
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test"
  defaultModel: "m1"
  startState: Alpha
  worktreePolicy:
    default: always
statechart:
  terminalStates: [done]
  advanceOutcomes: [ADVANCE]
  failedOutcomes: [REWORK]
  blockedOutcomes: [HALT]
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states:
  Alpha:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      - id: a1
        type: prompt
    transitions: { ADVANCE: "Bravo", REWORK: "Alpha", UNDECLARED_OUTCOME: "done" }
  Bravo:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      - id: a1
        type: prompt
    transitions: { ADVANCE: "done", REWORK: "Alpha", HALT: "done" }
`;
    fs.writeFileSync(tempPath, yaml);
    expect(() => new ConfigLoader().load(tempPath)).toThrow(
      /UNDECLARED_OUTCOME.*not in the declared statechart vocabulary/
    );
  });

  it('AC3: throws when a transition uses a typo outcome (SECURITY_FAILUER instead of SECURITY_FAILURE)', () => {
    const yaml = `
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test"
  defaultModel: "m1"
  startState: Alpha
  worktreePolicy:
    default: always
statechart:
  terminalStates: [done]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE, SECURITY_FAILURE]
  blockedOutcomes: [BLOCKED]
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states:
  Alpha:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      - id: a1
        type: prompt
    transitions: { SUCCESS: "done", SECURITY_FAILUER: "done" }
`;
    fs.writeFileSync(tempPath, yaml);
    expect(() => new ConfigLoader().load(tempPath)).toThrow(/SECURITY_FAILUER/);
  });

  it('AC4: config without statechart block is rejected (no legacy permissive mode)', () => {
    const yaml = `
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test"
  defaultModel: "m1"
  startState: Alpha
  worktreePolicy:
    default: always
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states:
  Alpha:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      - id: a1
        type: prompt
    transitions: { SUCCESS: "done", ANY_TYPO_OUTCOME: "done" }
`;
    fs.writeFileSync(tempPath, yaml);
    // No statechart block → startup-fatal error (no legacy mode)
    expect(() => new ConfigLoader().load(tempPath))
      .toThrow(/statechart block is required|no-statechart legacy mode/i);
  });

  it('AC1: config with fully declared vocabulary passes validation', () => {
    const yaml = `
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test"
  defaultModel: "m1"
  startState: Alpha
  worktreePolicy:
    default: always
statechart:
  terminalStates: [done]
  advanceOutcomes: [ADVANCE]
  failedOutcomes: [REWORK]
  blockedOutcomes: [HALT]
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states:
  Alpha:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      - id: a1
        type: prompt
    transitions: { ADVANCE: "Bravo", REWORK: "Alpha", HALT: "done" }
  Bravo:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      - id: a1
        type: prompt
    transitions: { ADVANCE: "done", REWORK: "Alpha", HALT: "done" }
`;
    fs.writeFileSync(tempPath, yaml);
    expect(() => new ConfigLoader().load(tempPath)).not.toThrow();
  });

  // Finding 3 (inverted): statechart block with ONLY terminalStates is now rejected —
  // explicit outcome vocabulary is required.
  it('Finding-3/AC4: statechart block with ONLY terminalStates (no vocab fields) is now rejected', () => {
    const yaml = `
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test"
  defaultModel: "m1"
  startState: Alpha
  worktreePolicy:
    default: always
statechart:
  terminalStates: [done]
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states:
  Alpha:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      - id: a1
        type: prompt
    transitions: { SUCCESS: "done", SOME_CUSTOM_TRANSITION: "done" }
`;
    fs.writeFileSync(tempPath, yaml);
    // No explicit vocab → startup-fatal error (explicit vocabulary is now required)
    expect(() => new ConfigLoader().load(tempPath))
      .toThrow(/statechart.*no explicit outcome vocabulary|explicit outcome vocabulary|advanceOutcomes.*failedOutcomes/i);
  });

  it('Finding-3: statechart block with ONLY terminalStates has null declaredOutcomeVocabulary (runtime helper)', () => {
    const cfg: HarnessConfig = {
      ...makeDefaultConfig(),
      statechart: {
        terminalStates: ['done']
        // No advanceOutcomes/failedOutcomes/blockedOutcomes/customOutcomes
      }
    } as unknown as HarnessConfig;
    // Runtime helper returns null for statechart-only-terminalStates (no explicit vocab)
    expect(declaredOutcomeVocabulary(cfg)).toBeNull();
    // isDeclaredOutcome returns true for the terminalStates-only case (null vocab = permissive)
    expect(isDeclaredOutcome('ANY_OUTCOME', cfg)).toBe(true);
    expect(isDeclaredOutcome('TYPO_OUTCOME', cfg)).toBe(true);
  });

  it('Finding-3: explicit vocab + undeclared outcome = still throws (strict mode)', () => {
    const yaml = `
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test"
  defaultModel: "m1"
  startState: Alpha
  worktreePolicy:
    default: always
statechart:
  terminalStates: [done]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states:
  Alpha:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      - id: a1
        type: prompt
    transitions: { SUCCESS: "done", UNDECLARED_OUTCOME: "done" }
`;
    fs.writeFileSync(tempPath, yaml);
    expect(() => new ConfigLoader().load(tempPath)).toThrow(/UNDECLARED_OUTCOME/);
  });
});

// ── AC2: gate-level regression — undeclared outcome in strict mode is REJECTED ──
//
// Proves that the actual binding path (evaluateGateReadiness) rejects an
// undeclared outcome in strict mode: ready=false, blockingEvidence names the
// offending outcome, transitionValid=false.  Uses the same mocking pattern as
// s3wp3_state_action_defaults.test.ts.

describe('AC2 gate-level: evaluateGateReadiness rejects undeclared outcome in strict mode', () => {
  /** Strict config: only ADVANCE/REWORK/HALT declared. */
  function makeStrictConfig(): HarnessConfig {
    return makeGenericConfig(); // advanceOutcomes:[ADVANCE], failedOutcomes:[REWORK], blockedOutcomes:[HALT]
  }

  /** Minimal services that pass every gate except the one under test. */
  function makePassthroughServices(config: HarnessConfig) {
    return {
      flowManager: {
        nextState: vi.fn().mockReturnValue('Bravo')
      },
      eventStore: {
        latestProjectToolFailureLimitEvent: vi.fn().mockResolvedValue(undefined),
        projectBead: vi.fn().mockResolvedValue({ checklists: {} }),
        eventsForBead: vi.fn().mockResolvedValue([
          {
            type: 'STATE_RUN_INITIALIZED',
            data: {
              beadId: 'bd-gate-test',
              stateId: 'Alpha',
              actionId: 'a1',
              promptProvenanceResolutionFailed: true // warn-only; doesn't block
            }
          }
        ])
      },
      requiredToolResolver: {
        resolve: vi.fn().mockResolvedValue({ toolNames: [] })
      },
      planWriteSet: {
        validatePlanContract: vi.fn().mockResolvedValue({ passed: true })
      },
      transactionalStateGuard: {
        validateSuccessReadOnly: vi.fn().mockResolvedValue({ passed: true })
      },
      configLoader: {
        load: vi.fn().mockResolvedValue(config),
        getConfigPath: vi.fn().mockReturnValue('/fake/harness.yaml')
      },
      projectRoot: '/fake/root'
    } as any;
  }

  function makeActiveRunStrict(overrides: Partial<ActiveRun> = {}): ActiveRun {
    const state: SDLCState = {
      id: 'Alpha',
      identity: { role: 'R', expertise: 'E', constraints: [] },
      actions: [{ id: 'a1', type: 'prompt' as any }],
      transitions: { ADVANCE: 'Bravo', REWORK: 'Alpha', HALT: 'done' }
    } as unknown as SDLCState;
    return {
      beadId: 'bd-gate-test',
      stateId: 'Alpha',
      state,
      action: { id: 'a1', type: 'prompt' as any } as any,
      requiredItems: [],
      startedAt: Date.now(),
      worklogManager: { appendEntry: vi.fn() } as any,
      checkpointAccepted: true,
      parentSequenceCompleted: false,
      completedActionIds: [],
      ...overrides
    };
  }

  it('AC2: undeclared outcome (SECURITY_FAILUER typo) in strict mode → ready=false, transitionValid=false', async () => {
    const config = makeStrictConfig();
    const services = makePassthroughServices(config);
    const run = makeActiveRunStrict();
    const obs = { getToolResult: vi.fn().mockReturnValue(undefined) } as any;

    const gate = await evaluateGateReadiness(run, 'SECURITY_FAILUER', services, { activeRun: run }, obs, config, true);

    expect(gate.ready).toBe(false);
    expect(gate.transitionValid).toBe(false);
    // blockingEvidence must name the offending outcome
    expect(gate.blockingEvidence.some(e => e.includes('SECURITY_FAILUER'))).toBe(true);
    // Undeclared outcome must NOT be treated as advance (the root-cause bug)
    expect(isAdvanceOutcome('SECURITY_FAILUER', config)).toBe(false);
  });

  it('AC2: undeclared outcome does not advance — isAdvanceOutcome returns false (always fail-closed)', () => {
    const config = makeStrictConfig();
    // Declared outcomes ARE advance
    expect(isAdvanceOutcome('ADVANCE', config)).toBe(true);
    // Undeclared outcomes are NOT advance (fail-closed)
    expect(isAdvanceOutcome('SECURITY_FAILUER', config)).toBe(false);
    expect(isAdvanceOutcome('UNKNOWN_OUTCOME', config)).toBe(false);
    // Default config: undeclared outcomes also fail closed (no advance fallback)
    const defaultCfg = makeDefaultConfig();
    expect(isAdvanceOutcome('SOME_TYPO', defaultCfg)).toBe(false);
  });

  it('AC2: declared outcomes in strict mode still classify correctly', async () => {
    const config = makeStrictConfig();
    const services = makePassthroughServices(config);
    const run = makeActiveRunStrict({ checkpointAccepted: true });
    const obs = { getToolResult: vi.fn().mockReturnValue(undefined) } as any;

    const gate = await evaluateGateReadiness(run, 'ADVANCE', services, { activeRun: run }, obs, config, true);

    // transitionValid=true: ADVANCE is declared and the flowManager mock returns 'Bravo'
    expect(gate.transitionValid).toBe(true);
    // No outcome-vocabulary blocking evidence
    expect(gate.blockingEvidence.some(e => e.includes('Undeclared'))).toBe(false);
  });
});

// ── AC7 runtime: missing/falsy outcomes fail closed in strict mode ────────────
//
// Proves the RUNTIME path (outcomeCategory → teammateEventTypeForOutcome) now
// fails closed on missing/falsy outcomes in strict mode (explicit vocabulary).
// The old dead-code gap: classifyOutcome returned FAILED but the runtime still
// called outcomeCategory() which returned 'advance' for falsy inputs.

describe('AC7 runtime: missing/falsy outcomes always fail closed (no legacy advance)', () => {
  const strictCfg = makeGenericConfig(); // advanceOutcomes:[ADVANCE], failedOutcomes:[REWORK], blockedOutcomes:[HALT]
  const defaultCfg = makeDefaultConfig(); // advanceOutcomes:[SUCCESS], failedOutcomes:[FAILURE], blockedOutcomes:[BLOCKED]

  // ── outcomeCategory (the function the runtime path actually calls) ──────────

  it('outcomeCategory(undefined, strictCfg) → "failed" (fail-closed, not "advance")', () => {
    expect(outcomeCategory(undefined as any, strictCfg)).toBe('failed');
  });

  it('outcomeCategory(null, strictCfg) → "failed" (fail-closed, not "advance")', () => {
    expect(outcomeCategory(null as any, strictCfg)).toBe('failed');
  });

  it('outcomeCategory("", strictCfg) → "failed" (fail-closed, not "advance")', () => {
    expect(outcomeCategory('' as any, strictCfg)).toBe('failed');
  });

  it('outcomeCategory(undefined, defaultCfg) → "failed" (fail-closed; no legacy advance fallback)', () => {
    expect(outcomeCategory(undefined as any, defaultCfg)).toBe('failed');
  });

  it('outcomeCategory("", defaultCfg) → "failed" (fail-closed; no legacy advance fallback)', () => {
    expect(outcomeCategory('' as any, defaultCfg)).toBe('failed');
  });

  // ── teammateEventTypeForOutcome (the runtime coordinator transition path) ───

  it('teammateEventTypeForOutcome(undefined, strictCfg) → STATE_FAILED (cannot advance)', () => {
    expect(teammateEventTypeForOutcome(undefined as any, strictCfg)).toBe(TeammateEventType.STATE_FAILED);
  });

  it('teammateEventTypeForOutcome("", strictCfg) → STATE_FAILED (cannot advance)', () => {
    expect(teammateEventTypeForOutcome('' as any, strictCfg)).toBe(TeammateEventType.STATE_FAILED);
  });

  it('teammateEventTypeForOutcome(undefined, defaultCfg) → STATE_FAILED (fail-closed; no legacy advance)', () => {
    expect(teammateEventTypeForOutcome(undefined as any, defaultCfg)).toBe(TeammateEventType.STATE_FAILED);
  });

  it('teammateEventTypeForOutcome("", defaultCfg) → STATE_FAILED (fail-closed; no legacy advance)', () => {
    expect(teammateEventTypeForOutcome('' as any, defaultCfg)).toBe(TeammateEventType.STATE_FAILED);
  });

  // ── declared outcomes still classify correctly (no over-fail-closing) ────────

  it('declared advance outcome still classifies as advance in strict mode', () => {
    expect(outcomeCategory('ADVANCE', strictCfg)).toBe('advance');
    expect(teammateEventTypeForOutcome('ADVANCE', strictCfg)).toBe(TeammateEventType.STATE_TRANSITIONED);
  });

  it('declared failed outcome still classifies as failed in strict mode', () => {
    expect(outcomeCategory('REWORK', strictCfg)).toBe('failed');
    expect(teammateEventTypeForOutcome('REWORK', strictCfg)).toBe(TeammateEventType.STATE_FAILED);
  });

  it('declared blocked outcome still classifies as blocked in strict mode', () => {
    expect(outcomeCategory('HALT', strictCfg)).toBe('blocked');
    expect(teammateEventTypeForOutcome('HALT', strictCfg)).toBe(TeammateEventType.STATE_BLOCKED);
  });
});
