/**
 * pi-experiment-zog2.8 — remove implicit presence-only tool evidence;
 * require minimal schema-owned semantic artifact.
 *
 * These tests prove the gate/resolver paths enforce the new contract:
 *
 *   NEGATIVE (load-bearing): a PRESENCE_ONLY tool (no verify() callback) that
 *   ran PASSED but recorded NO outputFile (no semanticArtifactPath) CANNOT
 *   satisfy requiredTools — gate fails CLOSED with TOOL_MISSING_ARTIFACT.
 *
 *   ACCEPTANCE: a PRESENCE_ONLY tool that ran PASSED and DID record an
 *   outputFile (minimal semantic artifact) IS accepted — gate passes.
 *
 *   OLD EVENT REJECTION: an old-style event shape that carries a tool record
 *   without outputFile cannot satisfy the gate.
 *
 *   CONTROL_PLANE ACK: a tool with a verify() callback (CONTROL_PLANE_ACK or
 *   VERIFIER_BACKED) is NOT blocked by the missing-artifact check — the
 *   verify() callback is responsible for artifact presence.
 *
 * Tests drive the REAL runVerifierGate production path (not a re-implemented
 * loop) with a FakeToolResultStore that records exact EventStore event shapes.
 * The negative test is load-bearing: if the implicit presence-only escape hatch
 * were re-introduced, the negative assertion would FAIL.
 */

import { describe, it, expect, afterEach } from 'vitest';

import {
  verifier,
  VerifyVerdict,
  type VerifyContext,
  type VerifyResult
} from '../src/contract.js';
import {
  runVerifierGate,
  VerifierGateBlockKind,
  type VerifierGateContext,
  type VerifierGateEventStore
} from '../src/core/VerifierGate.js';
import { DomainEventName, ToolResultStatus } from '../src/constants/index.js';
import type { DomainEvent } from '../src/core/EventStoreTypes.js';

// ---------------------------------------------------------------------------
// FakeToolResultStore — returns a DomainEvent or undefined per (b,s,a,tool)
// ---------------------------------------------------------------------------

class FakeToolResultStore implements VerifierGateEventStore {
  private readonly events = new Map<string, DomainEvent>();

  private key(beadId: string, stateId: string, actionId: string, tool: string): string {
    return [beadId, stateId, actionId, tool].join('\0');
  }

  setFlat(beadId: string, stateId: string, actionId: string, tool: string, status: ToolResultStatus, outputFile: string): void {
    this.events.set(this.key(beadId, stateId, actionId, tool), {
      id: `flat-${tool}`,
      type: status === ToolResultStatus.PASSED ? DomainEventName.PROJECT_TOOL_SUCCEEDED : DomainEventName.PROJECT_TOOL_FAILED,
      timestamp: new Date().toISOString(),
      sessionId: 'test',
      data: { beadId, stateId, actionId, tool, status, outputFile }
    });
  }

  /** Record a PASSED event with NO outputFile — simulates a presence-only run that forgot the artifact. */
  setFlatNoOutputFile(beadId: string, stateId: string, actionId: string, tool: string): void {
    this.events.set(this.key(beadId, stateId, actionId, tool), {
      id: `flat-nofile-${tool}`,
      type: DomainEventName.PROJECT_TOOL_SUCCEEDED,
      timestamp: new Date().toISOString(),
      sessionId: 'test',
      data: { beadId, stateId, actionId, tool, status: ToolResultStatus.PASSED }
      // outputFile intentionally absent
    });
  }

  async latestToolResultEvent(beadId: string, stateId: string, actionId: string, tool: string): Promise<DomainEvent | undefined> {
    return this.events.get(this.key(beadId, stateId, actionId, tool));
  }
}

const baseCtx: VerifierGateContext = {
  beadId: 'bd-1',
  stateId: 'Implementing',
  actionId: 'code',
  writeSet: [],
  artifacts: {}
};

// Registry cleanup — module-level singleton, last-wins, no removal API.
const registered: string[] = [];
function registerVerify(tool: string, fn: (ctx: VerifyContext) => VerifyResult | Promise<VerifyResult>): void {
  verifier.register(tool, fn);
  registered.push(tool);
}
afterEach(() => {
  for (const tool of registered.splice(0)) {
    verifier.register(tool, () => ({ verdict: VerifyVerdict.NOT_APPLICABLE, reasons: [] }));
  }
});

// ---------------------------------------------------------------------------
// NEGATIVE (load-bearing): presence-only tool with NO outputFile CANNOT satisfy
// ---------------------------------------------------------------------------

