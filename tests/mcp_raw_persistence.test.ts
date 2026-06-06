/**
 * s3wp.26 acceptance tests: raw MCP call-tool result persistence.
 *
 * Four fixtures required by the bead acceptance criteria:
 *   (a) large MCP text content response
 *   (b) large MCP structuredContent response
 *   (c) failure (isError) response
 *   (d) cached/repeated invocation
 *
 * Each fixture asserts:
 *   1. The complete raw payload is written to mcp-raw.json (byte count + sha256).
 *   2. The model-facing result is compact: no generic resultPreview/diagnosticPreview/
 *      outputArchive/truncated/sample wrapper fields, no inline 'result' content blob.
 *   3. rawFile, rawBytes, rawChecksum appear in the model-facing result.
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
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    actions: []
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

function assertNoForbiddenKeys(result: Record<string, unknown>): void {
  for (const key of FORBIDDEN_GENERIC_WRAPPER_KEYS) {
    expect(result, `model-facing result must not contain generic wrapper key '${key}'`).not.toHaveProperty(key);
  }
}

function assertNoInlineRawResult(result: Record<string, unknown>): void {
  // The raw MCP 'result' field (content[] / structuredContent) must never appear inline.
  expect((result as any).result, "raw MCP 'result' field must not appear in model-facing result").toBeUndefined();
}

// ---- Shared setup ----

describe('s3wp.26: MCP raw result persistence', () => {
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

  it('(a) persists complete raw payload for a large text-content MCP response', async () => {
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

    // 1. Compact model-facing schema: no forbidden generic wrapper keys.
    assertNoForbiddenKeys(result);
    // 2. Raw MCP 'result' field is NOT inline.
    assertNoInlineRawResult(result);
    // 3. rawFile reference is present and the file exists.
    expect(typeof result.rawFile).toBe('string');
    expect(result.rawBytes).toBeGreaterThan(4000); // large response
    expect(typeof result.rawChecksum).toBe('string');
    expect((result.rawChecksum as string).length).toBe(16); // 16-hex-char truncated sha256
    const rawFilePath = result.rawFile as string;
    expect(fs.existsSync(rawFilePath)).toBe(true);
    // 4. File contains the COMPLETE payload (verified by byte count and checksum).
    const rawContent = fs.readFileSync(rawFilePath, 'utf8');
    const expectedSerialized = JSON.stringify(callToolPayload);
    expect(rawContent).toBe(expectedSerialized);
    expect(Buffer.byteLength(rawContent, 'utf8')).toBe(result.rawBytes);
    expect(sha256Hex16(rawContent)).toBe(result.rawChecksum);
    // 5. The raw file is under the single PROJECT-scoped tool-output tree (0yt5.27).
    expect(rawFilePath).toContain('.pi/tool-output');
    expect(path.basename(rawFilePath)).toBe(MCP_RAW_FILE_NAME);
    // 6. Model-facing result has standard compact fields.
    expect(result.tool).toBe('test_mcp_tool');
    expect(result.status).toBe(ToolResultStatus.PASSED);
    expect(result.server).toBe(SERVER_NAME);
    expect(result.operation).toBe('query');
  });

  // ---- (b) Large MCP structuredContent response ----

  it('(b) persists complete raw payload for a large structuredContent MCP response', async () => {
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

    // 1–2. No forbidden keys, no inline result.
    assertNoForbiddenKeys(result);
    assertNoInlineRawResult(result);
    // 3. rawFile reference exists.
    expect(typeof result.rawFile).toBe('string');
    const rawFilePath = result.rawFile as string;
    expect(fs.existsSync(rawFilePath)).toBe(true);
    // 4. File holds the COMPLETE payload including structuredContent.
    const rawContent = fs.readFileSync(rawFilePath, 'utf8');
    const parsed = JSON.parse(rawContent);
    expect(parsed.structuredContent).toBeDefined();
    expect(parsed.structuredContent.totalCount).toBe(200);
    expect(parsed.structuredContent.symbols).toHaveLength(200);
    // Checksum and byte count match.
    const expectedSerialized = JSON.stringify(callToolPayload);
    expect(rawContent).toBe(expectedSerialized);
    expect(Buffer.byteLength(rawContent, 'utf8')).toBe(result.rawBytes);
    expect(sha256Hex16(rawContent)).toBe(result.rawChecksum);
    // 5. Compact schema fields.
    expect(result.status).toBe(ToolResultStatus.PASSED);
    expect(result.tool).toBe('test_mcp_tool');
  });

  // ---- (c) Failure (isError) response ----

  it('(c) persists complete raw payload for a failure (isError) MCP response', async () => {
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
    // 2. No forbidden keys, no inline result.
    assertNoForbiddenKeys(result);
    assertNoInlineRawResult(result);
    // 3. rawFile reference exists.
    expect(typeof result.rawFile).toBe('string');
    const rawFilePath = result.rawFile as string;
    expect(fs.existsSync(rawFilePath)).toBe(true);
    // 4. File contains the COMPLETE failure payload.
    const rawContent = fs.readFileSync(rawFilePath, 'utf8');
    const parsed = JSON.parse(rawContent);
    expect(parsed.isError).toBe(true);
    expect(parsed.content[0].text).toContain('symbol not found');
    // Byte count and checksum match.
    expect(Buffer.byteLength(rawContent, 'utf8')).toBe(result.rawBytes);
    expect(sha256Hex16(rawContent)).toBe(result.rawChecksum);
    // 5. Compact schema: tool/status/server/operation.
    expect(result.tool).toBe('test_mcp_tool');
    expect(result.server).toBe(SERVER_NAME);
    expect(result.operation).toBe('query');
    // rawFile path is under the single PROJECT-scoped .pi/tool-output tree (0yt5.27).
    expect(rawFilePath).toContain('.pi/tool-output');
  });

  // ---- (d) Cached/repeated invocation ----

  it('(d) writes a distinct raw file for each repeated invocation (no stale cache cross-contamination)', async () => {
    // First invocation
    const firstPayload = {
      content: [{ type: 'text', text: 'first-invocation-unique-response' }],
      isError: false
    };
    mcpMockState.callToolResult = firstPayload;

    const result1 = await executeConfiguredProjectTool(
      eventStore, toolCallPathFactory, mcpTool,
      { beadId: 'bd-1', stateId: 'Planning', actionId: 'analyze', operation: 'query' },
      {} as any, undefined, new Map()
    ) as Record<string, unknown>;

    // Second invocation with a different payload
    const secondPayload = {
      content: [{ type: 'text', text: 'second-invocation-unique-response' }],
      isError: false
    };
    mcpMockState.callToolResult = secondPayload;

    const result2 = await executeConfiguredProjectTool(
      eventStore, toolCallPathFactory, mcpTool,
      { beadId: 'bd-1', stateId: 'Planning', actionId: 'analyze', operation: 'query' },
      {} as any, undefined, new Map()
    ) as Record<string, unknown>;

    // Both results have rawFile references.
    expect(typeof result1.rawFile).toBe('string');
    expect(typeof result2.rawFile).toBe('string');

    // The two invocations must have DIFFERENT per-invocation directories.
    // (toolInvocationId is a UUID7 so the paths differ.)
    expect(result1.rawFile).not.toBe(result2.rawFile);

    // First file holds the first payload.
    const raw1 = fs.readFileSync(result1.rawFile as string, 'utf8');
    expect(JSON.parse(raw1).content[0].text).toBe('first-invocation-unique-response');
    expect(Buffer.byteLength(raw1, 'utf8')).toBe(result1.rawBytes);
    expect(sha256Hex16(raw1)).toBe(result1.rawChecksum);

    // Second file holds the second payload — no cross-contamination.
    const raw2 = fs.readFileSync(result2.rawFile as string, 'utf8');
    expect(JSON.parse(raw2).content[0].text).toBe('second-invocation-unique-response');
    expect(Buffer.byteLength(raw2, 'utf8')).toBe(result2.rawBytes);
    expect(sha256Hex16(raw2)).toBe(result2.rawChecksum);

    // Both results have no forbidden wrapper keys.
    assertNoForbiddenKeys(result1);
    assertNoForbiddenKeys(result2);
    assertNoInlineRawResult(result1);
    assertNoInlineRawResult(result2);
  });
});
