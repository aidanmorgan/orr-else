/**
 * Native-tool path-classification and policy-rejection helpers.
 *
 * Encapsulates all path-based policy enforcement that fires in the Pi
 * TOOL_CALL event observer (registerPiToolObservers) and in the
 * wrapPluginTool circuit-breaker path.
 *
 * No process.env reads except where required for path resolution
 * (relativeOperationalPath reads WORKTREE_PATH / PROJECT_ROOT to
 * anchor relative paths, which is inherent to path policy).
 */

import * as path from 'path';
import type { ToolCallEvent } from '@earendil-works/pi-coding-agent';
import type { HarnessConfig } from '../core/ConfigLoader.js';
import type { RuntimeServices } from '../core/RuntimeServices.js';
import {
  NativePiToolName,
  OperationalArtifactPath,
  OperationalLogPath,
  FileMutationPolicyDefaults,
  NativeReadPolicyDefaults,
  PiToolPolicyDefaults,
  EnvVars
} from '../constants/index.js';

// ── constants copied verbatim from extension.ts ──────────────────────────────

export const SHELL_OPERATIONAL_MUTATION_COMMANDS = new Set<string>([
  FileMutationPolicyDefaults.CP_COMMAND,
  FileMutationPolicyDefaults.MKDIR_COMMAND,
  FileMutationPolicyDefaults.MV_COMMAND,
  FileMutationPolicyDefaults.RM_COMMAND,
  FileMutationPolicyDefaults.RMDIR_COMMAND,
  FileMutationPolicyDefaults.SED_COMMAND,
  FileMutationPolicyDefaults.TEE_COMMAND,
  FileMutationPolicyDefaults.TOUCH_COMMAND,
  FileMutationPolicyDefaults.TRUNCATE_COMMAND
]);

export const GIT_OPERATIONAL_MUTATION_SUBCOMMANDS = new Set<string>([
  FileMutationPolicyDefaults.GIT_ADD_SUBCOMMAND,
  FileMutationPolicyDefaults.GIT_CLEAN_SUBCOMMAND,
  FileMutationPolicyDefaults.GIT_MV_SUBCOMMAND,
  FileMutationPolicyDefaults.GIT_RM_SUBCOMMAND,
  FileMutationPolicyDefaults.GIT_RESTORE_SUBCOMMAND,
  FileMutationPolicyDefaults.GIT_CHECKOUT_SUBCOMMAND
]);

export const NATIVE_PATH_INPUT_KEYS = [
  'path',
  'filePath',
  'file_path',
  'targetFile',
  'target_file'
] as const;

export const NATIVE_OPERATIONAL_MUTATION_TOOLS = new Set<string>([
  NativePiToolName.EDIT,
  NativePiToolName.WRITE
]);

export const OPERATIONAL_READ_DIRS = [
  OperationalArtifactPath.LEGACY_STATE_DIR,
  OperationalArtifactPath.PI_EVENTS_DIR,
  OperationalArtifactPath.PI_LOGS_DIR,
  OperationalArtifactPath.PI_MAILBOX_DIR,
  OperationalArtifactPath.PI_OTEL_DIR,
  OperationalArtifactPath.PI_ARTIFACTS_DIR,
  OperationalArtifactPath.PI_TOOL_OUTPUT_DIR
] as const;

export const OPERATIONAL_MUTATION_DIRS = [
  OperationalArtifactPath.LEGACY_STATE_DIR,
  OperationalArtifactPath.PI_EVENTS_DIR,
  OperationalArtifactPath.PI_LOGS_DIR,
  OperationalArtifactPath.PI_MAILBOX_DIR,
  OperationalArtifactPath.PI_OTEL_DIR,
  OperationalArtifactPath.PI_TOOL_OUTPUT_DIR,
  OperationalArtifactPath.TEMP_DIR
] as const;

export const PROJECT_TOOL_CALL_OUTPUT_DIR = `${OperationalArtifactPath.TEMP_DIR}/tool-calls`;
export const PROJECT_TOOL_CALL_OUTPUT_READ_GUIDANCE =
  `PROTOCOL VIOLATION: \`${NativePiToolName.READ}\` may not read project-tool output archives directly. ` +
  'Use the inline project-tool result preview, rerun the configured project tool with narrower arguments, or use a harness-owned project-tool output preview when available.';

// ── path helpers ─────────────────────────────────────────────────────────────

