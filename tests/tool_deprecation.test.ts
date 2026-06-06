/**
 * pi-experiment-87fm: Deprecation/visibility guard for obsolete project tools.
 *
 * AC1: Config can mark a tool/verifier as hidden or deprecated with optional replacement list and reason.
 * AC2: Deprecated/hidden tools are omitted from model-facing guidance (describeConfiguredProjectTools).
 * AC3: Invoking a deprecated tool returns REJECTED + emits TOOL_DEPRECATED_REJECTED event.
 * AC4: Config validation fails when requiredTool references a deprecated hidden tool without allowDeprecated.
 * AC5: (Illustrative) Config shape supports marking a generic validator deprecated while keeping replacements.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import {
  allowedDeprecatedToolNames,
  describeConfiguredProjectTools,
  executeConfiguredProjectTool
} from '../src/plugins/projectTools.js';
import { DomainEventName, ProjectToolType, ToolResultStatus } from '../src/constants/index.js';
import type { HarnessConfig } from '../src/core/ConfigLoader.js';
import type { ProjectCommandToolConfig } from '../src/core/domain/StateModels.js';

// ── minimal harness config builder ──────────────────────────────────────────

function minimalConfig(toolOverrides: Partial<ProjectCommandToolConfig>[] = []): HarnessConfig {
  return {
    settings: {
      maxConcurrentSlots: 1,
      handoverTemplate: 'handover',
      agentTurnTimeoutMs: 60_000,
      processReapIntervalMs: 5_000,
      harnessRestartEvent: 'HARNESS_RESTART',
      contextRestartEvent: 'CONTEXT_RESTART',
      defaultModel: 'gpt-4',
      defaultProvider: 'openai',
      modelProviders: { openai: { provider: 'openai', model: 'gpt-4' } },
      stateContextRotThreshold: 10,
      harnessContextRotThreshold: 5
    },
    scheduler: { weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 } },
    states: {},
    tools: toolOverrides.length > 0 ? toolOverrides.map(o => ({
      name: 'unnamed',
      type: ProjectToolType.COMMAND,
      command: 'echo',
      ...o
    } as ProjectCommandToolConfig)) : undefined
  } as HarnessConfig;
}

// ── AC1: config fields accepted on BaseProjectToolConfig ────────────────────

describe('AC1: deprecated/hidden config fields', () => {
  it('accepts deprecated:true with no replacements or reason', () => {
    const config = minimalConfig([{
      name: 'artifact_validator',
      type: ProjectToolType.COMMAND,
      command: 'echo',
      deprecated: true
    }]);
    const tool = config.tools![0] as any;
    expect(tool.deprecated).toBe(true);
    expect(tool.replacedBy).toBeUndefined();
    expect(tool.deprecationReason).toBeUndefined();
  });

  it('accepts deprecated:true with replacedBy and deprecationReason', () => {
    const config = minimalConfig([{
      name: 'artifact_validator',
      type: ProjectToolType.COMMAND,
      command: 'echo',
      deprecated: true,
      replacedBy: ['requirements_schema', 'plan_contract'],
      deprecationReason: 'Replaced by project-owned validators.'
    }]);
    const tool = config.tools![0] as any;
    expect(tool.deprecated).toBe(true);
    expect(tool.replacedBy).toEqual(['requirements_schema', 'plan_contract']);
    expect(tool.deprecationReason).toBe('Replaced by project-owned validators.');
  });

  it('accepts hidden:true independently of deprecated', () => {
    const config = minimalConfig([{
      name: 'old_tool',
      type: ProjectToolType.COMMAND,
      command: 'echo',
      hidden: true
    }]);
    const tool = config.tools![0] as any;
    expect(tool.hidden).toBe(true);
    expect(tool.deprecated).toBeUndefined();
  });
});

// ── AC2: hidden/deprecated tools excluded from model-facing guidance ─────────

describe('AC2: model-facing guidance omits hidden/deprecated tools', () => {
  it('includes a normal (non-deprecated, non-hidden) tool', () => {
    const config = minimalConfig([{
      name: 'plan_contract',
      description: 'Validates the implementation plan.',
      type: ProjectToolType.COMMAND,
      command: 'echo'
    }]);
    const description = describeConfiguredProjectTools(config);
    expect(description).toContain('plan_contract');
  });

  it('omits a hidden tool from guidance', () => {
    const config = minimalConfig([
      { name: 'plan_contract', description: 'Active tool.', type: ProjectToolType.COMMAND, command: 'echo' },
      { name: 'old_tool', description: 'Hidden.', type: ProjectToolType.COMMAND, command: 'echo', hidden: true } as any
    ]);
    const description = describeConfiguredProjectTools(config);
    expect(description).toContain('plan_contract');
    expect(description).not.toContain('old_tool');
  });

  it('omits a deprecated tool from guidance', () => {
    const config = minimalConfig([
      { name: 'requirements_schema', description: 'Active tool.', type: ProjectToolType.COMMAND, command: 'echo' },
      {
        name: 'artifact_validator',
        description: 'Generic validator.',
        type: ProjectToolType.COMMAND,
        command: 'echo',
        deprecated: true,
        replacedBy: ['requirements_schema'],
        deprecationReason: 'Use project-owned validators.'
      } as any
    ]);
    const description = describeConfiguredProjectTools(config);
    expect(description).toContain('requirements_schema');
    expect(description).not.toContain('artifact_validator');
  });

  it('omits both hidden and deprecated tools while keeping active ones', () => {
    const config = minimalConfig([
      { name: 'active', description: 'Active.', type: ProjectToolType.COMMAND, command: 'echo' },
      { name: 'hidden_tool', description: 'Hidden.', type: ProjectToolType.COMMAND, command: 'echo', hidden: true } as any,
      { name: 'deprecated_tool', description: 'Deprecated.', type: ProjectToolType.COMMAND, command: 'echo', deprecated: true } as any
    ]);
    const description = describeConfiguredProjectTools(config);
    expect(description).toContain('active');
    expect(description).not.toContain('hidden_tool');
    expect(description).not.toContain('deprecated_tool');
  });

  it('returns empty string when all tools are hidden or deprecated', () => {
    const config = minimalConfig([
      { name: 'h', type: ProjectToolType.COMMAND, command: 'echo', hidden: true } as any,
      { name: 'd', type: ProjectToolType.COMMAND, command: 'echo', deprecated: true } as any
    ]);
    expect(describeConfiguredProjectTools(config)).toBe('');
  });
});

// ── AC2 (escape hatch): deprecated/hidden tool surfaced when current state/action allows it ─

describe('AC2 escape: deprecated/hidden tool shown when current state/action uses allowDeprecated:true', () => {
  it('includes a deprecated+hidden tool when the current state requiredTools has allowDeprecated:true', () => {
    const config = minimalConfig([
      { name: 'active', description: 'Active tool.', type: ProjectToolType.COMMAND, command: 'echo' },
      {
        name: 'legacy_validator',
        description: 'Legacy tool.',
        type: ProjectToolType.COMMAND,
        command: 'echo',
        deprecated: true,
        hidden: true
      } as any
    ]);
    const allowed = allowedDeprecatedToolNames(
      [{ name: 'legacy_validator', allowDeprecated: true }],
      undefined
    );
    const description = describeConfiguredProjectTools(config, allowed);
    expect(description).toContain('active');
    expect(description).toContain('legacy_validator');
  });

  it('includes a deprecated+hidden tool when the current action requiredTools has allowDeprecated:true', () => {
    const config = minimalConfig([
      { name: 'active', description: 'Active tool.', type: ProjectToolType.COMMAND, command: 'echo' },
      {
        name: 'legacy_validator',
        description: 'Legacy tool.',
        type: ProjectToolType.COMMAND,
        command: 'echo',
        deprecated: true,
        hidden: true
      } as any
    ]);
    const allowed = allowedDeprecatedToolNames(
      undefined,
      [{ name: 'legacy_validator', allowDeprecated: true }]
    );
    const description = describeConfiguredProjectTools(config, allowed);
    expect(description).toContain('active');
    expect(description).toContain('legacy_validator');
  });

  it('does NOT include the deprecated+hidden tool for a state/action that does not allow it (default hide preserved)', () => {
    const config = minimalConfig([
      { name: 'active', description: 'Active tool.', type: ProjectToolType.COMMAND, command: 'echo' },
      {
        name: 'legacy_validator',
        description: 'Legacy tool.',
        type: ProjectToolType.COMMAND,
        command: 'echo',
        deprecated: true,
        hidden: true
      } as any
    ]);
    // allowDeprecated is false on the entry — should NOT surface the tool
    const allowed = allowedDeprecatedToolNames(
      [{ name: 'legacy_validator', allowDeprecated: false }],
      undefined
    );
    const description = describeConfiguredProjectTools(config, allowed);
    expect(description).toContain('active');
    expect(description).not.toContain('legacy_validator');
  });

  it('does NOT include the deprecated+hidden tool when requiredTools is empty (no escape, default hide)', () => {
    const config = minimalConfig([
      { name: 'active', description: 'Active tool.', type: ProjectToolType.COMMAND, command: 'echo' },
      {
        name: 'legacy_validator',
        description: 'Legacy tool.',
        type: ProjectToolType.COMMAND,
        command: 'echo',
        deprecated: true,
        hidden: true
      } as any
    ]);
    const allowed = allowedDeprecatedToolNames(undefined, undefined);
    const description = describeConfiguredProjectTools(config, allowed);
    expect(description).toContain('active');
    expect(description).not.toContain('legacy_validator');
  });

  it('does not affect non-deprecated tools', () => {
    const config = minimalConfig([
      { name: 'plan_contract', description: 'Active tool.', type: ProjectToolType.COMMAND, command: 'echo' },
      { name: 'requirements_schema', description: 'Also active.', type: ProjectToolType.COMMAND, command: 'echo' }
    ]);
    const allowed = allowedDeprecatedToolNames([], []);
    const description = describeConfiguredProjectTools(config, allowed);
    expect(description).toContain('plan_contract');
    expect(description).toContain('requirements_schema');
  });

  it('allowedDeprecatedToolNames collects from both state and action requiredTools', () => {
    const allowed = allowedDeprecatedToolNames(
      [{ name: 'state_tool', allowDeprecated: true }, { name: 'non_deprecated', allowDeprecated: false }],
      [{ name: 'action_tool', allowDeprecated: true }, 'string_form_tool']
    );
    expect(allowed.has('state_tool')).toBe(true);
    expect(allowed.has('action_tool')).toBe(true);
    expect(allowed.has('non_deprecated')).toBe(false);
    // string form never has allowDeprecated:true
    expect(allowed.has('string_form_tool')).toBe(false);
  });
});

// ── AC3: invoking deprecated tool returns REJECTED + emits event ─────────────

describe('AC3: invoking a deprecated tool returns REJECTED and emits TOOL_DEPRECATED_REJECTED', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deprecation-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function makeEventStore() {
    const recorded: Array<{ name: string; data: Record<string, unknown> }> = [];
    return {
      record: vi.fn(async (name: string, data: Record<string, unknown>) => {
        recorded.push({ name, data });
      }),
      recorded
    };
  }

  function makePathFactory(tempDir: string) {
    return {
      allocate: vi.fn((_ctx: unknown) => ({
        outputDir: tempDir,
        outputFile: path.join(tempDir, 'result.json')
      }))
    } as any;
  }

  function makeCtx() {
    return { hasUI: false } as any;
  }

  function makeBackpressure() {
    return {
      acquire: vi.fn(async () => ({ acquired: true, key: 'k' })),
      release: vi.fn()
    } as any;
  }

  it('returns a REJECTED result immediately for a deprecated tool without running the command', async () => {
    const eventStore = makeEventStore();
    const pathFactory = makePathFactory(tempDir);
    const ctx = makeCtx();
    const backpressure = makeBackpressure();

    const definition: ProjectCommandToolConfig & { deprecated: boolean; replacedBy: string[]; deprecationReason: string } = {
      name: 'artifact_validator',
      type: ProjectToolType.COMMAND,
      command: 'echo',
      deprecated: true,
      replacedBy: ['requirements_schema', 'plan_contract'],
      deprecationReason: 'Replaced by project-owned validators.'
    };

    const result = await executeConfiguredProjectTool(
      eventStore as any,
      pathFactory,
      definition as any,
      { beadId: 'bead-1', stateId: 'state-1', actionId: 'action-1' },
      ctx,
      undefined,
      backpressure,
      tempDir
    );

    const resultRecord = result as Record<string, unknown>;
    expect(resultRecord.status).toBe(ToolResultStatus.REJECTED);
    expect(typeof resultRecord.message).toBe('string');
    const msg = resultRecord.message as string;
    expect(msg).toContain('artifact_validator');
    expect(msg).toContain('deprecated');
    // Should name the replacements in the rejection message
    expect(msg).toContain('requirements_schema');
    expect(msg).toContain('plan_contract');
  });

  it('emits TOOL_DEPRECATED_REJECTED event with tool name and replacements', async () => {
    const eventStore = makeEventStore();
    const pathFactory = makePathFactory(tempDir);
    const ctx = makeCtx();
    const backpressure = makeBackpressure();

    const definition = {
      name: 'artifact_validator',
      type: ProjectToolType.COMMAND,
      command: 'echo',
      deprecated: true,
      replacedBy: ['requirements_schema'],
      deprecationReason: 'Use project-owned validators.'
    };

    await executeConfiguredProjectTool(
      eventStore as any,
      pathFactory,
      definition as any,
      { beadId: 'bead-1', stateId: 'state-1', actionId: 'action-1' },
      ctx,
      undefined,
      backpressure,
      tempDir
    );

    const deprecatedEvent = eventStore.recorded.find(e => e.name === DomainEventName.TOOL_DEPRECATED_REJECTED);
    expect(deprecatedEvent).toBeDefined();
    expect(deprecatedEvent!.data.tool).toBe('artifact_validator');
    expect(deprecatedEvent!.data.replacedBy).toEqual(['requirements_schema']);
    expect(deprecatedEvent!.data.reason).toBe('Use project-owned validators.');
  });

  it('emits TOOL_DEPRECATED_REJECTED even when no replacements are listed', async () => {
    const eventStore = makeEventStore();
    const pathFactory = makePathFactory(tempDir);
    const ctx = makeCtx();
    const backpressure = makeBackpressure();

    const definition = {
      name: 'old_validator',
      type: ProjectToolType.COMMAND,
      command: 'echo',
      deprecated: true
    };

    const result = await executeConfiguredProjectTool(
      eventStore as any,
      pathFactory,
      definition as any,
      {},
      ctx,
      undefined,
      backpressure,
      tempDir
    );

    const resultRecord = result as Record<string, unknown>;
    expect(resultRecord.status).toBe(ToolResultStatus.REJECTED);
    const deprecatedEvent = eventStore.recorded.find(e => e.name === DomainEventName.TOOL_DEPRECATED_REJECTED);
    expect(deprecatedEvent).toBeDefined();
    expect(deprecatedEvent!.data.replacedBy).toBeUndefined();
  });

  it('does not reject a non-deprecated tool via the deprecation guard', async () => {
    // Verify a normal (non-deprecated) tool flows through normally.
    // We'll check that no TOOL_DEPRECATED_REJECTED event is emitted.
    const eventStore = makeEventStore();
    const pathFactory = makePathFactory(tempDir);
    const ctx = makeCtx();
    const backpressure = makeBackpressure();

    const definition: ProjectCommandToolConfig = {
      name: 'requirements_schema',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', 'process.stdout.write(JSON.stringify({status:"PASSED"}))']
    };

    await executeConfiguredProjectTool(
      eventStore as any,
      pathFactory,
      definition,
      {},
      ctx,
      undefined,
      backpressure,
      tempDir
    ).catch(() => {/* ignore execution errors - we only care that the deprecation guard didn't fire */});

    const deprecatedEvent = eventStore.recorded.find(e => e.name === DomainEventName.TOOL_DEPRECATED_REJECTED);
    expect(deprecatedEvent).toBeUndefined();
  });
});

