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
import { isAdvanceOutcome, assertDeclaredOutcome } from '../core/FlowManager.js';
import {
  DomainEventName,
  EventName,
  BuiltInToolName,
  Component,
  HandoverRequiredDefaults,
  PromptProvenanceDefaults,
  ReviewArtifactKind
} from '../constants/index.js';
import { detectStaleProvenanceEntries, computeCurrentStateConfigHash, type PromptProvenanceEntry } from '../core/PiIntegration.js';
import { projectToolFailureLimitSuggestedOutcome } from '../plugins/projectTools.js';
import { isRecord } from './PiEventAdapters.js';
import { resolveActionHandoverRequired } from './CoordinatorController.js';
import {
  runVerifierGate,
  VerifierGateBlockKind,
  type VerifierGateContext
} from '../core/VerifierGate.js';
import type { ActiveRun } from './SessionTypes.js';

// 0yt5.33: resultIndicatesSuccess / resultIndicatesFailure are NO LONGER imported
// here. The pre_signal_audit + evaluateGateReadiness required-tool readiness
// surface has been migrated to the artifact-presence gate model: it now reuses
// `runVerifierGate` (the same loop the COORDINATOR-side binding gate runs) over
// the durable tool-result events + registered verify() callbacks, rather than
// re-classifying an in-memory tool result with resultIndicates*. Those two
// helpers are RETAINED in PiEventAdapters for their non-gate consumers
// (span-status, the SUCCEEDED validation rule, the persisted-result `failed`
// flag, and sequenced-action failure detection in extension.ts) which are
// unrelated to the artifact-presence gate.

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
  /**
   * True when the reviewArtifacts.shipPostReview gate is satisfied.
   *
   * When required=true and the active state matches the configured state,
   * this is true only when a SHIP_POST_REVIEW event with
   * artifactKind=ReviewArtifactKind.SHIP_POST_REVIEW exists for the current
   * bead + stateId in the projection.  When not configured or required=false,
   * this is always true.
   */
  reviewArtifactSatisfied: boolean;
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

/** What the advisory required-tool audit returns for one evaluation. */
interface RequiredToolAdvisoryAudit {
  entries: RequiredToolAuditEntry[];
  /** Verbatim per-tool failure strings reused by signal_completion's REJECTED message. */
  toolAuditFailures: string[];
  /** User-facing blocking strings (tool name + reason) for the audit result. */
  blockingEvidence: string[];
}

/**
 * Advisory required-tool audit on the ARTIFACT-PRESENCE gate model (0yt5.33).
 *
 * Re-points the worker-side readiness surface at the SAME inputs the COORDINATOR
 * binding gate uses (0yt5.20): the latest durable tool-result event per required
 * tool (outputFile + run status) plus that tool's registered verify() callback.
 * It reuses `runVerifierGate` directly — the identical loop — so a worker can
 * PREVIEW the likely coordinator verdict before signaling.
 *
 * Per required tool it reports exactly one of three states:
 *  - present + verdict PASS / NOT_APPLICABLE  → `passed`
 *  - absent (no tool-result event this attempt) → `never_invoked`
 *  - present but did-not-run (REJECTED) or verify() FAIL → `failed` (+ reasons)
 *
 * READ-ONLY: unlike evaluateCoordinatorGate this does NOT record a
 * VERIFY_EVALUATED event — the worker advisory has no side effects. The
 * write-set + declared-artifact PATHS are resolved best-effort (the same as the
 * coordinator), degrading to empty on any failure; the load-bearing inputs are
 * the tool-result events + verify() callbacks, never the write-set.
 */
