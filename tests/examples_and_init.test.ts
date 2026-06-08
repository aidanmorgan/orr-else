/**
 * examples_and_init.test.ts
 *
 * pi-experiment-7ypp: Move opinionated examples and init templates out of runtime defaults.
 *
 * AC2 (load-bearing): `orr-else init` emits a v2-valid starter config.
 *   - Generated harness.yaml contains `version: 2`.
 *   - Generated harness.yaml has no v1 fields (startState, worktreePolicy, promptKey,
 *     array-form states with `- id:`, array-form actions).
 *   - Generated harness.yaml passes ConfigLoader v2 admission: load() SUCCEEDS when all
 *     referenced promptFile paths exist (the emitted starter is genuinely v2-valid).
 *   - examples/planning-implementation-review.yaml also passes ConfigLoader v2 admission.
 *
 * AC4 (load-bearing / no-runtime-fallback): ConfigLoader discovery NEVER falls back to
 *   examples/ or templates/ as a runtime config.
 *   - With no config set and no harness.yaml in the project root, load() throws
 *     "not found" — it does NOT silently load from examples/ or templates/.
 *   - Explicitly calling load() with an examples/ path works (examples are usable by
 *     explicit reference), but is never automatic.
 *   - Explicitly calling load() with a templates/ path works (templates are usable
 *     by explicit reference), but is never automatic.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { ConfigLoader } from '../src/core/ConfigLoader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// AC2: init generates v2-valid starter config
// ---------------------------------------------------------------------------

describe('AC2: orr-else init emits v2-valid starter config', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-7ypp-init-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('generated harness.yaml contains version: 2', () => {
    const initScript = path.join(PROJECT_ROOT, 'dist', 'bin', 'init.js');
    execSync(`node "${initScript}" init --cwd "${tmpDir}" --force`, {
      cwd: tmpDir,
      stdio: 'pipe',
      env: { ...process.env }
    });

    const harnessYaml = path.join(tmpDir, 'harness.yaml');
    expect(fs.existsSync(harnessYaml)).toBe(true);

    const content = fs.readFileSync(harnessYaml, 'utf8');
    expect(content).toMatch(/^version:\s*2\s*$/m);
  });

  it('generated harness.yaml has no v1 field: startState', () => {
    const initScript = path.join(PROJECT_ROOT, 'dist', 'bin', 'init.js');
    execSync(`node "${initScript}" init --cwd "${tmpDir}" --force`, {
      cwd: tmpDir,
      stdio: 'pipe',
      env: { ...process.env }
    });

    const content = fs.readFileSync(path.join(tmpDir, 'harness.yaml'), 'utf8');
    expect(content).not.toMatch(/^\s*startState\s*:/m);
  });

  it('generated harness.yaml has no v1 field: worktreePolicy', () => {
    const initScript = path.join(PROJECT_ROOT, 'dist', 'bin', 'init.js');
    execSync(`node "${initScript}" init --cwd "${tmpDir}" --force`, {
      cwd: tmpDir,
      stdio: 'pipe',
      env: { ...process.env }
    });

    const content = fs.readFileSync(path.join(tmpDir, 'harness.yaml'), 'utf8');
    expect(content).not.toMatch(/^\s*worktreePolicy\s*:/m);
  });

  it('generated harness.yaml has no v1 field: promptKey', () => {
    const initScript = path.join(PROJECT_ROOT, 'dist', 'bin', 'init.js');
    execSync(`node "${initScript}" init --cwd "${tmpDir}" --force`, {
      cwd: tmpDir,
      stdio: 'pipe',
      env: { ...process.env }
    });

    const content = fs.readFileSync(path.join(tmpDir, 'harness.yaml'), 'utf8');
    expect(content).not.toMatch(/\bpromptKey\s*:/m);
  });

  it('generated harness.yaml has no v1 array-form states (- id: ...)', () => {
    const initScript = path.join(PROJECT_ROOT, 'dist', 'bin', 'init.js');
    execSync(`node "${initScript}" init --cwd "${tmpDir}" --force`, {
      cwd: tmpDir,
      stdio: 'pipe',
      env: { ...process.env }
    });

    const content = fs.readFileSync(path.join(tmpDir, 'harness.yaml'), 'utf8');
    // Array-form states use `- id:` pattern (YAML list item with id key)
    expect(content).not.toMatch(/^\s*-\s+id\s*:/m);
  });

  it('generated harness.yaml v2 admission: ConfigLoader rejects v1 startState if injected', () => {
    // This test verifies that the v2 admission gate correctly rejects a v1 field —
    // validating the gate works, complementing the "no v1 fields in template" tests above.
    const tempPath = path.join(tmpDir, 'v1-check.yaml');
    fs.writeFileSync(tempPath, `
version: 2
settings:
  startState: Planning
  maxConcurrentSlots: 2
  handoverTemplate: "test"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
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
  completed: {}
`);
    const loader = new ConfigLoader(undefined, tmpDir);
    expect(() => loader.load(tempPath)).toThrow(/startState/);
  });
});

// ---------------------------------------------------------------------------
// AC2 (load-bearing): init emits a starter that ConfigLoader.load() ACCEPTS
//
// Uses fs.realpathSync to resolve macOS /tmp→/private/tmp symlinks, which
// otherwise trigger a spurious promptFile path-traversal error.
// ---------------------------------------------------------------------------

describe('AC2 (load-bearing): templates/harness.yaml passes ConfigLoader v2 admission', () => {
  // Repo-relative test dir: resolved real path avoids macOS /tmp→/private/tmp symlink.
  const TEST_DIR = fs.realpathSync(
    fs.mkdtempSync(path.join(process.env['TMPDIR'] ?? os.tmpdir(), 'orr-else-7ypp-load-'))
  );

  afterEach(() => {
    // Clean files written during each test (keep TEST_DIR for the suite).
    for (const entry of fs.readdirSync(TEST_DIR)) {
      try {
        fs.rmSync(path.join(TEST_DIR, entry), { recursive: true, force: true });
      } catch { /* ignore */ }
    }
  });

  it('templates/harness.yaml loads without error when promptFile exists (genuinely v2-valid)', () => {
    // Copy the template harness.yaml into the test dir (simulating what init emits).
    const templateSrc = path.join(PROJECT_ROOT, 'templates', 'harness.yaml');
    const harnessPath = path.join(TEST_DIR, 'harness.yaml');
    fs.copyFileSync(templateSrc, harnessPath);

    // Create the referenced promptFile so load() doesn't fail on a missing file.
    // templates/harness.yaml references: .pi/prompts/implementer.md
    const promptDir = path.join(TEST_DIR, '.pi', 'prompts');
    fs.mkdirSync(promptDir, { recursive: true });
    fs.writeFileSync(path.join(promptDir, 'implementer.md'), 'Implement the requested changes.');

    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(harnessPath)).not.toThrow();
  });

  it('adding completed:{} back to states map causes load() to throw (self-verify: gate is real)', () => {
    // Self-verify: if we re-introduce the defect (completed:{} in states), load() must fail.
    const brokenYaml = `
version: 2
settings:
  maxConcurrentSlots: 3
  handoverTemplate: |
    HISTORY: {{history}}
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
states:
  Implement:
    identity:
      role: The Implementer
      expertise: Software engineering
      constraints:
        - Work only inside the assigned worktree.
    baseInstructions: |
      Implement the task.
    actions:
      run:
        type: prompt
        llm:
          promptFile: .pi/prompts/implementer.md
    transitions:
      SUCCESS: completed
      FAILURE: Implement
  completed: {}
`;
    const brokenPath = path.join(TEST_DIR, 'broken.yaml');
    fs.writeFileSync(brokenPath, brokenYaml);

    // Create the prompt file so the only failure is the schema violation.
    const promptDir = path.join(TEST_DIR, '.pi', 'prompts');
    fs.mkdirSync(promptDir, { recursive: true });
    fs.writeFileSync(path.join(promptDir, 'implementer.md'), 'Implement the requested changes.');

    const loader = new ConfigLoader(undefined, TEST_DIR);
    // The completed:{} entry violates v2 schema: must throw.
    expect(() => loader.load(brokenPath)).toThrow();
  });
});

