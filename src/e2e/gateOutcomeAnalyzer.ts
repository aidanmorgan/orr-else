/**
 * gateOutcomeAnalyzer — the VERIFIABLE CORE of the dedicated cerdiwen gate e2e
 * (pi-experiment-0yt5.30 / parent 0yt5.14 AC#9).
 *
 * This is a PURE function over a durable event log (DomainEvent[] parsed from
 * `{projectRoot}/.pi/events/*.jsonl`). It classifies every COORDINATOR-gated
 * transition into exactly one of three outcomes and surfaces the blocking
 * tool's verdict + reasons so a live-run driver (or a unit test) can assert the
 * marquee "cerdiwen gate works" guarantee against the DURABLE record — not
 * stdout (AC3).
 *
 * It does NO fs / network / subprocess work, so it is fully unit-testable here
 * AND reusable from the live-run driver via the built `dist/e2e/...` emit.
 *
 * Schema (authoritative, read from src — do NOT invent):
 *  - VERIFY_EVALUATED.data = { beadId, stateId, actionId, perTool, blocked }
 *      perTool: VerifierGatePerTool[] from src/core/VerifierGate.ts:
 *        { tool; verdict?: VerifyVerdict; reasons: string[]; durationMs; timedOut?; threw? }
 *      - A did-not-run (artifact ABSENT) block: a perTool entry with NO verdict
 *        (verdict undefined) + reasons naming "not invoked".
 *      - A present-but-FAIL block: a perTool entry with verdict 'FAIL' + reasons.
 *  - STATE_TRANSITION_APPLIED.data = { beadId, fromState, nextState, actionId, ... }
 *      The coordinator records this for BOTH advances AND blocks; a BLOCK is a
 *      self-loop (fromState === nextState). An ADVANCE has fromState !== nextState.
 */

import type { DomainEvent } from '../core/EventStoreTypes.js';
import { DomainEventName } from '../constants/domain.js';
import { VerifyVerdict } from '../contract.js';
import { GateOutcomeKind as GateOutcomeKindVocab } from '../core/vocabulary.js';

/** A tool that contributed to BLOCKING a transition, with its durable diagnostics. */
export interface BlockingTool {
  tool: string;
  /** Absent (undefined) for a did-not-run / artifact-absent block. */
  verdict?: VerifyVerdict;
  reasons: string[];
}

/** Re-exported from core vocabulary (amq0.11 — code-owned typed vocabulary). */
export type GateOutcomeKind = GateOutcomeKindVocab;

/** One classified gated transition, keyed by (beadId, stateId, actionId). */
export interface GateTransitionAnalysis {
  beadId: string;
  stateId: string;
  actionId: string;
  outcome: GateOutcomeKind;
  advanced: boolean;
  /** Empty for 'advanced'; the blocking tool(s) for the two blocked kinds. */
  blockingTools: BlockingTool[];
}

export interface GateOutcomeAnalysis {
  transitions: GateTransitionAnalysis[];
}

/** A minimally-typed view of a VERIFY_EVALUATED perTool entry (read-only). */
interface PerToolEntry {
  tool: string;
  verdict?: VerifyVerdict;
  reasons: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readPerTool(data: Record<string, unknown>): PerToolEntry[] {
  const raw = data.perTool;
  if (!Array.isArray(raw)) return [];
  const out: PerToolEntry[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const tool = asString(entry.tool);
    if (tool === undefined) continue;
    const verdict =
      entry.verdict === VerifyVerdict.PASS ||
      entry.verdict === VerifyVerdict.FAIL ||
      entry.verdict === VerifyVerdict.NOT_APPLICABLE
        ? entry.verdict
        : undefined;
    const reasons = Array.isArray(entry.reasons)
      ? entry.reasons.filter((r): r is string => typeof r === 'string')
      : [];
    out.push({ tool, verdict, reasons });
  }
  return out;
}

function transitionKey(beadId: string, stateId: string, actionId: string): string {
  return `${beadId} ${stateId} ${actionId}`;
}

/**
 * Did the durable log show an ACTUAL advance (fromState !== nextState) for this
 * bead/state/action AFTER the given VERIFY_EVALUATED index? The coordinator
 * records a self-loop STATE_TRANSITION_APPLIED on a block, so we must require a
 * non-self-loop transition to call an outcome 'advanced'.
 */
function hasAdvanceAfter(
  events: DomainEvent[],
  fromIndex: number,
  beadId: string,
  stateId: string,
  actionId: string
): boolean {
  for (let i = fromIndex + 1; i < events.length; i++) {
    const ev = events[i];
    if (ev.type !== DomainEventName.STATE_TRANSITION_APPLIED) continue;
    const data = ev.data;
    if (asString(data.beadId) !== beadId) continue;
    if (asString(data.fromState) !== stateId) continue;
    const evActionId = asString(data.actionId);
    if (actionId !== '' && evActionId !== undefined && evActionId !== actionId) continue;
    const nextState = asString(data.nextState);
    if (nextState !== undefined && nextState !== stateId) return true;
  }
  return false;
}

/**
 * Classify every gated transition in the durable event log.
 *
 * Each VERIFY_EVALUATED event is one gate evaluation. We group by
 * (beadId, stateId, actionId) and keep the LAST evaluation per key (a retried
 * transition's final verdict is the binding one). Pure — no I/O.
 */
export function analyzeGateOutcomes(events: DomainEvent[]): GateOutcomeAnalysis {
  const byKey = new Map<string, GateTransitionAnalysis>();

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.type !== DomainEventName.VERIFY_EVALUATED) continue;
    const data = ev.data;

