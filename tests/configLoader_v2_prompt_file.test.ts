/**
 * configLoader_v2_prompt_file.test.ts
 *
 * pi-experiment-0njv: Require safe promptFile paths for every v2 LLM action.
 *
 * AC1: Every admitted v2 LLM action has llm.promptFile and NO inline prompt body.
 *      - llm.prompt (inline body) → rejected.
 *      - top-level prompt field on a v2 LLM action → rejected.
 *      - missing llm.promptFile → rejected.
 *
 * AC2: promptFile paths must be normalized project-relative FILEs:
 *      - absolute path → rejected.
 *      - `..` escape → rejected.
 *      - symlink escape (real path outside project root) → rejected via realpath.
 *      - directory (not a file) → rejected.
 *      - unreadable / nonexistent → rejected.
 *
 * AC3: Admitted prompt file provenance records: normalizedPath, byteCount, sha256, actionId.
 *
 * AC4: Prompt BODY is NOT inlined into resolved config snapshots or diagnostics.
 *      A distinctive sentence in the prompt file must not appear in the resolved config.
 *
 * AC5: Tests cover: valid promptFile, inline-prompt rejection, legacy-prompt rejection,
 *      missing/directory paths, absolute path, `..` escape, real symlink escape, unreadable.
 *
 * Version-gated: all checks apply ONLY when version === 2. v1 configs unaffected.
 * Rejection happens BEFORE any model/provider/Pi request (before-model-spend guarantee).
 *
 * Each rejection test is LOAD-BEARING: it must fail if its specific check is removed.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import type { HarnessConfig } from '../src/core/ConfigLoader.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_DIR = fs.realpathSync(fs.mkdtempSync(path.join(process.env['TMPDIR'] ?? os.tmpdir(), 'orr-else-0njv-')));

function writeFile(relPath: string, content: string): string {
  const abs = path.join(TEST_DIR, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

function writeYaml(name: string, content: string): string {
  return writeFile(name, content);
}

afterEach(() => {
  // Remove only files/dirs created during the test run (keep TEST_DIR itself).
  for (const entry of fs.readdirSync(TEST_DIR)) {
    const p = path.join(TEST_DIR, entry);
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/** Minimal v2 YAML fixture template. Caller injects the actions block. */
function minimalV2Yaml(actionsBlock: string): string {
  return `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test handover"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: implement
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
states:
  implement:
    identity: { role: "Implementer", expertise: "Coding", constraints: [] }
    baseInstructions: "Implement the task."
    actions:
${actionsBlock}
    transitions:
      SUCCESS: completed
      FAILURE: implement
`;
}

// ---------------------------------------------------------------------------
// AC1 / AC3: Valid v2 LLM action with promptFile — admission + provenance
// ---------------------------------------------------------------------------

describe('pi-experiment-0njv AC1/AC3: valid v2 LLM action with promptFile', () => {
  it('S1: valid promptFile loads successfully and provenance is recorded', () => {
    const promptContent = 'Implement the requested changes to the codebase.';
    writeFile('.pi/prompts/implement.md', promptContent);

    const yamlPath = writeYaml('s1_valid.yaml', minimalV2Yaml(`
      run-impl:
        type: prompt
        llm:
          promptFile: .pi/prompts/implement.md
`));

    const loader = new ConfigLoader(undefined, TEST_DIR);

    let config: HarnessConfig | undefined;
    expect(() => { config = loader.load(yamlPath); }).not.toThrow();

    expect(config).toBeDefined();
    const actions = config!.states['implement'].actions;
    expect(actions).toHaveLength(1);
    expect(actions[0].id).toBe('run-impl');

    // AC3: provenance is recorded
    const prov = (actions[0] as unknown as Record<string, unknown>)['v2PromptProvenance'] as {
      normalizedPath: string; byteCount: number; sha256: string; actionId: string;
    };
    expect(prov).toBeDefined();
    expect(prov.actionId).toBe('run-impl');
    expect(prov.byteCount).toBe(Buffer.byteLength(promptContent));
    expect(prov.sha256).toBe(crypto.createHash('sha256').update(promptContent).digest('hex'));
    // Normalized path is project-relative
    expect(path.isAbsolute(prov.normalizedPath)).toBe(false);
    expect(prov.normalizedPath).toBe(path.normalize('.pi/prompts/implement.md'));
  });

  it('S1b: sha256 is deterministic across two loads of the same prompt file', () => {
    const promptContent = 'Deterministic prompt content.';
    writeFile('.pi/prompts/determ.md', promptContent);

    const yamlPath = writeYaml('s1b_determ.yaml', minimalV2Yaml(`
      run-impl:
        type: prompt
        llm:
          promptFile: .pi/prompts/determ.md
`));

    const prov1 = (new ConfigLoader(undefined, TEST_DIR).load(yamlPath)
      .states['implement'].actions[0] as unknown as Record<string, unknown>)['v2PromptProvenance'] as { sha256: string };
    const prov2 = (new ConfigLoader(undefined, TEST_DIR).load(yamlPath)
      .states['implement'].actions[0] as unknown as Record<string, unknown>)['v2PromptProvenance'] as { sha256: string };

    expect(prov1.sha256).toBe(prov2.sha256);
  });
});

