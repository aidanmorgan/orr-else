import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { execFile } from 'child_process';
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { v7 as uuidv7 } from 'uuid';
import { promisify } from 'util';
import type { HarnessConfig } from '../core/ConfigLoader.js';
import { getProjectRoot } from '../core/Paths.js';
import { resolveTemplateString, type TemplateContext } from '../core/PiIntegration.js';
import { ToolCallPathFactory } from '../core/ToolCallPathFactory.js';
import { ProjectToolConfig, ProjectCommandToolConfig, ProjectMcpToolConfig } from '../core/domain/StateModels.js';
import { Logger } from '../core/Logger.js';
import { EventStore } from '../core/EventStore.js';
import { Component, ProjectToolType, CwdMode, EnvVars, ToolResultStatus, Defaults, DataSize, DomainEventName, WorkerDefaults, CommandExitCode, CommandErrorCode, ProjectToolDefaults } from '../constants/index.js';

const execFileAsync = promisify(execFile);

const DEFAULT_MCP_CONFIG_PATH = '{{projectRoot}}/.pi/mcp/config.json';
const MCP_SERVER_CONFIG_KEY = 'mcpServers';
const LEGACY_MCP_SERVER_CONFIG_KEY = 'mcp-servers';
const MCP_SSE_TRANSPORT = 'sse';
const COMMAND_TOOL_RETURN_BYTES = 32 * DataSize.KIB;

const ProjectToolParameter = {
  ARGUMENTS: 'arguments',
  ARGV: 'argv',
  CWD: 'cwd',
  CWD_MODE: 'cwdMode'
} as const;

interface McpServerDefinition {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  type?: string;
}

interface McpConfigFile {
  mcpServers?: Record<string, McpServerDefinition>;
  'mcp-servers'?: Record<string, McpServerDefinition>;
}

interface ProjectToolExecutionContext {
  templateContext: TemplateContext;
  cwd: string;
  callDir: string;
  outputDir: string;
  outputFile: string;
  tmpDir: string;
}

export interface ProjectToolRuntimeContext {
  beadId?: string;
  stateId?: string;
  actionId?: string;
}

function toFlagName(key: string): string {
  return `--${key.replace(/[A-Z]/g, match => `-${match.toLowerCase()}`).replace(/_/g, '-')}`;
}

export function normalizeCommandArguments(input: unknown): string[] {
  if (input === undefined || input === null) return [];
  if (Array.isArray(input)) return input.map(value => String(value));
  if (typeof input === 'string') return [input];
  if (typeof input !== 'object') return [String(input)];

  const record = input as Record<string, unknown>;
  const args: string[] = [];
  const explicitArgv = record[ProjectToolParameter.ARGV];
  if (Array.isArray(explicitArgv)) {
    args.push(...explicitArgv.map(value => String(value)));
  } else if (typeof explicitArgv === 'string') {
    args.push(explicitArgv);
  }

  for (const [key, value] of Object.entries(record)) {
    if (key === ProjectToolParameter.ARGV) continue;
    if (value === undefined || value === null || value === false) continue;
    const flag = toFlagName(key);
    if (value === true) {
      args.push(flag);
    } else if (Array.isArray(value)) {
      for (const item of value) args.push(flag, String(item));
    } else {
      args.push(flag, String(value));
    }
  }
  return args;
}

function unavailable(name: string, message: string) {
  return {
    tool: name,
    status: ToolResultStatus.UNAVAILABLE,
    message
  };
}

function commandFailureStatus(error: any): ToolResultStatus {
  return error?.code === 'ENOENT' ? ToolResultStatus.UNAVAILABLE : ToolResultStatus.REJECTED;
}

function successfulExitCodes(definition: ProjectCommandToolConfig): number[] {
  return definition.successExitCodes?.length
    ? definition.successExitCodes
    : [CommandExitCode.SUCCESS];
}

