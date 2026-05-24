import { ArtifactPaths } from './ArtifactPaths.js';
import { ConfigLoader } from './ConfigLoader.js';
import { ContextInjector } from './ContextInjector.js';
import { DomainEventEmitter, DomainEvents } from './DomainEvents.js';
import { EventStore } from './EventStore.js';
import { FlowManager } from './FlowManager.js';
import { InstructionLoader } from './InstructionLoader.js';
import { Mediator } from './Mediator.js';
import { Observability } from './Observability.js';
import { ProtocolInjector } from './ProtocolInjector.js';
import { ProtocolParser } from './ProtocolParser.js';
import { Scheduler } from './Scheduler.js';
import { TelemetryStore } from './Telemetry.js';
import { ToolCallPathFactory } from './ToolCallPathFactory.js';
import { createBdPlugin } from '../plugins/bd.js';
import { createGitPlugin } from '../plugins/git.js';
import { createMailboxPlugin } from '../plugins/mailbox.js';
import { createMetaPlugin } from '../plugins/meta.js';
import { createQualityPlugin } from '../plugins/quality.js';

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
  scheduler: Scheduler;
  telemetryStore: TelemetryStore;
  artifactPaths: ArtifactPaths;
  toolCallPathFactory: ToolCallPathFactory;
  plugins: {
    bd: RuntimePlugin;
    git: RuntimePlugin;
    mailbox: RuntimePlugin;
    quality: RuntimePlugin;
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
    scheduler: new Scheduler(configLoader, flowManager),
    mediator: new Mediator(domainEvents),
    telemetryStore: new TelemetryStore(),
    artifactPaths: new ArtifactPaths(configLoader),
    toolCallPathFactory: new ToolCallPathFactory(),
    plugins: {
      bd: createBdPlugin(eventStore),
      git: createGitPlugin(eventStore),
      mailbox: createMailboxPlugin(eventStore),
      quality: createQualityPlugin(),
      meta: createMetaPlugin(eventStore)
    }
  };
}
