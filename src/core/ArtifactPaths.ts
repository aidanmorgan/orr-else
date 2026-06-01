import * as path from 'path';
import * as fs from 'fs';
import { ConfigLoader } from './ConfigLoader.js';
import { getProjectRoot, resolveProject } from './Paths.js';
import { ArtifactPathDefaults, EnvVars } from '../constants/index.js';

export interface ArtifactPathContext {
  beadId: string;
  stateId?: string;
  actionId?: string;
  artifactId?: string;
  includeContent?: boolean;
  maxInlineBytes?: number;
  maxTotalInlineBytes?: number;
}

const DEFAULT_TEMPLATES: Record<string, string> = {};
const ArtifactPathResultKey = {
  PATHS: 'artifactPaths',
  EXISTS: 'artifactExists',
  MISSING: 'missingArtifacts',
  CONTENTS: 'artifactContents'
} as const;

export interface ArtifactContentPreview {
  path: string;
  exists: boolean;
  bytes?: number;
  text?: string;
  inlineBytes?: number;
  truncated?: boolean;
  previewOmitted?: string;
  error?: string;
}

export interface ArtifactPathResolution {
  artifactPaths: Record<string, string>;
  artifactExists: Record<string, boolean>;
  missingArtifacts: string[];
  artifactContents: Record<string, ArtifactContentPreview>;
  nextAction?: string;
  recovery?: string[];
  truncatedArtifacts?: string[];
  omittedArtifacts?: string[];
  [key: string]: string | Record<string, string> | Record<string, boolean> | string[] | Record<string, ArtifactContentPreview> | undefined;
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
    const contents: Record<string, ArtifactContentPreview> = {};
    const missing: string[] = [];
    const truncatedArtifacts: string[] = [];
    const omittedArtifacts: string[] = [];
    const includeContent = context.includeContent ?? true;
    const requestedMaxInlineBytes = Math.max(0, Math.floor(context.maxInlineBytes ?? ArtifactPathDefaults.DEFAULT_INLINE_BYTES));
    const requestedMaxTotalInlineBytes = Math.max(0, Math.floor(context.maxTotalInlineBytes ?? ArtifactPathDefaults.DEFAULT_TOTAL_INLINE_BYTES));
    const maxInlineBytes = Math.min(requestedMaxInlineBytes, ArtifactPathDefaults.MAX_INLINE_BYTES);
    let remainingInlineBytes = Math.min(requestedMaxTotalInlineBytes, ArtifactPathDefaults.MAX_TOTAL_INLINE_BYTES);
    const templateEntries = Object.entries(templates);
    const selectedTemplateEntries = context.artifactId && Object.prototype.hasOwnProperty.call(templates, context.artifactId)
      ? [[context.artifactId, templates[context.artifactId]] as const]
      : templateEntries;

    for (const [name, template] of selectedTemplateEntries) {
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
      existence[name] = fs.existsSync(resolved);
      if (!existence[name]) missing.push(name);
      if (includeContent) {
        contents[name] = this.readArtifactPreview(resolved, existence[name], Math.min(maxInlineBytes, remainingInlineBytes));
        if (contents[name].truncated === true && contents[name].text !== undefined) {
          truncatedArtifacts.push(name);
        }
        if (contents[name].previewOmitted === 'artifact inline content budget exhausted') {
          omittedArtifacts.push(name);
        }
        remainingInlineBytes = Math.max(0, remainingInlineBytes - (contents[name].inlineBytes || 0));
      } else {
        contents[name] = { path: resolved, exists: existence[name] };
      }
    }

    const focusedFetchGuidance = this.focusedFetchGuidance([...truncatedArtifacts, ...omittedArtifacts]);

    return {
      ...paths,
      [ArtifactPathResultKey.PATHS]: paths,
      [ArtifactPathResultKey.EXISTS]: existence,
      [ArtifactPathResultKey.MISSING]: missing,
      [ArtifactPathResultKey.CONTENTS]: contents,
      ...(truncatedArtifacts.length > 0 ? { truncatedArtifacts } : {}),
      ...(omittedArtifacts.length > 0 ? { omittedArtifacts } : {}),
      ...focusedFetchGuidance
    };
  }

  private render(template: string, values: Record<string, string>): string {
    return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_match, key) => values[key] || '');
  }

  private readArtifactPreview(pathName: string, exists: boolean, maxInlineBytes: number): ArtifactContentPreview {
    if (!exists) return { path: pathName, exists };

    try {
      const stat = fs.statSync(pathName);
      if (!stat.isFile()) {
        return {
          path: pathName,
          exists,
          bytes: stat.size,
          inlineBytes: 0,
          truncated: false,
          previewOmitted: 'artifact path is not a regular file'
        };
      }
      if (maxInlineBytes <= 0) {
        return {
          path: pathName,
          exists,
          bytes: stat.size,
          inlineBytes: 0,
          truncated: stat.size > 0,
          previewOmitted: 'artifact inline content budget exhausted'
        };
      }

      const bytesToRead = Math.min(stat.size, maxInlineBytes);
      const file = fs.openSync(pathName, 'r');
      try {
        const buffer = Buffer.alloc(bytesToRead);
        fs.readSync(file, buffer, 0, bytesToRead, 0);
        return {
          path: pathName,
          exists,
          bytes: stat.size,
          text: buffer.toString('utf8'),
          inlineBytes: bytesToRead,
          truncated: stat.size > bytesToRead
        };
      } finally {
        fs.closeSync(file);
      }
    } catch (error) {
      return {
        path: pathName,
        exists,
        error: String(error)
      };
    }
  }

  private focusedFetchGuidance(artifactIds: string[]): Pick<ArtifactPathResolution, 'nextAction' | 'recovery'> {
    const uniqueArtifactIds = [...new Set(artifactIds)];
    if (uniqueArtifactIds.length === 0) return {};

    return {
      nextAction: 'rerun_with_artifactId',
      recovery: [
        `Rerun get_artifact_paths with artifactId set to one of: ${uniqueArtifactIds.join(', ')}.`,
        'Request only the needed artifact content and keep maxInlineBytes/maxTotalInlineBytes bounded to the evidence required.'
      ]
    };
  }
}
