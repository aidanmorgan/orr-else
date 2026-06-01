import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '../src/core/Logger.js';
import { FeatureListManager } from '../src/core/FeatureListManager.js';

// ---------------------------------------------------------------------------
// Metric: WI-18 — FeatureListManager.load() catch site
//
// BEFORE: JSON parse failure silently returned []; no diagnosis trail.
// AFTER:  still returns [] (control flow unchanged) AND emits Logger.warn
//         with filePath + error context.
// ---------------------------------------------------------------------------

describe('FeatureListManager.load — WI-18 warn logging', () => {
  let tempDir: string;
  let warnCalls: Array<Parameters<typeof Logger.warn>>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-flm-'));
    warnCalls = [];
    // Use mockImplementation so the module-level Logger singleton never triggers
    // its DailyRotateFile transport (which would write to the tempDir that
    // afterEach deletes, causing unhandled ENOENT errors).
    vi.spyOn(Logger, 'warn').mockImplementation((...args) => { warnCalls.push(args); });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('(a) returns [] and (b) emits a warn with filePath and error when JSON is malformed', () => {
    const filePath = path.join(tempDir, 'feature_list.json');
    fs.writeFileSync(filePath, '{ not valid json }');

    const manager = new FeatureListManager(tempDir, {} as any);

    // (a) Return value is unchanged
    const result = manager.load();
    expect(result).toEqual([]);

    // (b) A warn was emitted with the filePath and a non-empty error string
    expect(warnCalls).toHaveLength(1);
    const [component, message, metadata] = warnCalls[0];
    expect(component).toBe('Core');
    expect(message).toContain('feature list');
    expect(metadata?.filePath).toBe(filePath);
    expect(typeof metadata?.error).toBe('string');
    expect((metadata?.error as string).length).toBeGreaterThan(0);
  });

  it('returns [] without a warn when the file does not exist', () => {
    const manager = new FeatureListManager(tempDir, {} as any);
    const result = manager.load();

    expect(result).toEqual([]);
    expect(warnCalls).toHaveLength(0);
  });

  it('returns parsed features without a warn on valid JSON', () => {
    const filePath = path.join(tempDir, 'feature_list.json');
    const features = [{ id: 'f1', title: 'Feature One', status: 'in_progress' as any }];
    fs.writeFileSync(filePath, JSON.stringify(features));

    const manager = new FeatureListManager(tempDir, {} as any);
    const result = manager.load();

    expect(result).toEqual(features);
    expect(warnCalls).toHaveLength(0);
  });
});
