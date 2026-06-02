import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execa } from 'execa';
import { DomainEventName, EnvVars, PiCliFlag, TeammatePaneCleanupReason, TmuxOptionValue, Defaults } from '../src/constants/index.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { EventStore } from '../src/core/EventStore.js';
import { Logger } from '../src/core/Logger.js';
import { Observability } from '../src/core/Observability.js';
import type { ApiAddress } from '../src/core/RuntimeServices.js';
import { TeammateFactory } from '../src/plugins/teammates.js';
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
