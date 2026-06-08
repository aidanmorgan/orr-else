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
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
import {
  TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
  type ToolEvidenceHandle,
} from '../src/core/ToolEvidenceHandle.js';
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
    // Build a canonical ToolEvidenceHandle for the event (pi-experiment-yhec).
    // toolOutputRoot must contain semanticArtifactPath for the validator to pass.
    const toolOutputRoot = outputFile ? path.dirname(outputFile) : '/proj/.pi/tool-output';
    const evidenceHandle: ToolEvidenceHandle = status === ToolResultStatus.PASSED ? {
      schemaVersion: TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
      toolName: tool,
      invocationId: `inv-${tool}-zog2-8`,
      runStatus: 'PASSED',
      semanticArtifactPath: outputFile || undefined,
      toolOutputRoot: toolOutputRoot,
      summaryMode: 'none',
      noSummaryReason: 'zog2.8 test fixture',
      admittedHarnessFingerprint: 'sha256:test-fp',
      admittedExecutionBoundary: `bead:${beadId}/state:${stateId}/action:${actionId}`,
    } : {
      schemaVersion: TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
      toolName: tool,
      invocationId: `inv-${tool}-zog2-8`,
      runStatus: status as ToolEvidenceHandle['runStatus'],
      toolOutputRoot: toolOutputRoot,
      summaryMode: 'none',
      noSummaryReason: `zog2.8 test fixture — status=${status}`,
      admittedHarnessFingerprint: 'sha256:test-fp',
      admittedExecutionBoundary: `bead:${beadId}/state:${stateId}/action:${actionId}`,
    };
    this.events.set(this.key(beadId, stateId, actionId, tool), {
      id: `flat-${tool}`,
      type: status === ToolResultStatus.PASSED ? DomainEventName.PROJECT_TOOL_SUCCEEDED : DomainEventName.PROJECT_TOOL_FAILED,
      timestamp: new Date().toISOString(),
      sessionId: 'test',
      data: { beadId, stateId, actionId, tool, status, outputFile, evidenceHandle }
    });
  }

  /**
   * Record a PASSED event with a canonical handle but NO semanticArtifactPath
   * — simulates a presence-only run that did not persist a semantic artifact.
   * pi-experiment-yhec: the gate blocks this with TOOL_MISSING_ARTIFACT.
   */
  setFlatNoOutputFile(beadId: string, stateId: string, actionId: string, tool: string): void {
    // Handle has no semanticArtifactPath — the gate should block with TOOL_MISSING_ARTIFACT.
    const evidenceHandle: ToolEvidenceHandle = {
      schemaVersion: TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
      toolName: tool,
      invocationId: `inv-${tool}-nofile`,
      runStatus: 'PASSED',
      // semanticArtifactPath intentionally absent
      toolOutputRoot: '/proj/.pi/tool-output',
      summaryMode: 'none',
      noSummaryReason: 'zog2.8 test fixture — no artifact',
      admittedHarnessFingerprint: 'sha256:test-fp',
      admittedExecutionBoundary: `bead:${beadId}/state:${stateId}/action:${actionId}`,
    };
    this.events.set(this.key(beadId, stateId, actionId, tool), {
      id: `flat-nofile-${tool}`,
      type: DomainEventName.PROJECT_TOOL_SUCCEEDED,
      timestamp: new Date().toISOString(),
      sessionId: 'test',
      data: { beadId, stateId, actionId, tool, status: ToolResultStatus.PASSED, evidenceHandle }
      // outputFile intentionally absent from event data; semanticArtifactPath absent from handle
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

describe('zog2.8 (yhec) — NEGATIVE: presence-only tool without semanticArtifactPath cannot satisfy requiredTools', () => {
  it('PASSED tool with NO semanticArtifactPath (malformed handle) and NO verify() blocks — fail closed', async () => {
    // This is the load-bearing negative test: if the implicit presence-only escape
    // hatch were re-introduced, this test would FAIL because the gate would return pass:true.
    // pi-experiment-yhec: a PASSED handle with no semanticArtifactPath fails canonical
    // validation → EVIDENCE_HANDLE_INVALID (the old TOOL_MISSING_ARTIFACT).
    const store = new FakeToolResultStore();
    // Tool ran PASSED but handle has NO semanticArtifactPath.
    store.setFlatNoOutputFile('bd-1', 'Implementing', 'code', 'coding_standards');
    // No verify() registered (PRESENCE_ONLY tool — coding_standards in Cerdiwen).

    const result = await runVerifierGate(baseCtx, ['coding_standards'], store);

    // Must BLOCK — missing artifact is never evidence.
    expect(result.pass).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].tool).toBe('coding_standards');
    // pi-experiment-yhec: a handle with no semanticArtifactPath for PASSED runs fails
    // canonical validation → EVIDENCE_HANDLE_INVALID (not TOOL_MISSING_ARTIFACT).
    expect([
      VerifierGateBlockKind.TOOL_MISSING_ARTIFACT,
      VerifierGateBlockKind.EVIDENCE_HANDLE_INVALID
    ]).toContain(result.failures[0].kind);
    expect(result.failures[0].verdict).toBeUndefined();
    expect(result.rejectMessage).toContain('coding_standards');
  });

  it('PASSED tool with NO semanticArtifactPath and NO verify() blocks — even with a stub NOT_APPLICABLE verifier for other tools', async () => {
    const store = new FakeToolResultStore();
    // coding_standards: PASSED, no semanticArtifactPath in handle, no verify() → must block
    store.setFlatNoOutputFile('bd-1', 'Implementing', 'code', 'coding_standards');
    // other_tool: PASSED with verify() → must pass
    store.setFlat('bd-1', 'Implementing', 'code', 'other_tool', ToolResultStatus.PASSED, '/proj/.pi/tool-output/bd-1/Implementing/code/other_tool/inv/output/o.json');
    registerVerify('other_tool', () => ({ verdict: VerifyVerdict.PASS, reasons: [] }));

    const result = await runVerifierGate(baseCtx, ['coding_standards', 'other_tool'], store);

    expect(result.pass).toBe(false);
    // Only coding_standards blocks; other_tool passes.
    const blockingFailures = result.failures.filter(f =>
      f.tool === 'coding_standards' &&
      (f.kind === VerifierGateBlockKind.TOOL_MISSING_ARTIFACT || f.kind === VerifierGateBlockKind.EVIDENCE_HANDLE_INVALID)
    );
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
    // No verify() is registered (PRESENCE_ONLY class). The gate checks artifact readability.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zog2-8-presence-'));
    try {
      const minimalArtifactPath = path.join(tmpDir, 'coding_standards', 'minimal.json');
      fs.mkdirSync(path.dirname(minimalArtifactPath), { recursive: true });
      fs.writeFileSync(minimalArtifactPath, '{"ok":true}');
      const store = new FakeToolResultStore();
      store.setFlat('bd-1', 'Implementing', 'code', 'coding_standards', ToolResultStatus.PASSED, minimalArtifactPath);
      // No verify() registered — PRESENCE_ONLY.

      const result = await runVerifierGate(baseCtx, ['coding_standards'], store);

      // Must PASS — minimal artifact is present and readable.
      expect(result.pass).toBe(true);
      expect(result.failures).toEqual([]);
      // The perTool entry confirms NOT_APPLICABLE (no verify()) with artifact present.
      expect(result.perTool).toHaveLength(1);
      expect(result.perTool[0].tool).toBe('coding_standards');
      expect(result.perTool[0].verdict).toBe(VerifyVerdict.NOT_APPLICABLE);
      expect(result.perTool[0].reasons[0]).toContain('semantic artifact present');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('multiple PRESENCE_ONLY tools with artifacts all pass together', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zog2-8-multi-'));
    try {
      const store = new FakeToolResultStore();
      // All tools: PASSED with minimal artifact paths (real files), no verify() callbacks.
      const tools = ['coding_standards', 'add_checklist_item', 'submit_review_artifact'];
      for (const tool of tools) {
        const artifactPath = path.join(tmpDir, tool, 'minimal.json');
        fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
        fs.writeFileSync(artifactPath, '{"ok":true}');
        store.setFlat('bd-1', 'Implementing', 'code', tool, ToolResultStatus.PASSED, artifactPath);
      }

      const result = await runVerifierGate(baseCtx, tools, store);

      expect(result.pass).toBe(true);
      expect(result.failures).toEqual([]);
      expect(result.perTool).toHaveLength(3);
      for (const entry of result.perTool) {
        expect(entry.verdict).toBe(VerifyVerdict.NOT_APPLICABLE);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// OLD EVENT REJECTION: missing semanticArtifactPath in handle cannot satisfy
// ---------------------------------------------------------------------------

describe('zog2.8 (yhec) — old event rejection: missing semanticArtifactPath cannot satisfy gate', () => {
  it('PASSED handle with absent semanticArtifactPath blocks (fail closed — missing artifact is not evidence)', async () => {
    // A handle where semanticArtifactPath is absent.
    // pi-experiment-yhec: fails canonical validation → EVIDENCE_HANDLE_INVALID.
    const store = new FakeToolResultStore();
    store.setFlatNoOutputFile('bd-1', 'Implementing', 'code', 'semgrep');
    // semgrep is PRESENCE_ONLY (no verify()) — but missing artifact path is not admissible.

    const result = await runVerifierGate(baseCtx, ['semgrep'], store);

    expect(result.pass).toBe(false);
    // pi-experiment-yhec: EVIDENCE_HANDLE_INVALID (handle validation fails for missing semPath).
    expect([
      VerifierGateBlockKind.TOOL_MISSING_ARTIFACT,
      VerifierGateBlockKind.EVIDENCE_HANDLE_INVALID
    ]).toContain(result.failures[0].kind);
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
      // pi-experiment-yhec: use evidenceHandles not toolOutputs.
      if (!ctx.evidenceHandles['codemap']?.semanticArtifactPath) {
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
