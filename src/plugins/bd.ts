import { Type } from "@earendil-works/pi-ai";
import { createHash } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import lockfile from 'proper-lockfile';
import { Bead, BeadId, BeadsIssueRecord, HarnessBeadMetadata } from '../types/index.js';
import { getProjectRoot } from '../core/Paths.js';
import { Logger } from '../core/Logger.js';
import { EventStore } from '../core/EventStore.js';
import { getHarnessHeartbeats, postHarnessSignal } from '../core/HarnessApiClient.js';
import { createTeammateEventIdempotencyKey, type HeartbeatEvent } from '../core/TeammateEvents.js';
import {
  App,
  BeadStatus,
  BeadsDefaults,
  BeadsIssueStatus,
  BeadsCliCommand,
  Component,
  DomainEventName,
  EnvVars,
  Defaults,
  MUTATING_BEADS_COMMANDS,
  TeammateEventType,
  PluginToolName,
  StateChartToolDefaults,
  WorkerDefaults
} from '../constants/index.js';
import type { BeadStateChartProjection } from '../core/EventStore.js';

function projectRoot(): string {
  return process.env[EnvVars.PROJECT_ROOT] || getProjectRoot() || process.cwd();
}

function issuesJsonlPath(): string {
  return path.join(projectRoot(), '.beads', 'issues.jsonl');
}

function bdLockPath(): string {
  const root = projectRoot();
  const digest = createHash('sha256').update(root).digest('hex').slice(0, 16);
  return path.join(tmpdir(), 'orr-else-bd-locks', digest, 'bd-cli.lock');
}

interface HarnessHeartbeatParams {
  workerId: string;
  beadId: string;
  stateId: string;
  pid?: number;
  sessionStateId?: string;
}

async function ensureBdLockFile(): Promise<string> {
  const lockPath = bdLockPath();
  await mkdir(path.dirname(lockPath), { recursive: true });
  const handle = await open(lockPath, 'a');
  await handle.close();
  return lockPath;
}

async function withBdCliLock<T>(fn: () => Promise<T>): Promise<T> {
  const lockPath = await ensureBdLockFile();
  const startedAtMs = Date.now();
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(lockPath, {
      stale: BeadsDefaults.CLI_LOCK_STALE_MS,
      retries: {
        retries: BeadsDefaults.CLI_LOCK_RETRIES,
        factor: 1.1,
        minTimeout: BeadsDefaults.CLI_LOCK_RETRY_MIN_MS,
        maxTimeout: BeadsDefaults.CLI_LOCK_RETRY_MAX_MS
      }
    });
  } catch (error) {
    throw new Error(`Timed out acquiring bd CLI lock after ${Date.now() - startedAtMs}ms: ${String(error)}`);
  }

  const waitedMs = Date.now() - startedAtMs;
  if (waitedMs > BeadsDefaults.CLI_LOCK_RETRY_MAX_MS) {
    Logger.warn(Component.BEADS_CLI, 'Waited for bd CLI lock', { waitedMs, lockPath });
  }

  try {
    return await fn();
  } finally {
    await release?.().catch((error: unknown) => {
      Logger.warn(Component.BEADS_CLI, 'Unable to release bd CLI lock', { lockPath, error: String(error) });
    });
  }
}

