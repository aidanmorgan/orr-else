import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Tuning constants — exported so callers and tests can reference them without
// hard-coding magic numbers. Do NOT import from constants/domain.ts (another
// bead owns that file this wave).
// ---------------------------------------------------------------------------

/** Number of hex characters kept from the SHA-256 of the stable inputs. */
export const DIGEST_ID_LENGTH = 16;

/**
 * Characters-per-token divisor used to estimate LLM input token consumption
 * from a byte/char count.  4 chars ≈ 1 token is the standard approximation
 * for mixed English/code content (same heuristic used elsewhere in the harness).
 */
export const TOKEN_ESTIMATE_DIVISOR = 4;

/**
 * Token budget for the stable bootstrap block.  When the estimated token
 * count of the assembled stable block exceeds this threshold the digest is
 * flagged as over-budget so the caller can emit a warning or downgrade.
 *
 * 8 000 tokens is a conservative ceiling for a cacheable system-prompt prefix
 * (roughly 32 KB of text).  Adjust upward if role/protocol guidance grows, but
 * keep it well below typical context windows so the prefix does not crowd out
 * bead-specific volatile content.
 */
export const BOOTSTRAP_INPUT_TOKEN_BUDGET = 8_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The stable (non-volatile) inputs that uniquely identify a bootstrap context.
 * Changing ANY of these fields produces a different digestId.
 * Volatile fields (beadId, taskId, worktreePath, …) must NOT appear here.
 */
export interface StableBootstrapInputs {
  /** Canonical absolute path to the project root. */
  projectRoot: string;
  /** Opaque identity string for the workflow/harness config (e.g. configPath). */
  configIdentity: string;
  /** The state identifier as declared in harness.yaml (any arbitrary name; no built-in vocabulary is assumed). */
  stateId: string;
  /** Sorted list of resolved tool names available in this spawn. */
  toolNames: string[];
  /** Sorted list of resolved skill names available in this spawn. */
  skillNames: string[];
  /** Sorted list of rule category labels/paths injected for this state. */
  ruleCategories: string[];
  /** Optional protocol guidance label (e.g. "ORR_ELSE_PROTOCOL_v1"). */
  protocolLabel?: string;
}

/**
 * Result of measuring/hashing the ACTUAL assembled stable block text.
 * digestId is derived from both the stable identity AND the actual text,
 * so it changes when either the identity fields or the rendered content change.
 */
export interface StableBlockDigest {
  /** Deterministic ID derived from the stable identity + actual stable text — safe to use as a cache key. */
  digestId: string;
  /** Byte length of the stable block text encoded as UTF-8. */
  byteLength: number;
  /** Rough token estimate: ceil(byteLength / TOKEN_ESTIMATE_DIVISOR). */
  estimatedTokens: number;
  /**
   * True when `estimatedTokens` exceeds BOOTSTRAP_INPUT_TOKEN_BUDGET.
   * Caller should emit a warning and/or downgrade context when this is set.
   */
  overBudget: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Measure and hash the ACTUAL assembled stable block text together with its
 * identity inputs.
 *
 * Design goals:
 *  - No static state: pure function.  All inputs are explicit arguments.
 *  - Deterministic: same identity + stableText → byte-identical digestId.
 *  - No duplicate rendering: this function ONLY hashes and measures the text
 *    it is given; it does NOT re-render tool/skill/rule guidance.
 *  - Size-aware: exposes estimatedTokens and overBudget so callers can warn
 *    or downgrade before the token cost is paid.
 *
 * @param stableText  The actual assembled stable block text as emitted by
 *                    ContextInjector (the portion that does NOT contain beadId,
 *                    worktreePath, or any other volatile field).
 * @param identity    The stable identity inputs used to assemble `stableText`.
 *                    Arrays are sorted before hashing so order is irrelevant.
 * @param budgetOverride  Optional override for BOOTSTRAP_INPUT_TOKEN_BUDGET.
 */
export function digestStableBlock(
  stableText: string,
  identity: StableBootstrapInputs,
  budgetOverride?: number
): StableBlockDigest {
  const digestId = createHash('sha256')
    .update(canonicalise(identity), 'utf8')
    .update(stableText, 'utf8')
    .digest('hex')
    .slice(0, DIGEST_ID_LENGTH);

  const byteLength = Buffer.byteLength(stableText, 'utf8');
  const estimatedTokens = Math.ceil(byteLength / TOKEN_ESTIMATE_DIVISOR);
  const budget = budgetOverride ?? BOOTSTRAP_INPUT_TOKEN_BUDGET;
  const overBudget = estimatedTokens > budget;

  return { digestId, byteLength, estimatedTokens, overBudget };
}

/**
 * Compute a deterministic identity digest for audit / event-store purposes
 * when the actual stable text is not yet available (e.g. at coordinator spawn
 * time, before the worker assembles its prompt).
 *
 * The digest is derived ONLY from the canonical identity JSON, not from any
 * rendered text, so it changes whenever the stable inputs change but is
 * otherwise independent of prompt assembly.
 *
 * NOTE: This ID will differ from the one recorded by STATE_RUN_INITIALIZED
 * (which mixes identity + text).  Use it only for spawn-time audit trails
 * where a best-effort stable key is better than no key.
 */
export function digestIdentity(identity: StableBootstrapInputs): string {
  return createHash('sha256')
    .update(canonicalise(identity), 'utf8')
    .digest('hex')
    .slice(0, DIGEST_ID_LENGTH);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Produces a stable JSON string from `inputs` with sorted object keys so the
 * serialisation is independent of property insertion order.  Arrays are sorted
 * before stringification so insertion order of the caller's arrays is also
 * irrelevant.
 */
function canonicalise(inputs: StableBootstrapInputs): string {
  const sorted: Record<string, unknown> = {
    configIdentity: inputs.configIdentity,
    projectRoot: inputs.projectRoot,
    protocolLabel: inputs.protocolLabel ?? '',
    ruleCategories: [...inputs.ruleCategories].sort(),
    skillNames: [...inputs.skillNames].sort(),
    stateId: inputs.stateId,
    toolNames: [...inputs.toolNames].sort()
  };
  return JSON.stringify(sorted);
}
