/**
 * ToolExecutionWrapper unit tests (pi-experiment-amq0.1)
 *
 * Tests the wrapPluginTool behavior via fake ports.  Covers the 7 paths
 * required by the AC:
 *   1. Tool success — TOOL_INVOCATION_SUCCEEDED event recorded
 *   2. Tool rejection (validation rule) — TOOL_INVOCATION_FAILED with reason 'validation-reject'
 *   3. Timeout — tool exceeds wrapper timeout → error result
 *   4. Cache hit — second call to cacheable tool returns cached result
 *   5. Circuit breaker — consecutive failures open the breaker
 *   6. Worker mode (merge guard) — merge_and_commit rejected in worker mode
 *   7. Raw-result persistence — TOOL_INVOCATION_SUCCEEDED carries outputFile
 *
 * Uses a real temp directory so raw-persistence writes succeed without mocking
 * the filesystem (the native ESM 'node:fs'/'fs' distinction makes vi.mock
 * unreliable for low-level node built-ins in this project's ESM setup).
 */

import { describe, it, expect, vi, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { wrapPluginTool } from '../src/extension/ToolExecutionWrapper.js';
import type { ToolExecutionWrapperPorts } from '../src/extension/ToolExecutionWrapper.js';
import type { ToolExecutionSession } from '../src/extension/SessionTypes.js';
import type { TeammateEventType } from '../src/core/TeammateEvents.js';
import type { TeammateEvent } from '../src/core/TeammateEvents.js';
import { DomainEventName, PluginToolName } from '../src/constants/index.js';

// ─── Temp directory (one per test run) ───────────────────────────────────────

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-tew-'));

afterAll(() => {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
});

// ─── Fake ports ──────────────────────────────────────────────────────────────

function makeFakeEventStore() {
  const recorded: Array<{ type: string; data: Record<string, unknown> }> = [];
  return {
    recorded,
    record: vi.fn(async (type: string, data: Record<string, unknown>) => {
      recorded.push({ type, data });
    }),
  };
}

/** Returns a ToolCallPathFactory that allocates real paths under TMP_DIR. */
function makeRealishToolCallPathFactory() {
  let counter = 0;
  return {
    allocate: vi.fn(({ toolName }: { toolName: string }) => {
      const outputDir = path.join(TMP_DIR, `${toolName}-${++counter}`);
      return { outputDir, outputFile: path.join(outputDir, 'plugin-raw.json') };
    }),
  };
}

function makeFakeConfigLoader(toolConfigs: Array<Record<string, unknown>> = []) {
  return {
    load: vi.fn(async () => ({
      tools: toolConfigs,
      states: {},
      settings: { defaultProvider: 'anthropic' },
    })),
    getConfigPath: vi.fn(() => '/fake/harness.yaml'),
    setConfigPath: vi.fn(),
    resolveLLMConfig: vi.fn(() => ({
      providerKey: 'anthropic', provider: 'anthropic', model: 'claude-3', thinking: false
    })),
  };
}

function makeFakePorts(overrides: Partial<ToolExecutionWrapperPorts> = {}): ToolExecutionWrapperPorts {
  const eventStore = (overrides.eventStore as ReturnType<typeof makeFakeEventStore> | undefined) ?? makeFakeEventStore();
  const toolCallPathFactory = overrides.toolCallPathFactory ?? makeRealishToolCallPathFactory();
  const configLoader = overrides.configLoader ?? makeFakeConfigLoader();
  const isWorkerMode = overrides.isWorkerMode ?? (() => false);
  const projectRoot = overrides.projectRoot ?? TMP_DIR;
  const services = {
    eventStore,
    toolCallPathFactory,
    configLoader,
  } as unknown as ToolExecutionWrapperPorts['services'];

  return {
    eventStore,
    toolCallPathFactory,
    configLoader,
    services,
    isWorkerMode,
    projectRoot,
    terminalFailureAllowedTools: overrides.terminalFailureAllowedTools ?? new Set<string>(),
    buildWorkerEvent: overrides.buildWorkerEvent ?? ((type: TeammateEventType, fields: Record<string, unknown>) => ({
      type,
      ...fields,
      workerId: 'test-worker',
      sessionStateId: 'test-session',
      idempotencyKey: 'test-key',
      timestamp: 1000,
    } as unknown as TeammateEvent)),
  };
}

function makeFakeSession(overrides: Partial<ToolExecutionSession> = {}): ToolExecutionSession {
  return {
    activeRun: null,
    toolBreakerFailures: new Map(),
    toolResultCache: new Map(),
    runtimeBudgetTracker: null,
    loopDetector: null,
    ...overrides,
  };
}

function makeFakeObservability() {
  return {
    recordToolInvocation: vi.fn(),
    getToolResult: vi.fn(() => undefined),
    hasToolPassed: vi.fn(() => false),
    tracedAsync: vi.fn((_name: string, _attrs: unknown, fn: (...args: unknown[]) => Promise<unknown>, _completion: unknown) => {
      // Passthrough — run fn with its args synchronously (async)
      return (...args: unknown[]) => fn(...args);
    }),
  };
}

function makeFakeTool(
  name: string,
  execute: (params: unknown, ctx?: unknown, signal?: AbortSignal) => unknown =
    () => ({ status: 'PASSED', result: 'ok' })
) {
  return { name, description: `Test tool ${name}`, parameters: {}, execute };
}

function makeFakeCtx() {
  return {
    hasUI: false,
    ui: { notify: vi.fn(), setWorkingMessage: vi.fn() },
  } as unknown as import('@earendil-works/pi-coding-agent').ExtensionContext;
}

const beadIdFromParams = (_params: Record<string, unknown> | undefined) => undefined;
const toolSpanAttrs = (toolName: string) => ({ 'tool.name': toolName });

// ─── Test helper ──────────────────────────────────────────────────────────────

async function invokeWrappedTool(
  tool: ReturnType<typeof makeFakeTool>,
  ports: ToolExecutionWrapperPorts,
  session: ToolExecutionSession,
  params: unknown = {}
) {
  const obs = makeFakeObservability();
  const wrapped = wrapPluginTool(
    tool, obs as any, ports, session, beadIdFromParams, toolSpanAttrs as any
  );
  const ctx = makeFakeCtx();
  const result = await wrapped.execute('call-id', params as any, undefined, undefined, ctx);
  const recorded = (ports.eventStore as ReturnType<typeof makeFakeEventStore>).recorded;
  return { result, obs, recorded };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ToolExecutionWrapper', () => {

  // ── 1. Tool success ───────────────────────────────────────────────────────

  it('records TOOL_INVOCATION_SUCCEEDED on successful tool execution', async () => {
    const tool = makeFakeTool('my_tool', () => ({ status: 'PASSED', result: 'all good' }));
    const ports = makeFakePorts();
    const session = makeFakeSession();

    const { recorded } = await invokeWrappedTool(tool, ports, session);

    const started = recorded.find(r => r.type === DomainEventName.TOOL_INVOCATION_STARTED);
    const succeeded = recorded.find(r => r.type === DomainEventName.TOOL_INVOCATION_SUCCEEDED);

    expect(started).toBeDefined();
    expect(succeeded).toBeDefined();
    expect(succeeded!.data.tool).toBe('my_tool');
    expect(succeeded!.data.toolName).toBe('my_tool');
  });

  // ── 2. Tool rejection (validation rule) ───────────────────────────────────

  it('records TOOL_INVOCATION_FAILED with reason validation-reject when a validation rule fails', async () => {
    const tool = makeFakeTool('guarded_tool');
    const toolConfig = {
      name: 'guarded_tool',
      validationRules: [
        // condition: 'called' (ToolValidationCondition.CALLED = 'called')
        { tool: 'prerequisite_tool', condition: 'called', message: 'You must call prerequisite_tool first.' }
      ]
    };
    const ports = makeFakePorts({ configLoader: makeFakeConfigLoader([toolConfig as any]) as any });
    const session = makeFakeSession();

    const { result, recorded } = await invokeWrappedTool(tool, ports, session);

    const failed = recorded.find(r => r.type === DomainEventName.TOOL_INVOCATION_FAILED);
    expect(failed).toBeDefined();
    expect(failed!.data.result).toMatchObject({ reason: 'validation-reject' });

    // The model-facing result contains the validation error message.
    expect((result as any).content[0].text).toContain('prerequisite_tool');
  });

  // ── 3. Timeout ────────────────────────────────────────────────────────────

  it('returns an error result when the tool exceeds the wrapper timeout', async () => {
    // Use a tool that never resolves (hangs until the wrapper timeout fires).
    // We use a Promise that only resolves when an external abort signal fires
    // so we don't leave a 10-second timer hanging in the event loop (which
    // would keep the test alive past its timeout).
    let resolveHang!: () => void;
    const hangPromise = new Promise<void>(res => { resolveHang = res; });
    const tool = makeFakeTool('slow_tool', async () => {
      await hangPromise; // hangs until resolved externally
      return { status: 'PASSED' };
    });
    const toolConfig = { name: 'slow_tool', wrapperTimeoutMs: 20 }; // 20 ms timeout
    const ports = makeFakePorts({ configLoader: makeFakeConfigLoader([toolConfig as any]) as any });
    const session = makeFakeSession();

    // Resolve the hang AFTER the wrapper timeout has fired (a tiny bit later)
    const hangResolveTimer = setTimeout(resolveHang, 200);

    try {
      const { result, recorded } = await invokeWrappedTool(tool, ports, session);

      // Timeout fires (at 20ms) → catch block → TOOL_INVOCATION_FAILED recorded
      const failed = recorded.find(r => r.type === DomainEventName.TOOL_INVOCATION_FAILED);
      expect(failed).toBeDefined();

      // Model-facing result is an Error: ... string
      expect((result as any).content[0].text).toContain('Error:');
      expect((result as any).content[0].text).toContain('exceeded harness wrapper timeout');
    } finally {
      clearTimeout(hangResolveTimer);
      resolveHang(); // ensure the promise resolves so no timers leak
    }
  }, 5_000);

  // ── 4. Cache hit ──────────────────────────────────────────────────────────

  it('returns cached result on second call to a cacheable tool in worker mode', async () => {
    let callCount = 0;
    const tool = makeFakeTool('cacheable_tool', () => {
      callCount++;
      return { success: true, callCount }; // success:true → resultIndicatesSuccess
    });
    const toolConfig = { name: 'cacheable_tool', cacheable: true };
    const ports = makeFakePorts({
      configLoader: makeFakeConfigLoader([toolConfig as any]) as any,
      isWorkerMode: () => true, // worker mode enables cache
    });
    const session = makeFakeSession();
    const params = { input: 'same-input' };

    // First call — populates cache
    await invokeWrappedTool(tool, ports, session, params);
    expect(callCount).toBe(1);

    // Second call with same params — should hit cache
    const obs2 = makeFakeObservability();
    const wrapped2 = wrapPluginTool(tool, obs2 as any, ports, session, beadIdFromParams, toolSpanAttrs as any);
    await wrapped2.execute('call-id-2', params as any, undefined, undefined, makeFakeCtx());

    // Tool should NOT have been called again
    expect(callCount).toBe(1);

    // Second call should record TOOL_INVOCATION_SUCCEEDED with cached:true
    const allRecorded = (ports.eventStore as ReturnType<typeof makeFakeEventStore>).recorded;
    const cachedEvent = allRecorded.find(
      r => r.type === DomainEventName.TOOL_INVOCATION_SUCCEEDED && r.data.cached === true
    );
    expect(cachedEvent).toBeDefined();
  });

  // ── 5. Circuit breaker ────────────────────────────────────────────────────

  it('opens circuit breaker after maxConsecutiveFailures and rejects subsequent calls', async () => {
    // Tool always returns a failure result (isError:true → resultIndicatesFailure)
    const tool = makeFakeTool('breaking_tool', () => ({ isError: true, message: 'always fails' }));
    const toolConfig = { name: 'breaking_tool', maxConsecutiveFailures: 2 };
    const ports = makeFakePorts({
      configLoader: makeFakeConfigLoader([toolConfig as any]) as any,
      isWorkerMode: () => true, // breaker only enabled in worker mode
    });
    const session = makeFakeSession();

    // Two failures to saturate the breaker (maxFailures=2 → fails[key] reaches 2)
    await invokeWrappedTool(tool, ports, session);
    await invokeWrappedTool(tool, ports, session);
    // Third call — breaker open (failures >= maxFailures)
    const { result } = await invokeWrappedTool(tool, ports, session);

    expect((result as any).content[0].text).toContain('circuit open');
    expect((result as any).content[0].text).toContain('REJECTED');
  });

  // ── 6. Worker mode — merge guard ──────────────────────────────────────────

  it('rejects merge_and_commit in worker mode with PROTOCOL VIOLATION', async () => {
    const tool = makeFakeTool(PluginToolName.MERGE_AND_COMMIT, () => ({ status: 'PASSED' }));
    const ports = makeFakePorts({ isWorkerMode: () => true });
    const session = makeFakeSession();

    const { result, recorded } = await invokeWrappedTool(tool, ports, session);

    const failed = recorded.find(r => r.type === DomainEventName.TOOL_INVOCATION_FAILED);
    expect(failed).toBeDefined();
    expect(failed!.data.result).toMatchObject({ reason: 'worker-merge-guard' });
    expect((result as any).content[0].text).toContain('PROTOCOL VIOLATION');
    expect((result as any).content[0].text).toContain(PluginToolName.MERGE_AND_COMMIT);
  });

  // ── 7. Raw-result persistence ─────────────────────────────────────────────

  it('records outputFile on TOOL_INVOCATION_SUCCEEDED event (raw persistence)', async () => {
    const tool = makeFakeTool('persist_tool', () => ({ success: true, data: 'some result' }));
    const ports = makeFakePorts();
    const session = makeFakeSession();

    const { recorded } = await invokeWrappedTool(tool, ports, session);

    const succeeded = recorded.find(r => r.type === DomainEventName.TOOL_INVOCATION_SUCCEEDED);
    expect(succeeded).toBeDefined();

    // The toolResult field should carry outputFile (path to the raw persisted file)
    const toolResult = succeeded!.data.toolResult as { outputFile?: string; status?: string };
    expect(toolResult).toBeDefined();
    expect(typeof toolResult.outputFile).toBe('string');
    expect(toolResult.outputFile!.length).toBeGreaterThan(0);
    expect(toolResult.outputFile).toContain('plugin-raw.json');
  });

});
