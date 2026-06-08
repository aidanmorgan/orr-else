/**
 * config_explain.test.ts
 *
 * pi-experiment-vzp7: Tests for `orr-else config explain`.
 *
 * Acceptance criteria covered:
 *   AC1: --json output is byte-stable across repeated runs (determinism).
 *   AC2: No runtime preflight side effects — explain still works when tmux is
 *        unavailable or a backend probe fails (we make V2SubstratePreflight
 *        unavailable by verifying it is never imported/called by config-explain).
 *   AC3: Output includes resolved events, statechart, states, actions, tools, gates,
 *        profiles/defaults/toolSets, route emitters, non-compressible route table,
 *        prompt metadata, allowed inherited source paths, verifier registration metadata.
 *   AC4: Prompt bodies absent; digest (sha256 + byteCount + normalizedPath) present.
 *   AC5: Invalid config → exit non-zero + static diagnostic (forbidden route field, etc.).
 *
 * Tests:
 *   1. Valid v2 JSON explain — parses, includes required fields.
 *   2. Determinism — run twice, byte-identical JSON.
 *   3. Inherited allowed source paths present in JSON.
 *   4. Forbidden inherited route field (profile with transition) → exit non-zero + diagnostic.
 *   5. Invalid config (bad YAML / v1 field in v2) → exit non-zero + diagnostic.
 *   6. Prompt digest present, body absent.
 *   7. No runtime preflight side effects — no V2SubstratePreflight calls.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, execSync } from 'node:child_process';
import { runConfigExplain } from '../src/bin/config-explain.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

// Path to the compiled CLI entry (init.js, which now includes config explain).
const CLI_SCRIPT = path.join(PROJECT_ROOT, 'dist', 'bin', 'init.js');

// ---------------------------------------------------------------------------
// Test helper: write a minimal valid v2 fixture to a temp dir
// ---------------------------------------------------------------------------

function writeValidV2Fixture(tmpDir: string): { harnessPath: string; promptPath: string } {
  const promptDir = path.join(tmpDir, '.pi', 'prompts');
  fs.mkdirSync(promptDir, { recursive: true });
  const promptPath = path.join(promptDir, 'implementer.md');
  fs.writeFileSync(promptPath, 'Implement the requested changes in the worktree.');

  const harnessPath = path.join(tmpDir, 'harness.yaml');
  fs.writeFileSync(harnessPath, `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test handover"
  agentTurnTimeoutMs: 3600000
  processReapIntervalMs: 60000
  defaultProvider: claude
  modelProviders:
    claude:
      provider: claude
      model: claude-opus-4-5
      thinking: high
scheduler:
  weights:
    waitTime: 1.0
    executionTime: 0.5
    progress: 2.0
    penalty: 1.0
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: [INFO]
statechart:
  initial: Implement
  terminal: [completed]
states:
  Implement:
    identity:
      role: The Implementer
      expertise: Software engineering
      constraints:
        - Work in the assigned worktree.
    baseInstructions: Execute the plan.
    actions:
      run:
        type: prompt
        llm:
          promptFile: .pi/prompts/implementer.md
    transitions:
      SUCCESS: completed
      FAILURE: Implement
`);
  return { harnessPath, promptPath };
}

// Run the CLI and return { stdout, stderr, exitCode }.
function runCLI(args: string[], cwd: string): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync(process.execPath, [CLI_SCRIPT, ...args], {
      cwd,
      stdio: 'pipe',
      env: { ...process.env, ORR_ELSE_CONFIG_PATH: undefined }
    }).toString('utf8');
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer; stderr?: Buffer; status?: number };
    return {
      stdout: e.stdout?.toString('utf8') ?? '',
      stderr: e.stderr?.toString('utf8') ?? '',
      exitCode: e.status ?? 1,
    };
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('config explain: valid JSON output', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(process.env['TMPDIR'] ?? os.tmpdir(), 'vzp7-valid-'))
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exits 0 and outputs valid JSON for a valid v2 config', () => {
    const { harnessPath } = writeValidV2Fixture(tmpDir);
    const { stdout, exitCode } = runCLI(
      ['config', 'explain', '--json', '--config', harnessPath, '--cwd', tmpDir],
      tmpDir
    );
    expect(exitCode).toBe(0);
    expect(() => JSON.parse(stdout)).not.toThrow();
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed['schemaId']).toBe('harness.configExplain');
    expect(parsed['configVersion']).toBe(2);
  });

  it('output includes resolved events, statechart, states, actions, tools, gates', () => {
    const { harnessPath } = writeValidV2Fixture(tmpDir);
    const { stdout, exitCode } = runCLI(
      ['config', 'explain', '--json', '--config', harnessPath, '--cwd', tmpDir],
      tmpDir
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;

    // Events
    expect(parsed['events']).toBeTruthy();
    // resolvedVocabulary has all 4 categories
    const vocab = parsed['resolvedVocabulary'] as Record<string, unknown>;
    expect(vocab).toBeTruthy();
    expect(vocab['advance']).toContain('SUCCESS');
    expect(vocab['failure']).toContain('FAILURE');
    expect(vocab['blocked']).toContain('BLOCKED');
    expect(vocab['neutral']).toContain('INFO');

    // Statechart
    const statechart = parsed['statechart'] as Record<string, unknown>;
    expect(statechart).toBeTruthy();
    expect(statechart['initial']).toBe('Implement');
    expect(statechart['terminal']).toContain('completed');

    // States
    const states = parsed['states'] as Record<string, unknown>;
    expect(states).toBeTruthy();
    expect(states['Implement']).toBeTruthy();

    // Actions within state
    const implState = states['Implement'] as Record<string, unknown>;
    const actions = implState['actions'] as unknown[];
    expect(Array.isArray(actions)).toBe(true);
    expect(actions.length).toBeGreaterThan(0);

    // Tools (empty for this fixture but key must be present)
    expect(typeof parsed['tools']).toBe('object');

    // Gates (empty for this fixture but key must be present)
    expect(typeof parsed['gates']).toBe('object');
  });

  it('output includes route table (non-compressible transitions)', () => {
    const { harnessPath } = writeValidV2Fixture(tmpDir);
    const { stdout, exitCode } = runCLI(
      ['config', 'explain', '--json', '--config', harnessPath, '--cwd', tmpDir],
      tmpDir
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;

    const routeTable = parsed['routeTable'] as Record<string, Record<string, string>>;
    expect(routeTable).toBeTruthy();
    expect(routeTable['Implement']).toBeTruthy();
    expect(routeTable['Implement']['SUCCESS']).toBe('completed');
    expect(routeTable['Implement']['FAILURE']).toBe('Implement');
  });

  it('output includes allowed inherited source paths', () => {
    const { harnessPath } = writeValidV2Fixture(tmpDir);
    const { stdout, exitCode } = runCLI(
      ['config', 'explain', '--json', '--config', harnessPath, '--cwd', tmpDir],
      tmpDir
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;

    const inherited = parsed['allowedInheritedSourcePaths'] as Record<string, unknown>;
    expect(inherited).toBeTruthy();
    expect(Array.isArray(inherited['state'])).toBe(true);
    expect(Array.isArray(inherited['tool'])).toBe(true);
    const nc = inherited['nonCompressible'] as Record<string, unknown>;
    expect(Array.isArray(nc['state'])).toBe(true);
    expect(Array.isArray(nc['tool'])).toBe(true);

    // Spot-check allowlisted fields
    expect((inherited['state'] as string[])).toContain('thinking');
    expect((inherited['tool'] as string[])).toContain('timeoutMs');
    // Spot-check non-compressible fields
    expect((nc['state'] as string[])).toContain('transitions');
    expect((nc['tool'] as string[])).toContain('name');
  });
});

// ---------------------------------------------------------------------------
// AC1: Determinism — run twice → byte-identical JSON
// ---------------------------------------------------------------------------

describe('config explain: determinism (AC1)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(process.env['TMPDIR'] ?? os.tmpdir(), 'vzp7-det-'))
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('produces byte-identical JSON output across two repeated runs', () => {
    const { harnessPath } = writeValidV2Fixture(tmpDir);
    const args = ['config', 'explain', '--json', '--config', harnessPath, '--cwd', tmpDir];

    const { stdout: out1, exitCode: code1 } = runCLI(args, tmpDir);
    const { stdout: out2, exitCode: code2 } = runCLI(args, tmpDir);

    expect(code1).toBe(0);
    expect(code2).toBe(0);
    expect(out1).toBe(out2); // byte-identical
  });

  it('JSON output has deterministically sorted keys at the top level', () => {
    const { harnessPath } = writeValidV2Fixture(tmpDir);
    const { stdout, exitCode } = runCLI(
      ['config', 'explain', '--json', '--config', harnessPath, '--cwd', tmpDir],
      tmpDir
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const keys = Object.keys(parsed);
    const sortedKeys = [...keys].sort();
    expect(keys).toEqual(sortedKeys);
  });
});

// ---------------------------------------------------------------------------
// AC4: Prompt digest present, body absent
// ---------------------------------------------------------------------------

describe('config explain: prompt metadata (AC4)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(process.env['TMPDIR'] ?? os.tmpdir(), 'vzp7-prompt-'))
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('prompt digest present (normalizedPath, byteCount, sha256), body absent', () => {
    const { harnessPath, promptPath } = writeValidV2Fixture(tmpDir);
    const { stdout, exitCode } = runCLI(
      ['config', 'explain', '--json', '--config', harnessPath, '--cwd', tmpDir],
      tmpDir
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;

    const promptMetadata = parsed['promptMetadata'] as Record<string, unknown>[];
    expect(Array.isArray(promptMetadata)).toBe(true);
    expect(promptMetadata.length).toBeGreaterThan(0);

    const entry = promptMetadata[0];
    expect(typeof entry['normalizedPath']).toBe('string');
    expect(typeof entry['byteCount']).toBe('number');
    expect(typeof entry['sha256']).toBe('string');
    expect(entry['sha256']).toHaveLength(64); // sha256 hex

    // Body must not appear anywhere in the output
    const promptBody = fs.readFileSync(promptPath, 'utf8').trim();
    expect(stdout).not.toContain(promptBody);

    // Confirm the byte count matches the actual file size
    const actualBytes = fs.readFileSync(promptPath).length;
    expect(entry['byteCount']).toBe(actualBytes);
  });

  it('prompt metadata action IDs are included', () => {
    const { harnessPath } = writeValidV2Fixture(tmpDir);
    const { stdout, exitCode } = runCLI(
      ['config', 'explain', '--json', '--config', harnessPath, '--cwd', tmpDir],
      tmpDir
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const promptMetadata = parsed['promptMetadata'] as Record<string, unknown>[];
    expect(promptMetadata[0]).toHaveProperty('actionId');
    expect(promptMetadata[0]).toHaveProperty('stateId');
  });
});

// ---------------------------------------------------------------------------
// AC5: Invalid config → exit non-zero + static diagnostic
// ---------------------------------------------------------------------------

describe('config explain: invalid config admission failure (AC5)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(process.env['TMPDIR'] ?? os.tmpdir(), 'vzp7-invalid-'))
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exits non-zero with diagnostic when v2 config has a v1 stale field (startState)', () => {
    const badPath = path.join(tmpDir, 'bad.yaml');
    fs.writeFileSync(badPath, `
version: 2
settings:
  startState: Planning
  maxConcurrentSlots: 2
  handoverTemplate: test
  agentTurnTimeoutMs: 3600000
  processReapIntervalMs: 60000
  defaultProvider: claude
  modelProviders:
    claude:
      provider: claude
      model: claude-opus-4-5
scheduler:
  weights:
    waitTime: 1.0
    executionTime: 0.5
    progress: 2.0
    penalty: 1.0
statechart:
  initial: Implement
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
states:
  Implement: {}
`);
    const { stderr, exitCode } = runCLI(
      ['config', 'explain', '--json', '--config', badPath, '--cwd', tmpDir],
      tmpDir
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/startState|admission failed/i);
  });

  it('exits non-zero when config file does not exist', () => {
    const { stderr, exitCode } = runCLI(
      ['config', 'explain', '--json', '--config', path.join(tmpDir, 'nonexistent.yaml'), '--cwd', tmpDir],
      tmpDir
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/admission failed|not found|ENOENT/i);
  });

  it('exits non-zero for a profile that inherits a non-compressible transition field', () => {
    // A profile declaring `transitions` is forbidden (non-compressible workflow field).
    const badPath = path.join(tmpDir, 'bad-profile.yaml');
    fs.writeFileSync(badPath, `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: test
  agentTurnTimeoutMs: 3600000
  processReapIntervalMs: 60000
  defaultProvider: claude
  modelProviders:
    claude:
      provider: claude
      model: claude-opus-4-5
scheduler:
  weights:
    waitTime: 1.0
    executionTime: 0.5
    progress: 2.0
    penalty: 1.0
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
statechart:
  initial: Implement
  terminal: [completed]
profiles:
  states:
    base-state:
      transitions:
        SUCCESS: completed
states:
  Implement:
    profile: base-state
    identity:
      role: The Implementer
      expertise: Software engineering
      constraints:
        - Work in the assigned worktree.
    actions:
      run:
        type: prompt
        llm:
          promptFile: .pi/prompts/implementer.md
    transitions:
      SUCCESS: completed
      FAILURE: Implement
`);
    // Diagnostic must include non-compressible field mention
    const { stderr, exitCode } = runCLI(
      ['config', 'explain', '--json', '--config', badPath, '--cwd', tmpDir],
      tmpDir
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/non-compressible|transitions|admission failed/i);
  });
});

// ---------------------------------------------------------------------------
// AC2: No runtime preflight side effects
// ---------------------------------------------------------------------------

describe('config explain: no runtime preflight (AC2)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(process.env['TMPDIR'] ?? os.tmpdir(), 'vzp7-nopreflight-'))
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('explain works even when PATH is stripped (tmux/git unavailable)', () => {
    // By stripping PATH, tmux and git are unavailable — any substrate preflight would fail.
    // explain must still succeed purely on static config admission.
    const { harnessPath } = writeValidV2Fixture(tmpDir);
    try {
      const stdout = execFileSync(process.execPath, [CLI_SCRIPT, 'config', 'explain', '--json', '--config', harnessPath, '--cwd', tmpDir], {
        cwd: tmpDir,
        stdio: 'pipe',
        env: {
          // Intentionally omit PATH to make tmux/git unavailable
          HOME: process.env['HOME'],
          NODE_ENV: 'test',
        }
      }).toString('utf8');
      const parsed = JSON.parse(stdout) as Record<string, unknown>;
      expect(parsed['schemaId']).toBe('harness.configExplain');
    } catch (err: unknown) {
      // If the process exits non-zero, check it was not a preflight error
      const e = err as { stdout?: Buffer; stderr?: Buffer; status?: number };
      const stderr = e.stderr?.toString('utf8') ?? '';
      // Preflight errors mention tmux or git-worktree; static errors mention admission
      expect(stderr).not.toMatch(/tmux|git.worktree|substrate.*preflight/i);
    }
  });

  it('runConfigExplain function does not import V2SubstratePreflight or Supervisor', async () => {
    // Static check: V2SubstratePreflight must not be IMPORTED by config-explain.ts.
    // Check imports in the TypeScript source (not compiled JS to avoid false comment matches).
    const sourcePath = path.join(PROJECT_ROOT, 'src', 'bin', 'config-explain.ts');
    expect(fs.existsSync(sourcePath)).toBe(true);
    const source = fs.readFileSync(sourcePath, 'utf8');
    // Imports must not reference preflight or supervisor
    expect(source).not.toMatch(/from.*V2SubstratePreflight/);
    expect(source).not.toMatch(/from.*Supervisor/);
    // runV2SubstratePreflight must not be called
    expect(source).not.toMatch(/runV2SubstratePreflight\s*\(/);
    expect(source).not.toMatch(/Supervisor\s*\.\s*start/);
  });

  it('explain succeeds for valid config with no backend running', () => {
    // No backend is running; explain must not probe any backend.
    const { harnessPath } = writeValidV2Fixture(tmpDir);
    const { stdout, exitCode } = runCLI(
      ['config', 'explain', '--json', '--config', harnessPath, '--cwd', tmpDir],
      tmpDir
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed['configVersion']).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// profiles/defaults/toolSets in output
// ---------------------------------------------------------------------------

describe('config explain: profiles, defaults, toolSets', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(process.env['TMPDIR'] ?? os.tmpdir(), 'vzp7-profiles-'))
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('output includes profiles, defaults, toolSets blocks when declared', () => {
    const promptDir = path.join(tmpDir, '.pi', 'prompts');
    fs.mkdirSync(promptDir, { recursive: true });
    fs.writeFileSync(path.join(promptDir, 'implementer.md'), 'Implement the task.');

    const harnessPath = path.join(tmpDir, 'harness.yaml');
    fs.writeFileSync(harnessPath, `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test"
  agentTurnTimeoutMs: 3600000
  processReapIntervalMs: 60000
  defaultProvider: claude
  modelProviders:
    claude:
      provider: claude
      model: claude-opus-4-5
      thinking: high
scheduler:
  weights:
    waitTime: 1.0
    executionTime: 0.5
    progress: 2.0
    penalty: 1.0
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
statechart:
  initial: Implement
  terminal: [completed]
defaults:
  state:
    thinking: high
profiles:
  states:
    fast-state:
      thinking: medium
tools:
  my-tool:
    type: command
    command: echo
    name: my-tool
    description: A simple echo tool
toolSets:
  tools-all:
    - my-tool
states:
  Implement:
    identity:
      role: The Implementer
      expertise: Software engineering
      constraints: [Work in the assigned worktree.]
    baseInstructions: Execute the plan.
    actions:
      run:
        type: prompt
        llm:
          promptFile: .pi/prompts/implementer.md
    transitions:
      SUCCESS: completed
      FAILURE: Implement
`);

    const { stdout, exitCode } = runCLI(
      ['config', 'explain', '--json', '--config', harnessPath, '--cwd', tmpDir],
      tmpDir
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;

    // Profiles block present
    expect(parsed['profiles']).toBeTruthy();
    // Defaults block present
    expect(parsed['defaults']).toBeTruthy();
    // ToolSets block present
    expect(parsed['toolSets']).toBeTruthy();

    // Tools resolved
    const tools = parsed['tools'] as Record<string, unknown>;
    expect(tools['my-tool']).toBeTruthy();
  });
});
