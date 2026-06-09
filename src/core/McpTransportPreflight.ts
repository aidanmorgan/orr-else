/**
 * MCP transport preflight — coordinator-side bridge health check.
 *
 * Before the Supervisor spawns a worker into a state whose requiredTools
 * include MCP-backed project tools, it calls McpBridgeHealthService.check() to
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
