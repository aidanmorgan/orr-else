import { Type } from "@earendil-works/pi-ai";
import { execa } from 'execa';
import { Logger } from '../core/Logger.js';
import { Component, EnvVars, OtelAttr, PluginToolName, SpanName, ToolResultStatus } from '../constants/index.js';
import type { Observability } from '../core/Observability.js';
import { nodeRuntimeEnvironment, type RuntimeEnvironment } from '../core/RuntimeEnvironment.js';
import type { RuntimePlugin, RuntimeTool } from '../core/RuntimeServices.js';

export function createQualityPlugin(observability?: Observability, env: RuntimeEnvironment = nodeRuntimeEnvironment): RuntimePlugin {
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

        if (ui?.hasUI) ui.ui?.setWorkingMessage("Running quality checks...");

        const startMs = Date.now();
        let output = '';
        let exitCode: number | undefined;
        let verdict: 'passed' | 'failed' = 'passed';

        try {
          if (command) {
            const result = await execa('sh', ['-lc', command]);
            output = result.stdout;
            exitCode = result.exitCode;
          } else {
            const build = await execa('npm', ['run', 'build']);
            const test = await execa('npm', ['test']);
            output = `${build.stdout}\n${test.stdout}`;
            exitCode = test.exitCode;
          }
        } catch (error: unknown) {
          verdict = 'failed';
          output = (error && typeof error === 'object' && 'stdout' in error ? (error as { stdout: string }).stdout : undefined) || (error instanceof Error ? error.message : String(error));
          exitCode = (error && typeof error === 'object' && 'exitCode' in error ? (error as { exitCode?: number }).exitCode : undefined) ?? 1;
          Logger.error(Component.QUALITY, 'Quality checks failed', { error: output });
        }

        const endMs = Date.now();
        try {
          observability?.recordCompletedSpan(SpanName.VERIFIER_RUN, {
            [OtelAttr.ORR_ELSE_BEAD_ID]: env.env(EnvVars.BEAD_ID) || undefined,
            [OtelAttr.ORR_ELSE_STATE_ID]: env.env(EnvVars.STATE_ID) || undefined,
            'verifier.verdict': verdict,
            'verifier.exit_code': exitCode ?? 0
          }, startMs, endMs);
        } catch { /* best-effort: telemetry must never fail the check */ }

        if (verdict === 'failed') {
          if (ui?.hasUI) {
            ui.ui?.notify("Quality checks FAILED", "error");
            ui.ui?.setWorkingMessage(undefined);
          }
          return { status: ToolResultStatus.REJECTED, output };
        }

        if (ui?.hasUI) {
          ui.ui?.notify("Quality checks PASSED", "info");
          ui.ui?.setWorkingMessage(undefined);
        }
        return { status: ToolResultStatus.PASSED, output };
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
