import * as fs from 'fs';
import * as path from 'path';
import { v7 as uuidv7 } from 'uuid';
import { resolveProjectFrom } from './Paths.js';
import { ConfigLoader } from './ConfigLoader.js';
import { Logger } from './Logger.js';
import { JsonlEventLog } from './JsonlEventLog.js';
import { nodeRuntimeEnvironment, type RuntimeEnvironment } from './RuntimeEnvironment.js';
import { systemClock, type Clock } from './Clock.js';
import { isRecord } from './RecordUtils.js';
import { isRestartTransition } from './EventUtils.js';
import {
  Component,
  DomainEventName,
  EnvVars,
  EventStoreDefaults,
  TeammateEventType
} from '../constants/index.js';
import { BeadEventIndex } from './BeadEventIndex.js';
import { BeadStateProjection } from './BeadStateProjection.js';
import { DOMAIN_EVENT_SCHEMAS } from './DomainEventSchemas.js';

// Re-export all public types so existing callers of EventStore remain unaffected.
export type {
  DomainEvent,
  EventProjectionOptions,
  LatestEventFilterOptions,
  ProjectToolFailureLimitFilterOptions,
  ProjectionCapableStore,
  BeadStateTransitionProjection,
  BeadStateChartProjection
} from './EventStoreTypes.js';

import type {
  DomainEvent,
  LatestEventFilterOptions,
  ProjectToolFailureLimitFilterOptions,
  ProjectionCapableStore,
  EventProjectionOptions,
  BeadStateChartProjection
} from './EventStoreTypes.js';

import type { HarnessBeadMetadata } from '../types/index.js';

const existsSync = fs.existsSync;

// ---------------------------------------------------------------------------
// Production payload validation (pi-experiment-y2ax + pi-experiment-g0bi)
// ---------------------------------------------------------------------------

/**
 * Required-field schemas for production domain events.
 *
 * Sourced from the canonical DomainEventSchemas registry (pi-experiment-g0bi).
 * Previously this was a two-entry inline map (y2ax); now the full registry
 * covering all replay-critical and startup-critical events is imported here.
 *
 * The validation logic below (validateProductionPayload, EventStoreValidationError)
 * is unchanged — this const is the only thing that changed.
 */
const PRODUCTION_PAYLOAD_SCHEMAS: Readonly<Record<string, readonly string[]>> = DOMAIN_EVENT_SCHEMAS;

/**
 * Structured diagnostic attached to EventStoreValidationError as `.diagnostic`.
 */
export interface EventStoreValidationDiagnostic {
  eventType: string;
  missingFields: string[];
  receivedKeys: string[];
}

/**
 * Thrown when a production event write fails required-field validation.
 * Carries a structured `.diagnostic` for programmatic inspection.
 */
export class EventStoreValidationError extends Error {
  public readonly diagnostic: EventStoreValidationDiagnostic;

  constructor(diagnostic: EventStoreValidationDiagnostic) {
    const missing = diagnostic.missingFields.join(', ');
    super(
      `${diagnostic.eventType}: missing required field(s) [${missing}] in production event payload. ` +
      `Received keys: [${diagnostic.receivedKeys.join(', ')}]. ` +
      `Use a TestEventStore (tests/helpers/TestEventStore.ts) for test/fixture writes.`
    );
    this.name = 'EventStoreValidationError';
    this.diagnostic = diagnostic;
  }
}

/**
 * Thrown when production EventStore.record() is called with data.synthetic === true.
 *
 * Synthetic events must go through TestEventStore (isolated test namespace).
 * Writing synthetic events into the production store is rejected to ensure the
 * production write path stays clean and no test artifact can pollute production
 * replay/projection reads.
 */
export class EventStoreSyntheticRejectedError extends Error {
  public readonly eventType: string;

  constructor(eventType: string) {
    super(
      `${eventType}: production EventStore.record() rejects data.synthetic === true. ` +
      `Use a TestEventStore (tests/helpers/TestEventStore.ts) to write fixture/synthetic events.`
    );
    this.name = 'EventStoreSyntheticRejectedError';
    this.eventType = eventType;
  }
}