// ── AC4: config validation fails for deprecated requiredTool without allowDeprecated ─

describe('AC4: config validation rejects deprecated requiredTool without allowDeprecated', () => {
  let tempDir: string;
  let configLoader: ConfigLoader;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deprecation-cfg-'));
    configLoader = new ConfigLoader(undefined, tempDir);
    // Write a minimal schema to satisfy ConfigLoader (it skips validation if no schema)
    // We rely on the semantic-only post-schema check
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function writeConfig(yaml: string): string {
    const p = path.join(tempDir, 'harness.yaml');
    fs.writeFileSync(p, yaml);
    return p;
  }

  it('throws when a state requiredTools references a deprecated+hidden tool without allowDeprecated', () => {
    const p = writeConfig(`
settings:
  startState: Implement
  eventStore:
    enabled: true
states:
  Implement:
    identity: { role: "Dev", expertise: "Dev", constraints: [] }
    baseInstructions: "Build"
    requiredTools:
      - name: artifact_validator
    actions: []
    transitions: { SUCCESS: completed, FAILURE: Implement }
tools:
  - name: artifact_validator
    type: command
    command: echo
    deprecated: true
    hidden: true
    replacedBy:
      - requirements_schema
`);
    expect(() => configLoader.load(p)).toThrow(/deprecated/);
    expect(() => configLoader.load(p)).toThrow(/artifact_validator/);
  });

  it('throws when an action requiredTools references a deprecated+hidden tool without allowDeprecated', () => {
    const p = writeConfig(`
settings:
  startState: Implement
  eventStore:
    enabled: true
states:
  Implement:
    identity: { role: "Dev", expertise: "Dev", constraints: [] }
    baseInstructions: "Build"
    actions:
      - id: validate
        type: tool
        tool: artifact_validator
        requiredTools:
          - name: artifact_validator
    transitions: { SUCCESS: completed, FAILURE: Implement }
tools:
  - name: artifact_validator
    type: command
    command: echo
    deprecated: true
    hidden: true
`);
    expect(() => configLoader.load(p)).toThrow(/deprecated/);
    expect(() => configLoader.load(p)).toThrow(/artifact_validator/);
  });

  it('does NOT throw when a deprecated+hidden tool is referenced with allowDeprecated:true', () => {
    const p = writeConfig(`
settings:
  startState: Implement
  eventStore:
    enabled: true
states:
  Implement:
    identity: { role: "Dev", expertise: "Dev", constraints: [] }
    baseInstructions: "Build"
    requiredTools:
      - name: artifact_validator
        allowDeprecated: true
    actions: []
    transitions: { SUCCESS: completed, FAILURE: Implement }
tools:
  - name: artifact_validator
    type: command
    command: echo
    deprecated: true
    hidden: true
    replacedBy:
      - requirements_schema
`);
    expect(() => configLoader.load(p)).not.toThrow();
  });

  it('does NOT throw when requiredTools references a deprecated-but-not-hidden tool (visible, just deprecated)', () => {
    // Only hidden+deprecated should be a hard failure; deprecated-only is a warning.
    const p = writeConfig(`
settings:
  startState: Implement
  eventStore:
    enabled: true
states:
  Implement:
    identity: { role: "Dev", expertise: "Dev", constraints: [] }
    baseInstructions: "Build"
    requiredTools:
      - name: artifact_validator
    actions: []
    transitions: { SUCCESS: completed, FAILURE: Implement }
tools:
  - name: artifact_validator
    type: command
    command: echo
    deprecated: true
`);
    // deprecated-but-NOT-hidden: config validation should not fail
    expect(() => configLoader.load(p)).not.toThrow();
  });
});

