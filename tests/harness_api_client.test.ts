import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Defaults, EnvVars } from '../src/constants/infra.js';
import { harnessApiBase, harnessApiRequest } from '../src/core/HarnessApiClient.js';
import type { RuntimeEnvironment } from '../src/core/RuntimeEnvironment.js';

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

describe('HarnessApiClient', () => {
  let server: Server | undefined;

  afterEach(async () => {
    await closeServer(server);
    server = undefined;
  });

  function runtimeEnvironment(vars: Record<string, string | undefined>): RuntimeEnvironment {
    return {
      env: (name: string): string | undefined => vars[name]
    };
  }

  async function startServer(handler: Parameters<typeof createServer>[0]): Promise<string> {
    server = createServer(handler);
    await new Promise<void>(resolve => server?.listen(0, resolve));
    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  it('uses API_BASE from the provided runtime environment', () => {
    const runtime = runtimeEnvironment({
      [EnvVars.API_BASE]: 'http://example.test:1234',
      [EnvVars.API_PORT]: '9999'
    });

    expect(harnessApiBase(runtime)).toBe('http://example.test:1234');
  });

  it('falls back to API_PORT from the provided runtime environment', () => {
    const runtime = runtimeEnvironment({
      [EnvVars.API_PORT]: '4567'
    });

    expect(harnessApiBase(runtime)).toBe(`http://${Defaults.API_HOST}:4567`);
  });

  it('uses the default harness host and port when the runtime environment is unset', () => {
    expect(harnessApiBase(runtimeEnvironment({}))).toBe(`http://${Defaults.API_HOST}:${Defaults.API_PORT}`);
  });

  it('retries transient harness API failures through the shared client', async () => {
    let requests = 0;
    const apiBase = await startServer((_request, response) => {
      requests += 1;
      if (requests === 1) {
        response.writeHead(503);
        response.end('not ready');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, requests }));
    });

    const result = await harnessApiRequest<{ ok: boolean; requests: number }>('/signal', 'POST', {
      body: { type: 'HEARTBEAT' },
      attempts: 2,
      retryDelayMs: 1,
      timeoutMs: 1_000,
      runtimeEnvironment: runtimeEnvironment({ [EnvVars.API_BASE]: apiBase })
    });

    expect(result).toEqual({ ok: true, requests: 2 });
    expect(requests).toBe(2);
  });

  it('does not retry non-transient harness API rejections', async () => {
    let requests = 0;
    const apiBase = await startServer((_request, response) => {
      requests += 1;
      response.writeHead(400);
      response.end('bad request');
    });

    await expect(harnessApiRequest('/signal', 'POST', {
      body: { type: 'bad' },
      attempts: 3,
      retryDelayMs: 1,
      timeoutMs: 1_000,
      runtimeEnvironment: runtimeEnvironment({ [EnvVars.API_BASE]: apiBase })
    })).rejects.toThrow();
    expect(requests).toBe(1);
  });
});
