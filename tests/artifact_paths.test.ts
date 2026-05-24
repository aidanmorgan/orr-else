import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ArtifactPaths } from '../src/core/ArtifactPaths.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { setProjectRoot } from '../src/core/Paths.js';

const root = path.join(os.tmpdir(), 'orr-else-artifact-paths-test');

function writeFile(relativePath: string, content: string): void {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

describe('ArtifactPaths', () => {
  let configLoader: ConfigLoader;
  let artifactPaths: ArtifactPaths;

  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    setProjectRoot(root);
    configLoader = new ConfigLoader();
    artifactPaths = new ArtifactPaths(configLoader);
    writeFile('harness.yaml', `
settings:
  maxConcurrentSlots: 1
  handoverTemplate: ''
  defaultModel: gpt-5.5
  startState: RequirementsAnalysis
  artifacts:
    baseDir: .pi/artifacts
    templates:
      existingArtifact: .pi/artifacts/{{beadId}}/existing.json
      missingArtifact: .pi/artifacts/{{beadId}}/missing.json
scheduler:
  weights:
    waitTime: 1
    executionTime: 1
    progress: 1
    penalty: 1
states:
  RequirementsAnalysis:
    identity:
      role: Requirements
      expertise: Analysis
      constraints: []
    baseInstructions: Analyze.
    actions: []
    transitions:
      SUCCESS: Planning
`);
    writeFile('.pi/artifacts/bd-1/existing.json', '{}');
  });

  afterEach(() => {
    configLoader.reset();
    setProjectRoot(process.cwd());
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns stable paths with existence metadata', async () => {
    const result = await artifactPaths.resolve({ beadId: 'bd-1', stateId: 'RequirementsAnalysis' });

    expect(result.existingArtifact).toBe(path.join(root, '.pi/artifacts/bd-1/existing.json'));
    expect(result.missingArtifact).toBe(path.join(root, '.pi/artifacts/bd-1/missing.json'));
    expect(result.artifactPaths.existingArtifact).toBe(result.existingArtifact);
    expect(result.artifactPaths.missingArtifact).toBe(result.missingArtifact);
    expect(result.artifactExists.existingArtifact).toBe(true);
    expect(result.artifactExists.missingArtifact).toBe(false);
    expect(result.missingArtifacts).toContain('missingArtifact');
  });
});
