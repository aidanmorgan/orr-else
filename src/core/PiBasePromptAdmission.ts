import { createHash } from 'node:crypto';
import { DIGEST_ID_LENGTH, TOKEN_ESTIMATE_DIVISOR } from './BootstrapDigest.js';

// ---------------------------------------------------------------------------
// Token budget for the Pi base system prompt.
// Pi's buildSystemPrompt() injects role instructions, tool descriptions, and
// a volatile date+cwd trailer — collectively not expected to exceed ~12k tokens.
// If it does, we flag it as over-budget for diagnostics (NOT a hard block).
// ---------------------------------------------------------------------------

/** Token budget for the Pi base (host) system prompt segment. */
export const PI_BASE_PROMPT_TOKEN_BUDGET = 12_000;

// ---------------------------------------------------------------------------
// Rule codes — emitted in diagnostics/events INSTEAD of prompt bodies
// ---------------------------------------------------------------------------

export const PiBasePromptRuleCode = {
  /** Pi base prompt is present, within budget, and compatible with invariants. */
  ADMITTED: 'ADMITTED',
  /** Pi base prompt is absent (event.systemPrompt was falsy). */
  MISSING: 'MISSING',
  /** Pi base prompt is present but exceeds the token budget. */
  OVER_BUDGET: 'OVER_BUDGET',
  /** Pi base prompt changed between turns (drift detected). */
  DRIFT: 'DRIFT',
} as const;

export type PiBasePromptRuleCode = typeof PiBasePromptRuleCode[keyof typeof PiBasePromptRuleCode];

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Hash + size measurement for a single prompt segment.
 * Intentionally contains ONLY hashes/sizes — never the prompt text itself.
 */
export interface PromptSegmentHash {
  /** SHA-256 hex string (truncated to DIGEST_ID_LENGTH). Empty string when missing. */
  readonly sha256: string;
  /** UTF-8 byte length of the segment. 0 when missing. */
  readonly byteLength: number;
  /** Rough token estimate: ceil(byteLength / TOKEN_ESTIMATE_DIVISOR). 0 when missing. */
  readonly estimatedTokens: number;
  /** True when the segment was absent (undefined / empty string). */
  readonly missing?: true;
  /** True when estimatedTokens exceeds the per-segment budget. */
  readonly overBudget?: true;
}

/**
 * Result of admitting a Pi base prompt before worker token spend.
 *
 * All fields carry HASHES, SIZES, and RULE CODES only — never prompt bodies.
 * This invariant is enforced by construction: prompt text is hashed and discarded.
 */
