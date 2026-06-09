/**
 * CoordinatorVerifierGate — the LIVE coordinator-side binding gate (0yt5.20).
 *
 * Bead 0yt5.5 built `runVerifierGate`: a tested loop that, given a paths-only
 * VerifierGateContext + the resolved required-tool names + a coordinator-readable
 * EventStore, resolves each tool's latest tool-result event, runs its registered
 * verify() callback under per-verify isolation, and aggregates by enum.
 *
 * This module wires that loop into the LIVE coordinator transition path. It is
 * the COORDINATOR-side binding authority (decision B): at the transition-
 * application point in handleTeammateEvent (before STATE_TRANSITION_APPLIED is
 * committed) the coordinator:
 *
 *  1. Resolves the transition's required tool NAMES (RequiredToolResolver).
 *     A transition with NO required tools is a NO-OP — `evaluate` returns a
 *     trivially-passing result and records nothing, so unguarded routing is
 *     byte-identical to its prior behaviour.
 *  2. Builds the PATHS-ONLY VerifyContext coordinator-side from PROJECT-scoped
 *     state: declared-artifact name→path (ArtifactPaths) and the per-tool
 *     outputFile paths (resolved inside runVerifierGate from the durable events).
 *     The write-set is resolved best-effort (PlanWriteSet) and degrades to an
 *     empty array on any failure — the load-bearing inputs are the artifact +
 *     tool-output PATHS, never the write-set.
 *  3. Calls `runVerifierGate` with a per-verify TIMEOUT (AC5 isolation).
 *  4. Records a VERIFY_EVALUATED domain event with the per-tool diagnostics and
 *     the blocked flag (AC6 observability).
 *  5. Returns the structured VerifierGateResult so the caller blocks (does NOT
 *     auto-route — the model picks the recovery edge) on `pass === false`.
 *
 * The harness imports NO consumer tool code here. verify() callbacks arrive via
 * the contract `verifier` registry (consumer extensions register at load; the
 * coordinator loads those extensions in its OWN process — decision A).
 */

import { verifier as defaultVerifier, type Registry, type VerifyCallback } from '../contract.js';
import { DomainEventName } from '../constants/index.js';
import {
  runVerifierGate,
  type VerifierGateContext,
  type VerifierGateEventStore,
  type VerifierGateOptions,
  type VerifierGateResult
} from './VerifierGate.js';
import type { RequiredTool } from './domain/StateModels.js';
import type { HarnessConfig } from './ConfigLoader.js';
import { Logger } from './Logger.js';
import { Component } from '../constants/index.js';
import { asBeadId, asStateId, asActionId } from '../types/ids.js';
import { checkRequiredToolsForCommandCollisions, type ToolSurfaceCatalog } from './ToolSurfaceCatalog.js';

/** Default per-verify isolation timeout (ms). */
export const DEFAULT_VERIFY_TIMEOUT_MS = 30_000;

/**
 * FAIL-FAST config validation (0yt5.20 AC4).
 *
 * Scan every state's and action's `requiredTools`. For each required tool that
 * EXPECTS a verify() (object form with `expectsVerify: true`), assert a callback
 * is registered under that name in the verifier registry. Presence-only tools
 * (string form, or object without the flag) load cleanly with NO callback.
 *
 * MUST be called AFTER consumer worker-extensions + harness built-in tools have
 * registered their callbacks (i.e. at coordinator startup once the gate process
 * has loaded its extensions), so the registry reflects the gate process.
 *
 * Throws an Error NAMING the first offending tool (and every offender) when a
 * verify()-expecting tool has no registered callback.
 */
/**
 * Validate that required tools in config are all model-callable (not commands).
 *
 * pi-experiment-amq0.15: if a catalog is provided, check every requiredTools entry
 * against the catalog's command names. A COMMAND surface (pi.registerCommand)
 * CANNOT satisfy requiredTools — only model-callable tools can.
 *
 * This is the requiredTool lint consumer for the ToolSurfaceCatalog.
 */
export function validateRequiredToolsNotCommands(
  config: HarnessConfig,
  catalog: ToolSurfaceCatalog
): void {
  const violations: string[] = [];

  const inspectList = (tools: RequiredTool[] | undefined, location: string): void => {
    const names = (tools || []).map(t => typeof t === 'string' ? t : t.name);
    violations.push(...checkRequiredToolsForCommandCollisions(names, catalog, location));
  };

  for (const [stateId, state] of Object.entries(config.states || {})) {
    inspectList(state.requiredTools, `State "${stateId}"`);
    for (const action of state.actions || []) {
      inspectList(action.requiredTools, `State "${stateId}" action "${action.id}"`);
    }
    for (const [outcome, routeTools] of Object.entries(state.routeEvidence || {})) {
      inspectList(routeTools as RequiredTool[], `State "${stateId}" routeEvidence["${outcome}"]`);
    }
  }

  if (violations.length > 0) {
    throw new Error(
      `Config fail-fast: requiredTools command-collision(s) detected:\n` +
      violations.map(v => `  - ${v}`).join('\n')
    );
  }
}

