/**
 * Harness built-in tools — self-registration bootstrap (pi-experiment-0yt5.21).
 *
 * The harness owns a small set of COMMON, built-in tools (git_history is the
 * first). Unlike CONSUMER tools — which register their verify() callbacks via
 * the consuming-project extension — the harness self-registers its OWN tools'
 * verify() callbacks at LOAD via the contract's `verifier.register`. This keeps
 * the harness independent of any consumer extension: `verifier.has('git_history')`
 * is true after harness bootstrap even when NO consumer extension is loaded.
 *
 * `registerBuiltInVerifiers()` is IDEMPOTENT: the contract registry is last-wins,
 * so it is safe to invoke more than once (e.g. once as an import side effect here
 * and once explicitly from the extension entrypoint). It registers each built-in
 * tool's verify() under the SAME key the tool reports as its `tool` name.
 */
import { verifier } from '../contract.js';
import { ARTIFACT_VALIDATOR_TOOL, artifactValidatorVerify } from './artifact_validator.js';
import { GIT_HISTORY_TOOL_NAME, gitHistoryVerify } from './git_history.js';

/**
 * Register every harness-owned built-in tool's verify() callback into the
 * module-level verifier registry. Idempotent (last-wins).
 */
export function registerBuiltInVerifiers(): void {
  verifier.register(GIT_HISTORY_TOOL_NAME, gitHistoryVerify);
  verifier.register(ARTIFACT_VALIDATOR_TOOL, artifactValidatorVerify);
}

// Self-register at module load so merely importing the harness built-in tools
// barrel wires the verify() callbacks — no consumer extension required.
registerBuiltInVerifiers();
