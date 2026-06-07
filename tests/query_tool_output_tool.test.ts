/**
 * pi-experiment-6q0y.23 — query_tool_output progressive-disclosure tool,
 * tested against the REAL registered tool via fakePi/orrElseExtension.
 *
 * Load-bearing assertions:
 *   (A) Tool is registered with the correct name and parameter schema.
 *   (B) Summary mode: returns metadata (path, size, sha256, isJson, projections)
 *       without any file content (AC2).
 *   (C) JSON selector mode: dot-path extraction from a JSON artifact, capped
 *       at 24 KB (AC3, AC5).
 *   (D) Schema mode: recursive type-shape with values dropped, capped (AC3, AC5).
 *   (E) Text-tail mode: last N chars of any file, capped at 24,000 (AC3, AC5).
 *   (F) Fail-closed: missing artifact, unknown identity, bad inputs (AC1, AC5).
 *   (G) Arbitrary path rejection — arbitrary paths not derived from events are
 *       not accepted (AC1): the tool requires event-derived identity.
 *   (H) No raw-secret inlining: summary mode never surfaces raw file content.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BuiltInToolName, EnvVars, PiEventName } from '../src/constants/index.js';
import { Logger } from '../src/core/Logger.js';
import orrElseExtension from '../src/extension.js';
import { resolveFixtureFilePath } from './support/TestEventStore.js';

// ─── Minimal harness fixture ──────────────────────────────────────────────────

const HARNESS_YAML = `
settings:
  maxConcurrentSlots: 1
  handoverTemplate: ''
  defaultModel: gpt-5.5
  startState: Planning
  worktreePolicy:
    default: always
scheduler:
  weights:
    waitTime: 1
    executionTime: 1
    progress: 1
    penalty: 1
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
states:
  Planning:
    identity:
      role: Planner
      expertise: Planning
      constraints: []
    baseInstructions: Plan.
    actions:
      - id: a1
        type: prompt
    transitions:
      SUCCESS: completed
      FAILURE: Planning
`;

// ─── Fake Pi harness ──────────────────────────────────────────────────────────

function fakePi() {
  const tools: any[] = [];
  const callbacks: Record<string, Function> = {};
  return {
    tools,
    callbacks,
    pi: {
      on: (name: string, cb: Function) => { callbacks[name] = cb; },
      registerTool: (tool: any) => tools.push(tool),
      registerCommand: () => {},
      getActiveTools: () => [],
      setActiveTools: () => {},
      setThinkingLevel: () => {},
      setModel: async () => true,
      sendUserMessage: () => {}
    } as any
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Write a TOOL_INVOCATION_SUCCEEDED fixture event with a nested toolResult
 * (matching the NESTED event shape used by wrapPluginTool).
 */
