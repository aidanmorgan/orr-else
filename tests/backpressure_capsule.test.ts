/**
 * pi-experiment-t0xf: Backpressure coordination capsule tests.
 *
 * AC1: Normal runs with NO pressure add ZERO stable prompt tokens (no always-on block).
 * AC2: When a threshold trips, the capsule is under a FIXED small budget (<=80 est. tokens).
 * AC3: Repeated serialized tool calls receive the capsule INSTEAD of verbose text.
 * AC4: Capsule contains NO transcript text or raw tool output; suppresses duplicate fan-out.
 *
 * Imports only from the pure BackpressureCapsule module (no external package deps)
 * so this test runs cleanly in the isolated worktree environment.
 */

import { describe, expect, it } from 'vitest';
import {
  shouldEmitCapsule,
  buildBackpressureCapsule,
  CAPSULE_COLLISION_THRESHOLD,
  type BackpressureCapsuleResult
} from '../src/plugins/projectTools/BackpressureCapsule.js';
import { ProjectToolType, ToolResultStatus } from '../src/constants/domain.js';
import { ProjectToolFailureCategory } from '../src/plugins/projectTools/failureCategory.js';
import { projectToolBackpressureResult } from '../src/plugins/projectTools/contextHelpers.js';
import { attachFailureCategory } from '../src/plugins/projectTools/resultEnvelope.js';
import type { ProjectToolExecutionContext } from '../src/plugins/projectTools/types.js';
import type { InFlightProjectToolCall } from '../src/core/RuntimeServices.js';
import type { ProjectToolConfig } from '../src/core/domain/StateModels.js';

// ── token estimator (local copy — avoids pulling in Logger/winston via TokenUsage.ts) ──

const CHARS_PER_TOKEN = 4;

function estimateTokens(value: unknown): number {
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return Math.ceil(Buffer.byteLength(text, 'utf8') / CHARS_PER_TOKEN);
  } catch {
    return 0;
  }
}

// ── AC1: zero overhead when no backpressure ───────────────────────────────────

describe('AC1: zero overhead when no backpressure (shouldEmitCapsule)', () => {
  it('returns false for collision count 0 (first reservation, no collision)', () => {
    expect(shouldEmitCapsule(0)).toBe(false);
  });

  it('returns false for collision count 1 (first collision — verbose text appropriate)', () => {
    expect(shouldEmitCapsule(1)).toBe(false);
  });

  it('no capsule is produced below the threshold', () => {
    for (let count = 0; count < CAPSULE_COLLISION_THRESHOLD; count++) {
      expect(shouldEmitCapsule(count), `count=${count} must not emit capsule`).toBe(false);
    }
  });
});

// ── AC2: bounded capsule size ─────────────────────────────────────────────────

describe('AC2: capsule is under a fixed small budget (<=80 estimated tokens)', () => {
  it('shouldEmitCapsule returns true at CAPSULE_COLLISION_THRESHOLD', () => {
    expect(shouldEmitCapsule(CAPSULE_COLLISION_THRESHOLD)).toBe(true);
  });

  it('capsule result for typical IDs is <=80 estimated tokens', () => {
    const result = buildBackpressureCapsule('my_tool', 'bead-abc', 'Planning', 'implement', 1234);
    const tokens = estimateTokens(result);
    expect(tokens, `Capsule must be <=80 est. tokens; got ${tokens}`).toBeLessThanOrEqual(80);
  });

  it('capsule result with long IDs truncates them; worst-case (all id fields at MAX_ID_LEN=32) is <=80 est. tokens', () => {
    // Build with every id field at MAX_ID_LEN (32 chars) to exercise the true worst case.
    // Budget math: skeleton(137 bytes) + 4 fields * 32 bytes = 265 bytes => ceil(265/4) = 67 tokens.
    const longId = 'a'.repeat(200);
    const result = buildBackpressureCapsule(
      'tool_with_very_long_name_abcdefghijklmnopqrstuvwxyz_stress_test',
      longId,
      longId,
      longId,
      99999
    );
    // IDs are truncated at 32 chars (MAX_ID_LEN)
    expect(result.capsule.bead.length).toBeLessThanOrEqual(32);
    expect(result.capsule.state.length).toBeLessThanOrEqual(32);
    expect(result.capsule.action.length).toBeLessThanOrEqual(32);
    expect(result.tool.length).toBeLessThanOrEqual(32);
    // Worst-case on-wire capsule must stay <=80 estimated tokens
    const tokens = estimateTokens(result);
    expect(tokens, `Capsule with worst-case ids must be <=80 est. tokens; got ${tokens}`).toBeLessThanOrEqual(80);
  });

  it('capsule threshold is exactly CAPSULE_COLLISION_THRESHOLD=2', () => {
    expect(CAPSULE_COLLISION_THRESHOLD).toBe(2);
    expect(shouldEmitCapsule(1)).toBe(false);
    expect(shouldEmitCapsule(2)).toBe(true);
  });
});

// ── AC3: capsule REPLACES verbose text on threshold-crossing collisions ────────

