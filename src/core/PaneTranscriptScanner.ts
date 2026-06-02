/**
 * PaneTranscriptScanner — classifies cleaned pane-transcript text into
 * structured operator-facing issue categories without touching model inputs.
 *
 * Design constraints
 * ------------------
 * - Conservative: only clear signals trigger a category hit.  False-negative
 *   (missing a real issue) is preferred over false-positive (noisy alerts).
 * - Named pattern constants: all regex are exported top-level constants so
 *   they can be audited and tested independently.
 * - Bounded output: result object holds counts + one representative line per
 *   category — no full transcript dumps in the return value.
 * - Zero model-token impact: pure pattern matching, operator-side only.
 */

// ---------------------------------------------------------------------------
// Issue categories
// ---------------------------------------------------------------------------

export const ScanCategory = {
  /** Provider-side API / rate-limit / auth errors. */
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  /** Harness protocol contract violations (unexpected event/transition). */
  PROTOCOL_VIOLATION: 'PROTOCOL_VIOLATION',
  /** ENOENT / file-not-found errors in tool output or shell. */
  ENOENT: 'ENOENT',
  /** Agent appears stuck waiting for user input or confirmation. */
  STUCK_PROMPT: 'STUCK_PROMPT',
  /** Panic, fatal crash, or process-level abort messages. */
  PANIC_FATAL: 'PANIC_FATAL',
} as const;

export type ScanCategory = typeof ScanCategory[keyof typeof ScanCategory];

// ---------------------------------------------------------------------------
// Named pattern constants — one per category (single source of truth)
// ---------------------------------------------------------------------------

/**
 * Provider-side errors: rate limits, quota exhaustion, auth failures, API
 * server errors, connection resets from the provider endpoint.
 *
 * Conservative: only match clear provider-originated signals.  Generic
 * "error" lines are NOT included here — those appear in other categories.
 */
export const PROVIDER_ERROR_PATTERNS: readonly RegExp[] = [
  /\brate[_\s-]?limit(?:ed)?\b/i,
  /\bquota[_\s]?exceed(?:ed)?\b/i,
  /\b(?:401|403|429|5[0-9]{2})\b.*\b(?:error|fail|unauthorized|forbidden|too many)\b/i,
  /\bapi[_\s]?(?:key|auth(?:orization)?)\s+(?:invalid|expired|missing|fail(?:ed)?)\b/i,
  /\bprovider\s+(?:error|fail(?:ed)?|unreachable|timeout)\b/i,
  /\bconnection\s+reset\s+by\s+peer\b/i,
  /\bECONNRESET\b/,
  /\bservice\s+unavailable\b/i,
  /\banthropic(?:\.com)?\s+(?:error|fail|5\d\d)\b/i,
  /\bopenai(?:\.com)?\s+(?:error|fail|5\d\d)\b/i,
];

/**
 * Protocol-violation markers: harness contract failures, unexpected
 * event/state transitions, schema validation errors, and handover failures.
 */
export const PROTOCOL_VIOLATION_PATTERNS: readonly RegExp[] = [
  /\bprotocol\s+(?:error|violation|mismatch|fail)\b/i,
  /\bunexpected\s+(?:event|transition|state|message|type)\b/i,
  /\bschema\s+(?:validation|error|fail)\b/i,
  /\bhandover\s+(?:fail(?:ed)?|invalid|missing)\b/i,
  /\bmalformed\s+(?:event|response|message|json)\b/i,
  /\binvalid\s+(?:state\s+id|bead\s+id|transition)\b/i,
  /\bcontract\s+(?:violation|fail(?:ed)?)\b/i,
  /\bTeammateEvent\s+decode\s+fail(?:ed)?\b/i,
];

/**
 * ENOENT / file-not-found errors as emitted by Node.js, shell commands, and
 * tool outputs.  Narrow to avoid matching "no" in prose.
 */
export const ENOENT_PATTERNS: readonly RegExp[] = [
  /\bENOENT\b/,
  /\bno such file or directory\b/i,
  /\bfile not found\b/i,
  /\bpath not found\b/i,
  /\bcannot find\s+(?:file|module|path)\b/i,
  /\bmodule not found\b/i,
];

/**
 * Stuck-prompt indicators: the agent/process is waiting for interactive input
 * that will never arrive in unattended mode.
 */
