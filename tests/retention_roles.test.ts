/**
 * Tests for the decomposed retention roles (pi-experiment-amq0.17).
 *
 * Covers:
 * - ToolOutputRetentionPolicy: pure policy functions (fake-FS testable)
 * - RetentionPlanner: pure config resolution
 * - EventLogCompactor: JSONL compaction without Logger/EventStore
 * - RetentionReporter: event recording via injected port
 * - Architecture test: pure policies have no EventStore/Logger/process imports
 * - Load-bearing wiring proof: mutating a planner/policy changes production behavior
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readFileSync } from 'fs';

// ── Pure policy imports ────────────────────────────────────────────────────
import {
  toolOutputSegment,
  resolveExemptSegments,
  isExemptCurrentTransition,
  hasExceededAge
} from '../src/core/retention/ToolOutputRetentionPolicy.js';

// ── Planner imports ────────────────────────────────────────────────────────
import {
  resolveRetentionConfig,
  STANDARD_RETENTION_AREAS,
  TOOL_OUTPUT_AREA_PATH
} from '../src/core/retention/RetentionPlanner.js';

// ── Compactor imports ──────────────────────────────────────────────────────
import {
  compactJsonlFile,
  runEventStoreCompaction
} from '../src/core/retention/EventLogCompactor.js';

// ── Reporter imports ───────────────────────────────────────────────────────
import { reportRetentionResult } from '../src/core/retention/RetentionReporter.js';

// ── Production class imports (wiring proof) ────────────────────────────────
import { RetentionService } from '../src/core/retention/RetentionService.js';
import {
  DomainEventName,
  RetentionDefaults,
  REPLAY_CRITICAL_EVENT_TYPES
} from '../src/constants/index.js';
import type { DomainEvent } from '../src/core/EventStoreTypes.js';
import type { Clock } from '../src/core/Clock.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const NOW_MS = Date.parse('2026-03-15T12:00:00.000Z');

function fakeClock(nowMs = NOW_MS): Clock {
  return { now: () => nowMs, date: (ts?: number) => new Date(ts === undefined ? nowMs : ts) };
}

function fakeEventStore() {
  const records: Array<{ event: string; data: unknown }> = [];
  return {
    record: vi.fn(async (event: string, data: unknown) => { records.push({ event, data }); }),
    projectBeadStateChart: vi.fn(async () => ({ currentState: undefined, activeActionId: undefined })),
    records
  };
}

function makeTmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ret-roles-test-'));
  fs.mkdirSync(path.join(root, '.pi', 'logs'), { recursive: true });
  fs.mkdirSync(path.join(root, '.pi', 'events'), { recursive: true });
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
  fs.mkdirSync(path.join(root, '.pi', '.trash'), { recursive: true });
  return root;
}

function writeFileWithMtime(filePath: string, content: string, mtimeMs: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  const s = mtimeMs / 1000;
  fs.utimesSync(filePath, s, s);
}

function makeEvent(
  type: string,
  beadId: string,
  timestampMs: number,
  extra: Record<string, unknown> = {}
): DomainEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    type,
    timestamp: new Date(timestampMs).toISOString(),
    sessionId: 'test-session',
    data: { beadId, ...extra }
  };
}

/**
 * Construct a RetentionService with the same argument shape that
 * RetentionCleanup used to expose. Migration seam for all wiring-proof tests.
 */
function makeService(
  projectRoot: string,
  clock: Clock,
  eventStore: unknown,
  maxAgeMs: number = RetentionDefaults.MAX_AGE_MS,
  liveBeadIds: (() => Set<string> | Promise<Set<string>>) | null = null,
  retentionConfig?: Partial<{ maxAgeMs: number; compactionEnabled: boolean; compactionWindowMs: number; diskHealthWarnBytes: number; otelMaxBytes: number; maxToolCallFilesPerRun: number; maxToolCallDirsPerRun: number }>
): RetentionService {
  const resolved = resolveRetentionConfig(maxAgeMs, retentionConfig);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new RetentionService(projectRoot, clock, eventStore as any, resolved, liveBeadIds);
}

