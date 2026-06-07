/**
 * COMPILE-TIME type tests for branded harness identity types (pi-experiment-dsm2.13).
 *
 * This file is checked by `tsc --noEmit` (it lives under src/, which the build
 * compiles). Each `// @ts-expect-error` line asserts that a forbidden cross-brand
 * assignment is a COMPILE ERROR. If the brands were ever removed (e.g. types
 * collapsed back to `string`), the `@ts-expect-error` directives would become
 * unused-directive errors and `tsc` would fail — flagging the regression.
 *
 * There is no runtime behaviour here; these are pure type assertions.
 */

import type { BeadId, StateId, ActionId, WorkerId, SessionId, RunId, ToolName, ToolInvocationId, ArtifactId, SchemaId, EventId } from '../types/ids.js';
import { asBeadId, asStateId, asActionId, asWorkerId, asSessionId, asRunId, asToolName, asToolInvocationId, asArtifactId, asSchemaId, asEventId } from '../types/ids.js';

// ---------------------------------------------------------------------------
// AC: Each branded type is DISTINCT (not assignable to a different brand).
// ---------------------------------------------------------------------------

declare const beadId: BeadId;
declare const stateId: StateId;
declare const actionId: ActionId;
declare const workerId: WorkerId;
declare const sessionId: SessionId;
declare const runId: RunId;
declare const toolName: ToolName;
declare const toolInvocationId: ToolInvocationId;
declare const artifactId: ArtifactId;
declare const schemaId: SchemaId;
declare const eventId: EventId;

// A well-typed assignment to itself compiles.
export const okBeadId: BeadId = beadId;
export const okStateId: StateId = stateId;
export const okActionId: ActionId = actionId;

// ── Cross-brand swaps are COMPILE ERRORS ────────────────────────────────────

// A StateId cannot be assigned where a BeadId is expected.
// @ts-expect-error — StateId must NOT be assignable to BeadId.
export const stateAsBeadId: BeadId = stateId;

// A BeadId cannot be assigned where a StateId is expected.
// @ts-expect-error — BeadId must NOT be assignable to StateId.
export const beadAsStateId: StateId = beadId;

// An ActionId cannot be assigned where a WorkerId is expected.
// @ts-expect-error — ActionId must NOT be assignable to WorkerId.
export const actionAsWorkerId: WorkerId = actionId;

// A WorkerId cannot be assigned where a SessionId is expected.
// @ts-expect-error — WorkerId must NOT be assignable to SessionId.
export const workerAsSessionId: SessionId = workerId;

// A ToolName cannot be assigned where a ToolInvocationId is expected.
// @ts-expect-error — ToolName must NOT be assignable to ToolInvocationId.
export const toolNameAsInvocationId: ToolInvocationId = toolName;

// A RunId cannot be assigned where an EventId is expected.
// @ts-expect-error — RunId must NOT be assignable to EventId.
export const runAsEventId: EventId = runId;

// A raw string is NOT assignable to any branded type.
declare const rawString: string;
// @ts-expect-error — raw string must NOT be assignable to BeadId.
export const rawAsBeadId: BeadId = rawString;
// @ts-expect-error — raw string must NOT be assignable to StateId.
export const rawAsStateId: StateId = rawString;
// @ts-expect-error — raw string must NOT be assignable to ActionId.
export const rawAsActionId: ActionId = rawString;
// @ts-expect-error — raw string must NOT be assignable to WorkerId.
export const rawAsWorkerId: WorkerId = rawString;

// ── Cast helpers produce the correct branded type ───────────────────────────

export const okCastBeadId: BeadId = asBeadId('bd-123');
export const okCastStateId: StateId = asStateId('Implementing');
export const okCastActionId: ActionId = asActionId('my-action');
export const okCastWorkerId: WorkerId = asWorkerId('worker-42');
export const okCastSessionId: SessionId = asSessionId('sess-abc');
export const okCastRunId: RunId = asRunId('run-xyz');
export const okCastToolName: ToolName = asToolName('git_history');
export const okCastToolInvocationId: ToolInvocationId = asToolInvocationId('inv-001');
export const okCastArtifactId: ArtifactId = asArtifactId('implementation_plan');
export const okCastSchemaId: SchemaId = asSchemaId('STATUS_MUTATING_EVENT_v1');
export const okCastEventId: EventId = asEventId('event-uuid');

// ── Boundary interface: VerifierGateContext rejects wrong brands ─────────────

import type { VerifierGateContext } from './VerifierGate.js';

// A well-formed VerifierGateContext compiles.
export const okCtx: VerifierGateContext = {
  beadId: asBeadId('bd-1'),
  stateId: asStateId('Implementing'),
  actionId: asActionId('code'),
  writeSet: [],
  artifacts: {}
};

// Passing a raw string for beadId is rejected.
export const ctxRawBeadId: VerifierGateContext = {
  // @ts-expect-error — VerifierGateContext.beadId requires BeadId, not raw string.
  beadId: 'bd-raw',
  stateId: asStateId('Implementing'),
  actionId: asActionId('code'),
  writeSet: [],
  artifacts: {}
};

// Passing a StateId where ActionId is expected is rejected.
export const ctxStateAsAction: VerifierGateContext = {
  beadId: asBeadId('bd-1'),
  stateId: asStateId('Implementing'),
  // @ts-expect-error — VerifierGateContext.actionId requires ActionId, not StateId.
  actionId: stateId,
  writeSet: [],
  artifacts: {}
};

// ── Boundary interface: TeammateEventBase rejects wrong brands ───────────────

import type { TeammateEventBase } from './TeammateEvents.js';

// A well-formed base event compiles (no idempotencyKey, sessionStateId required here).
export const okTeammateBase: Pick<TeammateEventBase, 'workerId' | 'stateId'> = {
  workerId: asWorkerId('worker-1'),
  stateId: asStateId('Planning')
};

// A raw string for workerId is rejected.
export const baseRawWorkerId: Pick<TeammateEventBase, 'workerId' | 'stateId'> = {
  // @ts-expect-error — TeammateEventBase.workerId requires WorkerId, not raw string.
  workerId: 'worker-raw',
  stateId: asStateId('Planning')
};

// A BeadId used as WorkerId is rejected.
export const baseBeadAsWorker: Pick<TeammateEventBase, 'workerId' | 'stateId'> = {
  // @ts-expect-error — TeammateEventBase.workerId requires WorkerId, not BeadId.
  workerId: beadId,
  stateId: asStateId('Planning')
};
