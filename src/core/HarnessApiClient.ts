import { setTimeout as delay } from 'node:timers/promises';
import ky from 'ky';
import { ApiPath, Defaults, EnvVars, HttpMethod, HttpStatus, WorkerDefaults } from '../constants/index.js';
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

export async function postHarnessSignal(event: TeammateEvent): Promise<HarnessApiOkResponse | null> {
  return await harnessApiRequest<HarnessApiOkResponse>(ApiPath.SIGNAL, HttpMethod.POST, { body: event });
}

export async function getHarnessHeartbeats(): Promise<HarnessHeartbeatMap> {
  return (await harnessApiRequest<HarnessHeartbeatMap>(ApiPath.HEARTBEATS, HttpMethod.GET)) || {};
}
