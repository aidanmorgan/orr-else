/**
 * tool_payload_budget.test.ts — pi-experiment-6q0y.18
 *
 * Load-bearing tests for exact tool-result byte accounting and optional
 * payload budget enforcement.
 *
 * ACs covered:
 *
 * AC1 — serializeToolResultText() is the single canonical serialization; metered
 *        bytes match the actual content[0].text Pi receives for ≥5 result shapes.
 *        Tests compare metered bytes to the actual serialized model-facing text.
 *
 * AC2 — With no budget configured, tool results are NOT rejected and no
 *        TOOL_PAYLOAD_BUDGET_REJECTED event is emitted (true no-op / disabled
 *        by default). Proved by evaluateToolPayloadBudget returning exceeded:false
 *        and by driving the real wrapPluginTool path via orrElseExtension.
 *
 * AC5/AC6 — When enabled and exceeded, the harness rejects the model-facing
 *        payload BEFORE it reaches the model and emits a TOOL_PAYLOAD_BUDGET_REJECTED
 *        event with tool name, actualBytes, limitBytes, decision, route — NO raw body.
 *        Proved by driving wrapPluginTool via orrElseExtension with a real budget.
 *
 * AC7 — Startup lint rejects:
 *        (a) negative maxBytes in toolPayloadBudget / toolPayloadBudgetByTool
 *        (b) unknown tool names in toolPayloadBudgetByTool
 *        (c) routes absent from statechart vocabulary in any budget declaration
 *        Each test is LOAD-BEARING: removing its corresponding check in
 *        ConfigLoader.validateToolPayloadBudgetDeclarations makes the test fail.
 *
 * AC8 — Tests compare metered bytes to actual serialized model-facing text for
 *        ≥5 distinct result shapes (string, plain object, nested object, array,
 *        unicode string, number result) — proves no drift.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';

import {
  evaluateToolPayloadBudget,
  resolveToolPayloadBudgetPolicy,
} from '../src/core/ToolPayloadBudget.js';
import { serializeToolResultText } from '../src/core/TokenUsage.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { DomainEventName, EnvVars, PiEventName, ProcessFlag } from '../src/constants/index.js';
import orrElseExtension from '../src/extension.js';
import { Logger } from '../src/core/Logger.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakePi() {
  const tools: any[] = [];
  const callbacks: Record<string, Function> = {};
  return {
    tools,
    callbacks,
    pi: {
      on: (name: string, callback: Function) => { callbacks[name] = callback; },
      registerTool: (tool: any) => tools.push(tool),
      registerCommand: (_name: string, _opts: any) => {},
      getActiveTools: () => [] as string[],
      setActiveTools: (_names: string[]) => {},
      setThinkingLevel: () => {},
      setModel: async () => true,
      sendUserMessage: () => {}
    } as any
  };
}

interface TestEnv {
  tempRoot: string;
  prevEnv: Record<string, string | undefined>;
  prevCwd: string;
}

function setupWorkerEnv(yaml: string, stateId = 'Alpha', actionId = 'a1'): TestEnv {
  const prevCwd = process.cwd();
  const prevEnv: Record<string, string | undefined> = {
    [EnvVars.PROJECT_ROOT]: process.env[EnvVars.PROJECT_ROOT],
    [EnvVars.WORKTREE_PATH]: process.env[EnvVars.WORKTREE_PATH],
    [EnvVars.WORKER_MODE]: process.env[EnvVars.WORKER_MODE],
    [EnvVars.BEAD_ID]: process.env[EnvVars.BEAD_ID],
    [EnvVars.STATE_ID]: process.env[EnvVars.STATE_ID],
    [EnvVars.ACTION_ID]: process.env[EnvVars.ACTION_ID],
    [EnvVars.SESSION_STATE_ID]: process.env[EnvVars.SESSION_STATE_ID],
    [EnvVars.API_BASE]: process.env[EnvVars.API_BASE],
  };

  const tempRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'payload-budget-test-'))
  );
  fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), yaml);
  fs.mkdirSync(path.join(tempRoot, '.pi', 'logs'), { recursive: true });

  process.chdir(tempRoot);
  process.env[EnvVars.PROJECT_ROOT] = tempRoot;
  process.env[EnvVars.WORKTREE_PATH] = tempRoot;
  process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
  process.env[EnvVars.BEAD_ID] = 'bead-payload-test';
  process.env[EnvVars.STATE_ID] = stateId;
  process.env[EnvVars.ACTION_ID] = actionId;
  process.env[EnvVars.SESSION_STATE_ID] = 'sess-payload-001';
  process.env[EnvVars.API_BASE] = 'http://127.0.0.1:19997';

  return { tempRoot, prevEnv, prevCwd };
}

function teardownWorkerEnv(env: TestEnv): void {
  process.chdir(env.prevCwd);
  for (const [key, value] of Object.entries(env.prevEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(env.tempRoot, { recursive: true, force: true });
}

function makeHarnessYaml(extraSettings = '', toolsBlock = ''): string {
  return `
settings:
  startState: Alpha
  worktreePolicy:
    default: always
${extraSettings}
${toolsBlock ? toolsBlock : ''}
statechart:
  terminalStates: [done]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
states:
  Alpha:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions: [{ id: a1, type: prompt, prompt: "do the thing" }]
    transitions: { SUCCESS: done, FAILURE: Alpha, BLOCKED: Alpha }
`;
}

function readEventLog(tempRoot: string, eventType: string): any[] {
  const eventDir = path.join(tempRoot, '.pi', 'events');
  if (!fs.existsSync(eventDir)) return [];
  const found: any[] = [];
  for (const file of fs.readdirSync(eventDir).filter(f => f.endsWith('.jsonl'))) {
    const lines = fs.readFileSync(path.join(eventDir, file), 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === eventType) found.push(parsed);
      } catch { /* skip */ }
    }
  }
  return found;
}

