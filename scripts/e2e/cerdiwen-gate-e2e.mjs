#!/usr/bin/env node
/**
 * cerdiwen-gate-e2e.mjs — the LIVE acceptance run for pi-experiment-0yt5.30
 * (and parent 0yt5.14 AC#9): a dedicated, repeatable driver that runs the REAL
 * orr-else harness over TWO seeded cerdiwen beads and asserts the THREE durable
 * coordinator-gate outcomes against the event log:
 *
 *   1. advance-on-present+valid   — a transition advances when its declared
 *                                   artifacts are present + valid (formalizable
 *                                   bead: smt_lib artifact produced + checked).
 *   2. block-on-absent-artifact   — a transition BLOCKS when a required tool's
 *                                   artifact is ABSENT (tool did-not-run; the
 *                                   86j3 scenario — a non-formalizable bead must
 *                                   NOT stall, but the absent-artifact bead must
 *                                   block).
 *   3. block-on-present-but-FAIL  — a transition BLOCKS when a present artifact
 *                                   FAILs validation (injected sonarqube
 *                                   qualityGate ERROR, s3ss) with the tool's
 *                                   verdict + reasons in the durable record.
 *
 * The VERIFIABLE CORE (analyzeGateOutcomes + assertion helpers) is fully unit-
 * tested in tests/e2e_gate_outcome_analyzer.test.ts and is IMPORTED HERE from
 * the BUILT dist (../../dist/e2e/gateOutcomeAnalyzer.js) so the exact same code
 * that the tests prove is what the live run uses (AC1/AC3).
 *
 * THIS SCRIPT IS THE HUMAN STEP. It REQUIRES a provisioned environment:
 *   - the cerdiwen project checkout (root passed via --project-root / env)
 *   - the SSE MCP backends (codemap + sonarqube) started by cerdiwen's .claude
 *     SessionStart hooks (ups4)
 *   - LLM credentials exported (the binary's provider key)
 *   - two seeded cerdiwen beads (IDs passed via flags/env)
 * It FAILS FAST (non-zero, actionable message) on ANY missing precondition
 * BEFORE running anything (AC2). It does NOT fabricate a green run.
 *
 * Usage: see scripts/e2e/README.md.
 */

import { readFile, readdir, access } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// The tested core, reused from the BUILT dist so the live run and the unit
// tests share ONE implementation. (AC3: assertions read the event log.)
const DIST_ANALYZER = path.join(REPO_ROOT, 'dist', 'e2e', 'gateOutcomeAnalyzer.js');

// The LLM credential env vars pi recognises (provider API keys). At least one
// must be present for the real run. (Mirrors `pi --help` env-var list.)
const LLM_CREDENTIAL_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_OAUTH_TOKEN',
  'GEMINI_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'XAI_API_KEY',
  'GROQ_API_KEY'
];

/** The SSE MCP backends that MUST be reachable for the gate run (ups4). */
const REQUIRED_MCP_BACKENDS = ['codemap', 'sonarqube'];

class PreconditionError extends Error {}

function fail(message) {
  console.error(`\n[cerdiwen-gate-e2e] PRECONDITION FAILED:\n  ${message}\n`);
  process.exit(1);
}

function logStep(message) {
  console.log(`[cerdiwen-gate-e2e] ${message}`);
}

function getArg(flag, envName) {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  if (envName && process.env[envName]) return process.env[envName];
  return undefined;
}

