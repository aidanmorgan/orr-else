import * as path from 'path';
import { Type } from "@earendil-works/pi-ai";
import { v7 as uuidv7 } from 'uuid';
import { execa } from 'execa';
import { parse as parseShellCommand, quote as quoteShellArgs } from 'shell-quote';
import type { BeadId } from '../types/index.js';

import { getProjectRoot } from '../core/Paths.js';
import { ConfigLoader } from '../core/ConfigLoader.js';
import { Logger } from '../core/Logger.js';
import { Observability } from '../core/Observability.js';
import { EventStore } from '../core/EventStore.js';
import { resolvePiSkillPaths, resolveWorkerArgs, resolveWorkerExtensionPaths } from '../core/PiIntegration.js';
import {
  Component,
  EnvVars,
  Defaults,
  ThinkingLevel,
  PluginToolName,
  ProcessFlag,
  DomainEventName,
  OtelAttr,
  PiCliCommand,
  PiCliFlag,
  TmuxCommand,
  TmuxFormat,
  TmuxOption,
  TmuxOptionValue,
  TeammatePaneCleanupReason,
  WorktreeDefaults
} from '../constants/index.js';

const SAFE_REF = /^[A-Za-z0-9._-]+$/;

interface TmuxPane {
  paneId: string;
  paneTitle: string;
  currentCommand: string;
  startCommand: string;
  currentPath: string;
  dead: boolean;
}

async function tmux(args: string[]): Promise<string> {
  const result = await execa('tmux', args);
  return result.stdout;
}

function shellQuoteValue(value: string): string {
  return quoteShellArgs([value]);
}

function assertSafeBeadId(id: string) {
  if (!SAFE_REF.test(id)) throw new Error('Invalid Bead identifier format');
}

export class TeammateFactory {
  private lastLiveTeammatePanes: TmuxPane[] = [];
  private paneListFailed = false;
  private lastPaneListFailureMessage = '';

  constructor(
    private readonly observability: Observability,
    private readonly configLoader: ConfigLoader,
    private readonly eventStore: EventStore,
    private readonly maxSlots: number = Defaults.MAX_SLOTS,
    private readonly sessionName: string = Defaults.TMUX_SESSION,
    private readonly extensionPath?: string
  ) {}

  public async getActiveTeammateCount(): Promise<number> {
    return (await this.getLiveTeammatePanes()).length;
  }

  public async getLiveTeammateBeadIds(): Promise<Set<string>> {
    const panes = await this.getLiveTeammatePanes();
    return new Set(
      panes
        .map(pane => this.beadIdFromPane(pane))
        .filter((beadId): beadId is string => beadId !== undefined)
    );
  }

  private async getLiveTeammatePanes(): Promise<TmuxPane[]> {
    try {
      const panes = await this.listAgentPanes();
      await this.removeDeadTeammatePanes(panes);
      const livePanes = panes.filter(pane => !pane.dead && this.isTeammatePane(pane));
      this.lastLiveTeammatePanes = livePanes;
      this.paneListFailed = false;
      this.lastPaneListFailureMessage = '';
      return livePanes;
    } catch (error) {
      this.paneListFailed = true;
      const message = String(error);
      const fallbackPanes = this.lastLiveTeammatePanes.filter(pane => !pane.dead);
      await this.eventStore.record(DomainEventName.TEAMMATE_PANE_SCAN_FAILED, {
        sessionName: this.sessionName,
        error: message,
        fallbackPaneCount: fallbackPanes.length,
        failClosed: true
      }).catch(() => {});
      if (message !== this.lastPaneListFailureMessage) {
        this.lastPaneListFailureMessage = message;
        Logger.warn(Component.FACTORY, 'Unable to list Orr Else teammate panes; failing closed for slot allocation', {
          sessionName: this.sessionName,
          fallbackPaneCount: fallbackPanes.length,
          error: message
        });
      }
      return fallbackPanes;
    }
  }

  private async listAgentPanes(): Promise<TmuxPane[]> {
    const fields = [
      TmuxFormat.PANE_ID,
      TmuxFormat.PANE_TITLE,
      TmuxFormat.PANE_CURRENT_COMMAND,
      TmuxFormat.PANE_START_COMMAND,
      TmuxFormat.PANE_CURRENT_PATH,
      TmuxFormat.PANE_DEAD
    ].join(TmuxFormat.FIELD_SEPARATOR);
    const output = await tmux([TmuxCommand.LIST_PANES, '-t', `${this.sessionName}:${Defaults.TMUX_AGENTS_WINDOW}`, '-F', fields]);
    return output.trim().split('\n').filter(Boolean).map(line => {
      const parts = line.split(TmuxFormat.FIELD_SEPARATOR);
      const [paneId = '', paneTitle = '', currentCommand = '', startCommand = ''] = parts;
      const currentPath = parts.length >= 6 ? parts[4] || '' : '';
      const dead = parts.length >= 6 ? parts[5] || '0' : parts[4] || '0';
      return {
        paneId,
        paneTitle,
        currentCommand,
        startCommand,
        currentPath,
        dead: dead === '1'
      };
    });
  }

