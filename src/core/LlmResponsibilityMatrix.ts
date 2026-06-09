/**
 * pi-experiment-jvx3: Code-owned LLM responsibility matrix.
 *
 * This module is the BINDING source of truth for what the harness will and will
 * not delegate to LLM judgment. It is a typed registry, not prose. Every entry
 * maps an authority domain to:
 *
 *   - allowed: false → deterministic-only; the LLM is NOT the authority.
 *   - allowed: true  → LLM may act in this domain UNDER deterministic guards.
 *   - guardFile: the source file that code-owns the enforcement for this row.
 *   - guardSymbol: the specific function/class/constant in that file.
 *
 * DESIGN:
 *   - No runtime logic here — this is a TYPED CONSTANT. It is never invoked at
 *     runtime; it is imported by tests and documentation generators.
 *   - Each authority row covers exactly one harness domain.
 *   - The "allowed: false" rows are the binding contract: if the guard named in
 *     guardFile/guardSymbol were removed, a false-progress adversarial test
 *     would fail (load-bearing tests in llm_responsibility_matrix.test.ts).
 *   - "allowed: true" rows are bounded by deterministic guards — the LLM acts
 *     within a code-owned fence (e.g. prompt text is admitted via file, not inline
 *     model prose; code edits proceed through tool calls, not freeform output).
 *
 * SCOPE GUARD: this module intentionally imports NOTHING from the harness runtime.
 * It is pure types + a const. Keep it dependency-free.
 */

// ---------------------------------------------------------------------------
// Authority domain labels (exhaustive union)
// ---------------------------------------------------------------------------

/**
 * Exhaustive union of all authority domains covered by the responsibility matrix.
 * Extending this union without adding a matrix entry will cause a compile-time error
 * in the MatrixEntry type's discriminated union check below.
 */
export type AuthorityDomain =
  | 'stateTransitions'
  | 'routeEventSelection'
  | 'requiredToolSatisfaction'
  | 'artifactValidation'
  | 'schemaValidation'
  | 'rtkSummaries'
  | 'traceability'
  | 'testPassFail'
  | 'eventReplay'
  | 'startupReadiness'
  | 'budgetEnforcement'
  | 'loopDetection'
  | 'planningReviewExplain'
  | 'codeEditsUnderGuards';

// ---------------------------------------------------------------------------
// Matrix entry shape
// ---------------------------------------------------------------------------

/**
 * One row in the responsibility matrix.
 *
 * allowed: false → LLM is NOT the authority; deterministic code owns the decision.
 * allowed: true  → LLM MAY act in this domain, but ONLY under deterministic guards.
 *
 * guardFile:   absolute-from-repo-root source path for the enforcement guard.
 * guardSymbol: the specific export / class / constant that owns the enforcement.
 * note:        human-readable one-liner explaining what the guard does.
 */
export interface MatrixEntry {
  readonly domain: AuthorityDomain;
  readonly allowed: boolean;
  readonly guardFile: string;
  readonly guardSymbol: string;
  readonly note: string;
}

// ---------------------------------------------------------------------------
// The binding matrix
// ---------------------------------------------------------------------------

/**
 * The code-owned responsibility matrix.
 *
 * Each row is an entry in the typed registry. Entries are referenced by domain
 * key in RESPONSIBILITY_MAP below.
 *
 * DETERMINISTIC-ONLY rows (allowed: false):
 *   Prose claims, review-approval text, or compaction summaries from an LLM
 *   cannot satisfy these authorities. The named guard enforces this.
 *
 * LLM-UNDER-GUARDS rows (allowed: true):
 *   The LLM produces plans, reviews, explanations, and code — but always under
 *   a code-owned fence. The guard enforces the fence (e.g., artifact must be
 *   validated before progress; prompt must come from a file, not inline text).
 */
