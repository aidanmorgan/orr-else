import { Logger } from './Logger.js';
import { Component, TelemetryDefaults } from '../constants/index.js';

export interface TurnTelemetry {
  beadId: string;
  phase: string;
  actionId: string;
  model: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cost?: number;
}

export class TelemetryStore {
  private turns: TurnTelemetry[] = [];

  public recordTurn(telemetry: TurnTelemetry) {
    this.turns.push(telemetry);
    Logger.debug(Component.OBSERVABILITY, `Turn recorded for Bead ${telemetry.beadId} (${telemetry.actionId}): ${telemetry.durationMs}ms`);
    this.detectLoops(telemetry.beadId);
  }

  private detectLoops(beadId: string) {
    const beadTurns = this.turns.filter(t => t.beadId === beadId);
    if (beadTurns.length < TelemetryDefaults.LOOP_DETECTION_WINDOW) return;

    const recentTurns = beadTurns.slice(-TelemetryDefaults.LOOP_DETECTION_WINDOW);
    const allSameAction = recentTurns.every(t => t.actionId === recentTurns[0].actionId);
    
    if (allSameAction) {
       const hasFailure = recentTurns.some(t => t.durationMs < TelemetryDefaults.IMMEDIATE_FAILURE_DURATION_MS);
       if (hasFailure) {
         Logger.warn(Component.OBSERVABILITY, `High-frequency loop detected for Bead ${beadId} on action ${recentTurns[0].actionId}. Blocking.`);
       }
    }
  }

  public getSummary() {
    return {
      totalTurns: this.turns.length,
      totalDurationMs: this.turns.reduce((acc, t) => acc + t.durationMs, 0),
      totalTokens: this.turns.reduce((acc, t) => acc + (t.totalTokens || 0), 0),
    };
  }
}