async function writeToolSucceededEvent(
  tempRoot: string,
  opts: {
    beadId: string;
    stateId: string;
    actionId: string;
    toolName: string;
    outputFile: string;
    outputFileBytes?: number;
  }
): Promise<void> {
  const filePath = resolveFixtureFilePath(tempRoot);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const { v7: uuidv7 } = await import('uuid');
  const entry = {
    id: uuidv7(),
    type: 'TOOL_INVOCATION_SUCCEEDED',
    timestamp: new Date().toISOString(),
    sessionId: 'test-fixture',
    data: {
      beadId: opts.beadId,
      stateId: opts.stateId,
      actionId: opts.actionId,
      tool: opts.toolName,
      toolName: opts.toolName,
      toolInvocationId: uuidv7(),
      toolResult: {
        tool: opts.toolName,
        status: 'PASSED',
        outputFile: opts.outputFile,
        outputFileBytes: opts.outputFileBytes ?? fs.statSync(opts.outputFile).size
      }
    }
  };

  await fs.promises.appendFile(filePath, JSON.stringify(entry) + '\n', 'utf8');
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('pi-experiment-6q0y.23: query_tool_output progressive-disclosure tool', () => {
  let tempRoot: string;
  let prevProjectRoot: string | undefined;
  let prevWorktree: string | undefined;
  let previousCwd: string;

  beforeEach(() => {
    previousCwd = process.cwd();
    prevProjectRoot = process.env[EnvVars.PROJECT_ROOT];
    prevWorktree = process.env[EnvVars.WORKTREE_PATH];

    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-6q0y23-')));
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), HARNESS_YAML);

    process.chdir(tempRoot);
    process.env[EnvVars.PROJECT_ROOT] = tempRoot;
    process.env[EnvVars.WORKTREE_PATH] = tempRoot;
  });

  afterEach(async () => {
    Logger.close();
    await new Promise(resolve => setTimeout(resolve, 200));
    process.chdir(previousCwd);
    if (prevProjectRoot === undefined) delete process.env[EnvVars.PROJECT_ROOT];
    else process.env[EnvVars.PROJECT_ROOT] = prevProjectRoot;
    if (prevWorktree === undefined) delete process.env[EnvVars.WORKTREE_PATH];
    else process.env[EnvVars.WORKTREE_PATH] = prevWorktree;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  async function registeredTool(): Promise<any> {
    const harness = fakePi();
    await orrElseExtension(harness.pi);
    await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
    const tool = harness.tools.find(t => t.name === BuiltInToolName.QUERY_TOOL_OUTPUT);
    expect(tool, 'query_tool_output tool must be registered').toBeDefined();
    return tool;
  }

  const noUiCtx = { hasUI: false } as any;

  async function callTool(tool: any, params: Record<string, unknown>): Promise<any> {
    const wrapped = await tool.execute('call-id', params, undefined, undefined, noUiCtx);
    return wrapped.details ?? wrapped;
  }

  /** Write a JSON output artifact and its TOOL_INVOCATION_SUCCEEDED event. */
  async function writeJsonArtifact(
    opts: {
      beadId: string;
      stateId: string;
      actionId: string;
      toolName: string;
      content: object;
    }
  ): Promise<string> {
    const artifactDir = path.join(tempRoot, '.pi', 'tool-outputs', opts.beadId, opts.toolName);
    fs.mkdirSync(artifactDir, { recursive: true });
    const artifactPath = path.join(artifactDir, 'result.json');
    fs.writeFileSync(artifactPath, JSON.stringify(opts.content, null, 2), 'utf8');
    await writeToolSucceededEvent(tempRoot, {
      beadId: opts.beadId,
      stateId: opts.stateId,
      actionId: opts.actionId,
      toolName: opts.toolName,
      outputFile: artifactPath
    });
    return artifactPath;
  }

  /** Write a plain-text output artifact and its TOOL_INVOCATION_SUCCEEDED event. */
  async function writeTextArtifact(
    opts: {
      beadId: string;
      stateId: string;
      actionId: string;
      toolName: string;
      content: string;
    }
  ): Promise<string> {
    const artifactDir = path.join(tempRoot, '.pi', 'tool-outputs', opts.beadId, opts.toolName);
    fs.mkdirSync(artifactDir, { recursive: true });
    const artifactPath = path.join(artifactDir, 'output.txt');
    fs.writeFileSync(artifactPath, opts.content, 'utf8');
    await writeToolSucceededEvent(tempRoot, {
      beadId: opts.beadId,
      stateId: opts.stateId,
      actionId: opts.actionId,
      toolName: opts.toolName,
      outputFile: artifactPath
    });
    return artifactPath;
  }

  // ── (A) Registration ──────────────────────────────────────────────────────

  it('(A1) tool is registered with name query_tool_output', async () => {
    const tool = await registeredTool();
    expect(tool.name).toBe('query_tool_output');
  });

  it('(A2) tool parameter schema exposes identity fields and mode fields', async () => {
    const tool = await registeredTool();
    const props = tool.parameters?.properties ?? {};
    expect(props.beadId).toBeDefined();
    expect(props.stateId).toBeDefined();
    expect(props.actionId).toBeDefined();
    expect(props.toolName).toBeDefined();
    expect(props.selector).toBeDefined();
    expect(props.schema).toBeDefined();
    expect(props.textTail).toBeDefined();
  });

  // ── (B) Summary mode (AC2) ────────────────────────────────────────────────

  it('(B1) default mode returns summary with metadata but no raw content (AC2)', async () => {
    const secret = 'do-not-surface-this-secret-content';
    await writeJsonArtifact({
      beadId: 'bd-test-1',
      stateId: 'Planning',
      actionId: 'a1',
      toolName: 'my_tool',
      content: { result: 'ok', secretField: secret }
    });

    const tool = await registeredTool();
    const result = await callTool(tool, {
      beadId: 'bd-test-1',
      stateId: 'Planning',
      actionId: 'a1',
      toolName: 'my_tool'
    });

    expect(result.status).toBe('summary');
    expect(result.outputFile).toBeDefined();
    expect(typeof result.byteCount).toBe('number');
    expect(result.byteCount).toBeGreaterThan(0);
    expect(typeof result.sha256).toBe('string');
    expect(result.sha256.length).toBe(64);
    expect(typeof result.isJson).toBe('boolean');
    expect(result.isJson).toBe(true);
    expect(Array.isArray(result.availableProjections)).toBe(true);

    // Load-bearing: raw content not surfaced in summary mode (AC2 + no-inlining)
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('(B2) summary mode for a JSON file exposes json_selector and schema projections', async () => {
    await writeJsonArtifact({
      beadId: 'bd-test-2',
      stateId: 'Planning',
      actionId: 'a1',
      toolName: 'tsc_tool',
      content: { status: 'passed', errors: [] }
    });

    const tool = await registeredTool();
    const result = await callTool(tool, {
      beadId: 'bd-test-2',
      stateId: 'Planning',
      actionId: 'a1',
      toolName: 'tsc_tool'
    });

    expect(result.status).toBe('summary');
    expect(result.availableProjections).toContain('json_selector');
    expect(result.availableProjections).toContain('schema');
    expect(result.availableProjections).toContain('text_tail');
  });

  it('(B3) summary mode for a non-JSON file exposes text_tail only', async () => {
    await writeTextArtifact({
      beadId: 'bd-test-3',
      stateId: 'Planning',
      actionId: 'a1',
      toolName: 'shell_tool',
      content: 'Build succeeded\nWarnings: 0\n'
    });

    const tool = await registeredTool();
    const result = await callTool(tool, {
      beadId: 'bd-test-3',
      stateId: 'Planning',
      actionId: 'a1',
      toolName: 'shell_tool'
    });

    expect(result.status).toBe('summary');
    expect(result.isJson).toBe(false);
    expect(result.availableProjections).toContain('text_tail');
    expect(result.availableProjections).not.toContain('json_selector');
    expect(result.availableProjections).not.toContain('schema');
  });

  // ── (C) JSON selector mode (AC3, AC5) ────────────────────────────────────

  it('(C1) selector mode returns the selected JSON subtree', async () => {
    await writeJsonArtifact({
      beadId: 'bd-json-1',
      stateId: 'Planning',
      actionId: 'a1',
      toolName: 'json_tool',
      content: { status: 'passed', errors: [], meta: { count: 3 } }
    });

    const tool = await registeredTool();
    const result = await callTool(tool, {
      beadId: 'bd-json-1',
      stateId: 'Planning',
      actionId: 'a1',
      toolName: 'json_tool',
      selector: 'status'
    });

    expect(result.status).toBe('json');
    expect(result.result).toBe('passed');
    expect(result.selector).toBe('status');
  });

  it('(C2) selector mode returns nested path', async () => {
    await writeJsonArtifact({
      beadId: 'bd-json-2',
      stateId: 'Planning',
      actionId: 'a1',
      toolName: 'json_tool2',
      content: { meta: { count: 42, nested: { deep: 'value' } } }
    });

    const tool = await registeredTool();
    const result = await callTool(tool, {
      beadId: 'bd-json-2',
      stateId: 'Planning',
      actionId: 'a1',
      toolName: 'json_tool2',
      selector: 'meta.count'
    });

    expect(result.status).toBe('json');
    expect(result.result).toBe(42);
  });

  it('(C3) selector that exceeds 24 KB cap returns rejection with hint (AC5)', async () => {
    // Write a JSON file with a large array that will exceed the cap when selected
    const largeArray = Array.from({ length: 1000 }, (_, i) => ({
      id: i,
      data: 'x'.repeat(40)
    }));
    await writeJsonArtifact({
      beadId: 'bd-json-cap',
      stateId: 'Planning',
      actionId: 'a1',
      toolName: 'large_tool',
      content: { items: largeArray }
    });

    const tool = await registeredTool();
    const result = await callTool(tool, {
      beadId: 'bd-json-cap',
      stateId: 'Planning',
      actionId: 'a1',
      toolName: 'large_tool',
      selector: 'items'
    });

    // Load-bearing: over-cap selection returns a rejection with guidance
    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('24000');
  });

  it('(C4) unknown selector returns rejection', async () => {
    await writeJsonArtifact({
      beadId: 'bd-json-3',
      stateId: 'Planning',
      actionId: 'a1',
      toolName: 'json_tool3',
      content: { status: 'ok' }
    });

    const tool = await registeredTool();
    const result = await callTool(tool, {
      beadId: 'bd-json-3',
      stateId: 'Planning',
      actionId: 'a1',
      toolName: 'json_tool3',
      selector: 'nonexistent.field'
    });

    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('nonexistent.field');
  });

  it('(C5) selector on a non-JSON file returns rejection', async () => {
    await writeTextArtifact({
      beadId: 'bd-sel-txt',
      stateId: 'Planning',
      actionId: 'a1',
      toolName: 'text_tool',
      content: 'This is plain text output\n'
    });

    const tool = await registeredTool();
    const result = await callTool(tool, {
      beadId: 'bd-sel-txt',
      stateId: 'Planning',
      actionId: 'a1',
      toolName: 'text_tool',
      selector: 'status'
    });

    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('JSON');
  });

  // ── (D) Schema mode (AC3) ─────────────────────────────────────────────────

  it('(D1) schema mode returns recursive type-shape with values dropped', async () => {
    await writeJsonArtifact({
      beadId: 'bd-schema-1',
      stateId: 'Planning',
      actionId: 'a1',
      toolName: 'schema_tool',
      content: {
        status: 'passed',
        errors: [{ line: 1, message: 'foo' }],
        meta: { count: 3 }
      }
    });

    const tool = await registeredTool();
    const result = await callTool(tool, {
      beadId: 'bd-schema-1',
      stateId: 'Planning',
      actionId: 'a1',
      toolName: 'schema_tool',
      schema: true
    });

    expect(result.status).toBe('schema');
    expect(result.shape).toBeDefined();
    expect(result.shape.type).toBe('object');
    // Values are NOT present — only types
    expect(JSON.stringify(result.shape)).not.toContain('passed');
    expect(JSON.stringify(result.shape)).not.toContain('foo');
    expect(result.bounds).toBeDefined();
    expect(result.bounds.maxBytes).toBe(24_000);
    expect(typeof result.truncated).toBe('boolean');
  });

  it('(D2) schema mode on a non-JSON file returns rejection', async () => {
    await writeTextArtifact({
      beadId: 'bd-schema-txt',
      stateId: 'Planning',
      actionId: 'a1',
      toolName: 'text_tool2',
      content: 'plain text output\n'
    });

    const tool = await registeredTool();
    const result = await callTool(tool, {
      beadId: 'bd-schema-txt',
      stateId: 'Planning',
      actionId: 'a1',
      toolName: 'text_tool2',
      schema: true
    });

    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('JSON');
  });

  // ── (E) Text-tail mode (AC3, AC5) ────────────────────────────────────────

  it('(E1) textTail mode returns the last N characters of any file', async () => {
    const content = 'A'.repeat(100) + 'TAIL_CONTENT_HERE';
    await writeTextArtifact({
      beadId: 'bd-tail-1',
      stateId: 'Planning',
      actionId: 'a1',
      toolName: 'tail_tool',
      content
    });

    const tool = await registeredTool();
    const result = await callTool(tool, {
      beadId: 'bd-tail-1',
      stateId: 'Planning',
      actionId: 'a1',
      toolName: 'tail_tool',
      textTail: 20
    });

    expect(result.status).toBe('text_tail');
    expect(result.tail).toContain('TAIL_CONTENT_HERE');
    expect(result.returnedChars).toBeLessThanOrEqual(20);
  });

  it('(E2) textTail mode is capped at 24,000 characters (AC5)', async () => {
    // File larger than the cap
    const content = 'X'.repeat(30_000);
    await writeTextArtifact({
      beadId: 'bd-tail-cap',
      stateId: 'Planning',
      actionId: 'a1',
      toolName: 'tail_cap_tool',
      content
    });

    const tool = await registeredTool();
    // Request more than the cap
    const result = await callTool(tool, {
      beadId: 'bd-tail-cap',
      stateId: 'Planning',
      actionId: 'a1',
      toolName: 'tail_cap_tool',
      textTail: 30_000
    });

    expect(result.status).toBe('text_tail');
    // Load-bearing: cap enforced
    expect(result.returnedChars).toBeLessThanOrEqual(24_000);
    expect(result.requestedChars).toBe(24_000); // capped
    expect(result.tail.length).toBeLessThanOrEqual(24_000);
  });

  it('(E3) textTail also works on JSON files', async () => {
    await writeJsonArtifact({
      beadId: 'bd-tail-json',
      stateId: 'Planning',
      actionId: 'a1',
      toolName: 'json_tail_tool',
      content: { status: 'ok', result: 'done' }
    });

    const tool = await registeredTool();
    const result = await callTool(tool, {
      beadId: 'bd-tail-json',
      stateId: 'Planning',
      actionId: 'a1',
      toolName: 'json_tail_tool',
      textTail: 100
    });

    expect(result.status).toBe('text_tail');
    expect(result.returnedChars).toBeGreaterThan(0);
  });

  // ── (F) Fail-closed (AC1, AC5) ────────────────────────────────────────────

  it('(F1) missing required fields returns rejection', async () => {
    const tool = await registeredTool();
    const result = await callTool(tool, {
      beadId: 'bd-missing',
      // stateId intentionally omitted
      actionId: 'a1',
      toolName: 'some_tool'
    });

    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('required');
  });

  it('(F2) unknown identity (no matching event) returns rejection (AC5)', async () => {
    const tool = await registeredTool();
    // No event written — this identity has no recorded result
    const result = await callTool(tool, {
      beadId: 'bd-unknown',
      stateId: 'Planning',
      actionId: 'a1',
      toolName: 'never_ran_tool'
    });

    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('No tool result event found');
  });

  it('(F3) mutually exclusive modes (selector + schema) returns rejection (fail-closed)', async () => {
    const tool = await registeredTool();
    const result = await callTool(tool, {
      beadId: 'bd-excl',
      stateId: 'Planning',
      actionId: 'a1',
      toolName: 'some_tool',
      selector: 'status',
      schema: true
    });

    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('at most one');
  });

  it('(F4) mutually exclusive modes (selector + textTail) returns rejection', async () => {
    const tool = await registeredTool();
    const result = await callTool(tool, {
      beadId: 'bd-excl2',
      stateId: 'Planning',
      actionId: 'a1',
      toolName: 'some_tool',
      selector: 'status',
      textTail: 100
    });

    expect(result.status).toBe('rejected');
  });

  it('(F5) invalid textTail value returns rejection', async () => {
    const tool = await registeredTool();
    const result = await callTool(tool, {
      beadId: 'bd-bad-tail',
      stateId: 'Planning',
      actionId: 'a1',
      toolName: 'some_tool',
      textTail: -5
    });

    expect(result.status).toBe('rejected');
  });

  // ── (G) Arbitrary path rejection (AC1) ───────────────────────────────────

  it('(G1) the tool only accepts event-derived identities — there is no direct path parameter', async () => {
    // The tool schema must NOT expose a filePath or path parameter (AC1:
    // identity is derived from events, not arbitrary filesystem paths).
    const tool = await registeredTool();
    const props = tool.parameters?.properties ?? {};
    expect(props.filePath).toBeUndefined();
    expect(props.path).toBeUndefined();
    expect(props.artifactPath).toBeUndefined();
    expect(props.outputFile).toBeUndefined();
  });

  // ── (H) No raw-secret inlining (AC2) ─────────────────────────────────────

  it('(H1) summary mode never inlines raw file content regardless of content', async () => {
    const sensitiveData = 'API_KEY=sk-very-secret-value-that-must-not-appear';
    await writeTextArtifact({
      beadId: 'bd-secret',
      stateId: 'Planning',
      actionId: 'a1',
      toolName: 'secret_tool',
      content: sensitiveData
    });

    const tool = await registeredTool();
    const result = await callTool(tool, {
      beadId: 'bd-secret',
      stateId: 'Planning',
      actionId: 'a1',
      toolName: 'secret_tool'
    });

    expect(result.status).toBe('summary');
    // Load-bearing: sensitive content NOT inlined in summary mode
    expect(JSON.stringify(result)).not.toContain('sk-very-secret-value-that-must-not-appear');
  });
});
