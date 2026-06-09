/**
 * Generic-identity guard: asserts that routing/identity-load modules contain
 * no inline SDLC role or state-name literals in executable code.
 *
 * This is a REGRESSION GUARD analogous to layering.test.ts.  If someone
 * re-introduces a hard-coded SDLC state name (e.g. 'Planning') or role
 * string (e.g. 'planner') into routing logic, this test fails immediately.
 *
 * Design:
 *  - Read each file under test.
 *  - Strip single-line (//) and block (/* … * /) comments and JSDoc blocks
 *    from the source so we match only executable tokens.
 *  - Regex-scan the de-commented source for the forbidden literals.
 *  - Allowlist with an explicit reason any occurrence that is genuinely
 *    acceptable (e.g. a test fixture or a default-vocabulary constant that
 *    a parallel bead owns).
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Modules under test
// ---------------------------------------------------------------------------

const rootDir = process.cwd();

/**
 * Source files whose executable code must contain none of the forbidden literals.
 * These are the routing / identity-load modules that decide which state runs and
 * which skills/rules to load.
 */
const MODULES_UNDER_TEST: string[] = [
  'src/core/FlowManager.ts',
  'src/core/Scheduler.ts',
  'src/core/BeadStateProjection.ts',
  'src/extension/CoordinatorController.ts',
  'src/extension/WorkerRunController.ts',
];

// ---------------------------------------------------------------------------
// Forbidden literals
// ---------------------------------------------------------------------------

/**
 * SDLC state-name and role-string literals that must NOT appear in executable
 * routing code.  Presence of any of these in non-comment source text implies
 * the harness is making hard-coded role/state assumptions.
 */
const FORBIDDEN_LITERALS: string[] = [
  'Planning',
  'Implementation',
  'AdversarialPreReview',
  'AdversarialPostReview',
  'planner',
  'reviewer',
  'implementer',
];

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

/**
 * Allowlisted occurrences with a mandatory reason.
 *
 * Format: { file, literal, reason }
 * `file` is relative to the project root (same form as MODULES_UNDER_TEST).
 *
 * How to add an entry:
 *   1. Identify the exact module-relative file and literal.
 *   2. Provide a clear, honest reason for the exception.
 *   3. Add a follow-on note (// TODO: …) if the exception should be removed.
 */
interface AllowlistEntry {
  file: string;
  literal: string;
  reason: string;
}

const ALLOWLIST: AllowlistEntry[] = [
  // No current allowlist entries: guard test confirms zero occurrences.
  //
  // Example of how to add an entry if a genuine use-case arises:
  // {
  //   file: 'src/core/FlowManager.ts',
  //   literal: 'Planning',
  //   reason: 'Default example in a schema-comment; not used in routing logic.',
  // },
];

// ---------------------------------------------------------------------------
// Comment-stripping
// ---------------------------------------------------------------------------

/**
 * Strip JavaScript/TypeScript comments from `source` and return the result.
 *
 * Handles:
 *  - Single-line comments:  `// …`
 *  - Block comments:        `/* … * /`  (including JSDoc `/** … * /`)
 *  - Template literals are NOT re-entered after stripping (we replace comment
 *    regions with whitespace so line numbers are preserved for diagnostics).
 *
 * This is a best-effort heuristic — it is not a full JS parser.  Its goal is
 * to prevent false positives where a forbidden word appears only in a comment
 * or JSDoc.  It intentionally preserves string literals (tool-description
 * strings are executable and should be flagged if they contain forbidden words
 * that imply built-in role semantics rather than illustrative example text).
 */
function stripComments(source: string): string {
  // Replace block comments (including JSDoc) with spaces to preserve indexing.
  let result = source.replace(/\/\*[\s\S]*?\*\//g, (match) =>
    ' '.repeat(match.length)
  );
  // Replace single-line comments with spaces up to (but not including) the newline.
  result = result.replace(/\/\/[^\n]*/g, (match) => ' '.repeat(match.length));
  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildForbiddenRegex(): RegExp {
  // Word-boundary match: prevents e.g. "planner" matching inside "explanner".
  const escaped = FORBIDDEN_LITERALS.map(
    (lit) => `\\b${lit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`
  );
  return new RegExp(escaped.join('|'), 'g');
}

interface Hit {
  file: string;
  literal: string;
  lineNumber: number;
  lineText: string;
}

function isAllowed(file: string, literal: string): boolean {
  return ALLOWLIST.some(
    (entry) => entry.file === file && entry.literal === literal
  );
}

function scanFile(relPath: string, forbiddenRe: RegExp): Hit[] {
  const absPath = path.join(rootDir, relPath);
  const source = fs.readFileSync(absPath, 'utf8');
  const stripped = stripComments(source);

  // Split original source into lines for human-readable diagnostics.
  const originalLines = source.split('\n');
  const strippedLines = stripped.split('\n');

  const hits: Hit[] = [];

  strippedLines.forEach((strippedLine, index) => {
    // Reset lastIndex before each line scan.
    forbiddenRe.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = forbiddenRe.exec(strippedLine)) !== null) {
      const literal = match[0];
      if (!isAllowed(relPath, literal)) {
        hits.push({
          file: relPath,
          literal,
          lineNumber: index + 1,
          lineText: originalLines[index].trim(),
        });
      }
    }
  });

  return hits;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('generic-identity guard — no hard-coded SDLC states/roles in routing code', () => {
  const forbiddenRe = buildForbiddenRegex();

  it('all modules under test exist on disk', () => {
    const missing = MODULES_UNDER_TEST.filter(
      (rel) => !fs.existsSync(path.join(rootDir, rel))
    );
    expect(
      missing,
      `Guard test lists modules that do not exist:\n${missing.join('\n')}\nUpdate MODULES_UNDER_TEST or the file paths.`
    ).toEqual([]);
  });

  it('routing/identity-load modules contain no inline SDLC state-name or role literals in executable code', () => {
    const allHits: Hit[] = MODULES_UNDER_TEST.flatMap((rel) =>
      scanFile(rel, forbiddenRe)
    );

    const formatted = allHits.map(
      (h) =>
        `  ${h.file}:${h.lineNumber} — "${h.literal}" in: ${h.lineText}`
    );

    expect(
      allHits,
      [
        'Found hard-coded SDLC state-name or role literals in routing/identity-load code.',
        'States and roles must come entirely from harness.yaml config — never hard-coded.',
        '',
        'Findings:',
        ...formatted,
        '',
        'To resolve:',
        '  • Remove the hard-coded literal and drive the value from config.',
        '  • If the occurrence is a comment or JSDoc, this test should not have',
        '    flagged it — check the comment-stripping logic.',
        '  • If the occurrence is genuinely unavoidable (e.g. a default-vocabulary',
        '    constant owned by a parallel bead), add it to the ALLOWLIST with a',
        '    clear reason and a follow-on TODO.',
      ].join('\n')
    ).toHaveLength(0);
  });

  it('allowlist has no stale entries (every entry matches at least one file under test)', () => {
    const stale = ALLOWLIST.filter(
      (entry) => !MODULES_UNDER_TEST.includes(entry.file)
    );
    expect(
      stale.map((e) => `${e.file} / "${e.literal}"`),
      'Allowlist references files not in MODULES_UNDER_TEST — remove or fix.'
    ).toEqual([]);
  });
});
