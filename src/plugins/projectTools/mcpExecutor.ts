/**
 * MCP (Model Context Protocol) transport executor for projectTools.
 * Package-internal — do not import from outside src/plugins/.
 */
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { mkdir, open, readFile, writeFile } from 'fs/promises';
import lockfile from 'proper-lockfile';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { resolveTemplateString } from '../../core/PiIntegration.js';
import type { ProjectMcpToolConfig } from '../../core/domain/StateModels.js';
import { Logger } from '../../core/Logger.js';
import { Component, Defaults, ToolResultStatus } from '../../constants/index.js';
import {
  DEFAULT_MCP_CONFIG_PATH,
  LEGACY_MCP_SERVER_CONFIG_KEY,
  MCP_RAW_FILE_NAME,
  MCP_SERVER_CONFIG_KEY,
  MCP_SSE_TRANSPORT,
  SERIAL_MCP_LOCK_REASON,
  SERIAL_MCP_LOCK_RETRIES,
  SERIAL_MCP_LOCK_RETRY_MAX_MS,
  SERIAL_MCP_LOCK_RETRY_MIN_MS,
  SERIAL_MCP_LOCK_SCOPE,
  SERIAL_MCP_LOCK_STALE_MS,
  SERIAL_MCP_REQUEST_TIMEOUT_MS
} from './constants.js';
import type { McpConfigFile, McpServerDefinition, ProjectToolExecutionContext, SerializedMcpLockMetadata } from './types.js';
import { projectToolEnvironment } from './contextHelpers.js';
import { normalizeMcpPathArguments } from './pathNormalization.js';

// ---- Serialized MCP lock error ----

export class SerializedMcpToolLockTimeoutError extends Error {
  readonly lockMetadata: import('./types.js').SerializedMcpLockTimeoutMetadata;

  constructor(
    definition: ProjectMcpToolConfig,
    lockPath: string,
    waitedMs: number,
    cause: unknown,
    metadata: SerializedMcpLockMetadata
  ) {
    super(`Timed out acquiring serialized MCP project-tool lock for ${definition.name} after ${waitedMs}ms: ${String(cause)}`);
    this.name = 'SerializedMcpToolLockTimeoutError';
    this.lockMetadata = {
      scope: metadata.scope,
      reason: metadata.reason,
      waitedMs,
      tool: definition.name,
      server: definition.server,
      lockRef: path.basename(path.dirname(lockPath)),
      lockFile: path.basename(lockPath)
    };
  }
}

// ---- Exported helpers ----

export function shouldSerializeMcpTool(definition: Pick<ProjectMcpToolConfig, 'type' | 'serialize'>): boolean {
  return definition.type === 'mcp' && definition.serialize === true;
}

export function mcpToolRequestTimeoutMs(definition: Pick<ProjectMcpToolConfig, 'type' | 'timeoutMs' | 'serialize'>): number {
  if (typeof definition.timeoutMs === 'number' && Number.isFinite(definition.timeoutMs) && definition.timeoutMs > 0) {
    return definition.timeoutMs;
  }
  return shouldSerializeMcpTool(definition) ? SERIAL_MCP_REQUEST_TIMEOUT_MS : Defaults.PROCESS_REAP_INTERVAL_MS;
}

function mcpToolRequestOptions(definition: ProjectMcpToolConfig): RequestOptions {
  return { timeout: mcpToolRequestTimeoutMs(definition) };
}

// ---- Lock helpers ----

function serializedMcpLockMetadata(context: ProjectToolExecutionContext): SerializedMcpLockMetadata {
  const root = context.templateContext.projectRoot || process.cwd();
  return {
    scope: SERIAL_MCP_LOCK_SCOPE,
    projectRoot: root,
    worktreePath: context.templateContext.worktreePath,
    reason: SERIAL_MCP_LOCK_REASON
  };
}

function serializedMcpLockPath(definition: ProjectMcpToolConfig, context: ProjectToolExecutionContext): string {
  const metadata = serializedMcpLockMetadata(context);
  const digest = createHash('sha256')
    .update(`${metadata.projectRoot}\n${definition.server}\n${definition.name}`)
    .digest('hex')
    .slice(0, 16);
  return path.join(tmpdir(), 'orr-else-mcp-tool-locks', digest, `${definition.name}.lock`);
}

async function ensureSerializedMcpLockFile(definition: ProjectMcpToolConfig, context: ProjectToolExecutionContext): Promise<string> {
  const lockPath = serializedMcpLockPath(definition, context);
  await mkdir(path.dirname(lockPath), { recursive: true });
  const handle = await open(lockPath, 'a');
  await handle.close();
  return lockPath;
}

