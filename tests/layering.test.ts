import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

type LayerName = 'core' | 'plugins' | 'composition' | 'tools' | 'shared' | 'unknown';

interface SourceFile {
  absolutePath: string;
  relativePath: string;
  layer: LayerName;
}

interface ImportEdge {
  importer: string;
  imported: string;
  specifier: string;
}

interface AllowlistEntry {
  importer: string;
  imported: string;
  reason: string;
}

const rootDir = process.cwd();
const srcDir = path.join(rootDir, 'src');

const layerMap: Array<{ layer: LayerName; pattern: RegExp; intent: string }> = [
  {
    layer: 'composition',
    pattern: /^src\/(?:extension|main|teammate_entry)\.ts$|^src\/(?:extension|composition)\//,
    intent: 'Process and extension entrypoints (and their extracted controller modules) compose core services, plugins, and external APIs.'
  },
  {
    layer: 'tools',
    pattern: /^src\/(?:tools|bin)\//,
    intent: 'CLI/tool entrypoints may orchestrate shared contracts and runtime APIs.'
  },
  {
    layer: 'plugins',
    pattern: /^src\/plugins\//,
    intent: 'Plugin implementations adapt concrete tool behavior and may depend on core contracts.'
  },
  {
    layer: 'core',
    pattern: /^src\/core\//,
    intent: 'Core runtime and domain modules should remain independent from plugin implementations.'
  },
  {
    layer: 'shared',
    pattern: /^src\/(?:constants|types)\//,
    intent: 'Shared constants and types are dependency leaves for runtime layers.'
  }
];

const pluginImplementationAllowlist: AllowlistEntry[] = [];

const cycleAllowlist: AllowlistEntry[] = [];

function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join('/');
}

function listSourceFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(absolutePath);
    if (!entry.isFile()) return [];
    if (!entry.name.endsWith('.ts')) return [];
    if (entry.name.endsWith('.d.ts')) return [];
    return [absolutePath];
  });
}

function getLayer(relativePath: string): LayerName {
  return layerMap.find(({ pattern }) => pattern.test(relativePath))?.layer ?? 'unknown';
}

function readSourceGraph(): { files: SourceFile[]; edges: ImportEdge[] } {
  const files = listSourceFiles(srcDir).map((absolutePath) => {
    const relativePath = toPosix(path.relative(rootDir, absolutePath));
    return {
      absolutePath,
      relativePath,
      layer: getLayer(relativePath)
    };
  });
  const fileSet = new Set(files.map((file) => file.relativePath));
  const edges = files.flatMap((file) =>
    extractImportSpecifiers(fs.readFileSync(file.absolutePath, 'utf8'))
      .map((specifier) => resolveLocalImport(file, specifier, fileSet))
      .filter((edge): edge is ImportEdge => edge !== undefined)
  );
  return { files, edges };
}

function extractImportSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+(?:type\s+)?[^'";]*?\s+from\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specifiers.add(match[1]);
    }
  }

  return [...specifiers];
}

function resolveLocalImport(file: SourceFile, specifier: string, fileSet: Set<string>): ImportEdge | undefined {
  if (!specifier.startsWith('.')) return undefined;

  const importerDir = path.posix.dirname(file.relativePath);
  const withoutQuery = specifier.split('?')[0].split('#')[0];
  const candidateBase = path.posix.normalize(path.posix.join(importerDir, withoutQuery));
  const candidates = [
    candidateBase,
    candidateBase.replace(/\.(?:js|mjs|cjs)$/, '.ts'),
    `${candidateBase}.ts`,
    path.posix.join(candidateBase, 'index.ts')
  ];

  const imported = candidates.find((candidate) => candidate.startsWith('src/') && fileSet.has(candidate));
  if (!imported) return undefined;

  return {
    importer: file.relativePath,
    imported,
    specifier
  };
}

function isAllowed(edge: ImportEdge, allowlist: AllowlistEntry[]): boolean {
  return allowlist.some((entry) => entry.importer === edge.importer && entry.imported === edge.imported);
}

function formatEdge(edge: ImportEdge): string {
  return `${edge.importer} -> ${edge.imported} (${edge.specifier})`;
}

function findCycles(edges: ImportEdge[]): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (!adjacency.has(edge.importer)) adjacency.set(edge.importer, []);
    adjacency.get(edge.importer)!.push(edge.imported);
  }

  const cycles = new Set<string>();
  const stack: string[] = [];
  const inStack = new Set<string>();
  const visited = new Set<string>();

  function visit(node: string): void {
    visited.add(node);
    stack.push(node);
    inStack.add(node);

    for (const next of adjacency.get(node) ?? []) {
      if (!visited.has(next)) {
        visit(next);
        continue;
      }
      if (!inStack.has(next)) continue;

      const cycle = stack.slice(stack.indexOf(next)).concat(next);
      cycles.add(canonicalCycle(cycle));
    }

    stack.pop();
    inStack.delete(node);
  }

  for (const node of adjacency.keys()) {
    if (!visited.has(node)) visit(node);
  }

  return [...cycles].sort().map((cycle) => cycle.split(' -> '));
}

function canonicalCycle(cycle: string[]): string {
  const nodes = cycle.slice(0, -1);
  const rotations = nodes.map((_, index) => nodes.slice(index).concat(nodes.slice(0, index)));
  const canonical = rotations.map((rotation) => rotation.concat(rotation[0]).join(' -> ')).sort()[0];
  return canonical;
}

function cycleAllowed(cycle: string[]): boolean {
  const edges = cycle.slice(0, -1).map((importer, index) => ({
    importer,
    imported: cycle[index + 1],
    specifier: ''
  }));
  return edges.every((edge) => isAllowed(edge, cycleAllowlist));
}

describe('architecture layering', () => {
  it('keeps every source file assigned to an explicit layer', () => {
    const { files } = readSourceGraph();
    const unknownFiles = files.filter((file) => file.layer === 'unknown').map((file) => file.relativePath);

    expect(unknownFiles, `Files without a layer:\n${unknownFiles.join('\n')}`).toEqual([]);
  });

  it('prevents core runtime/domain modules from importing plugin implementations', () => {
    const { edges } = readSourceGraph();
    const forbidden = edges.filter((edge) =>
      edge.importer.startsWith('src/core/') &&
      edge.imported.startsWith('src/plugins/') &&
      !isAllowed(edge, pluginImplementationAllowlist)
    );

    expect(
      forbidden.map(formatEdge),
      [
        'Core must not depend on plugin implementation modules.',
        'Move new composition to a composition root or add a temporary allowlist entry with a reason while refactoring existing debt.'
      ].join('\n')
    ).toEqual([]);
  });

  it('reports circular local source dependencies', () => {
    const { edges } = readSourceGraph();
    const cycles = findCycles(edges).filter((cycle) => !cycleAllowed(cycle));
    const formattedCycles = cycles.map((cycle) => cycle.join(' -> '));

    expect(
      formattedCycles,
      [
        'Circular dependencies between src modules are forbidden unless explicitly allowlisted with a reason.',
        ...formattedCycles
      ].join('\n')
    ).toEqual([]);
  });
});
