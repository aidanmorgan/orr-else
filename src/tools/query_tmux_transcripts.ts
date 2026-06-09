/**
 * query_tmux_transcripts — tool-local RTK summary contract for the query_tmux_transcripts built-in.
 *
 * pi-experiment-6q0y.25 (producer-side)
 *
 * This module is the TOOL-LOCAL owner of the RTK summary for query_tmux_transcripts.
 * The harness validator enforces rtkSummary.owningFile === 'src/tools/query_tmux_transcripts.ts'.
 *
 * MODEL-FACING RESPONSE: the bounded tmux-transcript query result (metadata + lines).
 * The canonical handle is NOT included in the model-facing response.
 */

import { createHash } from 'node:crypto';
import type { ToolEvidenceRtkSummary } from '../core/ToolEvidenceHandle.js';

export const QUERY_TMUX_TRANSCRIPTS_TOOL_NAME = 'query_tmux_transcripts';

/**
 * QueryTmuxTranscriptsRtkSummary — compact, deterministic summary of a
 * query_tmux_transcripts invocation.
 */
export interface QueryTmuxTranscriptsRtkSummary {
  /** Whether the transcript was found. */
  found: boolean;
  /** Total lines in the (redacted) transcript, or 0 if not found. */
  totalLines: number;
  /** Whether the result was truncated or a search was capped. */
  capped: boolean;
}

export const QUERY_TMUX_TRANSCRIPTS_SCHEMA_DESCRIPTOR = {
  capped: 'boolean',
  found: 'boolean',
  totalLines: 'number',
} as const;

export function computeQueryTmuxTranscriptsSchemaHash(): string {
  const canonical = JSON.stringify(QUERY_TMUX_TRANSCRIPTS_SCHEMA_DESCRIPTOR);
  return 'sha256:' + createHash('sha256').update(canonical).digest('hex');
}

export const QUERY_TMUX_TRANSCRIPTS_SCHEMA_HASH: string = computeQueryTmuxTranscriptsSchemaHash();

/**
 * Build the tool-local RTK summary for a query_tmux_transcripts invocation.
 * Called from the registry factory in builtin_rtk_registry.ts.
 */
export function buildQueryTmuxTranscriptsRtkSummary(params: {
  result: unknown;
}): ToolEvidenceRtkSummary {
  let found = false;
  let totalLines = 0;
  let capped = false;

  const result = params.result;
  if (result !== null && result !== undefined && typeof result === 'object') {
    const rec = result as Record<string, unknown>;
    found = rec.status === 'found' || rec.status === 'search';
    if (found && typeof rec.metadata === 'object' && rec.metadata !== null) {
      const meta = rec.metadata as Record<string, unknown>;
      if (typeof meta.totalLines === 'number') totalLines = meta.totalLines;
    }
    capped = rec.truncated === true || rec.capped === true;
  }

  const summary: QueryTmuxTranscriptsRtkSummary = { found, totalLines, capped };
  return {
    schemaTypeName: 'QueryTmuxTranscriptsRtkSummary',
    owningFile: 'src/tools/query_tmux_transcripts.ts',
    summarySchemaVersion: '1.0.0',
    schemaHash: QUERY_TMUX_TRANSCRIPTS_SCHEMA_HASH,
    deterministicSummaryVersion: '1.0.0',
    inputArtifactSchemaId: 'tmux-transcript-query-result',
    inputArtifactSchemaVersion: '1.0.0',
    maximumCounts: {},
    omissionSemantics: 'query_tmux_transcripts returns a bounded pane window; full transcripts live in .pi/logs/tmux/',
    summary: summary as unknown as Record<string, unknown>,
  };
}
