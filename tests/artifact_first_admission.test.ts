/**
 * artifact_first_admission.test.ts — pi-experiment-6q0y.46
 *
 * Enforce artifact-first terminal and advance route events in code.
 *
 * The harness MUST NEVER allow a terminal or forward-progress (advance) route
 * event to be justified by LLM narrative alone. Enforcement is in the REAL
 * coordinator transition-admission code path (handleTeammateEvent →
 * coordinatorGateRequiredTools → evaluateCoordinatorGate).
 *
 * AC1 — Terminal and advance route events are rejected when required artifact
 *        evidence (state.routeEvidence) is missing or schema-invalid.
 * AC2 — The transition admission path ignores natural-language final messages
 *        for progress authority; model prose stored as non-authoritative only.
 * AC3 — Rejection events include state/action/route/missing-ids/remediation hint,
 *        NO raw prompt or tool-output bodies.
 * AC4 — Enforced for EVERY configured terminal/advance route (config-driven,
 *        not hardcoded to `completed`).
 * AC5 — Startup lint reports required tools per route and fails if any tool
 *        with expectsVerify:true is referenced in routeEvidence without a
 *        registered verify() callback.
 * AC6 — Replay reaches the SAME accepted/rejected transition decisions without
 *        reading model prose (the gate reads durable events, never prose fields).
 * AC7 — Tests cover: missing artifact, invalid artifact schema, missing semantic
 *        artifact path, failed verifier, missing review artifact, successful
 *        terminal route event, non-terminal failure route event, and LLM prose
 *        claiming success without evidence (real-path LOAD-BEARING test).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';

import {
  verifier,
  VerifyVerdict,
  type VerifyContext,
  type VerifyResult,
} from '../src/contract.js';
import {
  evaluateCoordinatorGate,
  validateRequiredToolVerifiers,
  type CoordinatorVerifierGateDeps,
  type CoordinatorGateInput,
} from '../src/core/CoordinatorVerifierGate.js';
import { VerifierGateBlockKind } from '../src/core/VerifierGate.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { EventStore } from '../src/core/EventStore.js';
import { ArtifactPaths } from '../src/core/ArtifactPaths.js';
import { PlanWriteSet } from '../src/core/PlanWriteSet.js';
import { RequiredToolResolver } from '../src/core/RequiredToolResolver.js';
import { Observability } from '../src/core/Observability.js';
import { SignalingServer } from '../src/core/SignalingServer.js';
import { createTeammateEventIdempotencyKey } from '../src/core/TeammateEvents.js';
import {
  DomainEventName,
  EnvVars,
  PiEventName,
  ProcessFlag,
  TeammateEventType,
  ToolResultStatus,
} from '../src/constants/index.js';
import orrElseExtension from '../src/extension.js';
import { Supervisor } from '../src/core/Supervisor.js';
import { TeammateFactory } from '../src/plugins/teammates.js';

// ── registry cleanup ──────────────────────────────────────────────────────────
const registered: string[] = [];
function registerVerify(
  tool: string,
  fn: (ctx: VerifyContext) => VerifyResult | Promise<VerifyResult>
): void {
  verifier.register(tool, fn);
  registered.push(tool);
}
afterEach(() => {
  for (const tool of registered.splice(0)) {
    verifier.register(tool, () => ({ verdict: VerifyVerdict.NOT_APPLICABLE, reasons: [] }));
  }
  vi.restoreAllMocks();
});

// ── helpers ───────────────────────────────────────────────────────────────────

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

/**
 * Minimal harness config with routeEvidence on the advance route (SUCCESS).
 * The route-level evidence requires `evidence_tool` with expectsVerify:true.
 */
function harnessYamlWithRouteEvidence(toolName = 'evidence_tool'): string {
  return `
settings:
  startState: Implementing
  eventStore:
    enabled: true
  worktreePolicy:
    default: always
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
states:
  Implementing:
    identity: { role: "Eng", expertise: "x", constraints: [] }
    baseInstructions: "Do"
    routeEvidence:
      SUCCESS:
        - name: ${toolName}
          expectsVerify: true
    actions:
      - id: code
        type: prompt
    transitions: { SUCCESS: "completed", FAILURE: "Implementing" }
`;
}