describe('zog2.8 — NEGATIVE: presence-only tool without outputFile cannot satisfy requiredTools', () => {
  it('PASSED tool with NO outputFile and NO verify() blocks with TOOL_MISSING_ARTIFACT (not presence-only pass)', async () => {
    // This is the load-bearing negative test: if the implicit presence-only escape
    // hatch were re-introduced (the old "no verify() → NOT_APPLICABLE → ignored"),
    // this test would FAIL because the gate would return pass:true.
    const store = new FakeToolResultStore();
    // Tool ran PASSED but recorded NO outputFile (no semanticArtifactPath).
    store.setFlatNoOutputFile('bd-1', 'Implementing', 'code', 'coding_standards');
    // No verify() registered (PRESENCE_ONLY tool — coding_standards in Cerdiwen).

    const result = await runVerifierGate(baseCtx, ['coding_standards'], store);

    // Must BLOCK — missing artifact is never evidence.
    expect(result.pass).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].tool).toBe('coding_standards');
    expect(result.failures[0].kind).toBe(VerifierGateBlockKind.TOOL_MISSING_ARTIFACT);
    expect(result.failures[0].verdict).toBeUndefined();
    expect(result.rejectMessage).toContain('coding_standards');
    // The error message must name the root cause.
    expect(result.failures[0].reasons[0]).toContain('semantic artifact path');
    expect(result.failures[0].reasons[0]).toContain('zog2.8');
  });

  it('PASSED tool with NO outputFile and NO verify() blocks — even with a stub NOT_APPLICABLE verifier for other tools', async () => {
    const store = new FakeToolResultStore();
    // coding_standards: PASSED, no outputFile, no verify() → must block
    store.setFlatNoOutputFile('bd-1', 'Implementing', 'code', 'coding_standards');
    // other_tool: PASSED with outputFile and a verify() → must pass
    store.setFlat('bd-1', 'Implementing', 'code', 'other_tool', ToolResultStatus.PASSED, '/proj/.pi/tool-output/bd-1/Implementing/code/other_tool/inv/output/o.json');
    registerVerify('other_tool', () => ({ verdict: VerifyVerdict.PASS, reasons: [] }));

    const result = await runVerifierGate(baseCtx, ['coding_standards', 'other_tool'], store);

    expect(result.pass).toBe(false);
    // Only coding_standards blocks (missing artifact); other_tool passes.
    const blockingFailures = result.failures.filter(f => f.kind === VerifierGateBlockKind.TOOL_MISSING_ARTIFACT);
    expect(blockingFailures).toHaveLength(1);
    expect(blockingFailures[0].tool).toBe('coding_standards');
  });
});

// ---------------------------------------------------------------------------
// ACCEPTANCE: presence-only tool WITH a recorded outputFile IS accepted
// ---------------------------------------------------------------------------

describe('zog2.8 — ACCEPTANCE: presence-only tool with minimal semantic artifact passes', () => {
  it('PASSED tool with outputFile and NO verify() passes (minimal artifact satisfies the gate)', async () => {
    // The tool persisted a minimal semantic artifact and recorded its path in the event.
    // No verify() is registered (PRESENCE_ONLY class). The gate must PASS.
    const store = new FakeToolResultStore();
    const minimalArtifactPath = '/proj/.pi/tool-output/bd-1/Implementing/code/coding_standards/inv/output/minimal.json';
    store.setFlat('bd-1', 'Implementing', 'code', 'coding_standards', ToolResultStatus.PASSED, minimalArtifactPath);
    // No verify() registered — PRESENCE_ONLY.

    const result = await runVerifierGate(baseCtx, ['coding_standards'], store);

    // Must PASS — minimal artifact is present.
    expect(result.pass).toBe(true);
    expect(result.failures).toEqual([]);
    // The perTool entry confirms NOT_APPLICABLE (no verify()) with artifact present.
    expect(result.perTool).toHaveLength(1);
    expect(result.perTool[0].tool).toBe('coding_standards');
    expect(result.perTool[0].verdict).toBe(VerifyVerdict.NOT_APPLICABLE);
    expect(result.perTool[0].reasons[0]).toContain('semantic artifact present');
  });

  it('multiple PRESENCE_ONLY tools with artifacts all pass together', async () => {
    const store = new FakeToolResultStore();
    // All tools: PASSED with minimal artifact paths, no verify() callbacks.
    const tools = ['coding_standards', 'add_checklist_item', 'submit_review_artifact'];
    for (const tool of tools) {
      const path = `/proj/.pi/tool-output/bd-1/Implementing/code/${tool}/inv/output/minimal.json`;
      store.setFlat('bd-1', 'Implementing', 'code', tool, ToolResultStatus.PASSED, path);
    }

    const result = await runVerifierGate(baseCtx, tools, store);

    expect(result.pass).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.perTool).toHaveLength(3);
    for (const entry of result.perTool) {
      expect(entry.verdict).toBe(VerifyVerdict.NOT_APPLICABLE);
    }
  });
});

