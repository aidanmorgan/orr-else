/**
 * s3wp.34 — Artifact presence vs validation gate status.
 *
 * Tests that pre_signal_audit and harness_status report artifact PRESENCE
 * separately from validatorStatus (passed|rejected|unknown) and checklistComplete,
 * so models cannot infer "artifact exists == gate accepted".
 *
 * Scenarios:
 *  1. planContract present but artifact_validator never invoked → validatorStatus=unknown,
 *     blockingEvidence names the missing gate.
 *  2. planContract present, artifact_validator invoked and rejected → validatorStatus=rejected,
 *     blockingEvidence names the rejected gate.
 *  3. planContract present, artifact_validator invoked and passed → validatorStatus=passed,
 *     no artifact-gate blocking evidence.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import orrElseExtension from '../src/extension.js';
import { BuiltInToolName, EnvVars, PiEventName, ProcessFlag } from '../src/constants/index.js';
import { ARTIFACT_VALIDATOR_TOOL_NAME } from '../src/plugins/projectTools/constants.js';

const HEADLESS_TOOL_CONTEXT = { hasUI: false, shutdown: () => {} } as any;

function fakePi() {
  const tools: any[] = [];
  const commands: Record<string, any> = {};
  const callbacks: Record<string, Function> = {};
  let activeTools: string[] = [];
  return {
    tools,
    commands,
    callbacks,
    pi: {
      on: (name: string, callback: Function) => { callbacks[name] = callback; },
      registerTool: (tool: any) => tools.push(tool),
      registerCommand: (name: string, options: any) => { commands[name] = options; },
      getActiveTools: () => activeTools,
      setActiveTools: (names: string[]) => { activeTools = names; },
      setThinkingLevel: () => {},
      setModel: async () => true,
      sendUserMessage: () => {}
    } as any
  };
}

/** Build a minimal harness.yaml with planContract artifact template + artifact_validator.
 * @param exitCode - Process exit code: 0 = PASSED, 1 = REJECTED
 */
function buildHarnessYaml(exitCode: 0 | 1): string {
  const exitCodeJs = exitCode === 0
    ? `console.log(JSON.stringify({ tool: '${ARTIFACT_VALIDATOR_TOOL_NAME}', status: 'PASSED' }));`
    : `console.log(JSON.stringify({ tool: '${ARTIFACT_VALIDATOR_TOOL_NAME}', status: 'REJECTED' })); process.exit(1);`;
  return `
settings:
  startState: Planning
  artifacts:
    baseDir: .pi/artifacts
    templates:
      planContract: .pi/artifacts/{{beadId}}/plan-contract.json
tools:
  - name: ${ARTIFACT_VALIDATOR_TOOL_NAME}
    type: command
    command: node
    defaultArgs:
      - "-e"
      - ${JSON.stringify(exitCodeJs)}
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    actions:
      - id: formulate-plan
        type: prompt
        prompt: "Plan"
    requiredTools: []
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`;
}

interface ArtifactGateItemStatus {
  artifactId: string;
  presence: boolean;
  validatorStatus: 'passed' | 'rejected' | 'unknown';
  checklistComplete: boolean;
}

interface ArtifactGateStatus {
  artifacts: ArtifactGateItemStatus[];
  allGatesSatisfied: boolean;
}

