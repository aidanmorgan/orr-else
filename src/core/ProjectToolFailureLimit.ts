/**
 * ProjectToolFailureLimit — pure, layering-safe helpers for resolving the
 * configured "suggested outcome" of a project-tool failure-limit.
 *
 * This lives in core (not in src/plugins) because both the plugin pipeline
 * (preflight) AND core orchestration (Supervisor restart/quarantine routing)
 * need it. Keeping it here lets core import it without reaching into the
 * plugin layer — see tests/layering.test.ts (core must not import plugin
 * implementation modules).
 *
 * It depends only on the ProjectToolConfig domain type and performs no I/O.
 */
import type { ProjectToolConfig } from './domain/StateModels.js';

/** Default routing outcome when a tool declares a failure limit but no
 * state/action-specific suggested outcome. */
export const DEFAULT_FAILURE_LIMIT_OUTCOME = 'BLOCKED';

/**
 * Resolve the suggested routing outcome for a tool's failure limit, honouring
 * (most specific first): per-state/action override, per-action override,
 * per-state override, then the tool-level default, then BLOCKED.
 */
export function projectToolFailureLimitSuggestedOutcome(
  definition: ProjectToolConfig | undefined,
  stateId?: string,
  actionId?: string
): string {
  const failureLimit = definition?.failureLimit;
  const byAction = failureLimit?.suggestedOutcomeByAction || {};
  const stateActionKey = stateId && actionId ? `${stateId}/${actionId}` : undefined;
  if (stateActionKey && byAction[stateActionKey]) return byAction[stateActionKey];
  if (actionId && byAction[actionId]) return byAction[actionId];

  const byState = failureLimit?.suggestedOutcomeByState || {};
  if (stateId && byState[stateId]) return byState[stateId];

  return failureLimit?.suggestedOutcome || DEFAULT_FAILURE_LIMIT_OUTCOME;
}
