/**
 * ProjectToolFailureCategory — exported public type + classification logic.
 * Package-internal types live here; the facade re-exports them for callers.
 */
import { ToolResultStatus } from '../../constants/index.js';
import {
  TRANSIENT_PROJECT_TOOL_FAILURE_PATTERN,
  TOOL_INPUT_PROJECT_TOOL_FAILURE_PATTERN,
  WORKTREE_STATE_PROJECT_TOOL_FAILURE_PATTERN,
  ProjectToolResultKey
} from './constants.js';
import { isJsonRecord, resultRecord, searchableFailureText } from './utils.js';
import type { ProjectToolConfig } from '../../core/domain/StateModels.js';

export const ProjectToolFailureCategory = {
  BACKPRESSURE: 'backpressure',
  TERMINAL_GATE: 'terminal_gate',
  TRANSIENT_TRANSPORT: 'transient_transport',
  TOOL_INPUT_ERROR: 'tool_input_error',
  UNAVAILABLE: 'unavailable',
  VERIFIER_FAILED: 'verifier_failed',
  WORKTREE_STATE_ERROR: 'worktree_state_error'
} as const;
export type ProjectToolFailureCategory =
  (typeof ProjectToolFailureCategory)[keyof typeof ProjectToolFailureCategory];

function statusFromToolResult(result: unknown): string | undefined {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined;
  const status = (result as { status?: unknown }).status;
  return typeof status === 'string' ? status : undefined;
}

export function classifyProjectToolFailure(
  definition: Pick<ProjectToolConfig, 'name'> | undefined,
  result: unknown
): ProjectToolFailureCategory | undefined {
  const record = resultRecord(result);
  const status = statusFromToolResult(record);
  if (status === ToolResultStatus.PASSED) return undefined;
  if (record[ProjectToolResultKey.FAILURE_CATEGORY]) {
    return record[ProjectToolResultKey.FAILURE_CATEGORY] as ProjectToolFailureCategory;
  }
  if (record.failureLimit) return ProjectToolFailureCategory.TERMINAL_GATE;
  if (status === ToolResultStatus.UNAVAILABLE) return ProjectToolFailureCategory.UNAVAILABLE;

  const text = searchableFailureText({ tool: definition?.name, ...record });
  if (TRANSIENT_PROJECT_TOOL_FAILURE_PATTERN.test(text)) return ProjectToolFailureCategory.TRANSIENT_TRANSPORT;
  if (TOOL_INPUT_PROJECT_TOOL_FAILURE_PATTERN.test(text)) return ProjectToolFailureCategory.TOOL_INPUT_ERROR;
  if (WORKTREE_STATE_PROJECT_TOOL_FAILURE_PATTERN.test(text)) return ProjectToolFailureCategory.WORKTREE_STATE_ERROR;
  if (status === ToolResultStatus.REJECTED) return ProjectToolFailureCategory.VERIFIER_FAILED;
  return undefined;
}

export function isInfrastructureProjectToolFailure(value: unknown): boolean {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return /\bENOSPC\b|No space left on device|os error 28/i.test(text);
}
