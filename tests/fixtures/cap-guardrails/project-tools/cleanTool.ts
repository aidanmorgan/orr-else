// In-repo fixture: a CLEAN project-tool source file.
//
// Read as TEXT by the cap-knob grep guard (scanFileForForbiddenTerms). It must
// contain ZERO forbidden cap-preview identifiers in production code so the guard
// reports zero violations — proving the guard accepts compliant project tools.
//
// NOTE: This file is intentionally NOT type-checked (tsconfig excludes tests/) and
// is never imported; it exists purely as scan input.

export interface CleanToolResult {
  // Raw output is persisted to files; the model receives references + byte counts.
  stdoutFile: string;
  stdoutBytes: number;
  stderrFile: string;
  stderrBytes: number;
  // Tool-owned compact summary (allowed name).
  compactSummary: string;
}

export function buildCleanToolResult(stdoutFile: string, bytes: number): CleanToolResult {
  return {
    stdoutFile,
    stdoutBytes: bytes,
    stderrFile: stdoutFile + '.err',
    stderrBytes: 0,
    compactSummary: 'ok'
  };
}
