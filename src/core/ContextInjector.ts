import { BeadId } from '../types/index.js';
import * as path from 'path';
import { digestStableBlock, type StableBootstrapInputs, type StableBlockDigest } from './BootstrapDigest.js';

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
 * Result of injectWithDigest: the fully assembled prompt together with the
 * stable-block text and its digest metadata.
 *
 * The assembled prompt is exactly [stableBlock] + "\n\n" + [volatileSuffix].
 * The stableBlock is the leading, cache-eligible span.  The volatile suffix
 * contains beadId, workdir, run paths, and checklist.
 */
export interface InjectedPromptWithDigest {
  /** Fully assembled prompt: stableBlock + "\n\n" + volatileSuffix (trimmed). */
  prompt: string;
  /**
   * The stable, cache-eligible leading block of the prompt.  Byte-identical
   * across any two calls that share the same (projectRoot, configIdentity,
   * stateId, toolNames, skillNames, ruleCategories, protocolLabel) — regardless
   * of beadId or other volatile fields.
   */
  stableBlock: string;
  /**
   * The volatile suffix of the prompt: beadId, workdir, run paths, checklist.
   * Exposed so callers (e.g. BEFORE_AGENT_START) can compose the final worker
   * prompt as stableBlock + Pi-base + volatileSuffix, ensuring stableBlock
   * forms the contiguous leading cache prefix.
   */
  volatileSuffix: string;
  /** Deterministic digest over the stable identity + stableBlock text. */
  digestId: string;
  /** Rough token estimate for the stable block: ceil(byteLength / TOKEN_ESTIMATE_DIVISOR). */
  estimatedTokens: number;
  /** True when estimatedTokens exceeds BOOTSTRAP_INPUT_TOKEN_BUDGET. */
  overBudget: boolean;
}

/**
 * Assembles the harness's contribution to the LLM system prompt.
 *
 * The block is partitioned so the stable, role/state/action-specific content
 * sits at the top and the volatile per-bead/per-session content sits at the
 * bottom. That ordering lets the model provider's prompt cache reuse the prefix
 * across Pi sessions started for different beads in the same role+state —
 * small change but a measurable token-cost lever per Anthropic's
 * "prompt caching is everything" guidance (Apr 2026).
 *
 * Use `inject()` when callers only need the prompt string (e.g. non-worker
 * contexts where digest tracking is not required).
 *
 * Use `injectWithDigest()` (worker-side, buildStateSystemPrompt path) when the
 * stable block must be measured and its digest recorded for cache-efficiency
 * accounting.  injectWithDigest() is the SINGLE source of truth for the
 * [stableBlock]+[volatileSuffix] prompt shape and for the digest computation —
 * no other code should duplicate this rendering.
 */
export class ContextInjector {
  /**
   * Assemble the harness system prompt.  Returns only the prompt string.
   * Equivalent to injectWithDigest().prompt when digest metadata is not needed.
   */
  public inject(prompt: string, context: PromptContext): string {
    const { stableBlock, volatileSuffix } = this.assembleParts(prompt, context);
    return `${stableBlock}\n\n${volatileSuffix}`.trim();
  }

  /**
   * Assemble the harness system prompt AND compute the stable-block digest.
   *
   * The returned `stableBlock` is the leading, cache-eligible span of the prompt.
   * `volatileSuffix` contains beadId, workdir, run paths, and checklist.
   * `digestId` is derived from `identity` (sorted canonical JSON) + `stableBlock`
   * text, so it changes when either the identity fields or the rendered content
   * change — providing an accurate cache key.
   *
   * @param prompt        Role/action instructions (role-specific, stable).
   * @param context       Per-bead run context (includes volatile beadId/workdir).
   * @param identity      Stable identity inputs used to derive the digest.
   *                      Must not include beadId/worktreePath/task (those are volatile).
   * @param budgetOverride  Optional token-budget override (default: BOOTSTRAP_INPUT_TOKEN_BUDGET).
   */
  public injectWithDigest(
    prompt: string,
    context: PromptContext,
    identity: StableBootstrapInputs,
    budgetOverride?: number
  ): InjectedPromptWithDigest {
    const { stableBlock, volatileSuffix } = this.assembleParts(prompt, context);
    const assembledPrompt = `${stableBlock}\n\n${volatileSuffix}`.trim();
    const digest: StableBlockDigest = digestStableBlock(stableBlock, identity, budgetOverride);
    return {
      prompt: assembledPrompt,
      stableBlock,
      volatileSuffix,
      digestId: digest.digestId,
      estimatedTokens: digest.estimatedTokens,
      overBudget: digest.overBudget
    };
  }

