/**
 * readinessProbe — pi-experiment-8ieq / pi-experiment-85bl
 *
 * Startup/readiness executor for project-tool probes.
 *
 * DESIGN CONSTRAINTS:
 *   - Only tools that declare sideEffectContract.safeForReadinessProbe: true
 *     may be executed. Tools without the declaration (no contract) are blocked
 *     fail-closed: they CANNOT be probed. Tools with safeForReadinessProbe:
 *     false are also blocked.
 *   - No model/provider calls are made. The executor shells out to the tool's
 *     command only (COMMAND-type tools). MCP tools are not supported as probes.
 *   - Execution is bounded by PROBE_TIMEOUT_MS, PROBE_MAX_OUTPUT_BYTES, and
 *     cwd/root-scope (probe cwd is pinned to the project root).
 *     A probe that exceeds either time/size limit is terminated and reported as
 *     TIMEOUT or OVERSIZE.
 *   - No raw output bodies are logged. Only byte count and SHA-256 of the
 *     output are recorded in the emitted event.
 *   - elapsedMs is measured using the injected Clock (deterministic in tests).
 *   - pi-experiment-85bl: required vs optional backend distinction. A tool with
 *     optional:true has its probe failure recorded as a diagnostic only — it
 *     does NOT block startup. Required (non-optional) backends block on failure.
 */
import { createHash } from 'node:crypto';
import { execa } from 'execa';
import type { ProjectToolConfig, ProjectCommandToolConfig } from '../../core/domain/StateModels.js';
import type { Clock } from '../../core/Clock.js';
import { systemClock } from '../../core/Clock.js';
import type { EventStore } from '../../core/EventStore.js';
import { DomainEventName, ProjectToolType } from '../../constants/domain.js';
import { EnvVars } from '../../constants/infra.js';
import {
  ProbeStatus as ProbeStatusVocab,
  GateDecision as GateDecisionVocab,
  assertNever
} from '../../core/vocabulary.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default per-probe execution timeout (ms). */
export const PROBE_TIMEOUT_MS = 30_000;

/** Maximum raw output size accepted from a probe command (bytes). */
export const PROBE_MAX_OUTPUT_BYTES = 512 * 1024; // 512 KiB

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Outcome of a single readiness-probe execution attempt.
 * Re-exported from core vocabulary (amq0.11 — code-owned typed vocabulary).
 *
 * PASSED   — tool ran, output within bounds.
 * REJECTED — tool ran but exited with a non-zero code.
 * UNSAFE   — tool lacks the safe-for-probe declaration; body never executed.
 * TIMEOUT  — tool exceeded PROBE_TIMEOUT_MS; process was terminated.
 * OVERSIZE — tool output exceeded PROBE_MAX_OUTPUT_BYTES; output rejected.
 */
export type ProbeStatus = ProbeStatusVocab;
export const ProbeStatus = ProbeStatusVocab;

/**
 * Startup admission gate decision for this probe.
 * Re-exported from core vocabulary (amq0.11 — code-owned typed vocabulary).
 *
 * ADMIT — probe passed (or is not required); harness may start.
 * DENY  — probe failed and the tool is required; harness must NOT start.
 */
export type GateDecision = GateDecisionVocab;
export const GateDecision = GateDecisionVocab;

/**
 * Structured failure taxonomy for a probe outcome (pi-experiment-85bl, AC4).
 *
 * Each non-PASSED probe outcome maps to one of these rows. The taxonomy is
 * stable across releases — consumers (6q0y.34) can pattern-match on this field
 * rather than the diagnostic string.
 *
 * PROBE_UNSAFE            — tool lacks safe-for-probe declaration; never executed.
 * PROBE_TIMEOUT           — tool exceeded the configured timeout; was terminated.
 * PROBE_OVERSIZE          — tool output exceeded the configured output-size limit.
 * PROBE_NONZERO_EXIT      — tool ran but exited with a non-zero exit code.
 * PROBE_UNSUPPORTED_TYPE  — tool type is not executable as a probe (non-COMMAND).
 */
export type ProbeFailureTaxonomy =
  | 'PROBE_UNSAFE'
  | 'PROBE_TIMEOUT'
  | 'PROBE_OVERSIZE'
  | 'PROBE_NONZERO_EXIT'
  | 'PROBE_UNSUPPORTED_TYPE';