  private isTeammatePane(pane: TmuxPane): boolean {
    return pane.paneTitle.startsWith(Defaults.AGENT_PANE_PREFIX) ||
      pane.startCommand.includes(`${EnvVars.WORKER_MODE}=`) ||
      this.beadIdFromCurrentPath(pane.currentPath) !== undefined;
  }

  private async removeDeadTeammatePanes(panes: TmuxPane[]): Promise<void> {
    const deadPanes = panes.filter(pane => pane.dead && this.isTeammatePane(pane));
    if (deadPanes.length === 0) return;

    const removedPaneIds: string[] = [];
    const beadIds = new Set<string>();

    for (const pane of deadPanes) {
      const beadId = this.beadIdFromPane(pane);
      if (beadId) beadIds.add(beadId);
      try {
        await tmux([TmuxCommand.KILL_PANE, '-t', pane.paneId]);
        removedPaneIds.push(pane.paneId);
      } catch (error) {
        Logger.warn(Component.FACTORY, 'Unable to remove dead Orr Else teammate pane', {
          paneId: pane.paneId,
          beadId,
          error: String(error)
        });
      }
    }

    if (removedPaneIds.length === 0) return;
    await this.eventStore.record(DomainEventName.TEAMMATE_DEAD_PANES_REMOVED, {
      reason: TeammatePaneCleanupReason.DEAD_TMUX_PANE,
      paneIds: removedPaneIds,
      beadIds: [...beadIds].sort()
    }).catch(() => {});
    Logger.warn(Component.FACTORY, 'Removed dead Orr Else teammate panes', {
      reason: TeammatePaneCleanupReason.DEAD_TMUX_PANE,
      paneIds: removedPaneIds,
      beadIds: [...beadIds].sort()
    });
  }

  private beadIdFromPane(pane: TmuxPane): string | undefined {
    if (pane.paneTitle.startsWith(Defaults.AGENT_PANE_PREFIX)) {
      return pane.paneTitle.slice(Defaults.AGENT_PANE_PREFIX.length) || undefined;
    }
    return this.envValueFromStartCommand(pane.startCommand, EnvVars.BEAD_ID) ||
      this.beadIdFromCurrentPath(pane.currentPath);
  }

  private beadIdFromCurrentPath(currentPath: string): string | undefined {
    if (!currentPath) return undefined;
    const projectRoot = process.env[EnvVars.PROJECT_ROOT] || getProjectRoot() || process.cwd();
    const worktreesRoot = path.resolve(projectRoot, WorktreeDefaults.ROOT_DIR);
    const absoluteCurrentPath = path.resolve(currentPath);
    const relativePath = path.relative(worktreesRoot, absoluteCurrentPath);
    if (relativePath === '' || relativePath.startsWith('..') || path.isAbsolute(relativePath)) return undefined;
    const [beadId] = relativePath.split(path.sep);
    if (!beadId || !SAFE_REF.test(beadId)) return undefined;
    return beadId;
  }

  private envValueFromStartCommand(command: string, key: string): string | undefined {
    const assignment = this.shellWords(command)
      .filter((part): part is string => typeof part === 'string')
      .find(part => part.startsWith(`${key}=`));
    return assignment?.slice(key.length + 1) || undefined;
  }

  private shellWords(command: string): unknown[] {
    const parsed = parseShellCommand(command);
    if (parsed.length === 1 && typeof parsed[0] === 'string' && parsed[0].includes(' ')) {
      return parseShellCommand(parsed[0]);
    }
    return parsed;
  }

  public async getAvailableSlots(): Promise<number> {
    const active = await this.getActiveTeammateCount();
    if (this.paneListFailed) return 0;
    return Math.max(0, this.maxSlots - active);
  }

  public async ensureAgentsWindow() {
    try {
      await tmux([TmuxCommand.HAS_SESSION, '-t', this.sessionName]);
    } catch {
      await tmux([TmuxCommand.NEW_SESSION, '-d', '-s', this.sessionName, '-n', Defaults.TMUX_COORDINATOR_WINDOW]);
    }

    try {
      const windows = (await tmux([TmuxCommand.LIST_WINDOWS, '-t', this.sessionName, '-F', '#{window_name}'])).trim().split('\n');
      if (!windows.includes(Defaults.TMUX_AGENTS_WINDOW)) {
        await tmux([TmuxCommand.NEW_WINDOW, '-t', this.sessionName, '-n', Defaults.TMUX_AGENTS_WINDOW]);
      }
      await tmux([
        TmuxCommand.SET_WINDOW_OPTION,
        '-t',
        `${this.sessionName}:${Defaults.TMUX_AGENTS_WINDOW}`,
        TmuxOption.REMAIN_ON_EXIT,
        TmuxOptionValue.OFF
      ]);
    } catch (error) {
      // Session might not exist yet if just created
      Logger.warn(Component.FACTORY, 'Failed to configure agents window in tmux session', { sessionName: this.sessionName, error: String(error) });
    }
  }

