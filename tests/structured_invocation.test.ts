/**
 * Tests for src/plugins/projectTools/structuredInvocation.ts
 *
 * Covers:
 *  - resolveStructuredInvocation: recognized tools, unknown tools, don't-double-inject
 *  - Parser correctness: eslint/ruff/tsc/pytest/semgrep/golangci-lint/mypy
 *  - Defensive: malformed JSON → null, unknown tool → null
 *  - Caps: bounded groups/locations
 */

import { describe, expect, it } from 'vitest';
import { resolveStructuredInvocation } from '../src/plugins/projectTools/structuredInvocation.js';

// ---- resolveStructuredInvocation: registration ----

describe('resolveStructuredInvocation: registry', () => {
  it('returns a handler for eslint', () => {
    const handler = resolveStructuredInvocation('eslint', ['.']);
    expect(handler).not.toBeNull();
    expect(handler!.augmentedArgs).toContain('--format');
    expect(handler!.augmentedArgs).toContain('json');
    // augmented args include the original user args
    expect(handler!.augmentedArgs).toContain('.');
  });

  it('returns a handler for ruff', () => {
    const handler = resolveStructuredInvocation('ruff', ['check', '.']);
    expect(handler).not.toBeNull();
    expect(handler!.augmentedArgs).toContain('--output-format');
    expect(handler!.augmentedArgs).toContain('json');
    expect(handler!.augmentedArgs).toContain('check');
    expect(handler!.augmentedArgs).toContain('.');
  });

  it('returns a handler for tsc', () => {
    const handler = resolveStructuredInvocation('tsc', ['--noEmit']);
    expect(handler).not.toBeNull();
    expect(handler!.augmentedArgs).toContain('--pretty');
    expect(handler!.augmentedArgs).toContain('false');
    expect(handler!.augmentedArgs).toContain('--noEmit');
  });

  it('returns a handler for pytest', () => {
    const handler = resolveStructuredInvocation('pytest', ['tests/']);
    expect(handler).not.toBeNull();
    expect(handler!.augmentedArgs).toContain('-q');
    expect(handler!.augmentedArgs).toContain('--tb=no');
    expect(handler!.augmentedArgs).not.toContain('--no-header');
    expect(handler!.augmentedArgs).toContain('tests/');
  });

  it('returns a handler for semgrep', () => {
    const handler = resolveStructuredInvocation('semgrep', ['--config=auto', '.']);
    expect(handler).not.toBeNull();
    expect(handler!.augmentedArgs).toContain('--json');
    expect(handler!.augmentedArgs).toContain('--config=auto');
  });

  it('returns a handler for golangci-lint', () => {
    const handler = resolveStructuredInvocation('golangci-lint', ['run']);
    expect(handler).not.toBeNull();
    expect(handler!.augmentedArgs).toContain('--out-format');
    expect(handler!.augmentedArgs).toContain('json');
    expect(handler!.augmentedArgs).toContain('run');
  });

  it('returns a handler for mypy', () => {
    const handler = resolveStructuredInvocation('mypy', ['src/']);
    expect(handler).not.toBeNull();
    expect(handler!.augmentedArgs).toContain('--output');
    expect(handler!.augmentedArgs).toContain('json');
    expect(handler!.augmentedArgs).toContain('src/');
  });

  it('returns null for an unknown tool', () => {
    expect(resolveStructuredInvocation('unknown-linter', [])).toBeNull();
    expect(resolveStructuredInvocation('cargo', ['build'])).toBeNull();
    expect(resolveStructuredInvocation('flake8', ['src/'])).toBeNull();
  });

  it('strips path prefix from commandName', () => {
    const handler = resolveStructuredInvocation('/usr/local/bin/eslint', ['.']);
    expect(handler).not.toBeNull();
    expect(handler!.augmentedArgs).toContain('--format');
    expect(handler!.augmentedArgs).toContain('json');
  });

  it('strips Windows extensions from commandName', () => {
    const handler = resolveStructuredInvocation('eslint.cmd', ['.']);
    expect(handler).not.toBeNull();
  });
});

// ---- resolveStructuredInvocation: don't-double-inject ----

