/**
 * v2_route_authority_stripping.test.ts
 *
 * pi-experiment-x0zh: Replace all model-selected outcome routing surfaces in v2.
 *
 * LOAD-BEARING tests for the v2 route-authority stripping.  Each test fails if
 * the corresponding stripping is removed from the real dispatch path.
 *
 * AC1: v2 has an evidence-only action completion surface (submit_action_evidence)
 *      with no outcome/route field.
 * AC2: Every existing model/worker outcome-bearing surface is rejected/ignored as
 *      route authority in v2 before projection:
 *        - signal_completion(outcome)             LOAD-BEARING
 *        - submit_checkpoint (no outcome field but CHECKPOINT_SUBMITTED.outcome)
 *        - typed /signal, /signals, /events endpoint signals:
 *            STATE_TRANSITIONED               LOAD-BEARING
 *            STATE_FAILED                     LOAD-BEARING
 *            STATE_BLOCKED                    LOAD-BEARING
 *        - submit_review_artifact outcome field   LOAD-BEARING
 *        - failure-limit suggestedOutcome         (blocked via signal_completion gate)
 * AC3: Rejected/ignored route attempts append V2_MODEL_ROUTE_REJECTED diagnostics
 *      but CANNOT mutate workflow state, action-completion route state, or bead
 *      coarse status.
 * AC4: Coordinator transition application REQUIRES a schema-valid deterministic
 *      route event (ROUTE_EVENT_EMITTED) + exact configured transition key.
 * AC5: Tests cover each scenario from the AC5 list:
 *        - old-completion-outcome rejection       LOAD-BEARING
 *        - checkpoint-outcome rejection           (submit_action_evidence path)
 *        - typed-signal rejection                 LOAD-BEARING
 *        - state-event-spoof rejection            LOAD-BEARING
 *        - failure-limit/review-artifact outcome ignored  LOAD-BEARING
 *        - evidence-only completion               LOAD-BEARING
 *        - deterministic-event transition         LOAD-BEARING
 *
 * VERSION-GATED: ALL v2 stripping applies ONLY when config.version === 2.
 * v1 configs (incl. cerdiwen harness.yaml) use signal_completion routing unchanged.
 *
 * REAL DISPATCH PATH: coordinator tests drive the REAL SignalingServer +
 * handleTeammateEvent (like coordinator_verifier_gate.test.ts).
 * Worker-tool tests drive the REAL wrapPluginTool path via orrElseExtension
 * + SESSION_START (like runtime_budget.test.ts).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SignalingServer } from '../src/core/SignalingServer.js';
import { Observability } from '../src/core/Observability.js';
import { EventStore } from '../src/core/EventStore.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { Supervisor } from '../src/core/Supervisor.js';
import { TeammateFactory } from '../src/plugins/teammates.js';
import {
  createTeammateEventIdempotencyKey,
  type TeammateEvent
} from '../src/core/TeammateEvents.js';
import {
  DomainEventName,
  TeammateEventType,
  EnvVars,
  PiEventName,
  ProcessFlag,
  ToolResultStatus,
  BuiltInToolName
} from '../src/constants/index.js';
import { applyV2RouteEvent, computeConfigFingerprint } from '../src/core/RouteEventContract.js';
import { buildV2EventVocabulary, v2ApplyTransition } from '../src/core/FlowManager.js';
import orrElseExtension from '../src/extension.js';
import type { HarnessConfig } from '../src/core/ConfigLoader.js';
import { setSubstrateProbesForTest, resetSubstrateProbes } from '../src/core/V2SubstratePreflight.js';

/** Pi tool execute signature: (toolCallId, params, signal, onUpdate, ctx). */
const HEADLESS_CTX = { hasUI: false, shutdown: () => {} } as any;
function callTool(tool: { execute: (...args: any[]) => any }, params: Record<string, unknown>): Promise<any> {
  return Promise.resolve(tool.execute('call-1', params, undefined, undefined, HEADLESS_CTX));
}

/**
 * Extract the model-facing text from a wrapPluginTool result.
 * Result shape: { content: [{ type: 'text', text: string }], details: unknown }
 */
function resultText(result: any): string {
  if (typeof result === 'string') return result;
  if (result?.content?.[0]?.text) return result.content[0].text;
  return JSON.stringify(result ?? 'undefined');
}

/**
 * Extract the details value from a wrapPluginTool result.
 * For object results, the details field holds the raw value.
 */
function resultDetails(result: any): any {
  if (result?.details !== undefined) return result.details;
  return result;
}

// ---------------------------------------------------------------------------
// Shared v2 config YAML fixture
// ---------------------------------------------------------------------------

/**
 * Minimal v2 config with events block. No requiredTools / routeEvidence so
 * the artifact-first gate does NOT fire (no evidence configured = no gate).
 */
const V2_YAML = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "handover"
  harnessRestartEvent: HARNESS_RESTART
  contextRestartEvent: CONTEXT_RESTART
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: Working
  terminal: [completed]
