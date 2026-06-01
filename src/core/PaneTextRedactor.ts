/**
 * PaneTextRedactor — strips model-thinking / reasoning blocks from raw tmux
 * capture-pane output BEFORE it is stored in operator-facing monitoring
 * artifacts or used by hidden-pane scans.
 *
 * Design constraints
 * ------------------
 * - Conservative: only strips lines that are unambiguously reasoning text.
 *   Any line that looks like a command, tool call, bead/state ID, error, or
 *   status line is preserved unconditionally.
 * - Pattern-based (no LLM calls): zero model-token impact.
 * - No agent self-policing: operates entirely in the operator's monitoring
 *   path, never on the model's input.
 * - Block-aware: once a reasoning block opens it absorbs lines until a
 *   matching close marker or a hard-actionable line interrupts.
 */

// ---------------------------------------------------------------------------
// ANSI / control-escape stripping
// ---------------------------------------------------------------------------

/**
 * Matches ANSI CSI sequences (ESC [ … m/K/J/H/A/B/C/D/…), OSC sequences
 * (ESC ] … BEL/ST), lone ESC characters, and other common terminal control
 * sequences emitted by tmux pane output.  Conservative: does NOT strip
 * printable characters — only the escape payload.
 *
 * Covers:
 *   - CSI:  ESC [ <param bytes> <intermediate bytes> <final byte>
 *   - OSC:  ESC ] <text> BEL  or  ESC ] <text> ESC \
 *   - SGR:  ESC [ … m  (subset of CSI, already covered)
 *   - bare ESC followed by a single non-[ character (e.g. ESC c, ESC 7/8)
 */
