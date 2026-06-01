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
import { EnvVars, PluginToolName } from '../constants/index.js';
import type { BeadsPort, WorktreePort, TeammateSpawner } from './OrchestrationPorts.js';
import type { Bead } from '../types/index.js';
// WorktreeResult is defined in OrchestrationPorts; re-exported here for
// backward compatibility with existing callers (git.ts, extension.ts, etc.)
export type { WorktreeResult } from './OrchestrationPorts.js';
import type {
  WorktreeResult,
  BeadReadyOptions,
  BeadListOptions,
  BeadListResult,
  BeadClaimOptions
} from './OrchestrationPorts.js';

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

/** Result contract for git merge/remove tools. Defined in core so that both
 * core consumers and plugin implementations share the same shape. */
export interface MergeResult {
  success: boolean;
  error?: string;
}

export interface RuntimeServices {
  /** The project root resolved once at composition time from the injected env
   * (PROJECT_ROOT env var) or process.cwd(). All path resolution in the coordinator
   * process flows from this single value — no mutable module global needed. */
  projectRoot: string;
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
  /** Typed port for beads operations (BD_READY, BD_LIST, BD_GET_BEAD, BD_CLAIM, BD_RELEASE).
   * Constructed at composition time; missing tools fail at startup rather than mid-tick. */
  beadsPort: BeadsPort;
  /** Typed port for worktree operations (CREATE_WORKTREE).
   * Constructed at composition time; missing tools fail at startup rather than mid-tick. */
  worktreePort: WorktreePort;
  /** Typed spawner interface for teammate lifecycle management.
   * Satisfies the TeammateSpawner port without additional wrapping. */
  teammateSpawner: TeammateSpawner;
}

// ---------------------------------------------------------------------------
// Private helper — avoids importing requireTool from ToolRegistry (which itself
// imports from RuntimeServices, creating a circular dependency).
// ---------------------------------------------------------------------------

function requirePluginTool(plugin: RuntimePlugin, name: string): RuntimeTool {
  const tool = plugin.tools.find(t => t.name === name);
  if (!tool) {
    throw new Error(
      `Required tool "${name}" is not registered in plugin "${plugin.name}". ` +
      `Available tools: [${plugin.tools.map(t => t.name).join(', ')}]`
    );
  }
  return tool;
}

// ---------------------------------------------------------------------------
// Adapter implementations — inline in the composition layer so that adapter
// classes do not need to import back from RuntimeServices (which would create
// a circular dependency). The interfaces they implement live in OrchestrationPorts.
// ---------------------------------------------------------------------------

/**
 * Wraps the BD plugin, resolving all tool handles at construction time.
 * Throws a descriptive error immediately if any required tool is missing (fail-at-construction).
 */
class BeadsPortAdapter implements BeadsPort {
  private readonly readyTool;
  private readonly listTool;
  private readonly getBeadTool;
  private readonly claimTool;
  private readonly releaseTool;

  constructor(bdPlugin: RuntimePlugin) {
    this.readyTool = requirePluginTool(bdPlugin, PluginToolName.BD_READY);
    this.listTool = requirePluginTool(bdPlugin, PluginToolName.BD_LIST);
    this.getBeadTool = requirePluginTool(bdPlugin, PluginToolName.BD_GET_BEAD);
    this.claimTool = requirePluginTool(bdPlugin, PluginToolName.BD_CLAIM);
    this.releaseTool = requirePluginTool(bdPlugin, PluginToolName.BD_RELEASE);
  }

  async ready(options: BeadReadyOptions): Promise<Bead[]> {
    return (await this.readyTool.execute(options)) as Bead[];
  }

  async list(options: BeadListOptions): Promise<BeadListResult> {
    return (await this.listTool.execute(options)) as BeadListResult;
  }

  async getBead(id: string): Promise<Bead> {
    return (await this.getBeadTool.execute({ id })) as Bead;
  }

  async claim(options: BeadClaimOptions, ctx?: unknown): Promise<Bead> {
    return (await this.claimTool.execute(options, ctx)) as Bead;
  }

  async release(id: string): Promise<void> {
    await this.releaseTool.execute({ id });
  }
}

