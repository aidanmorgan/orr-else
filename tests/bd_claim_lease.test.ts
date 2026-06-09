/**
 * BD_CLAIM lease-ownership fallback (pi-experiment-0w1e).
 *
 * When the atomic `bd update --claim` fails, BD_CLAIM falls back to reading the
 * current issue. An already-in-progress bead must ONLY be treated as a
 * successful self-claim when its existing lease owner matches the claimant.
 * A bead leased by a DIFFERENT owner must be REJECTED (claim throws) rather
 * than spuriously reported as a self-claim.
 */

import { describe, expect, it, vi } from 'vitest';
import { execa } from 'execa';
import { createBdPlugin } from '../src/plugins/bd.js';
import { PluginToolName } from '../src/constants/domain.js';

// fs/promises mock — only the JSONL export writes/reads are stubbed. mkdir/open
// stay real so the bd-cli lock file can be created (the claim path acquires it).
const fsMock = vi.hoisted(() => ({
  readFile: vi.fn(async (): Promise<string> => ''),
  writeFile: vi.fn(async () => undefined)
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: fsMock.readFile, writeFile: fsMock.writeFile };
});

vi.mock('execa', () => ({ execa: vi.fn() }));

function makeEventStore() {
  // projectBead returns no harness metadata, so the lease owner derives from
  // the issue's assignee/owner field (the path under test).
  return {
    record: vi.fn().mockResolvedValue(undefined),
    projectBead: vi.fn().mockResolvedValue({}),
    projectBeads: vi.fn().mockResolvedValue(new Map())
  } as any;
}

// Wire execa so the `update --claim` rejects (forcing the fallback) and `show`
// returns the given in-progress issue.
function wireExeca(issue: Record<string, unknown>) {
  vi.mocked(execa).mockReset();
  vi.mocked(execa).mockImplementation((async (_bin: string, args: string[]) => {
    const cmd = args.find(a => a === 'update' || a === 'show' || a === 'close');
    if (cmd === 'update') {
      throw new Error('bd: cannot claim — already claimed by another worker');
    }
    if (cmd === 'show') {
      return { stdout: JSON.stringify(issue), stderr: '' };
    }
    return { stdout: '', stderr: '' };
  }) as any);
}

function claimTool() {
  const plugin = createBdPlugin(makeEventStore());
  const tool = plugin.tools.find(t => t.name === PluginToolName.BD_CLAIM);
  if (!tool) throw new Error('missing bd_claim');
  return tool;
}

describe('BD_CLAIM — lease-ownership fallback', () => {
  // NEGATIVE: in-progress bead leased by a DIFFERENT owner must be rejected.
  it('rejects when the in-progress bead is leased by a different owner', async () => {
    wireExeca({ id: 'bd-1', title: 'T', status: 'in_progress', assignee: 'OtherWorker' });
    const tool = claimTool();

    await expect(
      tool.execute({ id: 'bd-1', owner: 'Me' })
    ).rejects.toThrow(/already in progress and leased by/i);
  });

  // POSITIVE: in-progress bead already leased by THIS claimant is a self-claim.
  it('accepts when the in-progress bead is already leased by the claimant', async () => {
    wireExeca({ id: 'bd-1', title: 'T', status: 'in_progress', assignee: 'Me' });
    const tool = claimTool();

    const result = await tool.execute({ id: 'bd-1', owner: 'Me' }) as { id: string; lease: { owner: string } };
    expect(result.id).toBe('bd-1');
    expect(result.lease.owner).toBe('Me');
  });
});
