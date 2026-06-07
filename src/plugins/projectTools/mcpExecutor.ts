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
import { readFile, writeFile } from 'fs/promises';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { resolveTemplateString } from '../../core/PiIntegration.js';
import type { ProjectMcpToolConfig } from '../../core/domain/StateModels.js';
import { Logger } from '../../core/Logger.js';
import { Component, Defaults, ToolResultStatus } from '../../constants/index.js';
import {
  DEFAULT_MCP_CONFIG_PATH,
  MCP_RAW_FILE_NAME,
  MCP_SERVER_CONFIG_KEY,
  MCP_SSE_TRANSPORT,
  MCP_TOOL_LOCK_DIR,
  SERIAL_MCP_LOCK_REASON,
  SERIAL_MCP_LOCK_SCOPE,
  SERIAL_MCP_REQUEST_TIMEOUT_MS
} from './constants.js';
import type { McpConfigFile, McpServerDefinition, ProjectToolExecutionContext, SerializedMcpLockMetadata } from './types.js';
import { projectToolEnvironment } from './contextHelpers.js';
import { normalizeMcpPathArguments } from './pathNormalization.js';
import { SerializedToolLockTimeoutError, withSerializedToolLock } from './serializedToolLock.js';

// ---- Serialized MCP lock error ----

export class SerializedMcpToolLockTimeoutError extends Error {
  readonly lockMetadata: import('./types.js').SerializedMcpLockTimeoutMetadata;

