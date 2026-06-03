import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConfigLoader, resolveProviderName } from '../src/core/ConfigLoader.js';
import * as fs from 'fs';
import * as path from 'path';

describe('ConfigLoader Detailed', () => {
  const tempConfigPath = path.join(process.cwd(), 'temp_harness.yaml');
  const tempPromptPath = path.join(process.cwd(), 'temp_prompt.md');
  const tempHarnessRestartPath = path.join(process.cwd(), 'temp_harness_restart.md');
  const tempContextRestartPath = path.join(process.cwd(), 'temp_context_restart.md');

  let configLoader: ConfigLoader;

  beforeEach(() => {
    configLoader = new ConfigLoader();
  });

  afterEach(() => {
    if (fs.existsSync(tempConfigPath)) fs.unlinkSync(tempConfigPath);
    if (fs.existsSync(tempPromptPath)) fs.unlinkSync(tempPromptPath);
    if (fs.existsSync(tempHarnessRestartPath)) fs.unlinkSync(tempHarnessRestartPath);
    if (fs.existsSync(tempContextRestartPath)) fs.unlinkSync(tempContextRestartPath);
  });

  it('should resolve prompt from file path', () => {
    fs.writeFileSync(tempPromptPath, '# Test Prompt Content');
    
    const configContent = `
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test"
  defaultModel: "m1"
  startState: TestPhase
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states:
  TestPhase:
    identity: { role: "R1", expertise: "E1", constraints: [] }
    baseInstructions: "Test"
    actions:
      - id: a1
        type: prompt
        prompt: "temp_prompt.md"
    transitions: { SUCCESS: "done", FAILURE: "failed" }
`;
    fs.writeFileSync(tempConfigPath, configContent);

    const config = configLoader.load(tempConfigPath);
    expect(config.states['TestPhase'].actions[0].prompt).toBe('# Test Prompt Content');
  });

  it('should resolve separate harness and context restart prompts from files', () => {
    fs.writeFileSync(tempHarnessRestartPath, '# Harness Restart');
    fs.writeFileSync(tempContextRestartPath, '# Context Restart');

    const configContent = `
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test"
  defaultModel: "m1"
  startState: TestPhase
  harnessRestartPrompt: "temp_harness_restart.md"
  contextRestartPrompt: "temp_context_restart.md"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states:
  TestPhase:
    identity: { role: "R1", expertise: "E1", constraints: [] }
    baseInstructions: "Test"
    contextRestartPrompt: "temp_context_restart.md"
    actions:
      - id: a1
        type: prompt
        prompt: "Inline"
    transitions: { SUCCESS: "done", FAILURE: "failed" }
`;
    fs.writeFileSync(tempConfigPath, configContent);

    const config = configLoader.load(tempConfigPath);
    expect(config.settings.harnessRestartPrompt).toBe('# Harness Restart');
    expect(config.settings.contextRestartPrompt).toBe('# Context Restart');
    expect(config.states['TestPhase'].contextRestartPrompt).toBe('# Context Restart');

    fs.unlinkSync(tempHarnessRestartPath);
    fs.unlinkSync(tempContextRestartPath);
  });

  it('should throw error on invalid schema', () => {
    // Missing required fields
    const invalidConfig = `
settings:
  maxConcurrentSlots: "invalid_type"
`;
    fs.writeFileSync(tempConfigPath, invalidConfig);

    expect(() => configLoader.load(tempConfigPath)).toThrow(/validation failed/);
  });

  it('should behave as a singleton until reset', () => {
    const configContent = `
settings:
  maxConcurrentSlots: 5
  handoverTemplate: "test"
  startState: Planning
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states: {}
`;
    fs.writeFileSync(tempConfigPath, configContent);

    const config1 = configLoader.load(tempConfigPath);
    const config2 = configLoader.load(tempConfigPath);

    expect(config1).toBe(config2);

    configLoader.reset();
    const config3 = configLoader.load(tempConfigPath);
    expect(config3).not.toBe(config1);
  });

  it('should reload cached config when the config file changes', () => {
    const firstConfig = `
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "first"
  startState: Planning
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states: {}
`;
    const secondConfig = `
settings:
  maxConcurrentSlots: 4
  handoverTemplate: "second"
  startState: Planning
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states: {}
`;
    fs.writeFileSync(tempConfigPath, firstConfig);

    const config1 = configLoader.load(tempConfigPath);
    fs.writeFileSync(tempConfigPath, secondConfig);
    const later = new Date(Date.now() + 2000);
    fs.utimesSync(tempConfigPath, later, later);
    const config2 = configLoader.load(tempConfigPath);

    expect(config2).not.toBe(config1);
    expect(config2.settings.maxConcurrentSlots).toBe(4);
    expect(config2.settings.handoverTemplate).toBe('second');
  });

  it('should accept wrapper timeout settings on command project tools', () => {
    const configContent = `
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test"
  startState: Planning
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
tools:
  - name: bounded_tool
    type: command
    command: node
    timeoutMs: 120000
    wrapperTimeoutMs: 600000
states: {}
`;
    fs.writeFileSync(tempConfigPath, configContent);

    const config = configLoader.load(tempConfigPath);
    expect(config.tools?.[0].wrapperTimeoutMs).toBe(600000);
  });

  it('should accept timeout settings on mcp project tools', () => {
    const configContent = `
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test"
  startState: Planning
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
tools:
  - name: python_lsp
    type: mcp
    server: python-lsp
    timeoutMs: 180000
    wrapperTimeoutMs: 600000
states: {}
`;
    fs.writeFileSync(tempConfigPath, configContent);

    const config = configLoader.load(tempConfigPath);
    expect(config.tools?.[0].timeoutMs).toBe(180000);
    expect(config.tools?.[0].wrapperTimeoutMs).toBe(600000);
  });

  it('should accept framework and workspace path scopes on project tools', () => {
    const configContent = `
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test"
  startState: Planning
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
tools:
  - name: framework_scan
    type: command
    command: node
    argumentPathScope:
      rootKind: framework
      workspaceRoot: /tmp/framework
      virtualRoots: [/workspace/framework]
      positionals: true
  - name: framework_lsp
    type: mcp
    server: framework-lsp
    pathArguments:
      diagnostics:
        filePath:
          rootKind: workspace
          workspaceRoot: /tmp/framework
states: {}
`;
    fs.writeFileSync(tempConfigPath, configContent);

    const config = configLoader.load(tempConfigPath);
    expect(config.tools?.[0].argumentPathScope?.rootKind).toBe('framework');
    expect(config.tools?.[0].argumentPathScope?.workspaceRoot).toBe('/tmp/framework');
    expect(config.tools?.[1].pathArguments?.diagnostics?.filePath?.rootKind).toBe('workspace');
    expect(config.tools?.[1].pathArguments?.diagnostics?.filePath?.workspaceRoot).toBe('/tmp/framework');
  });

  it('should use an explicitly configured harness path for subsequent loads', () => {
    const configContent = `
settings:
  maxConcurrentSlots: 3
  handoverTemplate: "configured"
  startState: Planning
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states: {}
`;
    fs.writeFileSync(tempConfigPath, configContent);

    configLoader.setConfigPath(tempConfigPath);
    const config = configLoader.load();

    expect(config.settings.maxConcurrentSlots).toBe(3);
    expect(configLoader.getConfigPath()).toBe(tempConfigPath);
  });

  it('should resolve state-specific LLM provider configuration', () => {
    const configContent = `
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test"
  startState: Review
  defaultProvider: claude
  defaultModel: "claude-default"
  modelProviders:
    claude: { provider: "anthropic", model: "claude-default", thinking: "high" }
    openai: { provider: "openai", model: "gpt-default", thinking: "medium" }
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states:
  Review:
    llmProvider: openai
    model: "gpt-review"
    thinking: "xhigh"
    identity: { role: "Reviewer", expertise: "Review", constraints: [] }
    baseInstructions: "Review"
    actions: []
    transitions: { SUCCESS: "completed", FAILURE: "Review" }
`;
    fs.writeFileSync(tempConfigPath, configContent);

    const config = configLoader.load(tempConfigPath);
    const llm = configLoader.resolveLLMConfig('Review', config);

    expect(llm).toEqual({
      providerKey: 'openai',
      provider: 'openai',
      model: 'gpt-review',
      thinking: 'xhigh'
    });
  });

  it('should route a claude provider string to the anthropic subscription provider', () => {
    const configContent = `
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test"
  startState: Plan
  defaultProvider: claude
  defaultModel: "claude-opus-4-5"
  modelProviders:
    claude: { provider: "claude", model: "claude-opus-4-5", thinking: "high" }
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states:
  Plan:
    llmProvider: claude
    identity: { role: "Planner", expertise: "Plan", constraints: [] }
    baseInstructions: "Plan"
    actions: []
    transitions: { SUCCESS: "completed", FAILURE: "Plan" }
`;
    fs.writeFileSync(tempConfigPath, configContent);

    const config = configLoader.load(tempConfigPath);
    const llm = configLoader.resolveLLMConfig('Plan', config);

    expect(llm).toEqual({
      providerKey: 'claude',
      provider: 'anthropic',
      model: 'claude-opus-4-5',
      thinking: 'high'
    });
  });

  it('should route a codex provider string to the openai-codex subscription provider', () => {
    const configContent = `
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test"
  startState: Plan
  defaultProvider: codex
  defaultModel: "gpt-5.5"
  modelProviders:
    codex: { provider: "codex", model: "gpt-5.5", thinking: "xhigh" }
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states:
  Plan:
    llmProvider: codex
    identity: { role: "Planner", expertise: "Plan", constraints: [] }
    baseInstructions: "Plan"
    actions: []
    transitions: { SUCCESS: "completed", FAILURE: "Plan" }
`;
    fs.writeFileSync(tempConfigPath, configContent);

    const config = configLoader.load(tempConfigPath);
    const llm = configLoader.resolveLLMConfig('Plan', config);

    expect(llm).toEqual({
      providerKey: 'codex',
      provider: 'openai-codex',
      model: 'gpt-5.5',
      thinking: 'xhigh'
    });
  });
});

