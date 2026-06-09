/**
 * pi-experiment-zog2.19 — Cerdiwen required-tool evidence-class classification.
 *
 * GOAL
 * ----
 * Classify every Cerdiwen required tool's evidence class BEFORE the global
 * presence-only evidence escape hatch is removed (zog2.8). This test proves
 * the classification is complete, internally consistent, and non-trivially
 * asserted — it will FAIL if:
 *   - A required tool is missing from the classification inventory.
 *   - A tool's evidenceClass contradicts its expectsVerify / hasVerifyCallback fields.
 *   - A PRESENCE_ONLY tool is reclassified to VERIFIER_BACKED without updating
 *     the inventory (the test asserts the exact set of PRESENCE_ONLY tools).
 *   - A new tool is added to CERDIWEN_REQUIRED_TOOL_NAMES without a classification.
 *   - The real cerdiwen harness.yaml changes (adding/removing requiredTools entries)
 *     without updating the fixture — the derivation test catches this.
 *   - The real cerdiwen.ts changes (adding/removing verifier.register calls)
 *     without updating the fixture — the derivation test catches this.
 *
 * ACCEPTANCE CRITERIA (pi-experiment-zog2.19)
 * -------------------------------------------
 * AC1: Every tool in CERDIWEN_REQUIRED_TOOL_NAMES has an entry in
 *      CERDIWEN_REQUIRED_TOOL_CLASSIFICATIONS.
 * AC2: VERIFIER_BACKED_SEMANTIC_ARTIFACT tools declare expectsVerify:true OR
 *      are harness-owned (git_history uses plain string form in harness.yaml,
 *      but its verify() is unconditionally registered by the harness).
 * AC3: CONTROL_PLANE_ACK tools have hasVerifyCallback:true and expectsVerify:false.
 * AC4: PRESENCE_ONLY tools have no verify callback.
 * AC5: The exact PRESENCE_ONLY tool set matches the expected set — any reclassification
 *      requires an explicit update.
 * AC6: The exact VERIFIER_BACKED_SEMANTIC_ARTIFACT set matches the expected set.
 * AC7: A PRESENCE_ONLY required tool gate CANNOT be satisfied by implicit evidence
 *      (non-PROJECT_TOOL events such as log records); ONLY a durable
 *      PROJECT_TOOL_SUCCEEDED event in the EventStore satisfies it.
 * AC8: The classification inventory has no duplicate toolName entries.
 * AC9: Every classified tool has a non-empty notes field.
 *
 * CERDIWEN-GROUNDED DERIVATION (load-bearing)
 * -------------------------------------------
 * The derivation suite reads the real cerdiwen source files and derives ground
 * truth from them. If cerdiwen adds a requiredTool or registers a new verify(),
 * this test fails — forcing an update to CERDIWEN_REQUIRED_TOOL_CLASSIFICATIONS.
 * Paths guarded with fail-loud existsSync (mirrors statechart_lint.test.ts pattern).
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  CERDIWEN_REQUIRED_TOOL_CLASSIFICATIONS,
  CERDIWEN_CLASSIFICATION_BY_NAME,
  CERDIWEN_REQUIRED_TOOL_NAMES,
  type CerdiwenToolClassificationEntry,
  type EvidenceClass,
} from '../src/core/RtkContract.js';
import {
  verifier,
  VerifyVerdict,
  type VerifyContext,
  type VerifyResult
} from '../src/contract.js';
import {
  runVerifierGate,
  VerifierGateBlockKind,
  type VerifierGateEventStore
} from '../src/core/VerifierGate.js';
import {
  TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
  type ToolEvidenceHandle,
} from '../src/core/ToolEvidenceHandle.js';
import { DomainEventName, ToolResultStatus } from '../src/constants/domain.js';
import type { DomainEvent } from '../src/core/EventStoreTypes.js';
import * as os from 'node:os';

// ---------------------------------------------------------------------------
// Cerdiwen source paths
// ---------------------------------------------------------------------------

const CERDIWEN_ROOT = '/Users/aidan/dev/bankwest/cerdiwen';
const CERDIWEN_HARNESS_YAML = path.join(CERDIWEN_ROOT, 'harness.yaml');
const CERDIWEN_EXTENSION_TS = path.join(CERDIWEN_ROOT, '.pi/extensions/cerdiwen.ts');

// ---------------------------------------------------------------------------
// Expected tool sets (derived from cerdiwen harness.yaml + cerdiwen.ts extension)
// These are the load-bearing assertions: any change to these sets requires
// an explicit review of the classification.
// ---------------------------------------------------------------------------

/**
 * Tools that have a registered verify() that can return non-trivial PASS/FAIL.
 * The gate enforces both artifact presence AND the verifier's semantic judgment.
 * Source: harness.yaml expectsVerify:true entries + git_history (harness-owned).
 */