/**
 * Validates the payload of a domain event before it is written to the
 * production event store.
 *
 * Returns `null` when the payload is valid (or the event has no schema).
 * Returns an `EventStoreValidationDiagnostic` when required fields are absent.
 *
 * NOTE: synthetic:true is no longer an escape hatch here — it is rejected
 * before this function is called (see EventStore.record()).
 */
function validateProductionPayload(
  eventType: string,
  data: Record<string, unknown>
): EventStoreValidationDiagnostic | null {
  const requiredFields = PRODUCTION_PAYLOAD_SCHEMAS[eventType];
  if (!requiredFields) return null;

  const missingFields = requiredFields.filter(field => !(field in data) || data[field] === undefined);
  if (missingFields.length === 0) return null;

  return {
    eventType,
    missingFields,
    receivedKeys: Object.keys(data)
  };
}

/** Path segment that marks the start of the PROJECT-scoped tool-output archive. */
const TOOL_OUTPUT_DIR_SEGMENT = 'tool-output';

/**
 * Recover the (beadId, stateId, actionId, tool) tuple from a tool-output
 * outputFile path. The archive layout is deterministic
 * (`.pi/tool-output/{bead}/{state}/{action}/{tool}/{invocationId}/…`), so the
 * four segments immediately after `tool-output` carry the tuple. Returns
 * undefined when the path is not a recognisable tool-output path.
 */
function toolOutputPathSegments(outputFile: string):
  | { beadId: string; stateId: string; actionId: string; tool: string }
  | undefined {
  const parts = outputFile.split(/[\\/]+/).filter(Boolean);
  const anchor = parts.lastIndexOf(TOOL_OUTPUT_DIR_SEGMENT);
  if (anchor < 0 || parts.length < anchor + 5) return undefined;
  return {
    beadId: parts[anchor + 1],
    stateId: parts[anchor + 2],
    actionId: parts[anchor + 3],
    tool: parts[anchor + 4]
  };
}

interface EventStoreLocation {
  dir: string;
  path: string;
}

export class EventStore implements ProjectionCapableStore {
  private currentLocation: EventStoreLocation | null | undefined;
  private sessionId: string;

  private readonly beadIndex: BeadEventIndex;
  private readonly projection: BeadStateProjection;

  constructor(
    private readonly configLoader: ConfigLoader,
    private readonly eventLog: JsonlEventLog = new JsonlEventLog(),
    private readonly env: RuntimeEnvironment = nodeRuntimeEnvironment,
    private readonly projectRoot: string = process.cwd(),
    private readonly clock: Clock = systemClock
  ) {
    this.sessionId = this.env.env(EnvVars.OBSERVABILITY_SESSION_ID) || uuidv7();
    this.beadIndex = new BeadEventIndex(this.eventLog, this.clock);
    this.projection = new BeadStateProjection();
  }

  public setSessionId(sessionId: string): void {
    if (this.sessionId === sessionId) return;
    this.sessionId = sessionId;
  }

  // ---------------------------------------------------------------------------
  // Internal utilities
  // ---------------------------------------------------------------------------

  private projectName(): string {
    const basename = path.basename(this.projectRoot);
    const sanitized = basename.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
    return sanitized || 'project';
  }

  private assertSessionIndependentPath(value: string, field: string): void {
    if (/\{\{\s*sessionId\s*\}\}/i.test(value)) {
      throw new Error(`Event store ${field} must not include {{sessionId}}. Event records include sessionId; storage must be stable across sessions.`);
    }
  }

  private expandProjectName(value: string, projectName: string): string {
    return value.replace(/\{\{\s*projectName\s*\}\}/g, projectName);
  }

  private async resolveLocation(): Promise<EventStoreLocation | null> {
    if (this.currentLocation !== undefined) return this.currentLocation;

    const config = await this.configLoader.load();
    const eventStore = config.settings.eventStore;
    if (eventStore?.enabled === false) {
      this.currentLocation = null;
      return null;
    }

    const projectName = eventStore?.name || this.projectName();
    const configuredDir = eventStore?.dir || EventStoreDefaults.DIR;
    const configuredFileName = eventStore?.fileName || EventStoreDefaults.FILE_NAME_TEMPLATE;
    this.assertSessionIndependentPath(configuredDir, 'dir');
    this.assertSessionIndependentPath(configuredFileName, 'fileName');

    const expandedDir = this.expandProjectName(configuredDir, projectName);
    const expandedFileName = this.expandProjectName(configuredFileName, projectName);
    const logDir = path.isAbsolute(expandedDir) ? expandedDir : resolveProjectFrom(this.projectRoot, expandedDir);
    const fileName = path.basename(expandedFileName);
    this.currentLocation = { dir: logDir, path: path.join(logDir, fileName) };
    return this.currentLocation;
  }

