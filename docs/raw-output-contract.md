# Raw-Output Archival Contract

**Status:** Active policy — supersedes the bounded-preview / byte-budget RTK framing from s3wp.11.

## The Invariant

Every tool invocation writes its **complete raw output** to harness-managed tool-calls storage.  The model-facing return is the individual tool's own **minimal schema**.  No generic byte cap, output limit, or truncation envelope is used as the primary output-control mechanism.

## Raw-Output Persistence

Complete raw output is persisted to:

```
PI_TOOL_CALL_DIR / .tmp/tool-calls/
  {beadId}/
    {stateId}/
      {actionId}/
        {toolName}/
          {toolInvocationId}
```

This location is managed by the harness and is independent of any model-facing return value.  Path injection (making the archive path available to the model when needed) belongs in the harness, not in individual tools.

## Minimal-Schema Rule

Each tool owns its own minimal return schema.  The model receives only what that schema specifies.  Schema types and compactors are owned by the tool (or, for Cerdiwen project tools, by Cerdiwen tooling).  The harness does not define a shared public return envelope.

## Forbidden Generic Output-Control Mechanisms

The following are **forbidden** as the primary output-control mechanism for any Orr Else bundled tool or any Cerdiwen project tool:

| Identifier | Origin |
|---|---|
| `outputLimit` | harness config / constants |
| `inlineResultBytes` | harness config / constants |
| `inlineResultLimit` | harness config / constants |
| `MODEL_FACING_RESULT_BUDGET_BYTES` | constants |
| `COMMAND_RETURN_BYTES` | constants |
| `OUTPUT_PREVIEW_BYTES` | constants |
| `COMMAND_DIAGNOSTIC_PREVIEW_BYTES` | constants |
| `TOOL_CALL_EXTRACTION_MAX_BYTES` | constants |
| `resultPreview` as a **required-for-all** key | generic envelope |
| `diagnosticPreview` as a **required-for-all** key | generic envelope |
| `outputPreview` as a **required-for-all** key | generic envelope |
| `outputArchive` as a **required-for-all** key | generic envelope |
| `stdoutTruncated` as a **required-for-all** key | generic envelope |
| `stderrTruncated` as a **required-for-all** key | generic envelope |
| `structuredResult` as a **required-for-all** key | generic envelope |

"Required-for-all" means enforced by the harness across all tools.  A project tool or tool skill may define any of these keys within its own private schema — that is permitted; only the harness imposing them uniformly is forbidden.

## Allowed Safety Controls

The following **remain allowed** and are not affected by this policy:

- **Timeouts** — subprocess and tool invocation timeouts.
- **Path scopes** — restricting which filesystem paths a tool may read or write.
- **Subprocess failure handling** — detecting non-zero exit codes, capturing stderr.
- **Validation** — input schema validation, argument sanitization.
- **Failure limits** — circuit breakers, retry caps, error budgets.
- **Tool-owned compaction** — a tool may perform deterministic, non-LLM compaction of its own raw output into its minimal schema.  The compacted form is what the model sees; the raw form goes to the archive.

## Scope

This invariant applies to:

- **100% of Orr Else bundled tools** — built-in control-plane tools, bundled runtime plugin tools, and native Pi tools observed by harness policy.
- **100% of Cerdiwen project tools** — tools declared in Cerdiwen's `harness.yaml` `tools:` section.

Generic archival and path injection belong in the harness (this repo).  Tool-specific schemas and compactors belong with each tool.  Cerdiwen schemas stay in the Cerdiwen repo.

## Implementation Beads

The following beads carry out this policy in code:

| Bead | Title |
|---|---|
| s3wp.24 | Remove harness config and schema output cap knobs |
| s3wp.25 | Persist complete raw output for project command tools |
| s3wp.26 | Persist complete raw output for MCP and native tool calls |
| s3wp.27 | Convert Orr Else bundled tools to no-cap minimal schemas |
| s3wp.28 | Convert Cerdiwen project tools to raw-output minimal schemas |
| s3wp.29 | Update tool skills and prompts for raw-output interpretation |
| s3wp.30 | Add no-cap raw-output guardrails for all tools |

## Superseded Framing

This contract supersedes the earlier bounded-preview / byte-budget RTK framing introduced in s3wp.11 (`RtkArchiveStrategy`, `byteBudget` field in `RtkContractEntry`).  Those constructs have been removed from the tool inventory model.  The inventory now records `rawOutputLocation` (where complete raw output is persisted) and `deterministicCompaction` (whether the tool itself performs lossless compaction into its schema) instead.
