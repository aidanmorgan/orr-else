import http from 'http';
import express, { type NextFunction, type Request, type Response } from 'express';
import { Logger } from './Logger.js';
import { TeammateEvent, validateTeammateEvent } from './TeammateEvents.js';
import { Observability } from './Observability.js';
import { EventStore } from './EventStore.js';
import { nodeRuntimeEnvironment, type RuntimeEnvironment } from './RuntimeEnvironment.js';
import { ApiPath, Component, EnvVars, Defaults, DomainEventName, HttpStatus, Numeric, OtelAttr, TeammateEventType, WorkerDefaults } from '../constants/index.js';

/**
 * The structured gate verdict the COORDINATOR rounds back to the caller for a
 * GATED status-mutating completion signal (pi-experiment-0yt5.20 AC3). Carries
 * the verifier-gate pass/fail + the structured failures + a rendered reject so
 * the worker receives the verdict SYNCHRONOUSLY and can remediate — instead of
 * a fire-and-forget {ok:true} that surfaced the verdict only via BLOCKED status.
 */
export interface SignalGateVerdict {
  pass: boolean;
  /** Structured per-tool failures (tool/verdict/reasons); empty when pass. */
  failures: unknown[];
  /** A single rendered reject message; empty string when pass. */
  rejectMessage: string;
}

/**
 * The acknowledgement handle the SignalingServer passes to the signal handler.
 *
 * By default the server responds {ok:true} immediately and runs the handler
 * fire-and-forget (the pre-existing live behaviour for every signal). A handler
 * that owns a SYNCHRONOUS verdict (the gated status-mutating completion signal)
 * calls `hold()` SYNCHRONOUSLY — before its first await — so the server defers
 * the HTTP response, then calls `send(verdict)` once the gate has run. `send()`
 * with no verdict (or never holding) keeps the {ok:true} fire-and-forget path.
 */
export interface SignalAck {
  /** Synchronously defer the HTTP response until send() is called. */
  hold(): void;
  /** Resolve the deferred response, optionally carrying the gate verdict. */
  send(verdict?: SignalGateVerdict): void;
}

