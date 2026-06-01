#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { stdin as input } from 'process';
import { v7 as uuidv7 } from 'uuid';
import { Command } from 'commander';
import {
  FileMutationPolicyDefaults,
  OperationalArtifactPath
} from '../constants/index.js';

interface TrashCliArgs {
  projectRoot: string;
  worktreePath: string;
  beadId: string;
  toolCallId: string;
  stdinNull: boolean;
  targets: string[];
}

function usage(): never {
  throw new Error('Usage: trash_cli --project-root <path> --worktree-path <path> --bead-id <id> --tool-call-id <id> [--stdin-null] -- <targets...>');
}

function parseArgs(argv: string[]): TrashCliArgs {
  const command = new Command();
  command
    .name('trash_cli')
    .exitOverride()
    .configureOutput({
      writeOut: () => {},
      writeErr: () => {}
    })
    .requiredOption('--project-root <path>')
    .requiredOption('--worktree-path <path>')
    .requiredOption('--bead-id <id>')
    .requiredOption('--tool-call-id <id>')
    .option(FileMutationPolicyDefaults.STDIN_NULL_FLAG)
    .argument('[targets...]');

  command.parse(argv, { from: 'user' });
  const options = command.opts<{
    projectRoot: string;
    worktreePath: string;
    beadId: string;
    toolCallId: string;
    stdinNull?: boolean;
  }>();

  if (!options.projectRoot || !options.worktreePath || !options.beadId || !options.toolCallId) usage();
  return {
    projectRoot: options.projectRoot,
    worktreePath: options.worktreePath,
    beadId: options.beadId,
    toolCallId: options.toolCallId,
    stdinNull: options.stdinNull === true,
    targets: command.args
  };
}

function isInside(candidatePath: string, rootPath: string): boolean {
  const relativePath = path.relative(canonicalPath(rootPath), canonicalPath(candidatePath));
  return !relativePath || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function canonicalPath(value: string): string {
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

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function uniqueTrashPath(args: TrashCliArgs, sourcePath: string): string {
  const relativePath = path.relative(canonicalPath(args.worktreePath), canonicalPath(sourcePath));
  const trashRoot = path.join(
    path.resolve(args.projectRoot),
    OperationalArtifactPath.PI_TRASH_DIR,
    safeSegment(args.beadId),
    safeSegment(args.toolCallId),
    uuidv7()
  );
  return path.join(trashRoot, relativePath);
}

async function readNullSeparatedStdin(): Promise<string[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8').split('\0').filter(Boolean);
}

async function moveToTrash(args: TrashCliArgs, target: string): Promise<string> {
  const sourcePath = path.resolve(path.isAbsolute(target) ? target : path.join(process.cwd(), target));
  const worktreePath = canonicalPath(args.worktreePath);
  if (!isInside(sourcePath, worktreePath)) {
    throw new Error(`Refusing to trash path outside worktree: ${target}`);
  }
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Cannot trash missing path: ${target}`);
  }

  const trashPath = uniqueTrashPath(args, sourcePath);
  await fs.promises.mkdir(path.dirname(trashPath), { recursive: true });
  await fs.promises.rename(sourcePath, trashPath);
  return trashPath;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const stdinTargets = args.stdinNull ? await readNullSeparatedStdin() : [];
  const targets = [...args.targets, ...stdinTargets];
  if (targets.length === 0) usage();

  const moved: Array<{ source: string; trashPath: string }> = [];
  for (const target of targets) {
    moved.push({ source: target, trashPath: await moveToTrash(args, target) });
  }

  process.stdout.write(`${JSON.stringify({ status: 'PASSED', moved })}\n`);
}

main().catch(error => {
  process.stderr.write(`${String(error instanceof Error ? error.message : error)}\n`);
  process.exitCode = 1;
});
