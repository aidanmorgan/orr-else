/**
 * CoordinatorExtensionLoader (0yt5.20 decision A / AC2).
 *
 * The COORDINATOR-side artifact-presence gate runs consumer verify() callbacks.
 * Those callbacks are registered into the contract `verifier` registry as an
 * import side effect of a consumer's pi.workerExtensions module. The registry is
 * a per-PROCESS module-level singleton, so a worker-side registration is NOT
 * visible in the coordinator process.
 *
 * This loader makes the coordinator load its consumer worker-extensions in its
 * OWN process at startup, so the verify() callbacks register in the same process
 * that runs the gate. Loading is:
 *  - best-effort per module: one extension's import failure logs + continues
 *    rather than aborting coordinator startup (the gate fails closed at the
 *    transition point anyway — a missing callback blocks);
 *  - de-duplicated by resolved path;
 *  - independent of the harness's OWN extension (which already self-registers its
 *    built-in verifiers via src/tools/index.ts at its own load).
 */

import { resolveWorkerExtensionPaths } from './PiIntegration.js';
import type { HarnessConfig } from './ConfigLoader.js';
import { Logger } from './Logger.js';
import { Component } from '../constants/index.js';

/** A dynamic-import seam so tests can inject a fake loader. */
export type ExtensionImporter = (resolvedPath: string) => Promise<unknown>;

const defaultImporter: ExtensionImporter = (resolvedPath: string) => import(resolvedPath);

export interface CoordinatorExtensionLoadResult {
  loaded: string[];
  failed: Array<{ path: string; error: string }>;
}

/**
 * Load every configured pi.workerExtension into THIS (coordinator) process so
 * consumer verify() callbacks register in the gate process.
 *
 * @param config              The loaded harness config.
 * @param projectRoot         Absolute project root (for path resolution).
 * @param primaryExtensionPath The coordinator's own extension path; included so
 *        resolveWorkerExtensionPaths de-dupes it, but it is SKIPPED for import
 *        because it is already loaded in this process.
 * @param importer            Dynamic-import seam (tests inject a fake).
 */
export async function loadCoordinatorWorkerExtensions(
  config: HarnessConfig,
  projectRoot: string,
  primaryExtensionPath: string,
  importer: ExtensionImporter = defaultImporter
): Promise<CoordinatorExtensionLoadResult> {
  const loaded: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];

  // resolveWorkerExtensionPaths validates existence and de-dupes; it returns the
  // primary extension path FIRST, which we skip (already loaded in this process).
  const resolvedPaths = resolveWorkerExtensionPaths(config, projectRoot, primaryExtensionPath);
  const primaryResolved = resolvedPaths[0];

  for (const resolvedPath of resolvedPaths) {
    if (resolvedPath === primaryResolved) continue; // skip the coordinator's own extension
    try {
      await importer(resolvedPath);
      loaded.push(resolvedPath);
      Logger.info(Component.ORR_ELSE, 'Coordinator loaded worker extension (verify() callbacks registered in gate process)', {
        path: resolvedPath
      });
    } catch (error) {
      const message = String(error);
      failed.push({ path: resolvedPath, error: message });
      Logger.warn(Component.ORR_ELSE, 'Coordinator failed to load a worker extension (verify() callbacks for it will be absent in the gate process)', {
        path: resolvedPath,
        error: message
      });
    }
  }

  return { loaded, failed };
}
