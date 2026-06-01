import * as fs from 'fs';
import * as path from 'path';
import fg from 'fast-glob';
import { SDLCState } from './domain/StateModels.js';
import { resolveProject } from './Paths.js';
import { CompatibilityContextDefaults } from '../constants/index.js';
import type { HarnessConfig } from './ConfigLoader.js';

const MARKDOWN_EXTENSION = '.md';
const COMPATIBILITY_GLOB_IGNORES = ['**/.DS_Store', '**/__pycache__/**'];
const HOOK_GLOB_IGNORES = ['.DS_Store', 'vendor/**', '__pycache__/**'];

export const CompatibilityPathGroup = {
  MASTER_RULES: 'masterRules',
  RULE_FILES: 'ruleFiles',
  HOOK_DIRS: 'hookDirs',
  HOOK_FILES: 'hookFiles',
  DOC_FILES: 'docFiles',
  AGENT_FILES: 'agentFiles'
} as const;

export type CompatibilityPathGroup = typeof CompatibilityPathGroup[keyof typeof CompatibilityPathGroup];

export interface CompatibilityContext {
  mode: string;
  masterRules: string[];
  ruleFiles: string[];
  hookDirs: string[];
  hookFiles: string[];
  docDirs: string[];
  docFiles: string[];
  agentDirs: string[];
  agentFiles: string[];
  truncated: Array<{ group: CompatibilityPathGroup; returned: number; total: number; limit: number }>;
  missing: Array<{ group: CompatibilityPathGroup; path: string }>;
}

export interface CompatibilityContextOptions {
  includeDocs?: boolean;
  includeAgents?: boolean;
  maxDocs?: number;
  maxAgents?: number;
}

export class InstructionLoader {
  public loadBaseInstructions(state: SDLCState): string {
    return state.baseInstructions;
  }

  private markdownFiles(dir: string): string[] {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
    return fg.sync(`**/*${MARKDOWN_EXTENSION}`, {
      cwd: dir,
      absolute: true,
      onlyFiles: true,
      dot: true,
      ignore: COMPATIBILITY_GLOB_IGNORES
    }).sort();
  }

  private directHookFiles(dir: string): string[] {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
    return fg.sync('*', {
      cwd: dir,
      absolute: true,
      onlyFiles: true,
      dot: true,
      ignore: HOOK_GLOB_IGNORES
    }).sort();
  }

  private existingFile(file: string): string | undefined {
    const fullPath = path.isAbsolute(file) ? file : resolveProject(file);
    return fs.existsSync(fullPath) && fs.statSync(fullPath).isFile() ? fullPath : undefined;
  }

  private existingDirectory(dir: string): string | undefined {
    const fullPath = path.isAbsolute(dir) ? dir : resolveProject(dir);
    return fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory() ? fullPath : undefined;
  }

  private positiveInteger(value: unknown, fallback: number): number {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
  }

  public loadRuleCategories(categories: string[]): string[] {
    const rules: string[] = [];
    const projectDir = resolveProject('.pi', 'rules');
    const installDir = path.join(process.cwd(), '.pi', 'rules');

    const searchDirs = [];
    if (fs.existsSync(projectDir)) searchDirs.push(projectDir);
    if (fs.existsSync(installDir)) searchDirs.push(installDir);

    for (const cat of categories) {
      for (const dir of searchDirs) {
        const catDir = path.join(dir, cat);
        if (fs.existsSync(catDir) && fs.statSync(catDir).isDirectory()) {
          const files = fg.sync(`*${MARKDOWN_EXTENSION}`, {
            cwd: catDir,
            absolute: true,
            onlyFiles: true
          }).sort();
          for (const file of files) {
            rules.push(fs.readFileSync(file, 'utf8'));
          }
        }
      }
    }
    return rules;
  }

  public compatibilityPaths(config?: HarnessConfig): string[] {
    const context = this.compatibilityContext(config);
    return [...context.masterRules, ...context.ruleFiles];
  }

