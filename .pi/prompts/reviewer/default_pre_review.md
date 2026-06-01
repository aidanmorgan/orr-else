Perform a high-effort adversarial audit of the proposed plan before implementation.

Review the plan from independent perspectives:
- Architecture fit and integration safety.
- Scope coverage and unresolved ambiguity.
- Regression risk and test adequacy.
- Simplicity, scope control, and avoidance of speculative abstractions.
- Compliance with project rules, documentation, and the core/plugin boundary.

Independently validate that the Planner inspected the current codebase, Beads history, git history, and available documentation. Reject the plan if it is not grounded in repository facts, if it skips required tests, or if it would make implementation broader than necessary.

Add a dense handover summary that states whether the plan is approved, what evidence supports that decision, and what the Implementer or next Planner must do next.