export interface ProbeResult {
  tool: string;
  configPath: string;
  probeStatus: ProbeStatus;
  elapsedMs: number;
  gateDec: GateDecision;
  /** Raw output byte count (absent when probe did not run). */
  bytes?: number;
  /** SHA-256 hex digest of the raw output (absent when probe did not run). */
  sha256?: string | undefined;
  /** Semantic artifact path returned by the tool (absent when not applicable). */
  semanticArtifactPath?: string;
  /** Human-readable diagnostic for UNSAFE/TIMEOUT/OVERSIZE/REJECTED outcomes. */
  diagnostic?: string;
  /**
   * Structured failure taxonomy row (pi-experiment-85bl, AC4).
   * Present on all non-PASSED outcomes; absent when probeStatus is 'PASSED'.
   */
  failureTaxonomy?: ProbeFailureTaxonomy;
}

// ---------------------------------------------------------------------------
// Safe-for-probe gate
// ---------------------------------------------------------------------------

/**
 * Returns true when a tool is declared safe for readiness probing.
 *
 * A tool is probe-safe only when its sideEffectContract explicitly declares
 * safeForReadinessProbe: true. Missing contract or safeForReadinessProbe:
 * false both fail-closed (gate blocks execution).
 */
export function isProbeDeclarationSafe(definition: ProjectToolConfig): boolean {
  const contract = definition.sideEffectContract;
  return contract !== undefined && contract.safeForReadinessProbe === true;
}

// ---------------------------------------------------------------------------
// Core probe executor
// ---------------------------------------------------------------------------

/**
 * Run a single declared-safe project-tool probe.
 *
 * SAFETY INVARIANTS (load-bearing — tests prove each):
 *   1. UNSAFE gate: when isProbeDeclarationSafe returns false, the tool body
 *      is NEVER executed. The function returns immediately with probeStatus
 *      UNSAFE and gateDec DENY. A spy/flag on the command proves the body
 *      never ran.
 *   2. TIMEOUT: the AbortController fires after PROBE_TIMEOUT_MS; execa
 *      receives the cancelSignal and terminates the subprocess.
 *   3. OVERSIZE: execa is given maxBuffer:maxOutputBytes so excess output
 *      causes execa to set result.isMaxBuffer; the probe is reported as
 *      OVERSIZE (the subprocess is not separately aborted — execa handles it).
 *   4. No provider calls: the executor ONLY runs the tool's declared command
 *      (execa). No model SDK, no HTTP to any LLM endpoint.
 *
 * @param definition   The configured project tool to probe.
 * @param configPath   Path to the harness.yaml that declared this tool.
 * @param required     Whether this tool's probe is required for startup admission.
 * @param eventStore   EventStore to record the PROJECT_TOOL_PROBE_COMPLETED event.
 * @param clock        Injected clock for deterministic elapsedMs.
 * @param overrides    Optional overrides for test injection (timeout, maxBytes, projectRoot).
 */