// ---------------------------------------------------------------------------
// OLD EVENT REJECTION: stdout-only or no-outputFile record cannot satisfy
// ---------------------------------------------------------------------------

describe('zog2.8 — old event rejection: missing outputFile in event cannot satisfy gate', () => {
  it('old-shape PASSED event with empty string outputFile blocks with TOOL_MISSING_ARTIFACT', async () => {
    // An old-style event where outputFile is an empty string (equivalent to absent).
    const store = new FakeToolResultStore();
    store.setFlat('bd-1', 'Implementing', 'code', 'semgrep', ToolResultStatus.PASSED, '');
    // semgrep is PRESENCE_ONLY (no verify()) — but empty outputFile is not admissible.

    const result = await runVerifierGate(baseCtx, ['semgrep'], store);

    expect(result.pass).toBe(false);
    expect(result.failures[0].kind).toBe(VerifierGateBlockKind.TOOL_MISSING_ARTIFACT);
    expect(result.failures[0].tool).toBe('semgrep');
  });
});

// ---------------------------------------------------------------------------
// CONTROL_PLANE ACK: tool WITH a verify() is NOT blocked by missing-artifact
// check — the verify() sees empty toolOutputs and returns its own verdict.
// ---------------------------------------------------------------------------

describe('zog2.8 — control-plane ack tools: verify() runs even when outputFile absent', () => {
  it('PASSED tool with NO outputFile but WITH a verify() is NOT blocked by TOOL_MISSING_ARTIFACT — verify() verdict applies', async () => {
    // A CONTROL_PLANE_ACK tool has its own verify() that handles the absent-artifact case.
    // The gate must NOT short-circuit to TOOL_MISSING_ARTIFACT when a verify() is registered.
    const store = new FakeToolResultStore();
    store.setFlatNoOutputFile('bd-1', 'Implementing', 'code', 'codemap');
    // codemap has a verify() (CONTROL_PLANE_ACK class) — the verify() sees no path and
    // returns NOT_APPLICABLE (standard behavior for absent artifact in ACK tools).
    registerVerify('codemap', (ctx): VerifyResult => {
      if (!ctx.toolOutputs['codemap']) {
        return { verdict: VerifyVerdict.NOT_APPLICABLE, reasons: ['no codemap output for this run'] };
      }
      return { verdict: VerifyVerdict.PASS, reasons: [] };
    });

    const result = await runVerifierGate(baseCtx, ['codemap'], store);

    // NOT blocked by TOOL_MISSING_ARTIFACT — verify() ran and returned NOT_APPLICABLE → gate passes.
    expect(result.pass).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.perTool[0].verdict).toBe(VerifyVerdict.NOT_APPLICABLE);
    // Crucially: TOOL_MISSING_ARTIFACT was NOT raised (verify() registered tools bypass that check).
    expect(result.failures.some(f => f.kind === VerifierGateBlockKind.TOOL_MISSING_ARTIFACT)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FAILED TOOL: REJECTED presence-only tool still blocks with TOOL_REJECTED
// ---------------------------------------------------------------------------

describe('zog2.8 — failed presence-only tool blocks with TOOL_REJECTED (pre-existing behavior unchanged)', () => {
  it('REJECTED presence-only tool blocks with TOOL_REJECTED (not TOOL_MISSING_ARTIFACT)', async () => {
    const store = new FakeToolResultStore();
    const outputFile = '/proj/.pi/tool-output/bd-1/Implementing/code/pytest/inv/output/result.json';
    store.setFlat('bd-1', 'Implementing', 'code', 'pytest', ToolResultStatus.REJECTED, outputFile);
    // pytest is PRESENCE_ONLY — no verify() registered.

    const result = await runVerifierGate(baseCtx, ['pytest'], store);

    expect(result.pass).toBe(false);
    expect(result.failures[0].kind).toBe(VerifierGateBlockKind.TOOL_REJECTED);
    expect(result.failures[0].tool).toBe('pytest');
    // TOOL_MISSING_ARTIFACT is NOT the reason — it's TOOL_REJECTED (ran, failed).
    expect(result.failures[0].kind).not.toBe(VerifierGateBlockKind.TOOL_MISSING_ARTIFACT);
  });
});