export const STUCK_PROMPT_PATTERNS: readonly RegExp[] = [
  /\bPress\s+(?:Enter|any\s+key)\s+to\s+continue\b/i,
  /\bWaiting\s+for\s+(?:input|confirmation|approval|user)\b/i,
  /\bAre you sure\b.*\?\s*$/i,
  /\bconfirm\s+(?:yes\/no|y\/n|proceed)\b/i,
  /\[y\/n\]\s*(?::\s*)?$/i,
  /\[yes\/no\]\s*(?::\s*)?$/i,
  /\bpassword\s*:\s*$/i,
  /\benter\s+(?:your\s+)?(?:password|passphrase|token|key)\b.*:\s*$/i,
  /\(y\/n\)\s*(?::\s*)?$/i,
];

/**
 * Panic and fatal crash signals emitted by Node.js, Rust programs,
 * Go runtimes, and shell-level aborts.
 *
 * These use word-boundary (\b) anchors so they catch crashes embedded anywhere
 * in a line — appropriate for the general scanPaneTranscript path which collects
 * representative evidence lines across the full transcript.
 *
 * NOTE: do NOT use this set directly in detectFinalBlockedState.  Instead use
 * FINAL_BLOCKED_PANIC_FATAL_PATTERNS, which re-anchors the process-level entries
 * to the start of the (trimmed) line so that mid-line occurrences in git-log
 * output or agent narration prose cannot cause false-positive blocked kills.
 */
export const PANIC_FATAL_PATTERNS: readonly RegExp[] = [
  /\bpanic(?:ked|king)?\b/i,
  /\bfatal\s+(?:error|exception|signal|crash)\b/i,
  /\bsegmentation\s+fault\b/i,
  /\bcore\s+dump(?:ed)?\b/i,
  /\bprocess\s+(?:killed|aborted|crashed)\b/i,
  /\bkill(?:ed)?\s+signal\b/i,
  /\bUnhandledPromiseRejectionWarning\b/,
  /\bUnhandledPromiseRejection\b/,
  /\bprocess\.exit\s*\(\s*[1-9]\d*\s*\)/,
  /\babort(?:ed)?\s*\(\s*(?:core\s+dump(?:ed)?)?\s*\)/i,
];

/**
 * Line-anchored variant of PANIC_FATAL_PATTERNS for exclusive use in
 * detectFinalBlockedState.
 *
 * The process-termination entries from PANIC_FATAL_PATTERNS that use \b (and
 * therefore match mid-line) are replaced with ^ (line-start) anchored versions.
 * This ensures a final transcript line like
 *   "a1b2c3 fix: handle process killed edge case in teardown"
 * (a git-log tail) does NOT trigger blocked=true even when it is the absolute
 * last line of the pane, because "process killed" is mid-line — not a leading
 * OS kill banner.
 *
 * All other patterns (panic, fatal error, segfault, etc.) are retained as-is
 * because they are unambiguous even mid-line, and the risk of prose false-
 * positives for those patterns is negligible.
 *
 * The general PANIC_FATAL_PATTERNS remain unchanged so scanPaneTranscript can
 * still detect crashes embedded anywhere in a line.
 */
export const FINAL_BLOCKED_PANIC_FATAL_PATTERNS: readonly RegExp[] = [
  /\bpanic(?:ked|king)?\b/i,
  /\bfatal\s+(?:error|exception|signal|crash)\b/i,
  /\bsegmentation\s+fault\b/i,
  /\bcore\s+dump(?:ed)?\b/i,
  // Line-anchored: only match when "process killed/aborted/crashed" leads the line.
  /^process\s+(?:killed|aborted|crashed)\b/i,
  // Line-anchored: "killed signal" / "kill signal" at line start.
  /^kill(?:ed)?\s+signal\b/i,
  /\bUnhandledPromiseRejectionWarning\b/,
  /\bUnhandledPromiseRejection\b/,
  /\bprocess\.exit\s*\(\s*[1-9]\d*\s*\)/,
  /\babort(?:ed)?\s*\(\s*(?:core\s+dump(?:ed)?)?\s*\)/i,
];

// ---------------------------------------------------------------------------
// Scan cap — limits how many representative lines we capture per category
// ---------------------------------------------------------------------------

/**
 * Maximum number of representative lines stored per category in the scan
 * result.  Keeps the output strictly bounded regardless of transcript size.
 */
export const SCAN_MAX_REPRESENTATIVE_LINES = 3;

// ---------------------------------------------------------------------------
// Final-blocked detection — tail-window constants and patterns
// ---------------------------------------------------------------------------

