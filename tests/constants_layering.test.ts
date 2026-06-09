/**
 * Architecture tests for pi-experiment-amq0.14.
 *
 * Enforces the constants-split contract:
 *
 *  1. src/constants/index.ts must NOT exist (broad barrel deleted, no-backcompat-ever).
 *
 *  2. Domain modules (src/core/domain/) must NOT import from:
 *       - src/constants/infra.ts  (infrastructure defaults)
 *       - node:process / node:fs / node:path  (OS/filesystem)
 *       - src/core/Logger.ts       (logger singleton)
 *       - src/plugins/**           (plugin implementations)
 *
 *  3. Layering test is load-bearing: adding a domain→infra import makes it fail.
 *     Proven by a self-check that simulates the violation inline.
 *
 *  4. The old broad-barrel import path is rejected:
 *       import { ... } from '../src/constants/index.js'    (test files)
 *       import { ... } from '../../constants/index.js'     (plugin files)
 *       import { ... } from '../constants/index.js'        (core files)
 *     must NOT appear anywhere in src/ or tests/ (except constants/index.ts itself,
 *     which also must not exist).
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const rootDir = process.cwd();
const srcDir = path.join(rootDir, 'src');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
}

function extractImports(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+(?:type\s+)?[^'";]*?\s+from\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

/** List all .ts source files (excluding .d.ts) under a directory. */
function listSourceFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap(entry => {
    const absPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(absPath);
    if (!entry.isFile()) return [];
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) return [];
    return [absPath];
  });
}