  constructor(
    definition: ProjectMcpToolConfig,
    cause: SerializedToolLockTimeoutError,
    metadata: SerializedMcpLockMetadata
  ) {
    super(cause.message);
    this.name = 'SerializedMcpToolLockTimeoutError';
    this.lockMetadata = {
      scope: metadata.scope,
      reason: metadata.reason,
      waitedMs: cause.waitedMs,
      tool: definition.name,
      server: definition.server,
      lockRef: cause.lockRef,
      lockFile: cause.lockFile
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

function mcpToolRequestOptions(definition: ProjectMcpToolConfig, signal?: AbortSignal): RequestOptions {
  // zog2.9: propagate the Pi AbortSignal to the MCP request only for tools that
  // declare cancellationPolicy: 'supported' in their sideEffectContract.
  const cancellationPolicy = (definition as { sideEffectContract?: { cancellationPolicy?: string } })
    .sideEffectContract?.cancellationPolicy;
  const opts: RequestOptions = { timeout: mcpToolRequestTimeoutMs(definition) };
  if (cancellationPolicy === 'supported' && signal) {
    opts.signal = signal;
  }
  return opts;
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

async function withSerializedMcpToolLock<T>(
  definition: ProjectMcpToolConfig,
  context: ProjectToolExecutionContext,
  fn: () => Promise<T>
): Promise<T> {
  if (!shouldSerializeMcpTool(definition)) return await fn();

  const metadata = serializedMcpLockMetadata(context);
  // zog2.9: when the tool declares a sideEffectContract.serializationKey, use that
  // key (instead of the tool name) as the lock-bucket differentiator so that two
  // distinct tools sharing the same serializationKey genuinely serialize against
  // each other. Without this, only tools with the same NAME would collide.
  const serializationKey = (definition as { sideEffectContract?: { serializationKey?: string | null } })
    .sideEffectContract?.serializationKey;
  const lockBucket = (typeof serializationKey === 'string' && serializationKey.trim())
    ? serializationKey.trim()
    : definition.name;
  try {
    return await withSerializedToolLock(
      {
        lockDir: MCP_TOOL_LOCK_DIR,
        keyParts: [metadata.projectRoot, lockBucket],
        lockName: definition.name,
        logFields: {
          tool: definition.name,
          server: definition.server,
          lockBucket,
          lockScope: metadata.scope,
          lockReason: metadata.reason
        }
      },
      `Timed out acquiring serialized MCP project-tool lock for ${definition.name}`,
      fn
    );
  } catch (error) {
    if (error instanceof SerializedToolLockTimeoutError) {
      throw new SerializedMcpToolLockTimeoutError(definition, error, metadata);
    }
    throw error;
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
  return config[MCP_SERVER_CONFIG_KEY] || {};
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

// ---- Raw MCP result persistence (s3wp.26 / cosx / zog2.12) ----

/**
 * Persist the complete raw client.callTool result (or error envelope) to
 * context.outputDir/mcp-raw.json BEFORE the compact model-facing result is
 * built.  This is AUTHORITATIVE harness-side evidence (zog2.12).
 *
 * Returns { rawFile, rawBytes, rawChecksum } for internal/evidence use.
 * These fields are NOT spread into the model-facing result (cosx: removed from
 * model-facing results; raw archives are harness-side evidence only, accessible
 * via the canonical event/evidence path).
 *
 * zog2.12: Errors are NO LONGER swallowed. Write failures throw an
 * McpRawArchiveWriteError so the caller can fail-closed (return REJECTED)
 * rather than silently producing a PASSED result without durable evidence.
 */
export type McpArchiveFailureCategory =
  | 'write_failure'
  | 'checksum_mismatch'
  | 'missing_checksum'
  | 'malformed'
  | 'backend_unavailable';

export class McpRawArchiveWriteError extends Error {
  readonly archiveFailureCategory: McpArchiveFailureCategory;
  readonly outputDir: string;
  readonly cause: unknown;

  constructor(outputDir: string, cause: unknown, category: McpArchiveFailureCategory = 'write_failure') {
    super(`MCP raw archive write failed (${category}): ${String(cause)}`);
    this.name = 'McpRawArchiveWriteError';
    this.outputDir = outputDir;
    this.cause = cause;
    this.archiveFailureCategory = category;
  }
}

export async function persistMcpRawResult(
  outputDir: string,
  payload: unknown
): Promise<{ rawFile: string; rawBytes: number; rawChecksum: string }> {
  const rawFile = path.join(outputDir, MCP_RAW_FILE_NAME);

  // zog2.12 review fix: classify malformed payloads that cannot be serialized.
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch (error) {
    throw new McpRawArchiveWriteError(outputDir, error, 'malformed');
  }

  const expectedBytes = Buffer.byteLength(serialized, 'utf8');
  const expectedChecksum = createHash('sha256').update(serialized).digest('hex').slice(0, 16);

  try {
    await writeFile(rawFile, serialized);
  } catch (error) {
    // zog2.12: propagate as McpRawArchiveWriteError so executeMcpToolUnlocked
    // can fail-closed (REJECTED) instead of silently producing PASSED evidence.
    throw new McpRawArchiveWriteError(outputDir, error);
  }

  // zog2.12 review fix: read the file back to cross-check that the persisted bytes
  // match what was written. This makes the "durably written and cross-checked" AC real:
  // a successful write followed by a divergent readback is a checksum_mismatch; an
  // absent/empty readback is a missing_checksum.
  let readback: string;
  try {
    readback = await readFile(rawFile, 'utf-8');
  } catch (error) {
    throw new McpRawArchiveWriteError(outputDir, error, 'missing_checksum');
  }

  if (!readback) {
    throw new McpRawArchiveWriteError(
      outputDir,
      new Error('readback returned empty content'),
      'missing_checksum'
    );
  }

  const readbackChecksum = createHash('sha256').update(readback).digest('hex').slice(0, 16);
  if (readbackChecksum !== expectedChecksum) {
    throw new McpRawArchiveWriteError(
      outputDir,
      new Error(`checksum mismatch: wrote ${expectedChecksum}, read back ${readbackChecksum} (${expectedBytes}B written, ${Buffer.byteLength(readback, 'utf8')}B read)`),
      'checksum_mismatch'
    );
  }

  return { rawFile, rawBytes: expectedBytes, rawChecksum: expectedChecksum };
}

// ---- executeMcpTool ----

export async function executeMcpTool(definition: ProjectMcpToolConfig, args: any, ctx: ExtensionContext, context: ProjectToolExecutionContext, signal?: AbortSignal) {
  try {
    return await withSerializedMcpToolLock(definition, context, async () => executeMcpToolUnlocked(definition, args, ctx, context, signal));
  } catch (error) {
    if (error instanceof SerializedMcpToolLockTimeoutError) {
      return serializedMcpLockTimeoutResult(definition, error);
    }
    throw error;
  }
}

async function executeMcpToolUnlocked(definition: ProjectMcpToolConfig, args: any, ctx: ExtensionContext, context: ProjectToolExecutionContext, signal?: AbortSignal) {
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
      }, undefined, mcpToolRequestOptions(definition, signal));

      // zog2.12: persist the COMPLETE raw client.callTool payload to mcp-raw.json as
      // AUTHORITATIVE harness-side evidence BEFORE building the compact model-facing result.
      // Write failures throw McpRawArchiveWriteError; the catch block below converts
      // that to a fail-closed REJECTED result (not a silent PASSED without evidence).
      // The model-facing result does NOT include rawFile/rawBytes/rawChecksum;
      // those are harness-internal evidence fields accessible via the canonical
      // event/evidence path (context.outputDir/mcp-raw.json).
      await persistMcpRawResult(context.outputDir, callToolResult);

      if ((callToolResult as { isError?: boolean }).isError) {
        return {
          tool: definition.name,
          status: ToolResultStatus.REJECTED,
          server: definition.server,
          operation,
          droppedArguments,
          normalizedPathArguments: normalizedArguments.normalizedPathArguments,
        };
      }

      return {
        tool: definition.name,
        status: ToolResultStatus.PASSED,
        server: definition.server,
        operation,
        droppedArguments,
        normalizedPathArguments: normalizedArguments.normalizedPathArguments,
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
    // zog2.12: fail-closed for authoritative archive write failures.
    // McpRawArchiveWriteError means persistMcpRawResult threw — the raw evidence
    // is not durably written, so the invocation cannot be PASSED. Return REJECTED
    // with write_failure classification so operators can triage the root cause.
    if (error instanceof McpRawArchiveWriteError) {
      Logger.warn(Component.PROJECT_TOOLS, 'MCP raw archive write failed (fail-closed: REJECTED)', {
        tool: definition.name,
        server: definition.server,
        operation,
        outputDir: error.outputDir,
        error: String(error.cause)
      });
      return {
        tool: definition.name,
        status: ToolResultStatus.REJECTED,
        server: definition.server,
        operation,
        archiveFailureCategory: error.archiveFailureCategory,
        failureCategory: error.archiveFailureCategory,
        message: `REJECTED: MCP raw archive persistence failed (${error.archiveFailureCategory}) — raw evidence not durably written. ${String(error.cause)}`,
      };
    }

    const message = String(error);
    if (definition.optional) return unavailable(definition.name, message);
    // cosx: persist a raw error envelope on transport/connection failures so
    // the complete error metadata is archived as harness-side evidence even when
    // client.callTool never ran. The model-facing result does NOT include
    // rawFile/rawBytes/rawChecksum; evidence is accessible via the canonical path.
    // zog2.12: error-envelope persistence is best-effort (the primary failure is
    // already the backend/transport error, not an archive write error).
    const errorEnvelope = {
      tool: definition.name,
      server: definition.server,
      operation,
      error: message,
      errorType: error instanceof Error ? error.constructor.name : typeof error,
      errorStack: error instanceof Error ? error.stack : undefined
    };
    await persistMcpRawResult(context.outputDir, errorEnvelope).catch((archiveError: unknown) => {
      Logger.warn(Component.PROJECT_TOOLS, 'Failed to persist raw MCP error envelope', {
        tool: definition.name,
        server: definition.server,
        outputDir: context.outputDir,
        error: String(archiveError)
      });
    });
    // zog2.12 review fix: classify transport/connect failures as backend_unavailable
    // so operators can distinguish backend connectivity issues from archive write errors,
    // semantic rejections (isError), or other failure categories.
    return {
      tool: definition.name,
      status: ToolResultStatus.REJECTED,
      server: definition.server,
      operation,
      failureCategory: 'backend_unavailable' as const,
      archiveFailureCategory: 'backend_unavailable' as const,
      message,
    };
  }
}
