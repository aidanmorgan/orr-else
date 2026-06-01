import { describe, expect, it } from 'vitest';
import { isRestartTransition } from '../src/core/EventUtils.js';
import { EventName } from '../src/constants/index.js';

describe('isRestartTransition', () => {
  it('returns true for RESTART', () => {
    expect(isRestartTransition(EventName.RESTART)).toBe(true);
  });

  it('returns true for CONTEXT_RESTART', () => {
    expect(isRestartTransition(EventName.CONTEXT_RESTART)).toBe(true);
  });

  it('returns true for HARNESS_RESTART', () => {
    expect(isRestartTransition(EventName.HARNESS_RESTART)).toBe(true);
  });

  it('returns false for SUCCESS', () => {
    expect(isRestartTransition(EventName.SUCCESS)).toBe(false);
  });

  it('returns false for FAILURE', () => {
    expect(isRestartTransition(EventName.FAILURE)).toBe(false);
  });

  it('returns false for null', () => {
    expect(isRestartTransition(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isRestartTransition(undefined)).toBe(false);
  });

  it('returns false for an unrelated string', () => {
    expect(isRestartTransition('BLOCKED')).toBe(false);
  });
});