describe('resolveStructuredInvocation: conflict detection', () => {
  it('returns null when eslint --format is already present', () => {
    expect(resolveStructuredInvocation('eslint', ['--format', 'stylish', '.'])).toBeNull();
    expect(resolveStructuredInvocation('eslint', ['-f', 'stylish', '.'])).toBeNull();
    expect(resolveStructuredInvocation('eslint', ['--format=stylish', '.'])).toBeNull();
  });

  it('returns null when ruff --output-format is already present', () => {
    expect(resolveStructuredInvocation('ruff', ['check', '--output-format', 'text'])).toBeNull();
    expect(resolveStructuredInvocation('ruff', ['check', '--output-format=text'])).toBeNull();
  });

  it('returns null when tsc --pretty is already present', () => {
    expect(resolveStructuredInvocation('tsc', ['--pretty', '--noEmit'])).toBeNull();
    expect(resolveStructuredInvocation('tsc', ['--pretty=false'])).toBeNull();
  });

  it('returns null when semgrep --json is already present', () => {
    expect(resolveStructuredInvocation('semgrep', ['--json', '--config=auto'])).toBeNull();
    expect(resolveStructuredInvocation('semgrep', ['--sarif', '--config=auto'])).toBeNull();
  });

  it('returns null when golangci-lint --out-format is already present', () => {
    expect(resolveStructuredInvocation('golangci-lint', ['run', '--out-format', 'colored-line-number'])).toBeNull();
    expect(resolveStructuredInvocation('golangci-lint', ['run', '--out-format=colored-line-number'])).toBeNull();
  });

  it('returns null when mypy --output is already present', () => {
    expect(resolveStructuredInvocation('mypy', ['--output', 'text', 'src/'])).toBeNull();
    expect(resolveStructuredInvocation('mypy', ['--output=text', 'src/'])).toBeNull();
  });

  it('does NOT suppress when verbose pytest flag is present but output format flag is absent', () => {
    // -q conflicts (we treat it as a conflict), but -v is fine
    const handler = resolveStructuredInvocation('pytest', ['-v', 'tests/']);
    // pytest -v conflicts with -q so handler should be null (already has a verbosity flag)
    expect(handler).toBeNull();
  });

  it('injects flags when user only passed positionals (no format conflict)', () => {
    const handler = resolveStructuredInvocation('eslint', ['src/', '--ext', '.ts']);
    expect(handler).not.toBeNull();
  });
});

// ---- ESLint parser ----

