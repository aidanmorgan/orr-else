import { describe, expect, it } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { ToolCallPathFactory, type ToolCallPathAllocation } from '../src/core/ToolCallPathFactory.js';
import type { TemplateContext } from '../src/core/TemplateResolver.js';

function context(overrides: Partial<TemplateContext> = {}): TemplateContext {
  const projectRoot = path.join(os.tmpdir(), 'orr-else-tool-call-paths');
  return {
    projectRoot,
    worktreePath: path.join(projectRoot, 'worktree'),
    beadId: 'bd-1',
    stateId: 'Planning',
    actionId: 'analyze',
    toolName: 'env_probe',
    toolInvocationId: '018f4c2a-1111-7222-8333-abcdefabcdef',
    ...overrides
  };
}

function expectedPaths(projectRoot: string, segments: string[], outputFileName: string): ToolCallPathAllocation {
  // 0yt5.27: single PROJECT-scoped tool-output archive at .pi/tool-output.
  const callDir = path.join(projectRoot, '.pi', 'tool-output', ...segments);
  const outputDir = path.join(callDir, 'output');
  return {
    invocationId: segments[4],
    callDir,
    outputDir,
    outputFile: path.join(outputDir, outputFileName),
    tmpDir: path.join(callDir, 'tmp')
  };
}

function expectAllocationUnderToolCallRoot(allocation: ToolCallPathAllocation, projectRoot: string): void {
  const toolCallRoot = path.join(projectRoot, '.pi', 'tool-output');
  for (const candidate of [allocation.callDir, allocation.outputDir, allocation.tmpDir, allocation.outputFile]) {
    const relativePath = path.relative(toolCallRoot, candidate);
    expect(relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath))).toBe(true);
  }
}

describe('ToolCallPathFactory', () => {
  it('preserves existing valid project-tool paths', () => {
    const input = context();
    const allocation = new ToolCallPathFactory().allocate(input);

    expect(allocation).toEqual(expectedPaths(input.projectRoot, [
      'bd-1',
      'Planning',
      'analyze',
      'env_probe',
      '018f4c2a-1111-7222-8333-abcdefabcdef'
    ], 'env_probe-018f4c2a-1111-7222-8333-abcdefabcdef.json'));
    expectAllocationUnderToolCallRoot(allocation, input.projectRoot);
  });

  it('sanitizes traversal fragments before resolving templates', () => {
    const input = context({
      beadId: '../outside',
      stateId: '..',
      actionId: 'review/../../ship',
      toolName: '../runner',
      toolInvocationId: '../invoke'
    });
    const allocation = new ToolCallPathFactory().allocate(input);

    expect(allocation).toEqual(expectedPaths(input.projectRoot, [
      '..-outside',
      'state',
      'review-..-..-ship',
      '..-runner',
      '..-invoke'
    ], '..-runner-..-invoke.json'));
    expectAllocationUnderToolCallRoot(allocation, input.projectRoot);
  });

  it('sanitizes absolute fragments before resolving templates', () => {
    const input = context({
      beadId: '/var/tmp/bd',
      stateId: '/Planning',
      actionId: '/run',
      toolName: '/bin/tool',
      toolInvocationId: '/tmp/invoke'
    });
    const allocation = new ToolCallPathFactory().allocate(input);

    expect(allocation).toEqual(expectedPaths(input.projectRoot, [
      'var-tmp-bd',
      'Planning',
      'run',
      'bin-tool',
      'tmp-invoke'
    ], 'bin-tool-tmp-invoke.json'));
    expectAllocationUnderToolCallRoot(allocation, input.projectRoot);
  });

  it('sanitizes path separators in all template path segments', () => {
    const input = context({
      beadId: 'team\\bd-1',
      stateId: 'Plan/Review',
      actionId: 'exec\\run',
      toolName: 'quality/check',
      toolInvocationId: 'call\\one/two'
    });
    const allocation = new ToolCallPathFactory().allocate(input);

    expect(allocation).toEqual(expectedPaths(input.projectRoot, [
      'team-bd-1',
      'Plan-Review',
      'exec-run',
      'quality-check',
      'call-one-two'
    ], 'quality-check-call-one-two.json'));
    expectAllocationUnderToolCallRoot(allocation, input.projectRoot);
  });

  it('uses safe fallbacks for empty optional segments', () => {
    const input = context({
      beadId: '',
      stateId: '',
      actionId: '',
      toolName: '',
      toolInvocationId: 'call-1'
    });
    const allocation = new ToolCallPathFactory().allocate(input);

    expect(allocation).toEqual(expectedPaths(input.projectRoot, [
      'unassigned',
      'state',
      'manual',
      'tool',
      'call-1'
    ], 'tool-call-1.json'));
    expectAllocationUnderToolCallRoot(allocation, input.projectRoot);
  });

  it('requires a non-empty tool invocation id', () => {
    expect(() => new ToolCallPathFactory().allocate(context({ toolInvocationId: '' })))
      .toThrow('toolInvocationId is required for tool-call path allocation');
  });
});
