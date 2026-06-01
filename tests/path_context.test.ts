/**
 * Tests for PathContext / read_path_context tool.
 *
 * Coverage:
 *   (a) ENOENT — missing path → exists:false + nearestMatches, no throw
 *   (b) Out-of-range offset — exists but offset > totalLines → correctedOffset, no read error
 *   (c) Successful narrowed read — valid path + range → slice with content
 *   (d) Out-of-scope path — absolute path outside roots / "../" traversal → structured rejection, NO content/existence-of-target leak
 *   (e) Nearest-match suggestion — near-miss path name → top nearestMatches
 *   (f) Exact file → found with correct totalLines and valid range
 *   (g) Missing offset (no offset given) → requestedOffsetValid is null
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  PathContext,
  PATH_CONTEXT_MAX_NEAR_MATCHES,
  PATH_CONTEXT_MAX_SLICE_LINES
} from '../src/core/PathContext.js';
import { EnvVars } from '../src/constants/index.js';

// ─── Test helpers ─────────────────────────────────────────────────────────────

const root = path.join(os.tmpdir(), 'orr-else-path-context-test');

function writeFile(relativePath: string, content: string): void {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function makeLines(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n');
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

describe('PathContext', () => {
  let pathContext: PathContext;
  let savedWorktreePath: string | undefined;
  let savedProjectRoot: string | undefined;

  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });

    savedWorktreePath = process.env[EnvVars.WORKTREE_PATH];
    savedProjectRoot = process.env[EnvVars.PROJECT_ROOT];

    // Point both env vars at the test root so scope checks pass for in-scope tests.
    process.env[EnvVars.WORKTREE_PATH] = root;
    process.env[EnvVars.PROJECT_ROOT] = root;

    pathContext = new PathContext(root);
  });

  afterEach(() => {
    if (savedWorktreePath === undefined) delete process.env[EnvVars.WORKTREE_PATH];
    else process.env[EnvVars.WORKTREE_PATH] = savedWorktreePath;

    if (savedProjectRoot === undefined) delete process.env[EnvVars.PROJECT_ROOT];
    else process.env[EnvVars.PROJECT_ROOT] = savedProjectRoot;

    fs.rmSync(root, { recursive: true, force: true });
  });

  // ── (a) ENOENT ────────────────────────────────────────────────────────────

  it('(a) ENOENT: missing path returns exists:false with nearestMatches — does not throw', () => {
    // Create a real file so there is something to suggest as a nearest match.
    writeFile('src/core/Foo.ts', 'export class Foo {}');

    const missing = path.join(root, 'src/core/FooBar.ts');
    const result = pathContext.resolve({ filePath: missing });

    expect(result.status).toBe('not_found');
    if (result.status !== 'not_found') throw new Error('unexpected status');
    expect(result.exists).toBe(false);
    expect(Array.isArray(result.nearestMatches)).toBe(true);
    // Should suggest the similar-named file
    expect(result.nearestMatches.length).toBeGreaterThan(0);
    expect(result.nearestMatches.length).toBeLessThanOrEqual(PATH_CONTEXT_MAX_NEAR_MATCHES);
    // Recovery hints must be present
    expect(Array.isArray(result.recovery)).toBe(true);
    expect(result.recovery.length).toBeGreaterThan(0);
  });

  it('(a) ENOENT: missing path in empty root returns nearestMatches:[] gracefully', () => {
    const missing = path.join(root, 'does/not/exist.ts');
    const result = pathContext.resolve({ filePath: missing });

    expect(result.status).toBe('not_found');
    if (result.status !== 'not_found') throw new Error('unexpected status');
    expect(result.exists).toBe(false);
    expect(result.nearestMatches).toEqual([]);
  });

  // ── (b) Out-of-range offset ───────────────────────────────────────────────

  it('(b) out-of-range offset: offset beyond EOF returns correctedOffset, no throw', () => {
    writeFile('src/target.ts', makeLines(10));

    const filePath = path.join(root, 'src/target.ts');
    const result = pathContext.resolve({ filePath, offset: 999 });

    expect(result.status).toBe('found');
    if (result.status !== 'found') throw new Error('unexpected status');
    expect(result.exists).toBe(true);
    expect(result.totalLines).toBe(10);
    expect(result.validOffsetRange).toEqual({ min: 1, max: 10 });
    expect(result.requestedOffsetValid).toBe(false);
    expect(result.correctedOffset).toBe(10); // last valid line
    expect(result.slice).toBeNull();
  });

  it('(b) out-of-range offset: offset of 0 returns correctedOffset of 1', () => {
    writeFile('src/target.ts', makeLines(5));

    const filePath = path.join(root, 'src/target.ts');
    const result = pathContext.resolve({ filePath, offset: 0 });

    expect(result.status).toBe('found');
    if (result.status !== 'found') throw new Error('unexpected status');
    expect(result.requestedOffsetValid).toBe(false);
    expect(result.correctedOffset).toBe(1);
  });

  it('(b) out-of-range offset: negative offset returns correctedOffset of 1', () => {
    writeFile('src/target.ts', makeLines(5));

    const filePath = path.join(root, 'src/target.ts');
    const result = pathContext.resolve({ filePath, offset: -5 });

    expect(result.status).toBe('found');
    if (result.status !== 'found') throw new Error('unexpected status');
    expect(result.requestedOffsetValid).toBe(false);
    expect(result.correctedOffset).toBe(1);
  });

  // ── (c) Successful narrowed read ──────────────────────────────────────────

  it('(c) successful narrowed read: valid path + offset + limit returns slice', () => {
    const content = makeLines(20);
    writeFile('src/core/Bar.ts', content);

    const filePath = path.join(root, 'src/core/Bar.ts');
    const result = pathContext.resolve({ filePath, offset: 3, limit: 5 });

    expect(result.status).toBe('found');
    if (result.status !== 'found') throw new Error('unexpected status');
    expect(result.exists).toBe(true);
    expect(result.totalLines).toBe(20);
    expect(result.requestedOffsetValid).toBe(true);
    expect(result.correctedOffset).toBeNull();
    expect(result.slice).not.toBeNull();
    // Slice should contain lines 3–7
    expect(result.slice).toContain('line 3');
    expect(result.slice).toContain('line 7');
    expect(result.slice).not.toContain('line 2');
    expect(result.slice).not.toContain('line 8');
  });

  it('(c) valid path + offset only (no limit) returns found with null slice', () => {
    writeFile('src/core/Baz.ts', makeLines(5));

    const filePath = path.join(root, 'src/core/Baz.ts');
    const result = pathContext.resolve({ filePath, offset: 2 });

    expect(result.status).toBe('found');
    if (result.status !== 'found') throw new Error('unexpected status');
    expect(result.requestedOffsetValid).toBe(true);
    expect(result.correctedOffset).toBeNull();
    expect(result.slice).toBeNull();
  });

  it('(c) limit is capped at PATH_CONTEXT_MAX_SLICE_LINES', () => {
    // File with far more lines than the cap
    const bigContent = makeLines(PATH_CONTEXT_MAX_SLICE_LINES + 200);
    writeFile('src/big.ts', bigContent);

    const filePath = path.join(root, 'src/big.ts');
    const result = pathContext.resolve({ filePath, offset: 1, limit: PATH_CONTEXT_MAX_SLICE_LINES + 200 });

    expect(result.status).toBe('found');
    if (result.status !== 'found') throw new Error('unexpected status');
    // Slice should only contain up to the cap
    const sliceLines = result.slice?.split('\n').length ?? 0;
    expect(sliceLines).toBeLessThanOrEqual(PATH_CONTEXT_MAX_SLICE_LINES);
  });

  // ── (d) Out-of-scope path ─────────────────────────────────────────────────

  it('(d) out-of-scope: absolute path outside roots returns structured rejection — no content/existence leak', () => {
    const outsidePath = path.join(os.tmpdir(), `outside-orr-else-test-${Date.now()}`);

    const result = pathContext.resolve({ filePath: outsidePath });

    expect(result.status).toBe('out_of_scope');
    if (result.status !== 'out_of_scope') throw new Error('unexpected status');
    expect(result.reason).toBeTruthy();
    // Must NOT leak whether the path exists outside the root
    const resultString = JSON.stringify(result);
    expect(resultString).not.toContain('exists');
    expect(Array.isArray(result.recovery)).toBe(true);
    expect(result.recovery.length).toBeGreaterThan(0);
  });

  it('(d) out-of-scope: "../" traversal above root returns structured rejection', () => {
    const escapePath = path.join(root, '..', '..', 'etc', 'passwd');
    const result = pathContext.resolve({ filePath: escapePath });

    expect(result.status).toBe('out_of_scope');
    if (result.status !== 'out_of_scope') throw new Error('unexpected status');
    expect(result.reason).toBeTruthy();
  });

  it('(d) out-of-scope: does not leak existence information for out-of-scope path', () => {
    // We use a path that we know exists (os.tmpdir() itself) but is outside scope
    const outOfScope = path.join(os.tmpdir(), 'orr-else-oob-check');
    // We don't create it — the point is that the result must be 'out_of_scope'
    // regardless of whether the target exists.
    const result = pathContext.resolve({ filePath: outOfScope });

    expect(result.status).toBe('out_of_scope');
    // The response must not include an 'exists' field at all (structural check)
    expect(Object.keys(result)).not.toContain('exists');
    expect(Object.keys(result)).not.toContain('totalLines');
  });

  // ── (e) Nearest-match suggestion ─────────────────────────────────────────

  it('(e) near-miss path name: returns the similarly-named file as top match', () => {
    writeFile('src/core/ConfigLoader.ts', 'export class ConfigLoader {}');
    writeFile('src/core/EventStore.ts', 'export class EventStore {}');
    writeFile('src/plugins/bd.ts', 'export const bd = {};');

    const result = pathContext.resolve({ filePath: path.join(root, 'src/core/ConfigLodr.ts') });

    expect(result.status).toBe('not_found');
    if (result.status !== 'not_found') throw new Error('unexpected status');
    expect(result.nearestMatches.length).toBeGreaterThan(0);
    // The top match should be ConfigLoader.ts (most similar)
    expect(result.nearestMatches[0]).toContain('ConfigLoader');
  });

  it('(e) nearest matches are capped at PATH_CONTEXT_MAX_NEAR_MATCHES', () => {
    // Create many files
    for (let index = 1; index <= 20; index++) {
      writeFile(`src/Thing${index}.ts`, `export const v = ${index};`);
    }

    const result = pathContext.resolve({ filePath: path.join(root, 'src/Thingy.ts') });

    expect(result.status).toBe('not_found');
    if (result.status !== 'not_found') throw new Error('unexpected status');
    expect(result.nearestMatches.length).toBeLessThanOrEqual(PATH_CONTEXT_MAX_NEAR_MATCHES);
  });

  // ── (f) Exact file ────────────────────────────────────────────────────────

  it('(f) exact file: found with correct totalLines and valid range', () => {
    writeFile('src/exact.ts', makeLines(42));

    const filePath = path.join(root, 'src/exact.ts');
    const result = pathContext.resolve({ filePath });

    expect(result.status).toBe('found');
    if (result.status !== 'found') throw new Error('unexpected status');
    expect(result.exists).toBe(true);
    expect(result.totalLines).toBe(42);
    expect(result.validOffsetRange).toEqual({ min: 1, max: 42 });
    expect(result.requestedOffsetValid).toBeNull(); // no offset requested
    expect(result.correctedOffset).toBeNull();
    expect(result.slice).toBeNull();
    expect(result.canonicalRelativePath).toBeTruthy();
    // The canonical relative path should not contain root prefix
    expect(result.canonicalRelativePath).not.toEqual(filePath);
  });

  // ── (g) No offset given ───────────────────────────────────────────────────

  it('(g) no offset given: requestedOffsetValid is null', () => {
    writeFile('src/nooffset.ts', makeLines(7));

    const filePath = path.join(root, 'src/nooffset.ts');
    const result = pathContext.resolve({ filePath });

    expect(result.status).toBe('found');
    if (result.status !== 'found') throw new Error('unexpected status');
    expect(result.requestedOffsetValid).toBeNull();
    expect(result.correctedOffset).toBeNull();
    expect(result.slice).toBeNull();
  });

  // ── Best-effort: never throws ─────────────────────────────────────────────

  it('best-effort: does not throw for any input', () => {
    const inputs = [
      { filePath: '' },
      { filePath: '/' },
      { filePath: path.join(root, 'x'), offset: NaN },
      { filePath: path.join(root, 'x'), offset: Infinity },
    ];

    for (const input of inputs) {
      expect(() => pathContext.resolve(input as any)).not.toThrow();
    }
  });
});