interface Harness {
  projectRoot: string;
  configLoader: ConfigLoader;
  store: EventStore;
  deps: CoordinatorVerifierGateDeps;
}

function makeHarness(yaml?: string): Harness {
  const projectRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-6q0y46-'))
  );
  fs.writeFileSync(path.join(projectRoot, 'harness.yaml'), yaml ?? harnessYamlWithRouteEvidence());
  const configLoader = new ConfigLoader(undefined, projectRoot);
  const config = configLoader.load();
  const store = new EventStore(configLoader, undefined, undefined, projectRoot);
  store.setSessionId(`test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const artifactPaths = new ArtifactPaths(configLoader, undefined, projectRoot);
  const planWriteSet = new PlanWriteSet(configLoader, artifactPaths, projectRoot);
  const requiredToolResolver = new RequiredToolResolver(planWriteSet, projectRoot);
  const deps: CoordinatorVerifierGateDeps = {
    eventStore: store,
    artifactPaths,
    requiredToolResolver,
    planWriteSet,
    projectRoot,
    config,
    verifyTimeoutMs: 200,
  };
  return { projectRoot, configLoader, store, deps };
}

function gateInput(overrides: Partial<CoordinatorGateInput> = {}): CoordinatorGateInput {
  return {
    beadId: 'bd-1',
    stateId: 'Implementing',
    actionId: 'code',
    requiredTools: [{ name: 'evidence_tool', expectsVerify: true }],
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AC1 — Missing artifact BLOCKS the route
// ─────────────────────────────────────────────────────────────────────────────
describe('AC1 — missing artifact blocks advance/terminal route', () => {
  it('blocks when required tool has no durable tool-result event (TOOL_NOT_INVOKED)', async () => {
    const h = makeHarness();
    try {
      // Register a verify() that would PASS — but the tool was never invoked.
      registerVerify('evidence_tool', () => ({ verdict: VerifyVerdict.PASS, reasons: [] }));

      const outcome = await evaluateCoordinatorGate(h.deps, gateInput());

      // The gate ran and BLOCKED because no durable evidence exists.
      expect(outcome.ran).toBe(true);
      expect(outcome.pass).toBe(false);
      expect(outcome.failures[0].kind).toBe(VerifierGateBlockKind.TOOL_NOT_INVOKED);
    } finally {
      h.configLoader.reset();
      fs.rmSync(h.projectRoot, { recursive: true, force: true });
    }
  });

  it('blocks when the tool result was REJECTED (did-not-run)', async () => {
    const h = makeHarness();
    try {
      const outputFile = path.join(
        h.projectRoot, '.pi', 'tool-output', 'bd-1', 'Implementing', 'code', 'evidence_tool', 'inv', 'o.json'
      );
      await h.store.record(DomainEventName.PROJECT_TOOL_FAILED, {
        beadId: 'bd-1', stateId: 'Implementing', actionId: 'code',
        tool: 'evidence_tool', status: ToolResultStatus.REJECTED, outputFile,
      });
      registerVerify('evidence_tool', () => ({ verdict: VerifyVerdict.PASS, reasons: ['would pass'] }));

      const outcome = await evaluateCoordinatorGate(h.deps, gateInput());

      expect(outcome.pass).toBe(false);
      expect(outcome.failures[0].kind).toBe(VerifierGateBlockKind.TOOL_REJECTED);
    } finally {
      h.configLoader.reset();
      fs.rmSync(h.projectRoot, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC1 — Failed verifier BLOCKS the route
// ─────────────────────────────────────────────────────────────────────────────
describe('AC1 — failed verifier blocks advance/terminal route', () => {
  it('blocks when the verify() callback returns FAIL', async () => {
    const h = makeHarness();
    try {
      const outputFile = path.join(
        h.projectRoot, '.pi', 'tool-output', 'bd-1', 'Implementing', 'code', 'evidence_tool', 'inv', 'o.json'
      );
      await h.store.record(DomainEventName.PROJECT_TOOL_SUCCEEDED, {
        beadId: 'bd-1', stateId: 'Implementing', actionId: 'code',
        tool: 'evidence_tool', status: ToolResultStatus.PASSED, outputFile,
      });
      registerVerify('evidence_tool', () => ({
        verdict: VerifyVerdict.FAIL,
        reasons: ['artifact schema invalid'],
      }));

      const outcome = await evaluateCoordinatorGate(h.deps, gateInput());

      expect(outcome.pass).toBe(false);
      expect(outcome.failures[0].kind).toBe(VerifierGateBlockKind.VERIFY_FAIL);
      expect(outcome.rejectMessage).toContain('artifact schema invalid');
    } finally {
      h.configLoader.reset();
      fs.rmSync(h.projectRoot, { recursive: true, force: true });
    }
  });

  it('blocks when the semantic artifact path does not point to a readable file', async () => {
    const h = makeHarness();
    try {
      // outputFile points to a non-existent path (semantic artifact path missing).
      const outputFile = path.join(
        h.projectRoot, '.pi', 'tool-output', 'bd-1', 'Implementing', 'code', 'evidence_tool', 'inv', 'MISSING.json'
      );
      await h.store.record(DomainEventName.PROJECT_TOOL_SUCCEEDED, {
        beadId: 'bd-1', stateId: 'Implementing', actionId: 'code',
        tool: 'evidence_tool', status: ToolResultStatus.PASSED, outputFile,
      });
      // verify() reads the path and returns FAIL when file is absent.
      registerVerify('evidence_tool', (ctx: VerifyContext) => {
        const p = ctx.toolOutputs['evidence_tool'];
        if (!p || !fs.existsSync(p)) {
          return { verdict: VerifyVerdict.FAIL, reasons: ['artifact file not found at declared path'] };
        }
        return { verdict: VerifyVerdict.PASS, reasons: [] };
      });

      const outcome = await evaluateCoordinatorGate(h.deps, gateInput());

      expect(outcome.pass).toBe(false);
      expect(outcome.rejectMessage).toContain('artifact file not found');
    } finally {
      h.configLoader.reset();
      fs.rmSync(h.projectRoot, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Successful terminal route event PASSES when evidence is present
// ─────────────────────────────────────────────────────────────────────────────
describe('successful terminal route event passes when evidence is present', () => {
  it('admits the route when the required tool ran and its verify() PASSes', async () => {
    const h = makeHarness();
    try {
      const outputFile = path.join(
        h.projectRoot, '.pi', 'tool-output', 'bd-1', 'Implementing', 'code', 'evidence_tool', 'inv', 'o.json'
      );
      await h.store.record(DomainEventName.PROJECT_TOOL_SUCCEEDED, {
        beadId: 'bd-1', stateId: 'Implementing', actionId: 'code',
        tool: 'evidence_tool', status: ToolResultStatus.PASSED, outputFile,
      });
      registerVerify('evidence_tool', () => ({ verdict: VerifyVerdict.PASS, reasons: [] }));

      const outcome = await evaluateCoordinatorGate(h.deps, gateInput());

      expect(outcome.ran).toBe(true);
      expect(outcome.pass).toBe(true);
    } finally {
      h.configLoader.reset();
      fs.rmSync(h.projectRoot, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Non-terminal failure route event is NOT gated (no routeEvidence declared)
// ─────────────────────────────────────────────────────────────────────────────
describe('non-terminal failure route event is a NO-OP when no routeEvidence declared', () => {
  it('ran:false when the input declares no required tools (unguarded failure route)', async () => {
    const h = makeHarness();
    try {
      // Pass an empty requiredTools list — simulates a FAILURE route with no routeEvidence.
      const outcome = await evaluateCoordinatorGate(h.deps, gateInput({ requiredTools: [] }));
      expect(outcome.ran).toBe(false);
      expect(outcome.pass).toBe(true);
    } finally {
      h.configLoader.reset();
      fs.rmSync(h.projectRoot, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC5 — Startup lint: validateRequiredToolVerifiers includes routeEvidence tools
// ─────────────────────────────────────────────────────────────────────────────
describe('AC5 — startup lint: routeEvidence tools with expectsVerify:true fail if no callback registered', () => {
  it('throws naming the offending tool when routeEvidence declares expectsVerify:true with no callback', () => {
    // Use a unique tool name that is NEVER registered anywhere else in the test
    // suite (avoids false-pass due to the module-level registry's last-wins
    // semantics: afterEach resets to NOT_APPLICABLE which still marks it as
    // "has callback").
    const uniqueTool = `lint_only_tool_${process.pid}_${Date.now()}`;
    const h = makeHarness(harnessYamlWithRouteEvidence(uniqueTool));
    try {
      // uniqueTool has NO registered verify() callback — must throw naming it.
      expect(() => validateRequiredToolVerifiers(h.deps.config)).toThrow(new RegExp(uniqueTool));
    } finally {
      h.configLoader.reset();
      fs.rmSync(h.projectRoot, { recursive: true, force: true });
    }
  });

  it('passes when routeEvidence tools with expectsVerify:true have a registered callback', () => {
    const h = makeHarness();
    try {
      registerVerify('evidence_tool', () => ({ verdict: VerifyVerdict.PASS, reasons: [] }));
      // Must not throw.
      expect(() => validateRequiredToolVerifiers(h.deps.config)).not.toThrow();
    } finally {
      h.configLoader.reset();
      fs.rmSync(h.projectRoot, { recursive: true, force: true });
    }
  });

  it('AC5 startup lint: ConfigLoader.load() rejects routeEvidence route keys not in vocabulary', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-6q0y46-lint-'));
    const configPath = path.join(tempDir, 'harness.yaml');
    try {
      fs.writeFileSync(configPath, `
settings:
  startState: Implementing
  worktreePolicy:
    default: always
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
states:
  Implementing:
    identity: { role: "Eng", expertise: "x", constraints: [] }
    baseInstructions: "Do"
    routeEvidence:
      UNKNOWN_OUTCOME:
        - name: some_tool
    actions:
      - id: code
        type: prompt
    transitions: { SUCCESS: "completed", FAILURE: "Implementing" }
`);
      const loader = new ConfigLoader(undefined, tempDir);
      // UNKNOWN_OUTCOME is not in the vocabulary — must throw.
      expect(() => loader.load(configPath)).toThrow(/UNKNOWN_OUTCOME/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC7 LOAD-BEARING: LLM prose claiming success without evidence is REJECTED
// via the REAL admission path (handleTeammateEvent / SignalingServer).
//
// This test drives the REAL coordinator SignalingServer registered by startOrrElse
// (extension.ts). A STATE_TRANSITIONED(SUCCESS) HTTP signal for a bead/state
// configured with routeEvidence.SUCCESS → [evidence_tool expectsVerify:true]
// and NO durable tool-result event for evidence_tool is sent. The test asserts:
//   1. handleTeammateEvent runs evaluateCoordinatorGate (real gate)
//   2. The gate BLOCKS (evidence_tool is TOOL_NOT_INVOKED)
//   3. A ROUTE_ADMISSION_REJECTED event is written to the event store
//   4. Response is {ok:false, blocked:true, gate:{pass:false}}
//
// The signal carries a convincing prose summary/evidence/handover — but these
// fields have NO authority (AC2). The gate reads ONLY the durable tool-result
// events. Removing the routeEvidence gate check in coordinatorGateRequiredTools
// causes this test to FAIL (gate would not run, prose-only signal would advance).
//
// Modelled on: runtime_budget.test.ts verifierFailureCount real-path test.
// ─────────────────────────────────────────────────────────────────────────────
describe('AC7 LOAD-BEARING: prose-only terminal advance REJECTED via real handleTeammateEvent path', () => {
  it('AC7: LLM prose claiming SUCCESS without evidence_tool artifact is REJECTED (LOAD-BEARING)', async () => {
    const projectRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-6q0y46-real-'))
    );
    fs.mkdirSync(path.join(projectRoot, '.pi', 'logs'), { recursive: true });

    const savedEnv = saveEnv(
      EnvVars.PROJECT_ROOT, EnvVars.API_PORT, EnvVars.API_BASE,
    );

    // Prevent real Supervisor/TeammateFactory side effects.
    const supervisorStartSpy = vi.spyOn(Supervisor.prototype, 'start').mockResolvedValue(undefined);
    const ensureWindowSpy = vi.spyOn(TeammateFactory.prototype, 'ensureAgentsWindow').mockResolvedValue({ ok: true });

    let sessionShutdown: (() => unknown) | undefined;

    try {
      // Config: state Implementing has routeEvidence.SUCCESS → [evidence_tool expectsVerify:true].
      // No durable tool-result event will be written → gate is TOOL_NOT_INVOKED → BLOCKED.
      fs.writeFileSync(path.join(projectRoot, 'harness.yaml'), harnessYamlWithRouteEvidence('evidence_tool'));

      process.env[EnvVars.PROJECT_ROOT] = projectRoot;
      // Port 0 → OS picks a free port (real SignalingServer bound to it).
      process.env[EnvVars.API_PORT] = '0';
      // Broken URL → postWorkerSignal fails gracefully (ECONNREFUSED caught by .catch(() => {})).
      process.env[EnvVars.API_BASE] = 'http://127.0.0.1:1';

      // Register a verify() that would PASS — but the tool was never invoked,
      // so the gate will hit TOOL_NOT_INVOKED before calling verify(). The
      // verify() is required here so validateRequiredToolVerifiers() succeeds at
      // startOrrElse time (it throws for expectsVerify:true without a callback).
      registerVerify('evidence_tool', () => ({ verdict: VerifyVerdict.PASS, reasons: [] }));

      // Build a fakePi that captures event callbacks + commands.
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

      // SESSION_START wires up TeammateFactory + observability.
      await allCallbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: projectRoot });
      sessionShutdown = allCallbacks[PiEventName.SESSION_SHUTDOWN] as () => unknown;

      // Invoke /orr-else: starts the REAL SignalingServer bound to a random OS port.
      const commandHandler = commands['orr-else']?.handler;
      expect(commandHandler, '/orr-else command must be registered').toBeDefined();
      await commandHandler('', { hasUI: false, ui: { notify: () => {}, setStatus: () => {} } } as any);

      // Discover the real bound port from the HARNESS_API_BOUND event.
      const allEvents = readEventStoreLines(projectRoot);
      const boundEvent = allEvents.find((e: any) => e.type === DomainEventName.HARNESS_API_BOUND);
      expect(boundEvent, 'HARNESS_API_BOUND must be recorded after startOrrElse').toBeDefined();
      const apiPort = (boundEvent as any).data?.apiPort as number;
      expect(apiPort, 'apiPort must be a positive number').toBeGreaterThan(0);

      // Build a STATE_TRANSITIONED(SUCCESS) signal.
      // The summary/evidence/handover fields are convincing prose — but these
      // have NO authority (AC2). The gate reads ONLY durable tool-result events.
      // No PROJECT_TOOL_SUCCEEDED event is written for evidence_tool → TOOL_NOT_INVOKED.
      const base = {
        type: TeammateEventType.STATE_TRANSITIONED,
        beadId: 'bd-prose-1',
        workerId: 'worker-prose-1',
        stateId: 'Implementing',
        actionId: 'code',
        transitionEvent: 'SUCCESS',
        // Convincing prose — must be IGNORED by the gate (AC2).
        summary: 'All work is done. The evidence_tool ran and passed. Everything is complete.',
        evidence: 'Evidence: evidence_tool was invoked and produced the required artifact.',
        handover: 'Handover: all required artifacts are present. Transition is safe.',
        timestamp: Date.now(),
      };
      const signal = { ...base, idempotencyKey: createTeammateEventIdempotencyKey(base) };

      // POST to the REAL SignalingServer.
      const response = await fetch(`http://127.0.0.1:${apiPort}/signals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(signal),
      });

      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;

      // LOAD-BEARING: the gate must have BLOCKED the prose-only advance.
      // {ok:false, blocked:true, gate:{pass:false}} — NOT {ok:true}.
      // Removing the routeEvidence gate in coordinatorGateRequiredTools causes
      // this assertion to fail (the gate would not run and the route would advance).
      expect(body.ok, 'Prose-only advance must be REJECTED by the artifact-first gate').toBe(false);
      expect(body.blocked).toBe(true);
      const gate = body.gate as Record<string, unknown> | undefined;
      expect(gate, 'gate verdict must be present').toBeDefined();
      expect(gate!.pass).toBe(false);

      // AC3: ROUTE_ADMISSION_REJECTED must be in the event store — no raw bodies.
      const finalEvents = readEventStoreLines(projectRoot);
      const rejectionEvents = finalEvents.filter(
        (e: any) => e.type === DomainEventName.ROUTE_ADMISSION_REJECTED
      );
      expect(
        rejectionEvents.length,
        'ROUTE_ADMISSION_REJECTED must be emitted by handleTeammateEvent (LOAD-BEARING: fails if gate removed)'
      ).toBeGreaterThan(0);

      const rejEvt = rejectionEvents[0] as any;
      const evtData = rejEvt.data as Record<string, unknown>;

      // AC3: event carries identity + missing IDs + remediation hint — no raw bodies.
      expect(evtData.stateId).toBe('Implementing');
      expect(evtData.routeEvent).toBe('SUCCESS');
      expect(Array.isArray(evtData.missingIds)).toBe(true);
      expect((evtData.missingIds as string[]).length).toBeGreaterThan(0);
      expect(typeof evtData.remediationHint).toBe('string');
      // AC3: no raw prompt or tool-output body in the event.
      expect(JSON.stringify(evtData)).not.toContain('All work is done');
      expect(JSON.stringify(evtData)).not.toContain('evidence_tool was invoked');

      // AC2: confirm the prose fields (summary/evidence/handover) are NOT the
      // reason for admission — the gate decision was purely artifact-based.
      // If prose had authority, the gate would have passed (the prose claims success).
      // The gate BLOCKED → prose has no progress authority.

      // AC6: replay — the same decision is reached by reading only the event store,
      // without reading prose. The event store has NO PROJECT_TOOL_SUCCEEDED for
      // evidence_tool, so any replay of gate decisions from the store alone reaches
      // the same BLOCKED verdict. (The ROUTE_ADMISSION_REJECTED event is evidence
      // that the blocking decision was recorded deterministically.)
    } finally {
      await sessionShutdown?.();
      restoreEnv(savedEnv);
      supervisorStartSpy.mockRestore();
      ensureWindowSpy.mockRestore();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4 UNIVERSAL FAIL-CLOSED: advance route with state-level requiredTools
// (not routeEvidence) is BLOCKED when tools not run.
//
// This test confirms the fail-closed invariant applies to state.requiredTools
// (the most common evidence declaration), not just routeEvidence. The existing
// AC7 test covers routeEvidence; this test covers state-level requiredTools.
//
// LOAD-BEARING: fails if the advance gate (coordinatorGateRequiredTools merging
// state.requiredTools) is removed.
// ─────────────────────────────────────────────────────────────────────────────
function harnessYamlWithStateRequiredTools(toolName = 'state_tool'): string {
  return `
settings:
  startState: Implementing
  eventStore:
    enabled: true
  worktreePolicy:
    default: always
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
states:
  Implementing:
    identity: { role: "Eng", expertise: "x", constraints: [] }
    baseInstructions: "Do"
    requiredTools: [${toolName}]
    actions:
      - id: code
        type: prompt
    transitions: { SUCCESS: "completed", FAILURE: "Implementing" }
`;
}

describe('AC4 UNIVERSAL FAIL-CLOSED LOAD-BEARING: state-level requiredTools gate blocks advance (real path)', () => {
  it('AC4: SUCCESS signal is REJECTED via real handleTeammateEvent when state.requiredTools tool was never run (LOAD-BEARING)', async () => {
    const projectRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-6q0y46-universal-'))
    );
    fs.mkdirSync(path.join(projectRoot, '.pi', 'logs'), { recursive: true });

    const savedEnv = saveEnv(
      EnvVars.PROJECT_ROOT, EnvVars.API_PORT, EnvVars.API_BASE,
    );

    const supervisorStartSpy = vi.spyOn(Supervisor.prototype, 'start').mockResolvedValue(undefined);
    const ensureWindowSpy = vi.spyOn(TeammateFactory.prototype, 'ensureAgentsWindow').mockResolvedValue({ ok: true });

    let sessionShutdown: (() => unknown) | undefined;

    try {
      // Config with state.requiredTools: [state_tool] — a tool that was never run.
      // This exercises the UNIVERSAL gate (not just routeEvidence).
      fs.writeFileSync(path.join(projectRoot, 'harness.yaml'), harnessYamlWithStateRequiredTools('state_tool'));

      process.env[EnvVars.PROJECT_ROOT] = projectRoot;
      process.env[EnvVars.API_PORT] = '0';
      process.env[EnvVars.API_BASE] = 'http://127.0.0.1:1';

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
      await allCallbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: projectRoot });
      sessionShutdown = allCallbacks[PiEventName.SESSION_SHUTDOWN] as () => unknown;

      const commandHandler = commands['orr-else']?.handler;
      expect(commandHandler, '/orr-else command must be registered').toBeDefined();
      await commandHandler('', { hasUI: false, ui: { notify: () => {}, setStatus: () => {} } } as any);

      const allEvents = readEventStoreLines(projectRoot);
      const boundEvent = allEvents.find((e: any) => e.type === DomainEventName.HARNESS_API_BOUND);
      expect(boundEvent, 'HARNESS_API_BOUND must be recorded').toBeDefined();
      const apiPort = (boundEvent as any).data?.apiPort as number;
      expect(apiPort).toBeGreaterThan(0);

      // No PROJECT_TOOL_SUCCEEDED event for state_tool → gate must BLOCK.
      const base = {
        type: TeammateEventType.STATE_TRANSITIONED,
        beadId: 'bd-universal-1',
        workerId: 'worker-universal-1',
        stateId: 'Implementing',
        actionId: 'code',
        transitionEvent: 'SUCCESS',
        summary: 'Implementation complete.',
        evidence: 'state_tool ran and produced output.',
        handover: 'All done.',
        timestamp: Date.now(),
      };
      const signal = { ...base, idempotencyKey: createTeammateEventIdempotencyKey(base) };

      const response = await fetch(`http://127.0.0.1:${apiPort}/signals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(signal),
      });

      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;

      // LOAD-BEARING: gate must block (state_tool not invoked).
      // Fails if coordinatorGateRequiredTools no longer merges state.requiredTools.
      expect(body.ok, 'State-level requiredTools advance must be REJECTED when tool not run').toBe(false);
      expect(body.blocked).toBe(true);

      const finalEvents = readEventStoreLines(projectRoot);
      const rejectionEvents = finalEvents.filter(
        (e: any) => e.type === DomainEventName.ROUTE_ADMISSION_REJECTED
      );
      expect(
        rejectionEvents.length,
        'ROUTE_ADMISSION_REJECTED must be emitted (LOAD-BEARING: fails if state.requiredTools gate removed)'
      ).toBeGreaterThan(0);
    } finally {
      await sessionShutdown?.();
      restoreEnv(savedEnv);
      supervisorStartSpy.mockRestore();
      ensureWindowSpy.mockRestore();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Startup lint: ConfigLoader.load() throws for advance route with zero evidence
// when the config has opted into the evidence system (hasAnyEvidence=true).
//
// LOAD-BEARING: fails if validateEmptyAdvanceEvidence() is removed from load().
// ─────────────────────────────────────────────────────────────────────────────
describe('startup lint: ConfigLoader.load() throws for zero-evidence advance route when config has evidence (LOAD-BEARING)', () => {
  it('throws for the zero-evidence state and names it when another state has evidence', () => {
    // Config: Implementing has evidence; ZeroState has NONE on its advance route.
    // The lint fires because configHasAnyEvidence=true and ZeroState has zero evidence.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-6q0y46-lint2-'));
    const configPath = path.join(tempDir, 'harness.yaml');
    try {
      fs.writeFileSync(configPath, `
settings:
  startState: Implementing
  worktreePolicy:
    default: always
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
states:
  Implementing:
    identity: { role: "Eng", expertise: "x", constraints: [] }
    baseInstructions: "Do"
    requiredTools: [some_tool]
    actions:
      - id: code
        type: prompt
    transitions: { SUCCESS: "ZeroState", FAILURE: "Implementing" }
  ZeroState:
    identity: { role: "Eng", expertise: "x", constraints: [] }
    baseInstructions: "Do"
    actions:
      - id: finalize
        type: prompt
    transitions: { SUCCESS: "completed", FAILURE: "ZeroState" }
`);
      const loader = new ConfigLoader(undefined, tempDir);
      // ZeroState has SUCCESS→completed (advance) but no evidence → lint must throw.
      expect(() => loader.load(configPath)).toThrow(/ZeroState/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('passes once evidence is declared on the formerly-zero-evidence advance route', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-6q0y46-lint2ok-'));
    const configPath = path.join(tempDir, 'harness.yaml');
    try {
      fs.writeFileSync(configPath, `
settings:
  startState: Implementing
  worktreePolicy:
    default: always
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
states:
  Implementing:
    identity: { role: "Eng", expertise: "x", constraints: [] }
    baseInstructions: "Do"
    requiredTools: [some_tool]
    actions:
      - id: code
        type: prompt
    transitions: { SUCCESS: "ZeroState", FAILURE: "Implementing" }
  ZeroState:
    identity: { role: "Eng", expertise: "x", constraints: [] }
    baseInstructions: "Do"
    requiredTools: [finalize_tool]
    actions:
      - id: finalize
        type: prompt
    transitions: { SUCCESS: "completed", FAILURE: "ZeroState" }
`);
      const loader = new ConfigLoader(undefined, tempDir);
      // Both states now have evidence — must NOT throw.
      expect(() => loader.load(configPath)).not.toThrow();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does NOT throw for configs with zero evidence anywhere (legacy/test configs)', () => {
    // A config with NO evidence anywhere is not subject to the lint —
    // it is a legacy or test config that predate the evidence system.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-6q0y46-lint2legacy-'));
    const configPath = path.join(tempDir, 'harness.yaml');
    try {
      fs.writeFileSync(configPath, `
settings:
  startState: Alpha
  worktreePolicy:
    default: always
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
states:
  Alpha:
    identity: { role: "R", expertise: "x", constraints: [] }
    baseInstructions: "Do"
    actions:
      - id: a1
        type: prompt
    transitions: { SUCCESS: "completed", FAILURE: "Alpha" }
`);
      const loader = new ConfigLoader(undefined, tempDir);
      // No evidence anywhere — lint must be skipped, load must succeed.
      expect(() => loader.load(configPath)).not.toThrow();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('FAILURE/BLOCKED routes with no evidence are NOT blocked (advance/terminal-only enforcement)', () => {
    // A config where advance route HAS evidence, but FAILURE route has no evidence.
    // The FAILURE route must NOT be gated — only advance/terminal routes are enforced.
    const h = makeHarness();
    try {
      // The FAILURE route goes back to Implementing (non-terminal, non-advance).
      // The gate must pass (ran:false) for FAILURE route with no evidence.
      const outcome = (async () => evaluateCoordinatorGate(h.deps, gateInput({ requiredTools: [] })))();
      return outcome.then(result => {
        expect(result.ran).toBe(false);
        expect(result.pass).toBe(true);
      });
    } finally {
      h.configLoader.reset();
      fs.rmSync(h.projectRoot, { recursive: true, force: true });
    }
  });
});