async function withSerializedMcpToolLock<T>(
  definition: ProjectMcpToolConfig,
  context: ProjectToolExecutionContext,
  fn: () => Promise<T>
): Promise<T> {
  if (!shouldSerializeMcpTool(definition)) return await fn();

  const lockPath = await ensureSerializedMcpLockFile(definition, context);
  const startedAtMs = Date.now();
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(lockPath, {
      stale: SERIAL_MCP_LOCK_STALE_MS,
      retries: {
        retries: SERIAL_MCP_LOCK_RETRIES,
        factor: 1.1,
        minTimeout: SERIAL_MCP_LOCK_RETRY_MIN_MS,
        maxTimeout: SERIAL_MCP_LOCK_RETRY_MAX_MS
      }
    });
  } catch (error) {
    const waitedMs = Date.now() - startedAtMs;
    const lockMetadata = serializedMcpLockMetadata(context);
    Logger.warn(Component.PROJECT_TOOLS, 'Timed out acquiring serialized MCP project-tool lock', {
      tool: definition.name,
      server: definition.server,
      waitedMs,
      lockScope: lockMetadata.scope,
      lockReason: lockMetadata.reason,
      lockRef: path.basename(path.dirname(lockPath)),
      lockFile: path.basename(lockPath),
      error: String(error)
    });
    throw new SerializedMcpToolLockTimeoutError(definition, lockPath, waitedMs, error, lockMetadata);
  }

  const waitedMs = Date.now() - startedAtMs;
  if (waitedMs > SERIAL_MCP_LOCK_RETRY_MAX_MS) {
    const lockMetadata = serializedMcpLockMetadata(context);
    Logger.warn(Component.PROJECT_TOOLS, 'Waited for serialized MCP project-tool lock', {
      tool: definition.name,
      server: definition.server,
      waitedMs,
      lockScope: lockMetadata.scope,
      lockReason: lockMetadata.reason,
      projectRoot: lockMetadata.projectRoot,
      worktreePath: lockMetadata.worktreePath,
      lockPath
    });
  }

  try {
    return await fn();
  } finally {
    await release?.().catch((error: unknown) => {
      Logger.warn(Component.PROJECT_TOOLS, 'Unable to release serialized MCP project-tool lock', {
        tool: definition.name,
        server: definition.server,
        lockPath,
        error: String(error)
      });
    });
  }
}

export function serializedMcpLockTimeoutResult(
  definition: ProjectMcpToolConfig,
  error: SerializedMcpToolLockTimeoutError
): Record<string, unknown> {
  return {
    tool: definition.name,
    status: ToolResultStatus.REJECTED,
    server: definition.server,
    failureCategory: 'backpressure',
    lockTimeout: true,
    lockMetadata: error.lockMetadata,
    message: `REJECTED: \`${definition.name}\` could not acquire the serialized MCP project-tool lock after ${error.lockMetadata.waitedMs}ms. Another ${definition.server} operation is likely still in flight; wait for that result instead of starting parallel retries.`,
    recovery: [
      'Wait for the in-flight serialized MCP project-tool result before retrying.',
      'After the in-flight result is visible, rerun this configured project tool once with narrower arguments only if more evidence is still required.'
    ]
  };
}

// ---- MCP config loading ----

async function loadMcpConfig(configPath: string): Promise<McpConfigFile> {
  const raw = await readFile(configPath, 'utf-8');
  const parsed = JSON.parse(raw) as McpConfigFile;
  return parsed;
}

function getMcpServers(config: McpConfigFile): Record<string, McpServerDefinition> {
  return config[MCP_SERVER_CONFIG_KEY] || config[LEGACY_MCP_SERVER_CONFIG_KEY] || {};
}

function resolveConfiguredPath(value: string, templateContext: import('../../core/PiIntegration.js').TemplateContext): string {
  const resolved = resolveTemplateString(value, templateContext);
  return path.isAbsolute(resolved) ? resolved : path.resolve(templateContext.projectRoot, resolved);
}

function resolveRecordTemplates(record: Record<string, string> | undefined, templateContext: import('../../core/PiIntegration.js').TemplateContext): Record<string, string> | undefined {
  if (!record) return undefined;
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, resolveTemplateString(value, templateContext)])
  );
}

function resolveArgumentTemplates(value: unknown, templateContext: import('../../core/PiIntegration.js').TemplateContext): unknown {
  if (typeof value === 'string') return resolveTemplateString(value, templateContext);
  if (Array.isArray(value)) return value.map(item => resolveArgumentTemplates(item, templateContext));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, resolveArgumentTemplates(nested, templateContext)])
  );
}

// ---- MCP operation resolution ----

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

  return (configuredOperations as Record<string, string>)[requestedOperation || ''] || (
    Object.values(configuredOperations as Record<string, string>).includes(requestedOperation || '') ? requestedOperation : undefined
  ) || Object.values(configuredOperations as Record<string, string>)[0];
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
  templateContext: import('../../core/PiIntegration.js').TemplateContext
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

// ---- Transport factory ----