export function nativeToolPath(event: ToolCallEvent): string {
  const input = event.input as Record<string, unknown>;
  for (const key of NATIVE_PATH_INPUT_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

export function toSlashPath(value: string): string {
  return value.replaceAll(path.sep, '/');
}

export function relativeOperationalPath(requestedPath: string): string {
  const trimmed = requestedPath.trim();
  if (!trimmed) return '';

  if (!path.isAbsolute(trimmed)) return toSlashPath(trimmed).replace(/^\.\//, '');

  const absolutePath = path.resolve(trimmed);
  const roots = [
    process.env[EnvVars.WORKTREE_PATH],
    process.env[EnvVars.PROJECT_ROOT],
    process.cwd()
  ].filter((root): root is string => typeof root === 'string' && root.length > 0)
    .map(root => path.resolve(root));

  for (const root of roots) {
    const relativePath = path.relative(root, absolutePath);
    if (!relativePath || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))) {
      return toSlashPath(relativePath || '.');
    }
  }

  return toSlashPath(trimmed);
}

export function pathWithin(relativePath: string, directory: string): boolean {
  const cleanPath = relativePath.replace(/^\.\//, '').replace(/^\/+/, '');
  const cleanDirectory = directory.replace(/^\/+|\/+$/g, '');
  return cleanPath === cleanDirectory || cleanPath.startsWith(`${cleanDirectory}/`);
}

export function isProgressOrWorklogPath(relativePath: string): boolean {
  const normalizedPath = relativePath.replace(/^\.\//, '').replace(/^\/+/, '');
  const fileName = path.posix.basename(normalizedPath);
  const readsProgressLog = fileName === OperationalLogPath.PROGRESS_FILE;
  const readsWorklog = normalizedPath.split('/').includes(OperationalLogPath.WORKLOG_DIR)
    && fileName.endsWith(OperationalLogPath.WORKLOG_FILE_SUFFIX);
  return readsProgressLog || readsWorklog;
}

export function isOperationalReadPath(requestedPath: string): boolean {
  const relativePath = relativeOperationalPath(requestedPath);
  return isProgressOrWorklogPath(relativePath)
    || OPERATIONAL_READ_DIRS.some(directory => pathWithin(relativePath, directory));
}

export function isProjectToolCallOutputPath(requestedPath: string): boolean {
  return pathWithin(relativeOperationalPath(requestedPath), PROJECT_TOOL_CALL_OUTPUT_DIR);
}

export function isOperationalMutationPath(requestedPath: string): boolean {
  const relativePath = relativeOperationalPath(requestedPath);
  return isProgressOrWorklogPath(relativePath)
    || OPERATIONAL_MUTATION_DIRS.some(directory => pathWithin(relativePath, directory));
}

// ── policy-rejection functions ────────────────────────────────────────────────

export function nativeOperationalMutationPolicyRejection(event: ToolCallEvent, isWorker: boolean): string | null {
  if (!isWorker || !NATIVE_OPERATIONAL_MUTATION_TOOLS.has(event.toolName)) return null;
  const requestedPath = nativeToolPath(event);
  if (!requestedPath || !isOperationalMutationPath(requestedPath)) return null;

  return `PROTOCOL VIOLATION: \`${event.toolName}\` may not modify framework runtime artifacts ` +
    'inside a teammate context. Use harness tools for state, progress, events, tool outputs, and generated temporary files.';
}

export function gitSubcommand(args: Array<{ text: string }>): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]?.text || '';
    if (token === FileMutationPolicyDefaults.ARG_SEPARATOR) continue;
    if (token === FileMutationPolicyDefaults.GIT_CHDIR_OPTION) {
      index += 1;
      continue;
    }
    if (!token.startsWith('-')) return token;
  }
  return undefined;
}

export function shellOperationalMutationPolicyRejection(event: ToolCallEvent, services: RuntimeServices, isWorker: boolean): string | null {
  if (!isWorker || event.toolName !== NativePiToolName.BASH) return null;
  const input = event.input as Record<string, unknown>;
  if (input[FileMutationPolicyDefaults.REWRITTEN_DELETE_FLAG]) return null;
  const command = typeof input.command === 'string' ? input.command : '';
  if (!command.trim()) return null;

  let commands;
  try {
    commands = services.shellCommandParser.parse(command).commands;
  } catch {
    return null;
  }
  for (const shellCommand of commands) {
    const effective = services.shellCommandParser.effectiveCommand(shellCommand);
    const commandName = effective.basename;
    const isMutation = SHELL_OPERATIONAL_MUTATION_COMMANDS.has(commandName)
      || (commandName === FileMutationPolicyDefaults.GIT_COMMAND && GIT_OPERATIONAL_MUTATION_SUBCOMMANDS.has(gitSubcommand(effective.args) || ''));
    if (!isMutation) continue;

    const target = [
      effective.name,
      ...effective.args.map(arg => arg.text),
      ...effective.redirects.map(redirect => redirect.file?.text || '')
    ].find(token => token && isOperationalMutationPath(token));
    if (!target) continue;

    return `PROTOCOL VIOLATION: \`${NativePiToolName.BASH}\` may not mutate framework runtime artifact path ` +
      `\`${target}\` inside a teammate context. Leave harness artifacts to Orr Else.`;
  }

  return null;
}

