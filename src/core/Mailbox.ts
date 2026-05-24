import * as fs from 'fs';
import * as path from 'path';
import { v7 as uuidv7 } from 'uuid';
import { resolveProject } from './Paths.js';
import { Logger } from './Logger.js';
import { EventStore } from './EventStore.js';
import { Component, DomainEventName, MailboxDefaults, MailboxMessageType } from '../constants/index.js';

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

export class NativeMailbox {
  private readonly baseDir: string;

  constructor(
    private readonly eventStore: EventStore,
    baseDir: string = MailboxDefaults.DIR
  ) {
    this.baseDir = path.isAbsolute(baseDir) ? baseDir : resolveProject(baseDir);
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
