import { ArtifactPaths } from './ArtifactPaths.js';
import { ConfigLoader } from './ConfigLoader.js';
import { ContextInjector } from './ContextInjector.js';
import { DomainEventEmitter, DomainEvents } from './DomainEvents.js';
import { EventStore } from './EventStore.js';
import { FileAccessPolicy } from './FileAccessPolicy.js';
import { FlowManager } from './FlowManager.js';
import { InstructionLoader } from './InstructionLoader.js';
import { Mediator } from './Mediator.js';
import { Observability } from './Observability.js';
import { PlanWriteSet } from './PlanWriteSet.js';
import { ProtocolInjector } from './ProtocolInjector.js';
import { ProtocolParser } from './ProtocolParser.js';
import { RequiredToolResolver } from './RequiredToolResolver.js';
import { nodeRuntimeEnvironment, type RuntimeEnvironment } from './RuntimeEnvironment.js';
import { Scheduler } from './Scheduler.js';
import type { ApiAddress } from '../types/index.js';
export type { ApiAddress } from '../types/index.js';
import { ShellCommandParser } from './ShellCommandParser.js';
import { TelemetryStore } from './Telemetry.js';
import { ToolCallPathFactory } from './ToolCallPathFactory.js';
import { TransactionalStateGuard } from './TransactionalStateGuard.js';
import { createBdPlugin } from '../plugins/bd.js';
import { createGitPlugin } from '../plugins/git.js';
import { createMailboxPlugin } from '../plugins/mailbox.js';
import { createMetaPlugin } from '../plugins/meta.js';
import { createQualityPlugin } from '../plugins/quality.js';
import { signalingPlugin } from '../plugins/signaling.js';
import { teammatePlugin, TeammateFactory } from '../plugins/teammates.js';

/** Shape of a single in-flight project-tool call entry tracked by the backpressure map.
 * Defined here in core so the map type can live in RuntimeServices without a core→plugin import. */
export interface InFlightProjectToolCall {
  token: string;
  startedAtMs: number;
}

/** Process-scoped in-flight backpressure map for project-tool calls.
 * Created once in createRuntimeServices and injected wherever project tools are executed,
 * so backpressure state is owned by the coordinator process rather than module-level statics. */
export type ProjectToolBackpressure = Map<string, InFlightProjectToolCall>;

export interface RuntimeTool {
  name: string;
  description: string;
  parameters?: unknown;
  execute(params: unknown, ctx?: unknown): unknown | Promise<unknown>;
}

export interface RuntimePlugin {
  name: string;
  tools: RuntimeTool[];
}

/** Result contract for git worktree provisioning tools. Defined in core so that
 * both core consumers (Supervisor) and plugin implementations (git plugin) can
 * reference the same shape without a core→plugin import. */
export interface WorktreeResult {
  success: boolean;
  path?: string;
  error?: string;
}

/** Result contract for git merge/remove tools. Defined in core so that both
 * core consumers and plugin implementations share the same shape. */
export interface MergeResult {
  success: boolean;
  error?: string;
}

export interface RuntimeServices {
  configLoader: ConfigLoader;
  contextInjector: ContextInjector;
  eventStore: EventStore;
  domainEventEmitter: DomainEventEmitter;
  domainEvents: DomainEvents;
  flowManager: FlowManager;
  instructionLoader: InstructionLoader;
  mediator: Mediator;
  observability: Observability;
  protocolInjector: ProtocolInjector;
  protocolParser: ProtocolParser;
  requiredToolResolver: RequiredToolResolver;
  scheduler: Scheduler;
  telemetryStore: TelemetryStore;
  artifactPaths: ArtifactPaths;
  planWriteSet: PlanWriteSet;
  fileMutationPolicy: FileAccessPolicy;
  shellCommandParser: ShellCommandParser;
  transactionalStateGuard: TransactionalStateGuard;
  toolCallPathFactory: ToolCallPathFactory;
  projectToolBackpressure: ProjectToolBackpressure;
  /** Shared mutable holder for the SignalingServer's bound address.
   * startOrrElse mutates this after the server binds; all TeammateFactory instances
   * that hold a reference to this object see the update at spawn time. */
  apiAddress: ApiAddress;
  plugins: {
    bd: RuntimePlugin;
    git: RuntimePlugin;
    teammates: RuntimePlugin;
    mailbox: RuntimePlugin;
    quality: RuntimePlugin;
    signaling: RuntimePlugin;
    meta: RuntimePlugin;
  };
}

export function createRuntimeServices(env: RuntimeEnvironment = nodeRuntimeEnvironment): RuntimeServices {
  const configLoader = new ConfigLoader(env);
  const eventStore = new EventStore(configLoader, undefined, env);
  const observability = new Observability(configLoader, env);
  const flowManager = new FlowManager();
  const domainEventEmitter = new DomainEventEmitter(eventStore);
  const domainEvents = new DomainEvents(domainEventEmitter);
  const shellCommandParser = new ShellCommandParser();

  const artifactPaths = new ArtifactPaths(configLoader, env);
  const planWriteSet = new PlanWriteSet(configLoader, artifactPaths);

  const bdPlugin = createBdPlugin(eventStore, env);
  const gitPlugin = createGitPlugin(eventStore, configLoader, bdPlugin);
  const apiAddress: ApiAddress = {};
  const teammateFactory = new TeammateFactory(observability, configLoader, eventStore, apiAddress, undefined, undefined, undefined, env);
  const projectToolBackpressure: ProjectToolBackpressure = new Map();

  return {
    configLoader,
    contextInjector: new ContextInjector(),
    eventStore,
    domainEventEmitter,
    domainEvents,
    flowManager,
    instructionLoader: new InstructionLoader(),
    observability,
    protocolInjector: new ProtocolInjector(),
    protocolParser: new ProtocolParser(),
    requiredToolResolver: new RequiredToolResolver(planWriteSet),
    scheduler: new Scheduler(configLoader, flowManager),
    mediator: new Mediator(domainEvents),
    telemetryStore: new TelemetryStore(),
    artifactPaths,
    planWriteSet,
    fileMutationPolicy: new FileAccessPolicy(eventStore, shellCommandParser, planWriteSet, env),
    shellCommandParser,
    transactionalStateGuard: new TransactionalStateGuard(configLoader, artifactPaths, eventStore, planWriteSet),
    toolCallPathFactory: new ToolCallPathFactory(),
    projectToolBackpressure,
    apiAddress,
    plugins: {
      bd: bdPlugin,
      git: gitPlugin,
      teammates: teammatePlugin(teammateFactory),
      mailbox: createMailboxPlugin(eventStore),
      quality: createQualityPlugin(),
      signaling: signalingPlugin,
      meta: createMetaPlugin(eventStore)
    }
  };
}
