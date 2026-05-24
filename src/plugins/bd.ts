import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { Type } from "@earendil-works/pi-ai";
import { Bead, BeadId, BeadsIssueRecord, HarnessBeadMetadata } from '../types/index.js';
import { getProjectRoot } from '../core/Paths.js';
import { Logger } from '../core/Logger.js';
import { EventStore } from '../core/EventStore.js';
import {
  ApiPath,
  BeadStatus,
  BeadsDefaults,
  BeadsIssueStatus,
  BeadsCliCommand,
  Component,
  DomainEventName,
  EnvVars,
  Defaults,
  HttpHeader,
  HttpMethod,
  MUTATING_BEADS_COMMANDS,
  TeammateEventType,
  PluginToolName,
  StateChartToolDefaults
} from '../constants/index.js';
import type { BeadStateChartProjection } from '../core/EventStore.js';

const execFileAsync = promisify(execFile);

const API_PORT = process.env[EnvVars.API_PORT] || Defaults.API_PORT;
const API_BASE = process.env[EnvVars.API_BASE] || `http://${Defaults.API_HOST}:${API_PORT}`;

function projectRoot(): string {
  return process.env[EnvVars.PROJECT_ROOT] || getProjectRoot() || process.cwd();
}

async function execBd(finalArgs: string[], options: { input?: string } = {}): Promise<{ stdout: string; stderr: string }> {
  if (options.input === undefined) {
    return await execFileAsync('bd', finalArgs, {
      encoding: 'utf8',
      maxBuffer: BeadsDefaults.MAX_BUFFER_BYTES
    });
  }

  return await new Promise((resolve, reject) => {
    const child = spawn('bd', finalArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(Object.assign(error, {
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8')
      }));
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > BeadsDefaults.MAX_BUFFER_BYTES) {
        fail(new Error('bd stdout exceeded maximum buffer'));
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > BeadsDefaults.MAX_BUFFER_BYTES) {
        fail(new Error('bd stderr exceeded maximum buffer'));
        return;
      }
      stderrChunks.push(chunk);
    });

    child.on('error', error => fail(error));
    child.on('close', code => {
      if (settled) return;
      settled = true;
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(Object.assign(new Error(`bd exited with code ${code}`), { stdout, stderr }));
    });

    child.stdin.end(options.input, 'utf8');
  });
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

async function apiRequest(path: string, method: string, body?: any) {
  Logger.debug(Component.BEADS_CLI, `API Request: ${method} ${path}`, { body });
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { [HttpHeader.CONTENT_TYPE]: HttpHeader.APPLICATION_JSON },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  if (!response.ok) {
    Logger.error(Component.BEADS_CLI, `API Request failed: ${response.status}`, { path, text });
    throw new Error(`API Error: ${response.status} ${text}`);
  }
  if (!text || response.status === 204) return null;
  return JSON.parse(text);
}

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function previewText(value: unknown, limit = BeadsDefaults.TEXT_PREVIEW_CHARS): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function compactStateChartText(value: unknown, limit = StateChartToolDefaults.TEXT_PREVIEW_CHARS): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function tailEntries<T>(record: Record<string, T>, limit: number): Record<string, T> {
  return Object.fromEntries(Object.entries(record).slice(-limit));
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

export function parseReadyPlainOutput(output: string): BeadsIssueRecord[] {
  const issues: BeadsIssueRecord[] = [];
  let current: BeadsIssueRecord | undefined;

  for (const line of output.split('\n')) {
    const issueMatch = line.match(/^\s*\d+\.\s+\[[^\]]+\]\s+\[([^\]]+)\]\s+([A-Za-z0-9_.-]+):\s+(.+)$/);
    if (issueMatch) {
      current = {
        id: issueMatch[2],
        title: stripRelationshipSuffix(issueMatch[3]),
        issue_type: issueMatch[1],
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
    const issueMatch = line.match(/^\S+\s+([A-Za-z0-9_.-]+)\s+\[[^\]]+\]\s+\[([^\]]+)\]\s+(.+)$/);
    if (!issueMatch) continue;
    const parsed = parseAssigneeAndTitle(issueMatch[3]);
    issues.push({
      id: issueMatch[1],
      title: parsed.title,
      issue_type: issueMatch[2],
      status: status || BeadsIssueStatus.OPEN,
      assignee: parsed.assignee
    });
  }
  return issues;
}

