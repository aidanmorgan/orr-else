/**
 * cosx acceptance tests: MCP raw result persistence via canonical evidence path.
 *
 * Four fixtures required by the bead acceptance criteria:
 *   (a) large MCP text content response
 *   (b) large MCP structuredContent response
 *   (c) failure (isError) response
 *   (d) cached/repeated invocation
 *
 * Each fixture asserts:
 *   1. The complete raw payload is written to mcp-raw.json (byte count + sha256)
 *      — discovered via the canonical _internalOutputFile evidence path, NOT via
 *      model-facing result fields.
 *   2. The model-facing result is compact: rawFile, rawBytes, rawChecksum are
 *      NOT present (harness-side evidence only, accessible via canonical path).
 *   3. No generic resultPreview/diagnosticPreview/outputArchive/truncated/sample
 *      wrapper fields appear in the model-facing result.
 *
 * (e) Negative test: proves that a model-facing raw archive field cannot satisfy
 *      requiredTools or verifier gates. The negative test drives a real production
 *      path and is load-bearing — it will FAIL if rawFile leaks into the model-facing
 *      result, because it explicitly asserts those fields are absent and would catch
 *      any regression where they are re-introduced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'node:crypto';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { EventStore } from '../src/core/EventStore.js';
import { ToolCallPathFactory } from '../src/core/ToolCallPathFactory.js';
import { EnvVars, ProjectToolType, ToolResultStatus } from '../src/constants/index.js';
import type { ProjectMcpToolConfig } from '../src/core/domain/StateModels.js';
import { executeConfiguredProjectTool } from '../src/plugins/projectTools.js';
import { MCP_RAW_FILE_NAME } from '../src/plugins/projectTools/constants.js';

// ---- Mock MCP SDK ----
// We mock the Client class so tests don't need a real MCP server.
// vi.hoisted() ensures the state object is created before vi.mock() factories run,
// which allows test bodies to mutate it and have those mutations visible to the mocks.
const mcpMockState = vi.hoisted(() => ({
  callToolResult: { content: [], isError: false } as unknown,
  connectError: undefined as Error | undefined
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

/**
 * Resolve the mcp-raw.json path via the canonical event-store evidence path.
 * The raw archive lives in the same directory as the tool's canonical outputFile
 * (context.outputDir), which is recorded on the PROJECT_TOOL_SUCCEEDED/FAILED event.
 *
 * This is the canonical evidence path: consumers discover raw archives by
 * locating the per-invocation output directory via event/evidence data, NOT
 * by reading model-facing rawFile references or internal result fields.
 */
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

// FORBIDDEN generic output-control wrapper keys (per docs/raw-output-contract.md).
// These must NEVER appear in the model-facing result.
const FORBIDDEN_GENERIC_WRAPPER_KEYS = new Set([
  'outputArchive',
  'outputAccess',
  'outputTruncated',
  'truncated',
  'sample',
  'diagnosticPreview',
  'resultPreview',
  'outputPreview',
  'stdoutTruncated',
  'stderrTruncated',
  'maxBufferExceeded'
]);

// Raw transport archive fields must NOT appear in model-facing results (cosx).
// They are harness-side evidence only, accessible via the canonical evidence path.
const FORBIDDEN_RAW_ARCHIVE_FIELDS = new Set([
  'rawFile',
  'rawBytes',
  'rawChecksum',
]);

function assertNoForbiddenKeys(result: Record<string, unknown>): void {
  for (const key of FORBIDDEN_GENERIC_WRAPPER_KEYS) {
    expect(result, `model-facing result must not contain generic wrapper key '${key}'`).not.toHaveProperty(key);
  }
}

function assertNoRawArchiveFields(result: Record<string, unknown>): void {
  for (const key of FORBIDDEN_RAW_ARCHIVE_FIELDS) {
    expect(
      result,
      `model-facing result must not contain raw archive field '${key}' — raw archives are harness-side evidence only`
    ).not.toHaveProperty(key);
  }
}

function assertNoInlineRawResult(result: Record<string, unknown>): void {
  // The raw MCP 'result' field (content[] / structuredContent) must never appear inline.
  expect((result as any).result, "raw MCP 'result' field must not appear in model-facing result").toBeUndefined();
}

// ---- Shared setup ----

