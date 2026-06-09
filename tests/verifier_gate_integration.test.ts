/**
 * pi-experiment-0yt5.28 — in-repo INTEGRATION test for the coordinator-side
 * artifact-presence gate (requiredTools + verify()).
 *
 * Beyond the loop unit tests (verifier_gate.test.ts) and the coordinator
 * orchestration tests (coordinator_verifier_gate.test.ts), this test exercises
 * the WHOLE coordinator-side gate END TO END with a FIXTURE DUAL-MODE TOOL:
 *
 *   - the fixture tool has a `run()` side that, when "invoked", writes a REAL
 *     outputFile to disk AND records a typed tool-result EVENT into a REAL
 *     EventStore (mirroring how a live tool persists its result), and a
 *     `verify()` side registered via the contract `verifier` registry that
 *     reads the resolved outputFile path the gate hands it;
 *   - the transition declares the tool in `requiredTools` (NO requireVerify
 *     field — that framing is DROPPED under the artifact-presence model);
 *   - we drive the REAL `evaluateCoordinatorGate` against the REAL EventStore /
 *     ArtifactPaths / RequiredToolResolver / PlanWriteSet — not a re-implemented
 *     loop.
 *
 * ACs (each a real, non-vacuous assertion):
 *   1. artifact present + verify PASS  => transition ADVANCES;
 *      outputFile/event ABSENT (tool not invoked) => BLOCKS (did-not-run);
 *      present + verify FAIL => BLOCKS with the tool verdict + reasons
 *      (BOTH the structured reasons AND the rendered/aggregated message);
 *      NOT_APPLICABLE => IGNORED (does not block);
 *      the gate does NOT auto-route (it blocks/advances, never selects an edge).
 *   2. a THROWING verify() AND a TIMING-OUT verify() both yield FAIL (blocked),
 *      driven through the coordinator gate's verifyTimeoutMs path.
 *   3. a required tool whose LATEST tool-result event has status===REJECTED
 *      blocks the transition (independent of verify()).
 *   4. a transition naming an UNREGISTERED required tool with expectsVerify:true
 *      fails fast at config/startup validation (error NAMES the tool); a
 *      presence-only required tool with NO verify() loads cleanly. Driven
 *      through the REAL ConfigLoader + the REAL validateRequiredToolVerifiers.
 *   5. picked up by `npx vitest run` and exits 0.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// The contract `verifier` registry is a module-level singleton; the gate uses
// the src instance, so the test must register into the SAME src instance.
import {
  verifier,
  VerifyVerdict,
  type VerifyContext,
  type VerifyResult
} from '../src/contract.js';
import {
  evaluateCoordinatorGate,
  validateRequiredToolVerifiers,
  type CoordinatorVerifierGateDeps,
  type CoordinatorGateInput
} from '../src/core/CoordinatorVerifierGate.js';
import { VerifierGateBlockKind } from '../src/core/VerifierGate.js';
import { TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION, type ToolEvidenceHandle } from '../src/core/ToolEvidenceHandle.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { EventStore } from '../src/core/EventStore.js';
import { ArtifactPaths } from '../src/core/ArtifactPaths.js';
import { PlanWriteSet } from '../src/core/PlanWriteSet.js';
import { RequiredToolResolver } from '../src/core/RequiredToolResolver.js';
import { DomainEventName, ToolResultStatus } from '../src/constants/domain.js';
import type { HarnessConfig } from '../src/core/ConfigLoader.js';

// ── registry cleanup (module-level singleton, last-wins, no removal API) ──────
// Mirror the existing tests: overwrite every callback we registered with an
// inert NOT_APPLICABLE stub so a stale callback can never leak into another test.
const registered: string[] = [];
function registerVerify(tool: string, fn: (ctx: VerifyContext) => VerifyResult | Promise<VerifyResult>): void {
  verifier.register(tool, fn);
  registered.push(tool);
}
afterEach(() => {
  for (const tool of registered.splice(0)) {
    verifier.register(tool, () => ({ verdict: VerifyVerdict.NOT_APPLICABLE, reasons: [] }));
  }
});

// ── a REAL-store coordinator harness wired exactly like production deps ───────
const FIXTURE_TOOL = 'fixture_tool';

function harnessYaml(): string {
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
    actions:
      - id: code
        type: prompt
        requiredTools: [${FIXTURE_TOOL}]
    transitions: { SUCCESS: "completed", FAILURE: "Implementing" }
`;
}

interface Harness {
  projectRoot: string;
  configLoader: ConfigLoader;
  config: HarnessConfig;
  store: EventStore;
  deps: CoordinatorVerifierGateDeps;
}

function makeHarness(): Harness {
  const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-0yt5-28-')));
  fs.writeFileSync(path.join(projectRoot, 'harness.yaml'), harnessYaml());
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
    // Small per-verify isolation timeout so the timing-out fixture is fast.
    verifyTimeoutMs: 100
  };
  return { projectRoot, configLoader, config, store, deps };
}

const input = (overrides: Partial<CoordinatorGateInput> = {}): CoordinatorGateInput => ({
  beadId: 'bd-1',
  stateId: 'Implementing',
  actionId: 'code',
  requiredTools: [FIXTURE_TOOL],
  ...overrides
});

/**
 * The "run" side of the fixture dual-mode tool: write a REAL outputFile to disk
 * and record a typed PROJECT_TOOL_SUCCEEDED event into the REAL store with a
 * canonical ToolEvidenceHandle. Returns the outputFile path so a verify() can
 * read it via ctx.evidenceHandles[FIXTURE_TOOL].semanticArtifactPath.
 *
 * pi-experiment-yhec: events must carry a canonical evidenceHandle.
 */
