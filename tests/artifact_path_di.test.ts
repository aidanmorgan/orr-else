/**
 * pi-experiment-0yt5.18 — artifact-path dependency-injection tests.
 *
 * AC3 (DI): injecting a fake projectRoot / RuntimeEnvironment makes
 *   WorklogManager + Observability + bd resolve artifact paths UNDER that root
 *   (asserted via startsWith), not process.cwd().
 *
 * AC4 (NEGATIVE): with PROJECT_ROOT / WORKTREE_PATH set to a temp dir, a
 *   representative write creates NO file under process.cwd() (cwd left clean).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { EventStore } from '../src/core/EventStore.js';
import { WorklogManager } from '../src/core/WorklogManager.js';
import { Observability } from '../src/core/Observability.js';
import { createQualityPlugin } from '../src/plugins/quality.js';
import { resolveExportOutputPath } from '../src/plugins/bd.js';
import { PluginToolName } from '../src/constants/domain.js';
import { EnvVars, OperationalArtifactPath, OperationalLogPath } from '../src/constants/infra.js';
import type { BeadId } from '../src/types/index.js';
import type { RuntimeEnvironment } from '../src/core/RuntimeEnvironment.js';

// No fs mocking: every test resolves against a real mkdtemp temp root that is
// removed in afterEach, so writes (worklog, quality, bd export dir) exercise the
// real filesystem under the injected root and never touch process.cwd().

function makeEnv(vars: Record<string, string> = {}): RuntimeEnvironment {
  return { env: (name: string) => vars[name] };
}

function makeStubEventStore(): EventStore {
  const stub = new EventStore(new ConfigLoader());
  stub.record = vi.fn().mockResolvedValue(undefined);
  return stub;
}

describe('artifact-path DI — resolved paths honor the injected projectRoot (AC3)', () => {
  let injectedRoot: string;

  beforeEach(() => {
    injectedRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-artifact-di-')));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(injectedRoot, { recursive: true, force: true });
  });

  it('WorklogManager resolves the worklog path under the injected projectRoot, not cwd', () => {
    const manager = new WorklogManager(makeStubEventStore(), injectedRoot);
    const worklogPath = manager.getWorklogPath('bead-123' as BeadId);

    expect(worklogPath.startsWith(injectedRoot)).toBe(true);
    expect(worklogPath.startsWith(process.cwd())).toBe(false);
    expect(worklogPath).toContain(path.join(OperationalLogPath.WORKLOG_DIR, `bead-123${OperationalLogPath.WORKLOG_FILE_SUFFIX}`));
    // The base directory is created under the injected root.
    expect(fs.existsSync(path.join(injectedRoot, OperationalLogPath.WORKLOG_DIR))).toBe(true);
  });

  it('Observability resolves the OTel JSONL path under the injected projectRoot, not cwd', () => {
    const env = makeEnv();
    const obs = new Observability(new ConfigLoader(env, injectedRoot), env, injectedRoot);
    const jsonlPath = obs.getJsonlFilePath();

    expect(jsonlPath.startsWith(injectedRoot)).toBe(true);
    expect(jsonlPath.startsWith(process.cwd())).toBe(false);
    expect(jsonlPath).toContain(OperationalArtifactPath.PI_OTEL_DIR);
  });

  it('Observability honors env PROJECT_ROOT over the constructor-injected root', () => {
    const envRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-artifact-di-env-')));
    try {
      const env = makeEnv({ [EnvVars.PROJECT_ROOT]: envRoot });
      // Constructor root is the temp injectedRoot, but env PROJECT_ROOT must win.
      const obs = new Observability(new ConfigLoader(env, injectedRoot), env, injectedRoot);
      const jsonlPath = obs.getJsonlFilePath();
      expect(jsonlPath.startsWith(envRoot)).toBe(true);
    } finally {
      fs.rmSync(envRoot, { recursive: true, force: true });
    }
  });

  it('bd resolveExportOutputPath resolves the export dir under the injected projectRoot, not cwd', async () => {
    const env = makeEnv(); // no PROJECT_ROOT, no TOOL_OUTPUT_DIR
    const resolved = await resolveExportOutputPath(undefined, injectedRoot, env);

    const expectedDir = path.join(injectedRoot, OperationalArtifactPath.PI_TOOL_OUTPUT_DIR);
    expect(resolved.startsWith(expectedDir)).toBe(true);
    expect(resolved.startsWith(injectedRoot)).toBe(true);
    expect(resolved.startsWith(process.cwd())).toBe(false);
    expect(resolved).toMatch(/bd-export-\d+\.jsonl$/);
  });

  it('bd resolveExportOutputPath prefers the harness-injected TOOL_OUTPUT_DIR env over the project fallback', async () => {
    const toolOutputDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-bd-tooldir-')));
    try {
      const env = makeEnv({ [EnvVars.TOOL_OUTPUT_DIR]: toolOutputDir });
      const resolved = await resolveExportOutputPath(undefined, injectedRoot, env);
      // Harness-injected per-invocation dir wins over the project-scoped fallback.
      expect(resolved.startsWith(toolOutputDir)).toBe(true);
      expect(resolved.startsWith(injectedRoot)).toBe(false);
    } finally {
      fs.rmSync(toolOutputDir, { recursive: true, force: true });
    }
  });
});

describe('artifact-path DI — NEGATIVE: temp PROJECT_ROOT/WORKTREE_PATH leaves cwd clean (AC4)', () => {
  let injectedRoot: string;

  beforeEach(() => {
    injectedRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-artifact-neg-')));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(injectedRoot, { recursive: true, force: true });
  });

  it('WorklogManager.appendEntry writes only under the injected root — no worklogs/ under cwd', async () => {
    const cwdWorklogDir = path.join(process.cwd(), OperationalLogPath.WORKLOG_DIR);
    const cwdWorklogPreexisted = fs.existsSync(cwdWorklogDir);

    const manager = new WorklogManager(makeStubEventStore(), injectedRoot);
    await manager.appendEntry('bead-neg-1' as BeadId, 'Implementation', 'summary', 'handover');

    // The artifact exists under the injected root.
    const writtenPath = manager.getWorklogPath('bead-neg-1' as BeadId);
    expect(writtenPath.startsWith(injectedRoot)).toBe(true);
    expect(fs.existsSync(writtenPath)).toBe(true);

    // And NO worklog file was created under process.cwd().
    const strayPath = path.join(cwdWorklogDir, `bead-neg-1${OperationalLogPath.WORKLOG_FILE_SUFFIX}`);
    expect(fs.existsSync(strayPath)).toBe(false);
    // If the cwd worklog dir did not previously exist, it must not have been created.
    if (!cwdWorklogPreexisted) {
      expect(fs.existsSync(cwdWorklogDir)).toBe(false);
    }
  });

  it('quality compress_session_logs writes under PROJECT_ROOT (env) — no .pi/tool-output under cwd', async () => {
    const env = makeEnv({
      [EnvVars.PROJECT_ROOT]: injectedRoot,
      [EnvVars.WORKTREE_PATH]: injectedRoot
    });
    const cwdToolOutput = path.join(process.cwd(), ...OperationalArtifactPath.PI_TOOL_OUTPUT_DIR.split('/'));
    const cwdToolOutputPreexisted = fs.existsSync(cwdToolOutput);

    const plugin = createQualityPlugin(env, injectedRoot);
    const tool = plugin.tools.find(t => t.name === PluginToolName.COMPRESS_SESSION_LOGS)!;
    const result = await tool.execute({ logs: '[Core] info: hello\n[Core] error: boom' }) as { rawLogFile: string };

    // The raw log file is written under the injected PROJECT_ROOT.
    expect(result.rawLogFile.startsWith(injectedRoot)).toBe(true);
    expect(fs.existsSync(result.rawLogFile)).toBe(true);

    // No tool-output directory leaked under process.cwd().
    if (!cwdToolOutputPreexisted) {
      expect(fs.existsSync(cwdToolOutput)).toBe(false);
    }
  });
});