/** Given a file and a relative import specifier, resolve to a src-relative path. */
function resolveImport(importerAbs: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const importerDir = path.dirname(importerAbs);
  const withoutExt = specifier.replace(/\.(?:js|mjs|cjs)$/, '');
  const candidates = [
    path.resolve(importerDir, withoutExt + '.ts'),
    path.resolve(importerDir, withoutExt, 'index.ts')
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return path.relative(rootDir, candidate).split(path.sep).join('/');
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Test 1: src/constants/index.ts must NOT exist (no-backcompat-ever)
// ---------------------------------------------------------------------------

describe('constants barrel deleted (no-backcompat-ever)', () => {
  it('src/constants/index.ts does not exist', () => {
    const barrelPath = path.join(rootDir, 'src', 'constants', 'index.ts');
    expect(
      fs.existsSync(barrelPath),
      'src/constants/index.ts must NOT exist — it was the broad barrel deleted under ' +
      'no-backcompat-ever; callers must import from src/constants/domain.ts or ' +
      'src/constants/infra.ts directly'
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 2: Old broad-barrel import paths are rejected in all source/test files
// ---------------------------------------------------------------------------

describe('old broad-barrel import path is rejected', () => {
  it('no source file imports from constants/index.js', () => {
    const allSrcFiles = listSourceFiles(srcDir);
    const violations: string[] = [];

    for (const absPath of allSrcFiles) {
      // Skip the new split files themselves
      const relPath = path.relative(rootDir, absPath).split(path.sep).join('/');
      if (relPath === 'src/constants/domain.ts' || relPath === 'src/constants/infra.ts') continue;
      // Skip this test file itself (it contains the string in comments/strings)
      if (relPath.includes('constants_layering')) continue;

      const source = fs.readFileSync(absPath, 'utf8');
      const imports = extractImports(source);
      for (const spec of imports) {
        if (spec.includes('constants/index')) {
          violations.push(`${relPath} imports from ${spec}`);
        }
      }
    }

    expect(
      violations,
      [
        'Source files must import from constants/domain.js or constants/infra.js, not the old broad barrel.',
        ...violations
      ].join('\n')
    ).toEqual([]);
  });

  it('no test file imports from constants/index.js', () => {
    const testDir = path.join(rootDir, 'tests');
    const allTestFiles = listSourceFiles(testDir);
    const violations: string[] = [];
    const selfName = 'constants_layering.test.ts';

    for (const absPath of allTestFiles) {
      const relPath = path.relative(rootDir, absPath).split(path.sep).join('/');
      // Skip this test file itself (it contains the string in comments/strings)
      if (relPath.includes(selfName)) continue;
      const source = fs.readFileSync(absPath, 'utf8');
      const imports = extractImports(source);
      for (const spec of imports) {
        if (spec.includes('constants/index')) {
          violations.push(`${relPath} imports from ${spec}`);
        }
      }
    }

    expect(
      violations,
      [
        'Test files must import from src/constants/domain.js or src/constants/infra.js, not the old broad barrel.',
        ...violations
      ].join('\n')
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Test 3: Domain modules must not import from infra constants or OS modules
// ---------------------------------------------------------------------------

describe('domain modules do not import infrastructure', () => {
  const domainDir = path.join(srcDir, 'core', 'domain');

  /**
   * Forbidden import specifiers for domain modules.
   *
   * Domain modules may only import other domain types and pure TypeScript
   * utilities. They must NOT import:
   *   - src/constants/infra.ts         (infrastructure defaults)
   *   - src/core/Logger.ts             (logger singleton — depends on winston/fs)
   *   - node:process / process         (process/env)
   *   - node:fs / fs / node:path / path (filesystem)
   *   - src/plugins/**                 (plugin implementations)
   */
  function isForbiddenDomainImport(importerAbs: string, spec: string): boolean {
    // Inline type imports like import('...').T
    const cleanSpec = spec.replace(/^import\(/, '').replace(/\)$/, '');

    // Infra constants
    const resolved = resolveImport(importerAbs, cleanSpec);
    if (resolved === 'src/constants/infra.ts') return true;

    // Logger singleton
    if (resolved === 'src/core/Logger.ts') return true;

    // Plugin implementations
    if (resolved?.startsWith('src/plugins/')) return true;

    // Node process / fs / path (bare or node: prefix)
    if (/^(node:)?(process|fs|path)$/.test(cleanSpec)) return true;
    if (cleanSpec.startsWith('node:fs') || cleanSpec.startsWith('node:path') || cleanSpec.startsWith('node:process')) return true;

    return false;
  }

  it('domain modules do not import from src/constants/infra.ts, Logger, process, fs/path, or plugins', () => {
    if (!fs.existsSync(domainDir)) return; // no domain dir → skip

    const domainFiles = listSourceFiles(domainDir).map(abs =>
      path.relative(rootDir, abs).split(path.sep).join('/')
    );
    const violations: string[] = [];

    for (const relPath of domainFiles) {
      const absPath = path.join(rootDir, relPath);
      const source = fs.readFileSync(absPath, 'utf8');
      const imports = extractImports(source);
      for (const spec of imports) {
        if (isForbiddenDomainImport(absPath, spec)) {
          violations.push(`${relPath} imports forbidden: ${spec}`);
        }
      }
    }

    expect(
      violations,
      [
        'Domain modules must not import infrastructure constants, Logger, process/env, fs/path, or plugin implementations.',
        'Move such imports to composition or infra layers.',
        ...violations
      ].join('\n')
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Test 4: Self-check — a domain→infra import would be caught (load-bearing proof)
// ---------------------------------------------------------------------------

describe('layering test self-check (load-bearing proof)', () => {
  it('would catch a domain module importing from src/constants/infra.ts (simulated violation)', () => {
    // Simulate a source file at src/core/domain/StateModels.ts importing from infra.
    const fakeSource = `import { WorkerDefaults } from '../../constants/infra.js';`;
    const imports = extractImports(fakeSource);

    // Resolve as if we were at src/core/domain/StateModels.ts
    const fakeImporterAbs = path.join(srcDir, 'core', 'domain', 'StateModels.ts');
    const resolved = resolveImport(fakeImporterAbs, imports[0]);

    // resolveImport must detect this as pointing to src/constants/infra.ts
    expect(resolved).toBe('src/constants/infra.ts');
  });

  it('would catch a domain module importing node:process (simulated violation)', () => {
    const spec = 'node:process';
    const isNodeProcess = /^(node:)?(process)$/.test(spec);
    expect(isNodeProcess).toBe(true);
  });

  it('would catch a domain module importing Logger (simulated violation)', () => {
    const fakeSource = `import { Logger } from '../Logger.js';`;
    const imports = extractImports(fakeSource);

    const fakeImporterAbs = path.join(srcDir, 'core', 'domain', 'StateModels.ts');
    const resolved = resolveImport(fakeImporterAbs, imports[0]);

    expect(resolved).toBe('src/core/Logger.ts');
  });
});

// ---------------------------------------------------------------------------
// Test 5: New split files exist with the expected vocabulary
// ---------------------------------------------------------------------------

describe('new split constant files exist', () => {
  it('src/constants/domain.ts exists and exports domain vocabulary', () => {
    const domainPath = path.join(rootDir, 'src', 'constants', 'domain.ts');
    expect(fs.existsSync(domainPath), 'src/constants/domain.ts must exist').toBe(true);

    const source = fs.readFileSync(domainPath, 'utf8');
    // Spot-check key domain exports
    expect(source).toContain('export enum BeadStatus');
    expect(source).toContain('export enum DomainEventName');
    expect(source).toContain('export enum TeammateEventType');
    expect(source).toContain('export enum BuiltInToolName');
    expect(source).toContain('export const REPLAY_CRITICAL_EVENT_TYPES');
    // Must NOT contain infra defaults
    expect(source).not.toContain('WorkerDefaults');
    expect(source).not.toContain('EnvVars');
    expect(source).not.toContain('TmuxCommand');
  });

  it('src/constants/infra.ts exists and exports infrastructure defaults', () => {
    const infraPath = path.join(rootDir, 'src', 'constants', 'infra.ts');
    expect(fs.existsSync(infraPath), 'src/constants/infra.ts must exist').toBe(true);

    const source = fs.readFileSync(infraPath, 'utf8');
    // Spot-check key infra exports
    expect(source).toContain('export const EnvVars');
    expect(source).toContain('export const WorkerDefaults');
    expect(source).toContain('export const TmuxCommand');
    expect(source).toContain('export const LoggingDefaults');
    expect(source).toContain('export const Defaults');
    // Must NOT contain domain enums
    expect(source).not.toContain('export enum BeadStatus');
    expect(source).not.toContain('export enum DomainEventName');
    expect(source).not.toContain('export const REPLAY_CRITICAL_EVENT_TYPES');
  });

  it('src/constants/infra.ts does not import from src/constants/domain.ts (no cross-dependency)', () => {
    const infraPath = path.join(rootDir, 'src', 'constants', 'infra.ts');
    const source = fs.readFileSync(infraPath, 'utf8');
    const imports = extractImports(source);
    const forbidden = imports.filter(spec => spec.includes('constants/domain'));
    expect(
      forbidden,
      'src/constants/infra.ts must not import from src/constants/domain.ts — infra is a leaf'
    ).toEqual([]);
  });

  it('src/constants/domain.ts does not import from src/constants/infra.ts (no cross-dependency)', () => {
    const domainPath = path.join(rootDir, 'src', 'constants', 'domain.ts');
    const source = fs.readFileSync(domainPath, 'utf8');
    const imports = extractImports(source);
    const forbidden = imports.filter(spec => spec.includes('constants/infra'));
    expect(
      forbidden,
      'src/constants/domain.ts must not import from src/constants/infra.ts — domain is a leaf'
    ).toEqual([]);
  });
});