export const ANSI_ESCAPE_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\x1b(?:\[[0-9;?]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[^[\]])/g;

/**
 * Strip ANSI and terminal control-escape sequences from a raw string.
 * Returns plain text suitable for pattern matching and log storage.
 *
 * This is applied BEFORE reasoning redaction so that escape codes in pane
 * output never cause reasoning-block patterns to miss their targets.
 */
export function stripAnsiEscapes(raw: string): string {
  return raw.replace(ANSI_ESCAPE_PATTERN, '');
}

// ---------------------------------------------------------------------------
// Named pattern constants (single source of truth)
// ---------------------------------------------------------------------------

/**
 * Patterns that mark the start of a model-thinking / reasoning block as it
 * appears in tmux pane output.  These typically come from Claude / Pi's
 * "<thinking>" XML rendering or from the Pi CLI's "[thinking]" label.
 *
 * Conservative: only the clearly-delimited forms are matched so that
 * incidental prose that happens to contain "thinking" is never stripped.
 */
export const REASONING_BLOCK_OPEN_PATTERNS: readonly RegExp[] = [
  /^<thinking>\s*$/i,                      // bare XML open tag on its own line
  /^\[thinking\]\s*$/i,                   // Pi CLI "[thinking]" label line
  /^```thinking\s*$/i,                    // fenced code block labelled "thinking"
  /^```reasoning\s*$/i,                   // fenced code block labelled "reasoning"
  /^<reasoning>\s*$/i,                    // bare XML reasoning open tag
];

/**
 * Patterns that close a reasoning block that was opened by
 * REASONING_BLOCK_OPEN_PATTERNS.
 */
export const REASONING_BLOCK_CLOSE_PATTERNS: readonly RegExp[] = [
  /^<\/antml:thinking>\s*$/i,
  /^```\s*$/,                             // generic fenced-block close
  /^<\/reasoning>\s*$/i,
];

/**
 * Single-line patterns for self-contained reasoning sentences that frequently
 * appear as standalone lines in pane output.  Only matches lines that:
 *   - begin with a known reasoning verb phrase, AND
 *   - do NOT contain tool markers, bead/state IDs, or error keywords.
 *
 * These are deliberately narrow — false-positive suppression of an actionable
 * line is far worse than leaking a reasoning line.
 */
export const REASONING_STANDALONE_LINE_PATTERNS: readonly RegExp[] = [
  /^(Updating the plan|Considering|Clarifying|Reflecting|Rethinking|Let me think|I need to think|Thinking through|Working through)\b.*$/i,
];

/**
 * Patterns for lines that are ALWAYS preserved regardless of redaction state.
 * These anchor the "actionable" definition: tool names, error keywords, bead
 * IDs (pi-experiment-XXXX form), state IDs, JSON objects/arrays, commands.
 */
export const ACTIONABLE_LINE_PRESERVE_PATTERNS: readonly RegExp[] = [
  /tool[_\s](?:call|use|result|name)[:=\s]/i,  // tool_call / tool_use / tool_result
  /^\s*"?(?:name|type|id)"?\s*[:=]/i,           // JSON-like key lines
  /\berror\b/i,                                  // any line with "error"
  /\bfailed?\b/i,                                // "fail" / "failed"
  /\bexception\b/i,
  /pi-[a-z0-9]+-[a-z0-9]+/i,                    // bead ID pattern (e.g. pi-experiment-kwrf)
  /\bstateId\b|\bbeadId\b|\bstate_id\b|\bbead_id\b/i,
  /^\s*\{/,                                      // JSON object start
  /^\s*\[[\s\S]*?["{0-9\-\[{]/,                 // JSON array (first elem is string, num, or nested)
  /^\s*\$/,                                      // shell prompt / command
  /^\s*>/,                                       // shell continuation
  /\btool\b.*\(/i,                               // tool invocation
];

// Replacement token inserted in place of redacted blocks/lines so that
// monitoring consumers know redaction occurred.
export const REDACTED_BLOCK_PLACEHOLDER = '[reasoning redacted]';

// ---------------------------------------------------------------------------
// Core redaction logic
// ---------------------------------------------------------------------------

function isActionableLine(line: string): boolean {
  return ACTIONABLE_LINE_PRESERVE_PATTERNS.some(pattern => pattern.test(line));
}

function isReasoningBlockOpen(line: string): boolean {
  return REASONING_BLOCK_OPEN_PATTERNS.some(pattern => pattern.test(line));
}

function isReasoningBlockClose(line: string): boolean {
  return REASONING_BLOCK_CLOSE_PATTERNS.some(pattern => pattern.test(line));
}

function isStandaloneReasoningLine(line: string): boolean {
  return REASONING_STANDALONE_LINE_PATTERNS.some(pattern => pattern.test(line));
}

/**
 * Redact model-thinking/reasoning blocks from a raw tmux capture-pane string.
 *
 * Algorithm:
 * 0. Strip ANSI/control-escape sequences so that patterns match clean text.
 * 1. Split into lines.
 * 2. Track whether we are inside an open reasoning block.
 * 3. A block opens on a REASONING_BLOCK_OPEN_PATTERNS match (if the line is
 *    not also an actionable line — safety guard).
 * 4. Inside a block, every line is suppressed UNLESS it matches
 *    ACTIONABLE_LINE_PRESERVE_PATTERNS, at which point the block is closed
 *    and the line is emitted.
 * 5. A block closes on a REASONING_BLOCK_CLOSE_PATTERNS match.
 * 6. Outside a block, REASONING_STANDALONE_LINE_PATTERNS lines are
 *    suppressed if they are not also actionable.
 * 7. When one or more consecutive lines are suppressed a single
 *    REDACTED_BLOCK_PLACEHOLDER is inserted in their place.
 *
 * Returns the redacted string (trailing newline preserved if the input had one).
 */
export function redactPaneText(raw: string): string {
  if (!raw) return raw;

  // Strip ANSI escape sequences before any pattern matching.
  raw = stripAnsiEscapes(raw);

  const trailingNewline = raw.endsWith('\n');
  const lines = raw.split('\n');
  // Drop the synthetic empty element caused by a trailing newline.
  if (trailingNewline && lines[lines.length - 1] === '') lines.pop();

  const output: string[] = [];
  let inReasoningBlock = false;
  let pendingRedact = false;   // true when we have suppressed ≥1 line since last placeholder

  function flushRedacted() {
    if (pendingRedact) {
      output.push(REDACTED_BLOCK_PLACEHOLDER);
      pendingRedact = false;
    }
  }

  for (const line of lines) {
    if (inReasoningBlock) {
      // Hard-actionable line: close the block and emit.
      if (isActionableLine(line)) {
        inReasoningBlock = false;
        flushRedacted();
        output.push(line);
        continue;
      }
      // Close marker: close the block, emit a placeholder for the suppressed
      // block content (not the close marker itself).
      if (isReasoningBlockClose(line)) {
        inReasoningBlock = false;
        flushRedacted();
        continue;
      }
      // Still inside block — suppress.
      pendingRedact = true;
      continue;
    }

    // Outside a block: check for block open.
    if (!isActionableLine(line) && isReasoningBlockOpen(line)) {
      inReasoningBlock = true;
      pendingRedact = true;     // The open marker itself is suppressed.
      continue;
    }

    // Outside a block: check for standalone reasoning line.
    if (!isActionableLine(line) && isStandaloneReasoningLine(line)) {
      pendingRedact = true;
      continue;
    }

    // Ordinary line: flush any pending redaction marker, then emit.
    flushRedacted();
    output.push(line);
  }

  // Flush any trailing redacted block.
  flushRedacted();

  const joined = output.join('\n');
  return trailingNewline ? joined + '\n' : joined;
}
