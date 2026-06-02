import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventStore } from '../src/core/EventStore.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { Logger } from '../src/core/Logger.js';
import { DomainEventName, EventName, EventStoreDefaults, PluginToolName, TeammateEventType } from '../src/constants/index.js';

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
      stateId: 'Planning'
    });

    const indexPath = path.join(
      tempRoot,
      '.pi/events',
      EventStoreDefaults.BEAD_INDEX_DIR,
      `bd-new${EventStoreDefaults.INDEX_FILE_EXTENSION}`
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
      stateId: 'Planning'
    });

    const indexPath = path.join(
      tempRoot,
      '.pi/events',
      EventStoreDefaults.BEAD_INDEX_DIR,
      `bd-1${EventStoreDefaults.INDEX_FILE_EXTENSION}`
    );
    fs.writeFileSync(`${indexPath}${EventStoreDefaults.INDEX_READY_FILE_EXTENSION}`, JSON.stringify({
      sources: {
        'project.jsonl': 0
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
  });

  it('keeps writing to the resolved event path after a temporary config validation failure', async () => {
    await eventStore.record(DomainEventName.BEAD_CLAIMED, {
      beadId: 'bd-stable',
      stateId: 'Planning'
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
      `bd-1${EventStoreDefaults.INDEX_FILE_EXTENSION}`
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
      `bd-1${EventStoreDefaults.INDEX_FILE_EXTENSION}`
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
    const eventsPath = path.join(tempRoot, '.pi/events/project.jsonl');
    const records = [
      {
        id: 'e1',
        type: DomainEventName.HARNESS_CAPACITY_LIMIT_REACHED,
        timestamp: '2026-01-01T00:00:01.000Z',
        sessionId: 's1',
        data: { pauseUntil: '2026-01-01T00:10:00.000Z' }
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
        type: DomainEventName.HARNESS_CAPACITY_LIMIT_REACHED,
        timestamp: '2026-01-01T00:00:03.000Z',
        sessionId: 's2',
        data: { pauseUntil: '2026-01-01T00:20:00.000Z' }
      }
    ];
    fs.writeFileSync(eventsPath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);

    const latest = await eventStore.latestEventByType(DomainEventName.HARNESS_CAPACITY_LIMIT_REACHED);

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
          actionId: 'surgical-execution'
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
          transitionEvent: 'HARNESS_RESTART'
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
    actions: []
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

  it('projectBead does NOT record completion for missing transitionEvent (null-safety regression guard)', async () => {
    const eventsPath = path.join(tempRoot, '.pi/events/project.jsonl');
    const records = [
      {
        id: 'e1',
        type: DomainEventName.STATE_TRANSITION_APPLIED,
        timestamp: '2026-01-01T00:00:01.000Z',
        sessionId: 's1',
        data: {
          beadId: 'bd-legacy',
          fromState: 'Planning',
          nextState: 'Planning',
          // transitionEvent is intentionally absent (legacy/replayed event)
          actionId: 'formulate-plan',
          actionKey: 'formulate-plan'
        }
      }
    ];
    fs.writeFileSync(eventsPath, `${records.map(r => JSON.stringify(r)).join('\n')}\n`);

    const bead = await eventStore.projectBead('bd-legacy', { includeDetails: true });

    // Missing transitionEvent must NOT record action completion — old semantics preserved
    expect(bead.completedActionIds ?? []).not.toContain('formulate-plan');
  });
});