export function isSuccessfulCommandExitCode(definition: ProjectCommandToolConfig, code: unknown): boolean {
  return typeof code === 'number' && successfulExitCodes(definition).includes(code);
}

export function isAcceptedMaxBufferFailure(definition: ProjectCommandToolConfig, error: unknown): boolean {
  return definition.acceptMaxBuffer === true
    && typeof error === 'object'
    && error !== null
    && (error as { code?: unknown }).code === CommandErrorCode.MAX_BUFFER;
}

function boundedCommandText(value: unknown): { text: string; bytes: number; truncated: boolean } {
  const text = typeof value === 'string'
    ? value
    : value === undefined || value === null
      ? ''
      : String(value);
  if (text.length <= COMMAND_TOOL_RETURN_BYTES) {
    return { text, bytes: text.length, truncated: false };
  }
  return {
    text: `${text.slice(0, COMMAND_TOOL_RETURN_BYTES)}\n\n[truncated ${text.length - COMMAND_TOOL_RETURN_BYTES} characters]`,
    bytes: text.length,
    truncated: true
  };
}

function beadIdFromArgs(args: any): string | undefined {
  return args?.beadId || args?.id || args?.arguments?.beadId || args?.arguments?.id || process.env[EnvVars.BEAD_ID];
}

function stateIdFromArgs(args: any): string | undefined {
  return args?.stateId || args?.state || args?.arguments?.stateId || args?.arguments?.state || process.env[EnvVars.STATE_ID];
}

function actionIdFromArgs(args: any): string | undefined {
  return args?.actionId || args?.action || args?.arguments?.actionId || args?.arguments?.action || process.env[EnvVars.ACTION_ID];
}