export function validateRequiredToolVerifiers(
  config: HarnessConfig,
  registry: Pick<Registry<VerifyCallback>, 'has'> = defaultVerifier,
  catalog?: ToolSurfaceCatalog
): void {
  // pi-experiment-amq0.15: if a catalog is provided, enforce that no COMMAND
  // name appears in requiredTools (fail-closed: commands cannot satisfy gates).
  if (catalog) {
    validateRequiredToolsNotCommands(config, catalog);
  }

  const offenders = new Set<string>();

  const inspect = (tools: RequiredTool[] | undefined): void => {
    for (const tool of tools || []) {
      if (typeof tool === 'string') continue; // presence-only; never expects verify
      if (tool.expectsVerify !== true) continue; // presence-only by declaration
      if (!registry.has(tool.name)) offenders.add(tool.name);
    }
  };

  for (const state of Object.values(config.states || {})) {
    inspect(state.requiredTools);
    for (const action of state.actions || []) {
      inspect(action.requiredTools);
    }
    // pi-experiment-6q0y.46 AC5: also inspect routeEvidence tools so that
    // tools declared as expectsVerify:true in routeEvidence trigger the same
    // startup-fail as state/action-level requiredTools.
    for (const routeTools of Object.values(state.routeEvidence || {})) {
      inspect(routeTools as RequiredTool[]);
    }
  }

  if (offenders.size > 0) {
    const names = [...offenders];
    throw new Error(
      `Config fail-fast: required tool(s) ${names.map(n => `"${n}"`).join(', ')} declare ` +
      `expectsVerify:true but no verify() callback is registered in the gate process. ` +
      `Register a verify() via the contract \`verifier\` registry (in a pi.workerExtensions ` +
      `module loaded by the coordinator), or drop expectsVerify for a presence-only tool.`
    );
  }
}

/** The narrow EventStore surface the coordinator gate needs. */
export interface CoordinatorGateEventStore extends VerifierGateEventStore {
  record(event: DomainEventName | string, data: unknown): Promise<void>;
}

/** The narrow ArtifactPaths surface the coordinator gate needs. */
export interface CoordinatorGateArtifactPaths {
  resolve(context: { beadId: string; stateId?: string; actionId?: string; includeContent?: boolean }): Promise<{
    artifactPaths: Record<string, string>;
  }>;
}

/** The narrow RequiredToolResolver surface the coordinator gate needs. */
export interface CoordinatorGateRequiredToolResolver {
  resolve(
    requiredTools: RequiredTool[] | undefined,
    context: { beadId?: string; stateId?: string; worktreePath?: string; projectRoot?: string; config: HarnessConfig }
  ): Promise<{ toolNames: string[] }>;
}

/** The narrow PlanWriteSet surface the coordinator gate needs (best-effort). */
export interface CoordinatorGatePlanWriteSet {
  resolve(context: { beadId: string; stateId?: string; worktreePath: string; projectRoot: string }): Promise<{
    allowedWriteSet: string[];
  }>;
}

/** Identity + transition-scoped inputs the coordinator already knows. */
export interface CoordinatorGateInput {
  beadId: string;
  stateId: string;
  actionId: string;
  /** Combined state + action requiredTools for this transition. */
  requiredTools: RequiredTool[] | undefined;
  /** Worktree path for write-set resolution; falls back to projectRoot. */
  worktreePath?: string;
}

/** Dependency bag for the coordinator gate (structural — testable with doubles). */
export interface CoordinatorVerifierGateDeps {
  eventStore: CoordinatorGateEventStore;
  artifactPaths: CoordinatorGateArtifactPaths;
  requiredToolResolver: CoordinatorGateRequiredToolResolver;
  planWriteSet?: CoordinatorGatePlanWriteSet;
  projectRoot: string;
  config: HarnessConfig;
  /** Per-verify isolation timeout (ms). Defaults to DEFAULT_VERIFY_TIMEOUT_MS. */
  verifyTimeoutMs?: number;
  /** verify() registry injection (tests); defaults to the module singleton. */
  registry?: VerifierGateOptions['registry'];
}

