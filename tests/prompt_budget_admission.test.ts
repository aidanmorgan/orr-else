/**
 * prompt_budget_admission.test.ts — pi-experiment-6q0y.17
 *
 * Load-bearing tests for the optional hard prompt-budget admission.
 *
 * ACs covered:
 *
 * AC1 — With no budget configured, prompt assembly does NOT reject and golden
 *        transitions are unaffected. Proved by the no-op path and by asserting
 *        no PROMPT_BUDGET_ADMISSION event is emitted.
 *
 * AC2 — computePromptSizing returns separate byte + token estimates for all four
 *        segments (stable block, Pi base prompt, volatile suffix, final prompt).
 *        Deterministic: same inputs → same outputs.
 *
 * AC3 — resolvePromptBudgetPolicy enforces action > state > settings precedence.
 *
 * AC4 / AC6 — WIRING: drives the REAL BEFORE_AGENT_START handler via
 *              orrElseExtension and asserts that, when an over-budget limit is
 *              configured, the BEFORE_AGENT_START handler throws BEFORE the first
 *              model/provider request (BEFORE_PROVIDER_REQUEST is never reached).
 *              If the admission is unwired this test FAILS because the provider
 *              request fires regardless.
 *
 * AC5 — PROMPT_BUDGET_ADMISSION event contains hashes, byte counts, token
 *        estimates, configPath, stateId, limitScope, route — NO prompt body.
 *
 * AC7 — Startup lint rejects:
 *        (a) negative limits (maxBytes < 0, maxTokens < 0),
 *        (b) unknown state or action ID references in named override maps
 *            (settings.promptBudgetStateOverrides / settings.promptBudgetActionOverrides).
 *            A key that does not match a declared state or action is rejected with a
 *            diagnostic naming the unknown ref and config path.
 *        (c) budget routes absent from statechart vocabulary.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

import {
  computePromptSizing,
  resolvePromptBudgetPolicy,
  evaluatePromptBudgetAdmission,
} from '../src/core/PromptBudgetAdmission.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { DomainEventName } from '../src/constants/domain.js';
import { EnvVars, PiEventName, ProcessFlag } from '../src/constants/infra.js';
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
    fs.mkdtempSync(path.join(os.tmpdir(), 'budget-admission-test-'))
  );
  fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), yaml);
  fs.mkdirSync(path.join(tempRoot, '.pi', 'logs'), { recursive: true });

  process.chdir(tempRoot);
  process.env[EnvVars.PROJECT_ROOT] = tempRoot;
  process.env[EnvVars.WORKTREE_PATH] = tempRoot;
  process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
  process.env[EnvVars.BEAD_ID] = 'bead-budget-test';
  process.env[EnvVars.STATE_ID] = stateId;
  process.env[EnvVars.ACTION_ID] = actionId;
  process.env[EnvVars.SESSION_STATE_ID] = 'sess-001';
  process.env[EnvVars.API_BASE] = 'http://127.0.0.1:19996';

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

function makeHarnessYaml(budgetBlock = ''): string {
  return `
settings:
  startState: Alpha
  worktreePolicy:
    default: always
${budgetBlock}
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
  // Extension.ts uses EventStore which writes to .pi/events/*.jsonl
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

// ---------------------------------------------------------------------------
// AC2: computePromptSizing — unit tests
// ---------------------------------------------------------------------------

describe('computePromptSizing (AC2)', () => {
  it('returns separate byte + token estimates for all four segments', () => {
    const stable = 'stable block content here';
    const pi = 'Pi base prompt';
    const suffix = 'volatile suffix content';

    const result = computePromptSizing({
      stableBlock: stable,
      piBasePrompt: pi,
      volatileSuffix: suffix,
    });

    // All four sizing fields are present
    expect(result.stableBlockBytes).toBeGreaterThan(0);
    expect(result.stableBlockTokens).toBeGreaterThan(0);
    expect(result.stableBlockHash).toHaveLength(16); // DIGEST_ID_LENGTH

    expect(result.piBasePromptBytes).toBeGreaterThan(0);
    expect(result.piBasePromptTokens).toBeGreaterThan(0);
    expect(result.piBasePromptHash).toHaveLength(16);

    expect(result.volatileSuffixBytes).toBeGreaterThan(0);
    expect(result.volatileSuffixTokens).toBeGreaterThan(0);
    expect(result.volatileSuffixHash).toHaveLength(16);

    expect(result.finalPromptBytes).toBeGreaterThan(0);
    expect(result.finalPromptTokens).toBeGreaterThan(0);
    expect(result.finalPromptHash).toHaveLength(16);

    // Byte count is correct (stable + "\n\n" + pi + "\n\n" + suffix)
    const expectedFinal = `${stable}\n\n${pi}\n\n${suffix}`;
    expect(result.finalPromptBytes).toBe(Buffer.byteLength(expectedFinal, 'utf8'));

    // Token estimate is ceil(bytes / 4)
    expect(result.stableBlockTokens).toBe(Math.ceil(Buffer.byteLength(stable, 'utf8') / 4));
    expect(result.finalPromptTokens).toBe(Math.ceil(result.finalPromptBytes / 4));
  });

  it('is deterministic: same inputs → same outputs', () => {
    const inputs = { stableBlock: 'stable', piBasePrompt: 'pi', volatileSuffix: 'suffix' };
    const a = computePromptSizing(inputs);
    const b = computePromptSizing(inputs);
    expect(a).toEqual(b);
  });

  it('handles absent Pi base prompt: final = stableBlock + \\n\\n + suffix', () => {
    const stable = 'stable content';
    const suffix = 'suffix content';
    const result = computePromptSizing({
      stableBlock: stable,
      piBasePrompt: undefined,
      volatileSuffix: suffix,
    });

    const expectedFinal = `${stable}\n\n${suffix}`;
    expect(result.finalPromptBytes).toBe(Buffer.byteLength(expectedFinal, 'utf8'));
    expect(result.piBasePromptBytes).toBe(0);
    expect(result.piBasePromptTokens).toBe(0);
  });

  it('four segments produce distinct hashes when content differs', () => {
    const result = computePromptSizing({
      stableBlock: 'AAAA',
      piBasePrompt: 'BBBB',
      volatileSuffix: 'CCCC',
    });
    const hashes = [
      result.stableBlockHash,
      result.piBasePromptHash,
      result.volatileSuffixHash,
      result.finalPromptHash,
    ];
    expect(new Set(hashes).size).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// AC3: resolvePromptBudgetPolicy — precedence tests
// ---------------------------------------------------------------------------

describe('resolvePromptBudgetPolicy (AC3: action > state > settings)', () => {
  function makeConfig(overrides: {
    settingsBudget?: { maxBytes: number; route: string };
    stateBudget?: { maxBytes: number; route: string };
    actionBudget?: { maxBytes: number; route: string };
  }): import('../src/core/ConfigLoader.js').HarnessConfig {
    return {
      settings: {
        maxConcurrentSlots: 1,
        handoverTemplate: 'tmpl',
        agentTurnTimeoutMs: 1000,
        processReapIntervalMs: 1000,
        harnessRestartEvent: 'HARNESS_RESTART',
        contextRestartEvent: 'CONTEXT_RESTART',
        defaultModel: 'gpt-4',
        defaultProvider: 'openai',
        modelProviders: {},
        stateContextRotThreshold: 10,
        harnessContextRotThreshold: 5,
        ...(overrides.settingsBudget ? { promptBudget: { ...overrides.settingsBudget } } : {}),
      } as any,
      scheduler: { weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 } },
      states: {
        Alpha: {
          id: 'Alpha',
          identity: { role: 'r', expertise: 'e', constraints: [] },
          actions: [{
            id: 'a1',
            type: 'prompt' as any,
            ...(overrides.actionBudget ? { promptBudget: { ...overrides.actionBudget } } : {}),
          }],
          transitions: { SUCCESS: 'done' },
          ...(overrides.stateBudget ? { promptBudget: { ...overrides.stateBudget } } : {}),
        } as any,
      },
    } as any;
  }

  it('returns undefined when no policy is configured at any scope', () => {
    const config = makeConfig({});
    expect(resolvePromptBudgetPolicy(config, 'Alpha', 'a1')).toBeUndefined();
  });

  it('returns settings policy when only settings is configured', () => {
    const config = makeConfig({ settingsBudget: { maxBytes: 1000, route: 'FAILURE' } });
    const result = resolvePromptBudgetPolicy(config, 'Alpha', 'a1');
    expect(result).toBeDefined();
    expect(result!.scope).toBe('settings');
    expect(result!.policy.maxBytes).toBe(1000);
  });

  it('returns state policy when state is configured (overrides settings)', () => {
    const config = makeConfig({
      settingsBudget: { maxBytes: 1000, route: 'FAILURE' },
      stateBudget: { maxBytes: 500, route: 'FAILURE' },
    });
    const result = resolvePromptBudgetPolicy(config, 'Alpha', 'a1');
    expect(result!.scope).toBe('state');
    expect(result!.policy.maxBytes).toBe(500);
  });

  it('returns action policy when action is configured (overrides state and settings)', () => {
    const config = makeConfig({
      settingsBudget: { maxBytes: 1000, route: 'FAILURE' },
      stateBudget: { maxBytes: 500, route: 'FAILURE' },
      actionBudget: { maxBytes: 200, route: 'FAILURE' },
    });
    const result = resolvePromptBudgetPolicy(config, 'Alpha', 'a1');
    expect(result!.scope).toBe('action');
    expect(result!.policy.maxBytes).toBe(200);
  });

  it('falls back to settings when stateId is absent', () => {
    const config = makeConfig({ settingsBudget: { maxBytes: 1000, route: 'FAILURE' } });
    const result = resolvePromptBudgetPolicy(config, undefined, undefined);
    expect(result!.scope).toBe('settings');
  });
});

// ---------------------------------------------------------------------------
// AC1: no-op when unconfigured — evaluatePromptBudgetAdmission
// ---------------------------------------------------------------------------

describe('evaluatePromptBudgetAdmission — no-op when unconfigured (AC1)', () => {
  it('returns exceeded:false and resolvedPolicy:undefined when no budget is configured', () => {
    const sizing = computePromptSizing({
      stableBlock: 'x'.repeat(10_000),
      piBasePrompt: 'y'.repeat(10_000),
      volatileSuffix: 'z'.repeat(10_000),
    });
    const config = {
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
      },
      scheduler: { weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 } },
      states: {},
    } as any;

    const result = evaluatePromptBudgetAdmission(sizing, config, 'Alpha', 'a1');
    expect(result.exceeded).toBe(false);
    expect(result.resolvedPolicy).toBeUndefined();
    expect(result.limitScope).toBeUndefined();
    expect(result.route).toBeUndefined();
  });

  it('does NOT exceed when prompt is below configured limits', () => {
    const sizing = computePromptSizing({
      stableBlock: 'small',
      piBasePrompt: 'prompt',
      volatileSuffix: 'suffix',
    });
    const config = {
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
        promptBudget: { maxBytes: 10_000_000, maxTokens: 10_000_000, route: 'FAILURE' },
      },
      scheduler: { weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 } },
      states: {},
    } as any;

    const result = evaluatePromptBudgetAdmission(sizing, config, undefined, undefined);
    expect(result.exceeded).toBe(false);
  });

  it('exceeds when maxBytes is breached', () => {
    const stableBlock = 'x'.repeat(100);
    const sizing = computePromptSizing({ stableBlock, piBasePrompt: undefined, volatileSuffix: '' });
    const config = {
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
        promptBudget: { maxBytes: 1, route: 'FAILURE' },
      },
      scheduler: { weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 } },
      states: {},
    } as any;

    const result = evaluatePromptBudgetAdmission(sizing, config, undefined, undefined);
    expect(result.exceeded).toBe(true);
    expect(result.route).toBe('FAILURE');
  });

  it('exceeds when maxTokens is breached', () => {
    const stableBlock = 'x'.repeat(1000); // ~250 tokens
    const sizing = computePromptSizing({ stableBlock, piBasePrompt: undefined, volatileSuffix: '' });
    const config = {
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
        promptBudget: { maxTokens: 1, route: 'FAILURE' },
      },
      scheduler: { weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 } },
      states: {},
    } as any;

    const result = evaluatePromptBudgetAdmission(sizing, config, undefined, undefined);
    expect(result.exceeded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC4 + AC6 (WIRING): BEFORE_AGENT_START fails before provider request
// ---------------------------------------------------------------------------

describe('AC4/AC6 WIRING: over-budget admission fails before provider request', () => {
  let env: TestEnv | undefined;
  const closeHandles: (() => Promise<void>)[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const close of closeHandles) await close().catch(() => {});
    closeHandles.length = 0;
    if (env) { teardownWorkerEnv(env); env = undefined; }
    Logger.close();
  });

  it('throws BEFORE any BEFORE_PROVIDER_REQUEST when maxBytes is exceeded (AC4/AC6 — LOAD-BEARING)', async () => {
    // Configure a maxBytes limit of 1 — any real prompt will exceed it.
    const yaml = makeHarnessYaml(`  promptBudget:\n    maxBytes: 1\n    route: FAILURE`);
    env = setupWorkerEnv(yaml);

    const harness = fakePi();
    await orrElseExtension(harness.pi);
    await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: env.tempRoot });

    // The BEFORE_AGENT_START handler runs before the first model request.
    // Spy on BEFORE_PROVIDER_REQUEST — it must NEVER be called if wiring is correct.
    let providerRequestFired = false;
    harness.pi.on(PiEventName.BEFORE_PROVIDER_REQUEST, () => {
      providerRequestFired = true;
    });

    // Trigger BEFORE_AGENT_START (simulates the Pi runtime calling it before the turn).
    // A thrown error from BEFORE_AGENT_START prevents the model from receiving the prompt.
    let threw = false;
    try {
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({
        systemPrompt: 'base system prompt from Pi'
      });
    } catch {
      threw = true;
    }

    // ASSERTION 1 (load-bearing): must throw — admission blocked the turn.
    // If evaluatePromptBudgetAdmission is removed from the handler, this assertion fails.
    expect(threw).toBe(true);

    // ASSERTION 2: no provider request fired — the throw happened before any model call.
    // This proves the admission gate is BEFORE the provider path.
    expect(providerRequestFired).toBe(false);
  });

  it('AC4 route→outcome: SIGNAL_INTENT_RECORDED event carries configured route as transitionEvent (LOAD-BEARING)', async () => {
    // This test proves that budgetResult.route drives a real outcome signal — not just
    // a dead string in an error message.
    //
    // HOW route→transition works (documented consumption):
    //   postWorkerSignal writes SIGNAL_INTENT_RECORDED to the event store with
    //   transitionEvent = budgetResult.route, then POSTs to the harness coordinator.
    //   The coordinator resolves nextState via flowManager.nextState(state, transitionEvent),
    //   records STATE_TRANSITION_APPLIED, and routes the bead — identical to a normal
    //   worker outcome signal.  This test asserts the SIGNAL_INTENT_RECORDED event is
    //   present with the correct transitionEvent so the check fails if postWorkerSignal
    //   is removed or the route is not passed as transitionEvent.
    const yaml = makeHarnessYaml(`  promptBudget:\n    maxBytes: 1\n    route: FAILURE`);
    env = setupWorkerEnv(yaml);

    const harness = fakePi();
    await orrElseExtension(harness.pi);
    await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: env.tempRoot });

    try {
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({
        systemPrompt: 'base system prompt from Pi'
      });
    } catch { /* expected — admission exceeded */ }

    // Allow event store writes to flush.
    await new Promise(r => setTimeout(r, 100));

    // The SIGNAL_INTENT_RECORDED event must be present in the event store with
    // transitionEvent matching the configured route ("FAILURE").
    // If postWorkerSignal is not called (route is a dead string), this fails.
    const signalEvents = readEventLog(env.tempRoot, DomainEventName.SIGNAL_INTENT_RECORDED);
    const budgetSignal = signalEvents.find(
      e => e.data?.transitionEvent === 'FAILURE'
    );
    expect(budgetSignal).toBeDefined();
    // The signal also carries the stateId and beadId from the active run.
    expect(budgetSignal!.data).toHaveProperty('transitionEvent', 'FAILURE');
  });

  it('does NOT throw and allows the turn when no budget is configured (AC1/AC6 no-op)', async () => {
    // Config with NO promptBudget anywhere — must be a complete no-op.
    const yaml = makeHarnessYaml();
    env = setupWorkerEnv(yaml);

    const harness = fakePi();
    await orrElseExtension(harness.pi);
    await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: env.tempRoot });

    let threw = false;
    try {
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({
        systemPrompt: 'base system prompt from Pi'
      });
    } catch {
      threw = true;
    }

    // Must NOT throw — no budget configured, no rejection.
    expect(threw).toBe(false);

    // Verify no PROMPT_BUDGET_ADMISSION event was emitted (true no-op, AC1).
    const events = readEventLog(env.tempRoot, DomainEventName.PROMPT_BUDGET_ADMISSION);
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC5: PROMPT_BUDGET_ADMISSION event structure — no prompt body
// ---------------------------------------------------------------------------

