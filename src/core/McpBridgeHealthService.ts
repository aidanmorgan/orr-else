/**
 * McpBridgeHealthService — per-runtime MCP bridge probe and health cache.
 *
 * The composition root creates one instance per runtime and injects it wherever
 * bridge health is checked (BeadSpawnCoordinator, extension.ts). The probe is
 * purely instance-owned: inject via setProbe() or the constructor; no module-level
 * globals are used.
 *
 * Design mirrors the s3wp.32 design goals:
 *  - SINGLE health event recorded per unique failure key
 *  - Cached probe results reused across spawn-loop iterations
 *  - Generic: no consuming-project specifics
 */

import {
  mcpBackedRequiredToolNames,
  type McpBridgeHealth,
} from './McpTransportPreflight.js';

export type { McpBridgeHealth };
export { mcpBackedRequiredToolNames };

/** Injectable probe function for testing. */
export type BridgeProbe = () => Promise<{ ok: boolean; errorMessage?: string; errorType?: string }>;

/** Cached result key — unique per failure message. */
type HealthCacheKey = string;

const BRIDGE_MODULES_TO_PROBE = [
  '@modelcontextprotocol/sdk/client/index.js'
] as const;

function buildHealthCacheKey(errorMessage: string): HealthCacheKey {
  const normalised = errorMessage
    .replace(/Cannot find module '.*?'/, "Cannot find module '<module>'")
    .replace(/\bnode_modules\/[^\s'"]*/g, 'node_modules/<path>')
    .slice(0, 200);
  return normalised;
}

const HEALTHY_CACHE_KEY = '__healthy__';

const REMEDIATION =
  'Install @modelcontextprotocol/sdk for the harness runtime environment ' +
  '(npm install --prefix .pi/npm @modelcontextprotocol/sdk), then restart the coordinator. ' +
  'MCP-backed project tools will remain unavailable until the bridge module resolves.';

/**
 * Per-runtime MCP bridge health service.
 *
 * Owns the probe cache and bridge probe — state is NOT shared with other runtimes.
 * Tests create fresh instances and inject probes via setProbe().
 */
export class McpBridgeHealthService {
  private readonly healthCache = new Map<HealthCacheKey, McpBridgeHealth>();
  private bridgeProbe: BridgeProbe | undefined;

  /**
   * Override the bridge probe function.
   * In production this is left undefined (real dynamic-import probe runs).
   * In tests, inject a fake probe via this method or the constructor.
   */
  public setProbe(probe: BridgeProbe | undefined): void {
    this.bridgeProbe = probe;
  }

  /**
   * Probe whether the @modelcontextprotocol/sdk bridge module can be loaded.
   * Returns a structured health result. Never throws.
   */
  private async probeModule(): Promise<{ ok: boolean; errorMessage?: string; errorType?: string }> {
    if (this.bridgeProbe) return this.bridgeProbe();
    for (const mod of BRIDGE_MODULES_TO_PROBE) {
      try {
        await import(mod);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const errorType = error instanceof Error ? error.constructor.name : typeof error;
        return { ok: false, errorMessage: message, errorType };
      }
    }
    return { ok: true };
  }

  /**
   * Check MCP bridge health for the given set of MCP-backed tool names.
   *
   * Identical contract to the module-level checkMcpBridgeHealth() in
   * McpTransportPreflight.ts, but with per-instance cache instead of the
   * module-level healthCache.
   */
  async check(
    mcpToolNames: string[],
    recordEvent: (eventData: Record<string, unknown>) => Promise<void>
  ): Promise<McpBridgeHealth> {
    if (mcpToolNames.length === 0) {
      return { healthy: true, affectedToolNames: [] };
    }

    // Fast path: cached healthy result
    if (this.healthCache.has(HEALTHY_CACHE_KEY)) {
      return this.healthCache.get(HEALTHY_CACHE_KEY)!;
    }

    const probe = await this.probeModule();

    if (probe.ok) {
      const healthy: McpBridgeHealth = { healthy: true, affectedToolNames: [] };
      this.healthCache.set(HEALTHY_CACHE_KEY, healthy);
      return healthy;
    }

    const errorMessage = probe.errorMessage ?? 'Unknown MCP bridge error';
    const cacheKey = buildHealthCacheKey(errorMessage);

    if (this.healthCache.has(cacheKey)) {
      const cached = this.healthCache.get(cacheKey)!;
      const mergedNames = [...new Set([...cached.affectedToolNames, ...mcpToolNames])];
      if (mergedNames.length !== cached.affectedToolNames.length) {
        const updated: McpBridgeHealth = { ...cached, affectedToolNames: mergedNames };
        this.healthCache.set(cacheKey, updated);
        return updated;
      }
      return cached;
    }

    const unhealthy: McpBridgeHealth = {
      healthy: false,
      affectedToolNames: [...mcpToolNames],
      message: errorMessage,
      errorType: probe.errorType,
      remediation: REMEDIATION
    };
    this.healthCache.set(cacheKey, unhealthy);

    await recordEvent({
      healthy: false,
      affectedToolNames: mcpToolNames,
      errorMessage,
      errorType: probe.errorType,
      remediation: REMEDIATION
    }).catch(() => {
      // Best-effort event recording — never block the preflight result.
    });

    return unhealthy;
  }

  /**
   * Reset the health cache (used in tests to simulate fresh probes).
   * With per-instance caches, tests can simply create a new McpBridgeHealthService
   * instead of calling this method.
   */
  public resetCache(): void {
    this.healthCache.clear();
  }

  /**
   * Return the most recently cached health result, or undefined if no probe
   * has run yet. Used by Supervisor.getMcpBridgeHealth().
   */
  public getCachedHealth(): McpBridgeHealth | undefined {
    // Return unhealthy result if any, otherwise healthy if cached, else undefined
    for (const [key, val] of this.healthCache) {
      if (key !== HEALTHY_CACHE_KEY && !val.healthy) return val;
    }
    return this.healthCache.get(HEALTHY_CACHE_KEY);
  }
}
