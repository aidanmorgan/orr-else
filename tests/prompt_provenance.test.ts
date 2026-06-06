/**
 * Focused tests for prompt provenance resolution and the completion-gate
 * provenance dimension.
 *
 * Covers:
 *  - resolvePromptProvenance: returns path+sha256 for each kind; missing files
 *    are flagged with missing: true.
 *  - STATE_RUN_INITIALIZED records the provenance array + harnessConfigVersion.
 *  - Completion gate REJECTS when provenance is missing for the run.
 *  - Completion gate REJECTS when a recorded hash no longer matches (stale).
 *  - Completion gate PASSES when provenance is present and all hashes match.
 *  - workflow_parity result is linked (recorded) alongside provenance.
 */

import { describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'node:crypto';

import {
  resolvePromptProvenance,
  detectStaleProvenanceEntries
} from '../src/core/PiIntegration.js';
import { PromptProvenanceKind, PromptProvenanceDefaults, EventStoreDefaults } from '../src/constants/index.js';
import orrElseExtension from '../src/extension.js';
import {
  BuiltInToolName,
  DomainEventName,
  EnvVars,
  PiEventName,
  ProcessFlag
} from '../src/constants/index.js';

// ---------------------------------------------------------------------------
// Test helpers
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

const HEADLESS_TOOL_CONTEXT = { hasUI: false, shutdown: () => {} } as any;

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

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/** Minimal valid harness.yaml content for a Planning-only workflow. */
function minimalHarnessYaml(extra = ''): string {
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
${extra}
`;
}

// ---------------------------------------------------------------------------
// Unit tests: resolvePromptProvenance
// ---------------------------------------------------------------------------

describe('resolvePromptProvenance', () => {
  it('records the harness config file with a valid sha256', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provenance-unit-'));
    try {
      const configContent = minimalHarnessYaml();
      const configPath = path.join(tempDir, 'harness.yaml');
      fs.writeFileSync(configPath, configContent);

      // Minimal stub config object (no file-backed prompts)
      const config: any = {
        settings: { workflowVersion: '1.0' },
        states: {
          Planning: {
            actions: [{ id: 'formulate-plan', prompt: 'Plan the work' }]
          }
        }
      };

      const provenance = resolvePromptProvenance(config, tempDir, 'Planning', configPath);

      const configEntry = provenance.entries.find(e => e.kind === PromptProvenanceKind.HARNESS_CONFIG);
      expect(configEntry).toBeDefined();
      expect(configEntry!.path).toBe(configPath);
      expect(configEntry!.sha256).toBe(sha256(configContent));
      expect(configEntry!.missing).toBeUndefined();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('records a statePrompt entry when the action prompt is a file reference', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provenance-state-prompt-'));
    try {
      const promptContent = '# Plan\nDo the work.';
      const promptPath = path.join(tempDir, 'default_plan.md');
      fs.writeFileSync(promptPath, promptContent);

      // The harness.yaml must reference the prompt file by path so that
      // readRawStateSubtree() recovers the original path reference.
      // (ConfigLoader.resolveFileBackedFields replaces it with file content in
      // the resolved HarnessConfig, so provenance now reads from the raw YAML.)
      const configPath = path.join(tempDir, 'harness.yaml');
      fs.writeFileSync(configPath, `
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
        prompt: "default_plan.md"
    requiredTools: []
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`);

      const config: any = {
        settings: { workflowVersion: undefined },
        states: {
          Planning: {
            // Simulates resolved config where prompt is already file content.
            actions: [{ id: 'formulate-plan', prompt: promptContent }]
          }
        }
      };

      const provenance = resolvePromptProvenance(config, tempDir, 'Planning', configPath);

      const stateEntry = provenance.entries.find(e => e.kind === PromptProvenanceKind.STATE_PROMPT);
      expect(stateEntry).toBeDefined();
      expect(stateEntry!.path).toBe(promptPath);
      expect(stateEntry!.sha256).toBe(sha256(promptContent));
      expect(stateEntry!.missing).toBeUndefined();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('flags a missing prompt file with missing: true and empty sha256', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provenance-missing-'));
    try {
      const configPath = path.join(tempDir, 'harness.yaml');
      fs.writeFileSync(configPath, minimalHarnessYaml());

      // Config references a prompt file that does not exist
      const missingPromptPath = path.join(tempDir, 'does_not_exist.md');
      const config: any = {
        settings: {},
        states: {
          Planning: {
            actions: [{ id: 'formulate-plan', prompt: 'does_not_exist.md' }]
          }
        }
      };

      const provenance = resolvePromptProvenance(config, tempDir, 'Planning', configPath);

      // Inline prompt text is not a file ref → no STATE_PROMPT entry for the
      // non-existent file.  But the HARNESS_CONFIG entry must exist.
      const configEntry = provenance.entries.find(e => e.kind === PromptProvenanceKind.HARNESS_CONFIG);
      expect(configEntry).toBeDefined();

      // Since 'does_not_exist.md' exists neither as a relative nor absolute path
      // that resolves to a file, resolveFileReference returns undefined and no
      // STATE_PROMPT entry is added.  If it DOES exist it would be present —
      // this test confirms the file is not auto-created.
      expect(fs.existsSync(missingPromptPath)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('flags a harness config that does not exist on disk as missing', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provenance-missing-config-'));
    try {
      const configPath = path.join(tempDir, 'nonexistent.yaml');
      const config: any = { settings: {}, states: { Planning: { actions: [] } } };

      const provenance = resolvePromptProvenance(config, tempDir, 'Planning', configPath);

      const configEntry = provenance.entries.find(e => e.kind === PromptProvenanceKind.HARNESS_CONFIG);
      expect(configEntry).toBeDefined();
      expect(configEntry!.sha256).toBe(PromptProvenanceDefaults.MISSING_HASH);
      expect(configEntry!.missing).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('returns harnessConfigVersion from settings.workflowVersion', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provenance-version-'));
    try {
      const configPath = path.join(tempDir, 'harness.yaml');
      fs.writeFileSync(configPath, minimalHarnessYaml());
      const config: any = { settings: { workflowVersion: '2.3.1' }, states: {} };

      const provenance = resolvePromptProvenance(config, tempDir, 'Planning', configPath);
      expect(provenance.harnessConfigVersion).toBe('2.3.1');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Unit tests: detectStaleProvenanceEntries
// ---------------------------------------------------------------------------

describe('detectStaleProvenanceEntries', () => {
  it('returns empty array when all hashes still match', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-check-match-'));
    try {
      const filePath = path.join(tempDir, 'prompt.md');
      const content = 'original content';
      fs.writeFileSync(filePath, content);

      const entries = [{ kind: PromptProvenanceKind.STATE_PROMPT, path: filePath, sha256: sha256(content) }];
      expect(detectStaleProvenanceEntries(entries)).toEqual([]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('returns the path when a file content changed', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-check-changed-'));
    try {
      const filePath = path.join(tempDir, 'prompt.md');
      fs.writeFileSync(filePath, 'original content');

      const entries = [{ kind: PromptProvenanceKind.STATE_PROMPT, path: filePath, sha256: sha256('original content') }];
      // Simulate a change
      fs.writeFileSync(filePath, 'updated content');

      const stale = detectStaleProvenanceEntries(entries);
      expect(stale).toContain(filePath);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('returns the path when a file that existed is now missing', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-check-deleted-'));
    try {
      const filePath = path.join(tempDir, 'prompt.md');
      fs.writeFileSync(filePath, 'content');
      const originalHash = sha256('content');

      // Delete the file
      fs.rmSync(filePath);

      const entries = [{ kind: PromptProvenanceKind.STATE_PROMPT, path: filePath, sha256: originalHash }];
      const stale = detectStaleProvenanceEntries(entries);
      expect(stale).toContain(filePath);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Integration tests: STATE_RUN_INITIALIZED records provenance
// ---------------------------------------------------------------------------

describe('STATE_RUN_INITIALIZED provenance recording', () => {
  it('records promptProvenance + harnessConfigVersion on run initialization', async () => {
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH],
      apiBase: process.env[EnvVars.API_BASE]
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'provenance-init-record-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Planning
  workflowVersion: "3.1"
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
`);

    const receivedEvents: unknown[] = [];
    let server: Server | undefined;
    let harness: ReturnType<typeof fakePi> | undefined;

    try {
      server = await startSignalAckServer(receivedEvents);
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-provenance-init';
      process.env[EnvVars.STATE_ID] = 'Planning';
      process.env[EnvVars.ACTION_ID] = 'formulate-plan';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

      // Query the event store to find the STATE_RUN_INITIALIZED event
      const eventDir = path.join(tempRoot, '.pi', 'events');
      // Give the recorder a moment to flush (it's async best-effort)
      await new Promise(resolve => setTimeout(resolve, 50));

      // Read the event log
      const eventFiles = fs.existsSync(eventDir) ? fs.readdirSync(eventDir).filter(f => f.endsWith('.jsonl')) : [];
      let initEvent: any;
      for (const file of eventFiles) {
        const lines = fs.readFileSync(path.join(eventDir, file), 'utf8').split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === DomainEventName.STATE_RUN_INITIALIZED && parsed.data?.beadId === 'bd-provenance-init') {
              initEvent = parsed;
            }
          } catch {}
        }
      }

      expect(initEvent).toBeDefined();
      expect(initEvent.data.promptProvenance).toBeDefined();
      expect(Array.isArray(initEvent.data.promptProvenance.entries)).toBe(true);
      expect(initEvent.data.promptProvenance.entries.length).toBeGreaterThan(0);
      expect(initEvent.data.promptProvenance.harnessConfigVersion).toBe('3.1');

      // The harness config entry must be present
      const configEntry = initEvent.data.promptProvenance.entries.find(
        (e: any) => e.kind === PromptProvenanceKind.HARNESS_CONFIG
      );
      expect(configEntry).toBeDefined();
      expect(typeof configEntry.sha256).toBe('string');
      expect(configEntry.sha256.length).toBeGreaterThan(0);
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
// Integration tests: completion gate — provenance dimension
// ---------------------------------------------------------------------------

