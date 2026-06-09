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
 *
 * BEAD E (metadata-elimination) — additional static guards:
 *
 * Guard 3: bd_update_metadata / BD_UPDATE_METADATA / --metadata must not appear
 *   anywhere in src/** or harness.yaml. These patterns indicate a code path that
 *   would write runtime statechart state into Beads native metadata, violating the
 *   event-store-only architecture.
 *
 * Guard 4: metadata.orr_else / metadata.micromanager / issue.metadata must not
 *   appear in src/**. These field-access patterns would read runtime statechart
 *   state out of Beads native metadata instead of the event-store projections.
 *
 * Guard 5: MUTATING_BEADS_COMMANDS (src/constants/domain.ts) must contain exactly
 *   the coarse set {close, create, import, update} — no more, no less.
 *   Additionally, no `bd update` invocation in src/ may include `--metadata`.
 *
 * (The former Guard 6 — that the REPLAY-ONLY BEAD_METADATA_MERGED event was never
 *  re-emitted — was removed when that event was deleted outright in
 *  pi-experiment-vvuz: there is no longer any event to guard against.)
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── helpers ─────────────────────────────────────────────────────────────────

const ROOT_DIR = path.resolve(process.cwd());
const SRC_DIR = path.join(ROOT_DIR, 'src');
const HARNESS_YAML = path.join(ROOT_DIR, 'harness.yaml');

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

/**
 * Reads harness.yaml (non-code config file) line-by-line and returns lines that
 * match the pattern, excluding comment lines (lines starting with '#').
 */
