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
      description: "Send an asynchronous message to the Team Lead or another teammate. Returns a minimal ack with the new message ID.",
      parameters: Type.Object({
        to: Type.String({ description: "Target recipient (e.g., 'TeamLead')" }),
        beadId: Type.String(),
        type: Type.String({ enum: Object.values(MailboxMessageType) }),
        content: Type.String()
      }),
      execute: async (params: unknown) => {
        const { to, beadId, type, content } = (params && typeof params === 'object' ? params : {}) as { to: string; beadId: string; type: MailboxMessageType; content: string };
        const messageId = await mailbox.sendMessage({ from: MailboxDefaults.TEAMMATE_SENDER, to, beadId, type, content });
        // Minimal ack: id + status only. Body is archived by the harness.
        return { messageId, status: 'sent' as const };
      }
    },
    {
      name: PluginToolName.CHECK_MAILBOX,
      description: "List pending messages addressed to you. Returns message IDs, routing metadata (from/to/subject/timestamp), and count — no inline bodies. Use fetch_mailbox_message to retrieve a specific body.",
      parameters: Type.Object({
        recipient: Type.String({ description: "Your name (e.g., 'TeamLead')" })
      }),
      execute: async (params: unknown) => {
        // recipient is declared in the parameters schema but the actual lookup uses the worker env var
        void params; // params shape: { recipient: string } — unused at runtime; lookup uses WORKER_ID
        const workerId = process.env[EnvVars.WORKER_ID] || Defaults.API_HOST; // Fallback
        // Return routing-only result: ids + metadata, no body content.
        return await mailbox.listMessagesFor(workerId);
      }
    },
    {
      name: 'fetch_mailbox_message',
      description: "Retrieve the full body of a single mailbox message by ID. Use this after check_mailbox returns a message ID you need to act on.",
      parameters: Type.Object({
        messageId: Type.String({ description: "The message ID returned by check_mailbox." })
      }),
      execute: async (params: unknown) => {
        const { messageId } = (params && typeof params === 'object' ? params : {}) as { messageId: string };
        return await mailbox.fetchMessage(messageId);
      }
    }
  ] satisfies RuntimeTool[]
};
}
