/**
 * Internal shared types for the projectTools plugin modules.
 * These are package-internal; do not import from outside src/plugins/.
 */
import type { TemplateContext } from '../../core/TemplateResolver.js';
import type { ProjectToolConfig, ProjectMcpToolConfig, ProjectCommandArgumentPathConfig } from '../../core/domain/StateModels.js';
// pi-experiment-amq0.19: single typed source for resolved root kind.
import type { ResolvedRootKind } from './rootKind.js';

export interface ProjectToolExecutionContext {
  templateContext: TemplateContext;
  cwd: string;
  callDir: string;
  outputDir: string;
  outputFile: string;
  tmpDir: string;
  /**
   * The host process environment snapshot (process.env) captured at context creation.
   * Stored here so sub-modules (commandExecutor, mcpExecutor) can spread it into child
   * process env without directly reading process.env themselves — keeping process.env
   * access to the allowed projectTools.ts facade.
   */
  hostEnv: Record<string, string | undefined>;
}

export interface McpServerDefinition {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  type?: string;
}

export interface McpConfigFile {
  mcpServers?: Record<string, McpServerDefinition>;
}

export interface SerializedMcpLockMetadata {
  scope: 'project';
  projectRoot: string;
  worktreePath: string;
  reason: 'shared_backend_symbol_operations';
}

export interface SerializedMcpLockTimeoutMetadata {
  scope: 'project';
  reason: 'shared_backend_symbol_operations';
  waitedMs: number;
  tool: string;
  server: string;
  lockRef: string;
  lockFile: string;
}

/**
 * Sanitized backpressure metadata for a serialized COMMAND/tsProjectTool lock
 * timeout. Mirrors the MCP shape minus the `server` field (command tools have no
 * MCP server). Carries no absolute project/worktree paths.
 */
export interface SerializedCommandLockTimeoutMetadata {
  scope: 'project';
  reason: 'serialized_tool';
  waitedMs: number;
  tool: string;
  lockRef: string;
  lockFile: string;
}

// 0yt5.16/0yt5.17: the model-facing result is the tool's own result passed
// through VERBATIM (minus internal-only raw-stream keys). It is an opaque record
// to the harness — no narrowing/preview/archive envelope fields are added.
export type ModelFacingProjectToolResult = Record<string, unknown>;

// 0yt5.16/0yt5.17: the diagnostic/scan/failure-group summarizer types
// (ParsedProjectDiagnostic(s), DiagnosticGroupSummary/Accumulator,
// ProjectDiagnosticSummary, ScanTargetEvidence, CommandFailureTestGroup/LintGroup,
// ProjectToolOutputArchive) have been REMOVED along with the summarizer machinery.

export interface ProjectToolFailureLimitResult {
  reached: boolean;
  failureCount: number;
  maxFailures: number;
  result?: Record<string, unknown>;
}

export type CommandArgumentPathNormalization = {
  arguments: string[];
  normalizedPathArguments: string[];
  rejection?: CommandArgumentPathRejection;
};

export type CommandArgumentPathRejection = {
  argumentName: string;
  value: string;
  message: string;
  guidance?: PathArgumentEscapeGuidance;
};

export interface PathArgumentRootResolution {
  path: string;
  // pi-experiment-amq0.19: typed from single-source ResolvedRootKind — no raw string.
  kind: ResolvedRootKind;
}

export interface PathArgumentEscapeGuidance {
  // pi-experiment-amq0.19: typed from single-source ResolvedRootKind.
  rootKind: ResolvedRootKind;
  allowedRoot: string;
  expectedRelativeForm: string;
  acceptedForms: string[];
  remediation: string[];
}

export interface CommandResultInput {
  definition: import('../../core/domain/StateModels.js').ProjectCommandToolConfig;
  status: import('../../constants/index.js').ToolResultStatus;
  exitCode: number | undefined;
  maxBufferExceeded: boolean;
  timedOut?: boolean;
  cancelled?: boolean;
  signal?: string | undefined;
  stdoutFile: string;
  stderrFile: string;
  boundedStdout: { text: string; bytes: number; truncated: boolean };
  boundedStderr: { text: string; bytes: number; truncated: boolean };
  structuredStdout: Record<string, unknown> | undefined;
  structuredSummary: unknown;
  toolCalls: unknown;
  normalizedPathArguments: string[];
}