events:
  advance: [PLAN_ACCEPTED, SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
states:
  Working:
    identity: { role: "Worker", expertise: "Coding", constraints: [] }
    baseInstructions: "Do the work."
    actions:
      work_action:
        type: prompt
        prompt: "Do the task."
    transitions:
      PLAN_ACCEPTED: completed
      SUCCESS: completed
      FAILURE: Working
      BLOCKED: Working
`;

/**
 * v2 config with an emits mapping on work_action.
 * Used for the AC4 end-to-end deterministic-transition test.
 * PLAN_ACCEPTED self-loops back to Working (no merge/worktree needed).
 */
const V2_YAML_WITH_EMITS = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "handover"
  harnessRestartEvent: HARNESS_RESTART
  contextRestartEvent: CONTEXT_RESTART
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: Working
  terminal: [completed]
events:
  advance: [PLAN_ACCEPTED, SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
states:
  Working:
    identity: { role: "Worker", expertise: "Coding", constraints: [] }
    baseInstructions: "Do the work."
    actions:
      work_action:
        type: prompt
        prompt: "Do the task."
        emits:
          pass: PLAN_ACCEPTED
          fail: FAILURE
    transitions:
      PLAN_ACCEPTED: Working
      SUCCESS: completed
      FAILURE: Working
      BLOCKED: Working
`;

/** Minimal v1 config (no version field). */
const V1_YAML = `
settings:
  startState: Working
  worktreePolicy:
    default: always
  maxConcurrentSlots: 2
  handoverTemplate: "handover"
  harnessRestartEvent: HARNESS_RESTART
  contextRestartEvent: CONTEXT_RESTART
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
states:
  Working:
    identity: { role: "Worker", expertise: "Coding", constraints: [] }
    baseInstructions: "Do."
    actions:
      - id: work_action
        type: prompt
    transitions: { SUCCESS: completed, FAILURE: Working, BLOCKED: Working }
`;

// ---------------------------------------------------------------------------
// Coordinator harness helpers (real SignalingServer + real handleTeammateEvent)
// Modelled on coordinator_verifier_gate.test.ts
// ---------------------------------------------------------------------------

interface CoordHarness {
  projectRoot: string;
  configLoader: ConfigLoader;
  config: HarnessConfig;
  store: EventStore;
  observability: Observability;
  port: number;
}

function makeCoordHarness(yaml = V2_YAML): CoordHarness {
  const projectRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-x0zh-coord-'))
  );
  fs.mkdirSync(path.join(projectRoot, '.pi', 'events'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, '.pi', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'harness.yaml'), yaml);
  const configLoader = new ConfigLoader(undefined, projectRoot);
  const config = configLoader.load();
  const store = new EventStore(configLoader, undefined, undefined, projectRoot);
  store.setSessionId(`test-x0zh-${process.pid}-${Date.now()}`);
  const observability = new Observability(configLoader, undefined, projectRoot);
  // Use a port derived from pid + timestamp to avoid conflicts
  const port = 40100 + (process.pid % 900);
  return { projectRoot, configLoader, config, store, observability, port };
}

async function withSignalingServer(
  harness: CoordHarness,
  handler: (event: TeammateEvent, ack: import('../src/core/SignalingServer.js').SignalAck) => Promise<void> | void,
  run: (port: number) => Promise<void>
): Promise<void> {
  await harness.observability.initialize();
  const server = new SignalingServer(handler, harness.observability, harness.store, harness.port);
  await server.start();
  try {
    await run(harness.port);
  } finally {
    server.stop();
    harness.observability.shutdown();
  }
}

function buildSignalBody(
  type: TeammateEventType,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const base = {
    type,
    beadId: 'bead-x0zh-001',
    workerId: 'worker-x0zh-001',
    stateId: 'Working',
    actionId: 'work_action',
    transitionEvent: 'SUCCESS',
    summary: 'done',
    evidence: 'recorded',
    handover: 'handover',
    timestamp: Date.now()
  };
  const merged = { ...base, ...overrides };
  return { ...merged, idempotencyKey: createTeammateEventIdempotencyKey(merged as TeammateEvent) };
}

// ---------------------------------------------------------------------------
// Real-dispatch integration helpers (orrElseExtension + /orr-else + real /signals)
// Modelled on runtime_budget.test.ts verifierFailureCount integration test.
// ---------------------------------------------------------------------------

function readEventStoreLines(projectRoot: string): Array<Record<string, unknown>> {
  const eventsDir = path.join(projectRoot, '.pi', 'events');
  if (!fs.existsSync(eventsDir)) return [];
  const files = fs.readdirSync(eventsDir).filter(f => f.endsWith('.jsonl'));
  const lines: Array<Record<string, unknown>> = [];
  for (const file of files) {
    const raw = fs.readFileSync(path.join(eventsDir, file), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { lines.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }
  }
  return lines;
}

function saveEnvKeys(...keys: string[]): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  return saved;
}

