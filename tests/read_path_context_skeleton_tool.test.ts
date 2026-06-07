/**
 * pi-experiment-fdls acceptance tests.
 *
 * 0yt5.3 made read_path_context skeleton extraction pluggable via the harness
 * `skeletons` registry, and PathContext.resolve() produces skeletons when called
 * with `skeleton:true`. This bead wires `skeleton` into the LIVE read_path_context
 * MCP tool schema registered in src/extension.ts so the model can trigger it.
 *
 * These tests drive the REAL registered tool's execute handler (not PathContext
 * directly): they build the extension via orrElseExtension(fakePi), fire the
 * SESSION_START callback so the tool registers, find read_path_context in the
 * captured registerTool calls, then invoke its execute with {filePath, skeleton:true}.
 *  - (a) WITH a registered extractor for the extension → skeletonContent is the
 *        extractor output and skeletonFallback is false.
 *  - (b) NEGATIVE: NO extractor for the extension → skeletonContent is the RAW
 *        file content and skeletonFallback is true (no crash).
 * It also asserts the registered TypeBox parameter schema exposes `skeleton`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BuiltInToolName, EnvVars, PiEventName } from '../src/constants/index.js';
import { skeletons } from '../src/contract.js';
import { Logger } from '../src/core/Logger.js';
import orrElseExtension from '../src/extension.js';

function fakePi() {
  const tools: any[] = [];
  const callbacks: Record<string, Function> = {};
  return {
    tools,
    callbacks,
    pi: {
      on: (name: string, cb: Function) => { callbacks[name] = cb; },
      registerTool: (tool: any) => tools.push(tool),
      registerCommand: () => {},
      getActiveTools: () => [],
      setActiveTools: () => {},
      setThinkingLevel: () => {},
      setModel: async () => true,
      sendUserMessage: () => {}
    } as any
  };
}

describe('pi-experiment-fdls: skeleton mode on the live read_path_context tool', () => {
  let previousCwd: string;
  let tempRoot: string;
  let prevProjectRoot: string | undefined;
  let prevWorktree: string | undefined;

  beforeEach(() => {
    previousCwd = process.cwd();
    prevProjectRoot = process.env[EnvVars.PROJECT_ROOT];
    prevWorktree = process.env[EnvVars.WORKTREE_PATH];
    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-fdls-')));
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Planning
  eventStore:
    enabled: true
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
      - id: a1
        type: prompt
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`);
    process.chdir(tempRoot);
    process.env[EnvVars.PROJECT_ROOT] = tempRoot;
    process.env[EnvVars.WORKTREE_PATH] = tempRoot;
  });

  afterEach(async () => {
    // The tool's execute records a domain event, which logs through the winston
    // DailyRotateFile transport (a buffered, async-flushing file stream). If we
    // rmSync the temp project root while a flush is pending, winston emits an
    // EventEmitter 'error' (ENOENT on .pi/logs/*.log) — an unhandled error, not a
    // catchable promise rejection. Close the transport, then let any in-flight
    // flush settle, before removing the dir. (Mirrors tests/event_store.test.ts.)
    Logger.close();
    await new Promise(resolve => setTimeout(resolve, 200));
    process.chdir(previousCwd);
    if (prevProjectRoot === undefined) delete process.env[EnvVars.PROJECT_ROOT];
    else process.env[EnvVars.PROJECT_ROOT] = prevProjectRoot;
    if (prevWorktree === undefined) delete process.env[EnvVars.WORKTREE_PATH];
    else process.env[EnvVars.WORKTREE_PATH] = prevWorktree;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  async function registeredReadPathContextTool(): Promise<any> {
    const harness = fakePi();
    await orrElseExtension(harness.pi);
    await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
    const tool = harness.tools.find(t => t.name === BuiltInToolName.READ_PATH_CONTEXT);
    expect(tool, 'read_path_context tool must be registered').toBeDefined();
    return tool;
  }

  const noUiCtx = { hasUI: false } as any;

  it('the registered tool schema exposes a `skeleton` boolean parameter', async () => {
    const tool = await registeredReadPathContextTool();
    // Introspect the TypeBox schema object passed to registerTool.
    expect(tool.parameters?.properties?.skeleton).toBeDefined();
    expect(tool.parameters.properties.skeleton.type).toBe('boolean');
  });

  it('(a) with a registered extractor → registry output + skeletonFallback false', async () => {
    const ext = '.fdlsa';
    skeletons.register(ext, (source) => `SKELETON-OF:${source.split('\n')[0]}`);
    try {
      const filePath = path.join(tempRoot, 'sample.fdlsa');
      fs.writeFileSync(filePath, 'first-line-marker\nbody-should-not-appear\n');

      const tool = await registeredReadPathContextTool();
      const wrapped = await tool.execute('call-a', { filePath, skeleton: true }, undefined, undefined, noUiCtx);
      // The wrapped plugin tool returns { content, details } — details is the
      // PathContext.resolve() result.
      const result = wrapped.details;

      expect(result.status).toBe('found');
      expect(result.skeletonFallback).toBe(false);
      expect(result.skeletonContent).toBe('SKELETON-OF:first-line-marker');
      expect(result.skeletonContent).not.toContain('body-should-not-appear');
    } finally {
      // Reset registry (last-wins overwrite — no remove API; mirror path_context (h1)).
      skeletons.register(ext, (source) => source);
    }
  });

  it('(b) NEGATIVE: no extractor → FAIL CLOSED — skeletonContent null, skeletonFallback true, no raw content', async () => {
    // pi-experiment-6q0y.31: skeleton:true with no registered extractor must fail
    // closed. Raw content must NOT be returned via skeleton mode.
    const rawBody = ['func main() {', '\tvar secret = "kept-verbatim"', '}'].join('\n');
    const filePath = path.join(tempRoot, 'main.fdlsb');
    fs.writeFileSync(filePath, rawBody);

    const tool = await registeredReadPathContextTool();
    const wrapped = await tool.execute('call-b', { filePath, skeleton: true }, undefined, undefined, noUiCtx);
    const result = wrapped.details;

    expect(result.status).toBe('found');
    // No extractor → skeletonFallback signals the missing-extractor condition.
    expect(result.skeletonFallback).toBe(true);
    // Fail closed: no raw content returned (null confirms no raw fallback).
    expect(result.skeletonContent).toBeNull();
  });
});
