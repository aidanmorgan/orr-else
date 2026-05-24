import * as fs from 'fs';
import * as path from 'path';
import { createInterface } from 'readline';
import { v7 as uuidv7 } from 'uuid';
import { getProjectRoot, resolveProject } from './Paths.js';
import { ConfigLoader } from './ConfigLoader.js';
import { Logger } from './Logger.js';
import {
  ActionCompletionKey,
  BeadStatus,
  Component,
  AgentFailureCode,
  AgentFailureSummary,
  DomainEventName,
  EnvVars,
  EVENT_STORE_ONLY_METADATA_KEYS,
  EventName,
  EventProjectionDefaults,
  EventStoreDefaults,
  MergeAndCommitStatus,
  RestartKind
} from '../constants/index.js';
import type { HarnessBeadMetadata } from '../types/index.js';

const existsSync = fs.existsSync;
const appendFileAsync = fs.promises.appendFile;
const readdirAsync = fs.promises.readdir;

export interface DomainEvent {
  id: string;
  type: DomainEventName | string;
  timestamp: string;
  sessionId: string;
  data: any;
}

export interface EventProjectionOptions {
  includeDetails?: boolean;
}

export interface LatestEventFilterOptions {
  excludeTypes?: readonly string[];
  excludeTeammateEventTypes?: readonly string[];
  excludeToolNames?: readonly string[];
}

export interface BeadStateTransitionProjection {
  eventId: string;
  sessionId: string;
  timestamp: string;
  fromState?: string;
  toState?: string;
  transitionEvent?: string;
  actionId?: string;
  summary?: string;
  evidence?: string;
}

export interface BeadStateChartProjection {
  beadId: string;
  currentState?: string;
  previousState?: string;
  beadStatus?: string;
  activeActionId?: string;
  assignedTo?: string;
  lease?: HarnessBeadMetadata['lease'];
  leaseSessionId?: string;
  worktreePath?: string;
  handovers: Record<string, string>;
  completedActionIds: string[];
  compactionCount?: number;
  checkedItems: Record<string, { checked: boolean; evidence?: string }>;
  addedChecklistItems: Array<{ text?: string; mandatory?: boolean; type?: string; source?: string; stateId?: string; actionId?: string; timestamp: string }>;
  checkpoints: Array<{ actionId?: string; summary?: string; evidence?: string; timestamp: string; sessionId: string }>;
  transitions: BeadStateTransitionProjection[];
  restartRequested?: boolean;
  restartKind?: RestartKind | string;
  restartEvent?: string;
  restartFromState?: string;
  restartTargetState?: string;
  mergeAndCommit?: {
    status: MergeAndCommitStatus;
    branchName?: string;
    targetBranch?: string;
    message?: string;
    error?: string;
    timestamp: string;
    sessionId: string;
  };
  lastEventId?: string;
  lastUpdatedAt?: string;
}

export class EventStore {
  private currentPath: string | null = null;
  private sessionId = process.env[EnvVars.OBSERVABILITY_SESSION_ID] || uuidv7();

  constructor(private readonly configLoader: ConfigLoader) {}

  public setSessionId(sessionId: string): void {
    if (this.sessionId === sessionId) return;
    this.sessionId = sessionId;
    this.currentPath = null;
  }

  private isRecord(value: unknown): value is Record<string, any> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  private deepMerge(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
    const output = { ...target };
    for (const key of Object.keys(source)) {
      if (source[key] === undefined) {
        delete output[key];
      } else if (this.isRecord(source[key]) && this.isRecord(target[key])) {
        output[key] = this.deepMerge(target[key], source[key]);
      } else {
        output[key] = source[key];
      }
    }
    return output;
  }

  private compactMetadataPatch(patch: Record<string, any>): Record<string, any> {
    const compacted = { ...patch };
    for (const key of EVENT_STORE_ONLY_METADATA_KEYS) {
      delete compacted[key];
    }
    return compacted;
  }

  private includeProjectionDetails(options?: EventProjectionOptions): boolean {
    return options?.includeDetails !== false;
  }

  private truncateProjectionText(value: string, maxChars: number): string {
    if (value.length <= maxChars) return value;
    return `${value.slice(0, maxChars)}... [truncated; full value remains in the event store]`;
  }