// ---------------------------------------------------------------------------
// AC4: Prompt BODY is NOT inlined into resolved config snapshots or diagnostics
// ---------------------------------------------------------------------------

describe('pi-experiment-0njv AC4: prompt body not inlined into resolved config', () => {
  it('S2: distinctive sentence in prompt file does NOT appear in JSON.stringify of resolved config', () => {
    const DISTINCTIVE = 'UNIQUE_SENTINEL_DO_NOT_COPY_TO_CONFIG_xyzzy42';
    const promptContent = `This is the prompt.\n${DISTINCTIVE}\nDo the work.`;
    writeFile('.pi/prompts/sentinel.md', promptContent);

    const yamlPath = writeYaml('s2_no_body.yaml', minimalV2Yaml(`
      run-impl:
        type: prompt
        llm:
          promptFile: .pi/prompts/sentinel.md
`));

    const loader = new ConfigLoader(undefined, TEST_DIR);
    const config = loader.load(yamlPath);

    const snapshot = JSON.stringify(config);
    // The distinctive sentence must NOT appear in the serialized config
    expect(snapshot).not.toContain(DISTINCTIVE);
  });
});

// ---------------------------------------------------------------------------
// AC1: inline llm.prompt rejection (load-bearing)
// ---------------------------------------------------------------------------

describe('pi-experiment-0njv AC1: llm.prompt inline body → rejected', () => {
  it('S3: action with llm.prompt (inline body) → load fails with path-specific diagnostic', () => {
    writeFile('.pi/prompts/real.md', 'prompt content');

    const yamlPath = writeYaml('s3_inline_llm_prompt.yaml', minimalV2Yaml(`
      run-impl:
        type: prompt
        llm:
          prompt: "This is an inline prompt body — FORBIDDEN"
          promptFile: .pi/prompts/real.md
`));

    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(yamlPath)).toThrow(/llm\.prompt.*inline.*forbidden|inline.*llm\.prompt.*forbidden/i);
  });

  it('S3b: action with llm.prompt only (no promptFile) → load fails', () => {
    const yamlPath = writeYaml('s3b_inline_only.yaml', minimalV2Yaml(`
      run-impl:
        type: prompt
        llm:
          prompt: "Inline body without promptFile"
`));

    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(yamlPath)).toThrow(/llm\.prompt|inline.*forbidden/i);
  });
});

// ---------------------------------------------------------------------------
// AC1: legacy top-level prompt field on v2 LLM action → rejected (load-bearing)
// ---------------------------------------------------------------------------

describe('pi-experiment-0njv AC1: top-level prompt field on v2 LLM action → rejected', () => {
  it('S4: v2 LLM action (has llm block) with top-level prompt field → load fails', () => {
    writeFile('.pi/prompts/real.md', 'prompt content');

    const yamlPath = writeYaml('s4_legacy_prompt.yaml', minimalV2Yaml(`
      run-impl:
        type: prompt
        prompt: "Legacy inline prompt — FORBIDDEN on v2 LLM action"
        llm:
          promptFile: .pi/prompts/real.md
`));

    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(yamlPath)).toThrow(/top-level prompt|legacy.*prompt.*forbidden|prompt.*forbidden.*v2 LLM/i);
  });
});