function cwdOverrideFromArgs(args: any): string | undefined {
  const value = args?.[ProjectToolParameter.CWD] || args?.[ProjectToolParameter.CWD_MODE];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function pathSegment(value: string | undefined, fallback: string): string {
  const sanitized = (value || fallback)
    .replace(ProjectToolDefaults.UNSAFE_PATH_SEGMENT_PATTERN, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized || fallback;
}

function baseTemplateContext(definition: ProjectToolConfig, args: any): TemplateContext {
  const projectRoot = process.env[EnvVars.PROJECT_ROOT] || getProjectRoot();
  const worktreeRoot = process.env[EnvVars.WORKTREE_PATH] || projectRoot;
  return {
    configPath: process.env[EnvVars.CONFIG_PATH],
    projectRoot,
    worktreePath: worktreeRoot,
    beadId: pathSegment(beadIdFromArgs(args), ProjectToolDefaults.UNASSIGNED_BEAD_ID),
    stateId: pathSegment(stateIdFromArgs(args), ProjectToolDefaults.UNSPECIFIED_STATE_ID),
    actionId: pathSegment(actionIdFromArgs(args), ProjectToolDefaults.UNSPECIFIED_ACTION_ID),
    toolName: pathSegment(definition.name, definition.name)
  };
}

function resolvePathAgainst(baseDir: string, value: string, templateContext: TemplateContext): string {
  const resolved = resolveTemplateString(value, templateContext);
  return path.isAbsolute(resolved) ? resolved : path.resolve(baseDir, resolved);
}

function resolveCwdValue(value: CwdMode | string | undefined, templateContext: TemplateContext): string {
  if (value === CwdMode.WORKTREE) return templateContext.worktreePath;
  if (value === CwdMode.PROJECT) return templateContext.projectRoot;
  if (value) return resolvePathAgainst(templateContext.projectRoot, value, templateContext);
  return templateContext.worktreePath;
}

function resolveToolCwd(definition: ProjectToolConfig, templateContext: TemplateContext, args: any): string {
  if (definition.type !== ProjectToolType.COMMAND) return templateContext.worktreePath;
  const configuredCwd = definition.allowCwdOverride
    ? cwdOverrideFromArgs(args) || definition.cwd
    : definition.cwd;
  return resolveCwdValue(configuredCwd, templateContext);
}

function executionContext(pathFactory: ToolCallPathFactory, definition: ProjectToolConfig, args: any): ProjectToolExecutionContext {
  const initialContext = baseTemplateContext(definition, args);
  const cwd = resolveToolCwd(definition, initialContext, args);
  const invocationContext = {
    ...initialContext,
    toolInvocationId: uuidv7()
  };
  const allocation = pathFactory.allocate(invocationContext);
  const allocatedContext = {
    ...invocationContext,
    toolCallDir: allocation.callDir,
    toolOutputDir: allocation.outputDir,
    toolOutputFile: allocation.outputFile,
    toolTmpDir: allocation.tmpDir
  };
  return {
    templateContext: allocatedContext,
    cwd,
    callDir: allocation.callDir,
    outputDir: allocation.outputDir,
    outputFile: allocation.outputFile,
    tmpDir: allocation.tmpDir
  };
}

async function prepareProjectToolOutputDir(context: ProjectToolExecutionContext): Promise<void> {
  await mkdir(context.outputDir, { recursive: true });
  await mkdir(context.tmpDir, { recursive: true });
}

function projectToolEnvironment(context: ProjectToolExecutionContext): Record<string, string> {
  return {
    [EnvVars.PROJECT_ROOT]: context.templateContext.projectRoot,
    [EnvVars.WORKTREE_PATH]: context.templateContext.worktreePath,
    [EnvVars.BEAD_ID]: context.templateContext.beadId || ProjectToolDefaults.UNASSIGNED_BEAD_ID,
    [EnvVars.STATE_ID]: context.templateContext.stateId || ProjectToolDefaults.UNSPECIFIED_STATE_ID,
    [EnvVars.ACTION_ID]: context.templateContext.actionId || ProjectToolDefaults.UNSPECIFIED_ACTION_ID,
    [EnvVars.TOOL_NAME]: context.templateContext.toolName || ProjectToolDefaults.UNASSIGNED_BEAD_ID,
    [EnvVars.TOOL_INVOCATION_ID]: context.templateContext.toolInvocationId || '',
    [EnvVars.TOOL_CALL_DIR]: context.callDir,
    [EnvVars.TOOL_OUTPUT_DIR]: context.outputDir,
    [EnvVars.TOOL_OUTPUT_FILE]: context.outputFile,
    [EnvVars.TOOL_TMP_DIR]: context.tmpDir,
    [EnvVars.TOOL_WORKING_DIR]: context.cwd,
    TMPDIR: context.tmpDir,
    TMP: context.tmpDir,
    TEMP: context.tmpDir
  };
}

function statusFromToolResult(result: unknown): ToolResultStatus | undefined {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined;
  const status = (result as { status?: unknown }).status;
  return typeof status === 'string' ? status as ToolResultStatus : undefined;
}

function summarizeToolResult(result: unknown): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const record = result as Record<string, unknown>;
  const summary: Record<string, unknown> = {
    status: record.status,
    success: record.success,
    message: record.message,
    tool: record.tool,
    server: record.server,
    operation: record.operation
  };
  for (const key of ['stdout', 'stderr', 'output', 'result']) {
    const value = record[key];
    if (typeof value === 'string') {
      summary[`${key}Bytes`] = value.length;
      summary[`${key}Preview`] = value.length > WorkerDefaults.EVENT_PREVIEW_CHARS
        ? `${value.slice(0, WorkerDefaults.EVENT_PREVIEW_CHARS)}...`
        : value;
    } else if (value !== undefined) {
      try {
        const json = JSON.stringify(value);
        summary[`${key}Bytes`] = json.length;
        summary[`${key}Preview`] = json.length > WorkerDefaults.EVENT_PREVIEW_CHARS
          ? `${json.slice(0, WorkerDefaults.EVENT_PREVIEW_CHARS)}...`
          : value;
      } catch {
        summary[`${key}Preview`] = String(value);
      }
    }
  }
  return summary;
}

function inlineResultLimit(definition: ProjectToolConfig): number {
  const configured = definition.inlineResultBytes;
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) return configured;
  return ProjectToolDefaults.INLINE_RESULT_BYTES;
}