async function execBd(finalArgs: string[], options: { input?: string } = {}): Promise<{ stdout: string; stderr: string }> {
  const result = await withBdCliLock(async () => {
    return await execa('bd', finalArgs, {
      input: options.input,
      maxBuffer: BeadsDefaults.MAX_BUFFER_BYTES,
      timeout: BeadsDefaults.CLI_TIMEOUT_MS
    });
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

async function exportJsonlAfterMutation(eventStore: EventStore, beadId: string | undefined, sourceCommand: string): Promise<void> {
  const outputPath = issuesJsonlPath();
  const args = ['-C', projectRoot(), 'export', '--output', outputPath];
  const eventArgs = ['export', '--output', outputPath];
  await eventStore.record(DomainEventName.BEADS_COMMAND_STARTED, {
    beadId,
    command: 'export',
    args: eventArgs,
    sourceCommand
  }).catch(() => {});

  try {
    const { stdout } = await execBd(args);
    await eventStore.record(DomainEventName.BEADS_COMMAND_SUCCEEDED, {
      beadId,
      command: 'export',
      args: eventArgs,
      sourceCommand,
      outputPath,
      outputBytes: stdout.trim().length
    }).catch(() => {});
  } catch (error) {
    Logger.warn(Component.BEADS_CLI, 'Unable to export Beads JSONL after mutation', {
      beadId,
      sourceCommand,
      outputPath,
      error: String(error)
    });
    await eventStore.record(DomainEventName.BEADS_COMMAND_FAILED, {
      beadId,
      command: 'export',
      args: eventArgs,
      sourceCommand,
      outputPath,
      error: String(error)
    }).catch(() => {});
  }
}

async function runBd(eventStore: EventStore, args: string[], options: { json?: boolean; input?: string; logErrors?: boolean } = {}): Promise<any> {
  const finalArgs = ['-C', projectRoot(), ...args];
  if (options.json !== false) finalArgs.push('--json');

  Logger.debug(Component.BEADS_CLI, 'Executing bd command', { args: finalArgs });
  const command = args[0];
  const beadId = command === BeadsCliCommand.UPDATE || command === BeadsCliCommand.CLOSE ? args[1] : undefined;
  const isMutation = MUTATING_BEADS_COMMANDS.has(command);
  if (isMutation) {
    await eventStore.record(DomainEventName.BEADS_COMMAND_STARTED, {
      beadId,
      command,
      args
    });
  }

  try {
    const { stdout } = await execBd(finalArgs, { input: options.input });

    const output = stdout.trim();
    if (isMutation) {
      await eventStore.record(DomainEventName.BEADS_COMMAND_SUCCEEDED, {
        beadId,
        command,
        args,
        outputBytes: output.length
      });
      await exportJsonlAfterMutation(eventStore, beadId, command);
    }
    if (options.json === false) return output;
    if (!output) return null;
    return JSON.parse(output);
  } catch (error) {
    if (isMutation) {
      await eventStore.record(DomainEventName.BEADS_COMMAND_FAILED, {
        beadId,
        command,
        args,
        error: String(error)
      }).catch(() => {});
    }
    if (options.logErrors !== false) {
      Logger.error(Component.BEADS_CLI, 'bd command failed', { args: finalArgs, error: String(error) });
    }
    throw error;
  }
}

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function previewText(value: unknown, limit: number = BeadsDefaults.TEXT_PREVIEW_CHARS): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function compactStateChartText(value: unknown, limit: number = StateChartToolDefaults.TEXT_PREVIEW_CHARS): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function compactChecklistEntries(
  record: Record<string, { checked: boolean; evidence?: unknown }>,
  limit: number
): Record<string, { checked: boolean; evidence?: string }> {
  return Object.fromEntries(
    Object.entries(record)
      .slice(-limit)
      .map(([text, item]) => [
        compactStateChartText(text, StateChartToolDefaults.DETAIL_TEXT_PREVIEW_CHARS) || text,
        {
          checked: item.checked,
          evidence: compactStateChartText(item.evidence, StateChartToolDefaults.DETAIL_TEXT_PREVIEW_CHARS)
        }
      ])
  );
}

function compactAddedChecklistItem(item: Record<string, any>): Record<string, unknown> {
  return {
    text: compactStateChartText(item.text, StateChartToolDefaults.DETAIL_TEXT_PREVIEW_CHARS),
    mandatory: item.mandatory,
    type: item.type,
    source: compactStateChartText(item.source, StateChartToolDefaults.DETAIL_TEXT_PREVIEW_CHARS),
    stateId: item.stateId,
    actionId: item.actionId,
    timestamp: item.timestamp
  };
}

function compactDynamicChecklists(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value as Record<string, any>)
      .slice(-StateChartToolDefaults.DETAIL_HANDOVERS)
      .map(([runKey, run]) => {
        const items = Array.isArray(run?.items) ? run.items : [];
        const compactItems = items.slice(-StateChartToolDefaults.DETAIL_ADDED_CHECKLIST_ITEMS)
          .filter((item: any) => item?.text)
          .map((item: any) => ({
            text: compactStateChartText(item.text, StateChartToolDefaults.DETAIL_TEXT_PREVIEW_CHARS),
            mandatory: item.mandatory,
            type: item.type,
            metadata: item.metadata && typeof item.metadata === 'object' ? { source: item.metadata.source } : undefined
          }));
        return [runKey, {
          itemCount: items.length,
          items: compactItems,
          itemsTruncated: compactItems.length < items.length
        }];
      })
  );
}

function compactHandovers(handovers: Record<string, string>, limit: number): Record<string, string> {
  return Object.fromEntries(
    Object.entries(handovers)
      .slice(-limit)
      .map(([stateId, handover]) => [stateId, compactStateChartText(handover, StateChartToolDefaults.DETAIL_TEXT_PREVIEW_CHARS) || ''])
  );
}

function safePositiveInteger(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

function isBeadsIssueStatus(value: unknown): value is BeadsIssueStatus {
  return typeof value === 'string' && Object.values(BeadsIssueStatus).includes(value as BeadsIssueStatus);
}

function stripRelationshipSuffix(title: string): string {
  return title.replace(/\s+\((?:blocked by:|blocks:|depends on:|blocked|blocking)[^)]+\)\s*$/i, '').trim();
}

function parseAssigneeAndTitle(rest: string): { assignee?: string; title: string } {
  const trimmed = rest.trim();
  if (trimmed.startsWith('@')) {
    const separatorIndex = trimmed.indexOf(' - ');
    if (separatorIndex > 0) {
      return {
        assignee: trimmed.slice(1, separatorIndex).trim(),
        title: stripRelationshipSuffix(trimmed.slice(separatorIndex + 3))
      };
    }
  }

  if (trimmed.startsWith('- ')) {
    return { title: stripRelationshipSuffix(trimmed.slice(2)) };
  }

  return { title: stripRelationshipSuffix(trimmed) };
}

function parsePriority(label: string): number | undefined {
  const match = label.match(/\bP([0-4])\b/i);
  return match ? Number(match[1]) : undefined;
}

export function parseReadyPlainOutput(output: string): BeadsIssueRecord[] {
  const issues: BeadsIssueRecord[] = [];
  let current: BeadsIssueRecord | undefined;

  for (const line of output.split('\n')) {
    const issueMatch = line.match(/^\s*\d+\.\s+\[([^\]]+)\]\s+\[([^\]]+)\]\s+([A-Za-z0-9_.-]+):\s+(.+)$/);
    if (issueMatch) {
      current = {
        id: issueMatch[3],
        title: stripRelationshipSuffix(issueMatch[4]),
        issue_type: issueMatch[2],
        priority: parsePriority(issueMatch[1]),
        status: BeadsIssueStatus.OPEN
      };
      issues.push(current);
      continue;
    }

    const assigneeMatch = line.match(/^\s*Assignee:\s+(.+)$/);
    if (assigneeMatch && current) {
      current.assignee = assigneeMatch[1].trim();
    }
  }

  return issues;
}

