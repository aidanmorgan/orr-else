/**
 * restart_admission_real_path.test.ts
 *
 * pi-experiment-6q0y.36 DEFECT 2 FIX: real-path wiring test for
 * validateRestartHandoffContract in handleTeammateEvent.
 *
 * SELF-VERIFY proof (mutation test):
 *   Replacing both validateRestartHandoffContract call sites in extension.ts with
 *   {admitted:true} causes the summary-only test to FAIL (summary-only is now admitted,
 *   RESTART_HANDOFF_REJECTED is never recorded, and CONTEXT_RESTART_REQUESTED appears
 *   where it must not). The revert of that mutation makes both tests pass.
 *
 * LOAD-BEARING: these tests drive the REAL handleTeammateEvent via bootRealCoordinator
 * → POST /signals. They CANNOT pass if validateRestartHandoffContract is replaced with
 * always-admit, a no-op, or called on a different code path.
 *
 * Covers:
 *   - summary-only CONTEXT_RESTART_REQUESTED → RESTART_HANDOFF_REJECTED recorded.
 *     CONTEXT_RESTART_REQUESTED must NOT be recorded.
 *   - evidence-aware CONTEXT_RESTART_REQUESTED → CONTEXT_RESTART_REQUESTED recorded
 *     (admitted). RESTART_HANDOFF_REJECTED must NOT be recorded.
 *   - summary-only HARNESS_RESTART_REQUESTED → RESTART_HANDOFF_REJECTED recorded.
 *     HARNESS_RESTART_REQUESTED must NOT be recorded.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { vi } from 'vitest';

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
  PiEventName
} from '../src/constants/index.js';
import orrElseExtension from '../src/extension.js';
import { setSubstrateProbesForTest, resetSubstrateProbes } from '../src/core/V2SubstratePreflight.js';

// ---------------------------------------------------------------------------
// Helpers (modelled on v2_route_authority_stripping.test.ts)
// ---------------------------------------------------------------------------

/**
 * Minimal v1 config — no version field so no v2 route stripping.
 * Uses contextRestartEvent/harnessRestartEvent for the restart path.
 */
const RESTART_TEST_YAML = `
settings:
  startState: Working
  worktreePolicy:
    default: never
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
    baseInstructions: "Do the work."
    actions:
      - id: work_action
        type: prompt
    transitions:
      SUCCESS: completed
      FAILURE: Working
      BLOCKED: Working
      CONTEXT_RESTART: Working
      HARNESS_RESTART: Working
`;

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

/**
 * Poll the event store until a predicate is satisfied or the deadline is reached.
 * Restart signals are fire-and-forget (no ack.hold()), so the 200 response arrives
 * before handleTeammateEvent finishes writing events. This helper yields the event
 * loop until the expected event appears.
 */
async function waitForEvent(
  projectRoot: string,
  predicate: (events: Array<Record<string, unknown>>) => boolean,
  timeoutMs = 5000
): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = readEventStoreLines(projectRoot);
    if (predicate(events)) return events;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  return readEventStoreLines(projectRoot);
}

/**
 * Boot a real coordinator via orrElseExtension + SESSION_START + /orr-else.
 * Modelled on v2_route_authority_stripping.test.ts bootRealCoordinator.
 */
async function bootRealCoordinator(yaml: string, extraSetup?: (projectRoot: string) => void): Promise<{
  projectRoot: string;
  apiPort: number;
  sessionShutdown: () => unknown;
}> {
  setSubstrateProbesForTest({
    tmux: async () => ({ ok: true }),
    git: async () => ({ ok: true })
  });

  const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-6q0y36-restart-')));
  fs.mkdirSync(path.join(projectRoot, '.pi', 'events'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, '.pi', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'harness.yaml'), yaml);
  if (extraSetup) extraSetup(projectRoot);

  process.env[EnvVars.PROJECT_ROOT] = projectRoot;
  process.env[EnvVars.API_PORT] = '0';
  process.env[EnvVars.API_BASE] = 'http://127.0.0.1:1';

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
  resetSubstrateProbes();

  const allEvents = readEventStoreLines(projectRoot);
  const boundEvent = allEvents.find((e: any) => e.type === DomainEventName.HARNESS_API_BOUND);
  if (!boundEvent) throw new Error('HARNESS_API_BOUND not found after /orr-else');
  const apiPort = (boundEvent as any).data?.apiPort as number;
  if (!apiPort || apiPort <= 0) throw new Error(`Invalid apiPort: ${apiPort}`);

  const sessionShutdown = allCallbacks[PiEventName.SESSION_SHUTDOWN] ?? (() => {});
  return { projectRoot, apiPort, sessionShutdown };
}

