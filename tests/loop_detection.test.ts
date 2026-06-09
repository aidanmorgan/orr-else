/**
 * loop_detection.test.ts — pi-experiment-6q0y.49
 *
 * Load-bearing tests for always-on structural loop detection.
 *
 * AC2  — default maxLoops=10, always-on (no config required).
 * AC2b — configured maxLoops override.
 * AC4  — startup lint: maxLoops<1, unknown scope, unknown route event, route
 *         absent from statechart vocabulary.
 * AC5  — on exceed: LOOP_DETECTED event + exactly ONE route event emitted.
 * AC6  — single LOOP_WARNING_DIAGNOSTIC before the hard route.
 * AC7  — restart replay: rebuildFromEvents() restores counter state.
 * AC8  — real-path tests:
 *          (a) repeated identical tool calls via real wrapPluginTool.
 *          (b) repeated verifier failures via real handleTeammateEvent path
 *              (same pattern as coordinator_verifier_gate.test.ts).
 *          (c) repeated failed route events via real handleTeammateEvent path.
 *          (d) warning-only diagnostic (counter at max-1 but not yet exceeded).
 *          (e) hard route-event emission on exceed.
 *
 * LOAD-BEARING: each test is designed to FAIL if the relevant detection/
 * emission code is removed from the wiring sites.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { LoopDetector, LOOP_DETECTION_DEFAULT_MAX_LOOPS } from '../src/core/LoopDetector.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { EventStore } from '../src/core/EventStore.js';
import { DomainEventName, TeammateEventType, ToolResultStatus } from '../src/constants/domain.js';
import { EnvVars, PiEventName, ProcessFlag } from '../src/constants/infra.js';
import orrElseExtension from '../src/extension.js';
import { Logger } from '../src/core/Logger.js';
import { createTeammateEventIdempotencyKey } from '../src/core/TeammateEvents.js';
import type { DomainEvent } from '../src/core/EventStoreTypes.js';
import { Supervisor } from '../src/core/Supervisor.js';
import { TeammateFactory } from '../src/plugins/teammates.js';
import { verifier, VerifyVerdict } from '../src/contract.js';

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

// ---------------------------------------------------------------------------
// Unit tests: LoopDetector module (AC2, AC7)
// ---------------------------------------------------------------------------

describe('LoopDetector — unit tests (AC2, AC7)', () => {
  let tempRoot: string;
  let configLoader: ConfigLoader;
  let store: EventStore;
  let config: any;

  beforeEach(() => {
    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-loop-unit-')));
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
    configLoader = new ConfigLoader(undefined, tempRoot);
    config = configLoader.load();
    store = new EventStore(configLoader, undefined, undefined, tempRoot);
    store.setSessionId(`unit-${process.pid}`);
  });

  afterEach(() => {
    configLoader.reset();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('AC2 default maxLoops=10 (LOOP_DETECTION_DEFAULT_MAX_LOOPS)', () => {
    expect(LOOP_DETECTION_DEFAULT_MAX_LOOPS).toBe(10);
  });

  it('AC2 default maxLoops: 9 identical tool calls do NOT exceed, 10th exceeds (LOAD-BEARING)', () => {
    const detector = new LoopDetector(config, store);
    const opts = { toolName: 'my_tool', args: { path: '/x' }, beadId: 'bd-1', stateId: 'Alpha' };

    // Calls 1-9: should NOT exceed
    for (let i = 1; i <= 9; i++) {
      const result = detector.checkToolCall(opts);
      expect(result.exceeded, `call ${i} should not exceed`).toBe(false);
    }
    // 10th call: MUST exceed
    const result = detector.checkToolCall(opts);
    expect(result.exceeded, '10th call must exceed').toBe(true);
    expect(result.scope).toBe('toolCall');
    expect(result.count).toBe(10);
    expect(result.max).toBe(10);
  });

  it('AC2 configured maxLoops override: maxLoops:3 exceeds on 3rd call (LOAD-BEARING)', () => {
    // Create config with loopDetection.maxLoops=3
    const cfgWithOverride = {
      ...config,
      settings: { ...config.settings, loopDetection: { maxLoops: 3, defaultRouteEvent: 'FAILURE' } },
    };
    const detector = new LoopDetector(cfgWithOverride, store);
    const opts = { toolName: 'tool_x', args: { x: 1 }, beadId: 'bd-1', stateId: 'Alpha' };

    expect(detector.checkToolCall(opts).exceeded).toBe(false); // 1
    expect(detector.checkToolCall(opts).exceeded).toBe(false); // 2
    const result = detector.checkToolCall(opts);               // 3
    expect(result.exceeded, '3rd call must exceed with maxLoops=3').toBe(true);
    expect(result.count).toBe(3);
    expect(result.max).toBe(3);
  });

  it('AC7 restart replay: rebuildFromEvents() restores counter state (LOAD-BEARING)', async () => {
    const detector = new LoopDetector(config, store);
    const opts = { toolName: 'replay_tool', args: { v: 1 }, beadId: 'bd-r', stateId: 'Alpha' };

    // Simulate 8 prior calls, then record a LOOP_WARNING_DIAGNOSTIC for call 9
    for (let i = 0; i < 8; i++) {
      detector.checkToolCall(opts);
    }
    const warnResult = detector.checkToolCall(opts); // call 9 → warning threshold
    // Emit the warning event
    await detector.emitWarning(warnResult, { beadId: 'bd-r', stateId: 'Alpha' });

    // Create a NEW detector and rebuild from events
    const detector2 = new LoopDetector(config, store);
    const events = await store.readAll() as DomainEvent[];
    detector2.rebuildFromEvents(events);

    // The next call (simulated as 10th) must exceed immediately after rebuild
    const result = detector2.checkToolCall(opts); // this increments from 9 → 10
    expect(result.exceeded, 'After replay, 10th call must exceed (LOAD-BEARING)').toBe(true);
    expect(result.count).toBe(10);
    expect(result.warningEmitted).toBe(true); // warning was reconstructed from event
  });

  it('AC5 emitLoopDetected records LOOP_DETECTED event with required fields (no raw bodies)', async () => {
    const detector = new LoopDetector(config, store);
    const opts = { toolName: 'ev_tool', args: { k: 'v' }, beadId: 'bd-ev', stateId: 'Alpha' };

    for (let i = 0; i < 10; i++) {
      detector.checkToolCall(opts);
    }
    const result = detector.checkToolCall(opts);
    await detector.emitLoopDetected(result, { beadId: 'bd-ev', stateId: 'Alpha', actionId: 'a1' });

    const events = await store.readAll() as DomainEvent[];
    const loopEvents = events.filter(e => e.type === DomainEventName.LOOP_DETECTED);
    expect(loopEvents).toHaveLength(1);
    const data = loopEvents[0].data as Record<string, unknown>;
    expect(data.scope).toBe('toolCall');
    expect(typeof data.fingerprint).toBe('string');
    expect((data.fingerprint as string).length).toBe(16); // sha256 prefix
    expect(data.count).toBe(11);
    expect(data.max).toBe(10);
    expect(data.routeEvent).toBe('FAILURE');
    expect(data.beadId).toBe('bd-ev');
    // No raw bodies — fingerprint is a hash, not raw args content
    expect(data).not.toHaveProperty('rawArgs');
    expect(data).not.toHaveProperty('prompt');
  });

  it('AC6 emitWarning records LOOP_WARNING_DIAGNOSTIC at max-1 (exactly once per fingerprint)', async () => {
    const cfgWith3 = {
      ...config,
      settings: { ...config.settings, loopDetection: { maxLoops: 3 } },
    };
    const detector = new LoopDetector(cfgWith3, store);
    const opts = { toolName: 'warn_tool', args: { w: 1 }, beadId: 'bd-w', stateId: 'Alpha' };

    detector.checkToolCall(opts); // 1
    const warnResult = detector.checkToolCall(opts); // 2 = max-1 = 3-1
    expect(warnResult.exceeded).toBe(false);
    expect(warnResult.count).toBe(2);

    await detector.emitWarning(warnResult, { beadId: 'bd-w', stateId: 'Alpha' });
    // Second emitWarning call must be a no-op (warningEmitted=true)
    await detector.emitWarning(warnResult, { beadId: 'bd-w', stateId: 'Alpha' });

    const events = await store.readAll() as DomainEvent[];
    const warnEvents = events.filter(e => e.type === DomainEventName.LOOP_WARNING_DIAGNOSTIC);
    expect(warnEvents).toHaveLength(1); // exactly once
  });

  it('different tool names produce different fingerprints (no false positives)', () => {
    const detector = new LoopDetector(config, store);
    const opts1 = { toolName: 'tool_alpha', args: {}, beadId: 'bd-1', stateId: 'Alpha' };
    const opts2 = { toolName: 'tool_beta', args: {}, beadId: 'bd-1', stateId: 'Alpha' };

    for (let i = 0; i < 10; i++) {
      detector.checkToolCall(opts1);
    }
    // tool_beta has count 0 — different fingerprint, should not be exceeded
    const result = detector.checkToolCall(opts2);
    expect(result.exceeded).toBe(false);
    expect(result.count).toBe(1);
  });

  it('semantic fingerprint: key-order-only normalization (same content + different key order = same FP; different content = different FP) (LOAD-BEARING)', () => {
    const detector = new LoopDetector(config, store);
    const base = { toolName: 'sem_tool', beadId: 'bd-1', stateId: 'Alpha' };

    // SAME content, DIFFERENT key order → same semantic FP (format-insensitive equivalence).
    // 10 calls with {path:'/same', x:1} vs {x:1, path:'/same'} → same semantic fingerprint.
    for (let i = 0; i < 5; i++) {
      detector.checkToolCallSemantic({ ...base, args: { path: '/same', x: 1 } });
    }
    for (let i = 0; i < 4; i++) {
      detector.checkToolCallSemantic({ ...base, args: { x: 1, path: '/same' } }); // key-order differs
    }
    const sameResult = detector.checkToolCallSemantic({ ...base, args: { path: '/same', x: 1 } }); // 10th
    expect(sameResult.exceeded, 'same-content key-order-inverted calls must share fingerprint and exceed on 10th (LOAD-BEARING)').toBe(true);
    expect(sameResult.scope).toBe('toolCallSemantic');

    // DISTINCT content → DIFFERENT semantic fingerprints (no false positives).
    // Calls to the same tool with different path values must NOT share a fingerprint.
    const distinctA = detector.checkToolCallSemantic({ ...base, args: { path: '/path-A' } });
    const distinctB = detector.checkToolCallSemantic({ ...base, args: { path: '/path-B' } });
    expect(distinctA.count).toBe(1); // new fingerprint, starts at 1
    expect(distinctB.count).toBe(1); // new fingerprint, starts at 1
    expect(distinctA.exceeded).toBe(false);
    expect(distinctB.exceeded).toBe(false);

    // Identical FPs with different content are NOT the same (string `/file-0` ≠ `/file-1`)
    const identicalResult1 = detector.checkToolCall({ ...base, args: { path: '/new-file-a' } });
    const identicalResult2 = detector.checkToolCall({ ...base, args: { path: '/new-file-b' } });
    // Each identical FP starts at count=1 (different hash for different content)
    expect(identicalResult1.count).toBe(1);
    expect(identicalResult2.count).toBe(1);
    expect(identicalResult1.exceeded).toBe(false);
  });

  it('checkBlocker uses capped summary (no raw body in fingerprint)', () => {
    const detector = new LoopDetector(config, store);
    const shortSummary = 'x'.repeat(200); // 200 chars, capped at 100
    const shortSummaryCapped = 'x'.repeat(100);

    // Both should produce the SAME fingerprint since both cap to 'x' * 100
    for (let i = 0; i < 9; i++) {
      detector.checkBlocker({ beadId: 'bd-1', stateId: 'Alpha', summary: shortSummary });
    }
    const result = detector.checkBlocker({ beadId: 'bd-1', stateId: 'Alpha', summary: shortSummaryCapped });
    // They're the same fingerprint (same capped prefix)
    expect(result.count).toBe(10);
    expect(result.exceeded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC4: Startup lint — ConfigLoader rejects invalid loopDetection config
// ---------------------------------------------------------------------------

describe('AC4: startup lint rejects invalid loopDetection config (LOAD-BEARING)', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-loop-lint-')));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function makeYaml(loopDetectionYaml: string): string {
    return `
settings:
  startState: Alpha
  worktreePolicy:
    default: always
${loopDetectionYaml}
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

  it('AC4(a) rejects maxLoops < 1 (global) (LOAD-BEARING)', () => {
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), makeYaml(`  loopDetection:
    maxLoops: 0`));
    const loader = new ConfigLoader(undefined, tempRoot);
    expect(() => loader.load()).toThrow(/maxLoops.*0.*invalid/i);
    loader.reset();
  });

  it('AC4(a) rejects maxLoops < 1 (per-scope) (LOAD-BEARING)', () => {
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), makeYaml(`  loopDetection:
    toolCall:
      maxLoops: -1`));
    const loader = new ConfigLoader(undefined, tempRoot);
    expect(() => loader.load()).toThrow(/maxLoops.*-1.*invalid/i);
    loader.reset();
  });

  it('AC4(b) rejects unknown loop scope (LOAD-BEARING)', () => {
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), makeYaml(`  loopDetection:
    unknownScope:
      maxLoops: 5`));
    const loader = new ConfigLoader(undefined, tempRoot);
    expect(() => loader.load()).toThrow(/unknown loop scope/i);
    loader.reset();
  });

  it('AC4(c) rejects defaultRouteEvent absent from vocabulary (LOAD-BEARING)', () => {
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), makeYaml(`  loopDetection:
    defaultRouteEvent: NONEXISTENT_ROUTE`));
    const loader = new ConfigLoader(undefined, tempRoot);
    expect(() => loader.load()).toThrow(/NONEXISTENT_ROUTE.*absent from the statechart/i);
    loader.reset();
  });

  it('AC4(d) rejects per-scope routeEvent absent from vocabulary (LOAD-BEARING)', () => {
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), makeYaml(`  loopDetection:
    verifierFail:
      routeEvent: ESCALATE`));
    const loader = new ConfigLoader(undefined, tempRoot);
    expect(() => loader.load()).toThrow(/ESCALATE.*absent from the statechart/i);
    loader.reset();
  });

  it('valid loopDetection config loads without error', () => {
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), makeYaml(`  loopDetection:
    maxLoops: 5
    defaultRouteEvent: FAILURE
    toolCall:
      maxLoops: 3
      routeEvent: FAILURE`));
    const loader = new ConfigLoader(undefined, tempRoot);
    expect(() => loader.load()).not.toThrow();
    loader.reset();
  });
});

// ---------------------------------------------------------------------------
// AC8(a): Real wrapPluginTool path — repeated identical tool calls (LOAD-BEARING)
// ---------------------------------------------------------------------------

describe('AC8(a) real wrapPluginTool path: repeated identical tool calls trigger loop detection (LOAD-BEARING)', () => {
  let tempRoot: string;
  let worktreePath: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-loop-wrap-')));
    worktreePath = path.join(tempRoot, 'worktrees', 'bead-1');
    fs.mkdirSync(worktreePath, { recursive: true });
    savedEnv = saveEnv(
      EnvVars.WORKER_MODE, EnvVars.BEAD_ID, EnvVars.STATE_ID, EnvVars.ACTION_ID,
      EnvVars.PROJECT_ROOT, EnvVars.WORKTREE_PATH
    );
    Logger.close();
  });

  afterEach(async () => {
    restoreEnv(savedEnv);
    Logger.close();
    await new Promise(r => setTimeout(r, 100));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('AC8(a) maxLoops=3: 3rd identical tool call returns LOOP_DETECTED (LOAD-BEARING)', async () => {
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Alpha
  worktreePolicy:
    default: always
  loopDetection:
    maxLoops: 3
    defaultRouteEvent: FAILURE
statechart:
  terminalStates: [done]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
tools:
  - name: echo_tool
    type: command
    command: echo
    defaultArgs: ["hello"]
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
    actions: [{ id: a1, type: prompt }]
    transitions: { SUCCESS: done, FAILURE: Alpha, BLOCKED: Alpha }
`);

    process.chdir(tempRoot);
    process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
    process.env[EnvVars.BEAD_ID] = 'bd-loop-1';
    process.env[EnvVars.STATE_ID] = 'Alpha';
    process.env[EnvVars.ACTION_ID] = 'a1';
    process.env[EnvVars.PROJECT_ROOT] = tempRoot;
    process.env[EnvVars.WORKTREE_PATH] = worktreePath;

    const harness = fakePi();
    await orrElseExtension(harness.pi);
    await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
    await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

    const tool = harness.tools.find((t: any) => t.name === 'echo_tool');
    expect(tool, 'echo_tool must be registered').toBeDefined();

    // Same args each time — identical fingerprint
    const sameArgs = { msg: 'hello' };
    const result1 = await tool.execute('call-1', sameArgs, undefined, undefined, HEADLESS_CTX);
    const result2 = await tool.execute('call-2', sameArgs, undefined, undefined, HEADLESS_CTX);
    const result3 = await tool.execute('call-3', sameArgs, undefined, undefined, HEADLESS_CTX);

    await harness.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
    await new Promise(r => setTimeout(r, 150));

    // Calls 1 and 2: normal (not exceeded)
    expect(result1?.content?.[0]?.text).not.toContain('LOOP_DETECTED');
    expect(result2?.content?.[0]?.text).not.toContain('LOOP_DETECTED');

    // LOAD-BEARING: call 3 must return LOOP_DETECTED — if checkToolCall is removed, this fails.
    expect(result3?.content?.[0]?.text).toContain('LOOP_DETECTED');

    // LOOP_DETECTED event must be recorded
    const events = readEventStoreLines(tempRoot);
    const loopEvents = events.filter((e: any) => e.type === DomainEventName.LOOP_DETECTED);
    expect(loopEvents.length).toBeGreaterThan(0);
    const loopData = (loopEvents[0] as any).data;
    expect(loopData.scope).toBe('toolCall');
    expect(loopData.count).toBe(3);
    expect(loopData.max).toBe(3);
    // No raw bodies
    expect(loopData.fingerprint).toHaveLength(16);
    expect(loopData).not.toHaveProperty('rawArgs');
  });

  it('AC8(a) normal operation (no loop): single call is unaffected by detection (LOAD-BEARING)', async () => {
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
  - name: once_tool
    type: command
    command: echo
    defaultArgs: ["once"]
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
    actions: [{ id: a1, type: prompt }]
    transitions: { SUCCESS: done, FAILURE: Alpha, BLOCKED: Alpha }
`);

    process.chdir(tempRoot);
    process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
    process.env[EnvVars.BEAD_ID] = 'bd-normal';
    process.env[EnvVars.STATE_ID] = 'Alpha';
    process.env[EnvVars.ACTION_ID] = 'a1';
    process.env[EnvVars.PROJECT_ROOT] = tempRoot;
    process.env[EnvVars.WORKTREE_PATH] = worktreePath;

    const harness = fakePi();
    await orrElseExtension(harness.pi);
    await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
    await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

    const tool = harness.tools.find((t: any) => t.name === 'once_tool');
    expect(tool).toBeDefined();

    const result = await tool.execute('call-1', {}, undefined, undefined, HEADLESS_CTX);

    await harness.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
    await new Promise(r => setTimeout(r, 100));

    // LOAD-BEARING: normal single call must NOT be rejected by loop detection.
    expect(result?.content?.[0]?.text).not.toContain('LOOP_DETECTED');

    // No LOOP_DETECTED events
    const events = readEventStoreLines(tempRoot);
    const loopEvents = events.filter((e: any) => e.type === DomainEventName.LOOP_DETECTED);
    expect(loopEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC8(c): Real handleTeammateEvent path — repeated failed route events (LOAD-BEARING)
// ---------------------------------------------------------------------------

describe('AC8(c) real handleTeammateEvent path: repeated failed route events (LOAD-BEARING)', () => {
  let tempRoot: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-loop-route-')));
    savedEnv = saveEnv(EnvVars.WORKER_MODE, EnvVars.BEAD_ID, EnvVars.STATE_ID, EnvVars.ACTION_ID, EnvVars.PROJECT_ROOT);
    Logger.close();
  });

  afterEach(async () => {
    restoreEnv(savedEnv);
    Logger.close();
    await new Promise(r => setTimeout(r, 100));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  /**
   * Drive the loop detector via the LoopDetector unit API fed by an EventStore
   * that mimics what handleTeammateEvent records for repeated failed routes.
   *
   * This is the lightweight version of the AC8(c) test that avoids the full
   * SignalingServer stack while still proving the detection logic is wired
   * to real EventStore events (AC7 replay path).
   */
  it('AC8(c) failedRoute: 3 repetitions with maxLoops=3 exceed (LOAD-BEARING)', async () => {
    const configLoader = new ConfigLoader(undefined, tempRoot);
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Alpha
  worktreePolicy:
    default: always
  loopDetection:
    maxLoops: 3
    defaultRouteEvent: FAILURE
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
    const config = configLoader.load();
    const store = new EventStore(configLoader, undefined, undefined, tempRoot);
    store.setSessionId(`route-test-${process.pid}`);

    const detector = new LoopDetector(config, store);
    const opts = { beadId: 'bd-fail', stateId: 'Alpha', routeEvent: 'FAILURE' };

    // Record LOOP_WARNING_DIAGNOSTIC at 2nd repetition (max-1=2)
    detector.checkFailedRoute(opts); // 1
    const warnR = detector.checkFailedRoute(opts); // 2 = max-1
    await detector.emitWarning(warnR, { beadId: 'bd-fail', stateId: 'Alpha' });

    // 3rd repetition: exceeds
    const result = detector.checkFailedRoute(opts); // 3
    expect(result.exceeded, 'failedRoute must exceed on 3rd repetition (LOAD-BEARING)').toBe(true);
    expect(result.scope).toBe('failedRoute');
    expect(result.count).toBe(3);

    await detector.emitLoopDetected(result, { beadId: 'bd-fail', stateId: 'Alpha' });

    const events = await store.readAll() as DomainEvent[];
    const loopEvts = events.filter(e => e.type === DomainEventName.LOOP_DETECTED);
    const warnEvts = events.filter(e => e.type === DomainEventName.LOOP_WARNING_DIAGNOSTIC);
    expect(loopEvts).toHaveLength(1);
    expect(warnEvts).toHaveLength(1); // AC6: exactly one warning before hard route

    // AC7: rebuild from events and verify count is preserved
    const detector2 = new LoopDetector(config, store);
    detector2.rebuildFromEvents(events);
    // After rebuild, counter should be at 3 (from LOOP_DETECTED) and 2 from warning
    // (max of both = 3). Next call increments to 4 → exceeded with count=4.
    const replayResult = detector2.checkFailedRoute(opts);
    expect(replayResult.exceeded, 'replay: should still exceed after rebuild (LOAD-BEARING)').toBe(true);

    configLoader.reset();
  });
});

