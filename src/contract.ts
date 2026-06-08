/**
 * orr-else/contract — the canonical, harness-OWNED tool + verify contract.
 *
 * This is the single source of truth for the tool-result base shape, the
 * verify() callback contract, and the two module-level registries
 * (`verifier`, `skeletons`) that consuming-project extensions register into.
 *
 * Design constraints (binding, see pi-experiment-0yt5.15):
 *  - PURE TYPES + a THIN register API only. This module must NOT import any
 *    heavy harness module (EventStore, ConfigLoader, plugins, winston Logger,
 *    …). Keeping the import graph lean lets tools depend on the TYPES and the
 *    pi extension depend on the runtime register API without dragging in the
 *    whole harness. A lean-import test asserts this.
 *  - The harness imports NO consumer code; consumers import FROM here.
 *  - The registries are module-level singletons created on FIRST IMPORT of
 *    this module, independent of extension load order.
 */

// ---------------------------------------------------------------------------
// (1) ToolResultBase — the thin "did the tool RUN" base shape.
//
// EXACTLY these 5 fields. `status` reports whether the tool RAN to completion
// (PASSED) or could not run (REJECTED) — it is NOT a semantic verdict. The
// semantic judgement lives in VerifyResult.verdict, produced by a registered
// verify() callback, never here.
// ---------------------------------------------------------------------------

/**
 * Did the tool RUN? Not a semantic verdict.
 *
 *   PASSED      — the tool ran to completion; its raw output is durable.
 *   REJECTED    — the tool could not complete (transport, timeout, input, infra).
 *   UNAVAILABLE — the tool binary / MCP server was not found (ENOENT / module
 *                 probe failure). Always non-PASSED; always blocks required-tool
 *                 satisfaction at the verifier gate.
 *
 * This is the SINGLE verifier-visible run-status union. All consumers must
 * import from this module; do NOT redefine a local PASSED/REJECTED/UNAVAILABLE
 * union elsewhere.
 */
export type ToolRunStatus = 'PASSED' | 'REJECTED' | 'UNAVAILABLE';

/** Why a tool could not RUN (advisory categorisation of a REJECTED run). */
export type ToolFailureCategory = 'TRANSPORT' | 'TIMEOUT' | 'INPUT' | 'INFRA';

export interface ToolResultBase {
  /** The tool name (matches the key it registered its verify() under). */
  tool: string;
  /** Did the tool RUN to completion? NOT a semantic pass/fail verdict. */
  status: ToolRunStatus;
  /** Present only when `status === 'REJECTED'`; categorises the run failure. */
  failureCategory?: ToolFailureCategory;
  /** Path to the file holding the tool's raw output. */
  outputFile: string;
  /** Size in bytes of `outputFile` (for the tool's own token accounting). */
  outputFileBytes: number;
}

// ---------------------------------------------------------------------------
// (2) VerifyVerdict + VerifyResult — the semantic judgement.
//
// `verdict` is the enum value and is NEVER null/undefined. There is NO boolean
// `pass` field. `failureOutcome` is ADVISORY metadata only — the harness NEVER
// auto-routes on it.
// ---------------------------------------------------------------------------

export enum VerifyVerdict {
  PASS = 'PASS',
  FAIL = 'FAIL',
  NOT_APPLICABLE = 'NOT_APPLICABLE'
}

export interface VerifyResult {
  /** The semantic judgement. Always one of the enum members; never null. */
  verdict: VerifyVerdict;
  /** Human-readable reasons backing the verdict. */
  reasons: string[];
  /** ADVISORY only — the harness never auto-routes on this. */
  failureOutcome?: string;
}

// ---------------------------------------------------------------------------
// (3) VerifyContext — canonical evidence handles exposed to every verify() callback.
//
// `artifacts` maps a declared-artifact NAME to its PATH.
// `evidenceHandles` maps a tool NAME to its VALIDATED canonical evidence handle
// (VerifyEvidenceHandle). The handle carries semanticArtifactPath, schema
// id/version, hash, byte count, invocationId, toolName, state/action identity
// (admittedExecutionBoundary), admitted fingerprint, and run status.
//
// Path-only toolOutputs is REMOVED. Verifiers read the semanticArtifactPath
// from the handle (handle.semanticArtifactPath) instead of a raw top-level
// path string. The gate validates every handle before it appears here: missing,
// malformed, outputFile-only, command-envelope, child-ToolResultBase, stale-
// fingerprint, hash-mismatch, and out-of-root handles never reach a callback.
// ---------------------------------------------------------------------------