export async function runReadinessProbe(
  definition: ProjectToolConfig,
  configPath: string,
  required: boolean,
  eventStore: EventStore,
  clock: Clock = systemClock,
  overrides?: { timeoutMs?: number; maxOutputBytes?: number; projectRoot?: string }
): Promise<ProbeResult> {
  const timeoutMs = overrides?.timeoutMs ?? PROBE_TIMEOUT_MS;
  const maxOutputBytes = overrides?.maxOutputBytes ?? PROBE_MAX_OUTPUT_BYTES;

  const startMs = clock.now();

  // ── Gate 1: safe-for-probe declaration ────────────────────────────────────
  if (!isProbeDeclarationSafe(definition)) {
    const elapsedMs = clock.now() - startMs;
    const diagnostic = definition.sideEffectContract === undefined
      ? `Tool "${definition.name}" (${configPath}) has no sideEffectContract — missing declaration blocks readiness probing fail-closed.`
      : `Tool "${definition.name}" (${configPath}) declares sideEffectContract.safeForReadinessProbe: false — blocked from readiness probing.`;
    const result: ProbeResult = {
      tool: definition.name,
      configPath,
      probeStatus: ProbeStatus.UNSAFE,
      elapsedMs,
      gateDec: required ? GateDecision.DENY : GateDecision.ADMIT,
      diagnostic,
      failureTaxonomy: 'PROBE_UNSAFE'
    };
    await emitProbeEvent(eventStore, result);
    return result;
  }

  // ── Gate 2: only COMMAND-type tools are executable as probes ──────────────
  if (definition.type !== ProjectToolType.COMMAND) {
    const elapsedMs = clock.now() - startMs;
    const diagnostic = `Tool "${definition.name}" (${configPath}) is type "${definition.type}" — only COMMAND tools can be executed as readiness probes.`;
    const result: ProbeResult = {
      tool: definition.name,
      configPath,
      probeStatus: ProbeStatus.UNSAFE,
      elapsedMs,
      gateDec: required ? GateDecision.DENY : GateDecision.ADMIT,
      diagnostic,
      failureTaxonomy: 'PROBE_UNSUPPORTED_TYPE'
    };
    await emitProbeEvent(eventStore, result);
    return result;
  }

  const commandDef = definition as ProjectCommandToolConfig;
  const command = commandDef.command;
  const defaultArgs: string[] = Array.isArray(commandDef.defaultArgs)
    ? commandDef.defaultArgs.map(String)
    : [];

  // ── cwd/root-scope bound (pi-experiment-85bl, AC3) ────────────────────────
  // Probe runs with cwd pinned to the project root. This prevents a probe from
  // resolving relative paths outside the project tree and ensures no repository
  // mutation, service startup, or Docker invocation can escape the scope.
  // Priority: explicit override (tests) → PI_PROJECT_ROOT env → process.cwd().
  const projectRoot = overrides?.projectRoot
    ?? process.env[EnvVars.PROJECT_ROOT]
    ?? process.cwd();

  // ── Bounded execution ─────────────────────────────────────────────────────
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  let probeStatus: ProbeStatus = ProbeStatus.PASSED;
  let rawOutput = '';
  let timedOut = false;

  try {
    const result = await execa(command, defaultArgs, {
      cancelSignal: ac.signal,
      reject: false,
      encoding: 'utf8',
      maxBuffer: maxOutputBytes,
      timeout: timeoutMs + 1000, // belt-and-suspenders; ac.abort fires first
      cwd: projectRoot
    });

    if (result.isCanceled) {
      timedOut = true;
    } else if (result.isMaxBuffer) {
      probeStatus = ProbeStatus.OVERSIZE;
    } else {
      rawOutput = (result.stdout ?? '') + (result.stderr ?? '');
      if (result.exitCode !== 0) {
        probeStatus = ProbeStatus.REJECTED;
      }
    }
  } catch {
    timedOut = true;
  } finally {
    clearTimeout(timer);
  }

  if (timedOut) {
    probeStatus = ProbeStatus.TIMEOUT;
  }

  const elapsedMs = clock.now() - startMs;
  const passed = probeStatus === ProbeStatus.PASSED;

  // ── Compute evidence (only when probe ran and output is within bounds) ─────
  let bytes: number | undefined;
  let sha256: string | undefined;
  if (passed || probeStatus === ProbeStatus.REJECTED) {
    bytes = Buffer.byteLength(rawOutput, 'utf8');
    sha256 = createHash('sha256').update(rawOutput).digest('hex');
  }

  const gateDec: GateDecision = (!passed && required) ? GateDecision.DENY : GateDecision.ADMIT;

  const diagnostic = passed ? undefined : buildDiagnostic(definition.name, configPath, probeStatus, timeoutMs, maxOutputBytes);

  // ── Failure taxonomy (pi-experiment-85bl, AC4) ────────────────────────────
  const failureTaxonomy: ProbeFailureTaxonomy | undefined = passed
    ? undefined
    : probeStatusToTaxonomy(probeStatus);

  const probeResult: ProbeResult = {
    tool: definition.name,
    configPath,
    probeStatus,
    elapsedMs,
    gateDec,
    ...(bytes !== undefined ? { bytes } : {}),
    ...(sha256 !== undefined ? { sha256 } : {}),
    ...(diagnostic !== undefined ? { diagnostic } : {}),
    ...(failureTaxonomy !== undefined ? { failureTaxonomy } : {})
  };

  await emitProbeEvent(eventStore, probeResult);
  return probeResult;
}

// ---------------------------------------------------------------------------
// Startup admission
// ---------------------------------------------------------------------------

/**
 * Run all configured probeContext:true tools and gate harness startup.
 *
 * pi-experiment-85bl (AC5): required vs optional backend distinction.
 *
 * - REQUIRED backend (tool.optional !== true): probe failure → DENY → startup
 *   blocked before HARNESS_STARTED and before model/provider spend.
 * - OPTIONAL backend (tool.optional === true): probe failure → ADMIT → failure
 *   is recorded as a diagnostic in the returned results but does NOT prevent
 *   startup. The operator learns the optional backend is unavailable without
 *   harness termination.
 *
 * Returns a summary of all probe results and a top-level admission decision.
 * Throws only when at least one REQUIRED backend probe is denied.
 */
