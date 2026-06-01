/**
 * Focused unit tests for extracted extension controller modules.
 *
 * Covers PiEventAdapters (event parsing / result classification) and
 * AgentLifecycleController (failure classification and lifecycle signaling).
 * These tests strengthen coverage for logic extracted from extension.ts and
 * complement the integration-level pi_extension.test.ts coverage.
 */

import { describe, expect, it, vi } from 'vitest';

// ── PiEventAdapters ──────────────────────────────────────────────────────────

import {
  isRecord,
  summarizeForEvent,
  textIndicatesFailure,
  contentIndicatesFailure,
  nestedResultIndicatesFailure,
  resultIndicatesFailure,
  resultIndicatesSuccess,
  externalPiToolEventIndicatesFailure,
  externalPiToolResultFromEvent,
  agentEventError,
  eventToolCallId,
  stringifySpanAttribute
} from '../src/extension/PiEventAdapters.js';

describe('PiEventAdapters', () => {
  describe('isRecord', () => {
    it('returns true for plain objects', () => {
      expect(isRecord({})).toBe(true);
      expect(isRecord({ a: 1 })).toBe(true);
    });

    it('returns false for arrays, null, primitives', () => {
      expect(isRecord([])).toBe(false);
      expect(isRecord(null)).toBe(false);
      expect(isRecord(undefined)).toBe(false);
      expect(isRecord(42)).toBe(false);
      expect(isRecord('string')).toBe(false);
    });
  });

  describe('textIndicatesFailure', () => {
    it('detects Error/Failed/REJECTED prefixes', () => {
      expect(textIndicatesFailure('Error: something')).toBe(true);
      expect(textIndicatesFailure('Failed to run')).toBe(true);
      expect(textIndicatesFailure('REJECTED: bad')).toBe(true);
    });

    it('returns false for success text', () => {
      expect(textIndicatesFailure('PASSED')).toBe(false);
      expect(textIndicatesFailure('OK')).toBe(false);
      expect(textIndicatesFailure('')).toBe(false);
    });
  });

  describe('contentIndicatesFailure', () => {
    it('detects failure in string content', () => {
      expect(contentIndicatesFailure('Error: bad')).toBe(true);
    });

    it('detects failure in content array text items', () => {
      const content = [{ type: 'text', text: 'Error: bad thing' }];
      expect(contentIndicatesFailure(content)).toBe(true);
    });

    it('returns false for passing content', () => {
      expect(contentIndicatesFailure([{ type: 'text', text: 'All good' }])).toBe(false);
      expect(contentIndicatesFailure(null)).toBe(false);
    });
  });

  describe('nestedResultIndicatesFailure', () => {
    it('detects isError:true', () => {
      expect(nestedResultIndicatesFailure({ isError: true })).toBe(true);
    });

    it('detects success:false', () => {
      expect(nestedResultIndicatesFailure({ success: false })).toBe(true);
    });

    it('detects REJECTED status', () => {
      expect(nestedResultIndicatesFailure({ status: 'REJECTED' })).toBe(true);
    });

    it('detects non-empty error string', () => {
      expect(nestedResultIndicatesFailure({ error: 'something failed' })).toBe(true);
    });

    it('returns false for passing record', () => {
      expect(nestedResultIndicatesFailure({ status: 'PASSED', success: true })).toBe(false);
    });

    it('recurses into details', () => {
      expect(nestedResultIndicatesFailure({ details: { isError: true } })).toBe(true);
    });
  });

  describe('resultIndicatesFailure', () => {
    it('detects string failure', () => {
      expect(resultIndicatesFailure('Error: bad')).toBe(true);
    });

    it('detects object failure', () => {
      expect(resultIndicatesFailure({ isError: true })).toBe(true);
    });

    it('returns false for null/undefined', () => {
      expect(resultIndicatesFailure(null)).toBe(false);
      expect(resultIndicatesFailure(undefined)).toBe(false);
    });
  });

  describe('resultIndicatesSuccess', () => {
    it('detects success:true', () => {
      expect(resultIndicatesSuccess({ success: true })).toBe(true);
    });

    it('detects PASSED status', () => {
      expect(resultIndicatesSuccess({ status: 'PASSED' })).toBe(true);
    });

    it('returns false for non-objects', () => {
      expect(resultIndicatesSuccess('ok')).toBe(false);
      expect(resultIndicatesSuccess(null)).toBe(false);
    });
  });

  describe('agentEventError', () => {
    it('extracts direct string error', () => {
      expect(agentEventError({ error: 'direct error' })).toBe('direct error');
    });

    it('extracts errorMessage from error object', () => {
      expect(agentEventError({ error: { errorMessage: 'nested' } })).toBe('nested');
    });

    it('extracts error from message with stopReason=error', () => {
      const event = { message: { stopReason: 'error', errorMessage: 'stop error' } };
      expect(agentEventError(event)).toBe('stop error');
    });

    it('extracts error from messages array', () => {
      const event = { messages: [{ stopReason: 'error', errorMessage: 'msg error' }] };
      expect(agentEventError(event)).toBe('msg error');
    });

    it('returns null for clean events', () => {
      expect(agentEventError({ message: { stopReason: 'end_turn' } })).toBeNull();
      expect(agentEventError({})).toBeNull();
    });
  });

  describe('eventToolCallId', () => {
    it('extracts string toolCallId', () => {
      expect(eventToolCallId({ toolCallId: 'abc-123' })).toBe('abc-123');
    });

    it('returns undefined for non-string or missing', () => {
      expect(eventToolCallId({ toolCallId: 42 })).toBeUndefined();
      expect(eventToolCallId({})).toBeUndefined();
    });
  });

  describe('externalPiToolEventIndicatesFailure', () => {
    it('detects isError:true', () => {
      expect(externalPiToolEventIndicatesFailure({ isError: true })).toBe(true);
    });

    it('detects failure in details', () => {
      expect(externalPiToolEventIndicatesFailure({ details: { isError: true } })).toBe(true);
    });

    it('detects failure in content', () => {
      expect(externalPiToolEventIndicatesFailure({ content: 'Error: bad' })).toBe(true);
    });

    it('returns false for clean tool events', () => {
      expect(externalPiToolEventIndicatesFailure({ content: 'ok', details: {} })).toBe(false);
    });
  });

  describe('externalPiToolResultFromEvent', () => {
    it('sets status PASSED for clean tool events', () => {
      const result = externalPiToolResultFromEvent({ toolName: 'my_tool', content: 'ok', details: {} });
      expect(result.status).toBe('PASSED');
      expect(result.isError).toBe(false);
      expect(result.tool).toBe('my_tool');
    });

    it('sets status REJECTED for failed tool events', () => {
      const result = externalPiToolResultFromEvent({ toolName: 'my_tool', isError: true, content: 'Error: bad', details: {} });
      expect(result.status).toBe('REJECTED');
      expect(result.isError).toBe(true);
    });
  });

  describe('summarizeForEvent', () => {
    it('returns undefined for undefined', () => {
      expect(summarizeForEvent(undefined)).toBeUndefined();
    });

    it('truncates long strings', () => {
      const longStr = 'x'.repeat(5000);
      const result = summarizeForEvent(longStr);
      expect(typeof result).toBe('string');
      expect((result as string).length).toBeLessThan(5000);
    });

    it('returns small objects as-is', () => {
      const obj = { key: 'value' };
      expect(summarizeForEvent(obj)).toEqual(obj);
    });
  });

  describe('stringifySpanAttribute', () => {
    it('returns string as-is', () => {
      expect(stringifySpanAttribute('hello')).toBe('hello');
    });

    it('JSON stringifies objects', () => {
      expect(stringifySpanAttribute({ a: 1 })).toBe('{"a":1}');
    });

    it('converts non-serializable values to String()', () => {
      const circular: any = {};
      circular.self = circular;
      expect(typeof stringifySpanAttribute(circular)).toBe('string');
    });
  });
});