/**
 * Validated canonical evidence handle exposed to verifier callbacks.
 *
 * This is the verifier-facing subset of the full ToolEvidenceHandle shape
 * (src/core/ToolEvidenceHandle.ts). It is defined inline here to keep
 * contract.ts lean (no ./core imports). VerifierGate validates incoming
 * ToolEvidenceHandle instances and casts them to this type before passing
 * them into VerifyContext — the shapes are structurally identical for all
 * verifier-visible fields.
 *
 * DO NOT add mutable fields or non-readonly properties. This is a read-only
 * view of the validated evidence: a verifier callback MUST NOT modify handles.
 */
export interface VerifyEvidenceHandle {
  /** Handle schema revision (= TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION). */
  readonly schemaVersion: string;
  /** The tool name as registered with Pi. */
  readonly toolName: string;
  /** Unique per-invocation id (from ToolCallPathAllocation). */
  readonly invocationId: string;
  /** Did the tool EXECUTE to completion? NOT a semantic verdict. */
  readonly runStatus: 'PASSED' | 'REJECTED' | 'UNAVAILABLE';
  /** Why it was REJECTED (present only when REJECTED). */
  readonly failureCategory?: 'TRANSPORT' | 'TIMEOUT' | 'INPUT' | 'INFRA';
  /**
   * Absolute path to the primary semantic output file.
   * Gate logic uses this path. REQUIRED for PASSED runs (zog2.8).
   * May be absent for REJECTED/UNAVAILABLE runs.
   */
  readonly semanticArtifactPath?: string;
  /** Byte count of semanticArtifactPath (for token accounting). */
  readonly semanticArtifactBytes?: number;
  /** Hex SHA-256 of semanticArtifactPath (for integrity checking). */
  readonly semanticArtifactSha256?: string;
  /** Absolute path to PI_TOOL_OUTPUT_DIR for this project. */
  readonly toolOutputRoot: string;
  /** 'summary' | 'none' — whether an RTK summary is present. */
  readonly summaryMode: 'summary' | 'none';
  /** Harness build fingerprint at the time this handle was produced. */
  readonly admittedHarnessFingerprint: string;
  /** The (bead, state, action) scope this handle was produced in. */
  readonly admittedExecutionBoundary: string;
}

export interface VerifyContext {
  beadId: string;
  stateId: string;
  actionId: string;
  /** The write-set paths for this transition. */
  writeSet: string[];
  /** Declared-artifact name → artifact PATH. */
  artifacts: Record<string, string>;
  /**
   * Tool name → validated canonical evidence handle.
   *
   * Replaces the old path-only toolOutputs map (pi-experiment-yhec, no-backcompat).
   * Every handle in this map has been validated by the gate:
   *   - schemaVersion, toolName, invocationId, runStatus, toolOutputRoot,
   *     admittedHarnessFingerprint, admittedExecutionBoundary are non-empty.
   *   - semanticArtifactPath (when present) is inside toolOutputRoot.
   *   - No rawOutput / modelFacingRawOutput fields.
   *   - Missing/malformed/outputFile-only events never appear here.
   *
   * To read the artifact path: handle.semanticArtifactPath
   * To check run status:       handle.runStatus
   */
  evidenceHandles: Record<string, VerifyEvidenceHandle>;
}

// ---------------------------------------------------------------------------
// (4) Callback function types.
// ---------------------------------------------------------------------------

/** A per-tool verify() callback. May be sync or async. */
export type VerifyCallback = (ctx: VerifyContext) => VerifyResult | Promise<VerifyResult>;

/** A read_path_context skeleton extractor: source text → skeleton text. */
export type SkeletonExtractor = (source: string) => string;

