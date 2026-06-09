/**
 * WorkerCommandBuilder — narrow interface for constructing the Pi worker
 * spawn command.
 *
 * Extracts the command-string construction from TeammateFactory so that
 * spawn behavior can be tested with a fake builder — verifying that the
 * right env vars, flags, skill paths, and session flags are included
 * without actually running tmux.
 *
 * INJECTABLE: the real implementation assembles the command the same way
 * as the original inline code in spawnTeammateInTmuxInner.
 * Tests inject a fake that returns a deterministic command string.
 */

import { quote as quoteShellArgs } from 'shell-quote';

export interface WorkerCommandInput {
  /** Environment variable assignments as key=value strings. */
  env: string[];
  /** The full list of Pi CLI args (pi command + flags + message). */
  args: string[];
}

export interface WorkerCommandBuilder {
  /**
   * Build the shell command string to be passed to tmux split-window.
   * The returned string is a single shell command with env vars prepended.
   */
  build(input: WorkerCommandInput): string;
}

/**
 * Real WorkerCommandBuilder — assembles env + quoted args into a shell command.
 */
export const nodeWorkerCommandBuilder: WorkerCommandBuilder = {
  build(input: WorkerCommandInput): string {
    return `${input.env.join(' ')} ${quoteShellArgs(input.args)}`;
  }
};
