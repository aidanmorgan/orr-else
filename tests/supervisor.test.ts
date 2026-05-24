import { describe, expect, it, vi } from 'vitest';
import { Supervisor } from '../src/core/Supervisor.js';
import { DomainEventName, PluginToolName, TimeMs } from '../src/constants/index.js';

const IMMEDIATE_NO_PROGRESS_TIMEOUT_MS = 1;
const STALE_PROGRESS_AGE_MS = TimeMs.MINUTE;

function supervisorHarness(latestProgressAtMs: number) {
  const records: Array<{ event: string; data: any }> = [];
  const release = vi.fn(async () => ({ id: 'bead-1' }));
  const terminateTeammatesForBead = vi.fn(async () => ({ terminatedPaneIds: ['%1'] }));
  const eventStore = {
    record: vi.fn(async (event: string, data: any) => records.push({ event, data })),
    latestEventsForBeads: vi.fn(async () => new Map([
      ['bead-1', {
        id: 'event-1',
        type: DomainEventName.CONTEXT_COMPACTION_RECORDED,
        timestamp: new Date(latestProgressAtMs).toISOString(),
        sessionId: 'session-1',
        data: { beadId: 'bead-1', stateId: 'Planning' }
      }]
    ]))
  };
  const supervisor = new Supervisor(
    {} as any,
    { hasUI: false } as any,
    {
      getHeartbeatSnapshot: () => [{
        workerId: 'worker-1',
        beadId: 'bead-1',
        stateId: 'Planning',
        timestampMs: Date.now()
      }]
    } as any,
    {
      getLiveTeammateBeadIds: vi.fn(async () => new Set(['bead-1'])),
      terminateTeammatesForBead
    } as any,
    { tracedAsync: (_name: string, _attrs: any, fn: any) => fn } as any,
    {
      configLoader: {
        load: async () => ({
          settings: {
            harnessRestartEvent: 'HARNESS_RESTART',
            teammateNoProgressTimeoutMs: IMMEDIATE_NO_PROGRESS_TIMEOUT_MS
          }
        })
      },
      eventStore,
      plugins: {
        bd: {
          tools: [{ name: 'bd_release', execute: release }]
        }
      }
    } as any,
    { maxSlots: 1 }
  );
  return { supervisor, records, release, terminateTeammatesForBead };
}

describe('Supervisor', () => {
  it('restarts a teammate that heartbeats without non-heartbeat progress', async () => {
    const { supervisor, records, release, terminateTeammatesForBead } = supervisorHarness(Date.now() - STALE_PROGRESS_AGE_MS);

    await (supervisor as any).recordSlotHealth('test');

    expect(records.find(record => record.event === DomainEventName.TEAMMATE_SLOT_HEALTH_CHECKED)?.data).toMatchObject({
      workingCount: 0,
      inactiveBeadIds: ['bead-1']
    });
    expect((supervisor as any).services.eventStore.latestEventsForBeads).toHaveBeenCalledWith(['bead-1'], expect.objectContaining({
      excludeToolNames: [PluginToolName.BD_HEARTBEAT]
    }));
    expect(records.some(record => record.event === DomainEventName.AGENT_TURN_FAILED)).toBe(true);
    expect(records.some(record => record.event === DomainEventName.HARNESS_RESTART_REQUESTED)).toBe(true);
    expect(terminateTeammatesForBead).toHaveBeenCalledWith('bead-1', expect.stringContaining('without non-heartbeat progress'));
    expect(release).toHaveBeenCalledWith({ id: 'bead-1' });
  });

  it('keeps a teammate working when recent non-heartbeat progress exists', async () => {
    const { supervisor, records, release, terminateTeammatesForBead } = supervisorHarness(Date.now());

    await (supervisor as any).recordSlotHealth('test');

    expect(records.find(record => record.event === DomainEventName.TEAMMATE_SLOT_HEALTH_CHECKED)?.data).toMatchObject({
      workingCount: 1,
      inactiveBeadIds: []
    });
    expect(terminateTeammatesForBead).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });
});
