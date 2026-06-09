/**
 * v2_substrate_preflight_wiring.test.ts — pi-experiment-ek2j
 *
 * LOAD-BEARING wiring test: drives the REAL startup entry point (startOrrElse,
 * via the /orr-else command handler registered by orrElseExtension) and asserts:
 *
 *   (a) Substrate-missing (tmux or git-worktree fails) → startup ABORTS before
 *       Supervisor.start() is ever called (fail-closed), and the operator
 *       receives a deterministic diagnostic.
 *
 *   (b) Substrate-available (both pass) → startup PROCEEDS and Supervisor.start()
 *       IS called.
 *
 *   (c) v1 config → substrate preflight is NOT run at all (version-gated).
 *
 * This test FAILS if the runV2SubstratePreflight call is removed from
 * extension.ts — confirming the preflight is genuinely wired, not orphaned.
 *
 * The v2 harness.yaml used here has the minimum schema required for a valid v2
 * config (version: 2, statechart, states). Tools block is empty so the
 * readiness-probe admission is a no-op; the substrate preflight is the only
 * admission gate exercised.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';

import orrElseExtension from '../src/extension.js';
import { BuiltInToolName } from '../src/constants/domain.js';
import { EnvVars, PiEventName } from '../src/constants/infra.js';
import {
  setSubstrateProbesForTest,
  resetSubstrateProbes
} from '../src/core/V2SubstratePreflight.js';

// ---------------------------------------------------------------------------
// Fake Pi surface (mirrors readiness_probe_wiring.test.ts)
// ---------------------------------------------------------------------------

function fakePi() {
  const tools: any[] = [];
  const commands: Record<string, any> = {};
  const callbacks: Record<string, Function> = {};
  return {
    tools,
    commands,
    callbacks,
    pi: {
      on: (name: string, callback: Function) => { callbacks[name] = callback; },
      registerTool: (tool: any) => tools.push(tool),
      registerCommand: (name: string, options: any) => { commands[name] = options; },
      getActiveTools: () => [] as string[],
      setActiveTools: () => {},
      setThinkingLevel: () => {},
      setModel: async () => true,
      sendUserMessage: () => {}
    } as any
  };
}

// ---------------------------------------------------------------------------
// Harness yaml builders
// ---------------------------------------------------------------------------

function makeV2HarnessYaml(): string {
  return `
version: 2
settings:
  maxConcurrentSlots: 1
statechart:
  initial: Alpha
  terminal: [done]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
states:
  Alpha:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      a1:
        type: prompt
        prompt: "Do work."
    transitions: { SUCCESS: done, FAILURE: Alpha, BLOCKED: Alpha }
`;
}

function makeV1HarnessYaml(): string {
  return `
settings:
  startState: Alpha
  worktreePolicy:
    default: always
statechart:
  terminalStates: [done]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
states:
  Alpha:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      - id: a1
        type: prompt
    transitions: { SUCCESS: done, FAILURE: Alpha, BLOCKED: Alpha }
`;
}

// ---------------------------------------------------------------------------
// Setup / teardown helpers
// ---------------------------------------------------------------------------

interface TestEnv {
  tempRoot: string;
  prevEnv: Record<string, string | undefined>;
  prevCwd: string;
}

function setup(yaml: string): TestEnv {
  const prevCwd = process.cwd();
  const prevEnv: Record<string, string | undefined> = {
    [EnvVars.PROJECT_ROOT]: process.env[EnvVars.PROJECT_ROOT],
    [EnvVars.WORKTREE_PATH]: process.env[EnvVars.WORKTREE_PATH],
    [EnvVars.WORKER_MODE]: process.env[EnvVars.WORKER_MODE],
    [EnvVars.BEAD_ID]: process.env[EnvVars.BEAD_ID],
    [EnvVars.STATE_ID]: process.env[EnvVars.STATE_ID],
  };

  const tempRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'substrate-wiring-test-'))
  );
  fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), yaml);
  // Pre-create the log directory so Logger doesn't fail with ENOENT on cleanup.
  fs.mkdirSync(path.join(tempRoot, '.pi', 'logs'), { recursive: true });

  // The git-worktree probe uses projectRoot as cwd — the tempRoot is not a
  // real git repo but the probe is intercepted by setSubstrateProbesForTest,
  // so the actual filesystem state does not matter for the wiring test.
  process.chdir(tempRoot);
  process.env[EnvVars.PROJECT_ROOT] = tempRoot;
  process.env[EnvVars.WORKTREE_PATH] = tempRoot;
  // Coordinator mode: clear worker-mode vars.
  delete process.env[EnvVars.WORKER_MODE];
  delete process.env[EnvVars.BEAD_ID];
  delete process.env[EnvVars.STATE_ID];

  return { tempRoot, prevEnv, prevCwd };
}

function teardown(env: TestEnv): void {
  process.chdir(env.prevCwd);
  for (const [key, value] of Object.entries(env.prevEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(env.tempRoot, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ek2j wiring: v2 substrate preflight in startOrrElse', () => {
  let env: TestEnv | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    resetSubstrateProbes();
    if (env) { teardown(env); env = undefined; }
  });

  it('(a) aborts startup (Supervisor.start never called) when tmux substrate fails', async () => {
    // Inject: tmux fails, git passes.
    setSubstrateProbesForTest({
      tmux: async () => ({ ok: false, stderr: 'no server running on /tmp/tmux-1000/default' }),
      git: async () => ({ ok: true })
    });

    env = setup(makeV2HarnessYaml());

    const { Supervisor } = await import('../src/core/Supervisor.js');
    const supervisorStartSpy = vi.spyOn(Supervisor.prototype, 'start').mockResolvedValue(undefined as any);
    const { SignalingServer } = await import('../src/core/SignalingServer.js');
    const signalingStartSpy = vi.spyOn(SignalingServer.prototype, 'start').mockResolvedValue(19996);

    const harness = fakePi();
    await orrElseExtension(harness.pi);
    await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: env.tempRoot });

    const commandHandler = harness.commands[BuiltInToolName.ORR_ELSE]?.handler;
    expect(commandHandler).toBeDefined();

    const notifiedErrors: string[] = [];
    const cmdCtx = {
      hasUI: true,
      ui: { notify: (msg: string, level: string) => { if (level === 'error') notifiedErrors.push(msg); } }
    } as any;

    await commandHandler('--bead bd-substrate-wiring-test', cmdCtx);

    // LOAD-BEARING: Supervisor.start must NOT be called.
    // If runV2SubstratePreflight wiring is removed, substrate is not checked
    // and startup proceeds — this assertion would fail, proving the wiring.
    expect(supervisorStartSpy).not.toHaveBeenCalled();

    // Operator receives a diagnostic naming the failing substrate.
    expect(notifiedErrors.length).toBeGreaterThan(0);
    const errorMsg = notifiedErrors.join('\n');
    expect(errorMsg).toMatch(/tmux|substrate/i);

    signalingStartSpy.mockRestore();
    supervisorStartSpy.mockRestore();
  });

  it('(a) aborts startup when git-worktree substrate fails', async () => {
    setSubstrateProbesForTest({
      tmux: async () => ({ ok: true }),
      git: async () => ({ ok: false, stderr: 'not a git repository' })
    });

    env = setup(makeV2HarnessYaml());

    const { Supervisor } = await import('../src/core/Supervisor.js');
    const supervisorStartSpy = vi.spyOn(Supervisor.prototype, 'start').mockResolvedValue(undefined as any);
    const { SignalingServer } = await import('../src/core/SignalingServer.js');
    const signalingStartSpy = vi.spyOn(SignalingServer.prototype, 'start').mockResolvedValue(19995);

    const harness = fakePi();
    await orrElseExtension(harness.pi);
    await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: env.tempRoot });

    const commandHandler = harness.commands[BuiltInToolName.ORR_ELSE]?.handler;
    const notifiedErrors: string[] = [];
    const cmdCtx = {
      hasUI: true,
      ui: { notify: (msg: string, level: string) => { if (level === 'error') notifiedErrors.push(msg); } }
    } as any;

    await commandHandler('--bead bd-git-substrate-test', cmdCtx);

    expect(supervisorStartSpy).not.toHaveBeenCalled();
    expect(notifiedErrors.join('\n')).toMatch(/git.worktree|substrate/i);

    signalingStartSpy.mockRestore();
    supervisorStartSpy.mockRestore();
  });

  it('(b) allows startup to proceed (Supervisor.start called) when both substrates pass', async () => {
    setSubstrateProbesForTest({
      tmux: async () => ({ ok: true }),
      git: async () => ({ ok: true })
    });

    env = setup(makeV2HarnessYaml());

    const { Supervisor } = await import('../src/core/Supervisor.js');
    const supervisorStartSpy = vi.spyOn(Supervisor.prototype, 'start').mockResolvedValue(undefined as any);
    const { SignalingServer } = await import('../src/core/SignalingServer.js');
    const signalingStartSpy = vi.spyOn(SignalingServer.prototype, 'start').mockResolvedValue(19994);

    const harness = fakePi();
    await orrElseExtension(harness.pi);
    await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: env.tempRoot });

    const commandHandler = harness.commands[BuiltInToolName.ORR_ELSE]?.handler;
    await commandHandler('--bead bd-substrate-pass-test', {
      hasUI: true,
      ui: { notify: () => {} }
    } as any);

    // Supervisor.start MUST be called — both substrates passed.
    expect(supervisorStartSpy).toHaveBeenCalledTimes(1);

    signalingStartSpy.mockRestore();
    supervisorStartSpy.mockRestore();
  });

  it('(c) v1 config — substrate preflight is NOT called (version-gated)', async () => {
    // Inject failing probes — they must never be called for v1.
    const tmuxProbeSpy = vi.fn(async () => ({ ok: false, stderr: 'should not be called' }));
    const gitProbeSpy = vi.fn(async () => ({ ok: false, stderr: 'should not be called' }));
    setSubstrateProbesForTest({ tmux: tmuxProbeSpy, git: gitProbeSpy });

    env = setup(makeV1HarnessYaml());

    const { Supervisor } = await import('../src/core/Supervisor.js');
    const supervisorStartSpy = vi.spyOn(Supervisor.prototype, 'start').mockResolvedValue(undefined as any);
    const { SignalingServer } = await import('../src/core/SignalingServer.js');
    const signalingStartSpy = vi.spyOn(SignalingServer.prototype, 'start').mockResolvedValue(19993);

    const harness = fakePi();
    await orrElseExtension(harness.pi);
    await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: env.tempRoot });

    const commandHandler = harness.commands[BuiltInToolName.ORR_ELSE]?.handler;
    await commandHandler('--bead bd-v1-config-test', {
      hasUI: true,
      ui: { notify: () => {} }
    } as any);

    // Substrate probes must NEVER be invoked for v1 configs.
    expect(tmuxProbeSpy).not.toHaveBeenCalled();
    expect(gitProbeSpy).not.toHaveBeenCalled();

    // v1 startup proceeds normally — Supervisor.start is called.
    expect(supervisorStartSpy).toHaveBeenCalledTimes(1);

    signalingStartSpy.mockRestore();
    supervisorStartSpy.mockRestore();
  });
});
