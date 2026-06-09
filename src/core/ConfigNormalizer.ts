/**
 * ConfigNormalizer — v2 map-form collection normalization.
 *
 * Owns: normalizeV2MapCollections() — converts map-form tools, validationGates,
 * and states.<state>.actions to sorted arrays with canonical map-derived IDs.
 *
 * Also owns: mergeWithDefaults() — merge DEFAULTS with parsed config.
 *
 * Extracted from ConfigLoader as part of pi-experiment-amq0.5 decomposition.
 * ConfigLoader remains the public facade; this class holds only the normalization concern.
 */
import { isRecord, mergeReplacingArrays } from './RecordUtils.js';

export class ConfigNormalizer {
  /**
   * Merge a defaults object with a parsed config object, replacing arrays.
   */
  public mergeWithDefaults(
    defaults: Record<string, unknown>,
    parsed: unknown
  ): unknown {
    return mergeReplacingArrays(defaults, parsed as Record<string, unknown>);
  }

  /**
   * pi-experiment-0dgy AC4: Normalize v2 map-form collections to sorted arrays.
   *
   * Converts map-form tools, validationGates, and states.<state>.actions to
   * sorted arrays with canonical map-derived IDs. The sort is lexicographic on
   * the canonical ID (map key), ensuring deterministic resolved serialization.
   *
   * Called AFTER preValidateV2Admission (grammar/conflict validation already done)
   * and BEFORE AJV schema validation (which expects array form).
   *
   * Version-gated: only runs when version === 2.
   */
  public normalizeV2MapCollections(parsed: unknown): void {
    if (!isRecord(parsed)) return;

    // ── tools: map → sorted array with name = key ─────────────────────────
    const toolsRaw = parsed['tools'];
    if (isRecord(toolsRaw)) {
      const entries = Object.entries(toolsRaw as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
      parsed['tools'] = entries.map(([key, value]) => {
        if (!isRecord(value)) return value;
        const entry = { ...(value as Record<string, unknown>) };
        // Map key becomes the canonical name; inner name (if matching key) is normalized
        entry['name'] = key;
        return entry;
      });
    }

    // ── validationGates: map → sorted array with id = key ─────────────────
    const gatesRaw = parsed['validationGates'];
    if (isRecord(gatesRaw)) {
      const entries = Object.entries(gatesRaw as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
      parsed['validationGates'] = entries.map(([key, value]) => {
        if (!isRecord(value)) return value;
        const entry = { ...(value as Record<string, unknown>) };
        // Map key becomes the canonical id; inner id (if matching key) is normalized
        entry['id'] = key;
        return entry;
      });
    }

    // ── states.<state>.actions: map → sorted array with id = key ─────────
    const statesRaw = parsed['states'];
    if (isRecord(statesRaw)) {
      for (const [, stateRaw] of Object.entries(statesRaw as Record<string, unknown>)) {
        if (!isRecord(stateRaw)) continue;
        const actionsRaw = (stateRaw as Record<string, unknown>)['actions'];
        if (!isRecord(actionsRaw)) continue;
        const entries = Object.entries(actionsRaw as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
        (stateRaw as Record<string, unknown>)['actions'] = entries.map(([key, value]) => {
          if (!isRecord(value)) return value;
          const entry = { ...(value as Record<string, unknown>) };
          // Map key becomes the canonical id; inner id (if matching key) is normalized
          entry['id'] = key;
          return entry;
        });
      }
    }
  }
}
