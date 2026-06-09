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
import { DomainEventName, TeammateEventType } from '../constants/domain.js';
import { Component, EnvVars, EventStoreDefaults } from '../constants/infra.js';
import { asEventId, asSessionId, type BeadId, type StateId, type ActionId, type ToolName } from '../types/ids.js';
import { BeadEventIndex } from './BeadEventIndex.js';
import { BeadStateProjection } from './BeadStateProjection.js';
import { DOMAIN_EVENT_SCHEMAS, DOMAIN_EVENT_SCHEMA_METADATA } from './DomainEventSchemas.js';

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
 *
 * pi-experiment-824i: added schemaVersion for deterministic diagnostics (AC4).
 */
export interface EventStoreValidationDiagnostic {
  eventType: string;
  schemaVersion: number | undefined;
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
    const schemaRef = diagnostic.schemaVersion !== undefined ? ` (schema v${diagnostic.schemaVersion})` : '';
    super(
      `${diagnostic.eventType}${schemaRef}: missing required field(s) [${missing}] in production event payload. ` +
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
 * Thrown when a production EventStore READ path encounters a record with
 * data.synthetic === true on disk (pi-experiment-jxdk: fail-closed).
 *
 * Since pi-experiment-824i, the production write path rejects synthetic writes,
 * so a synthetic record on disk indicates store corruption or a pre-824i legacy
 * record.  Production reads MUST NOT silently drop it — they fail closed with
 * this deterministic diagnostic so the caller can quarantine or surface the
 * anomaly.
 *
 * Note: this reverses the y2ax decision that kept a silent read-layer filter.
 * Per the owner's no-backcompat directive, the silent filter is removed.
 * Real production event logs contain no synthetic records (824i rejects writes),
 * so this error fires only if the store is corrupted or a pre-824i record is
 * encountered.
 */
export class EventStoreSyntheticReadError extends Error {
  public readonly eventType: string;
  public readonly eventId: string | undefined;

  constructor(eventType: string, eventId: string | undefined) {
    super(
      `${eventType}${eventId ? ` (id=${eventId})` : ''}: production EventStore encountered data.synthetic === true during a read. ` +
      `Synthetic records must never appear in production event logs (pi-experiment-824i rejects synthetic writes). ` +
      `Store may be corrupted or contain a pre-824i legacy record. ` +
      `Use a TestEventStore (tests/support/TestEventStore.ts) for test/fixture data.`
    );
    this.name = 'EventStoreSyntheticReadError';
    this.eventType = eventType;
    this.eventId = eventId;
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

  const schemaVersion = DOMAIN_EVENT_SCHEMA_METADATA[eventType]?.version;
  return {
    eventType,
    schemaVersion,
    missingFields,
    receivedKeys: Object.keys(data)
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
   * Fail-closed guard for production reads (pi-experiment-jxdk).
   *
   * Since pi-experiment-824i the production write path rejects synthetic events,
   * so a synthetic record on disk is unexpected.  Production reads MUST NOT
   * silently drop it — they throw so the anomaly is surfaced deterministically.
   *
   * This reverses the y2ax decision (silent read-layer filter).  Real production
   * event logs contain no synthetic records, so this throws only for corrupted
   * or pre-824i stores.
   */
  private rejectSyntheticReadIfPresent(event: DomainEvent): void {
    if (isRecord(event.data) && event.data.synthetic === true) {
      throw new EventStoreSyntheticReadError(event.type, typeof event.id === 'string' ? event.id : undefined);
    }
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
        if (!this.isDomainEvent(value)) return;
        this.rejectSyntheticReadIfPresent(value); // fail-closed (jxdk)
        visitor(value);
      });
    }
  }

  /**
   * Scan all event files, yielding valid DomainEvents AND counting records that
   * are present on disk as JSON objects but fail the domain-event shape check
   * (missing type/timestamp strings).
   *
   * Used by HarnessEventQuery to surface a real skippedCount (AC5: malformed
   * records are reported as counts, never hidden or inlined).
   *
   * Throws EventStoreSyntheticReadError if a synthetic record is encountered
   * (pi-experiment-jxdk: fail-closed; synthetic records must not be silently
   * ignored).
   */
  private async scanEventsWithCount(
    visitor: (event: DomainEvent) => void
  ): Promise<number> {
    const location = await this.resolveLocation();
    if (!location || !existsSync(location.dir)) return 0;

    let skippedCount = 0;
    for (const filePath of await this.eventLog.eventFilePaths(location.dir)) {
      await this.eventLog.scan(filePath, value => {
        if (!isRecord(value)) return; // not a JSON object — unparseable by ndjson already filtered
        if (!this.isDomainEvent(value)) {
          skippedCount++;
          return;
        }
        this.rejectSyntheticReadIfPresent(value); // fail-closed (jxdk)
        visitor(value);
      });
    }
    return skippedCount;
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
      id: asEventId(uuidv7()),
      type: event,
      timestamp: new Date(this.clock.now()).toISOString(),
      sessionId: asSessionId(this.sessionId),
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

  /**
   * Return the most-recent valid DomainEvent across all event log files using a
   * bounded tail scan — O(tailBytes × files) rather than O(total_events).
   *
   * Strategy: read only the last `tailBytes` of each JSONL file, parse every
   * complete record in that window, keep the chronologically latest valid event.
   * The tail window is generous enough to contain dozens of recent events without
   * scanning the whole store.
   *
   * If no event is found in the tail window (e.g. only very old files) the
   * method returns undefined.
   *
   * Throws EventStoreSyntheticReadError if a synthetic record is encountered
   * (pi-experiment-jxdk: fail-closed).
   */
  public async latestEvent(tailBytes = 65_536): Promise<DomainEvent | undefined> {
    const location = await this.resolveLocation();
    if (!location || !existsSync(location.dir)) return undefined;

    let latest: DomainEvent | undefined;
    let syntheticError: EventStoreSyntheticReadError | undefined;

    for (const filePath of await this.eventLog.eventFilePaths(location.dir)) {
      if (!existsSync(filePath)) continue;
      // NOTE: scanTail swallows exceptions thrown from within the visitor
      // callback (it catches JSON-parse errors broadly).  Track synthetic errors
      // via a captured variable and re-throw after the scan (fail-closed, jxdk).
      await this.eventLog.scanTail(filePath, tailBytes, value => {
        if (!this.isDomainEvent(value)) return;
        if (isRecord(value.data) && value.data.synthetic === true) {
          syntheticError = new EventStoreSyntheticReadError(
            value.type,
            typeof value.id === 'string' ? value.id : undefined
          );
          return; // stop accumulating; error will be thrown below
        }
        if (!latest || this.compareEvents(latest, value) < 0) latest = value;
      });
      if (syntheticError) throw syntheticError; // fail-closed (jxdk)
    }
    return latest;
  }

  /**
   * Read all valid domain events, also returning the count of records that were
   * present on disk as JSON objects but failed the domain-event shape check.
   *
   * Throws EventStoreSyntheticReadError if a synthetic record is encountered
   * (pi-experiment-jxdk: fail-closed).
   *
   * Used by HarnessEventQuery to surface a real skippedCount (AC5).
   */
  public async readAllRaw(): Promise<{ events: DomainEvent[]; skippedCount: number }> {
    const events: DomainEvent[] = [];
    const skippedCount = await this.scanEventsWithCount(event => events.push(event));
    return { events: events.sort(this.compareEvents.bind(this)), skippedCount };
  }

  public async eventsForBead(beadId: BeadId): Promise<DomainEvent[]> {
    return (await this.eventsForBeads([beadId])).get(beadId) || [];
  }

  public async eventsForBeads(beadIds: Iterable<BeadId>): Promise<Map<BeadId, DomainEvent[]>> {
    const requested = new Set([...beadIds].filter(Boolean));
    const grouped = new Map<BeadId, DomainEvent[]>();
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
        // Fail-closed: reject any synthetic record encountered in indexed reads (jxdk).
        for (const e of indexedEvents) this.rejectSyntheticReadIfPresent(e);
        grouped.set(beadId, indexedEvents);
      }
    }

    if (missing.size === 0) return grouped;

    for (const filePath of primaryFilePaths) {
      await this.eventLog.scan(filePath, value => {
        if (!this.isDomainEvent(value)) return;
        this.rejectSyntheticReadIfPresent(value); // fail-closed (jxdk)
        const beadId = this.beadIdFor(value) as BeadId | undefined;
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
    beadIds: Iterable<BeadId>,
    options: LatestEventFilterOptions = {}
  ): Promise<Map<BeadId, DomainEvent>> {
    const requested = new Set([...beadIds].filter(Boolean));
    const latest = new Map<BeadId, DomainEvent>();
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
   *    TOOL_INVOCATION_FAILED carry top-level { beadId, stateId, actionId, tool }
   *    plus a nested { toolResult: ToolResultBase }.
   *
   * Matching uses ONLY explicit canonical identity fields (beadId, stateId,
   * actionId, tool). Events missing explicit stateId/actionId at the top level
   * do NOT satisfy the query — path-layout parsing was removed (u7cl).
   */
  public async latestToolResultEvent(
    beadId: BeadId,
    stateId: StateId,
    actionId: ActionId,
    tool: ToolName
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
      // Canonical explicit-identity match (u7cl): stateId, actionId, and tool
      // must all be present and correct at the top level of the event data.
      // Events without explicit stateId/actionId do NOT match — path-layout
      // parsing was removed (u7cl). Events missing these fields are rejected.
      if (typeof data.stateId !== 'string' || typeof data.actionId !== 'string') return false;
      return data.stateId === stateId && data.actionId === actionId && data.tool === tool;
    }

    return false;
  }

  // ---------------------------------------------------------------------------
  // Public API – failure-limit queries
  // ---------------------------------------------------------------------------

  public async latestProjectToolFailureLimitEvent(
    beadId: BeadId,
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

  public async projectBeadStateChart(beadId: BeadId): Promise<BeadStateChartProjection> {
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
    beadId: BeadId,
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
    beadIds: Iterable<BeadId>,
    options: EventProjectionOptions = {}
  ): Promise<Map<BeadId, Partial<HarnessBeadMetadata>>> {
    const ids = [...new Set([...beadIds].filter(Boolean))];
    const projections = new Map<BeadId, Partial<HarnessBeadMetadata>>();
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