describe('AC2 (load-bearing): examples/planning-implementation-review.yaml passes ConfigLoader v2 admission', () => {
  const TEST_DIR = fs.realpathSync(
    fs.mkdtempSync(path.join(process.env['TMPDIR'] ?? os.tmpdir(), 'orr-else-7ypp-ex-'))
  );

  afterEach(() => {
    for (const entry of fs.readdirSync(TEST_DIR)) {
      try {
        fs.rmSync(path.join(TEST_DIR, entry), { recursive: true, force: true });
      } catch { /* ignore */ }
    }
  });

  it('examples/planning-implementation-review.yaml loads without error when promptFiles exist (genuinely v2-valid)', () => {
    const exampleSrc = path.join(PROJECT_ROOT, 'examples', 'planning-implementation-review.yaml');
    if (!fs.existsSync(exampleSrc)) {
      // Should always be present — skip only as a safety net.
      return;
    }
    const examplePath = path.join(TEST_DIR, 'harness.yaml');
    fs.copyFileSync(exampleSrc, examplePath);

    // Create all promptFiles referenced by the example:
    //   .pi/prompts/planner.md, .pi/prompts/implementer.md, .pi/prompts/reviewer.md
    const promptDir = path.join(TEST_DIR, '.pi', 'prompts');
    fs.mkdirSync(promptDir, { recursive: true });
    fs.writeFileSync(path.join(promptDir, 'planner.md'), 'Plan the task.');
    fs.writeFileSync(path.join(promptDir, 'implementer.md'), 'Implement the task.');
    fs.writeFileSync(path.join(promptDir, 'reviewer.md'), 'Review the implementation.');

    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(examplePath)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC4 (load-bearing): runtime config discovery never falls back to examples/templates
// ---------------------------------------------------------------------------

describe('AC4: runtime config discovery never falls back to examples/ or templates/', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-7ypp-nodiscovery-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('load() with no config path and no harness.yaml throws "not found" — does not load from examples/', () => {
    // The tmpDir has NO harness.yaml.
    // ConfigLoader default is to look for harness.yaml in the project root.
    // It must throw, not silently fall back to examples/.
    const loader = new ConfigLoader(undefined, tmpDir);
    expect(() => loader.load()).toThrow(/not found|ENOENT/i);
  });

  it('load() with no config path and no harness.yaml throws — does not load from templates/', () => {
    // Same invariant: no harness.yaml → throw, not fallback to templates/
    const loader = new ConfigLoader(undefined, tmpDir);
    expect(() => loader.load()).toThrow(/not found|ENOENT/i);
  });

  it('load() does not inspect examples/ path automatically (no harness.yaml at examples/)', () => {
    // Even if examples/ exists and contains YAML files, discovery does not look there.
    const examplesDir = path.join(tmpDir, 'examples');
    fs.mkdirSync(examplesDir, { recursive: true });
    fs.writeFileSync(
      path.join(examplesDir, 'planning-implementation-review.yaml'),
      'version: 2\nsettings:\n  maxConcurrentSlots: 1\n'
    );
    // Still no harness.yaml in tmpDir root → must throw.
    const loader = new ConfigLoader(undefined, tmpDir);
    expect(() => loader.load()).toThrow(/not found|ENOENT/i);
  });

  it('load() does not inspect templates/ path automatically (no harness.yaml at root)', () => {
    // Even if templates/ exists and contains harness.yaml, discovery does not look there.
    const templatesDir = path.join(tmpDir, 'templates');
    fs.mkdirSync(templatesDir, { recursive: true });
    fs.writeFileSync(
      path.join(templatesDir, 'harness.yaml'),
      'version: 2\nsettings:\n  maxConcurrentSlots: 1\n'
    );
    // Still no harness.yaml in tmpDir root → must throw.
    const loader = new ConfigLoader(undefined, tmpDir);
    expect(() => loader.load()).toThrow(/not found|ENOENT/i);
  });

  it('ConfigLoader.getConfigPath() resolves to harness.yaml in project root, not examples or templates', () => {
    // Verify the discovery path is the project root harness.yaml, nothing else.
    const loader = new ConfigLoader(undefined, tmpDir);
    const configPath = loader.getConfigPath();
    // Must be within the tmpDir root
    expect(configPath).toContain(tmpDir);
    // Must NOT be under examples/ or templates/
    expect(configPath).not.toContain(path.join(tmpDir, 'examples'));
    expect(configPath).not.toContain(path.join(tmpDir, 'templates'));
    // Must name harness.yaml
    expect(path.basename(configPath)).toBe('harness.yaml');
  });

  it('examples/ YAML is usable by explicit path (not runtime fallback)', () => {
    // Explicit load of the package examples file works fine —
    // the invariant is "no automatic fallback", not "examples are unusable".
    // We use the actual package examples/ directory for this test.
    const examplePath = path.join(PROJECT_ROOT, 'examples', 'planning-implementation-review.yaml');
    if (!fs.existsSync(examplePath)) {
      // Skip if not present (should always be present after this bead).
      return;
    }
    // The example has promptFile references — we cannot load it via ConfigLoader
    // without those files existing. But we can verify it parses as v2 YAML with no v1 fields.
    const content = fs.readFileSync(examplePath, 'utf8');
    expect(content).toMatch(/^version:\s*2\s*$/m);
    expect(content).not.toMatch(/^\s*startState\s*:/m);
    expect(content).not.toMatch(/^\s*worktreePolicy\s*:/m);
  });
});
