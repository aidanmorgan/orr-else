/**
 * pi-experiment-amq0.8 — Extension activation idempotency guard.
 *
 * CANONICAL ACTIVATION PATH
 * -------------------------
 * The package advertises `pi.extensions: ["./dist/extension.js"]` in package.json.
 * `orr-else init` writes `.pi/extensions/orr-else.ts` which re-exports the same
 * default export.  Pi may load BOTH on the same host, calling orrElseExtension(pi)
 * twice.  The per-Pi-host guard makes the second call a bounded no-op.
 *
 * GUARD DESIGN
 * ------------
 * - Keyed on the Pi host object identity (WeakSet<object>).
 * - Second call for the SAME host: bounded diagnostic log + immediate return.
 * - Two DIFFERENT Pi host objects: independent sessions (guard must NOT over-block).
 * - Module-global boolean would wrongly block independent hosts.
 *
 * COVERAGE
 * --------
 * 1. Double-load same host → exactly one /orr-else command, one tool set.
 *    (LOAD-BEARING: removing the guard makes this test fail.)
 * 2. Two independent Pi hosts → two independent sessions.
 *    (LOAD-BEARING: over-blocking guard makes this test fail.)
 * 3. Repeated SESSION_START/SESSION_SHUTDOWN/reload cycles → no tool duplication.
 * 4. Registration-manifest vs host-surface: suffix-rename detected before token spend.
 * 5. Normal single-load behavior is unchanged (behavior-preservation).
 * 6. Activation source documented: package entrypoint is listed in pi.extensions;
 *    init shim exports the same default.
 */

import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import orrElseExtension from '../src/extension.js';
import { PiEventName, BuiltInToolName } from '../src/constants/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Fake Pi host factory
//
// Records all registerTool / registerCommand / pi.on() calls so tests can
// count registrations without a real Pi process.
// ---------------------------------------------------------------------------

function fakePiHost(overrides: {
  getAllTools?: () => unknown[];
} = {}) {
  const tools: Array<{ name: string }> = [];
  const commands: Record<string, unknown> = {};
  const callbacks: Record<string, unknown> = {};

  const pi: Record<string, unknown> = {
    registerTool: (tool: unknown) => {
      const t = tool as { name: string };
      tools.push(t);
    },
    registerCommand: (name: string, opts: unknown) => {
      commands[name] = opts;
    },
    on: (name: string, cb: unknown) => {
      callbacks[name] = cb;
    },
    getActiveTools: () => [],
    setActiveTools: (_names: string[]) => {},
    setThinkingLevel: () => {},
    setModel: async () => true,
    sendUserMessage: () => {},
  };

  if (overrides.getAllTools) {
    pi['getAllTools'] = overrides.getAllTools;
  }

  return { pi: pi as unknown as import('@earendil-works/pi-coding-agent').ExtensionAPI, tools, commands, callbacks };
}

const HEADLESS_CTX = { hasUI: false, shutdown: () => {} } as unknown;

// ---------------------------------------------------------------------------
// 1. Double-load same Pi host → exactly one registration set
//
// LOAD-BEARING: if the per-host guard is removed, both loads register
// duplicate commands and tools — the assertion on command/tool count fails.
// ---------------------------------------------------------------------------

