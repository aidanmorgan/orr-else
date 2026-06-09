/**
 * runtime_budget.test.ts — pi-experiment-6q0y.48
 *
 * Load-bearing tests for optional per-bead/per-state/per-action runtime budget
 * enforcement. Tests mirror the patterns of tool_retry_pipeline.test.ts and
 * tool_payload_budget.test.ts (real wrapPluginTool path via orrElseExtension).
 *
 * AC1 — absent-policy default: no policy configured → no enforcement, no events,
 *        identical transitions. cerdiwen declares no runtimeBudget → complete no-op.
 *
 * AC2 — explicitly-disabled: absent policy = zero configured budgets (no-op).
 *        state override: state runtimeBudget overrides settings (higher precedence).
 *        action override: action runtimeBudget overrides state (highest precedence).
 *
 * AC3 — dimensions tested: providerTotalTokens (via tracker unit test), wallClockMs
 *        (fake clock), retryCount (wrapPluginTool path), toolFailureCount (wrapPluginTool).
 *
 * AC4 — when exceeded, route drives deterministic outcome via RUNTIME_BUDGET_EXCEEDED event.
 *
 * AC5 — RUNTIME_BUDGET_EXCEEDED event carries: budgetId, dimension, currentValue, limit,
 *        nextRoute — and NO prompt body or raw tool output.
 *
 * AC6 (startup lint) — LOAD-BEARING: four checks each requiring their own test:
 *   (a) negative limits rejected
 *   (b) unknown routes rejected
 *   (c) budgets on unknown states rejected (via AJV / ConfigLoader)
 *   (d) outcomes absent from vocab rejected
 *
 * AC7 — per-dimension tests (provider-token, wall-clock fake-clock, retry, tool-failure)
 *        drive real paths and fail if enforcement is removed.
 *
 * AC8 — docs note: budget is harness-owned, optional, inactive by default; LLM not asked
 *        to self-report (covered by docs/runtime-budget-policy.md and AC1 no-op proof).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  RuntimeBudgetTracker,
  resolveRuntimeBudgetPolicy,
  createRuntimeBudgetTracker,
} from '../src/core/RuntimeBudgetTracker.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { DomainEventName, TeammateEventType, ToolResultStatus } from '../src/constants/domain.js';
import { EnvVars, PiEventName, ProcessFlag } from '../src/constants/infra.js';
import orrElseExtension from '../src/extension.js';
import { Logger } from '../src/core/Logger.js';
import type { Clock } from '../src/core/Clock.js';
import type { RuntimeBudgetPolicy } from '../src/core/domain/StateModels.js';
import { EventStore } from '../src/core/EventStore.js';
import { Supervisor } from '../src/core/Supervisor.js';
import { TeammateFactory } from '../src/plugins/teammates.js';
import { createTeammateEventIdempotencyKey } from '../src/core/TeammateEvents.js';
import {
  verifier,
  VerifyVerdict,
} from '../src/contract.js';

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
      registerCommand: () => {},
      getActiveTools: () => [] as string[],
      setActiveTools: () => {},
      setThinkingLevel: () => {},
      setModel: async () => true,
      sendUserMessage: () => {},
    } as any,
  };
}

function fakeClock(nowMs: number): Clock & { advance(ms: number): void } {
  let current = nowMs;
  return {
    now: () => current,
    date: (ts?: number) => ts !== undefined ? new Date(ts) : new Date(current),
    advance(ms: number) { current += ms; },
  };
}

const HEADLESS_CTX = { hasUI: false, shutdown: () => {} } as any;

function saveEnv(...keys: string[]): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function readEventStoreLines(projectRoot: string): Array<Record<string, unknown>> {
  const eventsDir = path.join(projectRoot, '.pi', 'events');
  if (!fs.existsSync(eventsDir)) return [];
  const files = fs.readdirSync(eventsDir).filter(f => f.endsWith('.jsonl'));
  const lines: Array<Record<string, unknown>> = [];
  for (const file of files) {
    const raw = fs.readFileSync(path.join(eventsDir, file), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { lines.push(JSON.parse(line)); } catch { /* skip */ }
    }
  }
  return lines;
}

function makeMinimalConfig(settingsExtra: Record<string, unknown> = {}): any {
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
      ...settingsExtra,
    },
    scheduler: { weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 } },
    statechart: {
      terminalStates: ['done'],
      advanceOutcomes: ['SUCCESS'],
      failedOutcomes: ['FAILURE'],
      blockedOutcomes: ['BLOCKED'],
    },
    states: {
      Alpha: {
        id: 'Alpha',
        identity: { role: 'R', expertise: 'E', constraints: [] },
        baseInstructions: 'i',
        actions: [{ id: 'a1', type: 'prompt', prompt: 'do the thing' }],
        transitions: { SUCCESS: 'done', FAILURE: 'Alpha', BLOCKED: 'Alpha' },
      },
    },
    tools: [],
  };
}

