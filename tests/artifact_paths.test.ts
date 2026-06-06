import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ArtifactPaths } from '../src/core/ArtifactPaths.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';

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
    configLoader = new ConfigLoader(undefined, root);
    artifactPaths = new ArtifactPaths(configLoader, undefined, root);
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
  worktreePolicy:
    default: always
scheduler:
  weights:
    waitTime: 1
    executionTime: 1
    progress: 1
    penalty: 1
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]

states:
  RequirementsAnalysis:
    identity:
      role: Requirements
      expertise: Analysis
      constraints: []
    baseInstructions: Analyze.
    actions:
      - id: a1
        type: prompt
    transitions:
      SUCCESS: completed
      FAILURE: RequirementsAnalysis
`);
    writeFile('.pi/artifacts/bd-1/existing.json', '{}');
  });

  afterEach(() => {
    configLoader.reset();
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
    // Minimal metadata only — no inlined content, no byte-capped text
    expect(result.artifactContents.existingArtifact).toMatchObject({
      path: result.existingArtifact,
      exists: true,
      bytes: 2
    });
    expect(result.artifactContents.existingArtifact.text).toBeUndefined();
    expect(result.artifactContents.existingArtifact.truncated).toBeUndefined();
    expect(typeof result.artifactContents.existingArtifact.sha256).toBe('string');
    expect(result.artifactContents.missingArtifact).toMatchObject({
      path: result.missingArtifact,
      exists: false
    });
    // No byte-budget guidance fields
    expect((result as any).nextAction).toBeUndefined();
    expect((result as any).recovery).toBeUndefined();
    expect((result as any).truncatedArtifacts).toBeUndefined();
    expect((result as any).omittedArtifacts).toBeUndefined();
  });

  it('returns compact metadata (bytes + sha256) for any file size — no content inlining', async () => {
    writeFile('.pi/artifacts/bd-1/existing.json', 'abcdef');

    const result = await artifactPaths.resolve({
      beadId: 'bd-1',
      stateId: 'RequirementsAnalysis'
    });

    // Metadata only — no text inlining regardless of file size
    expect(result.artifactContents.existingArtifact.bytes).toBe(6);
    expect(result.artifactContents.existingArtifact.text).toBeUndefined();
    expect(result.artifactContents.existingArtifact.truncated).toBeUndefined();
    expect(result.artifactContents.existingArtifact.previewOmitted).toBeUndefined();
    expect(typeof result.artifactContents.existingArtifact.sha256).toBe('string');
    // No byte-budget guidance
    expect((result as any).truncatedArtifacts).toBeUndefined();
    expect((result as any).nextAction).toBeUndefined();
  });

  it('returns metadata for multiple artifacts without any inline budget tracking', async () => {
    writeFile('.pi/artifacts/bd-1/existing.json', 'abcdef');
    writeFile('.pi/artifacts/bd-1/missing.json', 'uvwxyz');

    const result = await artifactPaths.resolve({
      beadId: 'bd-1',
      stateId: 'RequirementsAnalysis'
    });

    // Both artifacts get metadata — no budget-exhausted omission
    expect(result.artifactContents.existingArtifact.bytes).toBe(6);
    expect(result.artifactContents.existingArtifact.text).toBeUndefined();
    expect(result.artifactContents.missingArtifact.bytes).toBe(6);
    expect(result.artifactContents.missingArtifact.text).toBeUndefined();
    // No omittedArtifacts / truncatedArtifacts fields
    expect((result as any).omittedArtifacts).toBeUndefined();
    expect((result as any).truncatedArtifacts).toBeUndefined();
    expect((result as any).nextAction).toBeUndefined();
  });

  it('returns only the requested configured artifact when artifactId matches a template key', async () => {
    const result = await artifactPaths.resolve({
      beadId: 'bd-1',
      stateId: 'RequirementsAnalysis',
      artifactId: 'existingArtifact'
    });

    expect(Object.keys(result.artifactPaths)).toEqual(['existingArtifact']);
    expect(result.existingArtifact).toBe(path.join(root, '.pi/artifacts/bd-1/existing.json'));
    // Metadata only — no text content inlining
    expect(result.artifactContents.existingArtifact).toMatchObject({
      path: result.existingArtifact,
      exists: true,
      bytes: 2
    });
    expect(result.artifactContents.existingArtifact.text).toBeUndefined();
    expect(typeof result.artifactContents.existingArtifact.sha256).toBe('string');
  });

  it('returns compact metadata for large artifacts without any content inlining', async () => {
    const largeContent = 'x'.repeat(70000);
    writeFile('.pi/artifacts/bd-1/existing.json', largeContent);

    const result = await artifactPaths.resolve({
      beadId: 'bd-1',
      stateId: 'RequirementsAnalysis',
      artifactId: 'existingArtifact'
    });

    // Bytes reflects true file size; no text, no truncated, no nextAction
    expect(result.artifactContents.existingArtifact.bytes).toBe(70000);
    expect(result.artifactContents.existingArtifact.text).toBeUndefined();
    expect(result.artifactContents.existingArtifact.truncated).toBeUndefined();
    expect(result.artifactContents.missingArtifact).toBeUndefined();
    expect((result as any).truncatedArtifacts).toBeUndefined();
    expect((result as any).nextAction).toBeUndefined();
  });

  it('includeContent:false returns only path and existence flags', async () => {
    const result = await artifactPaths.resolve({
      beadId: 'bd-1',
      stateId: 'RequirementsAnalysis',
      artifactId: 'existingArtifact',
      includeContent: false
    });

    expect(result.artifactContents.existingArtifact).toEqual({
      path: result.existingArtifact,
      exists: true
    });
    expect(result.artifactContents.existingArtifact.bytes).toBeUndefined();
    expect(result.artifactContents.existingArtifact.sha256).toBeUndefined();
  });
});
