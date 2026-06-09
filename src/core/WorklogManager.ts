import * as fs from 'fs';
import * as path from 'path';
import { BeadId } from '../types/index.js';
import { Logger, type LoggerPort } from './Logger.js'
import { EventStore } from './EventStore.js';
import { resolveProjectFrom } from './Paths.js';
import { DomainEventName } from '../constants/domain.js';
import { Component, OperationalLogPath } from '../constants/infra.js';

const readFileAsync = fs.promises.readFile;
const appendFileAsync = fs.promises.appendFile;
const existsSync = fs.existsSync;

export class WorklogManager {
  private readonly baseDir: string;
  private readonly logger: LoggerPort;

  /**
   * Worklogs are an operational log artifact resolved against the injected
   * PROJECT_ROOT (shared, coordinator-visible) — never via process.cwd() or a
   * hard-coded directory literal. The directory name comes from the
   * OperationalLogPath constant so there is a single source of truth.
   */
  constructor(
    private readonly eventStore: EventStore,
    projectRoot: string,
    baseDir: string = OperationalLogPath.WORKLOG_DIR,
    logger?: LoggerPort
  ) {
    this.logger = logger ?? Logger;
    this.baseDir = path.isAbsolute(baseDir) ? baseDir : resolveProjectFrom(projectRoot, baseDir);
    if (!existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  private getFilePath(beadId: BeadId): string {
    return path.join(this.baseDir, `${beadId}${OperationalLogPath.WORKLOG_FILE_SUFFIX}`);
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
      this.logger.error(Component.WORKLOG, `Failed to write worklog for ${beadId}`, { error: String(error) });
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
      this.logger.error(Component.WORKLOG, `Failed to read worklog for ${beadId}`, { error: String(error) });
      return undefined;
    }
  }
}
