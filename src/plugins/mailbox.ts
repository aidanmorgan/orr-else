import { Type } from "@earendil-works/pi-ai";
import { NativeMailbox } from '../core/Mailbox.js';
import { EventStore } from '../core/EventStore.js';
import { EnvVars, Defaults, PluginToolName, MailboxDefaults, MailboxMessageType } from '../constants/index.js';
import type { RuntimePlugin, RuntimeTool } from '../core/RuntimeServices.js';

export function createMailboxPlugin(eventStore: EventStore, projectRoot: string = process.cwd()): RuntimePlugin {
  const mailbox = new NativeMailbox(eventStore, undefined, projectRoot);
  return {
  name: 'mailbox-communication',
  tools: [
    {
      name: PluginToolName.SEND_MAILBOX_MESSAGE,
      description: "Send an asynchronous message to the Team Lead or another teammate.",
      parameters: Type.Object({
        to: Type.String({ description: "Target recipient (e.g., 'TeamLead')" }),
        beadId: Type.String(),
        type: Type.String({ enum: Object.values(MailboxMessageType) }),
        content: Type.String()
      }),
      execute: async (params: unknown) => {
        const { to, beadId, type, content } = (params && typeof params === 'object' ? params : {}) as { to: string; beadId: string; type: MailboxMessageType; content: string };
        await mailbox.sendMessage({ from: MailboxDefaults.TEAMMATE_SENDER, to, beadId, type, content });
        return `Message sent to ${to}.`;
      }
    },
    {
      name: PluginToolName.CHECK_MAILBOX,
      description: "Read pending messages addressed to you.",
      parameters: Type.Object({
        recipient: Type.String({ description: "Your name (e.g., 'TeamLead')" })
      }),
      execute: async (params: unknown) => {
        // recipient is declared in the parameters schema but the actual lookup uses the worker env var
        void params; // params shape: { recipient: string } — unused at runtime; lookup uses WORKER_ID
        const workerId = process.env[EnvVars.WORKER_ID] || Defaults.API_HOST; // Fallback
        const messages = await mailbox.readMessagesFor(workerId);
        if (messages.length === 0) return MailboxDefaults.EMPTY_MESSAGE;

        return messages;
      }
    }
  ] satisfies RuntimeTool[]
};
}
