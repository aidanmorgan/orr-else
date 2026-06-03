/**
 * Smoke tests for pi-experiment-mynj packaging.
 *
 * Validates that:
 * 1. package.json has the correct bin, files, exports, and bundledDependencies.
 * 2. The templates/ directory exists with required scaffold files.
 * 3. The compiled dist/bin/init.js exists.
 * 4. Running the init command in a temp dir writes a checkout-free extension shim
 *    (no absolute path back to /Users/aidan/dev/pi-experiment or any orr-else checkout).
 * 5. GENUINE dependency-contract test: every external module imported by dist/ is
 *    satisfied by either dependencies/bundleDependencies or peerDependencies — NOT
 *    only devDependencies. This catches the exact bug where dist/extension.js imported
 *    @earendil-works/pi-ai which was only in devDependencies, causing ERR_MODULE_NOT_FOUND
 *    in a fresh install.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

function readPackageJson(): Record<string, unknown> {
  const raw = fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

describe('package.json packaging', () => {
  it('has name orr-else', () => {
    const pkg = readPackageJson();
    expect(pkg.name).toBe('orr-else');
  });

  it('has main pointing at dist/extension.js', () => {
    const pkg = readPackageJson();
    expect(pkg.main).toBe('./dist/extension.js');
  });

  it('has exports with dist/extension.js entry', () => {
    const pkg = readPackageJson();
    const exports = pkg.exports as Record<string, unknown>;
    expect(exports).toBeDefined();
    expect(exports['./dist/extension.js']).toBe('./dist/extension.js');
  });

  it('has bin entry pointing at dist/bin/init.js', () => {
    const pkg = readPackageJson();
    const bin = pkg.bin as Record<string, string>;
    expect(bin).toBeDefined();
    // Accept with or without leading ./ — both are valid npm bin entries.
    expect(bin['orr-else']).toMatch(/^\.?\/?(dist\/bin\/init\.js)$/);
  });

  it('includes templates in files array', () => {
    const pkg = readPackageJson();
    const files = pkg.files as string[];
    expect(files).toContain('templates');
  });

  it('includes dist in files array', () => {
    const pkg = readPackageJson();
    const files = pkg.files as string[];
    expect(files).toContain('dist');
  });

  it('includes harness.schema.json in files array', () => {
    const pkg = readPackageJson();
    const files = pkg.files as string[];
    expect(files).toContain('harness.schema.json');
  });

  it('has bundledDependencies (or bundleDependencies) listing all runtime deps', () => {
    const pkg = readPackageJson();
    // npm normalizes the key to bundleDependencies; both forms are accepted.
    const bundled = (pkg.bundledDependencies ?? pkg.bundleDependencies) as string[];
    const deps = pkg.dependencies as Record<string, string>;
    expect(bundled).toBeDefined();
    expect(Array.isArray(bundled)).toBe(true);
    // Every runtime dep should be bundled (no @types/* which are devDeps).
    for (const depName of Object.keys(deps)) {
      if (!depName.startsWith('@types/')) {
        expect(bundled).toContain(depName);
      }
    }
  });

  it('bundledDependencies does not include @types/* packages', () => {
    const pkg = readPackageJson();
    const bundled = (pkg.bundledDependencies ?? pkg.bundleDependencies) as string[];
    for (const name of bundled) {
      expect(name.startsWith('@types/')).toBe(false);
    }
  });

  it('bundledDependencies includes @modelcontextprotocol/sdk', () => {
    const pkg = readPackageJson();
    const bundled = (pkg.bundledDependencies ?? pkg.bundleDependencies) as string[];
    expect(bundled).toContain('@modelcontextprotocol/sdk');
  });

  it('@types/* packages are only in devDependencies, not in dependencies', () => {
    const pkg = readPackageJson();
    const deps = pkg.dependencies as Record<string, string>;
    for (const name of Object.keys(deps)) {
      expect(name.startsWith('@types/')).toBe(false);
    }
  });
});

describe('templates/ directory', () => {
  it('templates/harness.yaml exists', () => {
    const p = path.join(PROJECT_ROOT, 'templates', 'harness.yaml');
    expect(fs.existsSync(p)).toBe(true);
  });

  it('templates/prompts/implementer.md exists', () => {
    const p = path.join(PROJECT_ROOT, 'templates', 'prompts', 'implementer.md');
    expect(fs.existsSync(p)).toBe(true);
  });

  it('templates/prompts/planner.md exists', () => {
    const p = path.join(PROJECT_ROOT, 'templates', 'prompts', 'planner.md');
    expect(fs.existsSync(p)).toBe(true);
  });

  it('templates/prompts/reviewer.md exists', () => {
    const p = path.join(PROJECT_ROOT, 'templates', 'prompts', 'reviewer.md');
    expect(fs.existsSync(p)).toBe(true);
  });

  it('templates/rules/harness_rules.md exists', () => {
    const p = path.join(PROJECT_ROOT, 'templates', 'rules', 'harness_rules.md');
    expect(fs.existsSync(p)).toBe(true);
  });

  it('templates/skills/README.md exists', () => {
    const p = path.join(PROJECT_ROOT, 'templates', 'skills', 'README.md');
    expect(fs.existsSync(p)).toBe(true);
  });

  it('starter harness.yaml does not configure orrElseFrameworkRoot as a YAML key', () => {
    const content = fs.readFileSync(
      path.join(PROJECT_ROOT, 'templates', 'harness.yaml'),
      'utf8'
    );
    // The YAML key that actually sets the framework root must not appear.
    // (Mentions in comments are fine — they explain the var is not needed.)
    expect(content).not.toMatch(/^\s*orrElseFrameworkRoot\s*:/m);
  });
});

describe('compiled dist/bin/init.js', () => {
  it('dist/bin/init.js exists after build', () => {
    const p = path.join(PROJECT_ROOT, 'dist', 'bin', 'init.js');
    expect(fs.existsSync(p)).toBe(true);
  });

  it('dist/bin/init.js has shebang', () => {
    const content = fs.readFileSync(
      path.join(PROJECT_ROOT, 'dist', 'bin', 'init.js'),
      'utf8'
    );
    expect(content.startsWith('#!/usr/bin/env node')).toBe(true);
  });
});

describe('orr-else init command writes a checkout-free shim', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-init-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes .pi/extensions/orr-else.ts with package import (not checkout path)', () => {
    const initScript = path.join(PROJECT_ROOT, 'dist', 'bin', 'init.js');
    execSync(`node "${initScript}" init --cwd "${tmpDir}" --force`, {
      cwd: tmpDir,
      stdio: 'pipe',
      env: { ...process.env }
    });

    const shimPath = path.join(tmpDir, '.pi', 'extensions', 'orr-else.ts');
    expect(fs.existsSync(shimPath)).toBe(true);

    const shimContent = fs.readFileSync(shimPath, 'utf8');

    // Must import from the package name, not a relative checkout path.
    expect(shimContent).toContain("import orrElse from 'orr-else/dist/extension.js'");

    // Must NOT contain any reference to the pi-experiment source checkout.
    expect(shimContent).not.toContain('/Users/aidan/dev/pi-experiment');
    expect(shimContent).not.toContain('../../dist');
    expect(shimContent).not.toContain('../../../pi-experiment');
  });

  it('writes .pi/settings.json with npm: package specifier (not relative path)', () => {
    const initScript = path.join(PROJECT_ROOT, 'dist', 'bin', 'init.js');
    execSync(`node "${initScript}" init --cwd "${tmpDir}" --force`, {
      cwd: tmpDir,
      stdio: 'pipe',
      env: { ...process.env }
    });

    const settingsPath = path.join(tmpDir, '.pi', 'settings.json');
    expect(fs.existsSync(settingsPath)).toBe(true);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
      packages: string[];
    };
    expect(Array.isArray(settings.packages)).toBe(true);

    const orrElseEntry = settings.packages.find((p: string) => p.includes('orr-else'));
    expect(orrElseEntry).toBeDefined();
    // Must use npm: specifier, not a relative or absolute path.
    expect(orrElseEntry).toMatch(/^npm:orr-else@/);
    expect(orrElseEntry).not.toContain('/Users/');
    expect(orrElseEntry).not.toContain('../');
    expect(orrElseEntry).not.toContain('./');
  });

  it('scaffolds harness.yaml in the project root', () => {
    const initScript = path.join(PROJECT_ROOT, 'dist', 'bin', 'init.js');
    execSync(`node "${initScript}" init --cwd "${tmpDir}" --force`, {
      cwd: tmpDir,
      stdio: 'pipe',
      env: { ...process.env }
    });

    const harnessYaml = path.join(tmpDir, 'harness.yaml');
    expect(fs.existsSync(harnessYaml)).toBe(true);

    const content = fs.readFileSync(harnessYaml, 'utf8');
    // Should have standard harness sections.
    expect(content).toContain('settings:');
    expect(content).toContain('scheduler:');
    expect(content).toContain('states:');
    // Should NOT reference checkout paths.
    expect(content).not.toContain('/Users/aidan/dev/pi-experiment');
    // Should NOT configure orrElseFrameworkRoot as a YAML key (comments are fine).
    expect(content).not.toMatch(/^\s*orrElseFrameworkRoot\s*:/m);
  });

  it('scaffolds .pi/prompts, .pi/skills, .pi/rules directories', () => {
    const initScript = path.join(PROJECT_ROOT, 'dist', 'bin', 'init.js');
    execSync(`node "${initScript}" init --cwd "${tmpDir}" --force`, {
      cwd: tmpDir,
      stdio: 'pipe',
      env: { ...process.env }
    });

    expect(fs.existsSync(path.join(tmpDir, '.pi', 'prompts'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.pi', 'skills'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.pi', 'rules'))).toBe(true);
  });

  it('no written file references the orr-else source checkout path', () => {
    const initScript = path.join(PROJECT_ROOT, 'dist', 'bin', 'init.js');
    execSync(`node "${initScript}" init --cwd "${tmpDir}" --force`, {
      cwd: tmpDir,
      stdio: 'pipe',
      env: { ...process.env }
    });

    // Recursively check all written files for checkout path references.
    function checkDir(dir: string): void {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          checkDir(full);
        } else {
          const content = fs.readFileSync(full, 'utf8');
          expect(content, `File ${full} must not reference the orr-else checkout`)
            .not.toContain('/Users/aidan/dev/pi-experiment');
          expect(content, `File ${full} must not use a relative checkout path`)
            .not.toContain('../../../pi-experiment');
        }
      }
    }
    checkDir(tmpDir);
  });
});

// ---------------------------------------------------------------------------
// Node built-in module prefix list (node: scheme + bare names without scheme)
// ---------------------------------------------------------------------------
const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
  'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain',
  'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net',
  'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring',
  'readline', 'repl', 'stream', 'string_decoder', 'sys', 'timers', 'tls',
  'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads',
  'zlib',
]);

function isBuiltin(specifier: string): boolean {
  if (specifier.startsWith('node:')) return true;
  const bare = specifier.split('/')[0];
  return NODE_BUILTINS.has(bare);
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

/**
 * Extract the bare package name (scope + name, no sub-path) from an import
 * specifier such as '@foo/bar/baz/index.js' → '@foo/bar' or 'express/utils' → 'express'.
 */
