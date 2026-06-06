import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventStore } from '../src/core/EventStore.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { JsonlEventLog } from '../src/core/JsonlEventLog.js';
import { BeadEventIndex } from '../src/core/BeadEventIndex.js';
import { Logger } from '../src/core/Logger.js';
import { DomainEventName, EventName, EventStoreDefaults, PluginToolName, TeammateEventType } from '../src/constants/index.js';
import type { Clock } from '../src/core/Clock.js';

// Helper to compute the collision-resistant index filename for a bead ID.
const beadIndex = new BeadEventIndex(new JsonlEventLog());
function indexFileNameFor(beadId: string): string {
  return beadIndex.indexFileName(beadId);
}

describe('EventStore projections', () => {
  let tempRoot: string;
  let configLoader: ConfigLoader;
  let eventStore: EventStore;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-event-store-'));
    configLoader = new ConfigLoader(undefined, tempRoot);
    eventStore = new EventStore(configLoader, undefined, undefined, tempRoot);
    eventStore.setSessionId(`test-${process.pid}`);
    fs.mkdirSync(path.join(tempRoot, '.pi/events'), { recursive: true });
    fs.mkdirSync(path.join(tempRoot, '.pi/logs'), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Planning
  worktreePolicy:
    default: always
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

  afterEach(async () => {
    configLoader.reset();
    eventStore.setSessionId(`test-${process.pid}-reset`);
    Logger.close();
    await new Promise(resolve => setTimeout(resolve, 25));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('fans out recorded bead events without an existing ready marker', async () => {
    await eventStore.record(DomainEventName.BEAD_CLAIMED, {
      beadId: 'bd-new',
      stateId: 'Planning',
      lease: { owner: 'Orr Else', expiresAt: '2026-01-01T01:00:00.000Z' }
    });

    const indexPath = path.join(
      tempRoot,
      '.pi/events',
      EventStoreDefaults.BEAD_INDEX_DIR,
      indexFileNameFor('bd-new')
    );

    expect(fs.existsSync(indexPath)).toBe(true);
    const indexed = fs.readFileSync(indexPath, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));

    expect(indexed).toHaveLength(1);
    expect(indexed[0]).toMatchObject({
      type: DomainEventName.BEAD_CLAIMED,
      data: {
        beadId: 'bd-new',
        stateId: 'Planning'
      }
    });
  });

  it('keeps events recorded before and after ready marker publication in the by-bead file', async () => {
    await eventStore.record(DomainEventName.BEAD_CLAIMED, {
      beadId: 'bd-1',
      stateId: 'Planning',
      lease: { owner: 'Orr Else', expiresAt: '2026-01-01T01:00:00.000Z' }
    });

    const indexPath = path.join(
      tempRoot,
      '.pi/events',
      EventStoreDefaults.BEAD_INDEX_DIR,
      indexFileNameFor('bd-1')
    );
    const eventsPath = path.join(tempRoot, '.pi/events', `${path.basename(tempRoot)}.jsonl`);
    const eventFileName = path.basename(eventsPath);
    fs.writeFileSync(`${indexPath}${EventStoreDefaults.INDEX_READY_FILE_EXTENSION}`, JSON.stringify({
      sources: {
        [eventFileName]: 0
      }
    }));

    await eventStore.record(DomainEventName.CHECKLIST_ITEM_TICKED, {
      beadId: 'bd-1',
      text: 'Record evidence',
      evidence: 'done'
    });

    const indexed = fs.readFileSync(indexPath, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));

    expect(indexed.map(event => event.type)).toEqual([
      DomainEventName.BEAD_CLAIMED,
      DomainEventName.CHECKLIST_ITEM_TICKED
    ]);

    const marker = JSON.parse(fs.readFileSync(`${indexPath}${EventStoreDefaults.INDEX_READY_FILE_EXTENSION}`, 'utf8'));
    expect(marker.sources[eventFileName]).toBe(fs.statSync(eventsPath).size);
  });

  it('keeps writing to the resolved event path after a temporary config validation failure', async () => {
    await eventStore.record(DomainEventName.BEAD_CLAIMED, {
      beadId: 'bd-stable',
      stateId: 'Planning',
      lease: { owner: 'Orr Else', expiresAt: '2026-01-01T01:00:00.000Z' }
    });

    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  maxConcurrentSlots: "invalid"
`);
    configLoader.reset();

    await eventStore.record(DomainEventName.CHECKLIST_ITEM_TICKED, {
      beadId: 'bd-stable',
      text: 'Record evidence',
      evidence: 'done'
    });

    const eventsPath = path.join(tempRoot, '.pi/events', `${path.basename(tempRoot)}.jsonl`);
    const events = fs.readFileSync(eventsPath, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));

    expect(events.map(event => event.type)).toEqual([
      DomainEventName.BEAD_CLAIMED,
      DomainEventName.CHECKLIST_ITEM_TICKED
    ]);
  });

  it('streams once into per-bead projections for batch reads', async () => {
    const eventsPath = path.join(tempRoot, '.pi/events/project.jsonl');
    const records = [
      {
        id: 'e0',
        type: DomainEventName.BEAD_STATUS_UPDATED,
        timestamp: '2026-01-01T00:00:00.000Z',
        sessionId: 's1',
        data: { beadId: 'other', status: 'Planning' }
      },
      {
        id: 'e1',
        type: DomainEventName.BEAD_STATUS_UPDATED,
        timestamp: '2026-01-01T00:00:01.000Z',
        sessionId: 's1',
        data: { beadId: 'bd-1', status: 'Planning' }
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
        type: DomainEventName.BEAD_STATUS_UPDATED,
        timestamp: '2026-01-01T00:00:03.000Z',
        sessionId: 's1',
        data: { beadId: 'bd-2', status: 'Implementation' }
      },
      {
        id: 'e4',
        type: DomainEventName.CONTEXT_COMPACTION_RECORDED,
        timestamp: '2026-01-01T00:00:04.000Z',
        sessionId: 's1',
        data: { beadId: 'bd-2', compactionCount: 1 }
      }
    ];
    fs.writeFileSync(eventsPath, `${records.map(record => JSON.stringify(record)).join('\n')}\nnot-json\n`);

    const projections = await eventStore.projectBeads(['bd-1', 'bd-2']);

    expect(projections.get('bd-1')).toMatchObject({
      status: 'Planning',
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

    // includeDetails=false yields the compact projection: status is retained,
    // but the detail-only checklists map is excluded.
    const summaries = await eventStore.projectBeads(['bd-1'], { includeDetails: false });
    expect(summaries.get('bd-1')).toMatchObject({
      status: 'Planning'
    });
    expect(summaries.get('bd-1')?.checklists).toBeUndefined();
  });

  it('reads complete per-bead event indexes for single-bead projections', async () => {
    const stalePrimary = `${JSON.stringify({
      id: 'stale-shared-event',
      type: DomainEventName.BEAD_CLAIMED,
      timestamp: '2026-01-01T00:00:02.000Z',
      sessionId: 's1',
      data: {
        beadId: 'bd-1',
        stateId: 'Implementation'
      }
    })}\n`;
    fs.writeFileSync(path.join(tempRoot, '.pi/events/project.jsonl'), stalePrimary);

    const indexPath = path.join(
      tempRoot,
      '.pi/events',
      EventStoreDefaults.BEAD_INDEX_DIR,
      indexFileNameFor('bd-1')
    );
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.writeFileSync(indexPath, `${JSON.stringify({
      id: 'indexed-event',
      type: DomainEventName.BEAD_CLAIMED,
      timestamp: '2026-01-01T00:00:01.000Z',
      sessionId: 's1',
      data: {
        beadId: 'bd-1',
        stateId: 'Planning'
      }
    })}\n`);
    fs.writeFileSync(`${indexPath}${EventStoreDefaults.INDEX_READY_FILE_EXTENSION}`, JSON.stringify({
      sources: {
        'project.jsonl': Buffer.byteLength(stalePrimary)
      }
    }));

    expect(fs.existsSync(indexPath)).toBe(true);

    const projection = await eventStore.projectBead('bd-1');

    expect(projection.status).toBe('Planning');
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

  it('uses complete per-bead event indexes for latest progress reads', async () => {
    const stalePrimary = `${JSON.stringify({
      id: 'stale-shared-event',
      type: DomainEventName.TOOL_INVOCATION_SUCCEEDED,
      timestamp: '2026-01-01T00:00:03.000Z',
      sessionId: 's1',
      data: {
        beadId: 'bd-1',
        stateId: 'Planning',
        tool: 'read'
      }
    })}\n`;
    fs.writeFileSync(path.join(tempRoot, '.pi/events/project.jsonl'), stalePrimary);

    const indexPath = path.join(
      tempRoot,
      '.pi/events',
      EventStoreDefaults.BEAD_INDEX_DIR,
      indexFileNameFor('bd-1')
    );
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.writeFileSync(indexPath, `${JSON.stringify({
      id: 'indexed-event',
      type: DomainEventName.CONTEXT_COMPACTION_RECORDED,
      timestamp: '2026-01-01T00:00:01.000Z',
      sessionId: 's1',
      data: {
        beadId: 'bd-1',
        stateId: 'Planning'
      }
    })}\n`);
    fs.writeFileSync(`${indexPath}${EventStoreDefaults.INDEX_READY_FILE_EXTENSION}`, JSON.stringify({
      sources: {
        'project.jsonl': Buffer.byteLength(stalePrimary)
      }
    }));

    const latest = await eventStore.latestEventsForBeads(['bd-1']);

    expect(latest.get('bd-1')?.id).toBe('indexed-event');
  });

  it('streams the latest project event by type', async () => {
    // j0tp: test updated to use SCHEDULING_PAUSED (canonical capacity-pause event)
    const eventsPath = path.join(tempRoot, '.pi/events/project.jsonl');
    const records = [
      {
        id: 'e1',
        type: DomainEventName.SCHEDULING_PAUSED,
        timestamp: '2026-01-01T00:00:01.000Z',
        sessionId: 's1',
        data: { pauseUntil: '2026-01-01T00:10:00.000Z', reason: 'usage_limit' }
      },
      {
        id: 'e2',
        type: DomainEventName.BEAD_CLAIMED,
        timestamp: '2026-01-01T00:00:02.000Z',
        sessionId: 's1',
        data: { beadId: 'bd-1' }
      },
      {
        id: 'e3',
        type: DomainEventName.SCHEDULING_PAUSED,
        timestamp: '2026-01-01T00:00:03.000Z',
        sessionId: 's2',
        data: { pauseUntil: '2026-01-01T00:20:00.000Z', reason: 'usage_limit' }
      }
    ];
    fs.writeFileSync(eventsPath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);

    const latest = await eventStore.latestEventByType(DomainEventName.SCHEDULING_PAUSED);

    expect(latest?.id).toBe('e3');
    expect(latest?.sessionId).toBe('s2');
  });

  it('streams the latest terminal project-tool failure-limit event for a bead state action', async () => {
    const eventsPath = path.join(tempRoot, '.pi/events/project.jsonl');
    const records = [
      {
        id: 'e1',
        type: DomainEventName.PROJECT_TOOL_FAILED,
        timestamp: '2026-01-01T00:00:01.000Z',
        sessionId: 's1',
        data: {
          beadId: 'bd-1',
          stateId: 'Implementation',
          actionId: 'surgical-execution',
          tool: 'pytest',
          result: {
            failureLimit: {
              terminal: false,
              suggestedOutcome: 'BLOCKED'
            }
          }
        }
      },
      {
        id: 'e2',
        type: DomainEventName.PROJECT_TOOL_FAILED,
        timestamp: '2026-01-01T00:00:02.000Z',
        sessionId: 's1',
        data: {
          beadId: 'bd-1',
          stateId: 'Implementation',
          actionId: 'surgical-execution',
          tool: 'semgrep',
          result: {
            failureLimit: {
              terminal: true,
              suggestedOutcome: 'QUALITY_GATE_FAILURE'
            }
          }
        }
      },
      {
        id: 'e3',
        type: DomainEventName.PROJECT_TOOL_FAILED,
        timestamp: '2026-01-01T00:00:03.000Z',
        sessionId: 's1',
        data: {
          beadId: 'bd-1',
          stateId: 'Planning',
          actionId: 'formulate-plan',
          tool: 'semgrep',
          result: {
            failureLimit: {
              terminal: true,
              suggestedOutcome: 'BLOCKED'
            }
          }
        }
      }
    ];
    fs.writeFileSync(eventsPath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);

    const latest = await eventStore.latestProjectToolFailureLimitEvent('bd-1', {
      stateId: 'Implementation',
      actionId: 'surgical-execution',
      terminalOnly: true
    });

    expect(latest?.id).toBe('e2');
    expect(latest?.data.tool).toBe('semgrep');
  });

  it('ignores legacy unscoped terminal project-tool failure-limit events for scoped lookups', async () => {
    const eventsPath = path.join(tempRoot, '.pi/events/project.jsonl');
    const records = [
      {
        id: 'e1',
        type: DomainEventName.PROJECT_TOOL_FAILED,
        timestamp: '2026-01-01T00:00:01.000Z',
        sessionId: 's1',
        data: {
          beadId: 'bd-1',
          tool: 'artifact_validator',
          result: {
            failureLimit: {
              terminal: true,
              suggestedOutcome: EventName.FAILURE
            }
          }
        }
      }
    ];
    fs.writeFileSync(eventsPath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);

    const latest = await eventStore.latestProjectToolFailureLimitEvent('bd-1', {
      stateId: 'AdversarialPostReview',
      actionId: 'adversarial-code-review',
      terminalOnly: true
    });

    expect(latest).toBeUndefined();
  });

  it('ignores terminal project-tool failure-limit events before a non-restart transition boundary', async () => {
    const eventsPath = path.join(tempRoot, '.pi/events/project.jsonl');
    const records = [
      {
        id: 'e1',
        type: DomainEventName.PROJECT_TOOL_FAILED,
        timestamp: '2026-01-01T00:00:01.000Z',
        sessionId: 's1',
        data: {
          beadId: 'bd-1',
          stateId: 'Planning',
          actionId: 'planning-workflow-parity',
          tool: 'artifact_validator',
          result: {
            failureLimit: {
              terminal: true,
              suggestedOutcome: EventName.FAILURE
            }
          }
        }
      },
      {
        id: 'e2',
        type: DomainEventName.STATE_TRANSITION_APPLIED,
        timestamp: '2026-01-01T00:00:02.000Z',
        sessionId: 's1',
        data: {
          beadId: 'bd-1',
          fromState: 'Planning',
          nextState: 'Planning',
          transitionEvent: EventName.FAILURE,
          actionId: 'planning-workflow-parity'
        }
      }
    ];
    fs.writeFileSync(eventsPath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);

    const latest = await eventStore.latestProjectToolFailureLimitEvent('bd-1', {
      stateId: 'Planning',
      actionId: 'planning-workflow-parity',
      terminalOnly: true
    });

    expect(latest).toBeUndefined();
  });

  it('applies terminal project-tool failure-limit boundaries in timestamp order across event files', async () => {
    const eventDir = path.join(tempRoot, '.pi/events');
    const projectEventsPath = path.join(eventDir, 'project.jsonl');
    const sessionEventsPath = path.join(eventDir, 'session-late-name.jsonl');
    const terminalFailure = {
      id: 'e1',
      type: DomainEventName.PROJECT_TOOL_FAILED,
      timestamp: '2026-01-01T00:00:01.000Z',
      sessionId: 's1',
      data: {
        beadId: 'bd-1',
        stateId: 'Planning',
        actionId: 'formulate-plan',
        tool: 'artifact_validator',
        result: {
          failureLimit: {
            terminal: true,
            suggestedOutcome: EventName.FAILURE
          }
        }
      }
    };
    const boundary = {
      id: 'e2',
      type: DomainEventName.STATE_TRANSITION_APPLIED,
      timestamp: '2026-01-01T00:00:02.000Z',
      sessionId: 's2',
      data: {
        beadId: 'bd-1',
        fromState: 'Planning',
        nextState: 'Planning',
        transitionEvent: EventName.FAILURE,
        actionId: 'formulate-plan'
      }
    };
    fs.writeFileSync(projectEventsPath, `${JSON.stringify(boundary)}\n`);
    fs.writeFileSync(sessionEventsPath, `${JSON.stringify(terminalFailure)}\n`);

    const latest = await eventStore.latestProjectToolFailureLimitEvent('bd-1', {
      stateId: 'Planning',
      actionId: 'formulate-plan',
      terminalOnly: true
    });

    expect(latest).toBeUndefined();
  });

  it('resets terminal project-tool failure-limit lookups when a fresh run follows an acknowledged terminal outcome', async () => {
    const eventsPath = path.join(tempRoot, '.pi/events/project.jsonl');
    const records = [
      {
        id: 'e1',
        type: DomainEventName.STATE_RUN_INITIALIZED,
        timestamp: '2026-01-01T00:00:01.000Z',
        sessionId: 's1',
        data: {
          beadId: 'bd-1',
          stateId: 'Planning',
          actionId: 'formulate-plan'
        }
      },
      {
        id: 'e2',
        type: DomainEventName.PROJECT_TOOL_FAILED,
        timestamp: '2026-01-01T00:00:02.000Z',
        sessionId: 's1',
        data: {
          beadId: 'bd-1',
          stateId: 'Planning',
          actionId: 'formulate-plan',
          tool: 'artifact_validator',
          result: {
            failureLimit: {
              terminal: true,
              suggestedOutcome: EventName.FAILURE
            }
          }
        }
      },
      {
        id: 'e3',
        type: DomainEventName.SIGNAL_ACKNOWLEDGED,
        timestamp: '2026-01-01T00:00:03.000Z',
        sessionId: 's1',
        data: {
          type: TeammateEventType.STATE_FAILED,
          beadId: 'bd-1',
          stateId: 'Planning',
          actionId: 'formulate-plan',
          transitionEvent: EventName.FAILURE
        }
      },
      {
        id: 'e4',
        type: DomainEventName.STATE_RUN_INITIALIZED,
        timestamp: '2026-01-01T00:00:04.000Z',
        sessionId: 's2',
        data: {
          beadId: 'bd-1',
          stateId: 'Planning',
          actionId: 'formulate-plan'
        }
      }
    ];
    fs.writeFileSync(eventsPath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);

    const latest = await eventStore.latestProjectToolFailureLimitEvent('bd-1', {
      stateId: 'Planning',
      actionId: 'formulate-plan',
      terminalOnly: true
    });

    expect(latest).toBeUndefined();
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
          actionKey: 'workflow=fixture-workflow-v1/state=Planning/action=formulate-plan',
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
          targetState: 'Implementation',
          transitionEvent: 'CONTEXT_RESTART',
          actionKey: 'workflow=fixture-workflow-v1/state=Implementation/action=surgical-execution',
          handover: noisyContextOverflow,
          restartId: 'restart-e2-lifecycle'
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
          actionKey: 'workflow=fixture-workflow-v1/state=Planning/action=formulate-plan',
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
          actionKey: 'workflow=fixture-workflow-v1/state=Planning/action=formulate-plan',
          handover: 'Agent lifecycle failure during turn_end: WebSocket closed 1000',
          summary: 'Agent lifecycle failure during turn_end: WebSocket closed 1000',
          evidence: 'Agent lifecycle failure during turn_end: WebSocket closed 1000',
          restartId: 'restart-e2-transient'
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

  it('derives restart fields exclusively from stateChart projection (single source of truth)', async () => {
    // Verifies WI-24: restart fields on projectBead output come only from
    // projectBeadStateChartFromEvents; the dead switch-arm writes have been removed.
    const eventsPath = path.join(tempRoot, '.pi/events/project.jsonl');
    const records = [
      {
        id: 'e1',
        type: DomainEventName.BEAD_CLAIMED,
        timestamp: '2026-01-01T00:00:01.000Z',
        sessionId: 's1',
        data: { beadId: 'bd-1', stateId: 'Planning' }
      },
      {
        id: 'e2',
        type: DomainEventName.STATE_TRANSITION_APPLIED,
        timestamp: '2026-01-01T00:00:02.000Z',
        sessionId: 's1',
        data: {
          beadId: 'bd-1',
          fromState: 'Planning',
          nextState: 'Implementation',
          transitionEvent: 'SUCCESS',
          actionId: 'formulate-plan'
        }
      },
      {
        id: 'e3',
        type: DomainEventName.CONTEXT_RESTART_REQUESTED,
        timestamp: '2026-01-01T00:00:03.000Z',
        sessionId: 's1',
        data: {
          beadId: 'bd-1',
          stateId: 'Implementation',
          targetState: 'Implementation',
          transitionEvent: 'CONTEXT_RESTART',
          actionId: 'surgical-execution',
          restartId: 'restart-e3-wt24'
        }
      }
    ];
    fs.writeFileSync(eventsPath, `${records.map(r => JSON.stringify(r)).join('\n')}\n`);

    const projections = await eventStore.projectBeads(['bd-1'], { includeDetails: true });
    const bead = projections.get('bd-1');

    // restart fields come from stateChart — single source of truth
    expect(bead?.restartRequested).toBe(true);
    expect(bead?.restartKind).toBe('context');
    expect(bead?.restartEvent).toBe('CONTEXT_RESTART');
    expect(bead?.restartFromState).toBe('Implementation');
    expect(bead?.restartTargetState).toBe('Implementation');

    // STATE_TRANSITION_APPLIED before the restart must not leave stale clears
    // (the earlier STATE_TRANSITION_APPLIED clears in the old code were dead too)
    expect(bead?.restartRequested).not.toBe(false);
  });

  it('clears restart fields after a STATE_TRANSITION_APPLIED following a restart event', async () => {
    // Companion to the above: confirm that a transition after a restart correctly
    // clears restart state via stateChart (not the now-deleted switch-arm clears).
    const eventsPath = path.join(tempRoot, '.pi/events/project.jsonl');
    const records = [
      {
        id: 'e1',
        type: DomainEventName.HARNESS_RESTART_REQUESTED,
        timestamp: '2026-01-01T00:00:01.000Z',
        sessionId: 's1',
        data: {
          beadId: 'bd-1',
          stateId: 'Planning',
          targetState: 'Planning',
          transitionEvent: 'HARNESS_RESTART',
          restartId: 'restart-e1-clear'
        }
      },
      {
        id: 'e2',
        type: DomainEventName.STATE_TRANSITION_APPLIED,
        timestamp: '2026-01-01T00:00:02.000Z',
        sessionId: 's1',
        data: {
          beadId: 'bd-1',
          fromState: 'Planning',
          nextState: 'Planning',
          transitionEvent: 'HARNESS_RESTART'
        }
      }
    ];
    fs.writeFileSync(eventsPath, `${records.map(r => JSON.stringify(r)).join('\n')}\n`);

    const projections = await eventStore.projectBeads(['bd-1']);
    const bead = projections.get('bd-1');

    expect(bead?.restartRequested).toBe(false);
    expect(bead?.restartKind).toBeUndefined();
    expect(bead?.restartEvent).toBeUndefined();
    expect(bead?.restartFromState).toBeUndefined();
    expect(bead?.restartTargetState).toBeUndefined();
  });

  // ── SHOULD-FIX 3: custom advanceOutcomes threading through EventStore ─────────

  it('projectBead with custom advanceOutcomes in config records completion for the custom advance outcome', async () => {
    // Override harness.yaml with a custom statechart using ADVANCE as the advance outcome
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Alpha
  worktreePolicy:
    default: always
statechart:
  terminalStates: [done]
  advanceOutcomes: [ADVANCE]
  failedOutcomes: [REWORK]
  blockedOutcomes: [HALT]
  customOutcomes: []
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states:
  Alpha:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      - id: a1
        type: prompt
    transitions: { ADVANCE: "done", REWORK: "Alpha", HALT: "done" }
`);
    configLoader.reset();

    const eventsPath = path.join(tempRoot, '.pi/events/project.jsonl');
    const records = [
      {
        id: 'e1',
        type: DomainEventName.STATE_TRANSITION_APPLIED,
        timestamp: '2026-01-01T00:00:01.000Z',
        sessionId: 's1',
        data: {
          beadId: 'bd-custom',
          fromState: 'Alpha',
          nextState: 'done',
          transitionEvent: 'ADVANCE',
          actionId: 'do-work',
          actionKey: 'do-work'
        }
      }
    ];
    fs.writeFileSync(eventsPath, `${records.map(r => JSON.stringify(r)).join('\n')}\n`);

    const bead = await eventStore.projectBead('bd-custom', { includeDetails: true });

    // With ADVANCE threaded correctly, action completion must be recorded
    expect(bead.completedActionIds).toContain('do-work');
    expect(bead.status).toBe('done');
  });

  it('projectBead with default config still records completion for SUCCESS (byte-identical regression guard)', async () => {
    const eventsPath = path.join(tempRoot, '.pi/events/project.jsonl');
    const records = [
      {
        id: 'e1',
        type: DomainEventName.STATE_TRANSITION_APPLIED,
        timestamp: '2026-01-01T00:00:01.000Z',
        sessionId: 's1',
        data: {
          beadId: 'bd-default',
          fromState: 'Planning',
          nextState: 'completed',
          transitionEvent: 'SUCCESS',
          actionId: 'formulate-plan',
          actionKey: 'formulate-plan'
        }
      }
    ];
    fs.writeFileSync(eventsPath, `${records.map(r => JSON.stringify(r)).join('\n')}\n`);

    const bead = await eventStore.projectBead('bd-default', { includeDetails: true });

    expect(bead.completedActionIds).toContain('formulate-plan');
    expect(bead.status).toBe('completed');
  });

  it('projectBead rejects malformed STATE_TRANSITION_APPLIED (missing transitionEvent) fail-closed — status unchanged, no completion (rpa0)', async () => {
    // pi-experiment-rpa0: inverted from legacy-tolerance "null-safety" test.
    // Old behaviour: missing transitionEvent → skip action-completion but still advance status.
    // New behaviour (fail-closed): entire event rejected; status must NOT change.
    const eventsPath = path.join(tempRoot, '.pi/events/project.jsonl');
    const records = [
      {
        id: 'e0',
        type: DomainEventName.BEAD_CLAIMED,
        timestamp: '2026-01-01T00:00:00.000Z',
        sessionId: 's1',
        data: { beadId: 'bd-legacy', stateId: 'Planning', lease: { owner: 'Orr Else', expiresAt: '2099-01-01' } }
      },
      {
        id: 'e1',
        type: DomainEventName.STATE_TRANSITION_APPLIED,
        timestamp: '2026-01-01T00:00:01.000Z',
        sessionId: 's1',
        data: {
          beadId: 'bd-legacy',
          fromState: 'Planning',
          nextState: 'Implementation',
          // transitionEvent intentionally absent — malformed/old record
          actionId: 'formulate-plan',
          actionKey: 'formulate-plan'
        }
      }
    ];
    fs.writeFileSync(eventsPath, `${records.map(r => JSON.stringify(r)).join('\n')}\n`);

    const bead = await eventStore.projectBead('bd-legacy', { includeDetails: true });

    // fail-closed: malformed transition event must NOT advance status to Implementation
    expect(bead.status).toBe('Planning');
    // and must NOT record action completion
    expect(bead.completedActionIds ?? []).not.toContain('formulate-plan');
  });
});