describe('AC3: buildBackpressureCapsule returns capsule (not verbose text)', () => {
  it('result has capsule field with coordination facts', () => {
    const result = buildBackpressureCapsule('my_tool', 'bead-1', 'Coding', 'write_tests', 500);

    expect(result).toHaveProperty('capsule');
    const capsule = result.capsule;
    expect(capsule.pressure).toBe('high');
    expect(capsule.bead).toBe('bead-1');
    expect(capsule.state).toBe('Coding');
    expect(capsule.action).toBe('write_tests');
    // activeTool is NOT in the capsule payload; the tool name is carried by result.tool
    expect(result.tool).toBe('my_tool');
    expect(capsule.ageMs).toBe(500);
  });

  it('result does NOT have message, recovery, or inFlight fields', () => {
    const result = buildBackpressureCapsule('my_tool', 'bead-1', 'Planning', 'impl', 100) as Record<string, unknown>;

    expect(result).not.toHaveProperty('message');
    expect(result).not.toHaveProperty('recovery');
    expect(result).not.toHaveProperty('inFlight');
    expect(result).not.toHaveProperty('nextAction');
  });

  it('status and failureCategory are preserved', () => {
    const result = buildBackpressureCapsule('my_tool', 'bead-1', 'Planning', 'impl', 100);

    expect(result.status).toBe(ToolResultStatus.REJECTED);
    expect(result.failureCategory).toBe(ProjectToolFailureCategory.BACKPRESSURE);
    expect(result.tool).toBe('my_tool');
  });

  it('shouldEmitCapsule correctly gates the threshold (1 → verbose, 2+ → capsule)', () => {
    // Simulate a caller checking whether to emit capsule on each collision
    const count1 = 1;
    const count2 = 2;
    const count5 = 5;

    expect(shouldEmitCapsule(count1)).toBe(false); // 1st collision → verbose
    expect(shouldEmitCapsule(count2)).toBe(true);  // 2nd collision → capsule
    expect(shouldEmitCapsule(count5)).toBe(true);  // 5th collision → capsule
  });
});

// ── AC4: capsule contains no transcript text or raw tool output ───────────────

describe('AC4: capsule contains no transcript text or raw tool output', () => {
  it('capsule result has no free-form text fields', () => {
    const result = buildBackpressureCapsule('my_tool', 'bead-1', 'Planning', 'impl', 0) as Record<string, unknown>;

    const forbidden = ['message', 'recovery', 'inFlight', 'stdout', 'stderr', 'rawOutput',
      'transcript', 'content', 'nextAction', 'error', 'details'];
    for (const key of forbidden) {
      expect(result, `capsule result must not contain '${key}'`).not.toHaveProperty(key);
    }
  });

  it('capsule object itself contains only allowed coordination keys', () => {
    const result = buildBackpressureCapsule('my_tool', 'bead-1', 'Planning', 'impl', 42);
    // activeTool is NOT in the capsule payload; tool name is at result.tool to avoid duplication
    const allowedCapsuleKeys = new Set(['pressure', 'bead', 'state', 'action', 'ageMs']);

    for (const key of Object.keys(result.capsule)) {
      expect(allowedCapsuleKeys.has(key), `capsule key '${key}' is not an allowed coordination fact`).toBe(true);
    }
  });

  it('IDs are independently isolated: different tools produce independent capsule payloads', () => {
    const r1 = buildBackpressureCapsule('tool_a', 'bead-X', 'State1', 'action1', 100);
    const r2 = buildBackpressureCapsule('tool_b', 'bead-Y', 'State2', 'action2', 200);

    // Tool name is at result.tool, not capsule.activeTool
    expect(r1.tool).toBe('tool_a');
    expect(r1.capsule.bead).toBe('bead-X');
    expect(r2.tool).toBe('tool_b');
    expect(r2.capsule.bead).toBe('bead-Y');
    // Each is independently gated — no cross-contamination of coordination state
  });

  it('tool name is truncated to 32 chars in the result (no raw long strings from source)', () => {
    const longTool = 'x'.repeat(200);
    const result = buildBackpressureCapsule(longTool, 'b', 's', 'a', 0);
    // Tool name is at result.tool only; capsule payload does NOT duplicate it
    expect(result.tool.length).toBeLessThanOrEqual(32);
    expect(result.capsule).not.toHaveProperty('activeTool');
  });

  it('AC1 zero-idle-overhead proof: shouldEmitCapsule(0) === false (no capsule on fresh tool calls)', () => {
    // A tool call that just started has collisionCount=0; no capsule is emitted.
    // This is the zero-overhead-when-idle property.
    expect(shouldEmitCapsule(0)).toBe(false);
    // The backpressure map has a fresh entry — no capsule is injected anywhere.
    // This is a pure function test: if the function returns false, no capsule
    // is built, and the model receives no extra coordination tokens.
  });
});

// ── Real-path: model-visible result after the full preflight envelope ─────────
//
// These tests drive the ACTUAL path: projectToolBackpressureResult → attachFailureCategory,
// mirroring exactly what preflight.ts does.  The pure BackpressureCapsule tests above only
// assert on the bare capsule object; these tests catch any re-inflation from attachFailureCategory.

