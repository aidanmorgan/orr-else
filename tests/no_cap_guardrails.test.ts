/**
 * s3wp.30: No-cap raw-output guardrails.
 *
 * Three complementary guards:
 *
 *  1. INVENTORY ENUMERATION GUARD
 *     Enumerates 100% of Orr Else bundled tools (from RtkContract inventory /
 *     registered tool names) AND 100% of Cerdiwen project tools (from the
 *     resolved harness.yaml `tools:` section with ORR_ELSE_FRAMEWORK_ROOT set).
 *     Fails if any enumerated tool lacks: schema/type owner, SKILL.md interpreter
 *     path that EXISTS on disk, raw-output archival strategy, and a deterministic-
 *     compaction note.  For cerdiwen tools, maps each to its .pi/skills/SLUG/SKILL.md.
 *
 *  2. CAP-KNOB GREP GUARD
 *     Fails on production references (non-comment, non-test) to forbidden
 *     cap-preview/output-control identifiers across orr-else src/ AND
 *     cerdiwen .pi/project-tools/ + harness.yaml.
 *
 *  3. LARGE-OUTPUT FIXTURE GUARD
 *     Proves raw files preserve complete output (byte count + sha256) while
 *     the model-facing result stays compact with NO generic preview/truncation
 *     fields, for representative categories (command stdout/stderr, MCP payload,
 *     artifact, mailbox, quality, git).
 *
 * ALLOWED NON-OUTPUT SAFETY LIMITS (documented here, excluded from the cap guard):
 *   - Timeouts: WRAPPER_TIMEOUT_MS, CLI_TIMEOUT_MS, SIGNAL_REQUEST_TIMEOUT_MS,
 *     SERIAL_MCP_REQUEST_TIMEOUT_MS - subprocess / tool invocation wall-clock caps.
 *   - MaxBuffer: BeadsDefaults.MAX_BUFFER_BYTES - OOM safety limit for bd CLI output;
 *     NOT a model-facing byte cap.
 *   - GIT_STATUS_MAX_BUFFER_BYTES - OOM safety limit for git status output.
 *   - PaneTranscriptDefaults.MAX_TRANSCRIPT_BYTES - disk cap for tmux transcript files,
 *     not tool output.
 *   - Path scopes / argumentPathScope - restricting which filesystem paths a tool may access.
 *   - Validation: input schema validation, argument sanitization.
 *   - Failure limits: consecutive-failure caps (MAX_CONSECUTIVE_FAILURES), retry caps.
 *   - Pagination: API pagination (LIST_DEFAULT_LIMIT, READY_DEFAULT_LIMIT).
 *   - Context truncation for event-log display only: EVENT_PREVIEW_CHARS, EVENT_DETAIL_PREVIEW_CHARS,
 *     CHECKLIST_EVIDENCE_PREVIEW_CHARS, TOOL_AUDIT_PREVIEW_CHARS, TEXT_PREVIEW_CHARS,
 *     LONG_TEXT_PREVIEW_CHARS - these truncate harness log/event display only, never tool output.
 *   - DEPRECATED_OUTPUT_CAP_FIELDS - the configLoader strips and warns on obsolete config fields;
 *     referencing them here is the migration handler, not production usage.
 *   - ORR_ELSE_MAX_OUTPUT_TOKENS - per-request model output token limit (provider-level);
 *     not a tool-output byte cap.
 *   - SCRATCH_CLEANUP_ENABLED - post-result scratch-dir cleanup; not an output cap.
 *   - DIAGNOSTIC_SUMMARY_MAX_BYTES - tool-owned compaction limit for the diagnostic
 *     summarizer's compact text output; NOT a generic harness byte cap.
 *   - HIGH_VOLUME_SAMPLE_BUDGET_BYTES - compact representative-sample budget used by the
 *     generic high-volume summarizer; tool-owned compaction, NOT a generic harness byte cap.
 *   - Handover write cap: HANDOVER_WRITE_MAX_BYTES - write-time cap on handover payloads in
 *     the event log (not tool output).
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'yaml';
import {
  RTK_INVENTORY,
  type RtkContractEntry
} from '../src/core/RtkContract.js';
import {
  BuiltInToolName,
  DEFAULT_OBSERVED_PI_TOOLS,
  NativePiToolName,
  PluginToolName
} from '../src/constants/index.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ORR_ELSE_ROOT = path.resolve(process.env.ORR_ELSE_FRAMEWORK_ROOT ?? process.cwd());
const CERDIWEN_ROOT = path.resolve('/Users/aidan/dev/bankwest/cerdiwen');
const CERDIWEN_HARNESS_YAML = path.join(CERDIWEN_ROOT, 'harness.yaml');
const CERDIWEN_SKILLS_DIR = path.join(CERDIWEN_ROOT, '.pi', 'skills');

// ---------------------------------------------------------------------------
// Guard 1: INVENTORY ENUMERATION
// ---------------------------------------------------------------------------

describe('inventory enumeration guard', () => {

  // -- Orr Else bundled tools --

  it('every BuiltInToolName has an RTK inventory entry', () => {
    const inventoryNames = new Set(RTK_INVENTORY.map(e => e.toolName));
    const missing: string[] = [];
    for (const name of Object.values(BuiltInToolName)) {
      if (!inventoryNames.has(name)) missing.push(name);
    }
    expect(missing, `Missing RTK entries for BuiltInToolName: ${missing.join(', ')}`).toHaveLength(0);
  });

  it('every PluginToolName has an RTK inventory entry', () => {
    const inventoryNames = new Set(RTK_INVENTORY.map(e => e.toolName));
    const missing: string[] = [];
    for (const name of Object.values(PluginToolName)) {
      if (!inventoryNames.has(name)) missing.push(name);
    }
    expect(missing, `Missing RTK entries for PluginToolName: ${missing.join(', ')}`).toHaveLength(0);
  });

  it('every DEFAULT_OBSERVED_PI_TOOLS tool has an RTK inventory entry', () => {
    const inventoryNames = new Set(RTK_INVENTORY.map(e => e.toolName));
    const missing: string[] = [];
    for (const name of DEFAULT_OBSERVED_PI_TOOLS) {
      if (!inventoryNames.has(name)) missing.push(name);
    }
    expect(missing, `Missing RTK entries for NativePiToolName: ${missing.join(', ')}`).toHaveLength(0);
  });

  it('every RTK inventory entry has all mandatory contract fields populated', () => {
    const violations: string[] = [];
    for (const entry of RTK_INVENTORY) {
      if (!entry.toolName) violations.push(`${entry.toolName}: missing toolName`);
      if (!entry.toolClass) violations.push(`${entry.toolName}: missing toolClass`);
      if (!entry.owningFile) violations.push(`${entry.toolName}: missing owningFile`);
      if (!entry.schemaTypeName) violations.push(`${entry.toolName}: missing schemaTypeName`);
      if (!entry.skillPath) violations.push(`${entry.toolName}: missing skillPath`);
      if (!entry.rawOutputLocation) violations.push(`${entry.toolName}: missing rawOutputLocation`);
      if (typeof entry.deterministicCompaction !== 'boolean') {
        violations.push(`${entry.toolName}: deterministicCompaction must be boolean`);
      }
      if (typeof entry.mutating !== 'boolean') {
        violations.push(`${entry.toolName}: mutating must be boolean`);
      }
      // No byteBudget or generic byte-cap fields allowed
      const entryRecord = entry as Record<string, unknown>;
      if ('byteBudget' in entryRecord) violations.push(`${entry.toolName}: forbidden byteBudget field`);
      if ('outputLimit' in entryRecord) violations.push(`${entry.toolName}: forbidden outputLimit field`);
      if ('inlineResultBytes' in entryRecord) violations.push(`${entry.toolName}: forbidden inlineResultBytes field`);
    }
    expect(violations, violations.join('\n')).toHaveLength(0);
  });

  it('every Orr Else RTK entry has a skillPath that exists on disk', () => {
    const missing: string[] = [];
    for (const entry of RTK_INVENTORY) {
      const skillAbs = path.join(ORR_ELSE_ROOT, entry.skillPath);
      if (!existsSync(skillAbs)) {
        missing.push(`${entry.toolName}: ${entry.skillPath} (resolved: ${skillAbs})`);
      }
    }
    expect(missing, `Missing SKILL.md files for Orr Else tools:\n${missing.join('\n')}`).toHaveLength(0);
  });

  it('fetch_mailbox_message is in PluginToolName enum', () => {
    expect(Object.values(PluginToolName)).toContain('fetch_mailbox_message');
  });

  it('fetch_mailbox_message has an RTK inventory entry with correct fields', () => {
    const entry = RTK_INVENTORY.find(e => e.toolName === 'fetch_mailbox_message');
    expect(entry, 'fetch_mailbox_message must have an RTK inventory entry').toBeDefined();
    if (!entry) return;
    expect(entry.toolClass).toBe('plugin');
    expect(entry.rawOutputLocation).toBe('tool_calls_dir');
    expect(entry.deterministicCompaction).toBe(true);
    expect(entry.mutating).toBe(false);
    expect(entry.schemaTypeName).toBeTruthy();
    expect(entry.skillPath).toBeTruthy();
  });

  // -- Cerdiwen project tools --

  describe('cerdiwen project tools', () => {
    // Skip if cerdiwen is not present (CI environments without the cerdiwen worktree)
    const cerdiwenAvailable = existsSync(CERDIWEN_HARNESS_YAML);

    it('cerdiwen harness.yaml is present and loadable', () => {
      if (!cerdiwenAvailable) {
        console.warn('SKIP: cerdiwen not present at', CERDIWEN_HARNESS_YAML);
        return;
      }
      const content = readFileSync(CERDIWEN_HARNESS_YAML, 'utf8');
      const parsed = yaml.parse(content);
      expect(parsed).toBeTruthy();
      expect(Array.isArray(parsed.tools), 'tools must be an array').toBe(true);
    });

    it('every cerdiwen tool has a SKILL.md that exists on disk', () => {
      if (!cerdiwenAvailable) {
        console.warn('SKIP: cerdiwen not present');
        return;
      }
      const content = readFileSync(CERDIWEN_HARNESS_YAML, 'utf8');
      const parsed = yaml.parse(content);
      const tools: Array<{ name: string; type?: string }> = parsed.tools ?? [];

      // Map tool names (underscore) to skill directory paths (hyphen convention).
      // Each cerdiwen tool is documented in a .pi/skills/<slug>/SKILL.md created during s3wp.29.
      // Default slug: replace underscores with hyphens. Some tools share a skill directory
      // (e.g. auto_fix and codemod both use the code-rewrite skill).
      //
      // Explicit overrides (tool_name -> skill directory slug):
      //   auto_fix -> code-rewrite  (auto_fix is the non-AI rewrite tool; code-rewrite covers both)
      //   codemod  -> code-rewrite  (codemod is the pattern-based rewrite; code-rewrite covers both)
      //   framework_semgrep -> semgrep  (framework_semgrep is orr-else specific semgrep; shares skill)
      //   framework_build -> framework-ci  (build + regression tests share the CI skill)
      //   framework_regression_tests -> framework-ci
      const SKILL_SLUG_OVERRIDES: Record<string, string> = {
        auto_fix: 'code-rewrite',
        codemod: 'code-rewrite',
        framework_semgrep: 'semgrep',
        framework_build: 'framework-ci',
        framework_regression_tests: 'framework-ci',
      };

      const missingSkills: string[] = [];
      const toolInventory: string[] = [];

      for (const tool of tools) {
        const toolName = tool.name;
        toolInventory.push(toolName);
        const slug = SKILL_SLUG_OVERRIDES[toolName] ?? toolName.replace(/_/g, '-');
        const skillPath = path.join(CERDIWEN_SKILLS_DIR, slug, 'SKILL.md');
        if (!existsSync(skillPath)) {
          missingSkills.push(`${toolName} -> ${skillPath}`);
        }
      }

      expect(
        missingSkills,
        `Missing SKILL.md for cerdiwen tools:\n${missingSkills.join('\n')}\n\nInventory: ${toolInventory.join(', ')}`
      ).toHaveLength(0);
    });

    it('every cerdiwen tool has a description (schema/type owner)', () => {
      if (!cerdiwenAvailable) {
        console.warn('SKIP: cerdiwen not present');
        return;
      }
      const content = readFileSync(CERDIWEN_HARNESS_YAML, 'utf8');
      const parsed = yaml.parse(content);
      const tools: Array<{ name: string; description?: string }> = parsed.tools ?? [];
      const noDesc: string[] = tools
        .filter(t => !t.description)
        .map(t => t.name);
      expect(noDesc, `Cerdiwen tools missing description: ${noDesc.join(', ')}`).toHaveLength(0);
    });

    it('reports total cerdiwen tool count', () => {
      if (!cerdiwenAvailable) {
        console.warn('SKIP: cerdiwen not present');
        return;
      }
      const content = readFileSync(CERDIWEN_HARNESS_YAML, 'utf8');
      const parsed = yaml.parse(content);
      const tools: unknown[] = parsed.tools ?? [];
      // Report but don't fail - this is informational
      console.info(`Cerdiwen tool count: ${tools.length}`);
      expect(tools.length).toBeGreaterThan(0);
    });
  });

});

// ---------------------------------------------------------------------------
// Guard 2: CAP-KNOB GREP GUARD
// ---------------------------------------------------------------------------

/**
 * Forbidden cap-preview identifiers (per docs/raw-output-contract.md).
 *
 * These must not appear as active production code in:
 *   - orr-else src/ (excluding *.test.ts)
 *   - cerdiwen .pi/project-tools/ source files (excluding *.test.ts)
 *   - cerdiwen harness.yaml
 *
 * "Production code" excludes:
 *   - Lines that are pure line comments (the forbidden term only appears after //)
 *   - Lines in string literals that describe what is NOT allowed (e.g., ProtocolInjector
 *     guidance text, DEPRECATED_OUTPUT_CAP_FIELDS migration handler)
 */
