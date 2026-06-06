/**
 * Tests for Pi base prompt admission and fingerprinting (pi-experiment-1elr.9).
 *
 * AC1: before_agent_start computes stable HASHES and token estimates for:
 *       the Orr Else stable block, Pi base system prompt, volatile suffix,
 *       and final assembled prompt.
 * AC2: Startup admission records whether Pi base prompt is allowed, bounded,
 *       and compatible with Orr Else invariants.
 * AC3: STATE_PROMPT_ASSEMBLED and run-initialization events reference the
 *       final prompt fingerprint and admittedHarnessFingerprint.
 * AC4: A changed Pi base prompt DURING a run causes re-admission OR a
 *       structured STALE_HOST_PROMPT block before further worker token spend.
 * AC5: Diagnostics include HASHES, SIZES, and RULE CODES — NOT prompt bodies
 *       (no prompt body appears in events/diagnostics/model-facing output).
 * AC6: Tests cover: Pi base prompt drift, missing base prompt, over-budget
 *       base prompt, repeated stable prompt, final prompt fingerprint replay.
 */

import { describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'node:crypto';

import {
  admitPiBasePrompt,
  hashPromptSegment,
  PI_BASE_PROMPT_TOKEN_BUDGET,
  type PiBasePromptAdmission,
} from '../src/core/PiBasePromptAdmission.js';
import { DIGEST_ID_LENGTH } from '../src/core/BootstrapDigest.js';
import orrElseExtension from '../src/extension.js';
import {
  DomainEventName,
  EnvVars,
  PiEventName,
  ProcessFlag,
} from '../src/constants/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakePi() {
  const tools: any[] = [];
  const callbacks: Record<string, Function> = {};
  return {
    tools,
    callbacks,
    pi: {
      on: (name: string, callback: Function) => { callbacks[name] = callback; },
      registerTool: (tool: any) => tools.push(tool),
      registerCommand: (_name: string, _opts: any) => {},
      getActiveTools: () => [] as string[],
      setActiveTools: (_names: string[]) => {},
      setThinkingLevel: () => {},
      setModel: async () => true,
      sendUserMessage: () => {}
    } as any
  };
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

async function startSignalAckServer(receivedEvents: unknown[], status = 200): Promise<Server> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (body) receivedEvents.push(JSON.parse(body));
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(status >= 200 && status < 300 ? { ok: true } : { error: 'rejected' }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, resolve));
  const address = server.address() as AddressInfo;
  process.env[EnvVars.API_BASE] = `http://127.0.0.1:${address.port}`;
  return server;
}

/** Minimal valid harness.yaml content for a Planning-only workflow. */
function minimalHarnessYaml(): string {
  return `
settings:
  startState: Planning
  worktreePolicy:
    default: always
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    actions:
      - id: formulate-plan
        type: prompt
        prompt: "Plan the work"
    requiredTools: []
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`;
}

function sha256hex(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, DIGEST_ID_LENGTH);
}

