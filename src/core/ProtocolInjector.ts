import { HarnessConfig, SDLCState } from './domain/StateModels.js';
import {
  BuiltInToolName,
  NativePiToolName,
  NativeReadPolicyDefaults,
  OperationalArtifactPath,
  OperationalLogPath,
  PluginToolName,
  ProjectToolType
} from '../constants/index.js';

export class ProtocolInjector {
  /**
   * Generates a generic, project-agnostic set of instructions detailing
   * exactly how the LLM must interact with the harness tools.
   * Behavioral enforcement is handled programmatically by the harness.
   */
  public inject(state: SDLCState, config?: HarnessConfig): string {
    const nativeMcpDisabled = config?.settings?.pi?.mcp?.allowToolCalls === false;
    const hasMcpBackedTools = (config?.tools ?? []).some(t => t.type === ProjectToolType.MCP);
    const mcpPolicy = (nativeMcpDisabled || hasMcpBackedTools)
      ? `\n- **MCP Policy**: ${nativeMcpDisabled ? `Native Pi \`${NativePiToolName.MCP}\` access is disabled for this project. ` : ''}Pi UI \`MCP: 0/N\` counts native adapters only, not Orr Else configured MCP-backed project tools. Use \`${BuiltInToolName.HARNESS_STATUS}\` for configured counts and call the named project tool; route a blocker only when no configured tool exposes the needed capability.`
      : '';
    return `
### ORR ELSE PROTOCOL v1.0
You are currently operating in the **${state.id}** phase.

#### PROTOCOL REFERENCE:
- This injected prompt is the authoritative Orr Else protocol for the active state.
- Do not read guessed framework protocol paths. If a project wants extra protocol docs, they are listed explicitly in the REFERENCE LIBRARIES section of your system prompt.
- Active progress is recorded in the configured PROGRESS path.
- Project-root configuration such as \`.pi/prompts\`, \`.pi/checklists\`, and \`.pi/rules\` is injected or exposed through configured tools. Do not use native file reads to inspect project-root copies while a Bead state is running.
- If you need the harness YAML, read the injected HARNESS_CONFIG/CONFIG_PATH absolute path only. Never read \`harness.yaml\` relative to the worktree.
- If you need Claude/Codex compatibility rules, hooks, docs, or agent paths, call \`${BuiltInToolName.GET_COMPATIBILITY_CONTEXT}\`. Never read a compatibility directory path directly.
- Framework runtime artifacts such as \`${OperationalLogPath.PROGRESS_FILE}\`, \`${OperationalLogPath.WORKLOG_DIR}/\`, \`${OperationalArtifactPath.TEMP_DIR}/\`, \`${OperationalArtifactPath.PI_EVENTS_DIR}/\`, \`${OperationalArtifactPath.PI_LOGS_DIR}/\`, \`${OperationalArtifactPath.PI_MAILBOX_DIR}/\`, \`${OperationalArtifactPath.PI_OTEL_DIR}/\`, \`${OperationalArtifactPath.PI_ARTIFACTS_DIR}/\`, and \`${OperationalArtifactPath.PI_TOOL_OUTPUT_DIR}/\` are not implementation files. Do not edit, delete, commit, or use them as source evidence except through configured harness tools.

#### PHASE CONTRACT:
- **Mandatory Tasks**: Use \`${BuiltInToolName.GET_OUTSTANDING_TASKS}\` to query your deterministic completion checklist and \`${BuiltInToolName.TICK_ITEMS}\` to record completed checklist evidence in batches. Use \`${BuiltInToolName.TICK_ITEM}\` only for single-item compatibility updates.
- **Configured Tools**: Use named Orr Else/Pi tools for configured capabilities. Do not invoke a configured project-tool capability through shell as a fallback.
${mcpPolicy}
- **Tool Result Contract**: Every Orr Else tool returns its own minimal schema. There is no shared generic output-control envelope. Complete raw output is archived to harness-managed tool-calls storage by the harness; the model-facing return is each tool's declared minimal schema. Tool-owned compaction fields (such as compactSummary, diagnosticFacts, structuredResult) may appear in project-tool results -- these are tool-specific, not harness-imposed. To obtain more detail, re-run the same tool with narrower arguments (e.g. a specific file path, projection name, or reduced scope) -- do not try to access a generic raw-output path. See the tool-routing SKILL.md for each tool's schema fields, raw-output file/ref location, and rerun strategy.
- **Tool-Use Backpressure**: Make one narrow project-tool call before fanning out. Do not issue concurrent calls to the same configured project tool for the same Bead/state/action. If a tool returns \`failureCategory: "backpressure"\` or \`nextAction: "wait_for_in_flight_result"\`, stop launching that tool, wait for the in-flight result already returned in the conversation, and then rerun once with narrower arguments only if the result is insufficient. If a tool result indicates a broad match or no-match, pause and narrow the path, operation, or pattern before making more calls.
- **Tool Choice**: Use native \`${NativePiToolName.READ}\` for known files and small line ranges. When a file path OR line offset is uncertain, call \`${BuiltInToolName.READ_PATH_CONTEXT}\` FIRST — it returns existence, total lines, the valid offset range, a corrected-offset hint if the requested offset is out of range, and nearest matches for missing files; this eliminates ENOENT retries and EOF errors before the read. For dependency/file-context questions, use a configured code-map or structure tool rather than literal text search. For structural code-pattern queries, use a configured AST-aware grep tool with valid structural patterns; do not use it as grep for plain strings. For language-server queries (symbols, diagnostics, hover, definition, references), use the configured LSP tool only after a targeted read has identified the file and position.
- **Beads Access**: Use \`${PluginToolName.BD_GET_BEAD}\` for the active Bead, \`${PluginToolName.BD_GET_STATE_CHART}\` for event-sourced state, and \`${PluginToolName.BD_LIST}\` only for bounded discovery. Do not run \`bd\` through \`${NativePiToolName.BASH}\`.
- **Stable Paths**: Use \`${BuiltInToolName.GET_ARTIFACT_PATHS}\` for configured artifact paths and bounded artifact content previews; do not native-read \`${OperationalArtifactPath.PI_ARTIFACTS_DIR}/\`. For large structured JSON artifacts (planContract, requirementsAnalysis — often 30–60 KB), use \`${BuiltInToolName.QUERY_ARTIFACT}\` with \`"summary":true\` first to get per-projection size estimates (byteCount + tokenEstimate) without inlining the full blob, then request only the named projections you need. Requesting large inline budgets via get_artifact_paths for these artifacts wastes ~14k tokens per call. Use \`${BuiltInToolName.GET_COMPATIBILITY_CONTEXT}\` for compatibility-mode paths.
- **Worktree Boundary**: Native \`${NativePiToolName.READ}\`, \`${NativePiToolName.WRITE}\`, \`${NativePiToolName.EDIT}\`, and shell file mutations must target files inside this Bead's worktree. Attempts to read or mutate project-root, sibling-worktree, or framework runtime paths are rejected unless a dedicated harness/project tool exposes that data.
- **Managed Delete**: File deletion attempts through \`${NativePiToolName.BASH}\` are intercepted and converted to a managed move into \`${OperationalArtifactPath.PI_TRASH_DIR}\`. Do not use shell delete commands to bypass worktree scope, and do not directly write into the trash directory.
- **Read Budget**: Native \`${NativePiToolName.READ}\` calls have a hard maximum of ${NativeReadPolicyDefaults.MAX_LIMIT_LINES} lines in teammate contexts; requests above that are rejected. Prefer ${NativeReadPolicyDefaults.RECOMMENDED_LIMIT_LINES} lines or fewer per call, split larger inspections into targeted chunks, and use configured code-map, AST-grep, reference-doc, or artifact-validator tools instead of broad file slices.
- **Checkpoint Evidence**: Use \`${BuiltInToolName.SUBMIT_CHECKPOINT}\` before terminal completion so evidence and handover are durably recorded.
- **Transactional Write Set**: When transactional state is enabled, \`${BuiltInToolName.SIGNAL_COMPLETION} SUCCESS\` is rejected if the Git worktree has dirty files outside the approved plan contract write set. Replan or revert unapproved paths; do not work around this gate.
- **Restart Routing**: Use \`${BuiltInToolName.REQUEST_CONTEXT_RESTART}\` for context pollution/window pressure and \`${BuiltInToolName.REQUEST_HARNESS_RESTART}\` for transient harness or Pi transport failures.
- **Pre-Signal Gate Audit**: Call \`${BuiltInToolName.PRE_SIGNAL_AUDIT}\` BEFORE \`${BuiltInToolName.SUBMIT_CHECKPOINT}\` or \`${BuiltInToolName.SIGNAL_COMPLETION}\` to confirm gate readiness. It returns required tools (with pass/fail/never_invoked state), terminal failure-limit state, missing checklist items, checkpoint status, and exact blocking evidence so you can address all blockers before attempting the terminal signal.
- **Completion Gate**: \`${BuiltInToolName.SIGNAL_COMPLETION} SUCCESS\` is programmatically rejected until mandatory checklist items and required tools pass.
- **No Shell Fallback**: Do not use \`${NativePiToolName.BASH}\` for \`pwd\`, \`ls\`, \`find\`, \`grep\`, \`wc\`, \`cmp\`, \`cp\`, \`git\`, Python snippets, or configured project-tool capability. Use native Pi tools, \`${BuiltInToolName.GET_ARTIFACT_PATHS}\`, \`${PluginToolName.BD_GET_STATE_CHART}\`, and the configured project tools. If no configured tool exists, record a blocker rather than improvising a shell command.
`.trim();
  }
}