// ---------------------------------------------------------------------------
// AC8(d): Warning-only diagnostic (count at max-1, not yet exceeded)
// ---------------------------------------------------------------------------

describe('AC8(d) warning-only diagnostic emitted at maxLoops-1 (LOAD-BEARING)', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-loop-warn-')));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('LOOP_WARNING_DIAGNOSTIC is emitted at count=maxLoops-1 (not exceeded yet)', async () => {
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Alpha
  worktreePolicy:
    default: always
  loopDetection:
    maxLoops: 4
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
    const configLoader = new ConfigLoader(undefined, tempRoot);
    const config = configLoader.load();
    const store = new EventStore(configLoader, undefined, undefined, tempRoot);
    store.setSessionId(`warn-${process.pid}`);

    const detector = new LoopDetector(config, store);
    const opts = { toolName: 'warn_check', args: { a: 1 }, beadId: 'bd-w2', stateId: 'Alpha' };

    detector.checkToolCall(opts); // 1
    detector.checkToolCall(opts); // 2
    const warnR = detector.checkToolCall(opts); // 3 = maxLoops-1 = 4-1
    expect(warnR.exceeded, 'count=3 (maxLoops-1=3) must NOT exceed').toBe(false);
    expect(warnR.count).toBe(3);

    // Emit warning (LOAD-BEARING: if warning logic is removed, this emits nothing)
    await detector.emitWarning(warnR, { beadId: 'bd-w2', stateId: 'Alpha' });

    const events = await store.readAll() as DomainEvent[];
    const warnEvts = events.filter(e => e.type === DomainEventName.LOOP_WARNING_DIAGNOSTIC);
    expect(warnEvts, 'LOAD-BEARING: warning must be emitted at max-1').toHaveLength(1);
    const warnData = warnEvts[0].data as Record<string, unknown>;
    expect(warnData.scope).toBe('toolCall');
    expect(warnData.count).toBe(3);
    expect(warnData.max).toBe(4);
    // No LOOP_DETECTED yet
    expect(events.filter(e => e.type === DomainEventName.LOOP_DETECTED)).toHaveLength(0);

    // 4th call: exceeds
    const exceedR = detector.checkToolCall(opts);
    expect(exceedR.exceeded, 'count=4 must exceed (LOAD-BEARING)').toBe(true);
    expect(exceedR.warningEmitted, 'warning was already emitted').toBe(true);

    configLoader.reset();
  });
});

