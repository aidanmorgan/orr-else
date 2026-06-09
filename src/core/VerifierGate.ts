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
 *     tool) coordinator-side (EventStore.latestToolResultEvent).
 *  2. Reads the canonical ToolEvidenceHandle from the event. Events that do NOT
 *     carry a validated canonical handle (outputFile-only events, command
 *     envelopes, child ToolResultBase records) are REJECTED — the gate fails
 *     CLOSED. One canonical shape only (pi-experiment-yhec, no-backcompat).
 *  3. Classifies the handle's runStatus. REJECTED/UNAVAILABLE/UNRECOGNIZED all
 *     block immediately, independent of any verify() verdict.
 *  4. For PASSED handles: validates the handle fully (missing/malformed fields,
 *     stale fingerprint, hash mismatch, semanticArtifactPath outside toolOutputRoot).
 *     Fails CLOSED on every violation.
 *  5. Looks up the tool's REGISTERED verify() callback and runs it with the full
 *     VerifyContext { beadId, stateId, actionId, writeSet, artifacts, evidenceHandles }
 *     carrying validated canonical handles — never raw paths.
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
  type VerifyEvidenceHandle,
  type VerifyResult,
  type ToolRunStatus
} from '../contract.js';
import { DomainEventName, ToolResultStatus } from '../constants/domain.js';
import { isRecord } from './RecordUtils.js';
import type { DomainEvent } from './EventStoreTypes.js';
import { asToolName, type BeadId, type StateId, type ActionId, type ToolName } from '../types/ids.js';
import {
  validateToolEvidenceHandle,
  validateToolEvidenceArtifact,
  type ToolEvidenceHandle,
} from './ToolEvidenceHandle.js';

/**
 * The narrow EventStore surface the gate reads. Declaring it structurally
 * keeps the gate testable with a lightweight double and free of an EventStore
 * import.
 */
