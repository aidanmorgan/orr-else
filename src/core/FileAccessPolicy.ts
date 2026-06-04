import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { quote as quoteShellArgs } from 'shell-quote';
import {
  Component,
  DomainEventName,
  EnvVars,
  FileMutationPolicyDefaults,
  NativePiToolName,
  OperationalArtifactPath,
  OperationalLogPath,
  ProcessFlag
} from '../constants/index.js';
import { Logger } from './Logger.js';
import { nodeRuntimeEnvironment, type RuntimeEnvironment } from './RuntimeEnvironment.js';
import type { EffectiveShellCommand, ParsedShellCommand, ParsedShellWord, ShellCommandParser } from './ShellCommandParser.js';
import type { EventStore } from './EventStore.js';
import type { PlanWriteSet } from './PlanWriteSet.js';
import type { ArtifactPaths } from './ArtifactPaths.js';

interface MutationContext {
  beadId?: string;
  stateId?: string;
  projectRoot: string;
  worktreePath: string;
  cwd: string;
  /** Absolute path to a configured named root exposed as the framework root, if set. */
  frameworkRoot?: string;
}

interface PolicyResult {
  rejection?: string;
  rewritten?: boolean;
  nextAction?: string;
  recovery?: string[];
}

interface ShellDeletion {
  kind: 'targets' | 'find';
  targets: ParsedShellWord[];
  findArgs?: string[];
}

const NATIVE_PATH_INPUT_KEYS = [
  'path',
  'filePath',
  'file_path',
  'targetFile',
  'target_file'
] as const;
const OPERATIONAL_MUTATION_DIRS = [
  OperationalArtifactPath.TEMP_DIR,
  OperationalArtifactPath.PI_EVENTS_DIR,
  OperationalArtifactPath.PI_LOGS_DIR,
  OperationalArtifactPath.PI_MAILBOX_DIR,
  OperationalArtifactPath.PI_OTEL_DIR,
  OperationalArtifactPath.PI_TRASH_DIR,
  OperationalArtifactPath.PI_TOOL_OUTPUT_DIR
] as const;
const OPERATIONAL_READ_DIRS = [
  OperationalArtifactPath.PI_EVENTS_DIR,
  OperationalArtifactPath.PI_LOGS_DIR,
  OperationalArtifactPath.PI_MAILBOX_DIR,
  OperationalArtifactPath.PI_OTEL_DIR,
  OperationalArtifactPath.PI_ARTIFACTS_DIR,
  OperationalArtifactPath.PI_TOOL_OUTPUT_DIR
] as const;
const PROJECT_TOOL_CALL_OUTPUT_DIR = `${OperationalArtifactPath.TEMP_DIR}/tool-calls`;
const PROJECT_TOOL_CALL_OUTPUT_READ_GUIDANCE =
  `PROTOCOL VIOLATION: \`${NativePiToolName.READ}\` may not read project-tool output archives directly. ` +
  'Use the inline project-tool result preview, rerun the configured project tool with narrower arguments, or use a harness-owned project-tool output preview when available.';

export class FileAccessPolicy {
  constructor(
    private readonly eventStore: EventStore,
    private readonly shellCommandParser: ShellCommandParser,
    private readonly planWriteSet: PlanWriteSet,
    private readonly env: RuntimeEnvironment = nodeRuntimeEnvironment,
    private readonly projectRoot: string = process.cwd(),
    private readonly artifactPaths?: ArtifactPaths
  ) {}

  public async apply(event: any): Promise<PolicyResult | null> {
    if (this.env.env(EnvVars.WORKER_MODE) !== ProcessFlag.TRUE) return null;
    if (event.toolName === NativePiToolName.READ) {
      return await this.applyNativeReadPolicy(event);
    }
    if (event.toolName === NativePiToolName.EDIT || event.toolName === NativePiToolName.WRITE) {
      return await this.applyNativeMutationPolicy(event);
    }
    if (event.toolName === NativePiToolName.BASH) {
      return await this.applyShellMutationPolicy(event);
    }
    return null;
  }

