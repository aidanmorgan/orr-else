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
- Framework runtime artifacts such as \`${OperationalLogPath.PROGRESS_FILE}\`, \`${OperationalLogPath.WORKLOG_DIR}/\`, \`${OperationalArtifactPath.LEGACY_STATE_DIR}/\`, \`${OperationalArtifactPath.TEMP_DIR}/\`, \`${OperationalArtifactPath.PI_EVENTS_DIR}/\`, \`${OperationalArtifactPath.PI_LOGS_DIR}/\`, \`${OperationalArtifactPath.PI_MAILBOX_DIR}/\`, \`${OperationalArtifactPath.PI_OTEL_DIR}/\`, \`${OperationalArtifactPath.PI_ARTIFACTS_DIR}/\`, and \`${OperationalArtifactPath.PI_TOOL_OUTPUT_DIR}/\` are not implementation files. Do not edit, delete, commit, or use them as source evidence except through configured harness tools.

#### PHASE CONTRACT:
- **Mandatory Tasks**: Use \`${BuiltInToolName.GET_OUTSTANDING_TASKS}\` to query your deterministic completion checklist and \`${BuiltInToolName.TICK_ITEMS}\` to record completed checklist evidence in batches. Use \`${BuiltInToolName.TICK_ITEM}\` only for single-item compatibility updates.
- **Configured Tools**: Use named Orr Else/Pi tools for configured capabilities. Do not invoke a configured project-tool capability through shell as a fallback.
${mcpPolicy}
- **Project Tool Results**: Use inline \`resultPreview\`, \`outputPreview\`, \`structuredResult\`, \`diagnosticPreview\`, and \`toolCalls\` returned by configured project tools. \`outputArchive.artifactRef\` and \`outputAccess\` text are archive guidance on PASSED calls, not errors. \`artifactRef\` is an opaque harness handle, not a filesystem path; do not pass \`artifactRef\`, \`outputFile\`, \`stdoutFile\`, or \`stderrFile\` to native reads, shell, or native MCP. Rerun the same configured project tool with narrower arguments when more detail is needed.
- **Tool-Use Backpressure**: Make one narrow project-tool call before fanning out. Do not issue concurrent calls to the same configured project tool for the same Bead/state/action. If a tool returns \`failureCategory: "backpressure"\` or \`nextAction: "wait_for_in_flight_result"\`, stop launching that tool, wait for the in-flight result already returned in the conversation, and then rerun once with narrower arguments only if the result is insufficient. If \`codemap\`, \`ast_grep\`, or another configured project tool returns a truncated preview, wrapper warning, no-match marker, or broad result, pause and narrow the path, operation, or pattern before making more calls.
- **Tool Choice**: Use native \`${NativePiToolName.READ}\` for known files and small line ranges. When a file path OR line offset is uncertain, call \`${BuiltInToolName.READ_PATH_CONTEXT}\` FIRST — it returns existence, total lines, the valid offset range, a corrected-offset hint if the requested offset is out of range, and nearest matches for missing files; this eliminates ENOENT retries and EOF errors before the read. Use \`codemap\` for dependency/file-context questions, not literal text search. Use \`ast_grep\` only for valid AST-shaped structural patterns; do not use it as grep for plain strings. Use \`python_lsp\` only for a specific symbol, diagnostics, hover, definition, or reference question after a targeted read has identified the file and position.
- **Beads Access**: Use \`${PluginToolName.BD_GET_BEAD}\` for the active Bead, \`${PluginToolName.BD_GET_STATE_CHART}\` for event-sourced state, and \`${PluginToolName.BD_LIST}\` only for bounded discovery. Do not run \`bd\` through \`${NativePiToolName.BASH}\`.
- **Stable Paths**: Use \`${BuiltInToolName.GET_ARTIFACT_PATHS}\` for configured artifact paths and bounded artifact content previews; do not native-read \`${OperationalArtifactPath.PI_ARTIFACTS_DIR}/\`. Use \`${BuiltInToolName.GET_COMPATIBILITY_CONTEXT}\` for compatibility-mode paths.
- **Worktree Boundary**: Native \`${NativePiToolName.READ}\`, \`${NativePiToolName.WRITE}\`, \`${NativePiToolName.EDIT}\`, and shell file mutations must target files inside this Bead's worktree. Attempts to read or mutate project-root, sibling-worktree, or framework runtime paths are rejected unless a dedicated harness/project tool exposes that data.
- **Managed Delete**: File deletion attempts through \`${NativePiToolName.BASH}\` are intercepted and converted to a managed move into \`${OperationalArtifactPath.PI_TRASH_DIR}\`. Do not use shell delete commands to bypass worktree scope, and do not directly write into the trash directory.
- **Read Budget**: Native \`${NativePiToolName.READ}\` calls have a hard maximum of ${NativeReadPolicyDefaults.MAX_LIMIT_LINES} lines in teammate contexts; requests above that are rejected. Prefer ${NativeReadPolicyDefaults.RECOMMENDED_LIMIT_LINES} lines or fewer per call, split larger inspections into targeted chunks, and use \`codemap\`, \`ast_grep\`, \`reference_docs\`, or artifact validators instead of broad file slices.
- **Checkpoint Evidence**: Use \`${BuiltInToolName.SUBMIT_CHECKPOINT}\` before terminal completion so evidence and handover are durably recorded.
- **Transactional Write Set**: When transactional state is enabled, \`${BuiltInToolName.SIGNAL_COMPLETION} SUCCESS\` is rejected if the Git worktree has dirty files outside the approved plan contract write set. Replan or revert unapproved paths; do not work around this gate.
- **Restart Routing**: Use \`${BuiltInToolName.REQUEST_CONTEXT_RESTART}\` for context pollution/window pressure and \`${BuiltInToolName.REQUEST_HARNESS_RESTART}\` for transient harness or Pi transport failures.
- **Completion Gate**: \`${BuiltInToolName.SIGNAL_COMPLETION} SUCCESS\` is programmatically rejected until mandatory checklist items and required tools pass.
- **No Shell Fallback**: Do not use \`${NativePiToolName.BASH}\` for \`pwd\`, \`ls\`, \`find\`, \`grep\`, \`wc\`, \`cmp\`, \`cp\`, \`git\`, Python snippets, or configured project-tool capability. Use native Pi tools, \`${BuiltInToolName.GET_ARTIFACT_PATHS}\`, \`${PluginToolName.BD_GET_STATE_CHART}\`, \`git_history\`, \`codemap\`, \`ast_grep\`, and the configured project tools. If no configured tool exists, record a blocker rather than improvising a shell command.

#### PHASE INSTRUCTIONS:
${state.baseInstructions}
`.trim();
  }
}