describe('ConfigLoader coarse-sink transition targets', () => {
  const tempConfigPath = path.join(process.cwd(), 'temp_coarse_sink_test.yaml');

  afterEach(() => {
    if (fs.existsSync(tempConfigPath)) fs.unlinkSync(tempConfigPath);
  });

  it('loads a statechart config with a transition target of "blocked" without throwing', () => {
    const configContent = `
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test"
  defaultModel: "m1"
  startState: Alpha
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [EXTERNAL_BLOCKER]
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states:
  Alpha:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions: []
    transitions:
      SUCCESS: completed
      FAILURE: Alpha
      EXTERNAL_BLOCKER: blocked
`;
    fs.writeFileSync(tempConfigPath, configContent);
    expect(() => new ConfigLoader().load(tempConfigPath)).not.toThrow();
    const cfg = new ConfigLoader().load(tempConfigPath);
    expect(cfg.states['Alpha'].transitions['EXTERNAL_BLOCKER']).toBe('blocked');
  });

  it('loads a statechart config with a transition target of "deferred" without throwing', () => {
    const configContent = `
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test"
  defaultModel: "m1"
  startState: Alpha
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [EXTERNAL_BLOCKER]
  customOutcomes: [DEFER]
scheduler:
  weights: { waitTime: 1, executionSize: 1, progress: 1, penalty: 1 }
states:
  Alpha:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions: []
    transitions:
      SUCCESS: completed
      FAILURE: Alpha
      DEFER: deferred
`;
    fs.writeFileSync(tempConfigPath, configContent);
    expect(() => new ConfigLoader().load(tempConfigPath)).not.toThrow();
    const cfg = new ConfigLoader().load(tempConfigPath);
    expect(cfg.states['Alpha'].transitions['DEFER']).toBe('deferred');
  });

  it('still throws when a transition target is genuinely unknown (not a state, terminal, or coarse sink)', () => {
    const configContent = `
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test"
  defaultModel: "m1"
  startState: Alpha
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [EXTERNAL_BLOCKER]
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states:
  Alpha:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions: []
    transitions:
      SUCCESS: totally_unknown_state
      FAILURE: Alpha
`;
    fs.writeFileSync(tempConfigPath, configContent);
    expect(() => new ConfigLoader().load(tempConfigPath)).toThrow(/not a defined state, declared terminal state, or recognized coarse sink status/);
  });

  it('GOLDEN (cerdiwen-style): AdversarialPostReview --EXTERNAL_BLOCKER--> blocked loads without throwing', () => {
    const configContent = `
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test"
  defaultModel: "m1"
  startState: Planning
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [EXTERNAL_BLOCKER]
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states:
  Planning:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions: []
    transitions:
      SUCCESS: Implementation
      FAILURE: Planning
  Implementation:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions: []
    transitions:
      SUCCESS: AdversarialPostReview
      FAILURE: Implementation
  AdversarialPostReview:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions: []
    transitions:
      SUCCESS: completed
      FAILURE: Implementation
      EXTERNAL_BLOCKER: blocked
`;
    fs.writeFileSync(tempConfigPath, configContent);
    expect(() => new ConfigLoader().load(tempConfigPath)).not.toThrow();
    const cfg = new ConfigLoader().load(tempConfigPath);
    // The EXTERNAL_BLOCKER transition routes to the coarse sink 'blocked'
    expect(cfg.states['AdversarialPostReview'].transitions['EXTERNAL_BLOCKER']).toBe('blocked');
    // blockedOutcomes includes EXTERNAL_BLOCKER → outcomeCategory would return 'blocked'
    // → shouldPersistBlockedBeadStatus would set BLOCKED coarse status
    expect(cfg.statechart?.blockedOutcomes).toContain('EXTERNAL_BLOCKER');
  });
});