/**
 * Number of non-empty lines taken from the END of the pane transcript to form
 * the "tail window" for final-blocked detection.  An error that appears in this
 * window and is NOT followed by any non-error progress line is treated as the
 * agent's FINAL output state.
 *
 * Rationale: a typical terminal-blocked banner is 1-5 lines. 20 lines gives
 * generous headroom for multi-line banners while still distinguishing "error
 * deep in a long run" (not final-blocked) from "error at the very end".
 */
export const SCAN_FINAL_TAIL_LINES = 20;

/**
 * Maximum number of characters from a single evidence line included in the
 * detectFinalBlockedState result.  Kept small so log payloads stay bounded.
 */
export const SCAN_EVIDENCE_MAX_CHARS = 200;

/**
 * Terminal-blocked banner patterns — signals that indicate the pane has reached
 * a hard stop and will not make further progress without external intervention.
 *
 * Design: HIGH-CONFIDENCE and specific.  Only patterns that unambiguously
 * indicate a FINAL blocked/halted state are included — this branch KILLS the
 * bead, so false-positives are unacceptable.  Prefer false-negative (miss a
 * real block) over false-positive (kill a healthy agent).
 *
 * Patterns retained here must satisfy at least one of:
 *   (a) STUCK_PROMPT signal (interactive-input prompt, always terminal).
 *   (b) Hard process-termination banner from the OS/runtime.
 *   (c) Line-ANCHORED fatal banner that cannot appear in agent narration prose.
 *
 * Prose-prone generic patterns ("cannot", "awaiting user", bare "failed") have
 * been DROPPED — an agent narrating "I see the command failed, let me
 * investigate" must NOT be killed.
 *
 * These are evaluated against the TAIL of the pane (last SCAN_FINAL_TAIL_LINES
 * non-empty lines) to distinguish "error appeared mid-run then recovered" from
 * "error is the last thing on the pane".
 */

/** Explicit blocked/halted label banners — line-anchored so prose cannot match. */
export const FINAL_BLOCKED_LABEL_PATTERNS: readonly RegExp[] = [
  /^blocked\s*:/i,
  /^halted\s*:/i,
];

/**
 * Hard process-termination banners from the OS/runtime — line-anchored variant
 * for use in the final-blocked tail scan.
 *
 * These patterns require the phrase to begin at the START of the (trimmed) line.
 * This prevents mid-line occurrences such as git-log commit messages
 * ("a1b2c3 fix: handle process killed edge case") or log-reader output
 * ("2026-01-01 worker exited with code 1") from being misclassified as a
 * terminal OS kill/exit banner.
 *
 * The general PANIC_FATAL_PATTERNS (used by scanPaneTranscript) are intentionally
 * kept with \b anchors so they can detect crashes embedded anywhere in a line —
 * the final-blocked decision is the only context where false-positives are
 * unacceptable (it kills the bead).
 */
export const FINAL_BLOCKED_PROCESS_PATTERNS: readonly RegExp[] = [
  /^process\s+(?:exited|terminated|killed)\b/i,
  /^(?:process\s+)?(?:exited|terminated)\s+with\s+(?:code|signal)\s+\S/i,
];

/** Line-anchored fatal/tool-fail banners that cannot appear in agent narration. */
export const FINAL_BLOCKED_BANNER_PATTERNS: readonly RegExp[] = [
  // "error:" at the very start of a line — identical anchoring to the scan category
  /^error:\s+\S/i,
  // "command failed" / "build failed" / "task failed" / "job failed" at line start
  /^(?:command|build|task|job)\s+failed\b/i,
  // Agent tool-call hard fail: "Tool call failed:" banner at line start
  /^tool\s+call\s+failed\b/i,
];

/** Combined set exported for external reference / testing. */
export const FINAL_BLOCKED_PATTERNS: readonly RegExp[] = [
  ...FINAL_BLOCKED_LABEL_PATTERNS,
  ...FINAL_BLOCKED_PROCESS_PATTERNS,
  ...FINAL_BLOCKED_BANNER_PATTERNS,
];

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface CategoryScanResult {
  count: number;
  /** Up to SCAN_MAX_REPRESENTATIVE_LINES matching lines (not the full text). */
  representativeLines: string[];
}

export type PaneTranscriptScanResult = {
  [K in ScanCategory]: CategoryScanResult;
};

/** True when any category has count > 0. */
export function hasScanFindings(result: PaneTranscriptScanResult): boolean {
  return Object.values(result).some((cat) => cat.count > 0);
}

