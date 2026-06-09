import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BuiltInToolName } from '../src/constants/domain.js';
import { deriveChecklistItems, mergeChecklistItems, missingMandatoryChecklistItems, normalizeChecklistTickText, resolveChecklistTickText } from '../src/core/ChecklistRequirements.js';
import { ProtocolInjector } from '../src/core/ProtocolInjector.js';
import type { SDLCState, TeammateAction } from '../src/core/domain/StateModels.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

function stateWithChecklist(checklist: SDLCState['checklist'], actions: TeammateAction[] = []): SDLCState {
  return {
    id: 'SpecimenCapture',
    identity: { role: 'Specimen state', expertise: 'Arbitrary workflow', constraints: [] },
    baseInstructions: 'Capture the specimen workflow state.',
    checklist,
    actions,
    transitions: { SUCCESS: 'SpecimenReview', FAILURE: 'SpecimenCapture' }
  };
}

describe('ChecklistRequirements', () => {
  it('derives state checklist items before active action additions for arbitrary states', () => {
    const action: TeammateAction = {
      id: 'capture-evidence',
      type: 'prompt',
      checklist: [
        { text: 'Photograph tagged sample', mandatory: true },
        { text: 'Record optional humidity', mandatory: false }
      ]
    };
    const state = stateWithChecklist([
      { text: 'Open specimen case', mandatory: true },
      { text: 'Record chain of custody', mandatory: true }
    ], [action]);

    expect(deriveChecklistItems(state, action).map(item => item.text)).toEqual([
      'Open specimen case',
      'Record chain of custody',
      'Photograph tagged sample',
      'Record optional humidity'
    ]);
  });

  it('deduplicates exact text and lets mandatory true win without replacing first metadata', () => {
    const action: TeammateAction = {
      id: 'capture-evidence',
      type: 'prompt',
      checklist: [
        { text: 'Record chain of custody', mandatory: true, type: 'tool', tool: 'external_tool' },
        { text: 'Photograph tagged sample', mandatory: true }
      ]
    };
    const state = stateWithChecklist([
      { text: 'Record chain of custody', mandatory: false, type: 'manual' },
      { text: 'Record chain of custody', mandatory: false, type: 'script', script: 'ignored.sh' }
    ], [action]);

    const items = deriveChecklistItems(state, action);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      text: 'Record chain of custody',
      mandatory: true,
      type: 'manual'
    });
    expect(items[0].tool).toBeUndefined();
  });

  it('calculates missing mandatory checklist items from the derived YAML requirements', () => {
    const requiredItems = deriveChecklistItems(
      stateWithChecklist([{ text: 'Open specimen case', mandatory: true }]),
      {
        id: 'capture-evidence',
        type: 'prompt',
        checklist: [
          { text: 'Record optional humidity', mandatory: false },
          { text: 'Photograph tagged sample', mandatory: true }
        ]
      }
    );

    expect(missingMandatoryChecklistItems(requiredItems, {
      'Open specimen case': { checked: true, evidence: 'Case seal verified before opening.' }
    })).toEqual(['Photograph tagged sample']);
  });

  it('merges dynamic checklist items without duplicating exact text and lets mandatory additions upgrade existing items', () => {
    const result = mergeChecklistItems(
      [
        { text: 'Static evidence review', mandatory: true },
        { text: 'Rule-specific audit', mandatory: false }
      ],
      [
        { text: 'Rule-specific audit', mandatory: true, id: 'coding.rule' },
        { text: 'LLM-selected coding rule', mandatory: true, rulePath: '.pi/rules/global/testing.md' }
      ]
    );

    expect(result.requiredItems.map(item => item.text)).toEqual([
      'Static evidence review',
      'Rule-specific audit',
      'LLM-selected coding rule'
    ]);
    expect(result.requiredItems[1].mandatory).toBe(true);
    expect(result.addedItems.map(item => item.text)).toEqual(['LLM-selected coding rule']);
    expect(result.existingItems.map(item => item.text)).toEqual(['Rule-specific audit']);
    expect(result.upgradedItems.map(item => item.text)).toEqual(['Rule-specific audit']);
  });

  it('resolves displayed protocol suffixes back to configured checklist text', () => {
    const requiredItems = [
      { text: 'Load compatibility context', mandatory: true },
      { text: 'Run optional audit', mandatory: false }
    ];

    expect(normalizeChecklistTickText('- Load compatibility context (MANDATORY)')).toBe('Load compatibility context');
    expect(resolveChecklistTickText(requiredItems, 'Run optional audit (OPTIONAL)')).toBe('Run optional audit');
    expect(resolveChecklistTickText(requiredItems, 'Missing item (MANDATORY)')).toBeUndefined();
  });

  it('enables checklist tool protocol guidance for state-level-only checklists', () => {
    const protocol = new ProtocolInjector().inject(stateWithChecklist([
      { text: 'State-level only review', mandatory: true }
    ], [{ id: 'state-action', type: 'prompt' }]));

    expect(protocol).toContain(BuiltInToolName.TICK_ITEMS);
    // tick_item (without trailing 's') must not appear as a standalone tool reference
    expect(protocol).not.toMatch(/`tick_item`/);
    expect(protocol).toContain(BuiltInToolName.GET_OUTSTANDING_TASKS);
    expect(protocol).toContain(BuiltInToolName.SUBMIT_CHECKPOINT);
    expect(protocol).toContain(BuiltInToolName.SIGNAL_COMPLETION);
    expect(protocol).toContain('Tool Result Contract');
    expect(protocol).toContain('minimal schema');
  });
});

describe('Runtime template text does not reference removed tick_item tool', () => {
  // harness_rules.md is loaded at runtime by InstructionLoader and copied into
  // every project's .pi/ by init. Any instruction to call `tick_item` (the
  // removed singular tool) would break teammate agents at runtime.
  const TICK_ITEM_WORD_BOUNDARY = /\btick_item\b(?!s)/;

  it('templates/rules/harness_rules.md contains no tick_item tool reference', () => {
    const content = fs.readFileSync(
      path.join(PROJECT_ROOT, 'templates', 'rules', 'harness_rules.md'),
      'utf8'
    );
    expect(content).not.toMatch(TICK_ITEM_WORD_BOUNDARY);
  });

  it('templates/prompts/implementer.md contains no tick_item tool reference', () => {
    const content = fs.readFileSync(
      path.join(PROJECT_ROOT, 'templates', 'prompts', 'implementer.md'),
      'utf8'
    );
    expect(content).not.toMatch(TICK_ITEM_WORD_BOUNDARY);
  });
});
