/**
 * Unit tests for pi-experiment-amq0.13 PiIntegration split.
 *
 * Covers:
 *  - TemplateResolver: substitution, unknown-token passthrough, namedRoots, no-IO.
 *  - WorkerResourceResolver: skill resolution with fake filesystem port.
 *  - PromptProvenanceService: hashing with fake file/config ports.
 */
import { describe, expect, it } from 'vitest';
import * as crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// TemplateResolver (pure — no filesystem required)
// ---------------------------------------------------------------------------

import {
  resolveTemplateString,
  NAMED_ROOT_TOKEN_PREFIX,
  type TemplateContext
} from '../src/core/TemplateResolver.js';

describe('TemplateResolver — pure template substitution', () => {
  const baseContext: TemplateContext = {
    projectRoot: '/project',
    worktreePath: '/project/worktrees/my-bead',
    beadId: 'bd-abc',
    stateId: 'Planning',
    actionId: 'formulate-plan',
    toolName: 'run_checks',
    toolInvocationId: 'inv-123'
  };

  it('substitutes {{projectRoot}}', () => {
    expect(resolveTemplateString('{{projectRoot}}/output', baseContext)).toBe('/project/output');
  });

  it('substitutes {{worktreePath}}', () => {
    expect(resolveTemplateString('{{worktreePath}}/work', baseContext)).toBe('/project/worktrees/my-bead/work');
  });

  it('substitutes {{beadId}}', () => {
    expect(resolveTemplateString('prefix-{{beadId}}-suffix', baseContext)).toBe('prefix-bd-abc-suffix');
  });

  it('substitutes {{stateId}}', () => {
    expect(resolveTemplateString('state={{stateId}}', baseContext)).toBe('state=Planning');
  });

  it('substitutes {{toolName}}', () => {
    expect(resolveTemplateString('{{toolName}}.log', baseContext)).toBe('run_checks.log');
  });

  it('substitutes multiple tokens in one string', () => {
    const result = resolveTemplateString('{{projectRoot}}/beads/{{beadId}}/{{stateId}}', baseContext);
    expect(result).toBe('/project/beads/bd-abc/Planning');
  });

  it('leaves unknown tokens (no match in context) unchanged', () => {
    const result = resolveTemplateString('{{unknownToken}}', baseContext);
    expect(result).toBe('{{unknownToken}}');
  });

  it('skips substitution for undefined optional context fields', () => {
    const ctx: TemplateContext = { projectRoot: '/p', worktreePath: '/wt' };
    // frameworkRoot is undefined → {{frameworkRoot}} is left as-is
    expect(resolveTemplateString('{{frameworkRoot}}/x', ctx)).toBe('{{frameworkRoot}}/x');
  });

  it('substitutes {{roots.NAME}} from namedRoots', () => {
    const ctx: TemplateContext = {
      ...baseContext,
      namedRoots: { bankwest: '/repos/bankwest' }
    };
    expect(resolveTemplateString('{{roots.bankwest}}/src', ctx)).toBe('/repos/bankwest/src');
  });

  it('leaves {{roots.UNKNOWN}} unchanged when not in namedRoots', () => {
    const ctx: TemplateContext = {
      ...baseContext,
      namedRoots: { bankwest: '/repos/bankwest' }
    };
    expect(resolveTemplateString('{{roots.other}}/x', ctx)).toBe('{{roots.other}}/x');
  });

  it('NAMED_ROOT_TOKEN_PREFIX is exported and correct', () => {
    expect(NAMED_ROOT_TOKEN_PREFIX).toBe('{{roots.');
  });

  it('works with no optional fields at all (minimal context)', () => {
    const minimal: TemplateContext = { projectRoot: '/root', worktreePath: '/root' };
    expect(resolveTemplateString('{{projectRoot}}', minimal)).toBe('/root');
  });

  it('returns the string unchanged when no tokens match', () => {
    expect(resolveTemplateString('no tokens here', baseContext)).toBe('no tokens here');
  });

  it('handles empty string input', () => {
    expect(resolveTemplateString('', baseContext)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// WorkerResourceResolver — with fake filesystem port
// ---------------------------------------------------------------------------

import {
  resolvePiSkillPathsForState,
  resolveWorkerExtensionPaths,
  resolvePiSkillPaths,
  getConfiguredPiToolNames,
  type FileSystemPort
} from '../src/core/WorkerResourceResolver.js';
import type { HarnessConfig } from '../src/core/ConfigLoader.js';

function makeFakeFs(existingPaths: string[]): FileSystemPort {
  const pathSet = new Set(existingPaths);
  return { existsSync: (p) => pathSet.has(p) };
}

function baseConfig(piOverrides: Partial<HarnessConfig['settings']['pi']> = {}): HarnessConfig {
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
      pi: piOverrides
    },
    scheduler: { weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 } },
    states: {}
  } as unknown as HarnessConfig;
}

describe('WorkerResourceResolver — fake filesystem port', () => {
  describe('resolvePiSkillPaths', () => {
    it('resolves a global skill path that exists', () => {
      const config = baseConfig({ skillPaths: ['.pi/skills/foo/SKILL.md'] });
      const fakeFs = makeFakeFs(['/project/.pi/skills/foo/SKILL.md']);
      const result = resolvePiSkillPaths(config, '/project', fakeFs);
      expect(result).toEqual(['/project/.pi/skills/foo/SKILL.md']);
    });

    it('throws for a missing global skill path', () => {
      const config = baseConfig({ skillPaths: ['.pi/skills/missing/SKILL.md'] });
      const fakeFs = makeFakeFs([]);
      expect(() => resolvePiSkillPaths(config, '/project', fakeFs)).toThrow(
        'Configured Pi skill path does not exist'
      );
    });

    it('returns empty array when no skillPaths configured', () => {
      const config = baseConfig({});
      const fakeFs = makeFakeFs([]);
      expect(resolvePiSkillPaths(config, '/project', fakeFs)).toEqual([]);
    });
  });

  describe('resolvePiSkillPathsForState', () => {
    it('returns state skills + global skills without overlap', () => {
      const config = baseConfig({ skillPaths: ['.pi/skills/global/SKILL.md'] }) as any;
      config.states = {
        Planning: { skills: ['local-skill'] }
      };
      const localPath = '/project/.pi/skills/local-skill/SKILL.md';
      const globalPath = '/project/.pi/skills/global/SKILL.md';
      const fakeFs = makeFakeFs([localPath, globalPath]);

      const result = resolvePiSkillPathsForState(config, '/project', 'Planning', fakeFs);
      expect(result).toEqual([
        { name: 'local-skill', path: localPath },
        { name: 'global', path: globalPath }
      ]);
    });

    it('throws for a missing state skill', () => {
      const config = baseConfig() as any;
      config.states = { Planning: { skills: ['missing-skill'] } };
      const fakeFs = makeFakeFs([]);
      expect(() => resolvePiSkillPathsForState(config, '/project', 'Planning', fakeFs)).toThrow(
        'no SKILL.md was found'
      );
    });

    it('falls back to global skills when state has no skills array', () => {
      const config = baseConfig({ skillPaths: ['.pi/skills/global/SKILL.md'] }) as any;
      config.states = { Planning: {} };
      const globalPath = '/project/.pi/skills/global/SKILL.md';
      const fakeFs = makeFakeFs([globalPath]);
      const result = resolvePiSkillPathsForState(config, '/project', 'Planning', fakeFs);
      expect(result).toEqual([{ name: 'global', path: globalPath }]);
    });

    it('rejects a skill name with path traversal attempt', () => {
      const config = baseConfig() as any;
      config.states = { Planning: { skills: ['../../../etc/passwd'] } };
      const fakeFs = makeFakeFs([]);
      expect(() => resolvePiSkillPathsForState(config, '/project', 'Planning', fakeFs)).toThrow(
        'escapes the skills directory'
      );
    });
  });

  describe('resolveWorkerExtensionPaths', () => {
    it('resolves primary + additional extension paths', () => {
      const config = baseConfig({ workerExtensions: ['./extra-extension.js'] });
      const fakeFs = makeFakeFs([
        '/project/dist/extension.js',
        '/project/extra-extension.js'
      ]);
      const result = resolveWorkerExtensionPaths(config, '/project', '/project/dist/extension.js', fakeFs);
      expect(result).toEqual(['/project/dist/extension.js', '/project/extra-extension.js']);
    });

    it('throws when primary extension path does not exist', () => {
      const config = baseConfig({});
      const fakeFs = makeFakeFs([]);
      expect(() => resolveWorkerExtensionPaths(config, '/project', '/project/missing.js', fakeFs)).toThrow(
        'Configured Pi worker extension does not exist'
      );
    });
  });

  describe('getConfiguredPiToolNames', () => {
    it('returns unique non-empty tool names', () => {
      const config = baseConfig({ tools: ['toolA', 'toolB', 'toolA', ''] });
      expect(getConfiguredPiToolNames(config)).toEqual(['toolA', 'toolB']);
    });

    it('returns empty array when no tools configured', () => {
      const config = baseConfig({});
      expect(getConfiguredPiToolNames(config)).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// PromptProvenanceService — with fake file/config ports
// ---------------------------------------------------------------------------

import {
  resolvePromptProvenance,
  detectStaleProvenanceEntries,
  computeCurrentStateConfigHash,
  type FileReadPort
} from '../src/core/PromptProvenanceService.js';
import { PromptProvenanceKind } from '../src/constants/domain.js';
import { PromptProvenanceDefaults } from '../src/constants/infra.js';

function sha256hex(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function makeFakeFilePort(files: Record<string, string>): FileReadPort {
  return {
    readFile(filePath: string): Buffer | null {
      const content = files[filePath];
      return content !== undefined ? Buffer.from(content, 'utf8') : null;
    },
    statFile(filePath: string): { isFile(): boolean } | null {
      return files[filePath] !== undefined ? { isFile: () => true } : null;
    }
  };
}

function makeFakeFsPort(existingPaths: string[]): FileSystemPort {
  const pathSet = new Set(existingPaths);
  return { existsSync: (p) => pathSet.has(p) };
}

const minimalYaml = `
settings:
  startState: Planning
  worktreePolicy:
    default: always
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    actions:
      - id: formulate-plan
        type: prompt
        prompt: "Plan the work"
    requiredTools: []
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`;

describe('PromptProvenanceService — fake port hashing', () => {
  const configPath = '/project/harness.yaml';
  const projectRoot = '/project';
  const config: any = {
    settings: { workflowVersion: '1.0' },
    states: {
      Planning: {
        actions: [{ id: 'formulate-plan', prompt: 'Plan the work' }]
      }
    }
  };

  describe('resolvePromptProvenance', () => {
    it('records the harness config SHA-256 from fake file content', () => {
      const filePort = makeFakeFilePort({ [configPath]: minimalYaml });
      const fsPort = makeFakeFsPort([]);

      const provenance = resolvePromptProvenance(config, projectRoot, 'Planning', configPath, filePort, fsPort);

      const configEntry = provenance.entries.find(e => e.kind === PromptProvenanceKind.HARNESS_CONFIG);
      expect(configEntry).toBeDefined();
      expect(configEntry!.sha256).toBe(sha256hex(minimalYaml));
      expect(configEntry!.missing).toBeUndefined();
      expect(configEntry!.blocking).toBe(false);
    });

    it('records missing: true when config file is absent', () => {
      const filePort = makeFakeFilePort({});
      const fsPort = makeFakeFsPort([]);

      const provenance = resolvePromptProvenance(config, projectRoot, 'Planning', configPath, filePort, fsPort);

      const configEntry = provenance.entries.find(e => e.kind === PromptProvenanceKind.HARNESS_CONFIG);
      expect(configEntry!.sha256).toBe(PromptProvenanceDefaults.MISSING_HASH);
      expect(configEntry!.missing).toBe(true);
    });

    it('records harnessConfigVersion from settings.workflowVersion', () => {
      const filePort = makeFakeFilePort({ [configPath]: minimalYaml });
      const fsPort = makeFakeFsPort([]);

      const provenance = resolvePromptProvenance(config, projectRoot, 'Planning', configPath, filePort, fsPort);
      expect(provenance.harnessConfigVersion).toBe('1.0');
    });

    it('records SKILL_PROMPT entries for state skills via fake ports', () => {
      const skillPath = '/project/.pi/skills/coding/SKILL.md';
      const skillContent = '# Coding Skill\nDo the coding.';
      const filePort = makeFakeFilePort({
        [configPath]: minimalYaml,
        [skillPath]: skillContent
      });
      const fsPort = makeFakeFsPort([skillPath]);

      const configWithSkill: any = {
        settings: { workflowVersion: '1.0' },
        states: {
          Planning: {
            skills: ['coding'],
            actions: [{ id: 'formulate-plan', prompt: 'Plan the work' }]
          }
        }
      };

      const provenance = resolvePromptProvenance(
        configWithSkill,
        projectRoot,
        'Planning',
        configPath,
        filePort,
        fsPort
      );

      const skillEntry = provenance.entries.find(e => e.kind === PromptProvenanceKind.SKILL_PROMPT);
      expect(skillEntry).toBeDefined();
      expect(skillEntry!.path).toBe(skillPath);
      expect(skillEntry!.sha256).toBe(sha256hex(skillContent));
    });

    it('records configuredSourceFailed: true when a state skill is missing', () => {
      const filePort = makeFakeFilePort({ [configPath]: minimalYaml });
      // Skill file does NOT exist in the fake fs.
      const fsPort = makeFakeFsPort([]);

      const configWithSkill: any = {
        settings: { workflowVersion: '1.0' },
        states: {
          Planning: {
            skills: ['missing-skill'],
            actions: [{ id: 'formulate-plan', prompt: 'Plan the work' }]
          }
        }
      };

      const provenance = resolvePromptProvenance(
        configWithSkill,
        projectRoot,
        'Planning',
        configPath,
        filePort,
        fsPort
      );

      expect(provenance.configuredSourceFailed).toBe(true);
    });

    it('includes a state-config-subtree (blocking) entry', () => {
      const filePort = makeFakeFilePort({ [configPath]: minimalYaml });
      const fsPort = makeFakeFsPort([]);

      const provenance = resolvePromptProvenance(config, projectRoot, 'Planning', configPath, filePort, fsPort);

      const subtreeEntry = provenance.entries.find(e => e.kind === 'stateConfig');
      expect(subtreeEntry).toBeDefined();
      expect(subtreeEntry!.path).toBe('stateConfig:Planning');
      // No blocking: false → it IS blocking by default.
      expect(subtreeEntry!.blocking).toBeUndefined();
    });
  });

  describe('detectStaleProvenanceEntries — fake file port', () => {
    it('returns empty when all hashes match', () => {
      const filePath = '/project/prompt.md';
      const content = 'original content';
      const filePort = makeFakeFilePort({ [filePath]: content });

      const entries = [
        { kind: PromptProvenanceKind.STATE_PROMPT, path: filePath, sha256: sha256hex(content) }
      ];
      expect(detectStaleProvenanceEntries(entries, filePort)).toEqual([]);
    });

    it('returns path when file content changed', () => {
      const filePath = '/project/prompt.md';
      const originalContent = 'original content';
      const changedContent = 'updated content';
      // Port returns changed content but recorded hash was original.
      const filePort = makeFakeFilePort({ [filePath]: changedContent });

      const entries = [
        { kind: PromptProvenanceKind.STATE_PROMPT, path: filePath, sha256: sha256hex(originalContent) }
      ];
      expect(detectStaleProvenanceEntries(entries, filePort)).toContain(filePath);
    });

    it('returns path when a file that existed is now missing', () => {
      const filePath = '/project/prompt.md';
      // Port has no files → file is "gone".
      const filePort = makeFakeFilePort({});

      const entries = [
        { kind: PromptProvenanceKind.STATE_PROMPT, path: filePath, sha256: sha256hex('content') }
      ];
      expect(detectStaleProvenanceEntries(entries, filePort)).toContain(filePath);
    });

    it('skips non-blocking (audit-only) entries', () => {
      const filePath = '/project/harness.yaml';
      // File changed but it is audit-only.
      const filePort = makeFakeFilePort({ [filePath]: 'new content' });

      const entries = [
        {
          kind: PromptProvenanceKind.HARNESS_CONFIG,
          path: filePath,
          sha256: sha256hex('old content'),
          blocking: false as const
        }
      ];
      // Should NOT report stale because blocking: false.
      expect(detectStaleProvenanceEntries(entries, filePort)).toEqual([]);
    });

    it('skips stateConfig-kind entries (checked separately by gate)', () => {
      const filePort = makeFakeFilePort({});
      const entries = [
        {
          kind: 'stateConfig' as any,
          path: 'stateConfig:Planning',
          sha256: 'some-hash'
        }
      ];
      expect(detectStaleProvenanceEntries(entries, filePort)).toEqual([]);
    });
  });

  describe('computeCurrentStateConfigHash — fake file port', () => {
    it('returns identifier and sha256 from raw yaml', () => {
      const filePort = makeFakeFilePort({ [configPath]: minimalYaml });
      const result = computeCurrentStateConfigHash(configPath, 'Planning', filePort);
      expect(result.identifier).toBe('stateConfig:Planning');
      expect(typeof result.sha256).toBe('string');
      expect(result.sha256.length).toBeGreaterThan(0);
      expect(result.missing).toBeUndefined();
    });

    it('returns missing: true when config file absent', () => {
      const filePort = makeFakeFilePort({});
      const result = computeCurrentStateConfigHash(configPath, 'Planning', filePort);
      expect(result.missing).toBe(true);
      expect(result.sha256).toBe(PromptProvenanceDefaults.MISSING_HASH);
    });

    it('returns same hash for same config content (deterministic)', () => {
      const filePort = makeFakeFilePort({ [configPath]: minimalYaml });
      const r1 = computeCurrentStateConfigHash(configPath, 'Planning', filePort);
      const r2 = computeCurrentStateConfigHash(configPath, 'Planning', filePort);
      expect(r1.sha256).toBe(r2.sha256);
    });

    it('returns different hashes for different state subtrees', () => {
      const yaml1 = minimalYaml;
      const yaml2 = minimalYaml.replace('"Plan"', '"Plan UPDATED"');
      const port1 = makeFakeFilePort({ [configPath]: yaml1 });
      const port2 = makeFakeFilePort({ [configPath]: yaml2 });
      const r1 = computeCurrentStateConfigHash(configPath, 'Planning', port1);
      const r2 = computeCurrentStateConfigHash(configPath, 'Planning', port2);
      expect(r1.sha256).not.toBe(r2.sha256);
    });
  });
});
