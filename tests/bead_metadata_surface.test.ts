/**
 * Tests for bead/myv3.2: surface Bead.metadata on the read path.
 *
 * AC1: A bead whose bd show --json includes metadata: {phase, pre_review_verdict}
 *      surfaces BOTH keys on Bead.metadata.
 *
 * AC2: A bead with metadata.orr_else does NOT leak orr_else onto Bead.metadata,
 *      and runtime projection still wins for reserved fields.
 *
 * BEAD-C: Existing invariant confirmed unchanged — event-store projection wins
 *         over ANY conflicting issue.metadata values.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execa } from 'execa';
import { createBdPlugin, stripReservedMetadataKeys } from '../src/plugins/bd.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { EventStore } from '../src/core/EventStore.js';

// Mock open (and mkdir) so BeadsClient lock operations don't hit the real FS.
const fsMock = vi.hoisted(() => ({
  mkdir: vi.fn(async () => undefined),
  open: vi.fn(async () => ({ close: async () => undefined })),
  readFile: vi.fn(async (_path: string, _enc: string) => ''),
  writeFile: vi.fn(async () => undefined)
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    mkdir: fsMock.mkdir,
    open: fsMock.open as unknown as typeof actual.open,
    readFile: fsMock.readFile,
    writeFile: fsMock.writeFile
  };
});

// Mock proper-lockfile so lock/unlock don't touch the real FS.
vi.mock('proper-lockfile', () => ({
  default: {
    lock: vi.fn(async () => async () => undefined),
    unlock: vi.fn(async () => undefined)
  }
}));

const execaMock = vi.hoisted(() =>
  vi.fn(async (_bin: string, _args: string[], _options: any = {}) => ({
    stdout: '',
    stderr: ''
  }))
);

vi.mock('execa', () => ({ execa: execaMock }));

// ---------------------------------------------------------------------------
// Unit tests for the shared helper
// ---------------------------------------------------------------------------

describe('stripReservedMetadataKeys', () => {
  it('passes through string, number, and boolean values unchanged', () => {
    const result = stripReservedMetadataKeys({ phase: 'planning', score: 3, done: true });
    expect(result).toEqual({ phase: 'planning', score: 3, done: true });
  });

  it('strips the orr_else key', () => {
    const result = stripReservedMetadataKeys({
      phase: 'planning',
      orr_else: { status: 'Planning', assigned_to: 'someone' }
    });
    expect(result).toEqual({ phase: 'planning' });
    expect('orr_else' in result).toBe(false);
  });

  it('drops object values (only scalar types are surfaced)', () => {
    const result = stripReservedMetadataKeys({
      phase: 'planning',
      nested: { foo: 'bar' }
    });
    expect(result).toEqual({ phase: 'planning' });
  });

  it('returns empty object when input has only reserved or non-scalar keys', () => {
    const result = stripReservedMetadataKeys({ orr_else: { status: 'x' } });
    expect(result).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Integration tests via bd_get_bead (tests BEAD-C and AC1/AC2 together)
// ---------------------------------------------------------------------------

describe('Bead.metadata surface on read path', () => {
  let bdPlugin: ReturnType<typeof createBdPlugin>;

  function tool(name: string) {
    const found = bdPlugin.tools.find(t => t.name === name);
    if (!found) throw new Error(`missing tool ${name}`);
    return found;
  }

  beforeEach(() => {
    vi.mocked(execa).mockClear();
    fsMock.mkdir.mockClear().mockResolvedValue(undefined as never);
    fsMock.open.mockClear().mockResolvedValue({ close: async () => undefined } as never);
    fsMock.readFile.mockClear().mockResolvedValue('' as never);
    fsMock.writeFile.mockClear().mockResolvedValue(undefined as never);
  });

  // AC1 — free-form metadata keys surface on Bead.metadata
  it('(AC1) surfaces free-form metadata keys from bd show --json onto Bead.metadata', async () => {
    vi.mocked(execa).mockResolvedValueOnce({
      stdout: JSON.stringify([{
        id: 'bd-ac1',
        title: 'AC1 Test',
        status: 'open',
        priority: 1,
        metadata: {
          phase: 'spike',
          pre_review_verdict: true,
          revision_count: 3
        }
      }]),
      stderr: ''
    } as any);

    bdPlugin = createBdPlugin({
      record: vi.fn().mockResolvedValue(undefined),
      projectBead: vi.fn().mockResolvedValue({}),
      projectBeads: vi.fn().mockResolvedValue(new Map())
    } as any);

    const result = await tool('bd_get_bead').execute({ id: 'bd-ac1', includeDetails: false }) as any;

    expect(result.metadata).toBeDefined();
    expect(result.metadata.phase).toBe('spike');
    expect(result.metadata.pre_review_verdict).toBe(true);
    expect(result.metadata.revision_count).toBe(3);
  });

  // AC2 — orr_else is stripped AND event-store projection wins (extends BEAD-C)
  it('(AC2) strips orr_else from Bead.metadata and event-store projection wins', async () => {
    vi.mocked(execa).mockResolvedValueOnce({
      stdout: JSON.stringify([{
        id: 'bd-ac2',
        title: 'AC2 Test',
        status: 'open',
        priority: 1,
        metadata: {
          phase: 'review',
          orr_else: {
            // WRONG — conflicts with projection below
            status: 'Implementation',
            assigned_to: 'wrong-owner'
          }
        }
      }]),
      stderr: ''
    } as any);

    const correctProjection = {
      status: 'Planning',
      assigned_to: 'correct-owner',
      retryCount: 2,
      compactionCount: 0,
      totalExecutionTimeMs: 100,
      lastActivity: '2026-01-01T00:00:00.000Z'
    };

    bdPlugin = createBdPlugin({
      record: vi.fn().mockResolvedValue(undefined),
      projectBead: vi.fn().mockResolvedValue(correctProjection),
      projectBeads: vi.fn().mockResolvedValue(new Map([['bd-ac2', correctProjection]]))
    } as any);

    const result = await tool('bd_get_bead').execute({ id: 'bd-ac2', includeDetails: true }) as any;

    // orr_else must NOT appear on Bead.metadata
    expect(result.metadata).toBeDefined();
    expect('orr_else' in (result.metadata ?? {})).toBe(false);

    // Free-form key survives
    expect(result.metadata?.phase).toBe('review');

    // Event-store projection wins for runtime fields
    expect(result.status).toBe('Planning');
    expect(result.assigned_to).toBe('correct-owner');
    expect(result.retryCount).toBe(2);

    // Wrong values from issue.metadata.orr_else must NOT appear
    expect(result.status).not.toBe('Implementation');
    expect(result.assigned_to).not.toBe('wrong-owner');
  });

  // No metadata field when issue has no metadata
  it('omits Bead.metadata when the issue record has no metadata', async () => {
    vi.mocked(execa).mockResolvedValueOnce({
      stdout: JSON.stringify([{
        id: 'bd-nometa',
        title: 'No Meta',
        status: 'open',
        priority: 1
      }]),
      stderr: ''
    } as any);

    bdPlugin = createBdPlugin({
      record: vi.fn().mockResolvedValue(undefined),
      projectBead: vi.fn().mockResolvedValue({}),
      projectBeads: vi.fn().mockResolvedValue(new Map())
    } as any);

    const result = await tool('bd_get_bead').execute({ id: 'bd-nometa', includeDetails: false }) as any;
    expect(result.metadata).toBeUndefined();
  });

  // No metadata field when metadata has only reserved/non-scalar keys
  it('omits Bead.metadata when all metadata keys are stripped', async () => {
    vi.mocked(execa).mockResolvedValueOnce({
      stdout: JSON.stringify([{
        id: 'bd-reserved',
        title: 'Reserved Only',
        status: 'open',
        priority: 1,
        metadata: {
          orr_else: { status: 'Planning' }
        }
      }]),
      stderr: ''
    } as any);

    bdPlugin = createBdPlugin({
      record: vi.fn().mockResolvedValue(undefined),
      projectBead: vi.fn().mockResolvedValue({}),
      projectBeads: vi.fn().mockResolvedValue(new Map())
    } as any);

    const result = await tool('bd_get_bead').execute({ id: 'bd-reserved', includeDetails: false }) as any;
    expect(result.metadata).toBeUndefined();
  });
});
