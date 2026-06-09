import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { simpleGit } from 'simple-git';
import { nodeLogger as Logger } from './Logger.js'
import { PATH_INSTALL_ROOT } from './Paths.js';
import { DomainEventName } from '../constants/domain.js';
import { BuildProvenanceDefaults, Component, TimeMs } from '../constants/infra.js';
import type { EventStore } from './EventStore.js';
import { SignalNoiseCoalescer } from './SignalNoiseCoalescer.js';
import { DIGEST_ID_LENGTH } from './BootstrapDigest.js';

/**
 * Build provenance record attached to coordinator/worker startup events.
 * Every field is best-effort: read failures yield UNKNOWN or undefined, never throw.
 */
export interface BuildProvenance {
  /** Harness npm package version from package.json, or 'unknown'. */
  packageVersion: string;
  /** Git commit SHA at HEAD in the install root, or 'unknown' if not a git repo. */
  gitCommit: string;
  /** SHA-256 hex digest of dist/extension.js contents, or 'unknown' if missing. */
  distArtifactHash: string;
  /** ISO-8601 string of dist/extension.js mtime, or undefined if the file is missing. */
  distBuildTimestamp: string | undefined;
  /** Absolute path to the resolved harness config file. */
  configPath: string;
  /** SHA-256 hex digest of the resolved harness config file contents, or 'unknown'. */
  configHash: string;
  /**
   * Whether dist/extension.js is older than the newest src/**​/*.ts source file.
   * undefined when staleness could not be determined (e.g. dist is missing).
   */
  distIsStale: boolean | undefined;
}

const DIST_EXTENSION_REL = path.join('dist', 'extension.js');
const PACKAGE_JSON_REL = 'package.json';
const SRC_DIR_REL = 'src';

/**
 * Module-level coalescer: deduplicates DIST_ARTIFACT_STALE warnings and events
 * by provenance key (distArtifactHash + gitCommit + configHash) within a 1-hour
 * window per process.  Tests may inject their own coalescer via the optional
 * parameter to runStalenessPreflightWarn.
 */
const defaultStaleCoalescer = new SignalNoiseCoalescer(TimeMs.HOUR);

function sha256(content: Buffer | string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/** Recursively find the newest mtime (ms) across all *.ts files under srcDir. */
function newestSrcMtimeMs(srcDir: string): number {
  let newest = 0;
  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        try {
          const { mtimeMs } = fs.statSync(full);
          if (mtimeMs > newest) newest = mtimeMs;
        } catch {
          // best-effort
        }
      }
    }
  }
  walk(srcDir);
  return newest;
}

/** Read package version from package.json at installRoot. Best-effort. */
function readPackageVersion(installRoot: string): string {
  try {
    const raw = fs.readFileSync(path.join(installRoot, PACKAGE_JSON_REL), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && 'version' in parsed && typeof (parsed as { version: unknown }).version === 'string') {
      return (parsed as { version: string }).version;
    }
  } catch {
    // best-effort
  }
  return BuildProvenanceDefaults.UNKNOWN;
}

/** Get git HEAD commit SHA in installRoot. Best-effort. */
async function readGitCommit(installRoot: string): Promise<string> {
  try {
    const result = await simpleGit({ baseDir: installRoot, binary: 'git' }).raw(['rev-parse', 'HEAD']);
    const trimmed = result.trim();
    return trimmed || BuildProvenanceDefaults.UNKNOWN;
  } catch {
    return BuildProvenanceDefaults.UNKNOWN;
  }
}

/** Compute hash and mtime of dist/extension.js. Best-effort. */
function readDistInfo(installRoot: string): { hash: string; mtimeMs: number | undefined } {
  const distPath = path.join(installRoot, DIST_EXTENSION_REL);
  try {
    const contents = fs.readFileSync(distPath);
    const { mtimeMs } = fs.statSync(distPath);
    return { hash: sha256(contents), mtimeMs };
  } catch {
    return { hash: BuildProvenanceDefaults.UNKNOWN, mtimeMs: undefined };
  }
}

/** Read and hash the config file at configPath. Best-effort. */
function readConfigHash(configPath: string): string {
  try {
    const contents = fs.readFileSync(configPath);
    return sha256(contents);
  } catch {
    return BuildProvenanceDefaults.UNKNOWN;
  }
}

/**
 * Compute and return a BuildProvenance record.
 *
 * All fields are best-effort: any individual read failure yields 'unknown' or
 * undefined for that field without throwing or affecting startup.
 *
 * @param installRoot - Harness install root (defaults to PATH_INSTALL_ROOT)
 * @param configPath  - Resolved config file path (for hash)
 */
export async function computeBuildProvenance(
  configPath: string,
  installRoot: string = PATH_INSTALL_ROOT
): Promise<BuildProvenance> {
  const packageVersion = readPackageVersion(installRoot);
  const gitCommit = await readGitCommit(installRoot);
  const { hash: distArtifactHash, mtimeMs: distMtimeMs } = readDistInfo(installRoot);
  const distBuildTimestamp = distMtimeMs !== undefined ? new Date(distMtimeMs).toISOString() : undefined;
  const configHash = readConfigHash(configPath);

  // Staleness: compare dist mtime against newest src/*.ts mtime
  let distIsStale: boolean | undefined;
  if (distMtimeMs !== undefined) {
    const srcDir = path.join(installRoot, SRC_DIR_REL);
    const srcNewest = newestSrcMtimeMs(srcDir);
    distIsStale = srcNewest > 0 && distMtimeMs < srcNewest;
  }

  return {
    packageVersion,
    gitCommit,
    distArtifactHash,
    distBuildTimestamp,
    configPath,
    configHash,
    distIsStale
  };
}

