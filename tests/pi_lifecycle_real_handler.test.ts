/**
 * pi-experiment-1elr.10: LOAD-BEARING real-handler lifecycle integration tests.
 *
 * PURPOSE
 * -------
 * Each test drives invalid or boundary lifecycle sequences through the REAL
 * extension.ts handlers (via orrElseExtension + fakePi callbacks) and asserts
 * PRODUCTION behavior changes.  Every test documented below WILL FAIL if the
 * corresponding enforcement `return` or field spread is removed from extension.ts.
 *
 * LOAD-BEARING PROOFS (removal mutations verified before commit):
 *
 *   (a) Duplicate SESSION_START:
 *       Removing the `return` after `!ssResult.ok` in the SESSION_START handler
 *       causes tools to be double-registered on the second call.  Test fails
 *       because tool count exceeds the count after the first SESSION_START.
 *
 *   (b) BEFORE_AGENT_START before SESSION_START (worker mode):
 *       Removing the `return` after `!bafResult.ok` in the BEFORE_AGENT_START
 *       handler causes the handler to proceed past the lifecycle gate, calling
 *       initializeWorkerRun and buildStateSystemPrompt.  Test fails because
 *       the callback returns a non-undefined { systemPrompt } value instead of
 *       undefined.
 *
 *   (c) RESOURCES_DISCOVER out-of-order (after SESSION_START):
 *       Removing the `return {}` after the violation in the RESOURCES_DISCOVER
 *       handler causes config loading and skill-path resolution to run, producing
 *       a non-empty result.  Test fails because the return is not `{}`.
 *
 *   (e) HARNESS_STARTED event carries typed lifecycle fields:
 *       Removing the `...buildLifecycleEventFields(session.lifecycleMachine)`
 *       spread from the HARNESS_STARTED record call causes the recorded event
 *       to lack the lifecycleState/supervisorHealthStage/runMode fields.  Test
 *       fails because the asserted fields are absent or undefined.
 *
 * NOTE on (d) SHUTDOWN-WITH-ACTIVE-RUN:
 *   The WORKER_ACTIVE state is NOT reachable through real Pi callbacks in the
 *   current implementation (TOOL_EVENT_START is not wired to any Pi event).
 *   The shutdown-with-active-run diagnostic is therefore covered at the pure
 *   state-machine level in pi_lifecycle_state_machine.test.ts.  The real-handler
 *   test for (d) below instead asserts that SESSION_SHUTDOWN always cleans up
 *   resources (non-blocking cleanup) from WORKER_ADMITTED — the production path.
 *
 * NOTE on (f) RESTART/RELOAD idempotency:
 *   Each orrElseExtension() call creates a fresh ExtensionSession with a new
 *   LifecycleMachineState (createLifecycleMachineState()).  Session state cannot
 *   bleed across calls.  The test verifies that a second orrElseExtension()
 *   invocation starts from a clean lifecycle (SESSION_START succeeds; tool
 *   count matches the first clean invocation).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import orrElseExtension from '../src/extension.js';
import { DomainEventName, EnvVars, PiEventName, ProcessFlag } from '../src/constants/index.js';
import { PiLifecycleState, RunMode, SupervisorHealthStage } from '../src/core/PiLifecycleStateMachine.js';

// ---------------------------------------------------------------------------
// Shared helpers (modelled on pi_extension.test.ts and restart_admission_real_path.test.ts)
// ---------------------------------------------------------------------------

function fakePi() {
  const tools: any[] = [];
  const commands: Record<string, any> = {};
  const callbacks: Record<string, Function> = {};
  let activeTools: string[] = [];

  return {
    tools,
    commands,
    callbacks,
    pi: {
      on: (name: string, callback: Function) => {
        callbacks[name] = callback;
      },
      registerTool: (tool: any) => tools.push(tool),
      registerCommand: (name: string, options: any) => {
        commands[name] = options;
      },
      getActiveTools: () => activeTools,
      setActiveTools: (names: string[]) => { activeTools = names; },
      setThinkingLevel: () => {},
      setModel: async () => true,
      sendUserMessage: () => {},
    } as any,
  };
}

const HEADLESS_CTX = { hasUI: false, shutdown: () => {} } as any;

function saveEnv(...keys: string[]): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/**
 * Read all JSONL event records from a project root's .pi/events directory.
 */
