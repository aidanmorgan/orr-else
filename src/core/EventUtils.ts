import { EventName } from '../constants/domain.js';

/**
 * Returns true when the given transition event value represents any kind of restart
 * (RESTART, CONTEXT_RESTART, or HARNESS_RESTART).  Accepts `unknown` because the
 * value is read directly from untyped event payloads.
 */
export function isRestartTransition(transitionEvent: unknown): boolean {
  return transitionEvent === EventName.RESTART
    || transitionEvent === EventName.CONTEXT_RESTART
    || transitionEvent === EventName.HARNESS_RESTART;
}
