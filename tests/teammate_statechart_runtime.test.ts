/**
 * teammate_statechart_runtime.test.ts
 *
 * Integration proof: teammate (worker) mode drives a FAKE two-state statechart
 * and emits the expected typed event sequence — no live Pi/tmux required.
 *
 * FAKE CONFIG (two-state):
 *   StateA  --SUCCESS-->  StateB  --SUCCESS-->  completed (terminal)
 *   StateA  --FAILURE-->  StateA
 *   StateA  --BLOCKED-->  StateA
 *   StateB  --FAILURE-->  StateB
 *   StateA has mandatory checklist items.
 *
 * ACCEPTANCE CRITERIA
 * AC-1  Worker-mode detection: with PI_ORR_ELSE_WORKER + PI_BEAD_ID + PI_STATE_ID
 *        set, the extension registers the worker tools (submit_checkpoint,
 *        signal_completion, request_context_restart) and enters teammate mode.
 * AC-2  submit_checkpoint → emits CHECKPOINT_ACCEPTED; checkpointAccepted = true.
 * AC-3  signal_completion({outcome:'SUCCESS'}) → emits STATE_TRANSITIONED with
 *        transitionEvent='SUCCESS'.  The teammate validates the transition via
 *        evaluateGateReadiness (flowManager.nextState) using the YAML config before
 *        emitting — nextState='StateB' is derived from StateA.transitions.SUCCESS.
 *        NOTE: nextState is NOT included in the worker-emitted signal (it is a
 *        coordinator-side enrichment computed when the coordinator processes the
 *        received event); the worker emits {type:STATE_TRANSITIONED, transitionEvent}
 *        which is sufficient proof that the worker owns the transition locally.
 * AC-4  Distinct outcome paths:
 *        signal_completion({outcome:'FAILURE'}) → STATE_FAILED
 *        signal_completion({outcome:'BLOCKED'}) → STATE_BLOCKED
 *        request_context_restart               → CONTEXT_RESTART_REQUESTED
 *        Each carries handover/summary data.
 * AC-5  All events are captured from the WORKER side (via the stubbed HTTP
 *        signal-ack server), proving the teammate emits the typed transition events
 *        locally — the coordinator is NOT needed to compute the teammate's
 *        transition (Reading A holds).
 */

import { describe, expect, it, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import orrElseExtension from '../src/extension.js';
import {
  BuiltInToolName,
  EnvVars,
  PiEventName,
  ProcessFlag
} from '../src/constants/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Minimal fake Pi surface (mirrors pi_extension.test.ts)
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

// ─────────────────────────────────────────────────────────────────────────────
// Signal-ack HTTP server (mirrors pi_extension.test.ts)
// ─────────────────────────────────────────────────────────────────────────────

async function startSignalAckServer(
  receivedEvents: unknown[],
  status = 200
): Promise<Server> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (body) receivedEvents.push(JSON.parse(body));
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify(status >= 200 && status < 300 ? { ok: true } : { error: 'rejected' })
      );
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
    server.close(error => (error ? reject(error) : resolve()));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Fake two-state harness YAML
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Two-state statechart:
 *   StateA --SUCCESS--> StateB --SUCCESS--> completed (terminal)
 *   StateA --FAILURE--> StateA
 *   StateA --BLOCKED--> StateA
 *   StateB --FAILURE--> StateB
 *
 * StateA has two mandatory checklist items so we can exercise the checklist gate.
 * No transactionalState, no write-set, no validationGates — keeps all
 * advance-outcome sub-gates trivially passing except the checklist gate.
 */
const FAKE_TWO_STATE_YAML = `
settings:
  startState: StateA
  worktreePolicy:
    default: always
states:
  StateA:
    identity:
      role: "Fake StateA Agent"
      expertise: "StateA tasks"
      constraints: []
    baseInstructions: "Do StateA work"
    actions:
      - id: state-a-action
        type: prompt
        prompt: "Execute StateA"
    checklist:
      - text: "StateA item one"
        mandatory: true
      - text: "StateA item two"
        mandatory: true
    transitions:
      SUCCESS: StateB
      FAILURE: StateA
      BLOCKED: StateA
  StateB:
    identity:
      role: "Fake StateB Agent"
      expertise: "StateB tasks"
      constraints: []
    baseInstructions: "Do StateB work"
    actions:
      - id: state-b-action
        type: prompt
        prompt: "Execute StateB"
    transitions:
      SUCCESS: completed
      FAILURE: StateB
`;