/**
 * Wraps the Git plugin, resolving the CREATE_WORKTREE tool at construction time.
 * Throws a descriptive error immediately if the tool is missing (fail-at-construction).
 */
class WorktreePortAdapter implements WorktreePort {
  private readonly createWorktreeTool;

  constructor(gitPlugin: RuntimePlugin) {
    this.createWorktreeTool = requirePluginTool(gitPlugin, PluginToolName.CREATE_WORKTREE);
  }

  async createWorktree(beadId: string, ctx?: unknown): Promise<WorktreeResult> {
    return (await this.createWorktreeTool.execute({ beadId }, ctx)) as WorktreeResult;
  }
}

export function createRuntimeServices(env: RuntimeEnvironment = nodeRuntimeEnvironment, explicitProjectRoot?: string): RuntimeServices {
  // Resolve projectRoot ONCE at the composition boundary.
  // Precedence: explicitProjectRoot > env PROJECT_ROOT > process.cwd()
  // Use || (not ??) to match WI-1 precedence: empty-string PROJECT_ROOT falls back.
  const projectRoot = explicitProjectRoot || env.env(EnvVars.PROJECT_ROOT) || process.cwd();

  const configLoader = new ConfigLoader(env, projectRoot);
  const eventStore = new EventStore(configLoader, undefined, env, projectRoot);
  const observability = new Observability(configLoader, env, projectRoot);
  const flowManager = new FlowManager();
  const domainEventEmitter = new DomainEventEmitter(eventStore);
  const domainEvents = new DomainEvents(domainEventEmitter);
  const shellCommandParser = new ShellCommandParser();

  const artifactPaths = new ArtifactPaths(configLoader, env, projectRoot);
  const planWriteSet = new PlanWriteSet(configLoader, artifactPaths, projectRoot);

  const bdPlugin = createBdPlugin(eventStore, env, projectRoot);
  const gitPlugin = createGitPlugin(eventStore, configLoader, bdPlugin);
  const apiAddress: ApiAddress = {};
  const teammateFactory = new TeammateFactory(observability, configLoader, eventStore, apiAddress, undefined, undefined, undefined, env, projectRoot);
  const projectToolBackpressure: ProjectToolBackpressure = new Map();
  const instructionLoader = new InstructionLoader(projectRoot);
  const requiredToolResolver = new RequiredToolResolver(planWriteSet, projectRoot);

  // Typed orchestration ports — adapters resolve their tool handles at construction
  // time via requireTool, so a missing plugin tool fails here (startup) rather than
  // mid-supervisor-tick.
  const beadsPort = new BeadsPortAdapter(bdPlugin);
  const worktreePort = new WorktreePortAdapter(gitPlugin);
  // TeammateFactory already satisfies the TeammateSpawner interface; no wrapper needed.
  const teammateSpawner: TeammateSpawner = teammateFactory;

  return {
    projectRoot,
    configLoader,
    contextInjector: new ContextInjector(),
    eventStore,
    domainEventEmitter,
    domainEvents,
    flowManager,
    instructionLoader,
    observability,
    protocolInjector: new ProtocolInjector(),
    protocolParser: new ProtocolParser(),
    requiredToolResolver,
    scheduler: new Scheduler(configLoader, flowManager),
    mediator: new Mediator(domainEvents),
    telemetryStore: new TelemetryStore(),
    artifactPaths,
    planWriteSet,
    fileMutationPolicy: new FileAccessPolicy(eventStore, shellCommandParser, planWriteSet, env, projectRoot),
    shellCommandParser,
    transactionalStateGuard: new TransactionalStateGuard(configLoader, artifactPaths, eventStore, planWriteSet),
    toolCallPathFactory: new ToolCallPathFactory(),
    projectToolBackpressure,
    apiAddress,
    plugins: {
      bd: bdPlugin,
      git: gitPlugin,
      teammates: teammatePlugin(teammateFactory),
      mailbox: createMailboxPlugin(eventStore, projectRoot),
      quality: createQualityPlugin(),
      signaling: signalingPlugin,
      meta: createMetaPlugin(eventStore)
    },
    beadsPort,
    worktreePort,
    teammateSpawner
  };
}