  private async init(): Promise<EventStoreLocation | null> {
    const location = await this.resolveLocation();
    if (!location) return null;

    if (!existsSync(location.dir)) {
      fs.mkdirSync(location.dir, { recursive: true });
    }

    return location;
  }

  private isDomainEvent(value: unknown): value is DomainEvent {
    return isRecord(value) && typeof value.type === 'string' && typeof value.timestamp === 'string';
  }

  /**
   * Returns true for events that carry `data.synthetic === true`.
   *
   * Synthetic events are test/fixture writes that bypass production payload
   * validation (AC3, pi-experiment-y2ax).  They must NEVER appear in production
   * replay, projection, or gate reads — filtering them at the read layer ensures
   * every consumer (BeadStateProjection, WorkerRunController, EventStore circuit-
   * breaker, RestartCorrelation, preflight) is uniformly covered without
   * requiring per-consumer guards.
   */
  private isSyntheticEvent(event: DomainEvent): boolean {
    return isRecord(event.data) && event.data.synthetic === true;
  }

  private beadIdFor(event: DomainEvent): string | undefined {
    const data = event.data;
    const beadId = typeof data.beadId === 'string' ? data.beadId : undefined;
    const id = typeof data.id === 'string' ? data.id : undefined;
    return beadId || id;
  }

  private compareEvents(a: DomainEvent, b: DomainEvent): number {
    const byTime = Date.parse(a.timestamp) - Date.parse(b.timestamp);
    return byTime !== 0 ? byTime : String(a.id || '').localeCompare(String(b.id || ''));
  }

  private jsonByteLength(value: unknown): number | undefined {
    try {
      return Buffer.byteLength(JSON.stringify(value));
    } catch {
      return undefined;
    }
  }

  private compactEventRecordMetadata(entry: DomainEvent): Record<string, unknown> {
    const data = isRecord(entry.data) ? entry.data : {};
    const result = isRecord(data.result) ? data.result : undefined;
    return {
      eventId: entry.id,
      sessionId: entry.sessionId,
      beadId: this.beadIdFor(entry),
      stateId: data.stateId || data.fromState || data.nextState,
      actionId: data.actionId,
      workerId: data.workerId,
      tool: data.tool,
      eventType: data.type,
      resultStatus: result?.status,
      outputBytes: data.outputBytes || result?.outputBytes,
      // outputTruncated removed (obsolete — s3wp.30, forbidden per raw-output-contract.md)
      dataBytes: this.jsonByteLength(data),
      paramsBytes: this.jsonByteLength(data.params),
      resultBytes: this.jsonByteLength(data.result),
      dataKeys: Object.keys(data).sort()
    };
  }