// ─────────────────────────────────────────────────────────────────────────────
// Test fixture setup / teardown helpers
// ─────────────────────────────────────────────────────────────────────────────

interface TestEnv {
  tempRoot: string;
  worktreePath: string;
  previousCwd: string;
  previousEnv: Record<string, string | undefined>;
}

function captureEnv(): Record<string, string | undefined> {
  return {
    [EnvVars.WORKER_MODE]: process.env[EnvVars.WORKER_MODE],
    [EnvVars.BEAD_ID]: process.env[EnvVars.BEAD_ID],
    [EnvVars.STATE_ID]: process.env[EnvVars.STATE_ID],
    [EnvVars.ACTION_ID]: process.env[EnvVars.ACTION_ID],
    [EnvVars.PROJECT_ROOT]: process.env[EnvVars.PROJECT_ROOT],
    [EnvVars.WORKTREE_PATH]: process.env[EnvVars.WORKTREE_PATH],
    [EnvVars.API_BASE]: process.env[EnvVars.API_BASE]
  };
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function createTestEnv(beadId: string, stateId: string, actionId: string): TestEnv {
  const previousCwd = process.cwd();
  const previousEnv = captureEnv();

  const tempRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), `orr-else-statechart-${stateId.toLowerCase()}-`))
  );
  const worktreePath = path.join(tempRoot, 'worktree');
  fs.mkdirSync(worktreePath);
  fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), FAKE_TWO_STATE_YAML);

  process.chdir(tempRoot);
  process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
  process.env[EnvVars.BEAD_ID] = beadId;
  process.env[EnvVars.STATE_ID] = stateId;
  process.env[EnvVars.ACTION_ID] = actionId;
  process.env[EnvVars.PROJECT_ROOT] = tempRoot;
  process.env[EnvVars.WORKTREE_PATH] = worktreePath;

  return { tempRoot, worktreePath, previousCwd, previousEnv };
}

