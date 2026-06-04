/**
 * Worker-run lifecycle helpers.
 *
 * Contains the terminal-failure-limit cluster, the gate-readiness types
 * and evaluateGateReadiness function, and the TerminalFailureLimitContext
 * interface used by both the gate evaluation and the tool-policy observers.
 *
 * No process.env reads — env-derived values are passed via the session
 * or runtime-services arguments.
 */

import type { HarnessConfig } from '../core/ConfigLoader.js';
import type { DomainEvent } from '../core/EventStore.js';
import type { Observability } from '../core/Observability.js';
import type { RuntimeServices } from '../core/RuntimeServices.js';
import { Logger } from '../core/Logger.js';
import { missingMandatoryChecklistItems } from '../core/ChecklistRequirements.js';
import { isAdvanceOutcome } from '../core/FlowManager.js';
import {
  DomainEventName,
  EventName,
  BuiltInToolName,
  Component,
  WorkerDefaults,
  HandoverRequiredDefaults,
  PromptProvenanceDefaults
} from '../constants/index.js';
import { detectStaleProvenanceEntries, computeCurrentStateConfigHash, type PromptProvenanceEntry } from '../core/PiIntegration.js';
import { projectToolFailureLimitSuggestedOutcome } from '../plugins/projectTools.js';
import { resultIndicatesSuccess, resultIndicatesFailure, isRecord } from './PiEventAdapters.js';
import { resolveActionHandoverRequired } from './CoordinatorController.js';
import type { ActiveRun } from './SessionTypes.js';

// 0yt5.16/0yt5.17: the zero-target-scan guard has been REMOVED. It was harness-side
// result-field recognition (reading the tool result's scanned-target count to
// override its PASSED status). The harness no longer recognizes scan-target evidence
// on a tool result; zero-target-scan semantics, if a tool needs them, belong in that
// tool's own verify() callback.

// ── terminal failure limit payload helpers ────────────────────────────────────

export function isTerminalFailureLimitPayload(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && isRecord(value.failureLimit) && value.failureLimit.terminal === true;
}

export function terminalFailureLimitDataFromResult(result: unknown): Record<string, unknown> | undefined {
  if (!isTerminalFailureLimitPayload(result)) return undefined;
  return {
    tool: typeof result.tool === 'string' ? result.tool : undefined,
    result
  };
}

export function scanTerminalFailureLimit(run: ActiveRun, services: RuntimeServices): Promise<DomainEvent | undefined> {
  return services.eventStore.latestProjectToolFailureLimitEvent(run.beadId, {
    stateId: run.stateId,
    actionId: run.action.id,
    terminalOnly: true
  });
}

export function preloadTerminalFailureLimit(run: ActiveRun, services: RuntimeServices): void {
  if (run.terminalFailureLimitScanned || run.terminalFailureLimitScan) return;
  run.terminalFailureLimitScan = scanTerminalFailureLimit(run, services)
    .then(event => {
      run.terminalFailureLimitScanned = true;
      if (event) run.terminalFailureLimitEvent = event;
      return event;
    })
    .catch(error => {
      run.terminalFailureLimitScan = undefined;
      Logger.warn(Component.ORR_ELSE, 'Unable to preload terminal project-tool failure limit', {
        beadId: run.beadId,
        stateId: run.stateId,
        actionId: run.action.id,
        error: String(error)
      });
      return undefined;
    });
}

// ── terminal failure limit context ────────────────────────────────────────────

export interface TerminalFailureLimitContext {
  failedTool: string;
  suggestedOutcome: string;
  suggestedOutcomeValid: boolean;
  suggestedOutcomeTransitionError?: string;
  stateId: string;
  actionId: string;
}

/** Session subset needed by terminalFailureLimitContext */
export interface TerminalFailureSession {
  activeRun: ActiveRun | null;
}

function routingHintSuggestedOutcomeFromResult(result: Record<string, any>): string | undefined {
  const candidates = [
    result.routingHint,
    isRecord(result.structuredResult) ? result.structuredResult.routingHint : undefined,
    isRecord(result.result) ? result.result.routingHint : undefined,
    isRecord(result.result) && isRecord(result.result.structuredResult)
      ? result.result.structuredResult.routingHint
      : undefined
  ];
  for (const candidate of candidates) {
    if (isRecord(candidate) && typeof candidate.suggestedOutcome === 'string') {
      return candidate.suggestedOutcome;
    }
  }
  return undefined;
}

