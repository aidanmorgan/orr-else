/**
 * pi-experiment-0yt5.5 — the harness-owned COORDINATOR-side verifier loop.
 *
 * The harness owns a generic verifier loop (`runVerifierGate`) that, for a
 * transition declaring `requiredTools: [t1, t2]`, resolves each tool's LATEST
 * tool-result event coordinator-side (recovering its outputFile + run status),
 * runs each tool's REGISTERED verify() callback (from the contract `verifier`
 * registry) with the full PATHS-ONLY VerifyContext, and aggregates by enum.
 *
 * These tests prove the loop MECHANISM + aggregate routing as a well-tested
 * unit. Two layers are exercised:
 *   - runVerifierGate against a fake store + the real contract registry (AC1-5).
 *   - latestToolResultEvent against a REAL EventStore that recorded BOTH the
 *     FLAT (command/MCP) and NESTED (plugin) tool-result event shapes — proving
 *     the coordinator-side latest-event-per-(bead,state,action,tool) resolution
 *     handles both shapes (AC1/AC3 require coordinator-side outputFile+status).
 *
 * The full handleTeammateEvent call-site wiring (running this loop before
 * STATE_TRANSITION_APPLIED is committed) is bead 0yt5.20's deliverable.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Import the contract from the SAME source module the VerifierGate consumes
// (src/contract.ts). The `verifier` registry is a module-level singleton: the
// gate uses the src instance, so the test must register into the src instance
// — not the dist-built `orr-else/contract` subpath, which is a SEPARATE module.
import {
  verifier,
  VerifyVerdict,
  type VerifyContext,
  type VerifyResult
} from '../src/contract.js';

import {
  runVerifierGate,
  VerifierGateBlockKind,
  type VerifierGateContext,
  type VerifierGateEventStore
} from '../src/core/VerifierGate.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { EventStore } from '../src/core/EventStore.js';
import { DomainEventName, ToolResultStatus } from '../src/constants/index.js';
import type { DomainEvent } from '../src/core/EventStoreTypes.js';

// ── A fake coordinator-readable store keyed by (bead,state,action,tool) ───────
class FakeToolResultStore implements VerifierGateEventStore {
  private readonly events = new Map<string, DomainEvent>();

  private key(beadId: string, stateId: string, actionId: string, tool: string): string {
    return [beadId, stateId, actionId, tool].join('\0');
  }

  /** Record a FLAT-shape (command/MCP) latest tool-result event. */
  setFlat(beadId: string, stateId: string, actionId: string, tool: string, status: ToolResultStatus, outputFile: string): void {
    this.events.set(this.key(beadId, stateId, actionId, tool), {
      id: `flat-${tool}`,
      type: status === ToolResultStatus.PASSED ? DomainEventName.PROJECT_TOOL_SUCCEEDED : DomainEventName.PROJECT_TOOL_FAILED,
      timestamp: new Date().toISOString(),
      sessionId: 'test',
      data: { beadId, stateId, actionId, tool, status, outputFile }
    });
  }

  async latestToolResultEvent(beadId: string, stateId: string, actionId: string, tool: string): Promise<DomainEvent | undefined> {
    return this.events.get(this.key(beadId, stateId, actionId, tool));
  }
}

const baseCtx: VerifierGateContext = {
  beadId: 'bd-1',
  stateId: 'Implementing',
  actionId: 'code',
  writeSet: ['/w/src/a.ts'],
  artifacts: { plan: '/artifacts/plan.md' }
};

// Track names we register so we can clean up the module-level singleton.
const registered: string[] = [];
function registerVerify(tool: string, fn: (ctx: VerifyContext) => VerifyResult | Promise<VerifyResult>): void {
  verifier.register(tool, fn);
  registered.push(tool);
}

afterEach(() => {
  // The contract registry is a module-level singleton with last-wins semantics
  // and no removal API. Overwrite every callback this suite registered with an
  // inert NOT_APPLICABLE stub so a stale callback can never leak into another
  // test (every test that needs a tool re-registers it in its own arrange step).
  for (const tool of registered.splice(0)) {
    verifier.register(tool, () => ({ verdict: VerifyVerdict.NOT_APPLICABLE, reasons: [] }));
  }
});

