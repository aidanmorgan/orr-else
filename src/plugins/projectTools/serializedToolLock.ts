/**
 * Generic cross-process serialized-tool lock.
 *
 * Both the MCP executor and the command executor reuse this single mechanism to
 * serialize `serialize: true` tools across teammates: a teammate that holds the
 * lock for a given tool runs to completion before any other teammate's identical
 * tool can start. Different tools use different lock files and never block each
 * other (keying is per project-root + per-tool).
 *
 * Package-internal — do not import from outside src/plugins/.
 */
import path from 'path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { mkdir, open } from 'fs/promises';
import lockfile from 'proper-lockfile';
import { Logger } from '../../core/Logger.js';
import { Component } from '../../constants/infra.js';
import {
  SERIAL_MCP_LOCK_RETRIES,
  SERIAL_MCP_LOCK_RETRY_MAX_MS,
  SERIAL_MCP_LOCK_RETRY_MIN_MS,
  SERIAL_MCP_LOCK_STALE_MS
} from './constants.js';

/**
 * Describes a single serialized-tool lock acquisition. `lockDir` selects the
 * tmpdir bucket (so MCP and command locks live in distinct namespaces);
 * `keyParts` are hashed into the per-tool lock directory so identical tools
 * collide (serialize) while different tools do not. `logFields` are added to
 * every log line so the MCP and command paths keep their existing structured
 * logging shape.
 */
export interface SerializedToolLockSpec {
  /** tmpdir bucket name, e.g. 'orr-else-mcp-tool-locks' or 'orr-else-command-tool-locks'. */
  lockDir: string;
  /** Stable parts hashed into the lock path. Identical parts => same lock => serialized. */
  keyParts: string[];
  /** Lock-file base name (the tool name). */
  lockName: string;
  /** Extra structured-log fields identifying the tool/server for observability. */
  logFields: Record<string, unknown>;
}

/**
 * Raised when a serialized-tool lock cannot be acquired within the bounded retry
 * window. Carries only sanitized metadata (no absolute project/worktree paths) so
 * callers can surface a descriptive, path-safe backpressure result.
 */
export class SerializedToolLockTimeoutError extends Error {
  readonly waitedMs: number;
  readonly lockRef: string;
  readonly lockFile: string;

  constructor(message: string, waitedMs: number, lockPath: string, cause: unknown) {
    super(`${message} after ${waitedMs}ms: ${String(cause)}`);
    this.name = 'SerializedToolLockTimeoutError';
    this.waitedMs = waitedMs;
    this.lockRef = path.basename(path.dirname(lockPath));
    this.lockFile = path.basename(lockPath);
  }
}

export function serializedToolLockPath(spec: SerializedToolLockSpec): string {
  const digest = createHash('sha256')
    .update(spec.keyParts.join('\n'))
    .digest('hex')
    .slice(0, 16);
  return path.join(tmpdir(), spec.lockDir, digest, `${spec.lockName}.lock`);
}

async function ensureLockFile(lockPath: string): Promise<void> {
  await mkdir(path.dirname(lockPath), { recursive: true });
  const handle = await open(lockPath, 'a');
  await handle.close();
}

/**
 * Acquire the per-tool cross-process lock, run `fn`, and release the lock in a
 * finally block. Throws {@link SerializedToolLockTimeoutError} when the bounded
 * retry window is exhausted. The retry/stale window matches the MCP lock so
 * command and MCP serialization behave identically.
 */
export async function withSerializedToolLock<T>(
  spec: SerializedToolLockSpec,
  timeoutMessage: string,
  fn: () => Promise<T>
): Promise<T> {
  const lockPath = serializedToolLockPath(spec);
  await ensureLockFile(lockPath);
  const startedAtMs = Date.now();
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(lockPath, {
      stale: SERIAL_MCP_LOCK_STALE_MS,
      retries: {
        retries: SERIAL_MCP_LOCK_RETRIES,
        factor: 1.1,
        minTimeout: SERIAL_MCP_LOCK_RETRY_MIN_MS,
        maxTimeout: SERIAL_MCP_LOCK_RETRY_MAX_MS
      }
    });
  } catch (error) {
    const waitedMs = Date.now() - startedAtMs;
    Logger.warn(Component.PROJECT_TOOLS, 'Timed out acquiring serialized project-tool lock', {
      ...spec.logFields,
      waitedMs,
      lockRef: path.basename(path.dirname(lockPath)),
      lockFile: path.basename(lockPath),
      error: String(error)
    });
    throw new SerializedToolLockTimeoutError(timeoutMessage, waitedMs, lockPath, error);
  }

  const waitedMs = Date.now() - startedAtMs;
  if (waitedMs > SERIAL_MCP_LOCK_RETRY_MAX_MS) {
    Logger.warn(Component.PROJECT_TOOLS, 'Waited for serialized project-tool lock', {
      ...spec.logFields,
      waitedMs,
      lockPath
    });
  }

  try {
    return await fn();
  } finally {
    await release?.().catch((error: unknown) => {
      Logger.warn(Component.PROJECT_TOOLS, 'Unable to release serialized project-tool lock', {
        ...spec.logFields,
        lockPath,
        error: String(error)
      });
    });
  }
}
