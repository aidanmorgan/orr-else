/**
 * pi-experiment-6q0y.15: model-turn and tool-payload accounting schema tests.
 *
 * AC1: Distinct schema-validated event types for model-turn usage and
 *      tool-payload accounting exist as DomainEventName entries.
 *
 * AC2: Events include stable identifiers, provider/model/tool names, byte
 *      counts, token estimates or provider usage fields, and idempotency keys.
 *
 * AC3: Events never include prompt bodies, raw tool output bodies, source
 *      files, or logs (enforced by additionalProperties: false in each schema).
 *
 * AC4: OTel attributes mirror only scalar accounting fields — the schemas do
 *      not allow prompt/body/log fields at all.
 *
 * AC5: Tests validate success, schema rejection, and replay of both event types.
 */

import { describe, it, expect } from 'vitest';
import {
  schemaRegistry,
  SchemaId,
  REQUIRED_BOUNDARY_IDS,
} from '../src/core/SchemaRegistry.js';
import {
  DOMAIN_EVENT_SCHEMAS,
  DOMAIN_EVENT_SCHEMA_METADATA,
} from '../src/core/DomainEventSchemas.js';
import {
  type ModelTurnAccountingEvent,
  type ToolPayloadAccountingEvent,
  buildModelTurnIdempotencyKey,
  buildToolPayloadIdempotencyKey,
} from '../src/core/TokenUsage.js';
import { DomainEventName } from '../src/constants/domain.js';

// ---------------------------------------------------------------------------
// AC1 — Distinct event types registered in DomainEventName and DOMAIN_EVENT_SCHEMAS
// ---------------------------------------------------------------------------

describe('AC1: distinct event types', () => {
  it('MODEL_TURN_USAGE_RECORDED is a stable DomainEventName', () => {
    expect(DomainEventName.MODEL_TURN_USAGE_RECORDED).toBe('MODEL_TURN_USAGE_RECORDED');
  });

  it('TOOL_PAYLOAD_ACCOUNTED is a stable DomainEventName', () => {
    expect(DomainEventName.TOOL_PAYLOAD_ACCOUNTED).toBe('TOOL_PAYLOAD_ACCOUNTED');
  });

  it('MODEL_TURN_USAGE_RECORDED and TOOL_PAYLOAD_ACCOUNTED have distinct string values', () => {
    expect(DomainEventName.MODEL_TURN_USAGE_RECORDED).not.toBe(DomainEventName.TOOL_PAYLOAD_ACCOUNTED);
  });

  it('MODEL_TURN_USAGE_RECORDED has DOMAIN_EVENT_SCHEMAS required-field entry', () => {
    const fields = DOMAIN_EVENT_SCHEMAS[DomainEventName.MODEL_TURN_USAGE_RECORDED];
    expect(fields).toBeDefined();
    expect(Array.isArray(fields)).toBe(true);
  });

  it('TOOL_PAYLOAD_ACCOUNTED has DOMAIN_EVENT_SCHEMAS required-field entry', () => {
    const fields = DOMAIN_EVENT_SCHEMAS[DomainEventName.TOOL_PAYLOAD_ACCOUNTED];
    expect(fields).toBeDefined();
    expect(Array.isArray(fields)).toBe(true);
  });

  it('MODEL_TURN_USAGE_RECORDED required fields include all writer-guaranteed fields', () => {
    const fields = DOMAIN_EVENT_SCHEMAS[DomainEventName.MODEL_TURN_USAGE_RECORDED] ?? [];
    for (const f of ['beadId', 'stateId', 'actionId', 'workerId', 'model',
      'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens',
      'totalTokens', 'costTotal', 'durationMs']) {
      expect(fields, `required field ${f} must be in the schema`).toContain(f);
    }
  });

  it('TOOL_PAYLOAD_ACCOUNTED required fields include writer-guaranteed tool + byte/token counts', () => {
    const fields = DOMAIN_EVENT_SCHEMAS[DomainEventName.TOOL_PAYLOAD_ACCOUNTED] ?? [];
    for (const f of ['tool', 'modelFacingBytes', 'estimatedTokens', 'cached']) {
      expect(fields, `required field ${f} must be in the schema`).toContain(f);
    }
  });

  it('MODEL_TURN_USAGE_RECORDED optional fields do NOT include prompt-body fields', () => {
    const meta = DOMAIN_EVENT_SCHEMA_METADATA[DomainEventName.MODEL_TURN_USAGE_RECORDED];
    expect(meta).toBeDefined();
    const optional = meta!.optionalFields;
    // Body/content fields must never appear in this event
    for (const forbidden of ['promptBody', 'rawContent', 'logOutput', 'sourceFile']) {
      expect(optional).not.toContain(forbidden);
    }
  });

  it('TOOL_PAYLOAD_ACCOUNTED optional fields do NOT include raw output body fields', () => {
    const meta = DOMAIN_EVENT_SCHEMA_METADATA[DomainEventName.TOOL_PAYLOAD_ACCOUNTED];
    expect(meta).toBeDefined();
    const optional = meta!.optionalFields;
    // Raw body/log fields must never appear in this event
    for (const forbidden of ['rawOutputBody', 'logOutput', 'sourceFile', 'promptBody']) {
      expect(optional).not.toContain(forbidden);
    }
  });

  it('both new events have AUDIT replayImpact (accounting, not replay-critical)', () => {
    expect(DOMAIN_EVENT_SCHEMA_METADATA[DomainEventName.MODEL_TURN_USAGE_RECORDED]?.replayImpact).toBe('AUDIT');
    expect(DOMAIN_EVENT_SCHEMA_METADATA[DomainEventName.TOOL_PAYLOAD_ACCOUNTED]?.replayImpact).toBe('AUDIT');
  });
});