  private async applyNativeReadPolicy(event: any): Promise<PolicyResult | null> {
    const targetPath = this.nativeToolPath(event);
    if (!targetPath) return null;
    const context = this.context();
    await this.recordAccessAttempt(event, context, targetPath, FileMutationPolicyDefaults.READ_OPERATION);
    const relativePath = this.relativeToKnownRoot(targetPath, context);

    if (this.isProjectToolCallOutputPath(relativePath)) {
      await this.recordAccessRejection(event, context, targetPath, PROJECT_TOOL_CALL_OUTPUT_READ_GUIDANCE);
      return { rejection: PROJECT_TOOL_CALL_OUTPUT_READ_GUIDANCE };
    }

    // Let the dedicated operational-read policy produce the more specific harness-artifact guidance.
    if (this.isOperationalReadPath(relativePath)) return null;

    const scopeRejection = this.worktreeScopeRejection(targetPath, context, `\`${event.toolName}\``, 'read');
    if (!scopeRejection) return null;

    await this.recordAccessRejection(event, context, targetPath, scopeRejection);
    return { rejection: scopeRejection };
  }

  private async applyNativeMutationPolicy(event: any): Promise<PolicyResult | null> {
    const targetPath = this.nativeToolPath(event);
    if (!targetPath) return null;
    const context = this.context();
    await this.recordAccessAttempt(event, context, targetPath, FileMutationPolicyDefaults.WRITE_OPERATION);
    const operationalRejection = this.operationalMutationRejection(targetPath, context, `\`${event.toolName}\``);
    if (operationalRejection) {
      await this.recordRejection(event, context, targetPath, operationalRejection);
      return { rejection: operationalRejection };
    }

    if (this.isBeadArtifactPath(targetPath, context)) {
      const planContractRejection = await this.planContractArtifactRejection(event, context, targetPath, `\`${event.toolName}\``);
      if (planContractRejection) {
        await this.recordRejection(event, context, targetPath, planContractRejection.rejection || 'PROTOCOL VIOLATION: plan contract mutation rejected.');
        return planContractRejection;
      }
      return null;
    }

    // A declared writable system artifact (e.g. lesson capture) is permitted at its
    // EXACT resolved path even though it is project-scoped (outside the worktree) and
    // not in the plan write set. Undeclared paths fall through to the normal checks. (g9ye)
    const declaredArtifact = await this.declaredWritableArtifactMatch(targetPath, context);
    if (declaredArtifact) {
      await this.recordSystemArtifactWritePermitted(context, declaredArtifact);
      return null;
    }

    // (mis) Early framework-root write-set rejection: give a clear, named rejection
    // before the generic worktree-scope error when the target is under the framework root.
    const frameworkRootRejection = this.frameworkRootWriteSetRejection(targetPath, context, `\`${event.toolName}\``);
    if (frameworkRootRejection) {
      await this.recordRejection(event, context, targetPath, frameworkRootRejection);
      return { rejection: frameworkRootRejection };
    }

    const scopeRejection = this.worktreeScopeRejection(targetPath, context, `\`${event.toolName}\``, 'mutate');
    if (scopeRejection) {
      await this.recordRejection(event, context, targetPath, scopeRejection);
      return { rejection: scopeRejection };
    }

    const writeSetRejection = await this.writeSetRejection(targetPath, context, `\`${event.toolName}\``);
    if (!writeSetRejection) return null;

    await this.recordRejection(event, context, targetPath, writeSetRejection);
    return { rejection: writeSetRejection };
  }

  private async applyShellMutationPolicy(event: any): Promise<PolicyResult | null> {
    if (event.input?.[FileMutationPolicyDefaults.REWRITTEN_DELETE_FLAG]) return null;
    const command = typeof event.input?.command === 'string' ? event.input.command : '';
    if (!command.trim()) return null;

    const context = this.context();
    const parsed = this.parseShellCommand(event, context, command);
    if (!parsed) return { rejection: await this.rejectUnparseableShell(event, context) };

    const deletionCommands = parsed.commands
      .map(shellCommand => ({ shellCommand, deletion: this.detectDeletion(shellCommand) }))
      .filter(entry => Boolean(entry.deletion));
    if (deletionCommands.length > 0) {
      if (parsed.commands.length !== 1 || deletionCommands[0]?.shellCommand.depth !== 0) {
        return await this.rejectCompoundDeletion(event, context);
      }
      return await this.convertDeletion(event, context, command, deletionCommands[0]!.deletion!);
    }

    const mutationTargets = parsed.commands.flatMap(shellCommand => this.detectShellMutationTargets(shellCommand));
    for (const target of mutationTargets) {
      const rejection = await this.validateShellTarget(event, context, target, FileMutationPolicyDefaults.WRITE_OPERATION);
      if (rejection) return rejection;
    }

    return null;
  }

