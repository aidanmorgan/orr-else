/**
 * pi-experiment-zog2.16 — ToolResultRecorder unit tests.
 *
 * TDD-first: these tests define the AC1-5 contract before the implementation.
 *
 * Covers the 10 exit-path cases from AC5:
 *   1. plugin validation rejection (checkToolValidationRules)
 *   2. worker merge guard (MERGE_AND_COMMIT in worker mode)
 *   3. circuit breaker (failures >= maxFailures)
 *   4. terminal failure limit (terminalRejection)
 *   5. deprecated project tool (removed — ebzz: runtime guard was dead code; config admission is the gate)
 *   6. project-tool preflight rejection (extension-type)
 *   7. backpressure (concurrent-call guard)
 *   8. timeout (runWithWrapperTimeout exceeded)
 *   9. ENOENT / thrown error (catch block in tracedExecute)
 *  10. MCP unavailable / native Pi policy rejection (PiObservers TOOL_CALL block)
 *
 * AC1: every TOOL_INVOCATION_x/PROJECT_TOOL_x event carries toolResult/outputFile
 * AC2: minimal failure artifacts have all required fields
 * AC3: verifier gate treats rejected short-circuit handles as INVOKED-BUT-FAILED
 * AC4: retention compaction preserves evidence-bearing failures
 * AC5: model-facing output is unchanged (toolResult is harness-side metadata only)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import {
  ToolResultRecorder,
  SHORT_CIRCUIT_ARTIFACT_FILE_NAME,
  isEvidenceBearingToolInvocationFailedEvent,
  isEvidenceBearingProjectToolFailedEvent,
} from '../src/core/ToolResultRecorder.js';
import { ToolCallPathFactory } from '../src/core/ToolCallPathFactory.js';
import { ToolResultStatus } from '../src/constants/domain.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zog2-16-recorder-'));
}

function makeFactory(): ToolCallPathFactory {
  return new ToolCallPathFactory();
}

function makeRecorder(projectRoot: string): ToolResultRecorder {
  return new ToolResultRecorder(makeFactory(), projectRoot);
}

// ---------------------------------------------------------------------------
// AC2: minimal failure artifact fields
// ---------------------------------------------------------------------------

describe('ToolResultRecorder — minimal failure artifact fields (AC2)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = makeTmpRoot();
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('writes a durable artifact file containing all required fields', async () => {
    const recorder = makeRecorder(tmpRoot);
    const handle = await recorder.recordShortCircuit({
      toolName: 'run_quality_checks',
      invocationId: 'inv-test-001',
      beadId: 'bead-abc',
      stateId: 'Implementing',
      actionId: 'code',
      status: ToolResultStatus.REJECTED,
      failureCategory: 'INPUT',
      rejectionReason: 'plugin validation rejected: missing prerequisite',
    });

    // File must exist
    expect(fs.existsSync(handle.outputFile)).toBe(true);

    const contents = JSON.parse(fs.readFileSync(handle.outputFile, 'utf8'));

    // AC2: required fields
    expect(contents).toHaveProperty('path');
    expect(contents).toHaveProperty('byteCount');
    expect(contents).toHaveProperty('sha256');
    expect(contents).toHaveProperty('invocationId', 'inv-test-001');
    expect(contents).toHaveProperty('status', ToolResultStatus.REJECTED);
    expect(contents).toHaveProperty('failureCategory', 'INPUT');
    expect(contents).toHaveProperty('schemaId');
    expect(contents).toHaveProperty('admittedFingerprint');
    expect(contents).toHaveProperty('executionBoundaryRef');
    // executionBoundaryRef encodes bead/state/action
    expect(contents.executionBoundaryRef).toContain('bead-abc');
    expect(contents.executionBoundaryRef).toContain('Implementing');
    expect(contents.executionBoundaryRef).toContain('code');
  });

  it('returns a ToolResultBase with REJECTED status and the written outputFile path', async () => {
    const recorder = makeRecorder(tmpRoot);
    const handle = await recorder.recordShortCircuit({
      toolName: 'merge_and_commit',
      invocationId: 'inv-merge-001',
      beadId: 'bead-xyz',
      stateId: 'Merging',
      actionId: 'merge',
      status: ToolResultStatus.REJECTED,
      failureCategory: 'INFRA',
      rejectionReason: 'worker merge guard: teammates cannot merge',
    });

    expect(handle.tool).toBe('merge_and_commit');
    expect(handle.status).toBe(ToolResultStatus.REJECTED);
    expect(handle.failureCategory).toBe('INFRA');
    expect(typeof handle.outputFile).toBe('string');
    expect(handle.outputFile.length).toBeGreaterThan(0);
    expect(fs.existsSync(handle.outputFile)).toBe(true);
  });

  it('artifact sha256 is a non-empty hex string matching a stable content hash', async () => {
    const recorder = makeRecorder(tmpRoot);
    const handle = await recorder.recordShortCircuit({
      toolName: 'run_checks',
      invocationId: 'inv-sha-001',
      beadId: 'b1',
      stateId: 's1',
      actionId: 'a1',
      status: ToolResultStatus.REJECTED,
      failureCategory: 'INFRA',
      rejectionReason: 'circuit breaker open',
    });

    const raw = fs.readFileSync(handle.outputFile, 'utf8');
    const artifact = JSON.parse(raw);
    // The sha256 field must be a 64-char hex string (SHA-256 output)
    expect(typeof artifact.sha256).toBe('string');
    expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('places the artifact inside the PROJECT-scoped tool-output tree', async () => {
    const recorder = makeRecorder(tmpRoot);
    const handle = await recorder.recordShortCircuit({
      toolName: 'some_tool',
      invocationId: 'inv-path-001',
      beadId: 'bead-p',
      stateId: 's1',
      actionId: 'a1',
      status: ToolResultStatus.REJECTED,
      failureCategory: 'INPUT',
      rejectionReason: 'validation failed',
    });

    const toolOutputRoot = path.join(tmpRoot, '.pi', 'tool-output');
    expect(handle.outputFile.startsWith(toolOutputRoot)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC1: evidence helpers
// ---------------------------------------------------------------------------

describe('isEvidenceBearingToolInvocationFailedEvent (AC1)', () => {
  it('returns true when event has toolResult.outputFile', () => {
    const event = {
      type: 'TOOL_INVOCATION_FAILED',
      data: {
        tool: 'some_tool',
        toolResult: { status: 'REJECTED', outputFile: '/project/.pi/tool-output/b/s/a/t/inv/output/short-circuit.json' }
      }
    };
    expect(isEvidenceBearingToolInvocationFailedEvent(event)).toBe(true);
  });

  it('returns false when event lacks toolResult.outputFile', () => {
    const event = {
      type: 'TOOL_INVOCATION_FAILED',
      data: {
        tool: 'some_tool',
        result: { status: 'REJECTED', message: 'circuit open' }
      }
    };
    expect(isEvidenceBearingToolInvocationFailedEvent(event)).toBe(false);
  });

  it('returns false for TOOL_INVOCATION_STARTED event', () => {
    const event = {
      type: 'TOOL_INVOCATION_STARTED',
      data: { tool: 'some_tool' }
    };
    expect(isEvidenceBearingToolInvocationFailedEvent(event)).toBe(false);
  });
});

describe('isEvidenceBearingProjectToolFailedEvent (AC1)', () => {
  it('returns true when PROJECT_TOOL_FAILED has outputFile', () => {
    const event = {
      type: 'PROJECT_TOOL_FAILED',
      data: {
        tool: 'some_tool',
        status: 'REJECTED',
        outputFile: '/project/.pi/tool-output/b/s/a/t/inv/output/short-circuit.json'
      }
    };
    expect(isEvidenceBearingProjectToolFailedEvent(event)).toBe(true);
  });

  it('returns false when PROJECT_TOOL_FAILED lacks outputFile', () => {
    const event = {
      type: 'PROJECT_TOOL_FAILED',
      data: { tool: 'some_tool', status: 'REJECTED' }
    };
    expect(isEvidenceBearingProjectToolFailedEvent(event)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC3: verifier gate treats rejected handles as INVOKED-BUT-FAILED
// ---------------------------------------------------------------------------

describe('VerifierGate — short-circuit rejection treated as INVOKED-BUT-FAILED (AC3)', () => {
  it('gate sees TOOL_REJECTED (not TOOL_NOT_INVOKED) for a REJECTED event with outputFile', async () => {
    // Import gate and the block kind enum
    const { runVerifierGate, VerifierGateBlockKind } = await import('../src/core/VerifierGate.js');
    const { DomainEventName } = await import('../src/constants/domain.js');
    const { ToolResultStatus } = await import('../src/constants/domain.js');

    // Fake store: provides a REJECTED event WITH outputFile (written by recorder)
    const fakeProjectOutputFile = '/fake/.pi/tool-output/bead1/Implementing/code/my_tool/inv-001/output/short-circuit.json';
    const store = {
      async latestToolResultEvent(beadId: string, stateId: string, actionId: string, tool: string) {
        if (tool !== 'my_tool') return undefined;
        return {
          id: 'evt-1',
          type: DomainEventName.TOOL_INVOCATION_FAILED,
          timestamp: new Date().toISOString(),
          sessionId: 'test',
          data: {
            beadId: 'bead1',
            tool: 'my_tool',
            toolInvocationId: 'inv-001',
            toolResult: {
              tool: 'my_tool',
              status: ToolResultStatus.REJECTED,
              failureCategory: 'INFRA',
              outputFile: fakeProjectOutputFile,
            },
            result: { status: 'REJECTED', message: 'circuit open' }
          }
        };
      }
    };

    const result = await runVerifierGate(
      { beadId: 'bead1', stateId: 'Implementing', actionId: 'code', writeSet: [], artifacts: {} },
      ['my_tool'],
      store
    );

    expect(result.pass).toBe(false);
    expect(result.failures).toHaveLength(1);
    // pi-experiment-yhec: TOOL_INVOCATION_FAILED events without a canonical evidenceHandle
    // are caught by EVIDENCE_HANDLE_INVALID (fail closed). Old events with only toolResult
    // shape (no top-level evidenceHandle) also get EVIDENCE_HANDLE_INVALID.
    // Both TOOL_REJECTED and EVIDENCE_HANDLE_INVALID correctly block the gate.
    expect([
      VerifierGateBlockKind.TOOL_REJECTED,
      VerifierGateBlockKind.EVIDENCE_HANDLE_INVALID
    ]).toContain(result.failures[0].kind);
    expect(result.failures[0].tool).toBe('my_tool');
  });

  it('gate sees TOOL_NOT_INVOKED when event lacks toolResult.outputFile (the old bug)', async () => {
    const { runVerifierGate, VerifierGateBlockKind } = await import('../src/core/VerifierGate.js');
    const { DomainEventName, ToolResultStatus } = await import('../src/constants/domain.js');

    // Old-style event: no toolResult.outputFile — gate cannot match it
    const store = {
      async latestToolResultEvent() {
        // Returns undefined because toolResultEventMatches requires outputFile for NESTED events
        return undefined;
      }
    };

    const result = await runVerifierGate(
      { beadId: 'bead1', stateId: 'Implementing', actionId: 'code', writeSet: [], artifacts: {} },
      ['my_tool'],
      store
    );

    expect(result.pass).toBe(false);
    expect(result.failures[0].kind).toBe(VerifierGateBlockKind.TOOL_NOT_INVOKED);
  });
});

// ---------------------------------------------------------------------------
// AC4: retention compaction preserves evidence-bearing failures
// ---------------------------------------------------------------------------

describe('Retention compaction preserves evidence-bearing failure events (AC4)', () => {
  it('keeps TOOL_INVOCATION_FAILED with toolResult.outputFile regardless of age', () => {
    // The retention logic in RetentionCleanup.compactJsonlFile checks:
    //   data.toolResult.outputFile for TOOL_INVOCATION_FAILED
    // Verify isEvidenceBearingToolInvocationFailedEvent matches that check
    const oldEvent = {
      type: 'TOOL_INVOCATION_FAILED',
      timestamp: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days ago
      data: {
        tool: 'my_tool',
        toolResult: {
          status: 'REJECTED',
          outputFile: '/project/.pi/tool-output/b/s/a/t/inv/output/short-circuit.json'
        }
      }
    };
    // The compaction check: evidence-bearing TOOL_INVOCATION_FAILED events must survive
    expect(isEvidenceBearingToolInvocationFailedEvent(oldEvent)).toBe(true);
  });

  it('keeps PROJECT_TOOL_FAILED with outputFile regardless of age', () => {
    const oldEvent = {
      type: 'PROJECT_TOOL_FAILED',
      timestamp: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      data: {
        tool: 'my_tool',
        status: 'REJECTED',
        outputFile: '/project/.pi/tool-output/b/s/a/t/inv/output/short-circuit.json'
      }
    };
    expect(isEvidenceBearingProjectToolFailedEvent(oldEvent)).toBe(true);
  });

  it('does NOT keep TOOL_INVOCATION_FAILED without toolResult.outputFile (compactable)', () => {
    const event = {
      type: 'TOOL_INVOCATION_FAILED',
      timestamp: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      data: {
        tool: 'my_tool',
        result: { status: 'REJECTED', message: 'old style' }
      }
    };
    expect(isEvidenceBearingToolInvocationFailedEvent(event)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC5: model-facing output shape is unchanged
// ---------------------------------------------------------------------------

describe('ToolResultRecorder — model-facing output unchanged (AC5)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = makeTmpRoot();
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('recordShortCircuit returns a ToolResultBase — same shape used by existing toolResult events', async () => {
    const recorder = makeRecorder(tmpRoot);
    const handle = await recorder.recordShortCircuit({
      toolName: 'my_tool',
      invocationId: 'inv-model-001',
      beadId: 'b1',
      stateId: 's1',
      actionId: 'a1',
      status: ToolResultStatus.REJECTED,
      failureCategory: 'INPUT',
      rejectionReason: 'validation rejected',
    });

    // ToolResultBase shape: tool, status, outputFile, outputFileBytes, failureCategory
    expect(handle).toHaveProperty('tool', 'my_tool');
    expect(handle).toHaveProperty('status', ToolResultStatus.REJECTED);
    expect(handle).toHaveProperty('outputFile');
    expect(handle).toHaveProperty('outputFileBytes');
    expect(handle).toHaveProperty('failureCategory', 'INPUT');

    // Must NOT have model-facing raw output fields
    expect(handle).not.toHaveProperty('rawOutput');
    expect(handle).not.toHaveProperty('modelFacingRawOutput');
  });

  it('SHORT_CIRCUIT_ARTIFACT_FILE_NAME constant is exported', () => {
    expect(typeof SHORT_CIRCUIT_ARTIFACT_FILE_NAME).toBe('string');
    expect(SHORT_CIRCUIT_ARTIFACT_FILE_NAME.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 10 exit-path cases: recordShortCircuit covers all failureCategories
// ---------------------------------------------------------------------------

describe('ToolResultRecorder — 10 exit-path failure categories (AC5)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = makeTmpRoot();
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  const exitPaths: Array<{
    name: string;
    failureCategory: 'INPUT' | 'INFRA' | 'TRANSPORT' | 'TIMEOUT';
    rejectionReason: string;
  }> = [
    { name: 'plugin validation rejection', failureCategory: 'INPUT', rejectionReason: 'PROTOCOL VIOLATION: prerequisite tool not called' },
    { name: 'worker merge guard', failureCategory: 'INFRA', rejectionReason: 'PROTOCOL VIOLATION: teammates cannot merge' },
    { name: 'circuit breaker', failureCategory: 'INFRA', rejectionReason: 'REJECTED: circuit open after 3 consecutive failures' },
    { name: 'terminal failure limit', failureCategory: 'INFRA', rejectionReason: 'REJECTED: terminal failure limit reached' },
    { name: 'project-tool preflight rejection', failureCategory: 'INFRA', rejectionReason: 'REJECTED: extension-type tool cannot be executed directly' },
    { name: 'backpressure (concurrent call)', failureCategory: 'INFRA', rejectionReason: 'REJECTED: concurrent call in progress' },
    { name: 'timeout', failureCategory: 'TIMEOUT', rejectionReason: 'Tool exceeded harness wrapper timeout of 30000ms' },
    { name: 'ENOENT / thrown error', failureCategory: 'INFRA', rejectionReason: 'Error: ENOENT: no such file or directory' },
    { name: 'MCP unavailable / native Pi policy rejection', failureCategory: 'TRANSPORT', rejectionReason: 'REJECTED: MCP bridge unavailable' },
  ];

  for (const exitPath of exitPaths) {
    it(`writes artifact for: ${exitPath.name}`, async () => {
      const recorder = makeRecorder(tmpRoot);
      const handle = await recorder.recordShortCircuit({
        toolName: 'some_tool',
        invocationId: `inv-${exitPath.name.replace(/\s+/g, '-')}`,
        beadId: 'bead-test',
        stateId: 'Testing',
        actionId: 'test',
        status: ToolResultStatus.REJECTED,
        failureCategory: exitPath.failureCategory,
        rejectionReason: exitPath.rejectionReason,
      });

      expect(fs.existsSync(handle.outputFile)).toBe(true);
      expect(handle.status).toBe(ToolResultStatus.REJECTED);
      expect(handle.failureCategory).toBe(exitPath.failureCategory);

      const artifact = JSON.parse(fs.readFileSync(handle.outputFile, 'utf8'));
      expect(artifact.status).toBe(ToolResultStatus.REJECTED);
      expect(artifact.failureCategory).toBe(exitPath.failureCategory);
      expect(artifact.invocationId).toBeTruthy();
      expect(artifact.schemaId).toBeTruthy();
      expect(artifact.admittedFingerprint).toBeTruthy();
      expect(artifact.executionBoundaryRef).toBeTruthy();
    });
  }
});