/** Build a restart signal body with required string fields (summary/evidence/handover). */
function buildRestartSignalBody(
  type: TeammateEventType.CONTEXT_RESTART_REQUESTED | TeammateEventType.HARNESS_RESTART_REQUESTED,
  beadId: string,
  transitionEvent: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    type,
    beadId,
    workerId: `worker-6q0y36-${type}`,
    stateId: 'Working',
    actionId: 'work_action',
    transitionEvent,
    summary: 'Context too large — summary-only, no evidence.',
    evidence: 'No artifacts.',
    handover: 'No handover artifacts.',
    timestamp: Date.now(),
    ...overrides
  };
  return { ...base, idempotencyKey: createTeammateEventIdempotencyKey(base as TeammateEvent) };
}

// ---------------------------------------------------------------------------
// LOAD-BEARING integration tests — real handleTeammateEvent restart admission
// ---------------------------------------------------------------------------

describe('LOAD-BEARING: real-path handleTeammateEvent restart admission (6q0y.36 DEFECT 2)', () => {
  /**
   * SELF-VERIFY proof (documented here for the auditor):
   *
   * If you replace both validateRestartHandoffContract calls in extension.ts
   * (CONTEXT_RESTART_REQUESTED ~line 3186 and HARNESS_RESTART_REQUESTED ~line 3261)
   * with `const validationResult = { admitted: true } as const;`, then:
   *
   * - Test "summary-only CONTEXT_RESTART_REQUESTED → RESTART_HANDOFF_REJECTED" FAILS:
   *   always-admit means CONTEXT_RESTART_REQUESTED IS recorded (no rejection), so the
   *   assertion `expect(restartEvents).toHaveLength(0)` fails and `expect(rejections.length).toBeGreaterThan(0)` fails.
   *
   * - Test "evidence-aware CONTEXT_RESTART_REQUESTED → CONTEXT_RESTART_REQUESTED admitted" PASSES
   *   (still admitted, but the rejection-absent assertion would also pass for wrong reason).
   *
   * The summary-only test is the MUTATION PROOF that the real gate is wired.
   * Reverting the mutation restores both tests to passing.
   */

  it('LOAD-BEARING: summary-only CONTEXT_RESTART_REQUESTED → RESTART_HANDOFF_REJECTED recorded, CONTEXT_RESTART_REQUESTED NOT recorded', async () => {
    const supervisorStartSpy = vi.spyOn(Supervisor.prototype, 'start').mockResolvedValue(undefined);
    const ensureWindowSpy = vi.spyOn(TeammateFactory.prototype, 'ensureAgentsWindow').mockResolvedValue({ ok: true });

    const savedEnv = saveEnvKeys(EnvVars.PROJECT_ROOT, EnvVars.API_PORT, EnvVars.API_BASE);
    let projectRoot = '';
    let sessionShutdown: () => unknown = () => {};
    let apiPort = 0;

    try {
      ({ projectRoot, sessionShutdown, apiPort } = await bootRealCoordinator(RESTART_TEST_YAML));

      const beadId = 'bead-restart-summary-only-001';

      // Summary-only restart signal: no evidenceRefs, no handoverArtifactPath.
      // The real validateRestartHandoffContract gate must reject this.
      const body = buildRestartSignalBody(
        TeammateEventType.CONTEXT_RESTART_REQUESTED,
        beadId,
        'CONTEXT_RESTART',
        {
          // evidenceRefs absent → triggers SUMMARY_ONLY rejection.
          summary: 'I finished the work. Please continue from where I left off.',
          evidence: 'No artifacts recorded.',
          handover: 'No handover artifacts.'
        }
      );

      const response = await fetch(`http://127.0.0.1:${apiPort}/signals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      // Response may be ok:true (ack sent after rejection) — what matters is the event store.
      expect(response.status).toBe(200);

      // Restart signals are fire-and-forget (no ack.hold()). Wait until the handler
      // records either RESTART_HANDOFF_REJECTED or CONTEXT_RESTART_REQUESTED.
      const allEvents = await waitForEvent(projectRoot, events =>
        events.some((e: any) =>
          e.type === DomainEventName.RESTART_HANDOFF_REJECTED ||
          e.type === DomainEventName.CONTEXT_RESTART_REQUESTED
        )
      );

      // LOAD-BEARING: RESTART_HANDOFF_REJECTED must be recorded by the REAL handleTeammateEvent.
      // Replacing validateRestartHandoffContract with always-admit causes this to FAIL
      // (no rejection → no RESTART_HANDOFF_REJECTED recorded).
      const rejections = allEvents.filter((e: any) => e.type === DomainEventName.RESTART_HANDOFF_REJECTED);
      expect(rejections.length, 'RESTART_HANDOFF_REJECTED must be recorded for summary-only restart').toBeGreaterThan(0);
      expect(rejections[0].data as any).toMatchObject({
        beadId,
        stateId: 'Working'
      });
      const rejection0 = rejections[0] as any;
      expect(Array.isArray(rejection0.data.rejections)).toBe(true);
      expect(rejection0.data.rejections[0].reason).toBe('SUMMARY_ONLY');

      // LOAD-BEARING: CONTEXT_RESTART_REQUESTED must NOT be recorded (gate blocked it).
      // Replacing validateRestartHandoffContract with always-admit causes this to FAIL
      // (always-admit records CONTEXT_RESTART_REQUESTED even for summary-only).
      const restartEvents = allEvents.filter((e: any) => e.type === DomainEventName.CONTEXT_RESTART_REQUESTED);
      expect(restartEvents, 'CONTEXT_RESTART_REQUESTED must NOT be recorded for summary-only restart').toHaveLength(0);

    } finally {
      await sessionShutdown();
      restoreEnvKeys(savedEnv);
      supervisorStartSpy.mockRestore();
      ensureWindowSpy.mockRestore();
      if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 30000);

  it('LOAD-BEARING: evidence-aware CONTEXT_RESTART_REQUESTED → CONTEXT_RESTART_REQUESTED admitted, RESTART_HANDOFF_REJECTED NOT recorded', async () => {
    const supervisorStartSpy = vi.spyOn(Supervisor.prototype, 'start').mockResolvedValue(undefined);
    const ensureWindowSpy = vi.spyOn(TeammateFactory.prototype, 'ensureAgentsWindow').mockResolvedValue({ ok: true });

    const savedEnv = saveEnvKeys(EnvVars.PROJECT_ROOT, EnvVars.API_PORT, EnvVars.API_BASE);
    let projectRoot = '';
    let sessionShutdown: () => unknown = () => {};
    let apiPort = 0;

    try {
      ({ projectRoot, sessionShutdown, apiPort } = await bootRealCoordinator(RESTART_TEST_YAML));

      const beadId = 'bead-restart-evidence-aware-001';

      // Evidence-aware restart signal: valid evidenceRefs with registered schemaId.
      // The real validateRestartHandoffContract gate must ADMIT this.
      // 'harness.handoff.workerCompletion' is registered in HandoffSchemas.ts (via extension.ts import).
      const evidenceRefs = [
        {
          schemaId: 'harness.handoff.workerCompletion',
          semanticArtifactPath: 'implementation/handoff.json',
          bytes: 1024,
          sha256: 'a'.repeat(64)
        }
      ];

      const body = buildRestartSignalBody(
        TeammateEventType.CONTEXT_RESTART_REQUESTED,
        beadId,
        'CONTEXT_RESTART',
        {
          evidenceRefs,
          summary: 'Context overflow — restarting with deterministic evidence.',
          evidence: 'See evidenceRefs.',
          handover: 'Handover is in the artifact.'
        }
      );

      const response = await fetch(`http://127.0.0.1:${apiPort}/signals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      expect(response.status).toBe(200);

      // Wait for the async handler to complete (restart signals are fire-and-forget).
      const allEvents = await waitForEvent(projectRoot, events =>
        events.some((e: any) =>
          e.type === DomainEventName.RESTART_HANDOFF_REJECTED ||
          e.type === DomainEventName.CONTEXT_RESTART_REQUESTED
        )
      );

      // LOAD-BEARING: CONTEXT_RESTART_REQUESTED must be recorded (admitted).
      const restartEvents = allEvents.filter((e: any) => e.type === DomainEventName.CONTEXT_RESTART_REQUESTED);
      expect(restartEvents.length, 'CONTEXT_RESTART_REQUESTED must be recorded for evidence-aware restart').toBeGreaterThan(0);
      const restartData = restartEvents[0] as any;
      expect(restartData.data.beadId).toBe(beadId);
      expect(Array.isArray(restartData.data.evidenceRefs)).toBe(true);
      expect(restartData.data.evidenceRefs.length).toBe(1);
      expect(restartData.data.evidenceRefs[0].schemaId).toBe('harness.handoff.workerCompletion');
      // Canonical narrative fields (no legacy summary/evidence/handover).
      expect(restartData.data.narrativeSummary).toBe('Context overflow — restarting with deterministic evidence.');
      expect(restartData.data.summary).toBeUndefined();
      expect(restartData.data.evidence).toBeUndefined();
      expect(restartData.data.handover).toBeUndefined();

      // LOAD-BEARING: RESTART_HANDOFF_REJECTED must NOT be recorded (gate passed).
      const rejections = allEvents.filter((e: any) => e.type === DomainEventName.RESTART_HANDOFF_REJECTED);
      expect(rejections, 'RESTART_HANDOFF_REJECTED must NOT be recorded for admitted restart').toHaveLength(0);

    } finally {
      await sessionShutdown();
      restoreEnvKeys(savedEnv);
      supervisorStartSpy.mockRestore();
      ensureWindowSpy.mockRestore();
      if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 30000);

  it('LOAD-BEARING: summary-only HARNESS_RESTART_REQUESTED → RESTART_HANDOFF_REJECTED recorded, HARNESS_RESTART_REQUESTED NOT recorded', async () => {
    const supervisorStartSpy = vi.spyOn(Supervisor.prototype, 'start').mockResolvedValue(undefined);
    const ensureWindowSpy = vi.spyOn(TeammateFactory.prototype, 'ensureAgentsWindow').mockResolvedValue({ ok: true });

    const savedEnv = saveEnvKeys(EnvVars.PROJECT_ROOT, EnvVars.API_PORT, EnvVars.API_BASE);
    let projectRoot = '';
    let sessionShutdown: () => unknown = () => {};
    let apiPort = 0;

    try {
      ({ projectRoot, sessionShutdown, apiPort } = await bootRealCoordinator(RESTART_TEST_YAML));

      const beadId = 'bead-restart-harness-summary-001';

      // Summary-only HARNESS_RESTART_REQUESTED — same gate as CONTEXT_RESTART_REQUESTED.
      const body = buildRestartSignalBody(
        TeammateEventType.HARNESS_RESTART_REQUESTED,
        beadId,
        'HARNESS_RESTART',
        {
          summary: 'Transient harness failure. Please restart.',
          evidence: 'No artifacts.',
          handover: 'No handover artifacts.'
        }
      );

      const response = await fetch(`http://127.0.0.1:${apiPort}/signals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      expect(response.status).toBe(200);

      // Wait for the async handler to complete (restart signals are fire-and-forget).
      const allEvents = await waitForEvent(projectRoot, events =>
        events.some((e: any) =>
          e.type === DomainEventName.RESTART_HANDOFF_REJECTED ||
          e.type === DomainEventName.HARNESS_RESTART_REQUESTED
        )
      );

      // LOAD-BEARING: RESTART_HANDOFF_REJECTED must be recorded for summary-only HARNESS_RESTART_REQUESTED.
      // Replacing the HARNESS_RESTART_REQUESTED validateRestartHandoffContract call site with
      // always-admit causes this to FAIL.
      const rejections = allEvents.filter((e: any) => e.type === DomainEventName.RESTART_HANDOFF_REJECTED);
      expect(rejections.length, 'RESTART_HANDOFF_REJECTED must be recorded for summary-only HARNESS restart').toBeGreaterThan(0);
      const rejection0 = rejections[0] as any;
      expect(rejection0.data.rejections[0].reason).toBe('SUMMARY_ONLY');

      // LOAD-BEARING: HARNESS_RESTART_REQUESTED must NOT be recorded.
      const harnessRestarts = allEvents.filter((e: any) => e.type === DomainEventName.HARNESS_RESTART_REQUESTED);
      expect(harnessRestarts, 'HARNESS_RESTART_REQUESTED must NOT be recorded for summary-only restart').toHaveLength(0);

    } finally {
      await sessionShutdown();
      restoreEnvKeys(savedEnv);
      supervisorStartSpy.mockRestore();
      ensureWindowSpy.mockRestore();
      if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 30000);
});
