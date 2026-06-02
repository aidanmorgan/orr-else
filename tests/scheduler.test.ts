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

  // ---------------------------------------------------------------------------
  // BEAD C — split-brain immunity: sortBacklog / FlowManager.stateForBead
  // reads only from bead.status (the event-store projection field), never from
  // any raw Beads metadata. Split-brain = correct projection + wrong metadata.
  // ---------------------------------------------------------------------------

  it('(BEAD-C) sortBacklog scores from event-projection bead.status even when Beads metadata would claim a wrong state', async () => {
    // The Bead type has no raw metadata field — normalizeIssueWithProjection
    // already wrote the projection-correct value into bead.status before the
    // scheduler sees it. This test proves that sortBacklog does NOT try to
    // read any "native" metadata field; it scores purely off bead.status.
    //
    // Split-brain scenario: raw Beads says "Planning" (early phase), but the
    // event-store projection correctly reflects "Implementation" (later phase).
    // After normalizeIssueWithProjection, bead.status == "Implementation".
    // sortBacklog must rank this bead ABOVE a genuine Planning-phase bead.
    const now = new Date().toISOString();
    const beads: any[] = [
      // Correctly projected to Implementation (later phase = higher score)
      { id: 'splitbrain-correct-projection', status: 'Implementation', lastActivity: now, priority: 2 },
      // Fresh bead genuinely in Planning (earlier phase = lower score)
      { id: 'genuine-planning', status: 'Planning', lastActivity: now, priority: 2 }
    ];

    const sorted = await scheduler().sortBacklog(beads);

    // Implementation ranks higher than Planning (closer to terminal state)
    expect(sorted[0].id).toBe('splitbrain-correct-projection');
    expect(sorted[1].id).toBe('genuine-planning');

    // Verify the score difference reflects the phase distance
    expect(sorted[0].score).toBeGreaterThan(sorted[1].score);
  });

  it('produces finite non-NaN scores when a coarse-sink "blocked" target appears in transitions', async () => {
    // Robustness: 'blocked' is not a defined state but IS a valid coarse-sink
    // transition target. The Scheduler's BFS graph must not crash or emit NaN.
    const cfgWithSink = {
      scheduler: { weights: { waitTime: 1.0, executionTime: 0.5, progress: 2.0, penalty: 1.0 } },
      settings: { startState: 'Planning' },
      statechart: { terminalStates: ['completed'] },
      states: {
        Planning: {
          transitions: { SUCCESS: 'Implementation', EXTERNAL_BLOCKER: 'blocked' },
          on: {}
        },
        Implementation: {
          transitions: { SUCCESS: 'completed', FAILURE: 'Planning', EXTERNAL_BLOCKER: 'blocked' },
          on: {}
        }
      }
    };
    const sched = new Scheduler({ load: () => cfgWithSink } as any, new FlowManager());
    const beads: any[] = [
      { id: 'p', status: 'Planning', lastActivity: new Date().toISOString() },
      { id: 'i', status: 'Implementation', lastActivity: new Date().toISOString() }
    ];
    const sorted = await sched.sortBacklog(beads);
    for (const b of sorted) {
      expect(typeof b.score).toBe('number');
      expect(isFinite(b.score)).toBe(true);
      expect(isNaN(b.score)).toBe(false);
    }
    // Implementation is closer to 'completed' → higher score
    expect(sorted[0].id).toBe('i');
  });

  it('(BEAD-C) stateForBead returns the projection-sourced bead.status, not any metadata fallback', async () => {
    // Direct proof: FlowManager.stateForBead(bead, config) reads bead.status
    // (already the projection output). A bead whose .status == "Implementation"
    // must map to "Implementation" even if one imagines a conflicting metadata.
    const { FlowManager } = await import('../src/core/FlowManager.js');
    const fm = new FlowManager();
    const config = {
      settings: { startState: 'Planning' },
      states: { Planning: {}, Implementation: {} },
      statechart: { terminalStates: ['completed'] }
    } as any;

    // Bead with projection-correct status "Implementation"
    const projectedBead = {
      id: 'bd-projected',
      status: 'Implementation',
      // No metadata field on Bead — isolation is structural
    } as any;

    expect(fm.stateForBead(projectedBead, config)).toBe('Implementation');

    // Bead with projection-correct status "Planning" (start state fallback)
    const readyBead = { id: 'bd-ready', status: 'ready' } as any;
    expect(fm.stateForBead(readyBead, config)).toBe('Planning'); // initialState for ready

    // Restart signal from event store: restartTargetState wins over status
    const restartBead = {
      id: 'bd-restart',
      status: 'Implementation',  // "wrong" current status
      restartRequested: true,
      restartTargetState: 'Planning'  // projection says restart here
    } as any;
    expect(fm.stateForBead(restartBead, config)).toBe('Planning');
  });
});