export async function terminalFailureLimitContext(
  services: RuntimeServices,
  session: TerminalFailureSession,
  isWorker: boolean
): Promise<TerminalFailureLimitContext | null> {
  const run = session.activeRun;
  if (!isWorker || !run) return null;

  let data = run.terminalFailureLimitEvent?.data || run.terminalFailureLimitResult;

  if (!data) {
    if (run.terminalFailureLimitScanned) return null;
    preloadTerminalFailureLimit(run, services);
    const limitEvent = await run.terminalFailureLimitScan;
    run.terminalFailureLimitScanned = true;
    run.terminalFailureLimitScan = undefined;
    if (!limitEvent) return null;
    run.terminalFailureLimitEvent = limitEvent;
    data = limitEvent.data || {};
  }

  const result = isRecord(data.result) ? data.result : {};
  const failureLimit = isRecord(result.failureLimit) ? result.failureLimit : {};
  const failedTool = typeof data.tool === 'string'
    ? data.tool
    : typeof result.tool === 'string'
      ? result.tool
      : 'unknown';
  const config = await services.configLoader.load();
  const failedToolDefinition = config.tools?.find(tool => tool.name === failedTool);
  const recordedSuggestedOutcome = typeof failureLimit.suggestedOutcome === 'string'
    ? failureLimit.suggestedOutcome
    : routingHintSuggestedOutcomeFromResult(result);
  const configuredSuggestedOutcome = projectToolFailureLimitSuggestedOutcome(
    failedToolDefinition,
    run.stateId,
    run.action.id
  );
  const suggestedOutcome = recordedSuggestedOutcome || configuredSuggestedOutcome || EventName.BLOCKED;
  let suggestedOutcomeValid = true;
  let suggestedOutcomeTransitionError: string | undefined;
  try {
    services.flowManager.nextState(run.state, suggestedOutcome, run.stateId);
  } catch (error) {
    suggestedOutcomeValid = false;
    suggestedOutcomeTransitionError = String(error);
  }
  return {
    failedTool,
    suggestedOutcome,
    suggestedOutcomeValid,
    suggestedOutcomeTransitionError,
    stateId: run.stateId,
    actionId: run.action.id
  };
}

export async function terminalFailureLimitRejection(
  toolName: string,
  services: RuntimeServices,
  session: TerminalFailureSession,
  isWorker: boolean,
  terminalFailureAllowedTools: Set<string>
): Promise<string | null> {
  if (terminalFailureAllowedTools.has(toolName)) return null;
  const terminal = await terminalFailureLimitContext(services, session, isWorker);
  if (!terminal) return null;

  if (!terminal.suggestedOutcomeValid) {
    return `PROTOCOL VIOLATION: terminal failure limit already reached for project tool \`${terminal.failedTool}\` ` +
      `in ${terminal.stateId}/${terminal.actionId}. Do not call \`${toolName}\` or gather more evidence in this state. ` +
      `The configured failure outcome \`${terminal.suggestedOutcome}\` is not routable here: ` +
      `${terminal.suggestedOutcomeTransitionError}. Use \`${BuiltInToolName.SUBMIT_CHECKPOINT}\` with this failure-limit ` +
      `evidence, then \`${BuiltInToolName.REQUEST_HARNESS_RESTART}\` with the same summary.`;
  }

  return `PROTOCOL VIOLATION: terminal failure limit already reached for project tool \`${terminal.failedTool}\` ` +
    `in ${terminal.stateId}/${terminal.actionId}. Do not call \`${toolName}\` or gather more evidence in this state. ` +
    `Use \`${BuiltInToolName.SUBMIT_CHECKPOINT}\` with the failure-limit evidence, then ` +
    `\`${BuiltInToolName.SIGNAL_COMPLETION}\` with outcome \`${terminal.suggestedOutcome}\`.`;
}

// ── gate readiness types and evaluation ───────────────────────────────────────

