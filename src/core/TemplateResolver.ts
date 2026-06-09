/**
 * TemplateResolver — pure template substitution with no IO, no crypto, no YAML,
 * no Pi SDK, and no process access.
 *
 * pi-experiment-amq0.13: extracted verbatim from PiIntegration.ts.
 *
 * This module is the ONLY template dependency that project-tool modules and
 * ToolCallPathFactory should import.  It contains zero side-effectful imports so
 * it is safe to use in tool-execution paths without pulling in fs/crypto/yaml.
 */

const TemplateToken = {
  CONFIG_PATH: '{{configPath}}',
  PROJECT_ROOT: '{{projectRoot}}',
  WORKTREE_PATH: '{{worktreePath}}',
  FRAMEWORK_ROOT: '{{frameworkRoot}}',
  BEAD_ID: '{{beadId}}',
  STATE_ID: '{{stateId}}',
  ACTION_ID: '{{actionId}}',
  TOOL_NAME: '{{toolName}}',
  TOOL_INVOCATION_ID: '{{toolInvocationId}}',
  TOOL_CALL_DIR: '{{toolCallDir}}',
  TOOL_OUTPUT_DIR: '{{toolOutputDir}}',
  TOOL_OUTPUT_FILE: '{{toolOutputFile}}',
  TOOL_TMP_DIR: '{{toolTmpDir}}'
} as const;

/** Prefix used to form named-root template tokens: `{{roots.NAME}}` */
export const NAMED_ROOT_TOKEN_PREFIX = '{{roots.';
const NAMED_ROOT_TOKEN_SUFFIX = '}}';

export interface TemplateContext {
  configPath?: string;
  projectRoot: string;
  worktreePath: string;
  frameworkRoot?: string;
  beadId?: string;
  stateId?: string;
  actionId?: string;
  toolName?: string;
  toolInvocationId?: string;
  toolCallDir?: string;
  toolOutputDir?: string;
  toolOutputFile?: string;
  toolTmpDir?: string;
  /**
   * Named roots resolved from `settings.roots` in harness.yaml.
   * Each entry maps a logical name to an absolute resolved path.  Template
   * strings may reference any named root as `{{roots.NAME}}` — generic,
   * with no project-specific names required in harness defaults.
   */
  namedRoots?: Record<string, string>;
}

export function resolveTemplateString(value: string, context: TemplateContext): string {
  const replacements: Array<[string, string | undefined]> = [
    [TemplateToken.PROJECT_ROOT, context.projectRoot],
    [TemplateToken.WORKTREE_PATH, context.worktreePath],
    [TemplateToken.FRAMEWORK_ROOT, context.frameworkRoot],
    [TemplateToken.CONFIG_PATH, context.configPath],
    [TemplateToken.BEAD_ID, context.beadId],
    [TemplateToken.STATE_ID, context.stateId],
    [TemplateToken.ACTION_ID, context.actionId],
    [TemplateToken.TOOL_NAME, context.toolName],
    [TemplateToken.TOOL_INVOCATION_ID, context.toolInvocationId],
    [TemplateToken.TOOL_CALL_DIR, context.toolCallDir],
    [TemplateToken.TOOL_OUTPUT_DIR, context.toolOutputDir],
    [TemplateToken.TOOL_OUTPUT_FILE, context.toolOutputFile],
    [TemplateToken.TOOL_TMP_DIR, context.toolTmpDir]
  ];

  let resolved = replacements.reduce(
    (acc, [token, replacement]) => replacement === undefined ? acc : acc.replaceAll(token, replacement),
    value
  );

  // Expand {{roots.NAME}} tokens from namedRoots
  if (context.namedRoots && resolved.includes(NAMED_ROOT_TOKEN_PREFIX)) {
    for (const [name, rootPath] of Object.entries(context.namedRoots)) {
      const token = `${NAMED_ROOT_TOKEN_PREFIX}${name}${NAMED_ROOT_TOKEN_SUFFIX}`;
      if (resolved.includes(token)) {
        resolved = resolved.replaceAll(token, rootPath);
      }
    }
  }

  return resolved;
}
