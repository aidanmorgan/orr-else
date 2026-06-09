import { setTimeout as delay } from 'node:timers/promises';
import ky from 'ky';
import { ApiPath, HttpMethod } from '../constants/domain.js';
import { Defaults, EnvVars, HttpStatus, WorkerDefaults } from '../constants/infra.js';
import { nodeRuntimeEnvironment, type RuntimeEnvironment } from './RuntimeEnvironment.js';
import type { TeammateEvent } from './TeammateEvents.js';

export interface HarnessApiRequestOptions {
  body?: unknown;
  timeoutMs?: number;
  attempts?: number;
  retryDelayMs?: number;
  runtimeEnvironment?: RuntimeEnvironment;
}

export interface HarnessApiOkResponse {
  ok: boolean;
}

/**
 * Thrown by postHarnessSignal when the coordinator returns HTTP 2xx but the
 * response body signals rejection: ok !== true, missing ok field, blocked gate,
 * held-ack timeout, or malformed/non-object body.
 *
 * Callers (postWorkerSignal) must handle this specifically and record
 * TEAMMATE_SIGNAL_FAILED — never SIGNAL_ACKNOWLEDGED — on coordinator rejection.
 */
export class CoordinatorRejectionError extends Error {
  /** Why the coordinator rejected — 'timedOut' | 'blocked' | 'malformed' */
  readonly rule: string;
  readonly timedOut?: boolean;
  readonly blocked?: boolean;
  readonly gate?: unknown;
  readonly malformed?: boolean;
  readonly responseBody: Record<string, unknown>;

  constructor(responseBody: Record<string, unknown>) {
    const rule = responseBody.timedOut
      ? 'timedOut'
      : responseBody.blocked
        ? 'blocked'
        : 'malformed';
    super(`Coordinator rejected signal: rule=${rule}`);
    this.name = 'CoordinatorRejectionError';
    this.rule = rule;
    this.responseBody = responseBody;
    if (responseBody.timedOut) this.timedOut = true;
    if (responseBody.blocked) this.blocked = true;
    if (responseBody.gate !== undefined) this.gate = responseBody.gate;
    if (rule === 'malformed') this.malformed = true;
  }
}

export type HarnessHeartbeatMap = Record<string, number>;

export function harnessApiBase(runtimeEnvironment: RuntimeEnvironment = nodeRuntimeEnvironment): string {
  const apiPort = runtimeEnvironment.env(EnvVars.API_PORT) || Defaults.API_PORT;
  return runtimeEnvironment.env(EnvVars.API_BASE) || `http://${Defaults.API_HOST}:${apiPort}`;
}

function requestAttempts(options: HarnessApiRequestOptions): number {
  const configured = options.attempts ?? WorkerDefaults.SIGNAL_REQUEST_ATTEMPTS;
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 1;
}

function retryDelayMs(options: HarnessApiRequestOptions): number {
  const configured = options.retryDelayMs ?? WorkerDefaults.SIGNAL_REQUEST_RETRY_DELAY_MS;
  return Number.isFinite(configured) && configured > 0 ? configured : 0;
}

function shouldRetryHarnessApiError(error: unknown): boolean {
  const status = typeof error === 'object' && error !== null
    ? (error as { response?: { status?: unknown } }).response?.status
    : undefined;
  if (typeof status !== 'number') return true;
  return status === HttpStatus.REQUEST_TIMEOUT || status === HttpStatus.TOO_MANY_REQUESTS || status >= HttpStatus.INTERNAL_SERVER_ERROR;
}

export async function harnessApiRequest<T = unknown>(
  path: string,
  method: string,
  options: HarnessApiRequestOptions = {}
): Promise<T | null> {
  const attempts = requestAttempts(options);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await ky(`${harnessApiBase(options.runtimeEnvironment)}${path}`, {
        method,
        timeout: options.timeoutMs || WorkerDefaults.SIGNAL_REQUEST_TIMEOUT_MS,
        retry: 0,
        ...(options.body !== undefined ? { json: options.body } : {})
      });
      if (response.status === HttpStatus.NO_CONTENT) return null;

      const text = await response.text();
      if (!text) return null;
      return JSON.parse(text) as T;
    } catch (error) {
      if (attempt >= attempts || !shouldRetryHarnessApiError(error)) throw error;
      await delay(retryDelayMs(options));
    }
  }
  return null;
}

/**
 * Post a teammate signal to the coordinator. Distinguishes transport success
 * (HTTP 2xx, no throw) from coordinator acceptance (ok === true in body).
 *
 * Returns the accepted response on ok:true.
 * Throws CoordinatorRejectionError when the coordinator returns ok !== true,
 * when ok is absent, or when the response body is not an object — these are
 * coordinator rejection rules, not transport failures.
 * Propagates transport errors (non-2xx, network timeouts) unchanged.
 */
export async function postHarnessSignal(
  event: TeammateEvent,
  options?: HarnessApiRequestOptions
): Promise<HarnessApiOkResponse> {
  const raw = await harnessApiRequest<unknown>(ApiPath.SIGNAL, HttpMethod.POST, { ...options, body: event });

  // null means HTTP 204 No Content — no coordinator verdict, treat as malformed
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CoordinatorRejectionError({ ok: false, malformed: true, raw: String(raw) });
  }

  const body = raw as Record<string, unknown>;

  // Coordinator acceptance requires ok === true explicitly
  if (body.ok !== true) {
    throw new CoordinatorRejectionError(body);
  }

  return body as unknown as HarnessApiOkResponse;
}

export async function getHarnessHeartbeats(): Promise<HarnessHeartbeatMap> {
  return (await harnessApiRequest<HarnessHeartbeatMap>(ApiPath.HEARTBEATS, HttpMethod.GET)) || {};
}
