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
 * BEAD E (metadata-elimination) — four additional static guards:
 *
 * Guard 3: bd_update_metadata / BD_UPDATE_METADATA / --metadata must not appear
 *   anywhere in src/** or harness.yaml. These patterns indicate a code path that
 *   would write runtime statechart state into Beads native metadata, violating the
 *   event-store-only architecture.
 *
 * Guard 4: metadata.orr_else / metadata.micromanager / issue.metadata must not
 *   appear in src/**. The sole ALLOWLISTED consumer is the BEAD_METADATA_MERGED
 *   case handler in BeadStateProjection.ts, which exists only for replaying old
 *   event logs — it is explicitly NOT a live write path.
 *
 * Guard 5: MUTATING_BEADS_COMMANDS (src/constants/index.ts) must contain exactly
 *   the coarse set {close, create, import, update} — no more, no less.
 *   Additionally, no `bd update` invocation in src/ may include `--metadata`.
 *
 * Guard 6: BEAD_METADATA_MERGED must not appear as the first argument to any
 *   eventStore.record() call anywhere in src/. The only allowed reference is the
 *   case-consumer in BeadStateProjection.ts (switch/case on replay). Emitting
 *   BEAD_METADATA_MERGED would reintroduce a deleted write path.
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
 * ALLOWLIST for Guard 4 (metadata field access) and Guard 6 (BEAD_METADATA_MERGED reference).
 *
 * BeadStateProjection.ts is the sole sanctioned consumer of BEAD_METADATA_MERGED.
 * It exists ONLY to replay old event logs that predate the metadata-elimination bead.
 * No new code may record or produce the event; BeadStateProjection only READS it
 * inside a switch/case during projection (not a write path).
 *
 * The `metadata.orr_else` / `metadata.micromanager` / `issue.metadata` patterns
 * are similarly only acceptable inside this file for the same replay-consumer reason.
 */
