import * as fs from 'fs';
import * as path from 'path';
import { v7 as uuidv7 } from 'uuid';
import { resolveProjectFrom } from './Paths.js';
import { nodeLogger as Logger } from './Logger.js'
import { EventStore } from './EventStore.js';
import { DomainEventName, MailboxMessageType } from '../constants/domain.js';
import { Component, MailboxDefaults } from '../constants/infra.js';

const readFileAsync = fs.promises.readFile;
const writeFileAsync = fs.promises.writeFile;
const readdirAsync = fs.promises.readdir;
const unlinkAsync = fs.promises.unlink;
const existsSync = fs.existsSync;

export interface MailboxMessage {
  id: string;
  from: string;
  to: string;
  beadId: string;
  type: MailboxMessageType;
  content: string;
  timestamp: string;
}

/**
 * Routing metadata for a single mailbox message, without the body.
 * Returned by list/peek/receive operations.
 */
export interface MailboxRoutingInfo {
  id: string;
  from: string;
  to: string;
  beadId: string;
  type: MailboxMessageType;
  timestamp: string;
}

/**
 * Minimal schema returned by check_mailbox (list operation).
 * Bodies are never inlined; use fetch_mailbox_message to retrieve a specific body.
 */
export interface MailboxListResult {
  count: number;
  messages: MailboxRoutingInfo[];
}

/**
 * Minimal ack returned by send_mailbox_message.
 */
export interface MailboxSendAck {
  messageId: string;
  status: 'sent';
}

/**
 * Result returned by fetch_mailbox_message for a single message body.
 */
export interface MailboxFetchResult {
  messageId: string;
  found: boolean;
  message?: MailboxMessage;
}

export class NativeMailbox {
  private readonly baseDir: string;

  constructor(
    private readonly eventStore: EventStore,
    baseDir: string = MailboxDefaults.DIR,
    projectRoot: string = process.cwd()
  ) {
    this.baseDir = path.isAbsolute(baseDir) ? baseDir : resolveProjectFrom(projectRoot, baseDir);
    if (!existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  public async sendMessage(msg: Omit<MailboxMessage, 'id' | 'timestamp'>): Promise<string> {
    const id = uuidv7();
    const message: MailboxMessage = {
      ...msg,
      id,
      timestamp: new Date().toISOString()
    };
    const filePath = path.join(this.baseDir, `${id}.json`);
    
    try {
      await writeFileAsync(filePath, JSON.stringify(message, null, 2));
    } catch (error) {
      Logger.error(Component.CORE, `Failed to send mailbox message`, { to: msg.to, error: String(error) });
      throw error;
    }
    await this.eventStore.record(DomainEventName.MAILBOX_MESSAGE_SENT, {
      beadId: msg.beadId,
      messageId: id,
      from: msg.from,
      to: msg.to,
      type: msg.type,
      path: filePath
    });
    return id;
  }

  public async readMessagesFor(to: string): Promise<MailboxMessage[]> {
    try {
      const files = await readdirAsync(this.baseDir);
      const jsonFiles = files.filter(f => f.endsWith('.json'));

      const messages = await Promise.all(jsonFiles.map(async f => {
        const content = await readFileAsync(path.join(this.baseDir, f), 'utf8');
        return JSON.parse(content) as MailboxMessage;
      }));

      return messages.filter(m => m.to === to);
    } catch (error) {
      Logger.error(Component.CORE, `Failed to read mailbox messages`, { to, error: String(error) });
      return [];
    }
  }

  /**
   * List messages for a recipient without inlining body content.
   * Returns routing metadata only (id, from, to, beadId, type, timestamp).
   */
  public async listMessagesFor(to: string): Promise<MailboxListResult> {
    const messages = await this.readMessagesFor(to);
    const routing: MailboxRoutingInfo[] = messages.map(m => ({
      id: m.id,
      from: m.from,
      to: m.to,
      beadId: m.beadId,
      type: m.type,
      timestamp: m.timestamp
    }));
    return { count: routing.length, messages: routing };
  }

  /**
   * Fetch a single message by ID, returning its full content.
   * Returns found:false if the message does not exist.
   */
  public async fetchMessage(id: string): Promise<MailboxFetchResult> {
    const filePath = path.join(this.baseDir, `${id}.json`);
    if (!existsSync(filePath)) {
      return { messageId: id, found: false };
    }
    try {
      const content = await readFileAsync(filePath, 'utf8');
      const message = JSON.parse(content) as MailboxMessage;
      return { messageId: id, found: true, message };
    } catch (error) {
      Logger.error(Component.CORE, `Failed to fetch mailbox message`, { id, error: String(error) });
      return { messageId: id, found: false };
    }
  }

  public async deleteMessage(id: string): Promise<void> {
    const filePath = path.join(this.baseDir, `${id}.json`);
    if (!existsSync(filePath)) return;
    
    try {
      await unlinkAsync(filePath);
    } catch (error) {
      Logger.error(Component.CORE, `Failed to delete mailbox message`, { id, error: String(error) });
      return;
    }
    await this.eventStore.record(DomainEventName.MAILBOX_MESSAGE_DELETED, {
      messageId: id,
      path: filePath
    });
  }
}