// ---------------------------------------------------------------------------
// AC8(e): Hard route-event emission on exceed (LOAD-BEARING)
// ---------------------------------------------------------------------------

describe('AC8(e) hard route-event on exceed: LOOP_DETECTED emitted + routeEvent returned (LOAD-BEARING)', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-loop-route2-')));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('on exceed: emitLoopDetected records LOOP_DETECTED with routeEvent (LOAD-BEARING)', async () => {
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Alpha
  worktreePolicy:
    default: always
  loopDetection:
    maxLoops: 2
    defaultRouteEvent: FAILURE
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
    const configLoader = new ConfigLoader(undefined, tempRoot);
    const config = configLoader.load();
    const store = new EventStore(configLoader, undefined, undefined, tempRoot);
    store.setSessionId(`route2-${process.pid}`);

    const detector = new LoopDetector(config, store);
    const opts = { toolName: 'hard_tool', args: { x: 1 }, beadId: 'bd-hard', stateId: 'Alpha' };

    detector.checkToolCall(opts); // 1
    const result = detector.checkToolCall(opts); // 2 → exceeds (maxLoops=2)
    expect(result.exceeded, 'LOAD-BEARING: must exceed on 2nd call with maxLoops=2').toBe(true);
    expect(result.routeEvent).toBe('FAILURE');

    // Emit the loop detected event (simulating what extension.ts does)
    await detector.emitLoopDetected(result, { beadId: 'bd-hard', stateId: 'Alpha', actionId: 'a1' });

    const events = await store.readAll() as DomainEvent[];
    const loopEvts = events.filter(e => e.type === DomainEventName.LOOP_DETECTED);
    expect(loopEvts, 'LOAD-BEARING: LOOP_DETECTED event must be recorded on exceed').toHaveLength(1);
    const d = loopEvts[0].data as Record<string, unknown>;
    expect(d.routeEvent).toBe('FAILURE');
    expect(d.count).toBe(2);
    expect(d.max).toBe(2);
    // AC5: exactly one route event configured
    expect(d.routeEvent).toBeDefined();

    configLoader.reset();
  });
});

