import * as path from 'path';
import { ProjectToolDefaults } from '../constants/index.js';
import { resolveTemplateString, type TemplateContext } from './PiIntegration.js';

export interface ToolCallPathAllocation {
  invocationId: string;
  callDir: string;
  outputDir: string;
  outputFile: string;
  tmpDir: string;
}

function resolveProjectPath(projectRoot: string, value: string, context: TemplateContext): string {
  const resolved = resolveTemplateString(value, context);
  return path.isAbsolute(resolved) ? resolved : path.resolve(projectRoot, resolved);
}

export class ToolCallPathFactory {
  public allocate(context: TemplateContext): ToolCallPathAllocation {
    const invocationId = context.toolInvocationId;
    if (!invocationId) throw new Error('toolInvocationId is required for tool-call path allocation');

    const callDir = resolveProjectPath(context.projectRoot, ProjectToolDefaults.CALL_DIR_TEMPLATE, context);
    const outputDir = path.join(callDir, ProjectToolDefaults.OUTPUT_DIR_NAME);
    const tmpDir = path.join(callDir, ProjectToolDefaults.TMP_DIR_NAME);
    const outputFileName = resolveTemplateString(ProjectToolDefaults.OUTPUT_FILE_NAME_TEMPLATE, {
      ...context,
      toolCallDir: callDir,
      toolOutputDir: outputDir,
      toolTmpDir: tmpDir,
    });

    return {
      invocationId,
      callDir,
      outputDir,
      outputFile: path.join(outputDir, outputFileName),
      tmpDir,
    };
  }
}
