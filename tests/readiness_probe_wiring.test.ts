/**
 * readiness_probe_wiring.test.ts — pi-experiment-8ieq
 *
 * LOAD-BEARING wiring test: drives the REAL startup entry point (startOrrElse,
 * via the /orr-else command handler registered by orrElseExtension) and asserts
 * that a failed required-tool readiness probe aborts startup BEFORE any pi/model
 * subprocess spawn (i.e. before Supervisor.start()).
 *
 * This test FAILS if the runStartupProbeAdmission call is removed from
 * extension.ts (AC5 wiring) — confirming the admission is genuinely wired.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';

import orrElseExtension from '../src/extension.js';
import { BuiltInToolName, ProjectToolType } from '../src/constants/domain.js';
import { EnvVars, PiEventName } from '../src/constants/infra.js';

// ── Minimal fake Pi surface ───────────────────────────────────────────────────

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

const HEADLESS_CTX = { hasUI: false, shutdown: () => {} } as any;

// ── Harness yaml WITH a failing probeContext:true tool ────────────────────────

function makeHarnessYaml(toolsBlock: string): string {
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
    actions: [{ id: a1, type: prompt }]
    transitions: { SUCCESS: done, FAILURE: Alpha, BLOCKED: Alpha }
${toolsBlock}
`;
}

// ── Setup / teardown helpers ──────────────────────────────────────────────────

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
    fs.mkdtempSync(path.join(os.tmpdir(), 'probe-wiring-test-'))
  );
  fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), yaml);
  // Pre-create the log directory so Logger doesn't fail with ENOENT when the
  // test process cleans up the tempRoot before the Logger flush completes.
  fs.mkdirSync(path.join(tempRoot, '.pi', 'logs'), { recursive: true });

  process.chdir(tempRoot);
  process.env[EnvVars.PROJECT_ROOT] = tempRoot;
  process.env[EnvVars.WORKTREE_PATH] = tempRoot;
  // Coordinator mode: clear worker-mode vars
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AC5 startup-wiring: failed required probe aborts startOrrElse before pi spawn', () => {
  let env: TestEnv | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    if (env) { teardown(env); env = undefined; }
  });

  it('aborts startup (Supervisor.start never called) when a required probeContext tool fails', async () => {
    // Config with a probeContext:true tool whose command exits non-zero.
    // safeForReadinessProbe:true is required for the probe to run (otherwise
    // UNSAFE → DENY on a required tool, which also triggers the gate).
    // Note: `required` is NOT a top-level tool schema field; omitting it means
    // the admission logic defaults to required=true (see runStartupProbeAdmission).
    const toolsBlock = `
tools:
  - name: failing_health_check
    type: command
    command: ${process.execPath}
    defaultArgs: ["-e", "process.exit(1)"]
    probeContext: true
    sideEffectContract:
      cancellationPolicy: not_supported
      idempotencyClass: idempotent
      serializationKey: null
      allowedInReadOnlyContext: true
      safeForReadinessProbe: true
`;
    env = setup(makeHarnessYaml(toolsBlock));

    // Spy on Supervisor.prototype.start — the REAL pi spawn path.
    // If the wiring is correct, this is NEVER called when a probe blocks.
    const { Supervisor } = await import('../src/core/Supervisor.js');
    const supervisorStartSpy = vi.spyOn(Supervisor.prototype, 'start').mockResolvedValue(undefined as any);

    // Also mock SignalingServer so it doesn't bind a real port.
    const { SignalingServer } = await import('../src/core/SignalingServer.js');
    const signalingStartSpy = vi.spyOn(SignalingServer.prototype, 'start').mockResolvedValue(19998);

    const harness = fakePi();
    await orrElseExtension(harness.pi);
    await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: env.tempRoot });

    const commandHandler = harness.commands[BuiltInToolName.ORR_ELSE]?.handler;
    expect(commandHandler).toBeDefined();

    // Track whether the command threw or produced an error notification.
    const notifiedErrors: string[] = [];
    const cmdCtx = {
      hasUI: true,
      ui: { notify: (msg: string, level: string) => { if (level === 'error') notifiedErrors.push(msg); } }
    } as any;

    // The command handler wraps startOrrElse in try/catch and notifies on error.
    await commandHandler('--bead bd-probe-wiring-test', cmdCtx);

    // ASSERTION 1 (load-bearing): Supervisor.start was NEVER called.
    // If runStartupProbeAdmission wiring is removed, the probe does not run and
    // startup proceeds — supervisorStartSpy would be called, failing this assertion.
    expect(supervisorStartSpy).not.toHaveBeenCalled();

    // ASSERTION 2: the failure was reported to the operator.
    expect(notifiedErrors.length).toBeGreaterThan(0);
    const errorMsg = notifiedErrors.join('\n');
    expect(errorMsg).toMatch(/failing_health_check|readiness probe|probe/i);

    signalingStartSpy.mockRestore();
    supervisorStartSpy.mockRestore();
  });

  it('allows startup to proceed (Supervisor.start called) when no probeContext tools are configured', async () => {
    // Config with NO probeContext tools: admission must be a no-op.
    const toolsBlock = `
tools:
  - name: plain_tool
    type: command
    command: ${process.execPath}
    defaultArgs: ["-e", "process.exit(0)"]
    sideEffectContract:
      cancellationPolicy: not_supported
      idempotencyClass: idempotent
      serializationKey: null
      allowedInReadOnlyContext: true
      safeForReadinessProbe: false
`;
    env = setup(makeHarnessYaml(toolsBlock));

    const { Supervisor } = await import('../src/core/Supervisor.js');
    const supervisorStartSpy = vi.spyOn(Supervisor.prototype, 'start').mockResolvedValue(undefined as any);
    const { SignalingServer } = await import('../src/core/SignalingServer.js');
    const signalingStartSpy = vi.spyOn(SignalingServer.prototype, 'start').mockResolvedValue(19997);

    const harness = fakePi();
    await orrElseExtension(harness.pi);
    await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: env.tempRoot });

    const commandHandler = harness.commands[BuiltInToolName.ORR_ELSE]?.handler;
    await commandHandler('--bead bd-no-probe-test', {
      hasUI: true,
      ui: { notify: () => {} }
    } as any);

    // Supervisor.start MUST be called — admission was a no-op (no probeContext tools).
    expect(supervisorStartSpy).toHaveBeenCalledTimes(1);

    signalingStartSpy.mockRestore();
    supervisorStartSpy.mockRestore();
  });
});
