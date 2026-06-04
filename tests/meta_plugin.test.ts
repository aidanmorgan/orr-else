import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { EventStore } from '../src/core/EventStore.js';
import { createMetaPlugin } from '../src/plugins/meta.js';
import { DomainEventName, PluginToolName } from '../src/constants/index.js';
import type { CreatePluginResult } from '../src/plugins/meta.js';

// ---------------------------------------------------------------------------
// Helper: create a stub EventStore whose record() is a no-op (never writes files)
// ---------------------------------------------------------------------------
function makeStubEventStore(): EventStore {
  const configLoader = new ConfigLoader();
  const stub = new EventStore(configLoader);
  // Override record to be a no-op — avoids config/filesystem dependencies
  stub.record = vi.fn().mockResolvedValue(undefined);
  return stub;
}

describe('meta plugin — CREATE_NEW_PLUGIN', () => {
  let tempRoot: string;
  let pluginsDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-meta-plugin-')));
    pluginsDir = path.join(tempRoot, 'src', 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    process.chdir(tempRoot);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('returns structured { success, name, path } on successful plugin creation', async () => {
    const eventStore = makeStubEventStore();
    const plugin = createMetaPlugin(eventStore, tempRoot);
    const createTool = plugin.tools.find(tool => tool.name === PluginToolName.CREATE_NEW_PLUGIN)!;
    expect(createTool).toBeDefined();

    const content = 'export default {}; // test plugin\n';
    const result = await createTool.execute({ name: 'test-plugin.ts', content }) as CreatePluginResult;

    expect(result.success).toBe(true);
    expect(result.name).toBe('test-plugin.ts');
    expect(typeof result.path).toBe('string');
    expect(result.path).toContain('test-plugin.ts');
    expect(result.error).toBeUndefined();

    // File must actually be created
    expect(fs.existsSync(result.path!)).toBe(true);
    expect(fs.readFileSync(result.path!, 'utf8')).toBe(content);
  });

  it('returns structured { success: false, error } on validation failure (non-.ts name)', async () => {
    const eventStore = makeStubEventStore();
    const plugin = createMetaPlugin(eventStore, tempRoot);
    const createTool = plugin.tools.find(tool => tool.name === PluginToolName.CREATE_NEW_PLUGIN)!;

    const result = await createTool.execute({ name: 'evil.js', content: 'bad' }) as CreatePluginResult;

    expect(result.success).toBe(false);
    expect(typeof result.error).toBe('string');
    expect(result.error!.length).toBeGreaterThan(0);
    expect(result.name).toBeUndefined();
    expect(result.path).toBeUndefined();
  });

  it('returns structured { success: false, error } on validation failure (path traversal attempt)', async () => {
    const eventStore = makeStubEventStore();
    const plugin = createMetaPlugin(eventStore, tempRoot);
    const createTool = plugin.tools.find(tool => tool.name === PluginToolName.CREATE_NEW_PLUGIN)!;

    const result = await createTool.execute({ name: '../evil.ts', content: 'bad' }) as CreatePluginResult;

    expect(result.success).toBe(false);
    expect(typeof result.error).toBe('string');
    expect(result.error!.length).toBeGreaterThan(0);
    expect(result.path).toBeUndefined();
  });

  it('records PLUGIN_FILE_CREATED event on success', async () => {
    const eventStore = makeStubEventStore();
    const plugin = createMetaPlugin(eventStore, tempRoot);
    const createTool = plugin.tools.find(tool => tool.name === PluginToolName.CREATE_NEW_PLUGIN)!;

    await createTool.execute({ name: 'event-test.ts', content: 'export default {};\n' });

    expect(eventStore.record).toHaveBeenCalledWith(
      DomainEventName.PLUGIN_FILE_CREATED,
      expect.objectContaining({ pluginName: 'event-test.ts' })
    );
  });
});

// ---------------------------------------------------------------------------
// meta plugin — no-cap minimal schema fixture (s3wp.27e)
//
// Verifies that the CREATE_NEW_PLUGIN tool result is always a compact
// structured schema with no inline content, preview, or byte-cap fields,
// even when the plugin content is very large.
// ---------------------------------------------------------------------------

describe('meta plugin — no-cap minimal schema (s3wp.27e)', () => {
  let tempRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-meta-nocap-')));
    fs.mkdirSync(path.join(tempRoot, 'src', 'plugins'), { recursive: true });
    process.chdir(tempRoot);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('result for large plugin content creation is compact — only { success, name, path } with no preview/cap fields', async () => {
    // Generate large plugin content (>10KB) to simulate a real plugin creation
    const largeContent = [
      '// Large TypeScript plugin with many exports',
      ...Array.from({ length: 200 }, (_, i) =>
        `export function handler${i}(x: unknown): unknown { return x; }`
      )
    ].join('\n') + '\n';
    expect(largeContent.length).toBeGreaterThan(10000);

    const eventStore = makeStubEventStore();
    const plugin = createMetaPlugin(eventStore, tempRoot);
    const createTool = plugin.tools.find(tool => tool.name === PluginToolName.CREATE_NEW_PLUGIN)!;

    const result = await createTool.execute({ name: 'large-plugin.ts', content: largeContent }) as Record<string, unknown>;

    // Must succeed
    expect(result.success).toBe(true);

    // Must NOT contain any inline content, preview, truncation, or byte-cap fields
    expect(result).not.toHaveProperty('outputPreview');
    expect(result).not.toHaveProperty('resultPreview');
    expect(result).not.toHaveProperty('diagnosticPreview');
    expect(result).not.toHaveProperty('truncated');
    expect(result).not.toHaveProperty('stdoutTruncated');
    expect(result).not.toHaveProperty('stderrTruncated');
    expect(result).not.toHaveProperty('outputArchive');
    expect(result).not.toHaveProperty('structuredResult');
    expect(result).not.toHaveProperty('byteCap');
    expect(result).not.toHaveProperty('outputLimit');

    // Must NOT echo back the large content
    expect(result).not.toHaveProperty('content');

    // Only allowed keys: success, name, path, optional error
    const allowedKeys = new Set(['success', 'name', 'path', 'error']);
    for (const key of Object.keys(result)) {
      expect(allowedKeys).toContain(key);
    }
  });

  it('result is never a plain string (must always be a structured object)', async () => {
    const eventStore = makeStubEventStore();
    const plugin = createMetaPlugin(eventStore, tempRoot);
    const createTool = plugin.tools.find(tool => tool.name === PluginToolName.CREATE_NEW_PLUGIN)!;

    // Test both success and failure paths return objects, not strings
    const successResult = await createTool.execute({ name: 'check.ts', content: 'export default {};\n' });
    expect(typeof successResult).toBe('object');
    expect(successResult).not.toBeNull();

    const failResult = await createTool.execute({ name: 'bad-name.js', content: 'bad' });
    expect(typeof failResult).toBe('object');
    expect(failResult).not.toBeNull();
  });
});