  private async rejectCompoundDeletion(event: any, context: MutationContext): Promise<PolicyResult> {
    const rejection = `PROTOCOL VIOLATION: \`${NativePiToolName.BASH}\` deletion attempts must be single-command operations so Orr Else can convert them to a managed move into \`${OperationalArtifactPath.PI_TRASH_DIR}\`.`;
    await this.recordRejection(event, context, undefined, rejection);
    return { rejection };
  }

  private async validateShellTarget(
    event: any,
    context: MutationContext,
    target: ParsedShellWord,
    operation: string
  ): Promise<PolicyResult | null> {
    await this.recordAccessAttempt(event, context, target.text, operation);
    const dynamicRejection = this.dynamicTargetRejection(target, `\`${NativePiToolName.BASH}\``);
    if (dynamicRejection) {
      await this.recordRejection(event, context, target.text, dynamicRejection);
      return { rejection: dynamicRejection };
    }
    const operationalRejection = this.operationalMutationRejection(target.text, context, `\`${NativePiToolName.BASH}\``);
    if (operationalRejection) {
      await this.recordRejection(event, context, target.text, operationalRejection);
      return { rejection: operationalRejection };
    }
    // Declared writable system artifact bypass (g9ye) — same as the native path.
    const declaredArtifact = await this.declaredWritableArtifactMatch(target.text, context);
    if (declaredArtifact) {
      await this.recordSystemArtifactWritePermitted(context, declaredArtifact);
      return null;
    }
    // (mis) Early framework-root write-set rejection for shell targets.
    const frameworkRootRejection = this.frameworkRootWriteSetRejection(target.text, context, `\`${NativePiToolName.BASH}\``);
    if (frameworkRootRejection) {
      await this.recordRejection(event, context, target.text, frameworkRootRejection);
      return { rejection: frameworkRootRejection };
    }
    const scopeRejection = this.worktreeScopeRejection(target.text, context, `\`${NativePiToolName.BASH}\``, 'mutate');
    if (scopeRejection) {
      await this.recordRejection(event, context, target.text, scopeRejection);
      return { rejection: scopeRejection };
    }
    const writeSetRejection = await this.writeSetRejection(target.text, context, `\`${NativePiToolName.BASH}\``);
    if (writeSetRejection) {
      await this.recordRejection(event, context, target.text, writeSetRejection);
      return { rejection: writeSetRejection };
    }
    return null;
  }

  private async convertDeletion(
    event: any,
    context: MutationContext,
    originalCommand: string,
    deletion: ShellDeletion
  ): Promise<PolicyResult> {
    if (deletion.targets.length === 0) {
      const rejection = `PROTOCOL VIOLATION: \`${NativePiToolName.BASH}\` deletion attempt did not contain an explicit target that Orr Else can move into \`${OperationalArtifactPath.PI_TRASH_DIR}\`.`;
      await this.recordRejection(event, context, undefined, rejection);
      return { rejection };
    }

    for (const target of deletion.targets) {
      const policyRejection = await this.validateShellTarget(event, context, target, FileMutationPolicyDefaults.DELETE_OPERATION);
      if (policyRejection) return policyRejection;
      if (FileMutationPolicyDefaults.GLOB_PATTERN.test(target.text)) {
        const rejection = `PROTOCOL VIOLATION: \`${NativePiToolName.BASH}\` deletion target \`${target.text}\` contains a shell glob that cannot be safely converted to a deterministic trash move. Use an explicit path.`;
        await this.recordRejection(event, context, target.text, rejection);
        return { rejection };
      }
    }

    const rewrittenCommand = deletion.kind === 'find'
      ? this.rewrittenFindDeleteCommand(context, event.toolCallId, deletion.findArgs || [])
      : this.trashCommand(context, event.toolCallId, deletion.targets.map(target => target.text));
    event.input.command = rewrittenCommand;
    event.input[FileMutationPolicyDefaults.REWRITTEN_DELETE_FLAG] = true;

    await this.eventStore.record(DomainEventName.FILE_DELETE_CONVERTED_TO_TRASH, {
      beadId: context.beadId,
      stateId: context.stateId,
      toolCallId: event.toolCallId,
      originalCommand,
      rewrittenCommand,
      targets: deletion.targets.map(target => target.text),
      trashDir: path.join(context.projectRoot, OperationalArtifactPath.PI_TRASH_DIR)
    }).catch(error => {
      Logger.warn(Component.ORR_ELSE, 'Failed to record delete-to-trash conversion', { error: String(error) });
    });

    return { rewritten: true };
  }

