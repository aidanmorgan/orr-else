/**
 * ExtensionBootstrap — thin composition root for orrElseExtension.
 *
 * pi-experiment-amq0.1: extracted from extension.ts.
 *
 * This module provides the `bootstrapExtension()` function that wires all
 * injectable services together and calls `registerPiLifecycleCallbacks` to
 * bind the Pi lifecycle handlers.  It is the single place that knows which
 * concrete service implementations to assemble.
 *
 * orrElseExtension() delegates to bootstrapExtension() after creating the
 * session and services, keeping itself as a thin Pi-facing entrypoint.
 *
 * SCOPE: This bootstrap handles only the structural wiring that was previously
 * inlined at the top of orrElseExtension (registerBuiltInVerifiers, Logger
 * configuration, registerProcessLifecycleObservers, command registration).
 * The Pi lifecycle handler BODIES remain in extension.ts as closures over the
 * session; PiRegistrationService merely binds them to the Pi instance.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { RuntimeServices } from '../composition/createRuntimeServices.js';
import { registerBuiltInVerifiers } from '../tools/index.js';
import { Logger } from '../core/Logger.js';
import { Component, App } from '../constants/index.js';
import { registerProcessLifecycleObservers } from './ProcessLifecycleObserver.js';
import { registerPiLifecycleCallbacks, type PiLifecycleHandlers } from './PiRegistrationService.js';
import type { PiEventName } from '../constants/index.js';

/**
 * Injected ports for ExtensionBootstrap.
 */
export interface ExtensionBootstrapPorts {
  services: RuntimeServices;
  isWorkerMode: () => boolean;
  piEventNames: {
    SESSION_SHUTDOWN: string;
    BEFORE_AGENT_START: string;
    RESOURCES_DISCOVER: string;
    SESSION_START: string;
  };
}

/**
 * Bootstrap the extension by wiring all injectable services and registering
 * Pi lifecycle callbacks.
 *
 * Called once per orrElseExtension() invocation after the session and services
 * have been created.
 *
 * @param pi - The Pi extension API instance.
 * @param ports - Injected ports (services + helpers).
 * @param handlers - Pi lifecycle handler bodies (provided by extension.ts closures).
 */
export function bootstrapExtension(
  pi: ExtensionAPI,
  ports: ExtensionBootstrapPorts,
  handlers: PiLifecycleHandlers
): void {
  const { services, isWorkerMode } = ports;

  // Self-register the harness's OWN built-in tools' verify() callbacks (e.g. git_history).
  registerBuiltInVerifiers();

  // Point the Logger's rotating-file transport at the injected project root.
  Logger.configureProjectRoot(services.projectRoot);

  // Register permanent process lifecycle observers (idempotent — module-level guard).
  registerProcessLifecycleObservers({ isWorkerMode });

  Logger.info(Component.ORR_ELSE, 'Orr Else extension loading', { version: App.VERSION });

  // Wire Pi lifecycle callbacks through PiRegistrationService.
  registerPiLifecycleCallbacks(pi, handlers, ports.piEventNames);
}