function baseResultSummary(definition: ProjectToolConfig, result: Record<string, unknown>): Record<string, unknown> {
  return {
    tool: typeof result.tool === 'string' ? result.tool : definition.name,
    status: result.status,
    exitCode: result.exitCode,
    server: result.server,
    operation: result.operation,
    message: result.message
  };
}

async function persistAndBoundResult(
  definition: ProjectToolConfig,
  result: unknown,
  context: ProjectToolExecutionContext
): Promise<unknown> {
  const serialized = JSON.stringify(result, null, 2) ?? String(result);
  await writeFile(context.outputFile, serialized);
  const maxInlineBytes = inlineResultLimit(definition);
  if (serialized.length <= maxInlineBytes) {
    return {
      ...(typeof result === 'object' && result !== null && !Array.isArray(result) ? result : { result }),
      outputFile: context.outputFile,
      outputBytes: serialized.length,
      outputTruncated: false
    };
  }

  const record = typeof result === 'object' && result !== null && !Array.isArray(result)
    ? result as Record<string, unknown>
    : {};
  return {
    ...baseResultSummary(definition, record),
    outputFile: context.outputFile,
    outputBytes: serialized.length,
    outputTruncated: true,
    outputPreview: `${serialized.slice(0, maxInlineBytes)}\n\n[truncated ${serialized.length - maxInlineBytes} characters; full result written to outputFile]`
  };
}

async function executeCommandTool(definition: ProjectCommandToolConfig, args: any, context: ProjectToolExecutionContext) {
  const templateContext = context.templateContext;
  const command = resolveTemplateString(definition.command, templateContext);
  const finalArgs = (definition.defaultArgs || []).map(arg => resolveTemplateString(arg, templateContext));
  const suppliedArgs = normalizeCommandArguments(args?.[ProjectToolParameter.ARGUMENTS]);
  if (definition.allowArgs && suppliedArgs.length > 0) {
    if (definition.argsMode === 'append') {
      finalArgs.push(...suppliedArgs.map(arg => resolveTemplateString(arg, templateContext)));
    } else {
      finalArgs.splice(0, finalArgs.length, ...suppliedArgs.map(arg => resolveTemplateString(arg, templateContext)));
    }
  }

  const env = Object.fromEntries(
    Object.entries(definition.env || {}).map(([key, value]) => [key, resolveTemplateString(value, templateContext)])
  );

  try {
    const { stdout, stderr } = await execFileAsync(command, finalArgs, {
      cwd: context.cwd,
      env: { ...process.env, ...env, ...projectToolEnvironment(context) },
      maxBuffer: definition.maxOutputBytes || DataSize.MIB,
      timeout: definition.timeoutMs || Defaults.PROCESS_REAP_INTERVAL_MS
    });
    const boundedStdout = boundedCommandText(stdout);
    const boundedStderr = boundedCommandText(stderr);

    return {
      tool: definition.name,
      status: ToolResultStatus.PASSED,
      exitCode: CommandExitCode.SUCCESS,
      stdout: boundedStdout.text,
      stderr: boundedStderr.text,
      stdoutBytes: boundedStdout.bytes,
      stderrBytes: boundedStderr.bytes,
      stdoutTruncated: boundedStdout.truncated,
      stderrTruncated: boundedStderr.truncated
    };
  } catch (error: any) {
    const stderrText = typeof error.stderr === 'string' ? error.stderr : '';
    const acceptedExitCode = isSuccessfulCommandExitCode(definition, error.code) && stderrText.trim().length === 0;
    const acceptedMaxBuffer = isAcceptedMaxBufferFailure(definition, error);
    const maxBufferExceeded = error?.code === CommandErrorCode.MAX_BUFFER;
    const status = acceptedExitCode || acceptedMaxBuffer
      ? ToolResultStatus.PASSED
      : commandFailureStatus(error);
    const boundedStdout = boundedCommandText(error.stdout);
    const boundedStderr = boundedCommandText(error.stderr || (acceptedExitCode ? '' : error.message));
    return {
      tool: definition.name,
      status,
      exitCode: typeof error.code === 'number' ? error.code : undefined,
      maxBufferExceeded,
      stdout: boundedStdout.text,
      stderr: boundedStderr.text,
      stdoutBytes: boundedStdout.bytes,
      stderrBytes: boundedStderr.bytes,
      stdoutTruncated: boundedStdout.truncated || maxBufferExceeded,
      stderrTruncated: boundedStderr.truncated
    };
  }
}

