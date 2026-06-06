/**
 * pi-experiment-dsm2.12 + pi-experiment-u7cl — Explicit verifier identity on tool result events.
 *
 * u7cl: path-derived identity matching removed from production code. Events missing
 * explicit stateId/actionId at the top level do NOT satisfy latestToolResultEvent
 * or verifier gates. Tests updated to reflect explicit-only matching.
 *
 * ACCEPTANCE CRITERIA (11 scenarios):
 *  1. explicit-identity success: flat project tool event carries beadId,
 *     stateId, actionId, toolName, toolInvocationId, schemaId, schemaVersion.
 *  2. explicit-identity success: nested plugin tool event carries the same
 *     identity fields at the top level (not only inside toolResult path).
 *  3. NEGATIVE (u7cl): TOOL_INVOCATION_* event WITHOUT explicit stateId/actionId
 *     is NOT matched by latestToolResultEvent regardless of outputFile path layout.
 *  4. NEGATIVE (u7cl): path-only TOOL_INVOCATION_* event (even with a well-formed
 *     outputFile path) cannot satisfy a verifier gate — gate sees TOOL_NOT_INVOKED.
 *  5. wrong-state/action guard: an event with explicit stateId=X,actionId=Y does
 *     NOT match latestToolResultEvent(…, stateId=A, actionId=B, …).
 *  6. cache-hit identity: a TOOL_INVOCATION_SUCCEEDED with cached:true carries
 *     the same explicit identity fields as a non-cached event.
 *  7. retry ordering: when two events share the same (beadId,stateId,actionId,tool)
 *     the freshest timestamp wins regardless of which has explicit fields.
 *  8. missing Pi toolCallId: a PiObserver event written WITHOUT a toolCallId still
 *     carries all other explicit identity fields (toolCallId is optional/undefined).
 *  9. duplicate Pi toolCallId: if two events share the same toolCallId only the
 *     later timestamp (freshest) is returned by latestToolResultEvent.
 * 10. out-of-order update/end: a TOOL_INVOCATION_STARTED with an earlier timestamp
 *     never beats a TOOL_INVOCATION_SUCCEEDED with a later timestamp even when
 *     written second.
 * 11. mixed legacy+modern: a legacy (path-only) event is not matched; the modern
 *     explicit-identity event for the same (bead,state,action,tool) IS matched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventStore } from '../src/core/EventStore.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { DomainEventName, ToolResultStatus } from '../src/constants/index.js';
import { Logger } from '../src/core/Logger.js';
import { mapPiToolCallIdToInvocationId } from '../src/extension/PiEventAdapters.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function writeMinimalHarness(dir: string): void {
  fs.writeFileSync(path.join(dir, 'harness.yaml'), `
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
}

function makeStore(dir: string): { configLoader: ConfigLoader; store: EventStore } {
  const configLoader = new ConfigLoader(undefined, dir);
  const store = new EventStore(configLoader, undefined, undefined, dir);
  store.setSessionId(`test-dsm2-12-${process.pid}`);
  return { configLoader, store };
}

function toolOutputPath(
  projectRoot: string,
  beadId: string, stateId: string, actionId: string,
  toolName: string, invocationId = 'inv-1'
): string {
  return path.join(projectRoot, '.pi', 'tool-output', beadId, stateId, actionId, toolName, invocationId, 'output', 'result.json');
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('dsm2.12: explicit verifier identity on tool result events', () => {
  let projectRoot: string;
  let configLoader: ConfigLoader;
  let store: EventStore;

  beforeEach(() => {
    projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsm2-12-')));
    fs.mkdirSync(path.join(projectRoot, '.pi', 'events'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.pi', 'logs'), { recursive: true });
    writeMinimalHarness(projectRoot);
    ({ configLoader, store } = makeStore(projectRoot));
  });

  afterEach(async () => {
    configLoader.reset();
    Logger.close();
    await new Promise(resolve => setTimeout(resolve, 25));
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  // ── Scenario 1: explicit identity on flat project-tool event ──────────────
  it('SC1: flat PROJECT_TOOL_SUCCEEDED carries explicit beadId/stateId/actionId/toolName/toolInvocationId/schemaId', async () => {
    const outputFile = toolOutputPath(projectRoot, 'bd-1', 'Implementing', 'code', 'flatTool');
    await store.record(DomainEventName.PROJECT_TOOL_SUCCEEDED, {
      beadId: 'bd-1',
      stateId: 'Implementing',
      actionId: 'code',
      tool: 'flatTool',
      toolName: 'flatTool',
      toolInvocationId: 'inv-explicit-1',
      status: ToolResultStatus.PASSED,
      outputFile,
      schemaId: 'tool-result-identity/1.0',
      schemaVersion: '1.0',
    });

    const event = await store.latestToolResultEvent('bd-1', 'Implementing', 'code', 'flatTool');
    expect(event).toBeDefined();
    const data = event!.data as Record<string, unknown>;

    // Explicit identity fields must be present
    expect(data.beadId).toBe('bd-1');
    expect(data.stateId).toBe('Implementing');
    expect(data.actionId).toBe('code');
    // tool is the existing key; toolName is the new explicit alias
    expect(data.toolName).toBe('flatTool');
    expect(data.toolInvocationId).toBe('inv-explicit-1');
    expect(data.schemaId).toBe('tool-result-identity/1.0');
    expect(data.schemaVersion).toBe('1.0');
  });

  // ── Scenario 2: explicit identity on nested plugin event ─────────────────
  it('SC2: TOOL_INVOCATION_SUCCEEDED carries explicit beadId/stateId/actionId/toolName/toolInvocationId at top level', async () => {
    const outputFile = toolOutputPath(projectRoot, 'bd-1', 'Implementing', 'code', 'pluginTool');
    await store.record(DomainEventName.TOOL_INVOCATION_SUCCEEDED, {
      beadId: 'bd-1',
      stateId: 'Implementing',
      actionId: 'code',
      tool: 'pluginTool',
      toolName: 'pluginTool',
      toolInvocationId: 'inv-explicit-2',
      schemaId: 'tool-result-identity/1.0',
      schemaVersion: '1.0',
      toolResult: { tool: 'pluginTool', status: ToolResultStatus.PASSED, outputFile, outputFileBytes: 20 }
    });

    const event = await store.latestToolResultEvent('bd-1', 'Implementing', 'code', 'pluginTool');
    expect(event).toBeDefined();
    const data = event!.data as Record<string, unknown>;

    // Explicit identity at the TOP level (not only nested in toolResult)
    expect(data.beadId).toBe('bd-1');
    expect(data.stateId).toBe('Implementing');
    expect(data.actionId).toBe('code');
    expect(data.toolName).toBe('pluginTool');
    expect(data.toolInvocationId).toBe('inv-explicit-2');
    expect(data.schemaId).toBe('tool-result-identity/1.0');
    expect(data.schemaVersion).toBe('1.0');
  });

  // ── Scenario 3: NEGATIVE — path-only event is NOT matched (u7cl) ─────────
  it('SC3: TOOL_INVOCATION_SUCCEEDED without explicit stateId/actionId is NOT matched (path-only events rejected)', async () => {
    // Path-only (legacy) shape: no stateId/actionId at top level.
    // The outputFile path IS a well-formed tool-output layout, but that no longer
    // confers identity — matching requires explicit canonical fields (u7cl).
    const outputFile = toolOutputPath(projectRoot, 'bd-1', 'Implementing', 'code', 'legacyTool');
    await store.record(DomainEventName.TOOL_INVOCATION_SUCCEEDED, {
      beadId: 'bd-1',
      tool: 'legacyTool',
      // No stateId, actionId, toolName, toolInvocationId — path-only shape
      toolResult: { tool: 'legacyTool', status: ToolResultStatus.PASSED, outputFile, outputFileBytes: 30 }
    });

    // Must return undefined — explicit identity fields absent; path parsing removed (u7cl).
    const event = await store.latestToolResultEvent('bd-1', 'Implementing', 'code', 'legacyTool');
    expect(event).toBeUndefined();
  });

  // ── Scenario 4: NEGATIVE — path-only event cannot satisfy a verifier gate ─
  it('SC4: path-only TOOL_INVOCATION_SUCCEEDED (no explicit identity) yields TOOL_NOT_INVOKED from the verifier gate', async () => {
    // This is the load-bearing negative test (u7cl): inject a real path-only
    // event with a well-formed tool-output path. The gate must see TOOL_NOT_INVOKED
    // because latestToolResultEvent returns undefined (no explicit identity).
    // If path-fallback were reintroduced, latestToolResultEvent would return the
    // event and the gate would instead see TOOL_REJECTED or PASS — so this test
    // will FAIL if the fallback comes back.
    const { runVerifierGate, VerifierGateBlockKind } = await import('../src/core/VerifierGate.js');

    const outputFile = toolOutputPath(projectRoot, 'bd-1', 'Implementing', 'code', 'pathOnlyTool');
    const eventsPath = path.join(projectRoot, '.pi', 'events', `${path.basename(projectRoot)}.jsonl`);

    // Write a path-only event (no stateId/actionId) directly to the JSONL to
    // simulate a pre-u7cl legacy record (schema only requires 'tool').
    const pathOnlyEvent = {
      id: 'ev-path-only',
      type: DomainEventName.TOOL_INVOCATION_SUCCEEDED,
      timestamp: new Date().toISOString(),
      sessionId: 'test',
      data: {
        beadId: 'bd-1',
        tool: 'pathOnlyTool',
        // No stateId, actionId — path-only shape (pre-dsm2.12 / pre-u7cl legacy)
        toolResult: { tool: 'pathOnlyTool', status: ToolResultStatus.PASSED, outputFile, outputFileBytes: 30 }
      }
    };
    fs.writeFileSync(eventsPath, `${JSON.stringify(pathOnlyEvent)}\n`);

    // latestToolResultEvent returns undefined — explicit identity absent.
    const event = await store.latestToolResultEvent('bd-1', 'Implementing', 'code', 'pathOnlyTool');
    expect(event).toBeUndefined();

    // Gate uses the same store — must see TOOL_NOT_INVOKED (not TOOL_REJECTED / PASS).
    const result = await runVerifierGate(
      { beadId: 'bd-1', stateId: 'Implementing', actionId: 'code', writeSet: [], artifacts: {} },
      ['pathOnlyTool'],
      store
    );
    expect(result.pass).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].kind).toBe(VerifierGateBlockKind.TOOL_NOT_INVOKED);
    expect(result.failures[0].tool).toBe('pathOnlyTool');
  });

  // ── Scenario 5: wrong state/action guard ─────────────────────────────────
  it('SC5: explicit stateId/actionId mismatch is rejected by latestToolResultEvent', async () => {
    const outputFile = toolOutputPath(projectRoot, 'bd-1', 'OtherState', 'other-action', 'myTool');
    await store.record(DomainEventName.TOOL_INVOCATION_SUCCEEDED, {
      beadId: 'bd-1',
      stateId: 'OtherState',
      actionId: 'other-action',
      tool: 'myTool',
      toolName: 'myTool',
      toolInvocationId: 'inv-5',
      schemaId: 'tool-result-identity/1.0',
      schemaVersion: '1.0',
      toolResult: { tool: 'myTool', status: ToolResultStatus.PASSED, outputFile, outputFileBytes: 10 }
    });

    // Querying for a DIFFERENT state/action must NOT match
    const event = await store.latestToolResultEvent('bd-1', 'Implementing', 'code', 'myTool');
    expect(event).toBeUndefined();

    // But the correct state/action DOES match
    const correct = await store.latestToolResultEvent('bd-1', 'OtherState', 'other-action', 'myTool');
    expect(correct).toBeDefined();
  });

  // ── Scenario 6: cache-hit identity ───────────────────────────────────────
  it('SC6: cache-hit TOOL_INVOCATION_SUCCEEDED carries the same explicit identity as the original', async () => {
    const outputFile = toolOutputPath(projectRoot, 'bd-1', 'Implementing', 'code', 'cachedTool');
    const toolResult = { tool: 'cachedTool', status: ToolResultStatus.PASSED, outputFile, outputFileBytes: 15 };

    // Original (non-cached) invocation
    await store.record(DomainEventName.TOOL_INVOCATION_SUCCEEDED, {
      beadId: 'bd-1',
      stateId: 'Implementing',
      actionId: 'code',
      tool: 'cachedTool',
      toolName: 'cachedTool',
      toolInvocationId: 'inv-6-orig',
      schemaId: 'tool-result-identity/1.0',
      schemaVersion: '1.0',
      toolResult
    });

    // Cache-hit (second invocation, same context)
    await store.record(DomainEventName.TOOL_INVOCATION_SUCCEEDED, {
      beadId: 'bd-1',
      stateId: 'Implementing',
      actionId: 'code',
      tool: 'cachedTool',
      toolName: 'cachedTool',
      toolInvocationId: 'inv-6-cache',
      schemaId: 'tool-result-identity/1.0',
      schemaVersion: '1.0',
      cached: true,
      cacheAgeMs: 5000,
      toolResult
    });

    // latestToolResultEvent must return the cache-hit (freshest)
    const event = await store.latestToolResultEvent('bd-1', 'Implementing', 'code', 'cachedTool');
    expect(event).toBeDefined();
    const data = event!.data as Record<string, unknown>;
    expect(data.cached).toBe(true);
    expect(data.toolInvocationId).toBe('inv-6-cache');
    expect(data.stateId).toBe('Implementing');
    expect(data.actionId).toBe('code');
    expect(data.toolName).toBe('cachedTool');
    expect(data.schemaId).toBe('tool-result-identity/1.0');
  });

  // ── Scenario 7: retry ordering ───────────────────────────────────────────
  it('SC7: when two events share (beadId,stateId,actionId,tool) the freshest timestamp wins', async () => {
    const eventsPath = path.join(projectRoot, '.pi', 'events', `${path.basename(projectRoot)}.jsonl`);
    const firstOutput = toolOutputPath(projectRoot, 'bd-1', 'Implementing', 'code', 'retryTool', 'inv-7-a');
    const retryOutput = toolOutputPath(projectRoot, 'bd-1', 'Implementing', 'code', 'retryTool', 'inv-7-b');

    // Write two events: first at t=1 (PASSED), retry at t=2 (FAILED/REJECTED)
    const e1 = {
      id: 'ev-retry-1',
      type: DomainEventName.PROJECT_TOOL_SUCCEEDED,
      timestamp: '2026-01-01T00:00:01.000Z',
      sessionId: 'test',
      data: {
        beadId: 'bd-1', stateId: 'Implementing', actionId: 'code',
        tool: 'retryTool', toolName: 'retryTool',
        toolInvocationId: 'inv-7-a',
        status: ToolResultStatus.PASSED, outputFile: firstOutput,
        schemaId: 'tool-result-identity/1.0', schemaVersion: '1.0',
      }
    };
    const e2 = {
      id: 'ev-retry-2',
      type: DomainEventName.PROJECT_TOOL_FAILED,
      timestamp: '2026-01-01T00:00:02.000Z',
      sessionId: 'test',
      data: {
        beadId: 'bd-1', stateId: 'Implementing', actionId: 'code',
        tool: 'retryTool', toolName: 'retryTool',
        toolInvocationId: 'inv-7-b',
        status: ToolResultStatus.REJECTED, outputFile: retryOutput,
        schemaId: 'tool-result-identity/1.0', schemaVersion: '1.0',
      }
    };
    fs.writeFileSync(eventsPath, `${JSON.stringify(e1)}\n${JSON.stringify(e2)}\n`);

    const event = await store.latestToolResultEvent('bd-1', 'Implementing', 'code', 'retryTool');
    expect(event).toBeDefined();
    expect(event!.id).toBe('ev-retry-2');
    expect((event!.data as Record<string, unknown>).toolInvocationId).toBe('inv-7-b');
  });

  // ── Scenario 8: missing Pi toolCallId ────────────────────────────────────
  it('SC8: TOOL_INVOCATION_SUCCEEDED without toolCallId still carries all other explicit identity fields', async () => {
    const outputFile = toolOutputPath(projectRoot, 'bd-1', 'Implementing', 'code', 'piTool');
    await store.record(DomainEventName.TOOL_INVOCATION_SUCCEEDED, {
      beadId: 'bd-1',
      stateId: 'Implementing',
      actionId: 'code',
      tool: 'piTool',
      toolName: 'piTool',
      toolInvocationId: 'inv-8',
      schemaId: 'tool-result-identity/1.0',
      schemaVersion: '1.0',
      // NO toolCallId
      toolResult: { tool: 'piTool', status: ToolResultStatus.PASSED, outputFile, outputFileBytes: 10 }
    });

    const event = await store.latestToolResultEvent('bd-1', 'Implementing', 'code', 'piTool');
    expect(event).toBeDefined();
    const data = event!.data as Record<string, unknown>;
    expect(data.toolCallId).toBeUndefined();
    expect(data.toolInvocationId).toBe('inv-8');
    expect(data.stateId).toBe('Implementing');
    expect(data.actionId).toBe('code');
    expect(data.toolName).toBe('piTool');
  });

  // ── Scenario 9: duplicate Pi toolCallId ──────────────────────────────────
  it('SC9: two events with the same toolCallId — latestToolResultEvent returns the fresher one', async () => {
    const eventsPath = path.join(projectRoot, '.pi', 'events', `${path.basename(projectRoot)}.jsonl`);
    const out1 = toolOutputPath(projectRoot, 'bd-1', 'Implementing', 'code', 'piDupTool', 'inv-9-a');
    const out2 = toolOutputPath(projectRoot, 'bd-1', 'Implementing', 'code', 'piDupTool', 'inv-9-b');

    const e1 = {
      id: 'ev-dup-1',
      type: DomainEventName.TOOL_INVOCATION_FAILED,
      timestamp: '2026-01-01T00:00:01.000Z',
      sessionId: 'test',
      data: {
        beadId: 'bd-1', stateId: 'Implementing', actionId: 'code',
        tool: 'piDupTool', toolName: 'piDupTool',
        toolCallId: 'tc-shared',
        toolInvocationId: 'inv-9-a',
        schemaId: 'tool-result-identity/1.0', schemaVersion: '1.0',
        toolResult: { tool: 'piDupTool', status: ToolResultStatus.REJECTED, outputFile: out1, outputFileBytes: 10 }
      }
    };
    const e2 = {
      id: 'ev-dup-2',
      type: DomainEventName.TOOL_INVOCATION_SUCCEEDED,
      timestamp: '2026-01-01T00:00:02.000Z',
      sessionId: 'test',
      data: {
        beadId: 'bd-1', stateId: 'Implementing', actionId: 'code',
        tool: 'piDupTool', toolName: 'piDupTool',
        toolCallId: 'tc-shared',
        toolInvocationId: 'inv-9-b',
        schemaId: 'tool-result-identity/1.0', schemaVersion: '1.0',
        toolResult: { tool: 'piDupTool', status: ToolResultStatus.PASSED, outputFile: out2, outputFileBytes: 20 }
      }
    };
    fs.writeFileSync(eventsPath, `${JSON.stringify(e1)}\n${JSON.stringify(e2)}\n`);

    // The freshest one (e2 at t=2) wins
    const event = await store.latestToolResultEvent('bd-1', 'Implementing', 'code', 'piDupTool');
    expect(event).toBeDefined();
    expect(event!.id).toBe('ev-dup-2');
    expect((event!.data as Record<string, unknown>).toolCallId).toBe('tc-shared');
  });

  // ── Scenario 10: out-of-order update/end ─────────────────────────────────
  it('SC10: STARTED event written after SUCCEEDED does not beat the SUCCEEDED (timestamp ordering)', async () => {
    const eventsPath = path.join(projectRoot, '.pi', 'events', `${path.basename(projectRoot)}.jsonl`);
    const outputFile = toolOutputPath(projectRoot, 'bd-1', 'Implementing', 'code', 'orderTool');

    // SUCCEEDED at t=2 written first (already in store), then STARTED at t=1 written later
    const succeeded = {
      id: 'ev-order-succeed',
      type: DomainEventName.TOOL_INVOCATION_SUCCEEDED,
      timestamp: '2026-01-01T00:00:02.000Z',
      sessionId: 'test',
      data: {
        beadId: 'bd-1', stateId: 'Implementing', actionId: 'code',
        tool: 'orderTool', toolName: 'orderTool',
        toolInvocationId: 'inv-10',
        schemaId: 'tool-result-identity/1.0', schemaVersion: '1.0',
        toolResult: { tool: 'orderTool', status: ToolResultStatus.PASSED, outputFile, outputFileBytes: 10 }
      }
    };
    const started = {
      id: 'ev-order-start',
      type: DomainEventName.TOOL_INVOCATION_STARTED,
      timestamp: '2026-01-01T00:00:01.000Z',
      sessionId: 'test',
      data: {
        beadId: 'bd-1', stateId: 'Implementing', actionId: 'code',
        tool: 'orderTool', toolName: 'orderTool',
        toolInvocationId: 'inv-10',
        schemaId: 'tool-result-identity/1.0', schemaVersion: '1.0',
      }
    };
    // Write SUCCEEDED first in the file, STARTED second (out of order)
    fs.writeFileSync(eventsPath, `${JSON.stringify(succeeded)}\n${JSON.stringify(started)}\n`);

    // latestToolResultEvent must return the SUCCEEDED (it's only TOOL_INVOCATION_SUCCEEDED/FAILED + PROJECT_TOOL_*)
    const event = await store.latestToolResultEvent('bd-1', 'Implementing', 'code', 'orderTool');
    // STARTED events are not matched as tool results
    // The only matchable event is the SUCCEEDED
    expect(event).toBeDefined();
    expect(event!.id).toBe('ev-order-succeed');
  });

  // ── Scenario 11: mixed legacy+modern — only modern matches (u7cl) ─────────
  it('SC11: legacy path-only event is not matched; modern explicit-identity event IS matched', async () => {
    const eventsPath = path.join(projectRoot, '.pi', 'events', `${path.basename(projectRoot)}.jsonl`);
    const legacyOutput = toolOutputPath(projectRoot, 'bd-1', 'Implementing', 'code', 'migTool', 'inv-11-legacy');
    const modernOutput = toolOutputPath(projectRoot, 'bd-1', 'Implementing', 'code', 'migTool', 'inv-11-modern');

    // Legacy event (t=1): no explicit stateId/actionId — path-only shape.
    // After u7cl this event DOES NOT match the query (explicit identity required).
    const legacyEvent = {
      id: 'ev-legacy',
      type: DomainEventName.TOOL_INVOCATION_SUCCEEDED,
      timestamp: '2026-01-01T00:00:01.000Z',
      sessionId: 'test',
      data: {
        beadId: 'bd-1',
        tool: 'migTool',
        // No stateId/actionId/toolName — path-only shape, not matchable
        toolResult: { tool: 'migTool', status: ToolResultStatus.PASSED, outputFile: legacyOutput, outputFileBytes: 10 }
      }
    };
    // Modern event (t=2): full explicit identity — this IS matchable.
    const modernEvent = {
      id: 'ev-modern',
      type: DomainEventName.TOOL_INVOCATION_SUCCEEDED,
      timestamp: '2026-01-01T00:00:02.000Z',
      sessionId: 'test',
      data: {
        beadId: 'bd-1',
        stateId: 'Implementing',
        actionId: 'code',
        tool: 'migTool',
        toolName: 'migTool',
        toolInvocationId: 'inv-11-modern',
        schemaId: 'tool-result-identity/1.0',
        schemaVersion: '1.0',
        toolResult: { tool: 'migTool', status: ToolResultStatus.PASSED, outputFile: modernOutput, outputFileBytes: 15 }
      }
    };
    fs.writeFileSync(eventsPath, `${JSON.stringify(legacyEvent)}\n${JSON.stringify(modernEvent)}\n`);

    // Only the modern event matches — the legacy event is invisible (no explicit identity).
    const event = await store.latestToolResultEvent('bd-1', 'Implementing', 'code', 'migTool');
    expect(event).toBeDefined();
    expect(event!.id).toBe('ev-modern');
    expect((event!.data as Record<string, unknown>).toolInvocationId).toBe('inv-11-modern');
    expect((event!.data as Record<string, unknown>).schemaId).toBe('tool-result-identity/1.0');
  });
});

// ---------------------------------------------------------------------------
// Typed Pi toolCallId ↔ toolInvocationId adapter tests
// ---------------------------------------------------------------------------

describe('dsm2.12: PiToolCallIdAdapter — typed toolCallId↔toolInvocationId mapping', () => {
  it('maps toolCallId to toolInvocationId for tool_call lifecycle hooks', () => {
    // The adapter resolves toolCallId → toolInvocationId across all Pi hook types.
    expect(typeof mapPiToolCallIdToInvocationId).toBe('function');

    const result = mapPiToolCallIdToInvocationId('tc-abc', 'inv-xyz');
    expect(result).toEqual({ toolCallId: 'tc-abc', toolInvocationId: 'inv-xyz' });
  });

  it('handles undefined toolCallId gracefully (Pi observer may not provide one)', () => {
    const result = mapPiToolCallIdToInvocationId(undefined, 'inv-fallback');
    expect(result).toEqual({ toolCallId: undefined, toolInvocationId: 'inv-fallback' });
  });
});

// ---------------------------------------------------------------------------
// latestToolResultEvent: explicit-only matching (u7cl)
// ---------------------------------------------------------------------------

describe('dsm2.12 + u7cl: latestToolResultEvent — explicit-only matching, no path fallback', () => {
  let projectRoot: string;
  let configLoader: ConfigLoader;
  let store: EventStore;

  beforeEach(() => {
    projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsm2-12-prefer-')));
    fs.mkdirSync(path.join(projectRoot, '.pi', 'events'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.pi', 'logs'), { recursive: true });
    writeMinimalHarness(projectRoot);
    ({ configLoader, store } = makeStore(projectRoot));
  });

  afterEach(async () => {
    configLoader.reset();
    Logger.close();
    await new Promise(resolve => setTimeout(resolve, 25));
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('explicit event is returned; co-resident path-only event for the same tool is invisible', async () => {
    // u7cl: even when a path-only event exists for the same tool, only the
    // event with explicit stateId/actionId is returned. The path-only event
    // is silently excluded (undefined from path parsing, no fallback).
    const eventsPath = path.join(projectRoot, '.pi', 'events', `${path.basename(projectRoot)}.jsonl`);
    const legacyOutput = toolOutputPath(projectRoot, 'bd-1', 'Implementing', 'code', 'prefTool', 'inv-p-a');
    const explicitOutput = toolOutputPath(projectRoot, 'bd-1', 'Implementing', 'code', 'prefTool', 'inv-p-b');

    // Path-only (legacy) event — no explicit stateId/actionId; not matchable (u7cl)
    const legacyEvent = {
      id: 'ev-pref-legacy',
      type: DomainEventName.TOOL_INVOCATION_SUCCEEDED,
      timestamp: '2026-01-01T00:00:01.000Z',
      sessionId: 'test',
      data: {
        beadId: 'bd-1',
        tool: 'prefTool',
        toolResult: { tool: 'prefTool', status: ToolResultStatus.PASSED, outputFile: legacyOutput, outputFileBytes: 10 }
      }
    };
    // Explicit event — has stateId/actionId; IS matchable
    const explicitEvent = {
      id: 'ev-pref-explicit',
      type: DomainEventName.TOOL_INVOCATION_SUCCEEDED,
      timestamp: '2026-01-01T00:00:02.000Z',
      sessionId: 'test',
      data: {
        beadId: 'bd-1',
        stateId: 'Implementing',
        actionId: 'code',
        tool: 'prefTool',
        toolName: 'prefTool',
        toolInvocationId: 'inv-p-b',
        schemaId: 'tool-result-identity/1.0',
        schemaVersion: '1.0',
        toolResult: { tool: 'prefTool', status: ToolResultStatus.PASSED, outputFile: explicitOutput, outputFileBytes: 20 }
      }
    };
    fs.writeFileSync(eventsPath, `${JSON.stringify(legacyEvent)}\n${JSON.stringify(explicitEvent)}\n`);

    const event = await store.latestToolResultEvent('bd-1', 'Implementing', 'code', 'prefTool');
    expect(event).toBeDefined();
    // The explicit event is the only matchable one
    expect(event!.id).toBe('ev-pref-explicit');
  });

  it('NEGATIVE: path-only event alone returns undefined (no explicit identity, no fallback)', async () => {
    // Load-bearing negative test (u7cl): a TOOL_INVOCATION_SUCCEEDED with a
    // well-formed tool-output path but no explicit stateId/actionId CANNOT
    // satisfy latestToolResultEvent. If path-fallback were reintroduced this
    // test would start returning a defined event and fail.
    const eventsPath = path.join(projectRoot, '.pi', 'events', `${path.basename(projectRoot)}.jsonl`);
    const outputFile = toolOutputPath(projectRoot, 'bd-1', 'Implementing', 'code', 'diagTool');

    const pathOnlyEvent = {
      id: 'ev-path-only-alone',
      type: DomainEventName.TOOL_INVOCATION_SUCCEEDED,
      timestamp: new Date().toISOString(),
      sessionId: 'test',
      data: {
        beadId: 'bd-1',
        tool: 'diagTool',
        // No stateId/actionId at top level — path-only shape
        toolResult: { tool: 'diagTool', status: ToolResultStatus.PASSED, outputFile, outputFileBytes: 25 }
      }
    };
    fs.writeFileSync(eventsPath, `${JSON.stringify(pathOnlyEvent)}\n`);

    const event = await store.latestToolResultEvent('bd-1', 'Implementing', 'code', 'diagTool');
    expect(event).toBeUndefined();
  });
});