describe('eslint parser', () => {
  const fixture: unknown[] = [
    {
      filePath: '/workspace/src/index.ts',
      messages: [
        { ruleId: 'no-unused-vars', severity: 2, message: 'x is defined but never used', line: 10, column: 3 },
        { ruleId: 'no-unused-vars', severity: 2, message: 'y is defined but never used', line: 20, column: 5 }
      ],
      errorCount: 2,
      warningCount: 0
    },
    {
      filePath: '/workspace/src/utils.ts',
      messages: [
        { ruleId: 'semi', severity: 1, message: 'Missing semicolon', line: 5, column: 1 }
      ],
      errorCount: 0,
      warningCount: 1
    }
  ];

  it('parses a representative eslint JSON output into a bounded structuredResult', () => {
    const handler = resolveStructuredInvocation('eslint', ['.'])!;
    const result = handler.parse(JSON.stringify(fixture), '', 1);
    expect(result).not.toBeNull();
    expect(result!.status).toBe('ok');
    expect(result!.counts?.errors).toBe(2);
    expect(result!.counts?.warnings).toBe(1);
    expect(result!.counts?.violations).toBeGreaterThan(0);
    expect(result!.affectedPaths).toContain('/workspace/src/index.ts');
    expect(result!.representativeSamples).toBeDefined();
    const samples = result!.representativeSamples as any[];
    expect(samples.some(s => s.rule === 'no-unused-vars')).toBe(true);
    expect(samples.some(s => s.rule === 'semi')).toBe(true);
  });

  it('returns null for malformed JSON', () => {
    const handler = resolveStructuredInvocation('eslint', ['.'])!;
    expect(handler.parse('not json', '', 1)).toBeNull();
    expect(handler.parse('{malformed}', '', 1)).toBeNull();
    expect(handler.parse('', '', 0)).toBeNull();
  });

  it('returns ok with zero counts for an empty eslint result (no violations)', () => {
    const handler = resolveStructuredInvocation('eslint', ['.'])!;
    const result = handler.parse(JSON.stringify([
      { filePath: '/src/a.ts', messages: [], errorCount: 0, warningCount: 0 }
    ]), '', 0);
    expect(result).not.toBeNull();
    expect(result!.status).toBe('ok');
    expect(result!.counts?.errors).toBe(0);
    expect(result!.counts?.warnings).toBe(0);
  });

  it('caps groups at MAX_GROUPS (6)', () => {
    // 8 distinct rules → only 6 groups should appear
    const messages = Array.from({ length: 8 }, (_, index) => ({
      ruleId: `rule-${index}`,
      severity: 2,
      message: `error from rule-${index}`,
      line: index + 1,
      column: 1
    }));
    const bigFixture = [{ filePath: '/src/file.ts', messages, errorCount: 8, warningCount: 0 }];
    const handler = resolveStructuredInvocation('eslint', ['.'])!;
    const result = handler.parse(JSON.stringify(bigFixture), '', 1)!;
    expect(result).not.toBeNull();
    expect((result.representativeSamples as any[]).length).toBeLessThanOrEqual(6);
  });

  it('caps locations per group at MAX_LOCATIONS_PER_GROUP (3)', () => {
    // 5 files all with the same rule → locations should be capped at 3
    const files = Array.from({ length: 5 }, (_, index) => ({
      filePath: `/src/file-${index}.ts`,
      messages: [{ ruleId: 'no-unused-vars', severity: 2, message: 'unused', line: 1, column: 1 }],
      errorCount: 1,
      warningCount: 0
    }));
    const handler = resolveStructuredInvocation('eslint', ['.'])!;
    const result = handler.parse(JSON.stringify(files), '', 1)!;
    expect(result).not.toBeNull();
    const samples = result.representativeSamples as any[];
    const unusedVarsSample = samples.find((s: any) => s.rule === 'no-unused-vars');
    expect(unusedVarsSample).toBeDefined();
    expect(unusedVarsSample.locations.length).toBeLessThanOrEqual(3);
  });
});

// ---- Ruff parser ----

describe('ruff parser', () => {
  const fixture = [
    {
      filename: '/workspace/src/models.py',
      code: 'F401',
      message: 'imported but unused',
      severity: 'warning',
      location: { row: 3, column: 1 }
    },
    {
      filename: '/workspace/src/models.py',
      code: 'E501',
      message: 'line too long',
      severity: 'error',
      location: { row: 10, column: 89 }
    }
  ];

  it('parses a representative ruff JSON output', () => {
    const handler = resolveStructuredInvocation('ruff', ['check', '.'])!;
    const result = handler.parse(JSON.stringify(fixture), '', 1);
    expect(result).not.toBeNull();
    expect(result!.status).toBe('ok');
    expect(result!.counts?.violations).toBe(2);
    expect(result!.affectedPaths).toContain('/workspace/src/models.py');
    const samples = result!.representativeSamples as any[];
    expect(samples.some(s => s.code === 'F401')).toBe(true);
    expect(samples.some(s => s.code === 'E501')).toBe(true);
  });

  it('returns null for malformed JSON', () => {
    const handler = resolveStructuredInvocation('ruff', ['check', '.'])!;
    expect(handler.parse('not json', '', 1)).toBeNull();
  });
});

// ---- tsc parser ----

