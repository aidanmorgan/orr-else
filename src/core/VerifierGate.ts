/**
 * VerifierGate — the harness-owned, COORDINATOR-side verifier loop
 * (pi-experiment-0yt5.5).
 *
 * A statechart transition may declare `requiredTools: [t1, t2]`. At the point
 * the coordinator is about to apply the transition (handleTeammateEvent, before
 * STATE_TRANSITION_APPLIED is committed) the harness runs this loop. For each
 * required tool it:
 *
 *  1. Resolves the LATEST tool-result event for (beadId, stateId, actionId,
 *     tool) coordinator-side, re-reading durable state from PROJECT-scoped
 *     paths (EventStore.latestToolResultEvent reconciles the FLAT command/MCP
 *     shape and the NESTED plugin shape).
 *  2. Reads that event's run status + outputFile. A required tool whose latest
 *     event status === REJECTED (it ran and failed) OR has NO event for this
 *     attempt (it was never invoked / no readable outputFile) BLOCKS the
 *     transition immediately — independent of any verify() verdict.
 *  3. Otherwise looks up the tool's REGISTERED verify() callback (from the
 *     contract `verifier` registry) and runs it with the full PATHS-ONLY
 *     VerifyContext { beadId, stateId, actionId, writeSet, artifacts,
 *     toolOutputs }.
 *
 * Aggregate routing (by enum, never boolean):
 *  - ANY verdict === FAIL blocks the transition.
 *  - A required tool with status === REJECTED or no event blocks.
 *  - NOT_APPLICABLE is ignored.
 *  - all-PASS / NA advances.
 *
 * Every blocking reason is collected into a structured `failures` array AND a
 * single rendered reject message. `failureOutcome` from a verify() result is
 * ADVISORY only — it is surfaced, NEVER auto-routed (the model picks the
 * recovery edge).
 *
 * The harness imports NO consumer tool code here: verify() callbacks arrive via
 * `verifier.register` (called by the consuming extension at load, or by the
 * harness's own built-in tools, e.g. git_history). No tool-specific gate policy
 * lives in this loop — the per-tool judgement (zero-target-scan etc.) lives
 * inside each tool's OWN verify().
 */

import {
  verifier as defaultVerifier,
  VerifyVerdict,
  type Registry,
  type VerifyCallback,
  type VerifyContext,
  type VerifyResult,
  type ToolRunStatus
} from '../contract.js';
import { DomainEventName, ToolResultStatus } from '../constants/index.js';
import { isRecord } from './RecordUtils.js';
import type { DomainEvent } from './EventStoreTypes.js';

/**
 * The narrow EventStore surface the gate reads. Declaring it structurally
 * keeps the gate testable with a lightweight double and free of an EventStore
 * import.
 */
export interface VerifierGateEventStore {
  latestToolResultEvent(beadId: string, stateId: string, actionId: string, tool: string): Promise<DomainEvent | undefined>;
}

/** Why a single required tool blocked the transition. */
export enum VerifierGateBlockKind {
  /** The required tool's latest event has status === REJECTED (it ran, failed). */
  TOOL_REJECTED = 'TOOL_REJECTED',
  /**
   * The required tool's latest event has status === UNAVAILABLE (the tool
   * binary was not found / ENOENT, or the MCP server module failed its
   * preflight probe). Always blocks — the tool did not produce usable output.
   */
  TOOL_UNAVAILABLE = 'TOOL_UNAVAILABLE',
  /** The required tool has no tool-result event for this attempt (never invoked). */
  TOOL_NOT_INVOKED = 'TOOL_NOT_INVOKED',
  /**
   * The required tool's latest event carries a status value that is not a
   * member of the known ToolRunStatus union (unknown, missing, or malformed).
   * Gate fails CLOSED on any unrecognized status — this is the exhaustive
   * never-escape-hatch for future or legacy-unmapped status strings.
   */
  TOOL_STATUS_UNRECOGNIZED = 'TOOL_STATUS_UNRECOGNIZED',
  /** The tool's registered verify() callback returned verdict === FAIL. */
  VERIFY_FAIL = 'VERIFY_FAIL'
}

