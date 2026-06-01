import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ArtifactPaths } from '../src/core/ArtifactPaths.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { ArtifactPathDefaults } from '../src/constants/index.js';
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
    expect(result.artifactContents.existingArtifact).toMatchObject({
      path: result.existingArtifact,
      exists: true,
      bytes: 2,
      text: '{}',
      truncated: false
    });
    expect(result.artifactContents.missingArtifact).toMatchObject({
      path: result.missingArtifact,
      exists: false
    });
    expect(result.nextAction).toBeUndefined();
    expect(result.recovery).toBeUndefined();
  });

  it('returns bounded previews without reading whole large artifacts into memory', async () => {
    writeFile('.pi/artifacts/bd-1/existing.json', 'abcdef');

    const result = await artifactPaths.resolve({
      beadId: 'bd-1',
      stateId: 'RequirementsAnalysis',
      maxInlineBytes: 3
    });

    expect(result.artifactContents.existingArtifact).toMatchObject({
      bytes: 6,
      text: 'abc',
      truncated: true
    });
    expect(result.truncatedArtifacts).toEqual(['existingArtifact']);
    expect(result.nextAction).toBe('rerun_with_artifactId');
    expect(result.recovery?.[0]).toContain('existingArtifact');
  });

  it('guides focused retrieval when aggregate inline budget is exhausted', async () => {
    writeFile('.pi/artifacts/bd-1/existing.json', 'abcdef');
    writeFile('.pi/artifacts/bd-1/missing.json', 'uvwxyz');

    const result = await artifactPaths.resolve({
      beadId: 'bd-1',
      stateId: 'RequirementsAnalysis',
      maxInlineBytes: 6,
      maxTotalInlineBytes: 6
    });

    expect(result.artifactContents.existingArtifact.text).toBe('abcdef');
    expect(result.artifactContents.missingArtifact).toMatchObject({
      previewOmitted: 'artifact inline content budget exhausted',
      inlineBytes: 0,
      truncated: true
    });
    expect(result.omittedArtifacts).toEqual(['missingArtifact']);
    expect(result.nextAction).toBe('rerun_with_artifactId');
    expect(result.recovery?.[0]).toContain('missingArtifact');
  });

  it('returns only the requested configured artifact when artifactId matches a template key', async () => {
    const result = await artifactPaths.resolve({
      beadId: 'bd-1',
      stateId: 'RequirementsAnalysis',
      artifactId: 'existingArtifact'
    });

    expect(Object.keys(result.artifactPaths)).toEqual(['existingArtifact']);
    expect(result.existingArtifact).toBe(path.join(root, '.pi/artifacts/bd-1/existing.json'));
    expect(result.artifactContents.existingArtifact).toMatchObject({
      path: result.existingArtifact,
      exists: true,
      text: '{}'
    });
  });

  it('honors larger bounded previews for a requested artifact without loading unrelated artifacts', async () => {
    const largeContent = 'x'.repeat(5000);
    writeFile('.pi/artifacts/bd-1/existing.json', largeContent);

    const result = await artifactPaths.resolve({
      beadId: 'bd-1',
      stateId: 'RequirementsAnalysis',
      artifactId: 'existingArtifact',
      maxInlineBytes: 5000,
      maxTotalInlineBytes: 5000
    });

    expect(result.artifactContents.existingArtifact.text).toHaveLength(5000);
    expect(result.artifactContents.existingArtifact.truncated).toBe(false);
    expect(result.artifactContents.missingArtifact).toBeUndefined();
    expect(result.nextAction).toBeUndefined();
  });

  it('caps excessive inline preview requests to protect teammate context', async () => {
    const largeContent = 'x'.repeat(70000);
    writeFile('.pi/artifacts/bd-1/existing.json', largeContent);

    const result = await artifactPaths.resolve({
      beadId: 'bd-1',
      stateId: 'RequirementsAnalysis',
      artifactId: 'existingArtifact',
      maxInlineBytes: 90000,
      maxTotalInlineBytes: 90000
    });

    expect(result.artifactContents.existingArtifact.text).toHaveLength(ArtifactPathDefaults.MAX_INLINE_BYTES);
    expect(result.artifactContents.existingArtifact.truncated).toBe(true);
    expect(result.truncatedArtifacts).toEqual(['existingArtifact']);
    expect(result.nextAction).toBe('rerun_with_artifactId');
  });
});