async function createMcpTransport(server: McpServerDefinition, context: ProjectToolExecutionContext) {
  const templateContext = context.templateContext;
  if (server.command) {
    const env = resolveRecordTemplates(server.env, templateContext);
    return new StdioClientTransport({
      command: resolveTemplateString(server.command, templateContext),
      args: (server.args || []).map(arg => resolveTemplateString(arg, templateContext)),
      cwd: server.cwd ? resolveConfiguredPath(server.cwd, templateContext) : templateContext.worktreePath,
      env: { ...context.hostEnv, ...env, ...projectToolEnvironment(context) } as Record<string, string>,
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

function unavailable(name: string, message: string) {
  return {
    tool: name,
    status: ToolResultStatus.UNAVAILABLE,
    message
  };
}

// ---- Raw MCP result persistence (s3wp.26) ----

/**
 * Persist the complete raw client.callTool result (or error envelope) to
 * context.outputDir/mcp-raw.json BEFORE the compact model-facing result is
 * built.  This is the generic archival the raw-output contract mandates.
 *
 * Returns { rawFile, rawBytes, rawChecksum } for inclusion in the model-facing
 * result so the model can reference the archive if needed.
 *
 * Errors here are swallowed (logged only) so a persistence failure never
 * prevents the model from receiving its result.
 */
export async function persistMcpRawResult(
  outputDir: string,
  payload: unknown
): Promise<{ rawFile: string; rawBytes: number; rawChecksum: string } | undefined> {
  try {
    const rawFile = path.join(outputDir, MCP_RAW_FILE_NAME);
    const serialized = JSON.stringify(payload);
    await writeFile(rawFile, serialized);
    const rawBytes = Buffer.byteLength(serialized, 'utf8');
    const rawChecksum = createHash('sha256').update(serialized).digest('hex').slice(0, 16);
    return { rawFile, rawBytes, rawChecksum };
  } catch (error) {
    Logger.warn(Component.PROJECT_TOOLS, 'Failed to persist raw MCP result', {
      outputDir,
      error: String(error)
    });
    return undefined;
  }
}

// ---- executeMcpTool ----

export async function executeMcpTool(definition: ProjectMcpToolConfig, args: any, ctx: ExtensionContext, context: ProjectToolExecutionContext) {
  try {
    return await withSerializedMcpToolLock(definition, context, async () => executeMcpToolUnlocked(definition, args, ctx, context));
  } catch (error) {
    if (error instanceof SerializedMcpToolLockTimeoutError) {
      return serializedMcpLockTimeoutResult(definition, error);
    }
    throw error;
  }
}

async function executeMcpToolUnlocked(definition: ProjectMcpToolConfig, args: any, ctx: ExtensionContext, context: ProjectToolExecutionContext) {
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
      operation,
      timeoutMs: mcpToolRequestTimeoutMs(definition)
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
      const normalizedArguments = normalizeMcpPathArguments(
        definition,
        args.operation,
        operation,
        toolArguments,
        templateContext
      );
      const callToolResult = await client.callTool({
        name: operation,
        arguments: normalizedArguments.arguments
      }, undefined, mcpToolRequestOptions(definition));

      // s3wp.26: persist the COMPLETE raw client.callTool payload to mcp-raw.json
      // BEFORE building the compact model-facing result.  The model never receives
      // the full callTool payload; it receives only the compact schema fields plus
      // rawFile/rawBytes/rawChecksum references.
      const rawArchive = await persistMcpRawResult(context.outputDir, callToolResult);

      if ((callToolResult as { isError?: boolean }).isError) {
        return {
          tool: definition.name,
          status: ToolResultStatus.REJECTED,
          server: definition.server,
          operation,
          droppedArguments,
          normalizedPathArguments: normalizedArguments.normalizedPathArguments,
          ...rawArchive
        };
      }

      return {
        tool: definition.name,
        status: ToolResultStatus.PASSED,
        server: definition.server,
        operation,
        droppedArguments,
        normalizedPathArguments: normalizedArguments.normalizedPathArguments,
        ...rawArchive
      };
    } finally {
      await client.close().catch((error: unknown) => {
        Logger.warn(Component.PROJECT_TOOLS, 'Failed to close MCP client', { server: definition.server, error: String(error) });
      });
      await transport.close().catch((error: unknown) => {
        Logger.warn(Component.PROJECT_TOOLS, 'Failed to close MCP transport', { server: definition.server, error: String(error) });
      });
    }
  } catch (error) {
    const message = String(error);
    if (definition.optional) return unavailable(definition.name, message);
    // s3wp.26: persist a raw error envelope on transport/connection failures so
    // the complete error metadata is archived even when client.callTool never ran.
    const errorEnvelope = {
      tool: definition.name,
      server: definition.server,
      operation,
      error: message,
      errorType: error instanceof Error ? error.constructor.name : typeof error,
      errorStack: error instanceof Error ? error.stack : undefined
    };
    const rawArchive = await persistMcpRawResult(context.outputDir, errorEnvelope).catch(() => undefined);
    return {
      tool: definition.name,
      status: ToolResultStatus.REJECTED,
      server: definition.server,
      operation,
      message,
      ...rawArchive
    };
  }
}