// ---------------------------------------------------------------------------
// AC2 — Schema content: stable identifiers, provider/model/tool, byte/token counts,
//         idempotency keys
// ---------------------------------------------------------------------------

describe('AC2: schema content covers required fields', () => {
  it('ModelTurnAccountingEvent schema has stable id and correct version', () => {
    const entry = schemaRegistry.getEntry(SchemaId.MODEL_TURN_USAGE);
    expect(entry.id).toBe('harness.accounting.modelTurnUsage');
    expect(entry.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(entry.replayPolicy).toBe('BEST_EFFORT');
    expect(entry.owner).toBeTruthy();
  });

  it('ToolPayloadAccountingEvent schema has stable id and correct version', () => {
    const entry = schemaRegistry.getEntry(SchemaId.TOOL_PAYLOAD);
    expect(entry.id).toBe('harness.accounting.toolPayload');
    expect(entry.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(entry.replayPolicy).toBe('BEST_EFFORT');
    expect(entry.owner).toBeTruthy();
  });

  it('ModelTurnAccountingEvent schema requires model field (provider name lives in schema)', () => {
    const required = schemaRegistry.getEntry(SchemaId.MODEL_TURN_USAGE).jsonSchema['required'] as string[];
    expect(required).toContain('model');
  });

  it('ModelTurnAccountingEvent schema allows optional provider field', () => {
    const props = schemaRegistry.getEntry(SchemaId.MODEL_TURN_USAGE).jsonSchema['properties'] as Record<string, unknown>;
    expect(props['provider']).toBeDefined();
  });

  it('ModelTurnAccountingEvent schema allows optional idempotencyKey field', () => {
    const props = schemaRegistry.getEntry(SchemaId.MODEL_TURN_USAGE).jsonSchema['properties'] as Record<string, unknown>;
    expect(props['idempotencyKey']).toBeDefined();
  });

  it('ToolPayloadAccountingEvent schema allows optional toolInvocationId field', () => {
    const props = schemaRegistry.getEntry(SchemaId.TOOL_PAYLOAD).jsonSchema['properties'] as Record<string, unknown>;
    expect(props['toolInvocationId']).toBeDefined();
  });

  it('ToolPayloadAccountingEvent schema allows optional idempotencyKey field', () => {
    const props = schemaRegistry.getEntry(SchemaId.TOOL_PAYLOAD).jsonSchema['properties'] as Record<string, unknown>;
    expect(props['idempotencyKey']).toBeDefined();
  });

  it('buildModelTurnIdempotencyKey produces stable, deterministic key', () => {
    const key1 = buildModelTurnIdempotencyKey('act-1', 'worker-1', 'Planning');
    const key2 = buildModelTurnIdempotencyKey('act-1', 'worker-1', 'Planning');
    expect(key1).toBe(key2);
    expect(key1).toBe('act-1:worker-1:Planning');
  });

  it('buildToolPayloadIdempotencyKey includes toolInvocationId when provided', () => {
    const key = buildToolPayloadIdempotencyKey('my_tool', 'inv-123', 'bead-abc');
    expect(key).toBe('inv-123:bead-abc');
  });

  it('buildToolPayloadIdempotencyKey falls back to tool name when no invocationId', () => {
    const key = buildToolPayloadIdempotencyKey('my_tool', undefined, 'bead-abc');
    expect(key).toBe('my_tool:bead-abc');
  });

  it('buildToolPayloadIdempotencyKey uses "global" when no beadId', () => {
    const key = buildToolPayloadIdempotencyKey('my_tool', 'inv-123', undefined);
    expect(key).toBe('inv-123:global');
  });
});

// ---------------------------------------------------------------------------
// AC3 — Schema rejects prompt bodies, raw output bodies, source files, logs
//          (enforced by additionalProperties: false in both schemas)
// ---------------------------------------------------------------------------

describe('AC3: schemas reject prompt/body/log fields (additionalProperties: false)', () => {
  const modelTurnValidator = () => schemaRegistry.getValidator(SchemaId.MODEL_TURN_USAGE);
  const toolPayloadValidator = () => schemaRegistry.getValidator(SchemaId.TOOL_PAYLOAD);

  const minimalModelTurn: ModelTurnAccountingEvent = {
    beadId: 'bead-1',
    stateId: 'Planning',
    actionId: 'act-1',
    workerId: 'worker-1',
    model: 'claude-opus-4-5',
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 150,
    costTotal: 0,
    durationMs: 1000
  };

  const minimalToolPayload: ToolPayloadAccountingEvent = {
    tool: 'my_tool',
    modelFacingBytes: 512,
    estimatedTokens: 128,
    cached: false
  };

  it('MODEL_TURN_USAGE schema rejects promptBody field', () => {
    const validate = modelTurnValidator();
    const invalid = { ...minimalModelTurn, promptBody: 'You are a helpful assistant...' };
    expect(validate(invalid)).toBe(false);
  });

  it('MODEL_TURN_USAGE schema rejects rawContent field', () => {
    const validate = modelTurnValidator();
    const invalid = { ...minimalModelTurn, rawContent: '<tool_result>...</tool_result>' };
    expect(validate(invalid)).toBe(false);
  });

  it('MODEL_TURN_USAGE schema rejects logOutput field', () => {
    const validate = modelTurnValidator();
    const invalid = { ...minimalModelTurn, logOutput: 'INFO: started run' };
    expect(validate(invalid)).toBe(false);
  });

  it('MODEL_TURN_USAGE schema rejects sourceFile field', () => {
    const validate = modelTurnValidator();
    const invalid = { ...minimalModelTurn, sourceFile: '/src/core/Orchestrator.ts' };
    expect(validate(invalid)).toBe(false);
  });

  it('TOOL_PAYLOAD schema rejects rawOutputBody field', () => {
    const validate = toolPayloadValidator();
    const invalid = { ...minimalToolPayload, rawOutputBody: '<large tool output>' };
    expect(validate(invalid)).toBe(false);
  });

  it('TOOL_PAYLOAD schema rejects logOutput field', () => {
    const validate = toolPayloadValidator();
    const invalid = { ...minimalToolPayload, logOutput: 'tool execution log' };
    expect(validate(invalid)).toBe(false);
  });

  it('TOOL_PAYLOAD schema rejects sourceFile field', () => {
    const validate = toolPayloadValidator();
    const invalid = { ...minimalToolPayload, sourceFile: '/src/some/file.ts' };
    expect(validate(invalid)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC5 — Success, schema rejection, and replay validation for both event types
// ---------------------------------------------------------------------------

describe('AC5: success, rejection, and replay validation — MODEL_TURN_USAGE_RECORDED', () => {
  const validate = () => schemaRegistry.getValidator(SchemaId.MODEL_TURN_USAGE);

  it('accepts a minimal valid model-turn accounting payload', () => {
    const payload: ModelTurnAccountingEvent = {
      beadId: 'bead-abc',
      stateId: 'Planning',
      actionId: 'formulate-plan',
      workerId: 'worker-1',
      model: 'claude-opus-4-5',
      inputTokens: 1200,
      outputTokens: 800,
      cacheReadTokens: 300,
      cacheWriteTokens: 100,
      totalTokens: 2400,
      costTotal: 0.33,
      durationMs: 2500
    };
    expect(validate()(payload)).toBe(true);
  });

  it('accepts payload with optional provider and idempotencyKey', () => {
    const payload: ModelTurnAccountingEvent = {
      beadId: 'bead-abc',
      stateId: 'Planning',
      actionId: 'formulate-plan',
      workerId: 'worker-1',
      model: 'claude-opus-4-5',
      provider: 'anthropic',
      inputTokens: 500,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 700,
      costTotal: 0.0,
      durationMs: 1200,
      idempotencyKey: buildModelTurnIdempotencyKey('formulate-plan', 'worker-1', 'Planning')
    };
    expect(validate()(payload)).toBe(true);
  });

  it('rejects payload missing required model field', () => {
    const payload = {
      beadId: 'bead-abc',
      stateId: 'Planning',
      actionId: 'formulate-plan',
      workerId: 'worker-1',
      // model is missing
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 150,
      costTotal: 0,
      durationMs: 1000
    };
    expect(validate()(payload)).toBe(false);
  });

  it('rejects payload with negative totalTokens', () => {
    const payload = {
      beadId: 'bead-abc',
      stateId: 'Planning',
      actionId: 'formulate-plan',
      workerId: 'worker-1',
      model: 'claude-opus-4-5',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: -1,
      costTotal: 0,
      durationMs: 1000
    };
    expect(validate()(payload)).toBe(false);
  });

  it('rejects payload missing beadId (required for replay)', () => {
    const payload = {
      stateId: 'Planning',
      actionId: 'formulate-plan',
      workerId: 'worker-1',
      model: 'claude-opus-4-5',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 150,
      costTotal: 0,
      durationMs: 1000
    };
    expect(validate()(payload)).toBe(false);
  });

  it('rejects string totalTokens (must be integer)', () => {
    const payload = {
      beadId: 'bead-abc',
      stateId: 'Planning',
      actionId: 'formulate-plan',
      workerId: 'worker-1',
      model: 'claude-opus-4-5',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 'one hundred fifty',
      costTotal: 0,
      durationMs: 1000
    };
    expect(validate()(payload)).toBe(false);
  });

  it('replay: same payload validates consistently (idempotent)', () => {
    const payload: ModelTurnAccountingEvent = {
      beadId: 'bead-replay',
      stateId: 'Implementation',
      actionId: 'act-impl',
      workerId: 'w-2',
      model: 'claude-sonnet-4-6',
      inputTokens: 400,
      outputTokens: 200,
      cacheReadTokens: 50,
      cacheWriteTokens: 25,
      totalTokens: 675,
      costTotal: 0.05,
      durationMs: 3000,
      idempotencyKey: buildModelTurnIdempotencyKey('act-impl', 'w-2', 'Implementation')
    };
    const v = validate();
    expect(v(payload)).toBe(true);
    // Second validation must produce the same result (no mutation)
    expect(v(payload)).toBe(true);
  });
});

describe('AC5: success, rejection, and replay validation — TOOL_PAYLOAD_ACCOUNTED', () => {
  const validate = () => schemaRegistry.getValidator(SchemaId.TOOL_PAYLOAD);

  it('accepts a minimal valid tool-payload accounting payload (no bead context)', () => {
    const payload: ToolPayloadAccountingEvent = {
      tool: 'my_tool',
      modelFacingBytes: 1024,
      estimatedTokens: 256,
      cached: false
    };
    expect(validate()(payload)).toBe(true);
  });

  it('accepts payload with all optional fields including idempotencyKey', () => {
    const invId = '01935c28-1234-7abc-def0-123456789abc';
    const payload: ToolPayloadAccountingEvent = {
      tool: 'my_tool',
      modelFacingBytes: 4096,
      estimatedTokens: 1024,
      cached: true,
      beadId: 'bead-xyz',
      stateId: 'Implementation',
      actionId: 'act-1',
      toolInvocationId: invId,
      idempotencyKey: buildToolPayloadIdempotencyKey('my_tool', invId, 'bead-xyz')
    };
    expect(validate()(payload)).toBe(true);
  });

  it('accepts cached tool-payload accounting (cached: true)', () => {
    const payload: ToolPayloadAccountingEvent = {
      tool: 'cached_tool',
      modelFacingBytes: 512,
      estimatedTokens: 128,
      cached: true
    };
    expect(validate()(payload)).toBe(true);
  });

  it('rejects payload missing required tool field', () => {
    const payload = {
      modelFacingBytes: 1024,
      estimatedTokens: 256,
      cached: false
    };
    expect(validate()(payload)).toBe(false);
  });

  it('rejects payload with negative modelFacingBytes', () => {
    const payload = {
      tool: 'my_tool',
      modelFacingBytes: -1,
      estimatedTokens: 256,
      cached: false
    };
    expect(validate()(payload)).toBe(false);
  });

  it('rejects payload with non-boolean cached field', () => {
    const payload = {
      tool: 'my_tool',
      modelFacingBytes: 100,
      estimatedTokens: 25,
      cached: 'yes' // must be boolean
    };
    expect(validate()(payload)).toBe(false);
  });

  it('rejects payload missing cached field', () => {
    const payload = {
      tool: 'my_tool',
      modelFacingBytes: 100,
      estimatedTokens: 25
    };
    expect(validate()(payload)).toBe(false);
  });

  it('replay: same payload validates consistently (idempotent)', () => {
    const payload: ToolPayloadAccountingEvent = {
      tool: 'replay_tool',
      modelFacingBytes: 2048,
      estimatedTokens: 512,
      cached: false,
      beadId: 'bead-replay',
      stateId: 'Planning',
      actionId: 'act-replay',
      toolInvocationId: 'inv-replay-123',
      idempotencyKey: buildToolPayloadIdempotencyKey('replay_tool', 'inv-replay-123', 'bead-replay')
    };
    const v = validate();
    expect(v(payload)).toBe(true);
    // Second validation must produce the same result (no mutation)
    expect(v(payload)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Registry conformance — both new schema ids must be in REQUIRED_BOUNDARY_IDS
// ---------------------------------------------------------------------------

describe('Registry conformance: accounting schemas in REQUIRED_BOUNDARY_IDS', () => {
  it('SchemaId.MODEL_TURN_USAGE is in REQUIRED_BOUNDARY_IDS', () => {
    expect(REQUIRED_BOUNDARY_IDS.has(SchemaId.MODEL_TURN_USAGE)).toBe(true);
  });

  it('SchemaId.TOOL_PAYLOAD is in REQUIRED_BOUNDARY_IDS', () => {
    expect(REQUIRED_BOUNDARY_IDS.has(SchemaId.TOOL_PAYLOAD)).toBe(true);
  });

  it('both accounting schemas are registered in the singleton registry', () => {
    expect(schemaRegistry.has(SchemaId.MODEL_TURN_USAGE)).toBe(true);
    expect(schemaRegistry.has(SchemaId.TOOL_PAYLOAD)).toBe(true);
  });

  it('both schemas have at least one positive and one negative fixture', () => {
    for (const id of [SchemaId.MODEL_TURN_USAGE, SchemaId.TOOL_PAYLOAD]) {
      const entry = schemaRegistry.getEntry(id);
      expect(entry.positiveFixtures.length, `${id} must have positive fixtures`).toBeGreaterThan(0);
      expect(entry.negativeFixtures.length, `${id} must have negative fixtures`).toBeGreaterThan(0);
    }
  });

  it('positive fixtures for MODEL_TURN_USAGE pass validation', () => {
    const entry = schemaRegistry.getEntry(SchemaId.MODEL_TURN_USAGE);
    const validate = schemaRegistry.getValidator(SchemaId.MODEL_TURN_USAGE);
    for (const fixture of entry.positiveFixtures) {
      expect(validate(fixture.value), `positive fixture "${fixture.label}" must pass`).toBe(true);
    }
  });

  it('negative fixtures for MODEL_TURN_USAGE fail validation', () => {
    const entry = schemaRegistry.getEntry(SchemaId.MODEL_TURN_USAGE);
    const validate = schemaRegistry.getValidator(SchemaId.MODEL_TURN_USAGE);
    for (const fixture of entry.negativeFixtures) {
      expect(validate(fixture.value), `negative fixture "${fixture.label}" must fail`).toBe(false);
    }
  });

  it('positive fixtures for TOOL_PAYLOAD pass validation', () => {
    const entry = schemaRegistry.getEntry(SchemaId.TOOL_PAYLOAD);
    const validate = schemaRegistry.getValidator(SchemaId.TOOL_PAYLOAD);
    for (const fixture of entry.positiveFixtures) {
      expect(validate(fixture.value), `positive fixture "${fixture.label}" must pass`).toBe(true);
    }
  });

  it('negative fixtures for TOOL_PAYLOAD fail validation', () => {
    const entry = schemaRegistry.getEntry(SchemaId.TOOL_PAYLOAD);
    const validate = schemaRegistry.getValidator(SchemaId.TOOL_PAYLOAD);
    for (const fixture of entry.negativeFixtures) {
      expect(validate(fixture.value), `negative fixture "${fixture.label}" must fail`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Distinct schema validation — model-turn vs tool-payload are NOT interchangeable
// ---------------------------------------------------------------------------

describe('Distinct schema validation: model-turn vs tool-payload are strictly separate', () => {
  it('a valid MODEL_TURN payload fails TOOL_PAYLOAD validation', () => {
    const modelTurnPayload: ModelTurnAccountingEvent = {
      beadId: 'bead-1',
      stateId: 'Planning',
      actionId: 'act-1',
      workerId: 'worker-1',
      model: 'claude-opus-4-5',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 150,
      costTotal: 0,
      durationMs: 1000
    };
    const toolValidator = schemaRegistry.getValidator(SchemaId.TOOL_PAYLOAD);
    // A model-turn payload is missing 'tool', 'modelFacingBytes', 'estimatedTokens', 'cached'
    // and has extra fields that TOOL_PAYLOAD does not allow (additionalProperties: false)
    expect(toolValidator(modelTurnPayload)).toBe(false);
  });

  it('a valid TOOL_PAYLOAD payload fails MODEL_TURN validation', () => {
    const toolPayload: ToolPayloadAccountingEvent = {
      tool: 'my_tool',
      modelFacingBytes: 512,
      estimatedTokens: 128,
      cached: false
    };
    const modelTurnValidator = schemaRegistry.getValidator(SchemaId.MODEL_TURN_USAGE);
    // A tool-payload is missing all required model-turn fields
    expect(modelTurnValidator(toolPayload)).toBe(false);
  });
});
