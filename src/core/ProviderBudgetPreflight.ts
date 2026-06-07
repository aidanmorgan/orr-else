/**
 * Provider-request budget preflight (pi-experiment-6q0y.16).
 *
 * Optional, disabled-by-default preflight that checks a serialized provider
 * request against operator-configured token/byte ceilings before the request
 * reaches the provider adapter.
 *
 * Design:
 *   - All functions are pure and side-effect-free (no I/O, no logging).
 *   - No request body is stored in the sizing record or rejection event.
 *   - The policy type lives here so StateModels.ts remains untouched.
 *   - Wiring into BEFORE_PROVIDER_REQUEST is done in PiObservers.ts.
 */

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

/**
 * Action taken when a ceiling is exceeded.
 *   'warn'  — log but allow the request to proceed.
 *   'block' — throw an error so the provider call is aborted.
 */
export type ProviderBudgetAction = 'warn' | 'block';

/**
 * Per-scope ceiling definition.  All ceiling fields are optional — an omitted
 * field means "unlimited for that dimension".  At least one ceiling field or
 * `action` should be present to be meaningful.
 */
export interface ProviderBudgetCeiling {
  /** Maximum serialized request bytes. */
  maxRequestBytes?: number;
  /** Maximum estimated input tokens (ceil(bytes / 4)). */
  maxEstimatedInputTokens?: number;
  /** Maximum `max_tokens` / `max_output_tokens` requested by the payload. */
  maxRequestedOutputTokens?: number;
  /** Action when this ceiling is exceeded. */
  action: ProviderBudgetAction;
}

/**
 * Top-level provider budget policy.
 *
 * Keyed by `provider` (e.g. 'anthropic', 'openai') or `provider:model`
 * (e.g. 'anthropic:claude-opus-4-5') for per-model overrides.
 * A plain provider key applies to all models for that provider unless
 * overridden by a more-specific `provider:model` key.
 *
 * An absent or `enabled: false` policy is a no-op — existing behaviour is
 * fully preserved.
 */
export interface ProviderBudgetPolicy {
  /** Master switch. Must be `true` for any ceiling to apply. Default: false. */
  enabled: boolean;
  /**
   * Ceiling map keyed by provider or provider:model.
   * Examples: 'anthropic', 'openai', 'anthropic:claude-opus-4-5'.
   */
  ceilings: Record<string, ProviderBudgetCeiling>;
}

// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------

/**
 * Computed sizing for one provider request.  No prompt bodies stored.
 */
export interface ProviderRequestSizing {
  /** Byte length of the JSON-serialised request payload. */
  requestBytes: number;
  /** Estimated input tokens: ceil(requestBytes / 4). */
  estimatedInputTokens: number;
  /**
   * The max_tokens / max_output_tokens value the payload requests (output
   * reservation).  0 when the field is absent or non-numeric.
   */
  requestedOutputTokens: number;
  /**
   * Conservative reserved total: estimatedInputTokens + requestedOutputTokens.
   * This is what a provider would "reserve" for the request.
   */
  reservedTotal: number;
  /** Provider string derived from payload shape heuristics. May be 'unknown'. */
  provider: string;
  /** Model string from the payload. May be 'unknown'. */
  model: string;
  /** Stable digest ID from the session — undefined when not yet recorded. */
  digestId: string | undefined;
}

const CHARS_PER_TOKEN = 4;

/**
 * Detect the provider from payload shape:
 *   - numeric `max_tokens` → 'anthropic'
 *   - `input` without numeric `max_tokens` → 'openai'
 *   - otherwise → 'unknown'
 */
function detectProvider(payload: Record<string, unknown>): string {
  if (typeof payload['max_tokens'] === 'number') return 'anthropic';
  if ('input' in payload) return 'openai';
  return 'unknown';
}

/**
 * Compute sizing for a provider request payload.
 * The payload is NOT stored in the result — only derived metrics.
 *
 * @param payload  The raw provider request payload (any shape).
 * @param digestId Stable-block digest ID from the current session.
 */
export function computeRequestSizing(
  payload: unknown,
  digestId: string | undefined
): ProviderRequestSizing {
  // Serialize to measure bytes — but discard the string immediately.
  let requestBytes = 0;
  try {
    requestBytes = Buffer.byteLength(JSON.stringify(payload) ?? '', 'utf8');
  } catch {
    requestBytes = 0;
  }

  const estimatedInputTokens = Math.ceil(requestBytes / CHARS_PER_TOKEN);

  let requestedOutputTokens = 0;
  let provider = 'unknown';
  let model = 'unknown';

  if (payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>;
    provider = detectProvider(p);
    if (typeof p['model'] === 'string') model = p['model'];
    // Anthropic: max_tokens; OpenAI Responses: max_output_tokens
    if (typeof p['max_tokens'] === 'number') {
      requestedOutputTokens = p['max_tokens'];
    } else if (typeof p['max_output_tokens'] === 'number') {
      requestedOutputTokens = p['max_output_tokens'];
    }
  }

  const reservedTotal = estimatedInputTokens + requestedOutputTokens;

  return {
    requestBytes,
    estimatedInputTokens,
    requestedOutputTokens,
    reservedTotal,
    provider,
    model,
    digestId
  };
}

