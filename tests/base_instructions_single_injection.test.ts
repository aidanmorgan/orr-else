import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { ProtocolInjector } from '../src/core/ProtocolInjector.js';
import { InstructionLoader } from '../src/core/InstructionLoader.js';
import type { HarnessConfig, SDLCState } from '../src/core/domain/StateModels.js';

const root = path.join(os.tmpdir(), 'orr-else-single-injection-test');

function minimalState(baseInstructions?: string): SDLCState {
  return {
    id: 'Planning',
    identity: { role: 'Planner', expertise: 'Planning work.', constraints: ['No shortcuts.'] },
    baseInstructions,
    actions: [],
    transitions: { SUCCESS: 'completed' }
  } as SDLCState;
}

function minimalConfig(): HarnessConfig {
  return {
    settings: {
      maxConcurrentSlots: 1,
      handoverTemplate: '',
      defaultModel: 'gpt-5.5',
      defaultProvider: 'openaiCodex',
      modelProviders: {},
      agentTurnTimeoutMs: 30000,
      processReapIntervalMs: 5000,
      harnessRestartEvent: 'HARNESS_RESTART',
      contextRestartEvent: 'CONTEXT_RESTART',
      stateContextRotThreshold: 10,
      harnessContextRotThreshold: 5
    },
    scheduler: { weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 } },
    states: {}
  } as HarnessConfig;
}

describe('base instructions single injection', () => {
  const instructionLoader = new InstructionLoader(root);
  const protocolInjector = new ProtocolInjector();

  it('(a) baseInstructions sentinel appears EXACTLY ONCE when assemble() and inject() are concatenated', () => {
    const SENTINEL = 'UNIQUE_SENTINEL_VALUE_xyzzy_42';
    const state = minimalState(SENTINEL);
    const config = minimalConfig();

    const assembled = instructionLoader.assemble(state, config);
    const protocol = protocolInjector.inject(state, config);

    // Replicate the join done by buildStateSystemPrompt
    const combined = [assembled, protocol].filter(Boolean).join('\n\n');

    // Sentinel must appear exactly once
    const occurrences = combined.split(SENTINEL).length - 1;
    expect(occurrences).toBe(1);

    // The PHASE INSTRUCTIONS block must not exist at all
    expect(combined).not.toContain('PHASE INSTRUCTIONS');
  });

  it('(b) assemble() emits no BASE INSTRUCTIONS header when baseInstructions is empty string', () => {
    const state = minimalState('');
    const assembled = instructionLoader.assemble(state, minimalConfig());

    expect(assembled).not.toContain('BASE INSTRUCTIONS:');
  });

  it('(b) assemble() emits no BASE INSTRUCTIONS header when baseInstructions is omitted', () => {
    const state = minimalState(undefined);
    const assembled = instructionLoader.assemble(state, minimalConfig());

    expect(assembled).not.toContain('BASE INSTRUCTIONS:');
  });

  it('assemble() still emits BASE INSTRUCTIONS header when baseInstructions is a non-empty string', () => {
    const state = minimalState('Do the planning work.');
    const assembled = instructionLoader.assemble(state, minimalConfig());

    expect(assembled).toContain('BASE INSTRUCTIONS:');
    expect(assembled).toContain('Do the planning work.');
  });
});
