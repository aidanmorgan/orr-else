import { Bead } from '../types/index.js';
import { ConfigLoader } from './ConfigLoader.js';
import { FlowManager } from './FlowManager.js';
import { Logger } from './Logger.js';
import { App, BeadStatus, Component, SchedulerDefaults } from '../constants/index.js';
import type { HarnessConfig } from './ConfigLoader.js';

/** Default terminal states when no statechart block is configured. */
const DEFAULT_SCHEDULER_TERMINAL_STATES: readonly string[] = [BeadStatus.COMPLETED];

export interface ScoredBead extends Bead {
  score: number;
}

export class Scheduler {
  private progressScores: Record<string, number> | null = null;

  constructor(
    private readonly configLoader: ConfigLoader,
    private readonly flowManager: FlowManager
  ) {}

  private isResumableState(bead: Bead, stateId: string, config: HarnessConfig): boolean {
    return bead.assigned_to === App.DISPLAY_NAME
      && bead.status === stateId
      && Object.prototype.hasOwnProperty.call(config.states, stateId);
  }

  private async getProgressScores(): Promise<Record<string, number>> {
    if (this.progressScores) return this.progressScores;

    const config = await this.configLoader.load();
    const states = config.states;
    const scores: Record<string, number> = {};
    
    Logger.debug(Component.SCHEDULER, 'Calculating progress scores from statechart');

    // Reverse adjacency list across every configured statechart edge.
    const adj: Record<string, string[]> = {};
    const allStateNames = Object.keys(states);
    
    for (const name of allStateNames) {
      const state = states[name];
      const targets = new Set([
        ...Object.values(state.transitions || {}),
        ...Object.values(state.on || {})
      ]);
      for (const target of targets) {
        if (!adj[target]) adj[target] = [];
        adj[target].push(name);
      }
    }
    
    // Seed BFS from ALL configured terminal states (default: ['completed']).
    // This preserves existing scoring when no statechart block is present.
    const terminalStates: readonly string[] =
      config.statechart?.terminalStates ?? DEFAULT_SCHEDULER_TERMINAL_STATES;
    const distances: Record<string, number> = {};
    const queue: string[] = [];
    for (const ts of terminalStates) {
      distances[ts] = 0;
      queue.push(ts);
    }
    
    while (queue.length > 0) {
      const curr = queue.shift()!;
      const d = distances[curr];
      
      const neighbors = adj[curr] || [];
      for (const neighbor of neighbors) {
        if (distances[neighbor] === undefined) {
          distances[neighbor] = d + 1;
          queue.push(neighbor);
        }
      }
    }
    
    // Find max distance among reachable states to completion
    let maxD = 0;
    for (const name of allStateNames) {
      if (distances[name] !== undefined && distances[name] > maxD) {
        maxD = distances[name];
      }
    }
    
    // Assign scores: 1.0 is completed, others are relative.
    for (const name of allStateNames) {
      if (distances[name] === undefined) {
        scores[name] = 0; 
      } else {
        scores[name] = 1.0 - (distances[name] / (maxD + 1));
      }
    }
    
    Logger.debug(Component.SCHEDULER, 'Progress scores calculated', { scores });
    this.progressScores = scores;
    return scores;
  }

  public async sortBacklog(beads: Bead[]): Promise<ScoredBead[]> {
    const config = await this.configLoader.load();
    const weights = {
      ...SchedulerDefaults.DEFAULT_WEIGHTS,
      ...(config.scheduler?.weights || {})
    };
    const progressScores = await this.getProgressScores();
    
    const now = Date.now();
    const maxWaitTimeMs = SchedulerDefaults.MAX_WAIT_TIME_MS;
    const maxExecTimeMs = SchedulerDefaults.MAX_EXECUTION_TIME_MS;

    Logger.info(Component.SCHEDULER, `Sorting backlog of ${beads.length} beads`, { weights });

    const schedulingRanks = new Map<string, { progressScore: number; resumable: boolean }>();
    const scoredBeads: ScoredBead[] = beads.map(bead => {
      const lastActivity = new Date(bead.lastActivity || Date.now()).getTime();
      const waitTimeMs = now - lastActivity;
      const execTimeMs = bead.totalExecutionTimeMs || 0;
      const retryCount = bead.retryCount || 0;
      const rotCount = bead.compactionCount || 0;
      const configuredPriority = typeof bead.priority === 'number'
        ? bead.priority
        : SchedulerDefaults.DEFAULT_PRIORITY;
      const boundedPriority = Math.min(
        SchedulerDefaults.LOWEST_PRIORITY,
        Math.max(SchedulerDefaults.HIGHEST_PRIORITY, configuredPriority)
      );

      // 2. Get Progress Score (Dynamically calculated from configured state ID)
      const stateId = this.flowManager.stateForBead(bead, config);
      const progressScore = progressScores[stateId] || 0;
      const priorityScore = (SchedulerDefaults.LOWEST_PRIORITY - boundedPriority) /
        (SchedulerDefaults.LOWEST_PRIORITY - SchedulerDefaults.HIGHEST_PRIORITY);
      const restartScore = bead.restartRequested ? SchedulerDefaults.RESTART_REQUESTED_SCORE : 0;
      const resumeScore = this.isResumableState(bead, stateId, config)
        ? SchedulerDefaults.RESUMABLE_STATE_SCORE
        : 0;
      schedulingRanks.set(bead.id, {
        progressScore,
        resumable: resumeScore > 0
      });

      // 3. Normalize values (0.0 to 1.0 roughly)
      const normWait = Math.min(waitTimeMs / maxWaitTimeMs, 1.0);
      const normExec = Math.min(execTimeMs / maxExecTimeMs, 1.0);
      
      // 4. Calculate Score
      const score = 
        (weights.waitTime * normWait) -
        (weights.executionTime * normExec) +
        (weights.progress * progressScore) -
        (weights.penalty * (
          retryCount * SchedulerDefaults.RETRY_PENALTY_WEIGHT +
          rotCount * SchedulerDefaults.COMPACTION_PENALTY_WEIGHT
        )) +
        (weights.priority * priorityScore) +
        ((weights.restart ?? SchedulerDefaults.DEFAULT_WEIGHTS.restart) * restartScore) +
        ((weights.resume ?? SchedulerDefaults.DEFAULT_WEIGHTS.resume) * resumeScore);

      Logger.debug(Component.SCHEDULER, `Scored bead ${bead.id}`, { 
        id: bead.id, 
        stateId, 
        score, 
        metrics: { normWait, normExec, progressScore, priorityScore, restartScore, resumeScore, retryCount, rotCount }
      });

      return {
        ...bead,
        score
      };
    });

    // For Orr Else-owned statechart work, the configured state order is a hard
    // priority: later phases must not be starved by older earlier-phase beads.
    const sorted = scoredBeads.sort((a, b) => {
      const aRank = schedulingRanks.get(a.id);
      const bRank = schedulingRanks.get(b.id);
      if (aRank?.resumable && bRank?.resumable) {
        const progressDelta = bRank.progressScore - aRank.progressScore;
        if (progressDelta !== 0) return progressDelta;
      }
      return b.score - a.score;
    });
    Logger.info(Component.SCHEDULER, 'Backlog sorted', { 
      topBeads: sorted.slice(0, SchedulerDefaults.LOG_TOP_BEAD_COUNT).map(b => ({ id: b.id, score: b.score, status: b.status }))
    });
    return sorted;
  }
}
