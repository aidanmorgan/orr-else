import { describe, it, expect, beforeEach } from 'vitest';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import * as path from 'path';

describe('ConfigLoader', () => {
  let configLoader: ConfigLoader;

  beforeEach(() => {
    configLoader = new ConfigLoader();
  });

  it('should load and parse harness.yaml correctly', () => {
    // Uses the root harness.yaml created earlier
    const configPath = path.join(process.cwd(), 'harness.yaml');
    const config = configLoader.load(configPath);
    
    expect(config).toBeDefined();
    expect(config.settings.handoverTemplate).toBeDefined();
    expect(config.states['Planning']).toBeDefined();
    expect(config.states['Planning'].identity.role).toContain('Planner Teammate');
    expect(config.states['Planning'].checklist?.map(item => item.text)).toContain('Explored codebase structure');
    expect(config.states['Planning'].actions).toBeDefined();
    expect(config.states['Planning'].actions.length).toBeGreaterThan(0);
    expect(config.states['Planning'].actions[0].checklist).toBeUndefined();
    expect(config.states['Planning'].transitions.SUCCESS).toBe('AdversarialPreReview');
    expect(config.states['AdversarialPreReview'].transitions.SUCCESS).toBe('Implementation');
    expect(config.states['Implementation'].transitions.SUCCESS).toBe('AdversarialPostReview');
    expect(config.states['AdversarialPostReview'].transitions.SUCCESS).toBe('completed');
    // States use the `codex` provider key, which routes to the openai-codex
    // (ChatGPT/Codex) OAuth subscription provider.
    expect(configLoader.resolveLLMConfig('Planning', config).provider).toBe('openai-codex');
    expect(configLoader.resolveLLMConfig('Planning', config).model).toBe('gpt-5.5');
    expect(configLoader.resolveLLMConfig('Implementation', config).provider).toBe('openai-codex');
    expect(configLoader.resolveLLMConfig('Implementation', config).model).toBe('gpt-5.5');
    // The claude provider key carries the `claude` subscription token, which
    // resolveLLMConfig routes to the anthropic (Claude Pro/Max) OAuth provider.
    expect(config.settings.modelProviders.claude.provider).toBe('claude');
    expect(config.settings.modelProviders.claude.model).toBe('claude-opus-4-5');
    const claudeLlm = configLoader.resolveLLMConfig('Planning', { ...config, settings: { ...config.settings, defaultProvider: 'claude' }, states: {} });
    expect(claudeLlm.provider).toBe('anthropic');
    // The codex provider key routes to the openai-codex (Codex) OAuth provider.
    expect(config.settings.modelProviders.codex.provider).toBe('codex');
    const codexLlm = configLoader.resolveLLMConfig('Planning', { ...config, settings: { ...config.settings, defaultProvider: 'codex' }, states: {} });
    expect(codexLlm.provider).toBe('openai-codex');
  });

  it('should throw if file does not exist', () => {
    expect(() => configLoader.load('nonexistent.yaml')).toThrowError(/not found/);
  });
});