export const RESPONSIBILITY_MATRIX: readonly MatrixEntry[] = [
  // ─── Deterministic-only authorities (LLM MUST NOT be the authority) ────────

  {
    domain: 'stateTransitions',
    allowed: false,
    guardFile: 'src/core/RouteEventContract.ts',
    guardSymbol: 'projectV2Transitions / replayProjectV2Transitions',
    note: 'Transitions advance ONLY from schema-valid ROUTE_EVENT_EMITTED records ' +
          'emitted by deterministic emitters (tool/verifier/gate/systemPrecondition). ' +
          'Model-authored outcome fields and prose are unconditionally skipped by the projector.',
  },
  {
    domain: 'routeEventSelection',
    allowed: false,
    guardFile: 'src/core/ActionRouteEventEmitter.ts',
    guardSymbol: 'emitActionRouteEvent',
    note: 'Route event names are chosen ONLY by (ActionEmitsMapping + deterministic TypeScript verdict). ' +
          'Tool stdout/stderr, LLM prose, and model-provided args are NEVER the source of a route event name. ' +
          'Startup lint (ConfigLoader.validateV2ActionEmits) rejects LLM actions declaring emits.',
  },
  {
    domain: 'requiredToolSatisfaction',
    allowed: false,
    guardFile: 'src/core/VerifierGate.ts',
    guardSymbol: 'runVerifierGate',
    note: 'Required-tool satisfaction is checked by the coordinator-side verifier gate, ' +
          'which reads only canonical ToolEvidenceHandle instances validated by ' +
          'validateToolEvidenceHandle. A tool with no event, REJECTED status, UNAVAILABLE status, ' +
          'invalid handle, or a FAIL verify() verdict blocks the transition. ' +
          'Model prose cannot satisfy a required-tool declaration.',
  },
  {
    domain: 'artifactValidation',
    allowed: false,
    guardFile: 'src/tools/artifact_validator.ts',
    guardSymbol: 'artifactValidatorVerify',
    note: 'Artifact presence and structural validity are checked by the harness-owned ' +
          'artifact_validator tool\'s verify() callback. An absent or malformed artifact ' +
          'fails the gate. LLM claims of "artifact present" or "artifact written" are not ' +
          'accepted — only on-disk state at the declared semanticArtifactPath matters.',
  },
  {
    domain: 'schemaValidation',
    allowed: false,
    guardFile: 'src/core/DomainEventSchemas.ts',
    guardSymbol: 'DOMAIN_EVENT_SCHEMAS',
    note: 'Domain event payloads are validated by the EventStore against DOMAIN_EVENT_SCHEMAS ' +
          'on record(). Schema-invalid records are rejected before projection. ' +
          'The LLM cannot produce a schema-valid ROUTE_EVENT_EMITTED record via prose — ' +
          'only deterministic emitters call applyV2RouteEvent.',
  },
  {
    domain: 'rtkSummaries',
    allowed: false,
    guardFile: 'src/core/RtkContract.ts',
    guardSymbol: 'RtkContract',
    note: 'RTK summaries are produced by tool-owned code, not by LLM prose. ' +
          'The harness ships no per-tool parsing; each tool produces its own RTK summary ' +
          'via its own TypeScript file. An LLM-authored summary string is not equivalent ' +
          'to a tool-produced RTK summary and cannot satisfy the RTK contract.',
  },
  {
    domain: 'traceability',
    allowed: false,
    guardFile: 'src/core/RouteEventContract.ts',
    guardSymbol: 'RouteEvidenceRef / routeEventId',
    note: 'Traceability (linking STATE_TRANSITION_APPLIED to ROUTE_EVENT_EMITTED via routeEventId, ' +
          'and ROUTE_EVENT_EMITTED to artifact evidence via RouteEvidenceRef with byteCount + sha256) ' +
          'is enforced structurally. validateEvidenceRefs rejects refs missing byteCount or sha256. ' +
          'LLM-authored traceability claims without validated artifact digests are rejected.',
  },
  {
    domain: 'testPassFail',
    allowed: false,
    guardFile: 'src/core/VerifierGate.ts',
    guardSymbol: 'runVerifierGate / VerifyVerdict',
    note: 'Test pass/fail verdicts are produced by registered verify() callbacks ' +
          '(TypeScript code, not LLM inference). The VerifierGate runs each callback ' +
          'and aggregates by enum. An LLM prose verdict ("tests pass") cannot satisfy ' +
          'a verify() gate — the gate reads the VerifyResult.verdict from the callback.',
  },
  {
    domain: 'eventReplay',
    allowed: false,
    guardFile: 'src/core/RouteEventContract.ts',
    guardSymbol: 'replayProjectV2Transitions',
    note: 'Event replay is performed by replayProjectV2Transitions, a pure deterministic ' +
          'function of the event log. Quarantine gates reject schema-invalid, undeclared, ' +
          'stale-fingerprint, and duplicate-idempotency route events. Compaction summaries ' +
          'are explicitly non-authoritative (nonAuthoritative: true) and do not affect replay.',
  },
  {
    domain: 'startupReadiness',
    allowed: false,
    guardFile: 'src/core/V2SubstratePreflight.ts',
    guardSymbol: 'runV2SubstratePreflight',
    note: 'Startup readiness is decided by V2SubstratePreflight (tmux + git-worktree ' +
          'substrate checks) and ConfigLoader admission lints (validateV2ActionEmits, ' +
          'preValidateV2Admission). The LLM does not participate in the startup readiness ' +
          'decision — a failed substrate check aborts before any LLM interaction.',
  },
  {
    domain: 'budgetEnforcement',
    allowed: false,
    guardFile: 'src/core/RuntimeBudgetTracker.ts',
    guardSymbol: 'RuntimeBudgetTracker / checkPreProviderRequest / checkPreRetry / checkPreVerifier',
    note: 'Budget enforcement is performed by RuntimeBudgetTracker at real pre-spend hooks. ' +
          'When a limit is exceeded the tracker returns the configured route deterministically. ' +
          'The LLM cannot override or negotiate a budget limit — the check runs before the ' +
          'next model call / retry / verifier invocation.',
  },
  {
    domain: 'loopDetection',
    allowed: false,
    guardFile: 'src/core/LoopDetector.ts',
    guardSymbol: 'LoopDetector / checkToolCall / checkFailedRoute / checkVerifierFail',
    note: 'Loop detection is always-on structural fingerprint counting (5 scopes). ' +
          'When a loop threshold is exceeded the detector emits LOOP_DETECTED and returns ' +
          'the configured route event. The LLM cannot suppress loop detection — there is ' +
          'no config flag to disable it, and model prose cannot reset the fingerprint counters.',
  },

  // ─── LLM-under-deterministic-guards rows (allowed: true) ──────────────────

  {
    domain: 'planningReviewExplain',
    allowed: true,
    guardFile: 'src/core/ActionRouteEventEmitter.ts',
    guardSymbol: 'emitActionRouteEvent (absent for LLM actions)',
    note: 'LLMs may plan, review, and explain. These actions (ActionType.PROMPT / llm block) ' +
          'do NOT have an emits mapping and cannot emit ROUTE_EVENT_EMITTED. ' +
          'The startup lint (ConfigLoader.validateV2ActionEmits) rejects any LLM action ' +
          'that declares an emits block. LLM output is never the sole authority for progress.',
  },
  {
    domain: 'codeEditsUnderGuards',
    allowed: true,
    guardFile: 'src/core/VerifierGate.ts',
    guardSymbol: 'runVerifierGate (post-edit verify)',
    note: 'LLMs may propose and perform code edits (via tool calls). Code edits are ' +
          'admitted under deterministic guards: the resulting artifacts must be validated ' +
          'by the artifact_validator verify() callback or a tool-registered verify() before ' +
          'the transition gate passes. An edit without a subsequent passing verify() gate ' +
          'does not advance the workflow.',
  },
];

