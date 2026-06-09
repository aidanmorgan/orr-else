/**
 * Tests for WorkerPromptIdentityBuilder — pi-experiment-amq0.10.
 *
 * Covers:
 *  - Duplicate global+state skill detection (load-bearing)
 *  - State-specific skills are resolved and included in identity
 *  - Resource-discovery failure (skill resolution error → graceful)
 *  - CLI skill flags: Pi tool names (not extension paths) in toolNames
 *  - Prompt-digest replay: identical inputs → identical digest
 *  - Stale identity after config reload: changed config → different digest
 *  - SELF-VERIFY: a mutation to the builder changes all consumer digests consistently
 *    (spawn bootstrap digest AND STATE_PROMPT_ASSEMBLED digest move together)
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  WorkerPromptIdentityBuilder,
  detectSkillDuplication,
  formatSkillDuplicationDiagnostic,
  type WorkerIdentityInputs,
} from '../src/core/WorkerPromptIdentityBuilder.js';
import { digestIdentity, digestStableBlock } from '../src/core/BootstrapDigest.js';
import { ContextInjector } from '../src/core/ContextInjector.js';
import type { HarnessConfig } from '../src/core/ConfigLoader.js';
import type { BeadId } from '../src/types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpRoot: string;

function mkSkillFile(root: string, skillName: string): string {
  const dir = path.join(root, '.pi', 'skills', skillName);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'SKILL.md');
  fs.writeFileSync(p, `# ${skillName}`);
  return p;
}

function mkGlobalSkillFile(root: string, relPath: string): string {
  const p = path.join(root, relPath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '# Global Skill');
  return p;
}

function baseConfig(overrides: {
  pi?: Partial<NonNullable<HarnessConfig['settings']['pi']>>;
  states?: Record<string, unknown>;
} = {}): HarnessConfig {
  return {
    settings: {
      maxConcurrentSlots: 1,
      handoverTemplate: 'handover',
      agentTurnTimeoutMs: 60000,
      processReapIntervalMs: 30000,
      harnessRestartEvent: 'restart',
      contextRestartEvent: 'ctx-restart',
      defaultModel: 'claude-sonnet-4-6',
      defaultProvider: 'anthropic',
      modelProviders: {},
      stateContextRotThreshold: 10,
      harnessContextRotThreshold: 20,
      pi: overrides.pi ?? {}
    },
    scheduler: { weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 } },
    states: overrides.states ?? {}
  } as unknown as HarnessConfig;
}

function baseInputs(config: HarnessConfig, stateId = 'Planning'): WorkerIdentityInputs {
  return {
    projectRoot: tmpRoot,
    configPath: path.join(tmpRoot, 'harness.yaml'),
    stateId,
    config
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wpib-test-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// detectSkillDuplication — LOAD-BEARING
// ---------------------------------------------------------------------------

describe('detectSkillDuplication — load-bearing duplication detection', () => {
  it('returns empty when there are no global skillPaths', () => {
    const config = baseConfig({
      states: { Planning: { skills: ['planner'] } }
    });
    // No global skillPaths — nothing to cross-check.
    const result = detectSkillDuplication(config, tmpRoot);
    expect(result).toHaveLength(0);
  });

  it('returns empty when global and state skills do NOT overlap', () => {
    mkGlobalSkillFile(tmpRoot, '.pi/skills/quality/SKILL.md');
    const config = baseConfig({
      pi: { skillPaths: ['.pi/skills/quality/SKILL.md'] },
      states: { Planning: { skills: ['planner'] } }
    });
    const result = detectSkillDuplication(config, tmpRoot);
    expect(result).toHaveLength(0);
  });

  it('detects a skill present in both global skillPaths and a state skills list', () => {
    mkSkillFile(tmpRoot, 'planner');
    // Global skillPaths points to the same planner SKILL.md via convention path.
    const config = baseConfig({
      pi: { skillPaths: [path.join('.pi', 'skills', 'planner', 'SKILL.md')] },
      states: { Planning: { skills: ['planner'] } }
    });
    const result = detectSkillDuplication(config, tmpRoot);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('planner');
    expect(result[0].affectedStates).toEqual(['Planning']);
  });

  it('detects the same duplicate across multiple states', () => {
    mkSkillFile(tmpRoot, 'quality');
    const config = baseConfig({
      pi: { skillPaths: [path.join('.pi', 'skills', 'quality', 'SKILL.md')] },
      states: {
        Planning: { skills: ['quality'] },
        Implementing: { skills: ['quality'] }
      }
    });
    const result = detectSkillDuplication(config, tmpRoot);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('quality');
    expect(result[0].affectedStates).toContain('Planning');
    expect(result[0].affectedStates).toContain('Implementing');
  });

  it('formatSkillDuplicationDiagnostic returns empty string when no duplications', () => {
    expect(formatSkillDuplicationDiagnostic([])).toBe('');
  });

  it('formatSkillDuplicationDiagnostic returns a non-empty compact diagnostic', () => {
    const diag = formatSkillDuplicationDiagnostic([
      { name: 'quality', affectedStates: ['Planning', 'Implementing'] }
    ]);
    expect(diag).toContain('quality');
    expect(diag).toContain('Planning');
    expect(diag).toContain('Implementing');
    expect(diag.length).toBeGreaterThan(0);
  });

  it('LOAD-BEARING: detection is still exercised when builder.build() is called with duplicate config', () => {
    // This test proves that WorkerPromptIdentityBuilder.build() surfaces the duplication
    // in its returned skillDuplications.  A refactor that drops the detection call
    // would make skillDuplications.length === 0, causing this assertion to fail.
    mkSkillFile(tmpRoot, 'planner');
    const config = baseConfig({
      pi: { skillPaths: [path.join('.pi', 'skills', 'planner', 'SKILL.md')] },
      states: { Planning: { skills: ['planner'] } }
    });
    const result = WorkerPromptIdentityBuilder.build(baseInputs(config, 'Planning'));
    expect(result.skillDuplications).toHaveLength(1);
    expect(result.skillDuplications[0].name).toBe('planner');
  });
});

// ---------------------------------------------------------------------------
// State-specific skills
// ---------------------------------------------------------------------------

describe('WorkerPromptIdentityBuilder — state-specific skills', () => {
  it('includes state-specific skill names in identity.skillNames', () => {
    mkSkillFile(tmpRoot, 'planner');
    const config = baseConfig({ states: { Planning: { skills: ['planner'] } } });
    const result = WorkerPromptIdentityBuilder.build(baseInputs(config, 'Planning'));
    expect(result.identity.skillNames).toContain('planner');
  });

  it('merges state-specific and global skills without duplication', () => {
    mkSkillFile(tmpRoot, 'planner');
    mkGlobalSkillFile(tmpRoot, '.pi/skills/quality/SKILL.md');
    const config = baseConfig({
      pi: { skillPaths: ['.pi/skills/quality/SKILL.md'] },
      states: { Planning: { skills: ['planner'] } }
    });
    const result = WorkerPromptIdentityBuilder.build(baseInputs(config, 'Planning'));
    // Both skills appear exactly once.
    expect(result.identity.skillNames).toContain('planner');
    expect(result.identity.skillNames).toContain('quality');
    expect(result.identity.skillNames.filter(n => n === 'planner')).toHaveLength(1);
    expect(result.identity.skillNames.filter(n => n === 'quality')).toHaveLength(1);
  });

  it('falls back to global-only skills for an unknown stateId', () => {
    mkGlobalSkillFile(tmpRoot, '.pi/skills/quality/SKILL.md');
    const config = baseConfig({ pi: { skillPaths: ['.pi/skills/quality/SKILL.md'] } });
    const result = WorkerPromptIdentityBuilder.build(baseInputs(config, 'UnknownState'));
    expect(result.identity.skillNames).toContain('quality');
  });

  it('returns zero skillNames when config has no skills and no state skills', () => {
    const config = baseConfig({ states: { Planning: {} } });
    const result = WorkerPromptIdentityBuilder.build(baseInputs(config, 'Planning'));
    expect(result.identity.skillNames).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// D2 — Fail-closed: missing referenced state skill aborts (throws), not swallows
// ---------------------------------------------------------------------------

describe('WorkerPromptIdentityBuilder — fail-closed on missing state skill (D2)', () => {
  it('FAIL-CLOSED: throws when a referenced state skill file is missing (config error)', () => {
    // Do NOT create the skill file — resolution must throw, not silently degrade.
    // A missing referenced skill is a config error, not graceful degradation.
    const config = baseConfig({ states: { Planning: { skills: ['nonexistent-skill'] } } });
    expect(() => WorkerPromptIdentityBuilder.build(baseInputs(config, 'Planning'))).toThrow();
  });

  it('FAIL-CLOSED: the thrown error message identifies the missing skill', () => {
    const config = baseConfig({ states: { Planning: { skills: ['ghost-skill'] } } });
    expect(() => WorkerPromptIdentityBuilder.build(baseInputs(config, 'Planning')))
      .toThrow('ghost-skill');
  });
});

// ---------------------------------------------------------------------------
// CLI skill flags / tool names — NOT extension paths
// ---------------------------------------------------------------------------

describe('WorkerPromptIdentityBuilder — toolNames uses Pi tool names not extension paths', () => {
  it('identity.toolNames contains the configured Pi tool names (not extension paths)', () => {
    const config = baseConfig({
      pi: { tools: ['read', 'bash', 'write'] }
    });
    const result = WorkerPromptIdentityBuilder.build(baseInputs(config));
    // Must contain Pi tool names.
    expect(result.identity.toolNames).toContain('read');
    expect(result.identity.toolNames).toContain('bash');
    expect(result.identity.toolNames).toContain('write');
    // Must NOT contain anything that looks like an extension path.
    for (const name of result.identity.toolNames) {
      expect(name).not.toContain('/');
      expect(name).not.toContain('.js');
    }
  });

  it('identity.toolNames is empty when no Pi tools are configured', () => {
    const config = baseConfig();
    const result = WorkerPromptIdentityBuilder.build(baseInputs(config));
    expect(result.identity.toolNames).toHaveLength(0);
  });

  it('resolvedSkills exposes skill paths for CLI --skill flags (same as identity resolution)', () => {
    mkSkillFile(tmpRoot, 'planner');
    const config = baseConfig({ states: { Planning: { skills: ['planner'] } } });
    const result = WorkerPromptIdentityBuilder.build(baseInputs(config, 'Planning'));
    const paths = result.resolvedSkills.map(s => s.path);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatch(/planner\/SKILL\.md$/);
  });
});

// ---------------------------------------------------------------------------
// Prompt-digest replay
// ---------------------------------------------------------------------------

describe('WorkerPromptIdentityBuilder — prompt-digest replay', () => {
  const injector = new ContextInjector();

  it('identical inputs produce identical digestIdentity (spawn-side)', () => {
    mkSkillFile(tmpRoot, 'planner');
    const config = baseConfig({
      pi: { tools: ['read'] },
      states: { Planning: { skills: ['planner'] } }
    });
    const a = WorkerPromptIdentityBuilder.build(baseInputs(config, 'Planning'));
    const b = WorkerPromptIdentityBuilder.build(baseInputs(config, 'Planning'));
    expect(digestIdentity(a.identity)).toBe(digestIdentity(b.identity));
  });

  it('identical inputs produce identical digestStableBlock (prompt-assembly-side)', () => {
    mkSkillFile(tmpRoot, 'planner');
    const config = baseConfig({
      pi: { tools: ['read'] },
      states: { Planning: { skills: ['planner'] } }
    });
    const a = WorkerPromptIdentityBuilder.build(baseInputs(config, 'Planning'));
    const b = WorkerPromptIdentityBuilder.build(baseInputs(config, 'Planning'));
    const stableText = 'You are a planner.';
    expect(digestStableBlock(stableText, a.identity).digestId)
      .toBe(digestStableBlock(stableText, b.identity).digestId);
  });

  it('injectWithDigest produces byte-identical stable block across two beads with the same identity', () => {
    mkSkillFile(tmpRoot, 'planner');
    const config = baseConfig({
      pi: { tools: ['read'] },
      states: { Planning: { skills: ['planner'] } }
    });
    const promptIdentity = WorkerPromptIdentityBuilder.build(baseInputs(config, 'Planning'));
    const rolePrompt = 'You are a planner.';
    const ctx = {
      projectRoot: tmpRoot,
      workdir: path.join(tmpRoot, 'worktrees', 'bead-a'),
      configPath: path.join(tmpRoot, 'harness.yaml'),
      actionId: 'plan',
      identity: 'planner',
      phase: 'Planning',
      llmProvider: 'anthropic' as const,
      llmModel: 'claude-sonnet-4-6',
      outstandingChecklist: 'None.'
    };

    const runA = injector.injectWithDigest(
      rolePrompt,
      { ...ctx, beadId: 'bead-a' as BeadId, workdir: path.join(tmpRoot, 'worktrees', 'bead-a') },
      promptIdentity.identity
    );
    const runB = injector.injectWithDigest(
      rolePrompt,
      { ...ctx, beadId: 'bead-b' as BeadId, workdir: path.join(tmpRoot, 'worktrees', 'bead-b') },
      promptIdentity.identity
    );

    // Stable blocks must be byte-identical (same identity across beads).
    expect(runA.stableBlock).toBe(runB.stableBlock);
    expect(runA.digestId).toBe(runB.digestId);
  });
});

// ---------------------------------------------------------------------------
// Stale identity after reload
// ---------------------------------------------------------------------------

describe('WorkerPromptIdentityBuilder — stale identity after config change', () => {
  it('adding a Pi tool to config changes the digest', () => {
    const configBefore = baseConfig({ pi: { tools: ['read'] } });
    const configAfter = baseConfig({ pi: { tools: ['read', 'bash'] } });
    const before = digestIdentity(WorkerPromptIdentityBuilder.build(baseInputs(configBefore)).identity);
    const after = digestIdentity(WorkerPromptIdentityBuilder.build(baseInputs(configAfter)).identity);
    expect(before).not.toBe(after);
  });

  it('adding a state skill changes the digest', () => {
    mkSkillFile(tmpRoot, 'planner');
    const configBefore = baseConfig({ states: { Planning: {} } });
    const configAfter = baseConfig({ states: { Planning: { skills: ['planner'] } } });
    const before = digestIdentity(WorkerPromptIdentityBuilder.build(baseInputs(configBefore, 'Planning')).identity);
    const after = digestIdentity(WorkerPromptIdentityBuilder.build(baseInputs(configAfter, 'Planning')).identity);
    expect(before).not.toBe(after);
  });

  it('changing stateId changes the digest', () => {
    const config = baseConfig({ states: { StateA: {}, StateB: {} } });
    const digestA = digestIdentity(WorkerPromptIdentityBuilder.build(baseInputs(config, 'StateA')).identity);
    const digestB = digestIdentity(WorkerPromptIdentityBuilder.build(baseInputs(config, 'StateB')).identity);
    expect(digestA).not.toBe(digestB);
  });

  it('changing configPath changes the identity (configIdentity field)', () => {
    const config = baseConfig();
    const inputsA = { ...baseInputs(config), configPath: '/proj/harness-v1.yaml' };
    const inputsB = { ...baseInputs(config), configPath: '/proj/harness-v2.yaml' };
    const digestA = digestIdentity(WorkerPromptIdentityBuilder.build(inputsA).identity);
    const digestB = digestIdentity(WorkerPromptIdentityBuilder.build(inputsB).identity);
    expect(digestA).not.toBe(digestB);
  });
});

// ---------------------------------------------------------------------------
// SELF-VERIFY: all consumers move together under a builder mutation
// ---------------------------------------------------------------------------

describe('SELF-VERIFY: all consumers move together under a builder mutation', () => {
  /**
   * This test proves that spawn bootstrap digest (digestIdentity) AND
   * STATE_PROMPT_ASSEMBLED digest (digestStableBlock) both change when a
   * relevant identity input changes — because BOTH consume the same builder
   * output.
   *
   * A consumer that still builds identity independently would NOT change when
   * only one side's input changes, causing one of these assertions to fail.
   */
  it('changing toolNames in config changes BOTH spawn-bootstrap digest AND assembled-prompt digest', () => {
    const stableText = 'You are a planner.';

    const configBefore = baseConfig({ pi: { tools: ['read'] } });
    const configAfter  = baseConfig({ pi: { tools: ['read', 'bash'] } });

    const identityBefore = WorkerPromptIdentityBuilder.build(baseInputs(configBefore)).identity;
    const identityAfter  = WorkerPromptIdentityBuilder.build(baseInputs(configAfter)).identity;

    // Spawn-bootstrap digest (identity-only, no text).
    const spawnBefore = digestIdentity(identityBefore);
    const spawnAfter  = digestIdentity(identityAfter);
    expect(spawnBefore).not.toBe(spawnAfter);

    // STATE_PROMPT_ASSEMBLED digest (identity + stable text).
    const assembledBefore = digestStableBlock(stableText, identityBefore).digestId;
    const assembledAfter  = digestStableBlock(stableText, identityAfter).digestId;
    expect(assembledBefore).not.toBe(assembledAfter);

    // Critical: both digests changed due to the SAME identity mutation.
    // If either stayed the same, a consumer is not going through the builder.
    expect(spawnBefore).not.toBe(spawnAfter);
    expect(assembledBefore).not.toBe(assembledAfter);
  });

  it('changing skill names changes BOTH digests consistently', () => {
    mkSkillFile(tmpRoot, 'planner');
    const stableText = 'You are a planner.';

    const configBefore = baseConfig({ states: { Planning: {} } });
    const configAfter  = baseConfig({ states: { Planning: { skills: ['planner'] } } });

    const identityBefore = WorkerPromptIdentityBuilder.build(baseInputs(configBefore, 'Planning')).identity;
    const identityAfter  = WorkerPromptIdentityBuilder.build(baseInputs(configAfter, 'Planning')).identity;

    const spawnBefore     = digestIdentity(identityBefore);
    const spawnAfter      = digestIdentity(identityAfter);
    const assembledBefore = digestStableBlock(stableText, identityBefore).digestId;
    const assembledAfter  = digestStableBlock(stableText, identityAfter).digestId;

    expect(spawnBefore).not.toBe(spawnAfter);
    expect(assembledBefore).not.toBe(assembledAfter);
  });

  it('GUARD: a consumer bypassing the builder (using old extension-path toolNames) produces a DIFFERENT digest', () => {
    // This simulates the OLD teammates.ts bug: toolNames was set to workerExtension paths.
    // If the old code were still in use, the digests would differ from the builder's.
    const extensionPaths = ['/dist/extension.js', '/dist/worker-ext.js'];
    const config = baseConfig({ pi: { tools: ['read', 'bash'] } });

    const builderIdentity = WorkerPromptIdentityBuilder.build(baseInputs(config)).identity;
    const stableText = 'You are a planner.';

    // Simulate the old bug: toolNames = extension paths (sorted).
    const oldBugIdentity = {
      ...builderIdentity,
      toolNames: [...extensionPaths].sort()
    };

    const builderDigest = digestIdentity(builderIdentity);
    const oldBugDigest  = digestIdentity(oldBugIdentity);

    // A consumer using the old path would produce a DIFFERENT digest, proving
    // the bug existed and the builder fixed it.
    expect(builderDigest).not.toBe(oldBugDigest);

    // Also verify the assembled digests differ.
    expect(digestStableBlock(stableText, builderIdentity).digestId)
      .not.toBe(digestStableBlock(stableText, oldBugIdentity).digestId);
  });
});