  private async scanEvents(visitor: (event: DomainEvent) => void): Promise<void> {
    const location = await this.resolveLocation();
    if (!location || !existsSync(location.dir)) return;

    for (const filePath of await this.eventLog.eventFilePaths(location.dir)) {
      await this.eventLog.scan(filePath, value => {
        if (this.isDomainEvent(value) && !this.isSyntheticEvent(value)) visitor(value);
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Public API – record
  // ---------------------------------------------------------------------------

  public async record(event: DomainEventName | string, data: unknown): Promise<void> {
    const normalized = isRecord(data) ? data : {};

    // Production write path rejects synthetic events (y2ax redesign).
    // Fixture/test writes must go through TestEventStore (tests/helpers/TestEventStore.ts).
    if (normalized.synthetic === true) {
      throw new EventStoreSyntheticRejectedError(event);
    }

    // Validate required payload fields before touching the store (y2ax).
    const diagnostic = validateProductionPayload(event, normalized);
    if (diagnostic) {
      throw new EventStoreValidationError(diagnostic);
    }

    const location = await this.init();

    const entry: DomainEvent = {
      id: uuidv7(),
      type: event,
      timestamp: new Date(this.clock.now()).toISOString(),
      sessionId: this.sessionId,
      data: normalized
    };

    if (location) {
      await this.eventLog.append(location.path, entry);
      const beadId = this.beadIdFor(entry);
      if (beadId) {
        await this.beadIndex.append(location, beadId, entry, location.path);
      }
    }

    Logger.debug(Component.CORE, `Event recorded: ${event}`, this.compactEventRecordMetadata(entry));
  }

  // ---------------------------------------------------------------------------
  // Public API – read
  // ---------------------------------------------------------------------------

  public async readAll(): Promise<DomainEvent[]> {
    const events: DomainEvent[] = [];
    await this.scanEvents(event => events.push(event));
    return events.sort(this.compareEvents.bind(this));
  }

  public async eventsForBead(beadId: string): Promise<DomainEvent[]> {
    return (await this.eventsForBeads([beadId])).get(beadId) || [];
  }

  public async eventsForBeads(beadIds: Iterable<string>): Promise<Map<string, DomainEvent[]>> {
    const requested = new Set([...beadIds].filter(Boolean));
    const grouped = new Map<string, DomainEvent[]>();
    for (const beadId of requested) grouped.set(beadId, []);
    if (requested.size === 0) return grouped;

    const location = await this.resolveLocation();
    if (!location || !existsSync(location.dir)) return grouped;
    const requestedIds = [...requested];
    const missing = new Set<string>();

    const primaryFilePaths = await this.eventLog.eventFilePaths(location.dir);

    for (const beadId of requestedIds) {
      const indexedEvents = await this.beadIndex.eventsForBead(
        location,
        beadId,
        primaryFilePaths,
        this.isDomainEvent.bind(this),
        this.beadIdFor.bind(this),
        this.compareEvents.bind(this)
      );
      if (indexedEvents === undefined) {
        missing.add(beadId);
      } else {
        // Filter synthetic events at the read layer: no production consumer
        // should ever see a synthetic:true event (pi-experiment-y2ax review fix).
        grouped.set(beadId, indexedEvents.filter(e => !this.isSyntheticEvent(e)));
      }
    }

    if (missing.size === 0) return grouped;

    for (const filePath of primaryFilePaths) {
      await this.eventLog.scan(filePath, value => {
        if (!this.isDomainEvent(value)) return;
        if (this.isSyntheticEvent(value)) return;
        const beadId = this.beadIdFor(value);
        if (!beadId || !missing.has(beadId)) return;
        grouped.get(beadId)!.push(value);
      });
    }

    for (const events of grouped.values()) {
      events.sort(this.compareEvents.bind(this));
    }
    return grouped;
  }

  public async latestEventsForBeads(
    beadIds: Iterable<string>,
    options: LatestEventFilterOptions = {}
  ): Promise<Map<string, DomainEvent>> {
    const requested = new Set([...beadIds].filter(Boolean));
    const latest = new Map<string, DomainEvent>();
    if (requested.size === 0) return latest;

    const excludedTypes = new Set(options.excludeTypes || []);
    const excludedTeammateEventTypes = new Set(options.excludeTeammateEventTypes || []);
    const excludedToolNames = new Set(options.excludeToolNames || []);

    const grouped = await this.eventsForBeads(requested);
    for (const [beadId, events] of grouped) {
      for (const value of events) {
        if (excludedTypes.has(String(value.type))) continue;
        if (excludedTeammateEventTypes.has(String(value.data?.type))) continue;
        if (excludedToolNames.has(String(value.data?.tool))) continue;
        const current = latest.get(beadId);
        if (!current || this.compareEvents(current, value) < 0) latest.set(beadId, value);
      }
    }

    return latest;
  }

  public async latestEventByType(type: DomainEventName | string): Promise<DomainEvent | undefined> {
    let latest: DomainEvent | undefined;
    await this.scanEvents(event => {
      if (event.type !== type) return;
      if (!latest || this.compareEvents(latest, event) < 0) latest = event;
    });
    return latest;
  }

  /**
   * Resolve the LATEST tool-result event for one (beadId, stateId, actionId,
   * tool) tuple. This is the COORDINATOR-side read the verifier gate uses to
   * recover a tool's outputFile + run status: it must reflect a retry (the
   * freshest event wins) and never a stale prior-run leaf.
   *
   * Two recorded shapes are reconciled here (see pi-experiment-0yt5.27):
   *  - FLAT (command / MCP tools): PROJECT_TOOL_SUCCEEDED / PROJECT_TOOL_FAILED
   *    carry top-level { beadId, stateId, actionId, tool, status, outputFile }.
   *  - NESTED (wrapped plugin tools): TOOL_INVOCATION_SUCCEEDED /
   *    TOOL_INVOCATION_FAILED carry top-level { beadId, tool } plus a nested
   *    { toolResult: ToolResultBase }. The plugin event does NOT carry stateId /
   *    actionId at the top level, so the (state, action) are recovered from the
   *    deterministic outputFile path layout
   *    `.pi/tool-output/{bead}/{state}/{action}/{tool}/{invocationId}/…`.
   */
  public async latestToolResultEvent(
    beadId: string,
    stateId: string,
    actionId: string,
    tool: string
  ): Promise<DomainEvent | undefined> {
    if (!beadId || !tool) return undefined;
    let latest: DomainEvent | undefined;
    for (const event of await this.eventsForBead(beadId)) {
      if (!this.toolResultEventMatches(event, beadId, stateId, actionId, tool)) continue;
      if (!latest || this.compareEvents(latest, event) < 0) latest = event;
    }
    return latest;
  }

  private toolResultEventMatches(
    event: DomainEvent,
    beadId: string,
    stateId: string,
    actionId: string,
    tool: string
  ): boolean {
    const data = isRecord(event.data) ? event.data : {};
    if (data.beadId !== beadId) return false;

    if (event.type === DomainEventName.PROJECT_TOOL_SUCCEEDED || event.type === DomainEventName.PROJECT_TOOL_FAILED) {
      // FLAT shape — state/action/tool live at the top level of the event data.
      return data.stateId === stateId && data.actionId === actionId && data.tool === tool;
    }

    if (event.type === DomainEventName.TOOL_INVOCATION_SUCCEEDED || event.type === DomainEventName.TOOL_INVOCATION_FAILED) {
      // NESTED shape — tool name is top-level; state/action are recovered from
      // the toolResult.outputFile path so a retry's freshest event still wins.
      if (data.tool !== tool) return false;
      const toolResult = isRecord(data.toolResult) ? data.toolResult : undefined;
      const outputFile = typeof toolResult?.outputFile === 'string' ? toolResult.outputFile : undefined;
      if (!outputFile) return false;
      const segments = toolOutputPathSegments(outputFile);
      return segments !== undefined
        && segments.beadId === beadId
        && segments.stateId === stateId
        && segments.actionId === actionId
        && segments.tool === tool;
    }

    return false;
  }

  // ---------------------------------------------------------------------------
  // Public API – failure-limit queries
  // ---------------------------------------------------------------------------

  public async latestProjectToolFailureLimitEvent(
    beadId: string,
    options: ProjectToolFailureLimitFilterOptions = {}
  ): Promise<DomainEvent | undefined> {
    if (!beadId) return undefined;
    let latest: DomainEvent | undefined;
    let terminalOutcomeAcknowledged = false;
    for (const event of await this.eventsForBead(beadId)) {
      const data = event.data || {};
      if (this.isProjectToolFailureLimitWindowBoundary(event, options)) {
        latest = undefined;
        terminalOutcomeAcknowledged = false;
        continue;
      }
      if (this.isProjectToolTerminalOutcomeAcknowledged(event, options)) {
        terminalOutcomeAcknowledged = true;
        continue;
      }
      if (terminalOutcomeAcknowledged && this.isProjectToolStateRunStart(event, options)) {
        latest = undefined;
        terminalOutcomeAcknowledged = false;
        continue;
      }
      if (event.type !== DomainEventName.PROJECT_TOOL_FAILED) continue;
      if (options.stateId && data.stateId !== options.stateId) continue;
      if (options.actionId && data.actionId !== options.actionId) continue;
      const result = isRecord(data.result) ? data.result : undefined;
      const failureLimit = isRecord(result?.failureLimit) ? result.failureLimit : undefined;
      if (!failureLimit) continue;
      if (options.terminalOnly && failureLimit.terminal !== true) continue;
      if (!latest || this.compareEvents(latest, event) < 0) latest = event;
    }
    return latest;
  }

  private isProjectToolFailureLimitWindowBoundary(
    event: DomainEvent,
    options: ProjectToolFailureLimitFilterOptions
  ): boolean {
    if (event.type !== DomainEventName.STATE_TRANSITION_APPLIED) return false;
    const data = event.data || {};
    if (isRestartTransition(data.transitionEvent)) return false;
    if (options.stateId && data.fromState !== options.stateId && data.nextState !== options.stateId) return false;
    if (options.actionId && data.actionId && data.actionId !== options.actionId) return false;
    return true;
  }

  private isProjectToolTerminalOutcomeAcknowledged(
    event: DomainEvent,
    options: ProjectToolFailureLimitFilterOptions
  ): boolean {
    if (event.type !== DomainEventName.SIGNAL_ACKNOWLEDGED) return false;
    const data = event.data || {};
    if (
      data.type !== TeammateEventType.STATE_FAILED
      && data.type !== TeammateEventType.STATE_BLOCKED
      && data.type !== TeammateEventType.STATE_TRANSITIONED
    ) {
      return false;
    }
    if (isRestartTransition(data.transitionEvent)) return false;
    if (options.stateId && data.stateId !== options.stateId) return false;
    if (options.actionId && data.actionId && data.actionId !== options.actionId) return false;
    return true;
  }

  private isProjectToolStateRunStart(
    event: DomainEvent,
    options: ProjectToolFailureLimitFilterOptions
  ): boolean {
    if (event.type !== DomainEventName.STATE_RUN_INITIALIZED) return false;
    const data = event.data || {};
    if (options.stateId && data.stateId !== options.stateId) return false;
    if (options.actionId && data.actionId && data.actionId !== options.actionId) return false;
    return true;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers – projection
  // ---------------------------------------------------------------------------

  /**
   * Builds an advanceOutcomes Set from config for threading into BeadStateProjection.
   * Returns undefined when no statechart block is present so the projection falls
   * back to its own DEFAULT_ADVANCE_OUTCOMES (['SUCCESS']) — byte-identical to
   * the old behaviour.
   *
   * No import of FlowManager or ConfigLoader constants — purely a Set<string>
   * extracted from the already-loaded config object (layering-safe).
   */
  private advanceOutcomesFromConfig(config: { statechart?: { advanceOutcomes?: string[] } }): Set<string> | undefined {
    const outcomes = config.statechart?.advanceOutcomes;
    if (!outcomes) return undefined;
    // Store upper-cased to match the predicate's .toUpperCase() comparison.
    return new Set(outcomes.map(o => o.toUpperCase()));
  }

  // ---------------------------------------------------------------------------
  // Public API – projections
  // ---------------------------------------------------------------------------

  public async projectBeadStateChart(beadId: string): Promise<BeadStateChartProjection> {
    const config = await this.configLoader.load();
    return this.projection.projectBeadStateChartFromEvents(
      beadId,
      await this.eventsForBead(beadId),
      config.settings.workflowVersion,
      {},
      this.advanceOutcomesFromConfig(config)
    );
  }

  public async projectBead(
    beadId: string,
    options: EventProjectionOptions = {}
  ): Promise<Partial<HarnessBeadMetadata>> {
    const config = await this.configLoader.load();
    return this.projection.projectBeadFromEvents(
      beadId,
      await this.eventsForBead(beadId),
      config.settings.workflowVersion,
      options,
      this.advanceOutcomesFromConfig(config)
    );
  }

  public async projectBeads(
    beadIds: Iterable<string>,
    options: EventProjectionOptions = {}
  ): Promise<Map<string, Partial<HarnessBeadMetadata>>> {
    const ids = [...new Set([...beadIds].filter(Boolean))];
    const projections = new Map<string, Partial<HarnessBeadMetadata>>();
    if (ids.length === 0) return projections;

    const config = await this.configLoader.load();
    const advanceOutcomes = this.advanceOutcomesFromConfig(config);
    const groupedEvents = await this.eventsForBeads(ids);
    for (const beadId of ids) {
      projections.set(
        beadId,
        this.projection.projectBeadFromEvents(beadId, groupedEvents.get(beadId) || [], config.settings.workflowVersion, options, advanceOutcomes)
      );
    }
    return projections;
  }
}