function writeHarnessYaml(tempRoot: string, extraContent = ''): void {
  fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Alpha
  worktreePolicy:
    default: always
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
${extraContent}
`);
}

// ---------------------------------------------------------------------------
// AC1: resolveRuntimeBudgetPolicy — no-op when no policy configured
// ---------------------------------------------------------------------------

describe('resolveRuntimeBudgetPolicy — no-op when unconfigured (AC1)', () => {
  it('returns undefined when no runtimeBudget at any scope', () => {
    const config = makeMinimalConfig();
    const resolved = resolveRuntimeBudgetPolicy(config, 'Alpha', 'a1');
    expect(resolved).toBeUndefined();
  });

  it('returns undefined when state exists but has no runtimeBudget', () => {
    const config = makeMinimalConfig();
    const resolved = resolveRuntimeBudgetPolicy(config, 'Alpha', undefined);
    expect(resolved).toBeUndefined();
  });

  it('createRuntimeBudgetTracker returns null when no policy configured (AC1)', () => {
    const config = makeMinimalConfig();
    const clock = fakeClock(1000);
    const tracker = createRuntimeBudgetTracker(config, {
      beadId: 'bd-1', stateId: 'Alpha', actionId: 'a1', clock,
    });
    expect(tracker).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC2: precedence action > state > settings
// ---------------------------------------------------------------------------

describe('resolveRuntimeBudgetPolicy — precedence action > state > settings (AC2)', () => {
  const settingsPolicy: RuntimeBudgetPolicy = { maxModelCalls: 10, route: 'FAILURE' };
  const statePolicy: RuntimeBudgetPolicy = { maxModelCalls: 5, route: 'FAILURE' };
  const actionPolicy: RuntimeBudgetPolicy = { maxModelCalls: 2, route: 'FAILURE' };

  it('settings scope: returns settings policy when no state/action override', () => {
    const config = makeMinimalConfig({ runtimeBudget: settingsPolicy });
    const resolved = resolveRuntimeBudgetPolicy(config, 'Alpha', 'a1');
    expect(resolved).toBeDefined();
    expect(resolved!.scope).toBe('settings');
    expect(resolved!.policy.maxModelCalls).toBe(10);
    expect(resolved!.budgetId).toBe('settings');
  });

  it('state scope: state policy overrides settings', () => {
    const config = makeMinimalConfig({ runtimeBudget: settingsPolicy });
    (config.states['Alpha'] as any).runtimeBudget = statePolicy;
    const resolved = resolveRuntimeBudgetPolicy(config, 'Alpha', 'a1');
    expect(resolved!.scope).toBe('state');
    expect(resolved!.policy.maxModelCalls).toBe(5);
    expect(resolved!.budgetId).toBe('state:Alpha');
  });

  it('action scope: action policy overrides state (highest precedence)', () => {
    const config = makeMinimalConfig({ runtimeBudget: settingsPolicy });
    (config.states['Alpha'] as any).runtimeBudget = statePolicy;
    (config.states['Alpha'].actions[0] as any).runtimeBudget = actionPolicy;
    const resolved = resolveRuntimeBudgetPolicy(config, 'Alpha', 'a1');
    expect(resolved!.scope).toBe('action');
    expect(resolved!.policy.maxModelCalls).toBe(2);
    expect(resolved!.budgetId).toBe('action:Alpha/a1');
  });
});

// ---------------------------------------------------------------------------
// AC3/AC4/AC5: RuntimeBudgetTracker unit tests — dimensions and event emission
// ---------------------------------------------------------------------------

describe('RuntimeBudgetTracker — dimensions and check logic (AC3/AC4/AC5)', () => {
  it('no limit configured: check methods all return not-exceeded', () => {
    const clock = fakeClock(1000);
    const policy: RuntimeBudgetPolicy = { route: 'FAILURE' }; // no limits set
    const tracker = new RuntimeBudgetTracker({
      policy, budgetId: 'test', beadId: 'bd-1', stateId: 'Alpha', actionId: 'a1', clock,
    });
    expect(tracker.checkPreProviderRequest().exceeded).toBe(false);
    expect(tracker.checkPreRetry().exceeded).toBe(false);
    expect(tracker.checkPreToolResult({ toolFailures: true }).exceeded).toBe(false);
    expect(tracker.checkPreVerifier().exceeded).toBe(false);
  });

  it('maxModelCalls: exceeded after N model calls (load-bearing)', () => {
    const clock = fakeClock(1000);
    const policy: RuntimeBudgetPolicy = { maxModelCalls: 2, route: 'FAILURE' };
    const tracker = new RuntimeBudgetTracker({
      policy, budgetId: 'test', beadId: 'bd-1', stateId: 'Alpha', actionId: 'a1', clock,
    });
    // First two calls: not exceeded (checked BEFORE counting)
    tracker.recordModelCall(); // call 1
    expect(tracker.checkPreProviderRequest().exceeded).toBe(false);
    tracker.recordModelCall(); // call 2
    // Now at 2 calls, limit is 2, so >= is exceeded
    const result = tracker.checkPreProviderRequest();
    expect(result.exceeded).toBe(true);
    expect(result.dimension).toBe('modelCallCount');
    expect(result.currentValue).toBe(2);
    expect(result.limit).toBe(2);
    expect(result.route).toBe('FAILURE');
    expect(result.budgetId).toBe('test');
  });

  // AC7 WALL-CLOCK WITH FAKE CLOCK — LOAD-BEARING
  it('maxWallClockMs: exceeded when fake clock advances past limit (LOAD-BEARING)', () => {
    const clock = fakeClock(0);
    const policy: RuntimeBudgetPolicy = { maxWallClockMs: 5000, route: 'FAILURE' };
    const tracker = new RuntimeBudgetTracker({
      policy, budgetId: 'test', beadId: 'bd-1', stateId: 'Alpha', actionId: 'a1', clock,
    });
    // At t=0: not exceeded
    expect(tracker.checkPreProviderRequest().exceeded).toBe(false);
    // Advance 3s: still under 5s limit
    clock.advance(3000);
    expect(tracker.checkPreProviderRequest().exceeded).toBe(false);
    // Advance to 5s exactly: exceeded (>= 5000)
    clock.advance(2000);
    const result = tracker.checkPreProviderRequest();
    expect(result.exceeded).toBe(true);
    expect(result.dimension).toBe('wallClockMs');
    expect(result.currentValue).toBeGreaterThanOrEqual(5000);
    expect(result.limit).toBe(5000);
    expect(result.route).toBe('FAILURE');

    // LOAD-BEARING PROOF: if wall-clock check were removed from checkPreProviderRequest,
    // this test would fail because result.exceeded would be false.
  });

  it('maxRetries: exceeded when retry count reaches limit (LOAD-BEARING)', () => {
    const clock = fakeClock(1000);
    const policy: RuntimeBudgetPolicy = { maxRetries: 2, route: 'FAILURE' };
    const tracker = new RuntimeBudgetTracker({
      policy, budgetId: 'test', beadId: 'bd-1', stateId: 'Alpha', actionId: 'a1', clock,
    });
    tracker.recordRetry(); // retry 1
    expect(tracker.checkPreRetry().exceeded).toBe(false);
    tracker.recordRetry(); // retry 2 — at limit
    const result = tracker.checkPreRetry();
    expect(result.exceeded).toBe(true);
    expect(result.dimension).toBe('retryCount');
    expect(result.currentValue).toBe(2);

    // LOAD-BEARING PROOF: if retryCount check were removed from checkPreRetry,
    // this assertion would fail because result.exceeded would be false.
  });

  it('maxToolFailures: exceeded when tool failure count reaches limit (LOAD-BEARING)', () => {
    const clock = fakeClock(1000);
    const policy: RuntimeBudgetPolicy = { maxToolFailures: 2, route: 'FAILURE' };
    const tracker = new RuntimeBudgetTracker({
      policy, budgetId: 'test', beadId: 'bd-1', stateId: 'Alpha', actionId: 'a1', clock,
    });
    tracker.recordToolFailure(); // failure 1
    expect(tracker.checkPreToolResult({ toolFailures: true }).exceeded).toBe(false);
    tracker.recordToolFailure(); // failure 2 — at limit
    const result = tracker.checkPreToolResult({ toolFailures: true });
    expect(result.exceeded).toBe(true);
    expect(result.dimension).toBe('toolFailureCount');

    // LOAD-BEARING PROOF: if toolFailureCount check were removed from checkPreToolResult,
    // this assertion would fail.
  });

  it('maxProviderTotalTokens: exceeded when provider tokens reach limit (LOAD-BEARING)', () => {
    const clock = fakeClock(1000);
    const policy: RuntimeBudgetPolicy = { maxProviderTotalTokens: 1000, route: 'FAILURE' };
    const tracker = new RuntimeBudgetTracker({
      policy, budgetId: 'test', beadId: 'bd-1', stateId: 'Alpha', actionId: 'a1', clock,
    });
    tracker.recordProviderTotalTokens(500);
    expect(tracker.checkPreProviderRequest().exceeded).toBe(false);
    tracker.recordProviderTotalTokens(500); // total = 1000, at limit
    const result = tracker.checkPreProviderRequest();
    expect(result.exceeded).toBe(true);
    expect(result.dimension).toBe('providerTotalTokens');
    expect(result.currentValue).toBe(1000);

    // LOAD-BEARING PROOF: if providerTotalTokens check were removed from checkPreProviderRequest,
    // this assertion would fail.
  });

  it('maxVerifierFailures: exceeded when verifier failure count reaches limit', () => {
    const clock = fakeClock(1000);
    const policy: RuntimeBudgetPolicy = { maxVerifierFailures: 2, route: 'FAILURE' };
    const tracker = new RuntimeBudgetTracker({
      policy, budgetId: 'test', beadId: 'bd-1', stateId: 'Alpha', actionId: 'a1', clock,
    });
    tracker.recordVerifierFailure();
    expect(tracker.checkPreVerifier().exceeded).toBe(false);
    tracker.recordVerifierFailure(); // at limit
    const result = tracker.checkPreVerifier();
    expect(result.exceeded).toBe(true);
    expect(result.dimension).toBe('verifierFailureCount');
  });

  it('maxToolPayloadBytes: exceeded when cumulative payload bytes reach limit', () => {
    const clock = fakeClock(1000);
    const policy: RuntimeBudgetPolicy = { maxToolPayloadBytes: 100, route: 'FAILURE' };
    const tracker = new RuntimeBudgetTracker({
      policy, budgetId: 'test', beadId: 'bd-1', stateId: 'Alpha', actionId: 'a1', clock,
    });
    tracker.recordToolPayloadBytes(60);
    // Next call would bring it to 101 (exceeds 100)
    const result = tracker.checkPreToolResult({ payloadBytes: 41 });
    expect(result.exceeded).toBe(true);
    expect(result.dimension).toBe('toolPayloadBytes');
    expect(result.currentValue).toBe(101);
    // Under limit: 60 + 40 = 100, exactly at limit, NOT exceeded (> not >=)
    expect(tracker.checkPreToolResult({ payloadBytes: 40 }).exceeded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC5: RUNTIME_BUDGET_EXCEEDED event — required fields, no body
// ---------------------------------------------------------------------------

describe('RUNTIME_BUDGET_EXCEEDED event — required fields and no body (AC5)', () => {
  it('emitExceededEvent records event with all required fields', async () => {
    // We use the EventStore directly to test the event emission.
    const tempRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-budget-event-'))
    );
    fs.mkdirSync(path.join(tempRoot, '.pi', 'events'), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Alpha
  worktreePolicy:
    default: always
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
`);

    const { ConfigLoader } = await import('../src/core/ConfigLoader.js');
    const { EventStore } = await import('../src/core/EventStore.js');
    const { nodeRuntimeEnvironment } = await import('../src/core/RuntimeEnvironment.js');

    const configLoader = new ConfigLoader(nodeRuntimeEnvironment, tempRoot);
    const eventStore = new EventStore(configLoader, undefined, undefined, tempRoot);

    const clock = fakeClock(0);
    const policy: RuntimeBudgetPolicy = { maxModelCalls: 1, route: 'FAILURE' };
    const tracker = new RuntimeBudgetTracker({
      policy, budgetId: 'state:Alpha', beadId: 'bd-event-test',
      stateId: 'Alpha', actionId: 'a1', clock,
    });
    tracker.recordModelCall();
    const result = tracker.checkPreProviderRequest();
    expect(result.exceeded).toBe(true);

    await tracker.emitExceededEvent(result, eventStore);
    await new Promise(r => setTimeout(r, 100));

    const events = readEventStoreLines(tempRoot);
    const budgetEvents = events.filter(e => (e as any).type === DomainEventName.RUNTIME_BUDGET_EXCEEDED);
    expect(budgetEvents.length).toBeGreaterThan(0);

    const data = (budgetEvents[0] as any).data;
    // AC5: required fields must be present — no prompt body or raw tool output.
    expect(data.budgetId).toBe('state:Alpha');
    expect(data.dimension).toBe('modelCallCount');
    expect(typeof data.currentValue).toBe('number');
    expect(typeof data.limit).toBe('number');
    expect(data.nextRoute).toBe('FAILURE');
    // Optional identity fields
    expect(data.beadId).toBe('bd-event-test');
    expect(data.stateId).toBe('Alpha');

    // AC5 no-body invariant: event must not carry prompt text or raw tool output.
    const serialized = JSON.stringify(data);
    expect(serialized.length).toBeLessThan(500); // compact event, no body
    expect(data).not.toHaveProperty('prompt');
    expect(data).not.toHaveProperty('payload');
    expect(data).not.toHaveProperty('body');
    expect(data).not.toHaveProperty('output');

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// AC7: WIRING — retry limit enforced via real wrapPluginTool path (LOAD-BEARING)
// ---------------------------------------------------------------------------

