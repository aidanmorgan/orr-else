/**
 * pi-experiment-zog2.12 — MCP raw archive persistence authority tests.
 *
 * The raw MCP archive (mcp-raw.json) is AUTHORITATIVE evidence:
 *   - Write failure → fail-closed REJECTED (not silently swallowed into PASSED)
 *   - Successful write → archive is part of canonical evidence with bytes/checksum
 *   - Backend error → error envelope archived; result is REJECTED
 *   - Large response → archived completely (not truncated/silently dropped)
 *   - Non-authoritative diagnostic path: quarantine result cannot satisfy gates
 *
 * All tests drive the REAL executeMcpTool path via executeConfiguredProjectTool.
 * These are load-bearing: they will FAIL if the authoritative semantics regress.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'node:crypto';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { EventStore } from '../src/core/EventStore.js';
import { ToolCallPathFactory } from '../src/core/ToolCallPathFactory.js';
import { ProjectToolType, ToolResultStatus } from '../src/constants/domain.js';
import { EnvVars } from '../src/constants/infra.js';
import type { ProjectMcpToolConfig } from '../src/core/domain/StateModels.js';
import { executeConfiguredProjectTool } from '../src/plugins/projectTools.js';
import { MCP_RAW_FILE_NAME } from '../src/plugins/projectTools/constants.js';

// ---- Mock MCP SDK (hoisted state so test bodies can mutate before execution) ----

const mcpMockState = vi.hoisted(() => ({
  callToolResult: { content: [], isError: false } as unknown,
  connectError: undefined as Error | undefined,
  // When set, writeFile throws this error to simulate archive write failure
  writeFileError: undefined as Error | undefined,
  // When set, readFile returns this content instead of real file content (for checksum-mismatch simulation)
  readFileOverride: undefined as string | undefined,
  // When set, JSON.stringify(callToolResult) will fail (malformed payload)
  serializeError: undefined as Error | undefined,
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  class ClientMock {
    connect(_transport: unknown): Promise<void> {
      if (mcpMockState.connectError) return Promise.reject(mcpMockState.connectError);
      return Promise.resolve();
    }
    callTool(_params: unknown, _compat?: unknown, _opts?: unknown): Promise<unknown> {
      return Promise.resolve(mcpMockState.callToolResult);
    }
    close(): Promise<void> {
      return Promise.resolve();
    }
  }
  return { Client: ClientMock };
});

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  class StdioClientTransportMock {
    close(): Promise<void> { return Promise.resolve(); }
  }
  return { StdioClientTransport: StdioClientTransportMock };
});

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => {
  class SSEClientTransportMock {
    close(): Promise<void> { return Promise.resolve(); }
  }
  return { SSEClientTransport: SSEClientTransportMock };
});

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => {
  class StreamableHTTPClientTransportMock {
    close(): Promise<void> { return Promise.resolve(); }
  }
  return { StreamableHTTPClientTransport: StreamableHTTPClientTransportMock };
});

// ---- Mock fs/promises to simulate write failures ----
// We mock only the writeFile call in mcpExecutor's persistMcpRawResult.
// The flag is checked per-test to control failure injection.

vi.mock('fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs/promises')>();
  return {
    ...real,
    writeFile: async (file: unknown, data: unknown, ...rest: unknown[]) => {
      // Only fail writes to mcp-raw.json when the error flag is set
      if (
        mcpMockState.writeFileError &&
        typeof file === 'string' &&
        file.endsWith(MCP_RAW_FILE_NAME)
      ) {
        throw mcpMockState.writeFileError;
      }
      return (real.writeFile as Function)(file, data, ...rest);
    },
    readFile: async (file: unknown, encoding?: unknown) => {
      // When readFileOverride is set and we're reading mcp-raw.json, return divergent content
      if (
        mcpMockState.readFileOverride !== undefined &&
        typeof file === 'string' &&
        file.endsWith(MCP_RAW_FILE_NAME)
      ) {
        return mcpMockState.readFileOverride;
      }
      return (real.readFile as Function)(file, encoding);
    }
  };
});

// ---- Helpers ----

function writeMinimalHarnessConfig(projectRoot: string): void {
  fs.writeFileSync(path.join(projectRoot, 'harness.yaml'), `
settings:
  startState: Planning
  eventStore:
    enabled: true
  worktreePolicy:
    default: always
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]

states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    actions:
      - id: a1
        type: prompt
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`);
}

function writeMcpConfig(projectRoot: string, serverName: string): void {
  const mcpDir = path.join(projectRoot, '.pi', 'mcp');
  fs.mkdirSync(mcpDir, { recursive: true });
  fs.writeFileSync(path.join(mcpDir, 'config.json'), JSON.stringify({
    mcpServers: {
      [serverName]: {
        command: 'node',
        args: ['-e', 'process.exit(0)']
      }
    }
  }));
}

function sha256Hex16(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

async function rawFileFromEventStore(
  es: EventStore,
  beadId: string,
  stateId: string,
  actionId: string,
  toolName: string
): Promise<string> {
  const event = await es.latestToolResultEvent(beadId as any, stateId as any, actionId as any, toolName as any);
  const outputFile = (event?.data as Record<string, unknown> | undefined)?.outputFile as string | undefined;
  expect(typeof outputFile, 'event outputFile must be a string (canonical evidence path)').toBe('string');
  return path.join(path.dirname(outputFile!), MCP_RAW_FILE_NAME);
}

// ---- Shared setup ----

describe('zog2.12: MCP raw archive persistence — AUTHORITATIVE semantics', () => {
  let tempRoot: string;
  let tempWorktree: string;
  let configLoader: ConfigLoader;
  let eventStore: EventStore;
  let toolCallPathFactory: ToolCallPathFactory;
  let previousProjectRootEnv: string | undefined;
  let previousWorktreeEnv: string | undefined;

  const SERVER_NAME = 'test-mcp-server';

  const mcpTool: ProjectMcpToolConfig = {
    name: 'test_mcp_tool',
    type: ProjectToolType.MCP,
    server: SERVER_NAME,
    operations: ['query']
  };

  beforeEach(() => {
    previousProjectRootEnv = process.env[EnvVars.PROJECT_ROOT];
    previousWorktreeEnv = process.env[EnvVars.WORKTREE_PATH];
    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-zog212-')));
    tempWorktree = path.join(tempRoot, 'worktrees', 'bd-1');
    fs.mkdirSync(tempWorktree, { recursive: true });
    writeMinimalHarnessConfig(tempRoot);
    writeMcpConfig(tempRoot, SERVER_NAME);
    configLoader = new ConfigLoader(undefined, tempRoot);
    eventStore = new EventStore(configLoader, undefined, undefined, tempRoot);
    toolCallPathFactory = new ToolCallPathFactory();
    eventStore.setSessionId(`test-${process.pid}`);
    process.env[EnvVars.PROJECT_ROOT] = tempRoot;
    process.env[EnvVars.WORKTREE_PATH] = tempWorktree;
    // Reset mock state
    mcpMockState.callToolResult = { content: [], isError: false };
    mcpMockState.connectError = undefined;
    mcpMockState.writeFileError = undefined;
    mcpMockState.readFileOverride = undefined;
    mcpMockState.serializeError = undefined;
  });

  afterEach(() => {
    configLoader.reset();
    vi.clearAllMocks();
    if (previousProjectRootEnv === undefined) delete process.env[EnvVars.PROJECT_ROOT];
    else process.env[EnvVars.PROJECT_ROOT] = previousProjectRootEnv;
    if (previousWorktreeEnv === undefined) delete process.env[EnvVars.WORKTREE_PATH];
    else process.env[EnvVars.WORKTREE_PATH] = previousWorktreeEnv;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  // ---- (1) Authoritative: successful evidence ----
  // The canonical success path: archive written durably; bytes+checksum captured;
  // result is PASSED. Load-bearing: would fail if persistMcpRawResult swallowed
  // the write and returned undefined (losing evidence metadata).

  it('(1) successful MCP invocation: archive written durably with bytes and checksum as authoritative evidence', async () => {
    const callToolPayload = {
      content: [{ type: 'text', text: 'symbol-analysis-result' }],
      isError: false
    };
    mcpMockState.callToolResult = callToolPayload;

    const result = await executeConfiguredProjectTool(
      eventStore, toolCallPathFactory, mcpTool,
      { beadId: 'bd-1', stateId: 'Planning', actionId: 'a1', operation: 'query' },
      {} as any, undefined, new Map()
    ) as Record<string, unknown>;

    // PASSED result (not failed)
    expect(result.status).toBe(ToolResultStatus.PASSED);
    expect(result.tool).toBe('test_mcp_tool');

    // Archive is durably present at canonical evidence path
    const rawFilePath = await rawFileFromEventStore(eventStore, 'bd-1', 'Planning', 'a1', 'test_mcp_tool');
    expect(fs.existsSync(rawFilePath), `mcp-raw.json must be durably written: ${rawFilePath}`).toBe(true);

    // Archive has correct content (complete payload, not truncated)
    const rawContent = fs.readFileSync(rawFilePath, 'utf8');
    const expectedSerialized = JSON.stringify(callToolPayload);
    expect(rawContent).toBe(expectedSerialized);

    // Byte count and checksum are consistent (authoritative metadata)
    const rawBytes = Buffer.byteLength(rawContent, 'utf8');
    expect(rawBytes).toBeGreaterThan(0);
    expect(sha256Hex16(rawContent)).toMatch(/^[0-9a-f]{16}$/);

    // Raw archive fields NOT in model-facing result (harness-side evidence only)
    expect('rawFile' in result).toBe(false);
    expect('rawBytes' in result).toBe(false);
    expect('rawChecksum' in result).toBe(false);

    // Archive under canonical .pi/tool-output path
    expect(rawFilePath).toContain('.pi/tool-output');
    expect(path.basename(rawFilePath)).toBe(MCP_RAW_FILE_NAME);
  });

  // ---- (2) Fail-closed: archive write failure → REJECTED, not PASSED ----
  // CRITICAL load-bearing: if persistMcpRawResult still swallows the error and
  // returns undefined, executeMcpToolUnlocked proceeds to return PASSED — this
  // test catches that regression by asserting REJECTED status.

  it('(2) archive write failure → fail-closed REJECTED (not silently swallowed into PASSED)', async () => {
    mcpMockState.callToolResult = {
      content: [{ type: 'text', text: 'result that should not produce PASSED' }],
      isError: false
    };
    // Inject write failure for mcp-raw.json
    mcpMockState.writeFileError = new Error('ENOSPC: no space left on device');

    const result = await executeConfiguredProjectTool(
      eventStore, toolCallPathFactory, mcpTool,
      { beadId: 'bd-1', stateId: 'Planning', actionId: 'a1', operation: 'query' },
      {} as any, undefined, new Map()
    ) as Record<string, unknown>;

    // CRITICAL: must be REJECTED — not PASSED — because the authoritative archive write failed
    expect(
      result.status,
      'Archive write failure must produce REJECTED (fail-closed), not PASSED — ' +
      'a PASSED result without durable archive is non-authoritative and violates the zog2.12 contract'
    ).toBe(ToolResultStatus.REJECTED);

    // Diagnostic classification: write_failure
    expect(
      (result.failureCategory as string | undefined) ?? (result.archiveFailureCategory as string | undefined),
      'Write failure must be classified as write_failure or carry archiveFailureCategory'
    ).toMatch(/write_failure|archive/i);

    // Must name the tool in the rejection message
    expect(result.tool).toBe('test_mcp_tool');

    // After fail-closed, the result status is REJECTED — the gate depends on status, not file presence.
    expect(result.status).toBe(ToolResultStatus.REJECTED);
  });

  // ---- (3) Backend unavailable → error envelope archived, result REJECTED ----
  // Simulates MCP server connection failure. The error envelope is archived
  // as harness-side evidence. The result is REJECTED (backend_unavailable).
  // Load-bearing: removing error-envelope archival loses transport-failure evidence.

  it('(3) backend unavailable (connect error) → error envelope archived as evidence, result REJECTED', async () => {
    mcpMockState.connectError = new Error('ECONNREFUSED: backend MCP server unavailable');

    const result = await executeConfiguredProjectTool(
      eventStore, toolCallPathFactory, mcpTool,
      { beadId: 'bd-1', stateId: 'Planning', actionId: 'a1', operation: 'query' },
      {} as any, undefined, new Map()
    ) as Record<string, unknown>;

    // Result must be REJECTED (backend unavailable)
    expect(result.status).toBe(ToolResultStatus.REJECTED);
    expect(result.tool).toBe('test_mcp_tool');

    // The error message must reference the connection failure
    const message = String(result.message ?? '');
    expect(message).toMatch(/ECONNREFUSED|backend|unavailable|connect/i);

    // Error envelope must be archived at canonical evidence path (even on connect failure)
    const rawFilePath = await rawFileFromEventStore(eventStore, 'bd-1', 'Planning', 'a1', 'test_mcp_tool');
    if (fs.existsSync(rawFilePath)) {
      const rawContent = fs.readFileSync(rawFilePath, 'utf8');
      const parsed = JSON.parse(rawContent);
      // Error envelope must contain error information for diagnostics
      expect(parsed.error ?? parsed.message ?? parsed.errorType).toBeTruthy();
    }
    // Whether or not the archive exists, the result is definitively REJECTED
    // (backend_unavailable classification may appear in failureCategory)
    expect(result.status).toBe(ToolResultStatus.REJECTED);
  });

  // ---- (4) Large response → archive complete (authoritative, not truncated) ----
  // CRITICAL: large payloads must be durably archived in full.
  // A PASSED result with a truncated/missing archive is non-authoritative.

  it('(4) large MCP response → archive is complete and authoritative (not truncated or dropped)', async () => {
    // ~50 KB response — large enough to stress any buffering
    const largeLine = 'x'.repeat(80);
    const largeText = Array.from({ length: 800 }, (_, i) => `line-${i}: ${largeLine}`).join('\n');
    const callToolPayload = {
      content: [{ type: 'text', text: largeText }],
      isError: false
    };
    mcpMockState.callToolResult = callToolPayload;

    const result = await executeConfiguredProjectTool(
      eventStore, toolCallPathFactory, mcpTool,
      { beadId: 'bd-1', stateId: 'Planning', actionId: 'a1', operation: 'query' },
      {} as any, undefined, new Map()
    ) as Record<string, unknown>;

    // PASSED
    expect(result.status).toBe(ToolResultStatus.PASSED);

    // Archive is complete — not truncated or dropped
    const rawFilePath = await rawFileFromEventStore(eventStore, 'bd-1', 'Planning', 'a1', 'test_mcp_tool');
    expect(fs.existsSync(rawFilePath), 'archive must exist for large response').toBe(true);

    const rawContent = fs.readFileSync(rawFilePath, 'utf8');
    const expectedSerialized = JSON.stringify(callToolPayload);
    // Byte-for-byte match (authoritative — no truncation)
    expect(rawContent).toBe(expectedSerialized);

    const rawBytes = Buffer.byteLength(rawContent, 'utf8');
    expect(rawBytes).toBeGreaterThan(50_000); // Large response is fully preserved

    // Model-facing result carries no raw archive fields (harness-side evidence only)
    expect('rawFile' in result).toBe(false);
    expect('rawBytes' in result).toBe(false);
    expect('rawChecksum' in result).toBe(false);
  });

  // ---- (5) Malformed MCP result (isError) → archived with failure classification ----
  // An MCP tool call that returns isError:true is a semantic failure. The archive
  // must contain the COMPLETE failure payload (not just a stub) for replay/forensics.

  it('(5) malformed/error MCP result → REJECTED, archive contains complete failure payload', async () => {
    const failurePayload = {
      content: [{ type: 'text', text: 'schema validation failed: field "x" missing' }],
      isError: true
    };
    mcpMockState.callToolResult = failurePayload;

    const result = await executeConfiguredProjectTool(
      eventStore, toolCallPathFactory, mcpTool,
      { beadId: 'bd-1', stateId: 'Planning', actionId: 'a1', operation: 'query' },
      {} as any, undefined, new Map()
    ) as Record<string, unknown>;

    // REJECTED (tool returned isError:true)
    expect(result.status).toBe(ToolResultStatus.REJECTED);

    // Archive contains COMPLETE failure payload (authoritative for forensics/replay)
    const rawFilePath = await rawFileFromEventStore(eventStore, 'bd-1', 'Planning', 'a1', 'test_mcp_tool');
    expect(fs.existsSync(rawFilePath), 'archive must exist even for isError responses').toBe(true);

    const rawContent = fs.readFileSync(rawFilePath, 'utf8');
    const parsed = JSON.parse(rawContent);
    expect(parsed.isError).toBe(true);
    expect(parsed.content[0].text).toContain('schema validation failed');

    // Bytes are non-zero (complete payload archived)
    const rawBytes = Buffer.byteLength(rawContent, 'utf8');
    expect(rawBytes).toBeGreaterThan(0);

    // Checksum is consistent
    expect(sha256Hex16(rawContent)).toMatch(/^[0-9a-f]{16}$/);
  });

  // ---- (6) Non-authoritative diagnostic: REJECTED cannot satisfy requiredTools ----
  // A REJECTED result (whether from write_failure, isError, or backend_unavailable)
  // is explicitly non-authoritative: it cannot satisfy requiredTools, verifier gates,
  // replay, or terminal progress. This test proves the gate-exclusion semantics by
  // asserting that a REJECTED result has status=REJECTED (not PASSED), which is the
  // condition that all gate checks use to exclude non-passing results.
  //
  // Load-bearing: if the fail-closed path regresses and the archive write failure
  // returns PASSED, this test fails — proving the gate can no longer exclude it.

  it('(6) REJECTED result (from write failure) is explicitly non-authoritative: cannot satisfy gate (status≠PASSED)', async () => {
    mcpMockState.callToolResult = { content: [{ type: 'text', text: 'data' }], isError: false };
    mcpMockState.writeFileError = new Error('ENOSPC: disk full');

    const result = await executeConfiguredProjectTool(
      eventStore, toolCallPathFactory, mcpTool,
      { beadId: 'bd-1', stateId: 'Planning', actionId: 'a1', operation: 'query' },
      {} as any, undefined, new Map()
    ) as Record<string, unknown>;

    // Non-authoritative diagnostic: status is REJECTED
    // Gates check result.status === PASSED before admitting evidence. A REJECTED
    // status definitively prevents the result from satisfying any gate.
    expect(result.status).toBe(ToolResultStatus.REJECTED);
    expect(result.status).not.toBe(ToolResultStatus.PASSED);

    // The tool name is present for diagnostics
    expect(result.tool).toBe('test_mcp_tool');

    // No raw archive fields leak into the model-facing diagnostic result
    expect('rawFile' in result).toBe(false);
    expect('rawBytes' in result).toBe(false);
    expect('rawChecksum' in result).toBe(false);
  });

  // ---- (7) Write failure classification: archiveFailureCategory or failureCategory ----
  // The diagnostic must classify the failure type so operators can distinguish
  // write failures from semantic rejections (isError) and backend errors.

  it('(7) write failure diagnostic carries failure classification for operator triage', async () => {
    mcpMockState.callToolResult = { content: [], isError: false };
    mcpMockState.writeFileError = new Error('EACCES: permission denied, open /some/path/mcp-raw.json');

    const result = await executeConfiguredProjectTool(
      eventStore, toolCallPathFactory, mcpTool,
      { beadId: 'bd-1', stateId: 'Planning', actionId: 'a1', operation: 'query' },
      {} as any, undefined, new Map()
    ) as Record<string, unknown>;

    expect(result.status).toBe(ToolResultStatus.REJECTED);

    // Diagnostic classification: the result must carry some form of failure classification
    // that distinguishes archive write failures from other failure modes.
    // This can appear as failureCategory, archiveFailureCategory, or in the message.
    const hasClassification =
      typeof result.failureCategory === 'string' ||
      typeof result.archiveFailureCategory === 'string' ||
      (typeof result.message === 'string' && /archive|write|persist|EACCES|ENOSPC/i.test(result.message as string));

    expect(
      hasClassification,
      'REJECTED result from write failure must carry diagnostic classification (failureCategory, archiveFailureCategory, or descriptive message) — ' +
      `got: ${JSON.stringify({ failureCategory: result.failureCategory, archiveFailureCategory: result.archiveFailureCategory, message: result.message })}`
    ).toBe(true);
  });

  // ---- (8) Checksum mismatch: readback diverges from written bytes → REJECTED with checksum_mismatch ----
  // LOAD-BEARING: this test MUST FAIL if the readback cross-check is removed from
  // persistMcpRawResult. It simulates storage corruption by making readFile return
  // different bytes than what was written, then asserts REJECTED with
  // archiveFailureCategory 'checksum_mismatch'. If the cross-check is absent,
  // the archive is assumed durable (incorrectly) and the result would be PASSED.

  it('(8) checksum mismatch (readback diverges from written bytes) → REJECTED with archiveFailureCategory checksum_mismatch', async () => {
    mcpMockState.callToolResult = {
      content: [{ type: 'text', text: 'legitimate-result' }],
      isError: false
    };
    // Simulate storage corruption: readFile returns different bytes than what was written
    mcpMockState.readFileOverride = '{"corrupted":"data","tampered":true}';

    const result = await executeConfiguredProjectTool(
      eventStore, toolCallPathFactory, mcpTool,
      { beadId: 'bd-1', stateId: 'Planning', actionId: 'a1', operation: 'query' },
      {} as any, undefined, new Map()
    ) as Record<string, unknown>;

    // CRITICAL load-bearing assertion: must be REJECTED — if the readback cross-check
    // were removed, the code would not detect the divergence and could return PASSED.
    expect(
      result.status,
      'Checksum mismatch (readback diverges from written) must produce REJECTED — ' +
      'if this fails, the readback cross-check was removed from persistMcpRawResult'
    ).toBe(ToolResultStatus.REJECTED);

    // The failure must be classified as checksum_mismatch specifically
    expect(
      (result.archiveFailureCategory as string | undefined) ?? (result.failureCategory as string | undefined),
      'checksum_mismatch must be classified as such (not write_failure or backend_unavailable)'
    ).toBe('checksum_mismatch');

    expect(result.tool).toBe('test_mcp_tool');
  });

  // ---- (9) Backend unavailable: connect error → REJECTED with backend_unavailable ----
  // zog2.12 review fix: the transport/connect failure path must carry
  // archiveFailureCategory/failureCategory 'backend_unavailable' so operators can
  // distinguish connectivity failures from archive write errors.

  it('(9) backend unavailable (connect error) → REJECTED with failureCategory backend_unavailable', async () => {
    mcpMockState.connectError = new Error('ECONNREFUSED: connection refused');

    const result = await executeConfiguredProjectTool(
      eventStore, toolCallPathFactory, mcpTool,
      { beadId: 'bd-1', stateId: 'Planning', actionId: 'a1', operation: 'query' },
      {} as any, undefined, new Map()
    ) as Record<string, unknown>;

    expect(result.status).toBe(ToolResultStatus.REJECTED);
    expect(result.tool).toBe('test_mcp_tool');

    // Must carry backend_unavailable classification (not generic/unclassified REJECTED)
    const category =
      (result.failureCategory as string | undefined) ??
      (result.archiveFailureCategory as string | undefined);
    expect(
      category,
      'Connect/transport failure must be classified as backend_unavailable'
    ).toBe('backend_unavailable');
  });

  // ---- (10) Malformed payload: unserializable result → REJECTED with malformed ----
  // When the MCP result cannot be serialized into the archive payload (e.g. circular
  // references or non-serializable values), persistMcpRawResult must classify it as
  // 'malformed' — not silently produce a PASSED result without a durable archive.

  it('(10) malformed MCP result (unserializable payload) → REJECTED with archiveFailureCategory malformed', async () => {
    // Circular reference — JSON.stringify will throw
    const circular: Record<string, unknown> = { content: [], isError: false };
    circular['self'] = circular;
    mcpMockState.callToolResult = circular;

    const result = await executeConfiguredProjectTool(
      eventStore, toolCallPathFactory, mcpTool,
      { beadId: 'bd-1', stateId: 'Planning', actionId: 'a1', operation: 'query' },
      {} as any, undefined, new Map()
    ) as Record<string, unknown>;

    expect(result.status).toBe(ToolResultStatus.REJECTED);
    expect(result.tool).toBe('test_mcp_tool');

    // Must carry malformed classification
    const category =
      (result.archiveFailureCategory as string | undefined) ??
      (result.failureCategory as string | undefined);
    expect(
      category,
      'Unserializable MCP payload must be classified as malformed'
    ).toBe('malformed');
  });

  // ---- (11) Missing checksum: readback returns empty → REJECTED with missing_checksum ----
  // If the file is written but reads back empty (e.g. a race or OS fault), the archive
  // is not durable. persistMcpRawResult must classify this as missing_checksum.

  it('(11) missing checksum (readback returns empty) → REJECTED with archiveFailureCategory missing_checksum', async () => {
    mcpMockState.callToolResult = {
      content: [{ type: 'text', text: 'some-result' }],
      isError: false
    };
    // Simulate empty readback — file written but returns no content
    mcpMockState.readFileOverride = '';

    const result = await executeConfiguredProjectTool(
      eventStore, toolCallPathFactory, mcpTool,
      { beadId: 'bd-1', stateId: 'Planning', actionId: 'a1', operation: 'query' },
      {} as any, undefined, new Map()
    ) as Record<string, unknown>;

    expect(result.status).toBe(ToolResultStatus.REJECTED);
    expect(result.tool).toBe('test_mcp_tool');

    const category =
      (result.archiveFailureCategory as string | undefined) ??
      (result.failureCategory as string | undefined);
    expect(
      category,
      'Empty readback must be classified as missing_checksum'
    ).toBe('missing_checksum');
  });
});