export interface PiBasePromptAdmission {
  /** Orr Else stable bootstrap block — hash + size only. */
  readonly stableBlockHash: PromptSegmentHash;
  /** Pi host-supplied base system prompt — hash + size only. */
  readonly piBasePromptHash: PromptSegmentHash;
  /** Volatile suffix (beadId, workdir, checklist) — hash + size only. */
  readonly volatileSuffixHash: PromptSegmentHash;
  /** Final assembled prompt (all segments joined) — hash + size only. */
  readonly finalPromptHash: PromptSegmentHash;
  /**
   * Whether the Pi base prompt is admitted for use:
   *   - MISSING (absent)  → allowed: true  (harness works without it)
   *   - ADMITTED (present, within budget) → allowed: true
   *   - OVER_BUDGET → allowed: false (exceeds the per-segment budget; a real
   *       incompatibility: the prompt is structurally too large for the expected
   *       cost envelope.  Workers should warn; coordinators should reject.)
   */
  readonly allowed: boolean;
  /** Rule code describing the admission outcome. One of PiBasePromptRuleCode. */
  readonly ruleCode: PiBasePromptRuleCode;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Hash a single prompt segment and return its measurement.
 *
 * SAFETY: The input text is hashed and discarded. The returned object
 * contains ONLY the hash digest, byte size, and token estimate — never
 * the original text.  This is the fundamental no-body-leak guarantee.
 *
 * @param text  The segment text to measure. `undefined` or empty string
 *              produces `{ sha256: '', byteLength: 0, estimatedTokens: 0, missing: true }`.
 * @param budgetTokens  Optional per-segment token budget. When provided and
 *              estimatedTokens exceeds it, `overBudget: true` is set.
 */
export function hashPromptSegment(
  text: string | undefined,
  budgetTokens?: number
): PromptSegmentHash {
  if (!text) {
    return { sha256: '', byteLength: 0, estimatedTokens: 0, missing: true };
  }

  const sha256 = createHash('sha256')
    .update(text, 'utf8')
    .digest('hex')
    .slice(0, DIGEST_ID_LENGTH);

  const byteLength = Buffer.byteLength(text, 'utf8');
  const estimatedTokens = Math.ceil(byteLength / TOKEN_ESTIMATE_DIVISOR);

  const result: PromptSegmentHash = { sha256, byteLength, estimatedTokens };
  if (budgetTokens !== undefined && estimatedTokens > budgetTokens) {
    (result as any).overBudget = true;
  }
  return result;
}

/**
 * Admit the Pi base system prompt before worker token spend.
 *
 * Computes stable hashes and token estimates for the four prompt segments:
 *   1. Orr Else stable block
 *   2. Pi host-supplied base system prompt (event.systemPrompt)
 *   3. Volatile suffix (beadId, workdir, checklist, etc.)
 *   4. Final assembled prompt (1 + 2 + 3 as assembled in BEFORE_AGENT_START)
 *
 * The assembled order matches extension.ts:
 *   stableBlock + "\n\n" + piBase + "\n\n" + volatileSuffix
 *   (piBase omitted when absent)
 *
 * INVARIANT: no prompt body ever appears in the returned object.
 * Only hashes, byte sizes, token estimates, and rule codes are returned.
 *
 * @param inputs.stableBlock      The Orr Else stable bootstrap block text.
 * @param inputs.piBasePrompt     The Pi host base system prompt (event.systemPrompt),
 *                                or undefined/empty when absent.
 * @param inputs.volatileSuffix   The volatile run-context suffix (beadId, workdir, etc.).
 */
export function admitPiBasePrompt(inputs: {
  stableBlock: string;
  piBasePrompt: string | undefined;
  volatileSuffix: string;
}): PiBasePromptAdmission {
  const { stableBlock, piBasePrompt, volatileSuffix } = inputs;

  // Hash each segment — texts are discarded after hashing.
  const stableBlockHash = hashPromptSegment(stableBlock);
  const piBasePromptHash = hashPromptSegment(piBasePrompt, PI_BASE_PROMPT_TOKEN_BUDGET);
  const volatileSuffixHash = hashPromptSegment(volatileSuffix);

  // Assemble the final prompt exactly as BEFORE_AGENT_START does, then hash it.
  // Prompt text is discarded after hashing — only the hash is kept.
  const finalText = piBasePrompt
    ? `${stableBlock}\n\n${piBasePrompt}\n\n${volatileSuffix}`
    : `${stableBlock}\n\n${volatileSuffix}`;
  const finalPromptHash = hashPromptSegment(finalText);

  // Determine admission rule code and allowed flag.
  let ruleCode: PiBasePromptRuleCode;
  if (piBasePromptHash.missing) {
    ruleCode = PiBasePromptRuleCode.MISSING;
  } else if (piBasePromptHash.overBudget) {
    ruleCode = PiBasePromptRuleCode.OVER_BUDGET;
  } else {
    ruleCode = PiBasePromptRuleCode.ADMITTED;
  }

  // OVER_BUDGET is a real incompatibility: the Pi base prompt exceeds the cost
  // envelope, so `allowed` is false.  MISSING and ADMITTED are both permitted.
  const allowed = ruleCode !== PiBasePromptRuleCode.OVER_BUDGET;

  return {
    stableBlockHash,
    piBasePromptHash,
    volatileSuffixHash,
    finalPromptHash,
    allowed,
    ruleCode,
  };
}
