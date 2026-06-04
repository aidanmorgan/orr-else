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
  PATH_CONTEXT_MAX_SLICE_LINES,
  SKELETON_MAX_BYTES
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

  // ── (h) Skeleton mode — TypeScript fixture ────────────────────────────────

  it('(h1) skeleton:true on a .ts file returns signatures + imports + class names, bodies elided', () => {
    const tsSource = [
      `import { Foo } from './foo.js';`,
      ``,
      `export class MyService {`,
      `  private count = 0;`,
      ``,
      `  constructor(private readonly dep: Foo) {`,
      `    this.count = 42;`,
      `    console.log('init');`,
      `  }`,
      ``,
      `  public doWork(input: string): number {`,
      `    const result = input.length * this.count;`,
      `    return result;`,
      `  }`,
      ``,
      `  private helper(): void {`,
      `    console.log('secret logic here');`,
      `  }`,
      `}`,
    ].join('\n');

    writeFile('src/MyService.ts', tsSource);
    const filePath = path.join(root, 'src/MyService.ts');

    const result = pathContext.resolve({ filePath, skeleton: true });

    expect(result.status).toBe('found');
    if (result.status !== 'found') throw new Error('unexpected status');
    expect(result.skeletonFallback).toBe(false);
    expect(result.skeletonContent).not.toBeNull();

    const skeleton = result.skeletonContent!;

    // Import line must be present
    expect(skeleton).toContain(`import { Foo } from './foo.js'`);

    // Class declaration must be present
    expect(skeleton).toContain('MyService');
    expect(skeleton).toContain('class MyService');

    // Signature lines must be present
    expect(skeleton).toContain('doWork');
    expect(skeleton).toContain('helper');

    // Body content of doWork must be ABSENT
    expect(skeleton).not.toContain('result = input.length * this.count');

    // Body content of helper must be ABSENT
    expect(skeleton).not.toContain('secret logic here');

    // Body of constructor must be ABSENT (the 42 assignment)
    expect(skeleton).not.toContain('this.count = 42');

    // Elision placeholder must appear
    expect(skeleton).toContain('{ ... }');
  });

  it('(h2) skeleton:true on a .ts file with arrow function export elides body', () => {
    const tsSource = [
      `export const transform = (x: number): string => {`,
      `  const secret = x * 99;`,
      `  return String(secret);`,
      `};`,
      ``,
      `export interface Options {`,
      `  verbose: boolean;`,
      `  timeout: number;`,
      `}`,
    ].join('\n');

    writeFile('src/transform.ts', tsSource);
    const filePath = path.join(root, 'src/transform.ts');

    const result = pathContext.resolve({ filePath, skeleton: true });

    expect(result.status).toBe('found');
    if (result.status !== 'found') throw new Error('unexpected status');
    expect(result.skeletonContent).not.toBeNull();

    const skeleton = result.skeletonContent!;

    // The interface and export symbol must appear
    expect(skeleton).toContain('Options');
    expect(skeleton).toContain('transform');

    // Body of transform must be ABSENT
    expect(skeleton).not.toContain('secret = x * 99');
    expect(skeleton).not.toContain('String(secret)');
  });

  // ── (h) Skeleton mode — Python fixture ───────────────────────────────────

  it('(h3) skeleton:true on a .py file returns def signatures + imports, bodies elided', () => {
    const pySource = [
      `import os`,
      `from typing import List`,
      ``,
      `SECRET_KEY = 'do-not-expose'`,
      ``,
      `class DataProcessor:`,
      `    """Process data."""`,
      ``,
      `    def __init__(self, path: str) -> None:`,
      `        self.path = path`,
      `        self._cache = {}`,
      ``,
      `    def process(self, items: List[str]) -> List[str]:`,
      `        result = []`,
      `        for item in items:`,
      `            result.append(item.upper())`,
      `        return result`,
      ``,
      `def standalone_helper(x: int) -> int:`,
      `    hidden_logic = x ** 2`,
      `    return hidden_logic`,
    ].join('\n');

    writeFile('src/processor.py', pySource);
    const filePath = path.join(root, 'src/processor.py');

    const result = pathContext.resolve({ filePath, skeleton: true });

    expect(result.status).toBe('found');
    if (result.status !== 'found') throw new Error('unexpected status');
    expect(result.skeletonFallback).toBe(false);
    expect(result.skeletonContent).not.toBeNull();

    const skeleton = result.skeletonContent!;

    // Imports must be present
    expect(skeleton).toContain('import os');
    expect(skeleton).toContain('from typing import List');

    // Class and def signatures must be present
    expect(skeleton).toContain('DataProcessor');
    expect(skeleton).toContain('def __init__');
    expect(skeleton).toContain('def process');
    expect(skeleton).toContain('def standalone_helper');

    // Body content must be ABSENT
    expect(skeleton).not.toContain('self._cache = {}');
    expect(skeleton).not.toContain('hidden_logic = x ** 2');
    expect(skeleton).not.toContain("result.append(item.upper())");
  });

  // ── (h) Skeleton mode — data-format fallback ─────────────────────────────

  it('(h4) skeleton:true on a .json file is a no-op — skeletonFallback:true, body NOT stripped', () => {
    const jsonContent = JSON.stringify({
      name: 'test',
      secret: 'do-not-strip',
      nested: { a: 1, b: 2 }
    }, null, 2);

    writeFile('config.json', jsonContent);
    const filePath = path.join(root, 'config.json');

    const result = pathContext.resolve({ filePath, skeleton: true });

    expect(result.status).toBe('found');
    if (result.status !== 'found') throw new Error('unexpected status');

    // Skeleton must be flagged as a fallback (data format)
    expect(result.skeletonFallback).toBe(true);
    // skeletonContent must be null (no stripping happened)
    expect(result.skeletonContent).toBeNull();
  });

  it('(h5) skeleton:true on a .yaml file is a no-op — skeletonFallback:true', () => {
    const yamlContent = [
      `settings:`,
      `  model: gpt-5`,
      `  secret: should-not-be-stripped`,
    ].join('\n');

    writeFile('config.yaml', yamlContent);
    const filePath = path.join(root, 'config.yaml');

    const result = pathContext.resolve({ filePath, skeleton: true });

    expect(result.status).toBe('found');
    if (result.status !== 'found') throw new Error('unexpected status');
    expect(result.skeletonFallback).toBe(true);
    expect(result.skeletonContent).toBeNull();
  });

  it('(h6) skeleton:true on a .md file is a no-op — skeletonFallback:true', () => {
    const mdContent = '# Title\n\nSome paragraph text.\n\nAnother paragraph.';
    writeFile('README.md', mdContent);
    const filePath = path.join(root, 'README.md');

    const result = pathContext.resolve({ filePath, skeleton: true });

    expect(result.status).toBe('found');
    if (result.status !== 'found') throw new Error('unexpected status');
    expect(result.skeletonFallback).toBe(true);
    expect(result.skeletonContent).toBeNull();
  });

  // ── (h) Skeleton mode — output bounded by SKELETON_MAX_BYTES ─────────────

  it('(h7) skeleton output is bounded by SKELETON_MAX_BYTES', () => {
    // Generate a TypeScript file with many functions
    const lines: string[] = [];
    lines.push(`import { something } from './other.js';`);
    for (let i = 0; i < 200; i++) {
      lines.push(`export function func${i}(a: string, b: number): boolean {`);
      lines.push(`  const veryLongBodyVariable${i} = a.repeat(b);`);
      lines.push(`  const anotherLongVar${i} = veryLongBodyVariable${i}.toLowerCase();`);
      lines.push(`  return anotherLongVar${i}.length > 0;`);
      lines.push(`}`);
      lines.push('');
    }
    writeFile('src/bigFile.ts', lines.join('\n'));
    const filePath = path.join(root, 'src/bigFile.ts');

    const result = pathContext.resolve({ filePath, skeleton: true });

    expect(result.status).toBe('found');
    if (result.status !== 'found') throw new Error('unexpected status');
    expect(result.skeletonContent).not.toBeNull();

    // The skeleton bytes must be at or below the cap
    const byteLength = Buffer.byteLength(result.skeletonContent!, 'utf8');
    expect(byteLength).toBeLessThanOrEqual(SKELETON_MAX_BYTES);
  });

  // ── (h) Skeleton mode — scope check still enforced ───────────────────────

  it('(h8) skeleton:true with out-of-scope path still returns out_of_scope — no content leak', () => {
    const outsidePath = path.join(os.tmpdir(), `outside-skeleton-test-${Date.now()}.ts`);

    const result = pathContext.resolve({ filePath: outsidePath, skeleton: true });

    expect(result.status).toBe('out_of_scope');
    if (result.status !== 'out_of_scope') throw new Error('unexpected status');
    // Must not have any skeleton/content fields
    expect(Object.keys(result)).not.toContain('skeletonContent');
    expect(Object.keys(result)).not.toContain('totalLines');
    expect(result.reason).toBeTruthy();
  });

  // ── (h) Existing behavior unaffected when skeleton not set ────────────────

  it('(h9) without skeleton flag, skeletonContent and skeletonFallback are null/false', () => {
    writeFile('src/plain.ts', `export const x = 1;\n`);
    const filePath = path.join(root, 'src/plain.ts');

    const result = pathContext.resolve({ filePath });

    expect(result.status).toBe('found');
    if (result.status !== 'found') throw new Error('unexpected status');
    expect(result.skeletonContent).toBeNull();
    expect(result.skeletonFallback).toBe(false);
  });

  // ── M1: single-line body elision ─────────────────────────────────────────

  it('(M1) single-line function body is ABSENT and placeholder present', () => {
    // Both open and close brace on the same signature line (net == 0).
    // Methods inside a class use access modifiers so they match METHOD_RE.
    const tsSource = [
      `export function add(a: number, b: number): number { return a + b; }`,
      ``,
      `export function getSecret(): string { return 'do-not-expose'; }`,
      ``,
      `export class Calc {`,
      `  public double(x: number): number { return x * 2; }`,
      `}`,
    ].join('\n');

    writeFile('src/Calc.ts', tsSource);
    const filePath = path.join(root, 'src/Calc.ts');

    const result = pathContext.resolve({ filePath, skeleton: true });

    expect(result.status).toBe('found');
    if (result.status !== 'found') throw new Error('unexpected status');
    expect(result.skeletonContent).not.toBeNull();

    const skeleton = result.skeletonContent!;

    // Signatures must be present
    expect(skeleton).toContain('add');
    expect(skeleton).toContain('getSecret');
    expect(skeleton).toContain('double');

    // Bodies must be ABSENT
    expect(skeleton).not.toContain('return a + b');
    expect(skeleton).not.toContain('do-not-expose');
    expect(skeleton).not.toContain('return x * 2');

    // Elision placeholder must appear instead
    expect(skeleton).toContain('{ ... }');
  });

  // ── M2: braces inside comments must not desync the counter ───────────────

  it('(M2) braces inside // line comments do NOT break body elision', () => {
    const tsSource = [
      `export function process(x: number): number {`,
      `  // closing } here should NOT exit the body`,
      `  const inner = x + 1;`,
      `  return inner;`,
      `}`,
      ``,
      `export function safe(): void {`,
      `  // opening { brace inside comment`,
      `  console.log('real body');`,
      `}`,
    ].join('\n');

    writeFile('src/CommentBraces.ts', tsSource);
    const filePath = path.join(root, 'src/CommentBraces.ts');

    const result = pathContext.resolve({ filePath, skeleton: true });

    expect(result.status).toBe('found');
    if (result.status !== 'found') throw new Error('unexpected status');
    expect(result.skeletonContent).not.toBeNull();

    const skeleton = result.skeletonContent!;

    // Signatures must be present
    expect(skeleton).toContain('process');
    expect(skeleton).toContain('safe');

    // Body content must be ABSENT — if M2 is broken, 'inner' or 'real body'
    // leaks because the comment brace triggers a premature stack pop
    expect(skeleton).not.toContain('inner = x + 1');
    expect(skeleton).not.toContain("real body");

    // Placeholder must be present
    expect(skeleton).toContain('{ ... }');
  });

  it('(M2) braces inside /* */ block comments do NOT break body elision', () => {
    const tsSource = [
      `export function compute(n: number): number {`,
      `  /* the closing brace } here is inside a block comment */`,
      `  const secret = n * 7;`,
      `  /* another { open brace in a comment */`,
      `  return secret;`,
      `}`,
    ].join('\n');

    writeFile('src/BlockComment.ts', tsSource);
    const filePath = path.join(root, 'src/BlockComment.ts');

    const result = pathContext.resolve({ filePath, skeleton: true });

    expect(result.status).toBe('found');
    if (result.status !== 'found') throw new Error('unexpected status');
    expect(result.skeletonContent).not.toBeNull();

    const skeleton = result.skeletonContent!;

    expect(skeleton).toContain('compute');

    // Body content must be ABSENT
    expect(skeleton).not.toContain('secret = n * 7');
    expect(skeleton).not.toContain('return secret');

    expect(skeleton).toContain('{ ... }');
  });

  it('(R1) operational .pi paths resolve from the project root while cwd is the bead worktree', () => {
    const projectRoot = path.join(root, 'project');
    const worktreeRoot = path.join(projectRoot, 'worktrees', 'bd-1');
    const artifactPath = path.join(projectRoot, '.pi', 'artifacts', 'bd-1', 'plan-contract.json');
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.mkdirSync(worktreeRoot, { recursive: true });
    fs.writeFileSync(artifactPath, '{"kind":"project-root-artifact"}\n');

    const previousCwd = process.cwd();
    process.env[EnvVars.PROJECT_ROOT] = projectRoot;
    process.env[EnvVars.WORKTREE_PATH] = worktreeRoot;
    try {
      process.chdir(worktreeRoot);
      const result = new PathContext(projectRoot).resolve({
        filePath: '.pi/artifacts/bd-1/plan-contract.json',
        offset: 1,
        limit: 1
      });

      expect(result.status).toBe('found');
      if (result.status !== 'found') throw new Error('unexpected status');
      expect(result.canonicalRelativePath).toBe(path.join('.pi', 'artifacts', 'bd-1', 'plan-contract.json'));
      expect(result.slice).toContain('project-root-artifact');
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('(R2) ordinary relative source paths still prefer the active bead worktree', () => {
    const projectRoot = path.join(root, 'project');
    const worktreeRoot = path.join(projectRoot, 'worktrees', 'bd-2');
    const relativeSourcePath = path.join('packages', 'example.py');
    fs.mkdirSync(path.join(projectRoot, 'packages'), { recursive: true });
    fs.mkdirSync(path.join(worktreeRoot, 'packages'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, relativeSourcePath), 'origin = "project"\n');
    fs.writeFileSync(path.join(worktreeRoot, relativeSourcePath), 'origin = "worktree"\n');

    const previousCwd = process.cwd();
    process.env[EnvVars.PROJECT_ROOT] = projectRoot;
    process.env[EnvVars.WORKTREE_PATH] = worktreeRoot;
    try {
      process.chdir(worktreeRoot);
      const result = new PathContext(projectRoot).resolve({
        filePath: relativeSourcePath,
        offset: 1,
        limit: 1
      });

      expect(result.status).toBe('found');
      if (result.status !== 'found') throw new Error('unexpected status');
      expect(result.canonicalRelativePath).toBe(relativeSourcePath);
      expect(result.slice).toContain('worktree');
      expect(result.slice).not.toContain('project');
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('(R3) a source path that exists ONLY in the project root must NOT cross into it from a worktree', () => {
    // Boundary-crossing regression (d5b2/g9ye): a teammate worktree that is
    // missing a source file must NOT silently read the project-root copy.
    const projectRoot = path.join(root, 'project');
    const worktreeRoot = path.join(projectRoot, 'worktrees', 'bd-3');
    const relativeSourcePath = path.join('packages', 'only_in_project.py');
    fs.mkdirSync(path.join(projectRoot, 'packages'), { recursive: true });
    fs.mkdirSync(worktreeRoot, { recursive: true });
    // File exists ONLY in the project root, NOT in the worktree.
    fs.writeFileSync(path.join(projectRoot, relativeSourcePath), 'origin = "project"\n');

    const env = {
      env: (name: string): string | undefined => {
        if (name === EnvVars.PROJECT_ROOT) return projectRoot;
        if (name === EnvVars.WORKTREE_PATH) return worktreeRoot;
        return undefined;
      }
    };
    const result = new PathContext(projectRoot, env).resolve({ filePath: relativeSourcePath, offset: 1, limit: 1 });
    // Must resolve to the worktree (where the file is absent) → not_found.
    // It must NEVER report 'found' by reading the project-root copy.
    expect(result.status).toBe('not_found');
  });

  it('(R4) resolution uses the injected RuntimeEnvironment, not process.env', () => {
    const projectRoot = path.join(root, 'project');
    const worktreeRoot = path.join(projectRoot, 'worktrees', 'bd-4');
    const rel = path.join('src', 'app.py');
    fs.mkdirSync(path.join(worktreeRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(worktreeRoot, rel), 'x = "in worktree"\n');

    // process.env points WORKTREE_PATH elsewhere; the injected env must win.
    const previousWorktree = process.env[EnvVars.WORKTREE_PATH];
    process.env[EnvVars.WORKTREE_PATH] = path.join(root, 'somewhere-else');
    try {
      const env = {
        env: (name: string): string | undefined => {
          if (name === EnvVars.PROJECT_ROOT) return projectRoot;
          if (name === EnvVars.WORKTREE_PATH) return worktreeRoot;
          return undefined;
        }
      };
      const result = new PathContext(projectRoot, env).resolve({ filePath: rel, offset: 1, limit: 1 });
      expect(result.status).toBe('found');
      if (result.status !== 'found') throw new Error('unexpected status');
      expect(result.slice).toContain('in worktree');
    } finally {
      if (previousWorktree === undefined) delete process.env[EnvVars.WORKTREE_PATH];
      else process.env[EnvVars.WORKTREE_PATH] = previousWorktree;
    }
  });

  // ── S1/S2: unknown-language and no-extension files → skeletonFallback ────

  it('(S1) Go source file (.go) → skeletonFallback:true, no body-assignment leaked', () => {
    // A Go file with in-body variable assignments that must NOT appear in output
    const goSource = [
      `package main`,
      ``,
      `import "fmt"`,
      ``,
      `func main() {`,
      `\tvar secret = "should-not-leak"`,
      `\tfmt.Println(secret)`,
      `}`,
    ].join('\n');

    writeFile('src/main.go', goSource);
    const filePath = path.join(root, 'src/main.go');

    const result = pathContext.resolve({ filePath, skeleton: true });

    expect(result.status).toBe('found');
    if (result.status !== 'found') throw new Error('unexpected status');

    // Unknown language → safe no-op
    expect(result.skeletonFallback).toBe(true);
    expect(result.skeletonContent).toBeNull();
  });

  it('(S2) no-extension file (Dockerfile) → skeletonFallback:true, no body content leaked', () => {
    const dockerfileSource = [
      `FROM node:20`,
      ``,
      `WORKDIR /app`,
      ``,
      `RUN npm install`,
      ``,
      `ENV SECRET_KEY=do-not-leak`,
      ``,
      `CMD ["node", "index.js"]`,
    ].join('\n');

    writeFile('Dockerfile', dockerfileSource);
    const filePath = path.join(root, 'Dockerfile');

    const result = pathContext.resolve({ filePath, skeleton: true });

    expect(result.status).toBe('found');
    if (result.status !== 'found') throw new Error('unexpected status');

    // No extension → unknown language → safe no-op
    expect(result.skeletonFallback).toBe(true);
    expect(result.skeletonContent).toBeNull();
  });
});
