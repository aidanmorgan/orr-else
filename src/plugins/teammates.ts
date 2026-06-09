import * as path from 'path';
import * as fs from 'fs';
import { Type } from "@earendil-works/pi-ai";
import { v7 as uuidv7 } from 'uuid';
import { parse as parseShellCommand, quote as quoteShellArgs } from 'shell-quote';
import type { ApiAddress, BeadId } from '../types/index.js';

import { ConfigLoader } from '../core/ConfigLoader.js';
import { Logger } from '../core/Logger.js';
import { validateHandoffPayload, HandoffSchemaId } from '../core/HandoffSchemas.js';
import { Observability } from '../core/Observability.js';
import { redactPaneText } from '../core/PaneTextRedactor.js';
import { scanPaneTranscript, hasScanFindings, formatScanSummary, type PaneTranscriptScanResult } from '../core/PaneTranscriptScanner.js';
import { resolveProjectFrom } from '../core/Paths.js';
import { EventStore } from '../core/EventStore.js';
import { nodeRuntimeEnvironment, type RuntimeEnvironment } from '../core/RuntimeEnvironment.js';
import { computeBuildProvenance } from '../core/BuildProvenance.js';
import type { RuntimePlugin, RuntimeTool } from '../core/RuntimeServices.js';
import { resolveWorkerArgs, resolveWorkerExtensionPaths } from '../core/WorkerResourceResolver.js';
import { WorkerPromptIdentityBuilder, formatSkillDuplicationDiagnostic } from '../core/WorkerPromptIdentityBuilder.js';
import { resolveToolPromptProfileId } from './projectTools.js';
import { digestIdentity } from '../core/BootstrapDigest.js';
import { DomainEventName, PiCliCommand, PluginToolName, ThinkingLevel } from '../constants/domain.js';
import { Component, Defaults, EnvVars, OperationalArtifactPath, OtelAttr, PaneTranscriptDefaults, PiCliFlag, ProcessFlag, TeammatePaneCleanupReason, TmuxCommand, TmuxFormat, TmuxOption, TmuxOptionValue, WorktreeDefaults } from '../constants/infra.js';
import { nodeTmuxClient, type TmuxClient } from './TmuxClient.js';
import { nodeWorkerCommandBuilder, type WorkerCommandBuilder } from './WorkerCommandBuilder.js';

/**
 * Format the Orr Else worker identity string stored in the @orr_worker pane
 * user-option. This value is set once at spawn time and is never overwritten
 * by Pi because Pi only emits terminal title escape sequences (which update
 * pane_title), not tmux user options. pane-border-format reads this value to
 * provide durable operator-facing observability even after Pi retitles the pane.
 *
 * Format: "worker:<workerId> bead:<beadId> state:<stateId>"
 * This is a named constant (not a magic string) — slot-counting code and
 * tests must use this function to produce or parse the canonical value.
 */
export function formatOrrWorkerPaneOption(workerId: string, beadId: string, stateId: string): string {
  return `worker:${workerId} bead:${beadId} state:${stateId}`;
}

/**
 * The tmux pane-border-format string that displays the @orr_worker user-option
 * on each pane's border status line. Stored as a named constant so tests and
 * production code refer to the same literal.
 */
const ORR_WORKER_BORDER_FORMAT = `#{${TmuxOption.ORR_WORKER_PANE_OPTION}}`;

/**
 * Regex that parses the canonical @orr_worker pane user-option value produced
 * by formatOrrWorkerPaneOption.  Named capture groups make the extraction
 * self-documenting and immune to positional-index drift.
 *
 * Format matched: "worker:<workerId> bead:<beadId> state:<stateId>"
 * Each token is one or more non-whitespace characters (\S+).
 */
const ORR_WORKER_PARSE_RE = /^worker:(?<workerId>\S+)\s+bead:(?<beadId>\S+)\s+state:(?<stateId>\S+)$/;

/**
 * Parse the @orr_worker pane user-option value written by formatOrrWorkerPaneOption.
 * Returns a structured identity object when the value matches the canonical format,
 * or null when the value is absent, empty, or malformed.
 *
 * This is the exact counterpart to formatOrrWorkerPaneOption and is the ONLY
 * production path through which the @orr_worker value is decoded.
 *
 * Exported so that tests can exercise the parser in isolation and verify the
 * round-trip contract against formatOrrWorkerPaneOption.
 */
export function parseOrrWorkerPaneOption(value: string): { workerId: string; beadId: string; stateId: string } | null {
  if (!value) return null;
  const m = ORR_WORKER_PARSE_RE.exec(value);
  if (!m || !m.groups) return null;
  const { workerId, beadId, stateId } = m.groups;
  if (!workerId || !beadId || !stateId) return null;
  return { workerId, beadId, stateId };
}

/**
 * Sanitise a tmux pane ID (e.g. "%42") to a safe filename component.
 * Replaces any character that is not alphanumeric, dot, dash, or underscore.
 */
const PANE_ID_UNSAFE_CHARS = /[^A-Za-z0-9._-]/g;