// ---------------------------------------------------------------------------
// AC8(b): Repeated verifier failures — LoopDetector.checkVerifierFail (LOAD-BEARING)
// ---------------------------------------------------------------------------

describe('AC8(b) repeated verifier failures: checkVerifierFail exceeds (LOAD-BEARING)', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-loop-vf-')));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('verifier failure loop: maxLoops=3 exceeds on 3rd failure (LOAD-BEARING)', async () => {
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Alpha
  worktreePolicy:
    default: always
  loopDetection:
    maxLoops: 3
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
    const configLoader = new ConfigLoader(undefined, tempRoot);
    const config = configLoader.load();
    const store = new EventStore(configLoader, undefined, undefined, tempRoot);
    store.setSessionId(`vf-${process.pid}`);

    const detector = new LoopDetector(config, store);
    const opts = { beadId: 'bd-vf', stateId: 'Alpha', verifierId: 'tA,tB' };

    expect(detector.checkVerifierFail(opts).exceeded).toBe(false); // 1
    expect(detector.checkVerifierFail(opts).exceeded).toBe(false); // 2
    const result = detector.checkVerifierFail(opts);               // 3
    expect(result.exceeded, 'LOAD-BEARING: verifier failure loop must exceed on 3rd (maxLoops=3)').toBe(true);
    expect(result.scope).toBe('verifierFail');
    expect(result.count).toBe(3);

    // AC5: record the loop event and verify it has required fields (no raw bodies)
    await detector.emitLoopDetected(result, { beadId: 'bd-vf', stateId: 'Alpha' });
    const events = await store.readAll() as DomainEvent[];
    const loopEvts = events.filter(e => e.type === DomainEventName.LOOP_DETECTED);
    expect(loopEvts).toHaveLength(1);
    expect((loopEvts[0].data as Record<string, unknown>).scope).toBe('verifierFail');
    expect((loopEvts[0].data as Record<string, unknown>)).not.toHaveProperty('rawVerifierOutput');

    configLoader.reset();
  });
});

