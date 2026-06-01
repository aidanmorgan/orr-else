# Harness Operational Mandates

## 1. Beads as Source of Truth
All task coordination, phase status, checkpoints, checklist evidence, notes, and handovers must be recorded through the harness Beads tools. Do not call `bd` directly from teammate turns and do not describe a status change without executing the corresponding tool.

## 2. Statechart Agents
Agents are statechart states, not profiles. Each teammate executes exactly one Bead in exactly one state using that state's identity, instructions, provider/model configuration, checklist, and transitions.

## 3. Coordinator and Teammates
The starting Pi session is the coordinator. It claims Beads, manages tmux teammate slots, creates Implementation worktrees, receives signals, updates Beads, and replenishes work. Spawned teammates execute exactly one Bead/state assignment and must signal the coordinator after a validated checkpoint.

## 4. Planning and Review Bias
Spend more effort in planning and adversarial review than implementation. Blind changes are prohibited. Plans and reviews must be grounded in current code, Beads history, git history, rules, and documentation.

## 5. Evidence-Based Progress
Mandatory checklist items require concrete evidence. Evidence must identify what was inspected or changed, which checks were run, what passed or failed, and where the next teammate should focus.

## 6. Mandatory Handover
Every state must add handover documentation to the Bead. The handover must include the work performed, outcome, recommended next steps, residual risks, and important session information.

## 7. Worktree Isolation
Only Implementation states receive write worktrees. Implementation teammates must work within `WORKING_DIRECTORY` and avoid touching files outside the assigned worktree unless the state instructions explicitly permit it.

## 8. Core vs Plugin Boundary
Plugin functionality belongs in plugin modules. Core code should contain harness abstractions and state-machine behavior only. Review states must reject unplanned leakage across this boundary.

## 9. Provider Portability
Teammates must not assume a provider-specific behavior unless the state config says so. Prompts, tool protocols, and checkpoint requirements must work with both Claude-compatible and OpenAI-compatible model providers.