  public async spawnTeammateInTmux(beadId: BeadId, stateId: string, worktreePath: string, ctx?: any): Promise<{ success: boolean; paneId?: string; error?: string }> {
    return this.observability.tracedAsync('spawn_teammate', {
      [OtelAttr.AGENT_BEAD_ID]: beadId,
      [OtelAttr.AGENT_STATE_ID]: stateId
    }, async () => this.spawnTeammateInTmuxInner(beadId, stateId, worktreePath, ctx))();
  }

  private async spawnTeammateInTmuxInner(beadId: BeadId, stateId: string, worktreePath: string, ctx?: any): Promise<{ success: boolean; paneId?: string; error?: string }> {
    try {
      assertSafeBeadId(beadId);
      if (!worktreePath) {
        return { success: false, error: 'A mandatory worktreePath is required for every Orr Else teammate.' };
      }
      await this.ensureAgentsWindow();

      const slots = await this.getAvailableSlots();
      if (slots <= 0) {
        return { success: false, error: 'No available Orr Else teammate slots.' };
      }

      if (ctx?.hasUI) ctx.ui.setWorkingMessage(`Spawning teammate for ${beadId}...`);

      const projectRoot = process.env[EnvVars.PROJECT_ROOT] || getProjectRoot() || process.cwd();
      const runDir = worktreePath;
      const extensionPath = this.extensionPath || path.join(projectRoot, Defaults.PROJECT_EXTENSION_PATH);
      const config = await this.configLoader.load();
      const llm = this.configLoader.resolveLLMConfig(stateId, config);
      const workerExtensions = resolveWorkerExtensionPaths(config, projectRoot, extensionPath);
      const skillPaths = resolvePiSkillPaths(config, projectRoot);
      const configPath = this.configLoader.getConfigPath();
      const workerArgs = resolveWorkerArgs(config, { configPath, projectRoot, worktreePath });
      const apiPort = process.env[EnvVars.API_PORT] || Defaults.API_PORT;
      const apiBase = process.env[EnvVars.API_BASE] || `http://${Defaults.API_HOST}:${apiPort}`;
      const sessionStateId = uuidv7();
      const workerId = `worker-${beadId}-${stateId}-${Date.now()}-${process.pid}`.replace(/[^A-Za-z0-9._:-]/g, '-');

      const traceContext = this.observability.getTraceContext();

      const env = [
        [EnvVars.WORKER_MODE, ProcessFlag.TRUE],
        [EnvVars.PROJECT_ROOT, projectRoot],
        [EnvVars.BEAD_ID, beadId],
        [EnvVars.STATE_ID, stateId],
        [EnvVars.WORKER_ID, workerId],
        [EnvVars.SESSION_STATE_ID, sessionStateId],
        [EnvVars.WORKTREE_PATH, worktreePath],
        [EnvVars.LLM_PROVIDER_KEY, llm.providerKey],
        [EnvVars.LLM_PROVIDER, llm.provider],
        [EnvVars.LLM_MODEL, llm.model],
        [EnvVars.LLM_THINKING, llm.thinking || ''],
        [EnvVars.MAX_OUTPUT_TOKENS, process.env[EnvVars.MAX_OUTPUT_TOKENS] || ''],
        [EnvVars.CONFIG_PATH, configPath],
        [EnvVars.API_PORT, apiPort],
        [EnvVars.API_BASE, apiBase],
        [EnvVars.TRACE_ID, traceContext?.traceId || ''],
        [EnvVars.SPAN_ID, traceContext?.spanId || ''],
        // Opt the worker into Anthropic's 1-hour prompt-cache TTL. Inter-role
        // handoffs routinely exceed the 5-minute default; 1h writes are 2×
        // base input but pay back from the first cache read (~0.1× base).
        [EnvVars.ENABLE_PROMPT_CACHING_1H, ProcessFlag.TRUE]
      ].map(([key, value]) => `${key}=${shellQuoteValue(value)}`);

      const args = [
        PiCliCommand.PI,
        PiCliFlag.NO_EXTENSIONS,
        ...workerExtensions.flatMap(workerExtension => [PiCliFlag.EXTENSION, workerExtension]),
        ...skillPaths.flatMap(skillPath => [PiCliFlag.SKILL, skillPath]),
        PiCliFlag.PROVIDER, llm.provider,
        PiCliFlag.MODEL, llm.model,
        PiCliFlag.THINKING, llm.thinking || ThinkingLevel.HIGH,
        PiCliFlag.NO_SESSION,
        ...workerArgs,
        `Orr Else teammate bootstrap for ${beadId}/${stateId}.`
      ];

      const command = `${env.join(' ')} ${quoteShellArgs(args)}`;
      Logger.info(Component.FACTORY, 'Spawning Orr Else teammate in tmux', {
        beadId,
        stateId,
        workerId,
        provider: llm.provider,
        model: llm.model,
        skillCount: skillPaths.length,
        workerExtensionCount: workerExtensions.length,
        workerArgsCount: workerArgs.length,
        runDir
      });
      await this.eventStore.record(DomainEventName.TEAMMATE_SPAWN_STARTED, {
        beadId,
        stateId,
        workerId,
        worktreePath,
        provider: llm.provider,
        model: llm.model,
        thinking: llm.thinking,
        skillPaths,
        workerExtensions,
        workerArgs
      });

      const paneId = (await tmux([TmuxCommand.SPLIT_WINDOW, '-P', '-F', '#{pane_id}', '-t', `${this.sessionName}:${Defaults.TMUX_AGENTS_WINDOW}`, '-c', runDir, command])).trim();
      if (paneId) {
        await tmux([TmuxCommand.SELECT_PANE, '-t', paneId, '-T', `${Defaults.AGENT_PANE_PREFIX}${beadId}`]);
      }
      await tmux([TmuxCommand.SELECT_LAYOUT, '-t', `${this.sessionName}:${Defaults.TMUX_AGENTS_WINDOW}`, 'tiled']);
      await this.eventStore.record(DomainEventName.TEAMMATE_SPAWNED, {
        beadId,
        stateId,
        workerId,
        worktreePath,
        paneId
      });

      if (ctx?.hasUI) {
        ctx.ui.notify(`Teammate spawned for ${beadId} (${stateId})`, 'info');
        ctx.ui.setWorkingMessage(undefined);
      }
      return { success: true, paneId };
    } catch (error) {
      await this.eventStore.record(DomainEventName.TEAMMATE_SPAWN_FAILED, {
        beadId,
        stateId,
        worktreePath,
        error: String(error)
      }).catch(() => {});
      Logger.error(Component.FACTORY, 'Failed to spawn Orr Else teammate', { beadId, stateId, error: String(error) });
      if (ctx?.hasUI) {
        ctx.ui.notify(`Failed to spawn teammate: ${String(error)}`, 'error');
        ctx.ui.setWorkingMessage(undefined);
      }
      return { success: false, error: String(error) };
    }
  }