function pkgName(specifier: string): string {
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return `${parts[0]}/${parts[1]}`;
  }
  return specifier.split('/')[0];
}

/**
 * Walk all *.js files under dir and collect every static import/export/require
 * specifier that resolves to an external (non-relative, non-builtin) package.
 * Returns a Map from package-name → Set<source files that import it>.
 */
function collectExternalImports(dir: string): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();

  // Matches:
  //   import { ... } from "pkg"   (named import)
  //   import "pkg"                (side-effect import)
  //   export { ... } from "pkg"   (re-export)
  //   import("pkg")               (dynamic import)
  //   require("pkg")              (CJS require)
  const fromRe = /(?:import|export)\s+.*?from\s+['"]([^'"]+)['"]/g;
  const sideEffectRe = /^\s*import\s+['"]([^'"]+)['"]\s*;/gm;
  const dynRe = /(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

  function walk(current: string): void {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        const src = fs.readFileSync(full, 'utf8');
        for (const re of [fromRe, sideEffectRe, dynRe]) {
          re.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = re.exec(src)) !== null) {
            const spec = m[1];
            // Skip template literal interpolations (e.g. '${PACKAGE_NAME}/dist/...')
            // and empty specifiers.
            if (!spec || spec.includes('${')) continue;
            if (!isRelative(spec) && !isBuiltin(spec)) {
              const name = pkgName(spec);
              if (!result.has(name)) result.set(name, new Set());
              result.get(name)!.add(path.relative(dir, full));
            }
          }
        }
      }
    }
  }

  walk(dir);
  return result;
}

