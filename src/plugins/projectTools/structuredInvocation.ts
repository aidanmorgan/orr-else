/**
 * Structured invocation registry for projectTools.
 *
 * This module is a GENERIC registry MECHANISM only. The harness ships NO
 * concrete tool-output parsers: each cerdiwen project tool owns ALL of its own
 * deterministic output parsing in its own per-tool file (see pi-experiment-0yt5.6
 * / 0yt5.19) and returns its own minimal ToolResultBase-extending result. The
 * harness therefore recognizes/summarizes nothing — with no registered handler
 * `resolveStructuredInvocation` returns null and the tool's output flows through
 * verbatim.
 *
 * The mechanism kept here is the run-and-detect dispatch: a registry keyed by
 * tool name that, when a handler IS registered, augments the spawn args with a
 * machine-readable output flag and parses the resulting output. A consumer (e.g.
 * cerdiwen) may register handlers via `registerStructuredInvocation`; the harness
 * itself registers none.
 *
 * Package-internal — do not import from outside src/plugins/.
 */

// ---- Shared types ----

export interface StructuredInvocationResult {
  status: 'ok' | 'parse_error';
  counts?: Record<string, number>;
  affectedPaths?: string[];
  representativeSamples?: unknown[];
  omissions?: string;
  nextAction?: string;
}

export interface StructuredInvocationHandler {
  /** The augmented args to pass to the process (instead of the original args). */
  augmentedArgs: string[];
  /**
   * Parse structured stdout/stderr/exitCode into a compact structuredResult.
   * Returns null on malformed input — caller falls back to text summarizers.
   * Must NEVER throw.
   */
  parse(stdout: string, stderr: string, exitCode: number | undefined): StructuredInvocationResult | null;
}

/** A registered tool entry describing how to augment args and parse output. */
export interface StructuredInvocationEntry {
  /** Flag(s) to inject for machine-readable output. */
  flags: string[];
  /** Patterns of args that indicate an output-format flag is already present. */
  conflictPatterns: RegExp[];
  /** Parse structured output into a compact structuredResult. Must never throw. */
  parse(stdout: string, stderr: string, exitCode: number | undefined): StructuredInvocationResult | null;
}

// ---- Helpers ----

/** Returns true when an arg token looks like an output-format flag for the given tool. */
function hasOutputFormatFlag(args: string[], patterns: RegExp[]): boolean {
  return args.some(arg => patterns.some(pattern => pattern.test(arg)));
}

// ---- Registry ----
//
// Intentionally EMPTY: the harness ships no concrete parsers. Cerdiwen per-tool
// files own their own parsing and register here (or parse inline) as they see fit.
const REGISTRY: Record<string, StructuredInvocationEntry> = {};

/**
 * Register a structured-invocation handler for a tool. Used by consumers that
 * own deterministic parsing (e.g. cerdiwen tools). The harness registers none.
 */
export function registerStructuredInvocation(toolName: string, entry: StructuredInvocationEntry): void {
  REGISTRY[toolName] = entry;
}

// ---- Public API ----

/**
 * Resolve a structured invocation handler for a registered tool.
 *
 * @param commandName - The base name of the executable (e.g. 'eslint', 'ruff').
 * @param args - The argument list that will be passed to the process.
 * @returns A handler with `augmentedArgs` and `parse`, or null if:
 *   - the tool has no registered handler (the harness registers none), or
 *   - an output-format flag is already present in `args` (don't double-inject).
 */
export function resolveStructuredInvocation(
  commandName: string,
  args: string[]
): StructuredInvocationHandler | null {
  // Normalize: strip path prefix (e.g. '/usr/local/bin/eslint' → 'eslint')
  const baseName = commandName.split('/').pop() ?? commandName;
  // Also strip extensions on Windows (e.g. 'eslint.cmd' → 'eslint')
  const toolName = baseName.replace(/\.(cmd|exe|bat)$/i, '');

  const entry = REGISTRY[toolName];
  if (!entry) return null;

  // Don't inject if an output-format flag is already present
  if (hasOutputFormatFlag(args, entry.conflictPatterns)) return null;

  // Append the output-format flags AFTER the user-supplied args so that subcommand
  // tools (ruff check, golangci-lint run) receive the subcommand first.
  const augmentedArgs = [...args, ...entry.flags];

  return {
    augmentedArgs,
    parse(stdout: string, stderr: string, exitCode: number | undefined): StructuredInvocationResult | null {
      try {
        return entry.parse(stdout, stderr, exitCode);
      } catch {
        // Defensive: never throw, always fall back
        return null;
      }
    }
  };
}