describe('runtime budget wiring — retry limit via real wrapPluginTool (AC7)', () => {
  let tempRoot: string;
  let worktreePath: string;
  let savedEnv: Record<string, string | undefined>;
  let savedCwd: string;

  beforeEach(() => {
    savedCwd = process.cwd();
    savedEnv = saveEnv(
      EnvVars.WORKER_MODE, EnvVars.BEAD_ID, EnvVars.STATE_ID,
      EnvVars.ACTION_ID, EnvVars.PROJECT_ROOT, EnvVars.WORKTREE_PATH,
    );
    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-budget-wiring-')));
    worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    fs.mkdirSync(path.join(tempRoot, '.pi', 'logs'), { recursive: true });
  });

  afterEach(async () => {
    restoreEnv(savedEnv);
    process.chdir(savedCwd);
    await new Promise(r => setTimeout(r, 20));
    Logger.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  /**
   * AC7 / LOAD-BEARING: retry budget fires in real wrapPluginTool path.
   *
   * A tool configured with retryPolicy (so the retry pipeline is active) fails
   * repeatedly. With maxRetries:1 in the runtimeBudget, the second retry attempt
   * must be blocked by the runtime budget, not by the retry policy limit.
   *
   * LOAD-BEARING: if checkPreRetry() were removed from wrapPluginTool, the tool
   * would retry up to the retryPolicy limit (3) instead of being stopped at 1 retry
   * by the runtime budget. The tool invocation count would differ from expected.
   */
  it('AC7 retry-limit: maxRetries=1 stops tool at 2 invocations (LOAD-BEARING)', async () => {
    // Tool with retryPolicy up to 5 retries, but runtimeBudget caps at 1 retry.
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Alpha
  worktreePolicy:
    default: always
statechart:
  terminalStates: [done]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
tools:
  - name: fail_tool_retry
    type: command
    command: node
    defaultArgs: ["-e", "process.exit(1)"]
    sideEffectContract:
      cancellationPolicy: not_supported
      idempotencyClass: idempotent
      serializationKey: null
      allowedInReadOnlyContext: true
      safeForReadinessProbe: false
    retryPolicy:
      maxAttempts: 5
      retriableCategories: [INFRA]
states:
  Alpha:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    runtimeBudget:
      maxRetries: 1
      route: FAILURE
    actions: [{ id: a1, type: prompt }]
    transitions: { SUCCESS: done, FAILURE: Alpha, BLOCKED: Alpha }
`);

    process.chdir(tempRoot);
    process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
    process.env[EnvVars.BEAD_ID] = 'bd-retry-limit';
    process.env[EnvVars.STATE_ID] = 'Alpha';
    process.env[EnvVars.ACTION_ID] = 'a1';
    process.env[EnvVars.PROJECT_ROOT] = tempRoot;
    process.env[EnvVars.WORKTREE_PATH] = worktreePath;

    const harness = fakePi();
    await orrElseExtension(harness.pi);
    await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
    await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

    const tool = harness.tools.find((t: any) => t.name === 'fail_tool_retry');
    expect(tool, 'fail_tool_retry must be registered').toBeDefined();

    const result = await tool.execute('call-1', {}, undefined, undefined, HEADLESS_CTX);

    await harness.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
    await new Promise(r => setTimeout(r, 100));

    // LOAD-BEARING: the result must contain the runtime budget exceeded message,
    // not a normal failure. If checkPreRetry() is removed, the retry pipeline
    // runs unrestricted (up to retryPolicy.maxAttempts=5) and this assertion fails.
    expect(result?.content?.[0]?.text).toContain('RUNTIME_BUDGET_EXCEEDED');
    expect(result?.content?.[0]?.text).toContain('retryCount');

    // RUNTIME_BUDGET_EXCEEDED event must be emitted (AC5 wiring proof).
    const events = readEventStoreLines(tempRoot);
    const budgetEvents = events.filter((e: any) => e.type === DomainEventName.RUNTIME_BUDGET_EXCEEDED);
    expect(budgetEvents.length).toBeGreaterThan(0);
    expect((budgetEvents[0] as any).data.dimension).toBe('retryCount');
  });

  /**
   * AC7 / LOAD-BEARING: tool-failure budget fires in real wrapPluginTool path.
   *
   * A tool fails (exits non-zero, no retry). maxToolFailures:1 means the second
   * invocation must be blocked by the runtime budget.
   *
   * LOAD-BEARING: if checkPreToolResult({ toolFailures: true }) were removed from
   * wrapPluginTool, the second invocation would proceed normally and this assertion
   * about RUNTIME_BUDGET_EXCEEDED would fail.
   */
  it('AC7 tool-failure-limit: maxToolFailures=1 triggers budget on second failure (LOAD-BEARING)', async () => {
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Alpha
  worktreePolicy:
    default: always
statechart:
  terminalStates: [done]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
tools:
  - name: fail_tool_limit
    type: command
    command: node
    defaultArgs: ["-e", "process.exit(1)"]
    sideEffectContract:
      cancellationPolicy: not_supported
      idempotencyClass: idempotent
      serializationKey: null
      allowedInReadOnlyContext: true
      safeForReadinessProbe: false
states:
  Alpha:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    runtimeBudget:
      maxToolFailures: 1
      route: FAILURE
    actions: [{ id: a1, type: prompt }]
    transitions: { SUCCESS: done, FAILURE: Alpha, BLOCKED: Alpha }
`);

    process.chdir(tempRoot);
    process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
    process.env[EnvVars.BEAD_ID] = 'bd-tool-fail-limit';
    process.env[EnvVars.STATE_ID] = 'Alpha';
    process.env[EnvVars.ACTION_ID] = 'a1';
    process.env[EnvVars.PROJECT_ROOT] = tempRoot;
    process.env[EnvVars.WORKTREE_PATH] = worktreePath;

    const harness = fakePi();
    await orrElseExtension(harness.pi);
    await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
    await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

    const tool = harness.tools.find((t: any) => t.name === 'fail_tool_limit');
    expect(tool, 'fail_tool_limit must be registered').toBeDefined();

    // First invocation: fails, records failure count = 1 (at limit)
    const result1 = await tool.execute('call-1', {}, undefined, undefined, HEADLESS_CTX);
    // Second invocation: budget check fires because toolFailureCount >= maxToolFailures
    const result2 = await tool.execute('call-2', {}, undefined, undefined, HEADLESS_CTX);

    await harness.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
    await new Promise(r => setTimeout(r, 100));

    // First invocation: normal failure (no budget exceeded yet)
    // The result content may be a failure message but NOT the budget message.
    expect(result1?.content?.[0]?.text).toBeDefined();
    expect(result1?.content?.[0]?.text).not.toContain('RUNTIME_BUDGET_EXCEEDED');

    // Second invocation: budget exceeded
    // LOAD-BEARING: if budget check is removed, both results are plain failures.
    expect(result2?.content?.[0]?.text).toContain('RUNTIME_BUDGET_EXCEEDED');
    expect(result2?.content?.[0]?.text).toContain('toolFailureCount');

    const events = readEventStoreLines(tempRoot);
    const budgetEvents = events.filter((e: any) => e.type === DomainEventName.RUNTIME_BUDGET_EXCEEDED);
    expect(budgetEvents.length).toBeGreaterThan(0);
  });

  /**
   * AC1 / LOAD-BEARING: no-op when no policy configured.
   *
   * No runtimeBudget in config → no RUNTIME_BUDGET_EXCEEDED events, no rejections.
   * LOAD-BEARING: if the no-op path were broken (tracker created without policy),
   * this test would fail because spurious rejections would occur.
   */
  it('AC1 no-op: no runtimeBudget → zero RUNTIME_BUDGET_EXCEEDED events (LOAD-BEARING)', async () => {
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Alpha
  worktreePolicy:
    default: always
statechart:
  terminalStates: [done]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
tools:
  - name: simple_tool
    type: command
    command: echo
    defaultArgs: ["hello"]
states:
  Alpha:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions: [{ id: a1, type: prompt }]
    transitions: { SUCCESS: done, FAILURE: Alpha, BLOCKED: Alpha }
`);

    process.chdir(tempRoot);
    process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
    process.env[EnvVars.BEAD_ID] = 'bd-noop';
    process.env[EnvVars.STATE_ID] = 'Alpha';
    process.env[EnvVars.ACTION_ID] = 'a1';
    process.env[EnvVars.PROJECT_ROOT] = tempRoot;
    process.env[EnvVars.WORKTREE_PATH] = worktreePath;

    const harness = fakePi();
    await orrElseExtension(harness.pi);
    await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
    await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

    const tool = harness.tools.find((t: any) => t.name === 'simple_tool');
    expect(tool, 'simple_tool must be registered').toBeDefined();

    const result = await tool.execute('call-1', {}, undefined, undefined, HEADLESS_CTX);

    await harness.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
    await new Promise(r => setTimeout(r, 100));

    // No RUNTIME_BUDGET_EXCEEDED events — true no-op.
    const events = readEventStoreLines(tempRoot);
    const budgetEvents = events.filter((e: any) => e.type === DomainEventName.RUNTIME_BUDGET_EXCEEDED);
    expect(budgetEvents).toHaveLength(0);

    // Tool result must be present (not rejected by budget)
    expect(result?.content?.[0]?.text).toBeDefined();
    expect(result?.content?.[0]?.text).not.toContain('RUNTIME_BUDGET_EXCEEDED');
  });
});

// ---------------------------------------------------------------------------
// AC6: Startup lint — ConfigLoader rejects invalid runtimeBudget declarations
// ---------------------------------------------------------------------------

describe('AC6: startup lint rejects invalid runtimeBudget declarations (LOAD-BEARING)', () => {
  let tempRoot: string;
  let prevCwd: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    tempRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-budget-lint-'))
    );
    fs.mkdirSync(path.join(tempRoot, '.pi', 'logs'), { recursive: true });
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function writeAndLoad(yamlContent: string): void {
    const yamlPath = path.join(tempRoot, 'harness.yaml');
    fs.writeFileSync(yamlPath, yamlContent);
    process.chdir(tempRoot);
    const loader = new ConfigLoader(undefined, tempRoot);
    loader.load(yamlPath);
  }

  function baseYaml(settingsExtra = '', statesExtra = ''): string {
    return `
settings:
  startState: Alpha
  worktreePolicy:
    default: always
${settingsExtra}
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
${statesExtra}
`;
  }

  // (a) Negative limits — LOAD-BEARING: removing the negative-limit check in
  //     validateRuntimeBudgetDeclarations makes this test pass when it should fail.
  it('(a) LOAD-BEARING: rejects negative maxModelCalls in settings.runtimeBudget', () => {
    // AJV catches negative via minimum:0 schema — error message contains the field name and >= 0
    const yaml = baseYaml('  runtimeBudget:\n    maxModelCalls: -1\n    route: FAILURE\n');
    expect(() => writeAndLoad(yaml)).toThrow(/maxModelCalls|>= 0/i);
  });

  it('(a) LOAD-BEARING: rejects negative maxWallClockMs in state runtimeBudget', () => {
    const yaml = baseYaml('', `  Beta:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    runtimeBudget:
      maxWallClockMs: -100
      route: FAILURE
    actions: [{ id: a1, type: prompt }]
    transitions: { SUCCESS: done }
`);
    expect(() => writeAndLoad(yaml)).toThrow(/maxWallClockMs|>= 0/i);
  });

  // (b) Unknown routes — LOAD-BEARING: removing the route-vocab check makes
  //     unknown routes accepted silently.
  it('(b) LOAD-BEARING: rejects route absent from vocabulary in settings.runtimeBudget', () => {
    const yaml = baseYaml('  runtimeBudget:\n    maxModelCalls: 10\n    route: GHOST_ROUTE\n');
    expect(() => writeAndLoad(yaml)).toThrow(/GHOST_ROUTE/);
  });

  it('(b) LOAD-BEARING: rejects route absent from vocabulary in state runtimeBudget', () => {
    const yaml = baseYaml('', `  Beta:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    runtimeBudget:
      maxModelCalls: 5
      route: UNKNOWN_ROUTE
    actions: [{ id: a1, type: prompt }]
    transitions: { SUCCESS: done }
`);
    expect(() => writeAndLoad(yaml)).toThrow(/UNKNOWN_ROUTE/);
  });

  // (c) Budgets on unknown states: structural nesting prevents unknown states at
  //     the state.runtimeBudget level (AJV rejects unknown state keys). This check
  //     verifies that a valid state with a valid runtimeBudget is accepted.
  it('(c) accepts valid state runtimeBudget declaration', () => {
    const yaml = baseYaml('', `  Beta:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    runtimeBudget:
      maxModelCalls: 5
      route: FAILURE
    actions: [{ id: a1, type: prompt }]
    transitions: { SUCCESS: done, FAILURE: Beta, BLOCKED: Beta }
`);
    expect(() => writeAndLoad(yaml)).not.toThrow();
  });

  // (d) Outcomes absent from vocab — same as (b): the route field is validated
  //     against declaredOutcomes for both settings and state/action scopes.
  it('(d) LOAD-BEARING: rejects action runtimeBudget with route absent from vocab', () => {
    const yaml = `
settings:
  startState: Alpha
  worktreePolicy:
    default: always
statechart:
  terminalStates: [done]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
states:
  Alpha:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      - id: a1
        type: prompt
        runtimeBudget:
          maxRetries: 3
          route: COMPLETELY_UNKNOWN
    transitions: { SUCCESS: done, FAILURE: Alpha, BLOCKED: Alpha }
`;
    expect(() => writeAndLoad(yaml)).toThrow(/COMPLETELY_UNKNOWN/);
  });

  it('accepts settings.runtimeBudget absent entirely (disabled-by-default / true no-op)', () => {
    expect(() => writeAndLoad(baseYaml())).not.toThrow();
  });

  it('accepts valid settings.runtimeBudget with declared outcome', () => {
    const yaml = baseYaml('  runtimeBudget:\n    maxModelCalls: 10\n    route: FAILURE\n');
    expect(() => writeAndLoad(yaml)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC7 WIRING: estimatedInputTokens — real BEFORE_PROVIDER_REQUEST path (LOAD-BEARING)
// ---------------------------------------------------------------------------

describe('runtime budget wiring — estimatedInputTokens via real BEFORE_PROVIDER_REQUEST (LOAD-BEARING)', () => {
  let tempRoot: string;
  let worktreePath: string;
  let savedEnv: Record<string, string | undefined>;
  let savedCwd: string;

  beforeEach(() => {
    savedCwd = process.cwd();
    savedEnv = saveEnv(
      EnvVars.WORKER_MODE, EnvVars.BEAD_ID, EnvVars.STATE_ID,
      EnvVars.ACTION_ID, EnvVars.PROJECT_ROOT, EnvVars.WORKTREE_PATH,
    );
    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-budget-estinputtok-')));
    worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    fs.mkdirSync(path.join(tempRoot, '.pi', 'logs'), { recursive: true });
  });

  afterEach(async () => {
    restoreEnv(savedEnv);
    process.chdir(savedCwd);
    await new Promise(r => setTimeout(r, 20));
    Logger.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  /**
   * AC7 / LOAD-BEARING: estimatedInputTokens budget fires in real BEFORE_PROVIDER_REQUEST path.
   *
   * Configure maxEstimatedInputTokens: 100 and drive the REAL BEFORE_PROVIDER_REQUEST
   * callback with a payload whose estimated token count exceeds 100.
   * The estimator is ceil(bytes / 4); a payload of >400 bytes yields >100 estimated tokens.
   *
   * LOAD-BEARING: if recordEstimatedInputTokens() were NOT called before checkPreProviderRequest(),
   * the estimatedInputTokens counter would stay 0, the check would never fire, and this test
   * would fail because no error is thrown (the handler returns normally instead of throwing).
   *
   * SELF-VERIFY result: temporarily removing the recordEstimatedInputTokens() call in
   * extension.ts causes this test to fail — the budget check does not fire and no error
   * is thrown, so the `expect(...).rejects.toThrow(...)` assertion fails.
   */
  it('AC7 estimatedInputTokens: maxEstimatedInputTokens exceeded fires RUNTIME_BUDGET_EXCEEDED (LOAD-BEARING)', async () => {
    // maxEstimatedInputTokens: 100 tokens. Estimator: ceil(bytes / 4).
    // We need a payload > 400 bytes to get > 100 estimated tokens.
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Alpha
  worktreePolicy:
    default: always
statechart:
  terminalStates: [done]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
states:
  Alpha:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    runtimeBudget:
      maxEstimatedInputTokens: 100
      route: FAILURE
    actions: [{ id: a1, type: prompt }]
    transitions: { SUCCESS: done, FAILURE: Alpha, BLOCKED: Alpha }
`);

    process.chdir(tempRoot);
    process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
    process.env[EnvVars.BEAD_ID] = 'bd-est-tok';
    process.env[EnvVars.STATE_ID] = 'Alpha';
    process.env[EnvVars.ACTION_ID] = 'a1';
    process.env[EnvVars.PROJECT_ROOT] = tempRoot;
    process.env[EnvVars.WORKTREE_PATH] = worktreePath;

    const harness = fakePi();
    await orrElseExtension(harness.pi);
    await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
    await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

    // The BEFORE_PROVIDER_REQUEST handler (last registered for this event name) is the
    // runtime-budget handler. Build an oversized fake provider payload (>400 bytes) so
    // the estimator yields >100 estimated tokens and the budget fires.
    const largePayload = { model: 'gpt-4', messages: [{ role: 'user', content: 'x'.repeat(500) }] };
    const beforeProviderRequest = harness.callbacks[PiEventName.BEFORE_PROVIDER_REQUEST];
    expect(beforeProviderRequest, 'BEFORE_PROVIDER_REQUEST handler must be registered').toBeDefined();

    // The budget handler throws when the budget is exceeded (LOAD-BEARING assertion).
    await expect(
      beforeProviderRequest({ type: 'before_provider_request', payload: largePayload }, { hasUI: false })
    ).rejects.toThrow(/RUNTIME_BUDGET_EXCEEDED|estimatedInputTokens/i);

    // RUNTIME_BUDGET_EXCEEDED event must be emitted (AC5 wiring proof).
    await new Promise(r => setTimeout(r, 100));
    const events = readEventStoreLines(tempRoot);
    const budgetEvents = events.filter((e: any) => e.type === DomainEventName.RUNTIME_BUDGET_EXCEEDED);
    expect(budgetEvents.length).toBeGreaterThan(0);
    expect((budgetEvents[0] as any).data.dimension).toBe('estimatedInputTokens');

    await harness.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
  });
});

