/**
 * ContractRegistrySet — per-runtime set of the three harness-owned registries:
 *   verifier   (verify() callbacks, per tool name)
 *   skeletons  (skeleton extractors, per file extension)
 *   projections (named artifact projections)
 *
 * The public boundary (`src/contract.ts`) exports process-wide singleton
 * registries for backward compatibility with consuming-project extensions
 * (e.g. cerdiwen calls `verifier.register(...)` at load). The production
 * runtime ContractRegistrySet starts FRESH and is DRAINED from the global
 * singletons at startup admission (after all extensions have loaded) via
 * drainFromGlobals(). Thereafter core reads ONLY the per-runtime instance,
 * never the global singletons — two runtimes are fully independent.
 *
 * Tests create FRESH registry sets with empty, standalone registries so they
 * need no global reset hooks.
 *
 * Core modules receive a ContractRegistrySet via constructor injection and
 * NEVER import the singletons from contract.ts directly.
 */

import {
  verifier as globalVerifier,
  skeletons as globalSkeletons,
  projections as globalProjections,
  type VerifyCallback,
  type SkeletonExtractor,
  type ProjectionDef,
  type Registry,
} from '../contract.js';

export type { Registry };

// Re-export the contract types core needs (no contract singleton import in callers)
export type { VerifyCallback, SkeletonExtractor, ProjectionDef };

/**
 * Minimal read+register port for a harness registry.
 *
 * Matches the public surface of the contract.ts Registry class.
 * Used so ContractRegistrySet can hold fresh instances independently of the
 * private-field Registry class that is not exported as a constructor.
 */
export interface RegistryPort<Fn> {
  register(name: string, fn: Fn): void;
  get(name: string): Fn | undefined;
  has(name: string): boolean;
  names(): string[];
  withLogger(logger: { warn(msg: string): void }): this;
}

/**
 * Per-runtime bundle of the three contract registries.
 *
 * Created once per `assembleRuntimeServices` call and threaded through to
 * core consumers (VerifierGate, ArtifactQuery, PathContext). Tests create
 * fresh ContractRegistrySets without needing global reset hooks.
 *
 * Production usage pattern:
 *   1. assembleRuntimeServices() creates a fresh (empty) registrySet.
 *   2. loadCoordinatorWorkerExtensions() imports consumer modules which call
 *      verifier.register() / skeletons.register() / projections.register() on
 *      the GLOBAL singletons.
 *   3. registrySet.drainFromGlobals() copies all current global registrations
 *      into this per-runtime set. Thereafter core reads ONLY this set.
 */
export class ContractRegistrySet {
  constructor(
    public readonly verifier: RegistryPort<VerifyCallback>,
    public readonly skeletons: RegistryPort<SkeletonExtractor>,
    public readonly projections: RegistryPort<ProjectionDef>
  ) {}

  /**
   * One-time drain: copy all registrations currently in the process-wide
   * global singletons (verifier / skeletons / projections from src/contract.ts)
   * into THIS per-runtime set. Existing entries in this set are NOT overwritten
   * (first-registration wins within the set), but new names from the globals are
   * added.
   *
   * Call ONCE after loadCoordinatorWorkerExtensions() has finished so that
   * consumer callbacks registered during extension load are captured here.
   * After this call, core reads ONLY this set and never touches the globals.
   */
  drainFromGlobals(): void {
    for (const name of globalVerifier.names()) {
      if (!this.verifier.has(name)) {
        const fn = globalVerifier.get(name);
        if (fn !== undefined) this.verifier.register(name, fn);
      }
    }
    for (const name of globalSkeletons.names()) {
      if (!this.skeletons.has(name)) {
        const fn = globalSkeletons.get(name);
        if (fn !== undefined) this.skeletons.register(name, fn);
      }
    }
    for (const name of globalProjections.names()) {
      if (!this.projections.has(name)) {
        const fn = globalProjections.get(name);
        if (fn !== undefined) this.projections.register(name, fn);
      }
    }
  }
}

/**
 * Build a fresh RegistryPort<Fn> backed by a plain Map with last-wins semantics.
 *
 * Used for TEST isolation: tests pass a freshRegistrySet() to core under test
 * so registrations in one test do not bleed into another.
 */
export function buildRegistryPort<Fn>(label: string): RegistryPort<Fn> {
  const entries = new Map<string, Fn>();
  let logger: { warn(msg: string): void } = {
    warn(msg: string) { console.warn(msg); } // eslint-disable-line no-console
  };

  const port: RegistryPort<Fn> = {
    register(name: string, fn: Fn): void {
      if (entries.has(name)) {
        logger.warn(`[orr-else/contract] ${label}: re-registering "${name}" — replacing the prior registration (last-wins).`);
      }
      entries.set(name, fn);
    },
    get(name: string): Fn | undefined {
      return entries.get(name);
    },
    has(name: string): boolean {
      return entries.has(name);
    },
    names(): string[] {
      return [...entries.keys()];
    },
    withLogger(l: { warn(msg: string): void }): typeof port {
      logger = l;
      return port;
    },
  };
  return port;
}

/**
 * Create a fresh (empty) ContractRegistrySet for use in tests.
 * No registrations are pre-populated; tests register exactly what they need.
 */
export function createFreshRegistrySet(): ContractRegistrySet {
  return new ContractRegistrySet(
    buildRegistryPort<VerifyCallback>('verifier'),
    buildRegistryPort<SkeletonExtractor>('skeletons'),
    buildRegistryPort<ProjectionDef>('projections')
  );
}

/**
 * Create a ContractRegistrySet that PROXIES the process-wide public boundary
 * singletons (verifier / skeletons / projections from src/contract.ts).
 *
 * DEPRECATED in favour of createFreshRegistrySet() + drainFromGlobals().
 * Two runtimes built with this function share the global singleton state,
 * which means registrations in one runtime are visible in the other.
 *
 * Retained only for test code that explicitly wants the global proxy.
 * assembleRuntimeServices no longer uses this function.
 */
export function createGlobalProxyRegistrySet(): ContractRegistrySet {
  return new ContractRegistrySet(
    globalVerifier as unknown as RegistryPort<VerifyCallback>,
    globalSkeletons as unknown as RegistryPort<SkeletonExtractor>,
    globalProjections as unknown as RegistryPort<ProjectionDef>
  );
}
