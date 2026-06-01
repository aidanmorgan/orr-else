import { describe, expect, it } from 'vitest';
import { Scheduler } from '../src/core/Scheduler.js';
import { FlowManager } from '../src/core/FlowManager.js';
import { App, BeadStatus } from '../src/constants/index.js';

function scheduler(): Scheduler {
  const configLoader = {
    load: () => ({
      scheduler: {
        weights: { waitTime: 1.0, executionTime: 0.5, progress: 2.0, penalty: 1.0 }
      },
      settings: { startState: 'Planning' },
      states: {
        Planning: { transitions: { SUCCESS: 'Implementation' }, on: {} },
        Implementation: { transitions: { SUCCESS: 'completed' }, on: {} }
      }
    })
  };
  return new Scheduler(configLoader as any, new FlowManager());
}

describe('Scheduler', () => {
  it('should sort beads based on progress score', async () => {
    const beads: any[] = [
      { id: 'bead-1', status: 'Planning', lastActivity: new Date().toISOString() },
      { id: 'bead-2', status: 'Implementation', lastActivity: new Date().toISOString() }
    ];

    const sorted = await scheduler().sortBacklog(beads);
    expect(sorted[0].id).toBe('bead-2');
  });

  it('should apply penalty for retries', async () => {
    const now = new Date().toISOString();
    const beads: any[] = [
      { id: 'bead-1', status: 'Planning', lastActivity: now, retryCount: 5 },
      { id: 'bead-2', status: 'Planning', lastActivity: now, retryCount: 0 }
    ];

    const sorted = await scheduler().sortBacklog(beads);
    expect(sorted[0].id).toBe('bead-2');
    expect(sorted[1].id).toBe('bead-1');
  });

  it('prioritizes restart-requested beads over fresh work', async () => {
    const now = new Date().toISOString();
    const beads: any[] = [
      { id: 'fresh', status: 'Implementation', lastActivity: now, priority: 2 },
      { id: 'restart', status: 'Planning', lastActivity: now, priority: 2, restartRequested: true, restartTargetState: 'Planning' }
    ];

    const sorted = await scheduler().sortBacklog(beads);

    expect(sorted[0].id).toBe('restart');
  });

  it('orders same-state beads by Beads priority', async () => {
    const now = new Date().toISOString();
    const beads: any[] = [
      { id: 'low', status: 'Planning', lastActivity: now, priority: 4 },
      { id: 'high', status: 'Planning', lastActivity: now, priority: 1 }
    ];

    const sorted = await scheduler().sortBacklog(beads);

    expect(sorted[0].id).toBe('high');
  });

  it('prioritizes resumable statechart work over fresh ready work', async () => {
    const now = new Date().toISOString();
    const beads: any[] = [
      { id: 'fresh', status: BeadStatus.READY, lastActivity: now, priority: 0 },
      { id: 'resume', status: 'Planning', lastActivity: now, priority: 4, assigned_to: App.DISPLAY_NAME }
    ];

    const sorted = await scheduler().sortBacklog(beads);

    expect(sorted[0].id).toBe('resume');
  });

  it('prioritizes later resumable statechart phases over stale earlier phases', async () => {
    const now = new Date().toISOString();
    const stale = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const beads: any[] = [
      { id: 'stale-requirements', status: 'Planning', lastActivity: stale, priority: 2, assigned_to: App.DISPLAY_NAME },
      { id: 'recent-implementation', status: 'Implementation', lastActivity: now, priority: 2, assigned_to: App.DISPLAY_NAME }
    ];

    const sorted = await scheduler().sortBacklog(beads);

    expect(sorted[0].id).toBe('recent-implementation');
  });
});