  public compatibilityContext(config?: HarnessConfig, options: CompatibilityContextOptions = {}): CompatibilityContext {
    const mode = config?.settings.compatibilityMode;
    const empty: CompatibilityContext = {
      mode: mode || 'none',
      masterRules: [],
      ruleFiles: [],
      hookDirs: [],
      hookFiles: [],
      docDirs: [],
      docFiles: [],
      agentDirs: [],
      agentFiles: [],
      truncated: [],
      missing: []
    };
    if (!mode || mode === 'none') return empty;

    const discovery = config?.settings.compatibility?.modes?.[mode];
    if (!discovery) return empty;

    const recordMissing = (group: CompatibilityPathGroup, configuredPath: string) => {
      empty.missing.push({ group, path: path.isAbsolute(configuredPath) ? configuredPath : resolveProject(configuredPath) });
    };
    const limitFiles = (group: CompatibilityPathGroup, files: string[], limit: number): string[] => {
      const sorted = files.sort();
      if (sorted.length > limit) {
        empty.truncated.push({ group, returned: limit, total: sorted.length, limit });
      }
      return sorted.slice(0, limit);
    };
    const maxDocs = this.positiveInteger(options.maxDocs, CompatibilityContextDefaults.DOC_FILE_LIMIT);
    const maxAgents = this.positiveInteger(options.maxAgents, CompatibilityContextDefaults.AGENT_FILE_LIMIT);

    for (const file of discovery.masterRules || []) {
      const existing = this.existingFile(file);
      if (existing) empty.masterRules.push(existing);
      else recordMissing(CompatibilityPathGroup.MASTER_RULES, file);
    }

    for (const dir of discovery.ruleDirs || []) {
      const existing = this.existingDirectory(dir);
      if (existing) empty.ruleFiles.push(...this.markdownFiles(existing).sort());
      else recordMissing(CompatibilityPathGroup.RULE_FILES, dir);
    }

    for (const dir of discovery.hookDirs || []) {
      const existing = this.existingDirectory(dir);
      if (existing) {
        empty.hookDirs.push(existing);
        empty.hookFiles.push(...this.directHookFiles(existing));
      } else {
        recordMissing(CompatibilityPathGroup.HOOK_DIRS, dir);
      }
    }

    for (const dir of discovery.docsDirs || []) {
      const existing = this.existingDirectory(dir);
      if (existing) {
        empty.docDirs.push(existing);
        if (options.includeDocs === true) empty.docFiles.push(...limitFiles(
          CompatibilityPathGroup.DOC_FILES,
          this.markdownFiles(existing),
          maxDocs
        ));
      }
      else recordMissing(CompatibilityPathGroup.DOC_FILES, dir);
    }

    for (const dir of discovery.agentDirs || []) {
      const existing = this.existingDirectory(dir);
      if (existing) {
        empty.agentDirs.push(existing);
        if (options.includeAgents === true) empty.agentFiles.push(...limitFiles(
          CompatibilityPathGroup.AGENT_FILES,
          this.markdownFiles(existing),
          maxAgents
        ));
      }
      else recordMissing(CompatibilityPathGroup.AGENT_FILES, dir);
    }

    return empty;
  }

  public loadCompatibilityDocuments(config?: HarnessConfig): string[] {
    return this.compatibilityPaths(config).map(filePath => {
      return `# ${path.relative(resolveProject(), filePath)}\n${fs.readFileSync(filePath, 'utf8')}`;
    });
  }

  public assemble(state: SDLCState, config?: HarnessConfig): string {
    let rules = '';
    const harnessRulesPath = resolveProject('.pi', 'harness_rules.md');
    if (fs.existsSync(harnessRulesPath)) {
      rules += `### HARNESS OPERATIONAL RULES\n${fs.readFileSync(harnessRulesPath, 'utf8')}\n\n`;
    }

    const ruleCategories = state.ruleCategories || [];
    const catRules = this.loadRuleCategories(ruleCategories);
    if (catRules.length > 0) {
      rules += `### PROJECT-SPECIFIC RULES\n${catRules.join('\n\n')}\n\n`;
    }

    const compatibilityDocs = this.loadCompatibilityDocuments(config);
    if (compatibilityDocs.length > 0) {
      rules += `### COMPATIBILITY MODE FILES\n${compatibilityDocs.join('\n\n')}\n\n`;
    }

    return `
${state.identity.role.toUpperCase()} IDENTITY:
${state.identity.expertise}

CONSTRAINTS:
${state.identity.constraints.map(c => `- ${c}`).join('\n')}

BASE INSTRUCTIONS:
${state.baseInstructions}

${rules}
`.trim();
  }
}