const SAFE_REF = /^[A-Za-z0-9._-]+$/;

interface TmuxPane {
  paneId: string;
  paneTitle: string;
  currentCommand: string;
  startCommand: string;
  currentPath: string;
  dead: boolean;
  /** Raw value of the @orr_worker pane user-option. Empty string when absent. */
  orrWorker: string;
}

/**
 * Return the exact-match tmux target prefix for a session name.
 *
 * tmux resolves target sessions by prefix: a session named "orr-else" will
 * also match "orr-else-coordinator" because "orr-else" is a prefix of that
 * name.  Prepending "=" forces an exact (non-prefix) lookup, so "=orr-else"
 * never resolves into "orr-else-coordinator".
 *
 * References:
 *   tmux(1) "TARGET" section — any target starting with "=" is matched exactly
 *   against the session name rather than by prefix.
 */
export function exactSession(sessionName: string): string {
  return `=${sessionName}`;
}

/**
 * Verify that a tmux session with the given name exists, using exact-match
 * targeting so a prefix-colliding session cannot satisfy the check.
 *
 * `display-message -p -t =<sessionName> '#{session_name}'` returns an empty
 * string on some tmux builds even when the exact session exists. `has-session`
 * is the purpose-built existence probe and exits non-zero when absent.
 */
async function verifyExactSession(sessionName: string, tmuxClient: TmuxClient): Promise<boolean> {
  try {
    await tmuxClient.run([TmuxCommand.HAS_SESSION, '-t', exactSession(sessionName)]);
    return true;
  } catch {
    return false;
  }
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
  /**
   * When ensureAgentsWindow detects a hard failure (window creation failed or
   * could not be verified), this flag is set to true.  While true, pane scans
   * are throttled — getLiveTeammatePanes returns the last cached result without
   * issuing list-panes noise — and spawn attempts are rejected immediately.
   */
  private agentsWindowSetupFailed = false;
  private lastAgentsWindowSetupError = '';

  constructor(
    private readonly observability: Observability,
    private readonly configLoader: ConfigLoader,
    private readonly eventStore: EventStore,
    /**
     * Shared mutable holder for the SignalingServer's bound address (WI-7).
     * Created once in createRuntimeServices and mutated by startOrrElse after
     * the server binds. All factories sharing this reference see the bound
     * port at spawn time — no process.env mutation required.
     */
    private readonly apiAddress: ApiAddress = {},
    private maxSlots: number = Defaults.MAX_SLOTS,
    private readonly sessionName: string = Defaults.TMUX_SESSION,
    private readonly extensionPath?: string,
    private readonly env: RuntimeEnvironment = nodeRuntimeEnvironment,
    private readonly projectRoot: string = process.cwd(),
    private readonly tmuxClient: TmuxClient = nodeTmuxClient,
    private readonly workerCommandBuilder: WorkerCommandBuilder = nodeWorkerCommandBuilder
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
    // When setup is known-failed, suppress list-panes noise: return cached
    // fallback immediately rather than issuing repeated failing tmux calls.
    // The only message emitted is the deduplication-throttled setup-failure log
    // (already emitted once in ensureAgentsWindow), not a per-poll PANE_SCAN_FAILED.
    if (this.agentsWindowSetupFailed) {
      const fallbackPanes = this.lastLiveTeammatePanes.filter(pane => !pane.dead);
      return fallbackPanes;
    }

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
      TmuxFormat.PANE_ID,           // index 0
      TmuxFormat.PANE_TITLE,        // index 1
      TmuxFormat.PANE_CURRENT_COMMAND, // index 2
      TmuxFormat.PANE_START_COMMAND,   // index 3
      TmuxFormat.PANE_CURRENT_PATH,    // index 4
      TmuxFormat.PANE_DEAD,            // index 5
      TmuxFormat.PANE_ORR_WORKER       // index 6
    ].join(TmuxFormat.FIELD_SEPARATOR);
    const output = await this.tmuxClient.run([TmuxCommand.LIST_PANES, '-t', `${exactSession(this.sessionName)}:${Defaults.TMUX_AGENTS_WINDOW}`, '-F', fields]);
    return output.trim().split('\n').filter(Boolean).map(line => {
      const parts = line.split(TmuxFormat.FIELD_SEPARATOR);
      const [paneId = '', paneTitle = '', currentCommand = '', startCommand = ''] = parts;
      const currentPath = parts[4] || '';
      const dead = parts[5] || '0';
      const orrWorker = parts[6] || '';
      return {
        paneId,
        paneTitle,
        currentCommand,
        startCommand,
        currentPath,
        dead: dead === '1',
        orrWorker
      };
    });
  }

  private isTeammatePane(pane: TmuxPane): boolean {
    // Prefer the durable @orr_worker user-option identity when present: it
    // survives Pi overwriting pane_title and is the authoritative signal.
    if (pane.orrWorker && parseOrrWorkerPaneOption(pane.orrWorker) !== null) return true;
    // Fall back to heuristics for older panes that pre-date the @orr_worker option.
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
        await this.tmuxClient.run([TmuxCommand.KILL_PANE, '-t', pane.paneId]);
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
    // Prefer the durable @orr_worker user-option: it survives Pi overwriting
    // pane_title and is the authoritative identity source for post-spawn beads.
    if (pane.orrWorker) {
      const parsed = parseOrrWorkerPaneOption(pane.orrWorker);
      if (parsed) return parsed.beadId;
    }
    // Fall back to pane_title prefix (set at spawn, may be overwritten by Pi).
    if (pane.paneTitle.startsWith(Defaults.AGENT_PANE_PREFIX)) {
      return pane.paneTitle.slice(Defaults.AGENT_PANE_PREFIX.length) || undefined;
    }
    // Final fallbacks: start-command env vars and worktree path heuristic.
    return this.envValueFromStartCommand(pane.startCommand, EnvVars.BEAD_ID) ||
      this.beadIdFromCurrentPath(pane.currentPath);
  }

  private beadIdFromCurrentPath(currentPath: string): string | undefined {
    if (!currentPath) return undefined;
    const projectRoot = this.env.env(EnvVars.PROJECT_ROOT) || this.projectRoot;
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

  /**
   * Capture the visible text of a tmux pane for operator-facing monitoring,
   * with model-thinking / reasoning blocks redacted before returning.
   *
   * ANSI/control-escape sequences are stripped inside redactPaneText before
   * any pattern matching occurs.
   *
   * This is the ONLY path through which pane content should reach operator
   * artifacts or monitoring summaries.  It never touches model inputs and
   * requires no agent self-policing.
   *
   * As a best-effort side-effect the cleaned text is written to a per-pane
   * transcript file under .pi/logs/tmux/ and a pointer file is updated to
   * record the current transcript path.  Failures are silently swallowed.
   *
   * @param paneId - tmux pane target (e.g. "%42" or "session:window.pane")
   * @returns Redacted pane text (reasoning blocks replaced with a placeholder).
   */
  public async capturePaneText(paneId: string): Promise<string> {
    const raw = await this.tmuxClient.run([TmuxCommand.CAPTURE_PANE, '-p', '-t', paneId]);
    const cleaned = redactPaneText(raw);
    // Best-effort: write transcript + pointer; never blocks on failure.
    this.writeCurrentTranscript(paneId, cleaned).catch(() => {});
    return cleaned;
  }

  /**
   * Write the cleaned+redacted pane transcript to a current file under the
   * harness log area (.pi/logs/tmux/<safePaneId>.log) and update the pointer
   * file (.pi/logs/tmux/current.path) to the current transcript path.
   *
   * The transcript is capped at PaneTranscriptDefaults.MAX_TRANSCRIPT_BYTES;
   * content beyond the cap is silently dropped.  All I/O is synchronous so
   * that no extra async chains are created in the monitoring hot path.
   *
   * Always best-effort: this method never throws.
   */
  private async writeCurrentTranscript(paneId: string, text: string): Promise<void> {
    try {
      const transcriptDir = resolveProjectFrom(
        this.projectRoot,
        OperationalArtifactPath.PI_TMUX_TRANSCRIPTS_DIR
      );
      fs.mkdirSync(transcriptDir, { recursive: true });

      const safeId = paneId.replace(PANE_ID_UNSAFE_CHARS, '_');
      const transcriptPath = path.join(
        transcriptDir,
        `${safeId}${PaneTranscriptDefaults.FILE_SUFFIX}`
      );
      const pointerPath = path.join(transcriptDir, PaneTranscriptDefaults.POINTER_FILENAME);

      // Enforce cap: only write if content fits within the byte budget.
      const encoded = Buffer.from(text, 'utf8');
      if (encoded.byteLength <= PaneTranscriptDefaults.MAX_TRANSCRIPT_BYTES) {
        fs.writeFileSync(transcriptPath, encoded);
        fs.writeFileSync(pointerPath, transcriptPath, 'utf8');
      } else {
        // Write only the capped portion (tail end is most recent output).
        const tail = encoded.subarray(encoded.byteLength - PaneTranscriptDefaults.MAX_TRANSCRIPT_BYTES);
        fs.writeFileSync(transcriptPath, tail);
        fs.writeFileSync(pointerPath, transcriptPath, 'utf8');
      }
    } catch {
      // Best-effort: swallow all errors — transcript write failures must
      // never propagate to the monitoring or recovery path.
    }
  }

  /**
   * Capture and scan the pane transcript for operator-facing issue categories.
   *
   * Returns the cleaned text and a structured scan result for each category.
   * Best-effort: capture failures return an empty text and zero-count result.
   *
   * @param paneId - tmux pane target (e.g. "%42" or "session:window.pane")
   */
  public async capturePaneTextWithScan(paneId: string): Promise<{
    text: string;
    scan: PaneTranscriptScanResult;
  }> {
    const text = await this.capturePaneText(paneId).catch(() => '');
    const scan = scanPaneTranscript(text);
    return { text, scan };
  }

  /**
   * Capture and redact the visible pane text for all live tmux panes belonging
   * to the given bead.  This is the harness-internal path through which pane
   * content reaches operator-facing monitoring artifacts (e.g. AGENT_TURN_FAILED
   * evidence in the slot-health stuck-pane path).
   *
   * Reasoning blocks are stripped by capturePaneText before the text is returned;
   * actionable lines (commands, errors, tool names, bead/state IDs) are preserved,
   * so stuck-prompt and error detection remain operational on the redacted text.
   *
   * As a best-effort side-effect the transcript is scanned for operator-facing
   * issue categories (PROVIDER_ERROR, PROTOCOL_VIOLATION, ENOENT, STUCK_PROMPT,
   * PANIC_FATAL).  When findings are detected a compact summary is appended to
   * the returned text so that callers (e.g. Supervisor.recoverInactiveBeads)
   * include the scan results in their evidence payloads without additional code.
   *
   * Never touches model inputs; requires no agent self-policing.
   *
   * Returns an empty string when no live pane is found for the bead or when
   * capture fails (errors are swallowed so callers always get a safe string).
   */
  public async captureBeadPaneText(beadId: string): Promise<string> {
    try {
      const panes = await this.getLiveTeammatePanes();
      const beadPanes = panes.filter(pane => this.beadIdFromPane(pane) === beadId);
      if (beadPanes.length === 0) return '';
      const snapshots = await Promise.all(
        beadPanes.map(pane =>
          this.capturePaneText(pane.paneId).catch(() => '')
        )
      );
      const combined = snapshots.filter(Boolean).join('\n---\n');

      // Run the transcript scan on the combined output and append findings to
      // the evidence string so the Supervisor sees the structured summary.
      const scan = scanPaneTranscript(combined);
      if (hasScanFindings(scan)) {
        const scanSummary = formatScanSummary(scan);
        return `${combined}\n\n[Transcript scan findings]\n${scanSummary}`;
      }
      return combined;
    } catch {
      return '';
    }
  }

  public async getAvailableSlots(): Promise<number> {
    const active = await this.getActiveTeammateCount();
    if (this.paneListFailed) return 0;
    return Math.max(0, this.maxSlots - active);
  }

  /**
   * Override the slot limit at runtime.  Called by startOrrElse when the
   * operator supplies `--max-slots N` on the CLI: the SESSION_START factory is
   * reused (WI-20 dedup), but the CLI value must win over the config value that
   * was baked into the factory at construction time.
   */
  public setMaxSlots(n: number): void {
    this.maxSlots = n;
  }

  /** Returns the current slot limit (useful for testing and diagnostics). */
  public getMaxSlots(): number {
    return this.maxSlots;
  }

  /**
   * Ensure the tmux session and Agents window exist, using exact-match session
   * targeting to prevent prefix collisions (e.g. "orr-else" resolving into
   * "orr-else-coordinator").
   *
   * Hard-failure semantics (s3wp.33):
   *   - Returns `{ ok: true }` when the Agents window is verified to exist.
   *   - Returns `{ ok: false, error: string }` when creation or verification
   *     fails.  The caller (spawnTeammateInTmuxInner) treats this as a hard
   *     setup failure and aborts the spawn rather than continuing silently.
   *
   * Also sets `this.agentsWindowSetupFailed` so subsequent pane scans are
   * throttled while the window is known-unready.
   */
  public async ensureAgentsWindow(): Promise<{ ok: boolean; error?: string }> {
    // Step 1: ensure the session exists. Use exact-match targeting so
    // "has-session -t =orr-else" never resolves "orr-else-coordinator".
    const sessionExists = await verifyExactSession(this.sessionName, this.tmuxClient);
    if (!sessionExists) {
      try {
        await this.tmuxClient.run([TmuxCommand.NEW_SESSION, '-d', '-s', this.sessionName, '-n', Defaults.TMUX_COORDINATOR_WINDOW]);
      } catch (error) {
        const msg = `Failed to create tmux session "${this.sessionName}": ${String(error)}`;
        this.agentsWindowSetupFailed = true;
        this.lastAgentsWindowSetupError = msg;
        Logger.error(Component.FACTORY, 'Hard setup failure: could not create tmux session', {
          sessionName: this.sessionName,
          error: String(error)
        });
        return { ok: false, error: msg };
      }
    }

    // Step 2: ensure the Agents window exists.
    let windowAlreadyExists = false;
    try {
      const windows = (await this.tmuxClient.run([TmuxCommand.LIST_WINDOWS, '-t', exactSession(this.sessionName), '-F', '#{window_name}'])).trim().split('\n');
      windowAlreadyExists = windows.includes(Defaults.TMUX_AGENTS_WINDOW);
    } catch (error) {
      const msg = `Failed to list windows for session "${this.sessionName}": ${String(error)}`;
      this.agentsWindowSetupFailed = true;
      this.lastAgentsWindowSetupError = msg;
      Logger.error(Component.FACTORY, 'Hard setup failure: could not list tmux windows', {
        sessionName: this.sessionName,
        error: String(error)
      });
      return { ok: false, error: msg };
    }

    if (!windowAlreadyExists) {
      try {
        await this.tmuxClient.run([TmuxCommand.NEW_WINDOW, '-t', exactSession(this.sessionName), '-n', Defaults.TMUX_AGENTS_WINDOW]);
      } catch (error) {
        const msg = `Failed to create Agents window in session "${this.sessionName}": ${String(error)}`;
        this.agentsWindowSetupFailed = true;
        this.lastAgentsWindowSetupError = msg;
        Logger.error(Component.FACTORY, 'Hard setup failure: new-window for Agents failed', {
          sessionName: this.sessionName,
          error: String(error)
        });
        return { ok: false, error: msg };
      }

      // Step 3: verify the window actually exists after creation. A spurious
      // fork/device error might silently succeed from tmux's perspective while
      // the window was never actually created.
      try {
        const windowsAfter = (await this.tmuxClient.run([TmuxCommand.LIST_WINDOWS, '-t', exactSession(this.sessionName), '-F', '#{window_name}'])).trim().split('\n');
        if (!windowsAfter.includes(Defaults.TMUX_AGENTS_WINDOW)) {
          const msg = `Agents window not found in session "${this.sessionName}" after creation`;
          this.agentsWindowSetupFailed = true;
          this.lastAgentsWindowSetupError = msg;
          Logger.error(Component.FACTORY, 'Hard setup failure: Agents window missing after new-window', {
            sessionName: this.sessionName
          });
          return { ok: false, error: msg };
        }
      } catch (error) {
        const msg = `Failed to verify Agents window after creation: ${String(error)}`;
        this.agentsWindowSetupFailed = true;
        this.lastAgentsWindowSetupError = msg;
        Logger.error(Component.FACTORY, 'Hard setup failure: could not verify Agents window', {
          sessionName: this.sessionName,
          error: String(error)
        });
        return { ok: false, error: msg };
      }
    }

    // Step 4: apply window options. remain-on-exit is required; pane-border-status is best-effort.
    try {
      await this.tmuxClient.run([
        TmuxCommand.SET_WINDOW_OPTION,
        '-t',
        `${exactSession(this.sessionName)}:${Defaults.TMUX_AGENTS_WINDOW}`,
        TmuxOption.REMAIN_ON_EXIT,
        TmuxOptionValue.OFF
      ]);
    } catch (error) {
      // Non-fatal: warn but do not fail setup — the window is verified to exist.
      Logger.warn(Component.FACTORY, 'Failed to configure agents window in tmux session', { sessionName: this.sessionName, error: String(error) });
    }

    // Enable the pane border status bar once when the Agents window is ready.
    // This is a window-level option: setting it here (rather than per-spawn)
    // ensures N concurrent spawns do not issue N redundant window-option writes.
    // Non-fatal: a rejection from an older tmux must not prevent spawn.
    this.tmuxClient.run([
      TmuxCommand.SET_OPTION,
      '-w',
      '-t',
      `${exactSession(this.sessionName)}:${Defaults.TMUX_AGENTS_WINDOW}`,
      TmuxOption.PANE_BORDER_STATUS,
      TmuxOptionValue.PANE_BORDER_STATUS_TOP
    ]).catch(() => {});

    // Clear any prior setup failure — window is now verified.
    this.agentsWindowSetupFailed = false;
    this.lastAgentsWindowSetupError = '';
    return { ok: true };
  }

  /** Returns true when the Agents window setup is known to have failed. Exposed for testing. */
  public isSetupFailed(): boolean {
    return this.agentsWindowSetupFailed;
  }

  public async spawnTeammateInTmux(beadId: BeadId, stateId: string, worktreePath: string, ctx?: unknown, spawnOptions?: import('../core/OrchestrationPorts.js').SpawnOptions): Promise<{ success: boolean; paneId?: string; error?: string; piSessionPath?: string }> {
    return this.observability.tracedAsync('spawn_teammate', {
      [OtelAttr.AGENT_BEAD_ID]: beadId,
      [OtelAttr.AGENT_STATE_ID]: stateId
    }, async () => this.spawnTeammateInTmuxInner(beadId, stateId, worktreePath, ctx, spawnOptions))();
  }

  private async spawnTeammateInTmuxInner(beadId: BeadId, stateId: string, worktreePath: string, ctx?: unknown, spawnOptions?: import('../core/OrchestrationPorts.js').SpawnOptions): Promise<{ success: boolean; paneId?: string; error?: string; piSessionPath?: string }> {
    const ui = ctx && typeof ctx === 'object' ? ctx as { hasUI?: boolean; ui?: { setWorkingMessage(m: string | undefined): void; notify(m: string, t: string): void } } : undefined;
    try {
      assertSafeBeadId(beadId);
      if (!worktreePath) {
        return { success: false, error: 'A mandatory worktreePath is required for every Orr Else teammate.' };
      }
      const windowSetup = await this.ensureAgentsWindow();
      if (!windowSetup.ok) {
        // Hard setup failure: do NOT continue — the Agents window is unverified.
        // Record the spawn failure and return immediately.
        await this.eventStore.record(DomainEventName.TEAMMATE_SPAWN_FAILED, {
          beadId,
          stateId,
          worktreePath,
          error: windowSetup.error
        }).catch(() => {});
        Logger.error(Component.FACTORY, 'Aborting spawn: Agents window setup failed', {
          beadId,
          stateId,
          error: windowSetup.error
        });
        if (ui?.hasUI) {
          ui.ui?.notify(`Failed to spawn teammate: Agents window setup failed`, 'error');
          ui.ui?.setWorkingMessage(undefined);
        }
        return { success: false, error: windowSetup.error };
      }

      const slots = await this.getAvailableSlots();
      if (slots <= 0) {
        return { success: false, error: 'No available Orr Else teammate slots.' };
      }

      if (ui?.hasUI) ui.ui?.setWorkingMessage(`Spawning teammate for ${beadId}...`);

      const projectRoot = this.env.env(EnvVars.PROJECT_ROOT) || this.projectRoot;
      const runDir = worktreePath;
      const extensionPath = this.extensionPath || path.join(projectRoot, Defaults.PROJECT_EXTENSION_PATH);
      const config = await this.configLoader.load();
      const llm = this.configLoader.resolveLLMConfig(stateId, config);
      const workerExtensions = resolveWorkerExtensionPaths(config, projectRoot, extensionPath);
      const configPath = this.configLoader.getConfigPath();
      // Resolve the effective tool prompt profile for this state at spawn time.
      // At spawn, there is no specific action in scope — only state + settings levels apply.
      const spawnProfileId = resolveToolPromptProfileId(config, config.states?.[stateId]);
      const spawnProtocolLabel = spawnProfileId
        ? `ORR_ELSE_PROTOCOL_v1|profile:${spawnProfileId}`
        : 'ORR_ELSE_PROTOCOL_v1';

      // pi-experiment-amq0.10: use the single WorkerPromptIdentityBuilder to derive
      // skill resolution + spawn-time identity.  This replaces the prior direct calls
      // to resolvePiSkillPathsForState + a WRONG toolNames (workerExtensions paths)
      // and ensures the spawn digest uses the same Pi tool names as the prompt-assembly
      // digest (Pi tool names from config, not extension file paths).
      const spawnIdentity = WorkerPromptIdentityBuilder.build({
        projectRoot,
        configPath,
        stateId,
        config,
        protocolLabel: spawnProtocolLabel
      });
      if (spawnIdentity.skillDuplications.length > 0) {
        Logger.warn(Component.FACTORY, formatSkillDuplicationDiagnostic(spawnIdentity.skillDuplications), {
          beadId,
          stateId,
          duplications: spawnIdentity.skillDuplications
        });
      }
      const resolvedSkills = spawnIdentity.resolvedSkills;
      const skillPaths = resolvedSkills.map(s => s.path);
      const workerArgs = resolveWorkerArgs(config, { configPath, projectRoot, worktreePath });
      const apiPort = this.apiAddress.port || Defaults.API_PORT;
      const apiBase = this.apiAddress.base || `http://${Defaults.API_HOST}:${apiPort}`;
      const sessionStateId = uuidv7();
      const workerId = `worker-${beadId}-${stateId}-${Date.now()}-${process.pid}`.replace(/[^A-Za-z0-9._:-]/g, '-');

      const traceContext = this.observability.getTraceContext();

      // Compute coordinator build provenance for spawn evidence. Best-effort.
      const spawnProvenance = await computeBuildProvenance(configPath).catch(() => undefined);

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

      // pi-experiment-6q0y.44: session flag resolution.
      // - namedContinuation (spawnOptions.contextKey): use --session <piSessionPath> to resume.
      // - producesContextKey (spawnOptions.persistSessionForKey): use a deterministic session
      //   path so the session is persistently stored and later resumable.
      // - default (freshSubagent): use --no-session for an ephemeral isolated context.
      let piSessionPath: string | undefined;
      let sessionFlags: string[];

      if (spawnOptions?.contextKey) {
        // Named continuation: resume an existing Pi session by full path.
        sessionFlags = [PiCliFlag.SESSION, spawnOptions.contextKey];
        piSessionPath = spawnOptions.contextKey;
      } else if (spawnOptions?.persistSessionForKey) {
        // Write side: create a persistent session at a deterministic path so it can
        // be found later by a namedContinuation consumer.
        const safeKey = spawnOptions.persistSessionForKey.replace(/[^A-Za-z0-9_-]/g, '-');
        const sessionDir = path.join(projectRoot, OperationalArtifactPath.PI_ARTIFACTS_DIR, 'sessions', safeKey);
        fs.mkdirSync(sessionDir, { recursive: true });
        // Use a deterministic session file path: Pi creates the file here when given
        // a full path argument containing a '/'.
        piSessionPath = path.join(sessionDir, `session-${beadId}-${stateId}.jsonl`);
        sessionFlags = [PiCliFlag.SESSION, piSessionPath];
      } else {
        // freshSubagent default: ephemeral isolated context.
        sessionFlags = [PiCliFlag.NO_SESSION];
      }

      const args = [
        PiCliCommand.PI,
        PiCliFlag.NO_EXTENSIONS,
        ...workerExtensions.flatMap(workerExtension => [PiCliFlag.EXTENSION, workerExtension]),
        ...skillPaths.flatMap(skillPath => [PiCliFlag.SKILL, skillPath]),
        PiCliFlag.PROVIDER, llm.provider,
        PiCliFlag.MODEL, llm.model,
        PiCliFlag.THINKING, llm.thinking || ThinkingLevel.HIGH,
        ...sessionFlags,
        ...workerArgs,
        `Orr Else teammate bootstrap for ${beadId}/${stateId}.`
      ];

      const command = this.workerCommandBuilder.build({ env, args });
      const skillNames = resolvedSkills.map(s => s.name);

      // pi-experiment-amq0.10: spawn-time identity digest via the single builder.
      // WorkerPromptIdentityBuilder.build() (called above) produced spawnIdentity.identity
      // with correct Pi tool names (not workerExtension paths) and state-aware skills.
      // digestIdentity() hashes only the canonical identity (no text rendering) so
      // it is deterministic and cache-eligible across beads in the same state.
      // The full stable-block digest (identity + actual rendered text) is
      // recorded on the worker-side STATE_PROMPT_ASSEMBLED event after the
      // worker assembles its real prompt in BEFORE_AGENT_START.
      const spawnDigestId = digestIdentity(spawnIdentity.identity);

      Logger.info(Component.FACTORY, 'Spawning Orr Else teammate in tmux', {
        beadId,
        stateId,
        workerId,
        provider: llm.provider,
        model: llm.model,
        skillCount: skillPaths.length,
        skillNames,
        workerExtensionCount: workerExtensions.length,
        workerArgsCount: workerArgs.length,
        runDir,
        spawnIdentityDigestId: spawnDigestId
      });

      // pi-experiment-3b5e: fail-closed dispatch-side validation for worker command.
      // The workerCommand schema enforces beadId/stateId are present and well-formed
      // before the spawn record is written and the tmux pane is launched.
      // Fail closed — the spawn is blocked entirely, not heuristic.
      const commandValidation = validateHandoffPayload(
        HandoffSchemaId.WORKER_COMMAND,
        { beadId, stateId, workerId },
        { beadId, stateId }
      );
      if (!commandValidation.valid) {
        const { diagnostic } = commandValidation;
        Logger.error(Component.FACTORY, 'Dispatch-side workerCommand schema validation FAILED — blocking spawn', {
          beadId,
          stateId,
          workerId,
          schemaId: diagnostic.schemaId,
          failurePath: diagnostic.failurePath
        });
        return {
          success: false,
          error: `Handoff schema violation [${diagnostic.schemaId}] for beadId=${beadId} stateId=${stateId}: ${diagnostic.failurePath.join('; ')}`
        };
      }

      await this.eventStore.record(DomainEventName.TEAMMATE_SPAWN_STARTED, {
        beadId,
        stateId,
        workerId,
        worktreePath,
        provider: llm.provider,
        model: llm.model,
        thinking: llm.thinking,
        skillNames,
        skillPaths,
        workerExtensions,
        workerArgs,
        buildProvenance: spawnProvenance,
        // Lightweight identity digest for audit — derived from canonical identity
        // inputs only (no text rendering).  The full digest (identity + rendered
        // stable block text) is recorded by the worker on STATE_PROMPT_ASSEMBLED.
        bootstrapDigestId: spawnDigestId,
        // pi-experiment-6q0y.44: context continuation audit fields.
        ...(piSessionPath ? { piSessionPath, isResumption: !!spawnOptions?.contextKey } : {})
      });

      const paneId = (await this.tmuxClient.run([TmuxCommand.SPLIT_WINDOW, '-P', '-F', '#{pane_id}', '-t', `${exactSession(this.sessionName)}:${Defaults.TMUX_AGENTS_WINDOW}`, '-c', runDir, command])).trim();
      if (paneId) {
        // Set the visible pane title (backward compat: slot-counter reads #{pane_title}
        // via AGENT_PANE_PREFIX prefix; Pi may overwrite this, but the @orr_worker
        // user-option and start-command/worktree-path fallbacks in
        // isTeammatePane/beadIdFromPane handle that case).
        await this.tmuxClient.run([TmuxCommand.SELECT_PANE, '-t', paneId, '-T', `${Defaults.AGENT_PANE_PREFIX}${beadId}`]);

        // Store the full worker identity as a pane user-option (fire-and-forget).
        // tmux user options (prefixed with @) are internal tmux state; Pi cannot
        // clobber them because Pi only emits terminal escape sequences that update
        // pane_title, never tmux set-option calls.  listAgentPanes reads this via
        // #{@orr_worker} so beadIdFromPane() can recover identity even when Pi has
        // retitled the pane.
        //
        // Non-fatal: older tmux versions may not support set-option -p for user
        // options. A rejection here must never fail a live spawn — the worker
        // process is already running. Wrap each observability call independently.
        const orrWorkerValue = formatOrrWorkerPaneOption(workerId, beadId, stateId);
        this.tmuxClient.run([TmuxCommand.SET_OPTION, '-p', '-t', paneId, TmuxOption.ORR_WORKER_PANE_OPTION, orrWorkerValue])
          .catch(() => {});

        // Wire the pane border to display the durable @orr_worker value (fire-and-forget).
        // set-option -p scopes the option to this pane only, so other panes in the
        // window are unaffected. pane-border-format reads #{@orr_worker} which
        // expands to the pane-scoped user-option set above.
        this.tmuxClient.run([TmuxCommand.SET_OPTION, '-p', '-t', paneId, TmuxOption.PANE_BORDER_FORMAT, ORR_WORKER_BORDER_FORMAT])
          .catch(() => {});
      }
      await this.tmuxClient.run([TmuxCommand.SELECT_LAYOUT, '-t', `${exactSession(this.sessionName)}:${Defaults.TMUX_AGENTS_WINDOW}`, 'tiled']);
      await this.eventStore.record(DomainEventName.TEAMMATE_SPAWNED, {
        beadId,
        stateId,
        workerId,
        worktreePath,
        paneId
      });

      if (ui?.hasUI) {
        ui.ui?.notify(`Teammate spawned for ${beadId} (${stateId})`, 'info');
        ui.ui?.setWorkingMessage(undefined);
      }
      const result: { success: boolean; paneId?: string; piSessionPath?: string } = { success: true, paneId };
      if (piSessionPath) result.piSessionPath = piSessionPath;
      return result;
    } catch (error) {
      await this.eventStore.record(DomainEventName.TEAMMATE_SPAWN_FAILED, {
        beadId,
        stateId,
        worktreePath,
        error: String(error)
      }).catch(() => {});
      Logger.error(Component.FACTORY, 'Failed to spawn Orr Else teammate', { beadId, stateId, error: String(error) });
      if (ui?.hasUI) {
        ui.ui?.notify(`Failed to spawn teammate: ${String(error)}`, 'error');
        ui.ui?.setWorkingMessage(undefined);
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
        await this.tmuxClient.run([TmuxCommand.KILL_PANE, '-t', pane.paneId]);
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

/**
 * pi-experiment-amq0.9: Admission gate for spawn_teammate.
 *
 * spawn_teammate is a coordinator-owned operation that MUST NOT execute before
 * the SignalingServer has bound (HARNESS_API_BOUND) and an active supervisor
 * session exists.  A call before either condition is met must be rejected
 * with NO tmux side effects and a compact diagnostic.
 *
 * The gate is REQUIRED. teammatePlugin always checks both conditions before
 * any tmux call is attempted (fail-closed).
 */
export interface SpawnTeammateGate {
  /** Returns true when HARNESS_API_BOUND has fired and apiAddress.port is set. */
  isApiBound(): boolean;
  /** Returns true when an active supervisor/coordinator session exists. */
  hasSupervisor(): boolean;
}

export const teammatePlugin = (factory: TeammateFactory, gate: SpawnTeammateGate): RuntimePlugin => ({
  name: 'orr-else-teammates',
  tools: [
    {
      name: PluginToolName.SPAWN_TEAMMATE,
      description: 'Spawn an Orr Else state worker Pi process in a tmux pane.',
      parameters: Type.Object({
        beadId: Type.String({ description: 'The Bead ID to assign' }),
        stateId: Type.String({ description: 'The statechart state to execute' }),
        worktreePath: Type.String({ description: 'Mandatory dedicated worktree path for the state worker.' })
      }),
      execute: async (params: unknown, ctx?: unknown) => {
        // pi-experiment-amq0.9: admission gate — fail closed before any tmux call.
        // BOTH conditions must hold: API must be bound and an active supervisor
        // must exist.  A pre-start or post-stop call returns a deterministic
        // rejection with no tmux side effects and no canonical evidence handle
        // (so it cannot satisfy requiredTools / pass a coordinator gate).
        if (!gate.isApiBound()) {
          return {
            success: false,
            error: 'spawn_teammate unavailable: signaling server not yet bound (HARNESS_API_BOUND has not fired). Call /orr-else first.'
          };
        }
        if (!gate.hasSupervisor()) {
          return {
            success: false,
            error: 'spawn_teammate unavailable: no active coordinator session (supervisor is null). Call /orr-else first.'
          };
        }
        const { beadId, stateId, worktreePath } = (params && typeof params === 'object' ? params : {}) as { beadId: string; stateId: string; worktreePath: string };
        return factory.spawnTeammateInTmux(beadId as BeadId, stateId, worktreePath, ctx);
      }
    }
  ] satisfies RuntimeTool[]
});