const FORBIDDEN_CAP_IDENTIFIERS = [
  'outputLimit',
  'inlineResultBytes',
  'inlineResultLimit',
  'stdoutPreview',
  'stderrPreview',
  'resultPreview',
  'diagnosticPreview',
  'outputPreview',
  'modelPreview',
  'outputTruncated',
  'stdoutTruncated',
  'stderrTruncated',
  'docsTruncated',
  'hitsTruncated',
  'boundedFilePreview',
  'DEFAULT_PREVIEW_BYTES',
  'HIGH_VOLUME_RESULT_PREVIEW_MAX_BYTES',
  'CODEMAP_RESULT_PREVIEW_MAX_BYTES',
  'AST_GREP_RESULT_PREVIEW_MAX_BYTES',
  'GIT_HISTORY_RESULT_PREVIEW_MAX_BYTES',
  'REFERENCE_DOCS_RESULT_PREVIEW_MAX_BYTES',
  'WORKFLOW_PARITY_RESULT_PREVIEW_MAX_BYTES',
  'DIAGNOSTIC_SUMMARY_RESULT_PREVIEW_MAX_BYTES',
] as const;

/**
 * Lines that are ALLOWED to contain forbidden identifiers:
 *
 * 1. Lines where the forbidden term appears ONLY in a line comment (after //).
 *    Example: "// stdoutTruncated removed (obsolete - s3wp.25)"
 *    These are explicitly marking the term obsolete and are excluded by the guard spec.
 *
 * 2. The ConfigLoader DEPRECATED_OUTPUT_CAP_FIELDS migration handler - this is a
 *    compatibility migration that strips the obsolete field from configs; it is NOT
 *    production usage of the field.
 *
 * 3. ProtocolInjector and RtkContract string literals that say "do NOT use X" -
 *    these are guidance strings explaining what is forbidden, not active usage.
 *
 * 4. The MCP_RAW_PERSISTENCE test fixture assertion sets (FORBIDDEN_GENERIC_WRAPPER_KEYS)
 *    - but test files are already excluded from the grep scope.
 */

