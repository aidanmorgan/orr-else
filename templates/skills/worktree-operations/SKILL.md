# Worktree Operations Skill

## Design Intent
The harness uses Git worktrees to isolate implementation work from the project root and from other concurrent tasks. This isolation ensures that "Draft" code does not pollute the main repository and allows for clean, automated merge/cleanup cycles.

## The Worktree Boundary
Each teammate session is spawned in an isolated directory (typically `worktrees/<beadId>/`).

- **The Sandbox**: All native `Write`, `Edit`, and `Bash` mutations MUST stay within the provided worktree path.
- **Project Root**: The project root is read-only. Do not attempt to modify configuration, rules, or sibling worktrees directly.
- **Harness Runtime**: Do not touch framework runtime paths (logs, events, mailbox) except through the provided harness tools.

## Transactional State & The Write Set
If the harness has `transactionalState` enabled, it enforces a strict "Write Set" contract:

- **Approved Paths**: Only paths declared in your approved `planContract` (the `writeSet`) may be modified.
- **Enforcement**: `signal_completion SUCCESS` will be rejected if unapproved files are dirty in the worktree.
- **Correction**: If you accidentally modify unapproved files, revert them immediately.

## Git Lifecycle (Harness-Managed)
The harness owns the Git lifecycle to ensure repository integrity.

- **No Commits**: Do not run `git commit`, `git merge`, or `git push` inside the worktree.
- **No Stashing**: Do not use `git stash` or `git reset` to manage state transitions; use the harness `bd` and `mailbox` tools.
- **Harness-Owned Merge**: When you signal `SUCCESS`, the harness performs the final quality audit, merge, commit, and worktree removal.

## Engineering Rules
- **Environment Grounding**: Always verify your current working directory is inside the assigned worktree before starting implementation.
- **Path Normalization**: Use the `read_path_context` tool to verify file existence and line ranges before attempting reads to avoid path errors.
- **Surgicality**: Change ONLY what is required by the plan. Avoid "Cleanup" of unrelated files in the same worktree.
