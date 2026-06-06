/**
 * Rate-limits repeated identical log entries by fingerprint.
 *
 * On the FIRST occurrence of a fingerprint (or when the prior window has
 * expired), observe() returns shouldLog:true and carries the PRIOR window's
 * suppressedCount so the caller can include an aggregate in the primary log
 * (e.g. "<event> (suppressed N similar in the last window)").
 *
 * Subsequent occurrences WITHIN the same window return shouldLog:false with
 * an incrementing suppressedCount.  That count is rolled into the NEXT
 * primary log when the window expires.
 *
 * This guarantees AT MOST ONE primary log + ONE aggregate per fingerprint per
 * window.  It affects ONLY human-facing log output — durable event-store
 * records are never gated by this class.
 *
 * Memory is bounded: entries whose window has expired are evicted on observe()
 * provided their suppressedCount has already been surfaced (i.e. a new
 * occurrence arrived to roll over the aggregate).  The map is also capped at
 * MAX_ENTRIES; when full, the oldest entry is evicted.
 *
 * Usage:
 *   const coalescer = new SignalNoiseCoalescer(TimeMs.MINUTE);
 *   const { shouldLog, suppressedCount } = coalescer.observe(fingerprint, Date.now());
 *   if (shouldLog) Logger.warn(..., ...(suppressedCount > 0 ? { suppressedCount } : {}));
 */
export interface CoalesceResult {
  /** True when this is the first occurrence (or window expired): caller should log. */
  shouldLog: boolean;
  /**
   * When shouldLog=true: the number of occurrences suppressed in the PRIOR window
   * (0 on the very first occurrence).
   * When shouldLog=false: the running count suppressed in the current window.
   */
  suppressedCount: number;
}

interface Entry {
  firstSeenMs: number;
  suppressedCount: number;
}

const MAX_ENTRIES = 256;

export class SignalNoiseCoalescer {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly windowMs: number) {}

  observe(fingerprint: string, nowMs: number = Date.now()): CoalesceResult {
    const existing = this.entries.get(fingerprint);

    if (!existing || nowMs - existing.firstSeenMs >= this.windowMs) {
      // Window expired (or first-ever occurrence).
      // Carry the prior window's suppressedCount into this primary log, then
      // reset the window.  The old entry is replaced in-place (eviction via
      // rollover) so its aggregate count is never lost.
      const priorSuppressed = existing ? existing.suppressedCount : 0;

      // Enforce map size cap before inserting a brand-new entry.
      if (!existing && this.entries.size >= MAX_ENTRIES) {
        const oldestKey = this.entries.keys().next().value;
        if (oldestKey !== undefined) this.entries.delete(oldestKey);
      }

      this.entries.set(fingerprint, { firstSeenMs: nowMs, suppressedCount: 0 });
      return { shouldLog: true, suppressedCount: priorSuppressed };
    }

    // Within window: suppress and increment counter.
    existing.suppressedCount++;
    return { shouldLog: false, suppressedCount: existing.suppressedCount };
  }
}