// ---------------------------------------------------------------------------
// AC1: missing llm.promptFile → rejected (load-bearing)
// ---------------------------------------------------------------------------

describe('pi-experiment-0njv AC1: missing llm.promptFile → rejected', () => {
  it('S5: v2 LLM action with empty llm block (no promptFile) → load fails', () => {
    const yamlPath = writeYaml('s5_missing_promptfile.yaml', minimalV2Yaml(`
      run-impl:
        type: prompt
        llm: {}
`));

    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(yamlPath)).toThrow(/promptFile.*required|must declare.*promptFile|without promptFile/i);
  });
});

// ---------------------------------------------------------------------------
// AC2: absolute path → rejected (load-bearing)
// ---------------------------------------------------------------------------

describe('pi-experiment-0njv AC2: absolute promptFile path → rejected', () => {
  it('S6: llm.promptFile is absolute → load fails before provider init', () => {
    const absPath = path.join(TEST_DIR, '.pi', 'prompts', 'abs.md');

    const yamlPath = writeYaml('s6_absolute.yaml', minimalV2Yaml(`
      run-impl:
        type: prompt
        llm:
          promptFile: "${absPath.replace(/\\/g, '/')}"
`));

    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(yamlPath)).toThrow(/absolute path|promptFile.*absolute/i);
  });
});

// ---------------------------------------------------------------------------
// AC2: `..` escape → rejected (load-bearing)
// ---------------------------------------------------------------------------

describe('pi-experiment-0njv AC2: .. escape via promptFile → rejected', () => {
  it('S7: llm.promptFile with .. that escapes project root → load fails', () => {
    // Create a file outside the project root (in parent of TEST_DIR)
    const parentDir = path.dirname(TEST_DIR);
    const outsideFile = path.join(parentDir, 'outside.md');
    fs.writeFileSync(outsideFile, 'outside content');

    try {
      // Compute a relative path from TEST_DIR that escapes to the parent
      const relEscape = path.join('..', path.basename(outsideFile));

      const yamlPath = writeYaml('s7_dotdot.yaml', minimalV2Yaml(`
      run-impl:
        type: prompt
        llm:
          promptFile: "${relEscape.replace(/\\/g, '/')}"
`));

      const loader = new ConfigLoader(undefined, TEST_DIR);
      expect(() => loader.load(yamlPath)).toThrow(/escape.*project root|escapes.*\.\.|outside.*project root/i);
    } finally {
      try { fs.unlinkSync(outsideFile); } catch { /* ignore */ }
    }
  });
});

// ---------------------------------------------------------------------------
// AC2: symlink escape → rejected (load-bearing; REAL symlink to outside root)
// ---------------------------------------------------------------------------