  private context(): MutationContext {
    const frameworkRootEnv = this.env.env(EnvVars.FRAMEWORK_ROOT);
    return {
      beadId: this.env.env(EnvVars.BEAD_ID),
      stateId: this.env.env(EnvVars.STATE_ID),
      projectRoot: this.env.env(EnvVars.PROJECT_ROOT) || this.projectRoot,
      worktreePath: this.env.env(EnvVars.WORKTREE_PATH) || '',
      cwd: process.cwd(),
      frameworkRoot: frameworkRootEnv || undefined
    };
  }

  private nativeToolPath(event: any): string {
    for (const key of NATIVE_PATH_INPUT_KEYS) {
      const value = event.input?.[key];
      if (typeof value === 'string' && value.trim()) return value;
    }
    return '';
  }

  private detectDeletion(command: ParsedShellCommand): ShellDeletion | null {
    const effective = this.shellCommandParser.effectiveCommand(command);
    const commandName = effective.basename;

    if (commandName === FileMutationPolicyDefaults.RM_COMMAND) {
      return { kind: 'targets', targets: this.positionalTargets(effective.args) };
    }
    if (commandName === FileMutationPolicyDefaults.UNLINK_COMMAND) {
      return { kind: 'targets', targets: this.positionalTargets(effective.args) };
    }
    if (commandName === FileMutationPolicyDefaults.GIT_COMMAND && this.gitSubcommand(effective.args) === FileMutationPolicyDefaults.GIT_RM_SUBCOMMAND) {
      return { kind: 'targets', targets: this.positionalTargetsAfterGitSubcommand(effective.args) };
    }
    if (commandName === FileMutationPolicyDefaults.FIND_COMMAND && effective.args.some(arg => arg.text === FileMutationPolicyDefaults.FIND_DELETE_PREDICATE)) {
      const findArgs = effective.args
        .filter(arg => arg.text !== FileMutationPolicyDefaults.FIND_DELETE_PREDICATE);
      return {
        kind: 'find',
        targets: this.findRoots(findArgs),
        findArgs: findArgs.map(arg => arg.text)
      };
    }

    return null;
  }

  private detectShellMutationTargets(command: ParsedShellCommand): ParsedShellWord[] {
    const effective = this.shellCommandParser.effectiveCommand(command);
    const commandName = effective.basename;
    return [
      ...this.redirectTargets(effective),
      ...this.commandMutationTargets(effective, commandName)
    ].filter(Boolean);
  }

  private commandMutationTargets(command: EffectiveShellCommand, commandName: string): ParsedShellWord[] {
    if (commandName === FileMutationPolicyDefaults.MV_COMMAND) return this.positionalTargets(command.args);
    if (commandName === FileMutationPolicyDefaults.CP_COMMAND) return this.copyDestinationTargets(command.args);
    if (
      commandName === FileMutationPolicyDefaults.TOUCH_COMMAND
      || commandName === FileMutationPolicyDefaults.MKDIR_COMMAND
      || commandName === FileMutationPolicyDefaults.TRUNCATE_COMMAND
    ) return this.positionalTargets(command.args);
    if (commandName === FileMutationPolicyDefaults.TEE_COMMAND) return this.positionalTargets(command.args);
    if (commandName === FileMutationPolicyDefaults.DD_COMMAND) return command.args
      .filter(arg => arg.text.startsWith(FileMutationPolicyDefaults.DD_OUTPUT_PREFIX))
      .map(arg => ({ text: arg.text.slice(FileMutationPolicyDefaults.DD_OUTPUT_PREFIX.length), dynamic: arg.dynamic }));
    if (commandName === FileMutationPolicyDefaults.SED_COMMAND && command.args.some(arg => FileMutationPolicyDefaults.SED_IN_PLACE_PATTERN.test(arg.text))) {
      const targets = this.positionalTargets(command.args);
      return targets.slice(1);
    }
    if (commandName === FileMutationPolicyDefaults.PERL_COMMAND && command.args.some(arg => FileMutationPolicyDefaults.PERL_IN_PLACE_PATTERN.test(arg.text))) {
      const targets = this.positionalTargets(command.args);
      return targets.slice(1);
    }
    return [];
  }

