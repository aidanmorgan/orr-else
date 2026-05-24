import { HarnessConfig, SDLCState } from './domain/StateModels.js';
import { BuiltInToolName, NativePiToolName, NativeReadPolicyDefaults, PluginToolName } from '../constants/index.js';

export class ProtocolInjector {
  /**
   * Generates a generic, project-agnostic set of instructions detailing
   * exactly how the LLM must interact with the harness tools.
   * Behavioral enforcement is handled programmatically by the harness.
   */
  public inject(state: SDLCState, config?: HarnessConfig): string {
    return `
### ORR ELSE PROTOCOL v1.0
You are currently operating in the **${state.id}** phase.

#### PROTOCOL REFERENCE:
- This injected prompt is the authoritative Orr Else protocol for the active state.
- Do not read guessed framework protocol paths. If a project wants extra protocol docs, they are listed explicitly in SYSTEM CONTEXT.
- Active progress is recorded in the configured PROGRESS path.
- Project-root configuration such as \`.pi/prompts\`, \`.pi/checklists\`, and \`.pi/rules\` may live outside the worktree; use PROJECT_ROOT paths when reading configured project artifacts.
- If you need the harness YAML, read the injected HARNESS_CONFIG/CONFIG_PATH absolute path only. Never read \`harness.yaml\` relative to the worktree.
- If you need Claude/Codex compatibility rules, hooks, docs, or agent paths, call \`${BuiltInToolName.GET_COMPATIBILITY_CONTEXT}\`. Never read a compatibility directory path directly.

#### PHASE CONTRACT:
- **Mandatory Tasks**: Use \`${BuiltInToolName.GET_OUTSTANDING_TASKS}\` to query your deterministic completion checklist and \`${BuiltInToolName.TICK_ITEMS}\` to record completed checklist evidence in batches. Use \`${BuiltInToolName.TICK_ITEM}\` only for single-item compatibility updates.
- **Configured Tools**: Use named Orr Else/Pi tools for configured capabilities. Do not invoke a configured project-tool capability through shell as a fallback.
- **Beads Access**: Use \`${PluginToolName.BD_GET_BEAD}\` for the active Bead, \`${PluginToolName.BD_GET_STATE_CHART}\` for event-sourced state, and \`${PluginToolName.BD_LIST}\` only for bounded discovery. Do not run \`bd\` through \`${NativePiToolName.BASH}\`.
- **Stable Paths**: Use \`${BuiltInToolName.GET_ARTIFACT_PATHS}\` for configured artifact paths and \`${BuiltInToolName.GET_COMPATIBILITY_CONTEXT}\` for compatibility-mode paths.
- **Read Budget**: Native \`${NativePiToolName.READ}\` calls are limited to ${NativeReadPolicyDefaults.MAX_LIMIT_LINES} lines in teammate contexts. Use smaller targeted reads, \`codemap\`, \`ast_grep\`, \`reference_docs\`, or artifact validators instead of broad file slices.
- **Checkpoint Evidence**: Use \`${BuiltInToolName.SUBMIT_CHECKPOINT}\` before terminal completion so evidence and handover are durably recorded.
- **Restart Routing**: Use \`${BuiltInToolName.REQUEST_CONTEXT_RESTART}\` for context pollution/window pressure and \`${BuiltInToolName.REQUEST_HARNESS_RESTART}\` for transient harness or Pi transport failures.
- **Completion Gate**: \`${BuiltInToolName.SIGNAL_COMPLETION} SUCCESS\` is programmatically rejected until mandatory checklist items and required tools pass.
- **No Shell Fallback**: If \`${NativePiToolName.BASH}\` would be needed to reach a configured capability, stop and call the configured Orr Else/Pi tool instead. If no configured tool exists, record a blocker rather than improvising a shell command.

#### PHASE INSTRUCTIONS:
${state.baseInstructions}
`.trim();
  }
}
