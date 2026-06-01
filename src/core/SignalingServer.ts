import http from 'http';
import express, { type NextFunction, type Request, type Response } from 'express';
import { Logger } from './Logger.js';
import { TeammateEvent, validateTeammateEvent } from './TeammateEvents.js';
import { Observability } from './Observability.js';
import { EventStore } from './EventStore.js';
import { nodeRuntimeEnvironment, type RuntimeEnvironment } from './RuntimeEnvironment.js';
import { ApiPath, Component, EnvVars, Defaults, DomainEventName, HttpStatus, Numeric, TeammateEventType, WorkerDefaults } from '../constants/index.js';

type SignalHandler = (event: TeammateEvent) => Promise<void> | void;

export interface HeartbeatSnapshot {
  workerId: string;
  beadId?: string;
  stateId?: string;
  timestampMs: number;
}

type AsyncRoute = (req: Request, res: Response) => Promise<void> | void;

export interface SignalingServerOptions {
  port?: number;
  runtimeEnvironment?: RuntimeEnvironment;
}

function asyncRoute(route: AsyncRoute) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(route(req, res)).catch(next);
  };
}

function isRuntimeEnvironment(value: unknown): value is RuntimeEnvironment {
  return typeof value === 'object'
    && value !== null
    && typeof (value as RuntimeEnvironment).env === 'function';
}

function resolvePort(portOrOptions: number | RuntimeEnvironment | SignalingServerOptions): number {
  if (typeof portOrOptions === 'number') return portOrOptions;

  const options = isRuntimeEnvironment(portOrOptions)
    ? { runtimeEnvironment: portOrOptions }
    : portOrOptions;
  const runtimeEnvironment = options.runtimeEnvironment || nodeRuntimeEnvironment;
  return options.port ?? Number.parseInt(runtimeEnvironment.env(EnvVars.API_PORT) || Defaults.API_PORT, Numeric.DECIMAL_RADIX);
}

export class SignalingServer {
  private server?: http.Server;
  private readonly heartbeats = new Map<string, number>();
  private readonly heartbeatDetails = new Map<string, HeartbeatSnapshot>();
  private readonly lastRecordedHeartbeatMs = new Map<string, number>();
  private readonly port: number;

  constructor(
    private readonly onSignal: SignalHandler,
    private readonly observability: Observability,
    private readonly eventStore: EventStore,
    portOrOptions: number | RuntimeEnvironment | SignalingServerOptions = {}
  ) {
    this.port = resolvePort(portOrOptions);
  }

