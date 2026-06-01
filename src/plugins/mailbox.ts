import { Type } from "@earendil-works/pi-ai";
import { NativeMailbox } from '../core/Mailbox.js';
import { EventStore } from '../core/EventStore.js';
import { EnvVars, Defaults, PluginToolName, MailboxDefaults, MailboxMessageType } from '../constants/index.js';

export function createMailboxPlugin(eventStore: EventStore) {
  const mailbox = new NativeMailbox(eventStore);
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
      execute: async ({ to, beadId, type, content }: { to: string; beadId: string; type: MailboxMessageType; content: string }) => {
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
      execute: async ({ recipient }: { recipient: string }) => {
        const workerId = process.env[EnvVars.WORKER_ID] || Defaults.API_HOST; // Fallback
        const messages = await mailbox.readMessagesFor(workerId);
        if (messages.length === 0) return MailboxDefaults.EMPTY_MESSAGE;

        return messages;
      }
    }
  ]
};
}
