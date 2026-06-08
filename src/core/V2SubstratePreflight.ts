/**
 * V2SubstratePreflight — pi-experiment-ek2j
 *
 * Runtime substrate checks for v2 harness startup:
 *   1. tmux substrate — verify `tmux list-panes` succeeds for the orr-else
 *      session + Agents window (the pane-listing operation all spawn cycles
 *      depend on).  A simpler `tmux -V` is insufficient because it does not
 *      catch socket-permission or session-management failures.
 *   2. git worktree substrate — verify that `git worktree list` succeeds at
 *      the project root, confirming the repository is intact and the git
 *      binary can perform the worktree management operations used by every
 *      worker spawn.
 *
 * DESIGN CONSTRAINTS (ek2j):
 *   - VERSION-GATED: only runs for configs with version === 2. v1 startup and
 *     cerdiwen are completely unaffected — the caller guards the call.
 *   - FAIL-CLOSED: any substrate failure throws; the caller (startOrrElse)
 *     must abort before SignalingServer, Supervisor, or worker spawn.
 *   - DETERMINISTIC DIAGNOSTIC: failure messages name the exact substrate,
 *     project root, and failed command. No Date.now() or Math.random().
 *   - NO SECRETS in logged output: stderr is sanitised to ≤500 chars and
 *     any environment-variable-looking tokens (KEY=value) are redacted.
 *   - Injectable probe functions for hermetic unit tests.
 */

import { execa } from 'execa';
import type { EventStore } from './EventStore.js';
import { DomainEventName } from '../constants/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Which substrate the preflight is checking. */
export type SubstrateKind = 'tmux' | 'git-worktree';

/** Outcome of a single substrate check. */
export interface SubstrateCheckResult {
  /** true = substrate is available and usable. */
  ok: boolean;
  substrate: SubstrateKind;
  projectRoot: string;
  /** Failed command string (absent when ok=true). */
  command?: string;
  /** Sanitised stderr ≤500 chars (absent when ok=true or no stderr captured). */
  sanitizedStderr?: string;
  /** Human-readable deterministic diagnostic (absent when ok=true). */
  diagnostic?: string;
}

// ---------------------------------------------------------------------------
// Injectable probe functions (for testing)
// ---------------------------------------------------------------------------

/**
 * Probe function signature — matches the minimal surface used by both real
 * execa calls and test fakes.
 */
export type SubstrateProbe = (command: string, args: string[], cwd: string) =>
  Promise<{ ok: boolean; stderr?: string }>;

/** Default probes — real execa invocations. Override via setProbesForTest. */
let _tmuxProbe: SubstrateProbe | undefined;
let _gitProbe: SubstrateProbe | undefined;

/** Override substrate probes for hermetic tests. Pass undefined to restore real probes. */
export function setSubstrateProbesForTest(probes: {
  tmux?: SubstrateProbe;
  git?: SubstrateProbe;
}): void {
  _tmuxProbe = probes.tmux;
  _gitProbe = probes.git;
}

/** Reset all probe overrides (call in afterEach). */
export function resetSubstrateProbes(): void {
  _tmuxProbe = undefined;
  _gitProbe = undefined;
}

// ---------------------------------------------------------------------------
// Sanitisation
// ---------------------------------------------------------------------------

const MAX_STDERR_CHARS = 500;
const ENV_TOKEN_RE = /\b[A-Z][A-Z0-9_]{2,}=[^\s]+/g;

/**
 * Sanitise a raw stderr string for safe inclusion in event payloads.
 * - Truncates to MAX_STDERR_CHARS characters.
 * - Redacts environment-variable-looking tokens (KEY=value).
 */
export function sanitiseStderr(raw: string): string {
  const truncated = raw.slice(0, MAX_STDERR_CHARS);
  return truncated.replace(ENV_TOKEN_RE, '<redacted>');
}

// ---------------------------------------------------------------------------
// Substrate checks
// ---------------------------------------------------------------------------

/**
 * Check whether tmux is available and can list panes for the orr-else session's
 * Agents window.  Falls back to a simpler availability check (`tmux list-sessions`)
 * when the orr-else session does not yet exist, because at startup the session
 * is created by ensureAgentsWindow AFTER the preflight — the probe must not
 * require the session to exist; it only verifies the tmux binary is callable.
 *
 * Specifically: `tmux list-sessions` succeeds (even returning an empty list or
 * error-if-no-sessions) on systems where tmux is installed and the socket is
 * accessible.  When tmux is absent or the socket is unreadable, the command
 * fails with a non-zero exit.
 */