  private lifecycleFailureSummary(value: string): string | undefined {
    const normalized = value.toLowerCase();
    if (
      normalized.includes(AgentFailureCode.USAGE_LIMIT_REACHED)
      || normalized.includes('usage limit has been reached')
    ) {
      return `${AgentFailureSummary.USAGE_LIMIT} ${AgentFailureSummary.EVENT_STORE_DETAILS}`;
    }
    if (
      normalized.includes(AgentFailureCode.CONTEXT_LENGTH_EXCEEDED)
      || normalized.includes('context length exceeded')
      || normalized.includes('context window')
    ) {
      return `${AgentFailureSummary.CONTEXT_OVERFLOW} ${AgentFailureSummary.EVENT_STORE_DETAILS}`;
    }
    if (
      normalized.includes(AgentFailureCode.WEBSOCKET_ERROR)
      || normalized.includes(AgentFailureCode.WEBSOCKET_CLOSED)
      || normalized.includes(AgentFailureCode.CONNECTION_RESET)
      || normalized.includes(AgentFailureCode.NETWORK_ERROR)
    ) {
      return `${AgentFailureSummary.HARNESS_TRANSIENT} ${AgentFailureSummary.EVENT_STORE_DETAILS}`;
    }
    return undefined;
  }

  private compactProjectionHandover(value: string): string {
    return this.lifecycleFailureSummary(value)
      || this.truncateProjectionText(value, EventProjectionDefaults.HANDOVER_PREVIEW_CHARS);
  }

  private compactProjectionDetail(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    return this.compactProjectionHandover(value);
  }

  private compactProjectionHandovers(handovers: Record<string, unknown>): Record<string, string> {
    const compacted: Record<string, string> = {};
    for (const [stateId, handover] of Object.entries(handovers)) {
      if (typeof handover === 'string') compacted[stateId] = this.compactProjectionHandover(handover);
    }
    return compacted;
  }

  private beadIdFor(event: DomainEvent): string | undefined {
    return event.data?.beadId || event.data?.id;
  }

  private compareEvents(a: DomainEvent, b: DomainEvent): number {
    const byTime = Date.parse(a.timestamp) - Date.parse(b.timestamp);
    return byTime !== 0 ? byTime : String(a.id || '').localeCompare(String(b.id || ''));
  }

  private projectName(): string {
    const basename = path.basename(getProjectRoot());
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

  private async resolveLocation(): Promise<{ dir: string; path: string } | null> {
    const config = await this.configLoader.load();
    const eventStore = config.settings.eventStore;
    if (eventStore?.enabled === false) {
      this.currentPath = null;
      return null;
    }

    const projectName = eventStore?.name || this.projectName();
    const configuredDir = eventStore?.dir || EventStoreDefaults.DIR;
    const configuredFileName = eventStore?.fileName || EventStoreDefaults.FILE_NAME_TEMPLATE;
    this.assertSessionIndependentPath(configuredDir, 'dir');
    this.assertSessionIndependentPath(configuredFileName, 'fileName');

    const expandedDir = this.expandProjectName(configuredDir, projectName);
    const expandedFileName = this.expandProjectName(configuredFileName, projectName);
    const logDir = path.isAbsolute(expandedDir) ? expandedDir : resolveProject(expandedDir);
    const fileName = path.basename(expandedFileName);
    return { dir: logDir, path: path.join(logDir, fileName) };
  }

  private async init(): Promise<string | null> {
    const location = await this.resolveLocation();
    if (!location) return null;

    if (this.currentPath === location.path) return location.path;

    if (!existsSync(location.dir)) {
      fs.mkdirSync(location.dir, { recursive: true });
    }

    this.currentPath = location.path;
    return location.path;
  }

  private async eventFilePaths(dir: string): Promise<string[]> {
    return (await readdirAsync(dir))
      .filter(file => file.endsWith('.jsonl'))
      .sort()
      .map(file => path.join(dir, file));
  }

  private async scanEvents(visitor: (event: DomainEvent) => void): Promise<void> {
    const location = await this.resolveLocation();
    if (!location || !existsSync(location.dir)) return;

    for (const filePath of await this.eventFilePaths(location.dir)) {
      const lines = createInterface({
        input: fs.createReadStream(filePath, { encoding: 'utf8' }),
        crlfDelay: Infinity
      });

      for await (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as DomainEvent;
          if (parsed?.type && parsed?.timestamp) visitor(parsed);
        } catch (error) {
          Logger.warn(Component.CORE, 'Ignoring malformed event-store line', { filePath, error: String(error) });
        }
      }
    }
  }