// ── AgentLifecycleController ─────────────────────────────────────────────────

import {
  isContextOverflowFailure,
  isUsageLimitFailure,
  isHarnessTransientFailureInternal,
  compactLifecycleFailureSummary,
  handleAgentLifecycleFailure
} from '../src/extension/AgentLifecycleController.js';
import { postWorkerSignal } from '../src/extension/SignalController.js';
import { PiEventName, DomainEventName, TeammateEventType } from '../src/constants/index.js';

describe('AgentLifecycleController', () => {
  describe('isContextOverflowFailure', () => {
    it('detects context window overflow patterns', () => {
      expect(isContextOverflowFailure('context_length_exceeded')).toBe(true);
      expect(isContextOverflowFailure('context length exceeded')).toBe(true);
      expect(isContextOverflowFailure('context window full')).toBe(true);
      expect(isContextOverflowFailure('too many compactions')).toBe(true);
      expect(isContextOverflowFailure('auto-compact triggered')).toBe(true);
    });

    it('returns false for unrelated errors', () => {
      expect(isContextOverflowFailure('network error')).toBe(false);
      expect(isContextOverflowFailure('usage limit reached')).toBe(false);
    });
  });

  describe('isUsageLimitFailure', () => {
    it('detects usage limit patterns', () => {
      expect(isUsageLimitFailure('usage_limit_reached')).toBe(true);
      expect(isUsageLimitFailure('usage limit has been reached')).toBe(true);
    });

    it('returns false for unrelated errors', () => {
      expect(isUsageLimitFailure('network error')).toBe(false);
      expect(isUsageLimitFailure('context_length_exceeded')).toBe(false);
    });
  });

  describe('isHarnessTransientFailureInternal', () => {
    it('detects transient harness failures', () => {
      expect(isHarnessTransientFailureInternal('websocket error occurred')).toBe(true);
      expect(isHarnessTransientFailureInternal('websocket closed')).toBe(true);
      expect(isHarnessTransientFailureInternal('connection reset by peer')).toBe(true);
      expect(isHarnessTransientFailureInternal('network error')).toBe(true);
      expect(isHarnessTransientFailureInternal('Codex SSE response headers timed out after 10000ms')).toBe(true);
    });

    it('returns false for non-transient errors', () => {
      expect(isHarnessTransientFailureInternal('context_length_exceeded')).toBe(false);
      expect(isHarnessTransientFailureInternal('usage limit reached')).toBe(false);
    });
  });

  describe('compactLifecycleFailureSummary', () => {
    it('produces usage limit summary', () => {
      const summary = compactLifecycleFailureSummary(PiEventName.TURN_END, 'usage_limit_reached');
      expect(summary).toContain('usage limit');
      expect(summary).toContain(PiEventName.TURN_END);
    });

    it('produces context overflow summary', () => {
      const summary = compactLifecycleFailureSummary(PiEventName.AGENT_END, 'context_length_exceeded');
      expect(summary).toContain('context');
      expect(summary).toContain(PiEventName.AGENT_END);
    });

    it('produces harness transient summary', () => {
      const summary = compactLifecycleFailureSummary(PiEventName.TURN_END, 'websocket error');
      expect(summary).toContain('transient');
    });

    it('produces generic summary for unknown errors', () => {
      const summary = compactLifecycleFailureSummary(PiEventName.TURN_END, 'some unknown error');
      expect(summary).toContain('some unknown error');
      expect(summary).toContain(PiEventName.TURN_END);
    });

    it('truncates very long error messages', () => {
      const longError = 'x'.repeat(5000);
      const summary = compactLifecycleFailureSummary(PiEventName.TURN_END, longError);
      expect(summary.length).toBeLessThan(longError.length);
    });
  });

  describe('handleAgentLifecycleFailure', () => {
    function makeActiveRun(overrides: Partial<any> = {}) {
      return {
        beadId: 'bd-test',
        stateId: 'Planning',
        action: { id: 'formulate-plan' },
        worklogManager: { appendEntry: vi.fn().mockResolvedValue(undefined) },
        progressManager: { appendLog: vi.fn().mockResolvedValue(undefined) },
        ...overrides
      };
    }

    function makeServices(overrides: Partial<any> = {}) {
      return {
        eventStore: {
          record: vi.fn().mockResolvedValue(undefined),
          eventsForBead: vi.fn().mockResolvedValue([])
        },
        configLoader: {
          load: vi.fn().mockResolvedValue({
            settings: {},
            states: {},
            tools: []
          })
        },
        ...overrides
      } as any;
    }

    it('does nothing in non-worker mode', async () => {
      const services = makeServices();
      const ctx = { hasUI: false, shutdown: vi.fn() } as any;
      await handleAgentLifecycleFailure(
        { error: 'some error' },
        ctx,
        PiEventName.TURN_END,
        services,
        {
          isWorker: false, // non-worker
          activeRun: makeActiveRun(),
          agentFailureSignaled: false,
          setAgentFailureSignaled: vi.fn(),
          buildWorkerEvent: vi.fn()
        }
      );
      expect(services.eventStore.record).not.toHaveBeenCalled();
    });

    it('does nothing if agentFailureSignaled is already true', async () => {
      const services = makeServices();
      const ctx = { hasUI: false, shutdown: vi.fn() } as any;
      await handleAgentLifecycleFailure(
        { error: 'some error' },
        ctx,
        PiEventName.TURN_END,
        services,
        {
          isWorker: true,
          activeRun: makeActiveRun(),
          agentFailureSignaled: true, // already signaled
          setAgentFailureSignaled: vi.fn(),
          buildWorkerEvent: vi.fn()
        }
      );
      expect(services.eventStore.record).not.toHaveBeenCalled();
    });

    it('does nothing if no agent error is present', async () => {
      const services = makeServices();
      const ctx = { hasUI: false, shutdown: vi.fn() } as any;
      await handleAgentLifecycleFailure(
        { message: { stopReason: 'end_turn' } }, // no error
        ctx,
        PiEventName.TURN_END,
        services,
        {
          isWorker: true,
          activeRun: makeActiveRun(),
          agentFailureSignaled: false,
          setAgentFailureSignaled: vi.fn(),
          buildWorkerEvent: vi.fn()
        }
      );
      expect(services.eventStore.record).not.toHaveBeenCalled();
    });

    it('sets agentFailureSignaled and records AGENT_TURN_FAILED on error', async () => {
      const services = makeServices();
      const ctx = { hasUI: false, shutdown: vi.fn() } as any;
      const setAgentFailureSignaled = vi.fn();
      const buildWorkerEvent = vi.fn().mockReturnValue({ type: 'STATE_BLOCKED', idempotencyKey: 'key', beadId: 'bd-test' } as any);

      await handleAgentLifecycleFailure(
        { error: 'some unclassified error' },
        ctx,
        PiEventName.TURN_END,
        services,
        {
          isWorker: true,
          activeRun: makeActiveRun(),
          agentFailureSignaled: false,
          setAgentFailureSignaled,
          buildWorkerEvent
        }
      );

      expect(setAgentFailureSignaled).toHaveBeenCalledWith(true);
      const calls = (services.eventStore.record as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.some(([type]: [string]) => type === 'AGENT_TURN_FAILED')).toBe(true);
    });

    it('capacity-limit branch: records HARNESS_CAPACITY_LIMIT_REACHED and posts TEAMMATE_EXITED signal', async () => {
      const services = makeServices();
      const ctx = { hasUI: false, shutdown: vi.fn() } as any;
      const setAgentFailureSignaled = vi.fn();
      const exitedEvent = { type: TeammateEventType.TEAMMATE_EXITED, idempotencyKey: 'k1', beadId: 'bd-test' } as any;
      const buildWorkerEvent = vi.fn().mockReturnValue(exitedEvent);

      await handleAgentLifecycleFailure(
        { error: 'usage_limit_reached' },
        ctx,
        PiEventName.TURN_END,
        services,
        {
          isWorker: true,
          activeRun: makeActiveRun(),
          agentFailureSignaled: false,
          setAgentFailureSignaled,
          buildWorkerEvent
        }
      );

      const recordCalls = (services.eventStore.record as ReturnType<typeof vi.fn>).mock.calls;
      expect(recordCalls.some(([type]: [string]) => type === DomainEventName.AGENT_TURN_FAILED)).toBe(true);
      expect(recordCalls.some(([type]: [string]) => type === DomainEventName.HARNESS_CAPACITY_LIMIT_REACHED)).toBe(true);
      expect(buildWorkerEvent).toHaveBeenCalledWith(TeammateEventType.TEAMMATE_EXITED, expect.objectContaining({ capacityLimited: true }));
    });

    it('context-restart vs harness-restart branch: buildWorkerEvent called with correct TeammateEventType and transitionEvent', async () => {
      const contextRestartError = 'context_length_exceeded';
      const harnessRestartError = 'websocket error occurred';

      for (const [error, expectedType] of [
        [contextRestartError, TeammateEventType.CONTEXT_RESTART_REQUESTED],
        [harnessRestartError, TeammateEventType.HARNESS_RESTART_REQUESTED]
      ] as const) {
        const services = makeServices();
        const ctx = { hasUI: false, shutdown: vi.fn() } as any;
        const buildWorkerEvent = vi.fn().mockReturnValue({ type: expectedType, idempotencyKey: 'k', beadId: 'bd-test' } as any);

        await handleAgentLifecycleFailure(
          { error },
          ctx,
          PiEventName.TURN_END,
          services,
          {
            isWorker: true,
            activeRun: makeActiveRun(),
            agentFailureSignaled: false,
            setAgentFailureSignaled: vi.fn(),
            buildWorkerEvent
          }
        );

        const recordCalls = (services.eventStore.record as ReturnType<typeof vi.fn>).mock.calls;
        expect(recordCalls.some(([type]: [string]) => type === DomainEventName.AGENT_TURN_FAILED)).toBe(true);
        expect(buildWorkerEvent).toHaveBeenCalledWith(expectedType, expect.objectContaining({ transitionEvent: expect.any(String) }));
      }
    });
  });
});

