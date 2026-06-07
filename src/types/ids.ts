/**
 * Leaf module for branded primitive ID types (pi-experiment-dsm2.13).
 *
 * Brands are NOMINAL: `string` is not assignable to a branded type, preventing
 * accidental cross-kind swaps (e.g. passing a StateId where a BeadId is expected).
 * Brands erase at runtime — there is zero overhead and no runtime wrappers.
 *
 * Usage pattern at trust boundaries (where raw strings enter):
 *   Use the asXxx() helpers (e.g. asBeadId, asStateId) exported from this module.
 *   const beadId = asBeadId(env.env(EnvVars.BEAD_ID)); // validated + branded once
 *
 * This module has no imports from within this project, making it safe to import
 * from any layer including core domain modules.
 */

/** Helper: nominal branding via unique-symbol intersection. */
type Brand<T, K extends symbol> = T & { readonly __brand: K };

// ── Unique brand symbols ────────────────────────────────────────────────────
declare const _beadId: unique symbol;
declare const _stateId: unique symbol;
declare const _actionId: unique symbol;
declare const _workerId: unique symbol;
declare const _sessionId: unique symbol;
declare const _runId: unique symbol;
declare const _toolName: unique symbol;
declare const _toolInvocationId: unique symbol;
declare const _artifactId: unique symbol;
declare const _schemaId: unique symbol;
declare const _eventId: unique symbol;

// ── Branded identity types ──────────────────────────────────────────────────

/** Identifies a bead (task unit) across all harness APIs. */
export type BeadId = Brand<string, typeof _beadId>;

/** Identifies a statechart state (e.g. 'Implementing', 'Planning'). */
export type StateId = Brand<string, typeof _stateId>;

/** Identifies a discrete action within a state run. */
export type ActionId = Brand<string, typeof _actionId>;

/** Identifies a worker process (teammate session). */
export type WorkerId = Brand<string, typeof _workerId>;

/** Identifies a harness session (maps to observability session ID). */
export type SessionId = Brand<string, typeof _sessionId>;

/** Identifies a state-run invocation (uuidv7 generated per run). */
export type RunId = Brand<string, typeof _runId>;

/** The registered name of a tool (matches the key in the verifier registry). */
export type ToolName = Brand<string, typeof _toolName>;

/** Identifies one tool invocation instance (uuidv7 per invocation). */
export type ToolInvocationId = Brand<string, typeof _toolInvocationId>;

/** Identifies a declared artifact (e.g. 'implementation_plan', 'review'). */
export type ArtifactId = Brand<string, typeof _artifactId>;

/** Identifies a domain-event schema (e.g. HandoffSchemaId members). */
export type SchemaId = Brand<string, typeof _schemaId>;

/** Identifies a persisted domain event (uuidv7 per event). */
export type EventId = Brand<string, typeof _eventId>;

// ── Cast helpers (trust-boundary parsers) ───────────────────────────────────
// Use these at the points where raw strings enter from config, env vars, or
// event payloads. They validate non-emptiness and brand the value once.

function brandNonEmpty<T extends string>(value: string | undefined, kind: string): T {
  if (!value || typeof value !== 'string') throw new Error(`${kind}: expected non-empty string, got ${JSON.stringify(value)}`);
  return value as T;
}

/** Brand a raw string as a BeadId at a trust boundary. */
export function asBeadId(value: string): BeadId { return value as BeadId; }

/** Brand a raw string as a StateId at a trust boundary. */
export function asStateId(value: string): StateId { return value as StateId; }

/** Brand a raw string as an ActionId at a trust boundary. */
export function asActionId(value: string): ActionId { return value as ActionId; }

/** Brand a raw string as a WorkerId at a trust boundary. */
export function asWorkerId(value: string): WorkerId { return value as WorkerId; }

/** Brand a raw string as a SessionId at a trust boundary. */
export function asSessionId(value: string): SessionId { return value as SessionId; }

/** Brand a raw string as a RunId at a trust boundary. */
export function asRunId(value: string): RunId { return value as RunId; }

/** Brand a raw string as a ToolName at a trust boundary. */
export function asToolName(value: string): ToolName { return value as ToolName; }

/** Brand a raw string as a ToolInvocationId at a trust boundary. */
export function asToolInvocationId(value: string): ToolInvocationId { return value as ToolInvocationId; }

/** Brand a raw string as an ArtifactId at a trust boundary. */
export function asArtifactId(value: string): ArtifactId { return value as ArtifactId; }

/** Brand a raw string as a SchemaId at a trust boundary. */
export function asSchemaId(value: string): SchemaId { return value as SchemaId; }

/** Brand a raw string as an EventId at a trust boundary. */
export function asEventId(value: string): EventId { return value as EventId; }

/**
 * Validated cast: brands a non-empty string as BeadId, throwing for empty/undefined.
 * Use at external ingestion points (env vars, HTTP payloads) where absence is invalid.
 */
export function requireBeadId(value: string | undefined): BeadId {
  return brandNonEmpty<BeadId>(value, 'BeadId');
}

/**
 * Validated cast: brands a non-empty string as SessionId, throwing for empty/undefined.
 */
export function requireSessionId(value: string | undefined): SessionId {
  return brandNonEmpty<SessionId>(value, 'SessionId');
}
