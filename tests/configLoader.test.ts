import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
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
});