// ── SignalController ──────────────────────────────────────────────────────────

import { buildWorkerEventFrom, teammateSignalEventData } from '../src/extension/SignalController.js';
import { WorkerDefaults } from '../src/constants/index.js';

describe('SignalController', () => {
  describe('buildWorkerEventFrom', () => {
    it('uses env beadId/stateId as fallbacks', () => {
      const event = buildWorkerEventFrom(
        'STATE_BLOCKED' as any,
        { summary: 'blocked' },
        { workerId: 'w-1', sessionStateId: undefined, beadId: 'bd-env', stateId: 'Planning' },
        WorkerDefaults.UNKNOWN_STATE_ID
      );
      expect(event.beadId).toBe('bd-env');
      expect(event.stateId).toBe('Planning');
      expect(event.workerId).toBe('w-1');
      expect(typeof event.idempotencyKey).toBe('string');
      expect(event.idempotencyKey.length).toBeGreaterThan(0);
    });

    it('prefers fields.beadId over env', () => {
      const event = buildWorkerEventFrom(
        'STATE_BLOCKED' as any,
        { beadId: 'bd-field', stateId: 'Implementation' },
        { workerId: 'w-1', sessionStateId: undefined, beadId: 'bd-env', stateId: 'Planning' },
        WorkerDefaults.UNKNOWN_STATE_ID
      );
      expect(event.beadId).toBe('bd-field');
      expect(event.stateId).toBe('Implementation');
    });

    it('falls back to unknownStateId when stateId is undefined', () => {
      const event = buildWorkerEventFrom(
        'STATE_BLOCKED' as any,
        {},
        { workerId: 'w-1', sessionStateId: undefined, beadId: undefined, stateId: undefined },
        WorkerDefaults.UNKNOWN_STATE_ID
      );
      expect(event.stateId).toBe(WorkerDefaults.UNKNOWN_STATE_ID);
    });

    it('sets timestamp and type', () => {
      const before = Date.now();
      const event = buildWorkerEventFrom(
        'CHECKPOINT_ACCEPTED' as any,
        { beadId: 'bd-1' },
        { workerId: 'w-1', sessionStateId: undefined, beadId: 'bd-1', stateId: 'Planning' },
        WorkerDefaults.UNKNOWN_STATE_ID
      );
      const after = Date.now();
      expect(event.type).toBe('CHECKPOINT_ACCEPTED');
      expect(event.timestamp).toBeGreaterThanOrEqual(before);
      expect(event.timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe('teammateSignalEventData', () => {
    it('serializes core fields', () => {
      const event = {
        type: 'STATE_TRANSITIONED',
        beadId: 'bd-1',
        workerId: 'w-1',
        sessionStateId: undefined,
        stateId: 'Planning',
        idempotencyKey: 'key-abc',
        actionId: 'act-1',
        transitionEvent: 'SUCCESS',
        summary: 'done'
      } as any;
      const data = teammateSignalEventData(event);
      expect(data.type).toBe('STATE_TRANSITIONED');
      expect(data.beadId).toBe('bd-1');
      expect(data.actionId).toBe('act-1');
      expect(data.transitionEvent).toBe('SUCCESS');
      expect(data.summary).toBe('done');
    });

    it('omits undefined optional fields', () => {
      const event = {
        type: 'HEARTBEAT',
        beadId: 'bd-1',
        workerId: 'w-1',
        sessionStateId: undefined,
        stateId: 'Planning',
        idempotencyKey: 'key-abc'
      } as any;
      const data = teammateSignalEventData(event);
      expect('actionId' in data).toBe(false);
      expect('transitionEvent' in data).toBe(false);
    });
  });
});