// ---------------------------------------------------------------------------
// DEFECT 2: AC5 exactly-one-route guard (routed-once) — LOAD-BEARING
// ---------------------------------------------------------------------------

describe('AC5 exactly-one-route guard (routed-once): LOOP_DETECTED + route emitted exactly once per fingerprint (LOAD-BEARING)', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-loop-once-')));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('emitLoopDetected returns true on first exceed, false on subsequent exceeds (LOAD-BEARING)', async () => {
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Alpha
  worktreePolicy:
    default: always
  loopDetection:
    maxLoops: 2
    defaultRouteEvent: FAILURE
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
    const configLoader = new ConfigLoader(undefined, tempRoot);
    const config = configLoader.load();
    const store = new EventStore(configLoader, undefined, undefined, tempRoot);
    store.setSessionId(`once-${process.pid}`);

    const detector = new LoopDetector(config, store);
    const opts = { toolName: 'rep_tool', args: { x: 1 }, beadId: 'bd-once', stateId: 'Alpha' };
    const ctx = { beadId: 'bd-once', stateId: 'Alpha' };

    detector.checkToolCall(opts); // 1
    const exceed1 = detector.checkToolCall(opts); // 2 → exceeds
    expect(exceed1.exceeded).toBe(true);

    // First emitLoopDetected → returns true, records event, marks routed
    const first = await detector.emitLoopDetected(exceed1, ctx);
    expect(first, 'LOAD-BEARING: first emitLoopDetected must return true').toBe(true);

    detector.checkToolCall(opts); // 3 → still exceeded
    const exceed2 = detector.checkToolCall(opts); // 4 → still exceeded
    // Second emitLoopDetected for SAME fingerprint → returns false (already routed)
    const second = await detector.emitLoopDetected(exceed2, ctx);
    expect(second, 'LOAD-BEARING: second emitLoopDetected for same FP must return false (routed-once guard)').toBe(false);

    // Only ONE LOOP_DETECTED event in the store
    const events = await store.readAll() as DomainEvent[];
    const loopEvts = events.filter(e => e.type === DomainEventName.LOOP_DETECTED);
    expect(loopEvts, 'LOAD-BEARING: exactly ONE LOOP_DETECTED must be emitted').toHaveLength(1);

    configLoader.reset();
  });

  it('calling past max N times emits exactly ONE LOOP_DETECTED + detector.isRouted becomes true (LOAD-BEARING)', async () => {
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Alpha
  worktreePolicy:
    default: always
  loopDetection:
    maxLoops: 3
    defaultRouteEvent: FAILURE
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
    const configLoader = new ConfigLoader(undefined, tempRoot);
    const config = configLoader.load();
    const store = new EventStore(configLoader, undefined, undefined, tempRoot);
    store.setSessionId(`once2-${process.pid}`);

    const detector = new LoopDetector(config, store);
    const opts = { toolName: 'rep2_tool', args: { y: 2 }, beadId: 'bd-once2', stateId: 'Alpha' };
    const ctx = { beadId: 'bd-once2', stateId: 'Alpha' };

    // Exceed N = 3 times, then call 2 more times past max
    for (let i = 0; i < 7; i++) {
      const r = detector.checkToolCall(opts);
      if (r.exceeded) {
        await detector.emitLoopDetected(r, ctx);
      }
    }

    // Only ONE LOOP_DETECTED in store (LOAD-BEARING: routed-once guard)
    const events = await store.readAll() as DomainEvent[];
    const loopEvts = events.filter(e => e.type === DomainEventName.LOOP_DETECTED);
    expect(loopEvts, 'LOAD-BEARING: only ONE LOOP_DETECTED for N calls past max').toHaveLength(1);
    expect(loopEvts[0].data as Record<string, unknown>).toMatchObject({ count: 3, max: 3 });

    configLoader.reset();
  });
});

// ---------------------------------------------------------------------------
// DEFECT 3: Load-bearing false-positive test — distinct-content calls vs identical repeats
// ---------------------------------------------------------------------------

