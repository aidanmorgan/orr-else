/**
 * BackendReadiness — Cerdiwen backend readiness manifest schema + startup-lint module.
 *
 * PURPOSE
 * -------
 * Cerdiwen depends on operator-managed services that generic MCP readiness does not
 * cover: a Python LSP server, a codemap indexer, SonarQube, and a Chroma/reference-doc
 * backend. This module:
 *
 *   1. Defines the TypeScript types for a backend readiness manifest.
 *   2. Validates a raw manifest against the JSON Schema (via AJV, backed by the
 *      SchemaRegistry entry at harness.config.backendReadinessManifest).
 *   3. Runs TCP-connect probes for each backend entry and returns a sorted, structured
 *      result (name / required / ok / latencyMs / remediation).
 *
 * CONSTRAINTS
 * -----------
 * - Probes are TCP connect-only: no LLM calls, no Docker, no service startup.
 * - All probes complete within a configurable deadline (default 5 000 ms).
 * - Probe functions are injectable for testing (no real network in unit tests).
 *
 * WIRING
 * ------
 * This is the HARNESS-SIDE module only. Wiring into cerdiwen's harness.yaml is
 * bead 6q0y.34's responsibility.
 */

import * as net from 'node:net';
import AjvModule from 'ajv';
import addFormatsModule from 'ajv-formats';

const Ajv = AjvModule.default ?? AjvModule;
const addFormats = addFormatsModule.default ?? addFormatsModule;

// ---------------------------------------------------------------------------
// JSON Schema (canonical — also registered in SchemaRegistry)
// ---------------------------------------------------------------------------

/**
 * JSON Schema for a backend readiness manifest.
 *
 * A manifest is an object with a `backends` array. Each entry declares:
 *   - name:        unique service identifier
 *   - host:        hostname or IP (default: "localhost")
 *   - port:        TCP port to probe
 *   - required:    whether the harness must abort startup when this backend is down
 *   - remediation: human-readable fix hint (command or doc reference)
 *   - description: optional human-readable note
 */
export const BACKEND_READINESS_MANIFEST_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['backends'],
  additionalProperties: false,
  properties: {
    backends: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['name', 'port', 'required', 'remediation'],
        additionalProperties: false,
        properties: {
          name:        { type: 'string', minLength: 1 },
          host:        { type: 'string', minLength: 1 },
          port:        { type: 'integer', minimum: 1, maximum: 65535 },
          required:    { type: 'boolean' },
          remediation: { type: 'string', minLength: 1 },
          description: { type: 'string' }
        }
      }
    }
  }
} as const;

// ---------------------------------------------------------------------------
// TypeScript types
// ---------------------------------------------------------------------------

/** One backend entry in the readiness manifest. */
export interface BackendEntry {
  /** Unique service identifier, e.g. "python_lsp". */
  name: string;
  /** Hostname to probe. Defaults to "localhost" when omitted. */
  host?: string;
  /** TCP port to probe. */
  port: number;
  /** Whether a missing backend is a fatal startup failure. */
  required: boolean;
  /**
   * Remediation command or document reference surfaced in probe output.
   * Example: "cd /path && ./start_lsp.sh" or "See docs/backends.md".
   */
  remediation: string;
  /** Optional human-readable description. */
  description?: string;
}

/** A backend readiness manifest: a list of backend entries to probe. */
export interface BackendManifest {
  backends: BackendEntry[];
}

/** Result of probing one backend entry. */
export interface BackendProbeResult {
  /** Service identifier (matches BackendEntry.name). */
  name: string;
  /** Whether this backend is required for startup. */
  required: boolean;
  /** TCP probe outcome: true = port reachable, false = unreachable / timed-out. */
  ok: boolean;
  /** Round-trip latency in milliseconds. undefined when probe failed before connect. */
  latencyMs: number | undefined;
  /** Remediation command or document reference from the manifest entry. */
  remediation: string;
}

/**
 * Validation error for a malformed manifest.
 * Thrown by validateManifest() when the raw value does not satisfy the schema.
 */
export class BackendManifestValidationError extends Error {
  constructor(
    message: string,
    public readonly validationErrors: string[]
  ) {
    super(message);
    this.name = 'BackendManifestValidationError';
  }
}

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

// Compile AJV validator once at module load (fail-fast on bad schema).
const _ajv = new Ajv({ allErrors: true });
addFormats(_ajv);
const _validateManifest = _ajv.compile(BACKEND_READINESS_MANIFEST_SCHEMA);

/**
 * Validate a raw value against the backend readiness manifest schema.
 *
 * @throws BackendManifestValidationError when the value does not conform.
 * @returns The typed BackendManifest when valid.
 */
export function validateManifest(raw: unknown): BackendManifest {
  const valid = _validateManifest(raw);
  if (!valid) {
    const errors = (_validateManifest.errors ?? []).map(
      e => `${e.instancePath || '(root)'}: ${e.message ?? 'validation error'}`
    );
    throw new BackendManifestValidationError(
      `Backend readiness manifest is invalid: ${errors.join('; ')}`,
      errors
    );
  }
  return raw as BackendManifest;
}

