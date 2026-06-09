import * as fs from 'fs';
import * as path from 'path';
import { nodeLogger as Logger } from './Logger.js'
import { EventStore } from './EventStore.js';
import { DomainEventName } from '../constants/domain.js';
import { Component } from '../constants/infra.js';

const readFileAsync = fs.promises.readFile;
const writeFileAsync = fs.promises.writeFile;
const appendFileAsync = fs.promises.appendFile;
const existsSync = fs.existsSync;

export class ProgressManager {
  private readonly filePath: string;

  constructor(
    worktreePath: string,
    private readonly eventStore: EventStore,
    private readonly context: { beadId?: string; stateId?: string } = {}
  ) {
    this.filePath = path.join(worktreePath, 'PROGRESS.md');
  }

  public async ensureExists(beadId: string, initialHistory: string) {
    if (!existsSync(this.filePath)) {
      const content = `
# Progress for Bead ${beadId}

## Initial State
${initialHistory}

## Timeline
- [${new Date().toISOString()}] Session started.
`.trim();
      try {
        await writeFileAsync(this.filePath, content);
      } catch (error) {
        Logger.error(Component.PROGRESS, `Failed to initialize progress file`, { path: this.filePath, error: String(error) });
        return;
      }
      await this.eventStore.record(DomainEventName.PROGRESS_FILE_INITIALIZED, {
        beadId,
        stateId: this.context.stateId,
        path: this.filePath,
        initialHistory
      });
    }
  }

  public async appendLog(log: string) {
    if (!existsSync(this.filePath)) return;
    const entry = `\n- [${new Date().toISOString()}] ${log}`;
    try {
      await appendFileAsync(this.filePath, entry);
    } catch (error) {
      Logger.error(Component.PROGRESS, `Failed to append to progress file`, { path: this.filePath, error: String(error) });
      return;
    }
    await this.eventStore.record(DomainEventName.PROGRESS_LOG_APPENDED, {
      beadId: this.context.beadId,
      stateId: this.context.stateId,
      path: this.filePath,
      log
    });
  }

  public async read(): Promise<string> {
    if (!existsSync(this.filePath)) return '';
    try {
      return await readFileAsync(this.filePath, 'utf8');
    } catch (error) {
      Logger.error(Component.PROGRESS, `Failed to read progress file`, { path: this.filePath, error: String(error) });
      return '';
    }
  }
}