async function auditRequiredToolsArtifactPresence(
  activeRun: ActiveRun,
  toolNames: string[],
  services: RuntimeServices
): Promise<RequiredToolAdvisoryAudit> {
  const entries: RequiredToolAuditEntry[] = [];
  const toolAuditFailures: string[] = [];
  const blockingEvidence: string[] = [];

  if (toolNames.length === 0) {
    return { entries, toolAuditFailures, blockingEvidence };
  }

  const actionId = activeRun.action.id;

  // Resolve the paths-only verify() context best-effort (mirrors the coordinator
  // gate). A failure degrades to an empty map/array rather than blocking.
  let artifacts: Record<string, string> = {};
  try {
    const resolution = await services.artifactPaths.resolve({
      beadId: activeRun.beadId,
      stateId: activeRun.stateId,
      actionId,
      includeContent: false
    });
    artifacts = resolution.artifactPaths ?? {};
  } catch {
    artifacts = {};
  }

  let writeSet: string[] = [];
  try {
    const resolution = await services.planWriteSet.resolve({
      beadId: activeRun.beadId,
      stateId: activeRun.stateId,
      worktreePath: activeRun.worktreePath || services.projectRoot,
      projectRoot: services.projectRoot
    });
    writeSet = resolution.allowedWriteSet ?? [];
  } catch {
    writeSet = [];
  }

  const ctx: VerifierGateContext = {
    beadId: activeRun.beadId,
    stateId: activeRun.stateId,
    actionId,
    writeSet,
    artifacts
  };

  const gate = await runVerifierGate(ctx, toolNames, services.eventStore);

  // Index failures by tool for the per-tool state mapping below.
  const failureByTool = new Map(gate.failures.map(failure => [failure.tool, failure] as const));

  for (const toolName of toolNames) {
    const failure = failureByTool.get(toolName);
    if (!failure) {
      // No failure for this tool ⇒ it ran (presence satisfied) and its verify()
      // returned PASS / NOT_APPLICABLE (or there was no callback).
      entries.push({ name: toolName, state: 'passed' });
      continue;
    }

    const reasonText = failure.reasons.length > 0 ? failure.reasons.join('; ') : '(no reason reported)';

    if (failure.kind === VerifierGateBlockKind.TOOL_NOT_INVOKED) {
      // Artifact ABSENT — the tool did not run this attempt.
      entries.push({ name: toolName, state: 'never_invoked' });
      toolAuditFailures.push(`Tool \`${toolName}\` was NEVER invoked.`);
      blockingEvidence.push(`Required tool \`${toolName}\` was never invoked: ${reasonText}`);
      continue;
    }

    // Present but FAIL: either the run did not complete (REJECTED) or its
    // registered verify() returned FAIL. Surface the tool name + reason(s) and,
    // when present, the verify() verdict.
    const verdictLabel = failure.verdict ? ` (verdict=${failure.verdict})` : '';
    entries.push({ name: toolName, state: 'failed' });
    toolAuditFailures.push(`Tool \`${toolName}\` did not pass${verdictLabel}: ${reasonText}`);
    blockingEvidence.push(`Required tool \`${toolName}\` did not pass${verdictLabel}: ${reasonText}`);
  }

  return { entries, toolAuditFailures, blockingEvidence };
}

