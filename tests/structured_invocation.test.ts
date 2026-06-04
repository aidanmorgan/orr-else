/**
 * Tests for src/plugins/projectTools/structuredInvocation.ts
 *
 * structuredInvocation is a parser-free GENERIC registry: the harness ships NO
 * concrete tool-output parsers (cerdiwen per-tool files own their own parsing,
 * see pi-experiment-0yt5.2 / 0yt5.6). These tests cover the registry MECHANISM:
 *  - With no registered handler, resolveStructuredInvocation returns null (AC2).
 *  - A registered handler augments args, parses output, and never throws.
 *  - Conflict detection, path-prefix / Windows-extension stripping.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  registerStructuredInvocation,
  resolveStructuredInvocation,
  type StructuredInvocationEntry,
  type StructuredInvocationResult
} from '../src/plugins/projectTools/structuredInvocation.js';

// ---- No built-in parsers (AC2) ----

describe('resolveStructuredInvocation: parser-free harness', () => {
  it('returns null for eslint — the harness registers no parser', () => {
    expect(resolveStructuredInvocation('eslint', ['.'])).toBeNull();
  });

  it('returns null for every formerly-built-in tool', () => {
    for (const tool of ['eslint', 'ruff', 'tsc', 'pytest', 'semgrep', 'golangci-lint', 'mypy']) {
      expect(resolveStructuredInvocation(tool, [])).toBeNull();
    }
  });

  it('returns null for an unknown tool', () => {
    expect(resolveStructuredInvocation('unknown-linter', [])).toBeNull();
    expect(resolveStructuredInvocation('cargo', ['build'])).toBeNull();
  });
});

// ---- Generic registry mechanism (with a test-only registered handler) ----

describe('resolveStructuredInvocation: registry mechanism', () => {
  const okResult: StructuredInvocationResult = { status: 'ok', counts: { findings: 0 } };

  // A throwaway tool name so we never collide with real consumers.
  const TOOL = '__structInvTestTool__';

  function register(overrides: Partial<StructuredInvocationEntry> = {}): void {
    registerStructuredInvocation(TOOL, {
      flags: ['--json'],
      conflictPatterns: [/^--json\b/, /^--format=/],
      parse: () => okResult,
      ...overrides
    });
  }

  // Restore an empty registry between tests by re-registering only when needed.
  afterEach(() => {
    // No public unregister API; registering a no-handler is unnecessary because
    // each test re-registers what it needs and uses a unique throwaway tool name.
  });

  it('returns a handler with augmented args after a parser is registered', () => {
    register();
    const handler = resolveStructuredInvocation(TOOL, ['.']);
    expect(handler).not.toBeNull();
    expect(handler!.augmentedArgs).toEqual(['.', '--json']);
  });

  it('parse() delegates to the registered handler', () => {
    register();
    const handler = resolveStructuredInvocation(TOOL, ['.'])!;
    expect(handler.parse('whatever', '', 0)).toEqual(okResult);
  });

  it('parse() never throws — a throwing registered parser yields null', () => {
    register({ parse: () => { throw new Error('boom'); } });
    const handler = resolveStructuredInvocation(TOOL, ['.'])!;
    expect(handler.parse('x', '', 1)).toBeNull();
  });

  it('does not double-inject when an output-format flag is already present', () => {
    register();
    expect(resolveStructuredInvocation(TOOL, ['--json', '.'])).toBeNull();
    expect(resolveStructuredInvocation(TOOL, ['--format=text'])).toBeNull();
  });

  it('strips a path prefix from commandName', () => {
    register();
    const handler = resolveStructuredInvocation(`/usr/local/bin/${TOOL}`, ['.']);
    expect(handler).not.toBeNull();
  });

  it('strips Windows extensions from commandName', () => {
    register();
    expect(resolveStructuredInvocation(`${TOOL}.cmd`, ['.'])).not.toBeNull();
    expect(resolveStructuredInvocation(`${TOOL}.exe`, ['.'])).not.toBeNull();
  });
});