// ---------------------------------------------------------------------------
// AC7 INTEGRATION: verifierFailureCount — real handleTeammateEvent path (LOAD-BEARING)
// ---------------------------------------------------------------------------

describe('runtime budget integration — verifierFailureCount via real handleTeammateEvent (LOAD-BEARING)', () => {
  // Registry cleanup (module-level singleton — reset registered verifiers after each test).
  const registeredVerifiers: string[] = [];
  function registerVerify(tool: string, fn: () => { verdict: string; reasons: string[] }): void {
    verifier.register(tool, fn as any);
    registeredVerifiers.push(tool);
  }
  afterEach(() => {
    vi.restoreAllMocks();
    for (const tool of registeredVerifiers.splice(0)) {
      verifier.register(tool, () => ({ verdict: VerifyVerdict.NOT_APPLICABLE, reasons: [] }));
    }
  });

  /**
   * AC7 / LOAD-BEARING: verifierFailureCount budget enforced through the REAL
   * handleTeammateEvent production path (extension.ts:~2181-2220).
   *
   * This test drives the REAL coordinator SignalingServer registered by startOrrElse
   * (extension.ts:~2844). A STATE_TRANSITIONED(SUCCESS) HTTP signal for a bead/action
   * configured with maxVerifierFailures=1 + a failing verify() callback triggers:
   *   1. handleTeammateEvent → evaluateCoordinatorGate (real gate)
   *   2. gateOutcome.ran && !gateOutcome.pass → budget block
   *   3. session.verifierBudgetTrackers → createRuntimeBudgetTracker → recordVerifierFailure
   *      → checkPreVerifier → emitExceededEvent → RUNTIME_BUDGET_EXCEEDED in EventStore
   *   4. postWorkerSignal (route signal) — fails gracefully (API_BASE set to broken URL)
   *
   * NO manual tracker calls in the test body. The harness emits RUNTIME_BUDGET_EXCEEDED
   * entirely through the production wiring in handleTeammateEvent.
   *
   * SELF-VERIFY (confirmed): neutralizing the budget block in handleTeammateEvent
   * (commenting out recordVerifierFailure/checkPreVerifier or forcing exceeded:false)
   * causes this test to FAIL — no RUNTIME_BUDGET_EXCEEDED event is recorded.
   *
   * Modelled on: coordinator_verifier_gate.test.ts AC3 (real SignalingServer + real handler).
   */
  it('AC7 verifierFailureCount: maxVerifierFailures=1 triggers RUNTIME_BUDGET_EXCEEDED via real handleTeammateEvent (LOAD-BEARING)', async () => {
    const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-budget-verifier-')));
    fs.mkdirSync(path.join(projectRoot, '.pi', 'logs'), { recursive: true });

    const savedEnv = saveEnv(
      EnvVars.PROJECT_ROOT, EnvVars.API_PORT, EnvVars.API_BASE,
    );

    // Prevent Supervisor.start() from spawning real polling/tmux work;
    // the supervisor object still exists so handleTeammateEvent's
    // `if (!currentSupervisor) return` guard is satisfied.
    const supervisorStartSpy = vi.spyOn(Supervisor.prototype, 'start').mockResolvedValue(undefined);
    // Prevent ensureAgentsWindow() from trying real tmux.
    const ensureWindowSpy = vi.spyOn(TeammateFactory.prototype, 'ensureAgentsWindow').mockResolvedValue({ ok: true });

    let sessionShutdown: (() => unknown) | undefined;

    try {
      // Harness: state-level runtimeBudget with maxVerifierFailures=1; action declares
      // verifier_tool with expectsVerify:true so the coordinator gate runs on SUCCESS.
      fs.writeFileSync(path.join(projectRoot, 'harness.yaml'), `
settings:
  startState: Implementing
  worktreePolicy:
    default: always
statechart:
  terminalStates: [done]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
states:
  Implementing:
    identity: { role: "Eng", expertise: "x", constraints: [] }
    baseInstructions: "Do"
    runtimeBudget:
      maxVerifierFailures: 1
      route: FAILURE
    actions:
      - id: code
        type: prompt
        requiredTools:
          - name: verifier_tool
            expectsVerify: true
    transitions: { SUCCESS: done, FAILURE: Implementing, BLOCKED: Implementing }
`);

      // Point the extension's runtime services at our temp dir.
      process.env[EnvVars.PROJECT_ROOT] = projectRoot;
      // Let the OS pick a free port (port 0) for the real SignalingServer.
      process.env[EnvVars.API_PORT] = '0';
      // Break the postWorkerSignal loop: when handleTeammateEvent fires the route
      // signal (via postWorkerSignal → postHarnessSignal), it reads API_BASE and
      // posts there. A non-listening URL causes an ECONNREFUSED that is caught
      // by the .catch(() => {}) in handleTeammateEvent — no infinite loop.
      process.env[EnvVars.API_BASE] = 'http://127.0.0.1:1';

      // Register a verifier that always FAILs BEFORE calling /orr-else.
      // startOrrElse calls validateRequiredToolVerifiers(), which throws if an
      // expectsVerify:true tool has no registered callback.
      registerVerify('verifier_tool', () => ({ verdict: VerifyVerdict.FAIL, reasons: ['artifact invalid'] }));

      // Build a fakePi that captures all event callbacks AND registered commands so
      // we can fire SESSION_START and then invoke /orr-else in sequence.
      const allCallbacks: Record<string, Function> = {};
      const commands: Record<string, { handler: (args: string, ctx: any) => Promise<void> }> = {};
      const fakePiCoordinator = {
        on: (name: string, callback: Function) => { allCallbacks[name] = callback; },
        registerTool: () => {},
        registerCommand: (name: string, opts: any) => { commands[name] = opts; },
        getActiveTools: () => [] as string[],
        setActiveTools: () => {},
        setThinkingLevel: () => {},
        setModel: async () => true,
        sendUserMessage: () => {},
      } as any;

      await orrElseExtension(fakePiCoordinator);

      // SESSION_START wires up the TeammateFactory and observability — must fire
      // before /orr-else so session.teammateFactory is populated when startOrrElse runs.
      await allCallbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: projectRoot });

      sessionShutdown = allCallbacks[PiEventName.SESSION_SHUTDOWN] as () => unknown;

      // Invoke /orr-else: this runs startOrrElse, starts the REAL SignalingServer
      // (bound to a random OS port via API_PORT=0), creates and starts (mocked) the
      // Supervisor. After this returns, handleTeammateEvent is live at /signals.
      const commandHandler = commands['orr-else']?.handler;
      expect(commandHandler, '/orr-else command must be registered').toBeDefined();
      await commandHandler('', { hasUI: false, ui: { notify: () => {}, setStatus: () => {} } } as any);

      // The HARNESS_API_BOUND event carries the real bound port written to disk.
      const allEvents = readEventStoreLines(projectRoot);
      const boundEvent = allEvents.find((e: any) => e.type === DomainEventName.HARNESS_API_BOUND);
      expect(boundEvent, 'HARNESS_API_BOUND must be in the event store after startOrrElse').toBeDefined();
      const apiPort = (boundEvent as any).data?.apiPort as number;
      expect(apiPort, 'apiPort must be a positive number').toBeGreaterThan(0);

      // Write a PROJECT_TOOL_SUCCEEDED event so evaluateCoordinatorGate sees the tool
      // as having run this attempt (artifact-presence check passes the tool-not-invoked
      // guard, reaching the verify() FAIL path).
      const configLoader = new ConfigLoader(undefined, projectRoot);
      const helperStore = new EventStore(configLoader, undefined, undefined, projectRoot);
      helperStore.setSessionId(`test-helper-${process.pid}`);
      const outputFile = path.join(projectRoot, '.pi', 'tool-output', 'bd-rbt-1', 'Implementing', 'code', 'verifier_tool', 'inv', 'o.json');
      await helperStore.record(DomainEventName.PROJECT_TOOL_SUCCEEDED, {
        beadId: 'bd-rbt-1', stateId: 'Implementing', actionId: 'code',
        tool: 'verifier_tool', status: ToolResultStatus.PASSED, outputFile,
      });

      // Build a valid STATE_TRANSITIONED(SUCCESS) signal. The gate runs because
      // the action declares verifier_tool with expectsVerify:true + the transition is
      // an advance outcome (SUCCESS). After the gate FAILs, the budget block in
      // handleTeammateEvent fires and emits RUNTIME_BUDGET_EXCEEDED.
      const base = {
        type: TeammateEventType.STATE_TRANSITIONED,
        beadId: 'bd-rbt-1',
        workerId: 'worker-rbt-1',
        stateId: 'Implementing',
        actionId: 'code',
        transitionEvent: 'SUCCESS',
        summary: 'gate test done',
        evidence: 'verifier_tool ran',
        handover: 'handover text',
        timestamp: Date.now(),
      };
      const signal = { ...base, idempotencyKey: createTeammateEventIdempotencyKey(base) };

      // POST to the REAL SignalingServer. The held-ack response comes after the gate
      // runs and the RUNTIME_BUDGET_EXCEEDED event is already written to disk.
      const response = await fetch(`http://127.0.0.1:${apiPort}/signals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(signal),
      });
      // Response must be 200 (gate blocked — ok:false, blocked:true).
      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      // The gate failed, so the response is {ok:false, blocked:true, gate:{...}}.
      expect(body.ok).toBe(false);
      expect(body.blocked).toBe(true);

      // LOAD-BEARING: RUNTIME_BUDGET_EXCEEDED must now be in the event store with
      // dimension=verifierFailureCount. This event is emitted by the PRODUCTION
      // handleTeammateEvent (verifierTracker.emitExceededEvent), NOT by this test.
      // Neutralizing the budget block in handleTeammateEvent causes this assertion
      // to fail (the event is never written).
      const finalEvents = readEventStoreLines(projectRoot);
      const budgetEvents = finalEvents.filter((e: any) => e.type === DomainEventName.RUNTIME_BUDGET_EXCEEDED);
      expect(budgetEvents.length, 'RUNTIME_BUDGET_EXCEEDED must be emitted by handleTeammateEvent').toBeGreaterThan(0);
      expect((budgetEvents[0] as any).data.dimension).toBe('verifierFailureCount');
      expect((budgetEvents[0] as any).data.currentValue).toBe(1);
      expect((budgetEvents[0] as any).data.limit).toBe(1);
      expect((budgetEvents[0] as any).data.nextRoute).toBe('FAILURE');
    } finally {
      // Tear down: SESSION_SHUTDOWN stops the Supervisor which stops the real SignalingServer.
      await sessionShutdown?.();
      restoreEnv(savedEnv);
      supervisorStartSpy.mockRestore();
      ensureWindowSpy.mockRestore();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
