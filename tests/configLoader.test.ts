import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConfigLoader, resolveProviderName } from '../src/core/ConfigLoader.js';
import { getPackagedSchemaPath } from '../src/core/SchemaRegistry.js';
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
  worktreePolicy:
    default: always
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
  worktreePolicy:
    default: always
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
  worktreePolicy:
    default: always
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
  worktreePolicy:
    default: always
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states: {}
`;
    const secondConfig = `
settings:
  maxConcurrentSlots: 4
  handoverTemplate: "second"
  startState: Planning
  worktreePolicy:
    default: always
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
  worktreePolicy:
    default: always
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
  worktreePolicy:
    default: always
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
tools:
  - name: fixture_mcp_tool
    type: mcp
    server: fixture-mcp-server
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
  worktreePolicy:
    default: always
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
  worktreePolicy:
    default: always
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
  worktreePolicy:
    default: always
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
  worktreePolicy:
    default: always
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
  worktreePolicy:
    default: always
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
  worktreePolicy:
    default: always
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
    actions:
      - id: a1
        type: prompt
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
  worktreePolicy:
    default: always
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
    actions:
      - id: a1
        type: prompt
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
  worktreePolicy:
    default: always
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
    actions:
      - id: a1
        type: prompt
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
  worktreePolicy:
    default: always
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
    actions:
      - id: a1
        type: prompt
    transitions:
      SUCCESS: Implementation
      FAILURE: Planning
  Implementation:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      - id: a1
        type: prompt
    transitions:
      SUCCESS: AdversarialPostReview
      FAILURE: Implementation
  AdversarialPostReview:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      - id: a1
        type: prompt
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
// qkjm: removed output-cap knobs HARD-REJECT (no warn-and-strip shim)
// ---------------------------------------------------------------------------
describe('qkjm removed output-cap knobs hard-reject at config validation', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'orr-else-qkjm-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempRoot)) fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('throws (does NOT warn-and-strip) when a tool declares the removed inlineResultBytes knob', () => {
    // inlineResultBytes was removed in s3wp.24. The former IGNORE-WITH-DEPRECATION-WARNING
    // shim was deleted in qkjm (v0.1, no users): the field is now an unknown property and
    // AJV schema validation (tools have additionalProperties:false) must HARD-REJECT it.
    const harnessYaml = `
settings:
  startState: Planning
  worktreePolicy:
    default: always
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
`;
    const configPath = path.join(tempRoot, 'harness.yaml');
    fs.writeFileSync(configPath, harnessYaml);

    const loader = new ConfigLoader(undefined, tempRoot);
    expect(() => loader.load(configPath)).toThrow(/Configuration validation failed/);
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
  worktreePolicy:
    default: always
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
  worktreePolicy:
    default: always
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
  worktreePolicy:
    default: always
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
  worktreePolicy:
    default: always
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

  // s4qi: undefined profile reference is STARTUP-FATAL (not warn-and-ignore)
  it('AC1: throws a startup-fatal error when a command tool references an undefined profile', () => {
    const configPath = writeConfig(`
settings:
  startState: Planning
  worktreePolicy:
    default: always
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states: {}
tools:
  - name: ts_tool
    type: command
    command: node
    profile: nonExistentProfile
`);
    let caught: Error | undefined;
    try {
      new ConfigLoader(undefined, tempRoot).load(configPath);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught, 'expected load() to throw on missing profile').toBeDefined();
    // AC1: error must name the tool
    expect(caught!.message).toMatch(/ts_tool/);
    // AC1: error must name the missing profile
    expect(caught!.message).toMatch(/nonExistentProfile/);
    // AC1: error must list available profiles (none declared → shows empty indicator)
    expect(caught!.message).toMatch(/available profiles/i);
  });

  // AC1: error diagnostic when toolProfiles is defined but the referenced name is absent
  it('AC1: names the tool, missing profile, and available profiles when some profiles are defined', () => {
    const configPath = writeConfig(`
settings:
  startState: Planning
  toolProfiles:
    profileA:
      timeoutMs: 30000
    profileB:
      timeoutMs: 60000
  worktreePolicy:
    default: always
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states: {}
tools:
  - name: bad_tool
    type: command
    command: node
    profile: missingProfile
`);
    let caught: Error | undefined;
    try {
      new ConfigLoader(undefined, tempRoot).load(configPath);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/bad_tool/);
    expect(caught!.message).toMatch(/missingProfile/);
    // Available profiles listed
    expect(caught!.message).toMatch(/profileA/);
    expect(caught!.message).toMatch(/profileB/);
  });

  // AC2: no profile reference → loads fine (no false positive)
  it('AC2: command tool without a profile reference loads without error', () => {
    const configPath = writeConfig(`
settings:
  startState: Planning
  worktreePolicy:
    default: always
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states: {}
tools:
  - name: no_profile_tool
    type: command
    command: node
`);
    expect(() => new ConfigLoader(undefined, tempRoot).load(configPath)).not.toThrow();
  });

  it('toolDefaults.failureLimit is merged shallowly with per-tool failureLimit', () => {
    const configPath = writeConfig(`
settings:
  startState: Planning
  toolDefaults:
    failureLimit:
      maxFailuresPerState: 3
      terminal: false
  worktreePolicy:
    default: always
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
  worktreePolicy:
    default: always
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

// ---------------------------------------------------------------------------
// s3wp.10: generic TypeScript project-tool defaults
// ---------------------------------------------------------------------------
describe('s3wp.10 tsProjectTool shorthand expansion', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'orr-else-s3wp10-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempRoot)) fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function writeConfig(yaml: string): string {
    const p = path.join(tempRoot, 'harness.yaml');
    fs.writeFileSync(p, yaml);
    return p;
  }

  it('tsProjectTool expands to type: command with node, --experimental-strip-types, and default script path', () => {
    const configPath = writeConfig(`
settings:
  startState: Planning
  worktreePolicy:
    default: always
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states: {}
tools:
  - name: run_checks
    type: tsProjectTool
    description: Run project checks
`);
    const config = new ConfigLoader(undefined, tempRoot).load(configPath);
    const tool = config.tools?.find(t => t.name === 'run_checks') as any;

    expect(tool.type).toBe('command');
    expect(tool.command).toBe('node');
    expect(tool.defaultArgs[0]).toBe('--experimental-strip-types');
    // Default script path: <projectRoot>/.pi/project-tools/run_checks.ts
    expect(tool.defaultArgs[1]).toContain('run_checks.ts');
    expect(tool.defaultArgs[1]).toContain('.pi/project-tools');
    expect(tool.argsMode).toBe('append');
    expect(tool.allowArgs).toBe(true);
    expect(tool.description).toBe('Run project checks');
  });

  it('tsProjectTool uses explicit scriptPath when provided', () => {
    const configPath = writeConfig(`
settings:
  startState: Planning
  worktreePolicy:
    default: always
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states: {}
tools:
  - name: custom_tool
    type: tsProjectTool
    scriptPath: scripts/my-tool.ts
`);
    const config = new ConfigLoader(undefined, tempRoot).load(configPath);
    const tool = config.tools?.find(t => t.name === 'custom_tool') as any;

    expect(tool.type).toBe('command');
    expect(tool.defaultArgs[1]).toContain('my-tool.ts');
  });

  it('tsProjectTool uses settings.tsProjectToolDefaults.scriptDir for default path', () => {
    const configPath = writeConfig(`
settings:
  startState: Planning
  tsProjectToolDefaults:
    scriptDir: src/scripts
  worktreePolicy:
    default: always
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states: {}
tools:
  - name: my_tool
    type: tsProjectTool
`);
    const config = new ConfigLoader(undefined, tempRoot).load(configPath);
    const tool = config.tools?.find(t => t.name === 'my_tool') as any;

    expect(tool.defaultArgs[1]).toContain('src/scripts');
    expect(tool.defaultArgs[1]).toContain('my_tool.ts');
  });

  it('per-tool argsMode overrides tsProjectTool default of append', () => {
    const configPath = writeConfig(`
settings:
  startState: Planning
  worktreePolicy:
    default: always
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states: {}
tools:
  - name: tool_replace
    type: tsProjectTool
    argsMode: replace
`);
    const config = new ConfigLoader(undefined, tempRoot).load(configPath);
    const tool = config.tools?.find(t => t.name === 'tool_replace') as any;
    expect(tool.argsMode).toBe('replace');
  });

  it('tsProjectToolDefaults argsMode overrides built-in append default', () => {
    const configPath = writeConfig(`
settings:
  startState: Planning
  tsProjectToolDefaults:
    argsMode: replace
  worktreePolicy:
    default: always
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states: {}
tools:
  - name: tool_a
    type: tsProjectTool
`);
    const config = new ConfigLoader(undefined, tempRoot).load(configPath);
    const tool = config.tools?.find(t => t.name === 'tool_a') as any;
    expect(tool.argsMode).toBe('replace');
  });

  it('tsProjectTool with timeoutMs and cwd is preserved after expansion', () => {
    const configPath = writeConfig(`
settings:
  startState: Planning
  worktreePolicy:
    default: always
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states: {}
tools:
  - name: timed_tool
    type: tsProjectTool
    timeoutMs: 120000
    cwd: /tmp/working
`);
    const config = new ConfigLoader(undefined, tempRoot).load(configPath);
    const tool = config.tools?.find(t => t.name === 'timed_tool') as any;
    expect(tool.timeoutMs).toBe(120000);
    expect(tool.cwd).toBe('/tmp/working');
  });

  it('tsProjectTool with profile can be further resolved by s3wp.2 profile expansion', () => {
    const configPath = writeConfig(`
settings:
  startState: Planning
  toolProfiles:
    nodeEnv:
      env:
        NODE_ENV: "test"
  worktreePolicy:
    default: always
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states: {}
tools:
  - name: env_tool
    type: tsProjectTool
    profile: nodeEnv
`);
    const config = new ConfigLoader(undefined, tempRoot).load(configPath);
    const tool = config.tools?.find(t => t.name === 'env_tool') as any;
    // Should be expanded to command with profile applied
    expect(tool.type).toBe('command');
    expect(tool.env?.NODE_ENV).toBe('test');
  });

  it('existing type: command tools are unaffected by tsProjectTool expansion', () => {
    const configPath = writeConfig(`
settings:
  startState: Planning
  worktreePolicy:
    default: always
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states: {}
tools:
  - name: plain_cmd
    type: command
    command: python
    defaultArgs: ["test.py"]
    argsMode: replace
`);
    const config = new ConfigLoader(undefined, tempRoot).load(configPath);
    const tool = config.tools?.find(t => t.name === 'plain_cmd') as any;
    expect(tool.type).toBe('command');
    expect(tool.command).toBe('python');
    expect(tool.defaultArgs).toEqual(['test.py']);
    expect(tool.argsMode).toBe('replace');
  });

  it('tsProjectTool additional defaultArgs are appended after the script path', () => {
    const configPath = writeConfig(`
settings:
  startState: Planning
  worktreePolicy:
    default: always
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states: {}
tools:
  - name: tool_with_args
    type: tsProjectTool
    defaultArgs: ["--verbose", "--ci"]
`);
    const config = new ConfigLoader(undefined, tempRoot).load(configPath);
    const tool = config.tools?.find(t => t.name === 'tool_with_args') as any;
    expect(tool.defaultArgs[0]).toBe('--experimental-strip-types');
    // Script path at index 1
    expect(tool.defaultArgs[2]).toBe('--verbose');
    expect(tool.defaultArgs[3]).toBe('--ci');
  });

  // s4qi AC3/4: tsProjectTool-expanded tools with undefined profile references are fatal
  it('AC3: tsProjectTool with an undefined profile reference throws a startup-fatal error', () => {
    const configPath = writeConfig(`
settings:
  startState: Planning
  worktreePolicy:
    default: always
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states: {}
tools:
  - name: expanded_ts_tool
    type: tsProjectTool
    profile: ghostProfile
`);
    let caught: Error | undefined;
    try {
      new ConfigLoader(undefined, tempRoot).load(configPath);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught, 'expected load() to throw when tsProjectTool profile is undefined').toBeDefined();
    // After expansion to type:command, the profile validation must fire
    expect(caught!.message).toMatch(/expanded_ts_tool/);
    expect(caught!.message).toMatch(/ghostProfile/);
    expect(caught!.message).toMatch(/available profiles/i);
  });

  // s4qi AC3/4: tsProjectTool with a VALID profile loads fine
  it('AC4: tsProjectTool with a valid profile reference loads without error', () => {
    const configPath = writeConfig(`
settings:
  startState: Planning
  toolProfiles:
    nodeTs:
      env:
        NODE_ENV: "test"
  worktreePolicy:
    default: always
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states: {}
tools:
  - name: valid_ts_tool
    type: tsProjectTool
    profile: nodeTs
`);
    const config = new ConfigLoader(undefined, tempRoot).load(configPath);
    const tool = config.tools?.find(t => t.name === 'valid_ts_tool') as any;
    expect(tool.type).toBe('command');
    expect(tool.env?.NODE_ENV).toBe('test');
  });
});

// ---------------------------------------------------------------------------
// r0oh: settings.traceability must declare ownedBy (non-inert contract)
// ---------------------------------------------------------------------------
describe('r0oh: settings.traceability binding (required ownedBy declaration)', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'orr-else-r0oh-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempRoot)) fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function writeConfig(yaml: string): string {
    const p = path.join(tempRoot, 'harness.yaml');
    fs.writeFileSync(p, yaml);
    return p;
  }

  // AC1: traceability without ownedBy must fail
  it('AC1: throws when settings.traceability is present without ownedBy', () => {
    const configPath = writeConfig(`
settings:
  startState: Planning
  traceability:
    requirePlanToBead: true
    requireBeadToPlan: true
    evidenceStore: eventStore
  worktreePolicy:
    default: always
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states: {}
`);
    expect(() => new ConfigLoader(undefined, tempRoot).load(configPath)).toThrow(
      /settings\.traceability requires an ownedBy declaration/
    );
  });

  // AC1 variant: any traceability flag without ownedBy must fail
  it('AC1: throws when only requirePlanToBead is set without ownedBy', () => {
    const configPath = writeConfig(`
settings:
  startState: Planning
  traceability:
    requirePlanToBead: true
  worktreePolicy:
    default: always
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states: {}
`);
    expect(() => new ConfigLoader(undefined, tempRoot).load(configPath)).toThrow(
      /settings\.traceability requires an ownedBy declaration/
    );
  });

  // AC3: traceability WITH ownedBy must load cleanly (ownedBy resolves to a declared tool)
  it('AC3: loads successfully when settings.traceability includes ownedBy naming a declared tool', () => {
    const configPath = writeConfig(`
settings:
  startState: Planning
  traceability:
    requirePlanToBead: true
    requireBeadToPlan: true
    evidenceStore: eventStore
    ownedBy: plan_contract
  worktreePolicy:
    default: always
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states: {}
tools:
  - name: plan_contract
    type: tsProjectTool
    description: Validates the plan contract
`);
    expect(() => new ConfigLoader(undefined, tempRoot).load(configPath)).not.toThrow();
    const config = new ConfigLoader(undefined, tempRoot).load(configPath);
    expect(config.settings.traceability?.ownedBy).toBe('plan_contract');
  });

  // AC4: no traceability block at all must load cleanly (backward-safe)
  it('AC4: loads successfully when settings.traceability is absent (backward-safe)', () => {
    const configPath = writeConfig(`
settings:
  startState: Planning
  worktreePolicy:
    default: always
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states: {}
`);
    expect(() => new ConfigLoader(undefined, tempRoot).load(configPath)).not.toThrow();
  });

  // AC3 diagnostic: error message names the ownedBy field and explains the fix
  it('AC3: error message explains how to fix the missing ownedBy field', () => {
    const configPath = writeConfig(`
settings:
  startState: Planning
  traceability:
    requireBeadToPlan: true
  worktreePolicy:
    default: always
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states: {}
`);
    let caught: Error | undefined;
    try {
      new ConfigLoader(undefined, tempRoot).load(configPath);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/ownedBy/);
    expect(caught!.message).toMatch(/verifier or tool/);
  });

  // New: ownedBy naming a non-existent tool is REJECTED with a diagnostic listing known names
  it('rejects ownedBy that does not resolve to a declared tool (lists known tools in error)', () => {
    const configPath = writeConfig(`
settings:
  startState: Planning
  traceability:
    requirePlanToBead: true
    ownedBy: nonexistent_typo
  worktreePolicy:
    default: always
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states: {}
tools:
  - name: plan_contract
    type: tsProjectTool
    description: Validates the plan contract
`);
    let caught: Error | undefined;
    try {
      new ConfigLoader(undefined, tempRoot).load(configPath);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/nonexistent_typo/);
    expect(caught!.message).toMatch(/Known tools/);
    expect(caught!.message).toMatch(/plan_contract/);
  });

  // New: cerdiwen-shaped config — traceability with ownedBy: plan_contract + tsProjectTool named plan_contract loads
  it('loads a cerdiwen-shaped config: traceability ownedBy plan_contract with plan_contract tsProjectTool declared', () => {
    const configPath = writeConfig(`
settings:
  startState: Planning
  traceability:
    requirePlanToBead: true
    requireBeadToPlan: true
    evidenceStore: eventStore
    ownedBy: plan_contract
  worktreePolicy:
    default: always
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states: {}
tools:
  - name: plan_contract
    type: tsProjectTool
    description: "Validates the planContract STRUCTURE; persists a per-check report and exports verify()."
`);
    expect(() => new ConfigLoader(undefined, tempRoot).load(configPath)).not.toThrow();
    const config = new ConfigLoader(undefined, tempRoot).load(configPath);
    expect(config.settings.traceability?.ownedBy).toBe('plan_contract');
    // plan_contract is a declared tsProjectTool (expanded to command); ownedBy resolves correctly
    expect(config.tools?.some(t => t.name === 'plan_contract')).toBe(true);
  });
});

// ── 1elr.8: observeOnly tools cannot satisfy requiredTools (config-load rejection) ──

describe('1elr.8: observeOnly tools in requiredTools are rejected at config load', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'orr-else-1elr8-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempRoot)) fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function writeConfig(yaml: string): string {
    const p = path.join(tempRoot, 'harness.yaml');
    fs.writeFileSync(p, yaml);
    return p;
  }

  // (a) observeOnly tool in state requiredTools is REJECTED
  it('throws when an observeOnly extension tool appears in a state requiredTools', () => {
    const configPath = writeConfig(`
settings:
  startState: Implement
  eventStore:
    enabled: true
  worktreePolicy:
    default: always
states:
  Implement:
    identity: { role: "Dev", expertise: "Dev", constraints: [] }
    baseInstructions: "Build"
    requiredTools:
      - watch_tool
    actions: []
    transitions: { SUCCESS: completed, FAILURE: Implement }
tools:
  - name: watch_tool
    type: extension
    observeOnly: true
`);
    const loader = new ConfigLoader(undefined, tempRoot);
    expect(() => loader.load(configPath)).toThrow(/watch_tool/);
    expect(() => loader.load(configPath)).toThrow(/observeOnly/);
  });

  // (a) observeOnly tool in action requiredTools is REJECTED
  it('throws when an observeOnly extension tool appears in an action requiredTools', () => {
    const configPath = writeConfig(`
settings:
  startState: Implement
  eventStore:
    enabled: true
  worktreePolicy:
    default: always
states:
  Implement:
    identity: { role: "Dev", expertise: "Dev", constraints: [] }
    baseInstructions: "Build"
    actions:
      - id: validate
        type: tool
        tool: real_tool
        requiredTools:
          - name: watch_tool
    transitions: { SUCCESS: completed, FAILURE: Implement }
tools:
  - name: watch_tool
    type: extension
    observeOnly: true
  - name: real_tool
    type: command
    command: echo
`);
    const loader = new ConfigLoader(undefined, tempRoot);
    expect(() => loader.load(configPath)).toThrow(/watch_tool/);
    expect(() => loader.load(configPath)).toThrow(/observeOnly/);
  });

  // (b) observeOnly tool NOT in requiredTools loads fine
  it('does NOT throw when an observeOnly tool is declared but not in any requiredTools', () => {
    const configPath = writeConfig(`
settings:
  startState: Implement
  eventStore:
    enabled: true
  worktreePolicy:
    default: always
states:
  Implement:
    identity: { role: "Dev", expertise: "Dev", constraints: [] }
    baseInstructions: "Build"
    requiredTools:
      - real_tool
    actions: []
    transitions: { SUCCESS: completed, FAILURE: Implement }
tools:
  - name: watch_tool
    type: extension
    observeOnly: true
  - name: real_tool
    type: command
    command: echo
`);
    expect(() => new ConfigLoader(undefined, tempRoot).load(configPath)).not.toThrow();
  });

  // (c) normal (non-observeOnly) tool in requiredTools still loads fine
  it('does NOT throw when a normal (non-observeOnly) tool appears in requiredTools', () => {
    const configPath = writeConfig(`
settings:
  startState: Implement
  eventStore:
    enabled: true
  worktreePolicy:
    default: always
states:
  Implement:
    identity: { role: "Dev", expertise: "Dev", constraints: [] }
    baseInstructions: "Build"
    requiredTools:
      - real_tool
    actions: []
    transitions: { SUCCESS: completed, FAILURE: Implement }
tools:
  - name: real_tool
    type: command
    command: echo
`);
    expect(() => new ConfigLoader(undefined, tempRoot).load(configPath)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// bhxt: fail startup closed when harness schema/registry missing or uncompilable
//
// The ConfigLoader.validate() method resolves the install schema path via a
// protected resolveInstallSchemaPath() hook, which subclasses can override for
// test isolation. Tests use ConfigLoaderWithCustomInstallSchema to inject a
// non-existent or corrupt schema path without touching real package files.
// ---------------------------------------------------------------------------

/** Test double: override install-schema resolution so we can inject any path. */
class ConfigLoaderWithCustomInstallSchema extends ConfigLoader {
  constructor(
    private readonly installSchemaOverride: string,
    projectRoot: string
  ) {
    super(undefined, projectRoot);
  }

  protected override resolveInstallSchemaPath(): string {
    return this.installSchemaOverride;
  }
}

describe('bhxt: ConfigLoader.validate() fails closed — missing / corrupt schema', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'orr-else-bhxt-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempRoot)) fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function writeConfig(yaml: string): string {
    const p = path.join(tempRoot, 'harness.yaml');
    fs.writeFileSync(p, yaml);
    return p;
  }

  const minimalYaml = `
settings:
  startState: Planning
  worktreePolicy:
    default: always
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states: {}
`;

  // AC1/AC3: both install schema and project schema absent → fatal throw (no warn-and-skip)
  it('AC1/AC3: throws (not warn-and-skip) when both install schema and project schema are absent', () => {
    const configPath = writeConfig(minimalYaml);
    // Neither the fake install path nor the project schema path exists.
    const loader = new ConfigLoaderWithCustomInstallSchema(
      path.join(tempRoot, 'nonexistent-install', 'harness.schema.json'),
      tempRoot
    );
    let thrown: Error | undefined;
    try {
      loader.load(configPath);
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown, 'expected load() to throw when both schema paths are absent').toBeDefined();
    // AC2: error must include the attempted paths
    expect(thrown!.message).toMatch(/harness\.schema\.json/);
    expect(thrown!.message).toMatch(/getPackagedSchemaPath/);
  });

  // AC3: install schema absent, project schema exists but contains invalid JSON → throws
  it('AC3: throws when schema file exists but contains invalid JSON', () => {
    // Write a corrupt schema at the project root.
    fs.writeFileSync(path.join(tempRoot, 'harness.schema.json'), 'INVALID_JSON{{{');
    const configPath = writeConfig(minimalYaml);
    // Install schema path points to non-existent location → falls back to project schema.
    const loader = new ConfigLoaderWithCustomInstallSchema(
      path.join(tempRoot, 'nonexistent-install', 'harness.schema.json'),
      tempRoot
    );
    let thrown: Error | undefined;
    try {
      loader.load(configPath);
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown, 'expected load() to throw on invalid JSON schema').toBeDefined();
    expect(thrown!.message).toMatch(/harness\.schema\.json/);
  });

  // AC3: install schema absent, project schema is valid JSON but AJV compile fails → throws
  it('AC3: throws when schema file contains valid JSON that AJV cannot compile', () => {
    // Write a JSON file that is syntactically valid but not a valid JSON Schema.
    fs.writeFileSync(
      path.join(tempRoot, 'harness.schema.json'),
      JSON.stringify({ type: 'completely_unknown_invalid_type_xyz' })
    );
    const configPath = writeConfig(minimalYaml);
    const loader = new ConfigLoaderWithCustomInstallSchema(
      path.join(tempRoot, 'nonexistent-install', 'harness.schema.json'),
      tempRoot
    );
    let thrown: Error | undefined;
    try {
      loader.load(configPath);
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown, 'expected load() to throw on AJV compile failure').toBeDefined();
    // The error should reference the schema path or compilation failure.
    expect(thrown!.message).toMatch(/harness\.schema\.json/);
  });

  // AC2: error message includes the install path and project path when both are absent
  it('AC2: error message includes both attempted schema paths', () => {
    const configPath = writeConfig(minimalYaml);
    const fakeInstallPath = path.join(tempRoot, 'fake-install', 'harness.schema.json');
    const loader = new ConfigLoaderWithCustomInstallSchema(fakeInstallPath, tempRoot);
    let thrown: Error | undefined;
    try {
      loader.load(configPath);
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeDefined();
    // The fake install path must appear in the error message.
    expect(thrown!.message).toContain(fakeInstallPath);
    // The project schema path must also appear.
    expect(thrown!.message).toContain(path.join(tempRoot, 'harness.schema.json'));
    // getPackagedSchemaPath must be mentioned so users know how to find the correct path.
    expect(thrown!.message).toMatch(/getPackagedSchemaPath/);
  });

  // AC1 (normal): packaged install schema is present → loads without throwing (no regression)
  it('AC1 (normal): real packaged install schema → load() succeeds, no regression', () => {
    const configPath = writeConfig(minimalYaml);
    // Use the real ConfigLoader (no override) — the packaged harness.schema.json must be found.
    expect(() => new ConfigLoader(undefined, tempRoot).load(configPath)).not.toThrow();
  });

  // AC1 (normal): install schema absent but valid project schema present → succeeds
  it('AC1 (normal): valid project-level harness.schema.json is accepted when install schema absent', () => {
    // Copy the real packaged schema into the project root.
    const pkgSchema = getPackagedSchemaPath();
    fs.copyFileSync(pkgSchema, path.join(tempRoot, 'harness.schema.json'));
    const configPath = writeConfig(minimalYaml);
    const loader = new ConfigLoaderWithCustomInstallSchema(
      path.join(tempRoot, 'nonexistent-install', 'harness.schema.json'),
      tempRoot
    );
    // Project schema is valid → must not throw.
    expect(() => loader.load(configPath)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// pi-experiment-145m: missing settings.worktreePolicy.default is startup-fatal
// ---------------------------------------------------------------------------
describe('pi-experiment-145m: settings.worktreePolicy.default must be explicit', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'orr-else-145m-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempRoot)) fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function writeConfig(yaml: string): string {
    const p = path.join(tempRoot, 'harness.yaml');
    fs.writeFileSync(p, yaml);
    return p;
  }

  // AC1/AC5: absent worktreePolicy entirely → startup-fatal
  it('AC1/AC5: throws when settings.worktreePolicy is entirely absent', () => {
    const configPath = writeConfig(
      'settings:\n  startState: Planning\nscheduler:\n  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }\nstates: {}\n'
    );
    expect(() => new ConfigLoader(undefined, tempRoot).load(configPath)).toThrow(
      /settings\.worktreePolicy\.default/
    );
  });

  // AC1/AC5: worktreePolicy block present but default field missing → startup-fatal
  it('AC1/AC5: throws when settings.worktreePolicy is present but default is absent', () => {
    const configPath = writeConfig(`
settings:
  startState: Planning
  worktreePolicy: {}
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states: {}
`);
    expect(() => new ConfigLoader(undefined, tempRoot).load(configPath)).toThrow(
      /settings\.worktreePolicy\.default/
    );
  });

  // AC5: diagnostic message includes a replacement example
  it('AC5: error message names the missing field and provides a replacement example', () => {
    const configPath = writeConfig(
      'settings:\n  startState: Planning\nscheduler:\n  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }\nstates: {}\n'
    );
    let caught: Error | undefined;
    try {
      new ConfigLoader(undefined, tempRoot).load(configPath);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/settings\.worktreePolicy\.default/);
    // Replacement example must name both valid values
    expect(caught!.message).toMatch(/always/);
    expect(caught!.message).toMatch(/never/);
  });

  // Positive: explicit default: always loads without error
  it('loads successfully when settings.worktreePolicy.default = "always"', () => {
    const configPath = writeConfig(`
settings:
  startState: Planning
  worktreePolicy:
    default: always
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states: {}
`);
    expect(() => new ConfigLoader(undefined, tempRoot).load(configPath)).not.toThrow();
    const config = new ConfigLoader(undefined, tempRoot).load(configPath);
    expect(config.settings.worktreePolicy?.default).toBe('always');
  });

  // Positive: explicit default: never loads without error
  it('loads successfully when settings.worktreePolicy.default = "never"', () => {
    const configPath = writeConfig(`
settings:
  startState: Planning
  worktreePolicy:
    default: never
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states: {}
`);
    expect(() => new ConfigLoader(undefined, tempRoot).load(configPath)).not.toThrow();
    const config = new ConfigLoader(undefined, tempRoot).load(configPath);
    expect(config.settings.worktreePolicy?.default).toBe('never');
  });
});

// ---------------------------------------------------------------------------
// buvj: compatibility fields are rejected at startup (deterministic error)
// ---------------------------------------------------------------------------

describe('ConfigLoader — compatibility fields rejected at startup (buvj)', () => {
  let tempRoot: string;
  let configLoader: ConfigLoader;

  function writeConfig(content: string): string {
    const configPath = path.join(tempRoot, 'harness.yaml');
    fs.writeFileSync(configPath, content);
    return configPath;
  }

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(process.cwd(), 'temp-buvj-compat-'));
    configLoader = new ConfigLoader(undefined, tempRoot);
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('rejects a config containing settings.compatibilityMode with a deterministic error', () => {
    const configPath = writeConfig(`
settings:
  startState: Planning
  worktreePolicy:
    default: always
  compatibilityMode: claude
states: {}
`);
    expect(() => configLoader.load(configPath)).toThrow(/compatibilityMode.*removed|compatibility.*removed|no longer supported|removed.*buvj/i);
  });

  it('rejects a config containing settings.compatibility with a deterministic error', () => {
    const configPath = writeConfig(`
settings:
  startState: Planning
  worktreePolicy:
    default: always
  compatibility:
    modes:
      claude:
        masterRules: [CLAUDE.md]
states: {}
`);
    expect(() => configLoader.load(configPath)).toThrow(/compatibility.*removed|compatibilityMode.*removed|no longer supported|removed.*buvj/i);
  });

  it('rejects a config containing both compatibilityMode and compatibility with a deterministic error', () => {
    const configPath = writeConfig(`
settings:
  startState: Planning
  worktreePolicy:
    default: always
  compatibilityMode: claude
  compatibility:
    modes:
      claude:
        masterRules: [CLAUDE.md]
        hookDirs: [.claude/hooks]
states: {}
`);
    expect(() => configLoader.load(configPath)).toThrow(/compatibilityMode.*removed|compatibility.*removed|no longer supported|removed.*buvj/i);
  });

  it('accepts a normal config without any compatibility fields', () => {
    const configPath = writeConfig(`
settings:
  startState: Planning
  worktreePolicy:
    default: always
states: {}
`);
    expect(() => configLoader.load(configPath)).not.toThrow();
  });
});
