import { describe, expect, it } from 'vitest';
import {
  digestStableBlock,
  digestIdentity,
  BOOTSTRAP_INPUT_TOKEN_BUDGET,
  DIGEST_ID_LENGTH,
  TOKEN_ESTIMATE_DIVISOR,
  type StableBootstrapInputs
} from '../src/core/BootstrapDigest.js';
import { ContextInjector, type PromptContext } from '../src/core/ContextInjector.js';
import type { BeadId } from '../src/types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIdentity(overrides: Partial<StableBootstrapInputs> = {}): StableBootstrapInputs {
  return {
    projectRoot: '/home/user/project',
    configIdentity: '/home/user/project/harness.yaml',
    stateId: 'Planning',
    toolNames: ['spawn_teammate', 'bd_get_bead'],
    skillNames: ['quality', 'planner'],
    ruleCategories: ['general', 'security'],
    protocolLabel: 'ORR_ELSE_PROTOCOL_v1',
    ...overrides
  };
}

const SAMPLE_STABLE_TEXT = '### SYSTEM CONTEXT\nPROJECT_ROOT: /home/user/project\n\n### ROLE INSTRUCTIONS\nYou are a planner.';

// Minimal PromptContext that produces a deterministic prompt via ContextInjector.
function makeContext(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    beadId: 'pi-experiment-test-bead' as BeadId,
    projectRoot: '/home/user/project',
    workdir: '/home/user/project/worktrees/bead-1',
    configPath: '/home/user/project/harness.yaml',
    actionId: 'plan',
    identity: 'planner',
    phase: 'Planning',
    llmProvider: 'anthropic',
    llmModel: 'claude-sonnet-4-6',
    compatibilityMode: 'none',
    skillPaths: ['/home/user/project/.pi/skills/quality/SKILL.md', '/home/user/project/.pi/skills/planner/SKILL.md'],
    rulePaths: ['/home/user/project/.pi/rules/general.md', '/home/user/project/.pi/rules/security.md'],
    outstandingChecklist: 'None provided.',
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Exported constant shapes
// ---------------------------------------------------------------------------

describe('exported tuning constants', () => {
  it('DIGEST_ID_LENGTH is a positive integer', () => {
    expect(DIGEST_ID_LENGTH).toBeGreaterThan(0);
    expect(Number.isInteger(DIGEST_ID_LENGTH)).toBe(true);
  });

  it('TOKEN_ESTIMATE_DIVISOR equals 4 (standard chars-per-token heuristic)', () => {
    expect(TOKEN_ESTIMATE_DIVISOR).toBe(4);
  });

  it('BOOTSTRAP_INPUT_TOKEN_BUDGET is a positive number', () => {
    expect(BOOTSTRAP_INPUT_TOKEN_BUDGET).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// digestStableBlock — determinism
// ---------------------------------------------------------------------------

describe('digestStableBlock — determinism', () => {
  it('produces the same digestId for identical identity + text called twice', () => {
    const identity = makeIdentity();
    const a = digestStableBlock(SAMPLE_STABLE_TEXT, identity);
    const b = digestStableBlock(SAMPLE_STABLE_TEXT, identity);
    expect(a.digestId).toBe(b.digestId);
  });

  it('digestId is a hex string of length DIGEST_ID_LENGTH', () => {
    const { digestId } = digestStableBlock(SAMPLE_STABLE_TEXT, makeIdentity());
    expect(digestId).toMatch(/^[0-9a-f]+$/);
    expect(digestId).toHaveLength(DIGEST_ID_LENGTH);
  });

  it('tool/skill arrays are order-independent — sorted before hashing', () => {
    const a = digestStableBlock(SAMPLE_STABLE_TEXT, makeIdentity({ toolNames: ['bd_get_bead', 'spawn_teammate'], skillNames: ['planner', 'quality'] }));
    const b = digestStableBlock(SAMPLE_STABLE_TEXT, makeIdentity({ toolNames: ['spawn_teammate', 'bd_get_bead'], skillNames: ['quality', 'planner'] }));
    expect(a.digestId).toBe(b.digestId);
  });
});

// ---------------------------------------------------------------------------
// digestStableBlock — stable-input sensitivity
// ---------------------------------------------------------------------------

describe('digestStableBlock — stable-input sensitivity', () => {
  it('changing stateId produces a different digestId', () => {
    const a = digestStableBlock(SAMPLE_STABLE_TEXT, makeIdentity({ stateId: 'Planning' }));
    const b = digestStableBlock(SAMPLE_STABLE_TEXT, makeIdentity({ stateId: 'Implementing' }));
    expect(a.digestId).not.toBe(b.digestId);
  });

  it('changing toolNames produces a different digestId', () => {
    const a = digestStableBlock(SAMPLE_STABLE_TEXT, makeIdentity({ toolNames: ['tool-A'] }));
    const b = digestStableBlock(SAMPLE_STABLE_TEXT, makeIdentity({ toolNames: ['tool-B'] }));
    expect(a.digestId).not.toBe(b.digestId);
  });

  it('changing the stable text produces a different digestId (text is part of the hash)', () => {
    const a = digestStableBlock('### SYSTEM CONTEXT\nPROJECT_ROOT: /proj/alpha', makeIdentity());
    const b = digestStableBlock('### SYSTEM CONTEXT\nPROJECT_ROOT: /proj/beta', makeIdentity());
    expect(a.digestId).not.toBe(b.digestId);
  });

  it('changing projectRoot produces a different digestId', () => {
    const a = digestStableBlock(SAMPLE_STABLE_TEXT, makeIdentity({ projectRoot: '/proj/alpha' }));
    const b = digestStableBlock(SAMPLE_STABLE_TEXT, makeIdentity({ projectRoot: '/proj/beta' }));
    expect(a.digestId).not.toBe(b.digestId);
  });

  it('adding a ruleCategory produces a different digestId', () => {
    const a = digestStableBlock(SAMPLE_STABLE_TEXT, makeIdentity({ ruleCategories: [] }));
    const b = digestStableBlock(SAMPLE_STABLE_TEXT, makeIdentity({ ruleCategories: ['security'] }));
    expect(a.digestId).not.toBe(b.digestId);
  });
});

// ---------------------------------------------------------------------------
// digestStableBlock — size metrics and overBudget flag
// ---------------------------------------------------------------------------

describe('digestStableBlock — size metrics', () => {
  it('byteLength matches the UTF-8 byte length of the input stable text', () => {
    const result = digestStableBlock(SAMPLE_STABLE_TEXT, makeIdentity());
    expect(result.byteLength).toBe(Buffer.byteLength(SAMPLE_STABLE_TEXT, 'utf8'));
  });

  it('estimatedTokens equals ceil(byteLength / TOKEN_ESTIMATE_DIVISOR)', () => {
    const result = digestStableBlock(SAMPLE_STABLE_TEXT, makeIdentity());
    expect(result.estimatedTokens).toBe(Math.ceil(result.byteLength / TOKEN_ESTIMATE_DIVISOR));
  });

  it('overBudget is false when the text is within the default budget', () => {
    const result = digestStableBlock(SAMPLE_STABLE_TEXT, makeIdentity());
    expect(result.overBudget).toBe(false);
  });

  it('overBudget trips when estimatedTokens exceeds a tiny budget override', () => {
    const result = digestStableBlock(SAMPLE_STABLE_TEXT, makeIdentity(), 1);
    expect(result.overBudget).toBe(true);
    expect(result.estimatedTokens).toBeGreaterThan(1);
  });

  it('overBudget is false when estimatedTokens exactly equals the budget', () => {
    const result = digestStableBlock(SAMPLE_STABLE_TEXT, makeIdentity());
    const exact = digestStableBlock(SAMPLE_STABLE_TEXT, makeIdentity(), result.estimatedTokens);
    expect(exact.overBudget).toBe(false);
  });

  it('overBudget is true when estimatedTokens is one above the budget override', () => {
    const result = digestStableBlock(SAMPLE_STABLE_TEXT, makeIdentity());
    const justUnder = digestStableBlock(SAMPLE_STABLE_TEXT, makeIdentity(), result.estimatedTokens - 1);
    expect(justUnder.overBudget).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// digestIdentity — lightweight identity-only hash for spawn audit
// ---------------------------------------------------------------------------

describe('digestIdentity', () => {
  it('produces a hex string of length DIGEST_ID_LENGTH', () => {
    const id = digestIdentity(makeIdentity());
    expect(id).toMatch(/^[0-9a-f]+$/);
    expect(id).toHaveLength(DIGEST_ID_LENGTH);
  });

  it('is deterministic: same identity → same digestId', () => {
    const a = digestIdentity(makeIdentity());
    const b = digestIdentity(makeIdentity());
    expect(a).toBe(b);
  });

  it('is order-independent for arrays', () => {
    const a = digestIdentity(makeIdentity({ toolNames: ['b', 'a'], skillNames: ['q', 'p'] }));
    const b = digestIdentity(makeIdentity({ toolNames: ['a', 'b'], skillNames: ['p', 'q'] }));
    expect(a).toBe(b);
  });

  it('changes when stateId changes', () => {
    const a = digestIdentity(makeIdentity({ stateId: 'Planning' }));
    const b = digestIdentity(makeIdentity({ stateId: 'Implementing' }));
    expect(a).not.toBe(b);
  });

  it('differs from digestStableBlock digestId for the same identity (text is not mixed in)', () => {
    const id = digestIdentity(makeIdentity());
    const { digestId } = digestStableBlock(SAMPLE_STABLE_TEXT, makeIdentity());
    // digestStableBlock mixes identity + text, so the IDs should differ.
    expect(id).not.toBe(digestId);
  });
});

// ---------------------------------------------------------------------------
// Integration: ContextInjector.injectWithDigest — stable block leads the prompt
// ---------------------------------------------------------------------------

describe('ContextInjector.injectWithDigest — integration', () => {
  const injector = new ContextInjector();

  it('assembled prompt STARTS WITH the stable block', () => {
    const context = makeContext();
    const identity = makeIdentity();
    const result = injector.injectWithDigest('You are a planner.', context, identity);

    expect(result.prompt.startsWith(result.stableBlock)).toBe(true);
  });

  it('stable block is BYTE-IDENTICAL across two runs differing ONLY in beadId and workdir', () => {
    // This is the real cache-eligibility test: same identity/config/state/tools
    // but different beadId and worktree path (the volatile fields).
    const identity = makeIdentity();
    const prompt = 'You are a planner.';

    const resultA = injector.injectWithDigest(prompt, makeContext({
      beadId: 'bead-alpha' as BeadId,
      workdir: '/home/user/project/worktrees/bead-alpha'
    }), identity);

    const resultB = injector.injectWithDigest(prompt, makeContext({
      beadId: 'bead-beta' as BeadId,
      workdir: '/home/user/project/worktrees/bead-beta'
    }), identity);

    // Stable blocks must be byte-identical — they form the cacheable prefix.
    expect(resultA.stableBlock).toBe(resultB.stableBlock);
    // DigestIds must match (same stable block + same identity).
    expect(resultA.digestId).toBe(resultB.digestId);
  });

  it('beadId and workdir appear ONLY in the volatile suffix, NEVER in the stable block', () => {
    const beadId = 'pi-experiment-isolation-check' as BeadId;
    const workdir = '/home/user/project/worktrees/pi-experiment-isolation-check';
    const result = injector.injectWithDigest(
      'You are a planner.',
      makeContext({ beadId, workdir }),
      makeIdentity()
    );

    // Volatile fields must NOT appear in the stable block.
    expect(result.stableBlock).not.toContain(beadId);
    expect(result.stableBlock).not.toContain(workdir);

    // They MUST appear in the full prompt (volatile suffix).
    expect(result.prompt).toContain(beadId);
    expect(result.prompt).toContain(workdir);
  });

  it('all expected sections appear exactly once in the assembled prompt (content-preservation)', () => {
    const result = injector.injectWithDigest(
      'You are a planner.',
      makeContext(),
      makeIdentity()
    );

    // Stable sections — must appear exactly once.
    expect(countOccurrences(result.prompt, '### SYSTEM CONTEXT')).toBe(1);
    expect(countOccurrences(result.prompt, 'PI-NATIVE SKILLS AVAILABLE')).toBe(1);
    expect(countOccurrences(result.prompt, 'REFERENCE LIBRARIES')).toBe(1);
    expect(countOccurrences(result.prompt, '### ROLE INSTRUCTIONS')).toBe(1);

    // Volatile section — must appear exactly once.
    expect(countOccurrences(result.prompt, '### RUN CONTEXT')).toBe(1);
    expect(countOccurrences(result.prompt, '### OUTSTANDING CHECKLIST')).toBe(1);
  });

  it('digestId is stable across beads with the same identity', () => {
    const identity = makeIdentity();
    const prompt = 'You are a planner.';

    const a = injector.injectWithDigest(prompt, makeContext({ beadId: 'bead-1' as BeadId }), identity);
    const b = injector.injectWithDigest(prompt, makeContext({ beadId: 'bead-2' as BeadId }), identity);

    expect(a.digestId).toBe(b.digestId);
  });

  it('digestId changes when stateId changes', () => {
    const prompt = 'You are a planner.';
    const contextA = makeContext({ phase: 'Planning', identity: 'planner' });
    const contextB = makeContext({ phase: 'Implementing', identity: 'implementer' });

    const a = injector.injectWithDigest(prompt, contextA, makeIdentity({ stateId: 'Planning' }));
    const b = injector.injectWithDigest(prompt, contextB, makeIdentity({ stateId: 'Implementing' }));

    expect(a.digestId).not.toBe(b.digestId);
  });

  it('overBudget trips with a tiny budget override', () => {
    const result = injector.injectWithDigest('You are a planner.', makeContext(), makeIdentity(), 1);
    expect(result.overBudget).toBe(true);
    expect(result.estimatedTokens).toBeGreaterThan(1);
  });

  it('inject() and injectWithDigest() produce byte-identical prompts for the same inputs', () => {
    const prompt = 'You are a planner.';
    const context = makeContext();
    const identity = makeIdentity();

    const plain = injector.inject(prompt, context);
    const withDigest = injector.injectWithDigest(prompt, context, identity);

    expect(withDigest.prompt).toBe(plain);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: final worker prompt composition — stableBlock as contiguous
// leading cache prefix (the gate the prior adversarial review demanded).
//
// This test mirrors what extension.ts BEFORE_AGENT_START does:
//   finalPrompt = stableBlock + "\n\n" + piBase + "\n\n" + volatileSuffix
//
// It uses a simulated Pi base prompt (event.systemPrompt) that carries a
// VOLATILE date and cwd trailer — exactly as Pi's buildSystemPrompt() appends
// "Current date: <date>\nCurrent working directory: <cwd>" last (system-prompt.js
// lines 115-117).  The two simulated runs differ in beadId, worktree path, and
// the date/cwd embedded in the Pi base prompt.
// ---------------------------------------------------------------------------

/**
 * Simulate Pi's event.systemPrompt for a given run: a base prompt that ends with
 * Pi's volatile "Current date" and "Current working directory" trailer.
 */
function makePiBasePrompt(date: string, cwd: string): string {
  return (
    'You are an expert coding assistant operating inside pi, a coding agent harness.\n\n' +
    'Available tools:\n- bash: Run shell commands\n- read: Read files\n\n' +
    'Guidelines:\n- Be concise in your responses\n' +
    `\nCurrent date: ${date}` +
    `\nCurrent working directory: ${cwd}`
  );
}

/**
 * Replicate the final-prompt composition from extension.ts BEFORE_AGENT_START:
 *   stableBlock + "\n\n" + piBase + "\n\n" + volatileSuffix
 *
 * The piBase argument is event.systemPrompt as emitted by Pi's buildSystemPrompt().
 */
function composeWorkerPrompt(stableBlock: string, piBase: string, volatileSuffix: string): string {
  return piBase
    ? `${stableBlock}\n\n${piBase}\n\n${volatileSuffix}`
    : `${stableBlock}\n\n${volatileSuffix}`;
}

describe('end-to-end: stableBlock is a contiguous leading cache prefix of the final worker prompt', () => {
  const injector = new ContextInjector();

  it('(a) both final prompts START WITH the identical stableBlock across runs differing only in bead/worktree/date', () => {
    const identity = makeIdentity();
    const rolePrompt = 'You are a planner. Formulate a detailed plan.';

    // Run A: bead-alpha, worktree-alpha, date 2026-06-01
    const runA = injector.injectWithDigest(
      rolePrompt,
      makeContext({ beadId: 'bead-alpha' as BeadId, workdir: '/proj/worktrees/bead-alpha' }),
      identity
    );
    const piBaseA = makePiBasePrompt('2026-06-01', '/proj/worktrees/bead-alpha');
    const finalA = composeWorkerPrompt(runA.stableBlock, piBaseA, runA.volatileSuffix);

    // Run B: bead-beta, worktree-beta, date 2026-06-02 (different bead AND different date)
    const runB = injector.injectWithDigest(
      rolePrompt,
      makeContext({ beadId: 'bead-beta' as BeadId, workdir: '/proj/worktrees/bead-beta' }),
      identity
    );
    const piBaseB = makePiBasePrompt('2026-06-02', '/proj/worktrees/bead-beta');
    const finalB = composeWorkerPrompt(runB.stableBlock, piBaseB, runB.volatileSuffix);

    // (a) Both final prompts must start with the identical stableBlock.
    expect(finalA.startsWith(runA.stableBlock)).toBe(true);
    expect(finalB.startsWith(runB.stableBlock)).toBe(true);
    // The stableBlocks must be byte-identical across the two runs.
    expect(runA.stableBlock).toBe(runB.stableBlock);
    // Therefore both finals share the same leading prefix of length >= stableBlock length.
    expect(finalA.startsWith(runB.stableBlock)).toBe(true);
    expect(finalB.startsWith(runA.stableBlock)).toBe(true);
  });

  it('(b) volatile bits (beadId, worktree, date) appear ONLY after the stableBlock prefix', () => {
    const identity = makeIdentity();
    const rolePrompt = 'You are a planner.';

    const runA = injector.injectWithDigest(
      rolePrompt,
      makeContext({ beadId: 'bead-alpha' as BeadId, workdir: '/proj/worktrees/bead-alpha' }),
      identity
    );
    const piBaseA = makePiBasePrompt('2026-06-01', '/proj/worktrees/bead-alpha');
    const finalA = composeWorkerPrompt(runA.stableBlock, piBaseA, runA.volatileSuffix);

    const prefixLen = runA.stableBlock.length;

    // The stableBlock itself must NOT contain any of the volatile fields.
    expect(runA.stableBlock).not.toContain('bead-alpha');
    expect(runA.stableBlock).not.toContain('2026-06-01');
    expect(runA.stableBlock).not.toContain('worktrees/bead-alpha');

    // Each volatile field must appear in the final prompt — but ONLY after the prefix.
    for (const volatileToken of ['bead-alpha', '2026-06-01', 'worktrees/bead-alpha']) {
      const indexInFinal = finalA.indexOf(volatileToken);
      expect(indexInFinal).toBeGreaterThanOrEqual(prefixLen);
    }
  });

  it('(c) the stable prefix is non-trivial: contains tool-guidance, skills, and rules section markers', () => {
    const identity = makeIdentity();
    const rolePrompt = 'You are a planner.';

    const runA = injector.injectWithDigest(
      rolePrompt,
      makeContext({ beadId: 'bead-alpha' as BeadId, workdir: '/proj/worktrees/bead-alpha' }),
      identity
    );

    // The stableBlock must contain the canonical section markers from ContextInjector.
    expect(runA.stableBlock).toContain('### SYSTEM CONTEXT');
    expect(runA.stableBlock).toContain('PI-NATIVE SKILLS AVAILABLE');
    expect(runA.stableBlock).toContain('### REFERENCE LIBRARIES');
    expect(runA.stableBlock).toContain('### ROLE INSTRUCTIONS');

    // And the stableBlock must be meaningfully long (> 256 chars of guidance).
    expect(runA.stableBlock.length).toBeGreaterThan(256);
  });

  it('GUARD: prepending a volatile base before stableBlock breaks the invariant — test catches the regression', () => {
    // This proves the test would catch the original bug where Pi's volatile base was PREPENDED.
    const identity = makeIdentity();
    const rolePrompt = 'You are a planner.';

    const runA = injector.injectWithDigest(
      rolePrompt,
      makeContext({ beadId: 'bead-alpha' as BeadId, workdir: '/proj/worktrees/bead-alpha' }),
      identity
    );
    const piBaseA = makePiBasePrompt('2026-06-01', '/proj/worktrees/bead-alpha');

    // Simulate the BROKEN composition (volatile base BEFORE stableBlock — the old bug):
    const brokenFinalA = `${piBaseA}\n\n${runA.stableBlock}\n\n${runA.volatileSuffix}`;

    const runB = injector.injectWithDigest(
      rolePrompt,
      makeContext({ beadId: 'bead-beta' as BeadId, workdir: '/proj/worktrees/bead-beta' }),
      identity
    );
    const piBaseB = makePiBasePrompt('2026-06-02', '/proj/worktrees/bead-beta');
    const brokenFinalB = `${piBaseB}\n\n${runB.stableBlock}\n\n${runB.volatileSuffix}`;

    // With the broken ordering, the two finals do NOT share a stableBlock-length leading prefix
    // (piBaseA !== piBaseB because date and cwd differ).
    const sharedPrefixLength = commonPrefixLength(brokenFinalA, brokenFinalB);
    expect(sharedPrefixLength).toBeLessThan(runA.stableBlock.length);

    // Sanity: the correct composition DOES share the full stableBlock prefix.
    const correctFinalA = composeWorkerPrompt(runA.stableBlock, piBaseA, runA.volatileSuffix);
    const correctFinalB = composeWorkerPrompt(runB.stableBlock, piBaseB, runB.volatileSuffix);
    const correctSharedLength = commonPrefixLength(correctFinalA, correctFinalB);
    expect(correctSharedLength).toBeGreaterThanOrEqual(runA.stableBlock.length);
  });
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function countOccurrences(text: string, substring: string): number {
  let count = 0;
  let index = 0;
  while ((index = text.indexOf(substring, index)) !== -1) {
    count++;
    index += substring.length;
  }
  return count;
}

function commonPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}