export function parseFlatListOutput(output: string, status?: string): BeadsIssueRecord[] {
  const issues: BeadsIssueRecord[] = [];
  for (const line of output.split('\n')) {
    const issueMatch = line.match(/^\S+\s+([A-Za-z0-9_.-]+)\s+\[([^\]]+)\]\s+\[([^\]]+)\]\s+(.+)$/);
    if (!issueMatch) continue;
    const parsed = parseAssigneeAndTitle(issueMatch[4]);
    issues.push({
      id: issueMatch[1],
      title: parsed.title,
      issue_type: issueMatch[3],
      priority: parsePriority(issueMatch[2]),
      status: status || BeadsIssueStatus.OPEN,
      assignee: parsed.assignee
    });
  }
  return issues;
}

function statusFor(issue: BeadsIssueRecord, metadata: HarnessBeadMetadata): string {
  switch (issue.status) {
    case BeadsIssueStatus.CLOSED:
    case BeadsIssueStatus.DONE:
      return BeadStatus.COMPLETED;
    case BeadsIssueStatus.BLOCKED:
      return BeadStatus.BLOCKED;
    case BeadsIssueStatus.DEFERRED:
      return BeadStatus.DEFERRED;
  }
  if (metadata.status) return metadata.status;
  switch (issue.status) {
    case BeadsIssueStatus.IN_PROGRESS:
      return BeadStatus.IN_PROGRESS;
    default:
      return BeadStatus.READY;
  }
}

function normalizeIssueWithProjection(
  issue: BeadsIssueRecord,
  projectedMetadata: Partial<HarnessBeadMetadata> = {},
  includeDetails = true
): Bead {
  const metadata = projectedMetadata as HarnessBeadMetadata;
  const bead: Bead = {
    id: issue.id as BeadId,
    title: issue.title,
    status: statusFor(issue, metadata),
    priority: issue.priority,
    description: issue.description,
    notes: issue.notes,
    assigned_to: metadata.assigned_to || issue.assignee || issue.owner,
    worktree_path: metadata.worktree_path,
    changed_files: metadata.changed_files || [],
    logs: metadata.logs || [],
    dependencies: (issue.dependencies || []).map(d => d.depends_on_id as BeadId),
    retryCount: metadata.retryCount || 0,
    compactionCount: metadata.compactionCount || 0,
    lastActivity: metadata.lastActivity || issue.updated_at || issue.created_at || new Date().toISOString(),
    subState: metadata.subState,
    totalExecutionTimeMs: metadata.totalExecutionTimeMs || 0,
    handovers: {},
    completedActionIds: [],
    restartRequested: metadata.restartRequested,
    restartKind: metadata.restartKind,
    restartEvent: metadata.restartEvent,
    restartFromState: metadata.restartFromState,
    restartTargetState: metadata.restartTargetState,
    lease: metadata.lease,
    leaseSessionId: metadata.leaseSessionId
  };

  const acceptanceCriteria = previewText(issue.acceptance_criteria, BeadsDefaults.LONG_TEXT_PREVIEW_CHARS);
  if (acceptanceCriteria) bead.acceptance_criteria = acceptanceCriteria;
  bead.description = previewText(issue.description, BeadsDefaults.LONG_TEXT_PREVIEW_CHARS);
  bead.notes = previewText(issue.notes, BeadsDefaults.LONG_TEXT_PREVIEW_CHARS);

  if (includeDetails) {
    if (metadata.checklists) {
      bead.checklists = compactChecklistEntries(metadata.checklists, StateChartToolDefaults.DETAIL_CHECKED_ITEMS);
      bead.checkedItemsTruncated = Object.keys(bead.checklists).length < Object.keys(metadata.checklists).length;
    }
    bead.dynamicChecklists = compactDynamicChecklists(metadata.dynamicChecklists);
    bead.handovers = compactHandovers(metadata.handovers || {}, StateChartToolDefaults.DETAIL_HANDOVERS);
    bead.handoversTruncated = Object.keys(bead.handovers).length < Object.keys(metadata.handovers || {}).length;
    bead.completedActionIds = (metadata.completedActionIds || []).slice(-StateChartToolDefaults.DETAIL_COMPLETED_ACTIONS);
    bead.completedActionIdsTruncated = bead.completedActionIds.length < (metadata.completedActionIds || []).length;
  }

  return bead;
}