// ---------------------------------------------------------------------------
// TCP probe
// ---------------------------------------------------------------------------

/**
 * Injectable probe function type. Defaults to a real TCP connect probe.
 * Tests inject a fake probe to avoid real network calls.
 */
export type TcpProbe = (host: string, port: number, timeoutMs: number) => Promise<{ ok: boolean; latencyMs: number | undefined }>;

/**
 * Real TCP probe: attempts a TCP connection and resolves with ok/latencyMs.
 * Never throws — all errors are caught and returned as { ok: false }.
 */
export async function realTcpProbe(
  host: string,
  port: number,
  timeoutMs: number
): Promise<{ ok: boolean; latencyMs: number | undefined }> {
  return new Promise(resolve => {
    const start = Date.now();
    const socket = new net.Socket();
    let settled = false;

    function settle(ok: boolean): void {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, latencyMs: ok ? Date.now() - start : undefined });
    }

    socket.setTimeout(timeoutMs);
    socket.on('connect', () => settle(true));
    socket.on('timeout', () => settle(false));
    socket.on('error', () => settle(false));
    socket.connect(port, host);
  });
}

// ---------------------------------------------------------------------------
// Readiness check
// ---------------------------------------------------------------------------

/** Options for checkBackendReadiness(). */
export interface BackendReadinessOptions {
  /**
   * Maximum time to wait for all probes combined, in milliseconds.
   * Individual probes also respect this as their per-socket timeout.
   * Default: 5000 ms (AC2).
   */
  timeoutMs?: number;
  /**
   * Injectable probe function (for testing).
   * Defaults to realTcpProbe.
   */
  probe?: TcpProbe;
}

/**
 * Run TCP-connect readiness probes for all backends in the manifest.
 *
 * Results are returned sorted by service name (AC4). Each result includes:
 *   name / required / ok / latencyMs / remediation
 *
 * Constraints:
 *   - Never starts services, mutates files, calls LLMs, or invokes Docker (AC3).
 *   - Completes within timeoutMs (default 5 000 ms) when all backends are down (AC2).
 *
 * @param manifest A validated BackendManifest (call validateManifest() first).
 * @param options  Optional timeout and probe overrides.
 * @returns Sorted array of BackendProbeResult.
 */
export async function checkBackendReadiness(
  manifest: BackendManifest,
  options: BackendReadinessOptions = {}
): Promise<BackendProbeResult[]> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const probe = options.probe ?? realTcpProbe;

  const probes = manifest.backends.map(async (entry): Promise<BackendProbeResult> => {
    const host = entry.host ?? 'localhost';
    const { ok, latencyMs } = await probe(host, entry.port, timeoutMs);
    return {
      name: entry.name,
      required: entry.required,
      ok,
      latencyMs,
      remediation: entry.remediation
    };
  });

  const results = await Promise.all(probes);

  // Sort by name for deterministic output (AC4).
  results.sort((a, b) => a.name.localeCompare(b.name));

  return results;
}

// ---------------------------------------------------------------------------
// Canonical Cerdiwen manifest
// ---------------------------------------------------------------------------

/**
 * The canonical readiness manifest for Cerdiwen's MCP backends.
 *
 * This manifest covers the four backends Cerdiwen requires:
 *   - python_lsp:     Python Language Server on port 8799 (required)
 *   - codemap:        Codemap indexer (port discovery via standard port; required)
 *   - sonarqube:      SonarQube quality gate on port 9199 (required)
 *   - reference_docs: Chroma/reference-doc vector backend (optional)
 *
 * Consuming projects (cerdiwen's harness.yaml wiring — bead 6q0y.34) may load this
 * manifest directly or provide their own YAML-parsed equivalent.
 */
export const CERDIWEN_BACKEND_MANIFEST: BackendManifest = {
  backends: [
    {
      name: 'python_lsp',
      host: 'localhost',
      port: 8799,
      required: true,
      remediation: 'Start the Python LSP server: cd $PROJECT_ROOT && ./scripts/start_python_lsp.sh',
      description: 'Python Language Server Protocol backend for python_lsp tool'
    },
    {
      name: 'codemap',
      host: 'localhost',
      port: 8798,
      required: true,
      remediation: 'Start the codemap indexer: cd $PROJECT_ROOT && ./scripts/start_codemap.sh',
      description: 'Codemap structural index backend for codemap tool'
    },
    {
      name: 'sonarqube',
      host: 'localhost',
      port: 9199,
      required: true,
      remediation: 'Start SonarQube: docker compose up -d sonarqube  (see docs/sonarqube.md)',
      description: 'SonarQube quality-gate backend for sonarqube/run_quality_checks tools'
    },
    {
      name: 'reference_docs',
      host: 'localhost',
      port: 8000,
      required: false,
      remediation: 'Start the Chroma reference-doc backend: cd $PROJECT_ROOT && ./scripts/start_reference_docs.sh',
      description: 'Chroma vector store for reference_docs tool (optional — degrades gracefully)'
    }
  ]
};