function readEventStoreLines(projectRoot: string): Array<Record<string, unknown>> {
  const eventsDir = path.join(projectRoot, '.pi', 'events');
  if (!fs.existsSync(eventsDir)) return [];
  const lines: Array<Record<string, unknown>> = [];
  for (const file of fs.readdirSync(eventsDir).filter(f => f.endsWith('.jsonl'))) {
    for (const line of fs.readFileSync(path.join(eventsDir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { lines.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }
  }
  return lines;
}

/** Minimal harness.yaml for integration tests. */
const MINIMAL_YAML = `
settings:
  startState: Planning
  worktreePolicy:
    default: always
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    actions:
      - id: plan
        type: prompt
        prompt: "Plan"
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`;

// ---------------------------------------------------------------------------
// (a) LOAD-BEARING: Duplicate SESSION_START — enforcement blocks re-registration
// ---------------------------------------------------------------------------

describe('LOAD-BEARING (a): duplicate SESSION_START does not re-register tools', () => {
  /**
   * SELF-VERIFY proof:
   *   Removing the `return` after `!ssResult.ok` in the SESSION_START handler
   *   (extension.ts ~line 4182) causes the second SESSION_START to proceed past the
   *   lifecycle gate, re-registering all tools a second time.  The tool count after
   *   the second SESSION_START exceeds toolCountAfterFirst.  This assertion FAILS.
   *
   *   Reverting the mutation restores the `return`, so the second SESSION_START is
   *   a no-op (returns early), the tool count stays the same, and the test PASSES.
   */
  it('LOAD-BEARING: second SESSION_START does not re-register tools (lifecycle gate enforced)', async () => {
    const harness = fakePi();

    await orrElseExtension(harness.pi);
    // First SESSION_START — tools are registered by the real handler.
    await harness.callbacks[PiEventName.SESSION_START]?.({}, HEADLESS_CTX);
    const toolCountAfterFirst = harness.tools.length;
    expect(toolCountAfterFirst).toBeGreaterThan(0); // tools were registered

    // Second SESSION_START — lifecycle gate must reject (duplicate observer registration).
    // LOAD-BEARING: if the enforcement `return` is removed, tools would be re-registered
    // and toolCountAfterSecond would be toolCountAfterFirst * 2 (or more).
    await harness.callbacks[PiEventName.SESSION_START]?.({}, HEADLESS_CTX);
    const toolCountAfterSecond = harness.tools.length;

    // Tool count must NOT increase — no re-registration happened.
    expect(toolCountAfterSecond).toBe(toolCountAfterFirst);

    await harness.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
    await new Promise(resolve => setTimeout(resolve, 25));
  });
});

// ---------------------------------------------------------------------------
// (b) LOAD-BEARING: BEFORE_AGENT_START before SESSION_START — no run initialization
// ---------------------------------------------------------------------------

describe('LOAD-BEARING (b): BEFORE_AGENT_START before SESSION_START — lifecycle gate blocks run init', () => {
  /**
   * SELF-VERIFY proof:
   *   Removing the `return` after `!bafResult.ok` in the BEFORE_AGENT_START handler
   *   (extension.ts ~line 3902) causes the handler to proceed past the lifecycle gate.
   *   It calls initializeWorkerRun and buildStateSystemPrompt, which returns a
   *   { systemPrompt: "..." } value — the handler returns non-undefined.
   *   The assertion `expect(result).toBeUndefined()` FAILS.
   *
   *   Reverting the mutation restores the `return`, the handler returns early with
   *   undefined (no prompt injection), and the test PASSES.
   */
  it('LOAD-BEARING: BEFORE_AGENT_START before SESSION_START returns undefined — no run init (lifecycle gate enforced)', async () => {
    const previousCwd = process.cwd();
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-1elr10-baf-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), MINIMAL_YAML);
    const savedEnv = saveEnv(EnvVars.WORKER_MODE, EnvVars.BEAD_ID, EnvVars.STATE_ID, EnvVars.PROJECT_ROOT, EnvVars.WORKTREE_PATH);
    let harness: ReturnType<typeof fakePi> | undefined;

    try {
      process.chdir(tempRoot);
      // Worker mode: BEFORE_AGENT_START would normally run worker initialization.
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-lifecycle-baf-test';
      process.env[EnvVars.STATE_ID] = 'Planning';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      // orrElseExtension registers callbacks but does NOT fire SESSION_START.
      await orrElseExtension(harness.pi);

      // Fire BEFORE_AGENT_START WITHOUT SESSION_START first.
      // The lifecycle machine is in EXTENSION_LOADED — BEFORE_AGENT_START is invalid.
      // LOAD-BEARING: the handler must return early (no prompt injection).
      const result = await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

      // LOAD-BEARING assertion: undefined means the handler returned early.
      // If the enforcement `return` is removed, the handler would return { systemPrompt: "..." }.
      expect(result).toBeUndefined();
    } finally {
      await harness?.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
      await new Promise(resolve => setTimeout(resolve, 25));
      process.chdir(previousCwd);
      restoreEnv(savedEnv);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// (c) LOAD-BEARING: RESOURCES_DISCOVER out-of-order returns {} (no discovery)
// ---------------------------------------------------------------------------

describe('LOAD-BEARING (c): RESOURCES_DISCOVER after SESSION_START returns {} (lifecycle gate enforced)', () => {
  /**
   * SELF-VERIFY proof:
   *   Removing the `return {}` after the violation in the RESOURCES_DISCOVER handler
   *   (extension.ts ~line 4155) causes config loading and skill-path resolution to run.
   *   For a config with no skill paths configured, this returns `{}` coincidentally.
   *   For a config WITH skill paths, this returns { skillPaths: [...] }.
   *
   *   The key behavioral proof: removing the `if (!rdResult.ok) { ... return {} }`
   *   block entirely causes the handler to continue to `applyTransition` on a
   *   failed transition (which would incorrectly advance the machine), and then
   *   calls config loading with incorrect state.  In this test, we detect that
   *   the handler DOES return {} when called in SESSION_ACTIVE — not because of
   *   a coincidental empty skill path, but because the gate enforces it.
   *
   *   Stronger proof: if we use a config that DOES have skill paths configured,
   *   removing the enforcement causes the handler to return { skillPaths: [...] }
   *   instead of {}.  The assertion `expect(result).toEqual({})` FAILS.
   *
   *   Reverting the mutation restores the `return {}`, and the assertion PASSES.
   */
  it('LOAD-BEARING: RESOURCES_DISCOVER in SESSION_ACTIVE returns {} (gate enforced)', async () => {
    const previousCwd = process.cwd();
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-1elr10-rd-')));

    // Create a real skill file so that resolvePiSkillPaths returns a non-empty list.
    // When enforcement is REMOVED, the handler proceeds to load config + resolve skills,
    // returning { skillPaths: ['/path/to/skill.md'] } instead of {}.
    // When enforcement IS present, the handler returns {} before reaching config loading.
    const skillPath = path.join(tempRoot, 'skills', 'probe.md');
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, '# Probe skill\nA test skill for lifecycle gate proof.\n');

    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Planning
  worktreePolicy:
    default: always
  pi:
    skillPaths:
      - skills/probe.md
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    actions:
      - id: plan
        type: prompt
        prompt: "Plan"
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`);
    const savedEnv = saveEnv(EnvVars.PROJECT_ROOT);
    let harness: ReturnType<typeof fakePi> | undefined;

    try {
      process.chdir(tempRoot);
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      harness = fakePi();

      await orrElseExtension(harness.pi);
      // Fire SESSION_START to advance to SESSION_ACTIVE.
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });

      // Confirm the skill path IS valid for the first RESOURCES_DISCOVER (from EXTENSION_LOADED
      // to RESOURCES_DISCOVERED — a valid transition). Re-create the extension for a clean machine.
      // NOTE: we drive SESSION_START first (valid path: EXTENSION_LOADED → SESSION_ACTIVE).
      // After SESSION_START, RESOURCES_DISCOVER is INVALID (no such transition from SESSION_ACTIVE).

      // Fire RESOURCES_DISCOVER AFTER SESSION_START — invalid transition.
      // LOAD-BEARING: the lifecycle gate must return {} (no discovery side effect).
      const result = await harness.callbacks[PiEventName.RESOURCES_DISCOVER]?.();

      // LOAD-BEARING assertion: {} means the gate blocked config loading + skill resolution.
      // If the enforcement `return {}` is removed, the handler proceeds to load config
      // and calls resolvePiSkillPaths — which finds skills/probe.md and returns
      // { skillPaths: ['/path/to/skills/probe.md'] }.  The assertion FAILS.
      expect(result).toEqual({});
    } finally {
      await harness?.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
      await new Promise(resolve => setTimeout(resolve, 25));
      process.chdir(previousCwd);
      restoreEnv(savedEnv);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// (d) Real-handler: SESSION_SHUTDOWN always cleans up (non-blocking)
// ---------------------------------------------------------------------------

describe('(d): SESSION_SHUTDOWN from WORKER_ADMITTED — cleanup always runs (non-blocking)', () => {
  /**
   * This test drives SESSION_SHUTDOWN from a WORKER_ADMITTED state (reachable via
   * SESSION_START + BEFORE_AGENT_START through the real Pi callbacks).
   *
   * Note: WORKER_ACTIVE state is NOT reachable via real Pi callbacks in the current
   * implementation (TOOL_EVENT_START is not wired to any Pi event).  The
   * shutdown-with-active-run diagnostic (shutdownWithActiveRun:true) is therefore
   * covered at the pure state-machine level in pi_lifecycle_state_machine.test.ts.
   *
   * This real-handler test verifies:
   *   - SESSION_SHUTDOWN does NOT throw even from an active lifecycle state.
   *   - Cleanup side effects (supervisor = null etc.) run without error.
   */
  it('SESSION_SHUTDOWN from WORKER_ADMITTED always completes without error', async () => {
    const previousCwd = process.cwd();
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-1elr10-shutdown-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), MINIMAL_YAML);
    const savedEnv = saveEnv(EnvVars.WORKER_MODE, EnvVars.BEAD_ID, EnvVars.STATE_ID, EnvVars.PROJECT_ROOT, EnvVars.WORKTREE_PATH);
    let harness: ReturnType<typeof fakePi> | undefined;

    try {
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-lifecycle-shutdown-test';
      process.env[EnvVars.STATE_ID] = 'Planning';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      // Advance to WORKER_ADMITTED via the real BEFORE_AGENT_START handler.
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

      // SESSION_SHUTDOWN must not throw, even from WORKER_ADMITTED.
      // This validates the non-blocking cleanup contract.
      await expect(harness.callbacks[PiEventName.SESSION_SHUTDOWN]?.()).resolves.not.toThrow();
    } finally {
      await new Promise(resolve => setTimeout(resolve, 25));
      process.chdir(previousCwd);
      restoreEnv(savedEnv);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// (e) LOAD-BEARING: HARNESS_STARTED carries typed lifecycle fields
// ---------------------------------------------------------------------------

describe('LOAD-BEARING (e): HARNESS_STARTED event carries typed lifecycle/health/runMode fields', () => {
  /**
   * SELF-VERIFY proof:
   *   Removing the `...buildLifecycleEventFields(session.lifecycleMachine)` spread
   *   from the HARNESS_STARTED record call in the SESSION_START handler
   *   (extension.ts ~line 4214) causes the recorded event to omit
   *   lifecycleState, supervisorHealthStage, and runMode.
   *   The assertions below on those fields FAIL (values are undefined).
   *
   *   Reverting the mutation restores the spread, the fields are present
   *   with the expected enum values, and the test PASSES.
   */
  it('LOAD-BEARING: worker-mode HARNESS_STARTED event has lifecycleState, supervisorHealthStage, runMode', async () => {
    const previousCwd = process.cwd();
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-1elr10-hstarted-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.mkdirSync(path.join(tempRoot, '.pi', 'events'), { recursive: true });
    fs.mkdirSync(path.join(tempRoot, '.pi', 'logs'), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), MINIMAL_YAML);
    const savedEnv = saveEnv(
      EnvVars.WORKER_MODE, EnvVars.BEAD_ID, EnvVars.STATE_ID,
      EnvVars.PROJECT_ROOT, EnvVars.WORKTREE_PATH, EnvVars.API_BASE
    );
    let harness: ReturnType<typeof fakePi> | undefined;

    try {
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-lifecycle-hstarted-test';
      process.env[EnvVars.STATE_ID] = 'Planning';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      // Prevent actual API calls in the test environment.
      process.env[EnvVars.API_BASE] = 'http://127.0.0.1:1';
      harness = fakePi();

      await orrElseExtension(harness.pi);
      // SESSION_START fires the real handler which records HARNESS_STARTED.
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });

      // Wait briefly for the async event store write to complete.
      await new Promise(resolve => setTimeout(resolve, 100));

      // Read the event store to find the HARNESS_STARTED event recorded by the real handler.
      const events = readEventStoreLines(tempRoot);
      const harnessStarted = events.find(e => e.type === DomainEventName.HARNESS_STARTED);

      // LOAD-BEARING: if buildLifecycleEventFields spread is removed, these fields
      // are undefined (not present in the recorded event).
      expect(harnessStarted, 'HARNESS_STARTED event must be recorded by real SESSION_START handler').toBeDefined();
      const data = (harnessStarted as any).data ?? {};

      // lifecycleState must be SESSION_ACTIVE (set AFTER applyTransition in SESSION_START).
      expect(data.lifecycleState, 'lifecycleState must be typed PiLifecycleState').toBe(PiLifecycleState.SESSION_ACTIVE);

      // supervisorHealthStage must be IDLE (set at SESSION_START in worker mode).
      expect(data.supervisorHealthStage, 'supervisorHealthStage must be typed SupervisorHealthStage').toBe(SupervisorHealthStage.IDLE);

      // runMode must be WORKER (determined at SESSION_START from env vars).
      expect(data.runMode, 'runMode must be typed RunMode').toBe(RunMode.WORKER);

      // All three are non-undefined (schema-declared optional fields that ARE present).
      expect(data.lifecycleState).not.toBeUndefined();
      expect(data.supervisorHealthStage).not.toBeUndefined();
      expect(data.runMode).not.toBeUndefined();
    } finally {
      await harness?.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
      await new Promise(resolve => setTimeout(resolve, 25));
      process.chdir(previousCwd);
      restoreEnv(savedEnv);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// (f) LOAD-BEARING: restart/reload idempotency — fresh lifecycle on re-invocation
// ---------------------------------------------------------------------------

describe('LOAD-BEARING (f): restart/reload idempotency — fresh session on each orrElseExtension call', () => {
  /**
   * Each call to orrElseExtension() creates a new ExtensionSession (createExtensionSession)
   * which calls createLifecycleMachineState().  The previous session's lifecycle state
   * cannot bleed into the new one.
   *
   * LOAD-BEARING: if orrElseExtension() shared a module-level lifecycle machine
   * (instead of per-session), a previous SESSION_START would leave the machine in
   * SESSION_ACTIVE, causing the second SESSION_START to produce a LIFECYCLE_VIOLATION
   * and register no tools.  The test would fail because toolCountAfterRestart would be 0
   * or less than toolCountAfterFirst (second invocation returns early on violation).
   */
  it('LOAD-BEARING: second orrElseExtension invocation starts from clean lifecycle — tools register correctly', async () => {
    // First complete session: register, start, shutdown.
    const harness1 = fakePi();
    await orrElseExtension(harness1.pi);
    await harness1.callbacks[PiEventName.SESSION_START]?.({}, HEADLESS_CTX);
    const toolCountAfterFirst = harness1.tools.length;
    expect(toolCountAfterFirst).toBeGreaterThan(0);
    await harness1.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
    await new Promise(resolve => setTimeout(resolve, 25));

    // Second invocation: fresh session; lifecycle must start from EXTENSION_LOADED.
    // SESSION_START must succeed (not violate) and tools must register correctly.
    const harness2 = fakePi();
    await orrElseExtension(harness2.pi);
    await harness2.callbacks[PiEventName.SESSION_START]?.({}, HEADLESS_CTX);
    const toolCountAfterRestart = harness2.tools.length;

    // LOAD-BEARING: if session state bled across calls, SESSION_START would violate
    // and no tools would register (toolCountAfterRestart would be 0).
    expect(toolCountAfterRestart).toBe(toolCountAfterFirst);

    await harness2.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
    await new Promise(resolve => setTimeout(resolve, 25));
  });

  it('valid lifecycle works after restart — BEFORE_AGENT_START in new session succeeds', async () => {
    const previousCwd = process.cwd();
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-1elr10-restart-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), MINIMAL_YAML);
    const savedEnv = saveEnv(
      EnvVars.WORKER_MODE, EnvVars.BEAD_ID, EnvVars.STATE_ID,
      EnvVars.PROJECT_ROOT, EnvVars.WORKTREE_PATH
    );

    try {
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-lifecycle-restart-seq';
      process.env[EnvVars.STATE_ID] = 'Planning';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;

      // First session: start → shutdown.
      const harness1 = fakePi();
      await orrElseExtension(harness1.pi);
      await harness1.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      await harness1.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
      await new Promise(resolve => setTimeout(resolve, 25));

      // Second session (restart): fresh machine; full lifecycle must work.
      const harness2 = fakePi();
      await orrElseExtension(harness2.pi);
      await harness2.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });

      // BEFORE_AGENT_START must succeed (machine is in SESSION_ACTIVE, not a leftover state).
      // LOAD-BEARING: if machine state bled, BEFORE_AGENT_START would see SESSION_SHUTDOWN
      // (from harness1) and violate, returning undefined when it should return { systemPrompt }.
      const result = await harness2.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

      // { systemPrompt: string } means the handler ran to completion (no lifecycle violation).
      // undefined means it returned early due to a lifecycle violation or no-op.
      // In worker mode with a valid lifecycle, BEFORE_AGENT_START should return systemPrompt.
      expect(result).toBeDefined();
      expect(result).toHaveProperty('systemPrompt');

      await harness2.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
      await new Promise(resolve => setTimeout(resolve, 25));
    } finally {
      process.chdir(previousCwd);
      restoreEnv(savedEnv);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
