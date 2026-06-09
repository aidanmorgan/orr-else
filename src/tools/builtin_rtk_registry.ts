/**
 * builtin_rtk_registry.ts — per-tool RTK summary factory registry for built-in tools.
 *
 * pi-experiment-zog2.2 (producer-side)
 *
 * DESIGN
 * ------
 * Each built-in tool's RTK summary is OWNED by its tool module (AC3 + zog2.7).
 * This registry maps tool names to their tool-module-owned summary factory functions.
 *
 * wrapPluginTool queries this registry after execute() to get the RTK summary
 * for the current tool. The factory is called with the execute() result (typed as
 * unknown) and the invocation params (typed as unknown). The returned summary is
 * attached to the event-store record via assembleAndWriteBuiltInHandle() — never
 * to the model-facing response.
 *
 * OWNERSHIP CONTRACT (zog2.7)
 * ----------------------------
 * Each factory function in this registry MUST be defined in and imported from the
 * tool's own TypeScript module (src/tools/<toolName>.ts). The registry itself
 * is NOT the owner — it is the lookup table. Do NOT define summary logic here.
 *
 * COVERAGE
 * --------
 * Every invocable BuiltInToolName must have a factory entry.
 * BuiltInToolName.ORR_ELSE ('orr-else') is explicitly excluded: it is a Pi COMMAND
 * registered via pi.registerCommand(), not a model-callable tool. The coordinator
 * never invokes it as a tool, so no RTK summary is needed (pi-experiment-2xho).
 *
 * FORBIDDEN
 * ---------
 * - Defining RTK summary types or schema descriptors here.
 * - Generating summaries without calling a tool-local factory.
 * - Falling through to a generic/shared summarizer.
 */

import type { ToolEvidenceRtkSummary } from '../core/ToolEvidenceHandle.js';
import { BuiltInToolName } from '../constants/domain.js';
import { buildHarnessStatusRtkSummary } from './harness_status.js';
import { buildPreSignalAuditRtkSummary } from './pre_signal_audit.js';
import { buildGetArtifactPathsRtkSummary } from './get_artifact_paths.js';
import { buildTickItemsRtkSummary } from './tick_items.js';
import { buildSubmitCheckpointRtkSummary } from './submit_checkpoint.js';
import { buildSignalCompletionRtkSummary } from './signal_completion.js';
import { buildGetOutstandingTasksRtkSummary } from './get_outstanding_tasks.js';
import { buildAddChecklistItemRtkSummary } from './add_checklist_item.js';
import { buildSubmitReviewArtifactRtkSummary } from './submit_review_artifact.js';
import { buildRequestContextRestartRtkSummary } from './request_context_restart.js';
import { buildRequestHarnessRestartRtkSummary } from './request_harness_restart.js';
import { buildQueryArtifactRtkSummary } from './query_artifact.js';
import { buildReadPathContextRtkSummary } from './read_path_context.js';
import { buildQueryHarnessEventsRtkSummary } from './query_harness_events.js';
import { buildQueryToolOutputRtkSummary } from './query_tool_output.js';
import { buildSubmitActionEvidenceRtkSummary } from './submit_action_evidence.js';
import { buildQueryHarnessLogsRtkSummary } from './query_harness_logs.js';
import { buildQueryTmuxTranscriptsRtkSummary } from './query_tmux_transcripts.js';
import { buildQueryOtelSpansRtkSummary } from './query_otel_spans.js';

// ---------------------------------------------------------------------------
// Factory type
// ---------------------------------------------------------------------------

/**
 * An RTK summary factory for a built-in tool.
 * Takes the execute() result (unknown) and the invocation params (unknown).
 * Returns the tool-local ToolEvidenceRtkSummary.
 *
 * Factories are defined in the tool's own module; this registry just holds references.
 */
export type BuiltInRtkSummaryFactory = (
  result: unknown,
  params: unknown
) => ToolEvidenceRtkSummary;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Map from BuiltInToolName → tool-local RTK summary factory.
 *
 * COVERAGE: every invocable BuiltInToolName has an entry.
 * BuiltInToolName.ORR_ELSE is omitted: it is a Pi command surface
 * (pi.registerCommand), not a model-callable tool (pi-experiment-2xho).
 */
