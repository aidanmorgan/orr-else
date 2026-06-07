# Artifact Management Skill

## Design Intent
Artifacts (plans, reviews, evidence archives) are the primary way information is handed over between statechart states. The harness manages their storage in `.pi/artifacts/` and enforces a "Budget-First" read protocol to prevent context-window exhaustion.

## Resolving Artifact Paths
Never guess or hard-code artifact paths. Use `get_artifact_paths` to resolve the logical artifact IDs (defined in `harness.yaml`) to absolute filesystem paths.

- **Logical IDs**: e.g., `planContract`, `requirementsAnalysis`, `postReview`.
- **Metadata**: The tool returns the `path`, `exists` status, and file size (`bytes`).

## The "Budget-First" Read Protocol
Large JSON artifacts (often 30-60KB) must NOT be read entirely into context. Use the following tiered approach with `query_artifact`:

1.  **Summary First**: Call `query_artifact` with `"summary": true`. This returns a list of available "projections" (named fields) and their individual size estimates (`byteCount`, `tokenEstimate`) without returning the content.
2.  **Targeted Fetch**: Select only the specific projections needed for the current task. Call `query_artifact` with the `projection` name.
3.  **Ad-hoc Selection**: If a named projection is insufficient, use a `selector` (dot-path syntax like `writeSet.0`) to extract narrow subtrees.
4.  **Schema Navigation**: Use the `"schema": true` flag to inspect the recursive shape of an unfamiliar artifact (types and lengths only) before choosing a selector.

## Artifact Creation & Updates
When your phase requires creating or updating an artifact:

1.  **Path Resolution**: Call `get_artifact_paths` to get the target absolute path.
2.  **Directory Guarantee**: The harness ensures the parent directory exists if `ensureDir` is configured for that artifact type.
3.  **Writing**: Use native `Write` or `Edit` to persist the artifact.
4.  **Structure**: Ensure the JSON structure matches the project's requirements (e.g., using a project-specific schema-validation tool if available).

## Engineering Rules
- **No Direct Reads**: Do not native-read `.pi/artifacts/` directly. Use `get_artifact_paths` + `query_artifact`.
- **Context Awareness**: If `query_artifact` returns `tooMuchData: true`, rerun with a narrower selector.
- **Evidence Integrity**: When using `tick_item`, reference artifacts by their logical name (e.g., `artifactRef: planContract`).
