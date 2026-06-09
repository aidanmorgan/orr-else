/**
 * LoopDetector — pi-experiment-6q0y.49
 *
 * Always-on structural loop detection for the Orr Else harness.
 *
 * DESIGN:
 *   - Fingerprint counters for five loop classes (AC3):
 *       1. toolCall:   identical normalized tool call (name + stable-args hash).
 *       2. toolCallSemantic: same name + normalized-schema args (after key-sort + null-strip).
 *       3. failedRoute:  failed / blocked coordinator route event by (beadId, stateId, route).
 *       4. verifierFail: verifier gate rejection by (beadId, stateId) with optional verifier id.
 *       5. blocker:      same-state self-loop with same blocker fingerprint.
 *
 *   - ALWAYS ON — no config flag to disable; YAML may override maxLoops per scope.
 *     Default maxLoops = 10 (LOOP_DETECTION_DEFAULT_MAX_LOOPS).
 *
 *   - Fingerprint state is reconstructable from event-store replay (AC7): the
 *     LoopDetector feeds LOOP_DETECTED + LOOP_WARNING_DIAGNOSTIC events into the
 *     event store; on restart the counters are rebuilt by replaying these events.
 *     `rebuildFromEvents()` is called with the full event log on startup.
 *
 *   - Deterministic: NO Date.now() / Math.random() in fingerprint logic.
 *
 *   - No raw prompt/tool bodies in fingerprints or events (AC1 / AC5).
 */

import { createHash } from 'node:crypto';
import type { HarnessConfig } from './ConfigLoader.js';
import type { EventStore } from './EventStore.js';
import { DomainEventName } from '../constants/domain.js';
import type { DomainEvent } from './EventStoreTypes.js';

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** Default maximum repetitions before a loop fires. YAML may override via loopDetection.maxLoops. */
export const LOOP_DETECTION_DEFAULT_MAX_LOOPS = 10;

/** Supported loop scopes for YAML loopDetection config (AC2 / AC4). */
export const LOOP_DETECTION_SUPPORTED_SCOPES = [
  'toolCall',
  'toolCallSemantic',
  'failedRoute',
  'verifierFail',
  'blocker',
] as const;

export type LoopScope = typeof LOOP_DETECTION_SUPPORTED_SCOPES[number];

// ---------------------------------------------------------------------------
// Check result
// ---------------------------------------------------------------------------

export interface LoopCheckResult {
  /** Whether the loop threshold has been exceeded. */
  exceeded: boolean;
  /** The scope that was exceeded (when exceeded=true). */
  scope?: LoopScope;
  /** Fingerprint key (no raw bodies). */
  fingerprint?: string;
  /** Count at the time of the check. */
  count?: number;
  /** Configured max for this scope. */
  max?: number;
  /** Configured route event to emit on exceed. */
  routeEvent?: string;
  /** Whether a warning has already been emitted for this fingerprint. */
  warningEmitted?: boolean;
}

// ---------------------------------------------------------------------------
// Internal fingerprint helpers — NO raw bodies included
// ---------------------------------------------------------------------------

/**
 * Deterministically hash a value (no raw content in output).
 * Returns a 16-char hex prefix — short, stable, collision-resistant.
 */
function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/**
 * Normalize tool arguments for fingerprinting (AC1):
 *   - JSON-stringify after sorting keys alphabetically.
 *   - Strip undefined/null values.
 *   - No raw string content from argument values that are strings (only shape).
 *   - For identical calls: use the JSON string directly (exact equality).
 *   - For semantic calls: strip null-ish scalar values, keep structural keys.
 */