describe('pi-experiment-0yt5.5: AC1 — loop resolves each tool outputFile and calls BOTH verify() with the full paths-only VerifyContext', () => {
  it('runs both registered callbacks with the resolved toolOutputs + paths-only context', async () => {
    const store = new FakeToolResultStore();
    store.setFlat('bd-1', 'Implementing', 'code', 't1', ToolResultStatus.PASSED, '/proj/.pi/tool-output/bd-1/Implementing/code/t1/inv/output/o.json');
    store.setFlat('bd-1', 'Implementing', 'code', 't2', ToolResultStatus.PASSED, '/proj/.pi/tool-output/bd-1/Implementing/code/t2/inv/output/o.json');

    const seen: VerifyContext[] = [];
    const capture = (verdict: VerifyVerdict) => (ctx: VerifyContext): VerifyResult => {
      seen.push(ctx);
      return { verdict, reasons: [] };
    };
    registerVerify('t1', capture(VerifyVerdict.PASS));
    registerVerify('t2', capture(VerifyVerdict.PASS));

    const result = await runVerifierGate(baseCtx, ['t1', 't2'], store);

    // BOTH callbacks ran.
    expect(seen.length).toBe(2);
    // Each saw the full paths-only context: identity + writeSet + artifacts.
    for (const ctx of seen) {
      expect(ctx.beadId).toBe('bd-1');
      expect(ctx.stateId).toBe('Implementing');
      expect(ctx.actionId).toBe('code');
      expect(ctx.writeSet).toEqual(['/w/src/a.ts']);
      expect(ctx.artifacts).toEqual({ plan: '/artifacts/plan.md' });
      // toolOutputs maps EVERY required tool's resolved outputFile path.
      expect(ctx.toolOutputs.t1).toBe('/proj/.pi/tool-output/bd-1/Implementing/code/t1/inv/output/o.json');
      expect(ctx.toolOutputs.t2).toBe('/proj/.pi/tool-output/bd-1/Implementing/code/t2/inv/output/o.json');
    }
    expect(result.pass).toBe(true);
    expect(result.failures).toEqual([]);
  });
});

describe('pi-experiment-0yt5.5: AC2 — aggregate gating by enum', () => {
  it('verdict:FAIL blocks the transition', async () => {
    const store = new FakeToolResultStore();
    store.setFlat('bd-1', 'Implementing', 'code', 't1', ToolResultStatus.PASSED, '/proj/.pi/tool-output/bd-1/Implementing/code/t1/inv/output/o.json');
    registerVerify('t1', () => ({ verdict: VerifyVerdict.FAIL, reasons: ['t1 says no'] }));

    const result = await runVerifierGate(baseCtx, ['t1'], store);
    expect(result.pass).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ tool: 't1', kind: VerifierGateBlockKind.VERIFY_FAIL, verdict: VerifyVerdict.FAIL });
  });

  it('NOT_APPLICABLE is ignored; all-PASS/NA advances', async () => {
    const store = new FakeToolResultStore();
    store.setFlat('bd-1', 'Implementing', 'code', 't1', ToolResultStatus.PASSED, '/proj/.pi/tool-output/bd-1/Implementing/code/t1/inv/output/o.json');
    store.setFlat('bd-1', 'Implementing', 'code', 't2', ToolResultStatus.PASSED, '/proj/.pi/tool-output/bd-1/Implementing/code/t2/inv/output/o.json');
    registerVerify('t1', () => ({ verdict: VerifyVerdict.PASS, reasons: [] }));
    registerVerify('t2', () => ({ verdict: VerifyVerdict.NOT_APPLICABLE, reasons: ['not my content'] }));

    const result = await runVerifierGate(baseCtx, ['t1', 't2'], store);
    expect(result.pass).toBe(true);
    expect(result.failures).toEqual([]);
  });
});

describe('pi-experiment-0yt5.5: AC3 — did-not-run blocks even with no verify() FAIL', () => {
  it('a required tool whose latest event status===REJECTED blocks', async () => {
    const store = new FakeToolResultStore();
    store.setFlat('bd-1', 'Implementing', 'code', 't1', ToolResultStatus.REJECTED, '/proj/.pi/tool-output/bd-1/Implementing/code/t1/inv/output/o.json');
    // Even a PASS-returning verify() cannot rescue a REJECTED run.
    registerVerify('t1', () => ({ verdict: VerifyVerdict.PASS, reasons: ['would pass'] }));

    const result = await runVerifierGate(baseCtx, ['t1'], store);
    expect(result.pass).toBe(false);
    expect(result.failures[0]).toMatchObject({ tool: 't1', kind: VerifierGateBlockKind.TOOL_REJECTED });
    // The verify() must NOT have been consulted to overturn a REJECTED run.
    expect(result.failures[0].verdict).toBeUndefined();
  });

  it('a required tool with NO event for this attempt (not invoked) blocks', async () => {
    const store = new FakeToolResultStore();
    // Nothing recorded for t1.
    registerVerify('t1', () => ({ verdict: VerifyVerdict.PASS, reasons: ['would pass'] }));

    const result = await runVerifierGate(baseCtx, ['t1'], store);
    expect(result.pass).toBe(false);
    expect(result.failures[0]).toMatchObject({ tool: 't1', kind: VerifierGateBlockKind.TOOL_NOT_INVOKED });
  });
});