async function runFixtureTool(h: Harness, body: string): Promise<string> {
  const toolOutputRoot = path.join(h.projectRoot, '.pi', 'tool-output');
  const outputDir = path.join(toolOutputRoot, 'bd-1', 'Implementing', 'code', FIXTURE_TOOL, 'inv');
  fs.mkdirSync(outputDir, { recursive: true });
  const outputFile = path.join(outputDir, 'o.json');
  fs.writeFileSync(outputFile, body);
  const evidenceHandle: ToolEvidenceHandle = {
    schemaVersion: TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
    toolName: FIXTURE_TOOL,
    invocationId: 'inv-fixture-test',
    runStatus: 'PASSED',
    semanticArtifactPath: outputFile,
    toolOutputRoot,
    summaryMode: 'none',
    noSummaryReason: 'fixture dual-mode tool test',
    admittedHarnessFingerprint: 'sha256:test-fp',
    admittedExecutionBoundary: 'bead:bd-1/state:Implementing/action:code',
  };
  await h.store.record(DomainEventName.PROJECT_TOOL_SUCCEEDED, {
    beadId: 'bd-1', stateId: 'Implementing', actionId: 'code', tool: FIXTURE_TOOL,
    status: ToolResultStatus.PASSED, outputFile, outputFileBytes: Buffer.byteLength(body),
    evidenceHandle
  });
  return outputFile;
}

/**
 * The "REJECTED" side of the fixture dual-mode tool: record a REJECTED event
 * with a canonical ToolEvidenceHandle.
 */
async function runFixtureToolRejected(h: Harness): Promise<void> {
  const toolOutputRoot = path.join(h.projectRoot, '.pi', 'tool-output');
  const evidenceHandle: ToolEvidenceHandle = {
    schemaVersion: TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
    toolName: FIXTURE_TOOL,
    invocationId: 'inv-fixture-rejected',
    runStatus: 'REJECTED',
    failureCategory: 'INFRA',
    toolOutputRoot,
    summaryMode: 'none',
    noSummaryReason: 'fixture dual-mode tool — REJECTED',
    admittedHarnessFingerprint: 'sha256:test-fp',
    admittedExecutionBoundary: 'bead:bd-1/state:Implementing/action:code',
  };
  await h.store.record(DomainEventName.PROJECT_TOOL_FAILED, {
    beadId: 'bd-1', stateId: 'Implementing', actionId: 'code', tool: FIXTURE_TOOL,
    status: ToolResultStatus.REJECTED, outputFile: '',
    evidenceHandle
  });
}

