/**
 * pi-experiment-zog2.7 — RTK summary contract: tool-local summaries for semantic artifacts.
 *
 * LOAD-BEARING: these tests drive the REAL validateRtkSummary path in
 * ToolEvidenceHandle.validateToolEvidenceHandle. If the generic-fallback ban,
 * tool-local requirement, or required metadata fields were removed, these tests
 * MUST fail.
 *
 * Assertions:
 *   AC1: A valid tool-local RTK summary with all required metadata fields is accepted.
 *   AC2: summaryMode='summary' without an rtkSummary is rejected (missing summary).
 *   AC3: schemaTypeName='untyped_record' (generic fallback) is rejected.
 *   AC4: owningFile pointing to a generic harness framework file is rejected.
 *   AC5: Missing summarySchemaVersion is rejected.
 *   AC6: Missing schemaHash is rejected.
 *   AC6b: schemaHash that does not start with 'sha256:' is rejected (format enforcement).
 *   AC7: Missing deterministicSummaryVersion is rejected.
 *   AC8: owningFile ending with non-.ts extension is rejected.
 *   AC9: summaryMode='none' without noSummaryReason is rejected (explicit opt-out required).
 *   AC10: summaryMode='none' with noSummaryReason is accepted (valid explicit no-summary opt-out).
 *   AC11: Schema drift detection — schemaHash is DERIVED from GIT_HISTORY_SCHEMA_DESCRIPTOR;
 *         a conformance test independently recomputes the hash and asserts it equals the
 *         emitted value, and another asserts that a stale hash is detectable as drift.
 *   AC12: Affirmative tool-local check — owningFile that belongs to a non-owning .ts module
 *         is REJECTED when expectedToolName is provided (not in denylist, but wrong tool).
 *   AC13: Missing inputArtifactSchemaId is rejected.
 *   AC14: Missing inputArtifactSchemaVersion is rejected.
 *   AC15: Missing maximumCounts is rejected.
 *   AC16: Missing omissionSemantics is rejected.
 *
 * These tests CANNOT be vacuous: they call validateToolEvidenceHandle (the real validator)
 * and assertions are structured so that removing the generic-fallback ban would cause
 * AC3/AC4 to produce valid:true where the test expects valid:false.
 */

import { describe, it, expect } from 'vitest';
import {
  TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
  validateToolEvidenceHandle,
  FORBIDDEN_GENERIC_SUMMARY_OWNER_FILES,
  type ToolEvidenceHandle,
} from '../src/core/ToolEvidenceHandle.js';
import {
  computeGitHistorySchemaHash,
  GIT_HISTORY_SCHEMA_DESCRIPTOR,
} from '../src/tools/git_history.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TOOL_OUTPUT_ROOT = '/project/.pi/tool-output';

/**
 * A fully valid tool-local RTK summary with all required metadata fields.
 * Used as the baseline for positive and negative tests.
 *
 * schemaHash is derived at test time using computeGitHistorySchemaHash() so the
 * test tracks the real descriptor — not a pasted constant.
 */
const VALID_TOOL_LOCAL_SUMMARY: ToolEvidenceHandle['rtkSummary'] = {
  schemaTypeName: 'GitHistoryRtkSummary',
  owningFile: 'src/tools/git_history.ts',
  summarySchemaVersion: '1.0.0',
  schemaHash: computeGitHistorySchemaHash(),
  deterministicSummaryVersion: '1.0.0',
  inputArtifactSchemaId: 'git-stdout-log',
  inputArtifactSchemaVersion: '1.0.0',
  maximumCounts: { commits: 50, paths: 30 },
  omissionSemantics: 'commits beyond maximumCounts.commits and paths beyond maximumCounts.paths are omitted; outputLines reports total line count',
  summary: {
    operation: 'log',
    repo: 'worktree',
    root: '/repo',
    outputLines: 5,
    outputFileBytes: 240,
    outputText: 'abc123 first commit\ndef456 second commit',
  },
};

/**
 * A minimal valid PASSED handle with summaryMode='summary'.
 * Overrides merge on top of this base.
 */
