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
import { Scheduler } from './Scheduler.js';
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

export interface RuntimeTool {
  name: string;
  description: string;
  parameters?: unknown;
  execute: (...args: any[]) => unknown;
}

export interface RuntimePlugin {
  name: string;
  tools: RuntimeTool[];
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

export function createRuntimeServices(): RuntimeServices {
  const configLoader = new ConfigLoader();
  const eventStore = new EventStore(configLoader);
  const observability = new Observability(configLoader);
  const flowManager = new FlowManager();
  const domainEventEmitter = new DomainEventEmitter(eventStore);
  const domainEvents = new DomainEvents(domainEventEmitter);
  const shellCommandParser = new ShellCommandParser();

  const artifactPaths = new ArtifactPaths(configLoader);
  const planWriteSet = new PlanWriteSet(configLoader, artifactPaths);

  const bdPlugin = createBdPlugin(eventStore);
  const gitPlugin = createGitPlugin(eventStore, configLoader, bdPlugin);
  const teammateFactory = new TeammateFactory(observability, configLoader, eventStore);

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
    fileMutationPolicy: new FileAccessPolicy(eventStore, shellCommandParser, planWriteSet),
    shellCommandParser,
    transactionalStateGuard: new TransactionalStateGuard(configLoader, artifactPaths, eventStore, planWriteSet),
    toolCallPathFactory: new ToolCallPathFactory(),
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
