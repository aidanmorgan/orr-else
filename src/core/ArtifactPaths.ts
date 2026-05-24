import * as path from 'path';
import { existsSync } from 'fs';
import { ConfigLoader } from './ConfigLoader.js';
import { getProjectRoot, resolveProject } from './Paths.js';
import { EnvVars } from '../constants/index.js';

export interface ArtifactPathContext {
  beadId: string;
  stateId?: string;
  actionId?: string;
  artifactId?: string;
}

const DEFAULT_TEMPLATES: Record<string, string> = {};
const ArtifactPathResultKey = {
  PATHS: 'artifactPaths',
  EXISTS: 'artifactExists',
  MISSING: 'missingArtifacts'
} as const;

export interface ArtifactPathResolution {
  artifactPaths: Record<string, string>;
  artifactExists: Record<string, boolean>;
  missingArtifacts: string[];
  [key: string]: string | Record<string, string> | Record<string, boolean> | string[];
}

export class ArtifactPaths {
  constructor(private readonly configLoader: ConfigLoader) {}

  public async resolve(context: ArtifactPathContext): Promise<ArtifactPathResolution> {
    const config = await this.configLoader.load();
    const baseDir = config.settings.artifacts?.baseDir || '.pi/artifacts';
    const templates = {
      ...DEFAULT_TEMPLATES,
      ...(config.settings.artifacts?.templates || {})
    };

    const paths: Record<string, string> = {};
    const existence: Record<string, boolean> = {};
    const missing: string[] = [];

    for (const [name, template] of Object.entries(templates)) {
      const rendered = this.render(template, {
        baseDir,
        beadId: context.beadId,
        stateId: context.stateId || '',
        actionId: context.actionId || '',
        artifactId: context.artifactId || name,
        projectRoot: process.env[EnvVars.PROJECT_ROOT] || getProjectRoot(),
        worktreePath: process.env[EnvVars.WORKTREE_PATH] || process.env[EnvVars.PROJECT_ROOT] || getProjectRoot()
      });
      const resolved = path.isAbsolute(rendered) ? rendered : resolveProject(rendered);
      paths[name] = resolved;
      existence[name] = existsSync(resolved);
      if (!existence[name]) missing.push(name);
    }

    return {
      ...paths,
      [ArtifactPathResultKey.PATHS]: paths,
      [ArtifactPathResultKey.EXISTS]: existence,
      [ArtifactPathResultKey.MISSING]: missing
    };
  }

  private render(template: string, values: Record<string, string>): string {
    return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_match, key) => values[key] || '');
  }
}