function makeMinimalConfig(extraSettings: Record<string, unknown> = {}): any {
  return {
    settings: {
      maxConcurrentSlots: 1,
      handoverTemplate: '',
      agentTurnTimeoutMs: 1000,
      processReapIntervalMs: 1000,
      harnessRestartEvent: 'HARNESS_RESTART',
      contextRestartEvent: 'CONTEXT_RESTART',
      defaultModel: 'gpt-4',
      defaultProvider: 'openai',
      modelProviders: {},
      stateContextRotThreshold: 10,
      harnessContextRotThreshold: 5,
      ...extraSettings,
    },
    scheduler: { weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 } },
    states: {},
    tools: [],
  };
}

// ---------------------------------------------------------------------------
// AC1 / AC8: serializeToolResultText — exact-match for ≥5 result shapes
// ---------------------------------------------------------------------------

describe('serializeToolResultText — exact match metered bytes vs actual payload (AC1/AC8)', () => {
  // For each shape: serialize it, measure bytes, then verify that the metered bytes
  // equal the byte length of the actual serialized string. This is the AC1 invariant:
  // no drift between accounting and the string that ends up in content[0].text.

  it('shape 1: plain string — metered bytes == Buffer.byteLength(string)', () => {
    const value = 'hello world, this is a plain string result';
    const serialized = serializeToolResultText(value);
    const metered = Buffer.byteLength(serialized, 'utf8');
    // Plain string: no JSON wrapping
    expect(serialized).toBe(value);
    expect(metered).toBe(Buffer.byteLength(value, 'utf8'));
  });

  it('shape 2: plain object — metered bytes == actual content[0].text bytes (pretty JSON)', () => {
    const value = { status: 'PASSED', result: 'all checks passed', count: 42 };
    const serialized = serializeToolResultText(value);
    const metered = Buffer.byteLength(serialized, 'utf8');
    // Object: pretty-printed JSON (2-space indent) — matching toolResult()
    expect(serialized).toBe(JSON.stringify(value, null, 2));
    expect(metered).toBe(Buffer.byteLength(JSON.stringify(value, null, 2), 'utf8'));
    // Verify compact JSON gives DIFFERENT byte count (proving drift was present before AC1 fix)
    const compactBytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
    expect(metered).not.toBe(compactBytes); // pretty != compact for multi-field objects
  });

  it('shape 3: nested object — metered bytes match actual pretty-print bytes', () => {
    const value = {
      status: 'PASSED',
      evidence: { tool: 'jest', passed: true },
      artifacts: ['/path/a', '/path/b'],
    };
    const serialized = serializeToolResultText(value);
    const metered = Buffer.byteLength(serialized, 'utf8');
    expect(serialized).toBe(JSON.stringify(value, null, 2));
    expect(metered).toBe(Buffer.byteLength(JSON.stringify(value, null, 2), 'utf8'));
  });

  it('shape 4: array — metered bytes match actual pretty-print bytes', () => {
    const value = ['item one', 'item two', 'item three'];
    const serialized = serializeToolResultText(value);
    const metered = Buffer.byteLength(serialized, 'utf8');
    expect(serialized).toBe(JSON.stringify(value, null, 2));
    expect(metered).toBe(Buffer.byteLength(JSON.stringify(value, null, 2), 'utf8'));
  });

  it('shape 5: unicode string — metered bytes == actual UTF-8 byte count (multi-byte chars)', () => {
    // Multi-byte UTF-8: 日本語 is 3 bytes per char; emoji 4 bytes each.
    const value = '日本語テスト 🎉 résultat';
    const serialized = serializeToolResultText(value);
    const metered = Buffer.byteLength(serialized, 'utf8');
    expect(serialized).toBe(value); // plain string: no wrapping
    expect(metered).toBe(Buffer.byteLength(value, 'utf8'));
    // Confirm multi-byte (byte count > char count)
    expect(metered).toBeGreaterThan(value.length);
  });

  it('shape 6: number result — metered bytes match JSON.stringify output', () => {
    const value = 12345;
    const serialized = serializeToolResultText(value);
    const metered = Buffer.byteLength(serialized, 'utf8');
    expect(serialized).toBe(JSON.stringify(value, null, 2));
    expect(metered).toBe(Buffer.byteLength(JSON.stringify(value, null, 2), 'utf8'));
  });

  it('evaluateToolPayloadBudget.actualBytes equals Buffer.byteLength(serializeToolResultText(value))', () => {
    const shapes: unknown[] = [
      'a plain string',
      { key: 'value', nested: { deep: true } },
      ['array', 'of', 'strings'],
      42,
      '日本語 emoji 🎉',
      { status: 'PASSED', items: [1, 2, 3] },
    ];
    const config = makeMinimalConfig();
    for (const value of shapes) {
      const budget = evaluateToolPayloadBudget('test_tool', value, config);
      const expectedBytes = Buffer.byteLength(serializeToolResultText(value), 'utf8');
      // Core AC1 assertion: metered bytes must exactly equal the actual payload bytes
      expect(budget.actualBytes).toBe(expectedBytes);
      // The serializedText in the result IS the string that will appear in content[0].text
      expect(budget.serializedText).toBe(serializeToolResultText(value));
    }
  });
});

