/**
 * ToolOutputRetentionPolicy — pure decision logic for the .pi/tool-output area.
 *
 * All exports are pure functions: no filesystem I/O, no Logger singleton,
 * no EventStore, no process globals. Fake-FS testable.
 *
 * pi-experiment-amq0.17: extracted from RetentionCleanup.
 */

import { ProjectToolDefaults } from '../../constants/index.js';

/**
 * Sanitize a state/action identifier into the on-disk path segment produced by
 * ToolCallPathFactory, so the live-bead current-transition carve-out matches the
 * directory names actually written under .pi/tool-output/{bead}/{state}/{action}.
 */
export function toolOutputSegment(value: string | undefined, fallback: string): string {
  const sanitized = (value || fallback)
    .replace(ProjectToolDefaults.UNSAFE_PATH_SEGMENT_PATTERN, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized && sanitized !== '.' && sanitized !== '..' ? sanitized : fallback;
}

/**
 * Resolve the exempt state/action path segments for the gate-before-reclaim carve-out.
 *
 * Returns null when currentState is undefined — the caller must preserve the
 * entire live bead dir when the current transition cannot be determined.
 */
export function resolveExemptSegments(
  currentState: string | undefined,
  currentActionId: string | undefined
): { exemptState: string; exemptAction: string } | null {
  if (!currentState) return null;
  return {
    exemptState: toolOutputSegment(currentState, ProjectToolDefaults.UNSPECIFIED_STATE_ID),
    exemptAction: toolOutputSegment(currentActionId, ProjectToolDefaults.UNSPECIFIED_ACTION_ID)
  };
}

/**
 * Whether a state/action directory pair is the exempt current-transition subtree.
 * Returns false (never exempt) when exemptSegments is null (unknown current transition).
 */
export function isExemptCurrentTransition(
  stateDirName: string,
  actionDirName: string,
  exemptSegments: { exemptState: string; exemptAction: string } | null
): boolean {
  if (!exemptSegments) return false;
  return stateDirName === exemptSegments.exemptState && actionDirName === exemptSegments.exemptAction;
}

/**
 * Whether an entry's age (nowMs - mtimeMs) meets or exceeds the max age threshold.
 */
export function hasExceededAge(mtimeMs: number, nowMs: number, maxAgeMs: number): boolean {
  return nowMs - mtimeMs >= maxAgeMs;
}
