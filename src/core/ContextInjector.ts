import { BeadId } from '../types/index.js';
import * as path from 'path';

export interface PromptContext {
  beadId: BeadId;
  projectRoot?: string;
  workdir: string;
  configPath?: string;
  actionId: string;
  identity: string;
  phase: string;
  llmProviderKey?: string;
  llmProvider?: string;
  llmModel?: string;
  llmThinking?: string;
  compatibilityMode?: string;
  handoverPath?: string;
  historyPath?: string;
  featureListPath?: string;
  progressPath?: string;
  skillPaths?: string[];
  documentationPaths?: string[];
  rulePaths?: string[];
  protocolGuidance?: string;
  globalStandards?: string;
  outstandingChecklist?: string;
}

/**
 * Assembles the harness's contribution to the LLM system prompt.
 *
 * The block is partitioned so the stable, role/state/action-specific content sits
 * at the top and the volatile per-bead/per-session content sits at the bottom.
 * That ordering lets the model provider's prompt cache reuse the prefix across
 * Pi sessions started for different beads in the same role+state — small change
 * but a measurable token-cost lever per Anthropic's "prompt caching is everything"
 * guidance (Apr 2026).
 */
export class ContextInjector {
  public inject(prompt: string, context: PromptContext): string {
    const docs = (context.documentationPaths || []).map(p => `- ${path.basename(p)}: ${p}`).join('\n');
    const rules = (context.rulePaths || []).map(p => `- ${path.basename(p)}: ${p}`).join('\n');
    const harnessConfigPath = context.configPath || 'N/A';
    const skills = (context.skillPaths || []).map(p => `- ${path.basename(path.dirname(p))}`).join('\n') || 'None provided.';

    return `
### SYSTEM CONTEXT
PROJECT_ROOT: ${context.projectRoot || 'N/A'}
CONFIG_PATH: ${context.configPath || 'N/A'}
PHASE: ${context.phase}
STATE_IDENTITY: ${context.identity}
LLM_PROVIDER_KEY: ${context.llmProviderKey || 'default'}
LLM_PROVIDER: ${context.llmProvider || 'default'}
LLM_MODEL: ${context.llmModel || 'default'}
LLM_THINKING: ${context.llmThinking || 'default'}
COMPATIBILITY_MODE: ${context.compatibilityMode || 'none'}

${context.protocolGuidance ? `\n${context.protocolGuidance}\n` : ''}
${context.globalStandards ? `\n${context.globalStandards}\n` : ''}

### CONFIGURED INPUTS
- HARNESS_CONFIG: ${harnessConfigPath}

### FRAMEWORK RUNTIME ACCESS RULES (TOOL ACCESS ONLY)
Do not read, edit, delete, or commit framework runtime paths directly. Use \`bd_get_state_chart\`, \`bd_get_bead\`, \`get_outstanding_tasks\`, \`submit_checkpoint\`, and \`get_artifact_paths\` instead. Active runtime paths are listed under RUN CONTEXT below.

Do not use native file reads against PROJECT_ROOT while a Bead state is running. If you need harness configuration, compatibility-mode rules, hooks, docs, or agent paths, call \`get_artifact_paths\`, \`get_compatibility_context\`, or other configured project tools; do not invent alternate prompt or checklist filenames. The active action prompt and outstanding checklist are already injected into this system context.

### PI-NATIVE SKILLS AVAILABLE
These skills are already loaded into Pi for this session. Do not native-read skill files from the worktree or PROJECT_ROOT.
${skills}

### REFERENCE LIBRARIES (READ ON DEMAND)
The following documents are available for you to read if you need deeper context on rules or design:
#### Rules
${rules || 'No phase-specific rules found.'}

#### Design Documentation
${docs || 'No design documentation found.'}

### ROLE INSTRUCTIONS
${prompt}

### RUN CONTEXT
BEAD_ID: ${context.beadId}
WORKING_DIRECTORY: ${context.workdir}

### CONFIGURED RUN FILES
- HANDOVER: ${context.handoverPath || 'N/A'}
- FEATURE_LIST: ${context.featureListPath || 'N/A'}

### FRAMEWORK RUNTIME PATHS (TOOL ACCESS ONLY)
- PROGRESS: ${context.progressPath || 'N/A'}
- RECENT_HISTORY: ${context.historyPath || 'N/A'}

### OUTSTANDING CHECKLIST
${context.outstandingChecklist || 'None provided.'}
    `.trim();
  }
}
