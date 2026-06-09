/**
 * RawToolResultStore — raw plugin-tool result persistence (s3wp.26).
 *
 * pi-experiment-amq0.1: extracted from extension.ts.
 *
 * Every plugin tool wrapped by wrapPluginTool must have its complete raw
 * execute() return value written to harness-managed storage BEFORE compaction.
 * This is the generic archival invariant from docs/raw-output-contract.md.
 *
 * The call dir follows the same CALL_DIR_TEMPLATE as projectTools (command/MCP)
 * so all tool-call archives live in a single consistent tree.  Errors here are
 * swallowed — a persistence failure must never prevent the model from receiving
 * its result.
 *
 * 0yt5.27: the plugin path now persists its raw result to the SAME single
 * PROJECT-scoped tool-output location used by command/MCP tools — via the shared
 * ToolCallPathFactory — and returns the typed ToolResultBase so wrapPluginTool can
 * record outputFile/status in the tool-result event (no throwaway id, no
 * double-persist across .pi/tool-output AND .tmp/tool-calls).
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { ToolResultBase } from '../contract.js';
import type { ToolCallPathFactory } from '../core/ToolCallPathFactory.js';
import { Logger } from '../core/Logger.js';
import { Component } from '../constants/index.js';
import { PLUGIN_RAW_FILE_NAME } from '../plugins/projectTools/constants.js';

/**
 * Injected ports for RawToolResultStore.
 */
export interface RawToolResultStorePorts {
  toolCallPathFactory: ToolCallPathFactory;
}

/**
 * Persist a plugin tool's raw result to the single PROJECT-scoped tool-output
 * location (0yt5.27) and return a typed ToolResultBase.
 *
 * Errors are swallowed — a persistence failure must never block the model result.
 */
export async function persistPluginToolRawResult(
  ports: RawToolResultStorePorts,
  toolName: string,
  beadId: string | undefined,
  stateId: string | undefined,
  actionId: string | undefined,
  projectRoot: string,
  payload: unknown,
  status: ToolResultBase['status'],
  failureCategory?: ToolResultBase['failureCategory'],
  toolInvocationId?: string
): Promise<ToolResultBase> {
  const invocationId = toolInvocationId ?? uuidv7();
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    serialized = JSON.stringify({ serializationError: 'payload could not be JSON-serialized', toolName });
  }
  const rawBytes = Buffer.byteLength(serialized, 'utf8');

  // Allocate the single canonical per-invocation path under
  // {PROJECT_ROOT}/.pi/tool-output/{bead}/{state}/{action}/{tool}/{invocationId}.
  // The raw file lives in the allocation's output dir as plugin-raw.json so the
  // coordinator gate can locate it deterministically.
  const allocation = ports.toolCallPathFactory.allocate({
    beadId,
    stateId,
    actionId,
    toolName,
    toolInvocationId: invocationId,
    projectRoot,
    // Tool-output is PROJECT-scoped; worktreePath is unused by the factory's
    // path math but TemplateContext requires it.
    worktreePath: projectRoot
  });
  const rawFile = path.join(allocation.outputDir, PLUGIN_RAW_FILE_NAME);

  try {
    await fs.promises.mkdir(allocation.outputDir, { recursive: true });
    await fs.promises.writeFile(rawFile, serialized);
    const rawChecksum = createHash('sha256').update(serialized).digest('hex').slice(0, 16);
    Logger.debug(Component.PROJECT_TOOLS, 'Persisted plugin tool raw result', {
      tool: toolName, toolInvocationId: invocationId, rawFile, rawBytes, rawChecksum
    });
  } catch (error) {
    Logger.warn(Component.PROJECT_TOOLS, 'Failed to persist plugin tool raw result', {
      tool: toolName, toolInvocationId: invocationId, error: String(error)
    });
  }

  return { tool: toolName, status, outputFile: rawFile, outputFileBytes: rawBytes, ...(failureCategory ? { failureCategory } : {}) };
}
