/**
 * ToolOutputQuery — bounded, schema-shaped, progressive-disclosure query tool
 * for persisted tool outputs / evidence artifacts.
 *
 * Design goals (pi-experiment-6q0y.23):
 * - Models inspect tool outputs through event-derived identities and capped
 *   projections instead of reading arbitrary files or inlining large output.
 * - Identity is resolved from recorded domain events (latestToolResultEvent).
 *   Arbitrary filesystem paths are rejected (AC1).
 * - Default (summary) mode returns metadata, paths, size, hash, and available
 *   projection modes — no raw content (AC2).
 * - JSON selector and schema modes are available with deterministic caps below
 *   24 KB (AC3).
 * - Text-tail mode returns the last N characters of a file, capped (AC3).
 * - Raw archives remain complete on disk and are never truncated in storage (AC4).
 * - Fail-closed on bad input; missing artifacts return structured rejections (AC5).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { EventStore } from './EventStore.js';
import { asBeadId, asStateId, asActionId, asToolName } from '../types/ids.js';
import { isRecord } from './RecordUtils.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum JSON-serialized byte size for a JSON selector result (24 KB). */
export const JSON_SELECTOR_MAX_BYTES = 24_000;

/** Maximum character count returned by text-tail mode (24 KB in chars). */
export const TEXT_TAIL_MAX_CHARS = 24_000;

/** Default tail length in characters when not specified. */
export const TEXT_TAIL_DEFAULT_CHARS = 4_000;

/** Maximum recursion depth for schema extraction. */
export const TOOL_OUTPUT_SCHEMA_MAX_DEPTH = 6;

/** Maximum keys per object level in schema extraction. */
export const TOOL_OUTPUT_SCHEMA_MAX_KEYS = 20;

/** Maximum byte size for the serialized schema output (24 KB). */
export const TOOL_OUTPUT_SCHEMA_MAX_BYTES = 24_000;

// ─── Input / Output types ─────────────────────────────────────────────────────

export interface ToolOutputQueryInput {
  /**
   * Bead ID — used with stateId + actionId + toolName to look up the
   * latest tool result event in the event store. Required.
   */
  beadId: string;
  /**
   * State ID component of the event identity. Required.
   */
  stateId: string;
  /**
   * Action ID component of the event identity. Required.
   */
  actionId: string;
  /**
   * Tool name component of the event identity. Required.
   */
  toolName: string;
  /**
   * Dot-path selector for JSON output files.
   * Empty string or absent → root of the JSON (subject to JSON_SELECTOR_MAX_BYTES).
   * Mutually exclusive with schema and textTail.
   */
  selector?: string;
  /**
   * When true, return the recursive type-shape of the JSON artifact with values
   * dropped. Mutually exclusive with selector and textTail.
   */
  schema?: boolean;
  /**
   * Number of characters to return from the END of the file (text-tail mode).
   * Capped at TEXT_TAIL_MAX_CHARS. Mutually exclusive with selector and schema.
   */
  textTail?: number;
}

export interface ToolOutputQueryRejection {
  status: 'rejected';
  reason: string;
}

/** Summary metadata returned in default mode (no content). */
export interface ToolOutputSummary {
  status: 'summary';
  beadId: string;
  stateId: string;
  actionId: string;
  toolName: string;
  /** Absolute path to the raw output archive. */
  outputFile: string;
  /** Byte count of the output file. */
  byteCount: number;
  /** Hex SHA-256 of the output file contents. */
  sha256: string;
  /** Whether the file content parses as JSON. */
  isJson: boolean;
  /**
   * Available projection modes for the detail call.
   * 'json_selector' and 'schema' are available when isJson is true.
   * 'text_tail' is always available.
   */
  availableProjections: string[];
}

/** Result for JSON selector mode. */
export interface ToolOutputJsonResult {
  status: 'json';
  beadId: string;
  stateId: string;
  actionId: string;
  toolName: string;
  outputFile: string;
  selector: string;
  result: unknown;
  byteCount: number;
}

/** A schema node in the recursive type shape. */
export interface ToolOutputSchemaNode {
  type: 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array';
  length?: number;
  properties?: Record<string, ToolOutputSchemaNode>;
  items?: ToolOutputSchemaNode;
  truncated?: true;
}

/** Result for schema mode. */
export interface ToolOutputSchemaResult {
  status: 'schema';
  beadId: string;
  stateId: string;
  actionId: string;
  toolName: string;
  outputFile: string;
  shape: ToolOutputSchemaNode;
  bounds: { maxDepth: number; maxKeysPerLevel: number; maxBytes: number };
  truncated: boolean;
}

/** Result for text-tail mode. */
export interface ToolOutputTextTailResult {
  status: 'text_tail';
  beadId: string;
  stateId: string;
  actionId: string;
  toolName: string;
  outputFile: string;
  tail: string;
  requestedChars: number;
  returnedChars: number;
  totalBytes: number;
}

