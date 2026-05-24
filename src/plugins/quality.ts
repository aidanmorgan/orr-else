import { Type } from "@earendil-works/pi-ai";
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Logger } from '../core/Logger.js';
import { Component, PluginToolName, ToolResultStatus } from '../constants/index.js';

const execFileAsync = promisify(execFile);

export function createQualityPlugin() {
  return {
  name: 'quality-assurance',
  tools: [
    {
      name: PluginToolName.RUN_QUALITY_CHECKS,
      description: "Performs mandatory code quality, complexity, and idiomatic checks.",
      parameters: Type.Object({
        command: Type.String({ description: "Optional command to run instead of the default TypeScript checks", optional: true })
      }),
      execute: async ({ command }: any, ctx: any) => {
        try {
          if (ctx?.hasUI) ctx.ui.setWorkingMessage("Running quality checks...");
          
          let output = '';
          if (command) {
            const { stdout } = await execFileAsync('sh', ['-lc', command], { encoding: 'utf8' });
            output = stdout;
          } else {
            const build = await execFileAsync('npm', ['run', 'build'], { encoding: 'utf8' });
            const test = await execFileAsync('npm', ['test'], { encoding: 'utf8' });
            output = `${build.stdout}\n${test.stdout}`;
          }
          
          if (ctx?.hasUI) {
            ctx.ui.notify("Quality checks PASSED", "info");
            ctx.ui.setWorkingMessage(undefined);
          }
	          return { status: ToolResultStatus.PASSED, output };
        } catch (error: any) {
          const output = error.stdout || error.message;
          Logger.error(Component.QUALITY, 'Quality checks failed', { error: output });
          if (ctx?.hasUI) {
            ctx.ui.notify("Quality checks FAILED", "error");
            ctx.ui.setWorkingMessage(undefined);
          }
	          return { status: ToolResultStatus.REJECTED, output };
        }
      }
    },
    {
      name: PluginToolName.COMPRESS_SESSION_LOGS,
      description: "Prepares a State Summary from logs. Returns instructions for the LLM to perform the compression.",
      parameters: Type.Object({
        logs: Type.String({ description: "The logs to compress" })
      }),
      execute: async ({ logs }: any) => {
        return `Please compress the following logs into a dense 2-3 sentence State Summary:\n\n${logs}`;
      }
    }
  ]
};
}
