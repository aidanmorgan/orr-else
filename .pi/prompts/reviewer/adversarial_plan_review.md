# Task: Adversarial Plan Review
Phase: Adversarial Pre-Review

## Objective
Ruthlessly audit the proposed implementation plan. You must guarantee that the plan is surgical, grounded in repository facts, compliant with project rules, and does not introduce architectural debt.

## Required Tools
Use repository search, file reads, git history, and configured project tools required by the active state to verify the Planner's assumptions.

## Mandatory Checklist
You MUST provide specific evidence/results for each item in the checklist.
- [ ] Independently validated codebase exploration
- [ ] Audited plan for architectural fit and project-rule compliance
- [ ] Verified insertion points are surgical and avoid regressions
- [ ] Confirmed plan adheres to configured project standards

## Protocol
To complete this task, you MUST use the harness checkpoint tools: tick every mandatory checklist item with evidence, call `get_outstanding_tasks` if uncertain, then call `submit_checkpoint`. Do NOT rely on a markdown-only response.