describe('tsc parser', () => {
  const stdoutFixture = [
    'src/index.ts(10,5): error TS2339: Property \'foo\' does not exist on type \'Bar\'.',
    'src/utils.ts(3,1): error TS2322: Type \'string\' is not assignable to type \'number\'.',
    'src/index.ts(20,3): warning TS6133: \'x\' is declared but its value is never read.'
  ].join('\n');

  it('parses tsc text output into a structuredResult', () => {
    const handler = resolveStructuredInvocation('tsc', ['--noEmit'])!;
    const result = handler.parse(stdoutFixture, '', 2);
    expect(result).not.toBeNull();
    expect(result!.status).toBe('ok');
    expect(result!.counts?.errors).toBe(2);
    expect(result!.counts?.warnings).toBe(1);
    expect(result!.affectedPaths).toContain('src/index.ts');
    expect(result!.affectedPaths).toContain('src/utils.ts');
  });

  it('returns null when no tsc diagnostic lines are found', () => {
    const handler = resolveStructuredInvocation('tsc', ['--noEmit'])!;
    expect(handler.parse('', '', 0)).toBeNull();
    expect(handler.parse('This is not a tsc error line\nNo diagnostics', '', 0)).toBeNull();
  });
});

// ---- Pytest parser ----

describe('pytest parser', () => {
  it('parses a passing pytest summary', () => {
    const stdout = '5 passed in 0.32s';
    const handler = resolveStructuredInvocation('pytest', ['tests/'])!;
    const result = handler.parse(stdout, '', 0);
    expect(result).not.toBeNull();
    expect(result!.status).toBe('ok');
    expect(result!.counts?.passed).toBe(5);
    expect(result!.counts?.failed).toBe(0);
  });

  it('parses a failing pytest summary', () => {
    const stdout = '3 failed, 2 passed, 1 skipped in 1.23s';
    const handler = resolveStructuredInvocation('pytest', ['tests/'])!;
    const result = handler.parse(stdout, '', 1);
    expect(result).not.toBeNull();
    expect(result!.status).toBe('ok');
    expect(result!.counts?.failed).toBe(3);
    expect(result!.counts?.passed).toBe(2);
    expect(result!.counts?.skipped).toBe(1);
    expect(result!.nextAction).toBe('fix_or_route_failure');
  });

  it('returns null when output is not parseable', () => {
    const handler = resolveStructuredInvocation('pytest', ['tests/'])!;
    expect(handler.parse('', 'some error', 1)).toBeNull();
  });
});

// ---- Semgrep parser ----

describe('semgrep parser', () => {
  const fixture = {
    results: [
      {
        check_id: 'python.django.security.injection.tainted-sql-string.tainted-sql-string',
        path: 'app/views.py',
        start: { line: 42 },
        extra: { severity: 'ERROR', message: 'SQL injection risk' }
      },
      {
        check_id: 'python.django.security.injection.tainted-sql-string.tainted-sql-string',
        path: 'app/models.py',
        start: { line: 10 },
        extra: { severity: 'ERROR', message: 'SQL injection risk' }
      }
    ],
    errors: [],
    paths: {
      scanned: ['app/views.py', 'app/models.py', 'app/serializers.py']
    }
  };

  it('parses a representative semgrep JSON output', () => {
    const handler = resolveStructuredInvocation('semgrep', ['--config=auto', '.'])!;
    const result = handler.parse(JSON.stringify(fixture), '', 1);
    expect(result).not.toBeNull();
    expect(result!.status).toBe('ok');
    expect(result!.counts?.findings).toBe(2);
    expect(result!.counts?.scannedFiles).toBe(3);
    // 0yt5.16/0yt5.17: the redundant scannedTargetCount echo was removed; the
    // scanned-file count is carried under scannedFiles only.
    expect(result!.counts?.scannedTargetCount).toBeUndefined();
    expect(result!.affectedPaths).toContain('app/views.py');
    const samples = result!.representativeSamples as any[];
    expect(samples.length).toBeGreaterThan(0);
    expect(samples[0].type).toBe('semgrep_finding');
  });

  it('returns null for malformed JSON', () => {
    const handler = resolveStructuredInvocation('semgrep', ['.'])!;
    expect(handler.parse('not json', '', 1)).toBeNull();
    expect(handler.parse('{bad}', '', 1)).toBeNull();
  });

  it('handles zero findings gracefully', () => {
    const handler = resolveStructuredInvocation('semgrep', ['.'])!;
    const result = handler.parse(JSON.stringify({ results: [], errors: [], paths: { scanned: ['src/a.py'] } }), '', 0);
    expect(result).not.toBeNull();
    expect(result!.status).toBe('ok');
    expect(result!.counts?.findings).toBe(0);
    expect(result!.counts?.scannedFiles).toBe(1);
  });
});