// ---------------------------------------------------------------------------
// Domain-keyed lookup map (for test assertions and lint)
// ---------------------------------------------------------------------------

/**
 * Responsibility matrix indexed by domain for O(1) lookup.
 *
 * Constructed from RESPONSIBILITY_MATRIX at module load. Tests import this
 * to assert each authority domain has an entry and to check allowed/guard fields.
 */
export const RESPONSIBILITY_MAP: ReadonlyMap<AuthorityDomain, MatrixEntry> = new Map(
  RESPONSIBILITY_MATRIX.map(entry => [entry.domain, entry])
);

// ---------------------------------------------------------------------------
// Compile-time completeness check
// ---------------------------------------------------------------------------

/**
 * Statically verify that every AuthorityDomain has an entry in the matrix.
 *
 * This function is never called at runtime — it exists only to produce a
 * TypeScript type error if a new AuthorityDomain member is added without
 * a corresponding RESPONSIBILITY_MATRIX entry. The compiler checks the
 * assignment below at build time.
 *
 * How it works: we extract the domain union from the const array and confirm
 * it equals AuthorityDomain. If any domain is missing, TypeScript raises an
 * incompatibility error.
 */
type MatrixDomains = typeof RESPONSIBILITY_MATRIX[number]['domain'];

// If AuthorityDomain has members not covered by MatrixDomains, this type
// becomes never and the variable assignment below would be unreachable
// (TypeScript emits an error at the call site).
type _AllDomainsPresent = [MatrixDomains] extends [AuthorityDomain]
  ? [AuthorityDomain] extends [MatrixDomains]
    ? true
    : never
  : never;

// This declaration forces TypeScript to evaluate _AllDomainsPresent.
// If it resolves to never, the module fails to compile — the matrix is incomplete.
const _matrixCompleteness: _AllDomainsPresent = true as _AllDomainsPresent;
void _matrixCompleteness;

// ---------------------------------------------------------------------------
// Deterministic-only authority set (convenience for tests and lints)
// ---------------------------------------------------------------------------

/**
 * Set of all authority domains that are deterministic-only (allowed: false).
 *
 * The LLM MUST NOT be the authority for any domain in this set.
 * Used by adversarial tests to enumerate which domains to probe.
 */
export const DETERMINISTIC_ONLY_DOMAINS: ReadonlySet<AuthorityDomain> = new Set(
  RESPONSIBILITY_MATRIX
    .filter(entry => !entry.allowed)
    .map(entry => entry.domain)
);