describe('resolveProviderName', () => {
  it('routes a string containing "codex" to the openai-codex subscription provider', () => {
    expect(resolveProviderName('codex')).toBe('openai-codex');
    expect(resolveProviderName('Codex')).toBe('openai-codex');
    expect(resolveProviderName('openai-codex')).toBe('openai-codex');
  });

  it('routes a string containing "claude" to the anthropic subscription provider', () => {
    expect(resolveProviderName('claude')).toBe('anthropic');
    expect(resolveProviderName('CLAUDE')).toBe('anthropic');
    expect(resolveProviderName('claude-code')).toBe('anthropic');
  });

  it('passes explicit api-key provider names through unchanged', () => {
    expect(resolveProviderName('openai')).toBe('openai');
    expect(resolveProviderName('anthropic')).toBe('anthropic');
    expect(resolveProviderName('google')).toBe('google');
  });
});

// ---------------------------------------------------------------------------
// s3wp.24: inlineResultBytes deprecation-warning path
// ---------------------------------------------------------------------------
describe('s3wp.24 inlineResultBytes deprecation-warning migration', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'orr-else-s3wp24-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempRoot)) fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('logs a deprecation warning and strips inlineResultBytes so the config still loads', async () => {
    // Write a harness.yaml that declares inlineResultBytes on a command tool.
    // The field was removed in s3wp.24; the ConfigLoader must emit a deprecation
    // warning (IGNORE-WITH-DEPRECATION-WARNING policy) and strip it so AJV schema
    // validation does not fail.
    const harnessYaml = `
settings:
  startState: Planning
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    actions: []
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
tools:
  - name: run_tests
    type: command
    command: pytest
    inlineResultBytes: 1000
  - name: codemap
    type: command
    command: codemap
    inlineResultBytes: 2048
`;
    const configPath = path.join(tempRoot, 'harness.yaml');
    fs.writeFileSync(configPath, harnessYaml);

    // Spy on Logger.warn to capture deprecation messages
    const { Logger } = await import('../src/core/Logger.js');
    const warnSpy = vi.spyOn(Logger, 'warn');

    const loader = new ConfigLoader(undefined, tempRoot);
    // Load must succeed (no exception thrown — IGNORE-WITH-DEPRECATION-WARNING)
    let config: ReturnType<typeof loader.load> | undefined;
    expect(() => { config = loader.load(configPath); }).not.toThrow();
    expect(config).toBeDefined();

    // At least one deprecation warning must have been emitted naming 'inlineResultBytes'
    const warnCalls = warnSpy.mock.calls;
    const deprecationWarnings = warnCalls.filter(call =>
      String(call[1] ?? '').includes('inlineResultBytes')
    );
    expect(deprecationWarnings.length).toBeGreaterThanOrEqual(2); // one per tool

    // The field must be stripped so it does not appear on the loaded tool configs
    const toolConfigs = (config as any).tools as any[];
    for (const tool of toolConfigs) {
      expect(tool.inlineResultBytes).toBeUndefined();
    }

    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// s3wp.2: tool defaults and profiles
// ---------------------------------------------------------------------------
describe('s3wp.2 tool defaults and profiles', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'orr-else-s3wp2-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempRoot)) fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function writeConfig(yaml: string): string {
    const p = path.join(tempRoot, 'harness.yaml');
    fs.writeFileSync(p, yaml);
    return p;
  }

  it('toolDefaults are applied to all command tools when the tool field is absent', () => {
    const configPath = writeConfig(`
settings:
  startState: Planning
  toolDefaults:
    argsMode: append
    timeoutMs: 30000
    env:
      BASE_VAR: "from-defaults"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states: {}
tools:
  - name: tool_a
    type: command
    command: node
  - name: tool_b
    type: command
    command: python
`);
    const config = new ConfigLoader(undefined, tempRoot).load(configPath);
    const toolA = config.tools?.find(t => t.name === 'tool_a') as any;
    const toolB = config.tools?.find(t => t.name === 'tool_b') as any;

    expect(toolA.argsMode).toBe('append');
    expect(toolA.timeoutMs).toBe(30000);
    expect(toolA.env?.BASE_VAR).toBe('from-defaults');
    expect(toolB.argsMode).toBe('append');
    expect(toolB.timeoutMs).toBe(30000);
  });

  it('per-tool fields win over toolDefaults', () => {
    const configPath = writeConfig(`
settings:
  startState: Planning
  toolDefaults:
    argsMode: replace
    timeoutMs: 10000
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states: {}
tools:
  - name: tool_a
    type: command
    command: node
    argsMode: append
    timeoutMs: 99000
`);
    const config = new ConfigLoader(undefined, tempRoot).load(configPath);
    const toolA = config.tools?.find(t => t.name === 'tool_a') as any;
    // Per-tool wins
    expect(toolA.argsMode).toBe('append');
    expect(toolA.timeoutMs).toBe(99000);
  });

  it('named profile is applied between toolDefaults and per-tool fields', () => {
    const configPath = writeConfig(`
settings:
  startState: Planning
  toolDefaults:
    argsMode: replace
    timeoutMs: 10000
    env:
      BASE: "default"
  toolProfiles:
    nodeTs:
      argsMode: append
      timeoutMs: 60000
      env:
        BASE: "profile"
        EXTRA: "profile-extra"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states: {}
tools:
  - name: ts_tool
    type: command
    command: node
    profile: nodeTs
    env:
      BASE: "tool"
`);
    const config = new ConfigLoader(undefined, tempRoot).load(configPath);
    const tool = config.tools?.find(t => t.name === 'ts_tool') as any;
    // Profile wins over defaults for argsMode and timeoutMs
    expect(tool.argsMode).toBe('append');
    expect(tool.timeoutMs).toBe(60000);
    // env merge: default BASE="default", profile BASE="profile" EXTRA="profile-extra",
    // per-tool BASE="tool" → final BASE="tool", EXTRA="profile-extra"
    expect(tool.env.BASE).toBe('tool');
    expect(tool.env.EXTRA).toBe('profile-extra');
  });

  it('toolDefaults do not affect mcp tools', () => {
    const configPath = writeConfig(`
settings:
  startState: Planning
  toolDefaults:
    argsMode: append
    timeoutMs: 30000
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states: {}
tools:
  - name: mcp_tool
    type: mcp
    server: my-server
`);
    const config = new ConfigLoader(undefined, tempRoot).load(configPath);
    const mcpTool = config.tools?.find(t => t.name === 'mcp_tool') as any;
    // mcp tools must not receive command-tool defaults
    expect(mcpTool.argsMode).toBeUndefined();
    // mcp has its own timeoutMs field — toolDefaults must not set it
    expect(mcpTool.timeoutMs).toBeUndefined();
  });

  it('warning is logged for unknown profile reference, tool still loads', async () => {
    const configPath = writeConfig(`
settings:
  startState: Planning
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states: {}
tools:
  - name: ts_tool
    type: command
    command: node
    profile: nonExistentProfile
`);
    const { Logger } = await import('../src/core/Logger.js');
    const warnSpy = vi.spyOn(Logger, 'warn');

    const config = new ConfigLoader(undefined, tempRoot).load(configPath);
    expect(config.tools?.length).toBe(1);

    const warnCalls = warnSpy.mock.calls;
    const profileWarnings = warnCalls.filter(call =>
      String(call[1] ?? '').includes('nonExistentProfile')
    );
    expect(profileWarnings.length).toBeGreaterThanOrEqual(1);
    warnSpy.mockRestore();
  });

  it('toolDefaults.failureLimit is merged shallowly with per-tool failureLimit', () => {
    const configPath = writeConfig(`
settings:
  startState: Planning
  toolDefaults:
    failureLimit:
      maxFailuresPerState: 3
      terminal: false
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states: {}
tools:
  - name: ts_tool
    type: command
    command: node
    failureLimit:
      maxFailuresPerState: 5
`);
    const config = new ConfigLoader(undefined, tempRoot).load(configPath);
    const tool = config.tools?.find(t => t.name === 'ts_tool') as any;
    // Per-tool maxFailuresPerState wins; terminal from defaults is not overridden
    expect(tool.failureLimit.maxFailuresPerState).toBe(5);
    expect(tool.failureLimit.terminal).toBe(false);
  });

  it('existing configs without toolDefaults/toolProfiles are unaffected', () => {
    const configPath = writeConfig(`
settings:
  startState: Planning
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states: {}
tools:
  - name: plain_tool
    type: command
    command: node
    argsMode: replace
    timeoutMs: 5000
`);
    const config = new ConfigLoader(undefined, tempRoot).load(configPath);
    const tool = config.tools?.find(t => t.name === 'plain_tool') as any;
    expect(tool.argsMode).toBe('replace');
    expect(tool.timeoutMs).toBe(5000);
  });
});
