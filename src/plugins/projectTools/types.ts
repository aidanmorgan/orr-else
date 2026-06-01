/**
 * Internal shared types for the projectTools plugin modules.
 * These are package-internal; do not import from outside src/plugins/.
 */
import type { TemplateContext } from '../../core/PiIntegration.js';
import type { ProjectToolConfig, ProjectMcpToolConfig, ProjectCommandArgumentPathConfig } from '../../core/domain/StateModels.js';

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
  'mcp-servers'?: Record<string, McpServerDefinition>;
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

export interface ProjectToolOutputArchive {
  artifactRef: string;
  bytes: number;
  truncated: boolean;
}

export type ModelFacingProjectToolResult = Record<string, unknown> & {
  outputArchive?: ProjectToolOutputArchive;
  outputAccess?: string;
  resultPreview?: string;
  outputPreview?: string;
  outputTruncated?: boolean;
};

export interface ParsedProjectDiagnostic {
  severity: string;
  message: string;
  source?: string;
  code?: string;
  file?: string;
  line?: number;
  column?: number;
}

export interface ParsedProjectDiagnostics {
  diagnostics: ParsedProjectDiagnostic[];
  declaredDiagnostics?: number;
  sourceTruncated: boolean;
}

export interface DiagnosticGroupSummary {
  source: string;
  code: string;
  severity: string;
  messagePrefix: string;
  count: number;
  missingImport: boolean;
  representativeLocations: string[];
}

export interface DiagnosticGroupAccumulator extends DiagnosticGroupSummary {
  sortIndex: number;
  severityRank: number;
}

export interface ProjectDiagnosticSummary {
  totalDiagnostics: number;
  parsedDiagnostics: number;
  declaredDiagnostics?: number;
  missingImportCount: number;
  sourceTruncated: boolean;
  groups: DiagnosticGroupSummary[];
  omittedGroups?: number;
  nextAction: string;
}

export interface ProjectToolFailureLimitResult {
  reached: boolean;
  failureCount: number;
  maxFailures: number;
  result?: Record<string, unknown>;
}

export interface ScanTargetEvidence {
  scannedTargetCount: number;
  scannedTargetSamples?: string[];
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
  kind: string;
}

export interface PathArgumentEscapeGuidance {
  rootKind: string;
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
  signal?: string | undefined;
  stdoutFile: string;
  stderrFile: string;
  boundedStdout: { text: string; bytes: number; truncated: boolean };
  boundedStderr: { text: string; bytes: number; truncated: boolean };
  stdoutTruncated: boolean;
  structuredStdout: Record<string, unknown> | undefined;
  structuredSummary: unknown;
  toolCalls: unknown;
  normalizedPathArguments: string[];
}

export interface CommandFailureTestGroup {
  testName: string;
  assertionType?: string;
  locations: string[];
  count: number;
}

export interface CommandFailureLintGroup {
  rule: string;
  severity: string;
  locations: string[];
  count: number;
}