  public async record(event: DomainEventName | string, data: any) {
    const logPath = await this.init();
    
    const entry: DomainEvent = {
      id: uuidv7(),
      type: event,
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      data
    };

    if (logPath) {
      await appendFileAsync(logPath, JSON.stringify(entry) + '\n');
    }
    
    Logger.debug(Component.CORE, `Event recorded: ${event}`, { data });
  }

  public async readAll(): Promise<DomainEvent[]> {
    const events: DomainEvent[] = [];
    await this.scanEvents(event => events.push(event));
    return events.sort(this.compareEvents);
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

    for (const filePath of await this.eventFilePaths(location.dir)) {
      const lines = createInterface({
        input: fs.createReadStream(filePath, { encoding: 'utf8' }),
        crlfDelay: Infinity
      });

      for await (const line of lines) {
        if (!line.trim()) continue;
        if (!requestedIds.some(beadId => line.includes(beadId))) continue;
        try {
          const parsed = JSON.parse(line) as DomainEvent;
          const beadId = this.beadIdFor(parsed);
          if (!beadId || !requested.has(beadId)) continue;
          grouped.get(beadId)!.push(parsed);
        } catch (error) {
          Logger.warn(Component.CORE, 'Ignoring malformed event-store line', { filePath, error: String(error) });
        }
      }
    }

    for (const events of grouped.values()) {
      events.sort(this.compareEvents);
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
    const location = await this.resolveLocation();
    if (!location || !existsSync(location.dir)) return latest;
    const requestedIds = [...requested];

    for (const filePath of await this.eventFilePaths(location.dir)) {
      const lines = createInterface({
        input: fs.createReadStream(filePath, { encoding: 'utf8' }),
        crlfDelay: Infinity
      });

      for await (const line of lines) {
        if (!line.trim()) continue;
        if (!requestedIds.some(beadId => line.includes(beadId))) continue;
        try {
          const parsed = JSON.parse(line) as DomainEvent;
          const beadId = this.beadIdFor(parsed);
          if (!beadId || !requested.has(beadId)) continue;
          if (excludedTypes.has(String(parsed.type))) continue;
          if (excludedTeammateEventTypes.has(String(parsed.data?.type))) continue;
          if (excludedToolNames.has(String(parsed.data?.tool))) continue;
          const current = latest.get(beadId);
          if (!current || this.compareEvents(current, parsed) < 0) latest.set(beadId, parsed);
        } catch (error) {
          Logger.warn(Component.CORE, 'Ignoring malformed event-store line', { filePath, error: String(error) });
        }
      }
    }

    return latest;
  }

  public async projectBeadStateChart(beadId: string): Promise<BeadStateChartProjection> {
    const config = await this.configLoader.load();
    return this.projectBeadStateChartFromEvents(
      beadId,
      await this.eventsForBead(beadId),
      config.settings.workflowVersion
    );
  }

  private workflowActionPrefix(workflowVersion?: string): string | undefined {
    const normalized = workflowVersion?.trim();
    if (!normalized) return undefined;
    return `${ActionCompletionKey.WORKFLOW_PREFIX}=${normalized}${ActionCompletionKey.FIELD_SEPARATOR}`;
  }

  private eventAppliesToWorkflow(data: Record<string, any>, workflowVersion?: string): boolean {
    const prefix = this.workflowActionPrefix(workflowVersion);
    if (!prefix) return true;
    return typeof data.actionKey === 'string' && data.actionKey.startsWith(prefix);
  }

  private completedActionFromData(data: Record<string, any>, workflowVersion?: string): unknown {
    if (!workflowVersion?.trim()) return data.actionKey || data.actionId;
    return this.eventAppliesToWorkflow(data, workflowVersion) ? data.actionKey : undefined;
  }

  private projectBeadStateChartFromEvents(
    beadId: string,
    events: DomainEvent[],
    workflowVersion?: string,
    options: EventProjectionOptions = {}
  ): BeadStateChartProjection {
    const includeDetails = this.includeProjectionDetails(options);
    const projection: BeadStateChartProjection = {
      beadId,
      handovers: {},
      completedActionIds: [],
      checkedItems: {},
      addedChecklistItems: [],
      checkpoints: [],
      transitions: []
    };

    const completeAction = (actionId: unknown): void => {
      if (typeof actionId !== 'string' || !actionId) return;
      projection.completedActionIds = [
        ...new Set([...projection.completedActionIds, actionId])
      ];
    };

    const applyRestart = (event: DomainEvent, kind: RestartKind): void => {
      const data = event.data || {};
      projection.restartRequested = true;
      projection.restartKind = kind;
      projection.restartEvent = data.transitionEvent;
      projection.restartFromState = data.stateId;
      projection.restartTargetState = data.targetState || data.stateId;
      if (data.targetState) projection.currentState = data.targetState;
      if (includeDetails) completeAction(this.completedActionFromData(data, workflowVersion));
      if (includeDetails && this.eventAppliesToWorkflow(data, workflowVersion) && typeof data.handover === 'string' && data.stateId) {
        projection.handovers[data.stateId] = this.compactProjectionHandover(data.handover);
      }
    };

    for (const event of events) {
      const data = event.data || {};
      projection.lastEventId = event.id;
      projection.lastUpdatedAt = event.timestamp;

      switch (event.type) {
        case DomainEventName.BEAD_CLAIMED:
          projection.currentState = data.stateId || projection.currentState;
          projection.assignedTo = data.owner || projection.assignedTo;
          projection.lease = data.lease || projection.lease;
          projection.leaseSessionId = data.lease ? event.sessionId : projection.leaseSessionId;
          projection.restartRequested = data.restartRequested || false;
          projection.restartKind = data.restartKind;
          projection.restartEvent = data.restartEvent;
          projection.restartFromState = data.restartFromState;
          projection.restartTargetState = data.restartTargetState;
          break;
        case DomainEventName.STATE_RUN_INITIALIZED:
          if (this.eventAppliesToWorkflow(data, workflowVersion)) {
            projection.currentState = data.stateId || projection.currentState;
            projection.activeActionId = data.actionId || projection.activeActionId;
          }
          break;
        case DomainEventName.ACTION_COMPLETED:
          if (includeDetails) completeAction(this.completedActionFromData(data, workflowVersion));
          break;
        case DomainEventName.TEAMMATE_SPAWNED:
          projection.currentState = data.stateId || projection.currentState;
          projection.worktreePath = data.worktreePath || projection.worktreePath;
          break;
        case DomainEventName.STATE_TRANSITION_APPLIED:
          if (this.eventAppliesToWorkflow(data, workflowVersion)) {
            projection.previousState = data.fromState || projection.currentState;
            projection.currentState = data.nextState || projection.currentState;
            projection.activeActionId = undefined;
            if (includeDetails) {
              projection.transitions.push({
                eventId: event.id,
                sessionId: event.sessionId,
                timestamp: event.timestamp,
                fromState: data.fromState,
                toState: data.nextState,
                transitionEvent: data.transitionEvent,
                actionId: data.actionId,
                summary: this.compactProjectionDetail(data.summary),
                evidence: this.compactProjectionDetail(data.evidence)
              });
            }
          }
          if (includeDetails && this.eventAppliesToWorkflow(data, workflowVersion) && typeof data.handover === 'string' && data.fromState) {
            projection.handovers[data.fromState] = this.compactProjectionHandover(data.handover);
          }
          if (includeDetails && data.transitionEvent === EventName.SUCCESS) completeAction(this.completedActionFromData(data, workflowVersion));
          projection.restartRequested = false;
          projection.restartKind = undefined;
          projection.restartEvent = undefined;
          projection.restartFromState = undefined;
          projection.restartTargetState = undefined;
          break;
        case DomainEventName.CONTEXT_RESTART_REQUESTED:
          applyRestart(event, RestartKind.CONTEXT);
          break;
        case DomainEventName.HARNESS_RESTART_REQUESTED:
          applyRestart(event, RestartKind.HARNESS);
          break;
        case DomainEventName.CHECKLIST_ITEM_TICKED:
          if (includeDetails && this.eventAppliesToWorkflow(data, workflowVersion) && typeof data.text === 'string') {
            projection.checkedItems[data.text] = { checked: true, evidence: data.evidence };
          }
          break;
        case DomainEventName.CHECKLIST_ITEM_ADDED:
          if (includeDetails && this.eventAppliesToWorkflow(data, workflowVersion) && (data.item?.text || data.text)) {
            const text = data.item?.text || data.text;
            const existing = projection.addedChecklistItems.find(item =>
              item.text === text &&
              item.stateId === data.stateId &&
              item.actionId === data.actionId
            );
            const nextItem = {
              text,
              mandatory: data.item?.mandatory ?? data.mandatory,
              type: data.item?.type || data.type,
              source: data.source,
              stateId: data.stateId,
              actionId: data.actionId,
              timestamp: event.timestamp
            };
            if (existing) {
              if (nextItem.mandatory === true) existing.mandatory = true;
              existing.type = existing.type || nextItem.type;
              existing.source = existing.source || nextItem.source;
              existing.timestamp = nextItem.timestamp;
            } else {
              projection.addedChecklistItems.push(nextItem);
            }
          }
          break;
        case DomainEventName.CHECKPOINT_SUBMITTED:
          if (includeDetails && this.eventAppliesToWorkflow(data, workflowVersion)) {
            projection.checkpoints.push({
              actionId: data.actionId,
              summary: this.compactProjectionDetail(data.summary),
              evidence: this.compactProjectionDetail(data.evidence),
              timestamp: event.timestamp,
              sessionId: event.sessionId
            });
          }
          break;
        case DomainEventName.CONTEXT_COMPACTION_RECORDED:
          projection.compactionCount = data.compactionCount || projection.compactionCount;
          break;
        case DomainEventName.WORKTREE_CREATED:
        case DomainEventName.WORKTREE_REUSED:
        case DomainEventName.WORKTREE_PROVISIONED:
          projection.worktreePath = data.path || data.worktreePath || projection.worktreePath;
          break;
        case DomainEventName.WORKTREE_REMOVED:
          projection.worktreePath = undefined;
          break;
        case DomainEventName.MERGE_AND_COMMIT_STARTED:
          projection.mergeAndCommit = {
            status: MergeAndCommitStatus.STARTED,
            branchName: data.branchName,
            targetBranch: data.targetBranch,
            message: data.message,
            timestamp: event.timestamp,
            sessionId: event.sessionId
          };
          break;
        case DomainEventName.MERGE_AND_COMMIT_SUCCEEDED:
          projection.mergeAndCommit = {
            status: MergeAndCommitStatus.SUCCEEDED,
            branchName: data.branchName,
            targetBranch: data.targetBranch,
            message: data.message,
            timestamp: event.timestamp,
            sessionId: event.sessionId
          };
          break;
        case DomainEventName.MERGE_AND_COMMIT_FAILED:
          projection.mergeAndCommit = {
            status: MergeAndCommitStatus.FAILED,
            targetBranch: data.targetBranch,
            error: data.error,
            timestamp: event.timestamp,
            sessionId: event.sessionId
          };
          break;
        case DomainEventName.BEAD_STATUS_UPDATED:
          projection.beadStatus = data.status || projection.beadStatus;
          break;
        case DomainEventName.BEAD_CLOSED:
          projection.beadStatus = BeadStatus.COMPLETED;
          projection.currentState = projection.currentState || BeadStatus.COMPLETED;
          projection.lease = undefined;
          projection.leaseSessionId = undefined;
          break;
        case DomainEventName.BEAD_RELEASED:
          projection.lease = undefined;
          projection.leaseSessionId = undefined;
          break;
      }
    }

    return projection;
  }

  private projectBeadFromEvents(
    beadId: string,
    events: DomainEvent[],
    workflowVersion?: string,
    options: EventProjectionOptions = {}
  ): Partial<HarnessBeadMetadata> {
    const projection: Record<string, any> = {};
    const includeDetails = this.includeProjectionDetails(options);
    for (const event of events) {
      const data = event.data || {};
      projection.lastActivity = event.timestamp;
      switch (event.type) {
        case DomainEventName.BEAD_METADATA_MERGED:
          Object.assign(
            projection,
            this.deepMerge(
              projection,
              includeDetails
                ? data.patch || {}
                : this.compactMetadataPatch(data.patch || {})
            )
          );
          break;
        case DomainEventName.BEAD_CLAIMED:
          Object.assign(projection, this.deepMerge(projection, {
            status: data.stateId,
            assigned_to: data.owner,
            lease: data.lease,
            leaseSessionId: data.lease ? event.sessionId : undefined,
            restartRequested: data.restartRequested,
            restartKind: data.restartKind,
            restartEvent: data.restartEvent,
            restartFromState: data.restartFromState,
            restartTargetState: data.restartTargetState
          }));
          break;
        case DomainEventName.WORKTREE_CREATED:
        case DomainEventName.WORKTREE_REUSED:
        case DomainEventName.WORKTREE_PROVISIONED:
          if (data.path || data.worktreePath) projection.worktree_path = data.path || data.worktreePath;
          break;
        case DomainEventName.WORKTREE_REMOVED:
          delete projection.worktree_path;
          break;
        case DomainEventName.TEAMMATE_SPAWNED:
          if (data.stateId) projection.status = data.stateId;
          if (data.worktreePath) projection.worktree_path = data.worktreePath;
          break;
        case DomainEventName.STATE_RUN_INITIALIZED:
          if (this.eventAppliesToWorkflow(data, workflowVersion) && data.stateId) projection.status = data.stateId;
          break;
        case DomainEventName.ACTION_COMPLETED:
          {
            const completedAction = this.completedActionFromData(data, workflowVersion);
            if (!completedAction) break;
            projection.completedActionIds = [
              ...new Set([...(projection.completedActionIds || []), completedAction])
            ];
          }
          break;
        case DomainEventName.STATE_TRANSITION_APPLIED:
          if (this.eventAppliesToWorkflow(data, workflowVersion) && data.nextState) projection.status = data.nextState;
          if (includeDetails && this.eventAppliesToWorkflow(data, workflowVersion) && data.handover && data.fromState) {
              projection.handovers = {
                ...(projection.handovers || {}),
                [data.fromState]: this.compactProjectionHandover(data.handover)
              };
            }
          if (data.transitionEvent === EventName.SUCCESS) {
            const completedAction = this.completedActionFromData(data, workflowVersion);
            if (completedAction) {
              projection.completedActionIds = [
                ...new Set([...(projection.completedActionIds || []), completedAction])
              ];
            }
          }
          projection.restartRequested = false;
          delete projection.restartKind;
          delete projection.restartEvent;
          delete projection.restartFromState;
          delete projection.restartTargetState;
          break;
        case DomainEventName.CONTEXT_RESTART_REQUESTED:
        case DomainEventName.HARNESS_RESTART_REQUESTED:
          projection.restartRequested = true;
          projection.restartKind = event.type === DomainEventName.CONTEXT_RESTART_REQUESTED ? RestartKind.CONTEXT : RestartKind.HARNESS;
          projection.restartEvent = data.transitionEvent;
          projection.restartFromState = data.stateId;
          projection.restartTargetState = data.targetState || data.stateId;
          if (data.targetState) projection.status = data.targetState;
          break;
        case DomainEventName.BEAD_RELEASED:
          delete projection.lease;
          delete projection.leaseSessionId;
          break;
        case DomainEventName.BEAD_STATUS_UPDATED:
          if (data.status) projection.status = data.status;
          break;
        case DomainEventName.BEAD_CLOSED:
          projection.status = BeadStatus.COMPLETED;
          delete projection.lease;
          delete projection.leaseSessionId;
          break;
        case DomainEventName.CHECKLIST_ITEM_TICKED:
          if (includeDetails && this.eventAppliesToWorkflow(data, workflowVersion) && typeof data.text === 'string') {
            projection.checklists = {
              ...(projection.checklists || {}),
              [data.text]: { checked: true, evidence: data.evidence }
            };
          }
          break;
        case DomainEventName.CONTEXT_COMPACTION_RECORDED:
          if (typeof data.compactionCount === 'number') projection.compactionCount = data.compactionCount;
          break;
      }
    }

    const stateChart = this.projectBeadStateChartFromEvents(beadId, events, workflowVersion, options);
    const workflowScoped = !!workflowVersion?.trim();
    if (stateChart.currentState) projection.status = stateChart.currentState;
    if (stateChart.beadStatus) projection.status = stateChart.beadStatus;
    if (stateChart.worktreePath) projection.worktree_path = stateChart.worktreePath;
    if (includeDetails && this.isRecord(projection.handovers)) {
      projection.handovers = this.compactProjectionHandovers(projection.handovers);
    }
    if (includeDetails && (Object.keys(stateChart.handovers).length > 0 || workflowScoped)) projection.handovers = stateChart.handovers;
    if (includeDetails && (stateChart.completedActionIds.length > 0 || workflowScoped)) projection.completedActionIds = stateChart.completedActionIds;
    if (stateChart.compactionCount !== undefined) projection.compactionCount = stateChart.compactionCount;
    if (includeDetails && (Object.keys(stateChart.checkedItems).length > 0 || workflowScoped)) projection.checklists = stateChart.checkedItems;
    if (stateChart.assignedTo) projection.assigned_to = stateChart.assignedTo;
    if (stateChart.lease) projection.lease = stateChart.lease;
    if (stateChart.leaseSessionId) projection.leaseSessionId = stateChart.leaseSessionId;
    if (stateChart.restartRequested !== undefined) projection.restartRequested = stateChart.restartRequested;
    projection.restartKind = stateChart.restartKind;
    projection.restartEvent = stateChart.restartEvent;
    projection.restartFromState = stateChart.restartFromState;
    projection.restartTargetState = stateChart.restartTargetState;

    if (includeDetails) {
      const dynamicChecklists = workflowScoped ? {} : { ...(projection.dynamicChecklists || {}) };
      for (const item of stateChart.addedChecklistItems) {
        if (!item.text || !item.stateId || !item.actionId) continue;
        const runKey = `${item.stateId}/${item.actionId}`;
        const existingRun = dynamicChecklists[runKey] || {};
        const existingItems = Array.from(
          new Map(
            (Array.isArray(existingRun.items) ? existingRun.items : [])
              .filter((candidate: any) => candidate?.text)
              .map((candidate: any) => [candidate.text, candidate])
          ).values()
        );
        const existingItem = existingItems.find((candidate: any) => candidate?.text === item.text);
        const projectedItem = {
          text: item.text,
          mandatory: item.mandatory,
          type: item.type,
          metadata: { source: item.source }
        };
        const items = existingItem
          ? existingItems.map((candidate: any) => {
              if (candidate?.text !== item.text) return candidate;
              return {
                ...candidate,
                mandatory: candidate.mandatory === true || item.mandatory === true,
                type: candidate.type || item.type,
                metadata: {
                  ...(candidate.metadata || {}),
                  source: candidate.metadata?.source || item.source
                }
              };
            })
          : [...existingItems, projectedItem];
        dynamicChecklists[runKey] = {
          ...existingRun,
          updatedAt: item.timestamp,
          items
        };
      }
      if (Object.keys(dynamicChecklists).length > 0 || workflowScoped) {
        projection.dynamicChecklists = dynamicChecklists;
      }
    }

    return projection as Partial<HarnessBeadMetadata>;
  }

  public async projectBead(beadId: string): Promise<Partial<HarnessBeadMetadata>> {
    const config = await this.configLoader.load();
    return this.projectBeadFromEvents(
      beadId,
      await this.eventsForBead(beadId),
      config.settings.workflowVersion
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
    const groupedEvents = await this.eventsForBeads(ids);
    for (const beadId of ids) {
      projections.set(
        beadId,
        this.projectBeadFromEvents(beadId, groupedEvents.get(beadId) || [], config.settings.workflowVersion, options)
      );
    }
    return projections;
  }
}
