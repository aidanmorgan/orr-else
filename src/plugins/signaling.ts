import { Type } from "@earendil-works/pi-ai";
import type { TeammateEvent } from '../core/TeammateEvents.js';
import { postHarnessSignal } from '../core/HarnessApiClient.js';
import { BuiltInToolName } from '../constants/index.js';
import type { RuntimePlugin, RuntimeTool } from '../core/RuntimeServices.js';

export const signalingPlugin: RuntimePlugin = {
  name: 'harness-signaling',
  tools: [
    {
      name: BuiltInToolName.SIGNAL_COMPLETION,
      description: 'Signal task completion or phase transition to the coordinator.',
      parameters: Type.Object({}, { additionalProperties: true }),
      execute: async (params: unknown) => await postHarnessSignal(params as TeammateEvent)
    }
  ] satisfies RuntimeTool[]
};