function resolveConfiguredPath(value: string, templateContext: TemplateContext): string {
  const resolved = resolveTemplateString(value, templateContext);
  return path.isAbsolute(resolved) ? resolved : path.resolve(templateContext.projectRoot, resolved);
}

function resolveArgumentTemplates(value: unknown, templateContext: TemplateContext): unknown {
  if (typeof value === 'string') return resolveTemplateString(value, templateContext);
  if (Array.isArray(value)) return value.map(item => resolveArgumentTemplates(item, templateContext));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, resolveArgumentTemplates(nested, templateContext)])
  );
}

async function loadMcpConfig(configPath: string): Promise<McpConfigFile> {
  const raw = await readFile(configPath, 'utf-8');
  const parsed = JSON.parse(raw) as McpConfigFile;
  return parsed;
}

function getMcpServers(config: McpConfigFile): Record<string, McpServerDefinition> {
  return config[MCP_SERVER_CONFIG_KEY] || config[LEGACY_MCP_SERVER_CONFIG_KEY] || {};
}

function resolveRecordTemplates(record: Record<string, string> | undefined, templateContext: TemplateContext): Record<string, string> | undefined {
  if (!record) return undefined;
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, resolveTemplateString(value, templateContext)])
  );
}

function resolveMcpOperation(definition: ProjectMcpToolConfig, requested: unknown): string | undefined {
  const requestedOperation = typeof requested === 'string' && requested.trim()
    ? requested.trim()
    : undefined;
  const configuredOperations = definition.operations;

  if (!configuredOperations) return requestedOperation;
  if (Array.isArray(configuredOperations)) {
    if (requestedOperation) return configuredOperations.includes(requestedOperation) ? requestedOperation : undefined;
    return configuredOperations[0];
  }

  if (requestedOperation) {
    return configuredOperations[requestedOperation] || (
      Object.values(configuredOperations).includes(requestedOperation) ? requestedOperation : undefined
    );
  }

  return Object.values(configuredOperations)[0];
}

function operationError(definition: ProjectMcpToolConfig, requested: unknown) {
  const requestedText = typeof requested === 'string' && requested.trim() ? ` Requested operation: ${requested}.` : '';
  const configured = definition.operations
    ? ` Configured operations: ${JSON.stringify(definition.operations)}.`
    : ' No default operations are configured.';
  return {
    tool: definition.name,
    status: ToolResultStatus.REJECTED,
    server: definition.server,
    message: `No valid MCP operation was selected for project tool ${definition.name}.${requestedText}${configured}`
  };
}

function operationArgumentDefaults(
  definition: ProjectMcpToolConfig,
  requested: unknown,
  operation: string,
  templateContext: TemplateContext
): Record<string, unknown> {
  const defaults = definition.argumentDefaults || {};
  const requestedOperation = typeof requested === 'string' && requested.trim()
    ? requested.trim()
    : undefined;
  const configuredDefaults = (requestedOperation && defaults[requestedOperation])
    || defaults[operation]
    || {};
  return resolveArgumentTemplates(configuredDefaults, templateContext) as Record<string, unknown>;
}

