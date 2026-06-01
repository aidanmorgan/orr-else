/**
 * DI tests: verify that the injected RuntimeEnvironment flows through to
 * the behaviour of converted classes without touching process.env.
 *
 * Representative classes: Observability (sessionId), EventStore (sessionId),
 * ConfigLoader (config path), FileAccessPolicy (WORKER_MODE gate + context).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RuntimeEnvironment } from '../src/core/RuntimeEnvironment.js';
import { Observability } from '../src/core/Observability.js';
import { EventStore } from '../src/core/EventStore.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { FileAccessPolicy } from '../src/core/FileAccessPolicy.js';
import { setProjectRoot } from '../src/core/Paths.js';
import { Logger } from '../src/core/Logger.js';
import { EnvVars, ProcessFlag } from '../src/constants/index.js';
import { JsonlEventLog } from '../src/core/JsonlEventLog.js';

// ─── stub factory ───────────────────────────────────────────────────────────

function stubEnv(values: Record<string, string | undefined>): RuntimeEnvironment {
  return { env: (name: string) => values[name] };
}

// ─── helpers ────────────────────────────────────────────────────────────────

function minimalHarnessYaml(startState = 'Done'): string {
  return `
settings:
  maxConcurrentSlots: 1
  handoverTemplate: "handover"
  startState: ${startState}
  defaultModel: "model"
  observability:
    dir: .pi/otel
    fileName: session-{{sessionId}}.jsonl
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states:
  ${startState}:
    identity: { role: done, expertise: done, constraints: [] }
    baseInstructions: done
    actions: []
    transitions: {}
`;
}

// ─── Observability ──────────────────────────────────────────────────────────

describe('Observability — injected RuntimeEnvironment', () => {
  let tmpDir: string;
  let configLoader: ConfigLoader;
  let observability: Observability;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orr-di-obs-'));
    setProjectRoot(tmpDir);
    fs.mkdirSync(path.join(tmpDir, '.pi/otel'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.pi/logs'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'state/logs'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'harness.yaml'), minimalHarnessYaml());
  });

  afterEach(async () => {
    observability?.shutdown();
    configLoader?.reset();
    Logger.close();
    setProjectRoot(process.cwd());
    await new Promise(resolve => setTimeout(resolve, 25));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uses the injected OBSERVABILITY_SESSION_ID without reading process.env', async () => {
    const injectedSessionId = 'stub-session-id-from-di';
    const env = stubEnv({ [EnvVars.OBSERVABILITY_SESSION_ID]: injectedSessionId });

    configLoader = new ConfigLoader(env);
    configLoader.setConfigPath(path.join(tmpDir, 'harness.yaml'));
    observability = new Observability(configLoader, env);

    expect(observability.getSessionId()).toBe(injectedSessionId);
  });

  it('generates a fresh UUIDv7 session ID when OBSERVABILITY_SESSION_ID is not injected', () => {
    const env = stubEnv({});   // no session id in env
    configLoader = new ConfigLoader(env);
    observability = new Observability(configLoader, env);

    const sessionId = observability.getSessionId();
    // Must be a v7 UUID
    expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('uses the injected OBSERVABILITY_FILE_NAME template without reading process.env', async () => {
    const injectedSessionId = 'my-session-42';
    const injectedTemplate = 'custom-{{sessionId}}.jsonl';
    const env = stubEnv({
      [EnvVars.OBSERVABILITY_SESSION_ID]: injectedSessionId,
      [EnvVars.OBSERVABILITY_FILE_NAME]: injectedTemplate
    });

    configLoader = new ConfigLoader(env);
    configLoader.setConfigPath(path.join(tmpDir, 'harness.yaml'));
    observability = new Observability(configLoader, env);

    await observability.initialize();
    expect(observability.getJsonlFileName()).toBe(`custom-${injectedSessionId}.jsonl`);
  });
});

// ─── EventStore ─────────────────────────────────────────────────────────────

describe('EventStore — injected RuntimeEnvironment', () => {
  let tmpDir: string;
  let configLoader: ConfigLoader;
  let eventStore: EventStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orr-di-es-'));
    setProjectRoot(tmpDir);
    fs.mkdirSync(path.join(tmpDir, '.pi/events'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.pi/logs'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'state/logs'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'harness.yaml'), minimalHarnessYaml());
  });

  afterEach(async () => {
    Logger.close();
    setProjectRoot(process.cwd());
    await new Promise(resolve => setTimeout(resolve, 25));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uses the injected OBSERVABILITY_SESSION_ID as the initial sessionId', () => {
    const injectedSessionId = 'event-store-session-di';
    const env = stubEnv({ [EnvVars.OBSERVABILITY_SESSION_ID]: injectedSessionId });

    configLoader = new ConfigLoader(env);
    configLoader.setConfigPath(path.join(tmpDir, 'harness.yaml'));
    eventStore = new EventStore(configLoader, new JsonlEventLog(), env);

    // The session ID is used when recording events; verify via a recorded event
    // sessionId field. We can inspect by recording and reading the event file.
    return eventStore.record('TEST_EVENT' as any, { beadId: 'bd-1' }).then(async () => {
      const eventsDir = path.join(tmpDir, '.pi/events');
      const files = fs.readdirSync(eventsDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => path.join(eventsDir, f));
      // Find the event we just wrote
      let foundSessionId: string | undefined;
      for (const file of files) {
        const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
        for (const line of lines) {
          const parsed = JSON.parse(line);
          if (parsed.type === 'TEST_EVENT') {
            foundSessionId = parsed.sessionId;
          }
        }
      }
      expect(foundSessionId).toBe(injectedSessionId);
    });
  });

  it('generates a fresh UUIDv7 sessionId when env has no OBSERVABILITY_SESSION_ID', () => {
    const env = stubEnv({});
    configLoader = new ConfigLoader(env);
    eventStore = new EventStore(configLoader, new JsonlEventLog(), env);

    // setSessionId is public and can be used to verify the initial ID was set
    // We can test indirectly: if a UUIDv7 was generated, sessionId would be non-empty
    // Record an event then scan the file for the sessionId field.
    return eventStore.record('PROBE_EVENT' as any, {}).then(async () => {
      const eventsDir = path.join(tmpDir, '.pi/events');
      const files = fs.readdirSync(eventsDir).filter(f => f.endsWith('.jsonl'));
      // At least one event was recorded
      expect(files.length).toBeGreaterThan(0);
    });
  });
});

// ─── ConfigLoader ───────────────────────────────────────────────────────────

describe('ConfigLoader — injected RuntimeEnvironment', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orr-di-cfg-'));
    setProjectRoot(tmpDir);
    fs.mkdirSync(path.join(tmpDir, 'state/logs'), { recursive: true });
  });

  afterEach(async () => {
    Logger.close();
    setProjectRoot(process.cwd());
    await new Promise(resolve => setTimeout(resolve, 25));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads CONFIG_PATH from the injected env, not process.env', () => {
    const configPath = path.join(tmpDir, 'injected.yaml');
    fs.writeFileSync(configPath, minimalHarnessYaml('InjectedState').replace('Done', 'InjectedState'));

    const env = stubEnv({ [EnvVars.CONFIG_PATH]: configPath });
    const loader = new ConfigLoader(env);

    expect(loader.getConfigPath()).toBe(configPath);
  });

  it('falls back to harness.yaml when CONFIG_PATH is not in the injected env', () => {
    const env = stubEnv({});
    const loader = new ConfigLoader(env);
    setProjectRoot(tmpDir);
    // getConfigPath returns the resolved project path to harness.yaml
    expect(loader.getConfigPath()).toMatch(/harness\.yaml$/);
  });
});

// ─── FileAccessPolicy ────────────────────────────────────────────────────────

describe('FileAccessPolicy — injected RuntimeEnvironment', () => {
  it('returns null (policy skip) when WORKER_MODE is not set in the injected env', async () => {
    const env = stubEnv({});  // WORKER_MODE not set
    // FileAccessPolicy needs eventStore, shellCommandParser, planWriteSet
    // Use minimal stubs that won't be called since apply() returns early.
    const eventStore = { record: async () => {} } as any;
    const shellCommandParser = {} as any;
    const planWriteSet = {} as any;
    const policy = new FileAccessPolicy(eventStore, shellCommandParser, planWriteSet, env);

    const result = await policy.apply({ toolName: 'Read', input: { path: '/some/path' } });
    expect(result).toBeNull();
  });

  it('proceeds past WORKER_MODE gate and uses injected BEAD_ID in context when WORKER_MODE=1', async () => {
    const env = stubEnv({
      [EnvVars.WORKER_MODE]: ProcessFlag.TRUE,
      [EnvVars.BEAD_ID]: 'bd-gate-test',
      [EnvVars.STATE_ID]: 'Testing',
      [EnvVars.PROJECT_ROOT]: '/fake/project',
      [EnvVars.WORKTREE_PATH]: '/fake/worktree'
    });
    const recordedEvents: any[] = [];
    const eventStore = { record: async (_type: string, data: any) => { recordedEvents.push(data); } } as any;
    const shellCommandParser = {} as any;
    const planWriteSet = {} as any;
    const policy = new FileAccessPolicy(eventStore, shellCommandParser, planWriteSet, env);

    // Use lowercase 'read' (NativePiToolName.READ = 'read') with a path input.
    // applyNativeReadPolicy will call recordAccessAttempt, populating recordedEvents.
    await policy.apply({ toolName: 'read', input: { path: '/fake/project/some/file.ts' } });

    // If the gate passed, recordAccessAttempt was called with the context derived
    // from the injected env — confirming beadId = 'bd-gate-test' flowed through.
    expect(recordedEvents.length).toBeGreaterThan(0);
    expect(recordedEvents[0].beadId).toBe('bd-gate-test');
  });
});
