import * as fs from 'fs';
import * as path from 'path';
import * as ndjson from 'ndjson';

const appendFileAsync = fs.promises.appendFile;
const readdirAsync = fs.promises.readdir;

export class JsonlEventLog {
  public async eventFilePaths(dir: string): Promise<string[]> {
    return (await readdirAsync(dir))
      .filter(file => file.endsWith('.jsonl'))
      .sort()
      .map(file => path.join(dir, file));
  }

  public async scan(filePath: string, visitor: (record: unknown) => void): Promise<void> {
    await this.scanFromOffset(filePath, 0, visitor);
  }

  public async scanFromOffset(filePath: string, offset: number, visitor: (record: unknown) => void): Promise<void> {
    const parser = fs
      .createReadStream(filePath, { encoding: 'utf8', start: Math.max(0, offset) })
      .pipe(ndjson.parse({ strict: false }));

    for await (const value of parser as AsyncIterable<unknown>) {
      if (value !== undefined && value !== null) visitor(value);
    }
  }

  public async append(filePath: string, record: unknown): Promise<void> {
    await appendFileAsync(filePath, `${JSON.stringify(record)}\n`);
  }
}