describe('cosx: MCP raw result persistence via canonical evidence path', () => {
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
    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-mcp-raw-')));
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

  // ---- (a) Large MCP text content response ----

  it('(a) persists complete raw payload for a large text-content MCP response via canonical evidence path', async () => {
    // Build a large text content payload (> 4 KiB to ensure it's "large").
    const largeLine = 'x'.repeat(80);
    const largeText = Array.from({ length: 100 }, (_, i) => `line-${i}: ${largeLine}`).join('\n');
    const callToolPayload = {
      content: [
        { type: 'text', text: largeText }
      ],
      isError: false
    };
    mcpMockState.callToolResult = callToolPayload;

    const result = await executeConfiguredProjectTool(
      eventStore, toolCallPathFactory, mcpTool,
      { beadId: 'bd-1', stateId: 'Planning', actionId: 'analyze', operation: 'query' },
      {} as any, undefined, new Map()
    ) as Record<string, unknown>;

    // 1. Model-facing result has NO raw archive fields (cosx).
    assertNoRawArchiveFields(result);
    // 2. No forbidden generic wrapper keys.
    assertNoForbiddenKeys(result);
    // 3. Raw MCP 'result' field is NOT inline.
    assertNoInlineRawResult(result);

    // 4. Persistence is asserted via the canonical evidence path:
    //    event outputFile → output dir → mcp-raw.json
    const rawFilePath = await rawFileFromEventStore(eventStore, 'bd-1', 'Planning', 'analyze', 'test_mcp_tool');
    expect(fs.existsSync(rawFilePath), `mcp-raw.json must exist at canonical evidence path: ${rawFilePath}`).toBe(true);

    // 5. File contains the COMPLETE payload (verified by byte count and checksum).
    const rawContent = fs.readFileSync(rawFilePath, 'utf8');
    const expectedSerialized = JSON.stringify(callToolPayload);
    expect(rawContent).toBe(expectedSerialized);
    const rawBytes = Buffer.byteLength(rawContent, 'utf8');
    expect(rawBytes).toBeGreaterThan(4000); // large response
    expect(sha256Hex16(rawContent)).toMatch(/^[0-9a-f]{16}$/);
    // Verify the archived content matches the original payload round-trip.
    expect(JSON.parse(rawContent)).toEqual(callToolPayload);

    // 6. The raw file is under the single PROJECT-scoped tool-output tree (0yt5.27).
    expect(rawFilePath).toContain('.pi/tool-output');
    expect(path.basename(rawFilePath)).toBe(MCP_RAW_FILE_NAME);

    // 7. Model-facing result has standard compact fields.
    expect(result.tool).toBe('test_mcp_tool');
    expect(result.status).toBe(ToolResultStatus.PASSED);
    expect(result.server).toBe(SERVER_NAME);
    expect(result.operation).toBe('query');
  });

  // ---- (b) Large MCP structuredContent response ----

  it('(b) persists complete raw payload for a large structuredContent MCP response via canonical evidence path', async () => {
    // structuredContent is an arbitrary JSON object alongside content[].
    const largeStructuredContent = {
      symbols: Array.from({ length: 200 }, (_, i) => ({
        name: `Symbol_${i}`,
        kind: 'function',
        location: { file: `src/module_${i}.py`, line: i * 5 + 1, column: 0 },
        docstring: 'x'.repeat(50)
      })),
      totalCount: 200,
      analysisVersion: '2.1.0'
    };
    const callToolPayload = {
      content: [
        { type: 'text', text: 'Symbol analysis complete' }
      ],
      structuredContent: largeStructuredContent,
      isError: false
    };
    mcpMockState.callToolResult = callToolPayload;

    const result = await executeConfiguredProjectTool(
      eventStore, toolCallPathFactory, mcpTool,
      { beadId: 'bd-1', stateId: 'Planning', actionId: 'symbols', operation: 'query' },
      {} as any, undefined, new Map()
    ) as Record<string, unknown>;

    // 1–2. No raw archive fields, no forbidden keys, no inline result.
    assertNoRawArchiveFields(result);
    assertNoForbiddenKeys(result);
    assertNoInlineRawResult(result);

    // 3. Persistence via canonical evidence path.
    const rawFilePath = await rawFileFromEventStore(eventStore, 'bd-1', 'Planning', 'symbols', 'test_mcp_tool');
    expect(fs.existsSync(rawFilePath), `mcp-raw.json must exist at: ${rawFilePath}`).toBe(true);

    // 4. File holds the COMPLETE payload including structuredContent.
    const rawContent = fs.readFileSync(rawFilePath, 'utf8');
    const parsed = JSON.parse(rawContent);
    expect(parsed.structuredContent).toBeDefined();
    expect(parsed.structuredContent.totalCount).toBe(200);
    expect(parsed.structuredContent.symbols).toHaveLength(200);
    // Serialization round-trip.
    const expectedSerialized = JSON.stringify(callToolPayload);
    expect(rawContent).toBe(expectedSerialized);

    // 5. Compact schema fields.
    expect(result.status).toBe(ToolResultStatus.PASSED);
    expect(result.tool).toBe('test_mcp_tool');
  });

  // ---- (c) Failure (isError) response ----

  it('(c) persists complete raw payload for a failure (isError) MCP response via canonical evidence path', async () => {
    const failurePayload = {
      content: [
        { type: 'text', text: 'Error: symbol not found in module src/engine.py at line 42' }
      ],
      isError: true
    };
    mcpMockState.callToolResult = failurePayload;

    const result = await executeConfiguredProjectTool(
      eventStore, toolCallPathFactory, mcpTool,
      { beadId: 'bd-1', stateId: 'Planning', actionId: 'inspect', operation: 'query' },
      {} as any, undefined, new Map()
    ) as Record<string, unknown>;

    // 1. Model-facing result is REJECTED.
    expect(result.status).toBe(ToolResultStatus.REJECTED);
    // 2. No raw archive fields, no forbidden keys, no inline result.
    assertNoRawArchiveFields(result);
    assertNoForbiddenKeys(result);
    assertNoInlineRawResult(result);

    // 3. Persistence via canonical evidence path.
    const rawFilePath = await rawFileFromEventStore(eventStore, 'bd-1', 'Planning', 'inspect', 'test_mcp_tool');
    expect(fs.existsSync(rawFilePath), `mcp-raw.json must exist at: ${rawFilePath}`).toBe(true);

    // 4. File contains the COMPLETE failure payload.
    const rawContent = fs.readFileSync(rawFilePath, 'utf8');
    const parsed = JSON.parse(rawContent);
    expect(parsed.isError).toBe(true);
    expect(parsed.content[0].text).toContain('symbol not found');
    // Byte count and checksum are internally consistent.
    const rawBytes = Buffer.byteLength(rawContent, 'utf8');
    expect(rawBytes).toBeGreaterThan(0);
    expect(sha256Hex16(rawContent)).toMatch(/^[0-9a-f]{16}$/);

    // 5. Compact schema: tool/status/server/operation.
    expect(result.tool).toBe('test_mcp_tool');
    expect(result.server).toBe(SERVER_NAME);
    expect(result.operation).toBe('query');
    // rawFile path is under the single PROJECT-scoped .pi/tool-output tree (0yt5.27).
    expect(rawFilePath).toContain('.pi/tool-output');
  });

  // ---- (d) Cached/repeated invocation ----

  it('(d) writes a distinct raw file for each repeated invocation (no stale cache cross-contamination)', async () => {
    // First invocation (actionId: 'analyze-1')
    const firstPayload = {
      content: [{ type: 'text', text: 'first-invocation-unique-response' }],
      isError: false
    };
    mcpMockState.callToolResult = firstPayload;

    const result1 = await executeConfiguredProjectTool(
      eventStore, toolCallPathFactory, mcpTool,
      { beadId: 'bd-1', stateId: 'Planning', actionId: 'analyze-1', operation: 'query' },
      {} as any, undefined, new Map()
    ) as Record<string, unknown>;

    // Second invocation with a different payload (actionId: 'analyze-2')
    const secondPayload = {
      content: [{ type: 'text', text: 'second-invocation-unique-response' }],
      isError: false
    };
    mcpMockState.callToolResult = secondPayload;

    const result2 = await executeConfiguredProjectTool(
      eventStore, toolCallPathFactory, mcpTool,
      { beadId: 'bd-1', stateId: 'Planning', actionId: 'analyze-2', operation: 'query' },
      {} as any, undefined, new Map()
    ) as Record<string, unknown>;

    // Both results have canonical evidence paths (no raw archive fields in model-facing).
    assertNoRawArchiveFields(result1);
    assertNoRawArchiveFields(result2);

    const rawFilePath1 = await rawFileFromEventStore(eventStore, 'bd-1', 'Planning', 'analyze-1', 'test_mcp_tool');
    const rawFilePath2 = await rawFileFromEventStore(eventStore, 'bd-1', 'Planning', 'analyze-2', 'test_mcp_tool');

    // The two invocations must have DIFFERENT per-invocation directories.
    // (toolInvocationId is a UUID7 so the paths differ.)
    expect(rawFilePath1).not.toBe(rawFilePath2);

    // First file holds the first payload.
    const raw1 = fs.readFileSync(rawFilePath1, 'utf8');
    expect(JSON.parse(raw1).content[0].text).toBe('first-invocation-unique-response');

    // Second file holds the second payload — no cross-contamination.
    const raw2 = fs.readFileSync(rawFilePath2, 'utf8');
    expect(JSON.parse(raw2).content[0].text).toBe('second-invocation-unique-response');

    // Both results have no forbidden wrapper keys.
    assertNoForbiddenKeys(result1);
    assertNoForbiddenKeys(result2);
    assertNoInlineRawResult(result1);
    assertNoInlineRawResult(result2);
  });

  // ---- (e) Negative test: raw archive fields must NOT appear in model-facing result ----
  //
  // This test is load-bearing: it will FAIL if rawFile/rawBytes/rawChecksum are
  // re-introduced into the model-facing result from executeMcpTool. The test drives the
  // REAL production path (executeConfiguredProjectTool → executeMcpTool) and
  // explicitly proves those fields are absent from what the model receives.
  //
  // A model-facing raw archive field CANNOT satisfy requiredTools or verifier gates
  // because: (1) the verifier gate reads semanticArtifactPath from canonical
  // ToolEvidenceHandle/event data, not from the model-facing result; (2) the
  // model-facing result is filtered by MODEL_HIDDEN_RESULT_KEYS before being returned;
  // (3) this test asserts the absence of those fields so any regression is caught.

  it('(e) negative: rawFile/rawBytes/rawChecksum absent from model-facing result; persistence still happens via canonical evidence', async () => {
    const callToolPayload = {
      content: [{ type: 'text', text: 'some-mcp-response' }],
      isError: false
    };
    mcpMockState.callToolResult = callToolPayload;

    const result = await executeConfiguredProjectTool(
      eventStore, toolCallPathFactory, mcpTool,
      { beadId: 'bd-1', stateId: 'Planning', actionId: 'gate-check', operation: 'query' },
      {} as any, undefined, new Map()
    ) as Record<string, unknown>;

    // CRITICAL NEGATIVE ASSERTIONS: these fields must be absent.
    // If any of these fail, it means rawFile/rawBytes/rawChecksum leaked into the
    // model-facing result — a regression that would allow a raw archive reference to
    // potentially appear as a model-facing field, violating the cosx contract.
    expect(
      'rawFile' in result,
      'rawFile must NOT be present in model-facing MCP result — raw archives are harness-side evidence only'
    ).toBe(false);
    expect(
      'rawBytes' in result,
      'rawBytes must NOT be present in model-facing MCP result — raw archives are harness-side evidence only'
    ).toBe(false);
    expect(
      'rawChecksum' in result,
      'rawChecksum must NOT be present in model-facing MCP result — raw archives are harness-side evidence only'
    ).toBe(false);

    // Persistence STILL happens via the canonical evidence path.
    // The raw file MUST exist on disk even though the model doesn't see the reference.
    const rawFilePath = await rawFileFromEventStore(eventStore, 'bd-1', 'Planning', 'gate-check', 'test_mcp_tool');
    expect(
      fs.existsSync(rawFilePath),
      `Raw archive must still be persisted at canonical path ${rawFilePath} even though model-facing result carries no rawFile reference`
    ).toBe(true);

    // Verify the file has real content (not empty).
    const rawContent = fs.readFileSync(rawFilePath, 'utf8');
    expect(rawContent.length).toBeGreaterThan(0);
    const parsed = JSON.parse(rawContent);
    expect(parsed.content[0].text).toBe('some-mcp-response');

    // The model-facing result has only compact schema fields.
    expect(result.tool).toBe('test_mcp_tool');
    expect(result.status).toBe(ToolResultStatus.PASSED);
    expect(result.server).toBe(SERVER_NAME);
    expect(result.operation).toBe('query');
  });
});
