# Artifact Evidence Skill

## Raw-Output Contract for Artifact Tools

The artifact-evidence tools (`get_artifact_paths`, `query_artifact`) follow the
no-cap minimal-schema contract: complete raw output is archived to tool-calls
storage by the harness; the model-facing result is the tool's own minimal schema.
There is no `resultPreview`, `outputArchive` envelope, or `truncation` flag in
these tool schemas.

To inspect artifact content when a named fact is missing: re-call `query_artifact`
with the specific projection name — do not guess archive paths or assume a
`rawOutput` key exists in the return value.

## Harness Artifact Handling

Artifacts (plans, reviews, evidence archives) are stored under `.pi/` in
harness-managed paths. Never hard-code paths; always resolve them through the
tool layer.

### Discovering Artifact Paths

Use `get_artifact_paths` to list available artifact paths for the current Bead.
Returns named slots (e.g. `plan`, `post_review`) with their resolved absolute file
paths and optional size estimates (`byteCount`, `tokenEstimate`).

**Schema fields**: named slot map, each slot with `path` (absolute file path)
and optional `byteCount`/`tokenEstimate`.

### Reading Artifact Content

Use native `Read` with the path from `get_artifact_paths` to load a small artifact
into context. For large JSON artifacts (plan contracts, requirements analysis —
often 30–60 KB), use `query_artifact` to extract a specific projection rather than
loading the entire file.

### query_artifact

Use `query_artifact` when an artifact is a large JSON document and you need only
specific fields. Call with `summary: true` first to get per-projection
`byteCount`/`tokenEstimate` without inlining the full blob, then request only the
named projections you need.

**Schema fields**: `{ projections: { [name]: value }, byteCount, tokenEstimate }`.
Missing projection name = not present in the artifact — do not retry without a
valid projection name.

**Pass/fail authority**: caller; absent projection = data not yet written by the
upstream phase.

**Rerun strategy**: first call with `summary: true`; then call again naming only
the required projections. Do not request the entire artifact inline when size
estimates indicate it would exhaust context budget.

### artifactRef

When a checklist item or prompt references an `artifactRef`, it is a symbolic name
for a harness-managed file. Resolve it with `get_artifact_paths` before reading.
Do not guess or construct the path manually.

### Evidence Recording

Every `tick_item` call must reference concrete evidence: file paths, line numbers,
command output excerpts, or artifact references — not bare assertions. The harness
validator rejects unsupported tick evidence.