async function pathExists(p) {
  try {
    await access(p, FS.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Probe a TCP host:port for liveness. Resolves true if a socket connects within
 * the timeout, false otherwise. Used to confirm the SSE MCP backends are up.
 */
function probeTcp(host, port, timeoutMs = 1500) {
  return new Promise(resolve => {
    const socket = new net.Socket();
    let settled = false;
    const done = ok => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

/**
 * Read the cerdiwen MCP config (`{projectRoot}/.pi/mcp/config.json`, the harness
 * DEFAULT_MCP_CONFIG_PATH) and resolve each required SSE backend's host:port
 * from its `url`. We do NOT hard-code ports — they come from the cerdiwen .pi
 * config (which the SessionStart hooks template from the dynamic codemap port).
 * Fails with a clear message if a backend or its url cannot be resolved.
 */
async function resolveMcpBackends(projectRoot) {
  const configPath = path.join(projectRoot, '.pi', 'mcp', 'config.json');
  if (!(await pathExists(configPath))) {
    throw new PreconditionError(
      `MCP config not found at ${configPath}. The SSE backends are configured by cerdiwen's ` +
        `.claude SessionStart hooks (ups4); start a cerdiwen session first so the config + ports exist.`
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(configPath, 'utf8'));
  } catch (error) {
    throw new PreconditionError(`MCP config ${configPath} is not valid JSON: ${String(error)}`);
  }
  const servers = (parsed && parsed.mcpServers) || {};
  const resolved = [];
  for (const name of REQUIRED_MCP_BACKENDS) {
    const server = servers[name];
    if (!server) {
      throw new PreconditionError(
        `MCP backend '${name}' is not configured in ${configPath}. ` +
          `Expected an SSE server entry written by the cerdiwen SessionStart hook (ups4).`
      );
    }
    const rawUrl = server.url;
    if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
      throw new PreconditionError(
        `MCP backend '${name}' in ${configPath} has no resolvable 'url' (got ${JSON.stringify(rawUrl)}). ` +
          `The dynamic codemap port may not have been templated — re-run the cerdiwen SessionStart hook.`
      );
    }
    if (rawUrl.includes('{{') || rawUrl.includes('}}')) {
      throw new PreconditionError(
        `MCP backend '${name}' url is still a template (${rawUrl}) in ${configPath}. ` +
          `The SessionStart hook did not substitute the dynamic port; start the backends first.`
      );
    }
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new PreconditionError(`MCP backend '${name}' has an unparseable url: ${rawUrl}`);
    }
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    resolved.push({ name, host: url.hostname, port, url: rawUrl });
  }
  return resolved;
}

/** AC2 precondition gate: project root, SSE backends, LLM creds, seed beads. */
async function checkPreconditions() {
  // (i) cerdiwen project root + harness.yaml.
  const projectRoot = getArg('--project-root', 'CERDIWEN_PROJECT_ROOT');
  if (!projectRoot) {
    throw new PreconditionError(
      `cerdiwen project root not provided. Pass --project-root <path> or set CERDIWEN_PROJECT_ROOT.`
    );
  }
  const resolvedRoot = path.resolve(projectRoot);
  if (!(await pathExists(resolvedRoot))) {
    throw new PreconditionError(`cerdiwen project root does not exist: ${resolvedRoot}`);
  }
  const harnessYaml = path.join(resolvedRoot, 'harness.yaml');
  if (!(await pathExists(harnessYaml))) {
    throw new PreconditionError(
      `${harnessYaml} not found — ${resolvedRoot} does not look like an orr-else consuming project ` +
        `(no harness.yaml).`
    );
  }

  // (ii) SSE MCP backends reachable (codemap + sonarqube), ports resolved from
  // the cerdiwen .pi config (NOT hard-coded).
  const backends = await resolveMcpBackends(resolvedRoot);
  const down = [];
  for (const b of backends) {
    const up = await probeTcp(b.host, b.port);
    logStep(`MCP backend ${b.name} @ ${b.host}:${b.port} — ${up ? 'reachable' : 'DOWN'}`);
    if (!up) down.push(b);
  }
  if (down.length > 0) {
    throw new PreconditionError(
      `SSE MCP backend(s) DOWN: ${down.map(b => `${b.name} (${b.host}:${b.port})`).join(', ')}. ` +
        `Start them via cerdiwen's .claude SessionStart hooks (ups4) before running the gate e2e.`
    );
  }

  // (iii) LLM credentials present.
  const haveCreds = LLM_CREDENTIAL_ENV_VARS.some(name => !!process.env[name]);
  if (!haveCreds) {
    throw new PreconditionError(
      `No LLM credentials found. Export one of: ${LLM_CREDENTIAL_ENV_VARS.join(', ')} ` +
        `(the provider key pi uses to run the real beads).`
    );
  }

  // Seed bead IDs — the two representative cerdiwen beads. The operator MUST
  // provide them (we do not fabricate cerdiwen fixtures). FAIL FAST if absent.
  const formalizableBead = getArg('--formalizable-bead', 'CERDIWEN_FORMALIZABLE_BEAD');
  const absentArtifactBead = getArg('--absent-artifact-bead', 'CERDIWEN_ABSENT_ARTIFACT_BEAD');
  const qualityGateBead = getArg('--quality-gate-bead', 'CERDIWEN_QUALITY_GATE_BEAD');
  const missingSeeds = [];
  if (!formalizableBead) missingSeeds.push('--formalizable-bead / CERDIWEN_FORMALIZABLE_BEAD');
  if (!absentArtifactBead) missingSeeds.push('--absent-artifact-bead / CERDIWEN_ABSENT_ARTIFACT_BEAD');
  if (!qualityGateBead) missingSeeds.push('--quality-gate-bead / CERDIWEN_QUALITY_GATE_BEAD');
  if (missingSeeds.length > 0) {
    throw new PreconditionError(
      `Missing seed bead ID(s): ${missingSeeds.join('; ')}. ` +
        `Provide the named, pre-seeded cerdiwen beads (one formalizable with a valid smt_lib artifact; ` +
        `one whose required smt_lib artifact is ABSENT; one whose sonarqube quality gate is ERROR). ` +
        `See scripts/e2e/README.md for the seeding contract — this script does NOT fabricate cerdiwen fixtures.`
    );
  }

  // The built analyzer must exist (run `npx tsc` first).
  if (!(await pathExists(DIST_ANALYZER))) {
    throw new PreconditionError(
      `Built analyzer not found at ${DIST_ANALYZER}. Run \`npx tsc\` in the orr-else repo first ` +
        `so the live run reuses the unit-tested core.`
    );
  }

  return { projectRoot: resolvedRoot, formalizableBead, absentArtifactBead, qualityGateBead };
}

/**
 * Run the REAL orr-else coordinator over one seeded bead via Pi non-interactive
 * mode. The orchestrator is the Pi command registered by the extension
 * (`/orr-else --bead <id>`), NOT the `orr-else` binary (which only scaffolds).
 * Returns the spawn result so the caller can surface failures.
 */
function runBead(projectRoot, beadId) {
  logStep(`Running real orr-else over bead ${beadId} ...`);
  const extensionPath = path.join(projectRoot, '.pi', 'extensions', 'orr-else.ts');
  const result = spawnSync(
    'pi',
    ['-e', extensionPath, '--print', `/orr-else --bead ${beadId}`],
    {
      cwd: projectRoot,
      env: { ...process.env, PI_PROJECT_ROOT: projectRoot },
      stdio: 'inherit',
      encoding: 'utf8'
    }
  );
  if (result.error) {
    fail(`Failed to launch pi for bead ${beadId}: ${String(result.error)}`);
  }
  if (result.status !== 0) {
    logStep(`pi exited non-zero (${result.status}) for bead ${beadId} — continuing to read the durable log.`);
  }
  return result;
}

/** Parse every `.pi/events/*.jsonl` line into a DomainEvent[] (durable read). */
async function readEventLog(projectRoot) {
  const eventsDir = path.join(projectRoot, '.pi', 'events');
  if (!(await pathExists(eventsDir))) {
    fail(`Event log dir not found at ${eventsDir} after the run — the coordinator recorded no events.`);
  }
  const files = (await readdir(eventsDir)).filter(f => f.endsWith('.jsonl')).sort();
  const events = [];
  for (const file of files) {
    const raw = await readFile(path.join(eventsDir, file), 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed));
      } catch {
        // Skip a torn/partial line rather than aborting the whole read.
      }
    }
  }
  logStep(`Read ${events.length} durable events from ${files.length} JSONL file(s).`);
  return events;
}

async function main() {
  let pre;
  try {
    pre = await checkPreconditions();
  } catch (error) {
    if (error instanceof PreconditionError) fail(error.message);
    throw error;
  }
  logStep('All preconditions satisfied. Proceeding to the live run.');

  const { analyzeGateOutcomes, assertAdvancedOnValid, assertBlockedOnAbsentArtifact, assertBlockedOnPresentButFail } =
    await import(DIST_ANALYZER);

  // SEED: the operator provided the three pre-seeded bead IDs (we fail-fast in
  // checkPreconditions if absent). Run the real orr-else over each.
  runBead(pre.projectRoot, pre.formalizableBead);
  runBead(pre.projectRoot, pre.absentArtifactBead);
  runBead(pre.projectRoot, pre.qualityGateBead);

  // ASSERT against the DURABLE event log (not stdout).
  const events = await readEventLog(pre.projectRoot);
  const analysis = analyzeGateOutcomes(events);

  const failures = [];
  try {
    assertAdvancedOnValid(analysis, pre.formalizableBead);
    logStep(`PASS: ${pre.formalizableBead} advanced on present + valid artifacts.`);
  } catch (error) {
    failures.push(String(error.message));
  }
  try {
    // The required smt_lib tool's artifact is ABSENT for this bead.
    assertBlockedOnAbsentArtifact(analysis, pre.absentArtifactBead, 'smt_lib');
    logStep(`PASS: ${pre.absentArtifactBead} blocked on absent smt_lib artifact.`);
  } catch (error) {
    failures.push(String(error.message));
  }
  try {
    assertBlockedOnPresentButFail(analysis, pre.qualityGateBead, 'sonarqube');
    logStep(`PASS: ${pre.qualityGateBead} blocked on present-but-FAIL sonarqube quality gate.`);
  } catch (error) {
    failures.push(String(error.message));
  }

  if (failures.length > 0) {
    console.error(`\n[cerdiwen-gate-e2e] LIVE ASSERTIONS FAILED:\n${failures.map(f => `  - ${f}`).join('\n')}\n`);
    console.error('Durable analysis was:\n' + JSON.stringify(analysis, null, 2));
    process.exit(1);
  }

  logStep('ALL THREE durable gate outcomes verified. cerdiwen gate e2e GREEN.');
  process.exit(0);
}

main().catch(error => {
  console.error('[cerdiwen-gate-e2e] UNEXPECTED ERROR:', error);
  process.exit(2);
});
