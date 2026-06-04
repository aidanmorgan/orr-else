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
  type VerifyResult
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
  /** The required tool has no tool-result event for this attempt (never invoked). */
  TOOL_NOT_INVOKED = 'TOOL_NOT_INVOKED',
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

/** The aggregate result of running the verifier loop over the required tools. */
export interface VerifierGateResult {
  /** True when the transition may proceed (all-PASS / NA, every tool ran). */
  pass: boolean;
  /** Every blocking failure, in tool order. Empty when `pass` is true. */
  failures: VerifierGateFailure[];
  /** A single rendered reject message; empty string when `pass` is true. */
  rejectMessage: string;
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
}

/**
 * Read a tool-result event's run status (did the tool RUN to completion) and
 * its outputFile path, reconciling the FLAT and NESTED recorded shapes.
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
      failures.push({
        tool,
        kind: VerifierGateBlockKind.TOOL_NOT_INVOKED,
        reasons: [`Required tool "${tool}" has no tool-result event for this attempt (it was not invoked).`]
      });
      continue;
    }

    // (2) Did the tool run to completion? REJECTED ⇒ it ran and failed ⇒ block.
    const { status } = readToolRun(event);
    if (status === ToolResultStatus.REJECTED) {
      failures.push({
        tool,
        kind: VerifierGateBlockKind.TOOL_REJECTED,
        reasons: [`Required tool "${tool}" did not run to completion (latest tool-result status === REJECTED).`]
      });
      continue;
    }

    // (3) The tool ran — run its registered verify() callback (if any).
    const verify = registry.get(tool);
    if (!verify) {
      // No registered callback: the tool ran (presence satisfied) and there is
      // no semantic verifier to consult, so it cannot FAIL. This is a PASS for
      // the loop's aggregate — the harness applies no tool-specific policy.
      continue;
    }

    const result: VerifyResult = await verify(verifyContext);
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
    rejectMessage: renderRejectMessage(failures)
  };
}
