#!/usr/bin/env node
/**
 * artifact_validator — a COMMON, harness-OWNED built-in tool (pi-experiment-0yt5.22).
 *
 * This is the GENERIC artifact validator. It performs presence / structure /
 * shape checks ONLY. It has NO knowledge of any consumer's artifact schema:
 * there are NO hard-coded artifact names and NO consumer-specific
 * requirements-schema or solver logic here. Consumer-specific semantic
 * validation is shipped separately as that consumer's OWN verify() callbacks,
 * registered via the consumer extension — NOT in this module.
 *
 * Under the artifact-presence gate, this generic verify() is the central gate:
 * a transition declares the artifacts it requires (the names + PATHS arrive in
 * VerifyContext.artifacts). For EACH declared artifact path this tool checks,
 * purely from on-disk state, that the artifact is present and structurally
 * coherent (non-empty; if it looks like JSON it must parse). The producing
 * tool's own verify() handles the semantics — this tool only proves the
 * artifact exists and is well-formed enough to be a real artifact.
 *
 * Determinism: the verify() is PURE given a paths-only VerifyContext — it reads
 * each declared artifact path from disk and judges presence + generic shape. NO
 * LLM, NO network, NO subprocess. Same context ⇒ same verdict.
 *
 * This module imports ONLY the contract TYPES and node builtins — never any
 * consumer code.
 */
import { existsSync, statSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  VerifyVerdict,
  type VerifyContext,
  type VerifyResult
} from '../contract.js';

/** The tool name this built-in registers its verify() under. */
export const ARTIFACT_VALIDATOR_TOOL = 'artifact_validator';

/**
 * A single declared artifact's generic presence/shape outcome. Used internally
 * to fold the per-artifact checks into one transition-level verdict.
 */
type ArtifactCheck =
  | { name: string; outcome: 'absent'; reason: string }
  | { name: string; outcome: 'valid'; reason: string }
  | { name: string; outcome: 'malformed'; reason: string };

/**
 * Generic presence + shape check for ONE declared-artifact path. PURE: reads the
 * path from disk, decides from on-disk state only.
 *
 *   - absent    — no path recorded, path does not exist, or it is an empty file.
 *                 (An absent artifact means the producing tool did-not-run for
 *                 this artifact; the fold turns this into NOT_APPLICABLE.)
 *   - valid     — present, non-empty, and (if it looks like JSON) parses cleanly.
 *   - malformed — present but structurally invalid: whitespace-only despite a
 *                 non-zero size, or JSON-looking content that fails to parse.
 */
function checkArtifact(name: string, artifactPath: string): ArtifactCheck {
  if (!artifactPath) {
    return { name, outcome: 'absent', reason: `${name}: no artifact path recorded.` };
  }

  const absolute = resolve(artifactPath);
  if (!existsSync(absolute)) {
    return { name, outcome: 'absent', reason: `${name}: artifact path does not exist (${absolute}).` };
  }

  let stats;
  try {
    stats = statSync(absolute);
  } catch (error: unknown) {
    return {
      name,
      outcome: 'absent',
      reason: `${name}: artifact path is not readable (${error instanceof Error ? error.message : String(error)}).`
    };
  }

  if (!stats.isFile()) {
    return { name, outcome: 'malformed', reason: `${name}: artifact path is not a regular file.` };
  }

  if (stats.size === 0) {
    return { name, outcome: 'absent', reason: `${name}: artifact is an empty file (nothing produced).` };
  }

  let content: string;
  try {
    content = readFileSync(absolute, 'utf8');
  } catch (error: unknown) {
    return {
      name,
      outcome: 'malformed',
      reason: `${name}: artifact exists but could not be read (${error instanceof Error ? error.message : String(error)}).`
    };
  }

  const trimmed = content.trim();
  if (trimmed.length === 0) {
    // Non-zero on-disk size but whitespace-only content: incoherent artifact.
    return { name, outcome: 'malformed', reason: `${name}: artifact is whitespace-only despite a non-empty file.` };
  }

  // Generic JSON shape check: only enforced when the content LOOKS like JSON
  // (starts with '{' or '['). Non-JSON artifacts (plain text, source, etc.) are
  // accepted as valid on the non-empty check alone — this validator is generic
  // and makes no assumption that artifacts are JSON.
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(trimmed);
    } catch (error: unknown) {
      return {
        name,
        outcome: 'malformed',
        reason: `${name}: artifact looks like JSON but failed to parse (${error instanceof Error ? error.message : String(error)}).`
      };
    }
  }

  return { name, outcome: 'valid', reason: `${name}: present and well-formed (${stats.size} bytes).` };
}

// ---------------------------------------------------------------------------
// verify() — the harness-owned, deterministic GENERIC artifact judgement.
//
// VerifyContext is PATHS-ONLY: the declared-artifact name → PATH map arrives as
// ctx.artifacts. The verdict folds the per-artifact generic checks:
//   - NOT_APPLICABLE when NO declared artifact is present (none declared, or every
//     declared artifact is absent) — there is nothing for THIS generic gate to
//     judge; the producing tool did-not-run is surfaced elsewhere.
//   - FAIL when any present artifact is malformed (present-but-broken is a real
//     failure of this gate).
//   - PASS when at least one declared artifact is present and ALL present
//     artifacts are well-formed.
//
// NO hard-coded artifact names: it validates WHATEVER paths ctx.artifacts holds.
// ---------------------------------------------------------------------------

export function artifactValidatorVerify(ctx: VerifyContext): VerifyResult {
  const entries = Object.entries(ctx.artifacts ?? {});

  if (entries.length === 0) {
    return {
      verdict: VerifyVerdict.NOT_APPLICABLE,
      reasons: ['No artifacts were declared for this transition — generic artifact validation is not applicable.']
    };
  }

  const checks = entries.map(([name, artifactPath]) => checkArtifact(name, artifactPath));
  const malformed = checks.filter((c) => c.outcome === 'malformed');
  const valid = checks.filter((c) => c.outcome === 'valid');
  const absent = checks.filter((c) => c.outcome === 'absent');

  if (malformed.length > 0) {
    return {
      verdict: VerifyVerdict.FAIL,
      reasons: [
        ...malformed.map((c) => c.reason),
        ...valid.map((c) => c.reason),
        ...absent.map((c) => c.reason)
      ],
      failureOutcome: 'malformed declared artifact'
    };
  }

  if (valid.length === 0) {
    // Every declared artifact is absent — nothing present to validate.
    return {
      verdict: VerifyVerdict.NOT_APPLICABLE,
      reasons: absent.map((c) => c.reason)
    };
  }

  return {
    verdict: VerifyVerdict.PASS,
    reasons: [
      ...valid.map((c) => c.reason),
      ...absent.map((c) => c.reason)
    ]
  };
}
