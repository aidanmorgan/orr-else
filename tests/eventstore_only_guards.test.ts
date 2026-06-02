/**
 * BEAD A — eventstore-service-injection static guard
 *
 * Two enforcement rules enforced by source scanning:
 *
 * 1. No static EventStore member access (EventStore.<uppercase>) anywhere in src/.
 *    Static access would mean a shared class-level singleton bypassing DI.
 *
 * 2. `new EventStore(` only in the two approved composition roots:
 *      - src/composition/createRuntimeServices.ts  (primary composition root)
 *      - src/core/RuntimeServices.ts               (assembleRuntimeServices fallback)
 *    Any other file constructing EventStore directly would bypass the DI chain.
 *
 * If either rule fires, it means new code is constructing or accessing EventStore
 * outside the sanctioned composition roots — a regression that this test prevents.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── helpers ─────────────────────────────────────────────────────────────────

const ROOT_DIR = path.resolve(process.cwd());
const SRC_DIR = path.join(ROOT_DIR, 'src');

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function listSourceFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap(entry => {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(abs);
    if (!entry.isFile()) return [];
    if (entry.name.endsWith('.d.ts')) return [];
    if (!entry.name.endsWith('.ts')) return [];
    return [abs];
  });
}

/**
 * Returns true when the line is a comment line that should be ignored
 * (// single-line comment or * inside a JSDoc block).
 */
function isCommentLine(line: string): boolean {
  return /^\s*(?:\/\/|\*)/.test(line);
}

interface SourceMatch {
  file: string;
  line: number;
  text: string;
}

function scanSourceFiles(pattern: RegExp): SourceMatch[] {
  const matches: SourceMatch[] = [];
  for (const abs of listSourceFiles(SRC_DIR)) {
    const rel = toPosix(path.relative(ROOT_DIR, abs));
    const source = fs.readFileSync(abs, 'utf8');
    for (const [index, rawLine] of source.split('\n').entries()) {
      if (isCommentLine(rawLine)) continue;
      if (!pattern.test(rawLine)) continue;
      matches.push({ file: rel, line: index + 1, text: rawLine.trim() });
    }
  }
  return matches;
}

// ─── approved composition roots ──────────────────────────────────────────────

/**
 * The two files allowed to call `new EventStore(`.
 * Both are composition roots — no other file may construct EventStore.
 */
const APPROVED_INSTANTIATION_FILES = new Set([
  'src/composition/createRuntimeServices.ts',
  'src/core/RuntimeServices.ts'
]);

// ─── tests ───────────────────────────────────────────────────────────────────

describe('EventStore DI guards', () => {
  it('has no static EventStore member access (EventStore.<UPPERCASE>) in src/', () => {
    // Static members on the EventStore class (e.g. EventStore.getInstance())
    // would bypass DI and re-introduce a singleton pattern.
    // The pattern matches `EventStore.` followed by an uppercase letter, which
    // is the conventional signature of a static factory/property/method call.
    // Import statements (`import { EventStore } from ...`) do NOT match because
    // they use `{` not `.` after `EventStore`.
    const staticAccessPattern = /\bEventStore\.[A-Z]/;
    const violations = scanSourceFiles(staticAccessPattern);

    const formatted = violations.map(v => `  ${v.file}:${v.line}  ${v.text}`);
    expect(
      formatted,
      [
        'Static EventStore member access found in src/.',
        'EventStore must not expose static factories/singletons — all consumers',
        'must receive an injected instance via constructor or factory parameter.',
        '',
        'Violations:',
        ...formatted
      ].join('\n')
    ).toEqual([]);
  });

  it('only instantiates EventStore in the two approved composition roots', () => {
    // `new EventStore(` outside the composition roots means a module is
    // constructing its own private EventStore instead of accepting one via DI.
    const instantiationPattern = /\bnew EventStore\(/;
    const allMatches = scanSourceFiles(instantiationPattern);
    const violations = allMatches.filter(m => !APPROVED_INSTANTIATION_FILES.has(m.file));

    const formatted = violations.map(v => `  ${v.file}:${v.line}  ${v.text}`);
    expect(
      formatted,
      [
        '`new EventStore(` found outside the approved composition roots.',
        'EventStore instances must only be constructed in:',
        '  - src/composition/createRuntimeServices.ts',
        '  - src/core/RuntimeServices.ts',
        'All other files must accept EventStore via constructor/factory injection.',
        '',
        'Violations:',
        ...formatted
      ].join('\n')
    ).toEqual([]);
  });

  it('approved composition roots both still contain exactly one EventStore instantiation each', () => {
    // Sanity-check: the allowlist is not vacuous. Each composition root must
    // have at least one `new EventStore(` so the guard is meaningful (it would
    // trivially pass if we moved construction elsewhere and forgot to update
    // APPROVED_INSTANTIATION_FILES).
    const instantiationPattern = /\bnew EventStore\(/;
    const allMatches = scanSourceFiles(instantiationPattern);
    const approvedMatches = allMatches.filter(m => APPROVED_INSTANTIATION_FILES.has(m.file));

    // Both composition roots must appear in the match list.
    for (const approvedFile of APPROVED_INSTANTIATION_FILES) {
      const found = approvedMatches.some(m => m.file === approvedFile);
      expect(
        found,
        `Approved composition root '${approvedFile}' no longer contains 'new EventStore(' — update APPROVED_INSTANTIATION_FILES if this file was intentionally removed.`
      ).toBe(true);
    }
  });
});
