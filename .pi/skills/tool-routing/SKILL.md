# Tool Routing Skill

## When to Use Each Code Navigation Tool

### codemap
Use `codemap` to get a structural overview of the codebase (modules, exported symbols,
class/function signatures). Start here when you need to understand what exists before
searching for a specific pattern. Best for: "what files handle X?", "does a function named
Y already exist?", "which modules export this interface?"

### ast_grep
Use `ast_grep` when structure matters — you need to match or rewrite actual code nodes, not
just text. Ignores false positives in comments and strings. Prefer over `rg` when:
- Renaming an API, function, or import across the repo.
- Enforcing a pattern (e.g. "find all `var` declarations").
- Applying a safe codemod (`-r` flag).

Use `rg` first to shortlist files, then `ast_grep` for precise matching/mutation.

### python_lsp / LSP
Use the LSP for go-to-definition, find-references, hover types, or rename when you need
the compiler's view of the symbol graph. Best for: tracing an interface to its
implementations, finding all call sites of a function, verifying a type.

### reference_docs
Use `reference_docs` (or configured MCP doc tools) when you need library or framework
API documentation — not codebase search. Best for: "what does this SDK method accept?",
"which config fields does this library support?"

### SonarQube / run_quality_checks
Run `run_quality_checks` (which may invoke SonarQube or configured linters) when the
checklist requires quality gate validation or when you suspect a smell. Do NOT run it on
every turn; run it before `submit_checkpoint` or when a test fails and the root cause is
unclear.

### git_history
Use `git log`, `git blame`, or `git show` via the Bash tool when you need to understand
why a change was made, trace a regression, or establish prior art. Best for: "when was
this pattern introduced?", "what commit removed this guard?", "what was the original
intent of this function?"

### get_artifact_paths / read_path_context
Use `get_artifact_paths` to discover harness-managed artifact locations (plans, reviews,
evidence archives) for the current Bead. Use `read_path_context` to load a specific
artifact's content. Do not hard-code `.pi/` paths — resolve them through these tools.

## Decision Flowchart

```
Need code overview?            → codemap
Need precise code match/edit?  → ast_grep (rg to shortlist first)
Need compiler symbol graph?    → LSP
Need library API docs?         → reference_docs
Need quality gate result?      → run_quality_checks
Need change history/intent?    → git_history (Bash: git log/blame)
Need harness artifact path?    → get_artifact_paths → read_path_context
```
