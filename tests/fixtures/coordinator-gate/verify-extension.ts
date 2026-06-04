/**
 * Fixture worker-extension for pi-experiment-0yt5.20 AC2.
 *
 * A consumer extension registers its tool's verify() callback into the contract
 * `verifier` registry as a LOAD-time side effect. The coordinator loads this
 * module in its OWN process at startup so the callback is registered in the gate
 * process. The test asserts the registry is non-empty in the gate process after
 * loading this fixture.
 *
 * IMPORTANT: it imports the contract from the SAME src module the gate consumes
 * (../../../src/contract.js) so it registers into the singleton the gate reads.
 */
import { verifier, VerifyVerdict } from '../../../src/contract.js';

export const FIXTURE_VERIFY_TOOL = 'fixture_coordinator_verify_tool';

verifier.register(FIXTURE_VERIFY_TOOL, () => ({
  verdict: VerifyVerdict.PASS,
  reasons: ['fixture coordinator verify callback']
}));
