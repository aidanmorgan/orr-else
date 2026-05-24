import http from 'http';
import { Logger } from './Logger.js';
import { TeammateEvent, validateTeammateEvent } from './TeammateEvents.js';
import { Observability } from './Observability.js';
import { EventStore } from './EventStore.js';
import { ApiPath, Component, EnvVars, Defaults, DomainEventName, HttpHeader, HttpMethod, HttpStatus, Numeric, TeammateEventType } from '../constants/index.js';

type SignalHandler = (event: TeammateEvent) => Promise<void> | void;

export interface HeartbeatSnapshot {
  workerId: string;
  beadId?: string;
  stateId?: string;
  timestampMs: number;
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
    });
    req.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function writeJson(res: http.ServerResponse, status: number, value: any) {
  const payload = JSON.stringify(value);
  res.writeHead(status, {
    [HttpHeader.CONTENT_TYPE]: HttpHeader.APPLICATION_JSON,
    [HttpHeader.CONTENT_LENGTH]: Buffer.byteLength(payload)
  });
  res.end(payload);
}

export class SignalingServer {
  private server?: http.Server;
  private readonly heartbeats = new Map<string, number>();
  private readonly heartbeatDetails = new Map<string, HeartbeatSnapshot>();

  constructor(
    private readonly onSignal: SignalHandler,
    private readonly observability: Observability,
    private readonly eventStore: EventStore,
    private readonly port = Number.parseInt(process.env[EnvVars.API_PORT] || Defaults.API_PORT, Numeric.DECIMAL_RADIX)
  ) {}

  public async start(): Promise<number> {
    if (this.server) return this.port;

    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        try {
          const method = req.method || HttpMethod.GET;
          const url = new URL(req.url || '/', `http://${req.headers.host || Defaults.API_HOST}`);

          Logger.debug(Component.SIGNALING, `Request: ${method} ${url.pathname}`, { headers: req.headers });

          if (method === HttpMethod.POST && (url.pathname === ApiPath.SIGNAL || url.pathname === ApiPath.SIGNALS || url.pathname === ApiPath.EVENTS)) {
            let body: any;
            try {
              body = await readJson(req);
            } catch (error) {
              Logger.warn(Component.SIGNALING, 'Malformed JSON in request body', { error: String(error) });
              writeJson(res, HttpStatus.BAD_REQUEST, { error: `invalid JSON request body: ${String(error)}` });
              return;
            }

            const validation = validateTeammateEvent(body);
            if (!validation.ok || !validation.event) {
              Logger.warn(Component.SIGNALING, 'Invalid teammate event received', { error: validation.error, body });
              writeJson(res, HttpStatus.BAD_REQUEST, { error: validation.error || 'invalid teammate event' });
              return;
            }

            const tracedSignal = this.observability.tracedAsync(`signal:${validation.event.type}`, {
              'agent.bead_id': validation.event.beadId,
              'agent.worker_id': validation.event.workerId,
              'agent.event_type': validation.event.type
            }, async (event: TeammateEvent) => {
              Logger.info(Component.SIGNALING, 'Received signal', { 
                type: event.type, 
                beadId: event.beadId, 
                workerId: event.workerId,
                stateId: event.stateId
              });

              await this.onSignal(event);
              if (event.type === TeammateEventType.HEARTBEAT) {
                const timestampMs = Date.now();
                this.heartbeats.set(event.workerId, timestampMs);
                this.heartbeatDetails.set(event.workerId, {
                  workerId: event.workerId,
                  beadId: event.beadId,
                  stateId: event.stateId,
                  timestampMs
                });
                await this.eventStore.record(DomainEventName.HEARTBEAT_RECORDED, {
                  beadId: event.beadId,
                  workerId: event.workerId,
                  stateId: event.stateId
                });
              }
            });

            await tracedSignal(validation.event);
            writeJson(res, HttpStatus.OK, { ok: true });
            return;
          }

          if (method === HttpMethod.POST && url.pathname === ApiPath.HEARTBEAT) {
            const body = await readJson(req);
            if (body.workerId !== undefined) {
              Logger.debug(Component.SIGNALING, 'Manual heartbeat received', { workerId: body.workerId });
              const workerId = String(body.workerId);
              const timestampMs = Date.now();
              this.heartbeats.set(workerId, timestampMs);
              this.heartbeatDetails.set(workerId, { workerId, timestampMs });
              await this.eventStore.record(DomainEventName.HEARTBEAT_RECORDED, {
                workerId
              });
            } else if (body.pid !== undefined) {
              Logger.debug(Component.SIGNALING, 'Manual heartbeat received', { pid: body.pid });
              const workerId = String(body.pid);
              const timestampMs = Date.now();
              this.heartbeats.set(workerId, timestampMs);
              this.heartbeatDetails.set(workerId, { workerId, timestampMs });
              await this.eventStore.record(DomainEventName.HEARTBEAT_RECORDED, {
                workerId
              });
            }
            writeJson(res, HttpStatus.OK, { ok: true });
            return;
          }

          if (method === HttpMethod.GET && url.pathname === ApiPath.HEARTBEATS) {
            writeJson(res, HttpStatus.OK, Object.fromEntries(this.heartbeats.entries()));
            return;
          }

          Logger.warn(Component.SIGNALING, 'Route not found', { method, pathname: url.pathname });
          writeJson(res, HttpStatus.NOT_FOUND, { error: 'not found' });
        } catch (error) {
          Logger.error(Component.SIGNALING, 'Internal server error', { error: String(error), stack: (error as Error).stack });
          writeJson(res, HttpStatus.INTERNAL_SERVER_ERROR, { error: String(error) });
        }
      });

      this.server.listen(this.port, Defaults.API_HOST, () => {
        const address = this.server?.address();
        const actualPort = typeof address === 'object' && address ? address.port : this.port;
        Logger.info(Component.SIGNALING, 'Orr Else signaling server started', { port: actualPort });
        resolve(actualPort);
      });

      this.server.on('error', reject);
    });
  }

  public stop() {
    this.server?.close();
    this.server = undefined;
    this.heartbeats.clear();
    this.heartbeatDetails.clear();
  }

  public getHeartbeatSnapshot(): HeartbeatSnapshot[] {
    return [...this.heartbeatDetails.values()];
  }
}