export interface RequiredToolAuditEntry {
  name: string;
  state: 'passed' | 'failed' | 'never_invoked' | 'unavailable';
  /** Set when state is 'unavailable'. Describes the infra blocker and remediation. */
  reason?: string;
}

export interface TerminalFailureLimitAudit {
  reached: boolean;
  failedTool?: string;
  suggestedOutcome?: string;
  suggestedOutcomeValid?: boolean;
  suggestedOutcomeTransitionError?: string;
}

/**
 * Structured result returned by evaluateGateReadiness.
 * All fields are read-only diagnostic data — the function never mutates state.
 *
 * toolAuditFailures contains the same per-tool failure strings that
 * signal_completion builds for its REJECTED: Protocol Violation message, so
 * that signal_completion can reuse them verbatim without re-examining results.
 */
export interface GateReadiness {
  ready: boolean;
  transitionValid: boolean;
  transitionError?: string;
  requiredTools: RequiredToolAuditEntry[];
  /** Verbatim per-tool failure strings used by signal_completion's REJECTED message. */
  toolAuditFailures: string[];
  terminalFailureLimit: TerminalFailureLimitAudit;
  requiredOutcome: string | null;
  missingChecklistItems: string[];
  checkpointAccepted: boolean;
  /**
   * True when the handoverRequired gate is satisfied for this run.
   *
   * When the resolved handoverRequired is false (default), this is always true.
   * When handoverRequired is true, this is true only when a checkpoint has been
   * submitted with a summary of at least HandoverRequiredDefaults.MIN_SUMMARY_CHARS
   * characters — ensuring the field drives a real behavioral difference.
   */
  handoverSatisfied: boolean;
  writeSetValid: boolean | null;
  writeSetReason?: string;
  transactionalValid: boolean | null;
  transactionalReason?: string;
  /** Provenance dimension: false when provenance is missing or stale. */
  provenanceValid: boolean;
  provenanceReason?: string;
  blockingEvidence: string[];
}

/** Session subset needed by evaluateGateReadiness */
export interface GateReadinessSession extends TerminalFailureSession {
  activeRun: ActiveRun | null;
}

function requiredToolsForRun(run: ActiveRun): import('../core/domain/StateModels.js').RequiredTool[] | undefined {
  const requiredTools = [
    ...(run.state.requiredTools || []),
    ...(run.action.requiredTools || [])
  ];
  return requiredTools.length > 0 ? requiredTools : undefined;
}

/**
 * Shared WORKER-side gate predicate that evaluates whether signal_completion
 * would ACCEPT or REJECT a given outcome. Both signal_completion and
 * pre_signal_audit call this so that audit.ready matches the worker-side accept
 * condition.
 *
 * ADVISORY (pi-experiment-0yt5.20 decision B / AC3): this predicate reads the
 * WORKER's in-memory tool-result map (obs.getToolResult) and is a NON-BINDING
 * pre-check only. It can still inform the worker (fail-fast before signaling),
 * but the BINDING artifact-presence authority is the COORDINATOR-side verifier
 * gate (evaluateCoordinatorGate, run in handleTeammateEvent before
 * STATE_TRANSITION_APPLIED), which re-evaluates the completing (state, action)
 * against DURABLE state. A worker that passes this local pre-check is still
 * BLOCKED by the coordinator when the durable tool-result event / artifact is
 * absent — the coordinator is the sole binding authority.
 *
 * IMPORTANT: This function is read-only. It does NOT record domain events,
 * does NOT auto-restore unapproved paths, does NOT post any signals, and does
 * NOT modify any state. It calls validateSuccessReadOnly (not validateSuccess)
 * on the transactional state guard so that no git restore side effects occur.
 */