export interface VerifierGateEventStore {
  latestToolResultEvent(beadId: BeadId, stateId: StateId, actionId: ActionId, tool: ToolName): Promise<DomainEvent | undefined>;
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
  VERIFY_FAIL = 'VERIFY_FAIL',
  /**
   * The required tool ran (PASSED) but recorded no outputFile (no semantic
   * artifact path). Per zog2.8: missing artifact paths are NEVER evidence.
   * A tool with no registered verify() AND no outputFile cannot satisfy the
   * gate — implicit presence-only evidence is removed.
   */
  TOOL_MISSING_ARTIFACT = 'TOOL_MISSING_ARTIFACT',
  /**
   * The required tool's latest event does NOT carry a valid canonical
   * ToolEvidenceHandle (pi-experiment-yhec, no-backcompat). Rejected cases:
   *   - no evidenceHandle field on the event (outputFile-only event, command
   *     envelope, child ToolResultBase record, legacy shape)
   *   - evidenceHandle present but fails validateToolEvidenceHandle (malformed
   *     fields, semanticArtifactPath outside toolOutputRoot, forbidden
   *     rawOutput/modelFacingRawOutput fields, unknown schema version, …)
   *   - evidenceHandle present and valid but semanticArtifactPath not readable
   *     on disk (hash mismatch / path not found)
   * The gate FAILS CLOSED on every such case — outputFile-only events are
   * never admissible evidence.
   */
  EVIDENCE_HANDLE_INVALID = 'EVIDENCE_HANDLE_INVALID'
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
  beadId: BeadId;
  stateId: StateId;
  actionId: ActionId;
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
 * Read the canonical ToolEvidenceHandle from a tool-result event.
 *
 * One canonical shape only (pi-experiment-yhec, no-backcompat). Both
 * PROJECT_TOOL and TOOL_INVOCATION events may carry an `evidenceHandle` field
 * at the top level of event.data. If absent, returns undefined (outputFile-only
 * event — gate fails CLOSED).
 */
function readEventEvidenceHandle(event: DomainEvent): unknown {
  const data = isRecord(event.data) ? event.data : {};
  // Both flat (PROJECT_TOOL_*) and nested (TOOL_INVOCATION_*) events carry
  // evidenceHandle at the top level of data when emitted by canonical tools.
  return data.evidenceHandle;
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

/**
 * Validate and extract a canonical ToolEvidenceHandle from a raw event value.
 *
 * Returns { valid: true, handle } on success, or { valid: false, errors } on
 * any validation failure. Used by runVerifierGate to reject events that do not
 * carry a valid canonical handle (outputFile-only events, command envelopes,
 * child ToolResultBase records, stale fingerprints, hash mismatches, out-of-root).
 */
function validateEventHandle(
  rawHandle: unknown,
  tool: string
): { valid: true; handle: ToolEvidenceHandle } | { valid: false; errors: string[] } {
  if (rawHandle === undefined || rawHandle === null) {
    return {
      valid: false,
      errors: [
        `Required tool "${tool}" event carries no canonical ToolEvidenceHandle ` +
        `(outputFile-only event, command envelope, or child ToolResultBase record). ` +
        `Only events with a validated evidenceHandle field are admissible (pi-experiment-yhec).`
      ]
    };
  }

  // Validate the handle against the full ToolEvidenceHandle contract.
  // The gate does NOT enforce semanticArtifactPath presence here for PASSED runs —
  // that is the responsibility of the per-tool TOOL_MISSING_ARTIFACT check (zog2.8).
  // Tools with registered verify() callbacks handle absent artifacts themselves.
  const result = validateToolEvidenceHandle(rawHandle, { expectedToolName: tool });
  if (!result.valid) {
    // Filter out the semanticArtifactPath-required-for-PASSED error: the gate uses
    // TOOL_MISSING_ARTIFACT (for presence-only tools) for clearer diagnostics.
    const relevantErrors = result.errors.filter(e =>
      !e.startsWith('semanticArtifactPath: required for PASSED runs')
    );
    if (relevantErrors.length > 0) {
      return {
        valid: false,
        errors: [
          `Required tool "${tool}" evidenceHandle failed canonical validation: ` +
          relevantErrors.join('; ')
        ]
      };
    }
    // The only error was the semanticArtifactPath-required one — construct the
    // handle manually from the raw object (safe since all other fields validated).
    const raw = rawHandle as Record<string, unknown>;
    const handle: ToolEvidenceHandle = {
      schemaVersion: raw['schemaVersion'] as string,
      toolName: raw['toolName'] as string,
      invocationId: raw['invocationId'] as string,
      runStatus: raw['runStatus'] as ToolEvidenceHandle['runStatus'],
      ...(raw['failureCategory'] !== undefined ? { failureCategory: raw['failureCategory'] as ToolEvidenceHandle['failureCategory'] } : {}),
      // semanticArtifactPath intentionally absent (TOOL_MISSING_ARTIFACT handles this)
      toolOutputRoot: raw['toolOutputRoot'] as string,
      summaryMode: raw['summaryMode'] as ToolEvidenceHandle['summaryMode'],
      ...(raw['noSummaryReason'] !== undefined ? { noSummaryReason: raw['noSummaryReason'] as string } : {}),
      admittedHarnessFingerprint: raw['admittedHarnessFingerprint'] as string,
      admittedExecutionBoundary: raw['admittedExecutionBoundary'] as string,
    };
    return { valid: true, handle };
  }

  return { valid: true, handle: result.handle };
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
  // evidenceHandles map exposes ALL validated canonical handles to every callback.
  const latestByTool = new Map<string, DomainEvent | undefined>();
  for (const tool of tools) {
    latestByTool.set(tool, await store.latestToolResultEvent(ctx.beadId, ctx.stateId, ctx.actionId, asToolName(tool)));
  }

  // Build the validated evidenceHandles map. Only tools with valid canonical
  // ToolEvidenceHandle instances appear here. Tools without a valid handle are
  // not included — they are blocked below with EVIDENCE_HANDLE_INVALID.
  const evidenceHandles: Record<string, VerifyEvidenceHandle> = {};
  for (const [tool, event] of latestByTool) {
    if (!event) continue;
    const rawHandle = readEventEvidenceHandle(event);
    const validation = validateEventHandle(rawHandle, tool);
    if (validation.valid) {
      // Cast to VerifyEvidenceHandle — ToolEvidenceHandle is a structural superset.
      evidenceHandles[tool] = validation.handle as VerifyEvidenceHandle;
    }
    // Invalid handles are excluded; the per-tool loop below will block with EVIDENCE_HANDLE_INVALID.
  }

  const verifyContext: VerifyContext = {
    beadId: ctx.beadId,
    stateId: ctx.stateId,
    actionId: ctx.actionId,
    writeSet: ctx.writeSet,
    artifacts: ctx.artifacts,
    evidenceHandles
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

    // (2) Validate the canonical ToolEvidenceHandle from the event.
    //     Fail CLOSED if no handle or invalid handle (pi-experiment-yhec).
    const rawHandle = readEventEvidenceHandle(event);
    const handleValidation = validateEventHandle(rawHandle, tool);
    if (!handleValidation.valid) {
      failures.push({ tool, kind: VerifierGateBlockKind.EVIDENCE_HANDLE_INVALID, reasons: handleValidation.errors });
      perTool.push({ tool, reasons: handleValidation.errors, durationMs: 0 });
      continue;
    }

    const handle = handleValidation.handle;

    // (3) Classify the handle's runStatus exhaustively + fail closed on non-PASSED.
    const statusClass = classifyRunStatus(handle.runStatus);

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
      const statusDisplay = JSON.stringify(handle.runStatus);
      const reasons = [
        `Required tool "${tool}" has an unrecognized run status: ${statusDisplay}. ` +
        `Gate fails closed on any non-PASSED or unknown status (zog2.15 exhaustive handling).`
      ];
      failures.push({ tool, kind: VerifierGateBlockKind.TOOL_STATUS_UNRECOGNIZED, reasons });
      perTool.push({ tool, reasons, durationMs: 0 });
      continue;
    }

    // statusClass === 'PASSED': the tool ran to completion.

    // (4) Proceed to verify() lookup. For PRESENCE_ONLY tools (no verify()), the
    //     gate enforces artifact presence. For tools WITH verify(), the verify()
    //     callback is responsible for artifact checks.
    const verify = registry.get(tool);
    if (!verify) {
      // No registered verify() callback (presence-only tool per zog2.8).
      // Implicit presence-only evidence is REMOVED: a durable semantic artifact
      // path (semanticArtifactPath on the handle) is now REQUIRED. Missing artifact
      // paths are NEVER evidence — gate fails CLOSED.
      if (!handle.semanticArtifactPath) {
        const reasons = [
          `Required tool "${tool}" ran (PASSED) but recorded no semantic artifact path (semanticArtifactPath is absent). ` +
          `Implicit presence-only evidence is not admissible (zog2.8). ` +
          `The tool must persist a minimal semantic artifact and record its path in the ToolEvidenceHandle.`
        ];
        failures.push({ tool, kind: VerifierGateBlockKind.TOOL_MISSING_ARTIFACT, reasons });
        perTool.push({ tool, reasons, durationMs: 0 });
        continue;
      }
      // For presence-only tools: validate the semantic artifact is readable on disk.
      const artifactCheck = validateToolEvidenceArtifact(handle);
      if (!artifactCheck.readable) {
        const reasons = [
          `Required tool "${tool}" semantic artifact path is not readable: ${artifactCheck.error}. ` +
          `Gate fails closed on unreadable artifact paths (pi-experiment-yhec).`
        ];
        failures.push({ tool, kind: VerifierGateBlockKind.EVIDENCE_HANDLE_INVALID, reasons });
        perTool.push({ tool, reasons, durationMs: 0 });
        continue;
      }
      // The tool ran and recorded a readable semantic artifact path — presence satisfied with artifact.
      perTool.push({ tool, verdict: VerifyVerdict.NOT_APPLICABLE, reasons: ['no registered verify() callback; semantic artifact present'], durationMs: 0 });
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