async function setupWorkerEnv(tempRoot: string, beadId: string): Promise<{
  previousCwd: string;
  previousEnv: Record<string, string | undefined>;
  worktreePath: string;
  planContractPath: string;
}> {
  const previousCwd = process.cwd();
  const previousEnv: Record<string, string | undefined> = {
    workerMode: process.env[EnvVars.WORKER_MODE],
    beadId: process.env[EnvVars.BEAD_ID],
    stateId: process.env[EnvVars.STATE_ID],
    actionId: process.env[EnvVars.ACTION_ID],
    projectRoot: process.env[EnvVars.PROJECT_ROOT],
    worktreePath: process.env[EnvVars.WORKTREE_PATH],
    apiBase: process.env[EnvVars.API_BASE]
  };
  const worktreePath = path.join(tempRoot, 'worktree');
  fs.mkdirSync(worktreePath, { recursive: true });

  process.chdir(tempRoot);
  process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
  process.env[EnvVars.BEAD_ID] = beadId;
  process.env[EnvVars.STATE_ID] = 'Planning';
  process.env[EnvVars.ACTION_ID] = 'formulate-plan';
  process.env[EnvVars.PROJECT_ROOT] = tempRoot;
  process.env[EnvVars.WORKTREE_PATH] = worktreePath;

  const planContractDir = path.join(tempRoot, '.pi', 'artifacts', beadId);
  fs.mkdirSync(planContractDir, { recursive: true });
  const planContractPath = path.join(planContractDir, 'plan-contract.json');
  return { previousCwd, previousEnv, worktreePath, planContractPath };
}

function restoreEnv(previousCwd: string, previousEnv: Record<string, string | undefined>): void {
  process.chdir(previousCwd);
  for (const [key, value] of Object.entries(previousEnv)) {
    const envKey = ({
      workerMode: EnvVars.WORKER_MODE,
      beadId: EnvVars.BEAD_ID,
      stateId: EnvVars.STATE_ID,
      actionId: EnvVars.ACTION_ID,
      projectRoot: EnvVars.PROJECT_ROOT,
      worktreePath: EnvVars.WORKTREE_PATH,
      apiBase: EnvVars.API_BASE
    } as Record<string, string>)[key];
    if (!envKey) continue;
    if (value === undefined) delete process.env[envKey];
    else process.env[envKey] = value;
  }
}

