import { Bead } from '../types/index.js';
import { ConfigLoader } from './ConfigLoader.js';
import { FlowManager } from './FlowManager.js';
import { Logger } from './Logger.js';
import { BeadStatus, Component, SchedulerDefaults } from '../constants/index.js';

export interface ScoredBead extends Bead {
  score: number;
}

export class Scheduler {
  private progressScores: Record<string, number> | null = null;

  constructor(
    private readonly configLoader: ConfigLoader,
    private readonly flowManager: FlowManager
  ) {}

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
    
    const distances: Record<string, number> = { [BeadStatus.COMPLETED]: 0 };
    const queue: string[] = [BeadStatus.COMPLETED];
    
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
    const weights = config.scheduler?.weights || { waitTime: 1.0, executionTime: 0.5, progress: 2.0, penalty: 1.0 };
    const progressScores = await this.getProgressScores();
    
    const now = Date.now();
    const maxWaitTimeMs = SchedulerDefaults.MAX_WAIT_TIME_MS;
    const maxExecTimeMs = SchedulerDefaults.MAX_EXECUTION_TIME_MS;

    Logger.info(Component.SCHEDULER, `Sorting backlog of ${beads.length} beads`, { weights });

    const scoredBeads: ScoredBead[] = beads.map(bead => {
      const lastActivity = new Date(bead.lastActivity || Date.now()).getTime();
      const waitTimeMs = now - lastActivity;
      const execTimeMs = bead.totalExecutionTimeMs || 0;
      const retryCount = bead.retryCount || 0;
      const rotCount = bead.compactionCount || 0;

      // 2. Get Progress Score (Dynamically calculated from configured state ID)
      const stateId = this.flowManager.stateForBead(bead, config);
      const progressScore = progressScores[stateId] || 0;

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
        ));

      Logger.debug(Component.SCHEDULER, `Scored bead ${bead.id}`, { 
        id: bead.id, 
        stateId, 
        score, 
        metrics: { normWait, normExec, progressScore, retryCount, rotCount } 
      });

      return {
        ...bead,
        score
      };
    });

    // Sort descending by score
    const sorted = scoredBeads.sort((a, b) => b.score - a.score);
    Logger.info(Component.SCHEDULER, 'Backlog sorted', { 
      topBeads: sorted.slice(0, SchedulerDefaults.LOG_TOP_BEAD_COUNT).map(b => ({ id: b.id, score: b.score, status: b.status }))
    });
    return sorted;
  }
}