  private redirectTargets(command: EffectiveShellCommand): ParsedShellWord[] {
    return command.redirects
      .filter(redirect => FileMutationPolicyDefaults.SHELL_WRITE_REDIRECT_OPERATORS.includes(redirect.operator as any))
      .map(redirect => redirect.file)
      .filter((target): target is ParsedShellWord => Boolean(target));
  }

  private positionalTargetsAfterGitSubcommand(args: ParsedShellWord[]): ParsedShellWord[] {
    const subcommandIndex = args.findIndex(arg => arg.text === FileMutationPolicyDefaults.GIT_RM_SUBCOMMAND);
    return this.positionalTargets(args.slice(subcommandIndex + 1));
  }

  private positionalTargets(args: ParsedShellWord[]): ParsedShellWord[] {
    const targets: ParsedShellWord[] = [];
    let optionsEnded = false;
    for (const arg of args) {
      if (!optionsEnded && arg.text === FileMutationPolicyDefaults.ARG_SEPARATOR) {
        optionsEnded = true;
        continue;
      }
      if (!optionsEnded && arg.text.startsWith('-')) continue;
      targets.push(arg);
    }
    return targets;
  }

  private copyDestinationTargets(args: ParsedShellWord[]): ParsedShellWord[] {
    const targets = this.positionalTargets(args);
    return targets.length > 0 ? [targets[targets.length - 1]] : [];
  }

  private findRoots(findArgs: ParsedShellWord[]): ParsedShellWord[] {
    const roots: ParsedShellWord[] = [];
    for (const token of findArgs) {
      if (token.text.startsWith('-') || token.text === '!' || token.text === '(' || token.text === ')') break;
      roots.push(token);
    }
    return roots.length > 0 ? roots : [{ text: '.', dynamic: false }];
  }

  private gitSubcommand(args: ParsedShellWord[]): string | undefined {
    for (let index = 0; index < args.length; index += 1) {
      const token = args[index]?.text || '';
      if (token === FileMutationPolicyDefaults.ARG_SEPARATOR) continue;
      if (token === FileMutationPolicyDefaults.GIT_CHDIR_OPTION) {
        index += 1;
        continue;
      }
      if (!token.startsWith('-')) return token;
    }
    return undefined;
  }

  // (mis/ruq0) Framework-root write-set early rejection.
  //
  // When a worker targets a path that is inside a configured named framework root
  // but outside the active worktree, reject EARLY with a clear read-only-evidence
  // contract message rather than a confusing generic "escapes worktree" error.
  //
  // CONTRACT (ruq0): the framework root (orr-else repo) is READ-ONLY EVIDENCE
  // from a Cerdiwen worktree. Framework-root write-sets are EXPLICITLY REJECTED.
  // The correct route is to make framework/orr-else changes directly in the
  // orr-else repository, not via a Cerdiwen worktree write-set.
  //
  // SECURITY: this is HARDENING only — it does NOT broaden what is allowed.
  // The worktreeScopeRejection that follows still applies to all other paths
  // outside the worktree, so the security surface is strictly unchanged.
  // canonicalPath + isInside are the same safe idiom used throughout this class.
  private frameworkRootWriteSetRejection(
    targetPath: string,
    context: MutationContext,
    toolLabel: string
  ): string | null {
    if (!context.frameworkRoot) return null;
    const resolvedPath = this.resolvePath(targetPath, context.cwd);
    if (!this.isInside(resolvedPath, context.frameworkRoot)) return null;
    // Path IS under the framework root. If it's also inside the worktree,
    // allow it to proceed through normal policy (no early rejection needed).
    if (context.worktreePath && this.isInside(resolvedPath, context.worktreePath)) return null;
    // Path is under framework root but outside the active worktree.
    // Give an explicit early rejection naming the read-only-evidence contract.
    return [
      `PROTOCOL VIOLATION: ${toolLabel} attempted to write to \`${targetPath}\`,`,
      `which resolves inside the configured framework root (\`${context.frameworkRoot}\`)`,
      'but outside the active Bead worktree.',
      'The framework root (orr-else repo) is read-only evidence from a Cerdiwen worktree;',
      'framework-root write-sets are explicitly rejected.',
      'Make framework/orr-else changes directly in the orr-else repository,',
      'not via a Cerdiwen worktree write-set.'
    ].join(' ');
  }