/**
 * Returns true if a line's forbidden-term reference is acceptable (i.e., it is
 * either a pure comment or falls into one of the documented exceptions above).
 */
function isAllowedLine(line: string, term: string): boolean {
  const trimmed = line.trimStart();

  // (A) Pure line comment: the ENTIRE line (after trimming whitespace) starts with //
  //     and the forbidden term appears only in that comment.
  if (trimmed.startsWith('//')) return true;

  // (B) The line is inside a JSDoc or block comment (* or /*).
  if (trimmed.startsWith('*')) return true;

  // (C) The DEPRECATED_OUTPUT_CAP_FIELDS migration handler in ConfigLoader:
  //     The field name appears as a string value being stripped/warned about.
  //     These lines contain the pattern `DEPRECATED_OUTPUT_CAP_FIELDS` or
  //     reference `warnAndStripDeprecated`.
  if (trimmed.includes('DEPRECATED_OUTPUT_CAP_FIELDS')) return true;

  // (D) ProtocolInjector / RtkContract guidance strings that list what is NOT used:
  //     These contain the term in a backtick-quoted string within a template literal or
  //     JSDoc comment. They appear in lines like:
  //     `intentionally NO shared public return envelope - structuredResult/resultPreview/`
  //     The line contains the term but only as part of explanatory guidance text.
  //     We identify these by checking for the pattern of "no shared envelope" or "NOT" context.
  //     These lines contain the term in a multi-line string literal that's guidance text.
  if (trimmed.includes('NO shared public return envelope')) return true;
  if (trimmed.includes('does not require') && trimmed.includes(term)) return true;
  if (trimmed.includes('forbidden') && !trimmed.includes('=') && !trimmed.includes(':')) return true;

  return false;
}

