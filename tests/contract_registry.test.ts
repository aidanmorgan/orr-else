/**
 * pi-experiment-0yt5.15 — runtime tests for the harness-owned tool/verify
 * contract exported via the `orr-else/contract` package subpath.
 *
 * These tests import the contract through the PACKAGE SUBPATH (`orr-else/contract`,
 * NOT a relative path) — resolved by Node's self-reference via the package.json
 * `exports` map — proving the subpath is genuinely reachable from the installed
 * package. They exercise the register -> invoke round trip and the last-wins
 * override semantics, and assert the registries are module-level singletons.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  verifier,
  skeletons,
  VerifyVerdict,
  type VerifyContext,
  type VerifyResult
} from 'orr-else/contract';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const sampleContext: VerifyContext = {
  beadId: 'bead-1',
  stateId: 'state-1',
  actionId: 'action-1',
  writeSet: ['/w/file.ts'],
  artifacts: { plan: '/artifacts/plan.md' },
  toolOutputs: { read_path_context: '/outputs/rpc.json' }
};

describe('contract subpath resolution', () => {
  it('package.json exports declares ./contract -> ./dist/contract.js', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')
    ) as { exports: Record<string, string> };
    expect(pkg.exports['./contract']).toBe('./dist/contract.js');
    // The existing "." export must be preserved.
    expect(pkg.exports['.']).toBe('./dist/extension.js');
  });

  it('the built file the subpath resolves to exists', () => {
    expect(fs.existsSync(path.join(PROJECT_ROOT, 'dist', 'contract.js'))).toBe(true);
  });

  it('the imported singletons are defined (subpath resolved at import time)', () => {
    expect(verifier).toBeDefined();
    expect(skeletons).toBeDefined();
    expect(VerifyVerdict.PASS).toBe('PASS');
  });
});

describe('verifier registry — register then the harness invokes the callback (AC6)', () => {
  const TOOL = 'contract_test_verify_tool';

  it('a registered verify() callback is looked up and invoked by the harness', async () => {
    let invokedWith: VerifyContext | undefined;
    const fake = (ctx: VerifyContext): VerifyResult => {
      invokedWith = ctx;
      return { verdict: VerifyVerdict.PASS, reasons: ['ok from fake'] };
    };

    verifier.register(TOOL, fake);

    // Simulate the harness verifier loop: look the callback up by tool name
    // and invoke it with the context.
    const cb = verifier.get(TOOL);
    expect(cb).toBeDefined();
    const result = await cb!(sampleContext);

    expect(invokedWith).toBe(sampleContext);
    expect(result.verdict).toBe(VerifyVerdict.PASS);
    expect(result.reasons).toEqual(['ok from fake']);
  });
});

describe('skeletons registry — register then the harness invokes the extractor (AC6)', () => {
  const EXT = '.contracttest';

  it('a registered skeleton extractor is looked up and invoked by the harness', () => {
    let invokedWith: string | undefined;
    const fake = (source: string): string => {
      invokedWith = source;
      return `SKELETON(${source.length})`;
    };

    skeletons.register(EXT, fake);

    // Simulate the harness skeleton loop.
    const extractor = skeletons.get(EXT);
    expect(extractor).toBeDefined();
    const out = extractor!('abcdef');

    expect(invokedWith).toBe('abcdef');
    expect(out).toBe('SKELETON(6)');
  });
});

describe('register() is LAST-WINS idempotent override (AC5)', () => {
  it('a second registration of the same tool REPLACES the prior one and does NOT throw', async () => {
    const TOOL = 'contract_lastwins_tool';
    const warnings: string[] = [];
    // Inject a capturing logger so we can assert the override is logged.
    verifier.withLogger({ warn: (m) => warnings.push(m) });

    const first = (): VerifyResult => ({ verdict: VerifyVerdict.FAIL, reasons: ['first'] });
    const second = (): VerifyResult => ({ verdict: VerifyVerdict.PASS, reasons: ['second'] });

    verifier.register(TOOL, first);
    // Second registration must NOT throw.
    expect(() => verifier.register(TOOL, second)).not.toThrow();

    // Last-wins: the second callback is the one that resolves.
    const cb = verifier.get(TOOL);
    const result = await cb!(sampleContext);
    expect(result.reasons).toEqual(['second']);

    // The override is logged.
    expect(warnings.some((w) => w.includes(TOOL) && w.toLowerCase().includes('last-wins'))).toBe(true);
  });

  it('skeletons registry is also last-wins and does not throw on re-register', () => {
    const EXT = '.lastwinsext';
    skeletons.register(EXT, () => 'one');
    expect(() => skeletons.register(EXT, () => 'two')).not.toThrow();
    expect(skeletons.get(EXT)!('x')).toBe('two');
  });
});

describe('registries are module-level singletons (AC5)', () => {
  beforeEach(() => {
    // no-op: state intentionally shared to prove singleton-ness across imports
  });

  it('a second import of the contract subpath yields the SAME registry instances', async () => {
    const again = await import('orr-else/contract');
    expect(again.verifier).toBe(verifier);
    expect(again.skeletons).toBe(skeletons);

    // A registration made via one reference is visible via the other (singleton).
    const TOOL = 'contract_singleton_tool';
    again.verifier.register(TOOL, () => ({ verdict: VerifyVerdict.PASS, reasons: [] }));
    expect(verifier.has(TOOL)).toBe(true);
  });
});