/**
 * A named artifact projection: a SCHEMA-FREE mapping from a model-facing
 * projection name to the ordered list of candidate dot-path selectors that
 * extract the relevant subtree from an artifact's JSON.
 *
 * This is deliberately generic — it embeds NO knowledge of any specific
 * project's artifact schema. The harness query_artifact tool resolves a named
 * projection by looking it up in the `projections` registry and trying each
 * candidate selector against the artifact JSON in order, returning the first
 * that resolves to a defined value. Consuming-project extensions register
 * their own projections (e.g. cerdiwen's planContract/requirementsAnalysis
 * projections) at load via `projections.register(name, def)`.
 */
export interface ProjectionDef {
  /**
   * Ordered list of candidate dot-paths to try against the artifact JSON.
   * The first selector that resolves to a defined value wins.
   * An empty string means "return the root".
   */
  selectors: [string, ...string[]];
  /** Short human description for summaries / rejection hints. */
  description?: string;
}

// ---------------------------------------------------------------------------
// Minimal lean logger.
//
// The override log MUST NOT drag in the heavy winston Logger. We accept an
// injectable logger and default to a tiny console-backed one. This keeps the
// contract's import graph lean while still surfacing last-wins overrides.
// ---------------------------------------------------------------------------

export interface ContractLogger {
  warn(message: string): void;
}

const defaultLogger: ContractLogger = {
  warn(message: string): void {
    // eslint-disable-next-line no-console
    console.warn(message);
  }
};

// ---------------------------------------------------------------------------
// (5) The two module-level singleton registries.
//
// A generic last-wins registry: a second registration of the same name
// REPLACES the prior callback and LOGS the override (it does NOT throw).
// ---------------------------------------------------------------------------

class Registry<Fn> {
  private readonly entries = new Map<string, Fn>();

  constructor(
    private readonly label: string,
    private logger: ContractLogger = defaultLogger
  ) {}

  /**
   * Register `fn` under `name`. LAST-WINS idempotent override: a second
   * registration of the same name REPLACES the prior one and logs the
   * override — it does NOT throw.
   */
  register(name: string, fn: Fn): void {
    if (this.entries.has(name)) {
      this.logger.warn(
        `[orr-else/contract] ${this.label}: re-registering "${name}" — replacing the prior registration (last-wins).`
      );
    }
    this.entries.set(name, fn);
  }

  /** Look up the callback registered under `name`, if any. */
  get(name: string): Fn | undefined {
    return this.entries.get(name);
  }

  /** True if a callback is registered under `name`. */
  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** All registered names (for diagnostics / the harness loops). */
  names(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * Swap the logger (test seam). Returns the registry for chaining.
   * Not used in production; the default console logger is lean enough.
   */
  withLogger(logger: ContractLogger): this {
    this.logger = logger;
    return this;
  }
}

/**
 * The harness-owned verify() registry. Consuming-project extensions call
 * `verifier.register(toolName, fn)` once per tool at load; the harness verifier
 * loop looks the callback up via `verifier.get(toolName)` and invokes it.
 */
export const verifier = new Registry<VerifyCallback>('verifier');

/**
 * The harness-owned read_path_context skeleton-extractor registry. Consuming
 * extensions call `skeletons.register(ext, fn)`; the skeleton loop looks the
 * extractor up by file extension and invokes it.
 */
export const skeletons = new Registry<SkeletonExtractor>('skeletons');

/**
 * The harness-owned named-projection registry. Consuming-project extensions
 * call `projections.register(name, def)` once per projection at load; the
 * generic query_artifact tool looks a projection up via `projections.get(name)`
 * and resolves its candidate selectors against the artifact JSON.
 *
 * Projection names are namespaced by artifact type using a `<artifactId>:<name>`
 * key (e.g. `planContract:writeSet`) so the flat last-wins Registry can hold
 * projections for any artifact type without coupling to a schema. The harness
 * NEVER pre-registers any project's projections — an UNregistered named
 * projection falls back to the generic dot-path selector.
 */
export const projections = new Registry<ProjectionDef>('projections');

/** Exported for tests that need to assert registry behaviour generically. */
export type { Registry };
