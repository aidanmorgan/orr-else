import { Type } from "@earendil-works/pi-ai";
import { execa } from 'execa';
import { Logger } from '../core/Logger.js';
import { Component, PluginToolName, ToolResultStatus } from '../constants/index.js';
import type { RuntimePlugin, RuntimeTool } from '../core/RuntimeServices.js';

export function createQualityPlugin(): RuntimePlugin {
  return {
  name: 'quality-assurance',
  tools: [
    {
      name: PluginToolName.RUN_QUALITY_CHECKS,
      description: "Performs mandatory code quality, complexity, and idiomatic checks.",
      parameters: Type.Object({
        command: Type.Optional(Type.String({ description: "Optional command to run instead of the default TypeScript checks" }))
      }),
      execute: async (params: unknown, ctx?: unknown) => {
        const { command } = (params && typeof params === 'object' ? params : {}) as { command?: string };
        const ui = ctx && typeof ctx === 'object' ? ctx as { hasUI?: boolean; ui?: { setWorkingMessage(m: string | undefined): void; notify(m: string, t: string): void } } : undefined;
        try {
          if (ui?.hasUI) ui.ui?.setWorkingMessage("Running quality checks...");

          let output = '';
          if (command) {
            const { stdout } = await execa('sh', ['-lc', command]);
            output = stdout;
          } else {
            const build = await execa('npm', ['run', 'build']);
            const test = await execa('npm', ['test']);
            output = `${build.stdout}\n${test.stdout}`;
          }

          if (ui?.hasUI) {
            ui.ui?.notify("Quality checks PASSED", "info");
            ui.ui?.setWorkingMessage(undefined);
          }
          return { status: ToolResultStatus.PASSED, output };
        } catch (error: unknown) {
          const output = (error && typeof error === 'object' && 'stdout' in error ? (error as { stdout: string }).stdout : undefined) || (error instanceof Error ? error.message : String(error));
          Logger.error(Component.QUALITY, 'Quality checks failed', { error: output });
          if (ui?.hasUI) {
            ui.ui?.notify("Quality checks FAILED", "error");
            ui.ui?.setWorkingMessage(undefined);
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
      execute: async (params: unknown) => {
        const { logs } = (params && typeof params === 'object' ? params : {}) as { logs: string };
        return `Please compress the following logs into a dense 2-3 sentence State Summary:\n\n${logs}`;
      }
    }
  ] satisfies RuntimeTool[]
};
}
