import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NativeMailbox } from '../src/core/Mailbox.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { EventStore } from '../src/core/EventStore.js';

describe('NativeMailbox', () => {
  let testDir: string;
  let mailbox: NativeMailbox;
  let eventStore: EventStore;

  beforeEach(() => {
    // Use a per-run isolated temp directory to avoid worktree cross-contamination.
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-mailbox-test-'));
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
    const messages = await mailbox.readMessagesFor('B');
    const msgId = messages[0].id;

    await mailbox.deleteMessage(msgId);
    const remaining = await mailbox.readMessagesFor('B');
    expect(remaining.length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // listMessagesFor: routing-only, no inline bodies
  // ---------------------------------------------------------------------------

  it('listMessagesFor returns count and routing metadata without body', async () => {
    await mailbox.sendMessage({ from: 'AgentA', to: 'TeamLead', beadId: 'b1', type: 'INFO', content: 'hello' });
    await mailbox.sendMessage({ from: 'AgentB', to: 'TeamLead', beadId: 'b2', type: 'REQUEST', content: 'need review' });

    const result = await mailbox.listMessagesFor('TeamLead');
    expect(result.count).toBe(2);
    expect(result.messages).toHaveLength(2);

    for (const m of result.messages) {
      expect(typeof m.id).toBe('string');
      expect(m.id.length).toBeGreaterThan(0);
      expect(typeof m.from).toBe('string');
      expect(typeof m.to).toBe('string');
      expect(typeof m.beadId).toBe('string');
      expect(typeof m.timestamp).toBe('string');
      // Body must NOT be present on routing info
      expect((m as unknown as Record<string, unknown>).content).toBeUndefined();
    }
  });

  it('listMessagesFor returns empty list with count 0 when no messages', async () => {
    const result = await mailbox.listMessagesFor('Nobody');
    expect(result.count).toBe(0);
    expect(result.messages).toHaveLength(0);
  });

  it('listMessagesFor only lists messages for the specified recipient', async () => {
    await mailbox.sendMessage({ from: 'X', to: 'Alice', beadId: 'b1', type: 'INFO', content: 'for Alice' });
    await mailbox.sendMessage({ from: 'X', to: 'Bob', beadId: 'b2', type: 'INFO', content: 'for Bob' });

    const aliceResult = await mailbox.listMessagesFor('Alice');
    expect(aliceResult.count).toBe(1);
    expect(aliceResult.messages[0].to).toBe('Alice');

    const bobResult = await mailbox.listMessagesFor('Bob');
    expect(bobResult.count).toBe(1);
    expect(bobResult.messages[0].to).toBe('Bob');
  });

  // ---------------------------------------------------------------------------
  // fetchMessage: explicit body selector
  // ---------------------------------------------------------------------------

  it('fetchMessage returns the full message body for a valid id', async () => {
    const id = await mailbox.sendMessage({ from: 'Sender', to: 'Recv', beadId: 'bx', type: 'STEER', content: 'important detail' });

    const result = await mailbox.fetchMessage(id);
    expect(result.found).toBe(true);
    expect(result.messageId).toBe(id);
    expect(result.message).toBeDefined();
    expect(result.message!.content).toBe('important detail');
    expect(result.message!.from).toBe('Sender');
  });

  it('fetchMessage returns found:false for an unknown id', async () => {
    const result = await mailbox.fetchMessage('00000000-0000-0000-0000-000000000000');
    expect(result.found).toBe(false);
    expect(result.message).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Large-body fixture: list/receive returns ids+routing+counts without inline bodies;
  // explicit fetch returns the full body for ONE id.
  // ---------------------------------------------------------------------------

  it('large-body fixture: list returns routing only, fetch returns full body', async () => {
    // Compose a large body (>10 KB) to confirm it never appears in the list result.
    const largeBody = 'X'.repeat(15_000);

    const id1 = await mailbox.sendMessage({ from: 'Writer', to: 'Reader', beadId: 'big-1', type: 'INFO', content: largeBody });
    const id2 = await mailbox.sendMessage({ from: 'Writer', to: 'Reader', beadId: 'big-2', type: 'REQUEST', content: 'short body' });

    // list operation: routing only
    const listResult = await mailbox.listMessagesFor('Reader');
    expect(listResult.count).toBe(2);

    const ids = listResult.messages.map(m => m.id);
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);

    // No body content in any list entry
    for (const m of listResult.messages) {
      const raw = m as unknown as Record<string, unknown>;
      expect(raw.content).toBeUndefined();
    }

    // Explicit fetch for the large-body message
    const fetchResult = await mailbox.fetchMessage(id1);
    expect(fetchResult.found).toBe(true);
    expect(fetchResult.message!.content).toBe(largeBody);
    expect(fetchResult.message!.content.length).toBe(15_000);

    // Explicit fetch for the short message
    const fetchShort = await mailbox.fetchMessage(id2);
    expect(fetchShort.found).toBe(true);
    expect(fetchShort.message!.content).toBe('short body');
  });
});
