import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import * as fs from 'fs';
import * as path from 'path';

describe('ConfigLoader Validation', () => {
  let configLoader: ConfigLoader;
  const validYaml = `
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "Global {{history}}"
  defaultModel: "m1"
  startState: State1
scheduler:
  weights:
    waitTime: 1.0
    executionTime: 0.5
    progress: 2.0
    penalty: 1.0
states:
  State1:
    identity: { role: 'R1', expertise: 'E1', constraints: [] }
    baseInstructions: 'Inst'
    actions:
      - id: action1
        type: prompt
        prompt: "Inline prompt"
    transitions: { SUCCESS: 'Done', FAILURE: 'State1' }
`;

  beforeEach(() => {
    configLoader = new ConfigLoader();
    if (fs.existsSync('test-harness.yaml')) fs.unlinkSync('test-harness.yaml');
  });

  afterEach(() => {
    configLoader.reset();
    if (fs.existsSync('test-harness.yaml')) fs.unlinkSync('test-harness.yaml');
    if (fs.existsSync('test-prompt.md')) fs.unlinkSync('test-prompt.md');
    if (fs.existsSync('test-checklist.yaml')) fs.unlinkSync('test-checklist.yaml');
  });

  it('should validate a valid YAML configuration', () => {
    fs.writeFileSync('test-harness.yaml', validYaml);
    const config = configLoader.load('test-harness.yaml');
    expect(config.states['State1'].actions[0].prompt).toBe('Inline prompt');
  });

  it('should validate state-level and action-level checklist entries', () => {
    const checklistYaml = validYaml
      .replace(
        "baseInstructions: 'Inst'",
        "baseInstructions: 'Inst'\n    checklist:\n      - text: State-defined requirement\n        mandatory: true"
      )
      .replace(
        '        prompt: "Inline prompt"',
        '        prompt: "Inline prompt"\n        checklist:\n          - text: Action-defined requirement\n            mandatory: false'
      );

    fs.writeFileSync('test-harness.yaml', checklistYaml);
    const config = configLoader.load('test-harness.yaml');

    expect(config.states['State1'].checklist?.[0].text).toBe('State-defined requirement');
    expect(config.states['State1'].actions[0].checklist?.[0].text).toBe('Action-defined requirement');
  });

  it('should load checklist entries from YAML files', () => {
    fs.writeFileSync('test-checklist.yaml', `
- text: File-backed requirement
  mandatory: true
`);
    const fileChecklistYaml = validYaml.replace(
      "baseInstructions: 'Inst'",
      "baseInstructions: 'Inst'\n    checklist: test-checklist.yaml"
    );
    fs.writeFileSync('test-harness.yaml', fileChecklistYaml);

    const config = configLoader.load('test-harness.yaml');

    expect(config.states['State1'].checklist?.[0].text).toBe('File-backed requirement');
    expect(config.states['State1'].checklist?.[0].mandatory).toBe(true);
  });

  it('should throw error for invalid YAML schema', () => {
    const invalidYaml = `
settings:
  maxConcurrentSlots: "should be int"
`;
    fs.writeFileSync('test-harness.yaml', invalidYaml);
    expect(() => configLoader.load('test-harness.yaml')).toThrow(/validation failed/);
  });

  it('should reject legacy agent profile configuration', () => {
    const profileYaml = `${validYaml}
agentProfiles: {}
`;
    fs.writeFileSync('test-harness.yaml', profileYaml);
    expect(() => configLoader.load('test-harness.yaml')).toThrow(/validation failed/);

    configLoader.reset();
    const stateProfileYaml = validYaml.replace("baseInstructions: 'Inst'", "baseInstructions: 'Inst'\n    agentProfile: Planner");
    fs.writeFileSync('test-harness.yaml', stateProfileYaml);
    expect(() => configLoader.load('test-harness.yaml')).toThrow(/validation failed/);
  });

  it('should resolve file-based prompts', () => {
    const promptFile = 'test-prompt.md';
    const promptContent = '# File based prompt';
    fs.writeFileSync(promptFile, promptContent);
    
    const fileYaml = validYaml.replace('Inline prompt', promptFile);
    fs.writeFileSync('test-harness.yaml', fileYaml);
    
    const config = configLoader.load('test-harness.yaml');
    expect(config.states['State1'].actions[0].prompt).toBe(promptContent);
    
    fs.unlinkSync(promptFile);
  });
});
