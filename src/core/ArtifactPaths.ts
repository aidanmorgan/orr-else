import * as path from 'path';
import * as fs from 'fs';
import { createHash } from 'node:crypto';
import { ConfigLoader } from './ConfigLoader.js';
import { resolveProjectFrom } from './Paths.js';
import { nodeRuntimeEnvironment, type RuntimeEnvironment } from './RuntimeEnvironment.js';
import { EnvVars } from '../constants/infra.js';
import type { ArtifactTemplate, ArtifactTemplateConfig } from './domain/StateModels.js';

export interface ArtifactPathContext {
  beadId: string;
  stateId?: string;
  actionId?: string;
  artifactId?: string;
  /**
   * When true (default), include deterministic file metadata (bytes, sha256) for existing
   * artifacts. Content is never inlined — use query_artifact with a selector or projection to
   * read artifact content.
   */
  includeContent?: boolean;
}

const DEFAULT_TEMPLATES: Record<string, string> = {};
const ArtifactPathResultKey = {
  PATHS: 'artifactPaths',
  EXISTS: 'artifactExists',
  MISSING: 'missingArtifacts',
  CONTENTS: 'artifactContents'
} as const;

/**
 * Deterministic file metadata for an artifact.
 * Content is never inlined here — use query_artifact selectors to read content.
 */
export interface ArtifactContentPreview {
  /** Resolved absolute path to the artifact. */
  path: string;
  /** Whether the artifact exists on disk. */
  exists: boolean;
  /** File size in bytes. Present when the artifact exists and is a regular file. */
  bytes?: number;
  /** SHA-256 hex digest (first 16 hex chars) of the file. Present when the artifact exists and is a regular file. */
  sha256?: string;
  /** Error message if stat/hash failed. */
  error?: string;
}

export interface ArtifactPathResolution {
  artifactPaths: Record<string, string>;
  artifactExists: Record<string, boolean>;
  missingArtifacts: string[];
  artifactContents: Record<string, ArtifactContentPreview>;
  [key: string]: string | Record<string, string> | Record<string, boolean> | string[] | Record<string, ArtifactContentPreview> | undefined;
}

export class ArtifactPaths {
  constructor(
    private readonly configLoader: ConfigLoader,
    private readonly env: RuntimeEnvironment = nodeRuntimeEnvironment,
    private readonly projectRoot: string = process.cwd()
  ) {}

  public async resolve(context: ArtifactPathContext): Promise<ArtifactPathResolution> {
    const config = await this.configLoader.load();
    const baseDir = config.settings.artifacts?.baseDir || '.pi/artifacts';
    const templates = {
      ...DEFAULT_TEMPLATES,
      ...(config.settings.artifacts?.templates || {})
    };

    const paths: Record<string, string> = {};
    const existence: Record<string, boolean> = {};
    const contents: Record<string, ArtifactContentPreview> = {};
    const missing: string[] = [];
    const includeContent = context.includeContent ?? true;
    const templateEntries = Object.entries(templates);
    const selectedTemplateEntries = context.artifactId && Object.prototype.hasOwnProperty.call(templates, context.artifactId)
      ? [[context.artifactId, templates[context.artifactId]] as const]
      : templateEntries;

    for (const [name, templateConfig] of selectedTemplateEntries) {
      const resolved = this.resolveTemplatePath(this.normalizeTemplate(templateConfig), name, baseDir, context);
      paths[name] = resolved;
      existence[name] = fs.existsSync(resolved);
      if (!existence[name]) missing.push(name);
      if (includeContent) {
        contents[name] = this.readArtifactMetadata(resolved, existence[name]);
      } else {
        contents[name] = { path: resolved, exists: existence[name] };
      }
    }

    return {
      ...paths,
      [ArtifactPathResultKey.PATHS]: paths,
      [ArtifactPathResultKey.EXISTS]: existence,
      [ArtifactPathResultKey.MISSING]: missing,
      [ArtifactPathResultKey.CONTENTS]: contents
    };
  }

  private render(template: string, values: Record<string, string>): string {
    return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_match, key) => values[key] || '');
  }

  /** Normalize the string-shorthand and object forms to a single ArtifactTemplate. */
  private normalizeTemplate(entry: ArtifactTemplateConfig): ArtifactTemplate {
    return typeof entry === 'string' ? { path: entry } : entry;
  }

  /** Render a template and resolve it against its declared scope root. */
  private resolveTemplatePath(
    template: ArtifactTemplate,
    name: string,
    baseDir: string,
    context: ArtifactPathContext
  ): string {
    const projectRoot = this.env.env(EnvVars.PROJECT_ROOT) || this.projectRoot;
    const worktreePath = this.env.env(EnvVars.WORKTREE_PATH) || projectRoot;
    const rendered = this.render(template.path, {
      baseDir,
      beadId: context.beadId,
      stateId: context.stateId || '',
      actionId: context.actionId || '',
      artifactId: context.artifactId || name,
      projectRoot,
      worktreePath
    });
    if (path.isAbsolute(rendered)) return path.normalize(rendered);
    const scopeRoot = template.scope === 'worktree' ? worktreePath : projectRoot;
    return resolveProjectFrom(scopeRoot, rendered);
  }

  /**
   * Resolve the exact absolute paths of all WRITABLE declared artifacts for the
   * given bead/state context. Transactional write-set enforcement permits writes
   * to exactly these paths (path-class systemArtifact) even when they are not in
   * the bead's approved plan write set.
   */
  public async resolveWritableArtifactPaths(context: ArtifactPathContext): Promise<string[]> {
    const config = await this.configLoader.load();
    const baseDir = config.settings.artifacts?.baseDir || '.pi/artifacts';
    const templates = config.settings.artifacts?.templates || {};
    const writable: string[] = [];
    for (const [name, entry] of Object.entries(templates)) {
      const template = this.normalizeTemplate(entry);
      if (!template.writable) continue;
      writable.push(this.resolveTemplatePath(template, name, baseDir, context));
    }
    return writable;
  }

  /**
   * Ensure the parent directory of every declared artifact whose template sets
   * ensureDir:true exists, so a teammate can write the artifact. mkdir -p is
   * idempotent; failures are surfaced to the caller.
   */
  public async ensureArtifactDirs(context: ArtifactPathContext): Promise<void> {
    const config = await this.configLoader.load();
    const baseDir = config.settings.artifacts?.baseDir || '.pi/artifacts';
    const templates = config.settings.artifacts?.templates || {};
    for (const [name, entry] of Object.entries(templates)) {
      const template = this.normalizeTemplate(entry);
      if (!template.ensureDir) continue;
      const resolved = this.resolveTemplatePath(template, name, baseDir, context);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
    }
  }

  /**
   * Read deterministic file metadata (size + sha256) for an artifact.
   * Content is never inlined — callers should use query_artifact selectors.
   */
  private readArtifactMetadata(pathName: string, exists: boolean): ArtifactContentPreview {
    if (!exists) return { path: pathName, exists };

    try {
      const stat = fs.statSync(pathName);
      if (!stat.isFile()) {
        return { path: pathName, exists, bytes: stat.size };
      }
      const raw = fs.readFileSync(pathName);
      const sha256 = createHash('sha256').update(raw).digest('hex').slice(0, 16);
      return { path: pathName, exists, bytes: stat.size, sha256 };
    } catch (error) {
      return { path: pathName, exists, error: String(error) };
    }
  }
}