// ---------------------------------------------------------------------------
// Ceiling resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the effective ceiling for a given provider+model from the policy.
 *
 * Lookup order (most-specific wins):
 *   1. `provider:model` key
 *   2. `provider` key
 *   3. undefined (no ceiling)
 */
export function resolveCeiling(
  policy: ProviderBudgetPolicy,
  provider: string,
  model: string
): ProviderBudgetCeiling | undefined {
  const specificKey = `${provider}:${model}`;
  if (policy.ceilings[specificKey]) return policy.ceilings[specificKey];
  if (policy.ceilings[provider]) return policy.ceilings[provider];
  return undefined;
}

// ---------------------------------------------------------------------------
// Budget check
// ---------------------------------------------------------------------------

/** Which dimension triggered the ceiling violation. */
export type BudgetDimension = 'requestBytes' | 'estimatedInputTokens' | 'requestedOutputTokens';

/** Result when a ceiling is exceeded. */
export interface BudgetViolation {
  dimension: BudgetDimension;
  actual: number;
  ceiling: number;
  action: ProviderBudgetAction;
}

/**
 * Check whether the sizing exceeds any configured ceiling.
 * Returns the first violation found, or `null` when all dimensions are within budget.
 *
 * Short-circuits at the first exceeded dimension (bytes → tokens → output).
 */
export function checkBudgetCeilings(
  sizing: ProviderRequestSizing,
  ceiling: ProviderBudgetCeiling
): BudgetViolation | null {
  if (ceiling.maxRequestBytes !== undefined && sizing.requestBytes > ceiling.maxRequestBytes) {
    return { dimension: 'requestBytes', actual: sizing.requestBytes, ceiling: ceiling.maxRequestBytes, action: ceiling.action };
  }
  if (ceiling.maxEstimatedInputTokens !== undefined && sizing.estimatedInputTokens > ceiling.maxEstimatedInputTokens) {
    return { dimension: 'estimatedInputTokens', actual: sizing.estimatedInputTokens, ceiling: ceiling.maxEstimatedInputTokens, action: ceiling.action };
  }
  if (ceiling.maxRequestedOutputTokens !== undefined && sizing.requestedOutputTokens > ceiling.maxRequestedOutputTokens) {
    return { dimension: 'requestedOutputTokens', actual: sizing.requestedOutputTokens, ceiling: ceiling.maxRequestedOutputTokens, action: ceiling.action };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rejection event
// ---------------------------------------------------------------------------

/**
 * Rejection event payload (AC5).
 * Never carries prompt bodies, raw request content, or source files.
 */
export interface ProviderBudgetRejectionEvent {
  provider: string;
  model: string;
  digestId: string | undefined;
  requestBytes: number;
  estimatedInputTokens: number;
  requestedOutputTokens: number;
  reservedTotal: number;
  violatedDimension: BudgetDimension;
  actualValue: number;
  configuredCeiling: number;
  action: ProviderBudgetAction;
  decision: 'warned' | 'blocked';
}

/**
 * Build a rejection event payload from the sizing + violation.
 * Pure — no side effects.
 */
export function buildBudgetRejectionEvent(
  sizing: ProviderRequestSizing,
  violation: BudgetViolation
): ProviderBudgetRejectionEvent {
  return {
    provider: sizing.provider,
    model: sizing.model,
    digestId: sizing.digestId,
    requestBytes: sizing.requestBytes,
    estimatedInputTokens: sizing.estimatedInputTokens,
    requestedOutputTokens: sizing.requestedOutputTokens,
    reservedTotal: sizing.reservedTotal,
    violatedDimension: violation.dimension,
    actualValue: violation.actual,
    configuredCeiling: violation.ceiling,
    action: violation.action,
    decision: violation.action === 'block' ? 'blocked' : 'warned'
  };
}

// ---------------------------------------------------------------------------
// Startup lint
// ---------------------------------------------------------------------------

/**
 * Validate a ProviderBudgetPolicy at startup.
 * Returns a list of validation error strings (empty = valid).
 *
 * Rejects:
 *   - Negative ceiling values (AC6).
 *   - Unknown action values (AC6: 'unknown budget routes').
 */
export function lintProviderBudgetPolicy(policy: ProviderBudgetPolicy): string[] {
  const errors: string[] = [];
  const validActions: ReadonlySet<string> = new Set(['warn', 'block']);

  for (const [key, ceiling] of Object.entries(policy.ceilings)) {
    if (!validActions.has(ceiling.action)) {
      errors.push(`providerBudget.ceilings["${key}"].action: unknown action "${ceiling.action}" (must be 'warn' or 'block')`);
    }
    if (ceiling.maxRequestBytes !== undefined && ceiling.maxRequestBytes < 0) {
      errors.push(`providerBudget.ceilings["${key}"].maxRequestBytes: must be non-negative, got ${ceiling.maxRequestBytes}`);
    }
    if (ceiling.maxEstimatedInputTokens !== undefined && ceiling.maxEstimatedInputTokens < 0) {
      errors.push(`providerBudget.ceilings["${key}"].maxEstimatedInputTokens: must be non-negative, got ${ceiling.maxEstimatedInputTokens}`);
    }
    if (ceiling.maxRequestedOutputTokens !== undefined && ceiling.maxRequestedOutputTokens < 0) {
      errors.push(`providerBudget.ceilings["${key}"].maxRequestedOutputTokens: must be non-negative, got ${ceiling.maxRequestedOutputTokens}`);
    }
  }

  return errors;
}