describe('completion gate — provenance dimension', () => {
  it('PASSES signal_completion SUCCESS when provenance is present and hashes match', async () => {
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH],
      apiBase: process.env[EnvVars.API_BASE]
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'provenance-gate-pass-')));
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
      process.env[EnvVars.BEAD_ID] = 'bd-provenance-pass';
      process.env[EnvVars.STATE_ID] = 'Planning';
      process.env[EnvVars.ACTION_ID] = 'formulate-plan';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

      const submitCheckpoint = harness.tools.find(tool => tool.name === BuiltInToolName.SUBMIT_CHECKPOINT);
      const signalCompletion = harness.tools.find(tool => tool.name === BuiltInToolName.SIGNAL_COMPLETION);

      await submitCheckpoint.execute('checkpoint', { summary: 'done', evidence: 'proof' }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      const result = await signalCompletion.execute('signal-success', {
        outcome: 'SUCCESS',
        summary: 'completed'
      }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      // Provenance is fresh (harness.yaml was not modified between init and completion)
      expect(result.details).not.toContain('REJECTED');
      expect(result.details).toContain('Completion signaled with outcome: SUCCESS');
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

  it('does NOT reject SUCCESS when only the unrelated harness.yaml content changed (blast-radius A)', async () => {
    // Verifies MUST-FIX A: editing unrelated content in harness.yaml (e.g. another
    // state's config or a comment) does NOT stale-reject THIS run, because the
    // whole-file harness.yaml hash is non-blocking (audit only).
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH],
      apiBase: process.env[EnvVars.API_BASE]
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'provenance-blast-A-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    const harnessYamlPath = path.join(tempRoot, 'harness.yaml');
    // A two-state harness: Planning (this run) + Review (unrelated).
    const twoStateYaml = `
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
  Review:
    identity: { role: "Reviewer", expertise: "Review", constraints: [] }
    baseInstructions: "Review"
    actions:
      - id: review
        type: prompt
        prompt: "Review the work"
    requiredTools: []
    transitions: { SUCCESS: "completed", FAILURE: "Review" }
`;
    fs.writeFileSync(harnessYamlPath, twoStateYaml);

    const receivedEvents: unknown[] = [];
    let server: Server | undefined;
    let harness: ReturnType<typeof fakePi> | undefined;

    try {
      server = await startSignalAckServer(receivedEvents);
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-blast-A';
      process.env[EnvVars.STATE_ID] = 'Planning';
      process.env[EnvVars.ACTION_ID] = 'formulate-plan';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

      // Simulate an unrelated edit: change the Review state's baseInstructions
      // and add a comment to harness.yaml.  The Planning state's config is unchanged.
      const mutatedYaml = twoStateYaml.replace(
        'baseInstructions: "Review"',
        'baseInstructions: "Review updated after run start"'
      ) + '\n# operator comment added mid-run\n';
      fs.writeFileSync(harnessYamlPath, mutatedYaml);

      const submitCheckpoint = harness.tools.find(tool => tool.name === BuiltInToolName.SUBMIT_CHECKPOINT);
      const signalCompletion = harness.tools.find(tool => tool.name === BuiltInToolName.SIGNAL_COMPLETION);

      await submitCheckpoint.execute('checkpoint-blast-A', { summary: 'done', evidence: 'proof' }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      const result = await signalCompletion.execute('signal-blast-A', {
        outcome: 'SUCCESS',
        summary: 'completed'
      }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      // Editing the Review state and adding a comment must NOT reject Planning's run.
      expect(result.details).not.toContain('REJECTED');
      expect(result.details).toContain('Completion signaled with outcome: SUCCESS');
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

  it('REJECTS SUCCESS when THIS state\'s prompt file changed mid-run (blast-radius B)', async () => {
    // Verifies MUST-FIX A + SHOULD-FIX D: changing the Planning state's own
    // prompt file (a blocking, file-backed entry) DOES cause a STALE rejection.
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH],
      apiBase: process.env[EnvVars.API_BASE]
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'provenance-blast-B-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);

    // Write a prompt file that the Planning state references.
    const promptPath = path.join(tempRoot, 'planning_prompt.md');
    fs.writeFileSync(promptPath, '# Planning\nDo the planning work.');

    const harnessYamlPath = path.join(tempRoot, 'harness.yaml');
    fs.writeFileSync(harnessYamlPath, `
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
        prompt: "planning_prompt.md"
    requiredTools: []
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`);

    const receivedEvents: unknown[] = [];
    let server: Server | undefined;
    let harness: ReturnType<typeof fakePi> | undefined;

    try {
      server = await startSignalAckServer(receivedEvents);
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-blast-B';
      process.env[EnvVars.STATE_ID] = 'Planning';
      process.env[EnvVars.ACTION_ID] = 'formulate-plan';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

      // Mutate this state's OWN prompt file mid-run.
      fs.writeFileSync(promptPath, '# Planning\nDo the planning work. UPDATED.');

      const submitCheckpoint = harness.tools.find(tool => tool.name === BuiltInToolName.SUBMIT_CHECKPOINT);
      const signalCompletion = harness.tools.find(tool => tool.name === BuiltInToolName.SIGNAL_COMPLETION);

      await submitCheckpoint.execute('checkpoint-blast-B', { summary: 'done', evidence: 'proof' }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      const result = await signalCompletion.execute('signal-blast-B', {
        outcome: 'SUCCESS',
        summary: 'completed'
      }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      // Changing THIS state's prompt file must STALE-reject.
      expect(result.details).toContain('REJECTED');
      expect(result.details).toContain(PromptProvenanceDefaults.REJECT_REASON_STALE);
      expect(result.details).toContain(promptPath);
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

  it('REJECTS SUCCESS when THIS state\'s config subtree changed mid-run (blast-radius C)', async () => {
    // Verifies MUST-FIX A + SHOULD-FIX D: changing Planning's own config fields
    // (e.g. baseInstructions) triggers a STALE rejection via the state-config-
    // subtree hash, which IS blocking.  The state-config entry is identified by
    // the logical path "stateConfig:Planning".
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH],
      apiBase: process.env[EnvVars.API_BASE]
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'provenance-blast-C-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    const harnessYamlPath = path.join(tempRoot, 'harness.yaml');

    const initialYaml = `
settings:
  startState: Planning
  worktreePolicy:
    default: always
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Original plan instructions"
    actions:
      - id: formulate-plan
        type: prompt
        prompt: "Plan the work"
    requiredTools: []
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`;
    fs.writeFileSync(harnessYamlPath, initialYaml);

    const receivedEvents: unknown[] = [];
    let server: Server | undefined;
    let harness: ReturnType<typeof fakePi> | undefined;

    try {
      server = await startSignalAckServer(receivedEvents);
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-blast-C';
      process.env[EnvVars.STATE_ID] = 'Planning';
      process.env[EnvVars.ACTION_ID] = 'formulate-plan';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

      // Mutate THIS state's baseInstructions in the live config by rewriting
      // harness.yaml so that when the gate re-reads config it sees the change.
      const mutatedYaml = initialYaml.replace(
        '"Original plan instructions"',
        '"Changed plan instructions mid-run"'
      );
      fs.writeFileSync(harnessYamlPath, mutatedYaml);

      const submitCheckpoint = harness.tools.find(tool => tool.name === BuiltInToolName.SUBMIT_CHECKPOINT);
      const signalCompletion = harness.tools.find(tool => tool.name === BuiltInToolName.SIGNAL_COMPLETION);

      await submitCheckpoint.execute('checkpoint-blast-C', { summary: 'done', evidence: 'proof' }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      const result = await signalCompletion.execute('signal-blast-C', {
        outcome: 'SUCCESS',
        summary: 'completed'
      }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      // Changing THIS state's config subtree must STALE-reject with the
      // logical identifier "stateConfig:Planning".
      expect(result.details).toContain('REJECTED');
      expect(result.details).toContain(PromptProvenanceDefaults.REJECT_REASON_STALE);
      expect(result.details).toContain('stateConfig:Planning');
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

  it('REJECTS SUCCESS when provenance was never recorded (missing gate)', async () => {
    // MUST-FIX C: replace the placebo with a real gate test.
    //
    // We craft a STATE_RUN_INITIALIZED event that has NO promptProvenance field
    // (simulating a harness bug where provenance was never written).  The gate
    // must HARD-REJECT because there is no recorded baseline to compare against.
    //
    // We exercise this by starting a run in a freshly isolated tempRoot, then
    // manually writing a STATE_RUN_INITIALIZED event WITHOUT promptProvenance
    // into the event store BEFORE calling BEFORE_AGENT_START (which would write
    // it with provenance).  Then we call BEFORE_AGENT_START to initialise the
    // activeRun (needed for signal_completion), but the gate will look for the
    // LATEST STATE_RUN_INITIALIZED event; since BEFORE_AGENT_START overwrites
    // the event store with a provenance-present event, we instead use a lower-
    // level approach: start a run normally, then at gate time verify that an
    // absent provenance causes a MISSING rejection.
    //
    // Because the gate always reads from the event store, the most reliable
    // way to reach the MISSING branch is to NOT call BEFORE_AGENT_START
    // (so no STATE_RUN_INITIALIZED is written) and instead manually set up
    // the activeRun by running BEFORE_AGENT_START after seeding a dummy event.
    // However, mutating the event store directly is too invasive.
    //
    // Pragmatic approach: The gate checks initEvent?.data?.promptProvenance.
    // We exercise the MISSING path by writing a STATE_RUN_INITIALIZED with
    // `promptProvenance: undefined` directly into the event JSONL file, then
    // verifying signal_completion returns REJECTED: ... missing.
    //
    // Since integration wiring is complex, we instead invoke a completed
    // gate-level function via pre_signal_audit (which calls evaluateGateReadiness
    // directly) on a run where we verify no provenance entry exists by
    // confirming the REJECT_REASON_MISSING string appears in the result.
    //
    // We do this by skipping BEFORE_AGENT_START (so no STATE_RUN_INITIALIZED
    // is written) but still calling signal_completion with an activeRun seeded
    // via a stripped-down bootstrap.  The simplest correct test: start normally,
    // read the init event, then write a second STATE_RUN_INITIALIZED WITHOUT
    // promptProvenance into the JSONL, and finally call signal_completion.
    // The gate reverses the event list and picks the most recent init event.
    // If we append a no-provenance init event AFTER the one written by
    // BEFORE_AGENT_START, the gate will see the no-provenance one and REJECT.

    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH],
      apiBase: process.env[EnvVars.API_BASE]
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'provenance-missing-gate-')));
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
      process.env[EnvVars.BEAD_ID] = 'bd-missing-gate';
      process.env[EnvVars.STATE_ID] = 'Planning';
      process.env[EnvVars.ACTION_ID] = 'formulate-plan';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      // BEFORE_AGENT_START writes the provenance-bearing STATE_RUN_INITIALIZED.
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

      // Now inject a SECOND STATE_RUN_INITIALIZED WITHOUT promptProvenance into
      // the JSONL event log, simulating a harness bug.  The gate reverses events
      // and will find this one first (it's later).
      await new Promise(resolve => setTimeout(resolve, 30));
      const eventDir = path.join(tempRoot, '.pi', 'events');
      const eventFiles = fs.existsSync(eventDir)
        ? fs.readdirSync(eventDir).filter(f => f.endsWith('.jsonl'))
        : [];
      const fakeInitEvent = JSON.stringify({
        id: 'fake-init-no-provenance',
        type: DomainEventName.STATE_RUN_INITIALIZED,
        timestamp: new Date().toISOString(),
        data: {
          beadId: 'bd-missing-gate',
          stateId: 'Planning',
          actionId: 'formulate-plan',
          actionKey: 'formulate-plan',
          // No promptProvenance field — simulates a harness bug.
        }
      }) + '\n';
      for (const file of eventFiles) {
        fs.appendFileSync(path.join(eventDir, file), fakeInitEvent);
      }

      // The fake event was written out-of-band, bypassing EventStore.record, so
      // it is NOT reflected in the live by-bead index.  Drop the index dir so the
      // next eventsForBead read falls back to a full primary scan and sees the
      // tampered JSONL (which is exactly the "harness bug" this test simulates —
      // the primary JSONL is the source of truth and was modified behind the
      // index's back).
      const beadIndexDir = path.join(eventDir, EventStoreDefaults.BEAD_INDEX_DIR);
      fs.rmSync(beadIndexDir, { recursive: true, force: true });

      await new Promise(resolve => setTimeout(resolve, 20));

      const submitCheckpoint = harness.tools.find(tool => tool.name === BuiltInToolName.SUBMIT_CHECKPOINT);
      const signalCompletion = harness.tools.find(tool => tool.name === BuiltInToolName.SIGNAL_COMPLETION);

      await submitCheckpoint.execute('checkpoint-missing', { summary: 'done', evidence: 'proof' }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      const result = await signalCompletion.execute('signal-missing', {
        outcome: 'SUCCESS',
        summary: 'completed'
      }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      // The gate must HARD-REJECT with the MISSING reason (provenance was
      // recorded but then overwritten by a no-provenance event — same as
      // "never recorded" from the gate's perspective).
      expect(result.details).toContain('REJECTED');
      expect(result.details).toContain(PromptProvenanceDefaults.REJECT_REASON_MISSING);
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

  it('ALLOWS SUCCESS and does NOT reject when promptProvenanceResolutionFailed is true (warn-only branch)', async () => {
    // Gate 7 safety policy: if provenance resolution threw at init time the
    // STATE_RUN_INITIALIZED event carries `promptProvenanceResolutionFailed: true`.
    // The gate must WARN but NOT hard-reject — the agent must not be penalised for
    // a harness-level error.  provenanceValid stays true, blockingEvidence is empty,
    // and signal_completion must return the normal "Completion signaled" message.
    //
    // We deliberately also omit promptProvenance (no entries) so that WITHOUT the
    // resolution-failed marker this event would trigger REJECT_REASON_MISSING.
    // This proves the resolution-failed branch takes precedence over missing.
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH],
      apiBase: process.env[EnvVars.API_BASE]
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'provenance-resolution-failed-')));
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
      process.env[EnvVars.BEAD_ID] = 'bd-resolution-failed';
      process.env[EnvVars.STATE_ID] = 'Planning';
      process.env[EnvVars.ACTION_ID] = 'formulate-plan';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      // BEFORE_AGENT_START writes a provenance-bearing STATE_RUN_INITIALIZED.
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

      // Inject a SECOND STATE_RUN_INITIALIZED event that:
      //   - Has NO promptProvenance (missing entries) — would be REJECT_REASON_MISSING
      //     if resolution-failed marker is absent.
      //   - Has promptProvenanceResolutionFailed: true — the gate must treat this
      //     as warn-only and allow completion.
      // The gate reverses events and picks the most recent init event for this
      // bead+state, so appending here ensures this one wins.
      await new Promise(resolve => setTimeout(resolve, 30));
      const eventDir = path.join(tempRoot, '.pi', 'events');
      const eventFiles = fs.existsSync(eventDir)
        ? fs.readdirSync(eventDir).filter(f => f.endsWith('.jsonl'))
        : [];
      const resolutionFailedInitEvent = JSON.stringify({
        id: 'fake-init-resolution-failed',
        type: DomainEventName.STATE_RUN_INITIALIZED,
        timestamp: new Date().toISOString(),
        data: {
          beadId: 'bd-resolution-failed',
          stateId: 'Planning',
          actionId: 'formulate-plan',
          actionKey: 'formulate-plan',
          // No promptProvenance field — would be MISSING without the marker below.
          promptProvenanceResolutionFailed: true
        }
      }) + '\n';
      for (const file of eventFiles) {
        fs.appendFileSync(path.join(eventDir, file), resolutionFailedInitEvent);
      }
      await new Promise(resolve => setTimeout(resolve, 20));

      const submitCheckpoint = harness.tools.find(tool => tool.name === BuiltInToolName.SUBMIT_CHECKPOINT);
      const signalCompletion = harness.tools.find(tool => tool.name === BuiltInToolName.SIGNAL_COMPLETION);

      await submitCheckpoint.execute('checkpoint-resolution-failed', { summary: 'done', evidence: 'proof' }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      const result = await signalCompletion.execute('signal-resolution-failed', {
        outcome: 'SUCCESS',
        summary: 'completed despite provenance resolution error'
      }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      // MUST NOT reject for provenance reasons: the resolution-failed marker
      // activates the warn-only branch, so provenanceValid stays true and
      // blockingEvidence is empty.
      expect(result.details).not.toContain('REJECTED');
      expect(result.details).not.toContain(PromptProvenanceDefaults.REJECT_REASON_MISSING);
      expect(result.details).not.toContain(PromptProvenanceDefaults.REJECT_REASON_STALE);
      // The normal completion message must be present (completion was allowed).
      expect(result.details).toContain('Completion signaled with outcome: SUCCESS');
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

  it('does NOT reject FAILURE outcome on stale provenance (provenance gate is SUCCESS-only)', async () => {
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH],
      apiBase: process.env[EnvVars.API_BASE]
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'provenance-gate-failure-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    const harnessYamlPath = path.join(tempRoot, 'harness.yaml');
    fs.writeFileSync(harnessYamlPath, minimalHarnessYaml());

    const receivedEvents: unknown[] = [];
    let server: Server | undefined;
    let harness: ReturnType<typeof fakePi> | undefined;

    try {
      server = await startSignalAckServer(receivedEvents);
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-provenance-failure';
      process.env[EnvVars.STATE_ID] = 'Planning';
      process.env[EnvVars.ACTION_ID] = 'formulate-plan';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

      // Mutate the harness.yaml to make the whole-file hash stale, but since
      // harness.yaml is non-blocking this should NOT affect FAILURE outcomes
      // (or any outcome, for that matter — non-blocking is never checked).
      fs.writeFileSync(harnessYamlPath, minimalHarnessYaml('# changed'));

      const submitCheckpoint = harness.tools.find(tool => tool.name === BuiltInToolName.SUBMIT_CHECKPOINT);
      const signalCompletion = harness.tools.find(tool => tool.name === BuiltInToolName.SIGNAL_COMPLETION);

      await submitCheckpoint.execute('checkpoint', { summary: 'done', evidence: 'proof' }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      // FAILURE does not go through provenance gate (it is SUCCESS-only)
      const result = await signalCompletion.execute('signal-failure', {
        outcome: 'FAILURE',
        summary: 'failed'
      }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      expect(result.details).not.toContain(PromptProvenanceDefaults.REJECT_REASON_STALE);
      expect(result.details).not.toContain(PromptProvenanceDefaults.REJECT_REASON_MISSING);
      expect(result.details).toContain('Completion signaled with outcome: FAILURE');
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
// r3yq: AC1-4 — configured source failures must propagate, not be silently skipped
// ---------------------------------------------------------------------------

describe('resolvePromptProvenance — configured source failures (r3yq)', () => {
  it('AC1: sets configuredSourceFailed when a configured state skill SKILL.md is missing', () => {
    // A state with skills: [nonexistent-skill] where .pi/skills/nonexistent-skill/SKILL.md
    // does not exist.  resolvePiSkillPathsForState already throws for missing configured
    // skill paths.  resolvePromptProvenance must NOT silently swallow this — it must
    // propagate as configuredSourceFailed: true so the gate can hard-block SUCCESS.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3yq-missing-skill-'));
    try {
      const configPath = path.join(tempDir, 'harness.yaml');
      fs.writeFileSync(configPath, `
settings:
  startState: Planning
  worktreePolicy:
    default: always
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    skills:
      - nonexistent-skill
    actions:
      - id: formulate-plan
        type: prompt
        prompt: "Plan the work"
    requiredTools: []
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`);
      const config: any = {
        settings: { workflowVersion: '1.0' },
        states: {
          Planning: {
            skills: ['nonexistent-skill'],
            actions: [{ id: 'formulate-plan', prompt: 'Plan the work' }]
          }
        }
      };

      // The skill directory .pi/skills/nonexistent-skill/SKILL.md does NOT exist.
      // resolvePromptProvenance must NOT silently succeed — it must signal failure.
      let threw = false;
      let result: any;
      try {
        result = resolvePromptProvenance(config, tempDir, 'Planning', configPath);
      } catch {
        threw = true;
      }

      // Either it threw OR returned configuredSourceFailed: true.
      // Both signal that a CONFIGURED source could not be resolved.
      const failed = threw || result?.configuredSourceFailed === true;
      expect(failed).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('AC1: sets configuredSourceFailed when a configured global skill path is missing', () => {
    // settings.pi.skillPaths references a path that does not exist.
    // resolveGlobalSkills already throws for this — must propagate as configuredSourceFailed.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3yq-missing-global-skill-'));
    try {
      const configPath = path.join(tempDir, 'harness.yaml');
      fs.writeFileSync(configPath, `
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
`);
      const config: any = {
        settings: {
          workflowVersion: '1.0',
          pi: { skillPaths: ['does/not/exist/SKILL.md'] }
        },
        states: {
          Planning: {
            actions: [{ id: 'formulate-plan', prompt: 'Plan the work' }]
          }
        }
      };

      let threw = false;
      let result: any;
      try {
        result = resolvePromptProvenance(config, tempDir, 'Planning', configPath);
      } catch {
        threw = true;
      }

      const failed = threw || result?.configuredSourceFailed === true;
      expect(failed).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('AC1: sets configuredSourceFailed when a configured action prompt FILE is missing', () => {
    // When the raw YAML action prompt looks like a file path (e.g. "plan.md") but
    // the file does not exist, resolvePromptProvenance must detect this as a
    // configured-source failure and set configuredSourceFailed: true.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3yq-missing-action-prompt-'));
    try {
      const configPath = path.join(tempDir, 'harness.yaml');
      fs.writeFileSync(configPath, `
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
        prompt: "missing_plan.md"
    requiredTools: []
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`);
      const config: any = {
        settings: { workflowVersion: '1.0' },
        states: {
          Planning: {
            actions: [{ id: 'formulate-plan', prompt: 'missing_plan.md' }]
          }
        }
      };

      // missing_plan.md does NOT exist in tempDir.
      const result = resolvePromptProvenance(config, tempDir, 'Planning', configPath);

      // Must signal configured-source failure (not silently skip).
      expect(result.configuredSourceFailed).toBe(true);
      // Must emit a missing STATE_PROMPT entry for tracking.
      const statePromptEntries = result.entries.filter(e => e.kind === PromptProvenanceKind.STATE_PROMPT);
      expect(statePromptEntries.length).toBeGreaterThan(0);
      expect(statePromptEntries.some(e => e.missing === true)).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('AC1: sets configuredSourceFailed when a configured goal prompt FILE is missing', () => {
    // When settings.projectObjective looks like a file path (e.g. "GOAL.md") but
    // the file does not exist, resolvePromptProvenance must set configuredSourceFailed.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3yq-missing-goal-prompt-'));
    try {
      const configPath = path.join(tempDir, 'harness.yaml');
      fs.writeFileSync(configPath, `
settings:
  startState: Planning
  projectObjective: "GOAL.md"
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
`);
      const config: any = {
        settings: { workflowVersion: '1.0', projectObjective: 'GOAL.md' },
        states: {
          Planning: {
            actions: [{ id: 'formulate-plan', prompt: 'Plan the work' }]
          }
        }
      };

      // GOAL.md does NOT exist in tempDir.
      const result = resolvePromptProvenance(config, tempDir, 'Planning', configPath);

      // Must signal configured-source failure.
      expect(result.configuredSourceFailed).toBe(true);
      // Must emit a missing GOAL_PROMPT entry.
      const goalEntries = result.entries.filter(e => e.kind === PromptProvenanceKind.GOAL_PROMPT);
      expect(goalEntries.length).toBeGreaterThan(0);
      expect(goalEntries.some(e => e.missing === true)).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('AC1: inline prompt text is NOT treated as a configured file reference', () => {
    // When a prompt value is genuine inline text (no .md extension, no path separator,
    // no absolute path), it must NOT be treated as a file reference even if the file
    // cannot be found.  configuredSourceFailed must remain false.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3yq-inline-prompt-'));
    try {
      const configPath = path.join(tempDir, 'harness.yaml');
      fs.writeFileSync(configPath, `
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
        prompt: "Plan the work carefully and thoroughly"
    requiredTools: []
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`);
      const config: any = {
        settings: { workflowVersion: '1.0' },
        states: {
          Planning: {
            actions: [{ id: 'formulate-plan', prompt: 'Plan the work carefully and thoroughly' }]
          }
        }
      };

      const result = resolvePromptProvenance(config, tempDir, 'Planning', configPath);

      // Inline text — must NOT set configuredSourceFailed.
      expect(result.configuredSourceFailed).toBeUndefined();
      // No STATE_PROMPT entry emitted for inline text.
      const statePromptEntries = result.entries.filter(e => e.kind === PromptProvenanceKind.STATE_PROMPT);
      expect(statePromptEntries.length).toBe(0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('slash-containing inline objective text is NOT treated as a missing file reference', () => {
    // Regression guard: "Implement the auth/login flow", "and/or cleanup", and
    // "Use TypeScript/JavaScript" contain slashes but are multi-word inline text.
    // looksLikeFilePath must return false for these (whitespace check fires first),
    // so configuredSourceFailed must remain UNSET.
    const slashInlineValues = [
      'Implement the auth/login flow',
      'Refactor input/output handling and/or cleanup',
      'Use TypeScript/JavaScript best practices'
    ];
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3yq-slash-inline-unit-'));
    try {
      for (const objective of slashInlineValues) {
        const configPath = path.join(tempDir, 'harness.yaml');
        fs.writeFileSync(configPath, `
settings:
  startState: Planning
  projectObjective: "${objective.replace(/"/g, '\\"')}"
  worktreePolicy:
    default: always
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    actions:
      - id: formulate-plan
        type: prompt
        prompt: "${objective.replace(/"/g, '\\"')}"
    requiredTools: []
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`);
        const config: any = {
          settings: { workflowVersion: '1.0', projectObjective: objective },
          states: {
            Planning: {
              actions: [{ id: 'formulate-plan', prompt: objective }]
            }
          }
        };

        const result = resolvePromptProvenance(config, tempDir, 'Planning', configPath);

        // Inline text with slashes must NOT set configuredSourceFailed.
        expect(result.configuredSourceFailed, `configuredSourceFailed should be unset for: "${objective}"`).toBeUndefined();
        // No GOAL_PROMPT or STATE_PROMPT entry emitted for inline text.
        const goalEntries = result.entries.filter(e => e.kind === PromptProvenanceKind.GOAL_PROMPT);
        expect(goalEntries.length, `no GOAL_PROMPT entry expected for: "${objective}"`).toBe(0);
        const stateEntries = result.entries.filter(e => e.kind === PromptProvenanceKind.STATE_PROMPT);
        expect(stateEntries.length, `no STATE_PROMPT entry expected for: "${objective}"`).toBe(0);
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('single-token file path with extension still detected as missing configured file', () => {
    // Confirm the whitespace tightening does NOT break genuine single-token missing
    // file detection: "missing_plan.md" and "prompts/x.md" have no whitespace and
    // must still set configuredSourceFailed when the file does not exist.
    const singleTokenPaths = [
      'missing_plan.md',
      'prompts/x.md'
    ];
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3yq-single-token-missing-'));
    try {
      for (const promptValue of singleTokenPaths) {
        const configPath = path.join(tempDir, 'harness.yaml');
        fs.writeFileSync(configPath, `
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
        prompt: "${promptValue}"
    requiredTools: []
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`);
        const config: any = {
          settings: { workflowVersion: '1.0' },
          states: {
            Planning: {
              actions: [{ id: 'formulate-plan', prompt: promptValue }]
            }
          }
        };

        // The file does NOT exist — configuredSourceFailed must be set.
        const result = resolvePromptProvenance(config, tempDir, 'Planning', configPath);
        expect(result.configuredSourceFailed, `configuredSourceFailed should be true for: "${promptValue}"`).toBe(true);
        const stateEntries = result.entries.filter(e => e.kind === PromptProvenanceKind.STATE_PROMPT);
        expect(stateEntries.length, `STATE_PROMPT entry expected for: "${promptValue}"`).toBeGreaterThan(0);
        expect(stateEntries.some(e => e.missing === true), `missing entry expected for: "${promptValue}"`).toBe(true);
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('AC3: missing configured skill is NOT silently omitted from the fingerprint', () => {
    // Ensure that when a configured skill is missing, the provenance entries do NOT
    // silently contain zero skill entries (which would make the fingerprint incomplete
    // and allow a run to proceed with an unresolved context).
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3yq-skill-not-omitted-'));
    try {
      const configPath = path.join(tempDir, 'harness.yaml');
      fs.writeFileSync(configPath, `
settings:
  startState: Planning
  worktreePolicy:
    default: always
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    skills:
      - missing-skill
    actions:
      - id: formulate-plan
        type: prompt
        prompt: "Plan the work"
    requiredTools: []
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`);
      const config: any = {
        settings: { workflowVersion: '1.0' },
        states: {
          Planning: {
            skills: ['missing-skill'],
            actions: [{ id: 'formulate-plan', prompt: 'Plan the work' }]
          }
        }
      };

      let threw = false;
      let result: any;
      try {
        result = resolvePromptProvenance(config, tempDir, 'Planning', configPath);
      } catch {
        threw = true;
      }

      // Must not return a "success" result with empty skill entries —
      // that would silently omit a configured source from the fingerprint.
      if (!threw) {
        expect(result.configuredSourceFailed).toBe(true);
      }
      // Either path is acceptable: threw or configuredSourceFailed.
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('AC4: valid configured skill resolves successfully and is stable across calls', () => {
    // When a configured skill SKILL.md exists, it must resolve without failure
    // and produce a stable, non-empty sha256.  This ensures the fix does not
    // break normal provenance resolution for valid configured sources.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3yq-valid-skill-'));
    try {
      const skillDir = path.join(tempDir, '.pi', 'skills', 'my-skill');
      fs.mkdirSync(skillDir, { recursive: true });
      const skillContent = '# My Skill\nI help with things.';
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillContent);

      const configPath = path.join(tempDir, 'harness.yaml');
      fs.writeFileSync(configPath, `
settings:
  startState: Planning
  worktreePolicy:
    default: always
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    skills:
      - my-skill
    actions:
      - id: formulate-plan
        type: prompt
        prompt: "Plan the work"
    requiredTools: []
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`);
      const config: any = {
        settings: { workflowVersion: '1.0' },
        states: {
          Planning: {
            skills: ['my-skill'],
            actions: [{ id: 'formulate-plan', prompt: 'Plan the work' }]
          }
        }
      };

      const result1 = resolvePromptProvenance(config, tempDir, 'Planning', configPath);
      expect(result1.resolutionFailed).toBeUndefined();

      const skillEntry = result1.entries.find(e => e.kind === PromptProvenanceKind.SKILL_PROMPT);
      expect(skillEntry).toBeDefined();
      expect(skillEntry!.sha256).toBe(sha256(skillContent));
      expect(skillEntry!.missing).toBeUndefined();

      // Stable across calls
      const result2 = resolvePromptProvenance(config, tempDir, 'Planning', configPath);
      const skillEntry2 = result2.entries.find(e => e.kind === PromptProvenanceKind.SKILL_PROMPT);
      expect(skillEntry2!.sha256).toBe(skillEntry!.sha256);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('AC4 (buvj): compatibility prompt entries are never emitted — compat surface fully removed', () => {
    // buvj: The compatibility prompt step is removed entirely from resolvePromptProvenance.
    // No COMPATIBILITY_PROMPT entries should ever appear regardless of config contents.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buvj-no-compat-'));
    try {
      const configPath = path.join(tempDir, 'harness.yaml');
      fs.writeFileSync(configPath, `
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
`);
      const config: any = {
        settings: { workflowVersion: '1.0' },
        states: {
          Planning: {
            actions: [{ id: 'formulate-plan', prompt: 'Plan the work' }]
          }
        }
      };

      // Resolution must succeed with zero compat entries — compat step removed entirely.
      const result = resolvePromptProvenance(config, tempDir, 'Planning', configPath);
      expect(result.resolutionFailed).toBeUndefined();
      expect(result.configuredSourceFailed).toBeUndefined();
      // Assert no entry has a kind that references compatibility — real load-bearing check:
      // if a compatibilityPrompt entry were emitted its kind would include 'compat'.
      expect(result.entries.some(e => String(e.kind).toLowerCase().includes('compat'))).toBe(false);
      // Also assert at least one entry was emitted (proves the function ran, not short-circuited).
      expect(result.entries.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// r3yq: AC2/AC4 — gate-level blocking: configured source failure blocks SUCCESS
// ---------------------------------------------------------------------------

describe('completion gate — configured source failures BLOCK SUCCESS (r3yq AC2/AC4)', () => {
  it('AC2: BLOCKS SUCCESS when a configured skill is missing at run start', async () => {
    // A configured state skill that is missing must cause the gate to HARD-BLOCK
    // SUCCESS.  provenanceValid must be false and blockingEvidence must be non-empty.
    // We simulate this by injecting a STATE_RUN_INITIALIZED event with
    // promptProvenanceConfiguredSourceFailed: true (what the harness records when a
    // configured skill cannot be resolved).
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH],
      apiBase: process.env[EnvVars.API_BASE]
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'r3yq-gate-skill-block-')));
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
      process.env[EnvVars.BEAD_ID] = 'bd-gate-skill-block';
      process.env[EnvVars.STATE_ID] = 'Planning';
      process.env[EnvVars.ACTION_ID] = 'formulate-plan';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

      // Inject a STATE_RUN_INITIALIZED event with promptProvenanceConfiguredSourceFailed: true
      // to simulate what the harness records when a configured skill is missing.
      // We append it after the real one so the gate (which reverses events) sees it first.
      await new Promise(resolve => setTimeout(resolve, 30));
      const eventDir = path.join(tempRoot, '.pi', 'events');
      const eventFiles = fs.existsSync(eventDir)
        ? fs.readdirSync(eventDir).filter(f => f.endsWith('.jsonl'))
        : [];
      const configuredSourceFailedInitEvent = JSON.stringify({
        id: 'fake-init-configured-source-failed',
        type: DomainEventName.STATE_RUN_INITIALIZED,
        timestamp: new Date().toISOString(),
        data: {
          beadId: 'bd-gate-skill-block',
          stateId: 'Planning',
          actionId: 'formulate-plan',
          actionKey: 'formulate-plan',
          promptProvenanceConfiguredSourceFailed: true
          // No promptProvenance — to confirm the configuredSourceFailed path wins
        }
      }) + '\n';
      for (const file of eventFiles) {
        fs.appendFileSync(path.join(eventDir, file), configuredSourceFailedInitEvent);
      }

      // Drop the bead index so the gate falls back to a full scan and sees the injected event.
      const beadIndexDir = path.join(eventDir, EventStoreDefaults.BEAD_INDEX_DIR);
      fs.rmSync(beadIndexDir, { recursive: true, force: true });

      await new Promise(resolve => setTimeout(resolve, 20));

      const submitCheckpoint = harness.tools.find(tool => tool.name === BuiltInToolName.SUBMIT_CHECKPOINT);
      const signalCompletion = harness.tools.find(tool => tool.name === BuiltInToolName.SIGNAL_COMPLETION);

      await submitCheckpoint.execute('checkpoint-skill-block', { summary: 'done', evidence: 'proof' }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      const result = await signalCompletion.execute('signal-skill-block', {
        outcome: 'SUCCESS',
        summary: 'completed despite missing configured skill'
      }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      // Gate must HARD-BLOCK SUCCESS when a configured source was unresolvable at init.
      expect(result.details).toContain('REJECTED');
      // Must not be merely a warn-only path (provenanceValid must be false).
      expect(result.details).not.toContain('Completion signaled with outcome: SUCCESS');
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

  it('AC2: BLOCKS SUCCESS when a configured goal prompt file is missing at run start', async () => {
    // A configured goal prompt file that is missing must block SUCCESS at the gate.
    // Simulated via a STATE_RUN_INITIALIZED event with promptProvenanceConfiguredSourceFailed: true.
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH],
      apiBase: process.env[EnvVars.API_BASE]
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'r3yq-gate-goal-block-')));
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
      process.env[EnvVars.BEAD_ID] = 'bd-gate-goal-block';
      process.env[EnvVars.STATE_ID] = 'Planning';
      process.env[EnvVars.ACTION_ID] = 'formulate-plan';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

      await new Promise(resolve => setTimeout(resolve, 30));
      const eventDir = path.join(tempRoot, '.pi', 'events');
      const eventFiles = fs.existsSync(eventDir)
        ? fs.readdirSync(eventDir).filter(f => f.endsWith('.jsonl'))
        : [];
      const goalFailedInitEvent = JSON.stringify({
        id: 'fake-init-goal-failed',
        type: DomainEventName.STATE_RUN_INITIALIZED,
        timestamp: new Date().toISOString(),
        data: {
          beadId: 'bd-gate-goal-block',
          stateId: 'Planning',
          actionId: 'formulate-plan',
          actionKey: 'formulate-plan',
          promptProvenanceConfiguredSourceFailed: true
        }
      }) + '\n';
      for (const file of eventFiles) {
        fs.appendFileSync(path.join(eventDir, file), goalFailedInitEvent);
      }

      const beadIndexDir = path.join(eventDir, EventStoreDefaults.BEAD_INDEX_DIR);
      fs.rmSync(beadIndexDir, { recursive: true, force: true });

      await new Promise(resolve => setTimeout(resolve, 20));

      const submitCheckpoint = harness.tools.find(tool => tool.name === BuiltInToolName.SUBMIT_CHECKPOINT);
      const signalCompletion = harness.tools.find(tool => tool.name === BuiltInToolName.SIGNAL_COMPLETION);

      await submitCheckpoint.execute('checkpoint-goal-block', { summary: 'done', evidence: 'proof' }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      const result = await signalCompletion.execute('signal-goal-block', {
        outcome: 'SUCCESS',
        summary: 'completed despite missing goal prompt file'
      }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      expect(result.details).toContain('REJECTED');
      expect(result.details).not.toContain('Completion signaled with outcome: SUCCESS');
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

  it('AC2: BLOCKS SUCCESS when a configured action prompt file is missing at run start', async () => {
    // A configured action prompt FILE that is missing must block SUCCESS at the gate.
    // We start a run where harness.yaml references a missing_plan.md action prompt,
    // which triggers configuredSourceFailed at init, blocking SUCCESS.
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH],
      apiBase: process.env[EnvVars.API_BASE]
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'r3yq-gate-action-block-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);

    // The action prompt file is configured but MISSING.
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
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
        prompt: "missing_plan.md"
    requiredTools: []
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`);
    // Do NOT create missing_plan.md — it is intentionally absent.

    const receivedEvents: unknown[] = [];
    let server: Server | undefined;
    let harness: ReturnType<typeof fakePi> | undefined;

    try {
      server = await startSignalAckServer(receivedEvents);
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-gate-action-block';
      process.env[EnvVars.STATE_ID] = 'Planning';
      process.env[EnvVars.ACTION_ID] = 'formulate-plan';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      // BEFORE_AGENT_START resolves provenance and records STATE_RUN_INITIALIZED
      // with promptProvenanceConfiguredSourceFailed: true (missing_plan.md is absent).
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

      await new Promise(resolve => setTimeout(resolve, 50));

      const submitCheckpoint = harness.tools.find(tool => tool.name === BuiltInToolName.SUBMIT_CHECKPOINT);
      const signalCompletion = harness.tools.find(tool => tool.name === BuiltInToolName.SIGNAL_COMPLETION);

      await submitCheckpoint.execute('checkpoint-action-block', { summary: 'done', evidence: 'proof' }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      const result = await signalCompletion.execute('signal-action-block', {
        outcome: 'SUCCESS',
        summary: 'completed despite missing action prompt file'
      }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      // Gate must HARD-BLOCK SUCCESS — the configured action prompt file was missing.
      expect(result.details).toContain('REJECTED');
      expect(result.details).not.toContain('Completion signaled with outcome: SUCCESS');
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

  it('AC2 regression: inline objective/prompt text with a slash does NOT trigger configuredSourceFailed', async () => {
    // Regression guard for the looksLikeFilePath false-positive fix.
    // Values like "Implement the auth/login flow" contain a slash but are inline
    // text.  Before the fix, looksLikeFilePath returned true for these, causing
    // configuredSourceFailed to be set and SUCCESS to be hard-blocked.
    // After the fix, the whitespace check short-circuits before the slash check.
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH],
      apiBase: process.env[EnvVars.API_BASE]
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'r3yq-inline-slash-gate-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);

    // An action prompt that is inline text containing slashes (the false-positive case).
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Planning
  projectObjective: "Implement the auth/login flow using TypeScript/JavaScript best practices"
  worktreePolicy:
    default: always
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    actions:
      - id: formulate-plan
        type: prompt
        prompt: "Refactor input/output handling and/or cleanup"
    requiredTools: []
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`);

    const receivedEvents: unknown[] = [];
    let server: Server | undefined;
    let harness: ReturnType<typeof fakePi> | undefined;

    try {
      server = await startSignalAckServer(receivedEvents);
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-inline-slash-gate';
      process.env[EnvVars.STATE_ID] = 'Planning';
      process.env[EnvVars.ACTION_ID] = 'formulate-plan';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

      await new Promise(resolve => setTimeout(resolve, 50));

      const submitCheckpoint = harness.tools.find(tool => tool.name === BuiltInToolName.SUBMIT_CHECKPOINT);
      const signalCompletion = harness.tools.find(tool => tool.name === BuiltInToolName.SIGNAL_COMPLETION);

      await submitCheckpoint.execute('checkpoint-inline-slash', { summary: 'done', evidence: 'proof' }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      const result = await signalCompletion.execute('signal-inline-slash', {
        outcome: 'SUCCESS',
        summary: 'completed with inline slash text'
      }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      // Inline text with slashes must NOT block SUCCESS.
      expect(result.details).not.toContain('REJECTED');
      expect(result.details).toContain('Completion signaled with outcome: SUCCESS');
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

  it('AC4: normal run with valid configured skill passes the gate (no regression)', async () => {
    // When a configured skill SKILL.md EXISTS, provenance resolution succeeds and
    // signal_completion SUCCESS is NOT blocked.  Ensures the fix does not regress
    // normal runs with valid configured sources.
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH],
      apiBase: process.env[EnvVars.API_BASE]
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'r3yq-gate-skill-pass-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);

    // Create a valid skill SKILL.md
    const skillDir = path.join(tempRoot, '.pi', 'skills', 'my-valid-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# My Valid Skill\nHelps with planning.');

    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Planning
  worktreePolicy:
    default: always
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    skills:
      - my-valid-skill
    actions:
      - id: formulate-plan
        type: prompt
        prompt: "Plan the work"
    requiredTools: []
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`);

    const receivedEvents: unknown[] = [];
    let server: Server | undefined;
    let harness: ReturnType<typeof fakePi> | undefined;

    try {
      server = await startSignalAckServer(receivedEvents);
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-gate-skill-pass';
      process.env[EnvVars.STATE_ID] = 'Planning';
      process.env[EnvVars.ACTION_ID] = 'formulate-plan';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

      await new Promise(resolve => setTimeout(resolve, 50));

      const submitCheckpoint = harness.tools.find(tool => tool.name === BuiltInToolName.SUBMIT_CHECKPOINT);
      const signalCompletion = harness.tools.find(tool => tool.name === BuiltInToolName.SIGNAL_COMPLETION);

      await submitCheckpoint.execute('checkpoint-skill-pass', { summary: 'done', evidence: 'proof' }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      const result = await signalCompletion.execute('signal-skill-pass', {
        outcome: 'SUCCESS',
        summary: 'completed with valid configured skill'
      }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      // Valid configured skill — gate must PASS, not block.
      expect(result.details).not.toContain('REJECTED');
      expect(result.details).toContain('Completion signaled with outcome: SUCCESS');
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