    const beadId = asString(data.beadId) ?? '';
    const stateId = asString(data.stateId) ?? '';
    const actionId = asString(data.actionId) ?? '';
    const blocked = data.blocked === true;
    const perTool = readPerTool(data);

    let outcome: GateOutcomeKind;
    let blockingTools: BlockingTool[];

    if (!blocked) {
      // Not blocked ⇒ the gate passed (all perTool PASS / NOT_APPLICABLE) and a
      // real advance must follow in the durable log.
      outcome = GateOutcomeKindVocab.ADVANCED;
      blockingTools = [];
    } else {
      // Blocked. Distinguish absent (no verdict) from present-but-FAIL.
      const fails = perTool.filter(p => p.verdict === VerifyVerdict.FAIL);
      const absent = perTool.filter(
        p => p.verdict === undefined && p.reasons.some(r => /not\s+invoked|did[\s-]?not[\s-]?run/i.test(r))
      );
      if (fails.length > 0) {
        outcome = GateOutcomeKindVocab.BLOCKED_FAIL;
        blockingTools = fails.map(p => ({ tool: p.tool, verdict: p.verdict, reasons: p.reasons }));
      } else {
        // Treat any verdict-less blocking entry as an absent/did-not-run block.
        const absentEntries = absent.length > 0 ? absent : perTool.filter(p => p.verdict === undefined);
        outcome = GateOutcomeKindVocab.BLOCKED_ABSENT;
        blockingTools = absentEntries.map(p => ({ tool: p.tool, verdict: p.verdict, reasons: p.reasons }));
      }
    }

    const advanced = outcome === GateOutcomeKindVocab.ADVANCED && hasAdvanceAfter(events, i, beadId, stateId, actionId);

    byKey.set(transitionKey(beadId, stateId, actionId), {
      beadId,
      stateId,
      actionId,
      outcome,
      advanced,
      blockingTools
    });
  }

  return { transitions: [...byKey.values()] };
}

// ---------------------------------------------------------------------------
// Assertion helpers — used by the live-run driver to assert the THREE outcomes
// against the durable analysis. Each THROWS a descriptive Error on mismatch so
// the driver exits non-zero with a clear diff (and so the unit test can prove
// non-vacuity).
// ---------------------------------------------------------------------------

function transitionsForBead(analysis: GateOutcomeAnalysis, beadId: string): GateTransitionAnalysis[] {
  return analysis.transitions.filter(t => t.beadId === beadId);
}

function describe(analysis: GateOutcomeAnalysis): string {
  return JSON.stringify(analysis.transitions, null, 2);
}

/**
 * Assert that the bead had a gated transition that ADVANCED (gate passed on
 * present + valid artifacts, and a real state advance followed).
 */
export function assertAdvancedOnValid(analysis: GateOutcomeAnalysis, beadId: string): GateTransitionAnalysis {
  const candidates = transitionsForBead(analysis, beadId);
  const hit = candidates.find(t => t.outcome === GateOutcomeKindVocab.ADVANCED && t.advanced);
  if (!hit) {
    throw new Error(
      `assertAdvancedOnValid FAILED for bead ${beadId}: expected a gated transition with ` +
        `outcome 'advanced' AND a durable state advance, but found ` +
        `${candidates.length === 0 ? 'no gated transitions' : describe({ transitions: candidates })}.`
    );
  }
  return hit;
}

/**
 * Assert that the bead's transition BLOCKED because a required tool's artifact
 * was ABSENT (the tool did NOT run — perTool entry with no verdict + a
 * "not invoked" reason).
 */
export function assertBlockedOnAbsentArtifact(
  analysis: GateOutcomeAnalysis,
  beadId: string,
  toolName: string
): GateTransitionAnalysis {
  const candidates = transitionsForBead(analysis, beadId);
  const hit = candidates.find(
    t =>
      t.outcome === GateOutcomeKindVocab.BLOCKED_ABSENT &&
      !t.advanced &&
      t.blockingTools.some(bt => bt.tool === toolName && bt.verdict === undefined)
  );
  if (!hit) {
    throw new Error(
      `assertBlockedOnAbsentArtifact FAILED for bead ${beadId}, tool ${toolName}: expected a ` +
        `transition BLOCKED by an absent/did-not-run '${toolName}' (no verdict), but found ` +
        `${candidates.length === 0 ? 'no gated transitions' : describe({ transitions: candidates })}.`
    );
  }
  return hit;
}

/**
 * Assert that the bead's transition BLOCKED because a present artifact FAILed
 * validation — and that the named tool's verdict ('FAIL') + reasons are
 * surfaced in the durable analysis (e.g. an injected sonarqube qualityGate
 * ERROR). Returns the matched transition so the caller can further inspect the
 * reasons.
 */
export function assertBlockedOnPresentButFail(
  analysis: GateOutcomeAnalysis,
  beadId: string,
  toolName: string
): GateTransitionAnalysis {
  const candidates = transitionsForBead(analysis, beadId);
  const hit = candidates.find(
    t =>
      t.outcome === GateOutcomeKindVocab.BLOCKED_FAIL &&
      !t.advanced &&
      t.blockingTools.some(
        bt => bt.tool === toolName && bt.verdict === VerifyVerdict.FAIL && bt.reasons.length > 0
      )
  );
  if (!hit) {
    throw new Error(
      `assertBlockedOnPresentButFail FAILED for bead ${beadId}, tool ${toolName}: expected a ` +
        `transition BLOCKED with '${toolName}' verdict FAIL and non-empty reasons, but found ` +
        `${candidates.length === 0 ? 'no gated transitions' : describe({ transitions: candidates })}.`
    );
  }
  return hit;
}
