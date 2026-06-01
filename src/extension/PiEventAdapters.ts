/**
 * Pi event payload parsing utilities.
 *
 * Typed parsing of Pi event payloads (TURN/AGENT lifecycle, TOOL events)
 * into typed shapes. No process.env reads — all values are parameters.
 */

import { WorkerDefaults, ToolResultStatus } from '../constants/index.js';

// ── shared ───────────────────────────────────────────────────────────────────

export function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// ── event summarization ──────────────────────────────────────────────────────

const EVENT_DETAIL_KEYS = new Set([
  'artifact',
  'artifactContents',
  'content',
  'details',
  'diagnostic',
  'documents',
  'evidence',
  'handover',
  'output',
  'outputPreview',
  'params',
  'result',
  'resultPreview',
  'stderr',
  'stdout',
  'text'
]);

function truncateEventText(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function summarizeEventString(value: string, key?: string): string {
  const limit = key && EVENT_DETAIL_KEYS.has(key)
    ? WorkerDefaults.EVENT_DETAIL_PREVIEW_CHARS
    : WorkerDefaults.EVENT_PREVIEW_CHARS;
  return truncateEventText(value, limit);
}

function summarizeEventValue(value: unknown, depth: number, seen: WeakSet<object>, key?: string): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value === 'string') return summarizeEventString(value, key);
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  if (depth >= 5) return '[MaxDepth]';

  seen.add(value);
  if (Array.isArray(value)) {
    const limit = WorkerDefaults.EVENT_ARRAY_PREVIEW_ITEMS;
    const items = value.slice(0, limit).map(item => summarizeEventValue(item, depth + 1, seen, key));
    return value.length > limit
      ? [...items, { omittedItems: value.length - limit }]
      : items;
  }

  const output: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [entryKey, entryValue] of entries.slice(0, WorkerDefaults.EVENT_OBJECT_PREVIEW_KEYS)) {
    output[entryKey] = summarizeEventValue(entryValue, depth + 1, seen, entryKey);
  }
  if (entries.length > WorkerDefaults.EVENT_OBJECT_PREVIEW_KEYS) {
    output.omittedKeys = entries.length - WorkerDefaults.EVENT_OBJECT_PREVIEW_KEYS;
  }
  return output;
}

export function summarizeForEvent(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    return summarizeEventString(value);
  }
  try {
    const json = JSON.stringify(value);
    if (json.length <= WorkerDefaults.EVENT_PREVIEW_CHARS) return value;
    const summarized = summarizeEventValue(value, 0, new WeakSet<object>());
    const summarizedJson = JSON.stringify(summarized);
    return summarizedJson.length > WorkerDefaults.EVENT_PREVIEW_CHARS * 3
      ? {
        preview: `${summarizedJson.slice(0, WorkerDefaults.EVENT_PREVIEW_CHARS)}...`,
        truncated: true,
        bytes: json.length,
        summarizedBytes: summarizedJson.length
      }
      : summarized;
  } catch {
    return String(value);
  }
}

// ── span / tool utilities ────────────────────────────────────────────────────

export function stringifySpanAttribute(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ── result classification ─────────────────────────────────────────────────────

export function textIndicatesFailure(text: string): boolean {
  return text.startsWith('Error') || text.startsWith('Failed') || text.startsWith('REJECTED');
}

export function contentIndicatesFailure(content: unknown): boolean {
  if (typeof content === 'string') return textIndicatesFailure(content.trim());
  if (!Array.isArray(content)) return false;
  return content.some(item => isRecord(item) && typeof item.text === 'string' && textIndicatesFailure(item.text.trim()));
}

export function nestedResultIndicatesFailure(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.isError === true || value.success === false) return true;
  if (value.status === ToolResultStatus.REJECTED || value.status === ToolResultStatus.UNAVAILABLE) return true;
  if (typeof value.error === 'string' && value.error.length > 0) return true;
  if (contentIndicatesFailure(value.content)) return true;
  return nestedResultIndicatesFailure(value.details) || nestedResultIndicatesFailure(value.mcpResult);
}

export function resultIndicatesFailure(result: unknown): boolean {
  if (typeof result === 'string') return textIndicatesFailure(result);
  if (!isRecord(result)) return false;
  return nestedResultIndicatesFailure(result);
}

export function resultIndicatesSuccess(result: unknown): boolean {
  if (!isRecord(result)) return false;
  return result.success === true || result.status === ToolResultStatus.PASSED;
}

export function externalPiToolEventIndicatesFailure(event: any): boolean {
  return event.isError === true || nestedResultIndicatesFailure(event.details) || contentIndicatesFailure(event.content);
}

export function externalPiToolResultFromEvent(event: any): Record<string, unknown> {
  const failed = externalPiToolEventIndicatesFailure(event);
  return {
    tool: event.toolName,
    status: failed ? ToolResultStatus.REJECTED : ToolResultStatus.PASSED,
    isError: failed,
    content: summarizeForEvent(event.content),
    details: summarizeForEvent(event.details)
  };
}

// ── agent lifecycle error extraction ─────────────────────────────────────────

function normalizeStopReason(value: unknown): string | null {
  return typeof value === 'string' ? value.toLowerCase() : null;
}

function agentMessageError(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const stopReason = normalizeStopReason(value.stopReason || value.stop_reason);
  const errorMessage = typeof value.errorMessage === 'string'
    ? value.errorMessage
    : typeof value.error_message === 'string'
      ? value.error_message
      : typeof value.error === 'string'
        ? value.error
        : null;
  if (stopReason === 'error' || errorMessage) {
    return errorMessage || `Agent turn ended with stop reason: ${stopReason}`;
  }
  return null;
}

export function agentEventError(event: any): string | null {
  const direct = typeof event?.error === 'string'
    ? event.error
    : isRecord(event?.error) && typeof event.error.errorMessage === 'string'
      ? event.error.errorMessage
      : null;
  if (direct) return direct;

  const candidates = [
    event?.message,
    ...(Array.isArray(event?.messages) ? event.messages : [])
  ];
  for (const candidate of candidates) {
    const messageError = agentMessageError(candidate);
    if (messageError) return messageError;
  }
  return null;
}

// ── event tool call ID ────────────────────────────────────────────────────────

export function eventToolCallId(event: any): string | undefined {
  return typeof event.toolCallId === 'string' ? event.toolCallId : undefined;
}
