/**
 * configLoader_v2_event_vocab.test.ts
 *
 * pi-experiment-cfzu: v2 category-first event vocabulary validation + exact transition-key admission.
 *
 * AC1: The v2 parser exposes a CLOSED event vocabulary derived only from events.advance/failure/blocked/neutral.
 * AC2: Event names are canonicalized (UPPER_SNAKE_CASE) with case-insensitive duplicate rejection
 *      within AND across categories.
 * AC3: State transition keys must be exact declared event names; category membership never supplies
 *      fallback routing. Runtime: v2ApplyTransition returns null when the state has no exact key
 *      even though the event is in the declared vocabulary.
 * AC4: Old outcome/custom-event fields (advanceOutcomes/failedOutcomes/blockedOutcomes/customOutcomes/
 *      statechart.customEvents) are rejected in v2 with deterministic replacement diagnostics.
 * AC5: Tests cover valid lookup, duplicate normalization, undeclared transition events,
 *      taxonomy-only category behavior, neutral exact routing, and old-field rejection.
 *
 * Each rejection test MUST FAIL if its check is removed (load-bearing).
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { buildV2EventVocabulary, v2ApplyTransition } from '../src/core/FlowManager.js';
import type { HarnessConfig } from '../src/core/ConfigLoader.js';
import type { SDLCState } from '../src/core/domain/StateModels.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_DIR = fs.mkdtempSync(path.join(process.env['TMPDIR'] ?? '/tmp', 'orr-else-cfzu-'));

function writeYaml(name: string, content: string): string {
  const p = path.join(TEST_DIR, name);
  fs.writeFileSync(p, content);
  return p;
}

afterEach(() => {
  for (const f of fs.readdirSync(TEST_DIR)) {
    try { fs.unlinkSync(path.join(TEST_DIR, f)); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// Minimal valid v2 fixture with events block.
// No advanceOutcomes/failedOutcomes/blockedOutcomes — those are v1 fields rejected in v2.
// ---------------------------------------------------------------------------
// pi-experiment-0dgy: v2 uses map-form actions (keys become canonical action IDs).
const MINIMAL_V2_WITH_EVENTS_YAML = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test handover"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: Implement
  terminal: [completed]
events:
  advance: [SUCCESS, QUALITY_PASSED]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: [REQUIREMENTS_CLARIFICATION_NEEDED]
states:
  Implement:
    identity: { role: "Implementer", expertise: "Coding", constraints: [] }
    baseInstructions: "Implement the task."
    actions:
      run_impl:
        type: prompt
        prompt: "Implement the requested changes."
    transitions:
      SUCCESS: completed
      FAILURE: Implement
      REQUIREMENTS_CLARIFICATION_NEEDED: Implement
`;

// ---------------------------------------------------------------------------
// AC1: v2 parser exposes a CLOSED event vocabulary
// ---------------------------------------------------------------------------
describe('pi-experiment-cfzu AC1: v2 closed event vocabulary', () => {
  it('S1: valid v2 fixture with events block loads and vocabulary is accessible', () => {
    const p = writeYaml('s1_valid_events.yaml', MINIMAL_V2_WITH_EVENTS_YAML);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    let config: HarnessConfig | undefined;
    expect(() => { config = loader.load(p); }).not.toThrow();

    expect(config).toBeDefined();
    expect(config!.version).toBe(2);
    expect(config!.events?.advance).toContain('SUCCESS');
    expect(config!.events?.advance).toContain('QUALITY_PASSED');
    expect(config!.events?.failure).toContain('FAILURE');
    expect(config!.events?.blocked).toContain('BLOCKED');
    expect(config!.events?.neutral).toContain('REQUIREMENTS_CLARIFICATION_NEEDED');
  });

  it('S1b: buildV2EventVocabulary returns all declared events with their categories', () => {
    const p = writeYaml('s1b_vocab_lookup.yaml', MINIMAL_V2_WITH_EVENTS_YAML);
    const loader = new ConfigLoader(undefined, TEST_DIR);
    const config = loader.load(p);

    const vocab = buildV2EventVocabulary(config);

    expect(vocab.get('SUCCESS')).toBe('advance');
    expect(vocab.get('QUALITY_PASSED')).toBe('advance');
    expect(vocab.get('FAILURE')).toBe('failure');
    expect(vocab.get('BLOCKED')).toBe('blocked');
    expect(vocab.get('REQUIREMENTS_CLARIFICATION_NEEDED')).toBe('neutral');
    // Undeclared event not present
    expect(vocab.has('UNKNOWN_EVENT')).toBe(false);
  });

  it('S1c: buildV2EventVocabulary returns empty map for v1 config (no events block)', () => {
    const v1yaml = `
settings:
  startState: Planning
  worktreePolicy:
    default: always
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan."
    actions:
      - id: plan
        type: prompt
    transitions: { SUCCESS: completed, FAILURE: Planning }
`;
    const p = writeYaml('s1c_v1_no_events.yaml', v1yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);
    const config = loader.load(p);

    const vocab = buildV2EventVocabulary(config);
    expect(vocab.size).toBe(0);
    expect(config.events).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC2: Canonicalization + case-insensitive duplicate rejection
// ---------------------------------------------------------------------------
describe('pi-experiment-cfzu AC2: canonicalization + duplicate rejection', () => {
  it('S2a: duplicate within same category (SUCCESS/success) → startup fails', () => {
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: Implement
  terminal: [completed]
events:
  advance: [SUCCESS, success]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
states:
  Implement:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      a1:
        type: prompt
    transitions: { SUCCESS: completed, FAILURE: Implement }
`;
    const p = writeYaml('s2a_dup_within.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    expect(() => loader.load(p)).toThrow(/duplicate/i);
  });

  it('S2b: duplicate across categories (SUCCESS in advance + success in failure) → startup fails naming both categories + normalized key', () => {
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: Implement
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE, success]
  blocked: [BLOCKED]
  neutral: []
states:
  Implement:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      a1:
        type: prompt
    transitions: { SUCCESS: completed, FAILURE: Implement }
`;
    const p = writeYaml('s2b_dup_across.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    let caught: Error | undefined;
    try { loader.load(p); } catch (e) { caught = e as Error; }

    expect(caught).toBeDefined();
    // Must name both categories and the normalized key
    expect(caught!.message).toMatch(/advance/);
    expect(caught!.message).toMatch(/failure/);
    expect(caught!.message).toMatch(/SUCCESS/i);
  });

  it('S2c: invalid event name pattern (contains space) → startup fails', () => {
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: Implement
  terminal: [completed]
events:
  advance: ["INVALID NAME"]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
states:
  Implement:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      a1:
        type: prompt
    transitions: { SUCCESS: completed, FAILURE: Implement }
`;
    const p = writeYaml('s2c_invalid_pattern.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    expect(() => loader.load(p)).toThrow(/pattern|UPPER_SNAKE/i);
  });

  it('S2d: lowercase-declared event name is case-insensitively normalized — duplicate detection catches success/SUCCESS cross-category', () => {
    // success declared in advance (normalizes to SUCCESS), SUCCESS declared in failure — duplicate across categories.
    // The canonicalization means both success and SUCCESS are the same canonical name.
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: Implement
  terminal: [completed]
events:
  advance: [success]
  failure: [SUCCESS]
  blocked: [BLOCKED]
  neutral: []
states:
  Implement:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      a1:
        type: prompt
    transitions: { SUCCESS: completed, FAILURE: Implement }
`;
    const p = writeYaml('s2d_casefold_dup.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    // success (normalized to SUCCESS) and SUCCESS are the same — duplicate across advance/failure
    let caught: Error | undefined;
    try { loader.load(p); } catch (e) { caught = e as Error; }

    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/advance/);
    expect(caught!.message).toMatch(/failure/);
    expect(caught!.message).toMatch(/SUCCESS/i);
  });

  it('S2e: valid UPPER_SNAKE_CASE event names (complex names) → accepted', () => {
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: Implement
  terminal: [completed]
events:
  advance: [QUALITY_PASSED_GATE_1]
  failure: [REVIEW_FAILED_WITH_ERRORS]
  blocked: [WAITING_FOR_DEPENDENCY_123]
  neutral: [REQUIREMENTS_CLARIFICATION_NEEDED]
states:
  Implement:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      a1:
        type: prompt
    transitions:
      QUALITY_PASSED_GATE_1: completed
      REVIEW_FAILED_WITH_ERRORS: Implement
      WAITING_FOR_DEPENDENCY_123: Implement
      REQUIREMENTS_CLARIFICATION_NEEDED: Implement
`;
    const p = writeYaml('s2e_complex_names.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    expect(() => loader.load(p)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC3: Exact transition-key startup lint + runtime exact-key admission
// ---------------------------------------------------------------------------
describe('pi-experiment-cfzu AC3: exact-transition-key admission', () => {
  it('S3a: startup lint — v2 state declares transition key not in vocabulary → startup fails', () => {
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: Implement
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
states:
  Implement:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      a1:
        type: prompt
    transitions:
      SUCCESS: completed
      FAILURE: Implement
      UNDECLARED_EVENT: Implement
`;
    const p = writeYaml('s3a_undeclared_key.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    let caught: Error | undefined;
    try { loader.load(p); } catch (e) { caught = e as Error; }

    expect(caught).toBeDefined();
    // Must name the offending event, state, and the declared vocabulary
    expect(caught!.message).toMatch(/UNDECLARED_EVENT/);
    expect(caught!.message).toMatch(/Implement/);
    expect(caught!.message).toMatch(/event vocabulary/i);
  });

  it('S3b: runtime — QUALITY_PASSED in events.advance, state has no QUALITY_PASSED transition → v2ApplyTransition returns null', () => {
    // Scenario: QUALITY_PASSED is declared in events.advance (it IS in vocabulary)
    // but the current state does NOT have a QUALITY_PASSED transition key.
    // Category membership alone (advance) must NOT route the event.
    const vocab = new Map<string, string>([
      ['QUALITY_PASSED', 'advance'],
      ['FAILURE', 'failure'],
      ['SUCCESS', 'advance']
    ]);

    // State that only has SUCCESS and FAILURE transitions — NO QUALITY_PASSED key
    const state: SDLCState = {
      id: 'Implement',
      identity: { role: 'R', expertise: 'E', constraints: [] },
      actions: [{ id: 'a1', type: 'prompt' as import('../src/constants/domain.js').ActionType }],
      transitions: {
        SUCCESS: 'completed',
        FAILURE: 'Implement'
        // QUALITY_PASSED intentionally absent
      }
    };

    // QUALITY_PASSED is in vocabulary (advance category) but NOT in state's transitions
    const result = v2ApplyTransition(state, 'QUALITY_PASSED', vocab);

    // Category membership (advance) must NOT route — result must be null
    expect(result).toBeNull();
  });

  it('S3c: runtime — SUCCESS has exact transition in state → v2ApplyTransition returns target', () => {
    const vocab = new Map<string, string>([
      ['SUCCESS', 'advance'],
      ['FAILURE', 'failure']
    ]);

    const state: SDLCState = {
      id: 'Implement',
      identity: { role: 'R', expertise: 'E', constraints: [] },
      actions: [{ id: 'a1', type: 'prompt' as import('../src/constants/domain.js').ActionType }],
      transitions: {
        SUCCESS: 'completed',
        FAILURE: 'Implement'
      }
    };

    const result = v2ApplyTransition(state, 'SUCCESS', vocab);
    expect(result).toBe('completed');
  });

  it('S3d: runtime — event not in vocabulary at all → v2ApplyTransition returns null', () => {
    const vocab = new Map<string, string>([
      ['SUCCESS', 'advance']
    ]);

    const state: SDLCState = {
      id: 'Implement',
      identity: { role: 'R', expertise: 'E', constraints: [] },
      actions: [{ id: 'a1', type: 'prompt' as import('../src/constants/domain.js').ActionType }],
      transitions: {
        SUCCESS: 'completed'
      }
    };

    // Completely undeclared — not even in vocabulary
    const result = v2ApplyTransition(state, 'TOTALLY_UNKNOWN', vocab);
    expect(result).toBeNull();
  });

  it('S3e: runtime — neutral event with exact transition → admitted (exact key only, not neutral fallback)', () => {
    // REQUIREMENTS_CLARIFICATION_NEEDED is in events.neutral.
    // The state HAS an exact transition for it.
    // v2ApplyTransition should return the target because the exact key exists.
    const vocab = new Map<string, string>([
      ['SUCCESS', 'advance'],
      ['FAILURE', 'failure'],
      ['REQUIREMENTS_CLARIFICATION_NEEDED', 'neutral']
    ]);

    const state: SDLCState = {
      id: 'Implement',
      identity: { role: 'R', expertise: 'E', constraints: [] },
      actions: [{ id: 'a1', type: 'prompt' as import('../src/constants/domain.js').ActionType }],
      transitions: {
        SUCCESS: 'completed',
        FAILURE: 'Implement',
        REQUIREMENTS_CLARIFICATION_NEEDED: 'Implement'  // exact key present
      }
    };

    const result = v2ApplyTransition(state, 'REQUIREMENTS_CLARIFICATION_NEEDED', vocab);
    // Admitted because exact key exists — not because neutral has any fallback
    expect(result).toBe('Implement');
  });

  it('S3f: runtime — neutral event WITHOUT exact transition → not admitted (no neutral fallback)', () => {
    // REQUIREMENTS_CLARIFICATION_NEEDED is in events.neutral.
    // The state does NOT have a transition for it.
    // Even though it is in vocabulary (neutral category), no exact key → no routing.
    const vocab = new Map<string, string>([
      ['SUCCESS', 'advance'],
      ['FAILURE', 'failure'],
      ['REQUIREMENTS_CLARIFICATION_NEEDED', 'neutral']
    ]);

    const state: SDLCState = {
      id: 'Implement',
      identity: { role: 'R', expertise: 'E', constraints: [] },
      actions: [{ id: 'a1', type: 'prompt' as import('../src/constants/domain.js').ActionType }],
      transitions: {
        SUCCESS: 'completed',
        FAILURE: 'Implement'
        // REQUIREMENTS_CLARIFICATION_NEEDED intentionally absent
      }
    };

    const result = v2ApplyTransition(state, 'REQUIREMENTS_CLARIFICATION_NEEDED', vocab);
    // No routing because the state has no exact key — neutral provides NO fallback
    expect(result).toBeNull();
  });

  it('S3g: startup lint — v2 config with valid transition keys (all in vocabulary) → accepted', () => {
    const p = writeYaml('s3g_valid_keys.yaml', MINIMAL_V2_WITH_EVENTS_YAML);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    expect(() => loader.load(p)).not.toThrow();
  });

  it('S3h: startup lint — HARNESS_RESTART and CONTEXT_RESTART transitions always admitted in v2', () => {
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: Implement
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
states:
  Implement:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      a1:
        type: prompt
    transitions:
      SUCCESS: completed
      FAILURE: Implement
      HARNESS_RESTART: Implement
      CONTEXT_RESTART: Implement
`;
    const p = writeYaml('s3h_restart_admitted.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    // Restart events must be admitted without being in events vocabulary
    expect(() => loader.load(p)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC4: Old v1 outcome/custom-event fields rejected in v2
// ---------------------------------------------------------------------------
describe('pi-experiment-cfzu AC4: old v1 outcome fields rejected in v2', () => {
  it('S4a: statechart.advanceOutcomes in v2 → startup fails with migration guidance', () => {
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: Implement
  terminal: [completed]
  advanceOutcomes: [SUCCESS]
events:
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
states:
  Implement:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      a1:
        type: prompt
    transitions: { FAILURE: Implement }
`;
    const p = writeYaml('s4a_advance_outcomes.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    let caught: Error | undefined;
    try { loader.load(p); } catch (e) { caught = e as Error; }

    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/statechart\.advanceOutcomes/);
    expect(caught!.message).toMatch(/events\.advance/i);
  });

  it('S4b: statechart.failedOutcomes in v2 → startup fails with migration guidance', () => {
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: Implement
  terminal: [completed]
  failedOutcomes: [FAILURE]
events:
  advance: [SUCCESS]
  blocked: [BLOCKED]
  neutral: []
states:
  Implement:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      a1:
        type: prompt
    transitions: { SUCCESS: completed }
`;
    const p = writeYaml('s4b_failed_outcomes.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    let caught: Error | undefined;
    try { loader.load(p); } catch (e) { caught = e as Error; }

    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/statechart\.failedOutcomes/);
    expect(caught!.message).toMatch(/events\.failure/i);
  });

  it('S4c: statechart.blockedOutcomes in v2 → startup fails with migration guidance', () => {
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: Implement
  terminal: [completed]
  blockedOutcomes: [BLOCKED]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  neutral: []
states:
  Implement:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      a1:
        type: prompt
    transitions: { SUCCESS: completed, FAILURE: Implement }
`;
    const p = writeYaml('s4c_blocked_outcomes.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    let caught: Error | undefined;
    try { loader.load(p); } catch (e) { caught = e as Error; }

    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/statechart\.blockedOutcomes/);
    expect(caught!.message).toMatch(/events\.blocked/i);
  });

  it('S4d: statechart.customOutcomes in v2 → startup fails with migration guidance', () => {
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: Implement
  terminal: [completed]
  customOutcomes: [MY_CUSTOM]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
states:
  Implement:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      a1:
        type: prompt
    transitions: { SUCCESS: completed, FAILURE: Implement }
`;
    const p = writeYaml('s4d_custom_outcomes.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    let caught: Error | undefined;
    try { loader.load(p); } catch (e) { caught = e as Error; }

    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/statechart\.customOutcomes/);
    expect(caught!.message).toMatch(/events/i);
  });

  it('S4e: statechart.customEvents in v2 → startup fails with migration guidance', () => {
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: Implement
  terminal: [completed]
  customEvents: [HARNESS_RESTART]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
states:
  Implement:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      a1:
        type: prompt
    transitions: { SUCCESS: completed, FAILURE: Implement }
`;
    const p = writeYaml('s4e_custom_events.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    let caught: Error | undefined;
    try { loader.load(p); } catch (e) { caught = e as Error; }

    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/statechart\.customEvents/);
    expect(caught!.message).toMatch(/events/i);
  });

  it('S4f: all old v1 outcome fields together → error names all fields', () => {
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: Implement
  terminal: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
  customOutcomes: [CUSTOM]
  customEvents: [MY_EVENT]
events:
  neutral: []
states:
  Implement:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      a1:
        type: prompt
    transitions: {}
`;
    const p = writeYaml('s4f_all_old_fields.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    let caught: Error | undefined;
    try { loader.load(p); } catch (e) { caught = e as Error; }

    expect(caught).toBeDefined();
    // All old fields must be named
    expect(caught!.message).toMatch(/statechart\.advanceOutcomes/);
    expect(caught!.message).toMatch(/statechart\.failedOutcomes/);
    expect(caught!.message).toMatch(/statechart\.blockedOutcomes/);
    expect(caught!.message).toMatch(/statechart\.customOutcomes/);
    expect(caught!.message).toMatch(/statechart\.customEvents/);
  });
});

// ---------------------------------------------------------------------------
// AC5 (regression): v1 configs (no version) remain COMPLETELY UNAFFECTED
// ---------------------------------------------------------------------------
describe('pi-experiment-cfzu version-gate: v1 configs unaffected', () => {
  it('S5a: v1 config with advanceOutcomes/failedOutcomes/blockedOutcomes loads cleanly', () => {
    const yaml = `
settings:
  startState: Planning
  worktreePolicy:
    default: always
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan."
    actions:
      - id: plan
        type: prompt
    transitions: { SUCCESS: completed, FAILURE: Planning }
`;
    const p = writeYaml('s5a_v1_loads.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    let config: HarnessConfig | undefined;
    expect(() => { config = loader.load(p); }).not.toThrow();
    expect(config).toBeDefined();
    expect(config!.version).toBeUndefined();
    expect(config!.statechart?.advanceOutcomes).toContain('SUCCESS');
    expect(config!.events).toBeUndefined();
  });

  it('S5b: v1 config with customEvents in statechart loads cleanly', () => {
    const yaml = `
settings:
  startState: Planning
  worktreePolicy:
    default: always
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
  customEvents: [MY_EVENT]
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan."
    actions:
      - id: plan
        type: prompt
    transitions: { SUCCESS: completed, FAILURE: Planning }
`;
    const p = writeYaml('s5b_v1_customevents.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    expect(() => loader.load(p)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC5 (neutral exact routing): spec scenario 3 — neutral event with exact transition
// ---------------------------------------------------------------------------
describe('pi-experiment-cfzu AC5: neutral event exact routing scenario', () => {
  it('S6: v2 config with neutral REQUIREMENTS_CLARIFICATION_NEEDED + exact transition → loads and routes', () => {
    const p = writeYaml('s6_neutral_exact.yaml', MINIMAL_V2_WITH_EVENTS_YAML);
    const loader = new ConfigLoader(undefined, TEST_DIR);
    const config = loader.load(p);

    expect(config.events?.neutral).toContain('REQUIREMENTS_CLARIFICATION_NEEDED');

    const vocab = buildV2EventVocabulary(config);
    expect(vocab.get('REQUIREMENTS_CLARIFICATION_NEEDED')).toBe('neutral');

    const state = config.states['Implement'];
    // State HAS an exact transition for this neutral event
    const result = v2ApplyTransition(state, 'REQUIREMENTS_CLARIFICATION_NEEDED', vocab);
    // Admitted because of EXACT KEY — not because neutral has any routing fallback
    expect(result).toBe('Implement');
  });
});
