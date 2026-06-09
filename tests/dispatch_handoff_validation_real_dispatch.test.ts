/**
 * pi-experiment-3b5e — Real-dispatch-path regression tests proving wiring fails closed.
 *
 * AC4 (load-bearing): Each test exercises the REAL production dispatch path at one of
 * the three validateHandoffPayload wiring sites and asserts the side effect DID NOT
 * OCCUR when the payload is malformed. If the wiring call were deleted, the side effect
 * WOULD occur and each test WOULD FAIL.
 *
 *   Site 1: terminalTransition
 *     Wired at: src/extension.ts handleTeammateEvent, STATE_TRANSITIONED branch,
 *     before `services.eventStore.record(STATE_TRANSITION_APPLIED, transitionEventData)`.
 *     Test: runs the full coordinator SignalingServer through orrElseExtension with
 *     injected providedServices that include a custom flowManager returning '' for
 *     nextState. The TERMINAL_TRANSITION schema requires nextState: minLength:1, so
 *     validateHandoffPayload returns {valid:false} → throws → STATE_TRANSITION_APPLIED
 *     is NOT recorded. If the wiring is deleted, no throw occurs and
 *     STATE_TRANSITION_APPLIED IS recorded — test fails.
 *
 *   Site 2: workerCompletion
 *     Wired at: src/extension.ts signal_completion tool execute,
 *     before `postWorkerSignal(services, event)`.
 *     Test: runs in worker mode with a config that declares customOutcomes: [''] so
 *     assertDeclaredOutcome('') passes (fwv9 strict vocab), and state.on['']='completed'
 *     so nextState resolves. Calls signal_completion with `outcome: ''` (empty string).
 *     isAdvanceOutcome('') = false (falsy) → advance gates skipped; checkpoint gate
 *     passes. The WORKER_COMPLETION schema requires outcome: minLength:1, so
 *     validateHandoffPayload throws before postWorkerSignal — the signal-ack server
 *     receives no STATE_TRANSITIONED event. If the wiring is deleted, postWorkerSignal
 *     IS called and the signal arrives.
 *
 *   Site 3: workerCommand
 *     Wired at: src/plugins/teammates.ts spawnTeammateInTmuxInner,
 *     before `this.eventStore.record(TEAMMATE_SPAWN_STARTED, ...)`.
 *     Test: calls spawnTeammateInTmux with an empty stateId ''. All pre-validation code
 *     runs normally (resolveLLMConfig etc. tolerate empty state), but the WORKER_COMMAND
 *     schema requires stateId: minLength:1. The wiring returns {success:false} before
 *     TEAMMATE_SPAWN_STARTED is recorded. If the wiring is deleted, TEAMMATE_SPAWN_STARTED
 *     IS recorded and the function returns {success:true} — test fails.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import orrElseExtension from '../src/extension.js';
import { BuiltInToolName, DomainEventName, PluginToolName, TeammateEventType } from '../src/constants/domain.js';
import { EnvVars, PiEventName, ProcessFlag } from '../src/constants/infra.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { EventStore } from '../src/core/EventStore.js';
import { Observability } from '../src/core/Observability.js';
import { FlowManager } from '../src/core/FlowManager.js';
import { TeammateFactory } from '../src/plugins/teammates.js';
import { createTeammateEventIdempotencyKey } from '../src/core/TeammateEvents.js';

// ─────────────────────────────────────────────────────────────────────────────
// Mock execa for Site 3 (TeammateFactory tmux calls)
// ─────────────────────────────────────────────────────────────────────────────

const { execaMockDisp, defaultTmuxRespDisp } = vi.hoisted(() => {
  const defaultTmuxRespDisp = async (bin: string, args: string[]) => {
    if (bin !== 'tmux') throw new Error(`unexpected binary: ${bin}`);
    if (args.includes('list-windows')) return { stdout: 'Agents\n', stderr: '' };
    if (args.includes('list-panes')) return { stdout: '', stderr: '' };
    if (args.includes('split-window')) return { stdout: '%1\n', stderr: '' };
    return { stdout: '', stderr: '' };
  };
  return {
    execaMockDisp: vi.fn(defaultTmuxRespDisp),
    defaultTmuxRespDisp
  };
});

vi.mock('execa', () => ({ execa: execaMockDisp }));

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

function fakePi() {
  const tools: any[] = [];
  const commands: Record<string, any> = {};
  const callbacks: Record<string, Function> = {};
  let activeTools: string[] = [];
  return {
    tools,
    commands,
    callbacks,
    pi: {
      on: (name: string, callback: Function) => { callbacks[name] = callback; },
      registerTool: (tool: any) => tools.push(tool),
      registerCommand: (name: string, options: any) => { commands[name] = options; },
      getActiveTools: () => activeTools,
      setActiveTools: (names: string[]) => { activeTools = names; },
      setThinkingLevel: () => {},
      setModel: async () => true,
      sendUserMessage: () => {}
    } as any
  };
}

const HEADLESS_TOOL_CONTEXT = { hasUI: false, shutdown: () => {} } as any;

async function startSignalAckServer(receivedEvents: unknown[], status = 200): Promise<Server> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (body) receivedEvents.push(JSON.parse(body));
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(status >= 200 && status < 300 ? { ok: true } : { error: 'rejected' }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, resolve));
  const address = server.address() as AddressInfo;
  process.env[EnvVars.API_BASE] = `http://127.0.0.1:${address.port}`;
  return server;
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close(err => err ? reject(err) : resolve());
  });
}

function captureEnv(...keys: string[]): Record<string, string | undefined> {
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

// ─────────────────────────────────────────────────────────────────────────────
// WORKER MODE YAML (for Site 2)
//
// state.on[''] = completed  lets nextState(state, '', stateId) return 'completed'
// so empty-string outcome passes the gate checks (isAdvanceOutcome('') = false,
// assertDeclaredOutcome in legacy mode = true, nextState resolves via on).
// But WORKER_COMPLETION schema rejects outcome: '' (minLength:1) — this is the
// wiring Site 2 protects.
// ─────────────────────────────────────────────────────────────────────────────

// fwv9: statechart block is mandatory and strict. customOutcomes: [''] permits the
// empty-string outcome key in state.on so that the empty-string trick survives vocab
// validation at config load time. At runtime, assertDeclaredOutcome('') passes ('' is
// in customOutcomes), but validateHandoffPayload(WORKER_COMPLETION) still rejects
// outcome:'' (minLength:1) — so Site 2 remains load-bearing.
const WORKER_COMPLETION_YAML = `
settings:
  startState: StateA
  worktreePolicy:
    default: always
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
  customOutcomes: ['']
states:
  StateA:
    identity:
      role: "Agent"
      expertise: "Work"
      constraints: []
    baseInstructions: "Do work"
    actions:
      - id: do-work
        type: prompt
        prompt: "Work"
    on:
      '': completed
    transitions:
      SUCCESS: completed
      FAILURE: StateA
`;

// ─────────────────────────────────────────────────────────────────────────────
// COORDINATOR YAML (for Site 1)
// ─────────────────────────────────────────────────────────────────────────────

// fwv9: statechart block is mandatory. SUCCESS→advance (nextState='completed'),
// FAILURE→failed (self-loop). The Site 1 negative test injects a flowManager that
// returns '' for nextState — the TERMINAL_TRANSITION schema (nextState:minLength:1)
// rejects the payload BEFORE STATE_TRANSITION_APPLIED is recorded.
const COORDINATOR_YAML = `
settings:
  startState: Planning
  worktreePolicy:
    default: always
  observability:
    enabled: false
  eventStore:
    enabled: false
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
states:
  Planning:
    identity:
      role: "Planner"
      expertise: "Planning"
      constraints: []
    baseInstructions: "Plan"
    actions:
      - id: formulate-plan
        type: prompt
        prompt: "Plan"
    requiredTools: []
    transitions:
      SUCCESS: completed
      FAILURE: Planning
`;

// ─────────────────────────────────────────────────────────────────────────────
// Build STATE_TRANSITIONED HTTP event for coordinator tests
// ─────────────────────────────────────────────────────────────────────────────

function makeTransitionEvent(
  beadId: string,
  stateId: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    type: TeammateEventType.STATE_TRANSITIONED,
    beadId,
    workerId: `worker-${beadId}-${stateId}`,
    stateId,
    actionId: 'formulate-plan',
    transitionEvent: 'SUCCESS',
    summary: 'All done.',
    evidence: 'All done.',
    handover: 'All done.',
    timestamp: Date.now(),
    ...overrides
  };
  return { ...base, idempotencyKey: createTeammateEventIdempotencyKey(base as any) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Site 1: terminalTransition — real handleTeammateEvent via coordinator HTTP
//
// Malformed payload: inject a custom flowManager that returns '' for nextState.
// The TERMINAL_TRANSITION schema requires nextState: minLength:1, so the wiring
// call at extension.ts:1930-1947 rejects the payload → throws → STATE_TRANSITION_APPLIED
// is NOT recorded. Deleting the wiring call makes the record happen — test fails.
// ─────────────────────────────────────────────────────────────────────────────

describe('Real-dispatch regression: terminalTransition wiring (Site 1)', () => {
  let projectRoot: string;
  let configLoader: ConfigLoader;
  let observability: Observability;
  let supervisorStartSpy: ReturnType<typeof vi.spyOn>;
  let ensureWindowSpy: ReturnType<typeof vi.spyOn>;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    savedEnv = captureEnv(
      EnvVars.WORKER_MODE, EnvVars.BEAD_ID, EnvVars.STATE_ID,
      EnvVars.PROJECT_ROOT, EnvVars.API_BASE, EnvVars.API_PORT
    );
    delete process.env[EnvVars.WORKER_MODE];
    // Use port 0 so the OS picks a free port — avoids conflict with any existing
    // Pi coordinator (e.g. the real Pi session running in this worktree).
    process.env[EnvVars.API_PORT] = '0';

    projectRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-3b5e-tt-'))
    );
    fs.writeFileSync(path.join(projectRoot, 'harness.yaml'), COORDINATOR_YAML);
    process.env[EnvVars.PROJECT_ROOT] = projectRoot;

    configLoader = new ConfigLoader(undefined, projectRoot);
    observability = new Observability(configLoader, undefined, projectRoot);
    await observability.initialize();

    const { Supervisor } = await import('../src/core/Supervisor.js');
    supervisorStartSpy = vi.spyOn(Supervisor.prototype, 'start').mockResolvedValue(undefined as any);
    ensureWindowSpy = vi.spyOn(TeammateFactory.prototype, 'ensureAgentsWindow').mockResolvedValue({ ok: true } as any);
  });

  afterEach(async () => {
    observability.shutdown();
    configLoader.reset();
    supervisorStartSpy.mockRestore();
    ensureWindowSpy.mockRestore();
    restoreEnv(savedEnv);
    if (projectRoot && fs.existsSync(projectRoot)) {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  /**
   * Builds minimal providedServices for the coordinator mode.
   *
   * - configLoader: real, pointing to COORDINATOR_YAML
   * - eventStore: mocked, tracks record() calls
   * - flowManager: can be overridden to return a malformed nextState
   * - plugins.bd: fake with BD_RELEASE and BD_GET_BEAD tools
   * - plugins.git: fake with MERGE_AND_COMMIT and REMOVE_WORKTREE tools
   */
  function makeCoordinatorServices(
    overrides: { flowManager?: Partial<FlowManager> } = {}
  ) {
    const recordedEvents: Array<{ event: string; data: unknown }> = [];
    const mockEventStore = {
      record: vi.fn(async (event: string, data: unknown) => {
        recordedEvents.push({ event, data });
      }),
      eventsForBead: vi.fn().mockResolvedValue([]),
      projectBead: vi.fn().mockResolvedValue(undefined),
      setSessionId: vi.fn(),
      readAll: vi.fn().mockResolvedValue([])
    };

    const realFlowManager = new FlowManager();
    const flowManager = overrides.flowManager
      ? Object.assign(Object.create(Object.getPrototypeOf(realFlowManager)), realFlowManager, overrides.flowManager)
      : realFlowManager;

    const fakeBd = {
      name: 'bd',
      tools: [
        { name: PluginToolName.BD_RELEASE, execute: vi.fn().mockResolvedValue({}) },
        { name: PluginToolName.BD_GET_BEAD, execute: vi.fn().mockResolvedValue({ completedActionIds: [] }) },
        { name: 'bd_update_status', execute: vi.fn().mockResolvedValue({}) }
      ]
    };

    const fakeGit = {
      name: 'git',
      tools: [
        { name: 'merge_and_commit', execute: vi.fn().mockResolvedValue({ success: true }) },
        { name: 'remove_worktree', execute: vi.fn().mockResolvedValue({}) }
      ]
    };

    const services = {
      configLoader,
      eventStore: mockEventStore,
      observability,
      flowManager,
      apiAddress: { port: '', base: '' },
      plugins: {
        bd: fakeBd,
        git: fakeGit,
        teammates: { name: 'teammates', tools: [] },
        mailbox: { name: 'mailbox', tools: [] },
        meta: { name: 'meta', tools: [] },
        quality: { name: 'quality', tools: [] },
        signaling: { name: 'signaling', tools: [] },
        beadsClientInvalidateCache: vi.fn()
      },
      projectRoot,
      artifactPaths: { ensureArtifactDirs: vi.fn() } as any,
      planWriteSet: {} as any,
      requiredToolResolver: {} as any,
      toolCallPathFactory: {} as any,
      scheduler: {} as any,
      fileMutationPolicy: {} as any,
      transactionalStateGuard: {} as any
    } as any;

    return { services, recordedEvents };
  }

  it('(negative) nextState="" — TERMINAL_TRANSITION schema rejects (minLength:1) → STATE_TRANSITION_APPLIED NOT recorded; if wiring deleted, test fails', async () => {
    const harness = fakePi();
    const beadId = 'bd-3b5e-tt-neg';

    // Inject a flowManager that returns empty string for nextState.
    // transitionEventData.nextState = '' fails TERMINAL_TRANSITION schema (minLength:1).
    const { services, recordedEvents } = makeCoordinatorServices({
      flowManager: {
        nextState: (_state: any, _outcome: string, _stateId?: string) => ''
      }
    });

    await orrElseExtension(harness.pi, services);
    await harness.callbacks[PiEventName.SESSION_START]?.({}, HEADLESS_TOOL_CONTEXT);

    const commandHandler = harness.commands[BuiltInToolName.ORR_ELSE]?.handler;
    await commandHandler(`--bead ${beadId}`, { hasUI: false } as any);

    const apiPort = services.apiAddress.port;
    expect(apiPort).toBeTruthy();

    // POST a well-formed STATE_TRANSITIONED event (passes SignalingServer validation),
    // but inside handleTeammateEvent the custom flowManager returns '' for nextState
    // → transitionEventData.nextState = '' → TERMINAL_TRANSITION schema fails.
    const event = makeTransitionEvent(beadId, 'Planning');
    const response = await fetch(`http://127.0.0.1:${apiPort}/signals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event)
    });
    expect(response.status).toBe(200);

    // Allow async signal chain to settle.
    await new Promise(resolve => setTimeout(resolve, 150));

    // STATE_TRANSITION_APPLIED must NOT be recorded — the wiring blocked it.
    const stateTransitionApplied = recordedEvents.filter(
      r => r.event === DomainEventName.STATE_TRANSITION_APPLIED
    );
    expect(stateTransitionApplied).toHaveLength(0);

    // TEAMMATE_EVENT IS recorded (always happens before the validation site),
    // confirming the event reached handleTeammateEvent and was processed up to the wiring.
    const teammateEvent = recordedEvents.filter(r => r.event === DomainEventName.TEAMMATE_EVENT);
    expect(teammateEvent.length).toBeGreaterThan(0);

    await harness.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
  });

  it('(positive) valid nextState — TERMINAL_TRANSITION schema passes → STATE_TRANSITION_APPLIED IS recorded', async () => {
    const harness = fakePi();
    const beadId = 'bd-3b5e-tt-pos';

    // Real flowManager — returns a valid nextState ('completed' for SUCCESS from Planning).
    const { services, recordedEvents } = makeCoordinatorServices();

    await orrElseExtension(harness.pi, services);
    await harness.callbacks[PiEventName.SESSION_START]?.({}, HEADLESS_TOOL_CONTEXT);

    const commandHandler = harness.commands[BuiltInToolName.ORR_ELSE]?.handler;
    await commandHandler(`--bead ${beadId}`, { hasUI: false } as any);

    const apiPort = services.apiAddress.port;
    expect(apiPort).toBeTruthy();

    // Valid event — all fields non-empty, nextState computed from real flowManager.
    const event = makeTransitionEvent(beadId, 'Planning');
    const response = await fetch(`http://127.0.0.1:${apiPort}/signals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event)
    });
    expect(response.status).toBe(200);

    await new Promise(resolve => setTimeout(resolve, 150));

    // STATE_TRANSITION_APPLIED MUST be recorded.
    const stateTransitionApplied = recordedEvents.filter(
      r => r.event === DomainEventName.STATE_TRANSITION_APPLIED
    );
    expect(stateTransitionApplied).toHaveLength(1);

    await harness.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Site 2: workerCompletion — real signal_completion tool via worker mode
//
// Malformed payload: outcome='' (empty string). Under fwv9:
//   customOutcomes:[''] in statechart → assertDeclaredOutcome('') passes;
//   isAdvanceOutcome('') = false → advance gates skipped;
//   state.on['']='completed' → nextState resolves (transitionValid=true);
//   checkpoint gate passes; validateHandoffPayload(WORKER_COMPLETION, {..., outcome:''})
//   → FAILS (minLength:1) → throws before postWorkerSignal.
// Deleting the wiring makes the signal reach the server.
// ─────────────────────────────────────────────────────────────────────────────

describe('Real-dispatch regression: workerCompletion wiring (Site 2)', () => {
  let tempRoot: string;
  let worktreePath: string;
  let server: Server | undefined;
  let harness: ReturnType<typeof fakePi> | undefined;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = captureEnv(
      EnvVars.WORKER_MODE, EnvVars.BEAD_ID, EnvVars.STATE_ID,
      EnvVars.ACTION_ID, EnvVars.PROJECT_ROOT, EnvVars.WORKTREE_PATH,
      EnvVars.API_BASE
    );
  });

  afterEach(async () => {
    try {
      await harness?.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
    } catch { /* best-effort */ }
    await closeServer(server);
    await new Promise(resolve => setTimeout(resolve, 25));
    restoreEnv(savedEnv);
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    harness = undefined;
    server = undefined;
  });

  async function setupWorkerEnv(beadId: string, stateId: string, actionId: string) {
    tempRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), `orr-else-3b5e-wc-${stateId.toLowerCase()}-`))
    );
    worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), WORKER_COMPLETION_YAML);

    process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
    process.env[EnvVars.BEAD_ID] = beadId;
    process.env[EnvVars.STATE_ID] = stateId;
    process.env[EnvVars.ACTION_ID] = actionId;
    process.env[EnvVars.PROJECT_ROOT] = tempRoot;
    process.env[EnvVars.WORKTREE_PATH] = worktreePath;
  }

  it('(negative) outcome="" — WORKER_COMPLETION schema rejects (minLength:1) → postWorkerSignal NOT called; if wiring deleted, test fails', async () => {
    const receivedEvents: unknown[] = [];
    server = await startSignalAckServer(receivedEvents);

    await setupWorkerEnv('bd-3b5e-wc-neg', 'StateA', 'do-work');
    harness = fakePi();

    await orrElseExtension(harness.pi);
    await harness.callbacks[PiEventName.SESSION_START]?.(
      {},
      { hasUI: false, cwd: tempRoot }
    );
    await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.(
      { systemPrompt: '' },
      { hasUI: false, cwd: worktreePath }
    );

    const submitCheckpoint = harness.tools.find(
      (t: any) => t.name === BuiltInToolName.SUBMIT_CHECKPOINT
    );
    const signalCompletion = harness.tools.find(
      (t: any) => t.name === BuiltInToolName.SIGNAL_COMPLETION
    );

    // Satisfy the checkpoint gate.
    await submitCheckpoint.execute(
      'checkpoint-wc-neg',
      { summary: 'Work done.', evidence: 'Done.' },
      undefined, undefined, HEADLESS_TOOL_CONTEXT
    );

    // Call signal_completion with outcome='' (empty string).
    // Flow through production code under fwv9:
    //   1. TypeBox Type.String() accepts '' (no minLength on the tool parameter).
    //   2. assertDeclaredOutcome('', config) passes — '' is in customOutcomes.
    //   3. nextState(state, '', 'StateA') resolves via state.on[''] = 'completed'.
    //   4. isAdvanceOutcome('', config) = false (falsy) → advance gates skip.
    //   5. checkpointAccepted = true → checkpoint gate passes.
    //   6. buildWorkerEvent(STATE_FAILED, {...}) → event.workerId is non-empty.
    //   7. validateHandoffPayload(WORKER_COMPLETION, {..., outcome:''}) → FAILS (minLength:1).
    //   8. Code throws before postWorkerSignal — wrapPluginTool returns error result.
    const completionResult = await signalCompletion.execute(
      'signal-wc-neg',
      { outcome: '', summary: 'Attempted signal with empty outcome.' },
      undefined, undefined, HEADLESS_TOOL_CONTEXT
    );

    // wrapPluginTool catches the throw → returns error result, NOT success.
    expect(completionResult.details).not.toContain('Completion signaled with outcome:');

    // postWorkerSignal was NOT called — signal-ack server received no STATE_TRANSITIONED.
    await new Promise(resolve => setTimeout(resolve, 50));
    const transitionedEvents = (receivedEvents as any[]).filter(
      (e: any) => e.type === TeammateEventType.STATE_TRANSITIONED
    );
    expect(transitionedEvents).toHaveLength(0);
  });

  it('(positive) outcome="SUCCESS" — WORKER_COMPLETION schema passes → postWorkerSignal IS called', async () => {
    const receivedEvents: unknown[] = [];
    server = await startSignalAckServer(receivedEvents);

    await setupWorkerEnv('bd-3b5e-wc-pos', 'StateA', 'do-work');
    harness = fakePi();

    await orrElseExtension(harness.pi);
    await harness.callbacks[PiEventName.SESSION_START]?.(
      {},
      { hasUI: false, cwd: tempRoot }
    );
    await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.(
      { systemPrompt: '' },
      { hasUI: false, cwd: worktreePath }
    );

    const submitCheckpoint = harness.tools.find(
      (t: any) => t.name === BuiltInToolName.SUBMIT_CHECKPOINT
    );
    const signalCompletion = harness.tools.find(
      (t: any) => t.name === BuiltInToolName.SIGNAL_COMPLETION
    );

    await submitCheckpoint.execute(
      'checkpoint-wc-pos',
      { summary: 'Work done.', evidence: 'Done.' },
      undefined, undefined, HEADLESS_TOOL_CONTEXT
    );

    const completionResult = await signalCompletion.execute(
      'signal-wc-pos',
      { outcome: 'SUCCESS', summary: 'StateA complete.' },
      undefined, undefined, HEADLESS_TOOL_CONTEXT
    );

    // Valid outcome 'SUCCESS' passes WORKER_COMPLETION schema → postWorkerSignal IS called.
    expect(completionResult.details).toContain('Completion signaled with outcome: SUCCESS');

    await new Promise(resolve => setTimeout(resolve, 50));
    const transitionedEvents = (receivedEvents as any[]).filter(
      (e: any) => e.type === TeammateEventType.STATE_TRANSITIONED
    );
    expect(transitionedEvents).toHaveLength(1);
    expect(transitionedEvents[0]).toMatchObject({
      beadId: 'bd-3b5e-wc-pos',
      stateId: 'StateA',
      transitionEvent: 'SUCCESS'
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Site 3: workerCommand — real spawnTeammateInTmuxInner via TeammateFactory
//
// Malformed payload: stateId='' (empty string). All pre-validation code runs
// normally (resolveLLMConfig, tmux list-windows, etc.). The WORKER_COMMAND wiring
// at teammates.ts:778-796 rejects stateId:'' (minLength:1) and returns
// {success:false} before recording TEAMMATE_SPAWN_STARTED. Deleting the wiring
// makes TEAMMATE_SPAWN_STARTED be recorded and the function return {success:true}.
// ─────────────────────────────────────────────────────────────────────────────

describe('Real-dispatch regression: workerCommand wiring (Site 3)', () => {
  const wc3Root = path.join(os.tmpdir(), 'orr-else-3b5e-wc3');
  const wc3WorktreePath = path.join(wc3Root, 'worktrees', 'pi-experiment-wc3');
  const wc3ConfigPath = path.join(wc3Root, 'harness.yaml');
  const wc3ExtPath = path.join(wc3Root, 'orr-else-ext.ts');
  let wc3ConfigLoader: ConfigLoader;
  let wc3Observability: Observability;
  let savedProjectRoot: string | undefined;

  beforeEach(async () => {
    fs.mkdirSync(path.join(wc3Root, 'state', 'logs'), { recursive: true });
    fs.mkdirSync(wc3WorktreePath, { recursive: true });
    fs.writeFileSync(wc3ExtPath, 'export default {};\n');
    savedProjectRoot = process.env[EnvVars.PROJECT_ROOT];
    process.env[EnvVars.PROJECT_ROOT] = wc3Root;

    // fwv9: statechart block is mandatory; Planning must have ≥1 action (AC2).
    // stateId='' is passed to spawnTeammateInTmux — this survives resolveLLMConfig
    // and all pre-spawn code, then fails validateHandoffPayload(WORKER_COMMAND) at
    // line 778 (stateId:minLength:1). The spawn is blocked before TEAMMATE_SPAWN_STARTED.
    fs.writeFileSync(wc3ConfigPath, `
settings:
  maxConcurrentSlots: 2
  startState: Planning
  worktreePolicy:
    default: always
  eventStore:
    enabled: false
  observability:
    enabled: false
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
states:
  Planning:
    identity: { role: planner, expertise: planning, constraints: [] }
    baseInstructions: plan
    actions:
      - id: formulate-plan
        type: prompt
        prompt: "Plan"
    transitions: { SUCCESS: completed }
`);

    wc3ConfigLoader = new ConfigLoader(undefined, wc3Root);
    wc3ConfigLoader.setConfigPath(wc3ConfigPath);
    wc3Observability = new Observability(wc3ConfigLoader, undefined, wc3Root);
    await wc3Observability.initialize();

    vi.mocked(execaMockDisp).mockReset();
    vi.mocked(execaMockDisp).mockImplementation(defaultTmuxRespDisp);
  });

  afterEach(() => {
    wc3Observability.shutdown();
    wc3ConfigLoader.reset();
    if (savedProjectRoot === undefined) delete process.env[EnvVars.PROJECT_ROOT];
    else process.env[EnvVars.PROJECT_ROOT] = savedProjectRoot;
    vi.restoreAllMocks();
    fs.rmSync(wc3Root, { recursive: true, force: true });
  });

  it('(negative) stateId="" — WORKER_COMMAND schema rejects (minLength:1) → {success:false} AND TEAMMATE_SPAWN_STARTED NOT recorded; if wiring deleted, test fails', async () => {
    const records: Array<{ event: string; data: any }> = [];
    const factory = new TeammateFactory(
      wc3Observability,
      wc3ConfigLoader,
      { record: vi.fn(async (event: string, data: any) => records.push({ event, data })) } as any,
      {},
      6,
      undefined,
      wc3ExtPath
    );

    // spawnTeammateInTmux with stateId='':
    //   - assertSafeBeadId('pi-experiment-wc3') passes.
    //   - worktreePath is non-empty → passes.
    //   - ensureAgentsWindow (mocked) → ok: true.
    //   - getAvailableSlots (tmux list-panes mock) → slots > 0.
    //   - resolveLLMConfig('', config) → uses defaults (state undefined).
    //   - resolveWorkerExtensionPaths, resolvePiSkillPathsForState → fine with ''.
    //   - Build workerId, env, args, command (all OK with empty stateId in the string).
    //   - validateHandoffPayload(WORKER_COMMAND, {beadId, stateId:'', workerId}) FAILS.
    //     stateId:'' fails schema requirement minLength:1.
    //   - Returns {success:false} BEFORE recording TEAMMATE_SPAWN_STARTED.
    const result = await factory.spawnTeammateInTmux(
      'pi-experiment-wc3' as any,
      '',  // malformed: empty stateId
      wc3WorktreePath
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Handoff schema violation');
    expect(result.error).toContain(PluginToolName.WORKER_COMMAND ?? 'harness.handoff.workerCommand');

    // TEAMMATE_SPAWN_STARTED must NOT be recorded.
    const spawnStarted = records.filter(r => r.event === DomainEventName.TEAMMATE_SPAWN_STARTED);
    expect(spawnStarted).toHaveLength(0);

    // No tmux split-window was issued.
    const splitCall = vi.mocked(execaMockDisp).mock.calls.find(
      ([, args]) => (args as string[]).includes('split-window')
    );
    expect(splitCall).toBeUndefined();
  });

  it('(positive) stateId="Planning" — WORKER_COMMAND schema passes → {success:true} AND TEAMMATE_SPAWN_STARTED IS recorded', async () => {
    const records: Array<{ event: string; data: any }> = [];
    const factory = new TeammateFactory(
      wc3Observability,
      wc3ConfigLoader,
      { record: vi.fn(async (event: string, data: any) => records.push({ event, data })) } as any,
      {},
      6,
      undefined,
      wc3ExtPath
    );

    const result = await factory.spawnTeammateInTmux(
      'pi-experiment-wc3' as any,
      'Planning',
      wc3WorktreePath
    );

    expect(result.success).toBe(true);

    // TEAMMATE_SPAWN_STARTED MUST be recorded.
    const spawnStarted = records.filter(r => r.event === DomainEventName.TEAMMATE_SPAWN_STARTED);
    expect(spawnStarted).toHaveLength(1);
    expect(spawnStarted[0].data).toMatchObject({
      beadId: 'pi-experiment-wc3',
      stateId: 'Planning'
    });
  });
});
