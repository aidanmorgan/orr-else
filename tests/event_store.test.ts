import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventStore } from '../src/core/EventStore.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { getProjectRoot, setProjectRoot } from '../src/core/Paths.js';
import { DomainEventName, PluginToolName } from '../src/constants/index.js';

describe('EventStore projections', () => {
  let tempRoot: string;
  let previousRoot: string;
  let configLoader: ConfigLoader;
  let eventStore: EventStore;

  beforeEach(() => {
    previousRoot = getProjectRoot();
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-event-store-'));
    setProjectRoot(tempRoot);
    configLoader = new ConfigLoader();
    eventStore = new EventStore(configLoader);
    eventStore.setSessionId(`test-${process.pid}`);
    fs.mkdirSync(path.join(tempRoot, '.pi/events'), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Planning
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    actions: []
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
  Implementation:
    identity: { role: "Builder", expertise: "Implementation", constraints: [] }
    baseInstructions: "Build"
    actions: []
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`);
  });

  afterEach(() => {
    setProjectRoot(previousRoot);
    configLoader.reset();
    eventStore.setSessionId(`test-${process.pid}-reset`);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('streams once into per-bead projections for batch reads', async () => {
    const eventsPath = path.join(tempRoot, '.pi/events/project.jsonl');
    const records = [
      {
        id: 'e0',
        type: DomainEventName.BEAD_METADATA_MERGED,
        timestamp: '2026-01-01T00:00:00.000Z',
        sessionId: 's1',
        data: {
          beadId: 'other',
          patch: { status: 'Planning', handovers: { Planning: 'unrelated' } }
        }
      },
      {
        id: 'e1',
        type: DomainEventName.BEAD_METADATA_MERGED,
        timestamp: '2026-01-01T00:00:01.000Z',
        sessionId: 's1',
        data: {
          beadId: 'bd-1',
          patch: {
            status: 'Planning',
            retryCount: 2,
            handovers: { Planning: 'ready for implementation' }
          }
        }
      },
      {
        id: 'e2',
        type: DomainEventName.CHECKLIST_ITEM_TICKED,
        timestamp: '2026-01-01T00:00:02.000Z',
        sessionId: 's1',
        data: {
          beadId: 'bd-1',
          text: 'Read project rules',
          evidence: 'CLAUDE.md and AGENTS.md'
        }
      },
      {
        id: 'e3',
        type: DomainEventName.BEAD_METADATA_MERGED,
        timestamp: '2026-01-01T00:00:03.000Z',
        sessionId: 's1',
        data: {
          beadId: 'bd-2',
          patch: { status: 'Implementation', compactionCount: 1 }
        }
      }
    ];
    fs.writeFileSync(eventsPath, `${records.map(record => JSON.stringify(record)).join('\n')}\nnot-json\n`);

    const projections = await eventStore.projectBeads(['bd-1', 'bd-2']);

    expect(projections.get('bd-1')).toMatchObject({
      status: 'Planning',
      retryCount: 2,
      handovers: { Planning: 'ready for implementation' },
      checklists: {
        'Read project rules': {
          checked: true,
          evidence: 'CLAUDE.md and AGENTS.md'
        }
      }
    });
    expect(projections.get('bd-2')).toMatchObject({
      status: 'Implementation',
      compactionCount: 1
    });
    expect(projections.has('other')).toBe(false);

    const summaries = await eventStore.projectBeads(['bd-1'], { includeDetails: false });
    expect(summaries.get('bd-1')).toMatchObject({
      status: 'Planning',
      retryCount: 2
    });
    expect(summaries.get('bd-1')?.handovers).toBeUndefined();
    expect(summaries.get('bd-1')?.checklists).toBeUndefined();
  });

  it('can exclude heartbeat tool wrapper events from latest progress reads', async () => {
    const eventsPath = path.join(tempRoot, '.pi/events/project.jsonl');
    const records = [
      {
        id: 'e1',
        type: DomainEventName.CONTEXT_COMPACTION_RECORDED,
        timestamp: '2026-01-01T00:00:01.000Z',
        sessionId: 's1',
        data: { beadId: 'bd-1', stateId: 'Planning' }
      },
      {
        id: 'e2',
        type: DomainEventName.TOOL_INVOCATION_SUCCEEDED,
        timestamp: '2026-01-01T00:00:02.000Z',
        sessionId: 's1',
        data: { beadId: 'bd-1', stateId: 'Planning', tool: PluginToolName.BD_HEARTBEAT }
      }
    ];
    fs.writeFileSync(eventsPath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);

    const latestWithoutFilter = await eventStore.latestEventsForBeads(['bd-1']);
    const latestWithFilter = await eventStore.latestEventsForBeads(['bd-1'], {
      excludeToolNames: [PluginToolName.BD_HEARTBEAT]
    });

    expect(latestWithoutFilter.get('bd-1')?.id).toBe('e2');
    expect(latestWithFilter.get('bd-1')?.id).toBe('e1');
  });

  it('projects the session that created an active lease', async () => {
    const eventsPath = path.join(tempRoot, '.pi/events/project.jsonl');
    const records = [
      {
        id: 'e1',
        type: DomainEventName.BEAD_CLAIMED,
        timestamp: '2026-01-01T00:00:01.000Z',
        sessionId: 'session-old',
        data: {
          beadId: 'bd-1',
          owner: 'Orr Else',
          stateId: 'Planning',
          lease: { owner: 'Orr Else', expiresAt: '2026-01-01T01:00:00.000Z' }
        }
      }
    ];
    fs.writeFileSync(eventsPath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);

    const projection = await eventStore.projectBeads(['bd-1']);
    const stateChart = await eventStore.projectBeadStateChart('bd-1');

    expect(projection.get('bd-1')?.leaseSessionId).toBe('session-old');
    expect(stateChart.leaseSessionId).toBe('session-old');
  });

  it('compacts lifecycle failure handovers in statechart projections', async () => {
    const eventsPath = path.join(tempRoot, '.pi/events/project.jsonl');
    const noisyUsageLimit = [
      'Agent lifecycle failure during turn_end: Codex error:',
      '{"type":"error","error":{"type":"usage_limit_reached","message":"The usage limit has been reached"},',
      '"headers":{"X-Codex-Primary-Reset-After-Seconds":"600","X-Codex-Secondary-Reset-After-Seconds":"600000"}}'
    ].join(' ');
    const noisyContextOverflow = [
      'Agent lifecycle failure during turn_end: Codex error:',
      '{"type":"error","error":{"code":"context_length_exceeded","message":"Your input exceeds the context window of this model"}}'
    ].join(' ');
    const records = [
      {
        id: 'e1',
        type: DomainEventName.STATE_TRANSITION_APPLIED,
        timestamp: '2026-01-01T00:00:01.000Z',
        sessionId: 's1',
        data: {
          beadId: 'bd-1',
          fromState: 'Planning',
          nextState: 'Planning',
          transitionEvent: 'CONTEXT_RESTART',
          actionKey: 'workflow=cerdiwen-codemap-v7/state=Planning/action=formulate-plan',
          handover: noisyUsageLimit
        }
      },
      {
        id: 'e2',
        type: DomainEventName.CONTEXT_RESTART_REQUESTED,
        timestamp: '2026-01-01T00:00:02.000Z',
        sessionId: 's1',
        data: {
          beadId: 'bd-1',
          stateId: 'Implementation',
          transitionEvent: 'CONTEXT_RESTART',
          actionKey: 'workflow=cerdiwen-codemap-v7/state=Implementation/action=surgical-execution',
          handover: noisyContextOverflow
        }
      }
    ];
    fs.writeFileSync(eventsPath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);

    const projection = await eventStore.projectBeadStateChart('bd-1');

    expect(projection.handovers.Planning).toContain('usage limit reached');
    expect(projection.handovers.Planning).not.toContain('X-Codex-Secondary-Reset-After-Seconds');
    expect(projection.handovers.Implementation).toContain('context window exceeded');
    expect(projection.handovers.Implementation).not.toContain('Your input exceeds the context window');
  });

  it('compacts transient harness failure handovers in statechart projections', async () => {
    const eventsPath = path.join(tempRoot, '.pi/events/project.jsonl');
    const records = [
      {
        id: 'e1',
        type: DomainEventName.STATE_TRANSITION_APPLIED,
        timestamp: '2026-01-01T00:00:01.000Z',
        sessionId: 's1',
        data: {
          beadId: 'bd-1',
          fromState: 'Planning',
          nextState: 'Planning',
          transitionEvent: 'BLOCKED',
          actionKey: 'workflow=cerdiwen-codemap-v7/state=Planning/action=formulate-plan',
          summary: 'Agent lifecycle failure during turn_end: WebSocket closed 1000',
          evidence: 'Agent lifecycle failure during turn_end: WebSocket closed 1000'
        }
      },
      {
        id: 'e2',
        type: DomainEventName.HARNESS_RESTART_REQUESTED,
        timestamp: '2026-01-01T00:00:02.000Z',
        sessionId: 's1',
        data: {
          beadId: 'bd-1',
          stateId: 'Planning',
          targetState: 'Planning',
          transitionEvent: 'HARNESS_RESTART',
          actionKey: 'workflow=cerdiwen-codemap-v7/state=Planning/action=formulate-plan',
          handover: 'Agent lifecycle failure during turn_end: WebSocket closed 1000',
          summary: 'Agent lifecycle failure during turn_end: WebSocket closed 1000',
          evidence: 'Agent lifecycle failure during turn_end: WebSocket closed 1000'
        }
      }
    ];
    fs.writeFileSync(eventsPath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);

    const projection = await eventStore.projectBeadStateChart('bd-1');

    expect(projection.restartKind).toBe('harness');
    expect(projection.handovers.Planning).toContain('transient harness transport error');
    expect(projection.handovers.Planning).not.toContain('WebSocket closed 1000');
    expect(projection.transitions[0].summary).toContain('transient harness transport error');
    expect(projection.transitions[0].summary).not.toContain('WebSocket closed 1000');
    expect(projection.transitions[0].evidence).toContain('transient harness transport error');
    expect(projection.transitions[0].evidence).not.toContain('WebSocket closed 1000');
  });
});
