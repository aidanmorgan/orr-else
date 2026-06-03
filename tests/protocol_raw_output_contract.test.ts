/**
 * Prompt-assembly test: raw-output / minimal-schema contract guidance.
 *
 * Assertions:
 *  1. The raw-output / minimal-schema guidance phrase appears EXACTLY ONCE in
 *     the assembled agent context (assemble() + inject() joined — the same join
 *     performed by buildStateSystemPrompt).  No duplication across state-specific
 *     and protocol sections.
 *  2. The obsolete generic-envelope terms (resultPreview, diagnosticPreview,
 *     outputPreview, outputArchive, inlineResultBytes) do NOT appear in the
 *     ProtocolInjector output as instructions to rely on them universally.
 *  3. The replacement "Tool Result Contract" guidance IS present in the
 *     ProtocolInjector output.
 */

import { describe, expect, it } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { ProtocolInjector } from '../src/core/ProtocolInjector.js';
import { InstructionLoader } from '../src/core/InstructionLoader.js';
import type { HarnessConfig, SDLCState } from '../src/core/domain/StateModels.js';

const root = path.join(os.tmpdir(), 'orr-else-raw-output-contract-test');

function minimalState(baseInstructions?: string): SDLCState {
  return {
    id: 'Implementation',
    identity: {
      role: 'Implementer',
      expertise: 'Implementing code changes.',
      constraints: ['No shortcuts.']
    },
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
      defaultModel: 'claude-3-7',
      defaultProvider: 'anthropic',
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

describe('protocol raw-output contract — prompt assembly', () => {
  const instructionLoader = new InstructionLoader(root);
  const protocolInjector = new ProtocolInjector();

  /**
   * Helper: build the combined system prompt the same way buildStateSystemPrompt does.
   */
  function buildCombined(state: SDLCState, config: HarnessConfig): string {
    const assembled = instructionLoader.assemble(state, config);
    const protocol = protocolInjector.inject(state, config);
    return [assembled, protocol].filter(Boolean).join('\n\n');
  }

  it('(1) "Tool Result Contract" guidance appears EXACTLY ONCE in the combined context', () => {
    const combined = buildCombined(minimalState(), minimalConfig());
    // The canonical phrase introduced by the raw-output contract update.
    const PHRASE = 'Tool Result Contract';
    const count = combined.split(PHRASE).length - 1;
    expect(
      count,
      `Expected "${PHRASE}" to appear exactly once; found ${count} occurrence(s)`
    ).toBe(1);
  });

  it('(2a) "resultPreview" does NOT appear in ProtocolInjector output as universal guidance', () => {
    const protocol = protocolInjector.inject(minimalState(), minimalConfig());
    // The term must not appear as an instruction to rely on it universally.
    // (It may appear in negative/forbidden-list framing — the check below is
    // case-sensitive and targets the camelCase form used in the old bullet.)
    expect(protocol).not.toContain('Use inline `resultPreview`');
    expect(protocol).not.toContain('Use inline `outputPreview`');
    expect(protocol).not.toContain('Use inline `diagnosticPreview`');
  });

  it('(2b) "outputArchive.artifactRef" does NOT appear in ProtocolInjector output', () => {
    const protocol = protocolInjector.inject(minimalState(), minimalConfig());
    expect(protocol).not.toContain('outputArchive.artifactRef');
  });

  it('(2c) "inlineResultBytes" does NOT appear in ProtocolInjector output', () => {
    const protocol = protocolInjector.inject(minimalState(), minimalConfig());
    expect(protocol).not.toContain('inlineResultBytes');
  });

  it('(3) ProtocolInjector emits the minimal-schema / raw-output-archive contract statement', () => {
    const protocol = protocolInjector.inject(minimalState(), minimalConfig());
    // Verify the key claim in the new guidance is present.
    expect(protocol).toContain('minimal schema');
    expect(protocol).toContain('tool-calls storage');
  });

  it('(4) combined context contains no duplicate "ORR ELSE PROTOCOL" header', () => {
    const combined = buildCombined(minimalState('Some base instructions.'), minimalConfig());
    const headerCount = combined.split('ORR ELSE PROTOCOL').length - 1;
    expect(
      headerCount,
      `"ORR ELSE PROTOCOL" header should appear exactly once; found ${headerCount}`
    ).toBe(1);
  });
});