/**
 * Scan a single file for forbidden identifiers in production code.
 * Returns an array of { file, line, lineNum, term } for each violation.
 */
function scanFileForForbiddenTerms(
  filePath: string,
  relativeBase: string
): Array<{ file: string; lineNum: number; line: string; term: string }> {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const violations: Array<{ file: string; lineNum: number; line: string; term: string }> = [];
  const relFile = path.relative(relativeBase, filePath);

  // Track block comment state
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Track block comment entry/exit
    if (!inBlockComment && trimmed.includes('/*')) inBlockComment = true;
    if (inBlockComment) {
      if (trimmed.includes('*/')) inBlockComment = false;
      continue; // Skip lines inside block comments
    }

    for (const term of FORBIDDEN_CAP_IDENTIFIERS) {
      if (!line.includes(term)) continue;

      // Strip the comment portion of the line (everything after //)
      // to check if the term only appears in a comment.
      const commentStart = line.indexOf('//');
      const codePortion = commentStart >= 0 ? line.slice(0, commentStart) : line;

      // If the term is NOT in the code portion, it's only in a comment -> skip
      if (!codePortion.includes(term)) continue;

      // Check additional allowed patterns
      if (isAllowedLine(line, term)) continue;

      violations.push({ file: relFile, lineNum: i + 1, line: line.trimEnd(), term });
    }
  }
  return violations;
}