  private worktreeScopeRejection(
    targetPath: string,
    context: MutationContext,
    toolLabel: string,
    operation: 'mutate' | 'read'
  ): string | null {
    if (!context.worktreePath) {
      return `PROTOCOL VIOLATION: ${toolLabel} attempted to ${operation} \`${targetPath}\`, but no mandatory WORKTREE_PATH is configured for this teammate.`;
    }
    const resolvedPath = this.resolvePath(targetPath, context.cwd);
    if (this.isInside(resolvedPath, context.worktreePath)) return null;
    return `PROTOCOL VIOLATION: ${toolLabel} may only ${operation} files inside this Bead worktree. Target \`${targetPath}\` resolves outside \`${context.worktreePath}\`.`;
  }

  private operationalMutationRejection(targetPath: string, context: MutationContext, toolLabel: string): string | null {
    const relativePath = this.relativeToKnownRoot(targetPath, context);
    if (!this.isOperationalMutationPath(relativePath)) return null;
    return `PROTOCOL VIOLATION: ${toolLabel} may not modify framework runtime artifacts inside a teammate context. Use harness tools for state, progress, events, tool outputs, and generated temporary files.`;
  }

  private isBeadArtifactPath(targetPath: string, context: MutationContext): boolean {
    if (!context.beadId) return false;
    const resolvedPath = this.resolvePath(targetPath, context.cwd);
    const artifactsRoot = path.join(context.projectRoot, OperationalArtifactPath.PI_ARTIFACTS_DIR, context.beadId);
    return this.isInside(resolvedPath, artifactsRoot);
  }

  private async writeSetRejection(targetPath: string, context: MutationContext, toolLabel: string): Promise<string | null> {
    const result = await this.planWriteSet.validateMutationTarget({
      beadId: context.beadId,
      stateId: context.stateId,
      projectRoot: context.projectRoot,
      worktreePath: context.worktreePath,
      cwd: context.cwd,
      targetPath,
      toolLabel
    });
    return result.passed ? null : result.reason || `PROTOCOL VIOLATION: ${toolLabel} target is outside the approved plan write set.`;
  }

  /**
   * Returns the resolved artifact path if `targetPath` exactly matches a declared
   * writable system artifact for the current bead/state, otherwise null.
   */
  private async declaredWritableArtifactMatch(targetPath: string, context: MutationContext): Promise<string | null> {
    if (!this.artifactPaths || !context.beadId) return null;
    const resolvedTarget = this.canonicalPath(this.resolvePath(targetPath, context.cwd));
    const actionId = this.env.env(EnvVars.ACTION_ID);
    const writablePaths = await this.artifactPaths.resolveWritableArtifactPaths({
      beadId: context.beadId,
      stateId: context.stateId,
      actionId: actionId || undefined,
      includeContent: false
    }).catch(() => [] as string[]);
    for (const candidate of writablePaths) {
      if (this.canonicalPath(candidate) === resolvedTarget) return candidate;
    }
    return null;
  }

  private async recordSystemArtifactWritePermitted(context: MutationContext, resolvedPath: string): Promise<void> {
    await this.eventStore.record(DomainEventName.SYSTEM_ARTIFACT_WRITE_PERMITTED, {
      beadId: context.beadId,
      stateId: context.stateId,
      actionId: this.env.env(EnvVars.ACTION_ID),
      resolvedPath,
      pathClass: 'systemArtifact'
    }).catch(error => {
      Logger.warn(Component.ORR_ELSE, 'Failed to record system-artifact write permit', { error: String(error) });
    });
  }