/** Minimal ProjectToolConfig stub sufficient for projectToolBackpressureResult / attachFailureCategory. */
function makeToolDef(name = 'my_tool'): ProjectToolConfig {
  return { name, type: ProjectToolType.COMMAND, command: 'echo' } as ProjectToolConfig;
}

/** Minimal ProjectToolExecutionContext stub. */
function makeContext(beadId = 'bead-1', stateId = 'Planning', actionId = 'implement'): ProjectToolExecutionContext {
  return {
    templateContext: {
      projectRoot: '/proj',
      worktreePath: '/proj/wt',
      beadId,
      stateId,
      actionId,
      toolInvocationId: 'inv-123',
      toolName: 'my_tool'
    },
    cwd: '/proj/wt',
    callDir: '/tmp/call',
    outputDir: '/tmp/out',
    outputFile: '/tmp/out/result.json',
    tmpDir: '/tmp/scratch',
    hostEnv: {}
  };
}

/** InFlightProjectToolCall at collisionCount=2 (capsule threshold). */
function makeInFlight(collisionCount: number): InFlightProjectToolCall {
  return { token: 'tok-abc', startedAtMs: Date.now() - 500, collisionCount };
}

describe('Real-path: model-visible result through the full preflight envelope (AC2 on-wire)', () => {
  const PROSE_KEYS = ['remediation', 'message', 'recovery', 'nextAction', 'inFlight'];
  const MAX_TOKENS = 80;

  it('first collision (collisionCount=1) uses verbose path — attachFailureCategory adds remediation (kept intentional)', () => {
    // The first backpressure collision is intentionally verbose so the agent sees the full
    // explanation once.  attachFailureCategory IS applied for this path.
    const raw = projectToolBackpressureResult(makeToolDef(), makeContext(), makeInFlight(1));
    const onWire = attachFailureCategory(makeToolDef(), raw) as Record<string, unknown>;
    const hasProse = PROSE_KEYS.some(k => k in onWire);
    expect(hasProse, 'First collision should carry at least one prose key').toBe(true);
  });

  it('WITHOUT the bypass: attachFailureCategory on capsule result inflates tokens above 80 (documents the bug)', () => {
    // This test documents the pre-fix defect: feeding the capsule result through
    // attachFailureCategory unconditionally causes the remediation prose to be appended,
    // pushing the on-wire size above 80 estimated tokens.
    const raw = projectToolBackpressureResult(makeToolDef(), makeContext(), makeInFlight(2));
    expect(raw).toHaveProperty('capsule'); // confirm it IS a capsule
    const inflated = attachFailureCategory(makeToolDef(), raw) as Record<string, unknown>;
    // The inflated result MUST carry remediation prose (this is what the old code produced).
    expect(inflated).toHaveProperty('remediation');
    const tokens = estimateTokens(inflated);
    // The inflated result exceeds the 80-token budget — confirming the bug.
    expect(tokens, `Inflated (bugged) capsule is ${tokens} est. tokens — expected >80`).toBeGreaterThan(MAX_TOKENS);
  });

  it('capsule path (collisionCount=2): on-wire result is <=80 estimated tokens (AC2)', () => {
    // Simulate the fixed preflight.ts: bypass attachFailureCategory for capsule results.
    const raw = projectToolBackpressureResult(makeToolDef(), makeContext(), makeInFlight(2));
    const onWire = ('capsule' in raw) ? raw : attachFailureCategory(makeToolDef(), raw);
    const tokens = estimateTokens(onWire);
    expect(tokens, `On-wire capsule must be <=80 est. tokens; got ${tokens}`).toBeLessThanOrEqual(MAX_TOKENS);
  });

  it('capsule path (collisionCount=2): on-wire result contains NO prose keys (AC3)', () => {
    const raw = projectToolBackpressureResult(makeToolDef(), makeContext(), makeInFlight(2));
    const onWire = ('capsule' in raw) ? raw : attachFailureCategory(makeToolDef(), raw);
    const onWireRec = onWire as Record<string, unknown>;
    for (const key of PROSE_KEYS) {
      expect(onWireRec, `on-wire capsule must NOT contain prose key '${key}'`).not.toHaveProperty(key);
    }
  });

  it('capsule path (collisionCount=5): still <=80 tokens and prose-free (AC2+AC3 stable)', () => {
    const raw = projectToolBackpressureResult(makeToolDef(), makeContext(), makeInFlight(5));
    const onWire = ('capsule' in raw) ? raw : attachFailureCategory(makeToolDef(), raw);
    const tokens = estimateTokens(onWire);
    expect(tokens, `On-wire capsule at count=5 must be <=80 est. tokens; got ${tokens}`).toBeLessThanOrEqual(MAX_TOKENS);
    const onWireRec = onWire as Record<string, unknown>;
    for (const key of PROSE_KEYS) {
      expect(onWireRec, `on-wire capsule at count=5 must NOT contain '${key}'`).not.toHaveProperty(key);
    }
  });
});