describe('pi-experiment-0njv AC2: symlink escape via promptFile → rejected', () => {
  it('S8: llm.promptFile is a symlink whose realpath is outside project root → load fails', () => {
    // Create a real file outside the project root
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-0njv-outside-'));
    const outsideFile = path.join(outsideDir, 'secret.md');
    fs.writeFileSync(outsideFile, 'secret content outside project root');

    // Create a symlink inside the project root that points to the outside file
    const symlinkPath = path.join(TEST_DIR, 'sym_escape.md');
    fs.symlinkSync(outsideFile, symlinkPath);

    try {
      const yamlPath = writeYaml('s8_symlink_escape.yaml', minimalV2Yaml(`
      run-impl:
        type: prompt
        llm:
          promptFile: sym_escape.md
`));

      const loader = new ConfigLoader(undefined, TEST_DIR);
      // The symlink exists inside the project root, but its realpath is outside.
      // A naive string check for `..` would NOT catch this. Only realpath() does.
      expect(() => loader.load(yamlPath)).toThrow(/symlink.*outside.*project root|resolves.*outside.*project root|symlink escape/i);
    } finally {
      try { fs.unlinkSync(symlinkPath); } catch { /* ignore */ }
      try { fs.rmSync(outsideDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

// ---------------------------------------------------------------------------
// AC2: directory path → rejected (load-bearing)
// ---------------------------------------------------------------------------

describe('pi-experiment-0njv AC2: directory as promptFile → rejected', () => {
  it('S9: llm.promptFile names a directory → load fails', () => {
    fs.mkdirSync(path.join(TEST_DIR, '.pi', 'prompts'), { recursive: true });

    const yamlPath = writeYaml('s9_directory.yaml', minimalV2Yaml(`
      run-impl:
        type: prompt
        llm:
          promptFile: .pi/prompts
`));

    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(yamlPath)).toThrow(/directory.*not.*file|is a directory/i);
  });
});

// ---------------------------------------------------------------------------
// AC2: nonexistent / unreadable file → rejected (load-bearing)
// ---------------------------------------------------------------------------

describe('pi-experiment-0njv AC2: nonexistent promptFile → rejected', () => {
  it('S10: llm.promptFile points to a nonexistent file → load fails', () => {
    const yamlPath = writeYaml('s10_missing.yaml', minimalV2Yaml(`
      run-impl:
        type: prompt
        llm:
          promptFile: .pi/prompts/does-not-exist.md
`));

    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(yamlPath)).toThrow(/does not exist|not.*exist|nonexistent/i);
  });
});

// ---------------------------------------------------------------------------
// VERSION GATE: v1 configs with top-level prompt field are unaffected
// ---------------------------------------------------------------------------

describe('pi-experiment-0njv version gate: v1 configs unaffected', () => {
  it('S11: v1 config (no version field) with inline prompt field loads without error', () => {
    const yamlPath = writeYaml('s11_v1_unaffected.yaml', `
settings:
  startState: Planning
  worktreePolicy:
    default: always
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan."
    actions:
      - id: plan
        type: prompt
        prompt: "Plan the work inline — this is a v1 config and is allowed."
    transitions: { SUCCESS: completed, FAILURE: Planning }
`);

    const loader = new ConfigLoader(undefined, TEST_DIR);
    let config: HarnessConfig | undefined;
    expect(() => { config = loader.load(yamlPath); }).not.toThrow();
    expect(config).toBeDefined();
    expect(config!.version).toBeUndefined();
  });

  it('S12: v2 config with action that has NO llm block (just type: prompt) is unaffected', () => {
    // An action without an `llm` block is NOT a v2 LLM action — prompt field is still allowed.
    const yamlPath = writeYaml('s12_v2_no_llm_block.yaml', minimalV2Yaml(`
      run-impl:
        type: prompt
        prompt: "Standard v2 prompt action without llm block — allowed."
`));

    const loader = new ConfigLoader(undefined, TEST_DIR);
    let config: HarnessConfig | undefined;
    expect(() => { config = loader.load(yamlPath); }).not.toThrow();
    expect(config).toBeDefined();
    // No v2PromptProvenance for actions without llm block
    const action = config!.states['implement'].actions[0] as unknown as Record<string, unknown>;
    expect(action['v2PromptProvenance']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC3: provenance correctness — byteCount and sha256 match file content
// ---------------------------------------------------------------------------

describe('pi-experiment-0njv AC3: provenance byteCount and sha256 are correct', () => {
  it('S13: provenance byteCount matches file size; sha256 matches manual digest', () => {
    const content = 'Exact content for digest verification.\n';
    writeFile('.pi/prompts/exact.md', content);

    const yamlPath = writeYaml('s13_provenance.yaml', minimalV2Yaml(`
      run-impl:
        type: prompt
        llm:
          promptFile: .pi/prompts/exact.md
`));

    const loader = new ConfigLoader(undefined, TEST_DIR);
    const config = loader.load(yamlPath);
    const prov = (config.states['implement'].actions[0] as unknown as Record<string, unknown>)['v2PromptProvenance'] as {
      byteCount: number; sha256: string; actionId: string; normalizedPath: string;
    };

    expect(prov.byteCount).toBe(Buffer.from(content).length);
    expect(prov.sha256).toBe(crypto.createHash('sha256').update(content).digest('hex'));
    expect(prov.actionId).toBe('run-impl');
    expect(prov.normalizedPath).not.toBe('');
    expect(path.isAbsolute(prov.normalizedPath)).toBe(false);
  });
});