// ---- golangci-lint parser ----

describe('golangci-lint parser', () => {
  const fixture = {
    Issues: [
      { Text: 'exported function without comment', Pos: { Filename: 'main.go', Line: 15 }, FromLinter: 'godot' },
      { Text: 'should use errcheck', Pos: { Filename: 'main.go', Line: 30 }, FromLinter: 'errcheck' },
      { Text: 'exported function without comment', Pos: { Filename: 'server.go', Line: 8 }, FromLinter: 'godot' }
    ],
    Report: {}
  };

  it('parses a representative golangci-lint JSON output', () => {
    const handler = resolveStructuredInvocation('golangci-lint', ['run'])!;
    const result = handler.parse(JSON.stringify(fixture), '', 1);
    expect(result).not.toBeNull();
    expect(result!.status).toBe('ok');
    expect(result!.counts?.issues).toBe(3);
    expect(result!.affectedPaths).toContain('main.go');
    const samples = result!.representativeSamples as any[];
    const godot = samples.find((s: any) => s.linter === 'godot');
    expect(godot).toBeDefined();
    expect(godot.count).toBe(2);
    expect(godot.locations.length).toBeLessThanOrEqual(3);
  });

  it('returns null for malformed JSON', () => {
    const handler = resolveStructuredInvocation('golangci-lint', ['run'])!;
    expect(handler.parse('not json', '', 1)).toBeNull();
  });
});

// ---- mypy parser ----

describe('mypy parser', () => {
  const fixture = [
    JSON.stringify({ file: 'src/models.py', line: 10, message: 'Incompatible types', code: 'assignment', severity: 'error' }),
    JSON.stringify({ file: 'src/models.py', line: 22, message: 'Missing return statement', code: 'return-value', severity: 'error' }),
    JSON.stringify({ file: 'src/utils.py', line: 5, message: 'note: See mypy docs', code: 'note', severity: 'note' })
  ].join('\n');

  it('parses a representative mypy --output=json output', () => {
    const handler = resolveStructuredInvocation('mypy', ['src/'])!;
    const result = handler.parse(fixture, '', 1);
    expect(result).not.toBeNull();
    expect(result!.status).toBe('ok');
    expect(result!.counts?.errors).toBe(2);
    expect(result!.counts?.notes).toBe(1);
    expect(result!.affectedPaths).toContain('src/models.py');
    const samples = result!.representativeSamples as any[];
    expect(samples.some(s => s.code === 'assignment')).toBe(true);
  });

  it('returns null when no JSON diagnostic lines are found', () => {
    const handler = resolveStructuredInvocation('mypy', ['src/'])!;
    expect(handler.parse('plain text output\nno json here', '', 1)).toBeNull();
    expect(handler.parse('', '', 0)).toBeNull();
  });
});

// ---- Defensive: never throw ----

describe('parsers: defensive (never throw)', () => {
  it('eslint parse never throws on unexpected inputs', () => {
    const handler = resolveStructuredInvocation('eslint', ['.'])!;
    expect(() => handler.parse('null', '', 0)).not.toThrow();
    expect(() => handler.parse('[{"filePath":null,"messages":[{"ruleId":null,"severity":null}]}]', '', 0)).not.toThrow();
    expect(() => handler.parse('{}', '', 0)).not.toThrow();
  });

  it('semgrep parse never throws on unexpected inputs', () => {
    const handler = resolveStructuredInvocation('semgrep', ['.'])!;
    expect(() => handler.parse('null', '', 0)).not.toThrow();
    expect(() => handler.parse('[]', '', 0)).not.toThrow();
    expect(() => handler.parse('{"results":null}', '', 0)).not.toThrow();
  });

  it('mypy parse never throws on unexpected inputs', () => {
    const handler = resolveStructuredInvocation('mypy', ['src/'])!;
    expect(() => handler.parse('not json at all\n{partial', '', 0)).not.toThrow();
  });
});