async function cleanupTestEnv(
  env: TestEnv | undefined,
  harness: ReturnType<typeof fakePi> | undefined,
  server: Server | undefined
): Promise<void> {
  if (harness) {
    try {
      await harness.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
    } catch { /* best-effort */ }
  }
  await closeServer(server);
  await new Promise(resolve => setTimeout(resolve, 25));
  if (env) {
    process.chdir(env.previousCwd);
    restoreEnv(env.previousEnv);
    fs.rmSync(env.tempRoot, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Teammate statechart runtime (two-state fake config)', () => {
  // Track resources for cleanup even when a test throws.
  let currentEnv: TestEnv | undefined;
  let currentHarness: ReturnType<typeof fakePi> | undefined;
  let currentServer: Server | undefined;

  afterEach(async () => {
    await cleanupTestEnv(currentEnv, currentHarness, currentServer);
    currentEnv = undefined;
    currentHarness = undefined;
    currentServer = undefined;
  });

  // ── AC-1: Worker-mode detection ────────────────────────────────────────────

  it('AC-1: detects worker mode and registers teammate tools (not coordinator)', async () => {
    currentEnv = createTestEnv('bd-statechart-ac1', 'StateA', 'state-a-action');
    const receivedEvents: unknown[] = [];
    currentServer = await startSignalAckServer(receivedEvents);
    currentHarness = fakePi();

    await orrElseExtension(currentHarness.pi);
    await currentHarness.callbacks[PiEventName.SESSION_START]?.(
      {},
      { hasUI: false, cwd: currentEnv.tempRoot }
    );

    const toolNames = currentHarness.tools.map((t: any) => t.name);

    // Worker tools registered
    expect(toolNames).toContain(BuiltInToolName.SUBMIT_CHECKPOINT);
    expect(toolNames).toContain(BuiltInToolName.SIGNAL_COMPLETION);
    expect(toolNames).toContain(BuiltInToolName.REQUEST_CONTEXT_RESTART);

    // Coordinator command should NOT be registered as a Pi command
    // (orr-else CLI command is registered in non-worker mode as the coordinator entry)
    // The harness_status tool is present (worker observability tool)
    expect(toolNames).toContain(BuiltInToolName.HARNESS_STATUS);

    const harnessStatus = currentHarness.tools.find(
      (t: any) => t.name === BuiltInToolName.HARNESS_STATUS
    );
    const status = await harnessStatus.execute(
      'status-ac1',
      {},
      undefined,
      undefined,
      HEADLESS_TOOL_CONTEXT
    );

    // Confirm the extension reports this session as teammate mode
    expect(status.details).toMatchObject({
      mode: 'teammate',
      beadId: 'bd-statechart-ac1',
      stateId: 'StateA'
    });
  });

  // ── AC-2: submit_checkpoint emits CHECKPOINT_ACCEPTED ─────────────────────

  it('AC-2: submit_checkpoint emits CHECKPOINT_ACCEPTED and sets checkpointAccepted', async () => {
    currentEnv = createTestEnv('bd-statechart-ac2', 'StateA', 'state-a-action');
    const receivedEvents: unknown[] = [];
    currentServer = await startSignalAckServer(receivedEvents);
    currentHarness = fakePi();

    await orrElseExtension(currentHarness.pi);
    await currentHarness.callbacks[PiEventName.SESSION_START]?.(
      {},
      { hasUI: false, cwd: currentEnv.tempRoot }
    );
    await currentHarness.callbacks[PiEventName.BEFORE_AGENT_START]?.(
      { systemPrompt: '' },
      { hasUI: false, cwd: currentEnv.worktreePath }
    );

    const submitCheckpoint = currentHarness.tools.find(
      (t: any) => t.name === BuiltInToolName.SUBMIT_CHECKPOINT
    );
    const harnessStatus = currentHarness.tools.find(
      (t: any) => t.name === BuiltInToolName.HARNESS_STATUS
    );

    // Before checkpoint: checkpointAccepted should be false
    const statusBefore = await harnessStatus.execute(
      'status-before',
      {},
      undefined,
      undefined,
      HEADLESS_TOOL_CONTEXT
    );
    expect(statusBefore.details.checkpoint).toMatchObject({ accepted: false });

    const checkpointResult = await submitCheckpoint.execute(
      'submit-cp-ac2',
      { summary: 'StateA progress summary', evidence: 'StateA evidence details' },
      undefined,
      undefined,
      HEADLESS_TOOL_CONTEXT
    );

    expect(checkpointResult.details).toBe('Checkpoint accepted and recorded.');

    // The worker emits CHECKPOINT_ACCEPTED to the coordinator via HTTP signal
    expect(receivedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'CHECKPOINT_ACCEPTED',
          beadId: 'bd-statechart-ac2',
          stateId: 'StateA'
        })
      ])
    );

    // Harness status now reflects accepted checkpoint
    const statusAfter = await harnessStatus.execute(
      'status-after',
      {},
      undefined,
      undefined,
      HEADLESS_TOOL_CONTEXT
    );
    expect(statusAfter.details.checkpoint).toMatchObject({ accepted: true });
  });

  // ── AC-3: SUCCESS → STATE_TRANSITIONED (Reading A: worker validates + emits) ─

  it('AC-3: signal_completion SUCCESS emits STATE_TRANSITIONED with transitionEvent SUCCESS', async () => {
    currentEnv = createTestEnv('bd-statechart-ac3', 'StateA', 'state-a-action');
    const receivedEvents: unknown[] = [];
    currentServer = await startSignalAckServer(receivedEvents);
    currentHarness = fakePi();

    await orrElseExtension(currentHarness.pi);
    await currentHarness.callbacks[PiEventName.SESSION_START]?.(
      {},
      { hasUI: false, cwd: currentEnv.tempRoot }
    );
    await currentHarness.callbacks[PiEventName.BEFORE_AGENT_START]?.(
      { systemPrompt: '' },
      { hasUI: false, cwd: currentEnv.worktreePath }
    );

    const tickItems = currentHarness.tools.find(
      (t: any) => t.name === BuiltInToolName.TICK_ITEMS
    );
    const submitCheckpoint = currentHarness.tools.find(
      (t: any) => t.name === BuiltInToolName.SUBMIT_CHECKPOINT
    );
    const signalCompletion = currentHarness.tools.find(
      (t: any) => t.name === BuiltInToolName.SIGNAL_COMPLETION
    );

    // Gate check: without checklist + checkpoint, SUCCESS should be rejected
    const prematureSuccess = await signalCompletion.execute(
      'premature-success',
      { outcome: 'SUCCESS', summary: 'not yet' },
      undefined,
      undefined,
      HEADLESS_TOOL_CONTEXT
    );
    // Checklist gate fires first (before checkpoint gate for advance outcomes)
    expect(prematureSuccess.details).toContain('REJECTED');

    // Satisfy mandatory checklist items on StateA
    const tickResult = await tickItems.execute(
      'tick-checklist',
      {
        items: [
          { text: 'StateA item one', evidence: 'Evidence for item one' },
          { text: 'StateA item two', evidence: 'Evidence for item two' }
        ]
      },
      undefined,
      undefined,
      HEADLESS_TOOL_CONTEXT
    );
    // tickItems returns {status, ...} wrapped in {details, content} by wrapPluginTool
    expect(tickResult.details?.status).toBe('PASSED');

    // Submit checkpoint (required before any signal_completion)
    const checkpointResult = await submitCheckpoint.execute(
      'checkpoint-ac3',
      {
        summary: 'StateA complete, transitioning to StateB',
        evidence: 'All StateA items ticked'
      },
      undefined,
      undefined,
      HEADLESS_TOOL_CONTEXT
    );
    expect(checkpointResult.details).toBe('Checkpoint accepted and recorded.');

    // Signal SUCCESS — the teammate validates the transition via flowManager.nextState
    // (StateA.transitions.SUCCESS = 'StateB') before emitting the event.
    const completionResult = await signalCompletion.execute(
      'signal-success-ac3',
      { outcome: 'SUCCESS', summary: 'StateA work complete, ready for StateB' },
      undefined,
      undefined,
      HEADLESS_TOOL_CONTEXT
    );
    expect(completionResult.details).toContain('Completion signaled with outcome: SUCCESS');

    // The worker EMITS STATE_TRANSITIONED to the coordinator HTTP endpoint.
    // The event carries:
    //   - type:            STATE_TRANSITIONED
    //   - transitionEvent: 'SUCCESS'  (the outcome the worker chose)
    //   - stateId:         'StateA'   (the state the worker was in)
    //   - beadId:          'bd-statechart-ac3'
    //
    // NOTE: nextState ('StateB') is NOT included in the worker-emitted signal.
    // It is derived by the coordinator from StateA.transitions.SUCCESS when it
    // processes the received event — this is the coordinator-side enrichment.
    // The worker proves its statechart ownership by VALIDATING the transition
    // before emitting (evaluateGateReadiness calls flowManager.nextState and
    // rejects invalid outcomes), then emitting the correct typed event.
    expect(receivedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'CHECKPOINT_ACCEPTED' }),
        expect.objectContaining({
          type: 'STATE_TRANSITIONED',
          transitionEvent: 'SUCCESS',
          stateId: 'StateA',
          beadId: 'bd-statechart-ac3'
        })
      ])
    );

    // Confirm event ordering: CHECKPOINT_ACCEPTED before STATE_TRANSITIONED
    const checkpointIdx = (receivedEvents as any[]).findIndex(
      (e: any) => e.type === 'CHECKPOINT_ACCEPTED'
    );
    const transitionIdx = (receivedEvents as any[]).findIndex(
      (e: any) => e.type === 'STATE_TRANSITIONED'
    );
    expect(checkpointIdx).toBeGreaterThanOrEqual(0);
    expect(transitionIdx).toBeGreaterThan(checkpointIdx);
  });

  // ── AC-4a: FAILURE → STATE_FAILED ─────────────────────────────────────────

  it('AC-4a: signal_completion FAILURE emits STATE_FAILED with handover data', async () => {
    currentEnv = createTestEnv('bd-statechart-ac4a', 'StateA', 'state-a-action');
    const receivedEvents: unknown[] = [];
    currentServer = await startSignalAckServer(receivedEvents);
    currentHarness = fakePi();

    await orrElseExtension(currentHarness.pi);
    await currentHarness.callbacks[PiEventName.SESSION_START]?.(
      {},
      { hasUI: false, cwd: currentEnv.tempRoot }
    );
    await currentHarness.callbacks[PiEventName.BEFORE_AGENT_START]?.(
      { systemPrompt: '' },
      { hasUI: false, cwd: currentEnv.worktreePath }
    );

    const submitCheckpoint = currentHarness.tools.find(
      (t: any) => t.name === BuiltInToolName.SUBMIT_CHECKPOINT
    );
    const signalCompletion = currentHarness.tools.find(
      (t: any) => t.name === BuiltInToolName.SIGNAL_COMPLETION
    );

    // FAILURE is not an advance outcome → no checklist gate, but checkpoint is
    // still required before any signal_completion.
    const noCheckpointResult = await signalCompletion.execute(
      'failure-no-checkpoint',
      { outcome: 'FAILURE', summary: 'failed without checkpoint' },
      undefined,
      undefined,
      HEADLESS_TOOL_CONTEXT
    );
    expect(noCheckpointResult.details).toContain('REJECTED: You must call `submit_checkpoint`');

    await submitCheckpoint.execute(
      'checkpoint-ac4a',
      { summary: 'StateA hit a blocker', evidence: 'Detailed failure evidence' },
      undefined,
      undefined,
      HEADLESS_TOOL_CONTEXT
    );

    const failureResult = await signalCompletion.execute(
      'signal-failure-ac4a',
      { outcome: 'FAILURE', summary: 'StateA could not complete — retry needed' },
      undefined,
      undefined,
      HEADLESS_TOOL_CONTEXT
    );
    expect(failureResult.details).toContain('Completion signaled with outcome: FAILURE');

    // Worker emits STATE_FAILED — no coordinator needed for this typing decision.
    expect(receivedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'CHECKPOINT_ACCEPTED' }),
        expect.objectContaining({
          type: 'STATE_FAILED',
          transitionEvent: 'FAILURE',
          stateId: 'StateA',
          beadId: 'bd-statechart-ac4a',
          summary: 'StateA could not complete — retry needed'
        })
      ])
    );
  });

  // ── AC-4b: BLOCKED → STATE_BLOCKED ────────────────────────────────────────

  it('AC-4b: signal_completion BLOCKED emits STATE_BLOCKED with handover data', async () => {
    currentEnv = createTestEnv('bd-statechart-ac4b', 'StateA', 'state-a-action');
    const receivedEvents: unknown[] = [];
    currentServer = await startSignalAckServer(receivedEvents);
    currentHarness = fakePi();

    await orrElseExtension(currentHarness.pi);
    await currentHarness.callbacks[PiEventName.SESSION_START]?.(
      {},
      { hasUI: false, cwd: currentEnv.tempRoot }
    );
    await currentHarness.callbacks[PiEventName.BEFORE_AGENT_START]?.(
      { systemPrompt: '' },
      { hasUI: false, cwd: currentEnv.worktreePath }
    );

    const submitCheckpoint = currentHarness.tools.find(
      (t: any) => t.name === BuiltInToolName.SUBMIT_CHECKPOINT
    );
    const signalCompletion = currentHarness.tools.find(
      (t: any) => t.name === BuiltInToolName.SIGNAL_COMPLETION
    );

    await submitCheckpoint.execute(
      'checkpoint-ac4b',
      { summary: 'StateA blocked on dependency', evidence: 'Blocker evidence' },
      undefined,
      undefined,
      HEADLESS_TOOL_CONTEXT
    );

    const blockedResult = await signalCompletion.execute(
      'signal-blocked-ac4b',
      { outcome: 'BLOCKED', summary: 'StateA is blocked on an external dependency' },
      undefined,
      undefined,
      HEADLESS_TOOL_CONTEXT
    );
    expect(blockedResult.details).toContain('Completion signaled with outcome: BLOCKED');

    // Worker emits STATE_BLOCKED directly — no coordinator required.
    expect(receivedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'STATE_BLOCKED',
          transitionEvent: 'BLOCKED',
          stateId: 'StateA',
          beadId: 'bd-statechart-ac4b',
          summary: 'StateA is blocked on an external dependency'
        })
      ])
    );
  });

  // ── AC-4c: request_context_restart → CONTEXT_RESTART_REQUESTED ────────────

  it('AC-4c: request_context_restart emits CONTEXT_RESTART_REQUESTED with handover', async () => {
    currentEnv = createTestEnv('bd-statechart-ac4c', 'StateA', 'state-a-action');
    const receivedEvents: unknown[] = [];
    currentServer = await startSignalAckServer(receivedEvents);
    currentHarness = fakePi();

    await orrElseExtension(currentHarness.pi);
    await currentHarness.callbacks[PiEventName.SESSION_START]?.(
      {},
      { hasUI: false, cwd: currentEnv.tempRoot }
    );
    await currentHarness.callbacks[PiEventName.BEFORE_AGENT_START]?.(
      { systemPrompt: '' },
      { hasUI: false, cwd: currentEnv.worktreePath }
    );

    const requestContextRestart = currentHarness.tools.find(
      (t: any) => t.name === BuiltInToolName.REQUEST_CONTEXT_RESTART
    );

    // request_context_restart does NOT require a prior checkpoint — the session
    // is being abandoned for a fresh context, not signaling work completion.
    const restartResult = await requestContextRestart.execute(
      'context-restart-ac4c',
      { summary: 'Context too large — requesting fresh session with handover' },
      undefined,
      undefined,
      HEADLESS_TOOL_CONTEXT
    );
    expect(restartResult.details).toContain('Context restart requested');

    // Worker emits CONTEXT_RESTART_REQUESTED locally.
    expect(receivedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'CONTEXT_RESTART_REQUESTED',
          stateId: 'StateA',
          beadId: 'bd-statechart-ac4c',
          summary: 'Context too large — requesting fresh session with handover'
        })
      ])
    );
  });

  // ── AC-5: Reading A proof — teammate owns statechart transition emission ───

  it('AC-5: teammate emits typed transition events locally (Reading A holds — coordinator not required)', async () => {
    // This test verifies the full two-state scenario in a single run, proving:
    //   (a) The worker validates the transition before emitting (gate rejects bad outcomes)
    //   (b) The worker emits the correct typed event based on the YAML statechart
    //   (c) The coordinator HTTP endpoint only RECEIVES the typed event — it does
    //       NOT need to compute which type to emit (the worker already decided)
    //   (d) nextState derivation: the worker calls flowManager.nextState internally
    //       during gate validation and would reject an invalid outcome (e.g. an
    //       outcome not in StateA.transitions) — proving it reads the YAML config.

    currentEnv = createTestEnv('bd-statechart-ac5', 'StateA', 'state-a-action');
    const receivedEvents: unknown[] = [];
    currentServer = await startSignalAckServer(receivedEvents);
    currentHarness = fakePi();

    await orrElseExtension(currentHarness.pi);
    await currentHarness.callbacks[PiEventName.SESSION_START]?.(
      {},
      { hasUI: false, cwd: currentEnv.tempRoot }
    );
    await currentHarness.callbacks[PiEventName.BEFORE_AGENT_START]?.(
      { systemPrompt: '' },
      { hasUI: false, cwd: currentEnv.worktreePath }
    );

    const tickItems = currentHarness.tools.find(
      (t: any) => t.name === BuiltInToolName.TICK_ITEMS
    );
    const submitCheckpoint = currentHarness.tools.find(
      (t: any) => t.name === BuiltInToolName.SUBMIT_CHECKPOINT
    );
    const signalCompletion = currentHarness.tools.find(
      (t: any) => t.name === BuiltInToolName.SIGNAL_COMPLETION
    );

    // ── Proof 1: invalid outcome is REJECTED by the teammate (not passed to coordinator)
    // 'NONEXISTENT_OUTCOME' has no entry in StateA.transitions, so flowManager.nextState
    // throws inside evaluateGateReadiness, and signal_completion returns REJECTED.
    const invalidOutcome = await signalCompletion.execute(
      'invalid-outcome',
      { outcome: 'NONEXISTENT_OUTCOME', summary: 'should be rejected' },
      undefined,
      undefined,
      HEADLESS_TOOL_CONTEXT
    );
    expect(invalidOutcome.details).toContain('REJECTED');
    // No event should have been posted to the coordinator for the invalid outcome
    const invalidEvents = (receivedEvents as any[]).filter(
      (e: any) => e.transitionEvent === 'NONEXISTENT_OUTCOME'
    );
    expect(invalidEvents).toHaveLength(0);

    // ── Proof 2: full SUCCESS path — worker validates, emits STATE_TRANSITIONED

    // Satisfy mandatory checklist items
    const tickResult = await tickItems.execute(
      'tick-all',
      {
        items: [
          { text: 'StateA item one', evidence: 'done one' },
          { text: 'StateA item two', evidence: 'done two' }
        ]
      },
      undefined,
      undefined,
      HEADLESS_TOOL_CONTEXT
    );
    // tickItems returns {status, ...} wrapped in {details, content} by wrapPluginTool
    expect(tickResult.details?.status).toBe('PASSED');

    // Submit checkpoint
    await submitCheckpoint.execute(
      'checkpoint-ac5',
      { summary: 'StateA done, all items checked', evidence: 'All items ticked' },
      undefined,
      undefined,
      HEADLESS_TOOL_CONTEXT
    );

    // Signal SUCCESS
    const successResult = await signalCompletion.execute(
      'signal-success-ac5',
      { outcome: 'SUCCESS', summary: 'Transitioning StateA → StateB' },
      undefined,
      undefined,
      HEADLESS_TOOL_CONTEXT
    );
    expect(successResult.details).toContain('Completion signaled with outcome: SUCCESS');

    // Collect all events emitted by the worker (all went to our stub server)
    const allTypes = (receivedEvents as any[]).map((e: any) => e.type);

    // Assert the typed event sequence emitted by the WORKER side:
    //   CHECKPOINT_ACCEPTED → STATE_TRANSITIONED
    expect(allTypes).toContain('CHECKPOINT_ACCEPTED');
    expect(allTypes).toContain('STATE_TRANSITIONED');

    const transitionEvent = (receivedEvents as any[]).find(
      (e: any) => e.type === 'STATE_TRANSITIONED'
    );
    expect(transitionEvent).toMatchObject({
      type: 'STATE_TRANSITIONED',
      // The worker emits transitionEvent = the outcome it chose
      transitionEvent: 'SUCCESS',
      // The worker emits stateId = the state it was in
      stateId: 'StateA',
      beadId: 'bd-statechart-ac5'
      // NOTE: nextState ('StateB') is NOT in this signal — the coordinator derives
      // it from StateA.transitions.SUCCESS when it processes the event.
      // The worker proved statechart ownership by:
      //   1. Calling flowManager.nextState(StateA, 'SUCCESS') inside evaluateGateReadiness
      //      (rejecting invalid outcomes before posting any event)
      //   2. Mapping the outcome to the correct typed event via teammateEventTypeForOutcome
      //   3. Emitting STATE_TRANSITIONED with transitionEvent='SUCCESS' directly
    });

    // Summary: the coordinator receives only the typed, validated event.
    // It does NOT compute the event type — the teammate already decided.
    // This confirms Reading A: the teammate owns its statechart locally.
  });
});
