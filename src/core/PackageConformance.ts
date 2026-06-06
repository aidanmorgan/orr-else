/**
 * PackageConformance — production package-manifest checks + host-SDK fingerprinting.
 *
 * All functions are pure and deterministic (no LLM, no I/O side-effects beyond
 * the filesystem reads they are explicitly designed to perform).  Callers own
 * error handling; every function is best-effort where noted.
 *
 * Used by:
 *   - SESSION_START admission in extension.ts (resolveHostSdkFingerprint)
 *   - tests/pi_package_conformance.test.ts (all exports)
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PATH_INSTALL_ROOT } from './Paths.js';

// ---------------------------------------------------------------------------
// Compact hash helper (same convention as BuildProvenance / rawChecksum)
// ---------------------------------------------------------------------------

/** SHA-256 of content, first 16 hex characters (compact provenance fingerprint). */
function compactSha256(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Host-SDK fingerprint
// ---------------------------------------------------------------------------

/**
 * Result of resolving the installed host SDK version and fingerprinting it.
 */
export interface HostSdkFingerprint {
  /** Resolved @earendil-works/pi-ai version string from node_modules. */
  version: string;
  /**
   * Compact SHA-256 fingerprint of the version string (first 16 hex chars).
   * Follows the same convention as BuildProvenance rawChecksum / distArtifactHash.
   */
  fingerprint: string;
}

/**
 * Resolve the installed @earendil-works/pi-ai version and compute a compact
 * provenance fingerprint.
 *
 * Reads `<installRoot>/node_modules/@earendil-works/pi-ai/package.json`.
 * Returns undefined if the file is absent (e.g. stripped install without devDeps)
 * — callers must handle the absent case gracefully.
 *
 * @param installRoot  Harness install root; defaults to PATH_INSTALL_ROOT.
 */
export function resolveHostSdkFingerprint(
  installRoot: string = PATH_INSTALL_ROOT
): HostSdkFingerprint | undefined {
  const pkgPath = path.join(
    installRoot,
    'node_modules',
    '@earendil-works',
    'pi-ai',
    'package.json'
  );
  let raw: string;
  try {
    raw = fs.readFileSync(pkgPath, 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('version' in parsed) ||
    typeof (parsed as { version: unknown }).version !== 'string'
  ) {
    return undefined;
  }
  const version = (parsed as { version: string }).version;
  if (!version) return undefined;
  return { version, fingerprint: compactSha256(version) };
}

// ---------------------------------------------------------------------------
// Missing runtime-dep detection
// ---------------------------------------------------------------------------

/**
 * Check which of an orr-else manifest's declared `dependencies` are absent from
 * the set of actually-installed package names in a consumer install.
 *
 * @param orrElsePkg       Parsed orr-else package.json object.
 * @param installedDepNames Names of packages present in the consumer's install.
 * @returns Array of dependency names that are required but not installed.
 */
export function checkMissingRuntimeDeps(
  orrElsePkg: Record<string, unknown>,
  installedDepNames: string[]
): string[] {
  const required = Object.keys(
    (orrElsePkg['dependencies'] ?? {}) as Record<string, string>
  );
  const installed = new Set(installedDepNames);
  return required.filter(dep => !installed.has(dep));
}

// ---------------------------------------------------------------------------
// Bundled-deps / deps cross-check
// ---------------------------------------------------------------------------

/**
 * Check which entries in `bundleDependencies` are NOT also declared in
 * `dependencies`.  A well-formed manifest must declare every bundled package
 * in both lists.
 *
 * @param orrElsePkg  Parsed orr-else package.json object.
 * @returns Array of names that are bundled but not in dependencies.
 */
export function checkBundledNotInDeps(
  orrElsePkg: Record<string, unknown>
): string[] {
  const deps = new Set(
    Object.keys((orrElsePkg['dependencies'] ?? {}) as Record<string, string>)
  );
  const bundled = (
    (orrElsePkg['bundledDependencies'] ?? orrElsePkg['bundleDependencies'] ?? []) as string[]
  );
  return bundled.filter(b => !deps.has(b));
}

// ---------------------------------------------------------------------------
// Duplicate shim-activation detection
// ---------------------------------------------------------------------------

/**
 * A shim activation entry: a path/name pair describing one pi.extensions entry.
 */
export interface ShimActivation {
  /** Filesystem path to the shim file (e.g. '.pi/extensions/orr-else.ts'). */
  path: string;
  /** The package name the shim activates (e.g. 'orr-else'). */
  package: string;
}

/**
 * Check for duplicate package activations in a consumer's shim list.
 *
 * A duplicate occurs when the same package name appears more than once in the
 * activation list, regardless of the file path.
 *
 * @param shimActivations  All shim activations in the consumer install.
 * @returns Array of package names that appear more than once (deduplicated).
 */
export function checkDuplicateShimActivations(
  shimActivations: ShimActivation[]
): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const { package: pkg } of shimActivations) {
    if (seen.has(pkg)) {
      duplicates.add(pkg);
    } else {
      seen.add(pkg);
    }
  }
  return [...duplicates];
}

// ---------------------------------------------------------------------------
// Missing pi.extensions entrypoint detection
// ---------------------------------------------------------------------------

/**
 * Check which pi.extensions entrypoints declared in a package manifest are
 * absent on disk in the package install directory.
 *
 * @param pkgDir  Absolute path to the installed package root (where package.json lives).
 * @param piPkg   Parsed package.json object for the installed package.
 * @returns Array of pi.extensions entries that do not exist on disk.
 */
export function checkMissingPiExtensionEntrypoints(
  pkgDir: string,
  piPkg: Record<string, unknown>
): string[] {
  const piField = (piPkg['pi'] ?? {}) as Record<string, unknown>;
  const extensions = (piField['extensions'] ?? []) as string[];
  return extensions.filter(ext => {
    const resolved = path.join(pkgDir, ext);
    return !fs.existsSync(resolved);
  });
}

// ---------------------------------------------------------------------------
// Semver range matching (minimal — wildcard + caret + exact)
// ---------------------------------------------------------------------------

/**
 * Minimal semver range check.
 *
 * Supports:
 *   - `"*"` — matches any version.
 *   - `"^major.minor.patch"` — same-major, at-least-minor range.
 *   - `"major.minor.patch"` — exact version match.
 *
 * Not a full semver implementation.  Sufficient for the drift-detection policy
 * used in the conformance tests.
 *
 * Exposed from the production module so tests assert the production function,
 * not a locally-reimplemented copy.
 */
export function semverMatchesRange(version: string, range: string): boolean {
  if (range === '*') return true;
  const caretMatch = range.match(/^\^(\d+)\.(\d+)\.(\d+)$/);
  if (caretMatch) {
    const [, rMaj, rMin] = caretMatch.map(Number);
    const vParts = version.split('.').map(Number);
    const [vMaj, vMin] = vParts;
    if (vMaj !== rMaj) return false;
    if (vMin < rMin) return false;
    return true;
  }
  return version === range;
}