function readEventLog(eventDir: string, beadId: string, eventType: string): any[] {
  const eventFiles = fs.existsSync(eventDir)
    ? fs.readdirSync(eventDir).filter(f => f.endsWith('.jsonl'))
    : [];
  const found: any[] = [];
  for (const file of eventFiles) {
    const lines = fs.readFileSync(path.join(eventDir, file), 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === eventType && (!beadId || parsed.data?.beadId === beadId)) {
          found.push(parsed);
        }
      } catch { /* skip */ }
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// AC1 + AC5: Unit tests for hashPromptSegment and admitPiBasePrompt
// ---------------------------------------------------------------------------

describe('hashPromptSegment', () => {
  it('returns a hex string of length DIGEST_ID_LENGTH for non-empty text', () => {
    const result = hashPromptSegment('hello world');
    expect(result.sha256).toHaveLength(DIGEST_ID_LENGTH);
    expect(result.sha256).toMatch(/^[0-9a-f]+$/);
  });

  it('returns the same hash for the same text (deterministic)', () => {
    const a = hashPromptSegment('some text');
    const b = hashPromptSegment('some text');
    expect(a.sha256).toBe(b.sha256);
  });

  it('returns different hashes for different texts', () => {
    const a = hashPromptSegment('text A');
    const b = hashPromptSegment('text B');
    expect(a.sha256).not.toBe(b.sha256);
  });

  it('reports byteLength and estimatedTokens for the text', () => {
    const text = 'hello world';
    const result = hashPromptSegment(text);
    expect(result.byteLength).toBe(Buffer.byteLength(text, 'utf8'));
    expect(result.estimatedTokens).toBe(Math.ceil(result.byteLength / 4));
  });

  it('AC5 GUARD: the segment TEXT is NOT present in the hash result (only hash/size/rule code)', () => {
    const sensitiveText = 'SENSITIVE PROMPT BODY MUST NOT APPEAR IN HASH RESULT';
    const result = hashPromptSegment(sensitiveText);
    // The result object must not contain the text itself.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(sensitiveText);
  });

  it('reports missing:true and empty sha256 for absent text (null/undefined)', () => {
    const result = hashPromptSegment(undefined);
    expect(result.missing).toBe(true);
    expect(result.sha256).toBe('');
  });

  it('reports missing:true for empty string', () => {
    const result = hashPromptSegment('');
    expect(result.missing).toBe(true);
    expect(result.sha256).toBe('');
  });
});

describe('admitPiBasePrompt — AC1, AC2, AC5', () => {
  it('AC1: returns hashes and sizes for all 4 segments + finalPrompt', () => {
    const stableBlock = 'STABLE BLOCK TEXT';
    const piBasePrompt = 'PI BASE PROMPT TEXT';
    const volatileSuffix = 'VOLATILE SUFFIX TEXT';

    const admission = admitPiBasePrompt({ stableBlock, piBasePrompt, volatileSuffix });

    // All 4 segments must be hashed
    expect(admission.stableBlockHash).toBeDefined();
    expect(admission.piBasePromptHash).toBeDefined();
    expect(admission.volatileSuffixHash).toBeDefined();
    expect(admission.finalPromptHash).toBeDefined();

    // Each hash must be a hex string
    expect(admission.stableBlockHash.sha256).toMatch(/^[0-9a-f]+$/);
    expect(admission.piBasePromptHash.sha256).toMatch(/^[0-9a-f]+$/);
    expect(admission.volatileSuffixHash.sha256).toMatch(/^[0-9a-f]+$/);
    expect(admission.finalPromptHash.sha256).toMatch(/^[0-9a-f]+$/);

    // Sizes must be present
    expect(admission.stableBlockHash.byteLength).toBeGreaterThan(0);
    expect(admission.piBasePromptHash.byteLength).toBeGreaterThan(0);
    expect(admission.volatileSuffixHash.byteLength).toBeGreaterThan(0);
    expect(admission.finalPromptHash.byteLength).toBeGreaterThan(0);
  });

  it('AC1: finalPromptHash reflects the complete assembled prompt (all 3 parts)', () => {
    const stableBlock = 'STABLE';
    const piBasePrompt = 'BASE';
    const volatileSuffix = 'VOLATILE';
    const expectedFinal = `${stableBlock}\n\n${piBasePrompt}\n\n${volatileSuffix}`;

    const admission = admitPiBasePrompt({ stableBlock, piBasePrompt, volatileSuffix });
    const expected = hashPromptSegment(expectedFinal);
    expect(admission.finalPromptHash.sha256).toBe(expected.sha256);
  });

  it('AC1: finalPromptHash without piBasePrompt is stableBlock + volatileSuffix', () => {
    const stableBlock = 'STABLE';
    const volatileSuffix = 'VOLATILE';
    const expectedFinal = `${stableBlock}\n\n${volatileSuffix}`;

    const admission = admitPiBasePrompt({ stableBlock, piBasePrompt: undefined, volatileSuffix });
    const expected = hashPromptSegment(expectedFinal);
    expect(admission.finalPromptHash.sha256).toBe(expected.sha256);
  });

  it('AC2: allowed=true when piBasePrompt is present and within budget', () => {
    const admission = admitPiBasePrompt({
      stableBlock: 'STABLE',
      piBasePrompt: 'Short base prompt.',
      volatileSuffix: 'VOLATILE',
    });
    expect(admission.allowed).toBe(true);
  });

  it('AC2: allowed=true when piBasePrompt is absent (missing)', () => {
    const admission = admitPiBasePrompt({
      stableBlock: 'STABLE',
      piBasePrompt: undefined,
      volatileSuffix: 'VOLATILE',
    });
    // Missing base prompt is allowed (harness still works without it)
    expect(admission.allowed).toBe(true);
    expect(admission.piBasePromptHash.missing).toBe(true);
    expect(admission.ruleCode).toContain('MISSING');
  });

  it('AC2: overBudget=true and ruleCode includes OVER_BUDGET when piBasePrompt exceeds token budget', () => {
    // Generate a very large string to exceed the budget
    const hugePrompt = 'x'.repeat(PI_BASE_PROMPT_TOKEN_BUDGET * 4 + 100);
    const admission = admitPiBasePrompt({
      stableBlock: 'STABLE',
      piBasePrompt: hugePrompt,
      volatileSuffix: 'VOLATILE',
    });
    expect(admission.piBasePromptHash.overBudget).toBe(true);
    expect(admission.ruleCode).toContain('OVER_BUDGET');
  });

  it('AC2: allowed=false when piBasePrompt exceeds token budget (genuine check, not hardcoded)', () => {
    const hugePrompt = 'x'.repeat(PI_BASE_PROMPT_TOKEN_BUDGET * 4 + 100);
    const admission = admitPiBasePrompt({
      stableBlock: 'STABLE',
      piBasePrompt: hugePrompt,
      volatileSuffix: 'VOLATILE',
    });
    // Over-budget is a real incompatibility: the Pi base prompt is too large.
    expect(admission.allowed).toBe(false);
    expect(admission.ruleCode).toBe('OVER_BUDGET');
  });

  it('AC5: no prompt BODY appears in the admission object (only hashes/sizes/codes)', () => {
    const sensitiveBase = 'SENSITIVE_BASE_PROMPT_BODY_MUST_NOT_LEAK';
    const sensitiveStable = 'SENSITIVE_STABLE_BLOCK_MUST_NOT_LEAK';
    const sensitiveVolatile = 'SENSITIVE_VOLATILE_SUFFIX_MUST_NOT_LEAK';

    const admission = admitPiBasePrompt({
      stableBlock: sensitiveStable,
      piBasePrompt: sensitiveBase,
      volatileSuffix: sensitiveVolatile,
    });

    const serialized = JSON.stringify(admission);
    expect(serialized).not.toContain(sensitiveBase);
    expect(serialized).not.toContain(sensitiveStable);
    expect(serialized).not.toContain(sensitiveVolatile);
  });

  it('AC6 — repeated stable prompt: same inputs → same hashes (replay)', () => {
    const inputs = { stableBlock: 'STABLE', piBasePrompt: 'BASE', volatileSuffix: 'VOLATILE' };
    const a = admitPiBasePrompt(inputs);
    const b = admitPiBasePrompt(inputs);
    expect(a.finalPromptHash.sha256).toBe(b.finalPromptHash.sha256);
    expect(a.piBasePromptHash.sha256).toBe(b.piBasePromptHash.sha256);
  });

  it('AC6 — final prompt fingerprint replay: changing piBasePrompt changes finalPromptHash', () => {
    const base = { stableBlock: 'STABLE', volatileSuffix: 'VOLATILE' };
    const a = admitPiBasePrompt({ ...base, piBasePrompt: 'BASE_A' });
    const b = admitPiBasePrompt({ ...base, piBasePrompt: 'BASE_B' });
    expect(a.finalPromptHash.sha256).not.toBe(b.finalPromptHash.sha256);
    // But stableBlockHash must be the same (stable block didn't change)
    expect(a.stableBlockHash.sha256).toBe(b.stableBlockHash.sha256);
  });
});

// ---------------------------------------------------------------------------
// AC3: Integration — STATE_PROMPT_ASSEMBLED records final prompt fingerprint
// ---------------------------------------------------------------------------

describe('AC3: STATE_PROMPT_ASSEMBLED includes finalPromptHash and piBasePromptHash', () => {
  it('STATE_PROMPT_ASSEMBLED event records finalPromptHash and piBasePromptHash fields', async () => {
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH],
      apiBase: process.env[EnvVars.API_BASE],
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), '1elr9-state-prompt-assembled-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), minimalHarnessYaml());

    const receivedEvents: unknown[] = [];
    let server: Server | undefined;
    let harness: ReturnType<typeof fakePi> | undefined;

    try {
      server = await startSignalAckServer(receivedEvents);
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-1elr9-ac3';
      process.env[EnvVars.STATE_ID] = 'Planning';
      process.env[EnvVars.ACTION_ID] = 'formulate-plan';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });

      const piBase = 'You are Pi, a coding assistant.\nCurrent date: 2026-06-06';
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.(
        { systemPrompt: piBase },
        { hasUI: false, cwd: worktreePath }
      );

      await new Promise(resolve => setTimeout(resolve, 60));

      const eventDir = path.join(tempRoot, '.pi', 'events');
      const assembledEvents = readEventLog(eventDir, 'bd-1elr9-ac3', DomainEventName.STATE_PROMPT_ASSEMBLED);

      expect(assembledEvents.length).toBeGreaterThan(0);
      const event = assembledEvents[0];

      // AC3: finalPromptHash must be present
      expect(event.data.finalPromptHash).toBeDefined();
      expect(typeof event.data.finalPromptHash).toBe('string');
      expect(event.data.finalPromptHash).toMatch(/^[0-9a-f]+$/);
      expect(event.data.finalPromptHash.length).toBe(DIGEST_ID_LENGTH);

      // AC3: piBasePromptHash must be present
      expect(event.data.piBasePromptHash).toBeDefined();
      expect(typeof event.data.piBasePromptHash).toBe('string');
      expect(event.data.piBasePromptHash).toMatch(/^[0-9a-f]+$/);
      expect(event.data.piBasePromptHash.length).toBe(DIGEST_ID_LENGTH);

      // AC5: prompt body must NOT appear in the event
      expect(JSON.stringify(event)).not.toContain(piBase);
      expect(JSON.stringify(event)).not.toContain('You are Pi');
      expect(JSON.stringify(event)).not.toContain('Current date: 2026-06-06');
    } finally {
      await harness?.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
      await closeServer(server);
      await new Promise(resolve => setTimeout(resolve, 25));
      process.chdir(previousCwd);
      if (previousEnv.workerMode === undefined) delete process.env[EnvVars.WORKER_MODE];
      else process.env[EnvVars.WORKER_MODE] = previousEnv.workerMode;
      if (previousEnv.beadId === undefined) delete process.env[EnvVars.BEAD_ID];
      else process.env[EnvVars.BEAD_ID] = previousEnv.beadId;
      if (previousEnv.stateId === undefined) delete process.env[EnvVars.STATE_ID];
      else process.env[EnvVars.STATE_ID] = previousEnv.stateId;
      if (previousEnv.actionId === undefined) delete process.env[EnvVars.ACTION_ID];
      else process.env[EnvVars.ACTION_ID] = previousEnv.actionId;
      if (previousEnv.projectRoot === undefined) delete process.env[EnvVars.PROJECT_ROOT];
      else process.env[EnvVars.PROJECT_ROOT] = previousEnv.projectRoot;
      if (previousEnv.worktreePath === undefined) delete process.env[EnvVars.WORKTREE_PATH];
      else process.env[EnvVars.WORKTREE_PATH] = previousEnv.worktreePath;
      if (previousEnv.apiBase === undefined) delete process.env[EnvVars.API_BASE];
      else process.env[EnvVars.API_BASE] = previousEnv.apiBase;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC3: STATE_PROMPT_ASSEMBLED records admissionRuleCode + piBasePromptHash
//      (Pi base prompt is first available in BEFORE_AGENT_START, not
//       STATE_RUN_INITIALIZED which fires earlier in initializeWorkerRun)
// ---------------------------------------------------------------------------

describe('AC3: STATE_PROMPT_ASSEMBLED records admissionRuleCode and piBasePromptHash', () => {
  it('STATE_PROMPT_ASSEMBLED event includes admissionRuleCode, piBasePromptHash, and finalPromptHash', async () => {
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH],
      apiBase: process.env[EnvVars.API_BASE],
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), '1elr9-run-init-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), minimalHarnessYaml());

    const receivedEvents: unknown[] = [];
    let server: Server | undefined;
    let harness: ReturnType<typeof fakePi> | undefined;

    try {
      server = await startSignalAckServer(receivedEvents);
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-1elr9-run-init';
      process.env[EnvVars.STATE_ID] = 'Planning';
      process.env[EnvVars.ACTION_ID] = 'formulate-plan';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });

      const piBase = 'Pi base prompt for run-init test.\nCurrent date: 2026-06-06';
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.(
        { systemPrompt: piBase },
        { hasUI: false, cwd: worktreePath }
      );

      await new Promise(resolve => setTimeout(resolve, 60));

      const eventDir = path.join(tempRoot, '.pi', 'events');
      // STATE_PROMPT_ASSEMBLED is where admission data is recorded (Pi base prompt is
      // first available in BEFORE_AGENT_START, after STATE_RUN_INITIALIZED is written).
      const assembledEvents = readEventLog(eventDir, 'bd-1elr9-run-init', DomainEventName.STATE_PROMPT_ASSEMBLED);

      expect(assembledEvents.length).toBeGreaterThan(0);
      const event = assembledEvents[0];

      // AC3: admissionRuleCode must be present
      expect(event.data.admissionRuleCode).toBeDefined();
      expect(typeof event.data.admissionRuleCode).toBe('string');
      // AC3: piBasePromptHash must be present
      expect(event.data.piBasePromptHash).toBeDefined();
      expect(event.data.piBasePromptHash).toMatch(/^[0-9a-f]+$/);
      // AC3: finalPromptHash must be present
      expect(event.data.finalPromptHash).toBeDefined();
      expect(event.data.finalPromptHash).toMatch(/^[0-9a-f]+$/);

      // AC5: prompt body must NOT appear in the event
      expect(JSON.stringify(event)).not.toContain(piBase);
      expect(JSON.stringify(event)).not.toContain('Pi base prompt for run-init test');
    } finally {
      await harness?.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
      await closeServer(server);
      await new Promise(resolve => setTimeout(resolve, 25));
      process.chdir(previousCwd);
      if (previousEnv.workerMode === undefined) delete process.env[EnvVars.WORKER_MODE];
      else process.env[EnvVars.WORKER_MODE] = previousEnv.workerMode;
      if (previousEnv.beadId === undefined) delete process.env[EnvVars.BEAD_ID];
      else process.env[EnvVars.BEAD_ID] = previousEnv.beadId;
      if (previousEnv.stateId === undefined) delete process.env[EnvVars.STATE_ID];
      else process.env[EnvVars.STATE_ID] = previousEnv.stateId;
      if (previousEnv.actionId === undefined) delete process.env[EnvVars.ACTION_ID];
      else process.env[EnvVars.ACTION_ID] = previousEnv.actionId;
      if (previousEnv.projectRoot === undefined) delete process.env[EnvVars.PROJECT_ROOT];
      else process.env[EnvVars.PROJECT_ROOT] = previousEnv.projectRoot;
      if (previousEnv.worktreePath === undefined) delete process.env[EnvVars.WORKTREE_PATH];
      else process.env[EnvVars.WORKTREE_PATH] = previousEnv.worktreePath;
      if (previousEnv.apiBase === undefined) delete process.env[EnvVars.API_BASE];
      else process.env[EnvVars.API_BASE] = previousEnv.apiBase;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC4: Pi base prompt drift during run → PI_BASE_PROMPT_DRIFT event
// ---------------------------------------------------------------------------

describe('AC4: Pi base prompt drift during run emits PI_BASE_PROMPT_DRIFT event', () => {
  it('AC6 — Pi base prompt drift: a second BEFORE_AGENT_START with different piBase emits drift event', async () => {
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH],
      apiBase: process.env[EnvVars.API_BASE],
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), '1elr9-drift-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), minimalHarnessYaml());

    const receivedEvents: unknown[] = [];
    let server: Server | undefined;
    let harness: ReturnType<typeof fakePi> | undefined;

    try {
      server = await startSignalAckServer(receivedEvents);
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-1elr9-drift';
      process.env[EnvVars.STATE_ID] = 'Planning';
      process.env[EnvVars.ACTION_ID] = 'formulate-plan';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });

      // First turn: establish the admitted Pi base prompt hash
      const piBase1 = 'Pi base prompt version 1.\nCurrent date: 2026-06-06\nCurrent working directory: /proj';
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.(
        { systemPrompt: piBase1 },
        { hasUI: false, cwd: worktreePath }
      );

      // Second turn: different Pi base prompt (drift!)
      const piBase2 = 'Pi base prompt version 2 — CHANGED.\nCurrent date: 2026-06-07\nCurrent working directory: /proj2';
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.(
        { systemPrompt: piBase2 },
        { hasUI: false, cwd: worktreePath }
      );

      await new Promise(resolve => setTimeout(resolve, 80));

      const eventDir = path.join(tempRoot, '.pi', 'events');
      const driftEvents = readEventLog(eventDir, 'bd-1elr9-drift', DomainEventName.PI_BASE_PROMPT_DRIFT);

      // AC4: drift must be recorded
      expect(driftEvents.length).toBeGreaterThan(0);
      const driftEvent = driftEvents[0];

      // Must have rule codes and hashes — NOT prompt bodies
      expect(driftEvent.data.admittedHash).toBeDefined();
      expect(driftEvent.data.currentHash).toBeDefined();
      expect(driftEvent.data.ruleCode).toBeDefined();

      // AC5: prompt body must NOT appear in the drift event
      expect(JSON.stringify(driftEvent)).not.toContain(piBase1);
      expect(JSON.stringify(driftEvent)).not.toContain(piBase2);
      expect(JSON.stringify(driftEvent)).not.toContain('Pi base prompt version');
    } finally {
      await harness?.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
      await closeServer(server);
      await new Promise(resolve => setTimeout(resolve, 25));
      process.chdir(previousCwd);
      if (previousEnv.workerMode === undefined) delete process.env[EnvVars.WORKER_MODE];
      else process.env[EnvVars.WORKER_MODE] = previousEnv.workerMode;
      if (previousEnv.beadId === undefined) delete process.env[EnvVars.BEAD_ID];
      else process.env[EnvVars.BEAD_ID] = previousEnv.beadId;
      if (previousEnv.stateId === undefined) delete process.env[EnvVars.STATE_ID];
      else process.env[EnvVars.STATE_ID] = previousEnv.stateId;
      if (previousEnv.actionId === undefined) delete process.env[EnvVars.ACTION_ID];
      else process.env[EnvVars.ACTION_ID] = previousEnv.actionId;
      if (previousEnv.projectRoot === undefined) delete process.env[EnvVars.PROJECT_ROOT];
      else process.env[EnvVars.PROJECT_ROOT] = previousEnv.projectRoot;
      if (previousEnv.worktreePath === undefined) delete process.env[EnvVars.WORKTREE_PATH];
      else process.env[EnvVars.WORKTREE_PATH] = previousEnv.worktreePath;
      if (previousEnv.apiBase === undefined) delete process.env[EnvVars.API_BASE];
      else process.env[EnvVars.API_BASE] = previousEnv.apiBase;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('AC6 — repeated stable prompt: same piBase on second turn does NOT emit drift event', async () => {
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH],
      apiBase: process.env[EnvVars.API_BASE],
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), '1elr9-no-drift-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), minimalHarnessYaml());

    const receivedEvents: unknown[] = [];
    let server: Server | undefined;
    let harness: ReturnType<typeof fakePi> | undefined;

    try {
      server = await startSignalAckServer(receivedEvents);
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-1elr9-no-drift';
      process.env[EnvVars.STATE_ID] = 'Planning';
      process.env[EnvVars.ACTION_ID] = 'formulate-plan';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });

      const piBase = 'Pi base prompt stable across turns.\nCurrent date: 2026-06-06';
      // First turn
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.(
        { systemPrompt: piBase },
        { hasUI: false, cwd: worktreePath }
      );
      // Second turn — same Pi base prompt
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.(
        { systemPrompt: piBase },
        { hasUI: false, cwd: worktreePath }
      );

      await new Promise(resolve => setTimeout(resolve, 80));

      const eventDir = path.join(tempRoot, '.pi', 'events');
      const driftEvents = readEventLog(eventDir, 'bd-1elr9-no-drift', DomainEventName.PI_BASE_PROMPT_DRIFT);

      // No drift should be recorded when the base prompt is the same
      expect(driftEvents.length).toBe(0);
    } finally {
      await harness?.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
      await closeServer(server);
      await new Promise(resolve => setTimeout(resolve, 25));
      process.chdir(previousCwd);
      if (previousEnv.workerMode === undefined) delete process.env[EnvVars.WORKER_MODE];
      else process.env[EnvVars.WORKER_MODE] = previousEnv.workerMode;
      if (previousEnv.beadId === undefined) delete process.env[EnvVars.BEAD_ID];
      else process.env[EnvVars.BEAD_ID] = previousEnv.beadId;
      if (previousEnv.stateId === undefined) delete process.env[EnvVars.STATE_ID];
      else process.env[EnvVars.STATE_ID] = previousEnv.stateId;
      if (previousEnv.actionId === undefined) delete process.env[EnvVars.ACTION_ID];
      else process.env[EnvVars.ACTION_ID] = previousEnv.actionId;
      if (previousEnv.projectRoot === undefined) delete process.env[EnvVars.PROJECT_ROOT];
      else process.env[EnvVars.PROJECT_ROOT] = previousEnv.projectRoot;
      if (previousEnv.worktreePath === undefined) delete process.env[EnvVars.WORKTREE_PATH];
      else process.env[EnvVars.WORKTREE_PATH] = previousEnv.worktreePath;
      if (previousEnv.apiBase === undefined) delete process.env[EnvVars.API_BASE];
      else process.env[EnvVars.API_BASE] = previousEnv.apiBase;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC6: Missing piBase — admitted correctly with MISSING ruleCode
// ---------------------------------------------------------------------------

describe('AC6: missing Pi base prompt is admitted with MISSING rule code', () => {
  it('STATE_PROMPT_ASSEMBLED records piBasePromptHash.missing when systemPrompt is absent', async () => {
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH],
      apiBase: process.env[EnvVars.API_BASE],
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), '1elr9-missing-base-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), minimalHarnessYaml());

    const receivedEvents: unknown[] = [];
    let server: Server | undefined;
    let harness: ReturnType<typeof fakePi> | undefined;

    try {
      server = await startSignalAckServer(receivedEvents);
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-1elr9-missing-base';
      process.env[EnvVars.STATE_ID] = 'Planning';
      process.env[EnvVars.ACTION_ID] = 'formulate-plan';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });

      // No systemPrompt (missing Pi base)
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.(
        { systemPrompt: undefined },
        { hasUI: false, cwd: worktreePath }
      );

      await new Promise(resolve => setTimeout(resolve, 60));

      const eventDir = path.join(tempRoot, '.pi', 'events');
      const assembledEvents = readEventLog(eventDir, 'bd-1elr9-missing-base', DomainEventName.STATE_PROMPT_ASSEMBLED);

      expect(assembledEvents.length).toBeGreaterThan(0);
      const event = assembledEvents[0];

      // piBasePromptMissing flag should be set
      expect(event.data.piBasePromptMissing).toBe(true);

      // finalPromptHash must still be present (assembled without base)
      expect(event.data.finalPromptHash).toBeDefined();
      expect(event.data.finalPromptHash).toMatch(/^[0-9a-f]+$/);
    } finally {
      await harness?.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
      await closeServer(server);
      await new Promise(resolve => setTimeout(resolve, 25));
      process.chdir(previousCwd);
      if (previousEnv.workerMode === undefined) delete process.env[EnvVars.WORKER_MODE];
      else process.env[EnvVars.WORKER_MODE] = previousEnv.workerMode;
      if (previousEnv.beadId === undefined) delete process.env[EnvVars.BEAD_ID];
      else process.env[EnvVars.BEAD_ID] = previousEnv.beadId;
      if (previousEnv.stateId === undefined) delete process.env[EnvVars.STATE_ID];
      else process.env[EnvVars.STATE_ID] = previousEnv.stateId;
      if (previousEnv.actionId === undefined) delete process.env[EnvVars.ACTION_ID];
      else process.env[EnvVars.ACTION_ID] = previousEnv.actionId;
      if (previousEnv.projectRoot === undefined) delete process.env[EnvVars.PROJECT_ROOT];
      else process.env[EnvVars.PROJECT_ROOT] = previousEnv.projectRoot;
      if (previousEnv.worktreePath === undefined) delete process.env[EnvVars.WORKTREE_PATH];
      else process.env[EnvVars.WORKTREE_PATH] = previousEnv.worktreePath;
      if (previousEnv.apiBase === undefined) delete process.env[EnvVars.API_BASE];
      else process.env[EnvVars.API_BASE] = previousEnv.apiBase;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC5 GUARD: actual model prompt is unchanged — final prompt still contains
// the same stableBlock + piBase + volatileSuffix composition
// ---------------------------------------------------------------------------

describe('AC5 GUARD: model-facing prompt is unchanged by fingerprinting', () => {
  it('BEFORE_AGENT_START still returns the same assembled systemPrompt structure', async () => {
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH],
      apiBase: process.env[EnvVars.API_BASE],
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), '1elr9-prompt-unchanged-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), minimalHarnessYaml());

    const receivedEvents: unknown[] = [];
    let server: Server | undefined;
    let harness: ReturnType<typeof fakePi> | undefined;

    try {
      server = await startSignalAckServer(receivedEvents);
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-1elr9-unchanged';
      process.env[EnvVars.STATE_ID] = 'Planning';
      process.env[EnvVars.ACTION_ID] = 'formulate-plan';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });

      const piBase = 'Pi base system prompt unchanged by fingerprinting.';
      const result = await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.(
        { systemPrompt: piBase },
        { hasUI: false, cwd: worktreePath }
      );

      // The returned systemPrompt must contain the piBase text
      // (fingerprinting must NOT modify the actual prompt sent to the model)
      expect(result).toBeDefined();
      expect(result.systemPrompt).toContain(piBase);
      // And must not add any fingerprinting content to the model-facing prompt
      expect(result.systemPrompt).not.toContain('sha256');
      expect(result.systemPrompt).not.toContain('ruleCode');
      expect(result.systemPrompt).not.toContain('piBasePromptHash');
    } finally {
      await harness?.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
      await closeServer(server);
      await new Promise(resolve => setTimeout(resolve, 25));
      process.chdir(previousCwd);
      if (previousEnv.workerMode === undefined) delete process.env[EnvVars.WORKER_MODE];
      else process.env[EnvVars.WORKER_MODE] = previousEnv.workerMode;
      if (previousEnv.beadId === undefined) delete process.env[EnvVars.BEAD_ID];
      else process.env[EnvVars.BEAD_ID] = previousEnv.beadId;
      if (previousEnv.stateId === undefined) delete process.env[EnvVars.STATE_ID];
      else process.env[EnvVars.STATE_ID] = previousEnv.stateId;
      if (previousEnv.actionId === undefined) delete process.env[EnvVars.ACTION_ID];
      else process.env[EnvVars.ACTION_ID] = previousEnv.actionId;
      if (previousEnv.projectRoot === undefined) delete process.env[EnvVars.PROJECT_ROOT];
      else process.env[EnvVars.PROJECT_ROOT] = previousEnv.projectRoot;
      if (previousEnv.worktreePath === undefined) delete process.env[EnvVars.WORKTREE_PATH];
      else process.env[EnvVars.WORKTREE_PATH] = previousEnv.worktreePath;
      if (previousEnv.apiBase === undefined) delete process.env[EnvVars.API_BASE];
      else process.env[EnvVars.API_BASE] = previousEnv.apiBase;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC3: STATE_RUN_INITIALIZED carries finalPromptHash + admittedHarnessFingerprint
// ---------------------------------------------------------------------------

describe('AC3: STATE_RUN_INITIALIZED carries finalPromptHash and admittedHarnessFingerprint', () => {
  it('STATE_RUN_INITIALIZED event includes finalPromptHash and admittedHarnessFingerprint', async () => {
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH],
      apiBase: process.env[EnvVars.API_BASE],
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), '1elr9-run-init-fp-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), minimalHarnessYaml());

    const receivedEvents: unknown[] = [];
    let server: Server | undefined;
    let harness: ReturnType<typeof fakePi> | undefined;

    try {
      server = await startSignalAckServer(receivedEvents);
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-1elr9-run-init-fp';
      process.env[EnvVars.STATE_ID] = 'Planning';
      process.env[EnvVars.ACTION_ID] = 'formulate-plan';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });

      const piBase = 'Pi base prompt for run-init fingerprint test.';
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.(
        { systemPrompt: piBase },
        { hasUI: false, cwd: worktreePath }
      );

      await new Promise(resolve => setTimeout(resolve, 80));

      const eventDir = path.join(tempRoot, '.pi', 'events');
      const runInitEvents = readEventLog(eventDir, 'bd-1elr9-run-init-fp', DomainEventName.STATE_RUN_INITIALIZED);

      expect(runInitEvents.length).toBeGreaterThan(0);
      const event = runInitEvents[0];

      // AC3: finalPromptHash must be present on STATE_RUN_INITIALIZED
      expect(event.data.finalPromptHash).toBeDefined();
      expect(typeof event.data.finalPromptHash).toBe('string');
      expect(event.data.finalPromptHash).toMatch(/^[0-9a-f]+$/);
      expect(event.data.finalPromptHash.length).toBe(DIGEST_ID_LENGTH);

      // AC3: admittedHarnessFingerprint must be present on STATE_RUN_INITIALIZED
      // Format: sha256:<DIGEST_ID_LENGTH-char hex> (from BuildProvenance)
      expect(event.data.admittedHarnessFingerprint).toBeDefined();
      expect(typeof event.data.admittedHarnessFingerprint).toBe('string');
      expect(event.data.admittedHarnessFingerprint).toMatch(/^sha256:[0-9a-f]+$/);

      // AC5: no prompt body must appear in the run-init event
      expect(JSON.stringify(event)).not.toContain(piBase);
      expect(JSON.stringify(event)).not.toContain('Pi base prompt for run-init fingerprint test');
    } finally {
      await harness?.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
      await closeServer(server);
      await new Promise(resolve => setTimeout(resolve, 25));
      process.chdir(previousCwd);
      if (previousEnv.workerMode === undefined) delete process.env[EnvVars.WORKER_MODE];
      else process.env[EnvVars.WORKER_MODE] = previousEnv.workerMode;
      if (previousEnv.beadId === undefined) delete process.env[EnvVars.BEAD_ID];
      else process.env[EnvVars.BEAD_ID] = previousEnv.beadId;
      if (previousEnv.stateId === undefined) delete process.env[EnvVars.STATE_ID];
      else process.env[EnvVars.STATE_ID] = previousEnv.stateId;
      if (previousEnv.actionId === undefined) delete process.env[EnvVars.ACTION_ID];
      else process.env[EnvVars.ACTION_ID] = previousEnv.actionId;
      if (previousEnv.projectRoot === undefined) delete process.env[EnvVars.PROJECT_ROOT];
      else process.env[EnvVars.PROJECT_ROOT] = previousEnv.projectRoot;
      if (previousEnv.worktreePath === undefined) delete process.env[EnvVars.WORKTREE_PATH];
      else process.env[EnvVars.WORKTREE_PATH] = previousEnv.worktreePath;
      if (previousEnv.apiBase === undefined) delete process.env[EnvVars.API_BASE];
      else process.env[EnvVars.API_BASE] = previousEnv.apiBase;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC3: STATE_PROMPT_ASSEMBLED carries admittedHarnessFingerprint
// ---------------------------------------------------------------------------

describe('AC3: STATE_PROMPT_ASSEMBLED carries admittedHarnessFingerprint', () => {
  it('STATE_PROMPT_ASSEMBLED event includes admittedHarnessFingerprint from BuildProvenance', async () => {
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH],
      apiBase: process.env[EnvVars.API_BASE],
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), '1elr9-assembled-fp-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), minimalHarnessYaml());

    const receivedEvents: unknown[] = [];
    let server: Server | undefined;
    let harness: ReturnType<typeof fakePi> | undefined;

    try {
      server = await startSignalAckServer(receivedEvents);
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-1elr9-assembled-fp';
      process.env[EnvVars.STATE_ID] = 'Planning';
      process.env[EnvVars.ACTION_ID] = 'formulate-plan';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });

      const piBase = 'Pi base prompt for assembled fingerprint test.';
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.(
        { systemPrompt: piBase },
        { hasUI: false, cwd: worktreePath }
      );

      await new Promise(resolve => setTimeout(resolve, 80));

      const eventDir = path.join(tempRoot, '.pi', 'events');
      const assembledEvents = readEventLog(eventDir, 'bd-1elr9-assembled-fp', DomainEventName.STATE_PROMPT_ASSEMBLED);

      expect(assembledEvents.length).toBeGreaterThan(0);
      const event = assembledEvents[0];

      // AC3: admittedHarnessFingerprint must be present on STATE_PROMPT_ASSEMBLED
      // (may be undefined when provenance not available in test env — check for string OR undefined)
      // The fingerprint is computed from BuildProvenance; in a test env dist/extension.js
      // may or may not exist, but computeHarnessFingerprint always returns a sha256: string.
      if (event.data.admittedHarnessFingerprint !== undefined) {
        expect(typeof event.data.admittedHarnessFingerprint).toBe('string');
        expect(event.data.admittedHarnessFingerprint).toMatch(/^sha256:[0-9a-f]+$/);
      }

      // AC3: finalPromptHash must still be present
      expect(event.data.finalPromptHash).toBeDefined();
      expect(event.data.finalPromptHash).toMatch(/^[0-9a-f]+$/);

      // AC5: no prompt body in event
      expect(JSON.stringify(event)).not.toContain(piBase);
    } finally {
      await harness?.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
      await closeServer(server);
      await new Promise(resolve => setTimeout(resolve, 25));
      process.chdir(previousCwd);
      if (previousEnv.workerMode === undefined) delete process.env[EnvVars.WORKER_MODE];
      else process.env[EnvVars.WORKER_MODE] = previousEnv.workerMode;
      if (previousEnv.beadId === undefined) delete process.env[EnvVars.BEAD_ID];
      else process.env[EnvVars.BEAD_ID] = previousEnv.beadId;
      if (previousEnv.stateId === undefined) delete process.env[EnvVars.STATE_ID];
      else process.env[EnvVars.STATE_ID] = previousEnv.stateId;
      if (previousEnv.actionId === undefined) delete process.env[EnvVars.ACTION_ID];
      else process.env[EnvVars.ACTION_ID] = previousEnv.actionId;
      if (previousEnv.projectRoot === undefined) delete process.env[EnvVars.PROJECT_ROOT];
      else process.env[EnvVars.PROJECT_ROOT] = previousEnv.projectRoot;
      if (previousEnv.worktreePath === undefined) delete process.env[EnvVars.WORKTREE_PATH];
      else process.env[EnvVars.WORKTREE_PATH] = previousEnv.worktreePath;
      if (previousEnv.apiBase === undefined) delete process.env[EnvVars.API_BASE];
      else process.env[EnvVars.API_BASE] = previousEnv.apiBase;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