/**
 * Build the provenance key used to deduplicate stale-dist warnings.
 *
 * The key is (distArtifactHash, gitCommit, configHash).  pid / sessionId are
 * implicitly scoped by the module-level coalescer (one instance per process),
 * so they are not included in the key itself.
 */
function provenanceKey(provenance: BuildProvenance): string {
  return `${provenance.distArtifactHash}|${provenance.gitCommit}|${provenance.configHash}`;
}

/**
 * Run the staleness preflight check.
 *
 * WARN (never hard-reject) when dist/extension.js is missing or older than
 * the newest src/*.ts file.  A hard reject would block legitimate runs
 * (e.g. running in-source without a dist build), so we choose loud WARN
 * as the default and never throw.
 *
 * Records a DIST_ARTIFACT_STALE domain event when stale so monitors can
 * correlate staleness with unexpected worker behaviour.
 *
 * Duplicate warnings for the same provenance key (distArtifactHash + gitCommit
 * + configHash) within the same window are coalesced: the FIRST occurrence emits
 * both a Logger.warn and a durable event; subsequent occurrences within the same
 * window are silently dropped.  HARNESS_STARTED.buildProvenance is never gated
 * and is always emitted by callers.
 *
 * @param provenance  - Already-computed BuildProvenance record
 * @param eventStore  - Used to record the staleness event (optional, for best-effort)
 * @param coalescer   - Optional coalescer override for testing; defaults to the
 *                      module-level singleton scoped to this process.
 */
export async function runStalenessPreflightWarn(
  provenance: BuildProvenance,
  eventStore?: Pick<EventStore, 'record'>,
  coalescer: SignalNoiseCoalescer = defaultStaleCoalescer
): Promise<void> {
  // Dist missing entirely
  if (provenance.distBuildTimestamp === undefined) {
    const key = provenanceKey(provenance);
    const { shouldLog, suppressedCount } = coalescer.observe(key);
    if (!shouldLog) return;

    const message =
      '[BuildProvenance] dist/extension.js is MISSING. ' +
      'Workers will not start. Run `npm run build` to produce the dist artifact.';
    Logger.warn(Component.BUILD_PROVENANCE, message, {
      distArtifactHash: provenance.distArtifactHash,
      packageVersion: provenance.packageVersion,
      gitCommit: provenance.gitCommit,
      ...(suppressedCount > 0 ? { suppressedCount } : {})
    });
    await eventStore?.record(DomainEventName.DIST_ARTIFACT_STALE, {
      reason: 'dist-missing',
      provenance,
      ...(suppressedCount > 0 ? { suppressedCount } : {})
    }).catch(() => {});
    return;
  }

  // Dist present but older than source
  if (provenance.distIsStale === true) {
    const key = provenanceKey(provenance);
    const { shouldLog, suppressedCount } = coalescer.observe(key);
    if (!shouldLog) return;

    const message =
      '[BuildProvenance] dist/extension.js is STALE: source files are newer than the compiled artifact. ' +
      'Workers may run old code. Run `npm run build` to rebuild.';
    Logger.warn(Component.BUILD_PROVENANCE, message, {
      distBuildTimestamp: provenance.distBuildTimestamp,
      packageVersion: provenance.packageVersion,
      gitCommit: provenance.gitCommit,
      ...(suppressedCount > 0 ? { suppressedCount } : {})
    });
    await eventStore?.record(DomainEventName.DIST_ARTIFACT_STALE, {
      reason: 'dist-older-than-src',
      provenance,
      ...(suppressedCount > 0 ? { suppressedCount } : {})
    }).catch(() => {});
  }
}

/**
 * Compute a compact harness fingerprint from a BuildProvenance record.
 *
 * The fingerprint binds together the three most stable identity signals:
 *   - distArtifactHash: SHA-256 of the compiled dist/extension.js
 *   - gitCommit:        HEAD commit SHA of the install root
 *   - configHash:       SHA-256 of the resolved harness config file
 *
 * Returns `sha256:<DIGEST_ID_LENGTH-char hex>`.  Best-effort: when all three
 * fields are 'unknown' the fingerprint is still deterministic and non-empty,
 * so consumers can always store it without null-checking.
 *
 * This is the authoritative producer of admittedHarnessFingerprint for the
 * pi-experiment-1elr.9 AC3 requirement.
 */
export function computeHarnessFingerprint(provenance: BuildProvenance): string {
  const raw = `${provenance.distArtifactHash}|${provenance.gitCommit}|${provenance.configHash}`;
  const digest = crypto.createHash('sha256').update(raw).digest('hex').slice(0, DIGEST_ID_LENGTH);
  return `sha256:${digest}`;
}
