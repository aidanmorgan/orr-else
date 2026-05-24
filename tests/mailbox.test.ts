import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NativeMailbox } from '../src/core/Mailbox.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { EventStore } from '../src/core/EventStore.js';
import * as fs from 'fs';

describe('NativeMailbox', () => {
  const testDir = 'state/test-mailbox';
  let mailbox: NativeMailbox;
  let eventStore: EventStore;

  beforeEach(() => {
    eventStore = new EventStore(new ConfigLoader());
    mailbox = new NativeMailbox(eventStore, testDir);
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  it('should send and retrieve messages', async () => {
    await mailbox.sendMessage({
      from: 'AgentA',
      to: 'TeamLead',
      beadId: 'bead-1',
      type: 'INFO',
      content: 'Task completed'
    });

    const messages = await mailbox.readMessagesFor('TeamLead');
    expect(messages.length).toBe(1);
    expect(messages[0].from).toBe('AgentA');
    expect(messages[0].content).toBe('Task completed');
  });

  it('should delete messages after reading', async () => {
    await mailbox.sendMessage({ from: 'A', to: 'B', beadId: '1', type: 'INFO', content: 'test' });
    let messages = await mailbox.readMessagesFor('B');
    const msgId = messages[0].id;
    
    await mailbox.deleteMessage(msgId);
    messages = await mailbox.readMessagesFor('B');
    expect(messages.length).toBe(0);
  });
});
