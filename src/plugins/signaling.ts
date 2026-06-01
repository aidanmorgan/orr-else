import { Type } from "@earendil-works/pi-ai";
import type { TeammateEvent } from '../core/TeammateEvents.js';
import { postHarnessSignal } from '../core/HarnessApiClient.js';
import { BuiltInToolName } from '../constants/index.js';

export const signalingPlugin = {
  name: 'harness-signaling',
  tools: [
    {
      name: BuiltInToolName.SIGNAL_COMPLETION,
      description: 'Signal task completion or phase transition to the coordinator.',
      parameters: Type.Object({}, { additionalProperties: true }),
      execute: async (event: TeammateEvent) => await postHarnessSignal(event)
    }
  ]
};
