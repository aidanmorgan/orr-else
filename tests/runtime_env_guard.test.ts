/**
 * Guard: prevent new direct process.env reads from being added to src/.
 *
 * Every entry in ALLOWLIST is a file that still legitimately reads process.env
 * directly, with a reason explaining why and (where applicable) which WI will
 * remove it.
 *
 * When this test fails it means a NEW unapproved process.env read was added.
 * Fix it by routing through RuntimeEnvironment, or (temporarily) adding an
 * allowlist entry with a documented reason and the deferred WI reference.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface AllowlistEntry {
  /** POSIX-relative path from repo root, e.g. "src/core/RuntimeEnvironment.ts" */
  file: string;
  /** Why this file is allowed to read process.env directly */
  reason: string;
  /** Which deferred work-item will remove this entry (undefined = permanent) */
  deferredWI?: string;
}

const ALLOWLIST: AllowlistEntry[] = [
  {
    file: 'src/core/RuntimeEnvironment.ts',
    reason: 'This IS the adapter — it is the single place that maps process.env to the RuntimeEnvironment port.',
    deferredWI: undefined
  },
  {
    file: 'src/core/Paths.ts',
    reason: 'Module-level projectRoot initialisation reads process.cwd(); removal requires threading projectRoot through RuntimeServices (WI-2).',
    deferredWI: 'WI-2'
  },
  {
    file: 'src/core/Teammate.ts',
    reason: 'Worker-process bootstrap reads BEAD_ID/STATE_ID/PROJECT_ROOT/WORKTREE_PATH at start. Requires WorkerContext injection (WI-6).',
    deferredWI: 'WI-6'
  },
  {
    file: 'src/core/ArtifactQuery.ts',
    reason: 'Not in WI-1 scope; reads PROJECT_ROOT/WORKTREE_PATH for artifact query context. Will be addressed in a follow-up.',
    deferredWI: undefined
  },
  {
    file: 'src/extension.ts',
    reason: 'Composition-root entrypoint. Multiple deferred items: WI-4 (session state), WI-6 (WorkerContext), WI-7 (API port write-back), WI-20 (TeammateFactory construction). Also holds the legitimate process.env write-back at :2496-2497 for WI-7.',
    deferredWI: 'WI-4,WI-6,WI-7,WI-20'
  },
  {
    file: 'src/plugins/mailbox.ts',
    reason: 'Reads WORKER_ID as a heartbeat fallback. Not in WI-1 scope.',
    deferredWI: undefined
  },
  {
    file: 'src/plugins/teammates.ts',
    reason: 'Reads API_PORT, API_BASE, MAX_OUTPUT_TOKENS for child-process env construction. Removal requires explicit API port threading (WI-7).',
    deferredWI: 'WI-7'
  },
  {
    file: 'src/plugins/projectTools.ts',
    reason: 'Uses { ...process.env, ...env } spread to forward the full host environment to child command processes — this is a child-process boundary operation, not a static read of a named key. No DI equivalent exists for full env forwarding.',
    deferredWI: undefined
  }
];

// ─── helpers ────────────────────────────────────────────────────────────────

const ROOT_DIR = path.resolve(process.cwd());
const SRC_DIR = path.join(ROOT_DIR, 'src');

/** Pattern that matches a real process.env access (not a comment or string). */
const PROCESS_ENV_CODE_PATTERN = /process\.env\b/;
/** Pattern that matches a comment line (// or JSDoc * lines) */
const COMMENT_LINE_PATTERN = /^\s*(?:\/\/|\*)/;

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function listSourceFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap(entry => {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(abs);
    if (!entry.isFile()) return [];
    if (!entry.name.endsWith('.ts')) return [];
    if (entry.name.endsWith('.d.ts')) return [];
    return [abs];
  });
}

interface ProcessEnvRead {
  file: string;
  line: number;
  text: string;
}

/**
 * Scan a TypeScript source file for non-comment lines that reference
 * process.env. Returns one entry per matching line.
 */
function findProcessEnvReads(absolutePath: string): ProcessEnvRead[] {
  const relativePath = toPosix(path.relative(ROOT_DIR, absolutePath));
  const source = fs.readFileSync(absolutePath, 'utf8');
  const reads: ProcessEnvRead[] = [];
  for (const [index, rawLine] of source.split('\n').entries()) {
    if (COMMENT_LINE_PATTERN.test(rawLine)) continue;
    if (!PROCESS_ENV_CODE_PATTERN.test(rawLine)) continue;
    reads.push({ file: relativePath, line: index + 1, text: rawLine.trim() });
  }
  return reads;
}

// ─── test ───────────────────────────────────────────────────────────────────

describe('RuntimeEnvironment guard', () => {
  it('has no direct process.env reads outside the approved allowlist', () => {
    const allowedFiles = new Set(ALLOWLIST.map(e => e.file));

    const allFiles = listSourceFiles(SRC_DIR);
    const violations: ProcessEnvRead[] = [];

    for (const absolutePath of allFiles) {
      const relativePath = toPosix(path.relative(ROOT_DIR, absolutePath));
      if (allowedFiles.has(relativePath)) continue;

      const reads = findProcessEnvReads(absolutePath);
      violations.push(...reads);
    }

    const formattedViolations = violations.map(v => `  ${v.file}:${v.line}  ${v.text}`);

    expect(
      formattedViolations,
      [
        'New direct process.env reads were found outside the approved allowlist.',
        'Route them through RuntimeEnvironment (inject via constructor with a nodeRuntimeEnvironment default),',
        'or add a temporary allowlist entry with a reason and a deferred WI reference.',
        '',
        'Violations:',
        ...formattedViolations
      ].join('\n')
    ).toEqual([]);
  });

  it('allowlist entries reference files that exist (no stale entries)', () => {
    const staleEntries: string[] = [];
    for (const entry of ALLOWLIST) {
      const absolutePath = path.join(ROOT_DIR, entry.file.split('/').join(path.sep));
      if (!fs.existsSync(absolutePath)) {
        staleEntries.push(`  ${entry.file} (${entry.reason})`);
      }
    }
    expect(
      staleEntries,
      `Allowlist entries reference files that no longer exist — remove them:\n${staleEntries.join('\n')}`
    ).toEqual([]);
  });
});