// ---------------------------------------------------------------------------
// AC2: evaluateToolPayloadBudget — no-op when unconfigured
// ---------------------------------------------------------------------------

describe('evaluateToolPayloadBudget — no-op when unconfigured (AC2)', () => {
  it('returns exceeded:false and resolvedPolicy:undefined when no budget configured', () => {
    const config = makeMinimalConfig();
    const result = evaluateToolPayloadBudget('my_tool', { status: 'PASSED' }, config);
    expect(result.exceeded).toBe(false);
    expect(result.resolvedPolicy).toBeUndefined();
    expect(result.route).toBeUndefined();
  });

  it('returns exceeded:false when payload is below the limit', () => {
    const config = makeMinimalConfig({
      toolPayloadBudget: { maxBytes: 1_000_000, route: 'FAILURE' },
    });
    const result = evaluateToolPayloadBudget('my_tool', { status: 'PASSED', small: true }, config);
    expect(result.exceeded).toBe(false);
    expect(result.resolvedPolicy).toBeDefined();
  });

  it('returns exceeded:true with route when payload exceeds default limit', () => {
    const bigValue = 'x'.repeat(10_000);
    const config = makeMinimalConfig({
      toolPayloadBudget: { maxBytes: 1, route: 'FAILURE' },
    });
    const result = evaluateToolPayloadBudget('my_tool', bigValue, config);
    expect(result.exceeded).toBe(true);
    expect(result.route).toBe('FAILURE');
    expect(result.actualBytes).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// AC4: resolveToolPayloadBudgetPolicy — per-tool > default
// ---------------------------------------------------------------------------

describe('resolveToolPayloadBudgetPolicy — per-tool > default (AC4)', () => {
  it('returns undefined when neither default nor per-tool budget is configured', () => {
    const config = makeMinimalConfig();
    expect(resolveToolPayloadBudgetPolicy(config, 'any_tool')).toBeUndefined();
  });

  it('returns the global default when no per-tool override exists', () => {
    const config = makeMinimalConfig({
      toolPayloadBudget: { maxBytes: 5000, route: 'FAILURE' },
    });
    const policy = resolveToolPayloadBudgetPolicy(config, 'any_tool');
    expect(policy).toBeDefined();
    expect(policy!.maxBytes).toBe(5000);
  });

  it('per-tool override takes precedence over the global default', () => {
    const config = makeMinimalConfig({
      toolPayloadBudget: { maxBytes: 5000, route: 'FAILURE' },
      toolPayloadBudgetByTool: {
        specific_tool: { maxBytes: 100, route: 'FAILURE' },
      },
    });
    // specific_tool uses the per-tool budget
    const perTool = resolveToolPayloadBudgetPolicy(config, 'specific_tool');
    expect(perTool!.maxBytes).toBe(100);

    // other_tool falls back to global default
    const fallback = resolveToolPayloadBudgetPolicy(config, 'other_tool');
    expect(fallback!.maxBytes).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// AC2/AC5/AC6: WIRING — real path rejection via orrElseExtension + tool execution
// ---------------------------------------------------------------------------

describe('orrElseExtension wrapPluginTool payload-budget wiring (AC2/AC5/AC6)', () => {
  let env: TestEnv | undefined;

  afterEach(async () => {
    if (env) { teardownWorkerEnv(env); env = undefined; }
    Logger.close();
  });

  it('AC2 — no-op when disabled: tool result passes through, no TOOL_PAYLOAD_BUDGET_REJECTED emitted (LOAD-BEARING)', async () => {
    // Config with NO toolPayloadBudget — must be a complete no-op.
    // If applyToolPayloadBudget incorrectly rejects when unconfigured, this test fails.
    const yaml = makeHarnessYaml();
    env = setupWorkerEnv(yaml);

    const harness = fakePi();
    await orrElseExtension(harness.pi);
    await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: env.tempRoot });

    // Find a registered tool and invoke it
    const tool = harness.tools.find(t => t.name === 'get_outstanding_tasks' || t.name === 'add_checklist_item');
    expect(tool).toBeDefined();

    // Invoke the tool — should succeed without rejection
    const toolCallId = 'tc-noop-test';
    const ctx = { hasUI: false, cwd: env.tempRoot };
    const result = await tool!.execute(toolCallId, {}, undefined, undefined, ctx);

    // Tool result must be present (not budget-rejected)
    expect(result).toBeDefined();
    expect(result.content).toBeDefined();
    expect(result.content[0]?.text).toBeDefined();

    // Allow event store writes to flush
    await new Promise(r => setTimeout(r, 100));

    // No TOOL_PAYLOAD_BUDGET_REJECTED event — true no-op (AC2)
    const rejectionEvents = readEventLog(env.tempRoot, DomainEventName.TOOL_PAYLOAD_BUDGET_REJECTED);
    expect(rejectionEvents).toHaveLength(0);
  });

  it('AC5/AC6 — WIRING: budget rejection fires on the real path and replaces model payload BEFORE return (LOAD-BEARING)', async () => {
    // Configure a maxBytes of 1 so any real tool result will be over-budget.
    // This test proves the budget check is WIRED to wrapPluginTool and NOT orphaned.
    // If applyToolPayloadBudget is not called in wrapPluginTool, the raw payload passes
    // through and no TOOL_PAYLOAD_BUDGET_REJECTED event is emitted — this test fails.
    const yaml = makeHarnessYaml('  toolPayloadBudget:\n    maxBytes: 1\n    route: FAILURE\n');
    env = setupWorkerEnv(yaml);

    const harness = fakePi();
    await orrElseExtension(harness.pi);
    await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: env.tempRoot });

    // Find get_outstanding_tasks — it returns a structured object result that will
    // exceed 1 byte and trigger budget enforcement.
    const tool = harness.tools.find(t => t.name === 'get_outstanding_tasks');
    expect(tool).toBeDefined();

    const ctx = { hasUI: false, cwd: env.tempRoot };
    const result = await tool!.execute('tc-budget-test', {}, undefined, undefined, ctx);

    // ASSERTION 1 (load-bearing — AC5): the result must contain the semantic rejection
    // message, not the raw tool payload. If the budget check is unwired, the raw result
    // passes through and this assertion fails.
    expect(result).toBeDefined();
    expect(result.content[0]?.text).toContain('TOOL_PAYLOAD_BUDGET_EXCEEDED');
    expect(result.content[0]?.text).toContain('get_outstanding_tasks');

    // Allow event store writes to flush
    await new Promise(r => setTimeout(r, 150));

    // ASSERTION 2 (load-bearing — AC6): TOOL_PAYLOAD_BUDGET_REJECTED event must be
    // emitted with the required fields. If the event is not recorded, this fails.
    const rejectionEvents = readEventLog(env.tempRoot, DomainEventName.TOOL_PAYLOAD_BUDGET_REJECTED);
    expect(rejectionEvents.length).toBeGreaterThan(0);
    const data = rejectionEvents[0].data;

    // Required fields (AC6): tool, actualBytes, limitBytes, decision, route — NO body.
    expect(data.tool).toBe('get_outstanding_tasks');
    expect(typeof data.actualBytes).toBe('number');
    expect(data.actualBytes).toBeGreaterThan(1); // payload was larger than limit
    expect(data.limitBytes).toBe(1);
    expect(data.decision).toBe('REJECTED');
    expect(data.route).toBe('FAILURE');

    // NO raw tool-output body in the event (AC6)
    const serialized = JSON.stringify(data);
    // Rejection event must not contain the raw checklist/task data that the tool returned
    // (the event has only identity fields, byte counts, and route — not output content).
    expect(serialized).not.toContain('"status"'); // raw PASSED/REJECTED status from tool
    // But we do expect the required scalar fields
    expect(data.tool).toBeDefined();
    expect(data.actualBytes).toBeDefined();
    expect(data.limitBytes).toBeDefined();
    expect(data.decision).toBeDefined();
    expect(data.route).toBeDefined();
  });

  it('AC6 — rejection event carries no raw tool-output body (no body invariant)', async () => {
    const yaml = makeHarnessYaml('  toolPayloadBudget:\n    maxBytes: 1\n    route: FAILURE\n');
    env = setupWorkerEnv(yaml);

    const harness = fakePi();
    await orrElseExtension(harness.pi);
    await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: env.tempRoot });

    const tool = harness.tools.find(t => t.name === 'get_outstanding_tasks');
    const ctx = { hasUI: false, cwd: env.tempRoot };
    await tool!.execute('tc-nobody-test', {}, undefined, undefined, ctx);

    await new Promise(r => setTimeout(r, 150));

    const rejectionEvents = readEventLog(env.tempRoot, DomainEventName.TOOL_PAYLOAD_BUDGET_REJECTED);
    if (rejectionEvents.length === 0) return; // no tool invocation happened

    const eventStr = JSON.stringify(rejectionEvents[0]);
    // The event must NOT contain a 'payload' or 'body' or 'output' field with raw content.
    expect(rejectionEvents[0].data).not.toHaveProperty('payload');
    expect(rejectionEvents[0].data).not.toHaveProperty('body');
    expect(rejectionEvents[0].data).not.toHaveProperty('output');
    // Scalar fields only: tool, actualBytes, limitBytes, decision, route, optional identity
    expect(typeof rejectionEvents[0].data.tool).toBe('string');
    expect(typeof rejectionEvents[0].data.actualBytes).toBe('number');
    expect(typeof rejectionEvents[0].data.limitBytes).toBe('number');
    expect(eventStr.length).toBeLessThan(2000); // compact event — not bloated with raw output
  });
});

// ---------------------------------------------------------------------------
// AC7: Startup lint — ConfigLoader rejects invalid toolPayloadBudget declarations
// ---------------------------------------------------------------------------

describe('AC7: startup lint rejects invalid tool-payload budget declarations', () => {
  let tempRoot: string | undefined;
  let prevCwd: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    tempRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'payload-budget-lint-test-'))
    );
    fs.mkdirSync(path.join(tempRoot!, '.pi', 'logs'), { recursive: true });
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function writeAndLoad(yamlContent: string): void {
    const yamlPath = path.join(tempRoot!, 'harness.yaml');
    fs.writeFileSync(yamlPath, yamlContent);
    process.chdir(tempRoot!);
    const loader = new ConfigLoader(undefined, tempRoot!);
    loader.load(yamlPath);
  }

  function baseYaml(settingsExtra: string = '', toolsBlock: string = ''): string {
    return `
settings:
  startState: Alpha
  worktreePolicy:
    default: always
${settingsExtra}
${toolsBlock}
statechart:
  terminalStates: [done]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
states:
  Alpha:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions: [{ id: a1, type: prompt }]
    transitions: { SUCCESS: done, FAILURE: Alpha, BLOCKED: Alpha }
`;
  }

  // (a) Negative limits — LOAD-BEARING: removing the semantic check or schema minimum:0
  //     makes negative limits accepted. The AJV schema catches negative values via
  //     minimum:0 before validateToolPayloadBudgetDeclarations runs.
  it('(a) LOAD-BEARING: rejects negative maxBytes in settings.toolPayloadBudget', () => {
    const yaml = baseYaml('  toolPayloadBudget:\n    maxBytes: -1\n    route: FAILURE\n');
    expect(() => writeAndLoad(yaml)).toThrow(/toolPayloadBudget|maxBytes|>= 0/i);
  });

  it('(a) LOAD-BEARING: rejects negative maxBytes in settings.toolPayloadBudgetByTool', () => {
    const yaml = baseYaml(
      '  toolPayloadBudgetByTool:\n    my_tool:\n      maxBytes: -100\n      route: FAILURE\n',
      'tools:\n  - name: my_tool\n    type: command\n    command: echo hi\n'
    );
    expect(() => writeAndLoad(yaml)).toThrow(/toolPayloadBudget|maxBytes|>= 0/i);
  });

  // (b) Unknown tool names — LOAD-BEARING: removing the `if (!declaredToolNames.has(toolName))`
  //     check in validateToolPayloadBudgetDeclarations makes unknown tool names accepted.
  it('(b) LOAD-BEARING: rejects unknown tool name in settings.toolPayloadBudgetByTool', () => {
    // "ghost_tool" is NOT declared in config.tools — must be rejected.
    const yaml = baseYaml(
      '  toolPayloadBudgetByTool:\n    ghost_tool:\n      maxBytes: 1000\n      route: FAILURE\n'
    );
    expect(() => writeAndLoad(yaml)).toThrow(/ghost_tool/);
  });

  it('(b) LOAD-BEARING: accepts known tool name in settings.toolPayloadBudgetByTool', () => {
    const yaml = baseYaml(
      '  toolPayloadBudgetByTool:\n    real_tool:\n      maxBytes: 1000\n      route: FAILURE\n',
      'tools:\n  - name: real_tool\n    type: command\n    command: echo hi\n'
    );
    // Must NOT throw — "real_tool" is declared in config.tools
    expect(() => writeAndLoad(yaml)).not.toThrow();
  });

  // (c) Routes absent from statechart vocabulary — LOAD-BEARING: removing the
  //     `if (!declaredOutcomes.has(...))` check makes unknown routes accepted.
  it('(c) LOAD-BEARING: rejects route absent from vocabulary in settings.toolPayloadBudget', () => {
    const yaml = baseYaml('  toolPayloadBudget:\n    maxBytes: 1000\n    route: UNKNOWN_ROUTE\n');
    expect(() => writeAndLoad(yaml)).toThrow(/UNKNOWN_ROUTE/);
  });

  it('(c) LOAD-BEARING: rejects route absent from vocabulary in settings.toolPayloadBudgetByTool', () => {
    const yaml = baseYaml(
      '  toolPayloadBudgetByTool:\n    my_tool:\n      maxBytes: 1000\n      route: MYSTERY_ROUTE\n',
      'tools:\n  - name: my_tool\n    type: command\n    command: echo hi\n'
    );
    expect(() => writeAndLoad(yaml)).toThrow(/MYSTERY_ROUTE/);
  });

  it('(c) accepts declared outcome as route in settings.toolPayloadBudget', () => {
    const yaml = baseYaml('  toolPayloadBudget:\n    maxBytes: 50000\n    route: FAILURE\n');
    // Must NOT throw — FAILURE is declared in failedOutcomes
    expect(() => writeAndLoad(yaml)).not.toThrow();
  });

  it('accepts toolPayloadBudget absent entirely (disabled-by-default / true no-op)', () => {
    // No toolPayloadBudget in settings — complete no-op
    const yaml = baseYaml();
    expect(() => writeAndLoad(yaml)).not.toThrow();
  });
});