function compactStateChartProjection(projection: BeadStateChartProjection): Record<string, unknown> {
  return {
    beadId: projection.beadId,
    currentState: projection.currentState,
    previousState: projection.previousState,
    beadStatus: projection.beadStatus,
    activeActionId: projection.activeActionId,
    assignedTo: projection.assignedTo,
    lease: projection.lease,
    leaseSessionId: projection.leaseSessionId,
    worktreePath: projection.worktreePath,
    handoverCount: Object.keys(projection.handovers).length,
    recentHandovers: compactHandovers(projection.handovers, StateChartToolDefaults.RECENT_HANDOVERS),
    compactionCount: projection.compactionCount,
    restartRequested: projection.restartRequested,
    restartKind: projection.restartKind,
    restartEvent: projection.restartEvent,
    restartFromState: projection.restartFromState,
    restartTargetState: projection.restartTargetState,
    mergeAndCommit: projection.mergeAndCommit,
    lastEventId: projection.lastEventId,
    lastUpdatedAt: projection.lastUpdatedAt,
    completedActionCount: projection.completedActionIds.length,
    recentCompletedActionIds: projection.completedActionIds.slice(-StateChartToolDefaults.RECENT_COMPLETED_ACTIONS),
    checkedItemCount: Object.keys(projection.checkedItems).length,
    addedChecklistItemCount: projection.addedChecklistItems.length,
    checkpointCount: projection.checkpoints.length,
    recentCheckpoints: projection.checkpoints.slice(-StateChartToolDefaults.RECENT_CHECKPOINTS).map(checkpoint => ({
      actionId: checkpoint.actionId,
      summary: compactStateChartText(checkpoint.summary),
      evidence: compactStateChartText(checkpoint.evidence),
      timestamp: checkpoint.timestamp,
      sessionId: checkpoint.sessionId
    })),
    transitionCount: projection.transitions.length,
    recentTransitions: projection.transitions.slice(-StateChartToolDefaults.RECENT_TRANSITIONS).map(transition => ({
      eventId: transition.eventId,
      sessionId: transition.sessionId,
      timestamp: transition.timestamp,
      fromState: transition.fromState,
      toState: transition.toState,
      transitionEvent: transition.transitionEvent,
      actionId: transition.actionId,
      summary: compactStateChartText(transition.summary),
      evidence: compactStateChartText(transition.evidence)
    }))
  };
}

function boundedDetailedStateChartProjection(projection: BeadStateChartProjection): Record<string, unknown> {
  const completedActionIdsSource = projection.completedActionIds || [];
  const checkedItemsSource = projection.checkedItems || {};
  const addedChecklistItemsSource = projection.addedChecklistItems || [];
  const handoversSource = projection.handovers || {};
  const checkpointsSource = projection.checkpoints || [];
  const transitionsSource = projection.transitions || [];
  const reviewArtifactsSource = projection.reviewArtifacts || [];
  const completedActionIds = completedActionIdsSource.slice(-StateChartToolDefaults.DETAIL_COMPLETED_ACTIONS);
  const checkedItems = compactChecklistEntries(checkedItemsSource, StateChartToolDefaults.DETAIL_CHECKED_ITEMS);
  const addedChecklistItems = addedChecklistItemsSource
    .slice(-StateChartToolDefaults.DETAIL_ADDED_CHECKLIST_ITEMS)
    .map(item => compactAddedChecklistItem(item));
  const handovers = compactHandovers(handoversSource, StateChartToolDefaults.DETAIL_HANDOVERS);
  const checkpoints = checkpointsSource.slice(-StateChartToolDefaults.DETAIL_CHECKPOINTS).map(checkpoint => ({
    ...checkpoint,
    summary: compactStateChartText(checkpoint.summary, StateChartToolDefaults.DETAIL_TEXT_PREVIEW_CHARS),
    evidence: compactStateChartText(checkpoint.evidence, StateChartToolDefaults.DETAIL_TEXT_PREVIEW_CHARS)
  }));
  const transitions = transitionsSource.slice(-StateChartToolDefaults.DETAIL_TRANSITIONS).map(transition => ({
    ...transition,
    summary: compactStateChartText(transition.summary, StateChartToolDefaults.DETAIL_TEXT_PREVIEW_CHARS),
    evidence: compactStateChartText(transition.evidence, StateChartToolDefaults.DETAIL_TEXT_PREVIEW_CHARS)
  }));
  const reviewArtifacts = reviewArtifactsSource
    .slice(-StateChartToolDefaults.DETAIL_REVIEW_ARTIFACTS)
    .map(artifact => ({
      ...artifact,
      summary: compactStateChartText(artifact.summary, StateChartToolDefaults.DETAIL_TEXT_PREVIEW_CHARS)
    }));
  const compact: Record<string, unknown> = compactStateChartProjection(projection);
  delete compact.recentCompletedActionIds;
  delete compact.recentHandovers;
  delete compact.recentCheckpoints;
  delete compact.recentTransitions;

  return {
    ...compact,
    detailIncluded: true,
    completedActionCount: completedActionIdsSource.length,
    completedActionIds,
    completedActionIdsTruncated: completedActionIds.length < completedActionIdsSource.length,
    handoverCount: Object.keys(handoversSource).length,
    handovers,
    handoversTruncated: Object.keys(handovers).length < Object.keys(handoversSource).length,
    checkedItemCount: Object.keys(checkedItemsSource).length,
    checkedItems,
    checkedItemsTruncated: Object.keys(checkedItems).length < Object.keys(checkedItemsSource).length,
    addedChecklistItemCount: addedChecklistItemsSource.length,
    addedChecklistItems,
    addedChecklistItemsTruncated: addedChecklistItems.length < addedChecklistItemsSource.length,
    checkpointCount: checkpointsSource.length,
    checkpoints,
    checkpointsTruncated: checkpoints.length < checkpointsSource.length,
    transitionCount: transitionsSource.length,
    transitions,
    transitionsTruncated: transitions.length < transitionsSource.length,
    reviewArtifactCount: reviewArtifactsSource.length,
    reviewArtifacts,
    reviewArtifactsTruncated: reviewArtifacts.length < reviewArtifactsSource.length
  };
}