describe('dependency contract: every runtime import is in dependencies or peerDependencies', () => {
  it('all external packages imported by dist/ are declared in dependencies/bundledDependencies or peerDependencies', () => {
    const pkg = readPackageJson();
    const deps = Object.keys((pkg.dependencies ?? {}) as Record<string, string>);
    const bundled = ((pkg.bundledDependencies ?? pkg.bundleDependencies ?? []) as string[]);
    const peers = Object.keys((pkg.peerDependencies ?? {}) as Record<string, string>);

    // Satisfied = appears in dependencies (which are all also bundled) or in peerDependencies.
    const satisfied = new Set<string>([...deps, ...bundled, ...peers]);

    const distDir = path.join(PROJECT_ROOT, 'dist');
    const externalImports = collectExternalImports(distDir);

    const missing: string[] = [];
    for (const [name, files] of externalImports) {
      if (!satisfied.has(name)) {
        missing.push(`  ${name}  (imported by: ${[...files].join(', ')})`);
      }
    }

    if (missing.length > 0) {
      throw new Error(
        `The following packages are imported at runtime in dist/ but are NOT declared in ` +
        `dependencies/bundledDependencies or peerDependencies.\n` +
        `A fresh install will throw ERR_MODULE_NOT_FOUND for each of these:\n\n` +
        missing.join('\n') + '\n\n' +
        `If the package is provided by the Pi host, declare it in peerDependencies.\n` +
        `If the package must be bundled, add it to dependencies + bundleDependencies.`
      );
    }
  });

  it('no package that is ONLY in devDependencies is imported by dist/', () => {
    const pkg = readPackageJson();
    const deps = new Set(Object.keys((pkg.dependencies ?? {}) as Record<string, string>));
    const bundled = new Set((pkg.bundledDependencies ?? pkg.bundleDependencies ?? []) as string[]);
    const peers = new Set(Object.keys((pkg.peerDependencies ?? {}) as Record<string, string>));
    const devDeps = new Set(Object.keys((pkg.devDependencies ?? {}) as Record<string, string>));

    const satisfied = new Set<string>([...deps, ...bundled, ...peers]);

    const distDir = path.join(PROJECT_ROOT, 'dist');
    const externalImports = collectExternalImports(distDir);

    const devOnly: string[] = [];
    for (const [name] of externalImports) {
      if (!satisfied.has(name) && devDeps.has(name)) {
        devOnly.push(name);
      }
    }

    if (devOnly.length > 0) {
      throw new Error(
        `The following packages are imported at runtime in dist/ but are ONLY in devDependencies — ` +
        `they will NOT be present in a fresh install:\n\n` +
        devOnly.map(n => `  ${n}`).join('\n') + '\n\n' +
        `This is the exact bug described in pi-experiment-mynj: declare host-provided packages ` +
        `in peerDependencies, or add them to dependencies + bundleDependencies if they must be bundled.`
      );
    }
  });

  it('peerDependencies declares @earendil-works/pi-ai (the only runtime Pi SDK import in dist/)', () => {
    const pkg = readPackageJson();
    const peers = (pkg.peerDependencies ?? {}) as Record<string, string>;
    expect(peers['@earendil-works/pi-ai']).toBeDefined();
  });

  it('@earendil-works/pi-ai is NOT in bundledDependencies (must be provided by the Pi host)', () => {
    const pkg = readPackageJson();
    const bundled = (pkg.bundledDependencies ?? pkg.bundleDependencies ?? []) as string[];
    expect(bundled).not.toContain('@earendil-works/pi-ai');
  });

  it('@earendil-works/pi-ai is NOT in dependencies (must be a peer not a bundled dep)', () => {
    const pkg = readPackageJson();
    const deps = (pkg.dependencies ?? {}) as Record<string, string>;
    expect(deps['@earendil-works/pi-ai']).toBeUndefined();
  });
});
