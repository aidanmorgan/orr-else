import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolvePiSkillPaths, resolvePiSkillPathsForState } from '../src/core/PiIntegration.js';
import type { HarnessConfig } from '../src/core/ConfigLoader.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSkillFile(root: string, skillName: string): string {
  const dir = path.join(root, '.pi', 'skills', skillName);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'SKILL.md');
  fs.writeFileSync(filePath, `# ${skillName} Skill\n`);
  return filePath;
}

function makeGlobalSkillFile(root: string, relPath: string): string {
  const filePath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `# Global Skill\n`);
  return filePath;
}

function baseConfig(overrides: Partial<HarnessConfig['settings']['pi']> = {}): HarnessConfig {
  return {
    settings: {
      maxConcurrentSlots: 1,
      handoverTemplate: 'handover',
      agentTurnTimeoutMs: 60000,
      processReapIntervalMs: 30000,
      harnessRestartEvent: 'restart',
      contextRestartEvent: 'ctx-restart',
      defaultModel: 'gpt-5',
      defaultProvider: 'openai',
      modelProviders: {},
      stateContextRotThreshold: 10,
      harnessContextRotThreshold: 20,
      pi: overrides
    },
    scheduler: { weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 } },
    states: {}
  } as unknown as HarnessConfig;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolvePiSkillPathsForState', () => {
  const root = path.join(os.tmpdir(), `pi-skill-resolution-test-${process.pid}`);

  beforeEach(() => {
    fs.mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // State-specific resolution
  // -------------------------------------------------------------------------

  it('resolves a single state skill name to its SKILL.md path', () => {
    const plannerPath = makeSkillFile(root, 'planner');
    const config = baseConfig();
    (config.states as any)['Planning'] = { skills: ['planner'] };

    const result = resolvePiSkillPathsForState(config, root, 'Planning');

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('planner');
    expect(result[0].path).toBe(plannerPath);
  });

  it('Planning state with skills:[planner] resolves ONLY planner SKILL.md — NOT reviewer/tester', () => {
    const plannerPath = makeSkillFile(root, 'planner');
    makeSkillFile(root, 'reviewer');
    makeSkillFile(root, 'tester');

    const config = baseConfig();
    (config.states as any)['Planning'] = { skills: ['planner'] };
    (config.states as any)['Review'] = { skills: ['reviewer'] };

    const result = resolvePiSkillPathsForState(config, root, 'Planning');

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('planner');
    expect(result[0].path).toBe(plannerPath);
    expect(result.map(s => s.name)).not.toContain('reviewer');
    expect(result.map(s => s.name)).not.toContain('tester');
  });

  it('resolves multiple state skills preserving order', () => {
    const plannerPath = makeSkillFile(root, 'planner');
    const toolRoutingPath = makeSkillFile(root, 'tool-routing');
    const artifactPath = makeSkillFile(root, 'artifact-evidence');

    const config = baseConfig();
    (config.states as any)['Planning'] = { skills: ['planner', 'tool-routing', 'artifact-evidence'] };

    const result = resolvePiSkillPathsForState(config, root, 'Planning');

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ name: 'planner', path: plannerPath });
    expect(result[1]).toEqual({ name: 'tool-routing', path: toolRoutingPath });
    expect(result[2]).toEqual({ name: 'artifact-evidence', path: artifactPath });
  });

  it('appends global skillPaths after state skills, deduplicating by path', () => {
    const plannerPath = makeSkillFile(root, 'planner');
    const globalPath = makeGlobalSkillFile(root, 'skills/quality/SKILL.md');

    const config = baseConfig({ skillPaths: ['skills/quality/SKILL.md'] });
    (config.states as any)['Planning'] = { skills: ['planner'] };

    const result = resolvePiSkillPathsForState(config, root, 'Planning');

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ name: 'planner', path: plannerPath });
    expect(result[1].path).toBe(globalPath);
  });

  it('does NOT duplicate a global skill that is already in state skills', () => {
    const plannerPath = makeSkillFile(root, 'planner');
    // planner SKILL.md at the convention path == what skillPaths resolves to
    const config = baseConfig({ skillPaths: [path.join('.pi', 'skills', 'planner', 'SKILL.md')] });
    (config.states as any)['Planning'] = { skills: ['planner'] };

    const result = resolvePiSkillPathsForState(config, root, 'Planning');

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe(plannerPath);
  });

  // -------------------------------------------------------------------------
  // Path-traversal guard
  // -------------------------------------------------------------------------

  it('throws a clear error when a state skill name contains ".." (path traversal)', () => {
    const config = baseConfig();
    (config.states as any)['Exploit'] = { skills: ['../../etc'] };

    expect(() => resolvePiSkillPathsForState(config, root, 'Exploit'))
      .toThrow(/State "Exploit" references skill "\.\.\/\.\.\/etc"/);
    expect(() => resolvePiSkillPathsForState(config, root, 'Exploit'))
      .toThrow(/escapes the skills directory/);
  });

  it('throws a clear error when a state skill name contains a leading path separator', () => {
    const config = baseConfig();
    (config.states as any)['Exploit'] = { skills: ['../escape'] };

    expect(() => resolvePiSkillPathsForState(config, root, 'Exploit'))
      .toThrow(/State "Exploit" references skill "\.\.\/escape"/);
    expect(() => resolvePiSkillPathsForState(config, root, 'Exploit'))
      .toThrow(/escapes the skills directory/);
  });

  it('does NOT resolve a traversal skill name outside .pi/skills', () => {
    const config = baseConfig();
    (config.states as any)['Exploit'] = { skills: ['../../etc'] };

    let thrownError: Error | undefined;
    try {
      resolvePiSkillPathsForState(config, root, 'Exploit');
    } catch (err) {
      thrownError = err as Error;
    }

    expect(thrownError).toBeDefined();
    // The error must fire before any filesystem access could escape the boundary.
    expect(thrownError!.message).not.toContain('SKILL.md was found at');
  });

  // -------------------------------------------------------------------------
  // Missing skill error
  // -------------------------------------------------------------------------

  it('throws a clear error when a state references a skill with no SKILL.md', () => {
    const config = baseConfig();
    (config.states as any)['Planning'] = { skills: ['nonexistent-skill'] };

    expect(() => resolvePiSkillPathsForState(config, root, 'Planning'))
      .toThrow(/State "Planning" references skill "nonexistent-skill"/);
    expect(() => resolvePiSkillPathsForState(config, root, 'Planning'))
      .toThrow(/SKILL\.md/);
  });

  // -------------------------------------------------------------------------
  // Backward-compatibility fallback
  // -------------------------------------------------------------------------

  it('falls back to global skillPaths when no stateId is provided', () => {
    const globalPath = makeGlobalSkillFile(root, 'skills/quality/SKILL.md');
    const config = baseConfig({ skillPaths: ['skills/quality/SKILL.md'] });

    const result = resolvePiSkillPathsForState(config, root);

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe(globalPath);
  });

  it('falls back to global skillPaths when the state has no skills array', () => {
    const globalPath = makeGlobalSkillFile(root, 'skills/quality/SKILL.md');
    const config = baseConfig({ skillPaths: ['skills/quality/SKILL.md'] });
    (config.states as any)['Planning'] = { skills: [] };  // empty skills

    const result = resolvePiSkillPathsForState(config, root, 'Planning');

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe(globalPath);
  });

  it('falls back to global skillPaths when the stateId does not exist in config', () => {
    const globalPath = makeGlobalSkillFile(root, 'skills/quality/SKILL.md');
    const config = baseConfig({ skillPaths: ['skills/quality/SKILL.md'] });

    const result = resolvePiSkillPathsForState(config, root, 'UnknownState');

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe(globalPath);
  });

  it('returns empty array when no state skills and no global skillPaths', () => {
    const config = baseConfig();
    (config.states as any)['Planning'] = {};

    const result = resolvePiSkillPathsForState(config, root, 'Planning');

    expect(result).toHaveLength(0);
  });

  it('throws for missing global skill in fallback mode', () => {
    const config = baseConfig({ skillPaths: ['skills/nonexistent/SKILL.md'] });

    expect(() => resolvePiSkillPathsForState(config, root))
      .toThrow(/does not exist/);
  });

  // -------------------------------------------------------------------------
  // existing resolvePiSkillPaths is unchanged
  // -------------------------------------------------------------------------

  it('existing resolvePiSkillPaths still works unchanged for backward compat', () => {
    const globalPath = makeGlobalSkillFile(root, 'skills/quality/SKILL.md');
    const config = baseConfig({ skillPaths: ['skills/quality/SKILL.md'] });

    const result = resolvePiSkillPaths(config, root);

    expect(result).toEqual([globalPath]);
  });
});