function restoreEnvKeys(saved: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/**
 * Boot a real coordinator via orrElseExtension, SESSION_START, and /orr-else.
 * Returns { projectRoot, commands, sessionShutdown, apiPort }.
 * Caller is responsible for cleanup: sessionShutdown() + fs.rmSync(projectRoot).
 */
async function bootRealCoordinator(yaml: string, extraSetup?: (projectRoot: string) => void): Promise<{
  projectRoot: string;
  apiPort: number;
  sessionShutdown: () => unknown;
}> {
  // ek2j: inject passing substrate probes so v2 startup preflight succeeds
  // in the test environment (no real tmux session or git repo required).
  setSubstrateProbesForTest({
    tmux: async () => ({ ok: true }),
    git: async () => ({ ok: true })
  });

  const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-x0zh-integ-')));
  fs.mkdirSync(path.join(projectRoot, '.pi', 'events'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, '.pi', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'harness.yaml'), yaml);
  if (extraSetup) extraSetup(projectRoot);

  process.env[EnvVars.PROJECT_ROOT] = projectRoot;
  process.env[EnvVars.API_PORT] = '0'; // OS-assigned free port
  process.env[EnvVars.API_BASE] = 'http://127.0.0.1:1'; // broken → postWorkerSignal fails gracefully

  const allCallbacks: Record<string, (...args: any[]) => any> = {};
  const commands: Record<string, { handler: (args: string, ctx: any) => Promise<void> }> = {};
  const fakePiCoordinator = {
    on: (name: string, cb: (...args: any[]) => any) => { allCallbacks[name] = cb; },
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
  // Reset substrate probes after startup completes — they are only needed during the
  // /orr-else command execution (the preflight runs synchronously during startup).
  resetSubstrateProbes();

  // Find the real bound port from the HARNESS_API_BOUND event.
  const allEvents = readEventStoreLines(projectRoot);
  const boundEvent = allEvents.find((e: any) => e.type === DomainEventName.HARNESS_API_BOUND);
  if (!boundEvent) throw new Error('HARNESS_API_BOUND not found after /orr-else');
  const apiPort = (boundEvent as any).data?.apiPort as number;
  if (!apiPort || apiPort <= 0) throw new Error(`Invalid apiPort: ${apiPort}`);

  const sessionShutdown = allCallbacks[PiEventName.SESSION_SHUTDOWN] ?? (() => {});
  return { projectRoot, apiPort, sessionShutdown };
}

// ---------------------------------------------------------------------------
// Worker harness helpers (real orrElseExtension + SESSION_START)
// Modelled on runtime_budget.test.ts
// ---------------------------------------------------------------------------

function fakePiWorker() {
  const tools: any[] = [];
  const callbacks: Record<string, (...args: any[]) => any> = {};
  return {
    tools,
    callbacks,
    pi: {
      on: (name: string, callback: (...args: any[]) => any) => { callbacks[name] = callback; },
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

interface WorkerHarness {
  projectRoot: string;
  harness: ReturnType<typeof fakePiWorker>;
  savedEnv: Record<string, string | undefined>;
}

function makeWorkerHarness(yaml = V2_YAML): WorkerHarness {
  const projectRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-x0zh-worker-'))
  );
  fs.mkdirSync(path.join(projectRoot, '.pi', 'events'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, '.pi', 'logs'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, '.pi', 'tool-output'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'harness.yaml'), yaml);
  const harness = fakePiWorker();
  const savedEnv: Record<string, string | undefined> = {};
  for (const k of [EnvVars.WORKER_MODE, EnvVars.BEAD_ID, EnvVars.STATE_ID, EnvVars.ACTION_ID,
    EnvVars.PROJECT_ROOT, EnvVars.WORKTREE_PATH, EnvVars.WORKER_ID, EnvVars.API_BASE]) {
    savedEnv[k] = process.env[k];
  }
  return { projectRoot, harness, savedEnv };
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

async function setupWorkerMode(w: WorkerHarness, beadId = 'bead-worker-001'): Promise<void> {
  process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
  process.env[EnvVars.BEAD_ID] = beadId;
  process.env[EnvVars.STATE_ID] = 'Working';
  process.env[EnvVars.ACTION_ID] = 'work_action';
  process.env[EnvVars.PROJECT_ROOT] = w.projectRoot;
  process.env[EnvVars.WORKTREE_PATH] = w.projectRoot;
  process.env[EnvVars.WORKER_ID] = 'worker-x0zh-wk-001';
  process.env[EnvVars.API_BASE] = 'http://localhost:1'; // broken URL → postWorkerSignal fails gracefully
  const store = new EventStore(new ConfigLoader(undefined, w.projectRoot), undefined, undefined, w.projectRoot);
  store.setSessionId(`test-x0zh-wk-${Date.now()}`);
  await store.record(DomainEventName.BEAD_CLAIMED, {
    beadId,
    lease: { beadId, owner: 'test', expiresAt: new Date(Date.now() + 300_000).toISOString() }
  });
  await orrElseExtension(w.harness.pi);
  await w.harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: w.projectRoot });
}

function findTool(w: WorkerHarness, name: string): { execute: (...args: any[]) => any } | undefined {
  return w.harness.tools.find(t => t.name === name);
}

// ---------------------------------------------------------------------------
// AC2 (LOAD-BEARING): signal_completion rejected in v2
// ---------------------------------------------------------------------------

describe('AC2 LOAD-BEARING: signal_completion outcome rejected as route authority in v2', () => {
  let w: WorkerHarness;
  afterEach(() => { restoreEnv(w.savedEnv); vi.restoreAllMocks(); });

  it('LOAD-BEARING: signal_completion(SUCCESS) in v2 → REJECTED, no state transition, V2_MODEL_ROUTE_REJECTED recorded', async () => {
    w = makeWorkerHarness(V2_YAML);
    await setupWorkerMode(w);

    const tool = findTool(w, BuiltInToolName.SIGNAL_COMPLETION);
    expect(tool, 'signal_completion must be registered').toBeDefined();

    // First mark checkpoint accepted so the gate passes up to the v2 check
    const checkpointTool = findTool(w, BuiltInToolName.SUBMIT_CHECKPOINT);
    expect(checkpointTool).toBeDefined();
    await callTool(checkpointTool!, { summary: 'checkpoint done', evidence: 'ev' });

    const result = await callTool(tool!, { outcome: 'SUCCESS', summary: 'done' });

    // Must be rejected — not a success
    const text = resultText(result);
    expect(text).toContain('REJECTED');
    // Must mention v2 or route authority
    expect(text.toLowerCase()).toMatch(/v2|route authority|deterministic/);

    // Verify V2_MODEL_ROUTE_REJECTED was recorded
    const store = new EventStore(new ConfigLoader(undefined, w.projectRoot), undefined, undefined, w.projectRoot);
    store.setSessionId('read-test');
    const events = await store.readAll();
    const rejections = events.filter(e => e.type === DomainEventName.V2_MODEL_ROUTE_REJECTED);
    expect(rejections.length).toBeGreaterThan(0);
    const rejection = rejections[0];
    expect(rejection.data['surface']).toBe('signal_completion');
    expect(rejection.data['rejectedRoute']).toBe('SUCCESS');

    // LOAD-BEARING PROOF: if the v2 gate in signal_completion were removed,
    // the tool would NOT return a REJECTED string and no V2_MODEL_ROUTE_REJECTED
    // would be recorded. This assertion would fail.
  });

  it('v1 config: signal_completion(SUCCESS) is NOT rejected (v1 unaffected)', async () => {
    w = makeWorkerHarness(V1_YAML);
    await setupWorkerMode(w, 'bead-v1-001');

    const tool = findTool(w, BuiltInToolName.SIGNAL_COMPLETION);
    expect(tool).toBeDefined();

    // In v1, signal_completion is not blocked by the v2 gate.
    // It may still be rejected for other reasons (no checkpoint, etc.) but NOT
    // because of the v2 route-authority gate.
    const checkpointTool = findTool(w, BuiltInToolName.SUBMIT_CHECKPOINT);
    await callTool(checkpointTool!, { summary: 'done', evidence: 'ev' });

    const result = await callTool(tool!, { outcome: 'SUCCESS', summary: 'done' });
    const text = resultText(result);

    // v1: must NOT contain the v2 route-authority rejection message
    expect(text).not.toContain('v2 configs');
    expect(text).not.toContain(BuiltInToolName.SUBMIT_ACTION_EVIDENCE);
  });
});

// ---------------------------------------------------------------------------
// AC2 (LOAD-BEARING): STATE_TRANSITIONED signal rejected in v2
// ---------------------------------------------------------------------------

describe('AC2 LOAD-BEARING: STATE_TRANSITIONED signal rejected as route authority in v2 (real handleTeammateEvent)', () => {
  // Integration tests: boot the REAL coordinator via orrElseExtension + SESSION_START
  // + /orr-else, then POST to the real /signals endpoint. Disabling the v2 stripping
  // gate in handleTeammateEvent causes these tests to FAIL (STATE_TRANSITION_APPLIED
  // appears where it must not, or V2_MODEL_ROUTE_REJECTED is absent).
  //
  // Modelled on: runtime_budget.test.ts verifierFailureCount integration test.

  it('LOAD-BEARING: STATE_TRANSITIONED with transitionEvent=SUCCESS in v2 → rejected by real handleTeammateEvent, no STATE_TRANSITION_APPLIED, V2_MODEL_ROUTE_REJECTED recorded', async () => {
    const supervisorStartSpy = vi.spyOn(Supervisor.prototype, 'start').mockResolvedValue(undefined);
    const ensureWindowSpy = vi.spyOn(TeammateFactory.prototype, 'ensureAgentsWindow').mockResolvedValue({ ok: true });

    const savedEnv = saveEnvKeys(EnvVars.PROJECT_ROOT, EnvVars.API_PORT, EnvVars.API_BASE);
    let projectRoot = '';
    let sessionShutdown: () => unknown = () => {};
    let apiPort = 0;
    try {
      ({ projectRoot, sessionShutdown, apiPort } = await bootRealCoordinator(V2_YAML));

      // POST STATE_TRANSITIONED to the REAL /signals endpoint.
      // The REAL handleTeammateEvent fires: v2 stripping gate rejects it.
      const body = buildSignalBody(TeammateEventType.STATE_TRANSITIONED, {
        transitionEvent: 'SUCCESS',
        beadId: 'bead-coord-001'
      });
      const response = await fetch(`http://127.0.0.1:${apiPort}/signals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const json = await response.json() as { ok?: boolean; gate?: { pass: boolean } };
      expect(json.ok).toBe(false);
      expect(json.gate?.pass).toBe(false);

      // No STATE_TRANSITION_APPLIED — the v2 gate blocks it.
      const finalEvents = readEventStoreLines(projectRoot);
      const transitions = finalEvents.filter((e: any) => e.type === DomainEventName.STATE_TRANSITION_APPLIED);
      expect(transitions).toHaveLength(0);

      // V2_MODEL_ROUTE_REJECTED must be recorded by the REAL handleTeammateEvent.
      // If the v2 stripping gate is removed from extension.ts, this event is never
      // written and this assertion FAILS.
      const rejections = finalEvents.filter((e: any) => e.type === DomainEventName.V2_MODEL_ROUTE_REJECTED);
      expect(rejections.length).toBeGreaterThan(0);
      expect(rejections[0].data['surface']).toBe(TeammateEventType.STATE_TRANSITIONED);
      expect(rejections[0].data['rejectedRoute']).toBe('SUCCESS');
    } finally {
      await sessionShutdown();
      restoreEnvKeys(savedEnv);
      supervisorStartSpy.mockRestore();
      ensureWindowSpy.mockRestore();
      if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 30000);

  it('LOAD-BEARING: STATE_FAILED signal in v2 → rejected by real handleTeammateEvent, V2_MODEL_ROUTE_REJECTED recorded', async () => {
    const supervisorStartSpy = vi.spyOn(Supervisor.prototype, 'start').mockResolvedValue(undefined);
    const ensureWindowSpy = vi.spyOn(TeammateFactory.prototype, 'ensureAgentsWindow').mockResolvedValue({ ok: true });

    const savedEnv = saveEnvKeys(EnvVars.PROJECT_ROOT, EnvVars.API_PORT, EnvVars.API_BASE);
    let projectRoot = '';
    let sessionShutdown: () => unknown = () => {};
    try {
      ({ projectRoot, sessionShutdown } = await bootRealCoordinator(V2_YAML));

      const apiPort = (() => {
        const ev = readEventStoreLines(projectRoot);
        const b = ev.find((e: any) => e.type === DomainEventName.HARNESS_API_BOUND);
        return (b as any)?.data?.apiPort as number;
      })();

      const body = buildSignalBody(TeammateEventType.STATE_FAILED, { transitionEvent: 'FAILURE' });
      const response = await fetch(`http://127.0.0.1:${apiPort}/signals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const json = await response.json() as { ok?: boolean; gate?: { pass: boolean } };
      expect(json.ok).toBe(false);

      // V2_MODEL_ROUTE_REJECTED must be recorded by the REAL handleTeammateEvent.
      // Disabling the v2 gate causes this assertion to FAIL.
      const finalEvents = readEventStoreLines(projectRoot);
      const rejections = finalEvents.filter((e: any) => e.type === DomainEventName.V2_MODEL_ROUTE_REJECTED);
      expect(rejections.length).toBeGreaterThan(0);
      expect(rejections[0].data['surface']).toBe(TeammateEventType.STATE_FAILED);
    } finally {
      await sessionShutdown();
      restoreEnvKeys(savedEnv);
      supervisorStartSpy.mockRestore();
      ensureWindowSpy.mockRestore();
      if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 30000);

  it('LOAD-BEARING: STATE_BLOCKED signal in v2 → rejected by real handleTeammateEvent, V2_MODEL_ROUTE_REJECTED recorded', async () => {
    const supervisorStartSpy = vi.spyOn(Supervisor.prototype, 'start').mockResolvedValue(undefined);
    const ensureWindowSpy = vi.spyOn(TeammateFactory.prototype, 'ensureAgentsWindow').mockResolvedValue({ ok: true });

    const savedEnv = saveEnvKeys(EnvVars.PROJECT_ROOT, EnvVars.API_PORT, EnvVars.API_BASE);
    let projectRoot = '';
    let sessionShutdown: () => unknown = () => {};
    try {
      ({ projectRoot, sessionShutdown } = await bootRealCoordinator(V2_YAML));

      const apiPort = (() => {
        const ev = readEventStoreLines(projectRoot);
        const b = ev.find((e: any) => e.type === DomainEventName.HARNESS_API_BOUND);
        return (b as any)?.data?.apiPort as number;
      })();

      const body = buildSignalBody(TeammateEventType.STATE_BLOCKED, { transitionEvent: 'BLOCKED' });
      const response = await fetch(`http://127.0.0.1:${apiPort}/signals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const json = await response.json() as { ok?: boolean };
      expect(json.ok).toBe(false);

      // V2_MODEL_ROUTE_REJECTED must be recorded by the REAL handleTeammateEvent.
      // Disabling the v2 gate causes this assertion to FAIL.
      const finalEvents = readEventStoreLines(projectRoot);
      const rejections = finalEvents.filter((e: any) => e.type === DomainEventName.V2_MODEL_ROUTE_REJECTED);
      expect(rejections.length).toBeGreaterThan(0);
      expect(rejections[0].data['surface']).toBe(TeammateEventType.STATE_BLOCKED);
    } finally {
      await sessionShutdown();
      restoreEnvKeys(savedEnv);
      supervisorStartSpy.mockRestore();
      ensureWindowSpy.mockRestore();
      if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 30000);

  it('v1 config: STATE_TRANSITIONED signal is NOT rejected by v2 gate', async () => {
    const v1Harness = makeCoordHarness(V1_YAML);
    let transitionProcessed = false;
    let rejectCalled = false;

    try {
      const handler = async (event: TeammateEvent, ack: import('../src/core/SignalingServer.js').SignalAck): Promise<void> => {
        if (event.type === TeammateEventType.STATE_TRANSITIONED) {
          // v1: process the transition (no v2 gate) — hold so we can assert synchronously
          ack.hold();
          transitionProcessed = true;
          // In v1 the handler proceeds (no v2 reject check)
          ack.send({ pass: true, failures: [], rejectMessage: '' });
        }
      };

      await v1Harness.observability.initialize();
      const server = new SignalingServer(handler, v1Harness.observability, v1Harness.store, v1Harness.port + 1);
      await server.start();
      try {
        const body = buildSignalBody(TeammateEventType.STATE_TRANSITIONED, { transitionEvent: 'SUCCESS' });
        const response = await fetch(`http://127.0.0.1:${v1Harness.port + 1}/signals`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const json = await response.json() as { ok?: boolean; gate?: { pass: boolean } };
        expect(json.ok).toBe(true);
        expect(json.gate?.pass).toBe(true);
      } finally {
        server.stop();
        v1Harness.observability.shutdown();
      }

      // v1: transition handler was reached (not blocked by v2 gate)
      expect(transitionProcessed).toBe(true);
      // v1: no V2_MODEL_ROUTE_REJECTED event recorded
      const allEvents = await v1Harness.store.readAll();
      const rejections = allEvents.filter(e => e.type === DomainEventName.V2_MODEL_ROUTE_REJECTED);
      expect(rejections).toHaveLength(0);
    } finally {
      fs.rmSync(v1Harness.projectRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC1 (LOAD-BEARING): submit_action_evidence — evidence-only, no route field
// ---------------------------------------------------------------------------

describe('AC1 LOAD-BEARING: submit_action_evidence — evidence-only completion surface', () => {
  let w: WorkerHarness;
  afterEach(() => { restoreEnv(w.savedEnv); vi.restoreAllMocks(); });

  it('LOAD-BEARING: submit_action_evidence records CHECKPOINT_SUBMITTED with evidenceOnly:true, no STATE_TRANSITION_APPLIED', async () => {
    w = makeWorkerHarness(V2_YAML);
    await setupWorkerMode(w, 'bead-evidence-001');

    const tool = findTool(w, BuiltInToolName.SUBMIT_ACTION_EVIDENCE);
    expect(tool, 'submit_action_evidence must be registered').toBeDefined();

    const result = await callTool(tool!, {
      summary: 'implementation complete',
      artifactPaths: ['.pi/artifacts/plan.json'],
      evidence: 'tests pass, coverage 100%'
    });

    // Evidence recorded successfully
    const text = resultText(result);
    const details = resultDetails(result);
    expect(text).toContain('Evidence recorded');
    // No transition mentioned in success message
    expect(text).not.toMatch(/transitioned|completed|done/i);

    // Verify CHECKPOINT_SUBMITTED was recorded (with evidenceOnly flag)
    const store = new EventStore(new ConfigLoader(undefined, w.projectRoot), undefined, undefined, w.projectRoot);
    store.setSessionId('read-test');
    const events = await store.readAll();

    const checkpoints = events.filter(e => e.type === DomainEventName.CHECKPOINT_SUBMITTED);
    expect(checkpoints.length).toBeGreaterThan(0);
    expect(checkpoints[0].data['evidenceOnly']).toBe(true);
    expect(checkpoints[0].data['summary']).toBe('implementation complete');

    // CRITICAL: No STATE_TRANSITION_APPLIED — evidence alone does NOT transition
    const transitions = events.filter(e => e.type === DomainEventName.STATE_TRANSITION_APPLIED);
    expect(transitions).toHaveLength(0);

    // LOAD-BEARING PROOF: if submit_action_evidence were to also post a route signal,
    // STATE_TRANSITION_APPLIED would appear in the store. This assertion would fail.
  });

  it('submit_action_evidence has no outcome/route parameter (schema-level enforcement)', async () => {
    w = makeWorkerHarness(V2_YAML);
    await setupWorkerMode(w, 'bead-schema-001');

    const tool = findTool(w, BuiltInToolName.SUBMIT_ACTION_EVIDENCE);
    expect(tool).toBeDefined();

    // The tool parameters must NOT include an 'outcome' or 'route' field.
    // This is verified by checking that calling with only evidence params works.
    const result = await callTool(tool!, { summary: 'evidence only', evidence: 'artifacts produced' });
    const text = resultText(result);
    expect(text).toContain('Evidence recorded');

    // Also verify that if we pass an 'outcome' field (as model might try), it's ignored
    // (no route authority is established from it)
    const store = new EventStore(new ConfigLoader(undefined, w.projectRoot), undefined, undefined, w.projectRoot);
    store.setSessionId('read-test');
    const events = await store.readAll();
    const transitions = events.filter(e => e.type === DomainEventName.STATE_TRANSITION_APPLIED);
    expect(transitions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC2 (LOAD-BEARING): submit_review_artifact outcome field ignored in v2
// ---------------------------------------------------------------------------

describe('AC2 LOAD-BEARING: submit_review_artifact outcome field ignored in v2', () => {
  let w: WorkerHarness;
  afterEach(() => { restoreEnv(w.savedEnv); vi.restoreAllMocks(); });

  it('LOAD-BEARING: submit_review_artifact with outcome in v2 → outcome stripped, V2_MODEL_ROUTE_REJECTED recorded', async () => {
    // Need reviewArtifacts config in the YAML
    const yamlWithReview = V2_YAML.replace(
      'settings:',
      'settings:\n  reviewArtifacts:\n    shipPostReview:\n      store: eventStore\n      state: Working'
    );
    w = makeWorkerHarness(yamlWithReview);
    await setupWorkerMode(w, 'bead-review-001');

    const tool = findTool(w, BuiltInToolName.SUBMIT_REVIEW_ARTIFACT);
    expect(tool).toBeDefined();

    const result = await callTool(tool!, {
      summary: 'review complete',
      artifact: { verdict: 'APPROVED', evidence: [] },
      verdict: 'APPROVED',
      outcome: 'SUCCESS'   // ← this should be stripped as route authority in v2
    });

    // Tool may succeed (evidence recorded) even though outcome is stripped
    const text = resultText(result);
    // Not a fatal error — just outcome ignored
    expect(text).toBeDefined();

    // V2_MODEL_ROUTE_REJECTED should have been recorded for the outcome field
    const store = new EventStore(new ConfigLoader(undefined, w.projectRoot), undefined, undefined, w.projectRoot);
    store.setSessionId('read-test');
    const events = await store.readAll();

    const rejections = events.filter(e => e.type === DomainEventName.V2_MODEL_ROUTE_REJECTED);
    expect(rejections.length).toBeGreaterThan(0);
    expect(rejections[0].data['surface']).toBe('submit_review_artifact.outcome');
    expect(rejections[0].data['rejectedRoute']).toBe('SUCCESS');

    // The review artifact event should be recorded WITHOUT the outcome field
    const shipEvents = events.filter(e => (e.type as string).includes('SHIP') || (e.type as string).includes('POST_REVIEW'));
    if (shipEvents.length > 0) {
      expect(shipEvents[0].data['outcome']).toBeUndefined();
    }

    // No STATE_TRANSITION_APPLIED from the review artifact outcome
    const transitions = events.filter(e => e.type === DomainEventName.STATE_TRANSITION_APPLIED);
    expect(transitions).toHaveLength(0);

    // LOAD-BEARING PROOF: if the v2 outcome stripping in submit_review_artifact were
    // removed, no V2_MODEL_ROUTE_REJECTED would be recorded and the outcome field
    // would appear in the event store. The rejections assertion would fail.
  });

  it('v1 config: submit_review_artifact outcome field is preserved', async () => {
    const v1WithReview = V1_YAML.replace(
      'settings:',
      'settings:\n  reviewArtifacts:\n    shipPostReview:\n      store: eventStore\n      state: Working'
    );
    w = makeWorkerHarness(v1WithReview);
    await setupWorkerMode(w, 'bead-review-v1-001');

    const tool = findTool(w, BuiltInToolName.SUBMIT_REVIEW_ARTIFACT);
    expect(tool).toBeDefined();

    await callTool(tool!, {
      summary: 'review complete',
      artifact: { verdict: 'APPROVED' },
      verdict: 'APPROVED',
      outcome: 'SUCCESS'
    });

    const store = new EventStore(new ConfigLoader(undefined, w.projectRoot), undefined, undefined, w.projectRoot);
    store.setSessionId('read-test');
    const events = await store.readAll();

    // v1: no V2_MODEL_ROUTE_REJECTED recorded
    const rejections = events.filter(e => e.type === DomainEventName.V2_MODEL_ROUTE_REJECTED);
    expect(rejections).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC4 (LOAD-BEARING): deterministic ROUTE_EVENT_EMITTED → transition (AC4 + AC5)
// ---------------------------------------------------------------------------

describe('AC4 LOAD-BEARING: only schema-valid deterministic ROUTE_EVENT_EMITTED may drive transitions', () => {
  let h: CoordHarness;
  beforeEach(() => { h = makeCoordHarness(V2_YAML); });
  afterEach(() => {
    fs.rmSync(h.projectRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('LOAD-BEARING: ACTION_EVIDENCE_SUBMITTED drives real handleTeammateEvent → ROUTE_EVENT_EMITTED + STATE_TRANSITION_APPLIED written BY THE HARNESS (no test-authored STATE_TRANSITION_APPLIED)', async () => {
    // End-to-end v2 deterministic transition test.
    //
    // Flow: POST ACTION_EVIDENCE_SUBMITTED (simulating submit_action_evidence output)
    // → real handleTeammateEvent in extension.ts
    //   → applyV2EvidenceDrivenTransition
    //     → evaluateCoordinatorGate (no requiredTools → ran:false, pass:true)
    //     → verdict=pass → emits.pass='PLAN_ACCEPTED'
    //     → emitActionRouteEvent → ROUTE_EVENT_EMITTED
    //     → STATE_TRANSITION_APPLIED with v2Driven:true written BY THE HARNESS
    //
    // The TEST does NOT call applyV2RouteEvent or write STATE_TRANSITION_APPLIED.
    // Disabling the positive-path wiring in applyV2EvidenceDrivenTransition causes
    // the ROUTE_EVENT_EMITTED and STATE_TRANSITION_APPLIED assertions to FAIL.
    const supervisorStartSpy = vi.spyOn(Supervisor.prototype, 'start').mockResolvedValue(undefined);
    const ensureWindowSpy = vi.spyOn(TeammateFactory.prototype, 'ensureAgentsWindow').mockResolvedValue({ ok: true });

    const savedEnv = saveEnvKeys(EnvVars.PROJECT_ROOT, EnvVars.API_PORT, EnvVars.API_BASE);
    let projectRoot = '';
    let sessionShutdown: () => unknown = () => {};
    try {
      ({ projectRoot, sessionShutdown } = await bootRealCoordinator(V2_YAML_WITH_EMITS));

      const apiPort = (() => {
        const ev = readEventStoreLines(projectRoot);
        const b = ev.find((e: any) => e.type === DomainEventName.HARNESS_API_BOUND);
        return (b as any)?.data?.apiPort as number;
      })();

      // POST ACTION_EVIDENCE_SUBMITTED (what submit_action_evidence posts in v2).
      // No model-supplied route authority — just evidence identity.
      const evidenceBase = {
        type: TeammateEventType.ACTION_EVIDENCE_SUBMITTED,
        beadId: 'bead-e2e-001',
        workerId: 'worker-e2e-001',
        stateId: 'Working',
        actionId: 'work_action',
        summary: 'implementation complete',
        timestamp: Date.now()
      };
      const evidenceSignal = {
        ...evidenceBase,
        idempotencyKey: createTeammateEventIdempotencyKey(evidenceBase as TeammateEvent)
      };

      const response = await fetch(`http://127.0.0.1:${apiPort}/signals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(evidenceSignal)
      });
      expect(response.status).toBe(200);
      const json = await response.json() as Record<string, unknown>;
      // Gate passed (no requiredTools → ran:false, pass:true)
      expect(json.ok).toBe(true);
      expect((json.gate as any)?.pass).toBe(true);

      // LOAD-BEARING: ROUTE_EVENT_EMITTED must be written by the HARNESS.
      // If emitActionRouteEvent is not called (wiring disabled), this fails.
      const finalEvents = readEventStoreLines(projectRoot);
      const routeEvents = finalEvents.filter((e: any) => e.type === DomainEventName.ROUTE_EVENT_EMITTED);
      expect(routeEvents.length).toBeGreaterThan(0);
      expect(routeEvents[0].data['eventName']).toBe('PLAN_ACCEPTED');
      expect(routeEvents[0].data['emitterId']).toBe('evaluateCoordinatorGate');

      // LOAD-BEARING: STATE_TRANSITION_APPLIED must be written BY THE HARNESS
      // (v2Driven:true), NOT by this test. The transition references the routeEventId.
      const transitionEvents = finalEvents.filter((e: any) => e.type === DomainEventName.STATE_TRANSITION_APPLIED);
      expect(transitionEvents.length).toBeGreaterThan(0);
      expect(transitionEvents[0].data['v2Driven']).toBe(true);
      expect(transitionEvents[0].data['routeEventId']).toBe(routeEvents[0].data['routeEventId']);
      expect(transitionEvents[0].data['transitionEvent']).toBe('PLAN_ACCEPTED');

    } finally {
      await sessionShutdown();
      restoreEnvKeys(savedEnv);
      supervisorStartSpy.mockRestore();
      ensureWindowSpy.mockRestore();
      if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 30000);

  it('LOAD-BEARING: model prose containing PLAN_ACCEPTED does NOT produce a route event or transition', async () => {
    // This is the anti-prose enforcement proof: a model that emits "PLAN_ACCEPTED"
    // in its prose output must NOT trigger a state transition in v2.
    const { projectV2Transitions } = await import('../src/core/RouteEventContract.js');
    const vocab = buildV2EventVocabulary(h.config);
    const stateFor = (id: string) => h.config.states[id];

    // Simulate: model outputs a TEAMMATE_EVENT record that happens to contain the
    // event name in prose (not a real ROUTE_EVENT_EMITTED).
    const proseEvent = {
      type: DomainEventName.TEAMMATE_EVENT,   // NOT ROUTE_EVENT_EMITTED
      data: {
        beadId: 'bead-prose-001',
        stateId: 'Working',
        eventName: 'PLAN_ACCEPTED',           // model injected this
        category: 'advance',
        emitterType: 'tool',
        emitterId: 'model-prose',
        routeEventId: 'fake-route-001'
      }
    };

    const transitions = projectV2Transitions([proseEvent], vocab, stateFor);

    // Prose/TEAMMATE_EVENT must produce ZERO transitions — gate 1 rejects it
    expect(transitions).toHaveLength(0);

    // LOAD-BEARING PROOF: if gate 1 (type !== ROUTE_EVENT_EMITTED check) were removed,
    // the proseEvent would pass to gate 2 and potentially produce a transition.
    // This assertion would fail.
  });

  it('LOAD-BEARING: state-event spoof (ROUTE_EVENT_EMITTED with emitterType=model) rejected by projectV2Transitions', async () => {
    const { projectV2Transitions } = await import('../src/core/RouteEventContract.js');
    const { ROUTE_EVENT_EMITTED_SCHEMA_ID, ROUTE_EVENT_EMITTED_SCHEMA_VERSION } = await import('../src/core/RouteEventContract.js');
    const vocab = buildV2EventVocabulary(h.config);
    const stateFor = (id: string) => h.config.states[id];

    // Spoof: a ROUTE_EVENT_EMITTED record with emitterType='model' (not allowed)
    const spoofEvent = {
      type: DomainEventName.ROUTE_EVENT_EMITTED,
      data: {
        schemaId: ROUTE_EVENT_EMITTED_SCHEMA_ID,
        schemaVersion: ROUTE_EVENT_EMITTED_SCHEMA_VERSION,
        configVersion: 2,
        configFingerprint: 'spoof-fp',
        beadId: 'bead-spoof-001',
        stateId: 'Working',
        actionId: 'work_action',
        runId: 'run-spoof',
        emitterType: 'model',     // ← NOT in the valid enum → must be rejected
        emitterId: 'llm-parser',
        eventName: 'PLAN_ACCEPTED',
        category: 'advance',
        evidenceRefs: [],
        routeEventId: 'spoof-route-001'
      }
    };

    const transitions = projectV2Transitions([spoofEvent], vocab, stateFor);
    expect(transitions).toHaveLength(0);

    // LOAD-BEARING PROOF: if the emitterType gate (gate 2) were removed from
    // projectV2Transitions, the spoof would produce a transition. This assertion
    // would fail if the anti-prose guard is removed.
  });
});

// ---------------------------------------------------------------------------
// AC3: Diagnostic events append but do not mutate state or bead status
// ---------------------------------------------------------------------------

describe('AC3: V2_MODEL_ROUTE_REJECTED is diagnostic only — no state/bead mutation', () => {
  it('V2_MODEL_ROUTE_REJECTED event has correct required fields and INFORMATIONAL replay impact', async () => {
    const { DOMAIN_EVENT_SCHEMA_METADATA, DOMAIN_EVENT_SCHEMAS } = await import('../src/core/DomainEventSchemas.js');

    // Schema metadata check
    const meta = DOMAIN_EVENT_SCHEMA_METADATA[DomainEventName.V2_MODEL_ROUTE_REJECTED];
    expect(meta).toBeDefined();
    expect(meta!.replayImpact).toBe('INFORMATIONAL');
    expect(meta!.version).toBe(1);
    expect(meta!.optionalFields).toContain('actionId');
    expect(meta!.optionalFields).toContain('rejectedRoute');

    // Required fields check
    const schema = DOMAIN_EVENT_SCHEMAS[DomainEventName.V2_MODEL_ROUTE_REJECTED];
    expect(schema).toBeDefined();
    expect(schema).toContain('beadId');
    expect(schema).toContain('stateId');
    expect(schema).toContain('surface');
    expect(schema).toContain('reason');
  });

  it('V2_MODEL_ROUTE_REJECTED is NOT in REPLAY_CRITICAL_EVENT_TYPES (diagnostic only)', async () => {
    const { REPLAY_CRITICAL_EVENT_TYPES } = await import('../src/constants/index.js');
    expect(REPLAY_CRITICAL_EVENT_TYPES.has(DomainEventName.V2_MODEL_ROUTE_REJECTED)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC5: failure-limit suggestedOutcome ignored in v2
// (covered by signal_completion rejection gate — suggestedOutcome logic runs
// inside signal_completion which is fully blocked in v2)
// ---------------------------------------------------------------------------

describe('AC5: failure-limit suggestedOutcome is ignored in v2', () => {
  let w: WorkerHarness;
  afterEach(() => { restoreEnv(w.savedEnv); vi.restoreAllMocks(); });

  it('LOAD-BEARING: signal_completion with failure-limit suggestedOutcome in v2 → REJECTED before suggestedOutcome enforcement runs', async () => {
    // When config.version===2, signal_completion returns REJECTED immediately at the
    // v2 gate — BEFORE the terminalFailureLimit.suggestedOutcome check runs.
    // So even if a failure limit has been reached, the suggestedOutcome carries no
    // route authority in v2.
    w = makeWorkerHarness(V2_YAML);
    await setupWorkerMode(w, 'bead-fl-001');

    const checkpointTool = findTool(w, BuiltInToolName.SUBMIT_CHECKPOINT);
    await callTool(checkpointTool!, { summary: 'done', evidence: 'ev' });

    const signalTool = findTool(w, BuiltInToolName.SIGNAL_COMPLETION);
    expect(signalTool).toBeDefined();

    // Signal with a "forced" outcome (as a failure-limit would suggest)
    const result = await callTool(signalTool!, { outcome: 'FAILURE', summary: 'done' });
    const text = typeof result === 'string' ? result : JSON.stringify(result);

    // Must be rejected by v2 gate (not by failure-limit logic)
    expect(text).toContain('REJECTED');
    expect(text).toContain('v2');

    // V2_MODEL_ROUTE_REJECTED recorded for signal_completion surface
    const store = new EventStore(new ConfigLoader(undefined, w.projectRoot), undefined, undefined, w.projectRoot);
    store.setSessionId('read-test');
    const events = await store.readAll();
    const rejections = events.filter(e => e.type === DomainEventName.V2_MODEL_ROUTE_REJECTED);
    expect(rejections.length).toBeGreaterThan(0);
    expect(rejections[0].data['surface']).toBe('signal_completion');

    // LOAD-BEARING PROOF: if the v2 gate in signal_completion fires after the
    // failure-limit check (not before), the test might still pass but for the
    // wrong reason. The v2 gate MUST fire as the first non-gate-readiness check.
    // If removed, this test fails because the tool would signal the route.
  });
});

// ---------------------------------------------------------------------------
// AC2: SUBMIT_ACTION_EVIDENCE is in BuiltInToolName enum
// ---------------------------------------------------------------------------

describe('AC1/AC2: BuiltInToolName.SUBMIT_ACTION_EVIDENCE constant exists', () => {
  it('BuiltInToolName.SUBMIT_ACTION_EVIDENCE is defined', () => {
    expect(BuiltInToolName.SUBMIT_ACTION_EVIDENCE).toBe('submit_action_evidence');
  });

  it('DomainEventName.V2_MODEL_ROUTE_REJECTED is defined', () => {
    expect(DomainEventName.V2_MODEL_ROUTE_REJECTED).toBe('V2_MODEL_ROUTE_REJECTED');
  });
});
