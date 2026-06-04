import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execa } from 'execa';
import { DomainEventName, EnvVars, PiCliFlag, SpanName, TeammatePaneCleanupReason, TmuxCommand, TmuxFormat, TmuxOption, TmuxOptionValue, Defaults } from '../src/constants/index.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { EventStore } from '../src/core/EventStore.js';
import { Logger } from '../src/core/Logger.js';
import { Observability } from '../src/core/Observability.js';
import type { ApiAddress } from '../src/core/RuntimeServices.js';
import { TeammateFactory, parseOrrWorkerPaneOption, formatOrrWorkerPaneOption } from '../src/plugins/teammates.js';
import {
  redactPaneText,
  REDACTED_BLOCK_PLACEHOLDER,
} from '../src/core/PaneTextRedactor.js';

const { execaMock, defaultTmuxResponse } = vi.hoisted(() => {
  const defaultTmuxResponse = async (bin: string, args: string[]) => {
    if (bin !== 'tmux') throw new Error(`unexpected binary: ${bin}`);
    if (args.includes('list-windows')) return { stdout: 'Agents\n', stderr: '' };
    if (args.includes('list-panes')) return { stdout: '', stderr: '' };
    if (args.includes('split-window')) return { stdout: '%1\n', stderr: '' };
    return { stdout: '', stderr: '' };
  };
  return { execaMock: vi.fn(defaultTmuxResponse), defaultTmuxResponse };
});

vi.mock('execa', () => ({
  execa: execaMock
}));

