# Tool Routing Skill

## Design Intent
Orr Else tools follow a uniform archival contract: minimal model-facing schemas paired with complete raw-output persistence. This keeps your context window focused while ensuring absolute auditability.

## The Archival Contract
- **Minimal Schema**: The result returned to you is a "Minimal Ack" (counts, IDs, or short summaries). It does NOT contain the full stdout/stderr of the operation.
- **Raw Archival**: The full output is archived in `PI_TOOL_OUTPUT_DIR`.
- **Deep-Dive Protocol**: If the minimal schema is insufficient, do NOT guess archive paths. Instead:
    1.  Rerun the tool with narrower arguments (e.g., a specific file or projection).
    2.  Use a specialized query tool (like `query_artifact`) to extract the missing facts.

## System Tools Reference

### `pre_signal_audit` (The "Gate Debugger")
**Call this BEFORE `submit_checkpoint` or `signal_completion`.**
It returns the exact state of your completion gates:
- Which **Required Tools** have failed or never been run.
- Which **Checklist Items** are missing.
- Whether a **Checkpoint** has been recorded.
- **Gate Status**: A boolean `gateReady` signal. Use this to address all blockers before attempting to finish.

### `harness_status`
Returns the operational health of the harness:
- Active vs. Available teammate slots.
- Counts of configured project tools.
- Health of MCP backends and signaling servers.

### `read_path_context`
**Call this before reading an unfamiliar or large file.**
Returns:
- `exists`: Boolean.
- `totalLines`: Absolute line count.
- `validOffsetRange`: Guidance for `Read` parameters.
- **Hints**: Corrected offsets or nearest matches for missing files to prevent `ENOENT` loops.

## Error & Backpressure Handling

### Backpressure
If a tool returns `failureCategory: "backpressure"`:
- **Stop**: Do not fan out more calls to this tool.
- **Wait**: There is already an in-flight result for this bead/action.
- **Rerun**: Once the in-flight result returns, rerun with narrower arguments if the result is still needed.

### Tool Rejection
If a tool result is `status: "REJECTED"`:
- The harness has identified a protocol violation (e.g., unauthorized path, missing evidence handle).
- Read the `remediation` field in the result and fix your tool invocation.

## Engineering Rules
- **No Shell Fallbacks**: Do not use `bash` for `grep`, `find`, or `git`. Use the native Pi tools and configured project tools.
- **Idempotency**: Assume all harness system tools are idempotent. Rerunning a successful tool is safe but token-wasteful.