const EXPECTED_VERIFIER_BACKED: readonly string[] = [
  'requirements_schema',
  'plan_contract',
  'run_quality_checks',
  'sonarqube',
  'git_history',
];

/**
 * Tools that have a registered verify() but verdict is always PASS when the
 * tool ran (control-plane confirmation, not a semantic gate).
 * Source: cerdiwen.ts verifier.register() calls that are NOT expectsVerify:true.
 */
const EXPECTED_CONTROL_PLANE_ACK: readonly string[] = [
  'codemap',
  'python_lsp',
  'reference_docs',
  'ast_grep',
  'smt_lib',
];

/**
 * Tools with NO registered verify() callback. Gate enforces only that a durable
 * tool-call EventStore record exists.
 * Source: tools declared in harness.yaml requiredTools that are NOT in cerdiwen.ts
 *         verifier.register() calls.
 */
const EXPECTED_PRESENCE_ONLY: readonly string[] = [
  'coding_standards',
  'add_checklist_item',
  'tick_items',
  'submit_review_artifact',
  'pytest',
  'semgrep',
];

// ---------------------------------------------------------------------------
// CERDIWEN-GROUNDED DERIVATION (Finding 1 fix)
// Reads the real cerdiwen source and derives ground truth to assert against
// the fixture. If cerdiwen adds/removes requiredTools or verify() registrations,
// this suite fails — forcing a fixture update.
// ---------------------------------------------------------------------------

