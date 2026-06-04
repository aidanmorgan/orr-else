/**
 * pi-experiment-0yt5.15 — the `orr-else/contract` entry exports PURE TYPES +
 * the thin register API ONLY, with NO transitive heavy harness imports.
 *
 * We assert leanness two ways:
 *  1. Source-level: src/contract.ts imports nothing from ./core, ./plugins,
 *     ./extension, winston, or any other heavy harness/runtime module.
 *  2. Compiled-level: dist/contract.js has NO static or dynamic imports at all
 *     (the contract is self-contained — types erase, and the registries depend
 *     only on a tiny console-backed logger).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

function readImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const fromRe = /(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]/g;
  const sideEffectRe = /^\s*import\s+['"]([^'"]+)['"]\s*;/gm;
  const dynRe = /(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const re of [fromRe, sideEffectRe, dynRe]) {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(source)) !== null) {
      specifiers.push(m[1]);
    }
  }
  return specifiers;
}

describe('contract is lean (no heavy harness imports)', () => {
  it('src/contract.ts imports nothing from ./core, ./plugins, ./extension or winston', () => {
    const src = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'contract.ts'), 'utf8');
    const specs = readImportSpecifiers(src);

    const forbiddenSubstrings = ['/core/', './core', '/plugins/', './plugins', 'extension', 'winston', 'EventStore', 'ConfigLoader'];
    const offending = specs.filter((s) =>
      forbiddenSubstrings.some((bad) => s.includes(bad))
    );
    expect(offending, `src/contract.ts must not import heavy modules; found: ${offending.join(', ')}`).toEqual([]);
  });

  it('compiled dist/contract.js has NO import/require statements at all (fully self-contained)', () => {
    const distPath = path.join(PROJECT_ROOT, 'dist', 'contract.js');
    expect(fs.existsSync(distPath), 'dist/contract.js must exist (run npm run build)').toBe(true);
    const js = fs.readFileSync(distPath, 'utf8');
    const specs = readImportSpecifiers(js);
    expect(specs, `dist/contract.js must have no imports; found: ${specs.join(', ')}`).toEqual([]);
  });
});

describe('contract exports the canonical types via the package subpath', () => {
  it('rg-style: src/contract.ts exports ToolResultBase, VerifyResult, VerifyContext, VerifyVerdict', () => {
    const src = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'contract.ts'), 'utf8');
    const re = /export (?:interface|type|enum|function|const) (ToolResultBase|VerifyResult|VerifyContext|VerifyVerdict)\b/g;
    const found = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) found.add(m[1]);
    expect(found.has('ToolResultBase')).toBe(true);
    expect(found.has('VerifyResult')).toBe(true);
    expect(found.has('VerifyContext')).toBe(true);
    expect(found.has('VerifyVerdict')).toBe(true);
  });
});
