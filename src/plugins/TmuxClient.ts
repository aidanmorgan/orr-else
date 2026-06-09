/**
 * TmuxClient — narrow interface for tmux subprocess operations.
 *
 * Replaces the module-local `tmux()` wrapper function in teammates.ts so that
 * TeammateFactory can be tested with a fake tmux adapter without spawning real
 * tmux processes.
 *
 * INJECTABLE: the real implementation delegates to execa('tmux').
 * Tests inject a fake that simulates tmux output or failures.
 */

import { execa } from 'execa';

export interface TmuxClient {
  /**
   * Run a tmux command with the given arguments and return stdout.
   * Throws when tmux exits non-zero (same semantics as the previous
   * module-local `tmux()` wrapper).
   */
  run(args: string[]): Promise<string>;
}

/**
 * Real TmuxClient implementation — delegates to execa('tmux').
 */
export const nodeTmuxClient: TmuxClient = {
  async run(args: string[]): Promise<string> {
    const result = await execa('tmux', args);
    return result.stdout;
  }
};