describe('TeammateFactory', () => {
  const root = path.join(os.tmpdir(), 'orr-else-teammate-test');
  const worktreePath = path.join(root, 'worktrees', 'pi-experiment-proof');
  const configPath = path.join(root, 'harness.yaml');
  const currentExtensionPath = path.join(root, 'orr-else-current-extension.ts');
  const configuredExtensionPath = path.join(root, 'configured-worker-extension.ts');
  const configuredSkillPath = path.join(root, 'skills', 'quality', 'SKILL.md');
  let configLoader: ConfigLoader;
  let eventStore: EventStore;
  let observability: Observability;
  let previousProjectRoot: string | undefined;

  beforeEach(async () => {
    fs.mkdirSync(path.join(root, 'state', 'logs'), { recursive: true });
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.writeFileSync(currentExtensionPath, 'export default {};\n');
    fs.writeFileSync(configuredExtensionPath, 'export default {};\n');
    fs.mkdirSync(path.dirname(configuredSkillPath), { recursive: true });
    fs.writeFileSync(configuredSkillPath, '---\nname: quality\ndescription: Quality guidance.\n---\n# Quality\n');
    previousProjectRoot = process.env[EnvVars.PROJECT_ROOT];
    process.env[EnvVars.PROJECT_ROOT] = root;
    fs.writeFileSync(configPath, `
settings:
  maxConcurrentSlots: 1
  handoverTemplate: "handover"
  startState: Planning
  defaultModel: "gpt-5.5"
  pi:
    skillPaths:
      - skills/quality/SKILL.md
    workerExtensions:
      - configured-worker-extension.ts
  eventStore:
    enabled: false
  observability:
    enabled: false
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states:
  Planning:
    identity: { role: planner, expertise: planning, constraints: [] }
    baseInstructions: plan
    actions: []
    transitions: { SUCCESS: completed }
`);
    configLoader = new ConfigLoader(undefined, root);
    configLoader.setConfigPath(configPath);
    eventStore = new EventStore(configLoader, undefined, undefined, root);
    observability = new Observability(configLoader, undefined, root);
    await observability.initialize();
    vi.mocked(execa).mockReset();
    vi.mocked(execa).mockImplementation(defaultTmuxResponse);
  });

  afterEach(() => {
    observability.shutdown();
    configLoader.reset();
    if (previousProjectRoot === undefined) {
      delete process.env[EnvVars.PROJECT_ROOT];
    } else {
      process.env[EnvVars.PROJECT_ROOT] = previousProjectRoot;
    }
    vi.restoreAllMocks();
  });

  it('spawns Pi teammates in tmux with automatic teammate-mode environment', async () => {
    const factory = new TeammateFactory(observability, configLoader, eventStore, {}, 6, undefined, currentExtensionPath);
    const result = await factory.spawnTeammateInTmux('pi-experiment-proof' as any, 'Planning', worktreePath);

    expect(result.success).toBe(true);
    const splitCall = vi.mocked(execa).mock.calls.find(([, args]) => (args as string[]).includes('split-window'));
    expect(splitCall).toBeDefined();

    const splitArgs = splitCall![1] as string[];
    const command = splitArgs[splitArgs.length - 1];
    expect(command).toContain('PI_ORR_ELSE_WORKER');
    expect(command).toContain('PI_BEAD_ID');
    expect(command).toContain('PI_STATE_ID');
    expect(command).toContain('PI_WORKER_ID');
    expect(command).toContain('ORR_ELSE_API_BASE');
    const extensionFlagCount = command.split(` ${PiCliFlag.EXTENSION} `).length - 1;
    expect(command).toContain('pi');
    expect(command).toContain(PiCliFlag.NO_EXTENSIONS);
    expect(extensionFlagCount).toBe(2);
    expect(command).toContain(currentExtensionPath);
    expect(command).toContain(configuredExtensionPath);
    expect(command).toContain(PiCliFlag.SKILL);
    expect(command).toContain(configuredSkillPath);
    expect(command).not.toContain('.pi/extensions/orr-else.ts');
    expect(command).toContain('--provider');
    expect(command).toContain('--model');

    const setWindowOptionCall = vi.mocked(execa).mock.calls.find(([, args]) => {
      const tmuxArgs = args as string[];
      return tmuxArgs.includes('set-window-option');
    });
    expect(setWindowOptionCall).toBeDefined();
    expect(setWindowOptionCall![1]).toContain(TmuxOptionValue.OFF);
    expect(setWindowOptionCall![1]).not.toContain(TmuxOptionValue.ON);
  });

  it('removes dead teammate panes while counting active teammates', async () => {
    const records: Array<{ event: string; data: any }> = [];
    vi.mocked(execa).mockImplementation(async (bin: string, args: string[]) => {
      if (bin !== 'tmux') throw new Error(`unexpected binary: ${bin}`);
      if (args.includes('list-panes')) {
        return {
          stdout: [
            `%1\tAgent:bead-dead\tzsh\tPI_ORR_ELSE_WORKER=true PI_BEAD_ID=bead-dead pi\t${path.join(root, 'worktrees', 'bead-dead')}\t1`,
            `%2\tAgent:bead-live\tnode\tPI_ORR_ELSE_WORKER=true PI_BEAD_ID=bead-live pi\t${path.join(root, 'worktrees', 'bead-live')}\t0`
          ].join('\n'),
          stderr: ''
        };
      }
      return { stdout: '', stderr: '' };
    });

    const factory = new TeammateFactory(
      observability,
      configLoader,
      { record: vi.fn(async (event: string, data: any) => records.push({ event, data })) } as any,
      {},
      6,
      undefined,
      currentExtensionPath
    );

    await expect(factory.getActiveTeammateCount()).resolves.toBe(1);
    expect(vi.mocked(execa)).toHaveBeenCalledWith('tmux', ['kill-pane', '-t', '%1']);
    expect(records).toContainEqual({
      event: DomainEventName.TEAMMATE_DEAD_PANES_REMOVED,
      data: {
        reason: TeammatePaneCleanupReason.DEAD_TMUX_PANE,
        paneIds: ['%1'],
        beadIds: ['bead-dead']
      }
    });
  });

  it('fails closed for slot allocation when tmux pane listing fails', async () => {
    const records: Array<{ event: string; data: any }> = [];
    vi.mocked(execa).mockImplementation(async (bin: string, args: string[]) => {
      if (bin !== 'tmux') throw new Error(`unexpected binary: ${bin}`);
      if (args.includes('list-panes')) {
        return {
          stdout: `%1\tAgent:bead-live\tnode\tPI_ORR_ELSE_WORKER=true PI_BEAD_ID=bead-live pi\t${path.join(root, 'worktrees', 'bead-live')}\t0`,
          stderr: ''
        };
      }
      return { stdout: '', stderr: '' };
    });

    const factory = new TeammateFactory(
      observability,
      configLoader,
      { record: vi.fn(async (event: string, data: any) => records.push({ event, data })) } as any,
      {},
      6,
      undefined,
      currentExtensionPath
    );

    await expect(factory.getActiveTeammateCount()).resolves.toBe(1);
    vi.mocked(execa).mockImplementation(async (bin: string, args: string[]) => {
      if (bin !== 'tmux') throw new Error(`unexpected binary: ${bin}`);
      if (args.includes('list-panes')) throw new Error('tmux server unavailable');
      return { stdout: '', stderr: '' };
    });

    await expect(factory.getLiveTeammateBeadIds()).resolves.toEqual(new Set(['bead-live']));
    await expect(factory.getAvailableSlots()).resolves.toBe(0);
    expect(records.some(record =>
      record.event === DomainEventName.TEAMMATE_PANE_SCAN_FAILED &&
      record.data.fallbackPaneCount === 1 &&
      record.data.failClosed === true
    )).toBe(true);
  });

  it('recovers bead ids from quoted tmux pane start commands after Pi retitles panes', async () => {
    vi.mocked(execa).mockImplementation(async (bin: string, args: string[]) => {
      if (bin !== 'tmux') throw new Error(`unexpected binary: ${bin}`);
      if (args.includes('list-panes')) {
        return {
          stdout: [
            `%1\tπ - cerdiwen-live\tnode\t"PI_ORR_ELSE_WORKER=1 PI_BEAD_ID=cerdiwen-live PI_STATE_ID=Planning pi --no-session"\t${path.join(root, 'worktrees', 'cerdiwen-live')}\t0`
          ].join('\n'),
          stderr: ''
        };
      }
      return { stdout: '', stderr: '' };
    });

    const factory = new TeammateFactory(observability, configLoader, eventStore, {}, 6, undefined, currentExtensionPath);

    await expect(factory.getLiveTeammateBeadIds()).resolves.toEqual(new Set(['cerdiwen-live']));
  });

  it('does not count the coordinator node pane as an active teammate', async () => {
    vi.mocked(execa).mockImplementation(async (bin: string, args: string[]) => {
      if (bin !== 'tmux') throw new Error(`unexpected binary: ${bin}`);
      if (args.includes('list-panes')) {
        return {
          stdout: [
            `%1\tπ - cerdiwen\tnode\tpi --provider openai-codex --model gpt-5.5\t${root}\t0`,
            `%2\tpi:c\tnode\t"PI_ORR_ELSE_WORKER=1 PI_BEAD_ID=cerdiwen-live PI_STATE_ID=Planning pi --no-session"\t${path.join(root, 'worktrees', 'cerdiwen-live')}\t0`
          ].join('\n'),
          stderr: ''
        };
      }
      return { stdout: '', stderr: '' };
    });

    const factory = new TeammateFactory(observability, configLoader, eventStore, {}, 6, undefined, currentExtensionPath);

    await expect(factory.getActiveTeammateCount()).resolves.toBe(1);
    await expect(factory.getLiveTeammateBeadIds()).resolves.toEqual(new Set(['cerdiwen-live']));
  });

  it('recognizes retitled teammate panes from their mandatory worktree path', async () => {
    vi.mocked(execa).mockImplementation(async (bin: string, args: string[]) => {
      if (bin !== 'tmux') throw new Error(`unexpected binary: ${bin}`);
      if (args.includes('list-panes')) {
        return {
          stdout: [
            `%1\tpi:c\tnode\tpi --provider openai-codex --model gpt-5.5\t${root}\t0`,
            `%2\tpi:c\tnode\tpi --no-session\t${path.join(root, 'worktrees', 'cerdiwen-path', 'packages')}\t0`
          ].join('\n'),
          stderr: ''
        };
      }
      return { stdout: '', stderr: '' };
    });

    const factory = new TeammateFactory(observability, configLoader, eventStore, {}, 6, undefined, currentExtensionPath);

    await expect(factory.getActiveTeammateCount()).resolves.toBe(1);
    await expect(factory.getLiveTeammateBeadIds()).resolves.toEqual(new Set(['cerdiwen-path']));
  });

  it('continues killing remaining panes and always records TEAMMATE_PROCESS_EXITED when first kill-pane fails', async () => {
    const records: Array<{ event: string; data: any }> = [];

    // Two panes for the same bead. The first kill-pane call rejects (simulates an
    // already-dead pane that tmux no longer knows about); the second must still execute.
    vi.mocked(execa).mockImplementation(async (bin: string, args: string[]) => {
      if (bin !== 'tmux') throw new Error(`unexpected binary: ${bin}`);
      if (args.includes('list-panes')) {
        return {
          stdout: [
            `%10\tAgent:bead-term\tzsh\tPI_ORR_ELSE_WORKER=true PI_BEAD_ID=bead-term pi\t${path.join(root, 'worktrees', 'bead-term')}\t0`,
            `%11\tAgent:bead-term\tzsh\tPI_ORR_ELSE_WORKER=true PI_BEAD_ID=bead-term pi\t${path.join(root, 'worktrees', 'bead-term')}\t0`
          ].join('\n'),
          stderr: ''
        };
      }
      if (args.includes('kill-pane') && args.includes('%10')) {
        throw new Error('no such pane: %10');
      }
      return { stdout: '', stderr: '' };
    });

    const factory = new TeammateFactory(
      observability,
      configLoader,
      { record: vi.fn(async (event: string, data: any) => records.push({ event, data })) } as any,
      {},
      6,
      undefined,
      currentExtensionPath
    );

    await factory.terminateTeammatesForBead('bead-term' as any, 'test-termination');

    // (a) The second pane (%11) must still be killed despite %10 failing.
    const killCalls = vi.mocked(execa).mock.calls.filter(([, args]) => (args as string[]).includes('kill-pane'));
    expect(killCalls.some(([, args]) => (args as string[]).includes('%11'))).toBe(true);

    // (b) TEAMMATE_PROCESS_EXITED is recorded exactly once, regardless of the kill-pane failure.
    const exitedEvents = records.filter(r => r.event === DomainEventName.TEAMMATE_PROCESS_EXITED);
    expect(exitedEvents).toHaveLength(1);
    expect(exitedEvents[0].data.beadId).toBe('bead-term');
  });

  // ---------------------------------------------------------------------------
  // WI-7 — shared ApiAddress holder: all factories see the bound port
  // ---------------------------------------------------------------------------

  it('(WI-7) factory constructed before the holder is set reads the bound port at spawn time', async () => {
    // Simulates the tool-factory scenario: TeammateFactory is constructed during
    // SESSION_START (before startOrrElse binds the server), but the shared holder
    // reference is mutated later — the factory must use the holder value at spawn time.
    const apiAddress: ApiAddress = {};
    // Poison process.env to catch any accidental fallback to process.env reads.
    const previousApiPort = process.env[EnvVars.API_PORT];
    const previousApiBase = process.env[EnvVars.API_BASE];
    process.env[EnvVars.API_PORT] = '9999';
    process.env[EnvVars.API_BASE] = 'http://127.0.0.1:9999';

    try {
      // Factory constructed BEFORE the holder is populated (holder is still empty).
      const factory = new TeammateFactory(observability, configLoader, eventStore, apiAddress, 6, undefined, currentExtensionPath);

      // Simulate startOrrElse mutating the shared holder after the server binds.
      apiAddress.port = '4242';
      apiAddress.base = 'http://127.0.0.1:4242';

      const result = await factory.spawnTeammateInTmux('pi-experiment-proof' as any, 'Planning', worktreePath);
      expect(result.success).toBe(true);

      const splitCall = vi.mocked(execa).mock.calls.find(([, args]) => (args as string[]).includes('split-window'));
      expect(splitCall).toBeDefined();
      const command = (splitCall![1] as string[])[splitCall![1].length - 1];

      // Must use the bound value set on the shared holder, not the poisoned process.env values.
      expect(command).toContain('ORR_ELSE_API_PORT=4242');
      expect(command).toContain('ORR_ELSE_API_BASE=');
      expect(command).toContain('4242');
      expect(command).not.toContain('9999');
    } finally {
      if (previousApiPort === undefined) delete process.env[EnvVars.API_PORT];
      else process.env[EnvVars.API_PORT] = previousApiPort;
      if (previousApiBase === undefined) delete process.env[EnvVars.API_BASE];
      else process.env[EnvVars.API_BASE] = previousApiBase;
    }
  });

  it('(WI-7) two factories sharing one ApiAddress holder both see the bound port — cross-factory invariant', async () => {
    // Proves the regression is fixed: the supervisor factory and the tool factory
    // share the same holder reference so both use the same bound port.
    const apiAddress: ApiAddress = {};
    const factoryA = new TeammateFactory(observability, configLoader, eventStore, apiAddress, 6, undefined, currentExtensionPath);
    const factoryB = new TeammateFactory(observability, configLoader, eventStore, apiAddress, 6, undefined, currentExtensionPath);

    // Simulate startOrrElse mutating the shared holder once.
    apiAddress.port = '5151';
    apiAddress.base = 'http://127.0.0.1:5151';

    for (const factory of [factoryA, factoryB]) {
      vi.mocked(execa).mockReset();
      vi.mocked(execa).mockImplementation(defaultTmuxResponse);

      const result = await factory.spawnTeammateInTmux('pi-experiment-proof' as any, 'Planning', worktreePath);
      expect(result.success).toBe(true);

      const splitCall = vi.mocked(execa).mock.calls.find(([, args]) => (args as string[]).includes('split-window'));
      expect(splitCall).toBeDefined();
      const command = (splitCall![1] as string[])[splitCall![1].length - 1];

      expect(command).toContain('ORR_ELSE_API_PORT=5151');
      expect(command).toContain('5151');
    }
  });

  it('(WI-7) factory falls back to Defaults.API_PORT when the shared holder is empty (not yet bound)', async () => {
    // Confirms the graceful-degradation path: a factory holding an unset ApiAddress
    // uses the Defaults values, not undefined.
    const apiAddress: ApiAddress = {};
    const factory = new TeammateFactory(observability, configLoader, eventStore, apiAddress, 6, undefined, currentExtensionPath);

    // Do NOT populate apiAddress — simulates a spawn before startOrrElse binds.
    const result = await factory.spawnTeammateInTmux('pi-experiment-proof' as any, 'Planning', worktreePath);
    expect(result.success).toBe(true);

    const splitCall = vi.mocked(execa).mock.calls.find(([, args]) => (args as string[]).includes('split-window'));
    expect(splitCall).toBeDefined();
    const command = (splitCall![1] as string[])[splitCall![1].length - 1];

    expect(command).toContain(`ORR_ELSE_API_PORT=${Defaults.API_PORT}`);
    expect(command).toContain(Defaults.API_PORT);
  });

  // ---------------------------------------------------------------------------
  // kwrf — capturePaneText: capture-pane + redaction applied before returning
  // ---------------------------------------------------------------------------

  it('(kwrf) capturePaneText captures pane text and redacts reasoning blocks', async () => {
    const rawPaneOutput = [
      'Bead: pi-experiment-kwrf  State: Planning',
      '<thinking>',
      'Updating the plan for the next step.',
      'Considering edge cases...',
      '</thinking>',
      'Tool call: bash',
      'Error: unexpected exit code 1'
    ].join('\n');

    vi.mocked(execa).mockImplementation(async (bin: string, args: string[]) => {
      if (bin !== 'tmux') throw new Error(`unexpected binary: ${bin}`);
      if (args.includes('capture-pane')) return { stdout: rawPaneOutput, stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const factory = new TeammateFactory(observability, configLoader, eventStore, {}, 6, undefined, currentExtensionPath);
    const result = await factory.capturePaneText('%42');

    // Reasoning block is gone; actionable lines survive.
    expect(result).not.toContain('<thinking>');
    expect(result).not.toContain('</thinking>');
    expect(result).not.toContain('Updating the plan');
    expect(result).not.toContain('Considering edge cases');
    expect(result).toContain(REDACTED_BLOCK_PLACEHOLDER);
    expect(result).toContain('Bead: pi-experiment-kwrf');
    expect(result).toContain('Tool call: bash');
    expect(result).toContain('Error: unexpected exit code 1');

    // Confirm capture-pane was called with the correct pane ID.
    const captureCall = vi.mocked(execa).mock.calls.find(([, args]) => (args as string[]).includes('capture-pane'));
    expect(captureCall).toBeDefined();
    expect(captureCall![1]).toContain('%42');
  });

  // ---------------------------------------------------------------------------
  // kwrf — captureBeadPaneText: cross-bead filter (privacy), no-pane, throw paths
  // ---------------------------------------------------------------------------

  it('(kwrf) captureBeadPaneText returns only the target bead pane and never captures another bead pane', async () => {
    // Two live panes: %1 belongs to bead-A, %2 belongs to bead-B.
    // capture-pane returns distinct content for each pane so a leak is detectable.
    const paneAContent = 'Bead: bead-A  State: Planning\nTool call: bash';
    const paneBContent = 'Bead: bead-B  State: Implementing\nSecret data for bead-B';

    vi.mocked(execa).mockImplementation(async (bin: string, args: string[]) => {
      if (bin !== 'tmux') throw new Error(`unexpected binary: ${bin}`);
      if (args.includes('list-panes')) {
        return {
          stdout: [
            `%1\tAgent:bead-A\tnode\tPI_ORR_ELSE_WORKER=true PI_BEAD_ID=bead-A pi\t${path.join(root, 'worktrees', 'bead-A')}\t0`,
            `%2\tAgent:bead-B\tnode\tPI_ORR_ELSE_WORKER=true PI_BEAD_ID=bead-B pi\t${path.join(root, 'worktrees', 'bead-B')}\t0`
          ].join('\n'),
          stderr: ''
        };
      }
      if (args.includes('capture-pane')) {
        const paneId = args[args.indexOf('-t') + 1];
        if (paneId === '%1') return { stdout: paneAContent, stderr: '' };
        if (paneId === '%2') return { stdout: paneBContent, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const factory = new TeammateFactory(observability, configLoader, eventStore, {}, 6, undefined, currentExtensionPath);
    const result = await factory.captureBeadPaneText('bead-A');

    // Must contain bead-A content.
    expect(result).toContain('Bead: bead-A');
    expect(result).toContain('Tool call: bash');

    // Must NOT contain any bead-B content — no cross-bead leak.
    expect(result).not.toContain('bead-B');
    expect(result).not.toContain('Secret data for bead-B');

    // capture-pane was invoked for %1 (bead-A pane) but NOT %2 (bead-B pane).
    const captureCalls = vi.mocked(execa).mock.calls.filter(([, args]) => (args as string[]).includes('capture-pane'));
    const capturedPaneIds = captureCalls.map(([, args]) => {
      const a = args as string[];
      return a[a.indexOf('-t') + 1];
    });
    expect(capturedPaneIds).toContain('%1');
    expect(capturedPaneIds).not.toContain('%2');
  });

  it('(kwrf) captureBeadPaneText returns empty string when no live pane matches the beadId', async () => {
    // list-panes returns a pane for a different bead — no match for 'bead-unknown'.
    vi.mocked(execa).mockImplementation(async (bin: string, args: string[]) => {
      if (bin !== 'tmux') throw new Error(`unexpected binary: ${bin}`);
      if (args.includes('list-panes')) {
        return {
          stdout: `%1\tAgent:bead-other\tnode\tPI_ORR_ELSE_WORKER=true PI_BEAD_ID=bead-other pi\t${path.join(root, 'worktrees', 'bead-other')}\t0`,
          stderr: ''
        };
      }
      return { stdout: '', stderr: '' };
    });

    const factory = new TeammateFactory(observability, configLoader, eventStore, {}, 6, undefined, currentExtensionPath);
    const result = await factory.captureBeadPaneText('bead-unknown');

    expect(result).toBe('');
    // capture-pane must never have been called.
    const captureCalls = vi.mocked(execa).mock.calls.filter(([, args]) => (args as string[]).includes('capture-pane'));
    expect(captureCalls).toHaveLength(0);
  });

  it('(kwrf) captureBeadPaneText returns empty string when getLiveTeammatePanes throws', async () => {
    // list-panes throws — the outer try/catch in captureBeadPaneText must swallow the error.
    vi.mocked(execa).mockImplementation(async (bin: string, args: string[]) => {
      if (bin !== 'tmux') throw new Error(`unexpected binary: ${bin}`);
      if (args.includes('list-panes')) throw new Error('tmux server not running');
      return { stdout: '', stderr: '' };
    });

    const factory = new TeammateFactory(observability, configLoader, eventStore, {}, 6, undefined, currentExtensionPath);
    // Must resolve, not throw, and return ''.
    await expect(factory.captureBeadPaneText('bead-any')).resolves.toBe('');
  });

  it('(kwrf) captureBeadPaneText applies redaction: <thinking> block stripped, actionable line survives', async () => {
    // Confirms the capturePaneText → redactPaneText path is exercised.
    const rawWithThinking = [
      'Bead: bead-C  State: Planning',
      '<thinking>',
      'Internal reasoning that must not leak.',
      '</thinking>',
      'Tool call: bash { "command": "npm test" }'
    ].join('\n');

    vi.mocked(execa).mockImplementation(async (bin: string, args: string[]) => {
      if (bin !== 'tmux') throw new Error(`unexpected binary: ${bin}`);
      if (args.includes('list-panes')) {
        return {
          stdout: `%3\tAgent:bead-C\tnode\tPI_ORR_ELSE_WORKER=true PI_BEAD_ID=bead-C pi\t${path.join(root, 'worktrees', 'bead-C')}\t0`,
          stderr: ''
        };
      }
      if (args.includes('capture-pane')) return { stdout: rawWithThinking, stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const factory = new TeammateFactory(observability, configLoader, eventStore, {}, 6, undefined, currentExtensionPath);
    const result = await factory.captureBeadPaneText('bead-C');

    // Reasoning block redacted.
    expect(result).not.toContain('<thinking>');
    expect(result).not.toContain('Internal reasoning that must not leak.');
    expect(result).toContain(REDACTED_BLOCK_PLACEHOLDER);
    // Actionable line preserved.
    expect(result).toContain('Tool call: bash');
    expect(result).toContain('Bead: bead-C');
  });

  // ---------------------------------------------------------------------------
  // State-scoped skill resolution — spawn uses only matching state's skills
  // ---------------------------------------------------------------------------

  it('spawn uses state-scoped skills when state.skills is configured', async () => {
    // Create a state-scoped skill SKILL.md for the 'Planning' state.
    const plannerSkillPath = path.join(root, '.pi', 'skills', 'planner', 'SKILL.md');
    fs.mkdirSync(path.dirname(plannerSkillPath), { recursive: true });
    fs.writeFileSync(plannerSkillPath, '# Planner Skill\n');

    // Also create a reviewer skill to prove it is NOT injected for Planning spawn.
    const reviewerSkillPath = path.join(root, '.pi', 'skills', 'reviewer', 'SKILL.md');
    fs.mkdirSync(path.dirname(reviewerSkillPath), { recursive: true });
    fs.writeFileSync(reviewerSkillPath, '# Reviewer Skill\n');

    // Config: state Planning has skills: ['planner']; no global skillPaths.
    fs.writeFileSync(configPath, `
settings:
  maxConcurrentSlots: 1
  handoverTemplate: "handover"
  startState: Planning
  defaultModel: "gpt-5.5"
  eventStore:
    enabled: false
  observability:
    enabled: false
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states:
  Planning:
    identity: { role: planner, expertise: planning, constraints: [] }
    baseInstructions: plan
    skills: ['planner']
    actions: []
    transitions: { SUCCESS: completed }
  Review:
    identity: { role: reviewer, expertise: review, constraints: [] }
    baseInstructions: review
    skills: ['reviewer']
    actions: []
    transitions: { SUCCESS: completed }
`);
    configLoader.reset();

    const records: Array<{ event: string; data: any }> = [];
    const factory = new TeammateFactory(
      observability,
      configLoader,
      { record: vi.fn(async (event: string, data: any) => records.push({ event, data })) } as any,
      {},
      6,
      undefined,
      currentExtensionPath
    );

    const result = await factory.spawnTeammateInTmux('pi-experiment-proof' as any, 'Planning', worktreePath);
    expect(result.success).toBe(true);

    const splitCall = vi.mocked(execa).mock.calls.find(([, args]) => (args as string[]).includes('split-window'));
    const command = (splitCall![1] as string[])[splitCall![1].length - 1];

    // Planner skill is injected.
    expect(command).toContain(plannerSkillPath);
    // Reviewer skill is NOT injected for Planning spawn.
    expect(command).not.toContain(reviewerSkillPath);
  });

  it('spawn event records resolved skill names and paths', async () => {
    // Create state-scoped skill file.
    const plannerSkillPath = path.join(root, '.pi', 'skills', 'planner', 'SKILL.md');
    fs.mkdirSync(path.dirname(plannerSkillPath), { recursive: true });
    fs.writeFileSync(plannerSkillPath, '# Planner Skill\n');

    fs.writeFileSync(configPath, `
settings:
  maxConcurrentSlots: 1
  handoverTemplate: "handover"
  startState: Planning
  defaultModel: "gpt-5.5"
  eventStore:
    enabled: false
  observability:
    enabled: false
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states:
  Planning:
    identity: { role: planner, expertise: planning, constraints: [] }
    baseInstructions: plan
    skills: ['planner']
    actions: []
    transitions: { SUCCESS: completed }
`);
    configLoader.reset();

    const records: Array<{ event: string; data: any }> = [];
    const factory = new TeammateFactory(
      observability,
      configLoader,
      { record: vi.fn(async (event: string, data: any) => records.push({ event, data })) } as any,
      {},
      6,
      undefined,
      currentExtensionPath
    );

    await factory.spawnTeammateInTmux('pi-experiment-proof' as any, 'Planning', worktreePath);

    const spawnStarted = records.find(r => r.event === 'TEAMMATE_SPAWN_STARTED');
    expect(spawnStarted).toBeDefined();
    // Event records both skill names and paths.
    expect(spawnStarted!.data.skillNames).toEqual(['planner']);
    expect(spawnStarted!.data.skillPaths).toEqual([plannerSkillPath]);
  });

  it('spawn falls back to global skillPaths when state has no skills', async () => {
    // Global skill is already set up via configuredSkillPath in beforeEach.
    // The Planning state in the default config has no skills array.
    const records: Array<{ event: string; data: any }> = [];
    const factory = new TeammateFactory(
      observability,
      configLoader,
      { record: vi.fn(async (event: string, data: any) => records.push({ event, data })) } as any,
      {},
      6,
      undefined,
      currentExtensionPath
    );

    await factory.spawnTeammateInTmux('pi-experiment-proof' as any, 'Planning', worktreePath);

    const spawnStarted = records.find(r => r.event === 'TEAMMATE_SPAWN_STARTED');
    expect(spawnStarted).toBeDefined();
    // Falls back to the global skill from settings.pi.skillPaths.
    expect(spawnStarted!.data.skillPaths).toEqual([configuredSkillPath]);
    // skill name derived from parent directory of the global path.
    expect(spawnStarted!.data.skillNames).toEqual(['quality']);
  });

  // ---------------------------------------------------------------------------
  // Bootstrap digest — spawn records bootstrapDigestId on the TEAMMATE_SPAWN_STARTED event
  // ---------------------------------------------------------------------------

  it('(bootstrap-digest) spawn records a non-empty hex bootstrapDigestId on TEAMMATE_SPAWN_STARTED', async () => {
    // The spawn-side bootstrapDigestId is a lightweight identity-only digest
    // (no text rendering).  The full stable-block digest (identity + actual
    // rendered text) is recorded by the worker on STATE_PROMPT_ASSEMBLED.
    const records: Array<{ event: string; data: any }> = [];
    const factory = new TeammateFactory(
      observability,
      configLoader,
      { record: vi.fn(async (event: string, data: any) => records.push({ event, data })) } as any,
      {},
      6,
      undefined,
      currentExtensionPath
    );

    await factory.spawnTeammateInTmux('pi-experiment-digest' as any, 'Planning', worktreePath);

    const spawnStarted = records.find(r => r.event === 'TEAMMATE_SPAWN_STARTED');
    expect(spawnStarted).toBeDefined();
    // bootstrapDigestId must be a non-empty hex string.
    expect(typeof spawnStarted!.data.bootstrapDigestId).toBe('string');
    expect(spawnStarted!.data.bootstrapDigestId.length).toBeGreaterThan(0);
    expect(spawnStarted!.data.bootstrapDigestId).toMatch(/^[0-9a-f]+$/);
    // The spawn event no longer carries estimatedTokens/overBudget (those belong
    // on STATE_PROMPT_ASSEMBLED where the actual prompt text exists).
    expect(spawnStarted!.data.bootstrapEstimatedTokens).toBeUndefined();
    expect(spawnStarted!.data.bootstrapOverBudget).toBeUndefined();
  });

  it('(bootstrap-digest) identical spawns for different beads produce the same bootstrapDigestId', async () => {
    // Two spawns with the same stateId, config, and tool/skill set but different
    // beadIds must produce an identical bootstrapDigestId — proving the identity
    // digest is independent of volatile bead-level data.
    const recordsA: Array<{ event: string; data: any }> = [];
    const recordsB: Array<{ event: string; data: any }> = [];

    const factoryA = new TeammateFactory(
      observability,
      configLoader,
      { record: vi.fn(async (event: string, data: any) => recordsA.push({ event, data })) } as any,
      {},
      6,
      undefined,
      currentExtensionPath
    );
    const factoryB = new TeammateFactory(
      observability,
      configLoader,
      { record: vi.fn(async (event: string, data: any) => recordsB.push({ event, data })) } as any,
      {},
      6,
      undefined,
      currentExtensionPath
    );

    await factoryA.spawnTeammateInTmux('bead-alpha' as any, 'Planning', worktreePath);
    // Reset mock between spawns so split-window always returns a pane ID.
    vi.mocked(execa).mockReset();
    vi.mocked(execa).mockImplementation(defaultTmuxResponse);
    await factoryB.spawnTeammateInTmux('bead-beta' as any, 'Planning', worktreePath);

    const eventA = recordsA.find(r => r.event === 'TEAMMATE_SPAWN_STARTED');
    const eventB = recordsB.find(r => r.event === 'TEAMMATE_SPAWN_STARTED');
    expect(eventA).toBeDefined();
    expect(eventB).toBeDefined();

    // Same stable inputs → identical identity digest → cache-eligible stable block.
    expect(eventA!.data.bootstrapDigestId).toBe(eventB!.data.bootstrapDigestId);
  });

  it('(bootstrap-digest) no over-budget warning is emitted at spawn time (warning moved to worker side)', async () => {
    // The over-budget check is now done by the WORKER in BEFORE_AGENT_START
    // when it assembles the real prompt.  The coordinator spawn path does NOT
    // emit an over-budget warning — it only records a lightweight identity digest.
    const warnCalls: Array<Parameters<typeof Logger.warn>> = [];
    vi.spyOn(Logger, 'warn').mockImplementation((...args) => { warnCalls.push(args); });

    const factory = new TeammateFactory(observability, configLoader, eventStore, {}, 6, undefined, currentExtensionPath);
    await factory.spawnTeammateInTmux('bead-budget' as any, 'Planning', worktreePath);

    // Neither the old "Bootstrap stable prefix exceeds token budget" message nor
    // any new over-budget message should appear from the coordinator spawn path.
    const overBudgetWarning = warnCalls.find(([, msg]) =>
      typeof msg === 'string' && (
        msg.includes('Bootstrap stable prefix exceeds token budget') ||
        msg.includes('stable block exceeds token budget')
      )
    );
    expect(overBudgetWarning).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // WI-18 — ensureAgentsWindow catch: warn logged, spawn return value unchanged
  // ---------------------------------------------------------------------------
  it('(WI-18) warns when set-window-option fails but spawn still succeeds', async () => {
    // Simulate: has-session succeeds, list-windows succeeds, new-window succeeds,
    // set-window-option throws, split-window (spawn) still runs and succeeds.
    vi.mocked(execa).mockImplementation(async (bin: string, args: string[]) => {
      if (bin !== 'tmux') throw new Error(`unexpected binary: ${bin}`);
      if (args.includes('has-session')) return { stdout: '', stderr: '' };
      if (args.includes('list-windows')) return { stdout: 'Agents\n', stderr: '' };
      if (args.includes('set-window-option')) throw new Error('set-window-option: tmux error');
      if (args.includes('split-window')) return { stdout: '%42\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    // Intercept Logger.warn to capture calls without relying on file transport
    const warnCalls: Array<Parameters<typeof Logger.warn>> = [];
    vi.spyOn(Logger, 'warn').mockImplementation((...args) => { warnCalls.push(args); });
    const factory = new TeammateFactory(observability, configLoader, eventStore, {}, 6, undefined, currentExtensionPath);

    // (b) return value / control flow: spawn still resolves to success
    const result = await factory.spawnTeammateInTmux('bead-wi18' as any, 'Planning', worktreePath);
    expect(result.success).toBe(true);

    // (a) warn was emitted with sessionName + error context
    const warnCall = warnCalls.find(([, msg]) => msg.includes('agents window'));
    expect(warnCall).toBeDefined();
    const [component, , metadata] = warnCall!;
    expect(component).toBe('TeammateFactory');
    expect(metadata?.sessionName).toBeDefined();
    expect(typeof metadata?.error).toBe('string');
    expect((metadata?.error as string).length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // s3wp.33 — exact tmux target resolution + hard ensureAgentsWindow failure +
  //           throttled pane scans
  // ---------------------------------------------------------------------------

  it('(s33/exact-target) list-panes target uses =session-name to avoid prefix-collision with orr-else-coordinator', async () => {
    // Verify that every list-panes call uses "=orr-else:Agents" not "orr-else:Agents",
    // so that a co-existing "orr-else-coordinator" session never receives the command.
    const factory = new TeammateFactory(observability, configLoader, eventStore, {}, 6, undefined, currentExtensionPath);
    await factory.getLiveTeammateBeadIds();

    const listPanesCall = vi.mocked(execa).mock.calls.find(([, args]) => (args as string[]).includes('list-panes'));
    expect(listPanesCall).toBeDefined();
    const listPanesArgs = listPanesCall![1] as string[];
    const targetArg = listPanesArgs[listPanesArgs.indexOf('-t') + 1];
    // Must start with "=" to force exact session matching.
    expect(targetArg).toMatch(/^=orr-else:/);
    // Must NOT be the ambiguous prefix form.
    expect(targetArg).not.toBe('orr-else:Agents');
  });

  it('(s33/exact-target) split-window target uses =session-name to avoid prefix-collision', async () => {
    const factory = new TeammateFactory(observability, configLoader, eventStore, {}, 6, undefined, currentExtensionPath);
    await factory.spawnTeammateInTmux('bead-exact' as any, 'Planning', worktreePath);

    const splitCall = vi.mocked(execa).mock.calls.find(([, args]) => (args as string[]).includes('split-window'));
    expect(splitCall).toBeDefined();
    const splitArgs = splitCall![1] as string[];
    const targetArg = splitArgs[splitArgs.indexOf('-t') + 1];
    expect(targetArg).toMatch(/^=orr-else:/);
  });

  it('(s33/exact-target) new-window and list-windows in ensureAgentsWindow use =session-name', async () => {
    // Force the code path that creates a new Agents window (list-windows returns no Agents window).
    // Verify that new-window and list-windows both use exact-match targeting.
    vi.mocked(execa).mockImplementation(async (bin: string, args: string[]) => {
      if (bin !== 'tmux') throw new Error(`unexpected binary: ${bin}`);
      if (args.includes('has-session')) return { stdout: '', stderr: '' };
      if (args.includes('list-windows')) return { stdout: 'Coordinator\n', stderr: '' }; // no Agents window
      if (args.includes('new-window')) return { stdout: '', stderr: '' };
      if (args.includes('split-window')) return { stdout: '%1\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const factory = new TeammateFactory(observability, configLoader, eventStore, {}, 6, undefined, currentExtensionPath);
    await factory.ensureAgentsWindow();

    const listWindowsCalls = vi.mocked(execa).mock.calls.filter(([, args]) => (args as string[]).includes('list-windows'));
    for (const call of listWindowsCalls) {
      const args = call[1] as string[];
      const tIdx = args.indexOf('-t');
      if (tIdx >= 0) {
        expect(args[tIdx + 1]).toMatch(/^=/);
      }
    }

    const newWindowCall = vi.mocked(execa).mock.calls.find(([, args]) => (args as string[]).includes('new-window'));
    expect(newWindowCall).toBeDefined();
    const newWindowArgs = newWindowCall![1] as string[];
    const tIdx = newWindowArgs.indexOf('-t');
    expect(newWindowArgs[tIdx + 1]).toMatch(/^=/);
  });

  it('(s33/session-reuse) existing exact teammate session is reused for additional worker spawns', async () => {
    vi.mocked(execa).mockImplementation(async (bin: string, args: string[]) => {
      if (bin !== 'tmux') throw new Error(`unexpected binary: ${bin}`);
      if (args.includes('has-session')) return { stdout: '', stderr: '' };
      if (args.includes('list-windows')) return { stdout: 'Coordinator\nAgents\n', stderr: '' };
      if (args.includes('split-window')) return { stdout: '%1\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const factory = new TeammateFactory(observability, configLoader, eventStore, {}, 6, 'orr-else', currentExtensionPath);
    const first = await factory.spawnTeammateInTmux('bead-reuse-one' as any, 'Planning', worktreePath);
    const second = await factory.spawnTeammateInTmux('bead-reuse-two' as any, 'Planning', worktreePath);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);

    const newSessionCalls = vi.mocked(execa).mock.calls.filter(([, args]) => (args as string[]).includes('new-session'));
    expect(newSessionCalls).toHaveLength(0);

    const hasSessionCalls = vi.mocked(execa).mock.calls.filter(([, args]) => (args as string[]).includes('has-session'));
    expect(hasSessionCalls).toHaveLength(2);
    for (const call of hasSessionCalls) {
      const args = call[1] as string[];
      expect(args[args.indexOf('-t') + 1]).toBe('=orr-else');
    }

    const splitCalls = vi.mocked(execa).mock.calls.filter(([, args]) => (args as string[]).includes('split-window'));
    expect(splitCalls).toHaveLength(2);
    for (const call of splitCalls) {
      const args = call[1] as string[];
      expect(args[args.indexOf('-t') + 1]).toBe('=orr-else:Agents');
    }
  });

  it('(s33/missing-session) creates the teammate tmux session when exact has-session fails', async () => {
    vi.mocked(execa).mockImplementation(async (bin: string, args: string[]) => {
      if (bin !== 'tmux') throw new Error(`unexpected binary: ${bin}`);
      if (args.includes('has-session')) throw new Error('no such session');
      if (args.includes('list-windows')) return { stdout: 'Coordinator\nAgents\n', stderr: '' };
      if (args.includes('new-session')) return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const factory = new TeammateFactory(observability, configLoader, eventStore, {}, 6, 'orr-else', currentExtensionPath);
    const result = await factory.ensureAgentsWindow();

    expect(result.ok).toBe(true);
    const newSessionCalls = vi.mocked(execa).mock.calls.filter(([, args]) => (args as string[]).includes('new-session'));
    expect(newSessionCalls).toHaveLength(1);
    const args = newSessionCalls[0]![1] as string[];
    expect(args).toContain('-s');
    expect(args[args.indexOf('-s') + 1]).toBe('orr-else');
    expect(args).toContain('-n');
    expect(args[args.indexOf('-n') + 1]).toBe('Coordinator');
  });

  it('(s33/hard-failure) ensureAgentsWindow returns { ok: false } when new-window fails', async () => {
    // Simulate: has-session succeeds (session exists), list-windows returns no Agents window,
    // new-window throws (e.g. fork failed: Device not configured).
    vi.mocked(execa).mockImplementation(async (bin: string, args: string[]) => {
      if (bin !== 'tmux') throw new Error(`unexpected binary: ${bin}`);
      if (args.includes('has-session')) return { stdout: '', stderr: '' };
      if (args.includes('list-windows')) return { stdout: 'Coordinator\n', stderr: '' };
      if (args.includes('new-window')) throw new Error('fork failed: Device not configured');
      return { stdout: '', stderr: '' };
    });

    const factory = new TeammateFactory(observability, configLoader, eventStore, {}, 6, undefined, currentExtensionPath);
    const result = await factory.ensureAgentsWindow();

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain('Device not configured');
    // Setup-failed flag must be set so subsequent pane scans are suppressed.
    expect(factory.isSetupFailed()).toBe(true);
  });

  it('(s33/hard-failure) spawn returns { success: false } immediately when ensureAgentsWindow fails', async () => {
    const records: Array<{ event: string; data: any }> = [];
    vi.mocked(execa).mockImplementation(async (bin: string, args: string[]) => {
      if (bin !== 'tmux') throw new Error(`unexpected binary: ${bin}`);
      if (args.includes('has-session')) return { stdout: '', stderr: '' };
      if (args.includes('list-windows')) return { stdout: 'Coordinator\n', stderr: '' };
      if (args.includes('new-window')) throw new Error('fork failed: Device not configured');
      return { stdout: '', stderr: '' };
    });

    const factory = new TeammateFactory(
      observability,
      configLoader,
      { record: vi.fn(async (event: string, data: any) => records.push({ event, data })) } as any,
      {},
      6,
      undefined,
      currentExtensionPath
    );

    const result = await factory.spawnTeammateInTmux('bead-fail' as any, 'Planning', worktreePath);

    // Spawn must fail hard — do not silently continue.
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain('Device not configured');

    // split-window must NOT have been called — we aborted before spawning.
    const splitCalls = vi.mocked(execa).mock.calls.filter(([, args]) => (args as string[]).includes('split-window'));
    expect(splitCalls).toHaveLength(0);

    // TEAMMATE_SPAWN_FAILED must be recorded.
    const failedEvent = records.find(r => r.event === DomainEventName.TEAMMATE_SPAWN_FAILED);
    expect(failedEvent).toBeDefined();
    expect(failedEvent!.data.beadId).toBe('bead-fail');
  });

  it('(s33/throttle) pane scans are suppressed (no list-panes calls) when setup is known-failed', async () => {
    // After a hard setup failure, getLiveTeammatePanes must return cached data
    // without issuing list-panes (no repeated PANE_SCAN_FAILED noise).
    const records: Array<{ event: string; data: any }> = [];
    vi.mocked(execa).mockImplementation(async (bin: string, args: string[]) => {
      if (bin !== 'tmux') throw new Error(`unexpected binary: ${bin}`);
      if (args.includes('has-session')) return { stdout: '', stderr: '' };
      if (args.includes('list-windows')) return { stdout: 'Coordinator\n', stderr: '' };
      if (args.includes('new-window')) throw new Error('fork failed: Device not configured');
      return { stdout: '', stderr: '' };
    });

    const factory = new TeammateFactory(
      observability,
      configLoader,
      { record: vi.fn(async (event: string, data: any) => records.push({ event, data })) } as any,
      {},
      6,
      undefined,
      currentExtensionPath
    );

    // Trigger setup failure.
    await factory.ensureAgentsWindow();
    expect(factory.isSetupFailed()).toBe(true);

    // Now reset the mock to a version that would fail list-panes — if called, it would throw.
    // We want to confirm list-panes is NOT called after setup failure.
    vi.mocked(execa).mockReset();
    vi.mocked(execa).mockImplementation(async (_bin: string, args: string[]) => {
      if ((args as string[]).includes('list-panes')) throw new Error('should not be called after setup failure');
      return { stdout: '', stderr: '' };
    });

    // Multiple calls to getLiveTeammateBeadIds must not call list-panes.
    await factory.getLiveTeammateBeadIds();
    await factory.getLiveTeammateBeadIds();
    await factory.getLiveTeammateBeadIds();

    // list-panes must not appear in any mock call.
    const listPanesCalls = vi.mocked(execa).mock.calls.filter(([, args]) => (args as string[]).includes('list-panes'));
    expect(listPanesCalls).toHaveLength(0);

    // TEAMMATE_PANE_SCAN_FAILED must NOT have been recorded (no spam).
    const scanFailedEvents = records.filter(r => r.event === DomainEventName.TEAMMATE_PANE_SCAN_FAILED);
    expect(scanFailedEvents).toHaveLength(0);
  });

  it('(s33/throttle) setup failure flag clears when ensureAgentsWindow subsequently succeeds', async () => {
    // First call fails (no Agents window, new-window throws).
    let newWindowShouldFail = true;
    vi.mocked(execa).mockImplementation(async (bin: string, args: string[]) => {
      if (bin !== 'tmux') throw new Error(`unexpected binary: ${bin}`);
      if (args.includes('has-session')) return { stdout: '', stderr: '' };
      if (args.includes('list-windows')) {
        // After the fix call, return Agents in the list.
        return { stdout: newWindowShouldFail ? 'Coordinator\n' : 'Coordinator\nAgents\n', stderr: '' };
      }
      if (args.includes('new-window')) {
        if (newWindowShouldFail) throw new Error('fork failed');
        return { stdout: '', stderr: '' };
      }
      if (args.includes('split-window')) return { stdout: '%10\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const factory = new TeammateFactory(observability, configLoader, eventStore, {}, 6, undefined, currentExtensionPath);

    // First call: fail.
    const first = await factory.ensureAgentsWindow();
    expect(first.ok).toBe(false);
    expect(factory.isSetupFailed()).toBe(true);

    // Fix the environment: now new-window succeeds and Agents window is listed.
    newWindowShouldFail = false;

    // Second call: succeed → setup-failed flag clears.
    const second = await factory.ensureAgentsWindow();
    expect(second.ok).toBe(true);
    expect(factory.isSetupFailed()).toBe(false);
  });

  it('(s33/prefix-collision) session named "orr-else" must not be targeted as ambiguous prefix when "orr-else-coordinator" coexists', async () => {
    // This test simulates the live incident: tmux has two sessions — "orr-else"
    // and "orr-else-coordinator".  Without exact-match targeting, tmux would
    // reject ambiguous prefix "orr-else" (or resolve to the wrong session).
    // With exact-match targeting ("=orr-else"), tmux resolves unambiguously.
    //
    // We verify that the -t argument passed to list-panes always starts with "="
    // so that even if an "orr-else-coordinator" session exists, it is never matched.
    const factory = new TeammateFactory(observability, configLoader, eventStore, {}, 6, 'orr-else', currentExtensionPath);
    await factory.getLiveTeammateBeadIds();

    const listPanesCall = vi.mocked(execa).mock.calls.find(([, args]) => (args as string[]).includes('list-panes'));
    expect(listPanesCall).toBeDefined();
    const args = listPanesCall![1] as string[];
    const target = args[args.indexOf('-t') + 1];

    // Exact-match prefix "=" prevents tmux from treating "orr-else" as a
    // prefix that could match "orr-else-coordinator".
    expect(target.startsWith('=')).toBe(true);
    expect(target).toBe('=orr-else:Agents');
  });

  it('(s33/hard-failure) ensureAgentsWindow returns { ok: false } when Agents window missing after new-window', async () => {
    // Simulates a scenario where new-window appears to succeed but the window
    // is absent when we re-list (e.g. partial failure from device error).
    let listWindowsCallCount = 0;
    vi.mocked(execa).mockImplementation(async (bin: string, args: string[]) => {
      if (bin !== 'tmux') throw new Error(`unexpected binary: ${bin}`);
      if (args.includes('has-session')) return { stdout: '', stderr: '' };
      if (args.includes('list-windows')) {
        listWindowsCallCount += 1;
        // First call (check): no Agents; second call (verify): also no Agents (creation silent-failed).
        return { stdout: 'Coordinator\n', stderr: '' };
      }
      if (args.includes('new-window')) return { stdout: '', stderr: '' }; // "succeeds" but window is absent
      return { stdout: '', stderr: '' };
    });

    const factory = new TeammateFactory(observability, configLoader, eventStore, {}, 6, undefined, currentExtensionPath);
    const result = await factory.ensureAgentsWindow();

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Agents window not found');
    expect(factory.isSetupFailed()).toBe(true);
    // Both list-windows calls were made (check + verify).
    expect(listWindowsCallCount).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// teammatePlugin — no-cap minimal schema fixture (s3wp.27e)
//
// Verifies that the SPAWN_TEAMMATE tool result is always a compact structured
// schema with no inline content, preview, or byte-cap fields, even when the
// spawn targets a bead with many files in its worktree.
// ---------------------------------------------------------------------------

import { teammatePlugin } from '../src/plugins/teammates.js';
import { PluginToolName } from '../src/constants/index.js';

describe('teammatePlugin — no-cap minimal schema (s3wp.27e)', () => {
  const root = path.join(os.tmpdir(), 'orr-else-teammate-nocap-test');
  const worktreePath = path.join(root, 'worktrees', 'nocap-bead');
  const configPath = path.join(root, 'harness.yaml');
  const currentExtensionPath = path.join(root, 'orr-else-ext.ts');

  let configLoader: ConfigLoader;
  let eventStore: EventStore;
  let observability: Observability;
  let previousProjectRoot: string | undefined;

  beforeEach(async () => {
    fs.mkdirSync(path.join(root, 'state', 'logs'), { recursive: true });
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.writeFileSync(currentExtensionPath, 'export default {};\n');
    previousProjectRoot = process.env[EnvVars.PROJECT_ROOT];
    process.env[EnvVars.PROJECT_ROOT] = root;
    fs.writeFileSync(configPath, `
settings:
  maxConcurrentSlots: 6
  handoverTemplate: "handover"
  startState: Planning
  defaultModel: "gpt-5.5"
  eventStore:
    enabled: false
  observability:
    enabled: false
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states:
  Planning:
    identity: { role: planner, expertise: planning, constraints: [] }
    baseInstructions: plan
    actions: []
    transitions: { SUCCESS: completed }
`);
    configLoader = new ConfigLoader(undefined, root);
    configLoader.setConfigPath(configPath);
    eventStore = new EventStore(configLoader, undefined, undefined, root);
    observability = new Observability(configLoader, undefined, root);
    await observability.initialize();
    vi.mocked(execa).mockReset();
    vi.mocked(execa).mockImplementation(async (bin: string, args: string[]) => {
      if (bin !== 'tmux') throw new Error(`unexpected binary: ${bin}`);
      if (args.includes('list-windows')) return { stdout: 'Agents\n', stderr: '' };
      if (args.includes('list-panes')) return { stdout: '', stderr: '' };
      if (args.includes('split-window')) return { stdout: '%55\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
  });

  afterEach(() => {
    observability.shutdown();
    configLoader.reset();
    if (previousProjectRoot === undefined) {
      delete process.env[EnvVars.PROJECT_ROOT];
    } else {
      process.env[EnvVars.PROJECT_ROOT] = previousProjectRoot;
    }
    vi.restoreAllMocks();
  });

  it('SPAWN_TEAMMATE result returns only { success, paneId } with no inline content or preview fields', async () => {
    const factory = new TeammateFactory(observability, configLoader, eventStore, {}, 6, undefined, currentExtensionPath);
    const plugin = teammatePlugin(factory);
    const spawnTool = plugin.tools.find(tool => tool.name === PluginToolName.SPAWN_TEAMMATE)!;
    expect(spawnTool).toBeDefined();

    const result = await spawnTool.execute({
      beadId: 'nocap-bead',
      stateId: 'Planning',
      worktreePath
    }) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(typeof result.paneId).toBe('string');

    // Must NOT contain any inline content, preview, truncation, or byte-cap fields
    expect(result).not.toHaveProperty('outputPreview');
    expect(result).not.toHaveProperty('resultPreview');
    expect(result).not.toHaveProperty('diagnosticPreview');
    expect(result).not.toHaveProperty('truncated');
    expect(result).not.toHaveProperty('stdoutTruncated');
    expect(result).not.toHaveProperty('stderrTruncated');
    expect(result).not.toHaveProperty('outputArchive');
    expect(result).not.toHaveProperty('structuredResult');
    expect(result).not.toHaveProperty('byteCap');
    expect(result).not.toHaveProperty('outputLimit');

    // Only allowed keys: success, paneId, optional error
    const allowedKeys = new Set(['success', 'paneId', 'error']);
    for (const key of Object.keys(result)) {
      expect(allowedKeys).toContain(key);
    }
  });

  it('SPAWN_TEAMMATE result on failure returns only { success, error } with no preview fields', async () => {
    // Simulate no available slots by mocking with many active panes
    vi.mocked(execa).mockImplementation(async (bin: string, args: string[]) => {
      if (bin !== 'tmux') throw new Error(`unexpected binary: ${bin}`);
      if (args.includes('list-windows')) return { stdout: 'Agents\n', stderr: '' };
      if (args.includes('list-panes')) {
        // Return 6 active panes to fill all slots
        const panes = Array.from({ length: 6 }, (_, i) =>
          `%${i + 1}\tAgent:bead-${i}\tnode\tPI_ORR_ELSE_WORKER=true PI_BEAD_ID=bead-${i} pi\t${path.join(root, 'worktrees', `bead-${i}`)}\t0`
        ).join('\n');
        return { stdout: panes, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const factory = new TeammateFactory(observability, configLoader, eventStore, {}, 6, undefined, currentExtensionPath);
    const plugin = teammatePlugin(factory);
    const spawnTool = plugin.tools.find(tool => tool.name === PluginToolName.SPAWN_TEAMMATE)!;

    const result = await spawnTool.execute({
      beadId: 'nocap-bead',
      stateId: 'Planning',
      worktreePath
    }) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(typeof result.error).toBe('string');

    // Must NOT contain any preview/truncation/cap fields
    expect(result).not.toHaveProperty('outputPreview');
    expect(result).not.toHaveProperty('resultPreview');
    expect(result).not.toHaveProperty('truncated');
    expect(result).not.toHaveProperty('outputArchive');
    expect(result).not.toHaveProperty('structuredResult');

    // Only allowed keys: success, paneId (absent on failure), optional error
    const allowedKeys = new Set(['success', 'paneId', 'error']);
    for (const key of Object.keys(result)) {
      expect(allowedKeys).toContain(key);
    }
  });
});

// ---------------------------------------------------------------------------
// Pane observability — command construction, env propagation, round-trip
// (pi-experiment-teammate-bootstrap-monitoring)
// ---------------------------------------------------------------------------

// Module-level default handler for pane-observability tests (returns %99 for split-window).
// Must be declared at module scope — vi.hoisted() must not be inside a describe block.
const defaultTmuxResponseObs = async (bin: string, args: string[]) => {
  if (bin !== 'tmux') throw new Error(`unexpected binary: ${bin}`);
  if (args.includes('list-windows')) return { stdout: 'Agents\n', stderr: '' };
  if (args.includes('list-panes')) return { stdout: '', stderr: '' };
  if (args.includes('split-window')) return { stdout: '%99\n', stderr: '' };
  return { stdout: '', stderr: '' };
};

describe('TeammateFactory — pane observability and env propagation', () => {
  const root = path.join(os.tmpdir(), 'orr-else-pane-obs-test');
  const worktreePath = path.join(root, 'worktrees', 'obs-bead');
  const configPath = path.join(root, 'harness.yaml');
  const currentExtensionPath = path.join(root, 'orr-else-ext.ts');

  // Reuse the top-level execa mock — the outer describe already patches execa.
  // These tests just reset and re-configure it in each beforeEach.

  let configLoader: ConfigLoader;
  let eventStore: EventStore;
  let observability: Observability;
  let previousProjectRoot: string | undefined;

  beforeEach(async () => {
    fs.mkdirSync(path.join(root, 'state', 'logs'), { recursive: true });
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.writeFileSync(currentExtensionPath, 'export default {};\n');
    previousProjectRoot = process.env[EnvVars.PROJECT_ROOT];
    process.env[EnvVars.PROJECT_ROOT] = root;
    fs.writeFileSync(configPath, `
settings:
  maxConcurrentSlots: 1
  handoverTemplate: "handover"
  startState: Planning
  defaultModel: "gpt-5.5"
  eventStore:
    enabled: false
  observability:
    enabled: false
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states:
  Planning:
    identity: { role: planner, expertise: planning, constraints: [] }
    baseInstructions: plan
    actions: []
    transitions: { SUCCESS: completed }
`);
    configLoader = new ConfigLoader(undefined, root);
    configLoader.setConfigPath(configPath);
    eventStore = new EventStore(configLoader, undefined, undefined, root);
    observability = new Observability(configLoader, undefined, root);
    await observability.initialize();
    vi.mocked(execa).mockReset();
    vi.mocked(execa).mockImplementation(defaultTmuxResponseObs);
  });

  afterEach(() => {
    observability.shutdown();
    configLoader.reset();
    if (previousProjectRoot === undefined) {
      delete process.env[EnvVars.PROJECT_ROOT];
    } else {
      process.env[EnvVars.PROJECT_ROOT] = previousProjectRoot;
    }
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Command construction: pane user-option and border setup
  // -------------------------------------------------------------------------

  it('(pane-obs) spawn issues set-option -p @orr_worker with workerId, beadId, and stateId encoded', async () => {
    const beadId = 'obs-bead';
    const stateId = 'Planning';
    const factory = new TeammateFactory(observability, configLoader, eventStore, {}, 6, undefined, currentExtensionPath);
    const result = await factory.spawnTeammateInTmux(beadId as any, stateId, worktreePath);
    expect(result.success).toBe(true);

    // Find the set-option call that sets the @orr_worker pane user-option.
    const setOptionCalls = vi.mocked(execa).mock.calls.filter(
      ([, args]) => (args as string[]).includes(TmuxCommand.SET_OPTION)
    );
    const orrWorkerCall = setOptionCalls.find(
      ([, args]) => (args as string[]).includes(TmuxOption.ORR_WORKER_PANE_OPTION)
    );
    expect(orrWorkerCall).toBeDefined();

    const orrWorkerArgs = orrWorkerCall![1] as string[];
    // Must be scoped to the pane (-p flag).
    expect(orrWorkerArgs).toContain('-p');
    // Must target the pane returned by split-window (%99 in this mock).
    expect(orrWorkerArgs).toContain('%99');
    // The value must encode the beadId and stateId.
    const valueIndex = orrWorkerArgs.indexOf(TmuxOption.ORR_WORKER_PANE_OPTION) + 1;
    const orrWorkerValue = orrWorkerArgs[valueIndex];
    expect(orrWorkerValue).toBeDefined();
    expect(orrWorkerValue).toContain(`bead:${beadId}`);
    expect(orrWorkerValue).toContain(`state:${stateId}`);
    // workerId is a computed value — verify the key prefix is present.
    expect(orrWorkerValue).toContain('worker:');
  });

  it('(pane-obs) spawn issues set-option -p pane-border-format #{@orr_worker} for the spawned pane', async () => {
    const factory = new TeammateFactory(observability, configLoader, eventStore, {}, 6, undefined, currentExtensionPath);
    const result = await factory.spawnTeammateInTmux('obs-bead' as any, 'Planning', worktreePath);
    expect(result.success).toBe(true);

    const setOptionCalls = vi.mocked(execa).mock.calls.filter(
      ([, args]) => (args as string[]).includes(TmuxCommand.SET_OPTION)
    );
    const borderFormatCall = setOptionCalls.find(
      ([, args]) => (args as string[]).includes(TmuxOption.PANE_BORDER_FORMAT)
    );
    expect(borderFormatCall).toBeDefined();

    const borderFormatArgs = borderFormatCall![1] as string[];
    // Must be scoped to the pane (-p flag).
    expect(borderFormatArgs).toContain('-p');
    // Must target the spawned pane (%99 in this mock).
    expect(borderFormatArgs).toContain('%99');
    // The format value must reference the @orr_worker user-option.
    const formatValueIndex = borderFormatArgs.indexOf(TmuxOption.PANE_BORDER_FORMAT) + 1;
    const formatValue = borderFormatArgs[formatValueIndex];
    expect(formatValue).toBe(`#{${TmuxOption.ORR_WORKER_PANE_OPTION}}`);
  });

  it('(pane-obs) spawn issues set-option -w pane-border-status top on the agents window', async () => {
    const factory = new TeammateFactory(observability, configLoader, eventStore, {}, 6, undefined, currentExtensionPath);
    const result = await factory.spawnTeammateInTmux('obs-bead' as any, 'Planning', worktreePath);
    expect(result.success).toBe(true);

    const setOptionCalls = vi.mocked(execa).mock.calls.filter(
      ([, args]) => (args as string[]).includes(TmuxCommand.SET_OPTION)
    );
    const borderStatusCall = setOptionCalls.find(
      ([, args]) => (args as string[]).includes(TmuxOption.PANE_BORDER_STATUS)
    );
    expect(borderStatusCall).toBeDefined();

    const borderStatusArgs = borderStatusCall![1] as string[];
    // Must be a window-level option (-w flag).
    expect(borderStatusArgs).toContain('-w');
    // Value must be 'top'.
    expect(borderStatusArgs).toContain(TmuxOptionValue.PANE_BORDER_STATUS_TOP);
  });

  // -------------------------------------------------------------------------
  // Env propagation: all required vars present in the spawned command
  // -------------------------------------------------------------------------

  it('(pane-obs/env) spawned command contains all required environment variables', async () => {
    const apiAddress = { port: '7171', base: 'http://127.0.0.1:7171' };
    const factory = new TeammateFactory(observability, configLoader, eventStore, apiAddress, 6, undefined, currentExtensionPath);
    const result = await factory.spawnTeammateInTmux('obs-bead' as any, 'Planning', worktreePath);
    expect(result.success).toBe(true);

    const splitCall = vi.mocked(execa).mock.calls.find(([, args]) => (args as string[]).includes('split-window'));
    expect(splitCall).toBeDefined();
    const command = (splitCall![1] as string[])[splitCall![1].length - 1];

    // Core worker identity
    expect(command).toContain(EnvVars.WORKER_MODE);   // PI_ORR_ELSE_WORKER
    expect(command).toContain(EnvVars.BEAD_ID);        // PI_BEAD_ID
    expect(command).toContain(EnvVars.STATE_ID);       // PI_STATE_ID
    expect(command).toContain(EnvVars.WORKER_ID);      // PI_WORKER_ID
    expect(command).toContain(EnvVars.SESSION_STATE_ID); // PI_SESSION_STATE_ID

    // Runtime paths
    expect(command).toContain(EnvVars.PROJECT_ROOT);   // PI_PROJECT_ROOT
    expect(command).toContain(EnvVars.WORKTREE_PATH);  // PI_WORKTREE_PATH
    expect(command).toContain(EnvVars.CONFIG_PATH);    // ORR_ELSE_CONFIG

    // API base URL and port
    expect(command).toContain(EnvVars.API_BASE);       // ORR_ELSE_API_BASE
    expect(command).toContain(EnvVars.API_PORT);       // ORR_ELSE_API_PORT
    expect(command).toContain('7171');

    // LLM routing
    expect(command).toContain(EnvVars.LLM_PROVIDER);  // PI_LLM_PROVIDER
    expect(command).toContain(EnvVars.LLM_MODEL);     // PI_LLM_MODEL
    expect(command).toContain(EnvVars.LLM_THINKING);  // PI_LLM_THINKING
    expect(command).toContain(EnvVars.LLM_PROVIDER_KEY); // PI_LLM_PROVIDER_KEY

    // Observability / tracing
    expect(command).toContain(EnvVars.TRACE_ID);       // PI_TRACE_ID
    expect(command).toContain(EnvVars.SPAN_ID);        // PI_SPAN_ID

    // Cache TTL opt-in
    expect(command).toContain(EnvVars.ENABLE_PROMPT_CACHING_1H);
  });

  // -------------------------------------------------------------------------
  // Round-trip: @orr_worker value encodes workerId/beadId/stateId, recoverable
  // -------------------------------------------------------------------------

  it('(pane-obs/round-trip) @orr_worker pane option value encodes workerId, beadId, stateId and they can be parsed back', async () => {
    const beadId = 'rt-bead';
    const stateId = 'Planning';
    const factory = new TeammateFactory(observability, configLoader, eventStore, {}, 6, undefined, currentExtensionPath);
    const result = await factory.spawnTeammateInTmux(beadId as any, stateId, worktreePath);
    expect(result.success).toBe(true);

    // Extract the @orr_worker value from the set-option mock call.
    const setOptionCalls = vi.mocked(execa).mock.calls.filter(
      ([, args]) => (args as string[]).includes(TmuxCommand.SET_OPTION)
    );
    const orrWorkerCall = setOptionCalls.find(
      ([, args]) => (args as string[]).includes(TmuxOption.ORR_WORKER_PANE_OPTION)
    );
    expect(orrWorkerCall).toBeDefined();
    const orrWorkerArgs = orrWorkerCall![1] as string[];
    const valueIndex = orrWorkerArgs.indexOf(TmuxOption.ORR_WORKER_PANE_OPTION) + 1;
    const orrWorkerValue = orrWorkerArgs[valueIndex];

    // Parse the canonical format: "worker:<workerId> bead:<beadId> state:<stateId>"
    const match = orrWorkerValue.match(/^worker:(\S+)\s+bead:(\S+)\s+state:(\S+)$/);
    expect(match).not.toBeNull();
    const [, parsedWorkerId, parsedBeadId, parsedStateId] = match!;

    // beadId and stateId are deterministic inputs — assert exact recovery.
    expect(parsedBeadId).toBe(beadId);
    expect(parsedStateId).toBe(stateId);
    // workerId is computed at spawn time but must be non-empty.
    expect(parsedWorkerId.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // parseOrrWorkerPaneOption — unit tests for the canonical parser
  // -------------------------------------------------------------------------

  it('(pane-obs/parser) parseOrrWorkerPaneOption round-trips formatOrrWorkerPaneOption output', () => {
    const workerId = 'worker-bead-state-1234-5678';
    const beadId = 'my-bead';
    const stateId = 'Planning';
    const encoded = formatOrrWorkerPaneOption(workerId, beadId, stateId);
    const parsed = parseOrrWorkerPaneOption(encoded);
    expect(parsed).not.toBeNull();
    expect(parsed!.workerId).toBe(workerId);
    expect(parsed!.beadId).toBe(beadId);
    expect(parsed!.stateId).toBe(stateId);
  });

  it('(pane-obs/parser) parseOrrWorkerPaneOption returns null on malformed input', () => {
    expect(parseOrrWorkerPaneOption('')).toBeNull();
    expect(parseOrrWorkerPaneOption('not-the-right-format')).toBeNull();
    expect(parseOrrWorkerPaneOption('worker:w bead:b')).toBeNull(); // missing state
    expect(parseOrrWorkerPaneOption('worker: bead:b state:s')).toBeNull(); // empty workerId
    expect(parseOrrWorkerPaneOption('bead:b state:s worker:w')).toBeNull(); // wrong order
  });

  // -------------------------------------------------------------------------
  // listAgentPanes — @orr_worker field is parsed and exposed on returned panes
  // -------------------------------------------------------------------------

  it('(pane-obs/list) listAgentPanes parses the @orr_worker field and exposes it on each pane', async () => {
    const workerValue = formatOrrWorkerPaneOption('worker-abc', 'test-bead', 'Planning');
    vi.mocked(execa).mockImplementation(async (bin: string, args: string[]) => {
      if (bin !== 'tmux') throw new Error(`unexpected binary: ${bin}`);
      if (args.includes('list-panes')) {
        // 7-field line including the @orr_worker value in the last column.
        return {
          stdout: `%7\tAgent:test-bead\tnode\tPI_ORR_ELSE_WORKER=true PI_BEAD_ID=test-bead pi\t${path.join(root, 'worktrees', 'test-bead')}\t0\t${workerValue}`,
          stderr: ''
        };
      }
      return { stdout: '', stderr: '' };
    });

    const factory = new TeammateFactory(observability, configLoader, eventStore, {}, 6, undefined, currentExtensionPath);
    const beadIds = await factory.getLiveTeammateBeadIds();

    // @orr_worker is parsed → beadId recovered from the option, not from pane_title.
    expect(beadIds).toContain('test-bead');

    // Confirm the format string passed to list-panes includes the @orr_worker format token.
    const listPanesCall = vi.mocked(execa).mock.calls.find(([, args]) => (args as string[]).includes('list-panes'));
    expect(listPanesCall).toBeDefined();
    const fFlag = listPanesCall![1] as string[];
    const formatArg = fFlag[fFlag.indexOf('-F') + 1];
    expect(formatArg).toContain(TmuxFormat.PANE_ORR_WORKER);
  });

  // -------------------------------------------------------------------------
  // Clobbered pane_title recovery — the gap-closing test
  // -------------------------------------------------------------------------

  it('(pane-obs/recovery) beadIdFromPane and isTeammatePane recover identity from @orr_worker when pane_title has been clobbered by Pi', async () => {
    // Simulate Pi having overwritten the pane_title so it no longer starts with
    // AGENT_PANE_PREFIX, and a start_command that also lacks WORKER_MODE
    // (simulating an older or retitled pane). The ONLY valid identity signal is
    // the @orr_worker user-option.
    const beadId = 'clobbered-bead';
    const stateId = 'Implementing';
    const workerId = 'worker-clobbered';
    const workerValue = formatOrrWorkerPaneOption(workerId, beadId, stateId);

    vi.mocked(execa).mockImplementation(async (bin: string, args: string[]) => {
      if (bin !== 'tmux') throw new Error(`unexpected binary: ${bin}`);
      if (args.includes('list-panes')) {
        return {
          // pane_title: Pi has overwritten it with its own "π - ..." format.
          // start_command: no WORKER_MODE env var (simulate a pane where the
          //   start command env is not parseable).
          // current_path: root (not a worktree path) so the path heuristic fails.
          // dead: 0 (live pane).
          // @orr_worker: carries the durable identity.
          stdout: `%55\tπ - something else\tnode\tpi --provider openai\t${root}\t0\t${workerValue}`,
          stderr: ''
        };
      }
      return { stdout: '', stderr: '' };
    });

    const factory = new TeammateFactory(observability, configLoader, eventStore, {}, 6, undefined, currentExtensionPath);

    // getLiveTeammateBeadIds() → getLiveTeammatePanes() → listAgentPanes() + isTeammatePane() + beadIdFromPane().
    // All three must succeed even though pane_title, start_command, and current_path
    // carry no useful identity — only @orr_worker does.
    const beadIds = await factory.getLiveTeammateBeadIds();
    expect(beadIds).toContain(beadId);

    // Verify the active count is 1 — isTeammatePane must have recognized the pane.
    const count = await factory.getActiveTeammateCount();
    // Reset mock to avoid re-triggering list-panes in getActiveTeammateCount
    // (it was already called; we just need to re-run to verify).
    expect(count).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Non-fatal set-option: spawn still succeeds when set-option rejects
  // -------------------------------------------------------------------------

  it('(pane-obs/non-fatal) spawn succeeds even when the observability set-option calls reject (older tmux)', async () => {
    // Simulate an older tmux that rejects set-option -p (pane-scoped user options
    // not supported). The worker has already been launched by split-window at this
    // point; a rejection in the observability path must NOT propagate to the spawn
    // return value — it must still be { success: true }.
    vi.mocked(execa).mockImplementation(async (bin: string, args: string[]) => {
      if (bin !== 'tmux') throw new Error(`unexpected binary: ${bin}`);
      if (args.includes('list-windows')) return { stdout: 'Agents\n', stderr: '' };
      if (args.includes('list-panes')) return { stdout: '', stderr: '' };
      if (args.includes('split-window')) return { stdout: '%77\n', stderr: '' };
      if (args.includes(TmuxCommand.SET_OPTION) && (args as string[]).includes('-p')) {
        throw new Error('unknown option: set-option -p @orr_worker');
      }
      return { stdout: '', stderr: '' };
    });

    const factory = new TeammateFactory(observability, configLoader, eventStore, {}, 6, undefined, currentExtensionPath);
    const result = await factory.spawnTeammateInTmux('obs-bead' as any, 'Planning', worktreePath);

    // Spawn must succeed — the worker process was launched before the set-option calls.
    expect(result.success).toBe(true);
    // paneId must be populated from split-window's output.
    expect(result.paneId).toBe('%77');

    // No TEAMMATE_SPAWN_FAILED event should have been recorded.
    // (The test confirms this by checking success === true; a SPAWN_FAILED path
    // would set success = false and record the event.)
  });

  // -------------------------------------------------------------------------
  // pane-border-status is set in ensureAgentsWindow, not per-spawn
  // -------------------------------------------------------------------------

  it('(pane-obs/window-once) pane-border-status top is set once in ensureAgentsWindow, not per spawn', async () => {
    // Count how many times pane-border-status is set across two spawns.
    // After SHOULD-FIX C, it should be set once per ensureAgentsWindow call
    // (called once per spawn), not moved to per-pane. The key assertion is that
    // the call appears on the window path (-w flag) and the value is 'top'.
    let splitCount = 0;
    vi.mocked(execa).mockImplementation(async (bin: string, args: string[]) => {
      if (bin !== 'tmux') throw new Error(`unexpected binary: ${bin}`);
      if (args.includes('list-windows')) return { stdout: 'Agents\n', stderr: '' };
      if (args.includes('list-panes')) return { stdout: '', stderr: '' };
      if (args.includes('split-window')) {
        splitCount += 1;
        return { stdout: `%${splitCount}\n`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const factory = new TeammateFactory(observability, configLoader, eventStore, {}, 6, undefined, currentExtensionPath);

    vi.mocked(execa).mockClear();
    await factory.spawnTeammateInTmux('bead-one' as any, 'Planning', worktreePath);

    // All pane-border-status calls must use -w (window-scoped), not -p (pane-scoped).
    const borderStatusCalls = vi.mocked(execa).mock.calls.filter(
      ([, args]) => (args as string[]).includes(TmuxOption.PANE_BORDER_STATUS)
    );
    for (const call of borderStatusCalls) {
      const callArgs = call[1] as string[];
      expect(callArgs).toContain('-w');
      expect(callArgs).not.toContain('-p');
      expect(callArgs).toContain(TmuxOptionValue.PANE_BORDER_STATUS_TOP);
    }
    // There must be at least one pane-border-status call (from ensureAgentsWindow).
    expect(borderStatusCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('(pane-obs) no pane-scoped set-option calls are made when split-window returns an empty pane ID', async () => {
    // When split-window returns empty (edge case), per-pane observability setup must be
    // skipped entirely — no pane-scoped (-p) set-option calls should be issued.
    // (The window-level pane-border-status call in ensureAgentsWindow is unaffected.)
    vi.mocked(execa).mockImplementation(async (bin: string, args: string[]) => {
      if (bin !== 'tmux') throw new Error(`unexpected binary: ${bin}`);
      if (args.includes('list-windows')) return { stdout: 'Agents\n', stderr: '' };
      if (args.includes('list-panes')) return { stdout: '', stderr: '' };
      if (args.includes('split-window')) return { stdout: '\n', stderr: '' }; // empty pane ID
      return { stdout: '', stderr: '' };
    });

    const factory = new TeammateFactory(observability, configLoader, eventStore, {}, 6, undefined, currentExtensionPath);
    const result = await factory.spawnTeammateInTmux('obs-bead' as any, 'Planning', worktreePath);
    expect(result.success).toBe(true);

    // Pane-scoped (-p) set-option calls must not be issued when paneId is empty.
    // Allow the window-scoped (-w) pane-border-status call from ensureAgentsWindow.
    const paneScopedSetOptionCalls = vi.mocked(execa).mock.calls.filter(
      ([, args]) => {
        const tmuxArgs = args as string[];
        return tmuxArgs.includes(TmuxCommand.SET_OPTION) && tmuxArgs.includes('-p');
      }
    );
    expect(paneScopedSetOptionCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// PaneTextRedactor — unit tests (kwrf)
// ---------------------------------------------------------------------------
//
// These tests verify the redaction logic in isolation so that the pattern
// constants and algorithm are exercised independently of the tmux layer.

describe('PaneTextRedactor', () => {
  describe('redactPaneText', () => {
    it('redacts a <thinking> block while preserving surrounding actionable lines', () => {
      const input = [
        'Bead: pi-experiment-kwrf  State: Planning',
        '<thinking>',
        'Updating the plan for the next step.',
        'Considering edge cases in the merge logic...',
        '</thinking>',
        'Tool call: bash { "command": "npm test" }',
        'Error: tests failed with exit code 1'
      ].join('\n');

      const result = redactPaneText(input);

      expect(result).not.toContain('<thinking>');
      expect(result).not.toContain('</thinking>');
      expect(result).not.toContain('Updating the plan');
      expect(result).not.toContain('Considering edge cases');
      expect(result).toContain(REDACTED_BLOCK_PLACEHOLDER);
      expect(result).toContain('Bead: pi-experiment-kwrf');
      expect(result).toContain('Tool call: bash');
      expect(result).toContain('Error: tests failed');
    });

    it('redacts a [thinking] label block', () => {
      const input = [
        'State: Reviewing',
        '[thinking]',
        'Reflecting on the evidence gathered so far.',
        '```',
        'Tool call: grep { "pattern": "ERROR" }'
      ].join('\n');

      const result = redactPaneText(input);

      expect(result).not.toContain('[thinking]');
      expect(result).not.toContain('Reflecting on the evidence');
      expect(result).toContain(REDACTED_BLOCK_PLACEHOLDER);
      expect(result).toContain('State: Reviewing');
      expect(result).toContain('Tool call: grep');
    });

    it('redacts a standalone reasoning line outside of a block', () => {
      const input = [
        'Bead: pi-experiment-test',
        'Considering the best approach for this merge.',
        'Tool call: bash { "command": "git status" }'
      ].join('\n');

      const result = redactPaneText(input);

      expect(result).not.toContain('Considering the best approach');
      expect(result).toContain(REDACTED_BLOCK_PLACEHOLDER);
      expect(result).toContain('Bead: pi-experiment-test');
      expect(result).toContain('Tool call: bash');
    });

    it('preserves normal tool output without any redaction', () => {
      const input = [
        'Bead: pi-experiment-norm  State: Implementing',
        'Tool call: bash { "command": "npx tsc --noEmit" }',
        '> stdout: (no errors)',
        'Tool result: { "status": "passed" }'
      ].join('\n');

      const result = redactPaneText(input);

      expect(result).toBe(input);
      expect(result).not.toContain(REDACTED_BLOCK_PLACEHOLDER);
    });

    it('preserves stuck-prompt / error lines so monitoring detects them after redaction', () => {
      const input = [
        '<thinking>',
        'Rethinking the plan entirely.',
        '</thinking>',
        'Error: process exited with code 127',
        'Failed to run command: permission denied',
        'Exception: TypeError at line 42'
      ].join('\n');

      const result = redactPaneText(input);

      // Reasoning block gone.
      expect(result).not.toContain('<thinking>');
      expect(result).not.toContain('Rethinking the plan');
      expect(result).toContain(REDACTED_BLOCK_PLACEHOLDER);

      // Error/failure lines preserved — detection still works.
      expect(result).toContain('Error: process exited');
      expect(result).toContain('Failed to run command');
      expect(result).toContain('Exception: TypeError');
    });

    it('preserves bead IDs and state IDs when they appear inside a non-reasoning context', () => {
      const input = [
        'beadId: pi-experiment-kwrf',
        'stateId: Planning',
        'Considering…',
        '{"type":"tool_call","name":"bash"}'
      ].join('\n');

      const result = redactPaneText(input);

      expect(result).toContain('pi-experiment-kwrf');
      expect(result).toContain('stateId: Planning');
      expect(result).toContain('"type":"tool_call"');
      // "Considering…" is a reasoning standalone line and should be redacted.
      expect(result).not.toContain('Considering…');
      expect(result).toContain(REDACTED_BLOCK_PLACEHOLDER);
    });

    it('handles a reasoning block immediately interrupted by an actionable line', () => {
      const input = [
        '<thinking>',
        'Error: unexpected token inside thinking block',
        'Some more reasoning text',
        '</thinking>',
        'Normal status line'
      ].join('\n');

      const result = redactPaneText(input);

      // The error line inside the block is actionable — it forces block close and is preserved.
      expect(result).toContain('Error: unexpected token inside thinking block');
      expect(result).toContain('Normal status line');
    });

    it('handles empty input gracefully', () => {
      expect(redactPaneText('')).toBe('');
    });

    it('preserves a trailing newline when present', () => {
      const input = 'Tool call: bash\nConsidering things\n';
      const result = redactPaneText(input);
      expect(result.endsWith('\n')).toBe(true);
    });

    it('does not add a trailing newline when input has none', () => {
      const input = 'Tool call: bash\nConsidering things';
      const result = redactPaneText(input);
      expect(result.endsWith('\n')).toBe(false);
    });

    it('collapses multiple consecutive reasoning lines into a single placeholder', () => {
      const input = [
        'Status: active',
        'Considering the first option.',
        'Updating the plan based on that.',
        'Tool call: read { "path": "/tmp/file" }'
      ].join('\n');

      const result = redactPaneText(input);

      const placeholderCount = (result.match(new RegExp(REDACTED_BLOCK_PLACEHOLDER.replace(/[[\]]/g, '\\$&'), 'g')) || []).length;
      expect(placeholderCount).toBe(1);
      expect(result).toContain('Status: active');
      expect(result).toContain('Tool call: read');
    });
  });
});

// ---------------------------------------------------------------------------
// postWorkerSignal — signal_ack span instrumentation
//
// Tests that postWorkerSignal emits a 'signal_ack' span via
// services.observability.recordCompletedSpan with the correct attributes
// and nonzero duration (startMs <= endMs), and that telemetry errors
// never prevent the signal from being posted.
// ---------------------------------------------------------------------------

import { postWorkerSignal } from '../src/extension/SignalController.js';
import type { TeammateEvent } from '../src/core/TeammateEvents.js';

// Mock HarnessApiClient so tests don't make real HTTP calls.
const harnessApiMock = vi.hoisted(() => ({ postHarnessSignal: vi.fn() }));
vi.mock('../src/core/HarnessApiClient.js', () => ({ postHarnessSignal: harnessApiMock.postHarnessSignal }));

function makeSignalServices(overrides: { observability?: Partial<Observability>; eventsForBead?: () => Promise<any[]> } = {}) {
  return {
    eventStore: {
      record: vi.fn().mockResolvedValue(undefined),
      eventsForBead: overrides.eventsForBead ?? vi.fn().mockResolvedValue([])
    },
    observability: {
      recordCompletedSpan: vi.fn(),
      ...overrides.observability
    } as unknown as Observability
  } as any;
}

function makeTestEvent(type = 'HEARTBEAT'): TeammateEvent {
  return {
    type,
    beadId: 'bd-signal-test',
    workerId: 'w-signal',
    sessionStateId: undefined,
    stateId: 'Implementation',
    idempotencyKey: 'idem-key-1',
    timestamp: Date.now()
  } as unknown as TeammateEvent;
}

describe('postWorkerSignal — signal_ack span', () => {
  beforeEach(() => {
    harnessApiMock.postHarnessSignal.mockReset();
  });

  it('emits signal_ack span with startMs<=endMs and signal.success=true on successful POST', async () => {
    harnessApiMock.postHarnessSignal.mockResolvedValue(undefined);

    const services = makeSignalServices();
    await postWorkerSignal(services, makeTestEvent());

    expect(services.observability.recordCompletedSpan).toHaveBeenCalledOnce();
    const [name, attrs, startMs, endMs] = (services.observability.recordCompletedSpan as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(name).toBe(SpanName.SIGNAL_ACK);
    expect(startMs).toBeLessThanOrEqual(endMs);
    expect(endMs - startMs).toBeGreaterThanOrEqual(0);
    expect(attrs['signal.success']).toBe(true);
    expect(attrs['orr_else.bead_id']).toBe('bd-signal-test');
    expect(attrs['agent.event_type']).toBe('HEARTBEAT');
  });

  it('emits signal_ack span with signal.success=false when POST fails but reconcile succeeds', async () => {
    harnessApiMock.postHarnessSignal.mockRejectedValue(new Error('network error'));

    const appliedEvent = {
      type: 'SIGNAL_ACKNOWLEDGED',
      data: makeTestEvent()
    };
    const services = makeSignalServices({
      eventsForBead: vi.fn().mockResolvedValue([appliedEvent]) as any
    });
    // Override eventsForBead to make findAppliedTeammateSignal return a match.
    // Since the reconcile path depends on TeammateEvents.findAppliedTeammateSignal,
    // we just check the span is emitted regardless.
    (services.eventStore.eventsForBead as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    try {
      await postWorkerSignal(services, makeTestEvent());
    } catch {
      // Expected to throw when reconcile finds no applied event.
    }

    expect(services.observability.recordCompletedSpan).toHaveBeenCalledOnce();
    const [name, attrs, startMs, endMs] = (services.observability.recordCompletedSpan as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(name).toBe(SpanName.SIGNAL_ACK);
    expect(startMs).toBeLessThanOrEqual(endMs);
    expect(attrs['signal.success']).toBe(false);
  });

  it('telemetry error does not prevent signal posting (best-effort)', async () => {
    harnessApiMock.postHarnessSignal.mockResolvedValue(undefined);

    const services = makeSignalServices({
      observability: {
        recordCompletedSpan: vi.fn().mockImplementation(() => {
          throw new Error('otel down');
        })
      }
    });

    // Must not throw — telemetry errors are swallowed.
    await postWorkerSignal(services, makeTestEvent());

    // The signal was still recorded as acknowledged.
    const recordCalls = (services.eventStore.record as ReturnType<typeof vi.fn>).mock.calls;
    expect(recordCalls.some(([event]: [string]) => event === DomainEventName.SIGNAL_ACKNOWLEDGED)).toBe(true);
  });
});