let h: Harness;
beforeEach(() => { h = makeHarness(); });
afterEach(() => {
  vi.restoreAllMocks();
  h.configLoader.reset();
  fs.rmSync(h.projectRoot, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC1 — the whole gate, end-to-end, with the fixture dual-mode tool.
// ─────────────────────────────────────────────────────────────────────────────
describe('AC1 — end-to-end coordinator gate with a fixture dual-mode tool', () => {
  it('artifact present + verify PASS => transition ADVANCES (and no edge is auto-selected)', async () => {
    const outputFile = await runFixtureTool(h, JSON.stringify({ ok: true }));
    // The verify() reads the REAL outputFile via ctx.evidenceHandles (pi-experiment-yhec).
    let sawContent: string | undefined;
    registerVerify(FIXTURE_TOOL, (ctx): VerifyResult => {
      const semanticPath = ctx.evidenceHandles[FIXTURE_TOOL]?.semanticArtifactPath;
      if (semanticPath) sawContent = fs.readFileSync(semanticPath, 'utf8');
      return { verdict: VerifyVerdict.PASS, reasons: [] };
    });

    const outcome = await evaluateCoordinatorGate(h.deps, input());

    expect(outcome.ran).toBe(true);
    expect(outcome.pass).toBe(true);
    expect(outcome.failures).toEqual([]);
    expect(outcome.evaluatedTools).toEqual([FIXTURE_TOOL]);
    // The verify() actually read back what the run() side wrote (not vacuous).
    expect(sawContent).toBe(JSON.stringify({ ok: true }));
    expect(fs.readFileSync(outputFile, 'utf8')).toBe(JSON.stringify({ ok: true }));
    // The gate does NOT auto-route: it returns ONLY a pass/block verdict — the
    // model (not the gate) picks the recovery edge. This is structurally
    // guaranteed by CoordinatorGateOutcome carrying no routing field; we assert
    // it falsifiably by pinning the outcome's own keys to the verdict surface
    // (a future field that smuggled in a routing decision would fail here).
    expect(Object.keys(outcome).sort()).toEqual(
      ['evaluatedTools', 'failures', 'pass', 'perTool', 'rejectMessage', 'ran'].sort()
    );
  });

  it('outputFile/event ABSENT (tool not invoked) => BLOCKS (did-not-run)', async () => {
    // The fixture tool is NEVER run: no outputFile written, no event recorded.
    // Even a PASS-returning verify() must not rescue a tool that never ran.
    registerVerify(FIXTURE_TOOL, () => ({ verdict: VerifyVerdict.PASS, reasons: ['worker thinks it passed'] }));

    const outcome = await evaluateCoordinatorGate(h.deps, input());

    expect(outcome.ran).toBe(true);
    expect(outcome.pass).toBe(false);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]).toMatchObject({ tool: FIXTURE_TOOL, kind: VerifierGateBlockKind.TOOL_NOT_INVOKED });
    expect(outcome.failures[0].verdict).toBeUndefined();
    expect(outcome.rejectMessage).toContain('was not invoked');
  });

  it('present + verify FAIL => BLOCKS with the tool verdict + reasons (structured AND rendered)', async () => {
    await runFixtureTool(h, JSON.stringify({ ok: false }));
    registerVerify(FIXTURE_TOOL, () => ({
      verdict: VerifyVerdict.FAIL,
      reasons: ['fixture content invalid', 'second reason'],
      failureOutcome: 'REWORK'
    }));

    const outcome = await evaluateCoordinatorGate(h.deps, input());

    expect(outcome.pass).toBe(false);
    // Structured failure carries verdict + BOTH reasons.
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]).toMatchObject({
      tool: FIXTURE_TOOL,
      kind: VerifierGateBlockKind.VERIFY_FAIL,
      verdict: VerifyVerdict.FAIL,
      reasons: ['fixture content invalid', 'second reason'],
      failureOutcome: 'REWORK'
    });
    // Rendered/aggregated message names the tool, BOTH reasons, and the
    // ADVISORY failureOutcome (surfaced, never auto-routed).
    expect(outcome.rejectMessage).toContain(FIXTURE_TOOL);
    expect(outcome.rejectMessage).toContain('fixture content invalid; second reason');
    expect(outcome.rejectMessage).toContain('advisory failureOutcome=REWORK');
  });

  it('NOT_APPLICABLE => IGNORED (does not block); transition advances', async () => {
    await runFixtureTool(h, JSON.stringify({ ok: true }));
    registerVerify(FIXTURE_TOOL, () => ({ verdict: VerifyVerdict.NOT_APPLICABLE, reasons: ['not my content'] }));

    const outcome = await evaluateCoordinatorGate(h.deps, input());

    expect(outcome.ran).toBe(true);
    expect(outcome.pass).toBe(true);
    expect(outcome.failures).toEqual([]);
    // The NA verdict appears in diagnostics but contributes NO failure.
    expect(outcome.perTool[0]).toMatchObject({ tool: FIXTURE_TOOL, verdict: VerifyVerdict.NOT_APPLICABLE });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2 — a throwing verify() AND a timing-out verify() both yield FAIL, driven
// through the coordinator gate's verifyTimeoutMs path (deps.verifyTimeoutMs=100).
// ─────────────────────────────────────────────────────────────────────────────
describe('AC2 — throwing and timing-out verify() both BLOCK via the coordinator gate', () => {
  it('a THROWING verify() yields FAIL (transition blocked, threw:true)', async () => {
    await runFixtureTool(h, '{}');
    registerVerify(FIXTURE_TOOL, () => { throw new Error('kaboom'); });

    const outcome = await evaluateCoordinatorGate(h.deps, input());

    expect(outcome.pass).toBe(false);
    expect(outcome.failures[0]).toMatchObject({ tool: FIXTURE_TOOL, kind: VerifierGateBlockKind.VERIFY_FAIL });
    expect(outcome.perTool[0].threw).toBe(true);
    expect(outcome.rejectMessage).toContain('threw');
  });

  it('a TIMING-OUT verify() yields FAIL via deps.verifyTimeoutMs (timedOut:true); a late reject is abandoned', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await runFixtureTool(h, '{}');
      // Settles AFTER the 100ms gate timeout, AND rejects — both must be abandoned.
      registerVerify(FIXTURE_TOOL, () => new Promise<VerifyResult>((_resolve, reject) => {
        setTimeout(() => reject(new Error('late rejection after abandon')), 250);
      }));

      const outcome = await evaluateCoordinatorGate(h.deps, input());

      expect(outcome.pass).toBe(false);
      expect(outcome.failures[0]).toMatchObject({ tool: FIXTURE_TOOL, kind: VerifierGateBlockKind.VERIFY_FAIL });
      expect(outcome.perTool[0].timedOut).toBe(true);
      expect(outcome.rejectMessage).toContain('timed out');
      // Wait past the late rejection so any unhandledRejection would surface.
      await new Promise(r => setTimeout(r, 300));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3 — a required tool whose LATEST tool-result event has status===REJECTED
// blocks the transition, independent of any verify() verdict.
// ─────────────────────────────────────────────────────────────────────────────
describe('AC3 — a latest tool-result status===REJECTED blocks (independent of verify())', () => {
  it('blocks (TOOL_REJECTED) even when a PASS-returning verify() is registered', async () => {
    // The tool RAN but its result is REJECTED (it could not run to completion).
    // pi-experiment-yhec: must include a canonical evidenceHandle.
    await runFixtureToolRejected(h);
    let verifyConsulted = false;
    registerVerify(FIXTURE_TOOL, () => { verifyConsulted = true; return { verdict: VerifyVerdict.PASS, reasons: ['would pass'] }; });

    const outcome = await evaluateCoordinatorGate(h.deps, input());

    expect(outcome.pass).toBe(false);
    expect(outcome.failures[0]).toMatchObject({ tool: FIXTURE_TOOL, kind: VerifierGateBlockKind.TOOL_REJECTED });
    // The REJECTED run short-circuits BEFORE verify() — the callback is not consulted.
    expect(verifyConsulted).toBe(false);
    expect(outcome.failures[0].verdict).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4 — config/startup fail-fast for an UNREGISTERED required tool that expects
// a verify(); a presence-only tool with NO verify() loads cleanly. Driven
// through the REAL ConfigLoader + the REAL validateRequiredToolVerifiers.
// ─────────────────────────────────────────────────────────────────────────────
describe('AC4 — config fail-fast names an unregistered expectsVerify tool; presence-only loads cleanly', () => {
  function configWith(requiredToolsYaml: string): { configLoader: ConfigLoader; config: HarnessConfig; root: string } {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-0yt5-28-cfg-')));
    fs.writeFileSync(path.join(root, 'harness.yaml'), `
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
    actions:
      - id: code
        type: prompt
        requiredTools:
${requiredToolsYaml}
    transitions: { SUCCESS: "completed", FAILURE: "Implementing" }
`);
    const configLoader = new ConfigLoader(undefined, root);
    const config = configLoader.load();
    return { configLoader, config, root };
  }

  it('FAILS FAST naming the unregistered tool that declares expectsVerify:true', () => {
    const { configLoader, config, root } = configWith(
      `          - name: needs_verify_tool\n            expectsVerify: true`
    );
    try {
      // No verify() registered for needs_verify_tool ⇒ startup validation throws.
      expect(() => validateRequiredToolVerifiers(config)).toThrowError(/needs_verify_tool/);
      // And it is explicitly framed as a fail-fast config error.
      expect(() => validateRequiredToolVerifiers(config)).toThrowError(/expectsVerify/);
    } finally {
      configLoader.reset();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('a presence-only required tool with NO verify() loads cleanly (no throw)', () => {
    const { configLoader, config, root } = configWith(
      `          - name: presence_only_tool`
    );
    try {
      // Presence-only (no expectsVerify) ⇒ validation passes with NO callback.
      expect(() => validateRequiredToolVerifiers(config)).not.toThrow();
    } finally {
      configLoader.reset();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('an expectsVerify tool WITH a registered verify() loads cleanly', () => {
    const { configLoader, config, root } = configWith(
      `          - name: registered_verify_tool\n            expectsVerify: true`
    );
    try {
      registerVerify('registered_verify_tool', () => ({ verdict: VerifyVerdict.PASS, reasons: [] }));
      expect(() => validateRequiredToolVerifiers(config)).not.toThrow();
    } finally {
      configLoader.reset();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
