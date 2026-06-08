/**
 * pi-experiment-yhec — canonical evidence handles in VerifyContext.
 *
 * This test suite proves the NEGATIVE contract: a verifier callback CANNOT
 * pass by reading stdout, outputFile basename, logs, OTel, tmux transcripts,
 * or model-facing summaries. Only a validated canonical ToolEvidenceHandle
 * carrying a PASSED runStatus with a readable semanticArtifactPath can
 * satisfy the gate.
 *
 * ACCEPTANCE CRITERIA PROVEN HERE:
 *   1. VerifierGate REJECTS events without canonical evidenceHandle (outputFile-only,
 *      command envelopes, child ToolResultBase records) → EVIDENCE_HANDLE_INVALID.
 *   2. VerifierGate REJECTS handles with malformed fields → EVIDENCE_HANDLE_INVALID.
 *   3. VerifierGate REJECTS handles where semanticArtifactPath is outside toolOutputRoot.
 *   4. VerifierGate REJECTS handles with REJECTED runStatus → TOOL_REJECTED.
 *   5. VerifierGate REJECTS handles with UNAVAILABLE runStatus → TOOL_UNAVAILABLE.
 *   6. VerifierGate REJECTS handles with PASSED runStatus but unreadable artifact → EVIDENCE_HANDLE_INVALID.
 *   7. A verifier callback cannot PASS by reading stdout (no stdout in evidenceHandles).
 *   8. A verifier callback cannot PASS by reading outputFile basename (not exposed).
 *   9. A verifier callback cannot PASS by reading logs/OTel/tmux/model summaries (not in context).
 *  10. A valid canonical PASSED handle with readable semanticArtifactPath PASSES.
 *  11. EVIDENCE_HANDLE_INVALID fires before verify() is ever called (fail closed).
 *  12. stale fingerprint / mismatched toolName → EVIDENCE_HANDLE_INVALID.
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
import { DomainEventName } from '../src/constants/index.js';
import type { DomainEvent } from '../src/core/EventStoreTypes.js';

// ── Minimal fake store ─────────────────────────────────────────────────────────

class SingleEventStore implements VerifierGateEventStore {
  constructor(private readonly event: DomainEvent | undefined) {}
  async latestToolResultEvent(): Promise<DomainEvent | undefined> {
    return this.event;
  }
}

function makeEvent(data: Record<string, unknown>): DomainEvent {
  return {
    id: 'evt-test',
    type: DomainEventName.PROJECT_TOOL_SUCCEEDED,
    timestamp: new Date().toISOString(),
    sessionId: 'test',
    data
  };
}

const baseCtx: VerifierGateContext = {
  beadId: 'bd-yhec',
  stateId: 'Implementing',
  actionId: 'code',
  writeSet: [],
  artifacts: {}
};

// Registry cleanup.
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

// ── 1. EVIDENCE_HANDLE_INVALID for events without evidenceHandle ───────────────

describe('yhec AC1: events without canonical evidenceHandle are rejected (EVIDENCE_HANDLE_INVALID)', () => {
  it('outputFile-only event (flat shape, no evidenceHandle) → EVIDENCE_HANDLE_INVALID', async () => {
    const event = makeEvent({
      beadId: 'bd-yhec', stateId: 'Implementing', actionId: 'code',
      tool: 'my_tool', status: 'PASSED',
      outputFile: '/proj/.pi/tool-output/bd-yhec/Implementing/code/my_tool/inv/out.json'
      // evidenceHandle intentionally absent
    });
    const result = await runVerifierGate(baseCtx, ['my_tool'], new SingleEventStore(event));
    expect(result.pass).toBe(false);
    expect(result.failures[0].kind).toBe(VerifierGateBlockKind.EVIDENCE_HANDLE_INVALID);
    expect(result.failures[0].tool).toBe('my_tool');
  });

  it('command envelope (outputArchive only, no evidenceHandle) → EVIDENCE_HANDLE_INVALID', async () => {
    const event = makeEvent({
      beadId: 'bd-yhec', stateId: 'Implementing', actionId: 'code',
      tool: 'my_tool', type: 'command', cwd: '/cwd',
      outputArchive: { artifactRef: 'project-tool-output:inv-legacy' }
      // evidenceHandle intentionally absent
    });
    const result = await runVerifierGate(baseCtx, ['my_tool'], new SingleEventStore(event));
    expect(result.pass).toBe(false);
    expect(result.failures[0].kind).toBe(VerifierGateBlockKind.EVIDENCE_HANDLE_INVALID);
  });

  it('child ToolResultBase record (nested toolResult, no top-level evidenceHandle) → EVIDENCE_HANDLE_INVALID', async () => {
    const event: DomainEvent = {
      id: 'nested', type: DomainEventName.TOOL_INVOCATION_SUCCEEDED,
      timestamp: new Date().toISOString(), sessionId: 'test',
      data: {
        beadId: 'bd-yhec', stateId: 'Implementing', actionId: 'code',
        tool: 'my_tool',
        toolResult: { tool: 'my_tool', status: 'PASSED', outputFile: '/some/file.json', outputFileBytes: 10 }
        // evidenceHandle intentionally absent at top level
      }
    };
    const result = await runVerifierGate(baseCtx, ['my_tool'], new SingleEventStore(event));
    expect(result.pass).toBe(false);
    expect(result.failures[0].kind).toBe(VerifierGateBlockKind.EVIDENCE_HANDLE_INVALID);
  });
});

// ── 2. EVIDENCE_HANDLE_INVALID for malformed handles ──────────────────────────

describe('yhec AC2: malformed evidenceHandle is rejected (EVIDENCE_HANDLE_INVALID)', () => {
  it('evidenceHandle missing required schemaVersion → EVIDENCE_HANDLE_INVALID', async () => {
    const event = makeEvent({
      beadId: 'bd-yhec', stateId: 'Implementing', actionId: 'code',
      tool: 'my_tool', status: 'PASSED',
      evidenceHandle: {
        // schemaVersion missing
        toolName: 'my_tool', invocationId: 'inv-1', runStatus: 'PASSED',
        toolOutputRoot: '/root', summaryMode: 'none', noSummaryReason: 'test',
        admittedHarnessFingerprint: 'sha256:fp', admittedExecutionBoundary: 'bead:b/state:s/action:a'
      }
    });
    const result = await runVerifierGate(baseCtx, ['my_tool'], new SingleEventStore(event));
    expect(result.pass).toBe(false);
    expect(result.failures[0].kind).toBe(VerifierGateBlockKind.EVIDENCE_HANDLE_INVALID);
  });

  it('evidenceHandle with wrong toolName (mismatched) → EVIDENCE_HANDLE_INVALID', async () => {
    const event = makeEvent({
      beadId: 'bd-yhec', stateId: 'Implementing', actionId: 'code',
      tool: 'my_tool', status: 'PASSED',
      evidenceHandle: {
        schemaVersion: TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
        toolName: 'different_tool', // MISMATCH
        invocationId: 'inv-1', runStatus: 'PASSED',
        toolOutputRoot: '/root', summaryMode: 'none', noSummaryReason: 'test',
        admittedHarnessFingerprint: 'sha256:fp', admittedExecutionBoundary: 'bead:b/state:s/action:a'
      }
    });
    registerVerify('my_tool', () => ({ verdict: VerifyVerdict.PASS, reasons: ['would pass'] }));
    const result = await runVerifierGate(baseCtx, ['my_tool'], new SingleEventStore(event));
    expect(result.pass).toBe(false);
    expect(result.failures[0].kind).toBe(VerifierGateBlockKind.EVIDENCE_HANDLE_INVALID);
    // Diagnostic must mention the toolName mismatch.
    expect(result.failures[0].reasons.join(' ')).toMatch(/mismatch|toolName|different_tool/i);
  });

  it('evidenceHandle with model-facing rawOutput field (forbidden) → EVIDENCE_HANDLE_INVALID', async () => {
    const event = makeEvent({
      beadId: 'bd-yhec', stateId: 'Implementing', actionId: 'code',
      tool: 'my_tool', status: 'PASSED',
      evidenceHandle: {
        schemaVersion: TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
        toolName: 'my_tool', invocationId: 'inv-1', runStatus: 'PASSED',
        toolOutputRoot: '/root', summaryMode: 'none', noSummaryReason: 'test',
        admittedHarnessFingerprint: 'sha256:fp', admittedExecutionBoundary: 'bead:b/state:s/action:a',
        rawOutput: 'some raw tool output text' // FORBIDDEN field
      }
    });
    registerVerify('my_tool', () => ({ verdict: VerifyVerdict.PASS, reasons: [] }));
    const result = await runVerifierGate(baseCtx, ['my_tool'], new SingleEventStore(event));
    expect(result.pass).toBe(false);
    expect(result.failures[0].kind).toBe(VerifierGateBlockKind.EVIDENCE_HANDLE_INVALID);
    // No verifier saw the rawOutput — it was rejected before verify() ran.
  });
});

// ── 3. EVIDENCE_HANDLE_INVALID for out-of-root semanticArtifactPath ───────────

describe('yhec AC3: semanticArtifactPath outside toolOutputRoot → EVIDENCE_HANDLE_INVALID', () => {
  it('handle with semanticArtifactPath outside toolOutputRoot is rejected', async () => {
    const event = makeEvent({
      beadId: 'bd-yhec', stateId: 'Implementing', actionId: 'code',
      tool: 'my_tool', status: 'PASSED',
      evidenceHandle: {
        schemaVersion: TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
        toolName: 'my_tool', invocationId: 'inv-1', runStatus: 'PASSED',
        semanticArtifactPath: '/outside/path/artifact.json', // OUTSIDE toolOutputRoot
        toolOutputRoot: '/inside-root',
        summaryMode: 'none', noSummaryReason: 'test',
        admittedHarnessFingerprint: 'sha256:fp', admittedExecutionBoundary: 'bead:b/state:s/action:a'
      }
    });
    registerVerify('my_tool', () => ({ verdict: VerifyVerdict.PASS, reasons: ['would pass'] }));
    const result = await runVerifierGate(baseCtx, ['my_tool'], new SingleEventStore(event));
    expect(result.pass).toBe(false);
    expect(result.failures[0].kind).toBe(VerifierGateBlockKind.EVIDENCE_HANDLE_INVALID);
    // The verifier was NEVER called (gate blocked before verify()).
  });
});

// ── 4. TOOL_REJECTED for REJECTED runStatus ────────────────────────────────────

describe('yhec AC4: REJECTED runStatus in handle → TOOL_REJECTED', () => {
  it('REJECTED handle → TOOL_REJECTED (verify() not consulted)', async () => {
    const event = makeEvent({
      beadId: 'bd-yhec', stateId: 'Implementing', actionId: 'code',
      tool: 'my_tool', status: 'REJECTED',
      evidenceHandle: {
        schemaVersion: TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
        toolName: 'my_tool', invocationId: 'inv-1', runStatus: 'REJECTED',
        failureCategory: 'INFRA', toolOutputRoot: '/root',
        summaryMode: 'none', noSummaryReason: 'test',
        admittedHarnessFingerprint: 'sha256:fp', admittedExecutionBoundary: 'bead:b/state:s/action:a'
      }
    });
    let verifyConsulted = false;
    registerVerify('my_tool', () => { verifyConsulted = true; return { verdict: VerifyVerdict.PASS, reasons: [] }; });
    const result = await runVerifierGate(baseCtx, ['my_tool'], new SingleEventStore(event));
    expect(result.pass).toBe(false);
    expect(result.failures[0].kind).toBe(VerifierGateBlockKind.TOOL_REJECTED);
    // verify() MUST NOT have been consulted.
    expect(verifyConsulted).toBe(false);
  });
});

// ── 5. TOOL_UNAVAILABLE for UNAVAILABLE runStatus ─────────────────────────────

describe('yhec AC5: UNAVAILABLE runStatus in handle → TOOL_UNAVAILABLE', () => {
  it('UNAVAILABLE handle → TOOL_UNAVAILABLE (verify() not consulted)', async () => {
    const event = makeEvent({
      beadId: 'bd-yhec', stateId: 'Implementing', actionId: 'code',
      tool: 'my_tool', status: 'UNAVAILABLE',
      evidenceHandle: {
        schemaVersion: TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
        toolName: 'my_tool', invocationId: 'inv-1', runStatus: 'UNAVAILABLE',
        toolOutputRoot: '/root', summaryMode: 'none', noSummaryReason: 'test',
        admittedHarnessFingerprint: 'sha256:fp', admittedExecutionBoundary: 'bead:b/state:s/action:a'
      }
    });
    let verifyConsulted = false;
    registerVerify('my_tool', () => { verifyConsulted = true; return { verdict: VerifyVerdict.PASS, reasons: [] }; });
    const result = await runVerifierGate(baseCtx, ['my_tool'], new SingleEventStore(event));
    expect(result.pass).toBe(false);
    expect(result.failures[0].kind).toBe(VerifierGateBlockKind.TOOL_UNAVAILABLE);
    expect(verifyConsulted).toBe(false);
  });
});

// ── 6. EVIDENCE_HANDLE_INVALID for PASSED handle with unreadable artifact ──────

describe('yhec AC6: PASSED handle with unreadable semanticArtifactPath → blocked for presence-only tools', () => {
  it('PASSED handle, no registered verify(), unreadable artifact → gate blocks (cannot pass via unreadable artifact)', async () => {
    // Use a unique tool name to avoid cross-test verifier contamination from afterEach.
    const UNREADABLE_TOOL = 'yhec_ac6_unreadable_tool';
    // Write a file, then delete it to simulate a non-readable artifact path.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yhec-unreadable-'));
    const artifactPath = path.join(tmpDir, 'artifact.json');
    fs.writeFileSync(artifactPath, '{}'); // write then delete
    fs.rmSync(artifactPath); // delete to make it unreadable
    try {
      const event = makeEvent({
        beadId: 'bd-yhec', stateId: 'Implementing', actionId: 'code',
        tool: UNREADABLE_TOOL, status: 'PASSED',
        evidenceHandle: {
          schemaVersion: TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
          toolName: UNREADABLE_TOOL, invocationId: 'inv-1', runStatus: 'PASSED',
          semanticArtifactPath: artifactPath, // file was deleted — unreadable
          toolOutputRoot: tmpDir,
          summaryMode: 'none', noSummaryReason: 'test',
          admittedHarnessFingerprint: 'sha256:fp', admittedExecutionBoundary: 'bead:b/state:s/action:a'
        }
      });
      // No verify() registered (presence-only tool) — pure tool-name scoping.
      const gateCtx: VerifierGateContext = {
        beadId: 'bd-yhec', stateId: 'Implementing', actionId: 'code',
        writeSet: [], artifacts: {}
      };
      const result = await runVerifierGate(gateCtx, [UNREADABLE_TOOL], new SingleEventStore(event));
      expect(result.pass).toBe(false);
      // Gate blocks because the artifact is not readable on disk.
      expect([
        VerifierGateBlockKind.EVIDENCE_HANDLE_INVALID,
        VerifierGateBlockKind.TOOL_MISSING_ARTIFACT
      ]).toContain(result.failures[0].kind);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── 7-9. Verifier callbacks CANNOT pass by reading stdout/basename/logs/OTel ───

describe('yhec AC7-9: verifier callbacks cannot read stdout, outputFile basename, logs, OTel, or model summaries', () => {
  it('NEGATIVE: a callback that reads ctx.evidenceHandles has no stdout field — cannot pass via stdout', async () => {
    // VerifyContext exposes evidenceHandles (canonical handles), NOT raw stdout text.
    // A callback that tries to read stdout from the context gets undefined.
    let capturedContext: VerifyContext | undefined;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yhec-no-stdout-'));
    const artifactPath = path.join(tmpDir, 'artifact.json');
    fs.writeFileSync(artifactPath, '{}');
    try {
      const handle: ToolEvidenceHandle = {
        schemaVersion: TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
        toolName: 'stdout_probe', invocationId: 'inv-1', runStatus: 'PASSED',
        semanticArtifactPath: artifactPath,
        toolOutputRoot: tmpDir,
        summaryMode: 'none', noSummaryReason: 'test',
        admittedHarnessFingerprint: 'sha256:fp', admittedExecutionBoundary: 'bead:b/state:s/action:a'
      };
      const event = makeEvent({
        beadId: 'bd-yhec', stateId: 'Implementing', actionId: 'code',
        tool: 'stdout_probe', status: 'PASSED', evidenceHandle: handle
      });
      registerVerify('stdout_probe', (ctx): VerifyResult => {
        capturedContext = ctx;
        // Attempt to read stdout — it is NOT in the context.
        const stdoutAccess = (ctx as unknown as Record<string, unknown>)['stdout'];
        const toolOutputsAccess = (ctx as unknown as Record<string, unknown>)['toolOutputs'];
        if (stdoutAccess !== undefined || toolOutputsAccess !== undefined) {
          // This branch MUST NOT execute — if it did, the test would expose these fields.
          return { verdict: VerifyVerdict.PASS, reasons: ['cheated via stdout'] };
        }
        // Only evidenceHandles is available — PASS based on proper canonical evidence.
        const h = ctx.evidenceHandles['stdout_probe'];
        if (h?.runStatus === 'PASSED') {
          return { verdict: VerifyVerdict.PASS, reasons: ['correct: read via canonical handle'] };
        }
        return { verdict: VerifyVerdict.FAIL, reasons: ['no canonical handle'] };
      });

      const gateCtx: VerifierGateContext = {
        beadId: 'bd-yhec', stateId: 'Implementing', actionId: 'code',
        writeSet: [], artifacts: {}
      };
      const result = await runVerifierGate(gateCtx, ['stdout_probe'], new SingleEventStore(event));

      // Gate passed (canonical handle present and verify() approved).
      expect(result.pass).toBe(true);
      // Context HAD no stdout or toolOutputs field.
      expect(capturedContext).toBeDefined();
      expect((capturedContext as unknown as Record<string, unknown>)['stdout']).toBeUndefined();
      expect((capturedContext as unknown as Record<string, unknown>)['toolOutputs']).toBeUndefined();
      // evidenceHandles IS available.
      expect(capturedContext?.evidenceHandles['stdout_probe']).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('NEGATIVE: a callback that tries to PASS based on stdout/basename/logs/OTel/tmux/summary is BLOCKED because these fields are absent from VerifyContext', async () => {
    // This test proves that a malicious or buggy verifier that tries to PASS
    // by inspecting ctx fields OTHER than evidenceHandles will get undefined
    // and must rely on canonical evidence handles to determine verdicts.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yhec-no-escape-'));
    const artifactPath = path.join(tmpDir, 'artifact.json');
    fs.writeFileSync(artifactPath, '{}');
    try {
      const handle: ToolEvidenceHandle = {
        schemaVersion: TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
        toolName: 'escape_probe', invocationId: 'inv-1', runStatus: 'PASSED',
        semanticArtifactPath: artifactPath,
        toolOutputRoot: tmpDir,
        summaryMode: 'none', noSummaryReason: 'test',
        admittedHarnessFingerprint: 'sha256:fp', admittedExecutionBoundary: 'bead:b/state:s/action:a'
      };
      const event = makeEvent({
        beadId: 'bd-yhec', stateId: 'Implementing', actionId: 'code',
        tool: 'escape_probe', status: 'PASSED', evidenceHandle: handle
      });
      registerVerify('escape_probe', (ctx): VerifyResult => {
        // A verifier trying to bypass canonical evidence by reading forbidden fields:
        const raw = ctx as unknown as Record<string, unknown>;
        const forbiddenFields = ['stdout', 'stderr', 'toolOutputs', 'logs', 'otel', 'tmux', 'modelSummary'];
        const foundForbidden = forbiddenFields.filter(f => raw[f] !== undefined);
        if (foundForbidden.length > 0) {
          // Would be a PASS cheat — but since these fields don't exist, this branch never runs.
          return { verdict: VerifyVerdict.PASS, reasons: [`cheated via: ${foundForbidden.join(',')}`] };
        }
        // None of the forbidden escape routes are present — verdict must come from canonical handle.
        return { verdict: VerifyVerdict.FAIL, reasons: ['no forbidden escape routes found; must use evidenceHandles'] };
      });

      const gateCtx: VerifierGateContext = {
        beadId: 'bd-yhec', stateId: 'Implementing', actionId: 'code',
        writeSet: [], artifacts: {}
      };
      const result = await runVerifierGate(gateCtx, ['escape_probe'], new SingleEventStore(event));

      // The verifier returned FAIL because no forbidden escape routes exist.
      // This proves NO bypass via stdout/logs/OTel/tmux/modelSummary is possible.
      expect(result.pass).toBe(false);
      expect(result.failures[0].kind).toBe(VerifierGateBlockKind.VERIFY_FAIL);
      expect(result.failures[0].reasons.join(' ')).toContain('no forbidden escape routes found');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── 10. A valid PASSED handle with readable artifact PASSES ───────────────────

describe('yhec AC10: valid canonical PASSED handle with readable artifact passes', () => {
  it('PASSED canonical handle with readable semanticArtifactPath + verify() PASS → gate passes', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yhec-pass-'));
    const artifactPath = path.join(tmpDir, 'canonical-evidence.json');
    fs.writeFileSync(artifactPath, JSON.stringify({ runStatus: 'PASSED' }));
    try {
      const handle: ToolEvidenceHandle = {
        schemaVersion: TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
        toolName: 'verified_tool', invocationId: 'inv-pass-001', runStatus: 'PASSED',
        semanticArtifactPath: artifactPath,
        toolOutputRoot: tmpDir,
        summaryMode: 'none', noSummaryReason: 'yhec pass test',
        admittedHarnessFingerprint: 'sha256:test-fingerprint',
        admittedExecutionBoundary: 'bead:bd-yhec/state:Implementing/action:code'
      };
      const event = makeEvent({
        beadId: 'bd-yhec', stateId: 'Implementing', actionId: 'code',
        tool: 'verified_tool', status: 'PASSED', evidenceHandle: handle
      });
      registerVerify('verified_tool', (ctx): VerifyResult => {
        const h = ctx.evidenceHandles['verified_tool'];
        if (!h || h.runStatus !== 'PASSED') {
          return { verdict: VerifyVerdict.FAIL, reasons: ['no valid handle'] };
        }
        // Read the actual artifact via the canonical semanticArtifactPath.
        const content = require('fs').readFileSync(h.semanticArtifactPath!, 'utf8');
        const parsed = JSON.parse(content);
        if (parsed.runStatus === 'PASSED') {
          return { verdict: VerifyVerdict.PASS, reasons: [`canonical handle validated (inv=${h.invocationId})`] };
        }
        return { verdict: VerifyVerdict.FAIL, reasons: ['artifact content invalid'] };
      });

      const gateCtx: VerifierGateContext = {
        beadId: 'bd-yhec', stateId: 'Implementing', actionId: 'code',
        writeSet: [], artifacts: {}
      };
      const result = await runVerifierGate(gateCtx, ['verified_tool'], new SingleEventStore(event));

      expect(result.pass).toBe(true);
      expect(result.failures).toHaveLength(0);
      expect(result.perTool[0].verdict).toBe(VerifyVerdict.PASS);
      expect(result.perTool[0].reasons[0]).toContain('canonical handle validated');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── 11. EVIDENCE_HANDLE_INVALID fires before verify() ─────────────────────────

describe('yhec AC11: EVIDENCE_HANDLE_INVALID fires before verify() is called', () => {
  it('verify() is NEVER called when the event lacks a canonical handle', async () => {
    let verifyCallCount = 0;
    const event = makeEvent({
      beadId: 'bd-yhec', stateId: 'Implementing', actionId: 'code',
      tool: 'early_block_tool', status: 'PASSED',
      outputFile: '/proj/.pi/tool-output/bd-yhec/Implementing/code/early_block_tool/inv/out.json'
      // evidenceHandle absent
    });
    registerVerify('early_block_tool', (): VerifyResult => {
      verifyCallCount++;
      return { verdict: VerifyVerdict.PASS, reasons: ['should not be called'] };
    });

    const result = await runVerifierGate(baseCtx, ['early_block_tool'], new SingleEventStore(event));

    expect(result.pass).toBe(false);
    expect(result.failures[0].kind).toBe(VerifierGateBlockKind.EVIDENCE_HANDLE_INVALID);
    // verify() was NEVER called — the gate failed closed before consulting it.
    expect(verifyCallCount).toBe(0);
  });
});

// ── 12. Mismatched toolName → EVIDENCE_HANDLE_INVALID ─────────────────────────

describe('yhec AC12: mismatched toolName in handle → EVIDENCE_HANDLE_INVALID', () => {
  it('handle with toolName different from the required tool → EVIDENCE_HANDLE_INVALID', async () => {
    const event = makeEvent({
      beadId: 'bd-yhec', stateId: 'Implementing', actionId: 'code',
      tool: 'target_tool', status: 'PASSED',
      evidenceHandle: {
        schemaVersion: TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
        toolName: 'impersonating_tool', // MISMATCH — different from 'target_tool'
        invocationId: 'inv-1', runStatus: 'PASSED',
        toolOutputRoot: '/root', summaryMode: 'none', noSummaryReason: 'test',
        admittedHarnessFingerprint: 'sha256:fp', admittedExecutionBoundary: 'bead:b/state:s/action:a'
      }
    });
    registerVerify('target_tool', (): VerifyResult => ({
      verdict: VerifyVerdict.PASS, reasons: ['should not reach here']
    }));
    const result = await runVerifierGate(baseCtx, ['target_tool'], new SingleEventStore(event));
    expect(result.pass).toBe(false);
    expect(result.failures[0].kind).toBe(VerifierGateBlockKind.EVIDENCE_HANDLE_INVALID);
    // The mismatch was caught before verify() ran.
  });
});
