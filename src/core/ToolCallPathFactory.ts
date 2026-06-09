import * as path from 'path';
import { OperationalArtifactPath, ProjectToolDefaults } from '../constants/infra.js';
import { resolveTemplateString, type TemplateContext } from './TemplateResolver.js';

export interface ToolCallPathAllocation {
  invocationId: string;
  callDir: string;
  outputDir: string;
  outputFile: string;
  tmpDir: string;
}

function resolveProjectPath(projectRoot: string, value: string, context: TemplateContext): string {
  const resolved = resolveTemplateString(value, context);
  return path.isAbsolute(resolved) ? resolved : path.resolve(projectRoot, resolved);
}

function pathSegment(value: string | undefined, fallback: string): string {
  const sanitized = (value || fallback)
    .replace(ProjectToolDefaults.UNSAFE_PATH_SEGMENT_PATTERN, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized && sanitized !== '.' && sanitized !== '..' ? sanitized : fallback;
}

/**
 * Root of the single PROJECT-scoped tool-output archive (0yt5.27).
 * Resolved against PROJECT_ROOT (the caller passes the PROJECT_ROOT-derived
 * `projectRoot`), NOT WORKTREE_PATH: tool outputs are SHARED/project-scoped,
 * keyed by beadId, so the coordinator-only gate can read worker-produced
 * outputs and concurrent worktrees never collide.
 */
function toolCallRoot(projectRoot: string): string {
  return path.resolve(projectRoot, ...OperationalArtifactPath.PI_TOOL_OUTPUT_DIR.split('/'));
}

function isInsidePath(root: string, candidate: string): boolean {
  const relativePath = path.relative(root, candidate);
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath));
}

function assertInsideToolCallRoot(projectRoot: string, label: string, candidate: string): void {
  const root = toolCallRoot(projectRoot);
  if (!isInsidePath(root, candidate)) {
    throw new Error(`${label} must stay under ${root}`);
  }
}

function sanitizeContext(context: TemplateContext): TemplateContext {
  const toolInvocationId = context.toolInvocationId;
  if (!toolInvocationId) throw new Error('toolInvocationId is required for tool-call path allocation');

  return {
    ...context,
    beadId: pathSegment(context.beadId, ProjectToolDefaults.UNASSIGNED_BEAD_ID),
    stateId: pathSegment(context.stateId, ProjectToolDefaults.UNSPECIFIED_STATE_ID),
    actionId: pathSegment(context.actionId, ProjectToolDefaults.UNSPECIFIED_ACTION_ID),
    toolName: pathSegment(context.toolName, context.toolName || 'tool'),
    toolInvocationId: pathSegment(toolInvocationId, 'tool-invocation')
  };
}

export class ToolCallPathFactory {
  public allocate(context: TemplateContext): ToolCallPathAllocation {
    const sanitizedContext = sanitizeContext(context);
    const invocationId = sanitizedContext.toolInvocationId!;

    const callDir = resolveProjectPath(sanitizedContext.projectRoot, ProjectToolDefaults.CALL_DIR_TEMPLATE, sanitizedContext);
    const outputDir = path.join(callDir, ProjectToolDefaults.OUTPUT_DIR_NAME);
    const tmpDir = path.join(callDir, ProjectToolDefaults.TMP_DIR_NAME);
    const outputFileName = resolveTemplateString(ProjectToolDefaults.OUTPUT_FILE_NAME_TEMPLATE, {
      ...sanitizedContext,
      toolCallDir: callDir,
      toolOutputDir: outputDir,
      toolTmpDir: tmpDir,
    });
    const outputFile = path.join(outputDir, outputFileName);

    assertInsideToolCallRoot(sanitizedContext.projectRoot, 'callDir', callDir);
    assertInsideToolCallRoot(sanitizedContext.projectRoot, 'outputDir', outputDir);
    assertInsideToolCallRoot(sanitizedContext.projectRoot, 'tmpDir', tmpDir);
    assertInsideToolCallRoot(sanitizedContext.projectRoot, 'outputFile', outputFile);

    return {
      invocationId,
      callDir,
      outputDir,
      outputFile,
      tmpDir,
    };
  }
}