function normalizeArgsIdentical(args: unknown): string {
  if (args === null || args === undefined) return '{}';
  if (typeof args !== 'object') return String(args);
  const sortKeys = (obj: unknown): unknown => {
    if (obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(sortKeys);
    const keys = Object.keys(obj as Record<string, unknown>).sort();
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      const v = (obj as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = sortKeys(v);
    }
    return out;
  };
  try { return JSON.stringify(sortKeys(args)); } catch { return '[unserializable]'; }
}

function normalizeArgsSemantic(args: unknown): string {
  // Semantic normalization: canonicalize FORMAT only (object key order, strip undefined/null)
  // but PRESERVE argument VALUES. So {path:'a'} and {path:'b'} produce DIFFERENT fingerprints
  // (different content = different work), while {path:'a', x:1} and {x:1, path:'a'} produce
  // the SAME fingerprint (key-order only = format-insensitive equivalence).
  //
  // The semantic class catches genuinely-equivalent repeats (same content, different key order),
  // NOT distinct-content iteration. The IDENTICAL class handles exact-arg repeats.
  if (args === null || args === undefined) return '{}';
  if (typeof args !== 'object') return String(args);
  const normalize = (obj: unknown): unknown => {
    if (obj === null) return null;
    if (typeof obj !== 'object') return obj; // preserve all scalar values (strings, numbers, booleans)
    if (Array.isArray(obj)) return obj.filter(v => v !== null && v !== undefined).map(normalize);
    const keys = Object.keys(obj as Record<string, unknown>).sort();
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      const v = (obj as Record<string, unknown>)[k];
      if (v !== null && v !== undefined) out[k] = normalize(v);
    }
    return out;
  };
  try { return JSON.stringify(normalize(args)); } catch { return '[unserializable]'; }
}

// ---------------------------------------------------------------------------
// LoopDetector
// ---------------------------------------------------------------------------

/** Resolved config for one loop scope. */
interface ScopeConfig {
  maxLoops: number;
  routeEvent: string;
}

export class LoopDetector {
  /** finger → count */
  private readonly counts = new Map<string, number>();
  /** finger → true if warning already emitted */
  private readonly warnedFingerprints = new Set<string>();
  /**
   * Fingerprints for which the LOOP_DETECTED event + route have already been
   * emitted. AC5: exactly one route event per loop fingerprint — subsequent
   * exceeds for the same fingerprint do NOT re-emit the route or LOOP_DETECTED.
   */
  private readonly routedFingerprints = new Set<string>();

  constructor(
    private readonly config: HarnessConfig,
    private readonly eventStore: EventStore
  ) {}

  // ── Scope config resolution ─────────────────────────────────────────────────

  /**
   * Resolve the effective maxLoops and routeEvent for a given scope.
   * Always returns a value — detection is always-on (AC2).
   */
  private resolveScope(scope: LoopScope): ScopeConfig {
    const ld = (this.config.settings as Record<string, unknown>)['loopDetection'] as
      | Record<string, unknown> | undefined;
    const globalMax = typeof ld?.['maxLoops'] === 'number'
      ? (ld['maxLoops'] as number)
      : LOOP_DETECTION_DEFAULT_MAX_LOOPS;
    const perScope = (ld as Record<string, unknown> | undefined)?.[scope] as
      | Record<string, unknown> | undefined;
    const max = typeof perScope?.['maxLoops'] === 'number'
      ? (perScope['maxLoops'] as number)
      : globalMax;
    const routeEvent = typeof perScope?.['routeEvent'] === 'string'
      ? (perScope['routeEvent'] as string)
      : (typeof ld?.['defaultRouteEvent'] === 'string'
        ? (ld['defaultRouteEvent'] as string)
        : 'FAILURE');
    return { maxLoops: max, routeEvent };
  }

  // ── Counter management ──────────────────────────────────────────────────────

  /** Increment the counter for a fingerprint and return the new count. */
  private increment(fp: string): number {
    const next = (this.counts.get(fp) ?? 0) + 1;
    this.counts.set(fp, next);
    return next;
  }

  /** Return current count without incrementing. */
  private getCount(fp: string): number {
    return this.counts.get(fp) ?? 0;
  }

  /** Reset counters for all fingerprints that start with the given prefix. */
  public resetPrefix(prefix: string): void {
    for (const k of this.counts.keys()) {
      if (k.startsWith(prefix)) {
        this.counts.delete(k);
        this.warnedFingerprints.delete(k);
        this.routedFingerprints.delete(k);
      }
    }
  }