function operationArgumentAllowlist(
  definition: ProjectMcpToolConfig,
  requested: unknown,
  operation: string
): string[] | undefined {
  const allowlist = definition.argumentAllowlist || {};
  const requestedOperation = typeof requested === 'string' && requested.trim()
    ? requested.trim()
    : undefined;
  return (requestedOperation && allowlist[requestedOperation]) || allowlist[operation];
}

function filterMcpArguments(
  definition: ProjectMcpToolConfig,
  requested: unknown,
  operation: string,
  argumentsRecord: Record<string, unknown>
): { arguments: Record<string, unknown>; droppedArguments: string[] } {
  const allowlist = operationArgumentAllowlist(definition, requested, operation);
  if (!allowlist) return { arguments: argumentsRecord, droppedArguments: [] };

  const allowed = new Set(allowlist);
  const filtered: Record<string, unknown> = {};
  const droppedArguments: string[] = [];
  for (const [key, value] of Object.entries(argumentsRecord)) {
    if (allowed.has(key)) filtered[key] = value;
    else droppedArguments.push(key);
  }
  return { arguments: filtered, droppedArguments };
}

async function createMcpTransport(server: McpServerDefinition, context: ProjectToolExecutionContext) {
  const templateContext = context.templateContext;
  if (server.command) {
    const env = resolveRecordTemplates(server.env, templateContext);
    return new StdioClientTransport({
      command: resolveTemplateString(server.command, templateContext),
      args: (server.args || []).map(arg => resolveTemplateString(arg, templateContext)),
      cwd: server.cwd ? resolveConfiguredPath(server.cwd, templateContext) : templateContext.worktreePath,
      env: { ...process.env, ...env, ...projectToolEnvironment(context) } as Record<string, string>,
      stderr: 'ignore'
    });
  }

  if (server.url) {
    const requestInit = server.headers
      ? { headers: resolveRecordTemplates(server.headers, templateContext) }
      : undefined;
    const url = new URL(resolveTemplateString(server.url, templateContext));
    return server.type === MCP_SSE_TRANSPORT
      ? new SSEClientTransport(url, { requestInit })
      : new StreamableHTTPClientTransport(url, { requestInit });
  }

  throw new Error('MCP server has neither command nor url configured.');
}