describe('s3wp.34 — artifact gate status: presence separate from validation', () => {
  it('planContract present but artifact_validator never invoked → validatorStatus=unknown + blocking evidence naming the missing gate', async () => {
    const beadId = 'bd-s34-unvalidated';
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-s34-unvalidated-')));
    let harness: ReturnType<typeof fakePi> | undefined;
    let envSetup: Awaited<ReturnType<typeof setupWorkerEnv>> | undefined;

    try {
      fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), buildHarnessYaml(0));
      envSetup = await setupWorkerEnv(tempRoot, beadId);

      // Write a planContract so presence=true
      fs.writeFileSync(envSetup.planContractPath, JSON.stringify({ writeSet: ['src/main.ts'] }));

      harness = fakePi();
      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: envSetup.worktreePath });

      // Do NOT invoke artifact_validator — audit should report validatorStatus=unknown
      const preSignalAudit = harness.tools.find((t: any) => t.name === BuiltInToolName.PRE_SIGNAL_AUDIT);
      expect(preSignalAudit, 'pre_signal_audit tool should be registered').toBeDefined();

      const result = await preSignalAudit.execute('audit-call', {}, undefined, undefined, HEADLESS_TOOL_CONTEXT);
      const audit = result.details;

      // Structured artifact gate status should be present
      expect(audit.artifactGateStatus).toBeDefined();
      const gateStatus = audit.artifactGateStatus as ArtifactGateStatus;
      const planContractGate = gateStatus.artifacts.find(a => a.artifactId === 'planContract');
      expect(planContractGate, 'planContract entry should exist in artifactGateStatus').toBeDefined();

      // Presence is true (file exists on disk)
      expect(planContractGate!.presence).toBe(true);
      // ValidatorStatus is unknown (artifact_validator not yet invoked)
      expect(planContractGate!.validatorStatus).toBe('unknown');
      // allGatesSatisfied must be false when validatorStatus=unknown
      expect(gateStatus.allGatesSatisfied).toBe(false);

      // Blocking evidence should name the EXACT missing gate (not just "artifact exists")
      expect(audit.blockingEvidence).toEqual(
        expect.arrayContaining([
          expect.stringContaining('planContract'),
          expect.stringContaining('validatorStatus=unknown')
        ])
      );
      // Blocking evidence must mention running artifact_validator specifically
      const artifactEvidence = (audit.blockingEvidence as string[]).find(
        e => e.includes('validatorStatus=unknown') && e.includes('planContract')
      );
      expect(artifactEvidence).toBeDefined();
      expect(artifactEvidence).toContain(ARTIFACT_VALIDATOR_TOOL_NAME);

    } finally {
      await harness?.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
      await new Promise(resolve => setTimeout(resolve, 25));
      if (envSetup) restoreEnv(envSetup.previousCwd, envSetup.previousEnv);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('planContract present, artifact_validator rejected → validatorStatus=rejected + blocking evidence naming the rejected gate', async () => {
    const beadId = 'bd-s34-rejected';
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-s34-rejected-')));
    let harness: ReturnType<typeof fakePi> | undefined;
    let envSetup: Awaited<ReturnType<typeof setupWorkerEnv>> | undefined;

    try {
      // artifact_validator will exit with code 1 → outer status = REJECTED
      fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), buildHarnessYaml(1));
      envSetup = await setupWorkerEnv(tempRoot, beadId);

      // Write a planContract so presence=true
      fs.writeFileSync(envSetup.planContractPath, JSON.stringify({ writeSet: ['src/main.ts'] }));

      harness = fakePi();
      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: envSetup.worktreePath });

      // Invoke artifact_validator — it will return REJECTED
      const artifactValidatorTool = harness.tools.find((t: any) => t.name === ARTIFACT_VALIDATOR_TOOL_NAME);
      expect(artifactValidatorTool, 'artifact_validator tool should be registered').toBeDefined();
      await artifactValidatorTool.execute('validate-call', {}, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      const preSignalAudit = harness.tools.find((t: any) => t.name === BuiltInToolName.PRE_SIGNAL_AUDIT);
      const result = await preSignalAudit.execute('audit-call', {}, undefined, undefined, HEADLESS_TOOL_CONTEXT);
      const audit = result.details;

      // Structured artifact gate status should show rejected
      expect(audit.artifactGateStatus).toBeDefined();
      const gateStatus = audit.artifactGateStatus as ArtifactGateStatus;
      const planContractGate = gateStatus.artifacts.find(a => a.artifactId === 'planContract');
      expect(planContractGate, 'planContract entry should exist in artifactGateStatus').toBeDefined();

      // Presence is true (file exists on disk)
      expect(planContractGate!.presence).toBe(true);
      // ValidatorStatus is rejected
      expect(planContractGate!.validatorStatus).toBe('rejected');
      // allGatesSatisfied must be false
      expect(gateStatus.allGatesSatisfied).toBe(false);

      // Blocking evidence must mention the rejected gate + artifact name
      const rejectedEvidence = (audit.blockingEvidence as string[]).find(
        e => e.includes('rejected') && e.includes('planContract')
      );
      expect(rejectedEvidence, 'blockingEvidence should name the rejected planContract gate').toBeDefined();
      expect(rejectedEvidence).toContain(ARTIFACT_VALIDATOR_TOOL_NAME);

    } finally {
      await harness?.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
      await new Promise(resolve => setTimeout(resolve, 25));
      if (envSetup) restoreEnv(envSetup.previousCwd, envSetup.previousEnv);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('planContract present, artifact_validator passed → validatorStatus=passed, no artifact-gate blocking evidence', async () => {
    const beadId = 'bd-s34-passed';
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-s34-passed-')));
    let harness: ReturnType<typeof fakePi> | undefined;
    let envSetup: Awaited<ReturnType<typeof setupWorkerEnv>> | undefined;

    try {
      // artifact_validator will exit with code 0 → outer status = PASSED
      fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), buildHarnessYaml(0));
      envSetup = await setupWorkerEnv(tempRoot, beadId);

      // Write a planContract so presence=true
      fs.writeFileSync(envSetup.planContractPath, JSON.stringify({ writeSet: ['src/main.ts'] }));

      harness = fakePi();
      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: envSetup.worktreePath });

      // Invoke artifact_validator — it will return PASSED (exit 0)
      const artifactValidatorTool = harness.tools.find((t: any) => t.name === ARTIFACT_VALIDATOR_TOOL_NAME);
      expect(artifactValidatorTool, 'artifact_validator tool should be registered').toBeDefined();
      await artifactValidatorTool.execute('validate-call', {}, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      const preSignalAudit = harness.tools.find((t: any) => t.name === BuiltInToolName.PRE_SIGNAL_AUDIT);
      const result = await preSignalAudit.execute('audit-call', {}, undefined, undefined, HEADLESS_TOOL_CONTEXT);
      const audit = result.details;

      // Structured artifact gate status should show passed
      expect(audit.artifactGateStatus).toBeDefined();
      const gateStatus = audit.artifactGateStatus as ArtifactGateStatus;
      const planContractGate = gateStatus.artifacts.find(a => a.artifactId === 'planContract');
      expect(planContractGate, 'planContract entry should exist in artifactGateStatus').toBeDefined();

      // Presence is true
      expect(planContractGate!.presence).toBe(true);
      // ValidatorStatus is passed
      expect(planContractGate!.validatorStatus).toBe('passed');

      // No artifact-gate blocking evidence for a passed artifact
      const artifactGateBlockers = (audit.blockingEvidence as string[]).filter(
        e => (e.includes('validatorStatus=unknown') || e.includes('validatorStatus=rejected'))
          && e.includes('planContract')
      );
      expect(artifactGateBlockers.length).toBe(0);

    } finally {
      await harness?.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
      await new Promise(resolve => setTimeout(resolve, 25));
      if (envSetup) restoreEnv(envSetup.previousCwd, envSetup.previousEnv);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('harness_status returns artifactGateStatus with presence/validatorStatus/checklistComplete fields', async () => {
    const beadId = 'bd-s34-harness-status';
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-s34-harness-status-')));
    let harness: ReturnType<typeof fakePi> | undefined;
    let envSetup: Awaited<ReturnType<typeof setupWorkerEnv>> | undefined;

    try {
      fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), buildHarnessYaml(0));
      envSetup = await setupWorkerEnv(tempRoot, beadId);

      // Write a planContract so presence=true
      fs.writeFileSync(envSetup.planContractPath, JSON.stringify({ writeSet: ['src/main.ts'] }));

      harness = fakePi();
      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: envSetup.worktreePath });

      const harnessStatus = harness.tools.find((t: any) => t.name === BuiltInToolName.HARNESS_STATUS);
      expect(harnessStatus, 'harness_status tool should be registered').toBeDefined();

      const result = await harnessStatus.execute('status-call', {}, undefined, undefined, HEADLESS_TOOL_CONTEXT);
      const status = result.details as any;

      // harness_status in teammate mode should include artifactGateStatus
      expect(status.mode).toBe('teammate');
      expect(status.artifactGateStatus).toBeDefined();
      const gateStatus = status.artifactGateStatus as ArtifactGateStatus;
      expect(gateStatus.artifacts.length).toBeGreaterThan(0);

      // planContract should be present (file was written)
      const planContractGate = gateStatus.artifacts.find(a => a.artifactId === 'planContract');
      expect(planContractGate).toBeDefined();
      expect(planContractGate!.presence).toBe(true);
      // No validator invocation yet → unknown
      expect(planContractGate!.validatorStatus).toBe('unknown');
      // checklistComplete should be a boolean
      expect(typeof planContractGate!.checklistComplete).toBe('boolean');

    } finally {
      await harness?.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
      await new Promise(resolve => setTimeout(resolve, 25));
      if (envSetup) restoreEnv(envSetup.previousCwd, envSetup.previousEnv);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