type SignalHandler = (event: TeammateEvent, ack: SignalAck) => Promise<void> | void;

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
  /**
   * Custom event type names declared in `statechart.customEvents` of the
   * harness config.  When provided, validateTeammateEvent will accept these
   * names in addition to the built-in TeammateEventType enum values.
   */
  allowedCustomEvents?: readonly string[];
  /**
   * Maximum milliseconds to wait for a held-ack gated handler to call send().
   * Defaults to WorkerDefaults.HELD_ACK_TIMEOUT_MS (25 s).
   * When the deadline elapses the server records TEAMMATE_SIGNAL_FAILED with
   * held: true metadata and responds with a retryable failure verdict.
   */
  heldAckTimeoutMs?: number;
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
  /** Per-bead promise chains that serialize async signal handling so a duplicate
   * (network-retry of the same idempotencyKey) cannot interleave with the original
   * and defeat the coordinator's check-then-act idempotency guard (xmp3). */
  private readonly signalChains = new Map<string, Promise<void>>();
  private readonly port: number;
  private readonly allowedCustomEvents: ReadonlySet<string>;
  private readonly heldAckTimeoutMs: number;
  /** Actual bound port, populated after start() resolves. */
  private boundPort?: number;

  constructor(
    private readonly onSignal: SignalHandler,
    private readonly observability: Observability,
    private readonly eventStore: EventStore,
    portOrOptions: number | RuntimeEnvironment | SignalingServerOptions = {}
  ) {
    this.port = resolvePort(portOrOptions);
    const options = typeof portOrOptions === 'object' && !isRuntimeEnvironment(portOrOptions)
      ? (portOrOptions as SignalingServerOptions)
      : undefined;
    this.allowedCustomEvents = new Set(options?.allowedCustomEvents ?? []);
    this.heldAckTimeoutMs = options?.heldAckTimeoutMs ?? WorkerDefaults.HELD_ACK_TIMEOUT_MS;
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
        const validation = validateTeammateEvent(req.body || {}, this.allowedCustomEvents);
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
          // Heartbeats are never gated — pass a no-op ack so the handler signature
          // is satisfied without ever deferring the (already-immediate) response.
          await this.onSignal(event, { hold: () => {}, send: () => {} });
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

        // ── Synchronous verdict round-trip (pi-experiment-0yt5.20 AC3) ──────────
        // By default the HTTP response is sent immediately and handling runs
        // fire-and-forget (the pre-existing live behaviour). A handler that owns
        // a SYNCHRONOUS verdict — the GATED status-mutating completion signal —
        // calls ack.hold() in its synchronous prelude (before its first await) to
        // defer the response, then ack.send(verdict) once the gate has run. We
        // give the handler's synchronous prelude one microtask to call hold()
        // before deciding whether to respond now or await the verdict.
        let held = false;
        let responseSent = false;
        let heldTimedOut = false;
        let resolveSend: () => void = () => {};
        const sendDeferred = new Promise<void>(resolve => { resolveSend = resolve; });
        let verdict: SignalGateVerdict | undefined;
        const ack: SignalAck = {
          hold: () => { held = true; },
          send: (gateVerdict?: SignalGateVerdict) => {
            verdict = gateVerdict;
            resolveSend();
          }
        };

        const tracedSignal = this.observability.tracedAsync(`signal:${event.type}`, {
          [OtelAttr.AGENT_BEAD_ID]: event.beadId,
          [OtelAttr.AGENT_WORKER_ID]: event.workerId,
          [OtelAttr.AGENT_EVENT_TYPE]: event.type,
          [OtelAttr.ORR_ELSE_BEAD_ID]: event.beadId,
          [OtelAttr.ORR_ELSE_STATE_ID]: event.stateId,
          [OtelAttr.ORR_ELSE_WORKER_ID]: event.workerId
        }, async (event: TeammateEvent) => {
          Logger.info(Component.SIGNALING, 'Received signal', {
            type: event.type,
            beadId: event.beadId,
            workerId: event.workerId,
            stateId: event.stateId
          });
          await this.onSignal(event, ack);
          // A held handler that never explicitly sent (e.g. no gate ran on this
          // path) still releases the deferred response with no verdict.
          resolveSend();
        });

        // Enqueue the handler on this bead's serialization chain: handling runs
        // sequentially per bead so a duplicate retry observes the original's
        // recorded idempotency key (xmp3).
        this.enqueueBeadSignal(event.beadId, () => tracedSignal(event).catch(async error => {
          Logger.error(Component.SIGNALING, 'Asynchronous teammate signal handler failed', {
            type: event.type,
            beadId: event.beadId,
            workerId: event.workerId,
            stateId: event.stateId,
            error: String(error),
            stack: (error as Error).stack
          });
          // If the held-ack timeout already fired and recorded TEAMMATE_SIGNAL_FAILED,
          // skip recording a second event for the same signal (double-record guard).
          if (!heldTimedOut) {
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
          }
          // Release any held response so a failing held handler never hangs the
          // caller — it falls back to the {ok:true} acknowledgement.
          resolveSend();
        }));

        // The handler's synchronous prelude calls ack.hold() (before its first
        // await) when it owns a synchronous verdict — the gated status-mutating
        // completion signal. A setImmediate yields a full macrotask, after the
        // entire microtask queue (the enqueued handler + its traced/context hops)
        // has drained, so `held` is observed deterministically — without racing
        // the gate. If held, defer the response until the verdict (or the handler)
        // settles and round-trip the structured gate verdict; otherwise respond
        // now and keep the pre-existing fire-and-forget behaviour for every other
        // signal.
        await new Promise<void>(resolve => setImmediate(resolve));
        if (held) {
          // Race the deferred send against the bounded held-ack timeout so a
          // hung gated handler never holds the HTTP connection indefinitely.
          // Mirror the VerifierGate.ts idiom: capture the handle and clear it
          // in a finally so the timer never outlives the race on either path.
          const timeoutMs = this.heldAckTimeoutMs;
          let heldTimer: ReturnType<typeof setTimeout> | undefined;
          const timeoutRace = new Promise<void>(resolve => {
            heldTimer = setTimeout(() => {
              heldTimedOut = true;
              resolve();
            }, timeoutMs);
          });
          try {
            await Promise.race([sendDeferred, timeoutRace]);
          } finally {
            if (heldTimer) clearTimeout(heldTimer);
          }

          if (heldTimedOut) {
            // heldTimedOut=true signals the bead-chain catch block to skip
            // recording a second TEAMMATE_SIGNAL_FAILED (double-record guard).
            // The gated handler hung — record a failure event with held-timeout
            // metadata so operators can diagnose which handler stalled, then
            // return a retryable failure so the worker can act on it.
            Logger.error(Component.SIGNALING, 'Held-ack timeout: gated handler did not call send() within deadline', {
              type: event.type,
              beadId: event.beadId,
              workerId: event.workerId,
              stateId: event.stateId,
              timeoutMs
            });
            try {
              await this.eventStore.record(DomainEventName.TEAMMATE_SIGNAL_FAILED, {
                held: true,
                timeoutMs,
                type: event.type,
                beadId: event.beadId,
                workerId: event.workerId,
                stateId: event.stateId,
                idempotencyKey: event.idempotencyKey
              });
            } catch (recordError) {
              Logger.error(Component.SIGNALING, 'Failed to record held-ack timeout failure', {
                error: String(recordError),
                stack: (recordError as Error).stack
              });
            }
            if (!responseSent) {
              responseSent = true;
              res.status(HttpStatus.OK).json({ ok: false, timedOut: true });
            }
            return;
          }

          if (!responseSent) {
            responseSent = true;
            if (verdict && !verdict.pass) {
              // Block: a structured rejection the worker can remediate against.
              res.status(HttpStatus.OK).json({ ok: false, blocked: true, gate: verdict });
            } else if (verdict) {
              res.status(HttpStatus.OK).json({ ok: true, gate: verdict });
            } else {
              res.status(HttpStatus.OK).json({ ok: true });
            }
          }
          return;
        }
        if (!responseSent) {
          responseSent = true;
          res.status(HttpStatus.OK).json({ ok: true });
        }
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
        this.boundPort = actualPort;
        Logger.info(Component.SIGNALING, 'Orr Else signaling server started', { port: actualPort });
        resolve(actualPort);
      });

      this.server.on('error', reject);
    });
  }

  /**
   * Run `handler` after any previously-enqueued handler for the same bead has
   * settled, so signal handling is serialized per bead. The chain link always
   * runs (regardless of the prior link's outcome) and the chain entry is pruned
   * once it settles with nothing newer queued, keeping the map bounded.
   */
  private enqueueBeadSignal(beadId: string, handler: () => Promise<void>): void {
    const key = beadId || '__unkeyed__';
    const previous = this.signalChains.get(key) ?? Promise.resolve();
    const next = previous.then(handler, handler);
    this.signalChains.set(key, next);
    void next.finally(() => {
      if (this.signalChains.get(key) === next) this.signalChains.delete(key);
    });
  }

  public stop() {
    this.server?.close();
    this.server = undefined;
    this.boundPort = undefined;
    this.heartbeats.clear();
    this.heartbeatDetails.clear();
    this.signalChains.clear();
  }

  /** Returns true if the HTTP server is currently listening. */
  public isListening(): boolean {
    return this.server?.listening === true;
  }

  /** Returns the actual bound port after start() resolves, or undefined if not started. */
  public getListeningPort(): number | undefined {
    return this.boundPort;
  }

  public getHeartbeatSnapshot(): HeartbeatSnapshot[] {
    return [...this.heartbeatDetails.values()];
  }
}
