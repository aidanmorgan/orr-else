import { Type } from "@earendil-works/pi-ai";
import type { TeammateEvent } from '../core/TeammateEvents.js';
import { postHarnessSignal, CoordinatorRejectionError } from '../core/HarnessApiClient.js';
import { BuiltInToolName } from '../constants/domain.js';
import type { RuntimePlugin, RuntimeTool } from '../core/RuntimeServices.js';

/**
 * Build a human-readable required-evidence hint for a coordinator rejection.
 * Names the rule and, when the gate verdict is present, includes the reject message.
 */
function coordinatorRejectionEvidence(err: CoordinatorRejectionError): string {
  if (err.rule === 'timedOut') {
    return 'The coordinator gate handler timed out. Retry the signal; if the gate consistently times out, contact the platform operator.';
  }
  if (err.rule === 'blocked') {
    const gate = err.gate as { rejectMessage?: string; failures?: unknown[] } | undefined;
    const msg = gate?.rejectMessage;
    return msg
      ? `Gate blocked: ${msg}. Resolve all gate failures before retrying signal_completion.`
      : 'The coordinator gate blocked the signal. Resolve all verifier gate failures before retrying signal_completion.';
  }
  return 'The coordinator response was malformed or missing the ok field. Retry the signal; if the problem persists, check coordinator health.';
}

export const signalingPlugin: RuntimePlugin = {
  name: 'harness-signaling',
  tools: [
    {
      name: BuiltInToolName.SIGNAL_COMPLETION,
      description: 'Signal task completion or phase transition to the coordinator.',
      parameters: Type.Object({}, { additionalProperties: true }),
      execute: async (params: unknown) => {
        try {
          return await postHarnessSignal(params as TeammateEvent);
        } catch (err) {
          if (err instanceof CoordinatorRejectionError) {
            // Coordinator explicitly rejected — return a structured diagnostic so
            // the caller can remediate rather than receiving an opaque throw.
            return {
              ok: false,
              rule: err.rule,
              requiredEvidence: coordinatorRejectionEvidence(err)
            };
          }
          throw err;
        }
      }
    }
  ] satisfies RuntimeTool[]
};