export type ToolOutputQueryResult =
  | ToolOutputSummary
  | ToolOutputJsonResult
  | ToolOutputSchemaResult
  | ToolOutputTextTailResult
  | ToolOutputQueryRejection;

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Blocked prototype-polluting keys (mirrors ArtifactQuery). */
const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Safe dot-path traversal — identical semantics to ArtifactQuery.safeSelectPath.
 * Returns undefined when the selector is invalid or a segment is missing.
 */
function safeSelectPath(root: unknown, selector: string): unknown {
  if (!selector.trim()) return root;
  const segments = selector.split('.');
  let current: unknown = root;
  for (const segment of segments) {
    if (!segment || BLOCKED_KEYS.has(segment)) return undefined;
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = parseInt(segment, 10);
      if (isNaN(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
    } else if (typeof current === 'object') {
      if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

/** Extract the recursive type-shape of a value, dropping actual values. */
function extractSchema(
  value: unknown,
  depth: number,
  maxDepth: number,
  maxKeys: number
): ToolOutputSchemaNode {
  if (value === null) return { type: 'null' };
  if (typeof value === 'string') return { type: 'string' };
  if (typeof value === 'number') return { type: 'number' };
  if (typeof value === 'boolean') return { type: 'boolean' };

  if (Array.isArray(value)) {
    const node: ToolOutputSchemaNode = { type: 'array', length: value.length };
    if (depth < maxDepth && value.length > 0) {
      node.items = extractSchema(value[0], depth + 1, maxDepth, maxKeys);
    }
    return node;
  }

  if (typeof value === 'object') {
    const node: ToolOutputSchemaNode = { type: 'object' };
    if (depth < maxDepth) {
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !BLOCKED_KEYS.has(k));
      const truncated = entries.length > maxKeys;
      const sliced = truncated ? entries.slice(0, maxKeys) : entries;
      const properties: Record<string, ToolOutputSchemaNode> = {};
      for (const [k, v] of sliced) {
        properties[k] = extractSchema(v, depth + 1, maxDepth, maxKeys);
      }
      node.properties = properties;
      if (truncated) node.truncated = true;
    } else {
      node.truncated = true;
    }
    return node;
  }

  return { type: 'string' };
}

/**
 * Resolve the outputFile path from a tool result event's data payload.
 * Handles both FLAT (PROJECT_TOOL_SUCCEEDED) and NESTED (TOOL_INVOCATION_SUCCEEDED)
 * event shapes.
 */
function outputFileFromEventData(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;

  // FLAT shape: outputFile at the top level
  if (typeof data['outputFile'] === 'string' && data['outputFile'].length > 0) {
    return data['outputFile'] as string;
  }

  // NESTED shape: toolResult.outputFile
  const toolResult = data['toolResult'];
  if (isRecord(toolResult) && typeof toolResult['outputFile'] === 'string' && toolResult['outputFile'].length > 0) {
    return toolResult['outputFile'] as string;
  }

  return undefined;
}

// ─── ToolOutputQuery class ────────────────────────────────────────────────────

export class ToolOutputQuery {
  constructor(private readonly eventStore: EventStore) {}

  public async query(input: ToolOutputQueryInput): Promise<ToolOutputQueryResult> {
    // ── Input validation ──────────────────────────────────────────────────────

    if (!input.beadId || !input.stateId || !input.actionId || !input.toolName) {
      return {
        status: 'rejected',
        reason: 'beadId, stateId, actionId, and toolName are all required to identify a tool output.'
      };
    }

    // Mutual exclusivity of selector / schema / textTail
    const modeCount = [
      input.selector !== undefined && input.selector !== '',
      input.schema === true,
      input.textTail !== undefined
    ].filter(Boolean).length;

    if (modeCount > 1) {
      return {
        status: 'rejected',
        reason: 'Provide at most one of: selector (dot-path JSON extraction), schema (recursive type shape), or textTail (text tail mode).'
      };
    }

    if (input.textTail !== undefined) {
      if (typeof input.textTail !== 'number' || input.textTail < 1 || !Number.isFinite(input.textTail)) {
        return {
          status: 'rejected',
          reason: `textTail must be a positive integer (got ${JSON.stringify(input.textTail)}).`
        };
      }
    }

    // ── Resolve outputFile from event store ───────────────────────────────────

    let event: import('./EventStoreTypes.js').DomainEvent | undefined;
    try {
      event = await this.eventStore.latestToolResultEvent(
        asBeadId(input.beadId),
        asStateId(input.stateId),
        asActionId(input.actionId),
        asToolName(input.toolName)
      );
    } catch {
      return {
        status: 'rejected',
        reason: 'Failed to read events from the event store. The store may not be initialized for this context.'
      };
    }

    if (!event) {
      return {
        status: 'rejected',
        reason: `No tool result event found for toolName="${input.toolName}" beadId="${input.beadId}" stateId="${input.stateId}" actionId="${input.actionId}". ` +
          'The tool may not have been invoked yet, or the identity fields may not match a recorded event.'
      };
    }

    const outputFile = outputFileFromEventData(event.data);
    if (!outputFile) {
      return {
        status: 'rejected',
        reason: `Tool result event found for toolName="${input.toolName}" but it carries no outputFile path. ` +
          'The tool may have failed without writing an artifact, or the event shape is unexpected.'
      };
    }

    // ── File existence check ──────────────────────────────────────────────────

    if (!fs.existsSync(outputFile)) {
      return {
        status: 'rejected',
        reason: `Tool output artifact does not exist on disk at "${outputFile}". ` +
          'The artifact may have been cleaned up or the path may be stale.'
      };
    }

    // ── Read file stats + hash ────────────────────────────────────────────────

    let rawContent: string;
    let byteCount: number;
    let sha256: string;
    try {
      const buf = fs.readFileSync(outputFile);
      rawContent = buf.toString('utf8');
      byteCount = buf.byteLength;
      sha256 = createHash('sha256').update(buf).digest('hex');
    } catch (error) {
      return {
        status: 'rejected',
        reason: `Failed to read tool output artifact at "${outputFile}": ${String(error)}`
      };
    }

    // Determine if content parses as JSON
    let parsed: unknown = undefined;
    let isJson = false;
    try {
      parsed = JSON.parse(rawContent);
      isJson = true;
    } catch {
      isJson = false;
    }

    const identity = {
      beadId: input.beadId,
      stateId: input.stateId,
      actionId: input.actionId,
      toolName: input.toolName,
      outputFile
    };

    // ── Mode dispatch ─────────────────────────────────────────────────────────

    // Text-tail mode
    if (input.textTail !== undefined) {
      const requestedChars = Math.min(input.textTail, TEXT_TAIL_MAX_CHARS);
      const tail = rawContent.slice(-requestedChars);
      return {
        status: 'text_tail',
        ...identity,
        tail,
        requestedChars,
        returnedChars: tail.length,
        totalBytes: byteCount
      };
    }

    // Schema mode
    if (input.schema === true) {
      if (!isJson) {
        return {
          status: 'rejected',
          reason: `Schema mode requires a JSON artifact, but the file at "${outputFile}" did not parse as JSON. Use textTail mode for non-JSON files.`
        };
      }

      const shape = extractSchema(parsed, 0, TOOL_OUTPUT_SCHEMA_MAX_DEPTH, TOOL_OUTPUT_SCHEMA_MAX_KEYS);
      const serialized = JSON.stringify(shape);
      const schemaBytes = Buffer.byteLength(serialized, 'utf8');
      let finalShape = shape;
      let truncated = false;

      if (schemaBytes > TOOL_OUTPUT_SCHEMA_MAX_BYTES) {
        const tightShape = extractSchema(parsed, 0, 2, TOOL_OUTPUT_SCHEMA_MAX_KEYS);
        finalShape = { ...tightShape, truncated: true };
        truncated = true;
      }

      return {
        status: 'schema',
        ...identity,
        shape: finalShape,
        bounds: {
          maxDepth: TOOL_OUTPUT_SCHEMA_MAX_DEPTH,
          maxKeysPerLevel: TOOL_OUTPUT_SCHEMA_MAX_KEYS,
          maxBytes: TOOL_OUTPUT_SCHEMA_MAX_BYTES
        },
        truncated
      };
    }

    // JSON selector mode (including empty selector = root)
    if (input.selector !== undefined) {
      if (!isJson) {
        return {
          status: 'rejected',
          reason: `JSON selector mode requires a JSON artifact, but the file at "${outputFile}" did not parse as JSON. Use textTail mode for non-JSON files.`
        };
      }

      const effectiveSelector = input.selector.trim();
      const value = safeSelectPath(parsed, effectiveSelector);

      if (value === undefined && effectiveSelector) {
        return {
          status: 'rejected',
          reason: `Selector "${effectiveSelector}" did not match any value in the tool output artifact for toolName="${input.toolName}".`
        };
      }

      const resultValue = value === undefined ? parsed : value;
      const resultSerialized = JSON.stringify(resultValue);
      const resultBytes = Buffer.byteLength(resultSerialized, 'utf8');

      if (resultBytes > JSON_SELECTOR_MAX_BYTES) {
        return {
          status: 'rejected',
          reason: `Selected value at selector "${effectiveSelector || '(root)'}" is ${resultBytes} bytes, which exceeds the ${JSON_SELECTOR_MAX_BYTES}-byte cap. ` +
            'Use a narrower selector or schema mode to navigate the artifact structure, then select a smaller subtree.'
        };
      }

      return {
        status: 'json',
        ...identity,
        selector: effectiveSelector,
        result: resultValue,
        byteCount: resultBytes
      };
    }

    // Default: summary mode
    const availableProjections = ['text_tail'];
    if (isJson) {
      availableProjections.unshift('json_selector', 'schema');
    }

    return {
      status: 'summary',
      ...identity,
      byteCount,
      sha256,
      isJson,
      availableProjections
    };
  }
}