  public async start(): Promise<number> {
    if (this.server) return this.port;

    return new Promise((resolve, reject) => {
      const app = express();
      app.use(express.json({ strict: false }));
      app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
        if (!error) {
          next();
          return;
        }
        Logger.warn(Component.SIGNALING, 'Malformed JSON in request body', { error: String(error) });
        res.status(HttpStatus.BAD_REQUEST).json({ error: `invalid JSON request body: ${String(error)}` });
      });

      app.post([ApiPath.SIGNAL, ApiPath.SIGNALS, ApiPath.EVENTS], asyncRoute(async (req, res) => {
        const validation = validateTeammateEvent(req.body || {});
        if (!validation.ok || !validation.event) {
          Logger.warn(Component.SIGNALING, 'Invalid teammate event received', { error: validation.error, body: req.body });
          res.status(HttpStatus.BAD_REQUEST).json({ error: validation.error || 'invalid teammate event' });
          return;
        }
        const event = validation.event;

        // Fast path for heartbeats: keep the in-memory liveness snapshot fresh
        // on every beat, but skip the OTEL span and only record a domain event
        // every WorkerDefaults.HEARTBEAT_RECORD_INTERVAL_MS per worker. At 1Hz
        // heartbeat × 6 workers this previously dominated OTEL byte volume.
        if (event.type === TeammateEventType.HEARTBEAT) {
          const timestampMs = Date.now();
          this.heartbeats.set(event.workerId, timestampMs);
          this.heartbeatDetails.set(event.workerId, {
            workerId: event.workerId,
            beadId: event.beadId,
            stateId: event.stateId,
            timestampMs
          });
          await this.onSignal(event);
          const lastRecorded = this.lastRecordedHeartbeatMs.get(event.workerId) || 0;
          if (timestampMs - lastRecorded >= WorkerDefaults.HEARTBEAT_RECORD_INTERVAL_MS) {
            this.lastRecordedHeartbeatMs.set(event.workerId, timestampMs);
            await this.eventStore.record(DomainEventName.HEARTBEAT_RECORDED, {
              beadId: event.beadId,
              workerId: event.workerId,
              stateId: event.stateId
            });
          }
          res.status(HttpStatus.OK).json({ ok: true });
          return;
        }

        const tracedSignal = this.observability.tracedAsync(`signal:${event.type}`, {
          'agent.bead_id': event.beadId,
          'agent.worker_id': event.workerId,
          'agent.event_type': event.type,
          'orr_else.bead_id': event.beadId,
          'orr_else.state_id': event.stateId,
          'orr_else.worker_id': event.workerId
        }, async (event: TeammateEvent) => {
          Logger.info(Component.SIGNALING, 'Received signal', {
            type: event.type,
            beadId: event.beadId,
            workerId: event.workerId,
            stateId: event.stateId
          });
          await this.onSignal(event);
        });

        res.status(HttpStatus.OK).json({ ok: true });
        void tracedSignal(event).catch(async error => {
          Logger.error(Component.SIGNALING, 'Asynchronous teammate signal handler failed', {
            type: event.type,
            beadId: event.beadId,
            workerId: event.workerId,
            stateId: event.stateId,
            error: String(error),
            stack: (error as Error).stack
          });
          try {
            await this.eventStore.record(DomainEventName.TEAMMATE_SIGNAL_FAILED, {
              type: event.type,
              beadId: event.beadId,
              workerId: event.workerId,
              stateId: event.stateId,
              error: String(error)
            });
          } catch (recordError) {
            Logger.error(Component.SIGNALING, 'Failed to record asynchronous teammate signal failure', {
              error: String(recordError),
              stack: (recordError as Error).stack
            });
          }
        });
      }));

      app.post(ApiPath.HEARTBEAT, asyncRoute(async (req, res) => {
        const body = req.body || {};
        const workerIdValue = body.workerId ?? body.pid;
        if (workerIdValue !== undefined) {
          const workerId = String(workerIdValue);
          Logger.debug(Component.SIGNALING, 'Manual heartbeat received', { workerId });
          const timestampMs = Date.now();
          this.heartbeats.set(workerId, timestampMs);
          this.heartbeatDetails.set(workerId, { workerId, timestampMs });
          const lastRecorded = this.lastRecordedHeartbeatMs.get(workerId) || 0;
          if (timestampMs - lastRecorded >= WorkerDefaults.HEARTBEAT_RECORD_INTERVAL_MS) {
            this.lastRecordedHeartbeatMs.set(workerId, timestampMs);
            await this.eventStore.record(DomainEventName.HEARTBEAT_RECORDED, { workerId });
          }
        }
        res.status(HttpStatus.OK).json({ ok: true });
      }));

      app.get(ApiPath.HEARTBEATS, (_req, res) => {
        res.status(HttpStatus.OK).json(Object.fromEntries(this.heartbeats.entries()));
      });

      app.use((req, res) => {
        Logger.warn(Component.SIGNALING, 'Route not found', { method: req.method, pathname: req.path });
        res.status(HttpStatus.NOT_FOUND).json({ error: 'not found' });
      });

      app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
        Logger.error(Component.SIGNALING, 'Internal server error', { error: String(error), stack: (error as Error).stack });
        res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: String(error) });
      });

      this.server = app.listen(this.port, Defaults.API_HOST, () => {
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