export async function runStartupProbeAdmission(
  tools: ProjectToolConfig[],
  configPath: string,
  eventStore: EventStore,
  clock: Clock = systemClock,
  overrides?: { timeoutMs?: number; maxOutputBytes?: number; projectRoot?: string }
): Promise<{ admitted: boolean; results: ProbeResult[] }> {
  const probeTools = tools.filter(t => (t as { probeContext?: boolean }).probeContext === true);
  if (probeTools.length === 0) return { admitted: true, results: [] };

  const results: ProbeResult[] = [];
  for (const tool of probeTools) {
    // A tool is REQUIRED unless it explicitly declares optional: true.
    // optional: true → backend is optional → probe failure is diagnostic only.
    // optional: false / absent → backend is required → probe failure blocks startup.
    const required = (tool as { optional?: boolean }).optional !== true;
    const r = await runReadinessProbe(tool, configPath, required, eventStore, clock, overrides);
    results.push(r);
  }

  const denied = results.filter(r => r.gateDec === GateDecision.DENY);
  if (denied.length === 0) return { admitted: true, results };

  const names = denied.map(r => `"${r.tool}" (${r.probeStatus})`).join(', ');
  throw new Error(
    `Harness startup blocked by failed readiness probe(s) at "${configPath}": ${names}. ` +
    `Fix the failing tool(s) before starting the harness (model spend is prevented until probes pass).`
  );
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

async function emitProbeEvent(eventStore: EventStore, result: ProbeResult): Promise<void> {
  const payload: Record<string, unknown> = {
    tool: result.tool,
    configPath: result.configPath,
    probeStatus: result.probeStatus,
    elapsedMs: result.elapsedMs,
    gateDec: result.gateDec
  };
  if (result.bytes !== undefined) payload.bytes = result.bytes;
  if (result.sha256 !== undefined) payload.sha256 = result.sha256;
  if (result.semanticArtifactPath !== undefined) payload.semanticArtifactPath = result.semanticArtifactPath;
  if (result.failureTaxonomy !== undefined) payload.failureTaxonomy = result.failureTaxonomy;
  await eventStore.record(DomainEventName.PROJECT_TOOL_PROBE_COMPLETED, payload).catch(() => {});
}

function buildDiagnostic(
  toolName: string,
  configPath: string,
  probeStatus: ProbeStatus,
  timeoutMs: number,
  maxOutputBytes: number
): string {
  switch (probeStatus) {
    case ProbeStatus.TIMEOUT:
      return `Tool "${toolName}" (${configPath}) probe timed out after ${timeoutMs}ms.`;
    case ProbeStatus.OVERSIZE:
      return `Tool "${toolName}" (${configPath}) probe output exceeded ${maxOutputBytes} bytes limit.`;
    case ProbeStatus.REJECTED:
      return `Tool "${toolName}" (${configPath}) probe exited with a non-zero exit code.`;
    case ProbeStatus.UNSAFE:
      return `Tool "${toolName}" (${configPath}) is not declared safe for readiness probing.`;
    case ProbeStatus.PASSED:
      return `Tool "${toolName}" (${configPath}) probe status was PASSED but diagnostic was requested.`;
  }
}

/**
 * Maps a ProbeStatus to the structured failure taxonomy row (pi-experiment-85bl).
 * Returns undefined for PASSED (no failure).
 *
 * assertNever in the default position makes an unhandled ProbeStatus member
 * a compile error — TypeScript will reject the build if a new member is added
 * to the ProbeStatus vocabulary and this switch is not updated (amq0.11).
 */
function probeStatusToTaxonomy(status: ProbeStatus): ProbeFailureTaxonomy | undefined {
  switch (status) {
    case ProbeStatus.UNSAFE:   return 'PROBE_UNSAFE';
    case ProbeStatus.TIMEOUT:  return 'PROBE_TIMEOUT';
    case ProbeStatus.OVERSIZE: return 'PROBE_OVERSIZE';
    case ProbeStatus.REJECTED: return 'PROBE_NONZERO_EXIT';
    case ProbeStatus.PASSED:   return undefined;
    default: return assertNever(status);
  }
}