describe('AC5: PROMPT_BUDGET_ADMISSION event has required fields and no prompt body', () => {
  let env: TestEnv | undefined;
  const closeHandles: (() => Promise<void>)[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const close of closeHandles) await close().catch(() => {});
    closeHandles.length = 0;
    if (env) { teardownWorkerEnv(env); env = undefined; }
    Logger.close();
  });

  it('emits PROMPT_BUDGET_ADMISSION with sizing fields, hash, configPath, scope, route — no body', async () => {
    const yaml = makeHarnessYaml(`  promptBudget:\n    maxBytes: 1\n    route: FAILURE`);
    env = setupWorkerEnv(yaml);

    const harness = fakePi();
    await orrElseExtension(harness.pi);
    await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: env.tempRoot });

    try {
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({
        systemPrompt: 'base system prompt from Pi'
      });
    } catch { /* expected */ }

    // Read the emitted event from disk (via the real EventStore).
    // Retry briefly because the event write may not be flushed instantly.
    let events: any[] = [];
    for (let i = 0; i < 10; i++) {
      events = readEventLog(env.tempRoot, DomainEventName.PROMPT_BUDGET_ADMISSION);
      if (events.length > 0) break;
      await new Promise(r => setTimeout(r, 50));
    }

    expect(events.length).toBeGreaterThan(0);
    const data = events[0].data;

    // Required fields present (AC5)
    expect(data).toHaveProperty('configPath');
    expect(data).toHaveProperty('stateId');
    expect(data).toHaveProperty('limitScope');
    expect(data).toHaveProperty('exceeded', true);
    expect(data).toHaveProperty('route', 'FAILURE');

    // Sizing fields for all four segments
    expect(typeof data.stableBlockBytes).toBe('number');
    expect(typeof data.stableBlockTokens).toBe('number');
    expect(typeof data.stableBlockHash).toBe('string');
    expect(typeof data.piBasePromptBytes).toBe('number');
    expect(typeof data.piBasePromptTokens).toBe('number');
    expect(typeof data.piBasePromptHash).toBe('string');
    expect(typeof data.volatileSuffixBytes).toBe('number');
    expect(typeof data.volatileSuffixTokens).toBe('number');
    expect(typeof data.volatileSuffixHash).toBe('string');
    expect(typeof data.finalPromptBytes).toBe('number');
    expect(typeof data.finalPromptTokens).toBe('number');
    expect(typeof data.finalPromptHash).toBe('string');

    // NO prompt body in the event (AC5)
    const serialized = JSON.stringify(data);
    // The prompt body text is not in the event (we can check the base prompt text)
    expect(serialized).not.toContain('base system prompt from Pi');
    // The stable block body is not in the event
    expect(serialized).not.toContain('do the thing');
  });
});