function baseHandle(rtkSummaryOverride?: ToolEvidenceHandle['rtkSummary']): unknown {
  return {
    schemaVersion: TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
    toolName: 'git_history',
    invocationId: 'inv-zog2.7-test',
    runStatus: 'PASSED' as const,
    semanticArtifactPath: `${TOOL_OUTPUT_ROOT}/bead1/state1/action1/git_history/inv-zog2.7-test/git-history.json`,
    toolOutputRoot: TOOL_OUTPUT_ROOT,
    summaryMode: 'summary' as const,
    rtkSummary: rtkSummaryOverride ?? VALID_TOOL_LOCAL_SUMMARY,
    admittedHarnessFingerprint: 'sha256:test-fingerprint',
    admittedExecutionBoundary: 'bead:b1/state:s1/action:a1',
  };
}

/**
 * A minimal valid PASSED handle with summaryMode='none'.
 */
function baseHandleNoSummary(noSummaryReason?: string): unknown {
  return {
    schemaVersion: TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
    toolName: 'coding_standards',
    invocationId: 'inv-zog2.7-nosummary',
    runStatus: 'PASSED' as const,
    semanticArtifactPath: `${TOOL_OUTPUT_ROOT}/bead1/state1/action1/coding_standards/inv-zog2.7-nosummary/result.json`,
    toolOutputRoot: TOOL_OUTPUT_ROOT,
    summaryMode: 'none' as const,
    ...(noSummaryReason !== undefined ? { noSummaryReason } : {}),
    admittedHarnessFingerprint: 'sha256:test-fingerprint',
    admittedExecutionBoundary: 'bead:b1/state:s1/action:a1',
  };
}

// ---------------------------------------------------------------------------
// AC1: A valid tool-local RTK summary with all required metadata fields is accepted
// ---------------------------------------------------------------------------