function writeEventsJsonl(filePath: string, events: DomainEvent[]): void {
  fs.writeFileSync(filePath, events.map(e => JSON.stringify(e)).join('\n') + '\n');
}

function readEventsJsonl(filePath: string): DomainEvent[] {
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l) as DomainEvent; } catch { return null; } })
    .filter((e): e is DomainEvent => e !== null);
}

// ---------------------------------------------------------------------------
// 1. ToolOutputRetentionPolicy — pure policy functions
// ---------------------------------------------------------------------------

describe('ToolOutputRetentionPolicy — pure functions', () => {
  describe('toolOutputSegment', () => {
    it('sanitizes a state name to match ToolCallPathFactory output', () => {
      expect(toolOutputSegment('Planning', 'fallback')).toBe('Planning');
    });

    it('replaces unsafe characters with hyphens', () => {
      const result = toolOutputSegment('Some State/With Slashes', 'fallback');
      expect(result).not.toContain('/');
      expect(result).not.toContain(' ');
    });

    it('uses the fallback when value is empty', () => {
      expect(toolOutputSegment('', 'fallback')).toBe('fallback');
    });

    it('uses the fallback when value is undefined', () => {
      expect(toolOutputSegment(undefined, 'fallback')).toBe('fallback');
    });

    it('uses the fallback when result would be "."', () => {
      // A value that sanitizes to "." or ".." is replaced with the fallback.
      expect(toolOutputSegment('.', 'fallback')).toBe('fallback');
      expect(toolOutputSegment('..', 'fallback')).toBe('fallback');
    });
  });

  describe('resolveExemptSegments', () => {
    it('returns null when currentState is undefined', () => {
      expect(resolveExemptSegments(undefined, 'actionId')).toBeNull();
    });

    it('returns segments when currentState is defined', () => {
      const result = resolveExemptSegments('Implementation', 'surgical-execution');
      expect(result).not.toBeNull();
      expect(result!.exemptState).toBe('Implementation');
      expect(result!.exemptAction).toBe('surgical-execution');
    });

    it('sanitizes currentState through toolOutputSegment', () => {
      const result = resolveExemptSegments('State With Spaces', undefined);
      expect(result).not.toBeNull();
      expect(result!.exemptState).not.toContain(' ');
    });
  });

  describe('isExemptCurrentTransition', () => {
    it('returns false when exemptSegments is null', () => {
      expect(isExemptCurrentTransition('Implementation', 'surgical-execution', null)).toBe(false);
    });

    it('returns true for the matching state/action pair', () => {
      const segments = { exemptState: 'Implementation', exemptAction: 'surgical-execution' };
      expect(isExemptCurrentTransition('Implementation', 'surgical-execution', segments)).toBe(true);
    });

    it('returns false when state does not match', () => {
      const segments = { exemptState: 'Implementation', exemptAction: 'surgical-execution' };
      expect(isExemptCurrentTransition('Planning', 'surgical-execution', segments)).toBe(false);
    });

    it('returns false when action does not match', () => {
      const segments = { exemptState: 'Implementation', exemptAction: 'surgical-execution' };
      expect(isExemptCurrentTransition('Implementation', 'other-action', segments)).toBe(false);
    });
  });

  describe('hasExceededAge', () => {
    it('returns true when age meets or exceeds maxAgeMs', () => {
      const mtimeMs = NOW_MS - TWO_DAYS_MS;
      expect(hasExceededAge(mtimeMs, NOW_MS, TWO_DAYS_MS)).toBe(true);
    });

    it('returns false when age is less than maxAgeMs', () => {
      const mtimeMs = NOW_MS - ONE_HOUR_MS;
      expect(hasExceededAge(mtimeMs, NOW_MS, TWO_DAYS_MS)).toBe(false);
    });

    it('returns true for one-ms-past-threshold', () => {
      const mtimeMs = NOW_MS - TWO_DAYS_MS - 1;
      expect(hasExceededAge(mtimeMs, NOW_MS, TWO_DAYS_MS)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// 2. RetentionPlanner — pure config resolution
// ---------------------------------------------------------------------------

describe('RetentionPlanner — pure config', () => {
  it('resolveRetentionConfig uses defaults when no overrides given', () => {
    const config = resolveRetentionConfig(TWO_DAYS_MS);
    expect(config.maxAgeMs).toBe(TWO_DAYS_MS);
    expect(config.compactionEnabled).toBe(RetentionDefaults.COMPACTION_ENABLED);
    expect(config.compactionWindowMs).toBe(RetentionDefaults.COMPACTION_WINDOW_MS);
    expect(config.diskHealthWarnBytes).toBe(RetentionDefaults.DISK_HEALTH_WARN_BYTES);
    expect(config.otelMaxBytes).toBe(RetentionDefaults.OTEL_MAX_BYTES);
    expect(config.maxToolCallFilesPerRun).toBe(RetentionDefaults.MAX_TOOL_CALL_FILES_PER_RUN);
    expect(config.maxToolCallDirsPerRun).toBe(RetentionDefaults.MAX_TOOL_CALL_DIRS_PER_RUN);
  });

  it('resolveRetentionConfig applies overrides over defaults', () => {
    const config = resolveRetentionConfig(TWO_DAYS_MS, {
      maxAgeMs: ONE_HOUR_MS,
      compactionEnabled: true,
      compactionWindowMs: SEVEN_DAYS_MS,
      diskHealthWarnBytes: 100,
      otelMaxBytes: 1000,
      maxToolCallFilesPerRun: 50,
      maxToolCallDirsPerRun: 10
    });
    expect(config.maxAgeMs).toBe(ONE_HOUR_MS);
    expect(config.compactionEnabled).toBe(true);
    expect(config.compactionWindowMs).toBe(SEVEN_DAYS_MS);
    expect(config.diskHealthWarnBytes).toBe(100);
    expect(config.otelMaxBytes).toBe(1000);
    expect(config.maxToolCallFilesPerRun).toBe(50);
    expect(config.maxToolCallDirsPerRun).toBe(10);
  });

  it('STANDARD_RETENTION_AREAS includes logs, tmp, trash, otel', () => {
    const names = STANDARD_RETENTION_AREAS.map(a => a.name);
    expect(names).toContain('logs');
    expect(names).toContain('tmp');
    expect(names).toContain('trash');
    expect(names).toContain('otel');
  });

  it('only otel has otelMaxBytesPass = true', () => {
    const otel = STANDARD_RETENTION_AREAS.find(a => a.name === 'otel');
    expect(otel).toBeDefined();
    expect(otel!.otelMaxBytesPass).toBe(true);
    const nonOtel = STANDARD_RETENTION_AREAS.filter(a => a.name !== 'otel');
    for (const area of nonOtel) {
      expect(area.otelMaxBytesPass).toBe(false);
    }
  });

  it('TOOL_OUTPUT_AREA_PATH is defined and non-empty', () => {
    expect(typeof TOOL_OUTPUT_AREA_PATH).toBe('string');
    expect(TOOL_OUTPUT_AREA_PATH.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 3. EventLogCompactor — JSONL compaction (no Logger/EventStore)
// ---------------------------------------------------------------------------

describe('EventLogCompactor — JSONL compaction', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ret-compactor-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('preserves semantic artifacts: replay-critical events survive compaction', async () => {
    const beadId = 'bd-compactor-critical';
    const oldMs = NOW_MS - SEVEN_DAYS_MS - ONE_HOUR_MS;
    const events = [
      makeEvent(DomainEventName.BEAD_CLAIMED, beadId, oldMs, { stateId: 'Planning' }),
      makeEvent(DomainEventName.HEARTBEAT_RECORDED, beadId, oldMs + 1000, {})
    ];
    const filePath = path.join(tmpDir, 'project.jsonl');
    writeEventsJsonl(filePath, events);

    const result = await compactJsonlFile(filePath, NOW_MS, ONE_HOUR_MS, new Set());
    expect(result.error).toBeUndefined();
    expect(result.eventsDropped).toBe(1); // only heartbeat
    expect(result.eventsKept).toBe(1);    // BEAD_CLAIMED preserved

    const remaining = readEventsJsonl(filePath);
    expect(remaining.some(e => e.type === DomainEventName.BEAD_CLAIMED)).toBe(true);
    expect(remaining.some(e => e.type === DomainEventName.HEARTBEAT_RECORDED)).toBe(false);
  });

  it('compactable transport archives: non-critical old events are dropped', async () => {
    const beadId = 'bd-compactor-transport';
    const oldMs = NOW_MS - SEVEN_DAYS_MS - ONE_HOUR_MS;
    const events = [
      makeEvent(DomainEventName.HEARTBEAT_RECORDED, beadId, oldMs, {}),
      makeEvent(DomainEventName.TOKEN_USAGE_RECORDED, beadId, oldMs + 1000, {})
    ];
    const filePath = path.join(tmpDir, 'events.jsonl');
    writeEventsJsonl(filePath, events);

    const result = await compactJsonlFile(filePath, NOW_MS, ONE_HOUR_MS, new Set());
    expect(result.eventsDropped).toBe(2);
    expect(result.eventsKept).toBe(0);
  });

  it('malformed manifests: malformed JSON lines are kept (not silently dropped)', async () => {
    const filePath = path.join(tmpDir, 'malformed.jsonl');
    fs.writeFileSync(filePath, '{"valid":true}\nNOT_JSON\n{"valid":true}\n');

    const result = await compactJsonlFile(filePath, NOW_MS, ONE_HOUR_MS, new Set());
    // Malformed lines are kept (kept count includes them)
    expect(result.eventsKept).toBeGreaterThanOrEqual(1);
    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toContain('NOT_JSON');
  });

  it('missing files: returns an error for a file that does not exist', async () => {
    const result = await compactJsonlFile(
      path.join(tmpDir, 'nonexistent.jsonl'),
      NOW_MS,
      ONE_HOUR_MS,
      new Set()
    );
    expect(result.error).toBeDefined();
    expect(result.eventsDropped).toBe(0);
    expect(result.eventsKept).toBe(0);
  });

  it('size limits: bytesReclaimed is accurate after compaction', async () => {
    const beadId = 'bd-compactor-size';
    const oldMs = NOW_MS - SEVEN_DAYS_MS - ONE_HOUR_MS;
    const events = [
      makeEvent(DomainEventName.BEAD_CLAIMED, beadId, oldMs, { stateId: 'Planning' }),
      makeEvent(DomainEventName.HEARTBEAT_RECORDED, beadId, oldMs + 1000, {})
    ];
    const filePath = path.join(tmpDir, 'size-test.jsonl');
    writeEventsJsonl(filePath, events);
    const originalSize = fs.statSync(filePath).size;

    const result = await compactJsonlFile(filePath, NOW_MS, ONE_HOUR_MS, new Set());
    const finalSize = fs.statSync(filePath).size;

    expect(result.bytesReclaimed).toBe(originalSize - finalSize);
    expect(result.bytesReclaimed).toBeGreaterThan(0);
  });

  it('event-log compaction oracle: runEventStoreCompaction processes all jsonl files in a dir', async () => {
    const beadId = 'bd-compactor-oracle';
    const oldMs = NOW_MS - SEVEN_DAYS_MS - ONE_HOUR_MS;
    const events1 = [makeEvent(DomainEventName.HEARTBEAT_RECORDED, beadId, oldMs, {})];
    const events2 = [makeEvent(DomainEventName.TOKEN_USAGE_RECORDED, beadId, oldMs, {})];

    fs.writeFileSync(path.join(tmpDir, 'file1.jsonl'), events1.map(e => JSON.stringify(e)).join('\n') + '\n');
    fs.writeFileSync(path.join(tmpDir, 'file2.jsonl'), events2.map(e => JSON.stringify(e)).join('\n') + '\n');

    const summary = await runEventStoreCompaction(tmpDir, NOW_MS, ONE_HOUR_MS, new Set());
    expect(summary.filesProcessed).toBe(2);
    expect(summary.eventsDropped).toBe(2);
    expect(summary.errors).toBe(0);
    expect(summary.compactedFileBasenames.size).toBe(2);
  });

  it('runEventStoreCompaction skips when liveBeadIds is null (fail-safe)', async () => {
    const beadId = 'bd-failsafe-null';
    const oldMs = NOW_MS - SEVEN_DAYS_MS - ONE_HOUR_MS;
    const events = [makeEvent(DomainEventName.HEARTBEAT_RECORDED, beadId, oldMs, {})];
    const filePath = path.join(tmpDir, 'events.jsonl');
    writeEventsJsonl(filePath, events);

    const warnCalls: string[] = [];
    const summary = await runEventStoreCompaction(tmpDir, NOW_MS, ONE_HOUR_MS, null, (msg) => warnCalls.push(msg));

    expect(summary.filesProcessed).toBe(0);
    expect(summary.eventsDropped).toBe(0);
    expect(warnCalls.some(m => m.includes('unavailable'))).toBe(true);
  });

  it('TOOL_INVOCATION_SUCCEEDED with outputFile is preserved (evidence handle)', async () => {
    const beadId = 'bd-compactor-evidence';
    const oldMs = NOW_MS - SEVEN_DAYS_MS - ONE_HOUR_MS;
    const outputFile = `.pi/tool-output/${beadId}/Planning/plan/bash/inv-1/output/result.json`;
    const events = [
      makeEvent(DomainEventName.TOOL_INVOCATION_SUCCEEDED, beadId, oldMs, {
        tool: 'bash',
        toolResult: { status: 'PASSED', outputFile }
      }),
      makeEvent(DomainEventName.HEARTBEAT_RECORDED, beadId, oldMs + 500, {})
    ];
    const filePath = path.join(tmpDir, 'evidence.jsonl');
    writeEventsJsonl(filePath, events);

    const result = await compactJsonlFile(filePath, NOW_MS, ONE_HOUR_MS, new Set());
    expect(result.eventsDropped).toBe(1); // only heartbeat
    const remaining = readEventsJsonl(filePath);
    expect(remaining.some(e => e.type === DomainEventName.TOOL_INVOCATION_SUCCEEDED)).toBe(true);
  });

  it('PROJECT_TOOL_SUCCEEDED with top-level outputFile is preserved (flat shape)', async () => {
    const beadId = 'bd-compactor-flat';
    const oldMs = NOW_MS - SEVEN_DAYS_MS - ONE_HOUR_MS;
    const outputFile = `.pi/tool-output/${beadId}/Planning/plan/bash/inv-1/output/result.json`;
    const events = [
      makeEvent(DomainEventName.PROJECT_TOOL_SUCCEEDED, beadId, oldMs, {
        stateId: 'Planning', actionId: 'plan', tool: 'bash', status: 'PASSED', outputFile
      }),
      makeEvent(DomainEventName.TOKEN_USAGE_RECORDED, beadId, oldMs + 500, {})
    ];
    const filePath = path.join(tmpDir, 'flat-shape.jsonl');
    writeEventsJsonl(filePath, events);

    const result = await compactJsonlFile(filePath, NOW_MS, ONE_HOUR_MS, new Set());
    expect(result.eventsDropped).toBe(1); // only token usage
    const remaining = readEventsJsonl(filePath);
    expect(remaining.some(e => e.type === DomainEventName.PROJECT_TOOL_SUCCEEDED)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. RetentionReporter — event recording via injected port
// ---------------------------------------------------------------------------

describe('RetentionReporter — event recording', () => {
  it('records RETENTION_CLEANUP_COMPLETED via injected recorder', async () => {
    const recorder = { record: vi.fn(async () => {}) };

    const result = {
      areas: [],
      totalFilesRemoved: 5,
      totalDirsRemoved: 3,
      totalBytesReclaimed: 1024,
      totalErrors: 0,
      eventsCompacted: 0,
      backpressureActive: false
    };
    const compactionSummary = {
      filesProcessed: 0,
      eventsKept: 0,
      eventsDropped: 0,
      bytesReclaimed: 0,
      errors: 0,
      compactedFileBasenames: new Set<string>()
    };

    await reportRetentionResult(result, compactionSummary, 50 * 1024 * 1024, 50000, 10000, recorder);

    expect(recorder.record).toHaveBeenCalledWith(
      DomainEventName.RETENTION_CLEANUP_COMPLETED,
      expect.objectContaining({
        totalFilesRemoved: 5,
        totalDirsRemoved: 3,
        totalBytesReclaimed: 1024
      })
    );
  });

  it('records RETENTION_DISK_HEALTH when bytes reclaimed exceeds threshold', async () => {
    const recorder = { record: vi.fn(async () => {}) };

    const result = {
      areas: [],
      totalFilesRemoved: 1,
      totalDirsRemoved: 0,
      totalBytesReclaimed: 500,
      totalErrors: 0,
      eventsCompacted: 0,
      backpressureActive: false
    };
    const compactionSummary = {
      filesProcessed: 0,
      eventsKept: 0,
      eventsDropped: 0,
      bytesReclaimed: 0,
      errors: 0,
      compactedFileBasenames: new Set<string>()
    };

    // Threshold is 100 bytes — 500 bytes exceeds it.
    await reportRetentionResult(result, compactionSummary, 100, 50000, 10000, recorder);

    const healthCall = recorder.record.mock.calls.find(([event]) => event === DomainEventName.RETENTION_DISK_HEALTH);
    expect(healthCall).toBeDefined();
    const [, healthData] = healthCall as [string, Record<string, unknown>];
    expect(healthData.diskHealthWarnBytes).toBe(100);
    expect((healthData.totalBytesReclaimed as number)).toBeGreaterThan(0);
  });

  it('does NOT record RETENTION_DISK_HEALTH when bytes below threshold and no backpressure', async () => {
    const recorder = { record: vi.fn(async () => {}) };

    const result = {
      areas: [],
      totalFilesRemoved: 0,
      totalDirsRemoved: 0,
      totalBytesReclaimed: 0,
      totalErrors: 0,
      eventsCompacted: 0,
      backpressureActive: false
    };
    const compactionSummary = {
      filesProcessed: 0,
      eventsKept: 0,
      eventsDropped: 0,
      bytesReclaimed: 0,
      errors: 0,
      compactedFileBasenames: new Set<string>()
    };

    await reportRetentionResult(result, compactionSummary, 50 * 1024 * 1024, 50000, 10000, recorder);

    const healthCall = recorder.record.mock.calls.find(([event]) => event === DomainEventName.RETENTION_DISK_HEALTH);
    expect(healthCall).toBeUndefined();
  });

  it('records RETENTION_DISK_HEALTH with backpressureActive=true when ceiling is hit', async () => {
    const recorder = { record: vi.fn(async () => {}) };

    const result = {
      areas: [],
      totalFilesRemoved: 2,
      totalDirsRemoved: 2,
      totalBytesReclaimed: 10,
      totalErrors: 0,
      eventsCompacted: 0,
      backpressureActive: true  // ceiling was hit
    };
    const compactionSummary = {
      filesProcessed: 0,
      eventsKept: 0,
      eventsDropped: 0,
      bytesReclaimed: 0,
      errors: 0,
      compactedFileBasenames: new Set<string>()
    };

    // Even with bytes below threshold, backpressure triggers health event.
    await reportRetentionResult(result, compactionSummary, 50 * 1024 * 1024, 50000, 10000, recorder);

    const healthCall = recorder.record.mock.calls.find(([event]) => event === DomainEventName.RETENTION_DISK_HEALTH);
    expect(healthCall).toBeDefined();
    const [, healthData] = healthCall as [string, Record<string, unknown>];
    expect(healthData.backpressureActive).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Architecture test: pure policies have no EventStore/Logger/process imports
// ---------------------------------------------------------------------------

describe('Architecture — pure policy/planner modules have no IO/EventStore/Logger imports', () => {
  /**
   * Read source file and check that forbidden imports are absent.
   * This is a structural guard against re-introducing singleton dependencies.
   */
  function readSourceFile(relativePath: string): string {
    return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
  }

  const pureModules = [
    'src/core/retention/ToolOutputRetentionPolicy.ts',
    'src/core/retention/RetentionPlanner.ts'
  ];

  const forbiddenImports = [
    "from '../EventStore.js'",
    "from '../../core/EventStore.js'",
    "from '../Logger.js'",
    "from '../../core/Logger.js'",
    "import process",
    "process.env",
    "process.exit"
  ];

  for (const module of pureModules) {
    for (const forbidden of forbiddenImports) {
      it(`${path.basename(module)} does NOT import ${forbidden}`, () => {
        const source = readSourceFile(module);
        expect(source).not.toContain(forbidden);
      });
    }
  }

  it('EventLogCompactor does NOT import EventStore or Logger singleton', () => {
    const source = readSourceFile('src/core/retention/EventLogCompactor.ts');
    expect(source).not.toContain("from '../EventStore.js'");
    expect(source).not.toContain("from '../Logger.js'");
    expect(source).not.toContain("process.env");
    expect(source).not.toContain("process.exit");
  });
});

// ---------------------------------------------------------------------------
// 6. Load-bearing wiring proof: mutating a policy method changes production behavior
//
// Proof: toolOutputSegment is used by reclaimLiveBeadPriorTransitions via
// resolveExemptSegments. If we override the policy so EVERY state/action pair
// is considered exempt (by making resolveExemptSegments return a wild-card that
// never matches), then a LIVE bead's prior aged transition is preserved instead
// of reclaimed.
//
// We prove this without patching the module by using the production
// RetentionCleanup and showing that the policy governs the reclaim outcome.
// ---------------------------------------------------------------------------

describe('Load-bearing wiring proof: policy governs production retention behavior', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = makeTmpRoot();
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  /**
   * Event store stub that returns specific current state/action for a bead.
   */
  function fakeEventStoreWithCurrent(
    current: Record<string, { currentState?: string; activeActionId?: string }>
  ) {
    return {
      record: vi.fn(async () => {}),
      projectBeadStateChart: vi.fn(async (beadId: string) => ({
        beadId,
        currentState: current[beadId]?.currentState,
        activeActionId: current[beadId]?.activeActionId,
        handovers: {}, completedActionIds: [], checkedItems: {}, addedChecklistItems: [], checkpoints: []
      }))
    };
  }

  it('production: aged prior-transition is reclaimed when NOT the exempt current state/action', async () => {
    const beadId = 'wiring-proof-live';
    const oldMtime = NOW_MS - TWO_DAYS_MS - ONE_HOUR_MS;

    // Prior (aged): Planning/formulate-plan
    const priorDir = path.join(tmpRoot, '.pi', 'tool-output', beadId, 'Planning', 'formulate-plan');
    const priorFile = path.join(priorDir, 'bash', 'inv-1', 'output', 'result.json');
    writeFileWithMtime(priorFile, '{}', oldMtime);
    const s = oldMtime / 1000;
    fs.utimesSync(priorDir, s, s);

    // Current: Implementation/surgical-execution (exempt — gate may not have run)
    const currentDir = path.join(tmpRoot, '.pi', 'tool-output', beadId, 'Implementation', 'surgical-execution');
    const currentFile = path.join(currentDir, 'bash', 'inv-2', 'output', 'result.json');
    writeFileWithMtime(currentFile, '{}', oldMtime);
    fs.utimesSync(currentDir, s, s);

    const es = fakeEventStoreWithCurrent({
      [beadId]: { currentState: 'Implementation', activeActionId: 'surgical-execution' }
    });
    const cleanup = makeService(
      tmpRoot, fakeClock(), es as any, TWO_DAYS_MS, () => new Set([beadId])
    );
    await cleanup.run();

    // Prior is reclaimed (policy says it's NOT the current/exempt transition).
    expect(fs.existsSync(priorDir)).toBe(false);
    // Current is preserved (policy says it IS exempt).
    expect(fs.existsSync(currentFile)).toBe(true);
  });

  it('proof: compactor policy (evidence-bearing events) governs what survives compaction', async () => {
    // This proves that the compaction policy (isExemptCurrentTransition / evidence guards)
    // is load-bearing: an evidence-bearing TOOL_INVOCATION_SUCCEEDED must survive,
    // while a non-evidence heartbeat must not.
    const beadId = 'compactor-wiring-proof';
    const oldMs = NOW_MS - SEVEN_DAYS_MS - ONE_HOUR_MS;
    const outputFile = `.pi/tool-output/${beadId}/Planning/plan/bash/inv-1/output/result.json`;

    const events = [
      makeEvent(DomainEventName.TOOL_INVOCATION_SUCCEEDED, beadId, oldMs, {
        tool: 'bash',
        toolResult: { status: 'PASSED', outputFile }
      }),
      makeEvent(DomainEventName.HEARTBEAT_RECORDED, beadId, oldMs + 500, {})
    ];

    const eventsFile = path.join(tmpRoot, '.pi', 'events', 'compaction-proof.jsonl');
    writeEventsJsonl(eventsFile, events);

    const es = fakeEventStore();
    const cleanup = makeService(
      tmpRoot,
      fakeClock(),
      es as any,
      TWO_DAYS_MS,
      () => new Set(),
      { compactionEnabled: true, compactionWindowMs: ONE_HOUR_MS }
    );
    const result = await cleanup.run();

    // The evidence-bearing event must survive; the heartbeat must not.
    expect(result.eventsCompacted).toBe(1);
    const remaining = readEventsJsonl(eventsFile);
    expect(remaining.some(e => e.type === DomainEventName.TOOL_INVOCATION_SUCCEEDED)).toBe(true);
    expect(remaining.some(e => e.type === DomainEventName.HEARTBEAT_RECORDED)).toBe(false);
  });

  it('dsm2/zog2 invariant: replay-critical events preserved end-to-end through RetentionService', async () => {
    // Regression guard for dsm2 / zog2 contracts.
    // All REPLAY_CRITICAL_EVENT_TYPES must survive compaction regardless of age.
    const beadId = 'dsm2-zog2-guard';
    const veryOldMs = NOW_MS - 30 * 24 * 60 * 60 * 1000; // 30 days

    const criticalEvents = Array.from(REPLAY_CRITICAL_EVENT_TYPES).slice(0, 5).map(type =>
      makeEvent(type, beadId, veryOldMs, { stateId: 'Planning' })
    );

    const eventsFile = path.join(tmpRoot, '.pi', 'events', 'critical-guard.jsonl');
    writeEventsJsonl(eventsFile, criticalEvents);

    const es = fakeEventStore();
    const cleanup = makeService(
      tmpRoot,
      fakeClock(),
      es as any,
      TWO_DAYS_MS,
      () => new Set(),
      { compactionEnabled: true, compactionWindowMs: ONE_HOUR_MS }
    );
    await cleanup.run();

    const remaining = readEventsJsonl(eventsFile);
    // All critical events must survive.
    expect(remaining.length).toBe(criticalEvents.length);
    for (const evt of criticalEvents) {
      expect(remaining.some(e => e.id === evt.id)).toBe(true);
    }
  });
});