export const BUILTIN_RTK_SUMMARY_REGISTRY: ReadonlyMap<string, BuiltInRtkSummaryFactory> = new Map([

  // ── Control-plane tools ──────────────────────────────────────────────────

  [BuiltInToolName.HARNESS_STATUS, (result: unknown, _params: unknown): ToolEvidenceRtkSummary => {
    const r = result !== null && typeof result === 'object' ? result as Record<string, unknown> : {};
    return buildHarnessStatusRtkSummary({
      flowActive: typeof r.mode === 'string' && r.mode !== 'inactive',
      beadId: typeof r.beadId === 'string' ? r.beadId : undefined,
      stateId: typeof r.stateId === 'string' ? r.stateId : undefined,
      actionId: typeof r.actionId === 'string' ? r.actionId : undefined,
      maxSlots: typeof r.maxSlots === 'number' ? r.maxSlots : undefined,
      autoContinue: typeof r.autoContinue === 'boolean' ? r.autoContinue : undefined,
    });
  }],

  [BuiltInToolName.PRE_SIGNAL_AUDIT, (result: unknown, _params: unknown): ToolEvidenceRtkSummary => {
    const r = result !== null && typeof result === 'object' ? result as Record<string, unknown> : {};
    return buildPreSignalAuditRtkSummary({
      ready: r.ready === true,
      outcome: typeof r.outcome === 'string' ? r.outcome : 'SUCCESS',
      blockingCount: Array.isArray(r.blockingEvidence) ? r.blockingEvidence.length : 0,
      checkpointAccepted: typeof r.checkpointAccepted === 'boolean' ? r.checkpointAccepted : undefined,
    });
  }],

  // ── Artifact/query tools ─────────────────────────────────────────────────

  [BuiltInToolName.GET_ARTIFACT_PATHS, (result: unknown, params: unknown): ToolEvidenceRtkSummary => {
    const p = params !== null && typeof params === 'object' ? params as Record<string, unknown> : {};
    return buildGetArtifactPathsRtkSummary({
      result,
      beadId: typeof p.beadId === 'string' ? p.beadId : undefined,
      stateId: typeof p.stateId === 'string' ? p.stateId : undefined,
    });
  }],

  [BuiltInToolName.QUERY_ARTIFACT, (result: unknown, _params: unknown): ToolEvidenceRtkSummary =>
    buildQueryArtifactRtkSummary({ result })
  ],

  [BuiltInToolName.READ_PATH_CONTEXT, (result: unknown, _params: unknown): ToolEvidenceRtkSummary =>
    buildReadPathContextRtkSummary({ result })
  ],

  [BuiltInToolName.QUERY_HARNESS_EVENTS, (result: unknown, _params: unknown): ToolEvidenceRtkSummary =>
    buildQueryHarnessEventsRtkSummary({ result })
  ],

  [BuiltInToolName.QUERY_TOOL_OUTPUT, (result: unknown, _params: unknown): ToolEvidenceRtkSummary =>
    buildQueryToolOutputRtkSummary({ result })
  ],

  [BuiltInToolName.QUERY_HARNESS_LOGS, (result: unknown, _params: unknown): ToolEvidenceRtkSummary =>
    buildQueryHarnessLogsRtkSummary({ result })
  ],

  [BuiltInToolName.QUERY_TMUX_TRANSCRIPTS, (result: unknown, _params: unknown): ToolEvidenceRtkSummary =>
    buildQueryTmuxTranscriptsRtkSummary({ result })
  ],

  [BuiltInToolName.QUERY_OTEL_SPANS, (result: unknown, _params: unknown): ToolEvidenceRtkSummary =>
    buildQueryOtelSpansRtkSummary({ result })
  ],

  // ── Checklist tools ──────────────────────────────────────────────────────

  [BuiltInToolName.TICK_ITEMS, (result: unknown, _params: unknown): ToolEvidenceRtkSummary =>
    buildTickItemsRtkSummary(result)
  ],

  [BuiltInToolName.GET_OUTSTANDING_TASKS, (result: unknown, _params: unknown): ToolEvidenceRtkSummary => {
    const r = result !== null && typeof result === 'object' ? result as Record<string, unknown> : {};
    const items: unknown[] = Array.isArray(r.items) ? r.items : Array.isArray(r.tasks) ? r.tasks : [];
    const pending = items.filter((it: unknown) => {
      if (it === null || typeof it !== 'object') return false;
      const item = it as Record<string, unknown>;
      return item.completed !== true && item.ticked !== true && item.status !== 'COMPLETED';
    });
    const completed = items.filter((it: unknown) => {
      if (it === null || typeof it !== 'object') return false;
      const item = it as Record<string, unknown>;
      return item.completed === true || item.ticked === true || item.status === 'COMPLETED';
    });
    const mandatoryPending = pending.filter((it: unknown) => {
      if (it === null || typeof it !== 'object') return false;
      return (it as Record<string, unknown>).mandatory !== false;
    });
    return buildGetOutstandingTasksRtkSummary({
      totalCount: items.length,
      pendingCount: pending.length,
      completedCount: completed.length,
      mandatoryPendingCount: mandatoryPending.length,
    });
  }],

  [BuiltInToolName.ADD_CHECKLIST_ITEM, (result: unknown, params: unknown): ToolEvidenceRtkSummary => {
    const p = params !== null && typeof params === 'object' ? params as Record<string, unknown> : {};
    const text = typeof p.text === 'string' ? p.text : '';
    const mandatory = p.mandatory !== false;
    return buildAddChecklistItemRtkSummary({ result, text, mandatory });
  }],

  // ── Checkpoint/review/evidence tools ─────────────────────────────────────

  [BuiltInToolName.SUBMIT_ACTION_EVIDENCE, (result: unknown, params: unknown): ToolEvidenceRtkSummary => {
    const p = params !== null && typeof params === 'object' ? params as Record<string, unknown> : {};
    const summaryText = typeof p.summary === 'string' ? p.summary : '';
    const artifactPaths = Array.isArray(p.artifactPaths) ? p.artifactPaths : [];
    return buildSubmitActionEvidenceRtkSummary({ result, summaryText, artifactPathCount: artifactPaths.length });
  }],

  [BuiltInToolName.SUBMIT_CHECKPOINT, (result: unknown, params: unknown): ToolEvidenceRtkSummary => {
    const p = params !== null && typeof params === 'object' ? params as Record<string, unknown> : {};
    const summaryText = typeof p.summary === 'string' ? p.summary : '';
    const accepted = typeof result === 'string'
      ? result.includes('accepted')
      : result !== null && typeof result === 'object' && (result as Record<string, unknown>).status !== 'REJECTED';
    return buildSubmitCheckpointRtkSummary({ accepted, summaryText });
  }],

  [BuiltInToolName.SUBMIT_REVIEW_ARTIFACT, (result: unknown, params: unknown): ToolEvidenceRtkSummary => {
    const p = params !== null && typeof params === 'object' ? params as Record<string, unknown> : {};
    const artifactKind = typeof p.kind === 'string' ? p.kind : typeof p.artifactKind === 'string' ? p.artifactKind : 'unknown';
    return buildSubmitReviewArtifactRtkSummary({ result, artifactKind });
  }],

  // ── Restart/signal tools ─────────────────────────────────────────────────

  [BuiltInToolName.SIGNAL_COMPLETION, (result: unknown, params: unknown): ToolEvidenceRtkSummary => {
    const p = params !== null && typeof params === 'object' ? params as Record<string, unknown> : {};
    const resultStr = typeof result === 'string' ? result : JSON.stringify(result ?? '');
    const requestedOutcome = typeof p.outcome === 'string' ? p.outcome : 'unknown';
    return buildSignalCompletionRtkSummary({ result: resultStr, requestedOutcome });
  }],

  [BuiltInToolName.REQUEST_CONTEXT_RESTART, (result: unknown, params: unknown): ToolEvidenceRtkSummary => {
    const p = params !== null && typeof params === 'object' ? params as Record<string, unknown> : {};
    const reason = typeof p.reason === 'string' ? p.reason : typeof p.summary === 'string' ? p.summary : '';
    return buildRequestContextRestartRtkSummary({ result, reason });
  }],

  [BuiltInToolName.REQUEST_HARNESS_RESTART, (result: unknown, params: unknown): ToolEvidenceRtkSummary => {
    const p = params !== null && typeof params === 'object' ? params as Record<string, unknown> : {};
    const reason = typeof p.reason === 'string' ? p.reason : typeof p.summary === 'string' ? p.summary : '';
    return buildRequestHarnessRestartRtkSummary({ result, reason });
  }],

]);

/**
 * Look up the tool-local RTK summary factory for a built-in tool.
 * Returns undefined for tools without a registered factory (legacy path).
 */
export function getBuiltInRtkSummaryFactory(toolName: string): BuiltInRtkSummaryFactory | undefined {
  return BUILTIN_RTK_SUMMARY_REGISTRY.get(toolName);
}