/**
 * Produce a compact human-readable summary of a scan result.
 * Only includes categories with at least one hit.
 * Never exceeds a fixed line count — safe for log lines and event payloads.
 */
export function formatScanSummary(result: PaneTranscriptScanResult): string {
  const parts: string[] = [];
  for (const [category, catResult] of Object.entries(result) as [ScanCategory, CategoryScanResult][]) {
    if (catResult.count === 0) continue;
    const lines = catResult.representativeLines.map((l) => `  ${l.trim()}`).join('\n');
    parts.push(`${category}(${catResult.count}):\n${lines}`);
  }
  return parts.length === 0 ? '(no issues detected)' : parts.join('\n');
}

// ---------------------------------------------------------------------------
// Core scan function
// ---------------------------------------------------------------------------

const CATEGORY_PATTERNS: readonly { category: ScanCategory; patterns: readonly RegExp[] }[] = [
  { category: ScanCategory.PROVIDER_ERROR,      patterns: PROVIDER_ERROR_PATTERNS },
  { category: ScanCategory.PROTOCOL_VIOLATION,  patterns: PROTOCOL_VIOLATION_PATTERNS },
  { category: ScanCategory.ENOENT,              patterns: ENOENT_PATTERNS },
  { category: ScanCategory.STUCK_PROMPT,        patterns: STUCK_PROMPT_PATTERNS },
  { category: ScanCategory.PANIC_FATAL,         patterns: PANIC_FATAL_PATTERNS },
] as const;

// ---------------------------------------------------------------------------
// Final-blocked detection
// ---------------------------------------------------------------------------

/** Combined set of all patterns that constitute a blocked/fatal signal for
 * the purposes of final-blocked tail-window detection.  Includes both the
 * dedicated FINAL_BLOCKED_PATTERNS and all FINAL_BLOCKED_PANIC_FATAL / STUCK_PROMPT
 * patterns (which are always terminal-state signals when they appear as the last output).
 *
 * Uses FINAL_BLOCKED_PANIC_FATAL_PATTERNS (line-anchored process entries) rather than
 * PANIC_FATAL_PATTERNS so that mid-line "process killed" occurrences in git-log
 * tails do not suppress the "progress-after-match" test for an otherwise-healthy pane. */
const FINAL_BLOCKED_ALL_PATTERNS: readonly RegExp[] = [
  ...FINAL_BLOCKED_PATTERNS,
  ...FINAL_BLOCKED_PANIC_FATAL_PATTERNS,
  ...STUCK_PROMPT_PATTERNS,
];

/** Result type returned by detectFinalBlockedState. */
export interface FinalBlockedStateResult {
  /** True when the pane's final output is a terminal-blocked banner. */
  blocked: boolean;
  /**
   * The ScanCategory that produced the LAST (decisive) match, if any.
   * STUCK_PROMPT / PANIC_FATAL matches are mapped to their own categories.
   * FINAL_BLOCKED_PATTERNS matches map to PANIC_FATAL (nearest existing category)
   * unless the matching pattern is already covered by a more specific category.
   */
  category?: ScanCategory;
  /** The LAST (decisive) matching evidence line from the tail window, truncated
   *  to SCAN_EVIDENCE_MAX_CHARS. */
  evidenceLine?: string;
}

/**
 * Examine the TAIL of a pane transcript (last SCAN_FINAL_TAIL_LINES non-empty
 * lines) and report whether the final meaningful output is a terminal-blocked
 * banner.
 *
 * Distinguishes "error appeared somewhere mid-run then recovered" (NOT
 * final-blocked — subsequent non-matching lines follow the error) from "error
 * is the last meaningful output on the pane" (final-blocked — no non-matching
 * progress lines follow it in the tail window).
 *
 * Algorithm:
 *   1. Extract the last SCAN_FINAL_TAIL_LINES non-empty lines (the tail window).
 *   2. Scan the tail window in order.  Track whether ANY line in the window
 *      matches a blocked/fatal pattern, and whether any NON-matching line
 *      appears AFTER the last matching line.
 *   3. If the last matching line in the window is followed by at least one
 *      non-matching non-empty line → NOT final-blocked (agent recovered/continued).
 *   4. If the last matching line in the window is the LAST matching occurrence
 *      and nothing non-matching follows it → final-blocked.
 *
 * @param text - Cleaned transcript text (ANSI-stripped, reasoning-redacted).
 * @returns FinalBlockedStateResult with blocked=false when no terminal signal
 *          is detected in the tail, or blocked=true with category + evidenceLine.
 */