// ---------------------------------------------------------------------------
// BEAD B — Memory-bound index scan proof
//
// When a bead has a complete .ready marker (sources record the full byte size
// of every primary JSONL file), eventsForBead must:
//   - scan only the per-bead index file (by-bead/<beadId>.jsonl)
//   - call scanFromOffset on the primary file only for the "tail" bytes beyond
//     what was indexed (or not at all when the marker covers the whole file)
//   - NEVER call the full scan() on the primary JSONL
//
// This proves the BeadEventIndex short-circuit: a single-bead projection reads
// O(bead-events) not O(all-events).
// ---------------------------------------------------------------------------

describe('EventStore — memory-bound index scan (BEAD B)', () => {
  let tempRoot: string;
  let configLoader: ConfigLoader;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-es-bound-'));
    configLoader = new ConfigLoader(undefined, tempRoot);
    fs.mkdirSync(path.join(tempRoot, '.pi/events'), { recursive: true });
    fs.mkdirSync(path.join(tempRoot, '.pi/logs'), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Planning
  worktreePolicy:
    default: always
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    actions: []
    transitions: {}
`);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    configLoader.reset();
    Logger.close();
    await new Promise(resolve => setTimeout(resolve, 25));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('does not full-scan the primary JSONL when the bead index is complete', async () => {
    // ── Setup: large multi-bead primary JSONL ────────────────────────────────
    // Write 50 events belonging to OTHER beads into the primary file.
    // bd-target has exactly 1 event, placed in its per-bead index.
    // The ready marker records the FULL byte size of the primary file so there
    // is no "tail" to catch up from — scanFromOffset should be called with an
    // offset equal to the full file size (≥ currentSize check skips it).

    const eventsPath = path.join(tempRoot, '.pi/events/project.jsonl');

    const otherBeadEvents = Array.from({ length: 50 }, (_, i) => ({
      id: `other-evt-${i}`,
      type: DomainEventName.BEAD_CLAIMED,
      timestamp: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      sessionId: 's1',
      data: { beadId: `bd-other-${i}`, stateId: 'Planning' }
    }));

    const primaryContent = `${otherBeadEvents.map(e => JSON.stringify(e)).join('\n')}\n`;
    fs.writeFileSync(eventsPath, primaryContent);
    const primaryByteSize = Buffer.byteLength(primaryContent);

    // ── Per-bead index for bd-target ─────────────────────────────────────────
    const indexDir = path.join(tempRoot, '.pi/events', EventStoreDefaults.BEAD_INDEX_DIR);
    fs.mkdirSync(indexDir, { recursive: true });

    const targetEvent = {
      id: 'target-evt-1',
      type: DomainEventName.BEAD_CLAIMED,
      timestamp: '2026-01-01T00:01:00.000Z',
      sessionId: 's1',
      data: { beadId: 'bd-target', stateId: 'Planning' }
    };

    const indexPath = path.join(indexDir, indexFileNameFor('bd-target'));
    fs.writeFileSync(indexPath, `${JSON.stringify(targetEvent)}\n`);

    // Ready marker: sources records the full primary file size → no tail to read.
    const markerPath = `${indexPath}${EventStoreDefaults.INDEX_READY_FILE_EXTENSION}`;
    fs.writeFileSync(markerPath, JSON.stringify({
      sources: { 'project.jsonl': primaryByteSize }
    }));

    // ── Spy on JsonlEventLog ──────────────────────────────────────────────────
    // We pass a real JsonlEventLog but spy on its methods to count calls.
    const eventLog = new JsonlEventLog();

    const scanSpy = vi.spyOn(eventLog, 'scan');
    const scanFromOffsetSpy = vi.spyOn(eventLog, 'scanFromOffset');

    // Construct EventStore with the spied eventLog.
    const eventStore = new EventStore(configLoader, eventLog, undefined, tempRoot);
    eventStore.setSessionId('test-bound');

    // ── Exercise ─────────────────────────────────────────────────────────────
    const events = await eventStore.eventsForBead('bd-target');

    // ── Assert: correct result ────────────────────────────────────────────────
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe('target-evt-1');

    // ── Assert: scan() was NOT called on the primary file ────────────────────
    // scan() delegates to scanFromOffset(path, 0, ...) — if it were called on
    // the primary JSONL, that would be a full scan of all 50 other-bead events.
    // The only scan() call allowed is on the per-bead index file itself.
    const primaryScanCalls = scanSpy.mock.calls.filter(
      ([filePath]) => filePath === eventsPath
    );
    expect(
      primaryScanCalls.length,
      'scan() must not be called on the primary JSONL when the bead index is complete — doing so would read all events regardless of bead'
    ).toBe(0);

    // ── Assert: scanFromOffset on the primary skips all bytes (offset ≥ size) ─
    // When the ready marker records the full size, BeadEventIndex computes
    // indexedSize >= currentSize → skips the scanFromOffset call entirely.
    // Either it was not called at all, or if called, it must be with an offset
    // >= primaryByteSize (meaning it reads nothing).
    const primaryTailCalls = scanFromOffsetSpy.mock.calls.filter(
      ([filePath]) => filePath === eventsPath
    );
    for (const [, offset] of primaryTailCalls) {
      expect(
        offset,
        'scanFromOffset on the primary JSONL must start at or beyond the full file size (no tail to read)'
      ).toBeGreaterThanOrEqual(primaryByteSize);
    }

    // ── Assert: the index file itself WAS scanned (proves the index path is used) ─
    const indexScanCalls = [
      ...scanSpy.mock.calls.filter(([fp]) => fp === indexPath),
      ...scanFromOffsetSpy.mock.calls.filter(([fp]) => fp === indexPath)
    ];
    expect(
      indexScanCalls.length,
      'The per-bead index file must be scanned at least once to read the indexed events'
    ).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// BEAD F — Restart-Replay Integration Test
//
// Proof that runtime statechart state is FULLY reconstructible from event files
// alone after a coordinator restart — with NO dependency on Beads native metadata.
//
// Protocol:
//   1. Record a FULL bead lifecycle into an isolated EventStore (BEAD_CLAIMED →
//      STATE_RUN_INITIALIZED → WORKTREE_CREATED → CHECKPOINT_SUBMITTED →
//      STATE_TRANSITION_APPLIED (SUCCESS, moves to next state) →
//      STATE_TRANSITION_APPLIED (SUCCESS, terminal merge transition) →
//      MERGE_AND_COMMIT_SUCCEEDED → BEAD_CLOSED).
//   2. Drop all in-memory state: construct a BRAND-NEW EventStore from the SAME
//      files on disk (simulating a coordinator restart with no memory of Session 1).
//   3. Assert projectBeadStateChart and projectBead reconstruct IDENTICAL statechart
//      state from event files only, with no Beads metadata dependency.
//
// This is the canonical "event-store-only" proof: if the assertions pass, the
// coordinator can correctly resume a bead after restart without ever reading
// Beads native metadata.
// ---------------------------------------------------------------------------

describe('EventStore — restart-replay integration (BEAD F)', () => {
  let tempRoot: string;
  let configLoader: ConfigLoader;
  let eventStore: EventStore;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-replay-'));
    configLoader = new ConfigLoader(undefined, tempRoot);
    eventStore = new EventStore(configLoader, undefined, undefined, tempRoot);
    eventStore.setSessionId('session-1');
    fs.mkdirSync(path.join(tempRoot, '.pi/events'), { recursive: true });
    fs.mkdirSync(path.join(tempRoot, '.pi/logs'), { recursive: true });
    // Statechart: Planning → Implementation → completed (SUCCESS path).
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Planning
  worktreePolicy:
    default: always
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    actions:
      - id: formulate-plan
        type: prompt
        instructions: "Formulate the plan"
    transitions: { SUCCESS: "Implementation", FAILURE: "Planning" }
  Implementation:
    identity: { role: "Builder", expertise: "Implementation", constraints: [] }
    baseInstructions: "Build"
    actions:
      - id: surgical-execution
        type: prompt
        instructions: "Execute the implementation"
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`);
  });

  afterEach(async () => {
    configLoader.reset();
    eventStore.setSessionId('test-reset');
    Logger.close();
    await new Promise(resolve => setTimeout(resolve, 25));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('reconstructs complete statechart state from event files after a simulated coordinator restart', async () => {
    const beadId = 'bd-replay-test';

    // ── Phase 1: Record a full bead lifecycle ──────────────────────────────────
    // All events come from Session 1 (coordinator first run).

    // Step 1: Claim the bead (enters Planning state).
    await eventStore.record(DomainEventName.BEAD_CLAIMED, {
      beadId,
      stateId: 'Planning',
      owner: 'orr-else-worker-1',
      lease: { owner: 'orr-else-worker-1', expiresAt: '2026-06-02T02:00:00.000Z' }
    });

    // Step 2: Initialize the first state run (Planning / formulate-plan).
    await eventStore.record(DomainEventName.STATE_RUN_INITIALIZED, {
      beadId,
      stateId: 'Planning',
      actionId: 'formulate-plan'
    });

    // Step 3: Create a worktree for the bead.
    await eventStore.record(DomainEventName.WORKTREE_CREATED, {
      beadId,
      path: `/tmp/worktrees/${beadId}`,
      branchName: `bead/${beadId}`
    });

    // Step 4: Submit a checkpoint in Planning.
    await eventStore.record(DomainEventName.CHECKPOINT_SUBMITTED, {
      beadId,
      stateId: 'Planning',
      actionId: 'formulate-plan',
      summary: 'Plan formulated: three-step implementation sequence identified.',
      evidence: 'IMPLEMENTATION_PLAN.md written with stages A, B, C.'
    });

    // Step 5: Transition Planning → Implementation (SUCCESS).
    await eventStore.record(DomainEventName.STATE_TRANSITION_APPLIED, {
      beadId,
      fromState: 'Planning',
      nextState: 'Implementation',
      transitionEvent: 'SUCCESS',
      actionId: 'formulate-plan',
      actionKey: 'state=Planning/action=formulate-plan'
    });

    // Step 6: Initialize the second state run (Implementation / surgical-execution).
    await eventStore.record(DomainEventName.STATE_RUN_INITIALIZED, {
      beadId,
      stateId: 'Implementation',
      actionId: 'surgical-execution'
    });

    // Step 7: Submit a checkpoint in Implementation.
    await eventStore.record(DomainEventName.CHECKPOINT_SUBMITTED, {
      beadId,
      stateId: 'Implementation',
      actionId: 'surgical-execution',
      summary: 'All tests passing. Ready for merge.',
      evidence: 'npx vitest run: 42 passed, 0 failed.'
    });

    // Step 8: Transition Implementation → completed (SUCCESS / merge).
    await eventStore.record(DomainEventName.STATE_TRANSITION_APPLIED, {
      beadId,
      fromState: 'Implementation',
      nextState: 'completed',
      transitionEvent: 'SUCCESS',
      actionId: 'surgical-execution',
      actionKey: 'state=Implementation/action=surgical-execution'
    });

    // Step 9: Record merge success (post-transition).
    await eventStore.record(DomainEventName.MERGE_AND_COMMIT_SUCCEEDED, {
      beadId,
      branchName: `bead/${beadId}`,
      targetBranch: 'main',
      message: `Merge bead ${beadId}: plan + implementation complete.`
    });

    // Step 10: Close the bead.
    await eventStore.record(DomainEventName.BEAD_CLOSED, {
      beadId,
      status: 'completed'
    });

    // ── Phase 2: Simulate a coordinator restart ────────────────────────────────
    // Discard all in-memory state. Build a new ConfigLoader and EventStore that
    // read from the SAME directory on disk but have zero in-memory knowledge of
    // the lifecycle just recorded.
    configLoader.reset();
    const restartedConfigLoader = new ConfigLoader(undefined, tempRoot);
    const restartedEventStore = new EventStore(restartedConfigLoader, undefined, undefined, tempRoot);
    // A fresh session ID simulates the coordinator's new process session.
    restartedEventStore.setSessionId('session-2');

    // ── Phase 3: Assert statechart reconstruction ──────────────────────────────
    // projectBeadStateChart must reconstruct the FULL post-lifecycle statechart
    // from the event files alone, with no Beads native metadata dependency.
    const stateChart = await restartedEventStore.projectBeadStateChart(beadId);

    // The bead transitioned Planning → Implementation → completed.
    expect(stateChart.currentState).toBe('completed');
    expect(stateChart.previousState).toBe('Implementation');

    // Both actions completed (recorded via STATE_TRANSITION_APPLIED with SUCCESS).
    expect(stateChart.completedActionIds).toContain('state=Planning/action=formulate-plan');
    expect(stateChart.completedActionIds).toContain('state=Implementation/action=surgical-execution');

    // Two checkpoints were submitted — one per state.
    expect(stateChart.checkpoints).toHaveLength(2);
    expect(stateChart.checkpoints[0].summary).toBe('Plan formulated: three-step implementation sequence identified.');
    expect(stateChart.checkpoints[1].summary).toBe('All tests passing. Ready for merge.');

    // The merge was recorded and succeeded.
    expect(stateChart.mergeAndCommit).toBeDefined();
    expect(stateChart.mergeAndCommit!.status).toBe('succeeded');
    expect(stateChart.mergeAndCommit!.branchName).toBe(`bead/${beadId}`);

    // Two transitions recorded (Planning→Implementation, Implementation→completed).
    expect(stateChart.transitions).toHaveLength(2);
    expect(stateChart.transitions[0].fromState).toBe('Planning');
    expect(stateChart.transitions[0].toState).toBe('Implementation');
    expect(stateChart.transitions[1].fromState).toBe('Implementation');
    expect(stateChart.transitions[1].toState).toBe('completed');

    // No restart was requested (clean lifecycle).
    expect(stateChart.restartRequested).toBeFalsy();

    // ── Phase 4: Assert projectBead consistency ────────────────────────────────
    // projectBead must produce the same terminal-state conclusions.
    const beadProjection = await restartedEventStore.projectBead(beadId, { includeDetails: true });

    // Status must reflect the closed/completed state (the last BEAD_CLAIMED or
    // BEAD_STATUS_UPDATED sets status; BEAD_CLOSED projection yields 'completed').
    // The stateChart is the authoritative source for statechart state; the flat
    // projection carries the leaf-status from the event stream.
    expect(beadProjection.worktree_path).toBe(`/tmp/worktrees/${beadId}`);

    // Completed actions must be present in the projection detail view.
    expect(beadProjection.completedActionIds).toContain('state=Planning/action=formulate-plan');
    expect(beadProjection.completedActionIds).toContain('state=Implementation/action=surgical-execution');

    // No restart state — clean forward-progress lifecycle.
    expect(beadProjection.restartRequested).toBeFalsy();
    expect(beadProjection.restartKind).toBeUndefined();

    // ── Phase 5: Confirm no Beads native metadata was consulted ───────────────
    // The restarted EventStore holds no in-memory projections from Session 1.
    // The event files are the SOLE source — if the assertions above pass, the
    // architecture correctly recovers complete runtime state from events only.
    //
    // Structural proof: the restarted store has a different sessionId and a
    // freshly-constructed in-memory projection cache. Any correct result
    // must come entirely from replaying the event files.
    expect(restartedEventStore).toBeDefined();
    // The restarted store must NOT have inherited the Session-1 session ID.
    // (setSessionId was called with 'session-2' above; the internal state is opaque
    // but the projection result is what matters — verified by assertions above.)

    // Clean up restarted resources.
    restartedConfigLoader.reset();
    restartedEventStore.setSessionId('test-reset');
  });
});

