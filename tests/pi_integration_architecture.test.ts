/**
 * Architecture tests for pi-experiment-amq0.13.
 *
 * Enforces the module-boundary contracts created by the PiIntegration split:
 *
 *  1. TemplateResolver.ts is pure — no fs, crypto, yaml, Pi SDK, or process
 *     imports allowed.  Project-tool modules import ONLY the template module.
 *
 *  2. Project-tool modules (src/plugins/projectTools/) must NOT import from
 *     PromptProvenanceService or WorkerResourceResolver.  Those services are
 *     consumed directly by extension/composition-layer callers.
 *
 *  3. ToolCallPathFactory imports only TemplateResolver, not the
 *     provenance/worker-resource services.
 *
 *  4. src/core/PiIntegration.ts must NOT exist — the re-export facade was
 *     deleted (no-backcompat-ever); all callers import from the owning modules.
 *
 * These tests walk the real source files so they will catch regressions.
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
    /\bexport\s+(?:type\s+)?[^'";]*?\s+from\s+['"]([^'"]+)['"]/g
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
// Test 1: TemplateResolver.ts has no IO/crypto/yaml/Pi/process imports
// ---------------------------------------------------------------------------

describe('TemplateResolver purity', () => {
  const templateResolverPath = 'src/core/TemplateResolver.ts';

  it('TemplateResolver.ts has no node:fs, fs, crypto, yaml, or Pi SDK imports', () => {
    const source = readSource(templateResolverPath);
    const imports = extractImports(source);

    const forbidden = imports.filter(spec =>
      spec === 'fs' ||
      spec === 'node:fs' ||
      spec.startsWith('fs/') ||
      spec === 'crypto' ||
      spec === 'node:crypto' ||
      spec === 'yaml' ||
      spec.includes('pi-coding-agent') ||
      spec.includes('@earendil-works/pi')
    );

    expect(
      forbidden,
      `TemplateResolver.ts must be purely computational with no IO/crypto/yaml/Pi imports. Found: ${forbidden.join(', ')}`
    ).toEqual([]);
  });

  it('TemplateResolver.ts has no process.env or process.cwd() reads', () => {
    const source = readSource(templateResolverPath);
    // Allow the word "process" only in comments.
    const linesWithProcess = source
      .split('\n')
      .filter(line => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
      .filter(line => /\bprocess\s*\./.test(line));

    expect(
      linesWithProcess,
      `TemplateResolver.ts must not access process.env or process.cwd. Found lines: ${linesWithProcess.join(' | ')}`
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Test 2: Project-tool modules import ONLY TemplateResolver (not
//         PromptProvenanceService or WorkerResourceResolver)
// ---------------------------------------------------------------------------

describe('project-tool modules template imports', () => {
  const projectToolsDir = path.join(srcDir, 'plugins', 'projectTools');
  const projectToolFiles = listSourceFiles(projectToolsDir).map(abs =>
    path.relative(rootDir, abs).split(path.sep).join('/')
  );

  it('project-tool modules do NOT import from PromptProvenanceService', () => {
    const violations: string[] = [];
    for (const relPath of projectToolFiles) {
      const source = readSource(relPath);
      const imports = extractImports(source);
      for (const spec of imports) {
        const resolved = resolveImport(path.join(rootDir, relPath), spec);
        if (resolved === 'src/core/PromptProvenanceService.ts') {
          violations.push(`${relPath} imports from PromptProvenanceService`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('project-tool modules do NOT import from WorkerResourceResolver', () => {
    const violations: string[] = [];
    for (const relPath of projectToolFiles) {
      const source = readSource(relPath);
      const imports = extractImports(source);
      for (const spec of imports) {
        const resolved = resolveImport(path.join(rootDir, relPath), spec);
        if (resolved === 'src/core/WorkerResourceResolver.ts') {
          violations.push(`${relPath} imports from WorkerResourceResolver`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('project-tool modules that import template types use TemplateResolver not a facade', () => {
    // The modules that need TemplateContext/resolveTemplateString must import
    // from TemplateResolver.ts directly — there is no re-export facade.
    const templateUsers = ['contextHelpers.ts', 'pathNormalization.ts', 'commandExecutor.ts', 'mcpExecutor.ts', 'types.ts'];
    const violations: string[] = [];

    for (const fileName of templateUsers) {
      const relPath = `src/plugins/projectTools/${fileName}`;
      if (!fs.existsSync(path.join(rootDir, relPath))) continue;
      const source = readSource(relPath);
      const imports = extractImports(source);
      for (const spec of imports) {
        const resolved = resolveImport(path.join(rootDir, relPath), spec);
        if (resolved === 'src/core/PromptProvenanceService.ts' || resolved === 'src/core/WorkerResourceResolver.ts') {
          violations.push(`${relPath} must not import from ${resolved}`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Test 3: ToolCallPathFactory imports TemplateResolver not the split services
// ---------------------------------------------------------------------------

describe('ToolCallPathFactory imports', () => {
  const factoryPath = 'src/core/ToolCallPathFactory.ts';

  it('ToolCallPathFactory does not import from PromptProvenanceService or WorkerResourceResolver', () => {
    const source = readSource(factoryPath);
    const imports = extractImports(source);

    const forbidden = imports.filter(spec => {
      const resolved = resolveImport(path.join(rootDir, factoryPath), spec);
      return resolved === 'src/core/PromptProvenanceService.ts' || resolved === 'src/core/WorkerResourceResolver.ts';
    });

    expect(
      forbidden,
      'ToolCallPathFactory must not import from PromptProvenanceService or WorkerResourceResolver'
    ).toEqual([]);
  });

  it('ToolCallPathFactory imports TemplateResolver.ts for template types', () => {
    const source = readSource(factoryPath);
    const imports = extractImports(source);

    const templateImports = imports.filter(spec => {
      const resolved = resolveImport(path.join(rootDir, factoryPath), spec);
      return resolved === 'src/core/TemplateResolver.ts';
    });

    expect(
      templateImports.length,
      'ToolCallPathFactory must import from TemplateResolver.ts'
    ).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Test 4: Architecture test self-check — adding a forbidden import should fail
// ---------------------------------------------------------------------------

describe('architecture test self-check (fake-port test)', () => {
  it('would detect a project-tool importing from PromptProvenanceService (simulated violation)', () => {
    // Simulate a source file that imports PromptProvenanceService.
    const fakeSource = `import { resolvePromptProvenance } from '../../core/PromptProvenanceService.js';`;
    const imports = extractImports(fakeSource);

    // Resolve as if we were a file at src/plugins/projectTools/commandExecutor.ts
    const fakeImporterAbs = path.join(srcDir, 'plugins', 'projectTools', 'commandExecutor.ts');
    const resolved = resolveImport(fakeImporterAbs, imports[0]);

    // The resolved path points to PromptProvenanceService.ts — the guard would fire.
    expect(resolved).toBe('src/core/PromptProvenanceService.ts');
  });

  it('would detect a project-tool importing from WorkerResourceResolver (simulated violation)', () => {
    const fakeSource = `import { resolvePiSkillPathsForState } from '../../core/WorkerResourceResolver.js';`;
    const imports = extractImports(fakeSource);

    const fakeImporterAbs = path.join(srcDir, 'plugins', 'projectTools', 'commandExecutor.ts');
    const resolved = resolveImport(fakeImporterAbs, imports[0]);

    expect(resolved).toBe('src/core/WorkerResourceResolver.ts');
  });
});

// ---------------------------------------------------------------------------
// Test 5: PiIntegration.ts must NOT exist (no-backcompat-ever)
// ---------------------------------------------------------------------------

describe('PiIntegration re-export facade is deleted', () => {
  it('src/core/PiIntegration.ts does not exist', () => {
    const piIntegrationPath = path.join(rootDir, 'src', 'core', 'PiIntegration.ts');
    expect(
      fs.existsSync(piIntegrationPath),
      'src/core/PiIntegration.ts must NOT exist — it was a re-export facade deleted under no-backcompat-ever; callers must import from the owning modules directly'
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 6: RuntimeServices compat shims are gone (0iyt no-backcompat-ever)
// ---------------------------------------------------------------------------

describe('RuntimeServices backward-compat shims are removed', () => {
  const runtimeServicesPath = 'src/core/RuntimeServices.ts';
  const createRuntimeServicesPath = 'src/composition/createRuntimeServices.ts';

  it('RuntimeServices.ts does not re-export WorktreeResult for backward compatibility', () => {
    const source = readSource(runtimeServicesPath);
    // The compat re-export was: export type { WorktreeResult } from './OrchestrationPorts.js'
    // WorktreeResult is now imported only from OrchestrationPorts directly by each consumer.
    const compatExport = /export\s+type\s+\{[^}]*WorktreeResult[^}]*\}\s+from\s+['"]\.\/OrchestrationPorts/;
    expect(
      compatExport.test(source),
      'RuntimeServices.ts must not re-export WorktreeResult from OrchestrationPorts — callers import from OrchestrationPorts directly'
    ).toBe(false);
  });

  it('RuntimeServices.ts does not re-export ApiAddress for backward compatibility', () => {
    const source = readSource(runtimeServicesPath);
    // The compat re-export was: export type { ApiAddress } from '../types/index.js'
    // ApiAddress is defined in types/index.ts; callers import from there directly.
    const compatExport = /export\s+type\s+\{[^}]*ApiAddress[^}]*\}\s+from\s+['"]/;
    expect(
      compatExport.test(source),
      'RuntimeServices.ts must not re-export ApiAddress — callers import from types/index.js directly'
    ).toBe(false);
  });

  it('createRuntimeServices.ts does not re-export ApiAddress via RuntimeServices', () => {
    const source = readSource(createRuntimeServicesPath);
    const compatExport = /export\s+type\s+\{[^}]*ApiAddress[^}]*\}/;
    expect(
      compatExport.test(source),
      'createRuntimeServices.ts must not re-export ApiAddress — it was a compat shim removed under no-backcompat-ever'
    ).toBe(false);
  });

  it('createRuntimeServices.ts has no old-path migration comments', () => {
    const source = readSource(createRuntimeServicesPath);
    expect(
      source,
      'createRuntimeServices.ts must not contain old-import-path migration guidance'
    ).not.toMatch(/previously imported createRuntimeServices from src\/core\/RuntimeServices/);
  });
});