/**
 * Shared WORKER-side gate predicate that evaluates whether signal_completion
 * would ACCEPT or REJECT a given outcome. Both signal_completion and
 * pre_signal_audit call this so that audit.ready matches the worker-side accept
 * condition.
 *
 * ADVISORY (pi-experiment-0yt5.20 decision B / AC3, 0yt5.33): the required-tool
 * dimension of this predicate now runs the ARTIFACT-PRESENCE gate — it reuses
 * `runVerifierGate` over the DURABLE tool-result events + registered verify()
 * callbacks (the same inputs the coordinator gate uses), so it PREVIEWS the
 * likely coordinator verdict. It remains a NON-BINDING pre-check: the BINDING
 * artifact-presence authority is the COORDINATOR-side verifier gate
 * (evaluateCoordinatorGate, run in handleTeammateEvent before
 * STATE_TRANSITION_APPLIED), which re-evaluates the completing (state, action)
 * against DURABLE state. A worker that passes this local pre-check is still
 * BLOCKED by the coordinator when a required artifact / tool-result event is
 * absent — the coordinator is the sole binding authority.
 *
 * IMPORTANT: This function is read-only. It does NOT record domain events,
 * does NOT auto-restore unapproved paths, does NOT post any signals, and does
 * NOT modify any state. It calls validateSuccessReadOnly (not validateSuccess)
 * on the transactional state guard so that no git restore side effects occur,
 * and (unlike evaluateCoordinatorGate) records NO VERIFY_EVALUATED event.
 *
 * `obs` is retained for signature stability with the prior worker-side surface;
 * the required-tool audit no longer reads the in-memory tool-result map.
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
  void obs;
  const blockingEvidence: string[] = [];

  // ── 0. Strict-mode outcome-vocabulary check ───────────────────────────────
  // When a statechart block is present the vocabulary is explicit and closed.
  // An undeclared outcome is rejected before any state mutation can occur.
  let transitionValid = true;
  let transitionError: string | undefined;
  try {
    assertDeclaredOutcome(outcome, config, `state "${activeRun.stateId}"`);
  } catch (error) {
    transitionValid = false;
    transitionError = String(error);
    blockingEvidence.push(`Undeclared outcome: ${transitionError}`);
  }

  // ── 1. nextState transition validity ─────────────────────────────────────
  if (transitionValid) {
    try {
      services.flowManager.nextState(activeRun.state, outcome, activeRun.stateId);
    } catch (error) {
      transitionValid = false;
      transitionError = String(error);
      blockingEvidence.push(`Invalid transition: ${transitionError}`);
    }
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
    // 0yt5.33: ARTIFACT-PRESENCE required-tool audit (advisory). Re-points the
    // readiness surface at the SAME inputs the coordinator binding gate uses —
    // the latest durable tool-result event per required tool (outputFile + run
    // status) plus the registered verify() callback — instead of re-classifying
    // an in-memory tool result. Per tool it reports present+verdict (passed) /
    // absent (never_invoked) / present-but-FAIL (failed, with the tool name +
    // reason), in two complementary formats:
    //  - toolAuditFailures: verbatim per-tool strings reused by signal_completion
    //    for its "REJECTED: Protocol Violation" message.
    //  - blockingEvidence: user-facing strings (tool name + reason) for the audit.
    const toolAudit = await auditRequiredToolsArtifactPresence(
      activeRun,
      requiredToolResolution.toolNames,
      services
    );
    requiredToolEntries = toolAudit.entries;
    toolAuditFailures.push(...toolAudit.toolAuditFailures);
    blockingEvidence.push(...toolAudit.blockingEvidence);
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

  // ── 5a. advance-outcome-only: required ship/post-review artifact ───────────
  // When settings.reviewArtifacts.shipPostReview.required is true and the
  // active state matches the configured state (or no state is configured,
  // making it apply to any state), a SHIP_POST_REVIEW event with
  // artifactKind=ReviewArtifactKind.SHIP_POST_REVIEW must exist in the
  // bead's projection before SUCCESS is accepted.
  //
  // Current-run scoping: the state AdversarialPostReview loops (FAILURE →
  // Implementation → AdversarialPostReview). Without run-scoping, a stale
  // SHIP_POST_REVIEW from a prior attempt would wrongly satisfy the gate on
  // the second pass. We scope by finding the latest STATE_RUN_INITIALIZED
  // event for activeRun.stateId (same pattern as the provenance gate in §7)
  // and only accepting artifacts recorded at or after that timestamp.
  //
  // Verdict/outcome consistency: an artifact whose `outcome` field is present
  // and is NOT an advance outcome records a rejecting review — it must not
  // satisfy the gate even within the current run.
  //
  // Performance: eventsForBead is O(n) in bead event count, shared with §7.
  // See §7 comment for why this is acceptable.
  let reviewArtifactSatisfied = true;
  // Hoist beadEvents here so §5a and §7 share a single eventsForBead call.
  let beadEventsForGates: Awaited<ReturnType<typeof services.eventStore.eventsForBead>> | undefined;

  if (isAdvanceOutcome(outcome, config)) {
    beadEventsForGates = await services.eventStore.eventsForBead(activeRun.beadId);

    const shipPostReviewConfig = config.settings.reviewArtifacts?.shipPostReview;
    const reviewRequired = shipPostReviewConfig?.required === true;
    const configuredState = shipPostReviewConfig?.state;
    // Gate applies only when required=true and the active state matches
    // (or no state restriction is set).
    const gateApplies = reviewRequired &&
      (!configuredState || configuredState === activeRun.stateId);

    if (gateApplies) {
      // Find the latest STATE_RUN_INITIALIZED event for the current state to
      // determine the start-of-current-run boundary.
      const latestInitEvent = [...beadEventsForGates]
        .reverse()
        .find(e => e.type === DomainEventName.STATE_RUN_INITIALIZED && e.data?.stateId === activeRun.stateId);
      const currentRunStartTimestamp = latestInitEvent?.timestamp;

      const stateChart = await services.eventStore.projectBeadStateChart(activeRun.beadId);
      const hasMatchingArtifact = stateChart.reviewArtifacts.some(a => {
        // Must be the right kind.
        if (a.artifactKind !== ReviewArtifactKind.SHIP_POST_REVIEW) return false;
        // Must match the configured stateId when one is specified.
        if (configuredState && a.stateId !== activeRun.stateId) return false;
        // Must belong to the CURRENT run: recorded at or after the latest
        // STATE_RUN_INITIALIZED for this state. If no init event was found
        // (should not happen in normal operation), we reject — we cannot
        // confirm the artifact is from the current attempt.
        if (!currentRunStartTimestamp || a.timestamp < currentRunStartTimestamp) return false;
        // Must carry an advance-consistent outcome: if `outcome` is present and
        // is NOT an advance outcome, the review is rejecting — do not satisfy.
        if (typeof a.outcome === 'string' && !isAdvanceOutcome(a.outcome, config)) return false;
        return true;
      });
      if (!hasMatchingArtifact) {
        reviewArtifactSatisfied = false;
        const stateQualifier = configuredState ? ` for state \`${configuredState}\`` : '';
        blockingEvidence.push(
          `Required ship/post-review artifact (SHIP_POST_REVIEW, artifactKind=\`${ReviewArtifactKind.SHIP_POST_REVIEW}\`)` +
          `${stateQualifier} has not been recorded for the current run with an advance-consistent outcome. ` +
          `Call \`${BuiltInToolName.SUBMIT_REVIEW_ARTIFACT}\` before signaling SUCCESS.`
        );
      }
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
  // Local reason constants for the distinct failure modes.
  const REJECT_REASON_RESOLUTION_FAILED =
    'Prompt provenance could not be resolved at run start (harness error; warn only — completion allowed)';
  const REJECT_REASON_CONFIGURED_SOURCE_FAILED =
    'A configured required source (skill or prompt file) could not be resolved at run start. ' +
    'SUCCESS is blocked until all configured skills and prompt files are available.';

  let provenanceValid = true;
  let provenanceReason: string | undefined;

  if (isAdvanceOutcome(outcome, config)) {
    // beadEventsForGates was fetched in §5a above; reuse it to avoid a second
    // eventsForBead round-trip.  It is always defined here because §5a sets it
    // whenever isAdvanceOutcome is true.
    const beadEvents = beadEventsForGates!;
    const initEvent = [...beadEvents]
      .reverse()
      .find(e => e.type === DomainEventName.STATE_RUN_INITIALIZED && e.data?.stateId === activeRun.stateId);

    // HARD-BLOCK: a CONFIGURED required source (skill, prompt file) was missing at
    // run start.  The agent cannot claim SUCCESS when its declared required context
    // was absent.  This is distinct from a harness-level error (warn-only below).
    const configuredSourceFailed = initEvent?.data?.promptProvenanceConfiguredSourceFailed === true;
    if (configuredSourceFailed) {
      provenanceValid = false;
      provenanceReason = REJECT_REASON_CONFIGURED_SOURCE_FAILED;
      blockingEvidence.push(`${REJECT_REASON_CONFIGURED_SOURCE_FAILED}`);
    }

    // WARN-ONLY: harness-level resolution error at init — do not penalise the agent.
    const resolutionFailed = initEvent?.data?.promptProvenanceResolutionFailed === true;
    if (!configuredSourceFailed && resolutionFailed) {
      // Warn via provenanceReason but leave provenanceValid = true (allow completion).
      provenanceReason = REJECT_REASON_RESOLUTION_FAILED;
      // Do NOT push to blockingEvidence — this is a warn-only path.
    }

    if (!configuredSourceFailed && !resolutionFailed) {
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
    reviewArtifactSatisfied,
    blockingEvidence
  };
}
