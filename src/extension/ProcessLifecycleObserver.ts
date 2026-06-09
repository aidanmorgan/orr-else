/**
 * ProcessLifecycleObserver — idempotent process-event registration.
 *
 * pi-experiment-amq0.1: extracted from extension.ts.
 *
 * The guard is module-level (not session-level) because process.on() listeners
 * are permanent for the lifetime of the OS process.  Registering them more than
 * once per process produces duplicate log lines and triggers
 * MaxListenersExceededWarning.  A session-level guard would be reset on every
 * fresh orrElseExtension() call, causing a second call to re-register.
 */
import { Logger } from '../core/Logger.js';
import { Component, ProcessEventName } from '../constants/infra.js';

/** Injected port: resolves whether the current process is a worker. */
export interface ProcessLifecycleObserverPorts {
  isWorkerMode: () => boolean;
}

/**
 * Process-global idempotency guard.
 *
 * Intentionally NOT part of ExtensionSession: it guards process.on() calls on
 * the Node.js `process` object, which is shared across all invocations within
 * the same OS process.  Moving it to ExtensionSession (always false at session
 * creation) would cause a second orrElseExtension() call to add four duplicate
 * permanent process listeners, triggering MaxListenersExceededWarning and
 * leaking listeners on every subsequent re-invocation.
 */
let _processLifecycleObserversRegistered = false;

/**
 * Register permanent process lifecycle observers idempotently (once per process).
 *
 * Subsequent calls are no-ops — the guard is module-level, not session-level.
 */
export function registerProcessLifecycleObservers(ports: ProcessLifecycleObserverPorts): void {
  if (_processLifecycleObserversRegistered) return;
  _processLifecycleObserversRegistered = true;

  process.on(ProcessEventName.BEFORE_EXIT, code => {
    Logger.warn(Component.ORR_ELSE, 'Pi process beforeExit observed', { code, isWorker: ports.isWorkerMode() });
  });
  process.on(ProcessEventName.EXIT, code => {
    Logger.warn(Component.ORR_ELSE, 'Pi process exit observed', { code, isWorker: ports.isWorkerMode() });
  });
  process.on(ProcessEventName.UNCAUGHT_EXCEPTION_MONITOR, error => {
    Logger.error(Component.ORR_ELSE, 'Uncaught exception observed', {
      error: String(error),
      stack: error instanceof Error ? error.stack : undefined,
      isWorker: ports.isWorkerMode()
    });
  });
  process.on(ProcessEventName.UNHANDLED_REJECTION, reason => {
    Logger.error(Component.ORR_ELSE, 'Unhandled rejection observed', {
      error: String(reason),
      isWorker: ports.isWorkerMode()
    });
  });
}

/**
 * Reset the process-global guard (test use only).
 *
 * Allows test isolation without touching the real process.on() calls.
 * NEVER call this in production code.
 */
export function _resetProcessLifecycleObserversGuard(): void {
  _processLifecycleObserversRegistered = false;
}