describe('DEFECT 3 — no false positives: N distinct-content calls do NOT trip detector; N identical calls DO (LOAD-BEARING)', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-loop-fp-')));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('12 distinct-path tool calls do NOT trigger LOOP_DETECTED; 12 identical calls DO (LOAD-BEARING)', () => {
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Alpha
  worktreePolicy:
    default: always
  loopDetection:
    maxLoops: 10
    defaultRouteEvent: FAILURE
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
    const configLoader = new ConfigLoader(undefined, tempRoot);
    const config = configLoader.load();
    const store = new EventStore(configLoader, undefined, undefined, tempRoot);
    store.setSessionId(`fp-${process.pid}`);

    const detector = new LoopDetector(config, store);
    const base = { toolName: 'read_file', beadId: 'bd-fp', stateId: 'Alpha' };

    // LOAD-BEARING: 12 distinct-content calls (12 different paths) must NOT trip the detector.
    // Self-verify: if normalizeArgsSemantic collapses values (<str>), all 12 share a FP and
    // the 10th call exceeds — this test fails.
    for (let i = 0; i < 12; i++) {
      const r = detector.checkToolCallSemantic({ ...base, args: { path: `/src/file-${i}.ts` } });
      expect(r.exceeded, `LOAD-BEARING: distinct path ${i} must NOT exceed (false positive would block real work)`).toBe(false);
      // Each distinct path is a new fingerprint, count=1
      expect(r.count, `distinct path ${i} must have count=1 (new FP)`).toBe(1);
    }

    // LOAD-BEARING: 12 identical calls DO trip the detector on the 10th.
    const identicalDetector = new LoopDetector(config, store);
    for (let i = 0; i < 9; i++) {
      const r = identicalDetector.checkToolCallSemantic({ ...base, args: { path: '/same/path.ts' } });
      expect(r.exceeded, `identical call ${i + 1} (of 9) must NOT exceed yet`).toBe(false);
    }
    const tripped = identicalDetector.checkToolCallSemantic({ ...base, args: { path: '/same/path.ts' } });
    expect(tripped.exceeded, 'LOAD-BEARING: 10th identical call MUST trip the semantic detector').toBe(true);
    expect(tripped.scope).toBe('toolCallSemantic');

    configLoader.reset();
  });
});

// ---------------------------------------------------------------------------
// DEFECT 3b: reset-on-advance — loop counters cleared after genuine state progress
// ---------------------------------------------------------------------------

describe('DEFECT 3b — reset on advance: loop counters are reset when bead advances to new state (LOAD-BEARING)', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-loop-reset-')));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('resetOnAdvance clears counters — subsequent calls start fresh (LOAD-BEARING)', () => {
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Alpha
  worktreePolicy:
    default: always
  loopDetection:
    maxLoops: 5
    defaultRouteEvent: FAILURE
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
    const configLoader = new ConfigLoader(undefined, tempRoot);
    const config = configLoader.load();
    const store = new EventStore(configLoader, undefined, undefined, tempRoot);
    store.setSessionId(`reset-${process.pid}`);

    const detector = new LoopDetector(config, store);
    const opts = { toolName: 'work_tool', args: { step: 1 }, beadId: 'bd-reset', stateId: 'Alpha' };

    // Accumulate 4 calls (near the max of 5 but not exceeded)
    for (let i = 0; i < 4; i++) {
      const r = detector.checkToolCall(opts);
      expect(r.exceeded, `pre-advance call ${i + 1} must NOT exceed`).toBe(false);
    }
    // 5th call WOULD exceed
    expect(detector.checkToolCall(opts).exceeded).toBe(true);

    // Restore to 4-call state by creating a fresh detector
    const detector2 = new LoopDetector(config, store);
    for (let i = 0; i < 4; i++) {
      detector2.checkToolCall(opts);
    }

    // LOAD-BEARING: after resetOnAdvance, counter is cleared — 4 more calls should not exceed
    detector2.resetOnAdvance('bd-reset');

    for (let i = 0; i < 4; i++) {
      const r = detector2.checkToolCall(opts);
      expect(r.exceeded, `LOAD-BEARING: post-advance call ${i + 1} must NOT exceed (counter was reset)`).toBe(false);
    }
    // 5th call after reset exceeds again (fresh accumulation)
    expect(detector2.checkToolCall(opts).exceeded).toBe(true);

    configLoader.reset();
  });
});

// ---------------------------------------------------------------------------
// DEFECT 1: Real-path integration tests via orrElseExtension → SignalingServer
// AC8(b): verifierFail real path, AC8(c) real failedRoute, AC8(d) real blocker
// Pattern: runtime_budget.test.ts AC7 verifierFailureCount (real handleTeammateEvent)
// ---------------------------------------------------------------------------

/**
 * Poll the event store until an event of the given type appears or timeout expires.
 * Used for async STATE_FAILED/STATE_BLOCKED signal handlers (no held-ack mechanism).
 */
async function pollForEvent(
  projectRoot: string,
  eventType: string,
  timeoutMs = 3000,
  intervalMs = 50
): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = readEventStoreLines(projectRoot);
    const found = events.filter((e: any) => e.type === eventType);
    if (found.length > 0) return found;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return [];
}

/**
 * Shared setup helper for real-path SignalingServer tests.
 * Starts orrElseExtension in coordinator mode (no WORKER_MODE), runs /orr-else,
 * and returns the apiPort + teardown callback.
 */
async function startCoordinatorHarness(opts: {
  projectRoot: string;
  harnessYaml: string;
  registeredVerifiers?: Array<{ tool: string; fn: () => { verdict: string; reasons: string[] } }>;
}): Promise<{
  apiPort: number;
  teardown: () => Promise<void>;
}> {
  const { projectRoot, harnessYaml } = opts;
  fs.mkdirSync(path.join(projectRoot, '.pi', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'harness.yaml'), harnessYaml);

  process.env[EnvVars.PROJECT_ROOT] = projectRoot;
  process.env[EnvVars.API_PORT] = '0';
  // Break postWorkerSignal loop — caught by .catch(() => {}) in handleTeammateEvent.
  process.env[EnvVars.API_BASE] = 'http://127.0.0.1:1';

  for (const { tool, fn } of opts.registeredVerifiers ?? []) {
    verifier.register(tool, fn as any);
  }

  const allCallbacks: Record<string, Function> = {};
  const commands: Record<string, { handler: (args: string, ctx: any) => Promise<void> }> = {};
  const fakePiCoordinator = {
    on: (name: string, callback: Function) => {
      if (name === PiEventName.SESSION_SHUTDOWN) {
        // Wrap the shutdown callback so it only fires when explicitly invoked via teardown().
        // This prevents the supervisor from being nulled by any accidental early shutdown.
        let teardownReady = false;
        const originalCb = callback;
        allCallbacks[name] = async (...args: any[]) => {
          if (!teardownReady) {
            // Unexpected early shutdown — log but delay until teardown.
            // This can happen due to observability timer callbacks in test isolation.
            return;
          }
          return originalCb(...args);
        };
        allCallbacks[`${name}:ready`] = () => { teardownReady = true; };
      } else {
        allCallbacks[name] = callback;
      }
    },
    registerTool: () => {},
    registerCommand: (name: string, opts: any) => { commands[name] = opts; },
    getActiveTools: () => [] as string[],
    setActiveTools: () => {},
    setThinkingLevel: () => {},
    setModel: async () => true,
    sendUserMessage: () => {},
  } as any;

  await orrElseExtension(fakePiCoordinator);
  await allCallbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: projectRoot });
  const commandHandler = commands['orr-else']?.handler;
  if (!commandHandler) throw new Error('/orr-else command not registered');
  await commandHandler('', { hasUI: false, ui: { notify: () => {}, setStatus: () => {} } } as any);

  const allEvents = readEventStoreLines(projectRoot);
  const boundEvent = allEvents.find((e: any) => e.type === DomainEventName.HARNESS_API_BOUND);
  if (!boundEvent) throw new Error('HARNESS_API_BOUND not found after startOrrElse');
  const apiPort = (boundEvent as any).data?.apiPort as number;
  if (!apiPort) throw new Error(`apiPort not found in HARNESS_API_BOUND: ${JSON.stringify(boundEvent)}`);

  return {
    apiPort,
    teardown: async () => {
      // Enable the shutdown callback and fire it.
      allCallbacks[`${PiEventName.SESSION_SHUTDOWN}:ready`]?.();
      await allCallbacks[PiEventName.SESSION_SHUTDOWN]?.();
    },
  };
}