  // ---------------------------------------------------------------------------
  // Internal: shared prompt assembly used by both inject() and injectWithDigest()
  // ---------------------------------------------------------------------------

  private assembleParts(prompt: string, context: PromptContext): { stableBlock: string; volatileSuffix: string } {
    // Sort paths before rendering so the stable block is canonical regardless
    // of YAML/source declaration order (cache key stability).
    const docs = [...(context.documentationPaths || [])].sort().map(p => `- ${path.basename(p)}: ${p}`).join('\n');
    const rules = [...(context.rulePaths || [])].sort().map(p => `- ${path.basename(p)}: ${p}`).join('\n');
    const harnessConfigPath = context.configPath || 'N/A';
    const skills = [...(context.skillPaths || [])].sort().map(p => `- ${path.basename(path.dirname(p))}`).join('\n') || 'None provided.';

    // -------------------------------------------------------------------------
    // STABLE BLOCK — everything that depends ONLY on project/config/state/toolset.
    // Must contain NO beadId, task text, worktreePath, timestamps, or checklist.
    // This block is byte-identical across any two runs sharing the same stable
    // inputs — it is the cache-eligible leading span of the assembled prompt.
    // -------------------------------------------------------------------------
    const stableBlock = `### SYSTEM CONTEXT
PROJECT_ROOT: ${context.projectRoot || 'N/A'}
CONFIG_PATH: ${context.configPath || 'N/A'}
PHASE: ${context.phase}
STATE_IDENTITY: ${context.identity}
LLM_PROVIDER_KEY: ${context.llmProviderKey || 'default'}
LLM_PROVIDER: ${context.llmProvider || 'default'}
LLM_MODEL: ${context.llmModel || 'default'}
LLM_THINKING: ${context.llmThinking || 'default'}

${context.protocolGuidance ? `\n${context.protocolGuidance}\n` : ''}
${context.globalStandards ? `\n${context.globalStandards}\n` : ''}

### CONFIGURED INPUTS
- HARNESS_CONFIG: ${harnessConfigPath}

### FRAMEWORK RUNTIME ACCESS RULES (TOOL ACCESS ONLY)
Do not read, edit, delete, or commit framework runtime paths directly. Use \`bd_get_state_chart\`, \`bd_get_bead\`, \`get_outstanding_tasks\`, \`submit_checkpoint\`, and \`get_artifact_paths\` instead. Active runtime paths are listed under RUN CONTEXT below.

Do not use native file reads against PROJECT_ROOT while a Bead state is running. If you need harness configuration, rules, hooks, or docs, call \`get_artifact_paths\` or other configured project tools; do not invent alternate prompt or checklist filenames. The active action prompt and outstanding checklist are already injected into this system context.

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
${prompt}`;

    // -------------------------------------------------------------------------
    // VOLATILE SUFFIX — bead ID, working directory, volatile run paths, checklist.
    // This section changes per bead/session and must NOT be included in any stable
    // cache prefix.  It is always appended AFTER the stable block.
    // -------------------------------------------------------------------------
    const volatileSuffix = `### RUN CONTEXT
BEAD_ID: ${context.beadId}
WORKING_DIRECTORY: ${context.workdir}

### CONFIGURED RUN FILES
- HANDOVER: ${context.handoverPath || 'N/A'}
- FEATURE_LIST: ${context.featureListPath || 'N/A'}

### FRAMEWORK RUNTIME PATHS (TOOL ACCESS ONLY)
- PROGRESS: ${context.progressPath || 'N/A'}
- RECENT_HISTORY: ${context.historyPath || 'N/A'}

### OUTSTANDING CHECKLIST
${context.outstandingChecklist || 'None provided.'}`;

    return { stableBlock, volatileSuffix };
  }
}