export function detectFinalBlockedState(text: string): FinalBlockedStateResult {
  if (!text) return { blocked: false };

  // Extract non-empty lines from the full transcript, then take the tail window.
  const nonEmptyLines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const tailWindow = nonEmptyLines.slice(-SCAN_FINAL_TAIL_LINES);

  if (tailWindow.length === 0) return { blocked: false };

  // Scan the tail window to find the LAST match index and that match's details.
  // Returning the LAST (decisive) match line + category gives the most actionable
  // evidence — it is the output that actually caused the block.
  let lastMatchIndex = -1;
  let lastMatchLine: string | undefined;
  let lastMatchCategory: ScanCategory | undefined;

  for (let i = 0; i < tailWindow.length; i++) {
    const line = tailWindow[i]!;
    // Check STUCK_PROMPT first (highest specificity for prompt-stuck signals)
    if (STUCK_PROMPT_PATTERNS.some(p => p.test(line))) {
      lastMatchIndex = i;
      lastMatchLine = line;
      lastMatchCategory = ScanCategory.STUCK_PROMPT;
      continue;
    }
    // Check PANIC_FATAL (using the line-anchored final-blocked variant so that
    // mid-line "process killed" in git-log tails cannot trigger a false positive)
    if (FINAL_BLOCKED_PANIC_FATAL_PATTERNS.some(p => p.test(line))) {
      lastMatchIndex = i;
      lastMatchLine = line;
      lastMatchCategory = ScanCategory.PANIC_FATAL;
      continue;
    }
    // Check FINAL_BLOCKED_PATTERNS
    if (FINAL_BLOCKED_PATTERNS.some(p => p.test(line))) {
      lastMatchIndex = i;
      lastMatchLine = line;
      lastMatchCategory = ScanCategory.PANIC_FATAL;
      continue;
    }
  }

  // No match in tail window → not final-blocked.
  if (lastMatchIndex < 0 || lastMatchLine === undefined) return { blocked: false };

  // Check whether any non-matching non-empty line follows the last match.
  // If so, the agent made progress after the error → not final-blocked.
  const linesAfterLastMatch = tailWindow.slice(lastMatchIndex + 1);
  const hasProgressAfterMatch = linesAfterLastMatch.some(line => {
    // A line counts as "progress" only if it does NOT itself match any blocked pattern.
    return !FINAL_BLOCKED_ALL_PATTERNS.some(p => p.test(line));
  });

  if (hasProgressAfterMatch) return { blocked: false };

  // Final-blocked: the last meaningful output is a terminal banner.
  // Return evidence from the LAST (decisive) match, truncated to the named cap.
  const evidenceLine = lastMatchLine.length > SCAN_EVIDENCE_MAX_CHARS
    ? lastMatchLine.slice(0, SCAN_EVIDENCE_MAX_CHARS - 3) + '...'
    : lastMatchLine;

  return {
    blocked: true,
    category: lastMatchCategory,
    evidenceLine
  };
}

// ---------------------------------------------------------------------------
// Core scan function
// ---------------------------------------------------------------------------

/**
 * Scan a cleaned (ANSI-stripped + reasoning-redacted) pane transcript for
 * operator-facing issue categories.
 *
 * @param text - Cleaned transcript text (as returned by capturePaneText).
 * @returns Structured scan result: one entry per category with a hit count
 *          and up to SCAN_MAX_REPRESENTATIVE_LINES representative lines.
 *          Categories with no hits have count=0 and empty representativeLines.
 */
export function scanPaneTranscript(text: string): PaneTranscriptScanResult {
  const result = Object.fromEntries(
    Object.values(ScanCategory).map((cat) => [
      cat,
      { count: 0, representativeLines: [] } as CategoryScanResult
    ])
  ) as unknown as PaneTranscriptScanResult;

  if (!text) return result;

  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    for (const { category, patterns } of CATEGORY_PATTERNS) {
      if (patterns.some((p) => p.test(trimmed))) {
        const cat = result[category];
        cat.count += 1;
        if (cat.representativeLines.length < SCAN_MAX_REPRESENTATIVE_LINES) {
          // Truncate very long lines so the summary stays bounded.
          cat.representativeLines.push(
            trimmed.length > 200 ? trimmed.slice(0, 197) + '...' : trimmed
          );
        }
      }
    }
  }

  return result;
}