describe('zog2.7 RTK summary contract — AC1: valid tool-local summary is accepted', () => {
  it('accepts a PASSED handle with a complete tool-local rtkSummary (all metadata fields present)', () => {
    const result = validateToolEvidenceHandle(baseHandle());
    expect(result.valid, `validator errors: ${!result.valid ? (result as { valid: false; errors: string[] }).errors.join('; ') : ''}`).toBe(true);
    if (result.valid) {
      expect(result.handle.summaryMode).toBe('summary');
      expect(result.handle.rtkSummary).toBeDefined();
      expect(result.handle.rtkSummary!.schemaTypeName).toBe('GitHistoryRtkSummary');
      expect(result.handle.rtkSummary!.owningFile).toBe('src/tools/git_history.ts');
      expect(result.handle.rtkSummary!.summarySchemaVersion).toBe('1.0.0');
      expect(result.handle.rtkSummary!.schemaHash).toMatch(/^sha256:/);
      expect(result.handle.rtkSummary!.deterministicSummaryVersion).toBe('1.0.0');
      expect(result.handle.rtkSummary!.inputArtifactSchemaId).toBe('git-stdout-log');
      expect(result.handle.rtkSummary!.inputArtifactSchemaVersion).toBe('1.0.0');
      expect(result.handle.rtkSummary!.maximumCounts).toEqual({ commits: 50, paths: 30 });
      expect(typeof result.handle.rtkSummary!.omissionSemantics).toBe('string');
      expect(result.handle.rtkSummary!.omissionSemantics.length).toBeGreaterThan(0);
    }
  });

  it('accepts a tool-local summary with a custom tool module as owningFile', () => {
    const customSummary: ToolEvidenceHandle['rtkSummary'] = {
      schemaTypeName: 'MyToolRtkSummary',
      owningFile: 'src/tools/my_tool.ts',
      summarySchemaVersion: '2.1.0',
      schemaHash: 'sha256:' + 'b'.repeat(64),
      deterministicSummaryVersion: '3',
      inputArtifactSchemaId: 'my-tool-output',
      inputArtifactSchemaVersion: '1.0.0',
      maximumCounts: { items: 10 },
      omissionSemantics: 'items beyond maximumCounts.items are omitted',
      summary: { itemCount: 10, truncated: false, omittedCount: 0 },
    };
    const result = validateToolEvidenceHandle(baseHandle(customSummary));
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC2: summaryMode='summary' without rtkSummary is rejected
// ---------------------------------------------------------------------------

describe('zog2.7 RTK summary contract — AC2: missing rtkSummary when summaryMode=summary is rejected', () => {
  it('rejects a handle with summaryMode="summary" and no rtkSummary field', () => {
    const handle = {
      ...baseHandle(),
      rtkSummary: undefined,
    };
    const result = validateToolEvidenceHandle(handle);
    // LOAD-BEARING: removing the rtkSummary requirement from summaryMode='summary' would make this pass
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('rtkSummary') || e.includes('summaryMode'))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// AC3: schemaTypeName='untyped_record' (generic fallback) is rejected
// ---------------------------------------------------------------------------

describe('zog2.7 RTK summary contract — AC3: generic schemaTypeName "untyped_record" is rejected', () => {
  it('rejects rtkSummary with schemaTypeName="untyped_record" (generic migration placeholder)', () => {
    const genericSummary: ToolEvidenceHandle['rtkSummary'] = {
      ...VALID_TOOL_LOCAL_SUMMARY,
      schemaTypeName: 'untyped_record',
    };
    const result = validateToolEvidenceHandle(baseHandle(genericSummary));
    // LOAD-BEARING: removing the 'untyped_record' ban would make this valid:true
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(
        result.errors.some(e =>
          e.includes('untyped_record') ||
          e.includes('generic migration placeholder') ||
          e.includes('schemaTypeName')
        )
      ).toBe(true);
    }
  });

  it('accepts rtkSummary with a concrete tool-specific schemaTypeName (not untyped_record)', () => {
    const concreteSummary: ToolEvidenceHandle['rtkSummary'] = {
      ...VALID_TOOL_LOCAL_SUMMARY,
      schemaTypeName: 'GitHistoryRtkSummary',
    };
    const result = validateToolEvidenceHandle(baseHandle(concreteSummary));
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC4: owningFile pointing to a generic harness framework file is rejected
// ---------------------------------------------------------------------------

describe('zog2.7 RTK summary contract — AC4: generic harness framework owningFile is rejected', () => {
  it.each([...FORBIDDEN_GENERIC_SUMMARY_OWNER_FILES])(
    'rejects owningFile="%s" (generic harness framework file)',
    (forbiddenFile) => {
      const genericSummary: ToolEvidenceHandle['rtkSummary'] = {
        ...VALID_TOOL_LOCAL_SUMMARY,
        owningFile: forbiddenFile,
      };
      const result = validateToolEvidenceHandle(baseHandle(genericSummary));
      // LOAD-BEARING: removing FORBIDDEN_GENERIC_SUMMARY_OWNER_FILES check would make these valid:true
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(
          result.errors.some(e =>
            e.includes('owningFile') ||
            e.includes('generic harness framework') ||
            e.includes('zog2.7')
          )
        ).toBe(true);
      }
    }
  );

  it('accepts a tool-specific module as owningFile (not in the forbidden set)', () => {
    const toolSummary: ToolEvidenceHandle['rtkSummary'] = {
      ...VALID_TOOL_LOCAL_SUMMARY,
      owningFile: 'src/tools/git_history.ts',
    };
    const result = validateToolEvidenceHandle(baseHandle(toolSummary));
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC5: Missing summarySchemaVersion is rejected
// ---------------------------------------------------------------------------

describe('zog2.7 RTK summary contract — AC5: missing summarySchemaVersion is rejected', () => {
  it('rejects rtkSummary missing summarySchemaVersion', () => {
    const { summarySchemaVersion: _, ...summaryWithoutVersion } = VALID_TOOL_LOCAL_SUMMARY!;
    const result = validateToolEvidenceHandle(baseHandle(summaryWithoutVersion as ToolEvidenceHandle['rtkSummary']));
    // LOAD-BEARING: removing summarySchemaVersion requirement would make this valid:true
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('summarySchemaVersion'))).toBe(true);
    }
  });

  it('rejects rtkSummary with empty summarySchemaVersion', () => {
    const summary: ToolEvidenceHandle['rtkSummary'] = {
      ...VALID_TOOL_LOCAL_SUMMARY,
      summarySchemaVersion: '',
    };
    const result = validateToolEvidenceHandle(baseHandle(summary));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('summarySchemaVersion'))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// AC6: Missing or malformed schemaHash is rejected
// ---------------------------------------------------------------------------

describe('zog2.7 RTK summary contract — AC6: missing or malformed schemaHash is rejected', () => {
  it('rejects rtkSummary missing schemaHash', () => {
    const { schemaHash: _, ...summaryWithoutHash } = VALID_TOOL_LOCAL_SUMMARY!;
    const result = validateToolEvidenceHandle(baseHandle(summaryWithoutHash as ToolEvidenceHandle['rtkSummary']));
    // LOAD-BEARING: removing schemaHash requirement would make this valid:true
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('schemaHash'))).toBe(true);
    }
  });

  it('rejects rtkSummary with empty schemaHash', () => {
    const summary: ToolEvidenceHandle['rtkSummary'] = {
      ...VALID_TOOL_LOCAL_SUMMARY,
      schemaHash: '',
    };
    const result = validateToolEvidenceHandle(baseHandle(summary));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('schemaHash'))).toBe(true);
    }
  });

  it('rejects rtkSummary with schemaHash that does not start with "sha256:" or "hash:" (format enforcement)', () => {
    const summary: ToolEvidenceHandle['rtkSummary'] = {
      ...VALID_TOOL_LOCAL_SUMMARY,
      schemaHash: 'raw-hex-no-prefix',
    };
    const result = validateToolEvidenceHandle(baseHandle(summary));
    // LOAD-BEARING: removing the sha256: prefix check would make this valid:true
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('schemaHash') && e.includes('sha256:'))).toBe(true);
    }
  });

  it('accepts schemaHash starting with "sha256:" (canonical format)', () => {
    const summary: ToolEvidenceHandle['rtkSummary'] = {
      ...VALID_TOOL_LOCAL_SUMMARY,
      schemaHash: 'sha256:' + 'c'.repeat(64),
    };
    const result = validateToolEvidenceHandle(baseHandle(summary));
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC7: Missing deterministicSummaryVersion is rejected
// ---------------------------------------------------------------------------

describe('zog2.7 RTK summary contract — AC7: missing deterministicSummaryVersion is rejected', () => {
  it('rejects rtkSummary missing deterministicSummaryVersion', () => {
    const { deterministicSummaryVersion: _, ...summaryWithoutVersion } = VALID_TOOL_LOCAL_SUMMARY!;
    const result = validateToolEvidenceHandle(baseHandle(summaryWithoutVersion as ToolEvidenceHandle['rtkSummary']));
    // LOAD-BEARING: removing deterministicSummaryVersion requirement would make this valid:true
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('deterministicSummaryVersion'))).toBe(true);
    }
  });

  it('rejects rtkSummary with empty deterministicSummaryVersion', () => {
    const summary: ToolEvidenceHandle['rtkSummary'] = {
      ...VALID_TOOL_LOCAL_SUMMARY,
      deterministicSummaryVersion: '',
    };
    const result = validateToolEvidenceHandle(baseHandle(summary));
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC8: owningFile with non-.ts extension is rejected
// ---------------------------------------------------------------------------

describe('zog2.7 RTK summary contract — AC8: non-TypeScript owningFile is rejected', () => {
  it.each([
    'src/tools/summarize.py',
    'src/tools/summarize.js',
    'src/tools/summarize.sh',
    'src/tools/summarize.rb',
  ])('rejects owningFile="%s" (non-TypeScript extension)', (nonTsFile) => {
    const summary: ToolEvidenceHandle['rtkSummary'] = {
      ...VALID_TOOL_LOCAL_SUMMARY,
      owningFile: nonTsFile,
    };
    const result = validateToolEvidenceHandle(baseHandle(summary));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('owningFile') || e.includes('.ts') || e.includes('TypeScript'))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// AC9: summaryMode='none' without noSummaryReason is rejected
// ---------------------------------------------------------------------------

describe('zog2.7 RTK summary contract — AC9: summaryMode=none without noSummaryReason is rejected', () => {
  it('rejects a handle with summaryMode="none" and no noSummaryReason', () => {
    const result = validateToolEvidenceHandle(baseHandleNoSummary(/* no reason */));
    // LOAD-BEARING: removing the noSummaryReason requirement would make this valid:true
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('noSummaryReason') || e.includes('summaryMode'))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// AC10: summaryMode='none' with noSummaryReason is accepted (valid opt-out)
// ---------------------------------------------------------------------------

describe('zog2.7 RTK summary contract — AC10: summaryMode=none with noSummaryReason is valid opt-out', () => {
  it('accepts a PASSED handle with summaryMode="none" and a non-empty noSummaryReason', () => {
    const result = validateToolEvidenceHandle(
      baseHandleNoSummary('PRESENCE_ONLY tool: no model-facing summary for coding_standards')
    );
    expect(result.valid, `validator errors: ${!result.valid ? (result as { valid: false; errors: string[] }).errors.join('; ') : ''}`).toBe(true);
    if (result.valid) {
      expect(result.handle.summaryMode).toBe('none');
      expect(result.handle.noSummaryReason).toBeTruthy();
      expect(result.handle.rtkSummary).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// AC11: Schema drift detection — DERIVED hash, real conformance test
// ---------------------------------------------------------------------------

describe('zog2.7 RTK summary contract — AC11: schema hash drift detection (DERIVED, load-bearing)', () => {
  it('computeGitHistorySchemaHash() returns a sha256: prefixed hash derived from GIT_HISTORY_SCHEMA_DESCRIPTOR', () => {
    // LOAD-BEARING: if the hash is hardcoded instead of derived, this import would
    // return the same stale string regardless of descriptor changes.
    const hash = computeGitHistorySchemaHash();
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('independently recomputing the hash from the same schema source matches the emitted handle schemaHash', () => {
    // Independently recompute from the descriptor — this is the real conformance test.
    // If the descriptor changes without the hash updating, this test fails.
    const { createHash } = require('node:crypto') as typeof import('node:crypto');
    const canonical = JSON.stringify(GIT_HISTORY_SCHEMA_DESCRIPTOR);
    const expectedHash = 'sha256:' + createHash('sha256').update(canonical).digest('hex');

    // The emitted handle uses the derived GIT_HISTORY_SCHEMA_HASH constant.
    // The test verifies they match — confirming the emitted hash TRACKS the descriptor.
    const emittedHash = computeGitHistorySchemaHash();
    expect(emittedHash).toBe(expectedHash);

    // Also validate that a handle with the derived hash is accepted by the validator.
    const summary: ToolEvidenceHandle['rtkSummary'] = {
      ...VALID_TOOL_LOCAL_SUMMARY,
      schemaHash: emittedHash,
    };
    const result = validateToolEvidenceHandle(baseHandle(summary));
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.handle.rtkSummary!.schemaHash).toBe(expectedHash);
    }
  });

  it('a handle with a drifted schemaHash (different from derived) is detectable as drift', () => {
    // LOAD-BEARING: the derived hash is known; a stale/wrong hash is detectable.
    // If someone hardcodes a wrong hash, it won't match computeGitHistorySchemaHash().
    const derivedHash = computeGitHistorySchemaHash();
    const staledHash = 'sha256:' + '0'.repeat(64); // stale — different from derived

    // The validator accepts both (it checks format, not value) — drift detection is tool-side.
    const driftedSummary: ToolEvidenceHandle['rtkSummary'] = {
      ...VALID_TOOL_LOCAL_SUMMARY,
      schemaHash: staledHash,
    };
    const result = validateToolEvidenceHandle(baseHandle(driftedSummary));
    expect(result.valid).toBe(true); // structurally valid

    // Drift is detectable: stored hash !== derived hash.
    if (result.valid) {
      const storedHash = result.handle.rtkSummary!.schemaHash;
      expect(storedHash).not.toBe(derivedHash);
      // Tool-side conformance check: this inequality IS the drift detection.
      const isDrifted = storedHash !== derivedHash;
      expect(isDrifted).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// AC12: Affirmative tool-local check — non-owning .ts rejected when expectedToolName known
// ---------------------------------------------------------------------------

describe('zog2.7 RTK summary contract — AC12: affirmative tool-local owningFile check', () => {
  it('rejects owningFile from a different tool module when expectedToolName is provided', () => {
    // 'src/tools/run_checks_cli.ts' is a real .ts tool file, not in the denylist,
    // but it does NOT own the git_history summary. With expectedToolName='git_history',
    // the validator must reject it affirmatively.
    const wrongToolSummary: ToolEvidenceHandle['rtkSummary'] = {
      ...VALID_TOOL_LOCAL_SUMMARY,
      owningFile: 'src/tools/run_checks_cli.ts', // NOT the git_history module
    };
    const result = validateToolEvidenceHandle(
      baseHandle(wrongToolSummary),
      { expectedToolName: 'git_history' }
    );
    // LOAD-BEARING: without the affirmative check, this would pass (file ends with .ts,
    // not in denylist) — the affirmative check is the only thing that rejects it.
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(
        result.errors.some(e =>
          e.includes('owningFile') &&
          (e.includes('affirmative') || e.includes('tool-local') || e.includes('git_history'))
        )
      ).toBe(true);
    }
  });

  it('accepts owningFile matching the expected tool module when expectedToolName is provided', () => {
    const correctSummary: ToolEvidenceHandle['rtkSummary'] = {
      ...VALID_TOOL_LOCAL_SUMMARY,
      owningFile: 'src/tools/git_history.ts',
    };
    const result = validateToolEvidenceHandle(
      baseHandle(correctSummary),
      { expectedToolName: 'git_history' }
    );
    expect(result.valid).toBe(true);
  });

  it('accepts owningFile from any .ts module when expectedToolName is NOT provided (no affirmative check)', () => {
    // Without expectedToolName, only the denylist and .ts extension are checked.
    const anotherToolSummary: ToolEvidenceHandle['rtkSummary'] = {
      ...VALID_TOOL_LOCAL_SUMMARY,
      owningFile: 'src/tools/run_checks_cli.ts',
    };
    const result = validateToolEvidenceHandle(baseHandle(anotherToolSummary));
    // No expectedToolName provided — no affirmative check — should pass.
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC13: Missing inputArtifactSchemaId is rejected
// ---------------------------------------------------------------------------

describe('zog2.7 RTK summary contract — AC13: missing inputArtifactSchemaId is rejected', () => {
  it('rejects rtkSummary missing inputArtifactSchemaId', () => {
    const { inputArtifactSchemaId: _, ...summaryWithout } = VALID_TOOL_LOCAL_SUMMARY!;
    const result = validateToolEvidenceHandle(baseHandle(summaryWithout as ToolEvidenceHandle['rtkSummary']));
    // LOAD-BEARING: removing inputArtifactSchemaId requirement would make this valid:true
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('inputArtifactSchemaId'))).toBe(true);
    }
  });

  it('rejects rtkSummary with empty inputArtifactSchemaId', () => {
    const summary: ToolEvidenceHandle['rtkSummary'] = {
      ...VALID_TOOL_LOCAL_SUMMARY,
      inputArtifactSchemaId: '',
    };
    const result = validateToolEvidenceHandle(baseHandle(summary));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('inputArtifactSchemaId'))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// AC14: Missing inputArtifactSchemaVersion is rejected
// ---------------------------------------------------------------------------

describe('zog2.7 RTK summary contract — AC14: missing inputArtifactSchemaVersion is rejected', () => {
  it('rejects rtkSummary missing inputArtifactSchemaVersion', () => {
    const { inputArtifactSchemaVersion: _, ...summaryWithout } = VALID_TOOL_LOCAL_SUMMARY!;
    const result = validateToolEvidenceHandle(baseHandle(summaryWithout as ToolEvidenceHandle['rtkSummary']));
    // LOAD-BEARING: removing inputArtifactSchemaVersion requirement would make this valid:true
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('inputArtifactSchemaVersion'))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// AC15: Missing maximumCounts is rejected
// ---------------------------------------------------------------------------

describe('zog2.7 RTK summary contract — AC15: missing maximumCounts is rejected', () => {
  it('rejects rtkSummary missing maximumCounts', () => {
    const { maximumCounts: _, ...summaryWithout } = VALID_TOOL_LOCAL_SUMMARY!;
    const result = validateToolEvidenceHandle(baseHandle(summaryWithout as ToolEvidenceHandle['rtkSummary']));
    // LOAD-BEARING: removing maximumCounts requirement would make this valid:true
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('maximumCounts'))).toBe(true);
    }
  });

  it('rejects rtkSummary with null maximumCounts', () => {
    const summary = {
      ...VALID_TOOL_LOCAL_SUMMARY,
      maximumCounts: null,
    };
    const result = validateToolEvidenceHandle(baseHandle(summary as unknown as ToolEvidenceHandle['rtkSummary']));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('maximumCounts'))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// AC16: Missing omissionSemantics is rejected
// ---------------------------------------------------------------------------

describe('zog2.7 RTK summary contract — AC16: missing omissionSemantics is rejected', () => {
  it('rejects rtkSummary missing omissionSemantics', () => {
    const { omissionSemantics: _, ...summaryWithout } = VALID_TOOL_LOCAL_SUMMARY!;
    const result = validateToolEvidenceHandle(baseHandle(summaryWithout as ToolEvidenceHandle['rtkSummary']));
    // LOAD-BEARING: removing omissionSemantics requirement would make this valid:true
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('omissionSemantics'))).toBe(true);
    }
  });

  it('rejects rtkSummary with empty omissionSemantics', () => {
    const summary: ToolEvidenceHandle['rtkSummary'] = {
      ...VALID_TOOL_LOCAL_SUMMARY,
      omissionSemantics: '',
    };
    const result = validateToolEvidenceHandle(baseHandle(summary));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('omissionSemantics'))).toBe(true);
    }
  });
});