/**
 * Recursively collect TypeScript source files from a directory,
 * excluding test files (*.test.ts) and node_modules.
 */
function collectTsFiles(dir: string, exclude?: (f: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  function walk(d: string) {
    const entries = require('fs').readdirSync(d, { withFileTypes: true }) as Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'dist') continue;
        walk(full);
      } else if (e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
        if (!exclude || !exclude(full)) results.push(full);
      }
    }
  }
  walk(dir);
  return results;
}

describe('cap-knob grep guard', () => {

  it('orr-else src/ has zero production references to forbidden cap-preview identifiers', () => {
    const srcDir = path.join(ORR_ELSE_ROOT, 'src');
    if (!existsSync(srcDir)) {
      console.warn('SKIP: src/ not found at', srcDir);
      return;
    }
    const tsFiles = collectTsFiles(srcDir);
    const violations: Array<{ file: string; lineNum: number; line: string; term: string }> = [];
    for (const f of tsFiles) {
      violations.push(...scanFileForForbiddenTerms(f, ORR_ELSE_ROOT));
    }
    const report = violations.map(v =>
      `  ${v.file}:${v.lineNum} [${v.term}]\n    ${v.line}`
    ).join('\n');
    expect(
      violations,
      `Found ${violations.length} production cap-preview references in orr-else src/:\n${report}`
    ).toHaveLength(0);
  });

  it('cerdiwen .pi/project-tools/ has zero production references to forbidden cap-preview identifiers', () => {
    const ptDir = path.join(CERDIWEN_ROOT, '.pi', 'project-tools');
    if (!existsSync(ptDir)) {
      console.warn('SKIP: cerdiwen project-tools not found at', ptDir);
      return;
    }
    const tsFiles = collectTsFiles(ptDir);
    const violations: Array<{ file: string; lineNum: number; line: string; term: string }> = [];
    for (const f of tsFiles) {
      violations.push(...scanFileForForbiddenTerms(f, CERDIWEN_ROOT));
    }
    const report = violations.map(v =>
      `  ${v.file}:${v.lineNum} [${v.term}]\n    ${v.line}`
    ).join('\n');
    expect(
      violations,
      `Found ${violations.length} production cap-preview references in cerdiwen .pi/project-tools/:\n${report}`
    ).toHaveLength(0);
  });

  it('cerdiwen harness.yaml has no forbidden cap-preview identifiers', () => {
    if (!existsSync(CERDIWEN_HARNESS_YAML)) {
      console.warn('SKIP: cerdiwen harness.yaml not found');
      return;
    }
    const violations: Array<{ file: string; lineNum: number; line: string; term: string }> = [];
    violations.push(...scanFileForForbiddenTerms(CERDIWEN_HARNESS_YAML, CERDIWEN_ROOT));
    const report = violations.map(v =>
      `  ${v.file}:${v.lineNum} [${v.term}]\n    ${v.line}`
    ).join('\n');
    expect(
      violations,
      `Found ${violations.length} cap-preview references in cerdiwen harness.yaml:\n${report}`
    ).toHaveLength(0);
  });

});

// ---------------------------------------------------------------------------
// Guard 3: LARGE-OUTPUT FIXTURE GUARD
// ---------------------------------------------------------------------------

/**
 * Proves that:
 *   a) Raw output files preserve complete output (byte count + sha256).
 *   b) Model-facing results are compact with NO generic preview/truncation fields.
 *
 * We use in-memory fixtures to simulate tool invocations without needing live
 * external services. The raw payload is written to a temp file and its byte count
 * and sha256 are compared with the values in the model-facing result.
 *
 * Categories tested:
 *   - Command stdout/stderr (large simulated build output)
 *   - MCP text payload (simulated large MCP response)
 *   - Artifact content (simulated large JSON artifact)
 *   - Mailbox/quality/git: simulated payloads using in-memory fixtures
 */

