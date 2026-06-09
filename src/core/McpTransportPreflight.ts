/**
 * MCP transport preflight — coordinator-side bridge health check.
 *
 * Before the Supervisor spawns a worker into a state whose requiredTools
 * include MCP-backed project tools, it calls checkMcpBridgeHealth() to
 * verify that the @modelcontextprotocol/sdk module can be loaded.
 *
 * Design goals (s3wp.32):
 *  - SINGLE health event recorded per unique failure key; repeated spawn-loop
 *    iterations reuse the cached result rather than rediscovering the same
 *    module error per worker.
 *  - GENERIC: no consuming-project specifics; any harness with MCP-type project tools
 *    benefits from the same protection.
 *  - UNAVAILABLE marking: affected tool names are exposed on the health result
 *    so callers can gate spawning without needing to re-probe.
 *  - REMEDIATION: the structured health event names the failing tool family +
 *    underlying module/service once, so the coordinator's event log is the
 *    single source of truth.
 */

/** Health result for the MCP bridge module probe. */
export interface McpBridgeHealth {
  /** true = bridge module loaded successfully; affected/message are empty. */
  healthy: boolean;
  /**
   * MCP-backed project tool names that are affected by the failure.
   * Empty when healthy=true.
   */
  affectedToolNames: string[];
  /**
   * Human-readable failure reason (module load error message).
   * undefined when healthy=true.
   */
  message?: string;
  /**
   * Error class name (e.g. 'Error', 'MODULE_NOT_FOUND') for structured
   * diagnostic filtering.  undefined when healthy=true.
   */
  errorType?: string;
  /**
   * Remediation hint surfaced once in the domain event and harness_status.
   * undefined when healthy=true.
   */
  remediation?: string;
}

/** Cached result key — unique per failure message so distinct errors each get one event. */
type HealthCacheKey = string;

const BRIDGE_MODULES_TO_PROBE = [
  '@modelcontextprotocol/sdk/client/index.js'
] as const;

function buildHealthCacheKey(errorMessage: string): HealthCacheKey {
  // Normalise path-specific details (node_modules paths vary) so the same
  // logical failure produces the same cache key across restarts.
  const normalised = errorMessage
    .replace(/Cannot find module '.*?'/, "Cannot find module '<module>'")
    .replace(/\bnode_modules\/[^\s'"]*/g, 'node_modules/<path>')
    .slice(0, 200);
  return normalised;
}

/** Injectable probe function for testing. Defaults to real module probe. */
type BridgeProbe = () => Promise<{ ok: boolean; errorMessage?: string; errorType?: string }>;
let _activeBridgeProbe: BridgeProbe | undefined;

/** Override the bridge probe for testing. Pass undefined to restore the default real probe. */
export function setBridgeProbeForTest(probe: BridgeProbe | undefined): void {
  _activeBridgeProbe = probe;
}

/**
 * Return the current module-level test probe (undefined if none is set).
 * Used by McpBridgeHealthService as a fallback when no instance probe is set,
 * so that tests calling setBridgeProbeForTest() work with the per-runtime service.
 */
export function getGlobalBridgeProbeForTest(): BridgeProbe | undefined {
  return _activeBridgeProbe;
}

/**
 * Probe whether the @modelcontextprotocol/sdk bridge module can be loaded.
 *
 * Returns a structured health result.  Never throws.
 */
async function probeMcpBridgeModule(): Promise<{ ok: boolean; errorMessage?: string; errorType?: string }> {
  if (_activeBridgeProbe) return _activeBridgeProbe();
  for (const mod of BRIDGE_MODULES_TO_PROBE) {
    try {
      // Dynamic import so module-not-found errors are catchable at runtime.
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
 * In-process cache keyed by normalised error message → McpBridgeHealth.
 * Ensures at most one probe per unique failure per process lifetime.
 */
const healthCache = new Map<HealthCacheKey, McpBridgeHealth>();

/** A successful probe result is also cached to avoid re-probing every scan cycle. */
const HEALTHY_CACHE_KEY = '__healthy__';

/**
 * Check MCP bridge health for the given set of MCP-backed tool names.
 *
 * If the bridge is healthy (or all tools are optional), returns a healthy result.
 * If the bridge fails, records the failure once (per unique error key) and
 * returns an unhealthy result with the affected tool names.
 *
 * @param mcpToolNames - Names of MCP-backed project tools relevant to this check.
 * @param recordEvent - Callback to record the domain event (called at most once per cache miss).
 */
export async function checkMcpBridgeHealth(
  mcpToolNames: string[],
  recordEvent: (eventData: Record<string, unknown>) => Promise<void>
): Promise<McpBridgeHealth> {
  if (mcpToolNames.length === 0) {
    return { healthy: true, affectedToolNames: [] };
  }

  // Fast path: cached healthy result
  if (healthCache.has(HEALTHY_CACHE_KEY)) {
    return healthCache.get(HEALTHY_CACHE_KEY)!;
  }

  // Probe the bridge module
  const probe = await probeMcpBridgeModule();

  if (probe.ok) {
    const healthy: McpBridgeHealth = { healthy: true, affectedToolNames: [] };
    healthCache.set(HEALTHY_CACHE_KEY, healthy);
    return healthy;
  }

  // Build the unhealthy result
  const errorMessage = probe.errorMessage ?? 'Unknown MCP bridge error';
  const cacheKey = buildHealthCacheKey(errorMessage);

  // Reuse cached unhealthy result (but update affected tools list to include new callers)
  if (healthCache.has(cacheKey)) {
    const cached = healthCache.get(cacheKey)!;
    // Merge new tool names without duplicates
    const mergedNames = [...new Set([...cached.affectedToolNames, ...mcpToolNames])];
    if (mergedNames.length !== cached.affectedToolNames.length) {
      const updated: McpBridgeHealth = { ...cached, affectedToolNames: mergedNames };
      healthCache.set(cacheKey, updated);
      return updated;
    }
    return cached;
  }

  const remediation =
    'Install @modelcontextprotocol/sdk for the harness runtime environment ' +
    '(npm install --prefix .pi/npm @modelcontextprotocol/sdk), then restart the coordinator. ' +
    'MCP-backed project tools will remain unavailable until the bridge module resolves.';

  const unhealthy: McpBridgeHealth = {
    healthy: false,
    affectedToolNames: [...mcpToolNames],
    message: errorMessage,
    errorType: probe.errorType,
    remediation
  };
  healthCache.set(cacheKey, unhealthy);

  // Record one domain event for this unique failure — NOT per worker.
  await recordEvent({
    healthy: false,
    affectedToolNames: mcpToolNames,
    errorMessage,
    errorType: probe.errorType,
    remediation
  }).catch(() => {
    // Best-effort event recording — never block the preflight result.
  });

  return unhealthy;
}

/** Reset the health cache (used in tests to simulate fresh probes). */
export function resetMcpBridgeHealthCache(): void {
  healthCache.clear();
}

/**
 * Given a set of required tool names and the full project tool config,
 * return the names of the MCP-backed tools that are required.
 */
export function mcpBackedRequiredToolNames(
  requiredToolNames: string[],
  projectToolConfigs: Array<{ name: string; type: string }>
): string[] {
  const mcpNames = new Set(
    projectToolConfigs
      .filter(t => t.type === 'mcp')
      .map(t => t.name)
  );
  return requiredToolNames.filter(name => mcpNames.has(name));
}