describe('CERDIWEN-GROUNDED derivation: fixture matches real cerdiwen source', () => {
  it('cerdiwen harness.yaml exists (fail-loud guard)', () => {
    expect(
      fs.existsSync(CERDIWEN_HARNESS_YAML),
      `cerdiwen harness.yaml not found at ${CERDIWEN_HARNESS_YAML} — consumer must be present`
    ).toBe(true);
  });

  it('cerdiwen.ts extension exists (fail-loud guard)', () => {
    expect(
      fs.existsSync(CERDIWEN_EXTENSION_TS),
      `cerdiwen.ts extension not found at ${CERDIWEN_EXTENSION_TS} — consumer must be present`
    ).toBe(true);
  });

  it('fixture required-tool name set matches all harness.yaml states.*.requiredTools entries', () => {
    // Derive the actual required-tool name set from real cerdiwen harness.yaml.
    const raw = fs.readFileSync(CERDIWEN_HARNESS_YAML, 'utf8');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed = parseYaml(raw) as any;
    const states: Record<string, unknown> = parsed?.states ?? {};
    const derivedSet = new Set<string>();
    for (const [, stateVal] of Object.entries(states)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stateObj = stateVal as any;
      const requiredTools: unknown[] = stateObj?.requiredTools ?? [];
      for (const entry of requiredTools) {
        if (typeof entry === 'string') {
          derivedSet.add(entry);
        } else if (entry && typeof entry === 'object' && 'name' in entry) {
          derivedSet.add((entry as { name: string }).name);
        }
      }
    }

    const fixtureSet = new Set(CERDIWEN_REQUIRED_TOOL_NAMES);

    const inDerivedNotFixture = [...derivedSet].filter(n => !fixtureSet.has(n)).sort();
    const inFixtureNotDerived = [...fixtureSet].filter(n => !derivedSet.has(n)).sort();

    expect(
      inDerivedNotFixture,
      `harness.yaml has requiredTools not in CERDIWEN_REQUIRED_TOOL_NAMES: ${inDerivedNotFixture.join(', ')}`
    ).toEqual([]);
    expect(
      inFixtureNotDerived,
      `CERDIWEN_REQUIRED_TOOL_NAMES lists tools not in harness.yaml requiredTools: ${inFixtureNotDerived.join(', ')}`
    ).toEqual([]);
  });

  it('fixture hasVerifyCallback matches verifier.register() calls in cerdiwen.ts (plus harness-owned git_history)', () => {
    // Derive which tools have a verify() from the real cerdiwen extension source text.
    // Match: verifier.register("toolName", ...) lines.
    const src = fs.readFileSync(CERDIWEN_EXTENSION_TS, 'utf8');
    const registerPattern = /verifier\.register\(\s*["']([^"']+)["']/g;
    const registeredInExtension = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = registerPattern.exec(src)) !== null) {
      registeredInExtension.add(m[1]);
    }

    // git_history is harness-owned: the harness self-registers it. It is NOT in
    // cerdiwen.ts. Any required tool with hasVerifyCallback:true that is NOT in
    // cerdiwen.ts must be harness-owned (currently only git_history).
    for (const entry of CERDIWEN_REQUIRED_TOOL_CLASSIFICATIONS) {
      const inExtension = registeredInExtension.has(entry.toolName);
      const isHarnessOwned = entry.verifyOwner === 'harness';
      const derivedHasVerify = inExtension || isHarnessOwned;

      expect(
        entry.hasVerifyCallback,
        `${entry.toolName}: fixture hasVerifyCallback=${entry.hasVerifyCallback} but ` +
        `derived hasVerify=${derivedHasVerify} ` +
        `(inExtension=${inExtension}, harnessOwned=${isHarnessOwned})`
      ).toBe(derivedHasVerify);
    }
  });

  it('fixture expectsVerify matches harness.yaml { name, expectsVerify: true } entries', () => {
    // Derive which tools have expectsVerify:true from real harness.yaml.
    const raw = fs.readFileSync(CERDIWEN_HARNESS_YAML, 'utf8');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed = parseYaml(raw) as any;
    const states: Record<string, unknown> = parsed?.states ?? {};
    const derivedExpectsVerify = new Set<string>();
    for (const [, stateVal] of Object.entries(states)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stateObj = stateVal as any;
      const requiredTools: unknown[] = stateObj?.requiredTools ?? [];
      for (const entry of requiredTools) {
        if (
          entry &&
          typeof entry === 'object' &&
          'name' in entry &&
          (entry as { expectsVerify?: boolean }).expectsVerify === true
        ) {
          derivedExpectsVerify.add((entry as { name: string }).name);
        }
      }
    }

    for (const entry of CERDIWEN_REQUIRED_TOOL_CLASSIFICATIONS) {
      // git_history is harness-owned and declared as plain string (no expectsVerify:true
      // in harness.yaml) — the fixture correctly records expectsVerify:false for it.
      const derivedExpects = derivedExpectsVerify.has(entry.toolName);
      expect(
        entry.expectsVerify,
        `${entry.toolName}: fixture expectsVerify=${entry.expectsVerify} but ` +
        `harness.yaml derivedExpectsVerify=${derivedExpects}`
      ).toBe(derivedExpects);
    }
  });
});

// ---------------------------------------------------------------------------
// AC1: Every CERDIWEN_REQUIRED_TOOL_NAMES entry has a classification entry.
// ---------------------------------------------------------------------------

describe('AC1: every Cerdiwen required tool has a classification entry', () => {
  it('CERDIWEN_REQUIRED_TOOL_NAMES is non-empty', () => {
    expect(CERDIWEN_REQUIRED_TOOL_NAMES.length).toBeGreaterThan(0);
  });

  it('CERDIWEN_CLASSIFICATION_BY_NAME covers every required tool name', () => {
    const missing: string[] = [];
    for (const name of CERDIWEN_REQUIRED_TOOL_NAMES) {
      if (!CERDIWEN_CLASSIFICATION_BY_NAME.has(name)) {
        missing.push(name);
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `${missing.length} required tool(s) have no classification entry:\n` +
        missing.map(n => `  - ${n}`).join('\n') +
        '\nAdd entries to CERDIWEN_REQUIRED_TOOL_CLASSIFICATIONS in src/core/RtkContract.ts.'
      );
    }
    expect(missing).toHaveLength(0);
  });

  it('total classification count matches required tool count', () => {
    expect(CERDIWEN_REQUIRED_TOOL_CLASSIFICATIONS.length).toBe(
      CERDIWEN_REQUIRED_TOOL_NAMES.length
    );
  });
});

// ---------------------------------------------------------------------------
// AC2: VERIFIER_BACKED_SEMANTIC_ARTIFACT tools have verify callbacks and
//      either expectsVerify:true or are harness-owned.
// ---------------------------------------------------------------------------