  private async planContractArtifactRejection(
    event: any,
    context: MutationContext,
    targetPath: string,
    toolLabel: string
  ): Promise<PolicyResult | null> {
    const resolvedTargetPath = this.resolvePath(targetPath, context.cwd);
    const isPlanContract = await this.planWriteSet.isPlanContractPath(resolvedTargetPath, {
      beadId: context.beadId,
      stateId: context.stateId,
      projectRoot: context.projectRoot,
      worktreePath: context.worktreePath
    });
    if (!isPlanContract) return null;

    if (event.toolName !== NativePiToolName.WRITE || typeof event.input?.content !== 'string') {
      return {
        rejection: `PROTOCOL VIOLATION: ${toolLabel} may only replace a plan contract with a full \`${NativePiToolName.WRITE}\` payload so Orr Else can validate the proposed write set before recording it.`,
        nextAction: 'replace_plan_contract_with_full_write',
        recovery: [
          `Submit a native \`${NativePiToolName.WRITE}\` call whose payload contains the complete plan-contract JSON.`,
          'This lets Orr Else validate the full write set before recording the plan contract.',
          'Do not retry a partial edit or patch for plan-contract.json.'
        ]
      };
    }

    const validation = await this.planWriteSet.validateProposedPlanContract(event.input.content, {
      beadId: context.beadId,
      stateId: context.stateId,
      projectRoot: context.projectRoot,
      worktreePath: context.worktreePath
    });
    if (validation.passed) return null;

    return {
      rejection: [
        `PROTOCOL VIOLATION: ${toolLabel} attempted to record a plan contract with unmergeable write-set paths.`,
        validation.reason || 'Approved plan write set contains ignored paths that Git will not merge.'
      ].join(' ')
    };
  }

  private isOperationalLogPath(relativePath: string): { normalizedPath: string; isLog: boolean } {
    const normalizedPath = relativePath.replace(/^\.\//, '').replace(/^\/+/, '');
    const fileName = path.posix.basename(normalizedPath);
    const isProgress = fileName === OperationalLogPath.PROGRESS_FILE;
    const isWorklog = normalizedPath.split('/').includes(OperationalLogPath.WORKLOG_DIR)
      && fileName.endsWith(OperationalLogPath.WORKLOG_FILE_SUFFIX);
    return { normalizedPath, isLog: isProgress || isWorklog };
  }

  private isOperationalMutationPath(relativePath: string): boolean {
    const { normalizedPath, isLog } = this.isOperationalLogPath(relativePath);
    return isLog || OPERATIONAL_MUTATION_DIRS.some(directory => this.pathWithin(normalizedPath, directory));
  }

  private isOperationalReadPath(relativePath: string): boolean {
    const { normalizedPath, isLog } = this.isOperationalLogPath(relativePath);
    return isLog || OPERATIONAL_READ_DIRS.some(directory => this.pathWithin(normalizedPath, directory));
  }

  private isProjectToolCallOutputPath(relativePath: string): boolean {
    return this.pathWithin(relativePath, PROJECT_TOOL_CALL_OUTPUT_DIR);
  }

  private relativeToKnownRoot(targetPath: string, context: MutationContext): string {
    const trimmed = targetPath.trim();
    if (!trimmed) return '';
    if (!path.isAbsolute(trimmed)) return this.toSlashPath(trimmed).replace(/^\.\//, '');

    const absolutePath = this.canonicalPath(trimmed);
    for (const root of [context.worktreePath, context.projectRoot, context.cwd].filter(Boolean)) {
      const relativePath = path.relative(this.canonicalPath(root), absolutePath);
      if (!relativePath || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))) {
        return this.toSlashPath(relativePath || '.');
      }
    }
    return this.toSlashPath(trimmed);
  }

  private rewrittenFindDeleteCommand(context: MutationContext, toolCallId: string | undefined, findArgs: string[]): string {
    const args = findArgs.includes(FileMutationPolicyDefaults.FIND_DEPTH_PREDICATE)
      ? findArgs
      : [...findArgs, FileMutationPolicyDefaults.FIND_DEPTH_PREDICATE];
    return [
      FileMutationPolicyDefaults.FIND_COMMAND,
      ...args.map(arg => this.shellQuote(arg)),
      FileMutationPolicyDefaults.FIND_PRINT0_PREDICATE,
      '|',
      this.trashCommand(context, toolCallId, [], true)
    ].join(' ');
  }

  private trashCommand(
    context: MutationContext,
    toolCallId: string | undefined,
    targets: string[],
    stdinNull = false
  ): string {
    const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../tools/trash_cli.js');
    const args = [
      process.execPath,
      cliPath,
      '--project-root',
      context.projectRoot,
      '--worktree-path',
      context.worktreePath,
      '--bead-id',
      context.beadId || 'unknown',
      '--tool-call-id',
      toolCallId || 'unknown'
    ];
    if (stdinNull) args.push(FileMutationPolicyDefaults.STDIN_NULL_FLAG);
    args.push(FileMutationPolicyDefaults.ARG_SEPARATOR, ...targets);
    return args.map(arg => this.shellQuote(arg)).join(' ');
  }