async function normalizeIssue(
  eventStore: EventStore,
  issue: BeadsIssueRecord,
  includeDetails = false,
  includeProjection = true
): Promise<Bead> {
  const projectedMetadata = includeProjection ? await eventStore.projectBead(issue.id, { includeDetails }) : {};
  return normalizeIssueWithProjection(issue, projectedMetadata, includeDetails);
}

async function normalizeIssues(
  eventStore: EventStore,
  issues: BeadsIssueRecord[],
  includeDetails = false,
  includeProjection = true
): Promise<Bead[]> {
  if (!includeProjection) return issues.map(issue => normalizeIssueWithProjection(issue, {}, includeDetails));
  const projections = await eventStore.projectBeads(issues.map(issue => issue.id), { includeDetails });
  return issues.map(issue => normalizeIssueWithProjection(issue, projections.get(issue.id) || {}, includeDetails));
}

async function getIssue(eventStore: EventStore, id: string): Promise<BeadsIssueRecord> {
  const result = await runBd(eventStore, ['show', id, '--long']);
  const issue = Array.isArray(result) ? result[0] : result;
  if (!issue?.id) throw new Error(`Bead ${id} not found`);
  return issue as BeadsIssueRecord;
}

async function updateIssueStatus(eventStore: EventStore, id: string, status?: BeadStatus, notes?: string): Promise<Bead | null> {
  Logger.info(Component.BEADS_CLI, 'Updating issue status', { id, status, notes });
  if (status === BeadStatus.COMPLETED) {
    const args = ['close', id];
    if (notes) args.push('--reason', notes);
    await runBd(eventStore, args);
    await eventStore.record(DomainEventName.BEAD_CLOSED, { beadId: id, status, notes });
    return normalizeIssue(eventStore, await getIssue(eventStore, id));
  }

  const args = ['update', id];
  if (status === BeadStatus.BLOCKED || status === BeadStatus.DEFERRED) {
    args.push('--status', status);
  } else {
    args.push('--status', BeadsIssueStatus.OPEN);
  }
  if (notes) args.push('--append-notes', notes);
  await runBd(eventStore, args);
  await eventStore.record(DomainEventName.BEAD_STATUS_UPDATED, { beadId: id, status, notes });
  return normalizeIssue(eventStore, await getIssue(eventStore, id));
}