describe('pi-experiment-0yt5.5: AC4 — NEGATIVE: an unrelated tool cannot force a transition', () => {
  it('a callback that does not own the content returns NOT_APPLICABLE, never PASS, so it cannot satisfy a FAILing peer', async () => {
    const store = new FakeToolResultStore();
    store.setFlat('bd-1', 'Implementing', 'code', 'owner', ToolResultStatus.PASSED, '/proj/.pi/tool-output/bd-1/Implementing/code/owner/inv/output/o.json');
    store.setFlat('bd-1', 'Implementing', 'code', 'unrelated', ToolResultStatus.PASSED, '/proj/.pi/tool-output/bd-1/Implementing/code/unrelated/inv/output/o.json');

    // The unrelated tool only PASSES content it OWNS; for anything else it must
    // return NOT_APPLICABLE — it can never force the transition through.
    registerVerify('unrelated', (ctx): VerifyResult => {
      const ownsOutput = typeof ctx.toolOutputs['unrelated-owned-marker'] === 'string';
      return ownsOutput
        ? { verdict: VerifyVerdict.PASS, reasons: ['owns it'] }
        : { verdict: VerifyVerdict.NOT_APPLICABLE, reasons: ['does not own this content'] };
    });
    // The OWNING tool fails its content.
    registerVerify('owner', () => ({ verdict: VerifyVerdict.FAIL, reasons: ['owner content invalid'] }));

    const result = await runVerifierGate(baseCtx, ['owner', 'unrelated'], store);
    // The unrelated tool's NOT_APPLICABLE is ignored and cannot override the
    // owner's FAIL — the transition is BLOCKED.
    expect(result.pass).toBe(false);
    expect(result.failures.map(f => f.tool)).toEqual(['owner']);
  });
});

describe('pi-experiment-0yt5.5: AC5 — multiple FAILs surfaced as a structured array AND a rendered reject message', () => {
  it('collects every failing {tool, verdict, reasons} and renders a message', async () => {
    const store = new FakeToolResultStore();
    store.setFlat('bd-1', 'Implementing', 'code', 't1', ToolResultStatus.PASSED, '/proj/.pi/tool-output/bd-1/Implementing/code/t1/inv/output/o.json');
    store.setFlat('bd-1', 'Implementing', 'code', 't2', ToolResultStatus.PASSED, '/proj/.pi/tool-output/bd-1/Implementing/code/t2/inv/output/o.json');
    registerVerify('t1', () => ({ verdict: VerifyVerdict.FAIL, reasons: ['t1 reason a', 't1 reason b'], failureOutcome: 'REWORK' }));
    registerVerify('t2', () => ({ verdict: VerifyVerdict.FAIL, reasons: ['t2 reason'] }));

    const result = await runVerifierGate(baseCtx, ['t1', 't2'], store);

    expect(result.pass).toBe(false);
    // Structured array carries BOTH verdicts and reasons for every failure.
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0]).toMatchObject({ tool: 't1', verdict: VerifyVerdict.FAIL, reasons: ['t1 reason a', 't1 reason b'], failureOutcome: 'REWORK' });
    expect(result.failures[1]).toMatchObject({ tool: 't2', verdict: VerifyVerdict.FAIL, reasons: ['t2 reason'] });
    // Rendered message names every failing tool + its reasons + advisory outcome.
    expect(result.rejectMessage).toContain('2 required tools failed');
    expect(result.rejectMessage).toContain('t1');
    expect(result.rejectMessage).toContain('t1 reason a; t1 reason b');
    expect(result.rejectMessage).toContain('advisory failureOutcome=REWORK');
    expect(result.rejectMessage).toContain('t2 reason');
  });
});