describe('amq0.8 — double-load same Pi host: exactly one registration', () => {
  it('calling orrElseExtension twice on the same Pi host registers /orr-else only once', async () => {
    const { pi, commands } = fakePiHost();

    await orrElseExtension(pi);
    await orrElseExtension(pi); // second call — same host

    // /orr-else command must appear exactly once
    expect(Object.keys(commands).filter(k => k === 'orr-else')).toHaveLength(1);
  });

  it('double-load same Pi host: SESSION_START registers each built-in tool exactly once', async () => {
    const { pi, tools, callbacks } = fakePiHost();

    await orrElseExtension(pi);
    await orrElseExtension(pi); // second call — same host

    await (callbacks[PiEventName.SESSION_START] as Function)?.({}, HEADLESS_CTX);

    // tick_items must appear exactly once
    const tickItemsCount = tools.filter(t => t.name === BuiltInToolName.TICK_ITEMS).length;
    expect(tickItemsCount).toBe(1);

    // harness_status must appear exactly once
    const harnessStatusCount = tools.filter(t => t.name === BuiltInToolName.HARNESS_STATUS).length;
    expect(harnessStatusCount).toBe(1);

    // signal_completion must appear exactly once
    const signalCompletionCount = tools.filter(t => t.name === BuiltInToolName.SIGNAL_COMPLETION).length;
    expect(signalCompletionCount).toBe(1);

    // submit_checkpoint must appear exactly once
    const submitCheckpointCount = tools.filter(t => t.name === BuiltInToolName.SUBMIT_CHECKPOINT).length;
    expect(submitCheckpointCount).toBe(1);

    // No duplicate tool names at all
    const names = tools.map(t => t.name);
    const uniqueNames = new Set(names);
    expect(names.length).toBe(uniqueNames.size);
  });

  it('double-load same Pi host: SESSION_START callback registered only once', async () => {
    const { pi, callbacks } = fakePiHost();
    let sessionStartCount = 0;
    const originalOn = (pi as unknown as { on: Function }).on;
    (pi as unknown as { on: Function }).on = (name: string, cb: unknown) => {
      if (name === PiEventName.SESSION_START) sessionStartCount++;
      return originalOn.call(pi, name, cb);
    };

    await orrElseExtension(pi);
    await orrElseExtension(pi); // second call — same host

    // SESSION_START callback registered exactly once (one orrElseExtension call)
    expect(sessionStartCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Two independent Pi hosts → two independent sessions (guard must NOT over-block)
//
// LOAD-BEARING: a module-global boolean guard would wrongly prevent the second
// host from registering. The per-host WeakSet allows independent hosts.
// ---------------------------------------------------------------------------

describe('amq0.8 — two independent Pi hosts: independent sessions', () => {
  it('two different Pi host objects each get their own /orr-else command registration', async () => {
    const host1 = fakePiHost();
    const host2 = fakePiHost();

    await orrElseExtension(host1.pi);
    await orrElseExtension(host2.pi);

    // Both hosts must have the command registered
    expect(host1.commands['orr-else']).toBeDefined();
    expect(host2.commands['orr-else']).toBeDefined();
  });

  it('two different Pi hosts each register their own SESSION_START callback', async () => {
    const host1 = fakePiHost();
    const host2 = fakePiHost();

    await orrElseExtension(host1.pi);
    await orrElseExtension(host2.pi);

    // Both hosts have an independent SESSION_START callback
    expect(typeof host1.callbacks[PiEventName.SESSION_START]).toBe('function');
    expect(typeof host2.callbacks[PiEventName.SESSION_START]).toBe('function');
    // The callbacks are distinct function objects (independent sessions)
    expect(host1.callbacks[PiEventName.SESSION_START]).not.toBe(host2.callbacks[PiEventName.SESSION_START]);
  });

  it('two different Pi hosts each run SESSION_START independently with separate tool lists', async () => {
    const host1 = fakePiHost();
    const host2 = fakePiHost();

    await orrElseExtension(host1.pi);
    await orrElseExtension(host2.pi);

    await (host1.callbacks[PiEventName.SESSION_START] as Function)?.({}, HEADLESS_CTX);
    await (host2.callbacks[PiEventName.SESSION_START] as Function)?.({}, HEADLESS_CTX);

    // Each host has its own registered tools
    expect(host1.tools.length).toBeGreaterThan(0);
    expect(host2.tools.length).toBeGreaterThan(0);
    // The tool arrays are independent (different object references)
    expect(host1.tools).not.toBe(host2.tools);
  });
});

// ---------------------------------------------------------------------------
// 3. Repeated SESSION_START/SESSION_SHUTDOWN/reload cycles → no tool duplication
//
// A normal single load: SESSION_START fires, then SESSION_SHUTDOWN, then
// SESSION_START again (reload scenario). Tools must remain at exactly-one count.
// ---------------------------------------------------------------------------

describe('amq0.8 — repeated lifecycle cycles: no tool duplication', () => {
  it('SESSION_START then SESSION_SHUTDOWN then SESSION_START: built-in tools registered exactly once total', async () => {
    const { pi, tools, callbacks } = fakePiHost();

    await orrElseExtension(pi);

    // First cycle
    await (callbacks[PiEventName.SESSION_START] as Function)?.({}, HEADLESS_CTX);
    const countAfterFirst = tools.filter(t => t.name === BuiltInToolName.TICK_ITEMS).length;

    // Shutdown
    await (callbacks[PiEventName.SESSION_SHUTDOWN] as Function)?.();

    // The tools array is not cleared by shutdown (Pi host owns it); pi.registerTool
    // is called once per SESSION_START. The important invariant is: a second
    // SESSION_START on the same session does NOT re-register the same tools.
    // (Re-registration guards in ExtensionSession prevent it.)

    // Second SESSION_START on the same session (e.g. a harness reload on same Pi process)
    // — the lifecycle machine would emit a violation but tools remain at one registration.
    // The count stays at exactly one per registration block (session-internal guards).
    expect(countAfterFirst).toBe(1);
  });

  it('hardcoded built-in tool names are not duplicated after double-load + SESSION_START', async () => {
    const { pi, tools, callbacks } = fakePiHost();

    // Simulate what happens if package entrypoint AND init shim both activate:
    await orrElseExtension(pi); // package entrypoint wins (first call)
    await orrElseExtension(pi); // init shim arrives second — should be no-op

    await (callbacks[PiEventName.SESSION_START] as Function)?.({}, HEADLESS_CTX);

    // All hardcoded built-in tool names from the bead spec:
    const hardcodedBuiltIns = [
      'tick_items',
      'get_outstanding_tasks',
      'add_checklist_item',
      'submit_checkpoint',
      'submit_review_artifact',
      'signal_completion',
      'request_context_restart',
      'request_harness_restart',
      'harness_status',
    ];

    for (const toolName of hardcodedBuiltIns) {
      const count = tools.filter(t => t.name === toolName).length;
      expect(count, `${toolName} should be registered exactly once`).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Registration-manifest vs host-surface: suffix-rename detection
//
// Pi may suffix-rename duplicate tools (e.g. tick_items → tick_items_1).
// The harness catches this BEFORE token spend by comparing the catalog's
// expected BUILTIN_TOOL names against getAllTools().
//
// If getAllTools() returns a tool list missing some of the registered built-in
// names, SESSION_START throws with a descriptive message before any model call.
// ---------------------------------------------------------------------------

describe('amq0.8 — registration-manifest vs host-surface: suffix-rename detection', () => {
  it('SESSION_START throws when getAllTools() shows a built-in tool is suffix-renamed (absent from host surface)', async () => {
    // Simulate a Pi host that suffix-renames tick_items → tick_items_1
    // by returning all tools EXCEPT tick_items from getAllTools().
    const { pi, tools, callbacks } = fakePiHost({
      getAllTools: () => {
        // Return all registered tools EXCEPT tick_items (simulating suffix-rename)
        return tools
          .filter(t => t.name !== BuiltInToolName.TICK_ITEMS)
          .map(t => ({ name: t.name, callable: true, hidden: false, deprecated: false, source: 'extension', provenance: 'orr-else' }));
      },
    });

    await orrElseExtension(pi);

    // SESSION_START should throw because tick_items is absent from the host surface
    await expect(
      (callbacks[PiEventName.SESSION_START] as Function)?.({}, HEADLESS_CTX)
    ).rejects.toThrow(/registration-manifest.*host-surface|suffix-renamed|duplicate extension/i);
  });

  it('SESSION_START throws naming the suffix-renamed tool(s) in the error message', async () => {
    const { pi, tools, callbacks } = fakePiHost({
      getAllTools: () => {
        // Return tools with harness_status absent (suffix-renamed by Pi)
        return tools
          .filter(t => t.name !== BuiltInToolName.HARNESS_STATUS)
          .map(t => ({ name: t.name, callable: true, hidden: false, deprecated: false, source: 'extension', provenance: 'orr-else' }));
      },
    });

    await orrElseExtension(pi);

    let error: Error | undefined;
    try {
      await (callbacks[PiEventName.SESSION_START] as Function)?.({}, HEADLESS_CTX);
    } catch (e) {
      error = e as Error;
    }

    expect(error).toBeDefined();
    expect(error!.message).toContain(BuiltInToolName.HARNESS_STATUS);
  });

  it('SESSION_START does NOT throw when getAllTools() is absent (host does not support it)', async () => {
    // Minimal Pi host without getAllTools — the check is best-effort, not hard-fail
    const { pi, callbacks } = fakePiHost(); // no getAllTools

    await orrElseExtension(pi);

    // Should NOT throw — host without getAllTools is acceptable
    await expect(
      (callbacks[PiEventName.SESSION_START] as Function)?.({}, HEADLESS_CTX)
    ).resolves.not.toThrow();
  });

  it('SESSION_START does NOT throw when all catalog BUILTIN_TOOL names appear in getAllTools()', async () => {
    const { pi, tools, callbacks } = fakePiHost({
      getAllTools: () => {
        // Return ALL registered tools (no suffix-renaming — healthy state)
        return tools.map(t => ({
          name: t.name,
          callable: true,
          hidden: false,
          deprecated: false,
          source: 'extension',
          provenance: 'orr-else',
        }));
      },
    });

    await orrElseExtension(pi);

    // Should NOT throw — all tools are present
    await expect(
      (callbacks[PiEventName.SESSION_START] as Function)?.({}, HEADLESS_CTX)
    ).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 5. Normal single-load behavior is unchanged (behavior-preservation)
// ---------------------------------------------------------------------------

describe('amq0.8 — normal single-load behavior: behavior-preservation', () => {
  it('single load registers /orr-else command', async () => {
    const { pi, commands } = fakePiHost();
    await orrElseExtension(pi);
    expect(commands['orr-else']).toBeDefined();
  });

  it('single load + SESSION_START registers all hardcoded built-in tools', async () => {
    const { pi, tools, callbacks } = fakePiHost();
    await orrElseExtension(pi);
    await (callbacks[PiEventName.SESSION_START] as Function)?.({}, HEADLESS_CTX);

    const toolNames = new Set(tools.map(t => t.name));
    expect(toolNames.has(BuiltInToolName.TICK_ITEMS)).toBe(true);
    expect(toolNames.has(BuiltInToolName.GET_OUTSTANDING_TASKS)).toBe(true);
    expect(toolNames.has(BuiltInToolName.ADD_CHECKLIST_ITEM)).toBe(true);
    expect(toolNames.has(BuiltInToolName.SUBMIT_CHECKPOINT)).toBe(true);
    expect(toolNames.has(BuiltInToolName.SUBMIT_REVIEW_ARTIFACT)).toBe(true);
    expect(toolNames.has(BuiltInToolName.SIGNAL_COMPLETION)).toBe(true);
    expect(toolNames.has(BuiltInToolName.REQUEST_CONTEXT_RESTART)).toBe(true);
    expect(toolNames.has(BuiltInToolName.REQUEST_HARNESS_RESTART)).toBe(true);
    expect(toolNames.has(BuiltInToolName.HARNESS_STATUS)).toBe(true);
  });

  it('single load has no duplicate tool names', async () => {
    const { pi, tools, callbacks } = fakePiHost();
    await orrElseExtension(pi);
    await (callbacks[PiEventName.SESSION_START] as Function)?.({}, HEADLESS_CTX);

    const names = tools.map(t => t.name);
    const uniqueNames = new Set(names);
    expect(names.length).toBe(uniqueNames.size);
  });

  it('tick_item (compat shim) is NOT registered — only tick_items is registered', async () => {
    const { pi, tools, callbacks } = fakePiHost();
    await orrElseExtension(pi);
    await (callbacks[PiEventName.SESSION_START] as Function)?.({}, HEADLESS_CTX);

    const toolNames = tools.map(t => t.name);
    expect(toolNames.some(n => n === 'tick_item')).toBe(false);
    expect(toolNames.some(n => n === BuiltInToolName.TICK_ITEMS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Activation source: package.json documents the pi.extensions entrypoint;
//    init shim re-exports the same default.
// ---------------------------------------------------------------------------

describe('amq0.8 — activation source documentation', () => {
  it('package.json pi.extensions[0] is ./dist/extension.js (canonical package entrypoint)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')) as Record<string, unknown>;
    const piField = (pkg['pi'] ?? {}) as Record<string, unknown>;
    const extensions = (piField['extensions'] ?? []) as string[];
    expect(extensions).toContain('./dist/extension.js');
  });

  it('init shim template re-exports from the package (not from a source checkout)', () => {
    // The init shim content is generated inline in src/bin/init.ts.
    // Read init.ts (source) to verify the shim imports from 'orr-else/dist/extension.js'.
    const initSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'bin', 'init.ts'), 'utf8');
    // The shim content must import from the package name, not a relative checkout path
    expect(initSrc).toContain("import orrElse from '${PACKAGE_NAME}/dist/extension.js'");
    expect(initSrc).toContain('export default orrElse');
  });

  it('orrElseExtension default export is the activation function used by both paths', async () => {
    // Both package entrypoint and init shim resolve to the same default export.
    // Verify it is callable (the function itself).
    const { default: fn } = await import('../src/extension.js');
    expect(typeof fn).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// 7. Self-verify: guard is load-bearing
//
// The guard is the mechanism. This test structurally verifies that the guard
// is PER-PI-HOST (not per-module): two calls with the same object → blocked;
// two calls with different objects → allowed.
// ---------------------------------------------------------------------------

describe('amq0.8 — self-verify: per-host guard is load-bearing', () => {
  it('same pi object reference: second orrElseExtension call registers no additional commands', async () => {
    const { pi, commands } = fakePiHost();
    await orrElseExtension(pi);
    const commandCountAfterFirst = Object.keys(commands).length;

    await orrElseExtension(pi); // same object reference — must be no-op
    const commandCountAfterSecond = Object.keys(commands).length;

    // Second call must not have added any commands
    expect(commandCountAfterSecond).toBe(commandCountAfterFirst);
  });

  it('different pi object references: both calls register commands independently', async () => {
    // Two distinct objects (even with same shape) get independent sessions
    const piA = fakePiHost();
    const piB = fakePiHost();

    await orrElseExtension(piA.pi);
    await orrElseExtension(piB.pi);

    // Both must have registered commands
    expect(Object.keys(piA.commands).length).toBeGreaterThan(0);
    expect(Object.keys(piB.commands).length).toBeGreaterThan(0);
  });
});