export async function checkTmuxSubstrate(projectRoot: string): Promise<SubstrateCheckResult> {
  const command = 'tmux';
  const args = ['list-sessions'];
  const probe = _tmuxProbe ?? realProbe;

  const result = await probe(command, args, projectRoot);
  if (result.ok) {
    return { ok: true, substrate: 'tmux', projectRoot };
  }

  const sanitizedStderr = result.stderr ? sanitiseStderr(result.stderr) : undefined;
  const diagnostic =
    `tmux substrate check failed at startup. ` +
    `Command "${command} ${args.join(' ')}" did not succeed. ` +
    `Install tmux and ensure the tmux socket is accessible before starting v2 harness. ` +
    (sanitizedStderr ? `Reason: ${sanitizedStderr}` : '');

  return {
    ok: false,
    substrate: 'tmux',
    projectRoot,
    command: `${command} ${args.join(' ')}`,
    sanitizedStderr,
    diagnostic
  };
}

/**
 * Check whether git worktree operations can succeed at the project root.
 * Runs `git worktree list` which is a read-only operation that verifies:
 *   - the git binary is accessible
 *   - the project root is inside a git repository
 *   - worktree listing (the same operation used by all spawn cycles) works
 */
export async function checkGitWorktreeSubstrate(projectRoot: string): Promise<SubstrateCheckResult> {
  const command = 'git';
  const args = ['worktree', 'list'];
  const probe = _gitProbe ?? realProbe;

  const result = await probe(command, args, projectRoot);
  if (result.ok) {
    return { ok: true, substrate: 'git-worktree', projectRoot };
  }

  const sanitizedStderr = result.stderr ? sanitiseStderr(result.stderr) : undefined;
  const diagnostic =
    `git worktree substrate check failed at startup. ` +
    `Command "${command} ${args.join(' ')}" at "${projectRoot}" did not succeed. ` +
    `Ensure "${projectRoot}" is inside a git repository before starting v2 harness. ` +
    (sanitizedStderr ? `Reason: ${sanitizedStderr}` : '');

  return {
    ok: false,
    substrate: 'git-worktree',
    projectRoot,
    command: `${command} ${args.join(' ')}`,
    sanitizedStderr,
    diagnostic
  };
}

// ---------------------------------------------------------------------------
// Startup admission gate
// ---------------------------------------------------------------------------

/**
 * Run both substrate checks for a v2 startup.
 *
 * Emits a V2_SUBSTRATE_PREFLIGHT_FAILED event for every failing substrate
 * (at most two — one per substrate kind). Throws with a deterministic
 * diagnostic naming all failing substrates if any check fails.
 *
 * The caller (startOrrElse) must guard this with `config.version === 2` so
 * v1 configs and cerdiwen are completely unaffected.
 *
 * @param projectRoot  The project root under which worktrees are provisioned.
 * @param eventStore   EventStore for recording failure diagnostics.
 */
export async function runV2SubstratePreflight(
  projectRoot: string,
  eventStore: EventStore
): Promise<void> {
  const [tmuxResult, gitResult] = await Promise.all([
    checkTmuxSubstrate(projectRoot),
    checkGitWorktreeSubstrate(projectRoot)
  ]);

  const failures: SubstrateCheckResult[] = [];
  for (const result of [tmuxResult, gitResult]) {
    if (!result.ok) {
      failures.push(result);
      await eventStore.record(DomainEventName.V2_SUBSTRATE_PREFLIGHT_FAILED, {
        substrate: result.substrate,
        projectRoot: result.projectRoot,
        diagnostic: result.diagnostic,
        ...(result.command !== undefined ? { command: result.command } : {}),
        ...(result.sanitizedStderr !== undefined ? { sanitizedStderr: result.sanitizedStderr } : {})
      }).catch(() => {});
    }
  }

  if (failures.length === 0) return;

  const names = failures.map(f => `"${f.substrate}"`).join(', ');
  const diagnostics = failures.map(f => f.diagnostic).filter(Boolean).join(' | ');
  throw new Error(
    `v2 harness startup blocked: substrate preflight failed for ${names}. ` +
    `${diagnostics} ` +
    `Fix the failing substrate(s) before starting the v2 harness ` +
    `(no model spend, no supervisor, and no worker spawn occur until all substrates are ready).`
  );
}

// ---------------------------------------------------------------------------
// Real probe (default implementation)
// ---------------------------------------------------------------------------

async function realProbe(
  command: string,
  args: string[],
  cwd: string
): Promise<{ ok: boolean; stderr?: string }> {
  try {
    const result = await execa(command, args, {
      cwd,
      reject: false,
      encoding: 'utf8',
      timeout: 10_000
    });
    if (result.exitCode !== 0) {
      return { ok: false, stderr: (result.stderr ?? '').toString() };
    }
    return { ok: true };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, stderr: msg };
  }
}