/** One failing required tool, with its verdict (when a verify() ran) + reasons. */
export interface VerifierGateFailure {
  tool: string;
  kind: VerifierGateBlockKind;
  /** The verify() verdict when a callback ran; absent for did-not-run blocks. */
  verdict?: VerifyVerdict;
  reasons: string[];
  /** ADVISORY only — surfaced, never auto-routed. */
  failureOutcome?: string;
}

/**
 * Per-tool diagnostic for the VERIFY_EVALUATED observability event (0yt5.20 AC6).
 * One entry per required tool the loop considered, in tool order.
 */
export interface VerifierGatePerTool {
  tool: string;
  /** The verify() verdict, when a callback ran. Absent for did-not-run blocks. */
  verdict?: VerifyVerdict;
  reasons: string[];
  /** Wall-clock duration of the verify() callback (0 when no callback ran). */
  durationMs: number;
  /** True when the verify() callback exceeded the per-verify timeout. */
  timedOut?: boolean;
  /** True when the verify() callback threw (converted to FAIL). */
  threw?: boolean;
}

/** The aggregate result of running the verifier loop over the required tools. */
export interface VerifierGateResult {
  /** True when the transition may proceed (all-PASS / NA, every tool ran). */
  pass: boolean;
  /** Every blocking failure, in tool order. Empty when `pass` is true. */
  failures: VerifierGateFailure[];
  /** A single rendered reject message; empty string when `pass` is true. */
  rejectMessage: string;
  /** Per-tool diagnostics (verdict/reasons/timing) for the VERIFY_EVALUATED event. */
  perTool: VerifierGatePerTool[];
}

/** The PATHS-ONLY inputs the caller already knows for this transition. */
export interface VerifierGateContext {
  beadId: string;
  stateId: string;
  actionId: string;
  /** The write-set paths for this transition. */
  writeSet: string[];
  /** Declared-artifact name → artifact PATH. */
  artifacts: Record<string, string>;
}

/** Optional dependency injection for tests. */
export interface VerifierGateOptions {
  /** Override the verify() registry (defaults to the module-level singleton). */
  registry?: Pick<Registry<VerifyCallback>, 'get'>;
  /**
   * Per-verify ISOLATION timeout in milliseconds (0yt5.20 AC5). When set and a
   * verify() callback does not settle within this window, the gate ABANDONS the
   * in-flight promise (attaching a no-op .catch so a late rejection never raises
   * unhandledRejection) and records the tool as a FAIL with timedOut:true. When
   * unset (the default), the gate awaits the callback indefinitely (the prior
   * 0yt5.5 behaviour). A throwing verify() is always caught and converted to a
   * FAIL regardless of this option.
   */
  verifyTimeoutMs?: number;
}

/** Sentinel resolved by the timeout race when a verify() exceeds verifyTimeoutMs. */
const VERIFY_TIMEOUT = Symbol('verify-timeout');

/**
 * Run a single verify() callback under per-verify ISOLATION (0yt5.20 AC5):
 *  - a THROW (sync or async rejection) is caught and converted to a FAIL;
 *  - a TIMEOUT (when verifyTimeoutMs is set) abandons the in-flight promise with
 *    a no-op .catch so a late resolve/reject never surfaces as unhandledRejection,
 *    and yields a FAIL with timedOut:true.
 * Returns the verify result plus timing/threw/timedOut diagnostics.
 */