  /**
   * Reset loop counters for a bead when it advances to a new state (genuine
   * progress). A loop is "stuck repeating within a state without progressing";
   * once a bead advances, its prior loop counts are no longer meaningful.
   *
   * Called from extension.ts on a successful advance transition (AC3b).
   */
  public resetOnAdvance(beadId: string): void {
    // Loop fingerprints are prefixed with their raw key (hashed), so we cannot
    // filter by beadId directly. Instead we clear ALL counts for this bead by
    // rebuilding the map without fingerprints whose source raw key contains beadId.
    // Since fingerprints are SHA-256 hashes, we track raw-key→fp in a side map,
    // OR we take the simpler approach: clear all counts (session-scoped detector,
    // one bead per worker-mode session).
    //
    // In worker mode there is exactly one beadId per session (the bead being worked).
    // Clearing all counts on advance is correct: the bead is in a new state, so
    // all prior loop accumulators are stale. Non-advance events (failures, blocks)
    // have their own fingerprints and will restart from 0 in the new state.
    this.counts.clear();
    this.warnedFingerprints.clear();
    this.routedFingerprints.clear();
  }

  // ── Loop check helpers ──────────────────────────────────────────────────────

  private checkAndBuild(fp: string, scope: LoopScope, count: number): LoopCheckResult {
    const { maxLoops, routeEvent } = this.resolveScope(scope);
    const warningEmitted = this.warnedFingerprints.has(fp);
    if (count >= maxLoops) {
      return { exceeded: true, scope, fingerprint: fp, count, max: maxLoops, routeEvent, warningEmitted };
    }
    // Always return fingerprint+count so callers can check warning thresholds.
    return { exceeded: false, scope, fingerprint: fp, count, max: maxLoops, routeEvent, warningEmitted };
  }

  // ── AC7: Replay from event store ────────────────────────────────────────────

  /**
   * Reconstruct loop-detection counters from the event log.
   * Called at coordinator startup after loading the event store for a bead.
   *
   * We replay LOOP_DETECTED and LOOP_WARNING_DIAGNOSTIC events; each carries
   * the fingerprint and the count at the time of emission. We take the MAX
   * seen count per fingerprint so restarts accumulate correctly.
   */
  public rebuildFromEvents(events: DomainEvent[]): void {
    for (const ev of events) {
      const isLoop = ev.type === DomainEventName.LOOP_DETECTED;
      const isWarn = ev.type === DomainEventName.LOOP_WARNING_DIAGNOSTIC;
      if (!isLoop && !isWarn) continue;
      const data = ev.data as Record<string, unknown> | undefined;
      if (!data) continue;
      const fp = typeof data['fingerprint'] === 'string' ? data['fingerprint'] : undefined;
      const count = typeof data['count'] === 'number' ? data['count'] : undefined;
      if (!fp || count === undefined) continue;
      if (count > (this.counts.get(fp) ?? 0)) {
        this.counts.set(fp, count);
      }
      if (isWarn) {
        this.warnedFingerprints.add(fp);
      }
    }
  }

  // ── Public detection API ────────────────────────────────────────────────────

  /**
   * Record an identical tool call and check for a loop.
   * Fingerprint = sha256(toolName + '|identical|' + sortedArgs).
   *
   * Returns a LoopCheckResult. When exceeded=true the caller must emit the
   * route event. When exceeded=false but warningEmitted=false and count is at
   * the warning threshold, the caller should emit the warning diagnostic.
   */
  public checkToolCall(opts: {
    toolName: string;
    args: unknown;
    beadId?: string;
    stateId?: string;
    actionId?: string;
  }): LoopCheckResult {
    const raw = `${opts.toolName}|identical|${opts.beadId ?? '_'}|${opts.stateId ?? '_'}|${normalizeArgsIdentical(opts.args)}`;
    const fp = shortHash(raw);
    const count = this.increment(fp);
    return this.checkAndBuild(fp, 'toolCall', count);
  }

  /**
   * Record a semantically-equivalent tool call (same name + structural args, not content).
   */
  public checkToolCallSemantic(opts: {
    toolName: string;
    args: unknown;
    beadId?: string;
    stateId?: string;
    actionId?: string;
  }): LoopCheckResult {
    const raw = `${opts.toolName}|semantic|${opts.beadId ?? '_'}|${opts.stateId ?? '_'}|${normalizeArgsSemantic(opts.args)}`;
    const fp = shortHash(raw);
    const count = this.increment(fp);
    return this.checkAndBuild(fp, 'toolCallSemantic', count);
  }

