/**
 * Composition root for RuntimeServices.
 *
 * This module is the ONLY place that imports concrete plugin implementations and
 * wires them into the core assembler. Core (src/core/) has no knowledge of plugin
 * construction; it only depends on the RuntimePlugin interface and PluginBundle.
 *
 * Callers that previously imported createRuntimeServices from src/core/RuntimeServices
 * should import it from here instead.
 */
import { createBdPlugin } from '../plugins/bd.js';
import { createGitPlugin } from '../plugins/git.js';
import { createMailboxPlugin } from '../plugins/mailbox.js';
import { createMetaPlugin } from '../plugins/meta.js';
import { createQualityPlugin } from '../plugins/quality.js';
import { signalingPlugin } from '../plugins/signaling.js';
import { TeammateFactory, teammatePlugin } from '../plugins/teammates.js';
import { ConfigLoader } from '../core/ConfigLoader.js';
import { EventStore } from '../core/EventStore.js';
import { Observability } from '../core/Observability.js';
import { nodeRuntimeEnvironment, type RuntimeEnvironment } from '../core/RuntimeEnvironment.js';
import { assembleRuntimeServices } from '../core/RuntimeServices.js';
import { EnvVars } from '../constants/index.js';
import type { TeammateSpawner } from '../core/OrchestrationPorts.js';
import type { ApiAddress } from '../types/index.js';

// Re-export types callers may depend on from this module entry point.
export type { RuntimeServices } from '../core/RuntimeServices.js';
export type { ApiAddress } from '../core/RuntimeServices.js';

/**
 * Build all plugin instances and assemble the full RuntimeServices object.
 *
 * Signature matches the old createRuntimeServices from src/core/RuntimeServices.ts
 * so all callers (extension.ts, tests) can update their import path with no other
 * changes.
 *
 * Behaviour preserved:
 *  WI-1: env/PROJECT_ROOT/cwd precedence (same || logic as before)
 *  WI-2: explicitProjectRoot override
 *  WI-7: apiAddress mutable holder — created here, given to TeammateFactory AND
 *         returned in RuntimeServices so extension.ts mutations propagate everywhere
 *  WI-20: single TeammateFactory — extension.ts ??= guard keeps the SESSION_START
 *          instance; this function produces the default instance used by tests and
 *          the providedServices fallback
 *  WI-21: projectToolBackpressure map (owned by assembleRuntimeServices)
 *  p6m:   BeadsPortAdapter / WorktreePortAdapter (inside assembleRuntimeServices)
 */
export function createRuntimeServices(
  env: RuntimeEnvironment = nodeRuntimeEnvironment,
  explicitProjectRoot?: string
): import('../core/RuntimeServices.js').RuntimeServices {
  // Resolve projectRoot once here (same precedence as assembleRuntimeServices uses
  // internally) so plugins receive the same value that ends up in services.projectRoot.
  // Use || (not ??) to match WI-1: empty-string PROJECT_ROOT falls back.
  const projectRoot = explicitProjectRoot || env.env(EnvVars.PROJECT_ROOT) || process.cwd();

  // Build the core service instances that plugins depend on. We pass these to
  // assembleRuntimeServices via coreOverride so that plugins and the returned
  // RuntimeServices share the same ConfigLoader / EventStore / Observability
  // instances (preserving the original shared-object behaviour of the old
  // createRuntimeServices — events recorded via a plugin's eventStore appear
  // in services.eventStore).
  const configLoader = new ConfigLoader(env, projectRoot);
  const eventStore = new EventStore(configLoader, undefined, env, projectRoot);
  const observability = new Observability(configLoader, env, projectRoot);

  // WI-7: shared mutable ApiAddress holder. The TeammateFactory holds a reference
  // to this object. assembleRuntimeServices stores this same reference in
  // RuntimeServices.apiAddress. When extension.ts mutates .port/.base after
  // SignalingServer binds, all factories see the update at spawn time.
  const apiAddress: ApiAddress = {};

  const bdPlugin = createBdPlugin(eventStore, env, projectRoot);

  // WI-merge: TeammateFactory is created below; we forward its liveness check to
  // createGitPlugin via a closure so that auto-remove can gate on live panes without
  // importing TeammateFactory into the plugin layer.  The closure is safe because
  // teammateFactory is assigned before any tool execute() call can run.
  let teammateFactoryRef: TeammateFactory | undefined;
  const getLiveTeammateBeadIds = () =>
    teammateFactoryRef
      ? teammateFactoryRef.getLiveTeammateBeadIds()
      : Promise.resolve(new Set<string>());

  const gitPlugin = createGitPlugin(eventStore, configLoader, bdPlugin, projectRoot, getLiveTeammateBeadIds);

  // WI-20: single factory. Extension.ts uses ??= so SESSION_START-constructed
  // factory is reused for coordinator. This instance is the default for tests
  // and the fallback createRuntimeServices() call path.
  const teammateFactory: TeammateFactory = new TeammateFactory(
    observability,
    configLoader,
    eventStore,
    apiAddress,
    undefined,
    undefined,
    undefined,
    env,
    projectRoot
  );
  // Bind the factory reference so the getLiveTeammateBeadIds closure above
  // resolves to the correct instance at execute() time.
  teammateFactoryRef = teammateFactory;

  return assembleRuntimeServices(
    {
      bd: bdPlugin,
      git: gitPlugin,
      teammates: teammatePlugin(teammateFactory),
      mailbox: createMailboxPlugin(eventStore, projectRoot),
      quality: createQualityPlugin(),
      signaling: signalingPlugin,
      meta: createMetaPlugin(eventStore),
      teammateSpawner: teammateFactory as TeammateSpawner,
      apiAddress,
      // FIX-1: thread BeadsClient.invalidate() into the adapter so the Supervisor
      // can call beadsPort.invalidateCache() at tick-start without a core→plugin import.
      beadsClientInvalidateCache: bdPlugin.invalidateCache
    },
    env,
    explicitProjectRoot,
    // Pass the pre-built core services so the assembler uses the SAME instances
    // that plugins were constructed with (preserves original shared-object behaviour).
    { configLoader, eventStore, observability }
  );
}