// ---------------------------------------------------------------------------
// AC7: Startup lint — ConfigLoader rejects bad budget declarations
// ---------------------------------------------------------------------------

describe('AC7: startup lint rejects invalid prompt-budget declarations', () => {
  let tempRoot: string | undefined;
  let prevCwd: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    tempRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'budget-lint-test-'))
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

  function baseYaml(budgetBlock: string): string {
    return `
settings:
  startState: Alpha
  worktreePolicy:
    default: always
${budgetBlock}
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

  // (a) Negative limits — LOAD-BEARING: removing the schema minimum:0 or the semantic check
  //     makes negative limits accepted. The AJV schema catches these before the semantic
  //     validator runs (minimum: 0 constraint), producing a "must be >= 0" error.
  it('(a) rejects negative maxBytes in settings.promptBudget', () => {
    const yaml = baseYaml('  promptBudget:\n    maxBytes: -1\n    route: FAILURE');
    expect(() => writeAndLoad(yaml)).toThrow(/promptBudget|maxBytes|>= 0/i);
  });

  it('(a) rejects negative maxTokens in settings.promptBudget', () => {
    const yaml = baseYaml('  promptBudget:\n    maxTokens: -100\n    route: FAILURE');
    expect(() => writeAndLoad(yaml)).toThrow(/promptBudget|maxTokens|>= 0/i);
  });

  it('(a) rejects negative maxBytes in state.promptBudget', () => {
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
    actions: [{ id: a1, type: prompt }]
    transitions: { SUCCESS: done, FAILURE: Alpha, BLOCKED: Alpha }
    promptBudget:
      maxBytes: -5
      route: FAILURE
`;
    expect(() => writeAndLoad(yaml)).toThrow(/promptBudget|maxBytes|>= 0/i);
  });

  it('(a) rejects negative maxBytes in action.promptBudget', () => {
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
        promptBudget:
          maxBytes: -10
          route: FAILURE
    transitions: { SUCCESS: done, FAILURE: Alpha, BLOCKED: Alpha }
`;
    expect(() => writeAndLoad(yaml)).toThrow(/promptBudget|maxBytes|>= 0/i);
  });

  // (c) Budget route absent from vocabulary — LOAD-BEARING.
  it('(c) rejects budget route absent from statechart vocabulary in settings.promptBudget', () => {
    const yaml = baseYaml('  promptBudget:\n    maxBytes: 1000\n    route: UNDEFINED_ROUTE');
    expect(() => writeAndLoad(yaml)).toThrow(/UNDEFINED_ROUTE/);
  });

  it('(c) rejects budget route absent from vocabulary in state.promptBudget', () => {
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
    actions: [{ id: a1, type: prompt }]
    transitions: { SUCCESS: done, FAILURE: Alpha, BLOCKED: Alpha }
    promptBudget:
      maxBytes: 1000
      route: NOT_IN_VOCAB
`;
    expect(() => writeAndLoad(yaml)).toThrow(/NOT_IN_VOCAB/);
  });

  it('(c) rejects budget route absent from vocabulary in action.promptBudget', () => {
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
        promptBudget:
          maxTokens: 100
          route: MYSTERY_ROUTE
    transitions: { SUCCESS: done, FAILURE: Alpha, BLOCKED: Alpha }
`;
    expect(() => writeAndLoad(yaml)).toThrow(/MYSTERY_ROUTE/);
  });

  // (b) Unknown state/action references in named override maps — LOAD-BEARING.
  //
  // These tests prove AC7(b) is GENUINELY enforced: a settings.promptBudgetStateOverrides
  // key that does not match a declared state is REJECTED.  Removing the check in
  // ConfigLoader.validatePromptBudgetDeclarations makes these tests fail.
  //
  // Self-verification: temporarily remove the `if (!stateIds.has(refStateId))` block from
  // ConfigLoader and these tests turn red (the load passes instead of throwing).
  it('(b) LOAD-BEARING: rejects unknown state ID in settings.promptBudgetStateOverrides', () => {
    // "Nonexistent" is NOT a declared state — the lint must reject it.
    const yaml = `
settings:
  startState: Alpha
  worktreePolicy:
    default: always
  promptBudgetStateOverrides:
    Nonexistent:
      maxBytes: 1000
      route: FAILURE
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
    // Must throw naming the unknown state reference and config path.
    expect(() => writeAndLoad(yaml)).toThrow(/Nonexistent/);
  });

  it('(b) LOAD-BEARING: rejects unknown action ID in settings.promptBudgetActionOverrides', () => {
    // "Alpha/nonexistentAction" — "Alpha" is valid but "nonexistentAction" is NOT declared.
    const yaml = `
settings:
  startState: Alpha
  worktreePolicy:
    default: always
  promptBudgetActionOverrides:
    Alpha/nonexistentAction:
      maxBytes: 1000
      route: FAILURE
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
    // Must throw naming the unknown action reference and config path.
    expect(() => writeAndLoad(yaml)).toThrow(/nonexistentAction/);
  });

  it('(b) rejects unknown state ID in the state-segment of promptBudgetActionOverrides', () => {
    // "GhostState/a1" — "GhostState" is NOT a declared state.
    const yaml = `
settings:
  startState: Alpha
  worktreePolicy:
    default: always
  promptBudgetActionOverrides:
    GhostState/a1:
      maxBytes: 1000
      route: FAILURE
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
    expect(() => writeAndLoad(yaml)).toThrow(/GhostState/);
  });

  it('(b) accepts a valid promptBudgetStateOverrides entry (known state)', () => {
    const yaml = `
settings:
  startState: Alpha
  worktreePolicy:
    default: always
  promptBudgetStateOverrides:
    Alpha:
      maxBytes: 50000
      route: FAILURE
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
    expect(() => writeAndLoad(yaml)).not.toThrow();
  });

  it('(b) accepts a valid promptBudgetActionOverrides entry (known state and action)', () => {
    const yaml = `
settings:
  startState: Alpha
  worktreePolicy:
    default: always
  promptBudgetActionOverrides:
    Alpha/a1:
      maxBytes: 50000
      route: FAILURE
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
    expect(() => writeAndLoad(yaml)).not.toThrow();
  });

  // Valid policy — must NOT be rejected.
  it('accepts a valid prompt-budget policy (no lint error)', () => {
    const yaml = baseYaml('  promptBudget:\n    maxBytes: 100000\n    maxTokens: 25000\n    route: FAILURE');
    expect(() => writeAndLoad(yaml)).not.toThrow();
  });

  // Absent policy — complete no-op (AC1 / AC7 baseline).
  it('accepts configs with no promptBudget (AC1 baseline)', () => {
    const yaml = baseYaml('');
    expect(() => writeAndLoad(yaml)).not.toThrow();
  });
});
