/**
 * PiRegistrationService — Pi lifecycle callback registration.
 *
 * pi-experiment-amq0.1: extracted from extension.ts.
 *
 * Provides a single `register()` method that wires all `pi.on(...)` lifecycle
 * handlers idempotently.  orrElseExtension calls this once per invocation;
 * subsequent invocations with a fresh `pi` instance re-register on the new
 * Pi instance (session-level guard).
 *
 * The registration service does NOT own the handler logic — it delegates to
 * the callbacks provided by the composition root (orrElseExtension /
 * ExtensionBootstrap).  This keeps orrElseExtension as the thin composition
 * entrypoint and makes the Pi-event wiring testable without a real Pi instance.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/**
 * Callbacks injected into PiRegistrationService by the composition root.
 *
 * Each handler is the actual Pi event handler body — the registration service
 * only calls `pi.on(eventName, handler)`.
 */
export interface PiLifecycleHandlers {
  onSessionShutdown: () => unknown | Promise<unknown>;
  onBeforeAgentStart: (event: import('@earendil-works/pi-coding-agent').BeforeAgentStartEvent) => unknown | Promise<unknown>;
  onResourcesDiscover: () => unknown | Promise<unknown>;
  onSessionStart: (
    event: import('@earendil-works/pi-coding-agent').SessionStartEvent,
    ctx: import('@earendil-works/pi-coding-agent').ExtensionContext
  ) => unknown | Promise<unknown>;
}

/**
 * Register Pi lifecycle callbacks on a Pi extension API instance.
 *
 * Idempotent at the session level — the session guard in ExtensionSession
 * (registration flags) prevents duplicate Pi tool registrations; this function
 * is responsible only for the `pi.on(...)` lifecycle wiring.
 *
 * Called once per `orrElseExtension()` invocation with the new `pi` instance.
 */
export function registerPiLifecycleCallbacks(
  pi: ExtensionAPI,
  handlers: PiLifecycleHandlers,
  eventNames: {
    SESSION_SHUTDOWN: string;
    BEFORE_AGENT_START: string;
    RESOURCES_DISCOVER: string;
    SESSION_START: string;
  }
): void {
  pi.on(eventNames.SESSION_SHUTDOWN as any, handlers.onSessionShutdown as any);
  pi.on(eventNames.BEFORE_AGENT_START as any, handlers.onBeforeAgentStart as any);
  pi.on(eventNames.RESOURCES_DISCOVER as any, handlers.onResourcesDiscover as any);
  pi.on(eventNames.SESSION_START as any, handlers.onSessionStart as any);
}