async function runIsolatedVerify(
  verify: VerifyCallback,
  verifyContext: VerifyContext,
  verifyTimeoutMs: number | undefined
): Promise<{ result: VerifyResult; durationMs: number; timedOut: boolean; threw: boolean }> {
  const startedAt = Date.now();
  // Invoke inside try/catch so a SYNC throw is captured the same as an async one.
  let pending: Promise<VerifyResult>;
  try {
    pending = Promise.resolve(verify(verifyContext));
  } catch (error) {
    return {
      result: { verdict: VerifyVerdict.FAIL, reasons: [`verify() threw: ${String(error)}`] },
      durationMs: Date.now() - startedAt,
      timedOut: false,
      threw: true
    };
  }

  if (verifyTimeoutMs === undefined || verifyTimeoutMs <= 0) {
    try {
      const result = await pending;
      return { result, durationMs: Date.now() - startedAt, timedOut: false, threw: false };
    } catch (error) {
      return {
        result: { verdict: VerifyVerdict.FAIL, reasons: [`verify() threw: ${String(error)}`] },
        durationMs: Date.now() - startedAt,
        timedOut: false,
        threw: true
      };
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof VERIFY_TIMEOUT>(resolve => {
    timer = setTimeout(() => resolve(VERIFY_TIMEOUT), verifyTimeoutMs);
  });

  try {
    const settled = await Promise.race([
      pending.then(result => ({ result }), (error: unknown) => ({ error })),
      timeout
    ]);

    if (settled === VERIFY_TIMEOUT) {
      // ABANDON the in-flight verify: attach a no-op .catch so a late rejection
      // cannot surface as an unhandledRejection. A late resolve is simply ignored.
      pending.catch(() => { /* abandoned: late result is intentionally discarded */ });
      return {
        result: {
          verdict: VerifyVerdict.FAIL,
          reasons: [`verify() did not settle within ${verifyTimeoutMs}ms (timed out; result abandoned).`]
        },
        durationMs: Date.now() - startedAt,
        timedOut: true,
        threw: false
      };
    }

    if ('error' in settled) {
      return {
        result: { verdict: VerifyVerdict.FAIL, reasons: [`verify() threw: ${String(settled.error)}`] },
        durationMs: Date.now() - startedAt,
        timedOut: false,
        threw: true
      };
    }

    return { result: settled.result, durationMs: Date.now() - startedAt, timedOut: false, threw: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Read a tool-result event's run status (did the tool RUN to completion) and
 * its outputFile path, reconciling the FLAT and NESTED recorded shapes.
 *
 * Returns the raw status string exactly as recorded (may be undefined when
 * the field is absent / malformed). The gate caller is responsible for
 * exhaustive handling of every possible value.
 */
function readToolRun(event: DomainEvent): { status: string | undefined; outputFile: string | undefined } {
  const data = isRecord(event.data) ? event.data : {};

  if (event.type === DomainEventName.PROJECT_TOOL_SUCCEEDED || event.type === DomainEventName.PROJECT_TOOL_FAILED) {
    // FLAT shape — status + outputFile are top-level on the event data.
    return {
      status: typeof data.status === 'string' ? data.status : undefined,
      outputFile: typeof data.outputFile === 'string' ? data.outputFile : undefined
    };
  }

  // NESTED shape — status + outputFile live on the typed toolResult handle.
  const toolResult = isRecord(data.toolResult) ? data.toolResult : undefined;
  return {
    status: typeof toolResult?.status === 'string' ? toolResult.status : undefined,
    outputFile: typeof toolResult?.outputFile === 'string' ? toolResult.outputFile : undefined
  };
}

/**
 * Exhaustive status classifier for the verifier gate.
 *
 * Returns:
 *   'PASSED'       — tool ran to completion; proceed to verify().
 *   'REJECTED'     — tool ran but failed (REJECTED); block with TOOL_REJECTED.
 *   'UNAVAILABLE'  — tool binary / MCP server not found; block with TOOL_UNAVAILABLE.
 *   'UNRECOGNIZED' — status is missing, undefined, or an unknown future value;
 *                    gate fails CLOSED with TOOL_STATUS_UNRECOGNIZED.
 *
 * This function is the SINGLE place that classifies a raw status string into
 * gate action. Adding a new ToolRunStatus value in contract.ts requires adding
 * a branch here — the TypeScript exhaustiveness check below enforces this.
 */
function classifyRunStatus(rawStatus: string | undefined): 'PASSED' | 'REJECTED' | 'UNAVAILABLE' | 'UNRECOGNIZED' {
  // Map through the known ToolRunStatus values explicitly.
  // The local variable forces TypeScript to check the switch is exhaustive
  // when ToolRunStatus gains new members.
  const known: ToolRunStatus[] = ['PASSED', 'REJECTED', 'UNAVAILABLE'];
  if (rawStatus === undefined || rawStatus === null) return 'UNRECOGNIZED';
  if (known.includes(rawStatus as ToolRunStatus)) {
    const status = rawStatus as ToolRunStatus;
    switch (status) {
      case 'PASSED': return 'PASSED';
      case 'REJECTED': return 'REJECTED';
      case 'UNAVAILABLE': return 'UNAVAILABLE';
      default: {
        // TypeScript exhaustiveness check: if ToolRunStatus gains a new member
        // and this switch is not updated, this line becomes unreachable AND
        // TypeScript raises a type error (never assignment). This is the
        // compile-time gate that enforces exhaustive handling.
        const _exhaustive: never = status;
        void _exhaustive;
        return 'UNRECOGNIZED';
      }
    }
  }
  return 'UNRECOGNIZED';
}

function renderRejectMessage(failures: VerifierGateFailure[]): string {
  if (failures.length === 0) return '';
  const header = failures.length === 1
    ? 'Verifier gate BLOCKED the transition (1 required tool failed):'
    : `Verifier gate BLOCKED the transition (${failures.length} required tools failed):`;
  const lines = failures.map(failure => {
    const verdictLabel = failure.verdict ? ` verdict=${failure.verdict}` : '';
    const reasons = failure.reasons.length > 0 ? failure.reasons.join('; ') : '(no reasons reported)';
    const advisory = failure.failureOutcome ? ` [advisory failureOutcome=${failure.failureOutcome}]` : '';
    return `- ${failure.tool} [${failure.kind}]${verdictLabel}: ${reasons}${advisory}`;
  });
  return [header, ...lines].join('\n');
}

/**
 * Run the coordinator-side verifier loop over the (already write-set-resolved)
 * required tool names. The loop resolves each tool's latest tool-result event
 * coordinator-side, runs its registered verify() callback when the tool ran,
 * and aggregates by enum.
 *
 * @param ctx           The transition's paths-only context (beadId, stateId,
 *                      actionId, writeSet, declared artifacts).
 * @param requiredTools The resolved tool NAMES this transition requires.
 * @param store         Coordinator-readable EventStore surface.
 * @param options       Optional registry injection (tests).
 */
export async function runVerifierGate(
  ctx: VerifierGateContext,
  requiredTools: string[],
  store: VerifierGateEventStore,
  options: VerifierGateOptions = {}
): Promise<VerifierGateResult> {
  const registry = options.registry ?? defaultVerifier;
  const failures: VerifierGateFailure[] = [];
  const perTool: VerifierGatePerTool[] = [];

  // De-duplicate tool names while preserving first-seen order.
  const tools = [...new Set(requiredTools.filter(Boolean))];

  // Resolve every required tool's latest event up front so the VerifyContext
  // toolOutputs map exposes ALL produced outputs to every callback.
  const latestByTool = new Map<string, DomainEvent | undefined>();
  for (const tool of tools) {
    latestByTool.set(tool, await store.latestToolResultEvent(ctx.beadId, ctx.stateId, ctx.actionId, tool));
  }

  const toolOutputs: Record<string, string> = {};
  for (const [tool, event] of latestByTool) {
    if (!event) continue;
    const { outputFile } = readToolRun(event);
    if (outputFile) toolOutputs[tool] = outputFile;
  }

  const verifyContext: VerifyContext = {
    beadId: ctx.beadId,
    stateId: ctx.stateId,
    actionId: ctx.actionId,
    writeSet: ctx.writeSet,
    artifacts: ctx.artifacts,
    toolOutputs
  };

  for (const tool of tools) {
    const event = latestByTool.get(tool);

    // (1) Did the tool RUN at all this attempt? No event ⇒ not invoked ⇒ block.
    if (!event) {
      const reasons = [`Required tool "${tool}" has no tool-result event for this attempt (it was not invoked).`];
      failures.push({ tool, kind: VerifierGateBlockKind.TOOL_NOT_INVOKED, reasons });
      perTool.push({ tool, reasons, durationMs: 0 });
      continue;
    }

    // (2) Classify the tool's run status exhaustively + fail closed on non-PASSED.
    const { status: rawStatus } = readToolRun(event);
    const statusClass = classifyRunStatus(rawStatus);

    if (statusClass === 'REJECTED') {
      const reasons = [`Required tool "${tool}" did not run to completion (latest tool-result status === REJECTED).`];
      failures.push({ tool, kind: VerifierGateBlockKind.TOOL_REJECTED, reasons });
      perTool.push({ tool, reasons, durationMs: 0 });
      continue;
    }

    if (statusClass === 'UNAVAILABLE') {
      const reasons = [
        `Required tool "${tool}" is UNAVAILABLE (tool binary not found or MCP server module probe failed; status === UNAVAILABLE). ` +
        `The tool did not produce usable output; required-tool satisfaction cannot be met.`
      ];
      failures.push({ tool, kind: VerifierGateBlockKind.TOOL_UNAVAILABLE, reasons });
      perTool.push({ tool, reasons, durationMs: 0 });
      continue;
    }

    if (statusClass === 'UNRECOGNIZED') {
      // Fail CLOSED: unknown, missing, or malformed status — never allow gate passage.
      const statusDisplay = rawStatus === undefined ? 'undefined (missing)' : JSON.stringify(rawStatus);
      const reasons = [
        `Required tool "${tool}" has an unrecognized run status: ${statusDisplay}. ` +
        `Gate fails closed on any non-PASSED or unknown status (zog2.15 exhaustive handling).`
      ];
      failures.push({ tool, kind: VerifierGateBlockKind.TOOL_STATUS_UNRECOGNIZED, reasons });
      perTool.push({ tool, reasons, durationMs: 0 });
      continue;
    }

    // statusClass === 'PASSED': the tool ran to completion — proceed to verify().
    // (3) The tool ran — run its registered verify() callback (if any).
    const verify = registry.get(tool);
    if (!verify) {
      // No registered callback: the tool ran (presence satisfied) and there is
      // no semantic verifier to consult, so it cannot FAIL. This is a PASS for
      // the loop's aggregate — the harness applies no tool-specific policy.
      perTool.push({ tool, verdict: VerifyVerdict.NOT_APPLICABLE, reasons: ['no registered verify() callback'], durationMs: 0 });
      continue;
    }

    // Run under per-verify isolation: a throw or timeout becomes a FAIL without
    // hanging or crashing the gate (AC5).
    const { result, durationMs, timedOut, threw } = await runIsolatedVerify(verify, verifyContext, options.verifyTimeoutMs);
    perTool.push({
      tool,
      verdict: result.verdict,
      reasons: result.reasons,
      durationMs,
      ...(timedOut ? { timedOut: true } : {}),
      ...(threw ? { threw: true } : {})
    });
    if (result.verdict === VerifyVerdict.FAIL) {
      failures.push({
        tool,
        kind: VerifierGateBlockKind.VERIFY_FAIL,
        verdict: result.verdict,
        reasons: result.reasons,
        failureOutcome: result.failureOutcome
      });
    }
    // PASS / NOT_APPLICABLE: nothing to collect — NOT_APPLICABLE is ignored.
  }

  return {
    pass: failures.length === 0,
    failures,
    rejectMessage: renderRejectMessage(failures),
    perTool
  };
}
