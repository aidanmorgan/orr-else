import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import { Type } from "@earendil-works/pi-ai";
import { v7 as uuidv7 } from 'uuid';
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
  PiCliCommand,
  PiCliFlag,
  TmuxCommand,
  TmuxFormat,
  TmuxOption,
  TmuxOptionValue
} from '../constants/index.js';

const execFileAsync = promisify(execFile);

const SAFE_REF = /^[A-Za-z0-9._-]+$/;

interface TmuxPane {
  paneId: string;
  paneTitle: string;
  currentCommand: string;
  startCommand: string;
  dead: boolean;
}

async function tmux(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('tmux', args, { encoding: 'utf8' });
  return stdout;
}

function shellQuote(s: string): string {
  if (!s) return "''";
  if (!/[^A-Za-z0-9_/:=-]/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function assertSafeBeadId(id: string) {
  if (!SAFE_REF.test(id)) throw new Error('Invalid Bead identifier format');
}

export class TeammateFactory {
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
      return (await this.listAgentPanes()).filter(pane => !pane.dead && this.isTeammatePane(pane));
    } catch {
      return [];
    }
  }

  private async listAgentPanes(): Promise<TmuxPane[]> {
    const fields = [
      TmuxFormat.PANE_ID,
      TmuxFormat.PANE_TITLE,
      TmuxFormat.PANE_CURRENT_COMMAND,
      TmuxFormat.PANE_START_COMMAND,
      TmuxFormat.PANE_DEAD
    ].join(TmuxFormat.FIELD_SEPARATOR);
    const output = await tmux([TmuxCommand.LIST_PANES, '-t', `${this.sessionName}:${Defaults.TMUX_AGENTS_WINDOW}`, '-F', fields]);
    return output.trim().split('\n').filter(Boolean).map(line => {
      const [paneId = '', paneTitle = '', currentCommand = '', startCommand = '', dead = '0'] = line.split(TmuxFormat.FIELD_SEPARATOR);
      return {
        paneId,
        paneTitle,
        currentCommand,
        startCommand,
        dead: dead === '1'
      };
    });
  }

  private isTeammatePane(pane: TmuxPane): boolean {
    return pane.paneTitle.startsWith(Defaults.AGENT_PANE_PREFIX) ||
      pane.currentCommand === Defaults.NODE_PROCESS_COMMAND ||
      pane.startCommand.includes(`${EnvVars.WORKER_MODE}=`);
  }

  private beadIdFromPane(pane: TmuxPane): string | undefined {
    if (pane.paneTitle.startsWith(Defaults.AGENT_PANE_PREFIX)) {
      return pane.paneTitle.slice(Defaults.AGENT_PANE_PREFIX.length) || undefined;
    }
    return this.envValueFromStartCommand(pane.startCommand, EnvVars.BEAD_ID);
  }

  private envValueFromStartCommand(command: string, key: string): string | undefined {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = command.match(new RegExp(`(?:^|\\s)${escapedKey}=('([^']*)'|"([^"]*)"|([^\\s]+))`));
    return match?.[2] || match?.[3] || match?.[4] || undefined;
  }

  public async getAvailableSlots(): Promise<number> {
    const active = await this.getActiveTeammateCount();
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
        TmuxOptionValue.ON
      ]);
    } catch {
      // Session might not exist yet if just created
    }
  }

  public async spawnTeammateInTmux(beadId: BeadId, stateId: string, worktreePath: string, ctx?: any): Promise<{ success: boolean; paneId?: string; error?: string }> {
    return this.observability.tracedAsync('spawn_teammate', {
      'agent.bead_id': beadId,
      'agent.state_id': stateId
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
        [EnvVars.CONFIG_PATH, configPath],
        [EnvVars.API_BASE, apiBase],
        [EnvVars.TRACE_ID, traceContext?.traceId || ''],
        [EnvVars.SPAN_ID, traceContext?.spanId || '']
      ].map(([key, value]) => `${key}=${shellQuote(value)}`);

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
      ].map(shellQuote);

      const command = `${env.join(' ')} ${args.join(' ')}`;
      Logger.info(Component.FACTORY, 'Spawning Orr Else teammate in tmux', {
        beadId,
        stateId,
        workerId,
        provider: llm.provider,
        model: llm.model,
        skillPaths,
        workerExtensions,
        workerArgs,
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
      await tmux([TmuxCommand.KILL_PANE, '-t', pane.paneId]);
      terminatedPaneIds.push(pane.paneId);
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
      execute: async ({ beadId, stateId, worktreePath }: any, ctx?: any) => await factory.spawnTeammateInTmux(beadId, stateId, worktreePath, ctx)
    }
  ]
});
