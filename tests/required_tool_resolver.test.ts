import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ArtifactPaths } from '../src/core/ArtifactPaths.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { PlanWriteSet } from '../src/core/PlanWriteSet.js';
import { RequiredToolResolver } from '../src/core/RequiredToolResolver.js';

describe('RequiredToolResolver', () => {
  let tempRoot: string;
  let tempWorktree: string;
  let frameworkRoot: string;
  let configLoader: ConfigLoader;
  let resolver: RequiredToolResolver;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-required-tools-'));
    tempWorktree = path.join(tempRoot, 'worktrees', 'bd-1');
    frameworkRoot = path.join(tempRoot, 'pi-experiment');
    fs.mkdirSync(path.join(tempRoot, '.pi', 'artifacts', 'bd-1'), { recursive: true });
    fs.mkdirSync(tempWorktree, { recursive: true });
    fs.mkdirSync(frameworkRoot, { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Implementation
  artifacts:
    templates:
      orrElseFrameworkRoot: ${JSON.stringify(frameworkRoot)}
      planContract: .pi/artifacts/{{beadId}}/plan-contract.json
  transactionalState:
    enabled: true
    requireWriteSet: true
  worktreePolicy:
    default: always
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]

states:
  Implementation:
    identity: { role: "Builder", expertise: "Implementation", constraints: [] }
    baseInstructions: "Build"
    requiredTools:
      - pytest
      - name: framework_build
        when:
          writeSetIncludesAny:
            - "{{orrElseFrameworkRoot}}"
    actions:
      - id: a1
        type: prompt
    transitions: { SUCCESS: "completed", FAILURE: "Implementation" }
`);
    configLoader = new ConfigLoader(undefined, tempRoot);
    resolver = new RequiredToolResolver(new PlanWriteSet(configLoader, new ArtifactPaths(configLoader, undefined, tempRoot), tempRoot), tempRoot);
  });

  afterEach(() => {
    configLoader.reset();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('skips conditional required tools when the approved write set does not match', async () => {
    fs.writeFileSync(path.join(tempRoot, '.pi', 'artifacts', 'bd-1', 'plan-contract.json'), JSON.stringify({
      writeSet: ['packages/ceridwen-compiler/src/example.py']
    }));
    const config = configLoader.load();

    const result = await resolver.resolve(config.states.Implementation.requiredTools, {
      beadId: 'bd-1',
      stateId: 'Implementation',
      worktreePath: tempWorktree,
      projectRoot: tempRoot,
      config
    });

    expect(result.toolNames).toEqual(['pytest']);
    expect(result.skippedTools).toEqual([
      {
        name: 'framework_build',
        reason: 'approved write set does not include any configured path prefix'
      }
    ]);
  });

  it('requires conditional tools when the approved write set matches a configured prefix', async () => {
    fs.writeFileSync(path.join(tempRoot, '.pi', 'artifacts', 'bd-1', 'plan-contract.json'), JSON.stringify({
      writeSet: [path.join(frameworkRoot, 'src', 'extension.ts')]
    }));
    const config = configLoader.load();

    const result = await resolver.resolve(config.states.Implementation.requiredTools, {
      beadId: 'bd-1',
      stateId: 'Implementation',
      worktreePath: tempWorktree,
      projectRoot: tempRoot,
      config
    });

    expect(result.toolNames).toEqual(['pytest', 'framework_build']);
    expect(result.skippedTools).toEqual([]);
  });
});