  public async terminateTeammatesForBead(beadId: BeadId | string, reason: string): Promise<{ terminatedPaneIds: string[] }> {
    assertSafeBeadId(beadId);
    const panes = await this.getLiveTeammatePanes();
    const matchingPanes = panes.filter(pane => this.beadIdFromPane(pane) === beadId);
    const terminatedPaneIds: string[] = [];

    for (const pane of matchingPanes) {
      try {
        await tmux([TmuxCommand.KILL_PANE, '-t', pane.paneId]);
        terminatedPaneIds.push(pane.paneId);
      } catch (error) {
        Logger.warn(Component.FACTORY, 'Unable to kill Orr Else teammate pane', {
          paneId: pane.paneId,
          beadId,
          error: String(error)
        });
      }
    }

    await this.eventStore.record(DomainEventName.TEAMMATE_PROCESS_EXITED, {
      beadId,
      reason,
      terminatedPaneIds
    });
    Logger.warn(Component.FACTORY, 'Terminated inactive Orr Else teammate panes', {
      beadId,
      reason,
      terminatedPaneIds
    });
    return { terminatedPaneIds };
  }
}

export const teammatePlugin = (factory: TeammateFactory) => ({
  name: 'orr-else-teammates',
  tools: [
    {
      name: PluginToolName.SPAWN_TEAMMATE,
      description: 'Spawn an Orr Else teammate Pi process in a tmux pane.',
      parameters: Type.Object({
        beadId: Type.String({ description: 'The Bead ID to assign' }),
        stateId: Type.String({ description: 'The statechart state to execute' }),
        worktreePath: Type.String({ description: 'Mandatory dedicated worktree path for the teammate.' })
      }),
      execute: async ({ beadId, stateId, worktreePath }: { beadId: string; stateId: string; worktreePath: string }, ctx?: unknown) => await factory.spawnTeammateInTmux(beadId as BeadId, stateId, worktreePath, ctx)
    }
  ]
});