  private async recordRejection(
    event: any,
    context: MutationContext,
    targetPath: string | undefined,
    reason: string
  ): Promise<void> {
    await this.eventStore.record(DomainEventName.FILE_MUTATION_REJECTED, {
      beadId: context.beadId,
      stateId: context.stateId,
      tool: event.toolName,
      toolCallId: event.toolCallId,
      targetPath,
      reason
    }).catch(error => {
      Logger.warn(Component.ORR_ELSE, 'Failed to record file mutation rejection', { error: String(error) });
    });
  }

  private async recordAccessAttempt(
    event: any,
    context: MutationContext,
    targetPath: string | undefined,
    operation: string
  ): Promise<void> {
    await this.eventStore.record(DomainEventName.FILE_ACCESS_ATTEMPTED, {
      beadId: context.beadId,
      stateId: context.stateId,
      tool: event.toolName,
      toolCallId: event.toolCallId,
      targetPath,
      operation
    }).catch(error => {
      Logger.warn(Component.ORR_ELSE, 'Failed to record file access attempt', { error: String(error) });
    });
  }

  private async recordAccessRejection(
    event: any,
    context: MutationContext,
    targetPath: string | undefined,
    reason: string
  ): Promise<void> {
    await this.eventStore.record(DomainEventName.FILE_ACCESS_REJECTED, {
      beadId: context.beadId,
      stateId: context.stateId,
      tool: event.toolName,
      toolCallId: event.toolCallId,
      targetPath,
      reason
    }).catch(error => {
      Logger.warn(Component.ORR_ELSE, 'Failed to record file access rejection', { error: String(error) });
    });
  }

  private parseShellCommand(event: any, context: MutationContext, command: string): ReturnType<ShellCommandParser['parse']> | null {
    try {
      return this.shellCommandParser.parse(command);
    } catch (error) {
      Logger.warn(Component.ORR_ELSE, 'Failed to parse shell command for mutation policy', {
        beadId: context.beadId,
        toolCallId: event.toolCallId,
        error: String(error)
      });
      return null;
    }
  }

  private async rejectUnparseableShell(event: any, context: MutationContext): Promise<string> {
    const rejection = `PROTOCOL VIOLATION: \`${NativePiToolName.BASH}\` command could not be parsed, so Orr Else cannot verify worktree scope or convert delete attempts to \`${OperationalArtifactPath.PI_TRASH_DIR}\`. Use native tools or a simpler command.`;
    await this.recordRejection(event, context, undefined, rejection);
    return rejection;
  }

  private dynamicTargetRejection(target: ParsedShellWord, toolLabel: string): string | null {
    if (!target.dynamic) return null;
    return `PROTOCOL VIOLATION: ${toolLabel} mutation target \`${target.text}\` contains shell expansion, so Orr Else cannot verify the exact path before execution. Use an explicit path.`;
  }

  private shellQuote(value: string): string {
    return quoteShellArgs([value]);
  }

  private resolvePath(targetPath: string, cwd: string): string {
    return path.resolve(path.isAbsolute(targetPath) ? targetPath : path.join(cwd, targetPath));
  }

  private isInside(candidatePath: string, rootPath: string): boolean {
    const relativePath = path.relative(this.canonicalPath(rootPath), this.canonicalPath(candidatePath));
    return !relativePath || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
  }

  private canonicalPath(value: string): string {
    const resolvedPath = path.resolve(value);
    try {
      return fs.realpathSync(resolvedPath);
    } catch {
      let currentPath = resolvedPath;
      const missingSegments: string[] = [];
      while (!fs.existsSync(currentPath)) {
        const parentPath = path.dirname(currentPath);
        if (parentPath === currentPath) return resolvedPath;
        missingSegments.unshift(path.basename(currentPath));
        currentPath = parentPath;
      }
      try {
        return path.join(fs.realpathSync(currentPath), ...missingSegments);
      } catch {
        return resolvedPath;
      }
    }
  }

  private pathWithin(relativePath: string, directory: string): boolean {
    const cleanPath = relativePath.replace(/^\.\//, '').replace(/^\/+/, '');
    const cleanDirectory = directory.replace(/^\/+|\/+$/g, '');
    return cleanPath === cleanDirectory || cleanPath.startsWith(`${cleanDirectory}/`);
  }

  private toSlashPath(value: string): string {
    return value.replaceAll(path.sep, '/');
  }
}