describe('AC2: VERIFIER_BACKED_SEMANTIC_ARTIFACT tools have verify() + valid expectsVerify', () => {
  const backed = CERDIWEN_REQUIRED_TOOL_CLASSIFICATIONS.filter(
    e => e.evidenceClass === 'VERIFIER_BACKED_SEMANTIC_ARTIFACT'
  );

  it('VERIFIER_BACKED tools always have hasVerifyCallback:true', () => {
    for (const entry of backed) {
      expect(
        entry.hasVerifyCallback,
        `${entry.toolName}: VERIFIER_BACKED_SEMANTIC_ARTIFACT must have hasVerifyCallback:true`
      ).toBe(true);
    }
  });

  it('VERIFIER_BACKED tools either declare expectsVerify:true or are harness-owned', () => {
    // git_history is harness-owned and uses plain string form in harness.yaml
    // (no expectsVerify:true) — that is intentional per srpk AC2.
    const harnessOwned = CERDIWEN_REQUIRED_TOOL_CLASSIFICATIONS
      .filter(e => e.evidenceClass === 'VERIFIER_BACKED_SEMANTIC_ARTIFACT' && e.verifyOwner === 'harness')
      .map(e => e.toolName);

    for (const entry of backed) {
      const isHarnessOwned = harnessOwned.includes(entry.toolName);
      if (!entry.expectsVerify && !isHarnessOwned) {
        throw new Error(
          `${entry.toolName}: VERIFIER_BACKED_SEMANTIC_ARTIFACT tool must have ` +
          `expectsVerify:true in harness.yaml OR be harness-owned. ` +
          `Got expectsVerify:${entry.expectsVerify}, verifyOwner:${entry.verifyOwner}.`
        );
      }
    }
    // At least one must be harness-owned (git_history) and at least one must declare expectsVerify
    expect(harnessOwned.length).toBeGreaterThanOrEqual(1);
    const declaresExpectsVerify = backed.filter(e => e.expectsVerify);
    expect(declaresExpectsVerify.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// AC3: CONTROL_PLANE_ACK tools have hasVerifyCallback:true, expectsVerify:false.
// ---------------------------------------------------------------------------

describe('AC3: CONTROL_PLANE_ACK tools have verify() but not expectsVerify:true', () => {
  const ackTools = CERDIWEN_REQUIRED_TOOL_CLASSIFICATIONS.filter(
    e => e.evidenceClass === 'CONTROL_PLANE_ACK'
  );

  it('CONTROL_PLANE_ACK tools always have hasVerifyCallback:true', () => {
    for (const entry of ackTools) {
      expect(
        entry.hasVerifyCallback,
        `${entry.toolName}: CONTROL_PLANE_ACK must have hasVerifyCallback:true`
      ).toBe(true);
    }
  });

  it('CONTROL_PLANE_ACK tools always have expectsVerify:false', () => {
    for (const entry of ackTools) {
      expect(
        entry.expectsVerify,
        `${entry.toolName}: CONTROL_PLANE_ACK must have expectsVerify:false ` +
        `(the gate does not enforce verify() at startup for these tools)`
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// AC4: PRESENCE_ONLY tools have no verify callback.
// ---------------------------------------------------------------------------

describe('AC4: PRESENCE_ONLY tools have no registered verify() callback', () => {
  const presenceOnly = CERDIWEN_REQUIRED_TOOL_CLASSIFICATIONS.filter(
    e => e.evidenceClass === 'PRESENCE_ONLY'
  );

  it('PRESENCE_ONLY tools always have hasVerifyCallback:false', () => {
    for (const entry of presenceOnly) {
      expect(
        entry.hasVerifyCallback,
        `${entry.toolName}: PRESENCE_ONLY must have hasVerifyCallback:false`
      ).toBe(false);
    }
  });

  it('PRESENCE_ONLY tools always have expectsVerify:false', () => {
    for (const entry of presenceOnly) {
      expect(
        entry.expectsVerify,
        `${entry.toolName}: PRESENCE_ONLY must have expectsVerify:false`
      ).toBe(false);
    }
  });

  it('PRESENCE_ONLY tools always have verifyOwner:none', () => {
    for (const entry of presenceOnly) {
      expect(
        entry.verifyOwner,
        `${entry.toolName}: PRESENCE_ONLY must have verifyOwner:"none"`
      ).toBe('none');
    }
  });
});

// ---------------------------------------------------------------------------
// AC5: The exact PRESENCE_ONLY tool set matches the expected enumeration.
//      Any reclassification (e.g. adding a verify() to semgrep) MUST update
//      both the classification entry and EXPECTED_PRESENCE_ONLY here.
// ---------------------------------------------------------------------------

describe('AC5: exact PRESENCE_ONLY tool set (load-bearing — fails if set changes)', () => {
  it('PRESENCE_ONLY tools match the expected set exactly', () => {
    const actualPresenceOnly = CERDIWEN_REQUIRED_TOOL_CLASSIFICATIONS
      .filter(e => e.evidenceClass === 'PRESENCE_ONLY')
      .map(e => e.toolName)
      .sort();
    const expectedSorted = [...EXPECTED_PRESENCE_ONLY].sort();

    expect(actualPresenceOnly).toEqual(expectedSorted);
  });

  it('PRESENCE_ONLY tool count is ' + EXPECTED_PRESENCE_ONLY.length, () => {
    const count = CERDIWEN_REQUIRED_TOOL_CLASSIFICATIONS.filter(
      e => e.evidenceClass === 'PRESENCE_ONLY'
    ).length;
    expect(count).toBe(EXPECTED_PRESENCE_ONLY.length);
  });
});

// ---------------------------------------------------------------------------
// AC6: The exact VERIFIER_BACKED_SEMANTIC_ARTIFACT set matches the expected
//      enumeration.
// ---------------------------------------------------------------------------

describe('AC6: exact VERIFIER_BACKED_SEMANTIC_ARTIFACT tool set (load-bearing)', () => {
  it('VERIFIER_BACKED tools match the expected set exactly', () => {
    const actualBacked = CERDIWEN_REQUIRED_TOOL_CLASSIFICATIONS
      .filter(e => e.evidenceClass === 'VERIFIER_BACKED_SEMANTIC_ARTIFACT')
      .map(e => e.toolName)
      .sort();
    const expectedSorted = [...EXPECTED_VERIFIER_BACKED].sort();

    expect(actualBacked).toEqual(expectedSorted);
  });

  it('CONTROL_PLANE_ACK tools match the expected set exactly', () => {
    const actualAck = CERDIWEN_REQUIRED_TOOL_CLASSIFICATIONS
      .filter(e => e.evidenceClass === 'CONTROL_PLANE_ACK')
      .map(e => e.toolName)
      .sort();
    const expectedSorted = [...EXPECTED_CONTROL_PLANE_ACK].sort();

    expect(actualAck).toEqual(expectedSorted);
  });
});

// ---------------------------------------------------------------------------
// AC7: A PRESENCE_ONLY required tool gate cannot be satisfied by implicit
//      evidence (e.g. log records, non-PROJECT_TOOL events). Only a durable
//      PROJECT_TOOL_SUCCEEDED event in the EventStore satisfies it.
//
// Uses the real runVerifierGate + a FakeToolResultStore (mirrors verifier_gate.test.ts
// pattern). Proves the gate mechanism: no implicit event → TOOL_NOT_INVOKED;
// PROJECT_TOOL_SUCCEEDED event → gate passes.
// ---------------------------------------------------------------------------

/** Minimal fake store keyed by (bead, state, action, tool). */
class FakeToolResultStore implements VerifierGateEventStore {
  private readonly events = new Map<string, DomainEvent>();

  private key(beadId: string, stateId: string, actionId: string, tool: string): string {
    return [beadId, stateId, actionId, tool].join('\0');
  }

  setProjectToolSucceeded(
    beadId: string, stateId: string, actionId: string, tool: string, outputFile: string
  ): void {
    // pi-experiment-yhec: include a canonical ToolEvidenceHandle.
    const toolOutputRoot = path.dirname(outputFile);
    const evidenceHandle: ToolEvidenceHandle = {
      schemaVersion: TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
      toolName: tool,
      invocationId: `inv-${tool}-ac7`,
      runStatus: 'PASSED',
      semanticArtifactPath: outputFile,
      toolOutputRoot,
      summaryMode: 'none',
      noSummaryReason: 'cerdiwen AC7 test fixture',
      admittedHarnessFingerprint: 'sha256:test-fp',
      admittedExecutionBoundary: `bead:${beadId}/state:${stateId}/action:${actionId}`,
    };
    this.events.set(this.key(beadId, stateId, actionId, tool), {
      id: `succeeded-${tool}`,
      type: DomainEventName.PROJECT_TOOL_SUCCEEDED,
      timestamp: new Date().toISOString(),
      sessionId: 'test',
      data: { beadId, stateId, actionId, tool, status: ToolResultStatus.PASSED, outputFile, evidenceHandle }
    });
  }

  async latestToolResultEvent(
    beadId: string, stateId: string, actionId: string, tool: string
  ): Promise<DomainEvent | undefined> {
    return this.events.get(this.key(beadId, stateId, actionId, tool));
  }
}

const gateCtx = {
  beadId: 'bd-zog2',
  stateId: 'Implementation',
  actionId: 'exec',
  writeSet: ['/w/src/foo.py'],
  artifacts: {}
};

// Track tools registered in this suite so we can neutralise them after each test.
const ac7Registered: string[] = [];

function registerForAc7(tool: string, fn: (ctx: VerifyContext) => VerifyResult | Promise<VerifyResult>): void {
  verifier.register(tool, fn);
  ac7Registered.push(tool);
}

afterEach(() => {
  for (const tool of ac7Registered.splice(0)) {
    verifier.register(tool, () => ({ verdict: VerifyVerdict.NOT_APPLICABLE, reasons: [] }));
  }
});

describe('AC7: PRESENCE_ONLY gate requires a durable PROJECT_TOOL_SUCCEEDED event — implicit evidence cannot satisfy it', () => {
  // Pick a representative PRESENCE_ONLY tool from the fixture.
  const presenceOnlyTool = 'semgrep';

  it('gate BLOCKS (TOOL_NOT_INVOKED) when no PROJECT_TOOL event exists for the tool — implicit evidence like log records cannot substitute', async () => {
    // Store has NO event at all for the tool (simulating implicit-only evidence:
    // a log record, OTel span, or prose mention cannot produce a tool-result event).
    const store = new FakeToolResultStore();
    // No verify() registered for PRESENCE_ONLY tools — they gate on presence alone.

    const result = await runVerifierGate(gateCtx, [presenceOnlyTool], store);

    expect(result.pass).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].tool).toBe(presenceOnlyTool);
    expect(result.failures[0].kind).toBe(VerifierGateBlockKind.TOOL_NOT_INVOKED);
  });

  it('gate PASSES when a durable PROJECT_TOOL_SUCCEEDED event exists for the tool', async () => {
    // pi-experiment-yhec: presence-only tools require a readable semantic artifact.
    // Write a real file so the artifact readability check passes.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cerdiwen-ac7-'));
    try {
      const outputFile = path.join(tmpDir, `${presenceOnlyTool}`, 'o.json');
      fs.mkdirSync(path.dirname(outputFile), { recursive: true });
      fs.writeFileSync(outputFile, '{"ok":true}');

      const store = new FakeToolResultStore();
      // Record a real PROJECT_TOOL_SUCCEEDED event (the only thing that can satisfy the gate).
      store.setProjectToolSucceeded(
        gateCtx.beadId,
        gateCtx.stateId,
        gateCtx.actionId,
        presenceOnlyTool,
        outputFile
      );
      // No verify() for PRESENCE_ONLY; gate should pass on presence alone.

      const result = await runVerifierGate(gateCtx, [presenceOnlyTool], store);

      expect(result.pass).toBe(true);
      expect(result.failures).toHaveLength(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('a tool that registers a verify() but produces no PROJECT_TOOL event still blocks (no implicit verify bypass)', async () => {
    // This negative test shows that even a registered verify() that returns PASS
    // cannot bypass a missing tool-result event — the gate checks presence first.
    const store = new FakeToolResultStore();
    // Register a PASS-returning verify() for semgrep (simulating a hypothetical future
    // registration). Even with this, the missing event blocks.
    registerForAc7(presenceOnlyTool, () => ({ verdict: VerifyVerdict.PASS, reasons: ['would pass'] }));

    const result = await runVerifierGate(gateCtx, [presenceOnlyTool], store);

    expect(result.pass).toBe(false);
    expect(result.failures[0].kind).toBe(VerifierGateBlockKind.TOOL_NOT_INVOKED);
  });
});

// ---------------------------------------------------------------------------
// AC8: No duplicate toolName entries in the classification inventory.
// ---------------------------------------------------------------------------

describe('AC8: no duplicate toolName entries in classification inventory', () => {
  it('all toolNames in CERDIWEN_REQUIRED_TOOL_CLASSIFICATIONS are unique', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const entry of CERDIWEN_REQUIRED_TOOL_CLASSIFICATIONS) {
      if (seen.has(entry.toolName)) {
        duplicates.push(entry.toolName);
      }
      seen.add(entry.toolName);
    }
    expect(duplicates).toHaveLength(0);
  });

  it('CERDIWEN_CLASSIFICATION_BY_NAME map size matches array length', () => {
    expect(CERDIWEN_CLASSIFICATION_BY_NAME.size).toBe(
      CERDIWEN_REQUIRED_TOOL_CLASSIFICATIONS.length
    );
  });
});

// ---------------------------------------------------------------------------
// AC9: Every classification entry has a non-empty notes field.
// ---------------------------------------------------------------------------

describe('AC9: every classification entry has a non-empty notes field', () => {
  it.each(CERDIWEN_REQUIRED_TOOL_CLASSIFICATIONS.map(e => [e.toolName, e] as [string, CerdiwenToolClassificationEntry]))(
    'entry for %s has a non-empty notes field',
    (_name, entry) => {
      expect(
        entry.notes.trim().length,
        `Classification entry for "${entry.toolName}" must have a non-empty notes field`
      ).toBeGreaterThan(0);
    }
  );
});

// ---------------------------------------------------------------------------
// Structural integrity: CERDIWEN_REQUIRED_TOOL_NAMES matches classification keys
// ---------------------------------------------------------------------------

describe('structural integrity: CERDIWEN_REQUIRED_TOOL_NAMES matches classification', () => {
  it('every CERDIWEN_REQUIRED_TOOL_NAME is in CERDIWEN_CLASSIFICATION_BY_NAME', () => {
    for (const name of CERDIWEN_REQUIRED_TOOL_NAMES) {
      expect(
        CERDIWEN_CLASSIFICATION_BY_NAME.has(name),
        `"${name}" is in CERDIWEN_REQUIRED_TOOL_NAMES but not in CERDIWEN_REQUIRED_TOOL_CLASSIFICATIONS`
      ).toBe(true);
    }
  });

  it('every classification entry toolName is in CERDIWEN_REQUIRED_TOOL_NAMES', () => {
    const requiredSet = new Set(CERDIWEN_REQUIRED_TOOL_NAMES);
    for (const entry of CERDIWEN_REQUIRED_TOOL_CLASSIFICATIONS) {
      expect(
        requiredSet.has(entry.toolName),
        `"${entry.toolName}" is in CERDIWEN_REQUIRED_TOOL_CLASSIFICATIONS but not in CERDIWEN_REQUIRED_TOOL_NAMES`
      ).toBe(true);
    }
  });

  it('three evidence classes cover all classified tools', () => {
    const validClasses: EvidenceClass[] = [
      'VERIFIER_BACKED_SEMANTIC_ARTIFACT',
      'CONTROL_PLANE_ACK',
      'PRESENCE_ONLY',
    ];
    for (const entry of CERDIWEN_REQUIRED_TOOL_CLASSIFICATIONS) {
      expect(
        validClasses.includes(entry.evidenceClass),
        `"${entry.toolName}" has an unrecognized evidenceClass: "${entry.evidenceClass}"`
      ).toBe(true);
    }
  });

  it('VERIFIER_BACKED + CONTROL_PLANE_ACK + PRESENCE_ONLY counts sum to total', () => {
    const backed = CERDIWEN_REQUIRED_TOOL_CLASSIFICATIONS.filter(
      e => e.evidenceClass === 'VERIFIER_BACKED_SEMANTIC_ARTIFACT'
    ).length;
    const ack = CERDIWEN_REQUIRED_TOOL_CLASSIFICATIONS.filter(
      e => e.evidenceClass === 'CONTROL_PLANE_ACK'
    ).length;
    const presence = CERDIWEN_REQUIRED_TOOL_CLASSIFICATIONS.filter(
      e => e.evidenceClass === 'PRESENCE_ONLY'
    ).length;
    expect(backed + ack + presence).toBe(CERDIWEN_REQUIRED_TOOL_CLASSIFICATIONS.length);
  });

  it('total required tool count is 16 (all state.requiredTools entries from harness.yaml)', () => {
    expect(CERDIWEN_REQUIRED_TOOL_NAMES.length).toBe(16);
    expect(CERDIWEN_REQUIRED_TOOL_CLASSIFICATIONS.length).toBe(16);
  });
});
