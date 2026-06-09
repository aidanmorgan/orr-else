/**
 * pi-experiment-t0xf: Gated compact coordination capsule for repeated backpressure collisions.
 *
 * Emitted ONLY when a (bead/state/action/tool) backpressure collision count exceeds the
 * threshold, replacing the verbose repeated backpressure text with a fixed small payload
 * (<=80 estimated tokens) that contains only coordination facts.
 *
 * Pure module — no external package imports; importable in tests without node_modules.
 */

import { ToolResultStatus } from '../../constants/domain.js';
import { ProjectToolFailureCategory } from './failureCategory.js';

/**
 * Collision count at which the compact capsule is emitted instead of the verbose text.
 * First collision (count = 1) always gets the verbose result so the agent sees the full
 * backpressure explanation once.  Second+ collision (count >= THRESHOLD) gets the capsule.
 */
export const CAPSULE_COLLISION_THRESHOLD = 2;

/**
 * Coordination capsule payload — contains only the facts needed to prevent repeated work.
 * No transcript text, no raw tool output, no recovery prose.
 *
 * Note: the tool name is NOT duplicated here; it is carried by the enclosing result's
 * top-level `tool` field.  This keeps the on-wire size within the 80-token budget.
 */
export interface BackpressureCapsulePayload {
  /** Always 'high': the capsule is emitted only under high collision pressure. */
  pressure: 'high';
  /** Active bead identifier. */
  bead: string;
  /** Active state identifier. */
  state: string;
  /** Active action identifier. */
  action: string;
  /** How long (ms) the in-flight call has been running. */
  ageMs: number;
}

/** Compact capsule result shape emitted on threshold-crossing collisions. */
export interface BackpressureCapsuleResult extends Record<string, unknown> {
  tool: string;
  status: typeof ToolResultStatus.REJECTED;
  failureCategory: typeof ProjectToolFailureCategory.BACKPRESSURE;
  capsule: BackpressureCapsulePayload;
}

/**
 * Returns true when the collision count has reached the threshold at which the compact
 * capsule should replace the verbose backpressure text.
 *
 * AC1: Returns false for counts below the threshold — zero overhead when idle.
 */
export function shouldEmitCapsule(collisionCount: number): boolean {
  return collisionCount >= CAPSULE_COLLISION_THRESHOLD;
}

/**
 * Build the compact coordination capsule.
 * The capsule contains ONLY coordination facts (pressure bucket, bead/state/action,
 * age) — no transcript text, no raw output, no recovery prose.
 *
 * On-wire budget (bytes / 4 = estimated tokens):
 *   Fixed JSON skeleton (keys + static values): ~137 bytes = 35 tokens
 *   4 id fields (tool, bead, state, action) each capped at MAX_ID_LEN chars:
 *     4 * 32 = 128 bytes = 32 tokens
 *   Total worst-case: ceil((137 + 128) / 4) = ceil(265 / 4) = 67 tokens  <=80 ✓
 *
 * `activeTool` is NOT stored in the capsule payload — it duplicates `tool` at the
 * top level of the result envelope; consumers read `result.tool` instead.
 */
export function buildBackpressureCapsule(
  toolName: string,
  beadId: string,
  stateId: string,
  actionId: string,
  ageMs: number
): BackpressureCapsuleResult {
  // MAX_ID_LEN=32: skeleton(137 bytes) + 4 fields * 32 bytes = 265 bytes => 67 est. tokens (<=80)
  const MAX_ID_LEN = 32;
  return {
    tool: toolName.slice(0, MAX_ID_LEN),
    status: ToolResultStatus.REJECTED,
    failureCategory: ProjectToolFailureCategory.BACKPRESSURE,
    capsule: {
      pressure: 'high',
      bead: beadId.slice(0, MAX_ID_LEN),
      state: stateId.slice(0, MAX_ID_LEN),
      action: actionId.slice(0, MAX_ID_LEN),
      ageMs
    }
  };
}