async function executeMcpTool(definition: ProjectMcpToolConfig, args: any, ctx: ExtensionContext, context: ProjectToolExecutionContext) {
  const templateContext = context.templateContext;
  const configPath = resolveConfiguredPath(definition.configPath || DEFAULT_MCP_CONFIG_PATH, templateContext);
  const operation = resolveMcpOperation(definition, args.operation);
  if (!operation) return operationError(definition, args.operation);

  try {
    const mcpConfig = await loadMcpConfig(configPath);
    const server = getMcpServers(mcpConfig)[definition.server];
    if (!server) {
      const message = `MCP server ${definition.server} is not configured in ${configPath}.`;
      if (definition.optional) return unavailable(definition.name, message);
      return {
        tool: definition.name,
        status: ToolResultStatus.REJECTED,
        server: definition.server,
        operation,
        message
      };
    }
    
    Logger.info(Component.PROJECT_TOOLS, 'Calling configured MCP tool', {
      tool: definition.name,
      server: definition.server,
      operation
    });

    const client = new Client(
      { name: `orr-else-${definition.name}`, version: '1.0.0' },
      { capabilities: {} }
    );
    const transport = await createMcpTransport(server, context);
    try {
      await client.connect(transport);
      const defaultArguments = operationArgumentDefaults(definition, args.operation, operation, templateContext);
      const suppliedArguments = resolveArgumentTemplates(args.arguments || {}, templateContext) as Record<string, unknown>;
      const { arguments: toolArguments, droppedArguments } = filterMcpArguments(
        definition,
        args.operation,
        operation,
        {
          ...defaultArguments,
          ...suppliedArguments
        }
      );
      const result = await client.callTool({
        name: operation,
        arguments: toolArguments
      });

      if ((result as { isError?: boolean }).isError) {
        return {
          tool: definition.name,
          status: ToolResultStatus.REJECTED,
          server: definition.server,
          operation,
          droppedArguments,
          result
        };
      }

      return {
        tool: definition.name,
        status: ToolResultStatus.PASSED,
        server: definition.server,
        operation,
        droppedArguments,
        result
      };
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  } catch (error) {
    const message = String(error);
    if (definition.optional) return unavailable(definition.name, message);
    return {
      tool: definition.name,
      status: ToolResultStatus.REJECTED,
      server: definition.server,
      operation,
      message
    };
  }
}

export async function executeConfiguredProjectTool(
  eventStore: EventStore,
  pathFactory: ToolCallPathFactory,
  definition: ProjectToolConfig,
  args: any,
  ctx: ExtensionContext
) {
  const beadId = beadIdFromArgs(args);
  const context = executionContext(pathFactory, definition, args);
  if (definition.type === ProjectToolType.EXTENSION) {
    const result = {
      tool: definition.name,
      status: ToolResultStatus.REJECTED,
      message: `Project tool ${definition.name} is registered by a Pi extension and cannot be executed directly by Orr Else. Use it as a model tool call, or configure a command/mcp tool for harness-run parent actions.`
    };
    await eventStore.record(DomainEventName.PROJECT_TOOL_FAILED, {
      beadId,
      tool: definition.name,
      type: definition.type,
      status: result.status,
      result
    }).catch(() => {});
    return result;
  }

  await eventStore.record(DomainEventName.PROJECT_TOOL_STARTED, {
      beadId,
      tool: definition.name,
      type: definition.type,
      cwd: context.cwd,
      toolInvocationId: context.templateContext.toolInvocationId,
      callDir: context.callDir,
      outputDir: context.outputDir,
      outputFile: context.outputFile,
      tmpDir: context.tmpDir
    });

  try {
    await prepareProjectToolOutputDir(context);
    await eventStore.record(DomainEventName.PROJECT_TOOL_OUTPUT_DIR_PREPARED, {
      beadId,
      tool: definition.name,
      cwd: context.cwd,
      toolInvocationId: context.templateContext.toolInvocationId,
      callDir: context.callDir,
      outputDir: context.outputDir,
      outputFile: context.outputFile,
      tmpDir: context.tmpDir
    });
    const rawResult = definition.type === ProjectToolType.COMMAND
      ? await executeCommandTool(definition as ProjectCommandToolConfig, args, context)
      : await executeMcpTool(definition as ProjectMcpToolConfig, args, ctx, context);
    const result = await persistAndBoundResult(definition, rawResult, context);
    const status = statusFromToolResult(result);
    await eventStore.record(
      status === ToolResultStatus.PASSED ? DomainEventName.PROJECT_TOOL_SUCCEEDED : DomainEventName.PROJECT_TOOL_FAILED,
      {
        beadId,
        tool: definition.name,
        type: definition.type,
        status,
        result: summarizeToolResult(result)
      }
    );
    return result;
  } catch (error) {
    await eventStore.record(DomainEventName.PROJECT_TOOL_FAILED, {
      beadId,
      tool: definition.name,
      type: definition.type,
      error: String(error)
    }).catch(() => {});
    throw error;
  }
}

export function getConfiguredProjectToolNames(config: HarnessConfig): string[] {
  return (config.tools || []).map(tool => tool.name);
}

export function getHarnessRegisteredProjectToolNames(config: HarnessConfig): string[] {
  return (config.tools || [])
    .filter(tool => tool.type !== ProjectToolType.EXTENSION)
    .map(tool => tool.name);
}

export function getNativePiExtensionProjectToolNames(config: HarnessConfig): string[] {
  return (config.tools || [])
    .filter(tool => tool.type === ProjectToolType.EXTENSION)
    .map(tool => tool.name);
}

export function describeConfiguredProjectTools(config: HarnessConfig): string {
  const tools = config.tools || [];
  if (tools.length === 0) return '';

  function operationSummary(tool: ProjectMcpToolConfig): string {
    const operations = tool.operations || {};
    const values = Array.isArray(operations)
      ? operations
      : Object.entries(operations).map(([alias, operation]) => `${alias} -> ${operation}`);
    return values.length > 0 ? ` Operations: ${values.join(', ')}.` : '';
  }

  function allowlistSummary(tool: ProjectMcpToolConfig): string {
    const entries = Object.entries(tool.argumentAllowlist || {});
    if (entries.length === 0) return '';
    const values = entries.map(([operation, keys]) => `${operation}(${keys.join(', ') || 'no arguments'})`);
    return ` Allowed arguments: ${values.join('; ')}.`;
  }

  function defaultSummary(tool: ProjectMcpToolConfig): string {
    const entries = Object.entries(tool.argumentDefaults || {});
    if (entries.length === 0) return '';
    const values = entries.map(([operation, defaults]) => `${operation} defaults ${JSON.stringify(defaults)}`);
    return ` Argument defaults: ${values.join('; ')}.`;
  }

  function usageNotesSummary(tool: ProjectToolConfig): string {
    return tool.usageNotes?.length ? ` Usage notes: ${tool.usageNotes.join(' ')}` : '';
  }

  const descriptions = tools.map(tool => {
    const transport = tool.type === ProjectToolType.MCP
      ? ` MCP server \`${(tool as ProjectMcpToolConfig).server}\`.`
      : tool.type === ProjectToolType.EXTENSION
        ? ' Native Pi extension tool registered with `pi.registerTool()` from `.pi/extensions`, `~/.pi/agent/extensions`, or an installed Pi package.'
        : '';
    const mcpDetails = tool.type === ProjectToolType.MCP
      ? [
        operationSummary(tool as ProjectMcpToolConfig),
        allowlistSummary(tool as ProjectMcpToolConfig),
        defaultSummary(tool as ProjectMcpToolConfig)
      ].join('')
      : '';
    return `- \`${tool.name}\`: ${tool.description || 'No description provided.'}${transport}${mcpDetails}${usageNotesSummary(tool)}`;
  }).join('\n');

  return `\n### PROJECT-SPECIFIC TOOLS\nThe following project-specific tools are available to you:\n\n${descriptions}\n`;
}

export function registerConfiguredProjectTools(
  eventStore: EventStore,
  pathFactory: ToolCallPathFactory,
  pi: ExtensionAPI,
  config: HarnessConfig,
  seen: Set<string>,
  wrapper: Function,
  runtimeContext?: () => ProjectToolRuntimeContext | undefined
) {
  const tools = config.tools || [];
  for (const definition of tools) {
    if (definition.type === ProjectToolType.EXTENSION) continue;
    if (seen.has(definition.name)) continue;
    seen.add(definition.name);

    pi.registerTool(wrapper({
      name: definition.name,
      description: definition.description || `Project-specific tool: ${definition.name}`,
      parameters: definition.type === ProjectToolType.COMMAND
        ? Type.Object({
            [ProjectToolParameter.ARGUMENTS]: Type.Optional(Type.Any({
              description: 'Command arguments. Use an argv array for exact control, or an object whose keys become stable --kebab-case flags.'
            })),
            [ProjectToolParameter.CWD]: Type.Optional(Type.String({
              description: 'Optional execution directory override when the tool configuration has allowCwdOverride=true. Use "worktree", "project", or a configured path template.'
            }))
          })
        : Type.Object({
            operation: Type.Optional(Type.String({ description: 'The configured MCP operation or alias to perform' })),
            arguments: Type.Optional(Type.Object({}, { additionalProperties: true, description: 'JSON object arguments for the MCP tool operation' }))
          }),
      execute: async (params: any, ctx: ExtensionContext) => {
        return await executeConfiguredProjectTool(eventStore, pathFactory, definition, {
          ...(runtimeContext?.() || {}),
          ...(params || {})
        }, ctx);
      }
    }));
  }
}
