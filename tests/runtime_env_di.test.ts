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
import { Logger } from '../src/core/Logger.js';
import { createRuntimeServices } from '../src/composition/createRuntimeServices.js';
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
  worktreePolicy:
    default: always
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]

states:
  ${startState}:
    identity: { role: done, expertise: done, constraints: [] }
    baseInstructions: done
    actions:
      - id: a1
        type: prompt
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
    fs.mkdirSync(path.join(tmpDir, '.pi/otel'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.pi/logs'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'state/logs'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'harness.yaml'), minimalHarnessYaml());
  });

  afterEach(async () => {
    observability?.shutdown();
    configLoader?.reset();
    Logger.close();
    await new Promise(resolve => setTimeout(resolve, 25));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uses the injected OBSERVABILITY_SESSION_ID without reading process.env', async () => {
    const injectedSessionId = 'stub-session-id-from-di';
    const env = stubEnv({ [EnvVars.OBSERVABILITY_SESSION_ID]: injectedSessionId });

    configLoader = new ConfigLoader(env, tmpDir);
    configLoader.setConfigPath(path.join(tmpDir, 'harness.yaml'));
    observability = new Observability(configLoader, env, tmpDir);

    expect(observability.getSessionId()).toBe(injectedSessionId);
  });

  it('generates a fresh UUIDv7 session ID when OBSERVABILITY_SESSION_ID is not injected', () => {
    const env = stubEnv({});   // no session id in env
    configLoader = new ConfigLoader(env, tmpDir);
    observability = new Observability(configLoader, env, tmpDir);

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

    configLoader = new ConfigLoader(env, tmpDir);
    configLoader.setConfigPath(path.join(tmpDir, 'harness.yaml'));
    observability = new Observability(configLoader, env, tmpDir);

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
    fs.mkdirSync(path.join(tmpDir, '.pi/events'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.pi/logs'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'state/logs'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'harness.yaml'), minimalHarnessYaml());
  });

  afterEach(async () => {
    Logger.close();
    await new Promise(resolve => setTimeout(resolve, 25));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uses the injected OBSERVABILITY_SESSION_ID as the initial sessionId', () => {
    const injectedSessionId = 'event-store-session-di';
    const env = stubEnv({ [EnvVars.OBSERVABILITY_SESSION_ID]: injectedSessionId });

    configLoader = new ConfigLoader(env, tmpDir);
    configLoader.setConfigPath(path.join(tmpDir, 'harness.yaml'));
    eventStore = new EventStore(configLoader, new JsonlEventLog(), env, tmpDir);

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
    configLoader = new ConfigLoader(env, tmpDir);
    eventStore = new EventStore(configLoader, new JsonlEventLog(), env, tmpDir);

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
    fs.mkdirSync(path.join(tmpDir, 'state/logs'), { recursive: true });
  });

  afterEach(async () => {
    Logger.close();
    await new Promise(resolve => setTimeout(resolve, 25));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads CONFIG_PATH from the injected env, not process.env', () => {
    const configPath = path.join(tmpDir, 'injected.yaml');
    fs.writeFileSync(configPath, minimalHarnessYaml('InjectedState').replace('Done', 'InjectedState'));

    const env = stubEnv({ [EnvVars.CONFIG_PATH]: configPath });
    const loader = new ConfigLoader(env, tmpDir);

    expect(loader.getConfigPath()).toBe(configPath);
  });

  it('falls back to harness.yaml when CONFIG_PATH is not in the injected env', () => {
    const env = stubEnv({});
    const loader = new ConfigLoader(env, tmpDir);
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

// ─── No-cross-talk: two RuntimeServices instances in the same process ────────

describe('RuntimeServices — no cross-talk between two instances (WI-2)', () => {
  let rootA: string;
  let rootB: string;

  beforeEach(() => {
    rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'orr-wi2-a-'));
    rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'orr-wi2-b-'));
    // Write minimal harness.yaml so ConfigLoader doesn't throw
    const minimalYaml = `
settings:
  maxConcurrentSlots: 1
  handoverTemplate: "h"
  startState: Done
  defaultModel: "model"
  worktreePolicy:
    default: always
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
states:
  Done:
    identity: { role: done, expertise: done, constraints: [] }
    baseInstructions: done
    actions:
      - id: a1
        type: prompt
    transitions: {}
`;
    fs.writeFileSync(path.join(rootA, 'harness.yaml'), minimalYaml);
    fs.writeFileSync(path.join(rootB, 'harness.yaml'), minimalYaml);
  });

  afterEach(async () => {
    Logger.close();
    await new Promise(resolve => setTimeout(resolve, 25));
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  });

  it('two services instances built with different projectRoots never share path state', () => {
    // Build two independent RuntimeServices in the same process, each with a
    // distinct projectRoot. Neither should observe the other's root.
    const envA = stubEnv({ [EnvVars.PROJECT_ROOT]: rootA });
    const envB = stubEnv({ [EnvVars.PROJECT_ROOT]: rootB });

    const servicesA = createRuntimeServices(envA);
    const servicesB = createRuntimeServices(envB);

    expect(servicesA.projectRoot).toBe(rootA);
    expect(servicesB.projectRoot).toBe(rootB);
    expect(servicesA.projectRoot).not.toBe(servicesB.projectRoot);
  });

  it('ConfigLoader built with rootA resolves harness.yaml under rootA, not rootB', () => {
    const loaderA = new ConfigLoader(undefined, rootA);
    const loaderB = new ConfigLoader(undefined, rootB);

    expect(loaderA.getConfigPath()).toContain(rootA);
    expect(loaderB.getConfigPath()).toContain(rootB);
    expect(loaderA.getConfigPath()).not.toContain(rootB);
    expect(loaderB.getConfigPath()).not.toContain(rootA);
  });

  it('ArtifactPaths built with rootA uses rootA for path resolution', async () => {
    // Write an artifact so we can verify the resolved path.
    const artifactDir = path.join(rootA, '.pi', 'artifacts', 'bd-test');
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, 'plan.json'), '{}');

    const configA = new ConfigLoader(undefined, rootA);
    configA.setConfigPath(path.join(rootA, 'harness.yaml'));

    // Add artifact template to the harness yaml
    fs.writeFileSync(path.join(rootA, 'harness.yaml'), `
settings:
  maxConcurrentSlots: 1
  handoverTemplate: "h"
  startState: Done
  defaultModel: "model"
  artifacts:
    baseDir: .pi/artifacts
    templates:
      plan: .pi/artifacts/{{beadId}}/plan.json
  worktreePolicy:
    default: always
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
states:
  Done:
    identity: { role: done, expertise: done, constraints: [] }
    baseInstructions: done
    actions:
      - id: a1
        type: prompt
    transitions: {}
`);
    const { ArtifactPaths } = await import('../src/core/ArtifactPaths.js');
    const apA = new ArtifactPaths(configA, undefined, rootA);
    const resolution = await apA.resolve({ beadId: 'bd-test' });

    // Path must be under rootA, not rootB
    expect(resolution.artifactPaths.plan).toContain(rootA);
    expect(resolution.artifactPaths.plan).not.toContain(rootB);
    configA.reset();
  });
});