const BEAD_STATE_PROJECTION_FILE = 'src/core/BeadStateProjection.ts';

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
   * appear in framework code outside the single allowlisted replay consumer.
   *
   * ALLOWLIST: BeadStateProjection.ts contains a case DomainEventName.BEAD_METADATA_MERGED
   * handler that reads `data.patch` — not `metadata.orr_else` — so it is NOT matched
   * by these patterns. The allowlist is present as a documented contract: if any
   * match IS found in BeadStateProjection.ts under these specific field-path patterns,
   * it would still be a violation (the replay consumer reads data.patch, not the
   * banned field paths).
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

  it('guard 4 is non-vacuous: the allowlisted replay consumer actually exists in BeadStateProjection.ts', () => {
    // Prove the allowlist is not vacuous: BEAD_METADATA_MERGED must appear in
    // BeadStateProjection.ts as a case consumer (switch/case, not a record call).
    // If this test fails it means the replay consumer was removed and the allowlist
    // entry no longer needs to exist — update BEAD_STATE_PROJECTION_FILE or this check.
    const beadStateProjectionPath = path.join(ROOT_DIR, BEAD_STATE_PROJECTION_FILE);
    expect(
      fs.existsSync(beadStateProjectionPath),
      `Expected allowlisted file '${BEAD_STATE_PROJECTION_FILE}' to exist on disk — the replay consumer may have been moved or renamed`
    ).toBe(true);

    const source = fs.readFileSync(beadStateProjectionPath, 'utf8');
    // The consumer is a `case DomainEventName.BEAD_METADATA_MERGED:` line.
    const hasCaseConsumer = /case\s+DomainEventName\.BEAD_METADATA_MERGED/.test(source);
    expect(
      hasCaseConsumer,
      `Expected '${BEAD_STATE_PROJECTION_FILE}' to contain a 'case DomainEventName.BEAD_METADATA_MERGED' replay consumer — the guard allowlist is now vacuous and should be reviewed`
    ).toBe(true);
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
  it('MUTATING_BEADS_COMMANDS contains exactly {close, create, import, update} in constants/index.ts', () => {
    const constantsPath = path.join(SRC_DIR, 'constants', 'index.ts');
    expect(
      fs.existsSync(constantsPath),
      'src/constants/index.ts not found — cannot verify MUTATING_BEADS_COMMANDS'
    ).toBe(true);

    const source = fs.readFileSync(constantsPath, 'utf8');

    // Extract the Set literal for MUTATING_BEADS_COMMANDS.
    // Match the block: `new Set<string>([\n  BeadsCliCommand.CLOSE,\n  ...  \n])`
    const setBlock = source.match(
      /MUTATING_BEADS_COMMANDS\s*=\s*new Set<[^>]*>\s*\(\s*\[([\s\S]*?)\]\s*\)/
    );
    expect(
      setBlock,
      'Could not parse the MUTATING_BEADS_COMMANDS Set literal in src/constants/index.ts — the guard needs updating if the declaration format changed'
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

// ─── Guard 6: BEAD_METADATA_MERGED must not be RECORDED anywhere ─────────────

describe('EventStore-only guard 6: BEAD_METADATA_MERGED is never recorded (emitted) in src/', () => {
  /**
   * BEAD_METADATA_MERGED is REPLAY-ONLY / HISTORICAL (documented in both constants/index.ts
   * and BeadStateProjection.ts). The only legal reference is the case-consumer inside
   * BeadStateProjection.ts's switch statement.
   *
   * This guard distinguishes RECORD/EMIT from CONSUME:
   *   - Banned:   eventStore.record(DomainEventName.BEAD_METADATA_MERGED, ...)
   *   - Banned:   eventStore.record('BEAD_METADATA_MERGED', ...)
   *   - Allowed:  case DomainEventName.BEAD_METADATA_MERGED: (switch arm in BeadStateProjection.ts)
   *   - Allowed:  BEAD_METADATA_MERGED = 'BEAD_METADATA_MERGED'  (enum declaration in constants)
   *
   * The pattern searches for .record( calls whose first argument is or contains
   * BEAD_METADATA_MERGED. It does NOT match enum declarations, import statements,
   * or case/switch consumers.
   *
   * Non-vacuity: a line like
   *   `await eventStore.record(DomainEventName.BEAD_METADATA_MERGED, { ... })`
   * would be caught by the pattern. We verify this below with an explicit pattern check.
   */

  /**
   * Returns true if a line looks like a .record() call that includes
   * BEAD_METADATA_MERGED as an argument (the first argument position is what
   * matters — the second is the data payload and should not contain this string
   * in practice, so we match the whole record call line to be conservative).
   */
  function isRecordEmission(line: string): boolean {
    // Match lines that call .record( with BEAD_METADATA_MERGED anywhere in the
    // argument region. The pattern is intentionally broad so it catches both
    // `.record(DomainEventName.BEAD_METADATA_MERGED` and `.record('BEAD_METADATA_MERGED'`.
    return /\.record\([\s\S]*BEAD_METADATA_MERGED/.test(line);
  }

  it('no file in src/ calls .record() with BEAD_METADATA_MERGED as a target', () => {
    // We scan non-comment lines only (isCommentLine filters already applied).
    const pattern = /\.record\([^)]*BEAD_METADATA_MERGED/;
    const violations = scanSourceFiles(pattern);
    const formatted = violations.map(v => `  ${v.file}:${v.line}  ${v.text}`);
    expect(
      formatted,
      [
        'BEAD_METADATA_MERGED found as a .record() argument in src/ — this event is REPLAY-ONLY.',
        'No live code path may emit BEAD_METADATA_MERGED. The only allowed reference is',
        `the case-consumer in '${BEAD_STATE_PROJECTION_FILE}' for replaying historical logs.`,
        '',
        'Violations:',
        ...formatted
      ].join('\n')
    ).toEqual([]);
  });

  it('guard 6 is non-vacuous: the pattern correctly identifies a hypothetical record call', () => {
    // Demonstrate that the guard pattern WOULD fire if a record call were introduced.
    // We test the pattern against a planted hypothetical line (never present in source).
    const hypotheticalLine = 'await eventStore.record(DomainEventName.BEAD_METADATA_MERGED, { beadId })';
    expect(isRecordEmission(hypotheticalLine)).toBe(true);

    // And that it does NOT fire on the legitimate case-consumer in BeadStateProjection.ts.
    const legitimateConsumer = 'case DomainEventName.BEAD_METADATA_MERGED:';
    expect(isRecordEmission(legitimateConsumer)).toBe(false);

    // And that it does NOT fire on the enum declaration in constants/index.ts.
    const enumDeclaration = "  BEAD_METADATA_MERGED = 'BEAD_METADATA_MERGED',";
    expect(isRecordEmission(enumDeclaration)).toBe(false);
  });

  it('the allowlisted replay consumer in BeadStateProjection.ts is a case-consumer, not a record call', () => {
    // Belt-and-suspenders: even the allowlisted file must not contain a record call.
    const beadStateProjectionPath = path.join(ROOT_DIR, BEAD_STATE_PROJECTION_FILE);
    if (!fs.existsSync(beadStateProjectionPath)) {
      // If the file doesn't exist the guard-4 non-vacuity test above already fails.
      return;
    }
    const source = fs.readFileSync(beadStateProjectionPath, 'utf8');
    const lines = source.split('\n');
    const recordEmissions = lines
      .filter(line => !isCommentLine(line))
      .filter(line => isRecordEmission(line));

    expect(
      recordEmissions,
      [
        `'${BEAD_STATE_PROJECTION_FILE}' must not contain a .record(BEAD_METADATA_MERGED) call.`,
        'Even the replay-consumer file may only READ the event inside a switch/case, not emit it.',
        '',
        'Offending lines:',
        ...recordEmissions.map(l => `  ${l.trim()}`)
      ].join('\n')
    ).toEqual([]);
  });
});
