/**
 * ProcessRunner — narrow interface for general subprocess execution (execa).
 *
 * Used by command project tools (commandExecutor) to run configured project
 * commands. Injecting a fake ProcessRunner in tests lets you exercise
 * command-failure and timeout behavior without spawning real subprocesses.
 *
 * INJECTABLE: the real implementation delegates to execa.
 * Tests inject a fake that simulates exit codes, stdout, stderr, signals.
 */

import { execa, type Options as ExecaOptions } from 'execa';

export interface ProcessRunnerResult {
  exitCode: number | undefined;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  isCanceled: boolean;
  signal: string | undefined;
}

export interface ProcessRunner {
  /**
   * Spawn a subprocess with the given command, args, and options.
   * Never rejects — always returns a result (equivalent to execa reject:false).
   *
   * When options.stdout/stderr are set to file paths (for streaming), the returned
   * stdout/stderr strings may be empty; callers are expected to read the files
   * directly.
   */
  run(
    command: string,
    args: string[],
    options: ExecaOptions
  ): Promise<ProcessRunnerResult>;
}

/**
 * Real ProcessRunner — delegates to execa with reject:false.
 */
export const nodeProcessRunner: ProcessRunner = {
  async run(
    command: string,
    args: string[],
    options: ExecaOptions
  ): Promise<ProcessRunnerResult> {
    const result = await execa(command, args, { ...options, reject: false });
    return {
      exitCode: typeof result.exitCode === 'number' ? result.exitCode : undefined,
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
      timedOut: result.timedOut ?? false,
      isCanceled: (result as { isCanceled?: boolean }).isCanceled ?? false,
      signal: result.signal
    };
  }
};
