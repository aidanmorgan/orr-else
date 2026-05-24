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
  timestamp: string;
  protocolGuidance?: string;
  globalStandards?: string;
}

export class ContextInjector {
  public inject(prompt: string, context: PromptContext): string {
    const docs = (context.documentationPaths || []).map(p => `- ${path.basename(p)}: ${p}`).join('\n');
    const rules = (context.rulePaths || []).map(p => `- ${path.basename(p)}: ${p}`).join('\n');

    const harnessConfigPath = context.configPath || 'N/A';

    return `
### SYSTEM CONTEXT
BEAD_ID: ${context.beadId}
PROJECT_ROOT: ${context.projectRoot || 'N/A'}
WORKING_DIRECTORY: ${context.workdir}
CONFIG_PATH: ${context.configPath || 'N/A'}
TIMESTAMP: ${context.timestamp}
PHASE: ${context.phase}
STATE_IDENTITY: ${context.identity}
LLM_PROVIDER_KEY: ${context.llmProviderKey || 'default'}
LLM_PROVIDER: ${context.llmProvider || 'default'}
LLM_MODEL: ${context.llmModel || 'default'}
LLM_THINKING: ${context.llmThinking || 'default'}
COMPATIBILITY_MODE: ${context.compatibilityMode || 'none'}

${context.protocolGuidance ? `\n${context.protocolGuidance}\n` : ''}
${context.globalStandards ? `\n${context.globalStandards}\n` : ''}

### RELEVANT FILES (ON DISK)
You MUST use your file tools to read these if you need context:
- PROGRESS: ${context.progressPath || 'N/A'}
- HANDOVER: ${context.handoverPath || 'N/A'}
- FEATURE_LIST: ${context.featureListPath || 'N/A'}
- RECENT_HISTORY: ${context.historyPath || 'N/A'}
- HARNESS_CONFIG: ${harnessConfigPath}

Project-root configuration files are read from PROJECT_ROOT, not from the worktree unless they are explicitly copied there. If you need the harness configuration, read exactly HARNESS_CONFIG as an absolute path; do not read \`harness.yaml\` by basename or relative path. Do not invent alternate prompt or checklist filenames; the active action prompt and checklist are already injected into this system context.
Use \`get_compatibility_context\` for Claude/Codex compatibility rule, hook, doc, and agent paths. Never read a compatibility directory path directly; read only the files returned by that tool.

### MY SKILL SHEETS (READ AS NEEDED)
${(context.skillPaths || []).map(p => `- ${path.basename(p, '.md').toUpperCase()}: ${p}`).join('\n') || 'None provided.'}

### REFERENCE LIBRARIES (READ ON DEMAND)
The following documents are available for you to read if you need deeper context on rules or design:
#### Rules
${rules || 'No phase-specific rules found.'}

#### Design Documentation
${docs || 'No design documentation found.'}

### INSTRUCTION
${prompt}
    `.trim();
  }
}