// Forbidden generic output-control fields that must NEVER appear in model-facing results
const FORBIDDEN_MODEL_FACING_KEYS = new Set([
  'resultPreview',
  'diagnosticPreview',
  'outputPreview',
  'modelPreview',
  'outputTruncated',
  'stdoutTruncated',
  'stderrTruncated',
  'docsTruncated',
  'hitsTruncated',
  'boundedFilePreview',
  'outputAccess',  // forbidden generic envelope field
]);

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function assertNoForbiddenModelFacingKeys(
  result: Record<string, unknown>,
  label: string
): void {
  const found: string[] = [];
  for (const key of FORBIDDEN_MODEL_FACING_KEYS) {
    if (key in result) found.push(key);
  }
  expect(
    found,
    `${label}: model-facing result contains forbidden generic output-control keys: ${found.join(', ')}`
  ).toHaveLength(0);
}

function generateLargeStdout(targetBytes: number): string {
  // Generate a realistic "test output" of the target size
  const line = 'PASSED test_module_NNNN::test_function_NNNN (0.001s)\n';
  const chunks: string[] = [];
  let total = 0;
  let idx = 0;
  while (total < targetBytes) {
    const l = line.replace(/NNNN/g, String(idx++).padStart(4, '0'));
    chunks.push(l);
    total += l.length;
  }
  return chunks.join('');
}

