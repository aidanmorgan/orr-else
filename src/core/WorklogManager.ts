import * as fs from 'fs';
import * as path from 'path';
import { BeadId } from '../types/index.js';
import { Logger } from './Logger.js';
import { EventStore } from './EventStore.js';
import { Component, DomainEventName } from '../constants/index.js';

const readFileAsync = fs.promises.readFile;
const appendFileAsync = fs.promises.appendFile;
const existsSync = fs.existsSync;

export class WorklogManager {
  private readonly baseDir: string;

  constructor(
    private readonly eventStore: EventStore,
    baseDir: string = 'worklogs'
  ) {
    this.baseDir = path.join(process.cwd(), baseDir);
    if (!existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  private getFilePath(beadId: BeadId): string {
    return path.join(this.baseDir, `${beadId}.log.md`);
  }

  public getWorklogPath(beadId: BeadId): string {
    return this.getFilePath(beadId);
  }

  public async appendEntry(beadId: BeadId, phase: string, summary: string, handover?: string) {
    const filePath = this.getFilePath(beadId);
    const timestamp = new Date().toISOString();
    const entry = `
## [${timestamp}] Phase: ${phase}
### Summary
${summary}

### Handover / Worklog
${handover || 'N/A'}

---
    `;
    try {
      await appendFileAsync(filePath, entry);
    } catch (error) {
      Logger.error(Component.WORKLOG, `Failed to write worklog for ${beadId}`, { error: String(error) });
      return;
    }
    await this.eventStore.record(DomainEventName.WORKLOG_ENTRY_APPENDED, {
      beadId,
      phase,
      path: filePath,
      summary,
      handover
    });
  }

  public async getLatestHandover(beadId: BeadId): Promise<string | undefined> {
    const filePath = this.getFilePath(beadId);
    if (!existsSync(filePath)) return undefined;
    
    try {
      const content = await readFileAsync(filePath, 'utf8');
      const sections = content.split('---').filter(s => s.trim().length > 0);
      if (sections.length === 0) return undefined;
      
      const latest = sections[sections.length - 1];
      const match = latest.match(/### Handover \/ Worklog\n([\s\S]*)/);
      return match ? match[1].trim() : undefined;
    } catch (error) {
      Logger.error(Component.WORKLOG, `Failed to read worklog for ${beadId}`, { error: String(error) });
      return undefined;
    }
  }
}
