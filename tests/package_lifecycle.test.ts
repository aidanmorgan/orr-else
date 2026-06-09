import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

describe('package lifecycle contract', () => {
  it('builds the declared CLI target when installed from a Git ref', () => {
    const packageJsonPath = path.join(PROJECT_ROOT, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
      bin?: Record<string, string>;
      scripts?: Record<string, string>;
    };

    expect(manifest.bin?.['orr-else']).toBe('dist/bin/init.js');
    expect(manifest.scripts?.['build']).toBe('tsc');
    expect(manifest.scripts?.['prepare']).toBe('npm run build');
  });
});
