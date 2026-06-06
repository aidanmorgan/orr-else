import * as fs from 'fs';
import * as path from 'path';
import fg from 'fast-glob';
import { SDLCState } from './domain/StateModels.js';
import { resolveInstall, resolveProjectFrom } from './Paths.js';
import type { HarnessConfig } from './ConfigLoader.js';

const MARKDOWN_EXTENSION = '.md';

export class InstructionLoader {
  constructor(private readonly projectRoot: string = process.cwd()) {}

  public loadBaseInstructions(state: SDLCState): string {
    return state.baseInstructions ?? '';
  }

  public loadRuleCategories(categories: string[]): string[] {
    const rules: string[] = [];
    const projectDir = resolveProjectFrom(this.projectRoot, '.pi', 'rules');
    // Bundled rules ship under the harness INSTALL root (PATH_INSTALL_ROOT), not
    // the caller's cwd — resolve via resolveInstall so the lookup is independent
    // of the working directory.
    const installDir = resolveInstall('.pi', 'rules');

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

  public assemble(state: SDLCState, config?: HarnessConfig): string {
    let rules = '';
    const harnessRulesPath = resolveProjectFrom(this.projectRoot, '.pi', 'harness_rules.md');
    if (fs.existsSync(harnessRulesPath)) {
      rules += `### HARNESS OPERATIONAL RULES\n${fs.readFileSync(harnessRulesPath, 'utf8')}\n\n`;
    }

    const ruleCategories = state.ruleCategories || [];
    const catRules = this.loadRuleCategories(ruleCategories);
    if (catRules.length > 0) {
      rules += `### PROJECT-SPECIFIC RULES\n${catRules.join('\n\n')}\n\n`;
    }

    const baseInstructions = (state.baseInstructions ?? '').trim();
    const baseInstructionsBlock = baseInstructions
      ? `\nBASE INSTRUCTIONS:\n${baseInstructions}\n`
      : '';

    return `
${state.identity.role.toUpperCase()} IDENTITY:
${state.identity.expertise}

CONSTRAINTS:
${state.identity.constraints.map(c => `- ${c}`).join('\n')}
${baseInstructionsBlock}
${rules}
`.trim();
  }
}
