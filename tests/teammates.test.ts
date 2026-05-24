import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { EnvVars, PiCliFlag } from '../src/constants/index.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { EventStore } from '../src/core/EventStore.js';
import { Observability } from '../src/core/Observability.js';
import { setProjectRoot } from '../src/core/Paths.js';
import { TeammateFactory } from '../src/plugins/teammates.js';

const execFileMock = vi.hoisted(() => {
  const mock = vi.fn();
  mock[Symbol.for('nodejs.util.promisify.custom') as any] = vi.fn(async (bin: string, args: string[]) => {
    if (bin !== 'tmux') throw new Error(`unexpected binary: ${bin}`);
    if (args.includes('list-windows')) return { stdout: 'Agents\n', stderr: '' };
    if (args.includes('list-panes')) return { stdout: '', stderr: '' };
    if (args.includes('split-window')) return { stdout: '%1\n', stderr: '' };
    return { stdout: '', stderr: '' };
  });
  return mock;
});

vi.mock('child_process', () => ({
  execFile: execFileMock
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
    setProjectRoot(root);
    configLoader = new ConfigLoader();
    configLoader.setConfigPath(configPath);
    eventStore = new EventStore(configLoader);
    observability = new Observability(configLoader);
    await observability.initialize();
    vi.mocked(execFile).mockClear();
  });

  afterEach(() => {
    observability.shutdown();
    configLoader.reset();
    if (previousProjectRoot === undefined) {
      delete process.env[EnvVars.PROJECT_ROOT];
    } else {
      process.env[EnvVars.PROJECT_ROOT] = previousProjectRoot;
    }
    setProjectRoot(process.cwd());
  });

  it('spawns Pi teammates in tmux with automatic teammate-mode environment', async () => {
    const factory = new TeammateFactory(observability, configLoader, eventStore, 6, undefined, currentExtensionPath);
    const result = await factory.spawnTeammateInTmux('pi-experiment-proof' as any, 'Planning', worktreePath);

    expect(result.success).toBe(true);
    const execFileAsyncMock = (execFile as any)[Symbol.for('nodejs.util.promisify.custom')];
    const splitCall = vi.mocked(execFileAsyncMock).mock.calls.find(([, args]) => (args as string[]).includes('split-window'));
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
  });
});