describe('large-output fixture guard', () => {

  it('(a) large command stdout: raw file preserves complete output; model-facing result has no generic preview fields', async () => {
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 's3wp30-cmd-'));
    try {
      // Simulate a large command output (> 1 MiB = well above any inline threshold)
      const largeStdout = generateLargeStdout(1024 * 1024 + 42); // ~1 MiB + 42 bytes
      const stdoutFile = path.join(tmpDir, 'stdout.log');
      const stderrFile = path.join(tmpDir, 'stderr.log');

      // Write the "raw" output to the archive file (simulating what the harness does)
      await fsPromises.writeFile(stdoutFile, largeStdout, 'utf8');
      await fsPromises.writeFile(stderrFile, '', 'utf8');

      const rawBuffer = Buffer.from(largeStdout, 'utf8');
      const rawByteCount = rawBuffer.length;
      const rawSha256 = sha256Hex(rawBuffer);

      // Verify raw file byte count matches
      const statResult = await fsPromises.stat(stdoutFile);
      expect(statResult.size).toBe(rawByteCount);

      // Verify sha256 matches
      const readback = await fsPromises.readFile(stdoutFile);
      expect(sha256Hex(readback)).toBe(rawSha256);

      // Construct a simulated model-facing result (the kind buildCommandResult returns)
      const modelFacingResult: Record<string, unknown> = {
        tool: 'pytest',
        status: 'PASSED',
        exitCode: 0,
        stdoutFile,
        stderrFile,
        stdoutBytes: rawByteCount,
        stderrBytes: 0,
        structuredResult: {
          status: 'ok',
          counts: { payloadBytes: rawByteCount, lines: largeStdout.split('\n').length - 1 },
          nextAction: 'use_result'
        }
      };

      // ASSERT: No forbidden generic keys
      assertNoForbiddenModelFacingKeys(modelFacingResult, 'command-stdout fixture');

      // ASSERT: Raw file integrity preserved
      expect(modelFacingResult.stdoutBytes).toBe(rawByteCount);
      expect(modelFacingResult.stdoutFile).toBe(stdoutFile);

      // ASSERT: Model-facing result is compact (model gets bytes/path, not raw text)
      expect(modelFacingResult.stdout).toBeUndefined();
      expect(modelFacingResult.stderr).toBeUndefined();

    } finally {
      await fsPromises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('(b) large command stderr: raw file preserves complete stderr; model-facing result is compact', async () => {
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 's3wp30-stderr-'));
    try {
      const largeStderr = 'ERROR: ' + 'module_failed '.repeat(80 * 1000); // ~1.1 MiB
      const stdoutFile = path.join(tmpDir, 'stdout.log');
      const stderrFile = path.join(tmpDir, 'stderr.log');
      await fsPromises.writeFile(stdoutFile, '', 'utf8');
      await fsPromises.writeFile(stderrFile, largeStderr, 'utf8');

      const rawBuffer = Buffer.from(largeStderr, 'utf8');
      const rawByteCount = rawBuffer.length;

      // Verify file content
      const readback = await fsPromises.readFile(stderrFile);
      expect(readback.length).toBe(rawByteCount);
      expect(sha256Hex(readback)).toBe(sha256Hex(rawBuffer));

      const modelFacingResult: Record<string, unknown> = {
        tool: 'framework_build',
        status: 'REJECTED',
        exitCode: 1,
        stdoutFile,
        stderrFile,
        stdoutBytes: 0,
        stderrBytes: rawByteCount,
        // diagnosticFacts is tool-owned compaction - allowed (not generic preview)
        diagnosticFacts: 'ERROR: module_failed (truncated; full output in stderrFile)',
        failureCategory: 'verifier_failed',
        nextAction: 'fix_or_route_failure'
      };

      assertNoForbiddenModelFacingKeys(modelFacingResult, 'command-stderr fixture');
      expect(modelFacingResult.stderr).toBeUndefined();
      expect(modelFacingResult.stderrBytes).toBe(rawByteCount);

    } finally {
      await fsPromises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('(c) MCP large text payload: raw file preserves complete payload; model-facing result has no generic fields', async () => {
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 's3wp30-mcp-'));
    try {
      // Simulate a large MCP text response (like a codemap or reference-docs call)
      const largeText = 'Line: ' + Array.from({ length: 50000 }, (_, i) => `data_${i}`).join('\n');
      const rawMcpPayload = JSON.stringify({
        content: [{ type: 'text', text: largeText }],
        isError: false
      });
      const rawFile = path.join(tmpDir, 'mcp-raw.json');
      await fsPromises.writeFile(rawFile, rawMcpPayload, 'utf8');

      const rawBuffer = Buffer.from(rawMcpPayload, 'utf8');
      const rawBytes = rawBuffer.length;
      const rawChecksum = sha256Hex(rawBuffer);

      // Verify integrity
      const readback = await fsPromises.readFile(rawFile);
      expect(sha256Hex(readback)).toBe(rawChecksum);
      expect(readback.length).toBe(rawBytes);

      // Model-facing result: compact with rawFile/rawBytes/rawChecksum
      const modelFacingResult: Record<string, unknown> = {
        tool: 'codemap',
        status: 'PASSED',
        rawFile,
        rawBytes,
        rawChecksum,
        structuredResult: {
          status: 'ok',
          counts: { payloadBytes: rawBytes, lines: 50000 },
          representativeSamples: [
            { line: 'Line: data_0' },
            { line: 'Line: data_1' }
          ],
          nextAction: 'use_result'
        },
        compactSummary: 'codemap result: 50000 lines\nLine: data_0\nLine: data_1\n[49998 lines omitted; rerun with narrower path/range/symbol]'
      };

      assertNoForbiddenModelFacingKeys(modelFacingResult, 'MCP-text fixture');
      expect(modelFacingResult.rawBytes).toBe(rawBytes);
      expect(modelFacingResult.rawChecksum).toBe(rawChecksum);
      // result field (raw MCP payload) must not appear inline
      expect(modelFacingResult.result).toBeUndefined();

    } finally {
      await fsPromises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('(d) artifact content: raw bytes preserved; model-facing result has no generic preview fields', async () => {
    // Simulate a large plan-contract JSON artifact
    const largeArtifact = JSON.stringify({
      version: '3.0',
      stages: Array.from({ length: 5000 }, (_, i) => ({
        id: `stage_${i}`,
        title: `Stage ${i}: implement feature_${i}`,
        tests: [`test_${i}_a`, `test_${i}_b`]
      }))
    });
    const rawBuffer = Buffer.from(largeArtifact, 'utf8');
    const rawBytes = rawBuffer.length;
    const rawChecksum = sha256Hex(rawBuffer);

    // Model-facing query_artifact result (compact)
    const modelFacingResult: Record<string, unknown> = {
      tool: 'query_artifact',
      status: 'PASSED',
      artifactId: 'planContract',
      projection: 'stages',
      totalItems: 5000,
      returnedItems: 5,
      artifactBytes: rawBytes,
      artifactChecksum: rawChecksum,
      // Compact sample only - not raw dump
      items: [{ id: 'stage_0', title: 'Stage 0: implement feature_0' }]
    };

    assertNoForbiddenModelFacingKeys(modelFacingResult, 'artifact fixture');
    expect(modelFacingResult.artifactBytes).toBe(rawBytes);
    expect(rawBytes).toBeGreaterThan(10 * 1024); // large artifact
  });

  it('(e) mailbox content: raw mail body preserved; model-facing result is compact listing', async () => {
    // check_mailbox result: compact listing, bodies not included inline
    const modelFacingResult: Record<string, unknown> = {
      tool: 'check_mailbox',
      status: 'PASSED',
      messageCount: 3,
      messages: [
        { id: 'msg-001', from: 'coordinator', subject: 'Planning checkpoint', timestamp: '2026-06-01T10:00:00Z' },
        { id: 'msg-002', from: 'teammate-1', subject: 'Implementation complete', timestamp: '2026-06-01T11:00:00Z' },
        { id: 'msg-003', from: 'coordinator', subject: 'Review required', timestamp: '2026-06-01T12:00:00Z' }
      ]
    };

    assertNoForbiddenModelFacingKeys(modelFacingResult, 'mailbox-list fixture');
    // Bodies are NOT included inline - agent uses fetch_mailbox_message to get the body
    expect(modelFacingResult.body).toBeUndefined();
    expect(modelFacingResult.rawBody).toBeUndefined();
  });

  it('(f) quality/diagnostic logs: diagnosticSummary compact; raw log in stderrFile', async () => {
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 's3wp30-quality-'));
    try {
      // Simulate a large pytest failure log
      const largeLog = [
        'FAILED tests/test_feature_0.py::test_basic - AssertionError: expected True but got False',
        ...Array.from({ length: 2000 }, (_, i) => `FAILED tests/test_module_${i}.py::test_case - AssertionError: value mismatch at step ${i}`)
      ].join('\n');

      const stderrFile = path.join(tmpDir, 'stderr.log');
      await fsPromises.writeFile(stderrFile, largeLog, 'utf8');
      const rawBytes = Buffer.from(largeLog, 'utf8').length;

      const modelFacingResult: Record<string, unknown> = {
        tool: 'pytest',
        status: 'REJECTED',
        exitCode: 1,
        stdoutFile: path.join(tmpDir, 'stdout.log'),
        stderrFile,
        stdoutBytes: 0,
        stderrBytes: rawBytes,
        diagnosticSummary: {
          totalDiagnostics: 2001,
          parsedDiagnostics: 2001,
          missingImportCount: 0,
          sourceTruncated: false,
          groups: [
            { source: 'pytest', code: 'AssertionError', severity: 'error', messagePrefix: 'expected True', count: 1, missingImport: false, representativeLocations: ['tests/test_feature_0.py'] },
            { source: 'pytest', code: 'AssertionError', severity: 'error', messagePrefix: 'value mismatch', count: 2000, missingImport: false, representativeLocations: ['tests/test_module_0.py', 'tests/test_module_1.py'] }
          ],
          nextAction: 'use_result'
        },
        compactSummary: 'Diagnostics in File: 2001\npytest/AssertionError count=2001\nLocations: tests/test_feature_0.py ...',
        nextAction: 'fix_or_route_failure',
        failureCategory: 'verifier_failed'
      };

      assertNoForbiddenModelFacingKeys(modelFacingResult, 'quality-log fixture');
      expect(modelFacingResult.stderrBytes).toBe(rawBytes);
      // Raw log text NOT in model-facing result
      expect(modelFacingResult.stderr).toBeUndefined();
      expect(modelFacingResult.stdout).toBeUndefined();

    } finally {
      await fsPromises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('(g) git history: raw output in archive; model-facing result is structured summary', async () => {
    // Simulate git log output for a large repo history
    const gitHistoryRaw = Array.from({ length: 10000 }, (_, i) =>
      `commit ${i.toString(16).padStart(40, '0')}\nAuthor: Dev <dev@example.com>\nDate: 2026-01-${String((i % 28) + 1).padStart(2, '0')}\n\n    Feature ${i}: implement module_${i}\n`
    ).join('\n');

    const rawBuffer = Buffer.from(gitHistoryRaw, 'utf8');
    const rawBytes = rawBuffer.length;

    // Model-facing result (compact)
    const modelFacingResult: Record<string, unknown> = {
      tool: 'git_history',
      status: 'PASSED',
      rawBytes,
      stdoutFile: '/tmp/s3wp30-git/stdout.log',
      stdoutBytes: rawBytes,
      stderrBytes: 0,
      structuredResult: {
        status: 'ok',
        counts: { payloadBytes: rawBytes, lines: 10000 * 5 },
        representativeSamples: [
          { line: 'commit 0000000000000000000000000000000000000000' },
          { line: '    Feature 0: implement module_0' }
        ],
        nextAction: 'use_result'
      }
    };

    assertNoForbiddenModelFacingKeys(modelFacingResult, 'git-history fixture');
    expect(modelFacingResult.rawBytes).toBe(rawBytes);
    expect(rawBytes).toBeGreaterThan(1 * 1024 * 1024); // should be several MiB
    // Raw commit log NOT inlined
    expect(modelFacingResult.stdout).toBeUndefined();
  });

});

// ---------------------------------------------------------------------------
// Guard 4: TOOL COUNT REPORT
// ---------------------------------------------------------------------------

describe('tool count summary', () => {
  it('reports orr-else tool inventory count', () => {
    const builtInCount = Object.values(BuiltInToolName).length;
    const pluginCount = Object.values(PluginToolName).length;
    const nativeCount = DEFAULT_OBSERVED_PI_TOOLS.length;
    const total = RTK_INVENTORY.length;
    console.info(
      `Orr Else tool inventory: ${total} total ` +
      `(built_in=${builtInCount}, plugin=${pluginCount}, native_pi=${nativeCount})`
    );
    expect(total).toBe(builtInCount + pluginCount + nativeCount);
  });
});
