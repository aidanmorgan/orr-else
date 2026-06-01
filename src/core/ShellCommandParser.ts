import * as path from 'path';
import parseShell, { type BashAstNode } from 'bash-parser';
import { FileMutationPolicyDefaults } from '../constants/index.js';

export interface ParsedShellWord {
  text: string;
  dynamic: boolean;
}

export interface ParsedShellRedirect {
  operator: string;
  file?: ParsedShellWord;
  fd?: string;
}

export interface ParsedShellCommand {
  name: string;
  basename: string;
  args: ParsedShellWord[];
  redirects: ParsedShellRedirect[];
  depth: number;
}

export interface ParsedShellProgram {
  commands: ParsedShellCommand[];
}

export interface EffectiveShellCommand {
  name: string;
  basename: string;
  args: ParsedShellWord[];
  redirects: ParsedShellRedirect[];
  depth: number;
}

export class ShellCommandParser {
  public parse(source: string): ParsedShellProgram {
    const ast = parseShell(source);
    const commands: ParsedShellCommand[] = [];
    this.collectCommands(ast, commands, 0);
    return { commands };
  }

  public commandBasenames(source: string): string[] {
    return this.parse(source).commands
      .map(command => this.effectiveCommand(command).basename)
      .filter(Boolean);
  }

  public effectiveCommand(command: ParsedShellCommand): EffectiveShellCommand {
    if (command.basename === FileMutationPolicyDefaults.SUDO_COMMAND) {
      return this.effectiveFromWrapper(command, this.skipSudoArgs(command.args));
    }
    if (command.basename === FileMutationPolicyDefaults.COMMAND_BUILTIN) {
      return this.effectiveFromWrapper(command, this.skipCommandBuiltinArgs(command.args));
    }
    if (command.basename === FileMutationPolicyDefaults.ENV_COMMAND) {
      return this.effectiveFromWrapper(command, this.skipEnvArgs(command.args));
    }
    return {
      name: command.name,
      basename: command.basename,
      args: command.args,
      redirects: command.redirects,
      depth: command.depth
    };
  }

  private effectiveFromWrapper(command: ParsedShellCommand, args: ParsedShellWord[]): EffectiveShellCommand {
    const nameWord = args[0];
    if (!nameWord) {
      return {
        name: command.name,
        basename: command.basename,
        args: command.args,
        redirects: command.redirects,
        depth: command.depth
      };
    }
    return {
      name: nameWord.text,
      basename: path.basename(nameWord.text),
      args: args.slice(1),
      redirects: command.redirects,
      depth: command.depth
    };
  }

  private skipSudoArgs(args: ParsedShellWord[]): ParsedShellWord[] {
    let index = 0;
    while (index < args.length) {
      const token = args[index]?.text || '';
      if (token === FileMutationPolicyDefaults.ARG_SEPARATOR) return args.slice(index + 1);
      if (!token.startsWith('-')) break;
      index += this.sudoOptionConsumesValue(token) ? 2 : 1;
    }
    return args.slice(index);
  }

  private sudoOptionConsumesValue(token: string): boolean {
    return (FileMutationPolicyDefaults.SUDO_VALUE_OPTIONS as readonly string[]).includes(token)
      || FileMutationPolicyDefaults.SUDO_VALUE_OPTION_PREFIXES.some(prefix => token.startsWith(prefix) && token.length === prefix.length);
  }

  private skipCommandBuiltinArgs(args: ParsedShellWord[]): ParsedShellWord[] {
    let index = 0;
    while (index < args.length && (FileMutationPolicyDefaults.COMMAND_BUILTIN_OPTIONS as readonly string[]).includes(args[index]?.text || '')) {
      index += 1;
    }
    return args.slice(index);
  }

  private skipEnvArgs(args: ParsedShellWord[]): ParsedShellWord[] {
    let index = 0;
    while (index < args.length) {
      const token = args[index]?.text || '';
      if (token === FileMutationPolicyDefaults.ARG_SEPARATOR) return args.slice(index + 1);
      if (FileMutationPolicyDefaults.ENV_ASSIGNMENT_PATTERN.test(token)) {
        index += 1;
        continue;
      }
      if (!token.startsWith('-')) break;
      index += this.envOptionConsumesValue(token) ? 2 : 1;
    }
    return args.slice(index);
  }

  private envOptionConsumesValue(token: string): boolean {
    return (FileMutationPolicyDefaults.ENV_VALUE_OPTIONS as readonly string[]).includes(token)
      || FileMutationPolicyDefaults.ENV_VALUE_OPTION_PREFIXES.some(prefix => token.startsWith(prefix) && token.length === prefix.length);
  }

  private collectCommands(node: unknown, commands: ParsedShellCommand[], depth: number): void {
    if (!this.isAstNode(node)) return;
    if (node.type === 'Script') {
      for (const child of node.commands || []) this.collectCommands(child, commands, depth);
      return;
    }
    if (this.isCommandNode(node)) {
      commands.push(this.commandFromNode(node, depth));
      this.collectWordExpansions(node.name, commands, depth + 1);
      for (const child of [...(node.prefix || []), ...(node.suffix || [])]) {
        this.collectWordExpansions(child, commands, depth + 1);
      }
      return;
    }

    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) this.collectCommands(child, commands, depth + 1);
      } else {
        this.collectCommands(value, commands, depth + 1);
      }
    }
  }

  private collectWordExpansions(node: unknown, commands: ParsedShellCommand[], depth: number): void {
    if (!this.isAstNode(node)) return;
    for (const expansion of node.expansion || []) {
      if (this.isAstNode(expansion.commandAST)) this.collectCommands(expansion.commandAST, commands, depth);
    }
  }

  private commandFromNode(node: BashAstNode, depth: number): ParsedShellCommand {
    const name = this.wordText(node.name) || '';
    const parts = [...(node.prefix || []), ...(node.suffix || [])];
    const redirects = parts
      .map(part => this.redirectFromNode(part))
      .filter((redirect): redirect is ParsedShellRedirect => Boolean(redirect));
    const args = (node.suffix || [])
      .map(part => this.wordFromNode(part))
      .filter((word): word is ParsedShellWord => Boolean(word));
    return {
      name,
      basename: name ? path.basename(name) : '',
      args,
      redirects,
      depth
    };
  }

  private redirectFromNode(node: BashAstNode): ParsedShellRedirect | null {
    if (node.type !== 'Redirect') return null;
    const operator = this.wordText(node.op) || '';
    return {
      operator,
      file: this.wordFromNode(node.file) || undefined,
      fd: this.wordText(node.numberIo)
    };
  }

  private wordFromNode(node: unknown): ParsedShellWord | null {
    if (!this.isAstNode(node)) return null;
    const text = this.wordText(node);
    if (!text) return null;
    return {
      text,
      dynamic: this.isDynamicWord(node)
    };
  }

  private wordText(node: unknown): string {
    if (!this.isAstNode(node)) return '';
    return typeof node.text === 'string' ? node.text : '';
  }

  private isDynamicWord(node: BashAstNode): boolean {
    return Boolean(node.expansion?.length)
      || (typeof node.text === 'string' && FileMutationPolicyDefaults.DYNAMIC_SHELL_WORD_PATTERN.test(node.text));
  }

  private isCommandNode(node: BashAstNode): boolean {
    return node.type === 'Command' || node.type === 'SimpleCommand';
  }

  private isAstNode(value: unknown): value is BashAstNode {
    return Boolean(value) && typeof value === 'object';
  }
}