export async function evaluateGateReadiness(
  activeRun: ActiveRun,
  outcome: string,
  services: RuntimeServices,
  session: GateReadinessSession,
  obs: Observability,
  config: HarnessConfig,
  isWorker: boolean
): Promise<GateReadiness> {
  const blockingEvidence: string[] = [];

  // ── 1. nextState transition validity ─────────────────────────────────────
  let transitionValid = true;
  let transitionError: string | undefined;
  try {
    services.flowManager.nextState(activeRun.state, outcome, activeRun.stateId);
  } catch (error) {
    transitionValid = false;
    transitionError = String(error);
    blockingEvidence.push(`Invalid transition: ${transitionError}`);
  }

  // ── 2. Terminal failure limit ─────────────────────────────────────────────
  const terminal = await terminalFailureLimitContext(services, session, isWorker);
  const terminalFailureLimit: TerminalFailureLimitAudit = terminal
    ? {
        reached: true,
        failedTool: terminal.failedTool,
        suggestedOutcome: terminal.suggestedOutcome,
        suggestedOutcomeValid: terminal.suggestedOutcomeValid,
        suggestedOutcomeTransitionError: terminal.suggestedOutcomeTransitionError
      }
    : { reached: false };
  if (terminal && !terminal.suggestedOutcomeValid) {
    blockingEvidence.push(
      `Terminal failure limit outcome \`${terminal.suggestedOutcome}\` is not routable from ` +
      `${terminal.stateId}/${terminal.actionId}: ${terminal.suggestedOutcomeTransitionError}. ` +
      `Use \`${BuiltInToolName.REQUEST_HARNESS_RESTART}\` after checkpointing the failure-limit evidence.`
    );
  }
  if (terminal && outcome !== terminal.suggestedOutcome) {
    blockingEvidence.push(
      `Terminal failure limit reached for \`${terminal.failedTool}\`. ` +
      `Required outcome: \`${terminal.suggestedOutcome}\`.`
    );
  }

  // ── 3. advance-outcome-only: mandatory checklist + required tools ──────────
  // Controlled by isAdvanceOutcome so that custom advance outcomes (e.g. ADVANCE
  // in a non-SDLC statechart) are gated the same way as the default SUCCESS.
  // With the default config this is byte-identical to `outcome === 'SUCCESS'`.
  let missingChecklistItems: string[] = [];
  let requiredToolEntries: RequiredToolAuditEntry[] = [];
  const toolAuditFailures: string[] = [];

  if (isAdvanceOutcome(outcome, config)) {
    const projection = await services.eventStore.projectBead(activeRun.beadId);
    missingChecklistItems = missingMandatoryChecklistItems(activeRun.requiredItems, projection.checklists as any);
    if (missingChecklistItems.length > 0) {
      blockingEvidence.push(
        `Mandatory checklist items outstanding: ${missingChecklistItems.map(t => `\`${t}\``).join(', ')}.`
      );
    }

    const requiredToolResolution = await services.requiredToolResolver.resolve(
      requiredToolsForRun(activeRun),
      {
        beadId: activeRun.beadId,
        stateId: activeRun.stateId,
        worktreePath: activeRun.worktreePath,
        projectRoot: services.projectRoot,
        config
      }
    );
    // Build the structured audit entries and collect tool failures in two
    // complementary formats:
    //  - toolAuditFailures: verbatim per-tool strings reused by signal_completion
    //    for its "REJECTED: Protocol Violation" message (original exact wording).
    //  - blockingEvidence: user-facing strings pushed into the audit result; uses
    //    a consistent "Required tool `X` was never invoked / did not pass" form
    //    that the existing pre_signal_audit tests assert against.
    requiredToolEntries = requiredToolResolution.toolNames.map(toolName => {
      const result = obs.getToolResult(toolName);
      let state: 'passed' | 'failed' | 'never_invoked';
      if (result === undefined) {
        state = 'never_invoked';
        toolAuditFailures.push(`Tool \`${toolName}\` was NEVER invoked.`);
        blockingEvidence.push(`Required tool \`${toolName}\` was never invoked.`);
      } else if (resultIndicatesSuccess(result)) {
        state = 'passed';
      } else if (typeof result === 'string' && (result.startsWith('Error') || result.startsWith('Failed'))) {
        state = 'failed';
        toolAuditFailures.push(`Tool \`${toolName}\` failed: ${result}`);
        blockingEvidence.push(`Required tool \`${toolName}\` did not pass.`);
      } else if (resultIndicatesFailure(result)) {
        state = 'failed';
        toolAuditFailures.push(`Tool \`${toolName}\` did not pass: ${JSON.stringify(result).slice(0, WorkerDefaults.TOOL_AUDIT_PREVIEW_CHARS)}`);
        blockingEvidence.push(`Required tool \`${toolName}\` did not pass.`);
      } else {
        state = 'failed';
        toolAuditFailures.push(`Tool \`${toolName}\` did not record a passing result: ${JSON.stringify(result).slice(0, WorkerDefaults.TOOL_AUDIT_PREVIEW_CHARS)}`);
        blockingEvidence.push(`Required tool \`${toolName}\` did not pass.`);
      }
      return { name: toolName, state };
    });
  }

  // ── 4. advance-outcome-only: plan write-set preflight (read-only, pure) ────
  let writeSetValid: boolean | null = null;
  let writeSetReason: string | undefined;

  if (isAdvanceOutcome(outcome, config)) {
    const planWriteSetPreflight = await services.planWriteSet.validatePlanContract({
      beadId: activeRun.beadId,
      stateId: activeRun.stateId,
      worktreePath: activeRun.worktreePath || process.cwd(),
      projectRoot: services.projectRoot
    });
    writeSetValid = planWriteSetPreflight.passed;
    writeSetReason = planWriteSetPreflight.reason;
    if (!planWriteSetPreflight.passed) {
      blockingEvidence.push(
        `Plan write-set preflight failed: ${planWriteSetPreflight.reason || 'write-set contract violation'}.`
      );
    }
  }

  // ── 5. advance-outcome-only: transactional state guard (read-only) ─────────
  let transactionalValid: boolean | null = null;
  let transactionalReason: string | undefined;

  if (isAdvanceOutcome(outcome, config)) {
    const transactionalState = await services.transactionalStateGuard.validateSuccessReadOnly(
      activeRun.beadId,
      activeRun.stateId,
      activeRun.worktreePath || process.cwd()
    );
    transactionalValid = transactionalState.passed;
    transactionalReason = transactionalState.reason;
    if (!transactionalState.passed) {
      blockingEvidence.push(
        `Transactional state gate failed: ${transactionalState.reason || 'unapproved dirty paths'}.`
      );
    }
  }

  // ── 6. Checkpoint ─────────────────────────────────────────────────────────
  const checkpointAccepted = activeRun.checkpointAccepted;
  if (!checkpointAccepted) {
    blockingEvidence.push(
      `\`${BuiltInToolName.SUBMIT_CHECKPOINT}\` has not been called yet.`
    );
  }

  // ── 6a. Handover required ─────────────────────────────────────────────────
  // When the action (or its parent state) declares handoverRequired=true, the
  // checkpoint summary must be substantive — at or above MIN_SUMMARY_CHARS —
  // so that the field drives a real gate rather than being a no-op decoration.
  // Applies only to advance outcomes (same scope as checklist / required-tools).
  const handoverRequired = resolveActionHandoverRequired(activeRun.action, activeRun.state);
  const handoverSummary = activeRun.handoverSummary ?? '';
  const handoverSatisfied = !handoverRequired ||
    (checkpointAccepted && handoverSummary.length >= HandoverRequiredDefaults.MIN_SUMMARY_CHARS);
  if (isAdvanceOutcome(outcome, config) && !handoverSatisfied) {
    blockingEvidence.push(
      `Action declares \`handoverRequired: true\` but no substantive checkpoint summary was recorded ` +
      `(minimum ${HandoverRequiredDefaults.MIN_SUMMARY_CHARS} characters). ` +
      `Call \`${BuiltInToolName.SUBMIT_CHECKPOINT}\` with a detailed summary before signaling completion.`
    );
  }

  // ── 7. Prompt provenance ──────────────────────────────────────────────────
  // Re-derive this run's prompt/config hashes and compare against the snapshot
  // recorded at STATE_RUN_INITIALIZED to detect drift since run-start.
  //
  // Two distinct NOT-OK cases are handled with different policy:
  //   STALE   — provenance was recorded at init AND a prompt/config hash has
  //             since changed.  HARD-REJECT: the agent is completing from a
  //             different prompt baseline than it started on.
  //   MISSING — no provenance was recorded at all (not because resolution failed,
  //             but because the init event is absent, which should not happen in
  //             normal operation).  HARD-REJECT: we cannot verify the prompt
  //             baseline at all.
  //   RESOLUTION-FAILED — provenance resolution threw at init time (recorded via
  //             `promptProvenanceResolutionFailed: true` on the init event).
  //             WARN-ONLY: the agent should not be penalised for a harness-level
  //             resolution problem; completion is allowed.
  //
  // Performance: eventsForBead loads the bead's full event history (O(n) in the
  // number of events for this bead) to find the latest STATE_RUN_INITIALIZED.
  // This is acceptable because: (a) the completion path is not on the hot turn
  // loop — it fires once per run; (b) typical bead event counts are bounded by
  // the number of actions + turns, not total project events.  A dedicated
  // projection/index for "latest init event for bead+state" would reduce this
  // to O(1) if the event store ever grows to support it.
  //
  // Local reason constants for the two distinct failure modes.
  const REJECT_REASON_RESOLUTION_FAILED =
    'Prompt provenance could not be resolved at run start (harness error; warn only — completion allowed)';

  let provenanceValid = true;
  let provenanceReason: string | undefined;

  if (isAdvanceOutcome(outcome, config)) {
    const beadEvents = await services.eventStore.eventsForBead(activeRun.beadId);
    const initEvent = [...beadEvents]
      .reverse()
      .find(e => e.type === DomainEventName.STATE_RUN_INITIALIZED && e.data?.stateId === activeRun.stateId);

    // If resolution failed at init, warn but do not block completion.
    const resolutionFailed = initEvent?.data?.promptProvenanceResolutionFailed === true;
    if (resolutionFailed) {
      // Warn via provenanceReason but leave provenanceValid = true (allow completion).
      provenanceReason = REJECT_REASON_RESOLUTION_FAILED;
      // Do NOT push to blockingEvidence — this is a warn-only path.
    } else {
      const recorded = initEvent?.data?.promptProvenance as
        | { entries: PromptProvenanceEntry[]; harnessConfigVersion?: string }
        | undefined;

      if (!recorded || !Array.isArray(recorded.entries) || recorded.entries.length === 0) {
        // No provenance recorded and no resolution-failed marker → init event is
        // missing or was never written.  Hard-reject.
        provenanceValid = false;
        provenanceReason = PromptProvenanceDefaults.REJECT_REASON_MISSING;
        blockingEvidence.push(`${PromptProvenanceDefaults.REJECT_REASON_MISSING}.`);
      } else {
        // Check for stale file-backed entries (non-blocking and state-config entries
        // are automatically excluded by detectStaleProvenanceEntries).
        const staleIdentifiers: string[] = detectStaleProvenanceEntries(recorded.entries);

        // Separately check the state-config-subtree hash: re-derive the current
        // raw-YAML subtree hash and compare with the init-time hash.
        const stateConfigEntry = recorded.entries.find(e => e.kind === 'stateConfig');
        if (stateConfigEntry) {
          const fresh = computeCurrentStateConfigHash(services.configLoader.getConfigPath(), activeRun.stateId);
          if (fresh.sha256 !== stateConfigEntry.sha256) {
            staleIdentifiers.push(stateConfigEntry.path);
          }
        }

        if (staleIdentifiers.length > 0) {
          provenanceValid = false;
          const fileList = staleIdentifiers.map(p => `\`${p}\``).join(', ');
          provenanceReason = `${PromptProvenanceDefaults.REJECT_REASON_STALE}: ${fileList}`;
          blockingEvidence.push(`${provenanceReason}.`);
        }
      }
    }
  }

  return {
    ready: blockingEvidence.length === 0,
    transitionValid,
    transitionError,
    requiredTools: requiredToolEntries,
    toolAuditFailures,
    terminalFailureLimit,
    requiredOutcome: terminal?.suggestedOutcome ?? null,
    missingChecklistItems,
    checkpointAccepted,
    handoverSatisfied,
    writeSetValid,
    writeSetReason,
    transactionalValid,
    transactionalReason,
    provenanceValid,
    provenanceReason,
    blockingEvidence
  };
}