function statusFor(issue: BeadsIssueRecord, metadata: HarnessBeadMetadata): string {
  if (metadata.status) return metadata.status;
  switch (issue.status) {
    case BeadsIssueStatus.CLOSED:
    case BeadsIssueStatus.DONE:
      return BeadStatus.COMPLETED;
    case BeadsIssueStatus.BLOCKED:
      return BeadStatus.BLOCKED;
    case BeadsIssueStatus.DEFERRED:
      return BeadStatus.DEFERRED;
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
  return {
    id: issue.id as BeadId,
    title: issue.title,
    status: statusFor(issue, metadata),
    description: issue.description,
    notes: issue.notes,
    assigned_to: metadata.assigned_to || issue.assignee || issue.owner,
    worktree_path: metadata.worktree_path,
    changed_files: metadata.changed_files || [],
    logs: metadata.logs || [],
    dependencies: (issue.dependencies || []).map(d => d.depends_on_id as BeadId),
    checklists: includeDetails ? metadata.checklists : undefined,
    dynamicChecklists: includeDetails ? metadata.dynamicChecklists : undefined,
    retryCount: metadata.retryCount || 0,
    compactionCount: metadata.compactionCount || 0,
    lastActivity: metadata.lastActivity || issue.updated_at || issue.created_at || new Date().toISOString(),
    subState: metadata.subState,
    totalExecutionTimeMs: metadata.totalExecutionTimeMs || 0,
    handovers: includeDetails ? metadata.handovers || {} : {},
    completedActionIds: includeDetails ? metadata.completedActionIds || [] : [],
    restartRequested: metadata.restartRequested,
    restartKind: metadata.restartKind,
    restartEvent: metadata.restartEvent,
    restartFromState: metadata.restartFromState,
    restartTargetState: metadata.restartTargetState,
    lease: metadata.lease,
    leaseSessionId: metadata.leaseSessionId
  };
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
    handovers: projection.handovers,
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
  const completedActionIds = projection.completedActionIds.slice(-StateChartToolDefaults.DETAIL_COMPLETED_ACTIONS);
  const checkedItems = tailEntries(projection.checkedItems, StateChartToolDefaults.DETAIL_CHECKED_ITEMS);
  const addedChecklistItems = projection.addedChecklistItems.slice(-StateChartToolDefaults.DETAIL_ADDED_CHECKLIST_ITEMS);
  const checkpoints = projection.checkpoints.slice(-StateChartToolDefaults.DETAIL_CHECKPOINTS).map(checkpoint => ({
    ...checkpoint,
    summary: compactStateChartText(checkpoint.summary),
    evidence: compactStateChartText(checkpoint.evidence)
  }));
  const transitions = projection.transitions.slice(-StateChartToolDefaults.DETAIL_TRANSITIONS).map(transition => ({
    ...transition,
    summary: compactStateChartText(transition.summary),
    evidence: compactStateChartText(transition.evidence)
  }));

  return {
    ...projection,
    completedActionCount: projection.completedActionIds.length,
    completedActionIds,
    completedActionIdsTruncated: completedActionIds.length < projection.completedActionIds.length,
    checkedItemCount: Object.keys(projection.checkedItems).length,
    checkedItems,
    checkedItemsTruncated: Object.keys(checkedItems).length < Object.keys(projection.checkedItems).length,
    addedChecklistItemCount: projection.addedChecklistItems.length,
    addedChecklistItems,
    addedChecklistItemsTruncated: addedChecklistItems.length < projection.addedChecklistItems.length,
    checkpointCount: projection.checkpoints.length,
    checkpoints,
    checkpointsTruncated: checkpoints.length < projection.checkpoints.length,
    transitionCount: projection.transitions.length,
    transitions,
    transitionsTruncated: transitions.length < projection.transitions.length
  };
}

async function normalizeIssue(eventStore: EventStore, issue: BeadsIssueRecord): Promise<Bead> {
  const projectedMetadata = await eventStore.projectBead(issue.id);
  return normalizeIssueWithProjection(issue, projectedMetadata);
}

async function normalizeIssues(eventStore: EventStore, issues: BeadsIssueRecord[], includeDetails = true): Promise<Bead[]> {
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
        limit: Type.Number({ description: `Maximum ready Beads to inspect. Defaults to ${BeadsDefaults.READY_DEFAULT_LIMIT}.`, optional: true })
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
        status: Type.String({ description: 'Optional native Beads status filter: open, in_progress, blocked, deferred, closed, or done. Statechart states are treated as stateId for compatibility.', optional: true }),
        stateId: Type.String({ description: 'Optional Orr Else statechart state filter, for example RequirementsAnalysis or Planning.', optional: true }),
        limit: Type.Number({ description: `Maximum compact records to return. Defaults to ${BeadsDefaults.LIST_DEFAULT_LIMIT}.`, optional: true }),
        includeNotesPreview: Type.Boolean({ description: 'Include a short notes preview. Full notes require bd_get_bead.', optional: true })
      }),
      execute: async ({ status, stateId, limit, includeNotesPreview }: { status?: string; stateId?: string; limit?: number; includeNotesPreview?: boolean } = {}) => {
        const safeLimit = safePositiveInteger(limit, BeadsDefaults.LIST_DEFAULT_LIMIT);
        const beadsStatus = isBeadsIssueStatus(status) ? status : undefined;
        const stateFilter = stateId || (status && !beadsStatus ? status : undefined);
        const cliLimit = stateFilter ? safeLimit * BeadsDefaults.READY_SCAN_MULTIPLIER : safeLimit;
        const args = ['list', '--limit', String(cliLimit), '--flat', '--no-pager'];
        if (beadsStatus) args.push('--status', beadsStatus);
        const issues = parseFlatListOutput(await runBd(eventStore, args, { json: false }), beadsStatus);
        const beads = await normalizeIssues(eventStore, issues, false);
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
            assigned_to: bead.assigned_to,
            dependencies: bead.dependencies,
            lastActivity: bead.lastActivity,
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
        outputPath: Type.String({ description: 'Optional file path to write JSONL to. If omitted, JSONL is returned as text.', optional: true }),
        all: Type.Boolean({ description: 'Include all records, including infrastructure/templates/gates/memories.', optional: true }),
        includeInfra: Type.Boolean({ description: 'Include infrastructure records.', optional: true }),
        includeMemories: Type.Boolean({ description: 'Include persistent memories.', optional: true }),
        scrub: Type.Boolean({ description: 'Exclude test/pollution records.', optional: true })
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
        inputPath: Type.String({ description: 'Optional JSONL file path. Use jsonl for stdin import instead.', optional: true }),
        jsonl: Type.String({ description: 'Optional newline-delimited JSON content to import via stdin.', optional: true }),
        dryRun: Type.Boolean({ description: 'Show what would be imported without writing.', optional: true }),
        dedup: Type.Boolean({ description: 'Skip lines whose title matches an existing open issue.', optional: true })
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
        description: Type.String({ description: 'Description', optional: true }),
        notes: Type.String({ description: 'Notes', optional: true }),
        id: Type.String({ description: 'Explicit Bead ID', optional: true }),
        type: Type.String({ description: 'Issue type', optional: true }),
        priority: Type.String({ description: 'Priority 0-4 or P0-P4', optional: true })
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
      description: 'Retrieve a Bead by ID via `bd show --long --json`.',
      parameters: Type.Object({
        id: Type.String({ description: 'The ID of the Bead' })
      }),
      execute: async ({ id }: { id: string }) => normalizeIssue(eventStore, await getIssue(eventStore, id))
    },
    {
      name: PluginToolName.BD_GET_STATE_CHART,
      description: 'Replay the event store and return the current statechart projection for a Bead. Compact output is returned by default; includeDetails returns bounded recent details with counts and truncation flags.',
      parameters: Type.Object({
        id: Type.String({ description: 'The ID of the Bead' }),
        includeDetails: Type.Boolean({ description: 'Return bounded checklist, checkpoint, action, and transition details. Default false to protect context budget.', optional: true })
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
	        owner: Type.String({ description: 'Claiming actor', optional: true }),
	        stateId: Type.String({ description: 'Statechart state selected by the orchestrator', optional: true }),
	        leaseTtlMs: Type.Number({ description: 'Lease TTL in milliseconds', optional: true })
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
	          owner: owner || bead.assigned_to || 'agent',
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
        const issue = await getIssue(eventStore, id);
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
        notes: Type.String({ description: 'Transition notes', optional: true })
      }),
      execute: async ({ id, status, notes }: { id: string, status: BeadStatus, notes?: string }) => updateIssueStatus(eventStore, id, status, notes)
    },
    {
      name: PluginToolName.BD_HEARTBEAT,
      description: 'Post a process heartbeat to the harness signaling API.',
      parameters: Type.Object({
        workerId: Type.String({ description: 'The worker identifier' }),
        beadId: Type.String({ description: 'The assigned Bead ID' }),
        stateId: Type.String({ description: 'The current state ID' })
      }),
      execute: async (params: any) => await apiRequest(ApiPath.SIGNAL, HttpMethod.POST, { type: TeammateEventType.HEARTBEAT, timestamp: Date.now(), idempotencyKey: `hb-${params.workerId}-${Date.now()}`, ...params })
    },
    {
      name: PluginToolName.BD_GET_HEARTBEATS,
      description: 'Get all active process heartbeats from the harness signaling API.',
      parameters: Type.Object({}),
      execute: async () => await apiRequest(ApiPath.HEARTBEATS, HttpMethod.GET)
    }
  ]
};
}
