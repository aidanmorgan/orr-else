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