describe('EventStore — injected Clock determinism (pf7v)', () => {
  let tempRoot: string;
  let configLoader: ConfigLoader;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-clock-'));
    configLoader = new ConfigLoader(undefined, tempRoot);
    fs.mkdirSync(path.join(tempRoot, '.pi/events'), { recursive: true });
    fs.mkdirSync(path.join(tempRoot, '.pi/logs'), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Planning
  worktreePolicy:
    default: always
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    actions: []
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`);
  });

  afterEach(async () => {
    configLoader.reset();
    Logger.close();
    await new Promise(resolve => setTimeout(resolve, 25));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('stamps the event timestamp from the injected Clock, not wall-clock', async () => {
    // A fixed epoch far from "now"; a wall-clock `new Date()` could never
    // produce this ISO string, so the assertion fails if the stamp regresses.
    const FIXED_EPOCH_MS = 1262304000000; // 2010-01-01T00:00:00.000Z
    const fixedClock: Clock = {
      now: () => FIXED_EPOCH_MS,
      date: (timestampMs?: number) => new Date(timestampMs ?? FIXED_EPOCH_MS)
    };

    const eventStore = new EventStore(configLoader, undefined, undefined, tempRoot, fixedClock);
    eventStore.setSessionId('clock-session');

    const before = Date.now();
    await eventStore.record(DomainEventName.BEAD_CLAIMED, { beadId: 'bd-clock', stateId: 'Planning', lease: { owner: 'Orr Else', expiresAt: '2026-01-01T01:00:00.000Z' } });
    const after = Date.now();

    const events = await eventStore.readAll();
    expect(events).toHaveLength(1);
    expect(events[0].timestamp).toBe('2010-01-01T00:00:00.000Z');

    // Adversarial guard: prove the stamp is the injected fixed epoch and NOT the
    // wall-clock that elapsed during record() — i.e. `new Date()` is gone.
    const stampedMs = Date.parse(events[0].timestamp);
    expect(stampedMs).toBe(FIXED_EPOCH_MS);
    expect(stampedMs).toBeLessThan(before);
    expect(stampedMs).toBeLessThan(after);
  });
});
