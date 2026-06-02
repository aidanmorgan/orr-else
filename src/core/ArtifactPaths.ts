import * as path from 'path';
import * as fs from 'fs';
import { createHash } from 'node:crypto';
import { ConfigLoader } from './ConfigLoader.js';
import { resolveProjectFrom } from './Paths.js';
import { nodeRuntimeEnvironment, type RuntimeEnvironment } from './RuntimeEnvironment.js';
import { EnvVars } from '../constants/index.js';

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

    for (const [name, template] of selectedTemplateEntries) {
      const effectiveRoot = this.env.env(EnvVars.PROJECT_ROOT) || this.projectRoot;
      const rendered = this.render(template, {
        baseDir,
        beadId: context.beadId,
        stateId: context.stateId || '',
        actionId: context.actionId || '',
        artifactId: context.artifactId || name,
        projectRoot: effectiveRoot,
        worktreePath: this.env.env(EnvVars.WORKTREE_PATH) || effectiveRoot
      });
      const resolved = path.isAbsolute(rendered) ? rendered : resolveProjectFrom(effectiveRoot, rendered);
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