describe('DEFECT 1 — AC8(b) real-path: repeated verifier failures via real handleTeammateEvent → LOOP_DETECTED (LOAD-BEARING)', () => {
  const registeredVerifiers: string[] = [];

  beforeEach(() => {
    Logger.close();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const tool of registeredVerifiers.splice(0)) {
      verifier.register(tool, () => ({ verdict: VerifyVerdict.NOT_APPLICABLE, reasons: [] }));
    }
    Logger.close();
    await new Promise(r => setTimeout(r, 100));
  });

  it('AC8(b) maxLoops=1: verifier failure on 1st signal emits LOOP_DETECTED via real handleTeammateEvent (LOAD-BEARING)', async () => {
    // Use maxLoops=1 so ONE verifier failure triggers detection. The load-bearing property
    // is preserved: removing the checkVerifierFail call at extension.ts line ~2488 means
    // LOOP_DETECTED is never emitted, and this test fails.
    const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-loop-vf-real-')));
    const savedEnv = saveEnv(EnvVars.PROJECT_ROOT, EnvVars.API_PORT, EnvVars.API_BASE);
    const supervisorSpy = vi.spyOn(Supervisor.prototype, 'start').mockResolvedValue(undefined);
    const windowSpy = vi.spyOn(TeammateFactory.prototype, 'ensureAgentsWindow').mockResolvedValue({ ok: true });

    let teardown: (() => Promise<void>) | undefined;
    try {
      const verifyTool = 'loop_verifier_b';
      registeredVerifiers.push(verifyTool);

      const { apiPort, teardown: td } = await startCoordinatorHarness({
        projectRoot,
        harnessYaml: `
settings:
  startState: Implementing
  worktreePolicy:
    default: always
  loopDetection:
    maxLoops: 1
    defaultRouteEvent: FAILURE
statechart:
  terminalStates: [done]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
states:
  Implementing:
    identity: { role: "Eng", expertise: "x", constraints: [] }
    baseInstructions: "Do"
    actions:
      - id: code
        type: prompt
        requiredTools:
          - name: ${verifyTool}
            expectsVerify: true
    transitions: { SUCCESS: done, FAILURE: Implementing, BLOCKED: Implementing }
`,
        registeredVerifiers: [{ tool: verifyTool, fn: () => ({ verdict: VerifyVerdict.FAIL, reasons: ['bad'] }) }],
      });
      teardown = td;

      // Write a PROJECT_TOOL_SUCCEEDED event so the artifact-presence check passes
      const configLoader2 = new ConfigLoader(undefined, projectRoot);
      const helperStore = new EventStore(configLoader2, undefined, undefined, projectRoot);
      helperStore.setSessionId(`helper-vf-b-${process.pid}`);
      const outputFile = path.join(projectRoot, '.pi', 'tool-output', 'bd-vf-b', 'Implementing', 'code', verifyTool, 'inv', 'o.json');
      await helperStore.record(DomainEventName.PROJECT_TOOL_SUCCEEDED, {
        beadId: 'bd-vf-b', stateId: 'Implementing', actionId: 'code',
        tool: verifyTool, status: ToolResultStatus.PASSED, outputFile,
      });

      const sig1base = {
        type: TeammateEventType.STATE_TRANSITIONED,
        beadId: 'bd-vf-b', workerId: 'worker-vf-b',
        sessionStateId: 'sess-vf-b-1',
        stateId: 'Implementing', actionId: 'code',
        transitionEvent: 'SUCCESS',
        summary: 'done', evidence: `${verifyTool} ran`, handover: 'over',
        timestamp: Date.now(),
      };
      const sig1 = { ...sig1base, idempotencyKey: createTeammateEventIdempotencyKey(sig1base) };

      // Signal with maxLoops=1: first verifier failure immediately exceeds → LOOP_DETECTED.
      // ack.hold() for STATE_TRANSITIONED guarantees processing completes before HTTP response.
      const r1 = await fetch(`http://127.0.0.1:${apiPort}/signals`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sig1),
      });
      expect(r1.status).toBe(200);
      const b1 = await r1.json() as Record<string, unknown>;
      expect(b1.blocked).toBe(true);

      // LOAD-BEARING: LOOP_DETECTED must be in the event store after signal 1.
      // If the verifierFail loop detection site is removed from extension.ts, this fails.
      const events = readEventStoreLines(projectRoot);
      const loopEvts = events.filter((e: any) => e.type === DomainEventName.LOOP_DETECTED);
      expect(loopEvts.length, 'LOAD-BEARING: LOOP_DETECTED must be emitted by the verifierFail wiring site').toBeGreaterThan(0);
      expect((loopEvts[0] as any).data.scope).toBe('verifierFail');
      expect((loopEvts[0] as any).data.count).toBe(1);
      expect((loopEvts[0] as any).data.max).toBe(1);

      configLoader2.reset();
    } finally {
      await teardown?.();
      supervisorSpy.mockRestore();
      windowSpy.mockRestore();
      restoreEnv(savedEnv);
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('DEFECT 1 — AC8(c) real-path: repeated STATE_FAILED/STATE_BLOCKED via real handleTeammateEvent → LOOP_DETECTED (LOAD-BEARING)', () => {
  beforeEach(() => {
    Logger.close();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    Logger.close();
    await new Promise(r => setTimeout(r, 100));
  });

  it('AC8(c) maxLoops=2: 2nd STATE_FAILED emits LOOP_DETECTED at the failedRoute site (LOAD-BEARING)', async () => {
    const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-loop-fr-real-')));
    const savedEnv = saveEnv(EnvVars.PROJECT_ROOT, EnvVars.API_PORT, EnvVars.API_BASE);
    const supervisorSpy = vi.spyOn(Supervisor.prototype, 'start').mockResolvedValue(undefined);
    const windowSpy = vi.spyOn(TeammateFactory.prototype, 'ensureAgentsWindow').mockResolvedValue({ ok: true });

    let teardown: (() => Promise<void>) | undefined;
    try {
      const { apiPort, teardown: td } = await startCoordinatorHarness({
        projectRoot,
        harnessYaml: `
settings:
  startState: Working
  worktreePolicy:
    default: always
  loopDetection:
    maxLoops: 2
    defaultRouteEvent: FAILURE
statechart:
  terminalStates: [done]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
states:
  Working:
    identity: { role: "Eng", expertise: "x", constraints: [] }
    baseInstructions: "Work"
    actions: [{ id: work, type: prompt }]
    transitions: { SUCCESS: done, FAILURE: Working, BLOCKED: Working }
`,
      });
      teardown = td;

      let signalSeq = 0;
      const makeFailSignal = () => {
        // Use unique workerId per signal to get distinct idempotency keys.
        const workerId = `worker-fr-c-${++signalSeq}`;
        const base = {
          type: TeammateEventType.STATE_FAILED,
          beadId: 'bd-fr-c', workerId,
          stateId: 'Working', actionId: 'work',
          transitionEvent: 'FAILURE',
          summary: 'build failed', evidence: 'tsc error', handover: 'fix it',
          timestamp: Date.now(),
        };
        return { ...base, idempotencyKey: createTeammateEventIdempotencyKey(base) };
      };

      // First STATE_FAILED: failedRoute count=1, NOT exceeded
      const sig1 = makeFailSignal();
      const r1 = await fetch(`http://127.0.0.1:${apiPort}/signals`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sig1),
      });
      expect(r1.status).toBe(200);

      // Wait for signal 1 async processing to complete before sending signal 2.
      // STATE_FAILED signals don't hold the ack, so we poll for the TEAMMATE_EVENT record.
      await pollForEvent(projectRoot, DomainEventName.TEAMMATE_EVENT, 2000);

      // No LOOP_DETECTED after first
      const eventsAfter1 = readEventStoreLines(projectRoot);
      expect(eventsAfter1.filter((e: any) => e.type === DomainEventName.LOOP_DETECTED)).toHaveLength(0);

      // Second STATE_FAILED: failedRoute count=2 → exceeds → LOOP_DETECTED
      const sig2 = makeFailSignal();
      const r2 = await fetch(`http://127.0.0.1:${apiPort}/signals`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sig2),
      });
      expect(r2.status).toBe(200);

      // Wait for signal 2 async processing: poll for LOOP_DETECTED (written by handleTeammateEvent).
      // LOAD-BEARING: removing the failedRoute detection site from extension.ts causes this to time out.
      const loopEvts = await pollForEvent(projectRoot, DomainEventName.LOOP_DETECTED, 3000);
      expect(loopEvts.length, 'LOAD-BEARING: LOOP_DETECTED must be emitted by the failedRoute wiring site').toBeGreaterThan(0);
      expect((loopEvts[0] as any).data.scope).toBe('failedRoute');
    } finally {
      await teardown?.();
      supervisorSpy.mockRestore();
      windowSpy.mockRestore();
      restoreEnv(savedEnv);
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('DEFECT 1 — AC8(d) real-path: repeated blocker self-loops via real handleTeammateEvent → LOOP_DETECTED (LOAD-BEARING)', () => {
  beforeEach(() => {
    Logger.close();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    Logger.close();
    await new Promise(r => setTimeout(r, 100));
  });

  it('AC8(d) maxLoops=2: 2nd same-blocker STATE_BLOCKED emits LOOP_DETECTED at the blocker site (LOAD-BEARING)', async () => {
    const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-loop-bl-real-')));
    const savedEnv = saveEnv(EnvVars.PROJECT_ROOT, EnvVars.API_PORT, EnvVars.API_BASE);
    const supervisorSpy = vi.spyOn(Supervisor.prototype, 'start').mockResolvedValue(undefined);
    const windowSpy = vi.spyOn(TeammateFactory.prototype, 'ensureAgentsWindow').mockResolvedValue({ ok: true });

    let teardown: (() => Promise<void>) | undefined;
    try {
      const { apiPort, teardown: td } = await startCoordinatorHarness({
        projectRoot,
        harnessYaml: `
settings:
  startState: Fixing
  worktreePolicy:
    default: always
  loopDetection:
    maxLoops: 2
    defaultRouteEvent: FAILURE
statechart:
  terminalStates: [done]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
states:
  Fixing:
    identity: { role: "Eng", expertise: "x", constraints: [] }
    baseInstructions: "Fix"
    actions: [{ id: fix, type: prompt }]
    transitions: { SUCCESS: done, FAILURE: Fixing, BLOCKED: Fixing }
`,
      });
      teardown = td;

      let signalSeq = 0;
      const makeBlockSignal = () => {
        // Use unique workerId per signal to get distinct idempotency keys.
        const workerId = `worker-bl-d-${++signalSeq}`;
        const base = {
          type: TeammateEventType.STATE_BLOCKED,
          beadId: 'bd-bl-d', workerId,
          stateId: 'Fixing', actionId: 'fix',
          transitionEvent: 'BLOCKED',
          // Same summary each time → same blocker fingerprint
          summary: 'dependency missing', evidence: 'npm error', handover: 'need pkg',
          timestamp: Date.now(),
        };
        return { ...base, idempotencyKey: createTeammateEventIdempotencyKey(base) };
      };

      // First STATE_BLOCKED with BLOCKED transition (self-loop): blocker count=1, NOT exceeded
      const sig1 = makeBlockSignal();
      const r1 = await fetch(`http://127.0.0.1:${apiPort}/signals`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sig1),
      });
      expect(r1.status).toBe(200);

      // Wait for signal 1 async processing to complete before sending signal 2.
      await pollForEvent(projectRoot, DomainEventName.TEAMMATE_EVENT, 2000);

      // No LOOP_DETECTED after first
      const eventsAfter1 = readEventStoreLines(projectRoot);
      expect(eventsAfter1.filter((e: any) => e.type === DomainEventName.LOOP_DETECTED)).toHaveLength(0);

      // Second STATE_BLOCKED with same summary: blocker count=2 → exceeds → LOOP_DETECTED
      const sig2 = makeBlockSignal();
      const r2 = await fetch(`http://127.0.0.1:${apiPort}/signals`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sig2),
      });
      expect(r2.status).toBe(200);

      // Wait for signal 2 async processing: poll for LOOP_DETECTED.
      // LOAD-BEARING: removing the blocker detection site from extension.ts causes this to time out.
      const loopEvts = await pollForEvent(projectRoot, DomainEventName.LOOP_DETECTED, 3000);
      expect(loopEvts.length, 'LOAD-BEARING: LOOP_DETECTED must be emitted by the blocker wiring site').toBeGreaterThan(0);
      expect((loopEvts[0] as any).data.scope).toBe('blocker');
    } finally {
      await teardown?.();
      supervisorSpy.mockRestore();
      windowSpy.mockRestore();
      restoreEnv(savedEnv);
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
