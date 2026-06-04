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
import { skeletons } from '../src/contract.js';

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

  // ── (h) Skeleton mode — delegates to the harness-owned `skeletons` registry ─
  //
  // The harness ships NO built-in extractors (0yt5.3). read_path_context
  // dispatches by lowercased file extension to the `skeletons` registry; when
  // an extractor is registered for the ext it is used, otherwise the RAW file
  // content is returned (safe no-op).

  it('(h1) skeleton:true routes a registered .xyz extension through the registry extractor', () => {
    // Register a fake extractor for a fresh extension that no other test/extension uses.
    const ext = '.xyz';
    skeletons.register(ext, (source) => `SKELETON-OF:${source.split('\n')[0]}`);
    try {
      writeFile('src/sample.xyz', 'first-line-marker\nbody-should-not-appear\n');
      const filePath = path.join(root, 'src/sample.xyz');

      const result = pathContext.resolve({ filePath, skeleton: true });

      expect(result.status).toBe('found');
      if (result.status !== 'found') throw new Error('unexpected status');
      // An extractor IS registered → not a fallback.
      expect(result.skeletonFallback).toBe(false);
      expect(result.skeletonContent).not.toBeNull();

      const skeleton = result.skeletonContent!;
      // The registered extractor produced the skeleton.
      expect(skeleton).toBe('SKELETON-OF:first-line-marker');
      // The raw body was NOT passed through verbatim.
      expect(skeleton).not.toContain('body-should-not-appear');
    } finally {
      // Reset registry to avoid cross-test leakage (overwrite with an identity
      // no-op; the contract Registry has no delete, so we neutralize the entry).
      skeletons.register(ext, (source) => source);
    }
  });

  it('(h2) skeleton output from a registered extractor is bounded by SKELETON_MAX_BYTES', () => {
    const ext = '.huge';
    // Extractor that returns far more than the cap.
    skeletons.register(ext, () => 'x\n'.repeat(SKELETON_MAX_BYTES));
    try {
      writeFile('src/big.huge', 'seed');
      const filePath = path.join(root, 'src/big.huge');

      const result = pathContext.resolve({ filePath, skeleton: true });

      expect(result.status).toBe('found');
      if (result.status !== 'found') throw new Error('unexpected status');
      expect(result.skeletonContent).not.toBeNull();

      const byteLength = Buffer.byteLength(result.skeletonContent!, 'utf8');
      expect(byteLength).toBeLessThanOrEqual(SKELETON_MAX_BYTES + 64); // + truncation marker
      expect(result.skeletonContent).toContain('[skeleton truncated');
    } finally {
      skeletons.register(ext, (source) => source);
    }
  });

  it('(h-excl) skeleton is mutually exclusive with offset/limit — offset is ignored when skeleton:true', () => {
    const ext = '.xclr';
    skeletons.register(ext, (source) => `SKELETON-OF:${source.split('\n')[0]}`);
    try {
      writeFile('src/excl.xclr', 'line1\nline2\nline3\nline4\n');
      const filePath = path.join(root, 'src/excl.xclr');

      // Pass BOTH skeleton and an out-of-range offset + a limit. Per the
      // documented contract, skeleton wins and offset/limit are ignored: no
      // slice, no offset validation, no corrected-offset hint.
      const result = pathContext.resolve({ filePath, skeleton: true, offset: 999, limit: 2 });

      expect(result.status).toBe('found');
      if (result.status !== 'found') throw new Error('unexpected status');
      // Skeleton is produced.
      expect(result.skeletonContent).toBe('SKELETON-OF:line1');
      // offset/limit are ignored — none of the slice/offset fields are computed.
      expect(result.slice).toBeNull();
      expect(result.requestedOffsetValid).toBeNull();
      expect(result.correctedOffset).toBeNull();
    } finally {
      skeletons.register(ext, (source) => source);
    }
  });

  // ── (h) NEGATIVE: no extractor registered → RAW content, no crash ─────────

  it('(h3) skeleton:true with NO registered extractor returns the RAW file content (no crash)', () => {
    // A unique extension that NO extractor is registered for.
    const rawBody = [
      `func main() {`,
      `\tvar secret = "kept-verbatim"`,
      `}`,
    ].join('\n');

    writeFile('src/main.noskel', rawBody);
    const filePath = path.join(root, 'src/main.noskel');

    const result = pathContext.resolve({ filePath, skeleton: true });

    expect(result.status).toBe('found');
    if (result.status !== 'found') throw new Error('unexpected status');

    // No extractor → safe no-op fallback, RAW content returned (no body stripping).
    expect(result.skeletonFallback).toBe(true);
    expect(result.skeletonContent).toBe(rawBody);
    expect(result.skeletonContent).toContain('kept-verbatim');
  });

  it('(h4) skeleton:true on a no-extension file with no extractor returns RAW content', () => {
    const rawBody = [
      `FROM node:20`,
      `ENV SECRET_KEY=kept-verbatim`,
    ].join('\n');

    writeFile('Dockerfile', rawBody);
    const filePath = path.join(root, 'Dockerfile');

    const result = pathContext.resolve({ filePath, skeleton: true });

    expect(result.status).toBe('found');
    if (result.status !== 'found') throw new Error('unexpected status');
    expect(result.skeletonFallback).toBe(true);
    expect(result.skeletonContent).toBe(rawBody);
  });

  // ── (h) Skeleton mode — scope check still enforced ───────────────────────

  it('(h5) skeleton:true with out-of-scope path still returns out_of_scope — no content leak', () => {
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

  it('(h6) without skeleton flag, skeletonContent and skeletonFallback are null/false', () => {
    writeFile('src/plain.ts', `export const x = 1;\n`);
    const filePath = path.join(root, 'src/plain.ts');

    const result = pathContext.resolve({ filePath });

    expect(result.status).toBe('found');
    if (result.status !== 'found') throw new Error('unexpected status');
    expect(result.skeletonContent).toBeNull();
    expect(result.skeletonFallback).toBe(false);
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

});
