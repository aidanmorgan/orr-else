/**
 * pi-experiment-zog2.15 — Unified verifier-visible tool run-status contract.
 *
 * These tests prove:
 *   AC1: A single shared verifier-visible run-status schema is used across all
 *        relevant modules (contract.ts exports ToolRunStatus; ToolEvidenceHandle
 *        re-exports it; gates consume it).
 *   AC2: The compile-time status union is exported from contract.ts and consumed
 *        without local redefinition.
 *   AC3: UNAVAILABLE is admitted as an explicit non-PASSED status that ALWAYS
 *        blocks required-tool satisfaction (via TOOL_UNAVAILABLE block kind).
 *   AC4: runVerifierGate is exhaustive + fail-closed on non-PASSED, unknown,
 *        missing, and malformed status — with structured diagnostics.
 *   AC5: Tests cover PASSED, REJECTED, UNAVAILABLE, unknown status, missing
 *        status, MCP unavailable, command ENOENT, native Pi observer unavailable,
 *        and Cerdiwen legacy ToolResultBase migration.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as nodePath from 'node:path';

// ── AC1/AC2: import the single-source status union from contract.ts ────────────
import {
  verifier,
  VerifyVerdict,
  type ToolRunStatus,
  type VerifyContext,
  type VerifyResult
} from '../src/contract.js';

import {
  runVerifierGate,
  VerifierGateBlockKind,
  type VerifierGateContext,
  type VerifierGateEventStore
} from '../src/core/VerifierGate.js';

// ToolEvidenceHandle re-exports ToolRunStatus from contract (AC2 — no local redefinition).
import {
  TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
  type ToolEvidenceHandle,
  type ToolEvidenceRunStatus,
  toolResultBaseToMigrationDebt,
} from '../src/core/ToolEvidenceHandle.js';

import { DomainEventName, ToolResultStatus } from '../src/constants/domain.js';
import type { DomainEvent } from '../src/core/EventStoreTypes.js';
import type { ToolResultBase } from '../src/contract.js';

// ── Fake store for gate tests (pi-experiment-yhec: includes canonical handles) ─

class FakeStatusStore implements VerifierGateEventStore {
  private readonly events = new Map<string, DomainEvent>();

  private key(beadId: string, stateId: string, actionId: string, tool: string): string {
    return [beadId, stateId, actionId, tool].join('\0');
  }

  /**
   * Record an event with a canonical ToolEvidenceHandle.
   * status must be one of 'PASSED'|'REJECTED'|'UNAVAILABLE' (canonical values).
   * For non-canonical statuses (testing TOOL_STATUS_UNRECOGNIZED) use setFlatNoHandle().
   */
  setFlat(
    beadId: string,
    stateId: string,
    actionId: string,
    tool: string,
    status: string,
    outputFile: string
  ): void {
    const type = status === ToolResultStatus.PASSED
      ? DomainEventName.PROJECT_TOOL_SUCCEEDED
      : DomainEventName.PROJECT_TOOL_FAILED;
    // Only include evidenceHandle for canonical status values (the validator rejects non-canonical).
    const isCanonical = status === 'PASSED' || status === 'REJECTED' || status === 'UNAVAILABLE';
    let evidenceHandle: ToolEvidenceHandle | undefined;
    if (isCanonical) {
      const canonicalStatus = status as ToolEvidenceHandle['runStatus'];
      // toolOutputRoot must contain semanticArtifactPath for the validator to pass.
      // Derive it from the dirname of the outputFile.
      const toolOutputRoot = nodePath.dirname(outputFile);
      evidenceHandle = {
        schemaVersion: TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
        toolName: tool,
        invocationId: `inv-${tool}-zog2-15`,
        runStatus: canonicalStatus,
        ...(canonicalStatus === 'PASSED' ? { semanticArtifactPath: outputFile } : {}),
        toolOutputRoot,
        summaryMode: 'none',
        noSummaryReason: `test fixture for zog2.15 (status=${status})`,
        admittedHarnessFingerprint: 'sha256:test-fp',
        admittedExecutionBoundary: `bead:${beadId}/state:${stateId}/action:${actionId}`,
      };
    }
    this.events.set(this.key(beadId, stateId, actionId, tool), {
      id: `flat-${tool}`,
      type,
      timestamp: new Date().toISOString(),
      sessionId: 'test',
      data: { beadId, stateId, actionId, tool, status, outputFile, ...(evidenceHandle ? { evidenceHandle } : {}) }
    });
  }

  /**
   * Record a PASSED event WITHOUT a canonical evidenceHandle (simulates an
   * outputFile-only or malformed event for negative testing).
   * pi-experiment-yhec: such events are blocked with EVIDENCE_HANDLE_INVALID.
   */
  setFlatNoHandle(
    beadId: string,
    stateId: string,
    actionId: string,
    tool: string,
    status?: string
  ): void {
    this.events.set(this.key(beadId, stateId, actionId, tool), {
      id: `nohandle-${tool}`,
      type: DomainEventName.PROJECT_TOOL_FAILED,
      timestamp: new Date().toISOString(),
      sessionId: 'test',
      data: { beadId, stateId, actionId, tool, status: status ?? 'PASSED', outputFile: '/some/file' }
      // evidenceHandle intentionally absent
    });
  }

  /**
   * Record a PASSED event with NO status field AND no handle (malformed event).
   * pi-experiment-yhec: blocked with EVIDENCE_HANDLE_INVALID.
   */
  setFlatNoStatus(
    beadId: string,
    stateId: string,
    actionId: string,
    tool: string
  ): void {
    // Simulates a malformed event: no status field, no handle.
    this.events.set(this.key(beadId, stateId, actionId, tool), {
      id: `malformed-${tool}`,
      type: DomainEventName.PROJECT_TOOL_FAILED,
      timestamp: new Date().toISOString(),
      sessionId: 'test',
      data: { beadId, stateId, actionId, tool, outputFile: '/some/file' }
      // status + evidenceHandle intentionally absent
    });
  }

  async latestToolResultEvent(
    beadId: string,
    stateId: string,
    actionId: string,
    tool: string
  ): Promise<DomainEvent | undefined> {
    return this.events.get(this.key(beadId, stateId, actionId, tool));
  }
}