function scanHarnessYaml(pattern: RegExp): SourceMatch[] {
  const matches: SourceMatch[] = [];
  if (!fs.existsSync(HARNESS_YAML)) return matches;
  const source = fs.readFileSync(HARNESS_YAML, 'utf8');
  for (const [index, rawLine] of source.split('\n').entries()) {
    if (/^\s*#/.test(rawLine)) continue;  // skip YAML comment lines
    if (!pattern.test(rawLine)) continue;
    matches.push({ file: 'harness.yaml', line: index + 1, text: rawLine.trim() });
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

// ─── Guard 3–6 allowlists ─────────────────────────────────────────────────────

/**
 * Expected members of MUTATING_BEADS_COMMANDS — exactly the coarse set.
 * Any addition to this set must be reviewed as a potential metadata write path.
 */
const EXPECTED_MUTATING_BEADS_COMMANDS = new Set([
  'BeadsCliCommand.CLOSE',
  'BeadsCliCommand.CREATE',
  'BeadsCliCommand.IMPORT',
  'BeadsCliCommand.UPDATE'
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

// ─── Guard 3: no bd_update_metadata / BD_UPDATE_METADATA / --metadata ────────

describe('EventStore-only guard 3: no metadata write commands in src/ or harness.yaml', () => {
  /**
   * The patterns bd_update_metadata, BD_UPDATE_METADATA, and --metadata are
   * the fingerprints of a `bd update --metadata` call — the mechanism that
   * previously wrote runtime statechart state into Beads native metadata.
   * After the metadata-elimination bead (BEAD E) they must not appear anywhere.
   *
   * Non-vacuity: the patterns are distinct literals that the scanner would detect
   * if any future code reintroduced `bd update --metadata <json>` or renamed the
   * tool back to `bd_update_metadata`. The guard covers both src/ and harness.yaml
   * (tool names can appear in YAML agent prompts as well as TypeScript).
   */
  it('has no bd_update_metadata / BD_UPDATE_METADATA references in src/', () => {
    const pattern = /\bbd_update_metadata\b|\bBD_UPDATE_METADATA\b/;
    const violations = scanSourceFiles(pattern);
    const formatted = violations.map(v => `  ${v.file}:${v.line}  ${v.text}`);
    expect(
      formatted,
      [
        'bd_update_metadata / BD_UPDATE_METADATA found in src/ — this tool was deleted by the metadata-elimination bead.',
        'Runtime statechart state must live in the event store, not in Beads native metadata.',
        '',
        'Violations:',
        ...formatted
      ].join('\n')
    ).toEqual([]);
  });

  it('has no --metadata flag in src/ (would imply a bd update --metadata write)', () => {
    // We scan for the `--metadata` flag as a standalone argument token.
    // This catches constructions like `['update', beadId, '--metadata', ...]`.
    // The pattern requires a word boundary or quote boundary to avoid false-positives
    // on field names like `metadata:` or `metadata =`.
    const pattern = /['"`\s]--metadata\b/;
    const violations = scanSourceFiles(pattern);
    const formatted = violations.map(v => `  ${v.file}:${v.line}  ${v.text}`);
    expect(
      formatted,
      [
        '`--metadata` flag found in src/ — passing --metadata to `bd update` would write state into Beads native metadata.',
        'Runtime state must live exclusively in the event store.',
        '',
        'Violations:',
        ...formatted
      ].join('\n')
    ).toEqual([]);
  });

  it('has no bd_update_metadata / BD_UPDATE_METADATA / --metadata in harness.yaml', () => {
    // harness.yaml may contain agent prompts that mention tool names.
    // Any reference here would indicate the harness is instructing agents to
    // write state through the old metadata path.
    const pattern = /\bbd_update_metadata\b|\bBD_UPDATE_METADATA\b|['"`\s]--metadata\b/;
    const violations = scanHarnessYaml(pattern);
    const formatted = violations.map(v => `  ${v.file}:${v.line}  ${v.text}`);
    expect(
      formatted,
      [
        'Metadata write pattern found in harness.yaml — agents must not be instructed to use `bd update --metadata`.',
        '',
        'Violations:',
        ...formatted
      ].join('\n')
    ).toEqual([]);
  });

  it('guard 3 is non-vacuous: src/ files exist and are scanned', () => {
    // Sanity-check that the scanner actually reads files.
    // We use a pattern that definitely appears in bd.ts (a real tool in src/).
    const sanityPattern = /\bBEADS_COMMAND_STARTED\b/;
    const hits = scanSourceFiles(sanityPattern);
    expect(
      hits.length,
      'Expected at least one match for BEADS_COMMAND_STARTED — if zero, the file scanner is broken or src/ is empty'
    ).toBeGreaterThan(0);
  });
});

// ─── Guard 4: no metadata.orr_else / metadata.micromanager / issue.metadata ──

describe('EventStore-only guard 4: no framework code reads banned metadata field paths', () => {
  /**
   * metadata.orr_else, metadata.micromanager, and issue.metadata are field-access
   * patterns that indicate a code path reading runtime statechart state out of
   * Beads native metadata. After the metadata-elimination bead these must not
   * appear in framework code at all — runtime state is derived exclusively from
   * event-store projections.
   *
   * Non-vacuity: these are real property-access chain patterns. The scanner would
   * catch a line like `const x = issue.metadata.orr_else` that a future developer
   * might add when reading a Beads issue record.
   */
  it('has no metadata.orr_else references in src/', () => {
    const pattern = /\bmetadata\.orr_else\b/;
    const violations = scanSourceFiles(pattern);
    const formatted = violations.map(v => `  ${v.file}:${v.line}  ${v.text}`);
    expect(
      formatted,
      [
        'metadata.orr_else found in src/ — this field path reads deleted Beads native metadata.',
        'Runtime state must be derived exclusively from event-store projections.',
        '',
        'Violations:',
        ...formatted
      ].join('\n')
    ).toEqual([]);
  });

  it('has no metadata.micromanager references in src/', () => {
    const pattern = /\bmetadata\.micromanager\b/;
    const violations = scanSourceFiles(pattern);
    const formatted = violations.map(v => `  ${v.file}:${v.line}  ${v.text}`);
    expect(
      formatted,
      [
        'metadata.micromanager found in src/ — this field path reads deleted Beads native metadata.',
        'Runtime state must be derived exclusively from event-store projections.',
        '',
        'Violations:',
        ...formatted
      ].join('\n')
    ).toEqual([]);
  });

  it('has no issue.metadata references in src/', () => {
    const pattern = /\bissue\.metadata\b/;
    const violations = scanSourceFiles(pattern);
    const formatted = violations.map(v => `  ${v.file}:${v.line}  ${v.text}`);
    expect(
      formatted,
      [
        'issue.metadata found in src/ — this field path reads Beads native metadata that was deleted by the metadata-elimination bead.',
        'Runtime state must come exclusively from event-store projections (projectBead, projectBeadStateChart).',
        '',
        'Violations:',
        ...formatted
      ].join('\n')
    ).toEqual([]);
  });
});

// ─── Guard 5: MUTATING_BEADS_COMMANDS membership + no bd update --metadata ───

describe('EventStore-only guard 5: MUTATING_BEADS_COMMANDS membership is exactly the coarse set', () => {
  /**
   * MUTATING_BEADS_COMMANDS must contain exactly {close, create, import, update}.
   * Expanding this set — e.g. by adding 'update-metadata' or any new subcommand —
   * would silently enable new Beads write paths that may carry state into native
   * metadata. The guard reads the actual constant from the compiled source.
   *
   * Non-vacuity: the test extracts the live members from the source file (the
   * enumeration lines inside the Set initializer). If a new BeadsCliCommand member
   * were added and included in the Set literal, the extracted set would differ from
   * EXPECTED_MUTATING_BEADS_COMMANDS and the assertion would fail.
   */
  it('MUTATING_BEADS_COMMANDS contains exactly {close, create, import, update} in constants/domain.ts', () => {
    const constantsPath = path.join(SRC_DIR, 'constants', 'domain.ts');
    expect(
      fs.existsSync(constantsPath),
      'src/constants/domain.ts not found — cannot verify MUTATING_BEADS_COMMANDS'
    ).toBe(true);

    const source = fs.readFileSync(constantsPath, 'utf8');

    // Extract the Set literal for MUTATING_BEADS_COMMANDS.
    // Match the block: `new Set<string>([\n  BeadsCliCommand.CLOSE,\n  ...  \n])`
    const setBlock = source.match(
      /MUTATING_BEADS_COMMANDS\s*=\s*new Set<[^>]*>\s*\(\s*\[([\s\S]*?)\]\s*\)/
    );
    expect(
      setBlock,
      'Could not parse the MUTATING_BEADS_COMMANDS Set literal in src/constants/domain.ts — the guard needs updating if the declaration format changed'
    ).not.toBeNull();

    // Extract each BeadsCliCommand.* member from the block.
    const blockContent = setBlock![1];
    const memberMatches = [...blockContent.matchAll(/\bBeadsCliCommand\.(\w+)\b/g)];
    const extractedMembers = new Set(memberMatches.map(m => `BeadsCliCommand.${m[1]}`));

    // Assert exact set equality.
    const missing = [...EXPECTED_MUTATING_BEADS_COMMANDS].filter(m => !extractedMembers.has(m));
    const extra = [...extractedMembers].filter(m => !EXPECTED_MUTATING_BEADS_COMMANDS.has(m));

    expect(
      { missing, extra },
      [
        'MUTATING_BEADS_COMMANDS does not match the expected coarse set {close, create, import, update}.',
        'Any addition must be reviewed: new members may enable Beads native metadata writes.',
        `Missing expected members: ${missing.join(', ') || '(none)'}`,
        `Extra unexpected members: ${extra.join(', ') || '(none)'}`
      ].join('\n')
    ).toEqual({ missing: [], extra: [] });
  });

  it('no bd update invocation in src/ passes --metadata as an argument', () => {
    // Catches patterns like: runBd(client, store, ['update', id, '--metadata', ...])
    // The comment-aware scanner skips comment lines so a commented-out example
    // would not trigger the guard.
    const pattern = /['"`\s]--metadata\b/;
    const violations = scanSourceFiles(pattern);
    const formatted = violations.map(v => `  ${v.file}:${v.line}  ${v.text}`);
    expect(
      formatted,
      [
        '`--metadata` argument found in src/ — `bd update --metadata` would write state into Beads native metadata.',
        'Runtime state must live exclusively in the event store.',
        '',
        'Violations:',
        ...formatted
      ].join('\n')
    ).toEqual([]);
  });
});