  /**
   * Record a failed/blocked coordinator route event and check for a loop.
   * Fingerprint = sha256(beadId + stateId + routeEvent).
   */
  public checkFailedRoute(opts: {
    beadId: string;
    stateId: string;
    routeEvent: string;
  }): LoopCheckResult {
    const raw = `failedRoute|${opts.beadId}|${opts.stateId}|${opts.routeEvent}`;
    const fp = shortHash(raw);
    const count = this.increment(fp);
    return this.checkAndBuild(fp, 'failedRoute', count);
  }

  /**
   * Record a verifier gate failure and check for a loop.
   * Fingerprint = sha256(beadId + stateId + verifierId?).
   */
  public checkVerifierFail(opts: {
    beadId: string;
    stateId: string;
    verifierId?: string;
  }): LoopCheckResult {
    const raw = `verifierFail|${opts.beadId}|${opts.stateId}|${opts.verifierId ?? '_'}`;
    const fp = shortHash(raw);
    const count = this.increment(fp);
    return this.checkAndBuild(fp, 'verifierFail', count);
  }

  /**
   * Record a same-state blocker (self-loop with same summary fingerprint).
   * Fingerprint = sha256(beadId + stateId + errorCategory).
   * errorCategory = capped first 100 chars of blocker summary (no raw body).
   */
  public checkBlocker(opts: {
    beadId: string;
    stateId: string;
    summary?: string;
  }): LoopCheckResult {
    const cappedSummary = (opts.summary ?? '').slice(0, 100);
    const raw = `blocker|${opts.beadId}|${opts.stateId}|${cappedSummary}`;
    const fp = shortHash(raw);
    const count = this.increment(fp);
    return this.checkAndBuild(fp, 'blocker', count);
  }

  // ── Event emission ───────────────────────────────────────────────────────────

  /**
   * Emit LOOP_WARNING_DIAGNOSTIC (AC6) — one warning may precede the hard route.
   * Does NOT emit if already warned for this fingerprint (exactly one warning).
   * No raw prompt/tool bodies — only structural fields.
   */
  public async emitWarning(result: LoopCheckResult, context: {
    beadId?: string;
    stateId?: string;
    actionId?: string;
  }): Promise<void> {
    // Guard: already warned for this fingerprint (check the live set, not the snapshot result).
    if (!result.fingerprint || this.warnedFingerprints.has(result.fingerprint)) return;
    this.warnedFingerprints.add(result.fingerprint);
    await this.eventStore.record(DomainEventName.LOOP_WARNING_DIAGNOSTIC, {
      scope: result.scope!,
      fingerprint: result.fingerprint!,
      count: result.count!,
      max: result.max!,
      routeEvent: result.routeEvent!,
      beadId: context.beadId,
      stateId: context.stateId,
      actionId: context.actionId,
    }).catch(() => {});
  }

  /**
   * Emit LOOP_DETECTED (AC5) — structured evidence, no raw bodies.
   * Exactly one emission per fingerprint (routed-once guard). Returns true if
   * this is the first route for this fingerprint (caller SHOULD emit the route
   * event); returns false if already routed (caller must NOT re-emit the route).
   */
  public async emitLoopDetected(result: LoopCheckResult, context: {
    beadId?: string;
    stateId?: string;
    actionId?: string;
  }): Promise<boolean> {
    if (!result.exceeded || !result.fingerprint) return false;
    // AC5: exactly one route event per loop — guard against re-emission.
    if (this.routedFingerprints.has(result.fingerprint)) return false;
    this.routedFingerprints.add(result.fingerprint);
    await this.eventStore.record(DomainEventName.LOOP_DETECTED, {
      scope: result.scope!,
      fingerprint: result.fingerprint!,
      count: result.count!,
      max: result.max!,
      routeEvent: result.routeEvent!,
      beadId: context.beadId,
      stateId: context.stateId,
      actionId: context.actionId,
    }).catch(() => {});
    return true;
  }

  /**
   * Check whether the route has already been emitted for this fingerprint.
   * Used by sites that need to block repeated calls without re-emitting.
   */
  public isRouted(fingerprint: string): boolean {
    return this.routedFingerprints.has(fingerprint);
  }
}