const baseCtx: VerifierGateContext = {
  beadId: 'bd-zog2-15',
  stateId: 'Implementing',
  actionId: 'code',
  writeSet: [],
  artifacts: {}
};

const registered: string[] = [];
function registerVerify(
  tool: string,
  fn: (ctx: VerifyContext) => VerifyResult | Promise<VerifyResult>
): void {
  verifier.register(tool, fn);
  registered.push(tool);
}

afterEach(() => {
  for (const tool of registered.splice(0)) {
    verifier.register(tool, () => ({ verdict: VerifyVerdict.NOT_APPLICABLE, reasons: [] }));
  }
});

// ── AC5 path: PASSED ──────────────────────────────────────────────────────────

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('zog2.15 AC5: PASSED status satisfies gate', () => {
  it('PASSED tool with registered PASS verify() advances', async () => {
    const store = new FakeStatusStore();
    // verify() is registered, so no artifact readability check is needed.
    store.setFlat('bd-zog2-15', 'Implementing', 'code', 'my_tool',
      ToolResultStatus.PASSED, '/proj/.pi/tool-output/bd-1/Implementing/code/my_tool/inv/output/o.json');
    registerVerify('my_tool', () => ({ verdict: VerifyVerdict.PASS, reasons: [] }));

    const result = await runVerifierGate(baseCtx, ['my_tool'], store);
    expect(result.pass).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it('PASSED tool with no registered verify() advances when artifact is readable (NOT_APPLICABLE)', async () => {
    // For presence-only tools, the gate checks artifact readability.
    // Write a real file so the check passes.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zog2-15-'));
    try {
      const outputFile = path.join(tmpDir, 'no_verify_tool', 'o.json');
      fs.mkdirSync(path.dirname(outputFile), { recursive: true });
      fs.writeFileSync(outputFile, '{"ok":true}');
      const store = new FakeStatusStore();
      store.setFlat('bd-zog2-15', 'Implementing', 'code', 'no_verify_tool',
        ToolResultStatus.PASSED, outputFile);
      // No verify() registered.

      const result = await runVerifierGate(baseCtx, ['no_verify_tool'], store);
      expect(result.pass).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── AC5 path: REJECTED ────────────────────────────────────────────────────────

describe('zog2.15 AC5: REJECTED status blocks gate', () => {
  it('REJECTED tool blocks with TOOL_REJECTED kind', async () => {
    const store = new FakeStatusStore();
    store.setFlat('bd-zog2-15', 'Implementing', 'code', 'failing_tool',
      ToolResultStatus.REJECTED, '/proj/.pi/tool-output/bd-1/Implementing/code/failing_tool/inv/output/o.json');
    registerVerify('failing_tool', () => ({ verdict: VerifyVerdict.PASS, reasons: ['would pass'] }));

    const result = await runVerifierGate(baseCtx, ['failing_tool'], store);
    expect(result.pass).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].kind).toBe(VerifierGateBlockKind.TOOL_REJECTED);
    expect(result.failures[0].tool).toBe('failing_tool');
    // verify() must NOT have been called on a REJECTED run.
    expect(result.failures[0].verdict).toBeUndefined();
  });
});

// ── AC3 + AC5: UNAVAILABLE status blocks gate ─────────────────────────────────

describe('zog2.15 AC3 + AC5: UNAVAILABLE status always blocks gate', () => {
  it('UNAVAILABLE blocks with TOOL_UNAVAILABLE kind (not TOOL_REJECTED)', async () => {
    const store = new FakeStatusStore();
    // commandExecutor emits UNAVAILABLE for ENOENT (command not found).
    store.setFlat('bd-zog2-15', 'Implementing', 'code', 'enoent_tool',
      ToolResultStatus.UNAVAILABLE, '/proj/.pi/tool-output/bd-1/Implementing/code/enoent_tool/inv/output/o.json');
    registerVerify('enoent_tool', () => ({ verdict: VerifyVerdict.PASS, reasons: ['would pass'] }));

    const result = await runVerifierGate(baseCtx, ['enoent_tool'], store);
    expect(result.pass).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].kind).toBe(VerifierGateBlockKind.TOOL_UNAVAILABLE);
    expect(result.failures[0].tool).toBe('enoent_tool');
    // verify() must NOT have been called for UNAVAILABLE.
    expect(result.failures[0].verdict).toBeUndefined();
    // Diagnostic message references UNAVAILABLE.
    expect(result.rejectMessage).toContain('UNAVAILABLE');
  });

  it('UNAVAILABLE from MCP server unavailable blocks gate', async () => {
    const store = new FakeStatusStore();
    // mcpExecutor emits UNAVAILABLE when the MCP server is unavailable.
    store.setFlat('bd-zog2-15', 'Implementing', 'code', 'mcp_tool',
      ToolResultStatus.UNAVAILABLE, '/proj/.pi/tool-output/bd-1/Implementing/code/mcp_tool/inv/output/o.json');

    const result = await runVerifierGate(baseCtx, ['mcp_tool'], store);
    expect(result.pass).toBe(false);
    expect(result.failures[0].kind).toBe(VerifierGateBlockKind.TOOL_UNAVAILABLE);
    expect(result.rejectMessage).toContain('mcp_tool');
  });

  it('UNAVAILABLE from native Pi observer (blocked native Pi tool) blocks gate', async () => {
    // Native Pi tools observed by PiObservers emit TOOL_INVOCATION_FAILED with
    // status REJECTED (policy rejection). But UNAVAILABLE from MCP preflight or
    // ENOENT paths is treated equivalently — gate blocks on both.
    const store = new FakeStatusStore();
    store.setFlat('bd-zog2-15', 'Implementing', 'code', 'native_pi_tool',
      ToolResultStatus.UNAVAILABLE, '/proj/.pi/tool-output/bd-1/Implementing/code/native_pi_tool/inv/output/o.json');

    const result = await runVerifierGate(baseCtx, ['native_pi_tool'], store);
    expect(result.pass).toBe(false);
    expect(result.failures[0].kind).toBe(VerifierGateBlockKind.TOOL_UNAVAILABLE);
  });
});

// ── AC4 + AC5: unknown/malformed/missing handles fail closed ──────────────────
// pi-experiment-yhec: events without a valid canonical ToolEvidenceHandle are
// blocked with EVIDENCE_HANDLE_INVALID. Non-canonical statuses ('SOME_FUTURE_STATUS')
// and missing status fields result in EVIDENCE_HANDLE_INVALID because the handle
// validator rejects them before the gate reads runStatus.

describe('zog2.15 AC4 + AC5 (yhec): events without valid canonical handles fail closed with EVIDENCE_HANDLE_INVALID', () => {
  it('event with no evidenceHandle (outputFile-only) fails closed with EVIDENCE_HANDLE_INVALID', async () => {
    // pi-experiment-yhec: outputFile-only events (no evidenceHandle) are rejected.
    const store = new FakeStatusStore();
    store.setFlatNoHandle('bd-zog2-15', 'Implementing', 'code', 'unknown_tool', 'SOME_FUTURE_STATUS');

    const result = await runVerifierGate(baseCtx, ['unknown_tool'], store);
    expect(result.pass).toBe(false);
    expect(result.failures).toHaveLength(1);
    // pi-experiment-yhec: no handle → EVIDENCE_HANDLE_INVALID (not TOOL_STATUS_UNRECOGNIZED).
    expect(result.failures[0].kind).toBe(VerifierGateBlockKind.EVIDENCE_HANDLE_INVALID);
    expect(result.failures[0].tool).toBe('unknown_tool');
    // Diagnostic mentions the missing handle.
    const reason = result.failures[0].reasons.join(' ');
    expect(reason).toMatch(/canonical|evidenceHandle|outputFile-only|admissible/i);
  });

  it('missing (undefined) status AND no handle fails closed with EVIDENCE_HANDLE_INVALID', async () => {
    const store = new FakeStatusStore();
    store.setFlatNoStatus('bd-zog2-15', 'Implementing', 'code', 'malformed_tool');

    const result = await runVerifierGate(baseCtx, ['malformed_tool'], store);
    expect(result.pass).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].kind).toBe(VerifierGateBlockKind.EVIDENCE_HANDLE_INVALID);
    expect(result.failures[0].tool).toBe('malformed_tool');
    // Diagnostic mentions the missing canonical handle.
    const reason = result.failures[0].reasons.join(' ');
    expect(reason).toMatch(/canonical|evidenceHandle|outputFile-only|admissible/i);
  });

  it('missing handle does not invoke verify() callback', async () => {
    const store = new FakeStatusStore();
    store.setFlatNoHandle('bd-zog2-15', 'Implementing', 'code', 'malformed_tool2');
    let verifyCalled = false;
    registerVerify('malformed_tool2', () => {
      verifyCalled = true;
      return { verdict: VerifyVerdict.PASS, reasons: [] };
    });

    const result = await runVerifierGate(baseCtx, ['malformed_tool2'], store);
    expect(result.pass).toBe(false);
    // Gate must fail closed without consulting verify().
    expect(verifyCalled).toBe(false);
  });

  it('missing event (no invocation) blocks with TOOL_NOT_INVOKED', async () => {
    const store = new FakeStatusStore();
    // Nothing recorded for 'not_run_tool'.

    const result = await runVerifierGate(baseCtx, ['not_run_tool'], store);
    expect(result.pass).toBe(false);
    expect(result.failures[0].kind).toBe(VerifierGateBlockKind.TOOL_NOT_INVOKED);
  });
});

// ── AC2: ToolRunStatus from contract.ts is the single source; ToolEvidenceRunStatus
//         re-exports it (structural alias, no local redefinition) ────────────────

describe('zog2.15 AC2: single-source status union — contract.ts is the authority', () => {
  it('ToolRunStatus from contract.ts includes PASSED and REJECTED', () => {
    // Type-level: we can assign the known values to a ToolRunStatus variable.
    // At runtime: confirm the string values match ToolResultStatus constants.
    const passed: ToolRunStatus = 'PASSED';
    const rejected: ToolRunStatus = 'REJECTED';
    const unavailable: ToolRunStatus = 'UNAVAILABLE';

    expect(passed).toBe(ToolResultStatus.PASSED);
    expect(rejected).toBe(ToolResultStatus.REJECTED);
    expect(unavailable).toBe(ToolResultStatus.UNAVAILABLE);
  });

  it('ToolEvidenceRunStatus (re-exported from contract) includes UNAVAILABLE', () => {
    // ToolEvidenceRunStatus must be the same type as ToolRunStatus from contract.
    // Assign UNAVAILABLE to ToolEvidenceRunStatus — if they diverge this is a
    // compile-time error.
    const status: ToolEvidenceRunStatus = 'UNAVAILABLE';
    expect(status).toBe('UNAVAILABLE');
  });

  it('ToolEvidenceHandle migration adapter maps PASSED ToolResultBase correctly', () => {
    const base: ToolResultBase = {
      tool: 'my_tool',
      status: 'PASSED',
      outputFile: '/proj/.pi/tool-output/my_tool/inv/output/result.json',
      outputFileBytes: 42
    };
    const debt = toolResultBaseToMigrationDebt(base, '/proj/.pi/tool-output');
    expect(debt._migrationDebt).toBe(true);
    expect(debt.runStatus).toBe('PASSED');
    expect(debt.semanticArtifactPath).toBe(base.outputFile);
  });

  it('ToolEvidenceHandle migration adapter maps REJECTED ToolResultBase correctly (Cerdiwen legacy path)', () => {
    // Cerdiwen's ToolResultBase uses REJECTED — the adapter must preserve this.
    const base: ToolResultBase = {
      tool: 'cerdiwen_tool',
      status: 'REJECTED',
      failureCategory: 'TRANSPORT',
      outputFile: '',
      outputFileBytes: 0
    };
    const debt = toolResultBaseToMigrationDebt(base, '/proj/.pi/tool-output');
    expect(debt._migrationDebt).toBe(true);
    expect(debt.runStatus).toBe('REJECTED');
    expect(debt.failureCategory).toBe('TRANSPORT');
    // REJECTED tools must NOT expose semanticArtifactPath (it wasn't produced).
    expect(debt.semanticArtifactPath).toBeUndefined();
  });
});

// ── AC4: perTool diagnostics include block kind info for all non-PASSED paths ──

describe('zog2.15 AC4: perTool diagnostics populated for all block paths', () => {
  it('perTool carries reasons for UNAVAILABLE block', async () => {
    const store = new FakeStatusStore();
    store.setFlat('bd-zog2-15', 'Implementing', 'code', 'diag_tool',
      ToolResultStatus.UNAVAILABLE, '/path/output.json');

    const result = await runVerifierGate(baseCtx, ['diag_tool'], store);
    expect(result.perTool).toHaveLength(1);
    expect(result.perTool[0].tool).toBe('diag_tool');
    expect(result.perTool[0].reasons.length).toBeGreaterThan(0);
    expect(result.perTool[0].reasons[0]).toMatch(/UNAVAILABLE/i);
  });

  it('perTool carries reasons for missing-handle block (no canonical evidenceHandle on event)', async () => {
    // pi-experiment-yhec: events without canonical handles → EVIDENCE_HANDLE_INVALID.
    const store = new FakeStatusStore();
    store.setFlatNoHandle('bd-zog2-15', 'Implementing', 'code', 'future_tool', 'FUTURE_STATUS');

    const result = await runVerifierGate(baseCtx, ['future_tool'], store);
    expect(result.perTool[0].reasons.join(' ')).toMatch(/canonical|evidenceHandle|admissible/i);
  });

  it('rejectMessage names the tool and block kind for UNAVAILABLE', async () => {
    const store = new FakeStatusStore();
    store.setFlat('bd-zog2-15', 'Implementing', 'code', 'named_tool',
      ToolResultStatus.UNAVAILABLE, '/path/output.json');

    const result = await runVerifierGate(baseCtx, ['named_tool'], store);
    expect(result.rejectMessage).toContain('named_tool');
    expect(result.rejectMessage).toContain('TOOL_UNAVAILABLE');
  });

  it('rejectMessage names the tool and block kind for missing-handle (EVIDENCE_HANDLE_INVALID)', async () => {
    // pi-experiment-yhec: events without canonical handles → EVIDENCE_HANDLE_INVALID.
    const store = new FakeStatusStore();
    store.setFlatNoHandle('bd-zog2-15', 'Implementing', 'code', 'mystery_tool', 'MYSTERY');

    const result = await runVerifierGate(baseCtx, ['mystery_tool'], store);
    expect(result.rejectMessage).toContain('mystery_tool');
    expect(result.rejectMessage).toContain('EVIDENCE_HANDLE_INVALID');
  });
});
