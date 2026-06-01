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

// ---------------------------------------------------------------------------
// Scan cap — limits how many representative lines we capture per category
// ---------------------------------------------------------------------------

/**
 * Maximum number of representative lines stored per category in the scan
 * result.  Keeps the output strictly bounded regardless of transcript size.
 */
export const SCAN_MAX_REPRESENTATIVE_LINES = 3;

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
