/**
 * compaction_summary_lint.test.ts
 *
 * pi-experiment-6q0y.35 AC8: Startup lint for compactionSummary declarations.
 *
 * Load-bearing tests — each must fail if its specific check is removed from ConfigLoader:
 *
 * L1: Valid compactionSummary (enabled:false) → loads without error.
 * L2: Valid compactionSummary (enabled:true with valid compactionRoute) → loads.
 * L3: Invalid setting: non-object compactionSummary → startup-fatal.
 * L4: Invalid setting: enabled is not boolean → startup-fatal.
 * L5: enabled:true with missing compactionRoute → startup-fatal.
 * L6: compactionRoute references an unknown statechart outcome → startup-fatal.
 * L7: Multiple states with valid compactionSummary → all load.
 * L8: enabled:false needs no compactionRoute → loads.
 * L9: absent compactionSummary → complete no-op (AC1/AC2); existing behavior unchanged.
 *
 * Version: works for both v1 and v2 configs (per-state field).
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ConfigLoader } from '../src/core/ConfigLoader.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_DIR = fs.realpathSync(
  fs.mkdtempSync(path.join(process.env['TMPDIR'] ?? os.tmpdir(), 'orr-else-6q0y35-lint-'))
);

afterEach(() => {
  for (const entry of fs.readdirSync(TEST_DIR)) {
    try { fs.rmSync(path.join(TEST_DIR, entry), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function writeYaml(name: string, content: string): string {
  const p = path.join(TEST_DIR, name);
  fs.writeFileSync(p, content);
  return p;
}

/**
 * Minimal v1 harness.yaml with a single Implement state and configurable
 * compactionSummary block. Uses v1 (no version:2) for simplicity.
 */
function minimalYaml(compactionBlock: string): string {
  return `
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test handover"
  worktreePolicy:
    default: always
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initialState: Implement
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS, COMPACTED]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
tools:
  - name: verify_build
    type: command
    command: echo ok
    sideEffectContract:
      idempotencyClass: idempotent
states:
  Implement:
    identity:
      role: "Implementer"
      expertise: "Code"
      constraints: []
    baseInstructions: "Implement."
    checklist:
      - text: "Done"
    actions:
      - id: run
        type: prompt
        prompt: "Do the work."
    requiredTools:
      - name: verify_build
        expectsVerify: false
    transitions:
      SUCCESS: completed
      FAILURE: Implement
      BLOCKED: Implement
      COMPACTED: Implement
${compactionBlock}
`;
}

// ---------------------------------------------------------------------------
// L1: disabled compactionSummary → loads
// ---------------------------------------------------------------------------
it('L1: compactionSummary enabled:false → loads without error (AC1 no-op)', () => {
  const block = `
    compactionSummary:
      enabled: false
`;
  const p = writeYaml('L1.yaml', minimalYaml(block));
  const loader = new ConfigLoader();
  expect(() => loader.load(p)).not.toThrow();
});

// ---------------------------------------------------------------------------
// L2: valid compactionSummary enabled:true with valid route → loads
// ---------------------------------------------------------------------------
it('L2: compactionSummary enabled:true with declared compactionRoute → loads', () => {
  const block = `
    compactionSummary:
      enabled: true
      compactionRoute: COMPACTED
`;
  const p = writeYaml('L2.yaml', minimalYaml(block));
  const loader = new ConfigLoader();
  expect(() => loader.load(p)).not.toThrow();
});

// ---------------------------------------------------------------------------
// L3: invalid setting: non-object compactionSummary → startup-fatal (LOAD-BEARING)
// ---------------------------------------------------------------------------
it('L3: non-object compactionSummary → startup-fatal (AC8 load-bearing)', () => {
  // YAML: compactionSummary: "bad-value" — passes as a string.
  // But after schema validation, the ConfigLoader semantic check should reject it.
  // Note: The JSON schema only allows 'object' type for compactionSummary,
  // so AJV catches this first. Either way, startup must fail.
  const block = `
    compactionSummary: "invalid-string-value"
`;
  const p = writeYaml('L3.yaml', minimalYaml(block));
  const loader = new ConfigLoader();
  // AJV schema validation rejects the string value before semantics.
  expect(() => loader.load(p)).toThrow();
});

