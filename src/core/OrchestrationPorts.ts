/**
 * Typed port interfaces for core orchestration operations.
 *
 * Core modules (Orchestrator, Supervisor) depend on these interfaces rather than
 * on RuntimePlugin arrays or string-keyed tool lookups. Adapters that wrap the
 * concrete plugin tool calls are located in the composition layer (RuntimeServices).
 *
 * Keeping these in core is safe: the interfaces reference only Bead (from types)
 * and WorktreeResult (defined here). No plugin imports.
 */

import type { Bead } from '../types/index.js';
import type { BeadsIssueStatus } from '../constants/index.js';

// ---------------------------------------------------------------------------
// Shared result contract for git worktree provisioning.
// Defined here (rather than in RuntimeServices) so that OrchestrationPorts is
// a pure-contract file with no circular imports. RuntimeServices re-exports this
// for backward compatibility with existing callers.
// ---------------------------------------------------------------------------

/** Result contract for git worktree provisioning tools. */
export interface WorktreeResult {
  success: boolean;
  path?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// BeadsPort — wraps BD_READY, BD_LIST, BD_GET_BEAD, BD_CLAIM, BD_RELEASE
// ---------------------------------------------------------------------------

export interface BeadReadyOptions {
  limit: number;
}

export interface BeadListOptions {
  status: BeadsIssueStatus;
  limit: number;
  includeProjection: boolean;
  includeNotesPreview: boolean;
}

export interface BeadListResult {
  items?: Bead[];
}

export interface BeadClaimOptions {
  id: string;
  owner: string;
  stateId: string;
  leaseTtlMs: number;
}

export interface BeadsPort {
  /** BD_READY — fetch the ready backlog up to `limit` items. */
  ready(options: BeadReadyOptions): Promise<Bead[]>;
  /** BD_LIST — list beads by status with pagination and optional projection. */
  list(options: BeadListOptions): Promise<BeadListResult>;
  /** BD_GET_BEAD — fetch a single bead by id. */
  getBead(id: string): Promise<Bead>;
  /** BD_CLAIM — claim a bead and return the updated bead record. Passes ctx for audit. */
  claim(options: BeadClaimOptions, ctx?: unknown): Promise<Bead>;
  /** BD_RELEASE — release the lease on a bead. */
  release(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// WorktreePort — wraps CREATE_WORKTREE
// ---------------------------------------------------------------------------

export interface WorktreePort {
  /** CREATE_WORKTREE — provision a git worktree for the given bead. Passes ctx for audit. */
  createWorktree(beadId: string, ctx?: unknown): Promise<WorktreeResult>;
}

// ---------------------------------------------------------------------------
// TeammateSpawner — matches the public surface of TeammateFactory used by core
// ---------------------------------------------------------------------------

export interface TeammateSpawner {
  /** Spawn a teammate in a tmux pane for the given bead + state + worktree. */
  spawnTeammateInTmux(
    beadId: string,
    stateId: string,
    worktreePath: string,
    ctx?: unknown
  ): Promise<{ success: boolean; paneId?: string; error?: string }>;
  /** Return the live set of bead IDs that have an active teammate pane. */
  getLiveTeammateBeadIds(): Promise<Set<string>>;
  /** Return the count of currently active teammate panes. */
  getActiveTeammateCount(): Promise<number>;
  /** Return the number of available teammate slots. */
  getAvailableSlots(): Promise<number>;
  /** Terminate all teammate panes for a given bead. */
  terminateTeammatesForBead(beadId: string, reason: string): Promise<{ terminatedPaneIds: string[] }>;
  /**
   * Capture the visible pane text for all live tmux panes belonging to the
   * given bead, returning the concatenated, redacted output.  Reasoning blocks
   * are stripped before the text is returned; actionable lines (commands,
   * errors, tool names, bead/state IDs) are preserved.
   *
   * This is the harness-internal path through which pane content reaches
   * operator-facing monitoring artifacts (e.g. AGENT_TURN_FAILED evidence).
   * It never touches model inputs and requires no agent self-policing.
   *
   * Returns an empty string when no live pane is found for the bead or when
   * capture fails (errors are swallowed so callers always get a safe string).
   */
  captureBeadPaneText(beadId: string): Promise<string>;
}
