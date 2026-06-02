# Artifact Evidence Skill

## Harness Artifact Handling

Artifacts (plans, reviews, archives) are stored under `.pi/` in harness-managed paths.
Never hard-code paths; always resolve them through the tool layer.

### Discovering Artifact Paths
Use `get_artifact_paths` to list available artifact paths for the current Bead.
Returns named slots (e.g. `plan`, `post_review`, `output_archive`) with their
resolved file paths.

### Reading Artifact Content
Use `read_path_context` with the resolved path from `get_artifact_paths` to load an
artifact's content into context. For large JSON artifacts, prefer `query_artifact`
to extract a specific field rather than loading the entire file.

### artifactRef
When a checklist item or prompt references an `artifactRef`, it is a symbolic name
for a harness-managed file. Resolve it with `get_artifact_paths` before reading.
Do not guess or construct the path manually.

### outputArchive / outputArchivePath
The `outputArchive` artifact collects the implementer's evidence (changed files,
test results, quality gate logs). When reviewing post-implementation:
1. Call `get_artifact_paths` to get the `output_archive` path.
2. Call `read_path_context` (or `query_artifact` for large JSON) to inspect its
   contents.
3. Verify the listed changed files and test/lint results match the approved plan.

### query_artifact
Use `query_artifact` when an artifact is a large JSON document and you need only a
specific field (e.g. `$.changedFiles`, `$.qualityGateResult`). Avoids loading the
entire document into the context window.

### Evidence Recording
Every `tick_item` call must reference concrete evidence: file paths, line numbers,
command output excerpts, or artifact references — not assertions. The harness
validator rejects unsupported tick evidence.