export function createBdPlugin(eventStore: EventStore) {
  return {
  name: 'beads-orchestration',
  tools: [
    {
      name: PluginToolName.BD_READY,
      description: 'Read unblocked work from Beads via `bd ready --json`.',
      parameters: Type.Object({
        limit: Type.Optional(Type.Number({ description: `Maximum ready Beads to inspect. Defaults to ${BeadsDefaults.READY_DEFAULT_LIMIT}.` }))
      }),
      execute: async ({ limit }: { limit?: number } = {}, ctx?: any) => {
        if (ctx?.hasUI) ctx.ui.setWorkingMessage('Fetching ready Beads...');
        const safeLimit = safePositiveInteger(limit, BeadsDefaults.READY_DEFAULT_LIMIT);
        const readyOutput = await runBd(eventStore, ['ready', '--limit', String(safeLimit), '--plain'], { json: false });
        const readyLookups = parseReadyPlainOutput(readyOutput);
        const beads = await normalizeIssues(eventStore, readyLookups, false);
        if (ctx?.hasUI) ctx.ui.setWorkingMessage(undefined);
        return beads;
      }
    },
    {
      name: PluginToolName.BD_LIST,
      description: 'List Beads via `bd list`. Returns compact records by default; use status for native Beads statuses and stateId for Orr Else statechart states.',
      parameters: Type.Object({
        status: Type.Optional(Type.String({ description: 'Optional native Beads status filter: open, in_progress, blocked, deferred, closed, or done. Statechart states are treated as stateId for compatibility.' })),
        stateId: Type.Optional(Type.String({ description: 'Optional Orr Else statechart state filter, for example RequirementsAnalysis or Planning.' })),
        limit: Type.Optional(Type.Number({ description: `Maximum compact records to return. Defaults to ${BeadsDefaults.LIST_DEFAULT_LIMIT}.` })),
        includeProjection: Type.Optional(Type.Boolean({ description: 'Include Orr Else event-store projection metadata in native status records.' })),
        includeNotesPreview: Type.Optional(Type.Boolean({ description: 'Include a short notes preview. Full notes require bd_get_bead.' }))
      }),
      execute: async ({ status, stateId, limit, includeProjection, includeNotesPreview }: { status?: string; stateId?: string; limit?: number; includeProjection?: boolean; includeNotesPreview?: boolean } = {}) => {
        const safeLimit = safePositiveInteger(limit, BeadsDefaults.LIST_DEFAULT_LIMIT);
        const beadsStatus = isBeadsIssueStatus(status) ? status : undefined;
        const stateFilter = stateId || (status && !beadsStatus ? status : undefined);
        const cliLimit = stateFilter ? safeLimit * BeadsDefaults.READY_SCAN_MULTIPLIER : safeLimit;
        const args = ['list', '--limit', String(cliLimit), '--flat', '--no-pager'];
        if (beadsStatus) args.push('--status', beadsStatus);
        const issues = parseFlatListOutput(await runBd(eventStore, args, { json: false }), beadsStatus);
        const needsProjection = includeProjection === true || Boolean(stateFilter);
        const beads = await normalizeIssues(eventStore, issues, false, needsProjection);
        const filtered = stateFilter ? beads.filter(bead => bead.status === stateFilter) : beads;
        return {
          total: filtered.length,
          returned: Math.min(filtered.length, safeLimit),
          truncated: issues.length >= cliLimit || filtered.length > safeLimit,
          filters: {
            status: beadsStatus,
            stateId: stateFilter
          },
          items: filtered.slice(0, safeLimit).map(bead => ({
            id: bead.id,
            title: bead.title,
            status: bead.status,
            priority: bead.priority,
            assigned_to: bead.assigned_to,
            dependencies: bead.dependencies,
            lastActivity: bead.lastActivity,
            retryCount: bead.retryCount,
            compactionCount: bead.compactionCount,
            totalExecutionTimeMs: bead.totalExecutionTimeMs,
            restartRequested: bead.restartRequested,
            restartKind: bead.restartKind,
            restartEvent: bead.restartEvent,
            restartFromState: bead.restartFromState,
            restartTargetState: bead.restartTargetState,
            lease: bead.lease,
            leaseSessionId: bead.leaseSessionId,
            notesPreview: includeNotesPreview ? previewText(bead.notes) : undefined
          }))
        };
      }
    },
    {
      name: PluginToolName.BD_EXPORT_JSONL,
      description: 'Export Beads records using `bd export` JSONL format.',
      parameters: Type.Object({
        outputPath: Type.Optional(Type.String({ description: 'Optional file path to write JSONL to. If omitted, JSONL is returned as text.' })),
        all: Type.Optional(Type.Boolean({ description: 'Include all records, including infrastructure/templates/gates/memories.' })),
        includeInfra: Type.Optional(Type.Boolean({ description: 'Include infrastructure records.' })),
        includeMemories: Type.Optional(Type.Boolean({ description: 'Include persistent memories.' })),
        scrub: Type.Optional(Type.Boolean({ description: 'Exclude test/pollution records.' }))
      }),
      execute: async ({ outputPath, all, includeInfra, includeMemories, scrub }: any) => {
        const args = ['export'];
        if (outputPath) args.push('--output', outputPath);
        if (all) args.push('--all');
        if (includeInfra) args.push('--include-infra');
        if (includeMemories) args.push('--include-memories');
        if (scrub) args.push('--scrub');

        const output = await runBd(eventStore, args, { json: false });
        return outputPath
          ? { outputPath, message: output || `Exported Beads JSONL to ${outputPath}.` }
          : output.length > BeadsDefaults.INLINE_JSONL_EXPORT_PREVIEW_BYTES
            ? {
              message: `Beads export is ${output.length} bytes, which is too large to return inline. Re-run bd_export_jsonl with outputPath, or use bd_get_bead/bd_list for targeted reads.`,
              bytes: output.length,
              preview: output.slice(0, BeadsDefaults.INLINE_JSONL_EXPORT_PREVIEW_BYTES)
            }
          : output;
      }
    },
    {
      name: PluginToolName.BD_IMPORT_JSONL,
      description: 'Import Beads records using `bd import` JSONL upsert semantics.',
      parameters: Type.Object({
        inputPath: Type.Optional(Type.String({ description: 'Optional JSONL file path. Use jsonl for stdin import instead.' })),
        jsonl: Type.Optional(Type.String({ description: 'Optional newline-delimited JSON content to import via stdin.' })),
        dryRun: Type.Optional(Type.Boolean({ description: 'Show what would be imported without writing.' })),
        dedup: Type.Optional(Type.Boolean({ description: 'Skip lines whose title matches an existing open issue.' }))
      }),
      execute: async ({ inputPath, jsonl, dryRun, dedup }: any) => {
        if (inputPath && jsonl) {
          throw new Error('Provide either inputPath or jsonl, not both.');
        }

        const args = ['import'];
        if (inputPath) args.push(inputPath);
        if (jsonl) args.push('-');
        if (dryRun) args.push('--dry-run');
        if (dedup) args.push('--dedup');

        return await runBd(eventStore, args, { input: jsonl });
      }
    },
    {
      name: PluginToolName.BD_CREATE,
      description: 'Create a Bead via `bd create`.',
      parameters: Type.Object({
        title: Type.String({ description: 'Title for the Bead' }),
        description: Type.Optional(Type.String({ description: 'Description' })),
        notes: Type.Optional(Type.String({ description: 'Notes' })),
        id: Type.Optional(Type.String({ description: 'Explicit Bead ID' })),
        type: Type.Optional(Type.String({ description: 'Issue type' })),
        priority: Type.Optional(Type.String({ description: 'Priority 0-4 or P0-P4' }))
      }),
      execute: async ({ id, title, description, notes, type, priority }: any) => {
        const args = ['create', title];
        if (id) args.push('--id', id);
        if (description) args.push('--description', description);
        if (notes) args.push('--notes', notes);
        if (type) args.push('--type', type);
        if (priority) args.push('--priority', priority);
        const bead = await normalizeIssue(eventStore, await runBd(eventStore, args));
        await eventStore.record(DomainEventName.BEAD_CREATED, {
          beadId: bead.id,
          title,
          type,
          priority
        });
        return bead;
      }
    },
    {
      name: PluginToolName.BD_GET_BEAD,
      description: 'Retrieve the task-facing Bead record by ID via `bd show --long --json`. Uses a fast native Beads view by default; pass includeDetails=true or use bd_get_state_chart for event-store checklist, handover, action, and transition details.',
      parameters: Type.Object({
        id: Type.String({ description: 'The ID of the Bead' }),
        includeDetails: Type.Optional(Type.Boolean({ description: 'Include derived event-store details. Default false; prefer bd_get_state_chart for targeted statechart details.' }))
      }),
      execute: async ({ id, includeDetails }: { id: string; includeDetails?: boolean }) => normalizeIssue(eventStore, await getIssue(eventStore, id), includeDetails === true, includeDetails === true)
    },
    {
      name: PluginToolName.BD_GET_STATE_CHART,
      description: 'Replay the event store and return the current statechart projection for a Bead. Compact output is returned by default; includeDetails returns bounded recent details with counts and truncation flags.',
      parameters: Type.Object({
        id: Type.String({ description: 'The ID of the Bead' }),
        includeDetails: Type.Optional(Type.Boolean({ description: 'Return bounded checklist, checkpoint, action, and transition details. Default false to protect context budget.' }))
      }),
      execute: async ({ id, includeDetails }: { id: string; includeDetails?: boolean }) => {
        const projection = await eventStore.projectBeadStateChart(id);
        return includeDetails ? boundedDetailedStateChartProjection(projection) : compactStateChartProjection(projection);
      }
    },
    {
      name: PluginToolName.BD_CLAIM,
      description: 'Atomically claim a Bead via `bd update --claim`.',
      parameters: Type.Object({
	        id: Type.String({ description: 'The ID of the Bead' }),
	        owner: Type.Optional(Type.String({ description: 'Claiming actor' })),
	        stateId: Type.Optional(Type.String({ description: 'Statechart state selected by the orchestrator' })),
	        leaseTtlMs: Type.Optional(Type.Number({ description: 'Lease TTL in milliseconds' }))
	      }),
	      execute: async ({ id, owner, stateId, leaseTtlMs }: { id: string, owner?: string, stateId?: string, leaseTtlMs?: number }, ctx?: any) => {
	        if (ctx?.hasUI) ctx.ui.setWorkingMessage(`Claiming Bead ${id}...`);
	        let bead: Bead;
	        let restartRequested = false;
        try {
          const claimed = await runBd(eventStore, ['update', id, '--claim'], { logErrors: false });
          bead = await normalizeIssue(eventStore, Array.isArray(claimed) ? claimed[0] : claimed);
          restartRequested = bead.restartRequested || false;
        } catch (error) {
          let issue: BeadsIssueRecord;
          try {
            issue = await getIssue(eventStore, id);
          } catch {
            if (ctx?.hasUI) ctx.ui.setWorkingMessage(undefined);
            throw error;
          }
	          if (issue.status !== BeadsIssueStatus.IN_PROGRESS) {
            if (ctx?.hasUI) ctx.ui.setWorkingMessage(undefined);
            throw error;
	          }
	          bead = await normalizeIssue(eventStore, issue);
	          restartRequested = bead.restartRequested || false;
	        }

	        const selectedStateId = stateId || bead.status;
	        const lease = {
	          owner: owner || bead.assigned_to || App.DISPLAY_NAME,
	          expiresAt: new Date(Date.now() + (leaseTtlMs || Defaults.LEASE_TTL_MS)).toISOString()
	        };
	
	        await eventStore.record(DomainEventName.BEAD_CLAIMED, {
	          beadId: id,
	          owner: owner || bead.assigned_to,
	          stateId: selectedStateId,
	          lease,
	          restartRequested,
	          restartKind: restartRequested ? bead.restartKind : undefined,
	          restartEvent: restartRequested ? bead.restartEvent : undefined,
	          restartFromState: restartRequested ? bead.restartFromState : undefined,
	          restartTargetState: restartRequested ? bead.restartTargetState : undefined
	        });
	        const result = await normalizeIssue(eventStore, await getIssue(eventStore, id));
        
        if (ctx?.hasUI) {
          ctx.ui.notify(`Claimed Bead ${id}`, 'info');
          ctx.ui.setWorkingMessage(undefined);
        }
        return result;
      }
    },
    {
      name: PluginToolName.BD_RELEASE,
      description: 'Release harness lease metadata and reopen an in-progress Bead if needed.',
      parameters: Type.Object({
        id: Type.String({ description: 'The ID of the Bead' })
      }),
      execute: async ({ id }: { id: string }) => {
        let issue: BeadsIssueRecord | undefined;
        try {
          issue = await getIssue(eventStore, id);
        } catch {
          // Bead no longer exists in the task store (deleted/purged). Record a
          // tombstone so slot-health pruning can clean up the tracked entry and
          // future projections exclude this ID from live/ready accounting.
          Logger.info(Component.BEADS_CLI, 'Bead not found during release; recording tombstone and releasing slot', { beadId: id });
          await eventStore.record(DomainEventName.BEAD_RELEASED, { beadId: id, tombstoned: true });
          await eventStore.record(DomainEventName.BEAD_TOMBSTONED, { beadId: id });
          return { id, tombstoned: true };
        }
        if (issue.status === BeadsIssueStatus.IN_PROGRESS) {
          await runBd(eventStore, ['update', id, '--status', BeadsIssueStatus.OPEN]);
        }
        await eventStore.record(DomainEventName.BEAD_RELEASED, { beadId: id });
        const result = await normalizeIssue(eventStore, await getIssue(eventStore, id));
        return result;
      }
    },
    {
      name: PluginToolName.BD_UPDATE_STATUS,
      description: 'Transition a Bead to a new status (e.g. ready, completed, blocked).',
      parameters: Type.Object({
        id: Type.String({ description: 'The ID of the Bead' }),
        status: Type.String({ description: 'Target BeadStatus' }),
        notes: Type.Optional(Type.String({ description: 'Transition notes' }))
      }),
      execute: async ({ id, status, notes }: { id: string, status: BeadStatus, notes?: string }) => updateIssueStatus(eventStore, id, status, notes)
    },
    {
      name: PluginToolName.BD_HEARTBEAT,
      description: 'Post a process heartbeat to the harness signaling API.',
      parameters: Type.Object({
        workerId: Type.String({ description: 'The worker identifier' }),
        beadId: Type.String({ description: 'The assigned Bead ID' }),
        stateId: Type.String({ description: 'The current state ID' }),
        pid: Type.Optional(Type.Number({ description: 'The teammate process ID' })),
        sessionStateId: Type.Optional(Type.String({ description: 'The current session state ID' }))
      }),
      execute: async (params: HarnessHeartbeatParams) => {
        const event = {
          type: TeammateEventType.HEARTBEAT,
          timestamp: Date.now(),
          workerId: params.workerId,
          beadId: params.beadId as BeadId,
          stateId: params.stateId,
          ...(params.pid !== undefined ? { pid: params.pid } : {}),
          ...(params.sessionStateId ? { sessionStateId: params.sessionStateId } : {})
        } satisfies Omit<HeartbeatEvent, 'idempotencyKey'>;
        const signal: HeartbeatEvent = {
          ...event,
          idempotencyKey: createTeammateEventIdempotencyKey(event)
        };
        return await postHarnessSignal(signal);
      }
    },
    {
      name: PluginToolName.BD_GET_HEARTBEATS,
      description: 'Get all active process heartbeats from the harness signaling API.',
      parameters: Type.Object({}),
      execute: async () => await getHarnessHeartbeats()
    }
  ]
};
}