// ── Coordinator-side latest-event resolution against a REAL EventStore ────────
describe('pi-experiment-0yt5.5: AC1/AC3 — latestToolResultEvent resolves outputFile+status for BOTH event shapes', () => {
  let projectRoot: string;
  let configLoader: ConfigLoader;
  let store: EventStore;

  beforeEach(() => {
    projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-0yt5-5-')));
    fs.writeFileSync(path.join(projectRoot, 'harness.yaml'), `
settings:
  startState: Implementing
  eventStore:
    enabled: true
  worktreePolicy:
    default: always
states:
  Implementing:
    identity: { role: "Eng", expertise: "x", constraints: [] }
    baseInstructions: "Do"
    actions: []
    transitions: { SUCCESS: "completed", FAILURE: "Implementing" }
`);
    configLoader = new ConfigLoader(undefined, projectRoot);
    store = new EventStore(configLoader, undefined, undefined, projectRoot);
    store.setSessionId(`test-${process.pid}`);
  });

  afterEach(() => {
    configLoader.reset();
    vi.restoreAllMocks();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('resolves the FLAT (command/MCP) shape outputFile + status', async () => {
    const outputFile = path.join(projectRoot, '.pi', 'tool-output', 'bd-1', 'Implementing', 'code', 'flatTool', 'inv', 'output', 'o.json');
    await store.record(DomainEventName.PROJECT_TOOL_SUCCEEDED, {
      beadId: 'bd-1', stateId: 'Implementing', actionId: 'code', tool: 'flatTool',
      status: ToolResultStatus.PASSED, outputFile
    });
    const event = await store.latestToolResultEvent('bd-1', 'Implementing', 'code', 'flatTool');
    expect(event?.type).toBe(DomainEventName.PROJECT_TOOL_SUCCEEDED);
    expect((event!.data as Record<string, unknown>).outputFile).toBe(outputFile);
    expect((event!.data as Record<string, unknown>).status).toBe(ToolResultStatus.PASSED);
  });

  it('resolves the NESTED (plugin) shape via explicit canonical identity fields (u7cl: path-segment fallback removed)', async () => {
    // u7cl: NESTED plugin events must carry explicit stateId/actionId at the
    // top level — path-segment parsing from toolResult.outputFile is removed.
    const outputFile = path.join(projectRoot, '.pi', 'tool-output', 'bd-1', 'Implementing', 'code', 'pluginTool', 'inv', 'output', 'plugin-raw.json');
    await store.record(DomainEventName.TOOL_INVOCATION_SUCCEEDED, {
      beadId: 'bd-1', stateId: 'Implementing', actionId: 'code', tool: 'pluginTool',
      toolResult: { tool: 'pluginTool', status: ToolResultStatus.PASSED, outputFile, outputFileBytes: 12 }
    });
    const event = await store.latestToolResultEvent('bd-1', 'Implementing', 'code', 'pluginTool');
    expect(event?.type).toBe(DomainEventName.TOOL_INVOCATION_SUCCEEDED);
    const toolResult = (event!.data as Record<string, unknown>).toolResult as Record<string, unknown>;
    expect(toolResult.outputFile).toBe(outputFile);
    expect(toolResult.status).toBe(ToolResultStatus.PASSED);
    // A different (state,action) must NOT match the same plugin event.
    expect(await store.latestToolResultEvent('bd-1', 'OtherState', 'code', 'pluginTool')).toBeUndefined();
  });

  it('a retry records a fresher event and the LATEST (REJECTED) wins over the stale PASS', async () => {
    const firstFile = path.join(projectRoot, '.pi', 'tool-output', 'bd-1', 'Implementing', 'code', 'flatTool', 'inv-1', 'output', 'o.json');
    const retryFile = path.join(projectRoot, '.pi', 'tool-output', 'bd-1', 'Implementing', 'code', 'flatTool', 'inv-2', 'output', 'o.json');
    await store.record(DomainEventName.PROJECT_TOOL_SUCCEEDED, {
      beadId: 'bd-1', stateId: 'Implementing', actionId: 'code', tool: 'flatTool',
      status: ToolResultStatus.PASSED, outputFile: firstFile
    });
    await store.record(DomainEventName.PROJECT_TOOL_FAILED, {
      beadId: 'bd-1', stateId: 'Implementing', actionId: 'code', tool: 'flatTool',
      status: ToolResultStatus.REJECTED, failureCategory: 'INFRA', outputFile: retryFile
    });

    const event = await store.latestToolResultEvent('bd-1', 'Implementing', 'code', 'flatTool');
    expect(event?.type).toBe(DomainEventName.PROJECT_TOOL_FAILED);
    expect((event!.data as Record<string, unknown>).outputFile).toBe(retryFile);

    // The gate, fed this real store, BLOCKS on the freshest REJECTED run.
    const result = await runVerifierGate(
      { beadId: 'bd-1', stateId: 'Implementing', actionId: 'code', writeSet: [], artifacts: {} },
      ['flatTool'],
      store
    );
    expect(result.pass).toBe(false);
    expect(result.failures[0].kind).toBe(VerifierGateBlockKind.TOOL_REJECTED);
  });
});

// ── pi-experiment-q64l: cache-hit events must carry durable tool-result shape ──
describe('pi-experiment-q64l: AC2/AC3/AC4 — cache-hit TOOL_INVOCATION_SUCCEEDED carries durable toolResult', () => {
  let projectRoot: string;
  let configLoader: ConfigLoader;
  let store: EventStore;

  beforeEach(() => {
    projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-q64l-')));
    fs.writeFileSync(path.join(projectRoot, 'harness.yaml'), `
settings:
  startState: Implementing
  eventStore:
    enabled: true
  worktreePolicy:
    default: always
states:
  Implementing:
    identity: { role: "Eng", expertise: "x", constraints: [] }
    baseInstructions: "Do"
    actions: []
    transitions: { SUCCESS: "completed", FAILURE: "Implementing" }
`);
    configLoader = new ConfigLoader(undefined, projectRoot);
    store = new EventStore(configLoader, undefined, undefined, projectRoot);
    store.setSessionId(`test-${process.pid}`);
  });

  afterEach(() => {
    configLoader.reset();
    vi.restoreAllMocks();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  // AC2: the second (cache-hit) TOOL_INVOCATION_SUCCEEDED carries toolResult.status + toolResult.outputFile.
  it('AC2 — cache-hit TOOL_INVOCATION_SUCCEEDED includes toolResult.status and toolResult.outputFile', async () => {
    // Simulate what the non-cached path records (first invocation).
    const outputFile = path.join(projectRoot, '.pi', 'tool-output', 'bd-1', 'Implementing', 'code', 'cacheableTool', 'inv-1', 'plugin-raw.json');
    const toolResult = { tool: 'cacheableTool', status: ToolResultStatus.PASSED, outputFile, outputFileBytes: 42 };

    // First invocation — non-cached, durable shape. Explicit identity required (u7cl).
    await store.record(DomainEventName.TOOL_INVOCATION_SUCCEEDED, {
      beadId: 'bd-1', stateId: 'Implementing', actionId: 'code', tool: 'cacheableTool',
      result: { ok: true },
      toolResult
    });

    // Second invocation — cache hit. Must include the SAME toolResult handle + cached:true.
    await store.record(DomainEventName.TOOL_INVOCATION_SUCCEEDED, {
      beadId: 'bd-1', stateId: 'Implementing', actionId: 'code', tool: 'cacheableTool',
      result: { ok: true },
      cached: true,
      cacheAgeMs: 10,
      toolResult
    });

    // AC2: the cached event carries toolResult.status + toolResult.outputFile.
    const events = await store.readAll();
    const cacheHitEvent = events.filter(
      e => e.type === DomainEventName.TOOL_INVOCATION_SUCCEEDED
        && (e.data as Record<string, unknown>).cached === true
    );
    expect(cacheHitEvent).toHaveLength(1);
    const data = cacheHitEvent[0].data as Record<string, unknown>;
    const tr = data.toolResult as Record<string, unknown>;
    expect(tr).toBeDefined();
    expect(tr.status).toBe(ToolResultStatus.PASSED);
    expect(tr.outputFile).toBe(outputFile);
    // Model-facing output unchanged: result is still present, cached:true is added, no new fields on result.
    expect(data.result).toEqual({ ok: true });
    expect(data.cached).toBe(true);
  });

  // AC3: latestToolResultEvent resolves the cache-hit event.
  it('AC3 — latestToolResultEvent resolves a cache-hit event with toolResult.outputFile', async () => {
    const outputFile = path.join(projectRoot, '.pi', 'tool-output', 'bd-1', 'Implementing', 'code', 'cacheableTool', 'inv-1', 'plugin-raw.json');
    const toolResult = { tool: 'cacheableTool', status: ToolResultStatus.PASSED, outputFile, outputFileBytes: 42 };

    // First invocation at t=1. Explicit identity required (u7cl).
    await store.record(DomainEventName.TOOL_INVOCATION_SUCCEEDED, {
      beadId: 'bd-1', stateId: 'Implementing', actionId: 'code', tool: 'cacheableTool',
      result: { ok: true }, toolResult
    });

    // Cache-hit at t=2 — same toolResult handle, cached:true. Explicit identity required (u7cl).
    await store.record(DomainEventName.TOOL_INVOCATION_SUCCEEDED, {
      beadId: 'bd-1', stateId: 'Implementing', actionId: 'code', tool: 'cacheableTool',
      result: { ok: true }, cached: true, cacheAgeMs: 5,
      toolResult
    });

    // AC3: latestToolResultEvent must resolve the SECOND (cache-hit) event.
    const event = await store.latestToolResultEvent('bd-1', 'Implementing', 'code', 'cacheableTool');
    expect(event).toBeDefined();
    expect(event?.type).toBe(DomainEventName.TOOL_INVOCATION_SUCCEEDED);
    const tr = (event!.data as Record<string, unknown>).toolResult as Record<string, unknown>;
    expect(tr.outputFile).toBe(outputFile);
    expect(tr.status).toBe(ToolResultStatus.PASSED);
    // The resolved event IS the cache-hit one.
    expect((event!.data as Record<string, unknown>).cached).toBe(true);
  });

  // AC4: the verifier gate validates using the cache-hit event output.
  it('AC4 — verifier gate validates cache-hit event output (PASS path)', async () => {
    const outputFile = path.join(projectRoot, '.pi', 'tool-output', 'bd-1', 'Implementing', 'code', 'cacheableTool', 'inv-1', 'plugin-raw.json');
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, JSON.stringify({ verified: true }));
    const toolResult = { tool: 'cacheableTool', status: ToolResultStatus.PASSED, outputFile, outputFileBytes: 20 };

    // Only the cache-hit event is recorded (no prior non-cached event). Explicit identity (u7cl).
    await store.record(DomainEventName.TOOL_INVOCATION_SUCCEEDED, {
      beadId: 'bd-1', stateId: 'Implementing', actionId: 'code', tool: 'cacheableTool',
      result: { ok: true }, cached: true, cacheAgeMs: 0,
      toolResult
    });

    let verifyReadPath: string | undefined;
    verifier.register('cacheableTool', (ctx): VerifyResult => {
      verifyReadPath = ctx.toolOutputs['cacheableTool'];
      return { verdict: VerifyVerdict.PASS, reasons: [] };
    });

    const result = await runVerifierGate(
      { beadId: 'bd-1', stateId: 'Implementing', actionId: 'code', writeSet: [], artifacts: {} },
      ['cacheableTool'],
      store
    );

    // Gate passes, and verify() received the correct outputFile path.
    expect(result.pass).toBe(true);
    expect(verifyReadPath).toBe(outputFile);

    // Cleanup registry.
    verifier.register('cacheableTool', () => ({ verdict: VerifyVerdict.NOT_APPLICABLE, reasons: [] }));
  });

  // AC5 (model-facing output unchanged): the result field on a cache-hit event is unchanged.
  it('AC5 — model-facing result is unchanged on cache-hit (cached:true added, result field untouched)', async () => {
    const outputFile = path.join(projectRoot, '.pi', 'tool-output', 'bd-1', 'Implementing', 'code', 'cacheableTool', 'inv-1', 'plugin-raw.json');
    const originalResult = { field: 'value', nested: { x: 1 } };
    const toolResult = { tool: 'cacheableTool', status: ToolResultStatus.PASSED, outputFile, outputFileBytes: 30 };

    await store.record(DomainEventName.TOOL_INVOCATION_SUCCEEDED, {
      beadId: 'bd-1', stateId: 'Implementing', actionId: 'code', tool: 'cacheableTool',
      result: originalResult, cached: true, cacheAgeMs: 200,
      toolResult
    });

    const events = await store.readAll();
    const hit = events.find(e => (e.data as Record<string, unknown>).cached === true);
    expect(hit).toBeDefined();
    // The result is unchanged.
    expect((hit!.data as Record<string, unknown>).result).toEqual(originalResult);
    // cached + cacheAgeMs are additive, not replacing result.
    expect((hit!.data as Record<string, unknown>).cached).toBe(true);
    expect((hit!.data as Record<string, unknown>).cacheAgeMs).toBe(200);
  });
});