/** The coordinator gate outcome surfaced to the caller. */
export interface CoordinatorGateOutcome extends VerifierGateResult {
  /** Whether the gate actually ran (false when no required tools applied). */
  ran: boolean;
  /** The resolved required tool names the gate evaluated (empty when ran=false). */
  evaluatedTools: string[];
}

/**
 * Resolve the declared-artifact name→PATH map coordinator-side. Best-effort:
 * a resolution failure yields an empty map rather than blocking the gate (the
 * tool-output paths remain the load-bearing input).
 */
async function resolveArtifacts(
  deps: CoordinatorVerifierGateDeps,
  input: CoordinatorGateInput
): Promise<Record<string, string>> {
  try {
    const resolution = await deps.artifactPaths.resolve({
      beadId: input.beadId,
      stateId: input.stateId,
      actionId: input.actionId,
      includeContent: false
    });
    return resolution.artifactPaths ?? {};
  } catch (error) {
    Logger.warn(Component.ORR_ELSE, 'Coordinator gate: artifact path resolution failed (degrading to empty map)', {
      beadId: input.beadId,
      stateId: input.stateId,
      actionId: input.actionId,
      error: String(error)
    });
    return {};
  }
}

/**
 * Resolve the transition write-set coordinator-side. Best-effort: degrades to
 * an empty array on any failure (the artifact + tool-output paths are the
 * load-bearing inputs, never the write-set).
 */
async function resolveWriteSet(
  deps: CoordinatorVerifierGateDeps,
  input: CoordinatorGateInput
): Promise<string[]> {
  if (!deps.planWriteSet) return [];
  try {
    const resolution = await deps.planWriteSet.resolve({
      beadId: input.beadId,
      stateId: input.stateId,
      worktreePath: input.worktreePath || deps.projectRoot,
      projectRoot: deps.projectRoot
    });
    return resolution.allowedWriteSet ?? [];
  } catch (error) {
    Logger.warn(Component.ORR_ELSE, 'Coordinator gate: write-set resolution failed (degrading to empty array)', {
      beadId: input.beadId,
      stateId: input.stateId,
      error: String(error)
    });
    return [];
  }
}

/**
 * Run the LIVE coordinator-side verifier gate for one transition.
 *
 * Returns `{ ran: false, pass: true, ... }` (a NO-OP) when the transition
 * declares no required tools — so an unguarded transition is never affected.
 * Otherwise resolves the paths-only context, runs `runVerifierGate` with the
 * per-verify timeout, records a VERIFY_EVALUATED event, and returns the result.
 */
export async function evaluateCoordinatorGate(
  deps: CoordinatorVerifierGateDeps,
  input: CoordinatorGateInput
): Promise<CoordinatorGateOutcome> {
  const resolution = await deps.requiredToolResolver.resolve(input.requiredTools, {
    beadId: input.beadId,
    stateId: input.stateId,
    worktreePath: input.worktreePath,
    projectRoot: deps.projectRoot,
    config: deps.config
  });

  const evaluatedTools = resolution.toolNames;

  // NO-OP: a transition with no required tools is unguarded — behave EXACTLY as
  // before (no gate, no event recorded).
  if (evaluatedTools.length === 0) {
    return { ran: false, pass: true, failures: [], rejectMessage: '', perTool: [], evaluatedTools: [] };
  }

  const [artifacts, writeSet] = await Promise.all([
    resolveArtifacts(deps, input),
    resolveWriteSet(deps, input)
  ]);

  const ctx: VerifierGateContext = {
    beadId: asBeadId(input.beadId),
    stateId: asStateId(input.stateId),
    actionId: asActionId(input.actionId),
    writeSet,
    artifacts
  };

  const result = await runVerifierGate(ctx, evaluatedTools, deps.eventStore, {
    registry: deps.registry,
    verifyTimeoutMs: deps.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS
  });

  // AC6: record a VERIFY_EVALUATED domain event per gate with the per-tool
  // diagnostics and the blocked flag. Best-effort: a recording failure must not
  // change the gate verdict.
  await deps.eventStore.record(DomainEventName.VERIFY_EVALUATED, {
    beadId: input.beadId,
    stateId: input.stateId,
    actionId: input.actionId,
    perTool: result.perTool,
    blocked: !result.pass
  }).catch((error: unknown) => {
    Logger.warn(Component.ORR_ELSE, 'Coordinator gate: failed to record VERIFY_EVALUATED event', {
      beadId: input.beadId,
      stateId: input.stateId,
      actionId: input.actionId,
      error: String(error)
    });
  });

  return { ...result, ran: true, evaluatedTools };
}