export function shellPolicyRejection(event: ToolCallEvent, config: HarnessConfig, services: RuntimeServices, isWorker: boolean, commandInvokesToolName: (command: string, toolName: string, services: RuntimeServices) => boolean, commandMatchesPattern: (command: string, pattern: string) => boolean): string | null {
  if (!isWorker || event.toolName !== NativePiToolName.BASH) return null;
  const input = event.input as Record<string, unknown>;
  if (input[FileMutationPolicyDefaults.REWRITTEN_DELETE_FLAG]) return null;

  const policy = config.settings.pi?.shell;
  const command = typeof input.command === 'string' ? input.command : '';
  if (!command.trim()) return null;

  for (const pattern of policy?.blockedCommandPatterns || []) {
    if (commandMatchesPattern(command, pattern)) {
      return `PROTOCOL VIOLATION: \`${NativePiToolName.BASH}\` may not invoke configured project-tool capability matching \`${pattern}\`. Use the corresponding Orr Else/Pi tool call from harness.yaml.`;
    }
  }

  const disallowProjectToolFallback = policy?.disallowProjectToolFallback ?? PiToolPolicyDefaults.DISALLOW_PROJECT_TOOL_FALLBACK;
  if (!disallowProjectToolFallback) return null;

  for (const tool of config.tools || []) {
    if (commandInvokesToolName(command, tool.name, services)) {
      return `PROTOCOL VIOLATION: \`${NativePiToolName.BASH}\` may not invoke configured project tool \`${tool.name}\`. Use the \`${tool.name}\` tool call from harness.yaml.`;
    }
  }

  return null;
}

export function mcpPolicyRejection(event: ToolCallEvent, config: HarnessConfig, isWorker: boolean): string | null {
  if (!isWorker || event.toolName !== NativePiToolName.MCP) return null;
  const policy = config.settings.pi?.mcp;
  const input = event.input as Record<string, unknown>;
  const requestedTool = typeof input.tool === 'string' ? input.tool.trim() : '';
  const isMcpToolCall = requestedTool.length > 0;

  if (policy?.allowToolCalls === false) {
    const requestedDescription = isMcpToolCall ? ` tool call \`${requestedTool}\`` : ' access';
    return `PROTOCOL VIOLATION: direct Pi \`${NativePiToolName.MCP}\`${requestedDescription} is disabled by harness.yaml. Use the configured Orr Else project tool for this capability or route BLOCKED if none exists.`;
  }

  const blockedPatterns = policy?.blockedToolPatterns || [];
  for (const pattern of blockedPatterns) {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch (error) {
      return `PROTOCOL VIOLATION: invalid harness.yaml Pi MCP blockedToolPatterns entry \`${pattern}\`: ${String(error)}`;
    }
    if (!requestedTool || !regex.test(requestedTool)) continue;
    return `PROTOCOL VIOLATION: direct Pi \`${NativePiToolName.MCP}\` tool call \`${requestedTool}\` is blocked by harness.yaml. Use the configured Orr Else project tool for this capability or route BLOCKED if none exists.`;
  }

  return null;
}

export function operationalArtifactReadPolicyRejection(event: ToolCallEvent, isWorker: boolean): string | null {
  if (!isWorker || event.toolName !== NativePiToolName.READ) return null;
  const requestedPath = nativeToolPath(event);
  if (!requestedPath.trim()) return null;
  if (isProjectToolCallOutputPath(requestedPath)) return PROJECT_TOOL_CALL_OUTPUT_READ_GUIDANCE;
  if (!isOperationalReadPath(requestedPath)) return null;

  return `PROTOCOL VIOLATION: \`${NativePiToolName.READ}\` may not read framework runtime artifacts ` +
    `(\`${OperationalLogPath.PROGRESS_FILE}\`, \`${OperationalLogPath.WORKLOG_DIR}/*${OperationalLogPath.WORKLOG_FILE_SUFFIX}\`, ` +
    `\`${OperationalArtifactPath.LEGACY_STATE_DIR}/\`, \`${OperationalArtifactPath.PI_EVENTS_DIR}/\`, ` +
    `\`${OperationalArtifactPath.PI_LOGS_DIR}/\`, \`${OperationalArtifactPath.PI_MAILBOX_DIR}/\`, ` +
    `\`${OperationalArtifactPath.PI_OTEL_DIR}/\`, \`${OperationalArtifactPath.PI_ARTIFACTS_DIR}/\`, ` +
    `or \`${OperationalArtifactPath.PI_TOOL_OUTPUT_DIR}/\`) ` +
    'inside a teammate context. Use `bd_get_state_chart`, `bd_get_bead`, `get_artifact_paths`, and configured artifacts for state reconstruction.';
}

export function oversizedReadPolicyRejection(event: ToolCallEvent, isWorker: boolean): string | null {
  if (!isWorker || event.toolName !== NativePiToolName.READ) return null;
  const input = event.input as Record<string, unknown>;
  const limit = Number(input.limit);
  if (!Number.isFinite(limit) || limit <= NativeReadPolicyDefaults.MAX_LIMIT_LINES) return null;

  return `PROTOCOL VIOLATION: \`${NativePiToolName.READ}\` limit ${Math.floor(limit)} exceeds ` +
    `${NativeReadPolicyDefaults.MAX_LIMIT_LINES} lines inside a teammate context. ` +
    'Use smaller targeted reads, codemap, ast_grep, reference_docs, or artifact validators instead of loading broad file slices.';
}