// ── AC5: Illustrative cerdiwen-style config shape ────────────────────────────

describe('AC5: illustrative config shape for cerdiwen migration', () => {
  it('config shape correctly represents artifact_validator deprecation with replacements', () => {
    // This test documents the YAML config shape that cerdiwen would use.
    // It does NOT edit cerdiwen — it only proves the config types support it.
    const config = minimalConfig([
      {
        name: 'artifact_validator',
        description: 'DEPRECATED: use requirements_schema and plan_contract instead.',
        type: ProjectToolType.COMMAND,
        command: 'echo',
        deprecated: true,
        hidden: true,
        replacedBy: ['requirements_schema', 'plan_contract'],
        deprecationReason: 'Monolithic validator replaced by project-owned tools (pi-experiment-87fm).'
      } as any,
      {
        name: 'requirements_schema',
        description: 'Validates requirements schema.',
        type: ProjectToolType.COMMAND,
        command: 'node'
      },
      {
        name: 'plan_contract',
        description: 'Validates plan contract.',
        type: ProjectToolType.COMMAND,
        command: 'node'
      }
    ]);

    // artifact_validator is hidden from model guidance
    const guidance = describeConfiguredProjectTools(config);
    expect(guidance).not.toContain('artifact_validator');
    // Replacements are visible
    expect(guidance).toContain('requirements_schema');
    expect(guidance).toContain('plan_contract');

    // Config round-trips the deprecation metadata correctly
    const deprecated = config.tools!.find(t => t.name === 'artifact_validator') as any;
    expect(deprecated.deprecated).toBe(true);
    expect(deprecated.hidden).toBe(true);
    expect(deprecated.replacedBy).toEqual(['requirements_schema', 'plan_contract']);
  });
});
