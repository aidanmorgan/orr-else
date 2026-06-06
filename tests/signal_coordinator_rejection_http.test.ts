/**
 * pi-experiment-qlm4: postHarnessSignal real HTTP server tests.
 *
 * These tests run the REAL postHarnessSignal against a local HTTP server
 * (no module mock) to verify that the transport-vs-acceptance distinction
 * is implemented correctly in the HTTP layer.
 *
 * Kept in a separate file from signal_coordinator_rejection.test.ts which
 * uses a top-level vi.mock for HarnessApiClient.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EnvVars } from '../src/constants/index.js';
import type { TeammateEvent } from '../src/core/TeammateEvents.js';
import type { RuntimeEnvironment } from '../src/core/RuntimeEnvironment.js';
import { postHarnessSignal, CoordinatorRejectionError } from '../src/core/HarnessApiClient.js';

function makeRuntimeEnvironment(vars: Record<string, string>): RuntimeEnvironment {
  return { env: (name: string) => vars[name] };
}

async function startHttpServer(
  handler: Parameters<typeof createServer>[0]
): Promise<{ server: Server; apiBase: string }> {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, apiBase: `http://127.0.0.1:${port}` };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(err => (err ? reject(err) : resolve()));
  });
}

function makeTestEvent(): TeammateEvent {
  return {
    type: 'STATE_TRANSITIONED',
    beadId: 'bd-qlm4-http',
    workerId: 'w-qlm4-http',
    sessionStateId: undefined,
    stateId: 'Implementation',
    idempotencyKey: 'idem-qlm4-http-1',
    timestamp: Date.now(),
    actionId: 'implement',
    transitionEvent: 'SUCCESS',
    summary: 'done',
    evidence: 'done',
    handover: 'done'
  } as unknown as TeammateEvent;
}

describe('postHarnessSignal — coordinator acceptance classification via real HTTP (qlm4 AC1+AC4)', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server?.listening) await closeServer(server);
    server = undefined;
  });

  it('AC4: ok:true response resolves with {ok:true} — accepted path preserved', async () => {
    const started = await startHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    server = started.server;

    const runtimeEnv = makeRuntimeEnvironment({ [EnvVars.API_BASE]: started.apiBase });
    const result = await postHarnessSignal(makeTestEvent(), { runtimeEnvironment: runtimeEnv });
    expect(result).toMatchObject({ ok: true });
  });

  it('AC4 + AC1: ok:false timedOut:true response throws CoordinatorRejectionError', async () => {
    const started = await startHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, timedOut: true }));
    });
    server = started.server;

    const runtimeEnv = makeRuntimeEnvironment({ [EnvVars.API_BASE]: started.apiBase });
    await expect(postHarnessSignal(makeTestEvent(), { runtimeEnvironment: runtimeEnv }))
      .rejects.toThrow(CoordinatorRejectionError);
  });

  it('AC4 + AC1: ok:false blocked:true response throws CoordinatorRejectionError', async () => {
    const gateVerdict = { pass: false, failures: [{ tool: 'verify', verdict: 'FAIL', reasons: ['missing artifact'] }], rejectMessage: 'gate blocked' };
    const started = await startHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, blocked: true, gate: gateVerdict }));
    });
    server = started.server;

    const runtimeEnv = makeRuntimeEnvironment({ [EnvVars.API_BASE]: started.apiBase });
    await expect(postHarnessSignal(makeTestEvent(), { runtimeEnvironment: runtimeEnv }))
      .rejects.toThrow(CoordinatorRejectionError);
  });

  it('AC1: ok:false blocked response error carries rule:blocked and gate verdict', async () => {
    const gateVerdict = { pass: false, failures: [], rejectMessage: 'blocked by gate' };
    const started = await startHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, blocked: true, gate: gateVerdict }));
    });
    server = started.server;

    const runtimeEnv = makeRuntimeEnvironment({ [EnvVars.API_BASE]: started.apiBase });
    let caught: unknown;
    try {
      await postHarnessSignal(makeTestEvent(), { runtimeEnvironment: runtimeEnv });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CoordinatorRejectionError);
    const err = caught as CoordinatorRejectionError;
    expect(err.rule).toBe('blocked');
    expect(err.gate).toEqual(gateVerdict);
  });

  it('AC1: ok:false timedOut response error carries rule:timedOut', async () => {
    const started = await startHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, timedOut: true }));
    });
    server = started.server;

    const runtimeEnv = makeRuntimeEnvironment({ [EnvVars.API_BASE]: started.apiBase });
    let caught: unknown;
    try {
      await postHarnessSignal(makeTestEvent(), { runtimeEnvironment: runtimeEnv });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CoordinatorRejectionError);
    const err = caught as CoordinatorRejectionError;
    expect(err.rule).toBe('timedOut');
    expect(err.timedOut).toBe(true);
  });

  it('AC1: response body missing ok field (e.g. {status:"queued"}) throws CoordinatorRejectionError', async () => {
    const started = await startHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'queued' })); // no ok field
    });
    server = started.server;

    const runtimeEnv = makeRuntimeEnvironment({ [EnvVars.API_BASE]: started.apiBase });
    let caught: unknown;
    try {
      await postHarnessSignal(makeTestEvent(), { runtimeEnvironment: runtimeEnv });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CoordinatorRejectionError);
    const err = caught as CoordinatorRejectionError;
    expect(err.rule).toBe('malformed');
  });

  it('AC1: response body is a JSON array (not an object) throws CoordinatorRejectionError', async () => {
    const started = await startHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([1, 2, 3]));
    });
    server = started.server;

    const runtimeEnv = makeRuntimeEnvironment({ [EnvVars.API_BASE]: started.apiBase });
    let caught: unknown;
    try {
      await postHarnessSignal(makeTestEvent(), { runtimeEnvironment: runtimeEnv });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CoordinatorRejectionError);
    const err = caught as CoordinatorRejectionError;
    expect(err.rule).toBe('malformed');
  });

  it('AC4: non-2xx transport failure (500) throws a transport error, NOT CoordinatorRejectionError', async () => {
    const started = await startHttpServer((_req, res) => {
      res.writeHead(500);
      res.end('server error');
    });
    server = started.server;

    const runtimeEnv = makeRuntimeEnvironment({ [EnvVars.API_BASE]: started.apiBase });
    let caught: unknown;
    try {
      await postHarnessSignal(makeTestEvent(), { runtimeEnvironment: runtimeEnv, attempts: 1 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught).not.toBeInstanceOf(CoordinatorRejectionError);
  });
});