// ---------------------------------------------------------------------------
// L4: enabled is not boolean → startup-fatal (LOAD-BEARING)
// ---------------------------------------------------------------------------
it('L4: compactionSummary.enabled is not boolean → startup-fatal (AC8 load-bearing)', () => {
  const block = `
    compactionSummary:
      enabled: "yes"
`;
  const p = writeYaml('L4.yaml', minimalYaml(block));
  const loader = new ConfigLoader();
  // AJV catches non-boolean `enabled` field first.
  expect(() => loader.load(p)).toThrow();
});

// ---------------------------------------------------------------------------
// L5: enabled:true with missing compactionRoute → startup-fatal (LOAD-BEARING)
// ---------------------------------------------------------------------------
it('L5: compactionSummary enabled:true without compactionRoute → startup-fatal (AC8 load-bearing)', () => {
  const block = `
    compactionSummary:
      enabled: true
`;
  const p = writeYaml('L5.yaml', minimalYaml(block));
  const loader = new ConfigLoader();
  expect(() => loader.load(p)).toThrow(/compactionRoute is missing/);
});

// ---------------------------------------------------------------------------
// L6: compactionRoute not in statechart vocabulary → startup-fatal (LOAD-BEARING)
// ---------------------------------------------------------------------------
it('L6: compactionRoute absent from statechart vocabulary → startup-fatal (AC8 load-bearing)', () => {
  const block = `
    compactionSummary:
      enabled: true
      compactionRoute: UNKNOWN_ROUTE_NOT_IN_VOCAB
`;
  const p = writeYaml('L6.yaml', minimalYaml(block));
  const loader = new ConfigLoader();
  expect(() => loader.load(p)).toThrow(/absent from the statechart outcome vocabulary/);
});

// ---------------------------------------------------------------------------
// L7: multiple states with valid compactionSummary → loads
// ---------------------------------------------------------------------------
it('L7: multiple states with valid compactionSummary → all load', () => {
  const yaml = `
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test handover"
  worktreePolicy:
    default: always
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initialState: StateA
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS, COMPACTED]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
tools:
  - name: verify_build
    type: command
    command: echo ok
    sideEffectContract:
      idempotencyClass: idempotent
states:
  StateA:
    identity:
      role: "Agent"
      expertise: "X"
      constraints: []
    baseInstructions: "Do A."
    actions:
      - id: act
        type: prompt
        prompt: "Do A."
    requiredTools:
      - name: verify_build
        expectsVerify: false
    transitions:
      SUCCESS: StateB
      FAILURE: StateA
      BLOCKED: StateA
      COMPACTED: StateA
    compactionSummary:
      enabled: true
      compactionRoute: COMPACTED
  StateB:
    identity:
      role: "Agent"
      expertise: "Y"
      constraints: []
    baseInstructions: "Do B."
    actions:
      - id: act
        type: prompt
        prompt: "Do B."
    requiredTools:
      - name: verify_build
        expectsVerify: false
    transitions:
      SUCCESS: completed
      FAILURE: StateB
      BLOCKED: StateB
      COMPACTED: StateB
    compactionSummary:
      enabled: false
`;
  const p = writeYaml('L7.yaml', yaml);
  const loader = new ConfigLoader();
  expect(() => loader.load(p)).not.toThrow();
});

// ---------------------------------------------------------------------------
// L8: enabled:false needs no compactionRoute → loads
// ---------------------------------------------------------------------------
it('L8: compactionSummary enabled:false without compactionRoute → loads (AC2 no-op)', () => {
  const block = `
    compactionSummary:
      enabled: false
`;
  const p = writeYaml('L8.yaml', minimalYaml(block));
  const loader = new ConfigLoader();
  expect(() => loader.load(p)).not.toThrow();
});

// ---------------------------------------------------------------------------
// L9: absent compactionSummary → complete no-op (AC1/AC2 load-bearing)
// ---------------------------------------------------------------------------
it('L9: absent compactionSummary → no-op, existing behavior unchanged (AC1/AC2 load-bearing)', () => {
  // No compactionSummary block at all — cerdiwen-style config.
  const p = writeYaml('L9.yaml', minimalYaml(''));
  const loader = new ConfigLoader();
  const config = loader.load(p);
  // Config loads successfully.
  expect(config.states['Implement']).toBeDefined();
  // No compactionSummary in the resolved config.
  const state = config.states['Implement'] as { compactionSummary?: unknown };
  expect(state.compactionSummary).toBeUndefined();
});
