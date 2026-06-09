import { Type } from "@earendil-works/pi-ai";
import { NativeMailbox } from '../core/Mailbox.js';
import { EventStore } from '../core/EventStore.js';
import { MailboxMessageType, PluginToolName } from '../constants/domain.js';
import { EnvVars, MailboxDefaults } from '../constants/infra.js';
import { nodeRuntimeEnvironment, type RuntimeEnvironment } from '../core/RuntimeEnvironment.js';
import type { RuntimePlugin, RuntimeTool } from '../core/RuntimeServices.js';

export function createMailboxPlugin(
  eventStore: EventStore,
  projectRoot: string = process.cwd(),
  env: RuntimeEnvironment = nodeRuntimeEnvironment
): RuntimePlugin {
  const mailbox = new NativeMailbox(eventStore, undefined, projectRoot);
  return {
  name: 'mailbox-communication',
  tools: [
    {
      name: PluginToolName.SEND_MAILBOX_MESSAGE,
      description: "Send an asynchronous message to the coordinator or another worker. Returns a minimal ack with the new message ID.",
      parameters: Type.Object({
        to: Type.String({ description: "Target recipient identifier (e.g., the coordinator or a configured worker ID)" }),
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
        recipient: Type.String({ description: "Your worker identifier (the configured ID this process is running as)" })
      }),
      execute: async (params: unknown) => {
        const { recipient } = (params && typeof params === 'object' ? params : {}) as { recipient?: string };
        // Resolve identity: explicit recipient param wins, else the injected
        // RuntimeEnvironment's WORKER_ID. Fail closed — never fall back to an
        // arbitrary identity, which would leak another worker's mail.
        const resolved = (recipient && recipient.trim()) || env.env(EnvVars.WORKER_ID)?.trim();
        if (!resolved) {
          throw new Error(
            'check_mailbox: cannot resolve recipient identity. Pass a `recipient` ' +
            `or set ${EnvVars.WORKER_ID} in the environment.`
          );
        }
        // Return routing-only result: ids + metadata, no body content.
        return await mailbox.listMessagesFor(resolved);
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
