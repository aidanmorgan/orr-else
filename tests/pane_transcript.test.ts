/**
 * Tests for pane transcript capture, ANSI cleanup, scan, and transcript writing.
 *
 * Covers:
 *   - stripAnsiEscapes: strips CSI/SGR sequences while preserving text content.
 *   - redactPaneText: ANSI stripped before reasoning redaction.
 *   - scanPaneTranscript: detects each of the five issue categories; ignores
 *     clean output.
 *   - TeammateFactory.capturePaneText: writes transcript + pointer; cap respected;
 *     write failure does not throw.
 *   - TeammateFactory.captureBeadPaneText: scan findings appended to evidence.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execa } from 'execa';

import {
  stripAnsiEscapes,
  redactPaneText,
  ANSI_ESCAPE_PATTERN,
} from '../src/core/PaneTextRedactor.js';
import {
  scanPaneTranscript,
  hasScanFindings,
  formatScanSummary,
  ScanCategory,
  SCAN_MAX_REPRESENTATIVE_LINES,
  detectFinalBlockedState,
  SCAN_FINAL_TAIL_LINES,
} from '../src/core/PaneTranscriptScanner.js';
import { PaneTranscriptDefaults, OperationalArtifactPath, EnvVars } from '../src/constants/index.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { EventStore } from '../src/core/EventStore.js';
import { Observability } from '../src/core/Observability.js';
import { TeammateFactory } from '../src/plugins/teammates.js';

// ---------------------------------------------------------------------------
// execa mock — shared across all tests in this file
// ---------------------------------------------------------------------------

const { execaMock, defaultTmuxResponse } = vi.hoisted(() => {
  const defaultTmuxResponse = async (bin: string, args: string[]) => {
    if (bin !== 'tmux') throw new Error(`unexpected binary: ${bin}`);
    if (args.includes('list-windows')) return { stdout: 'Agents\n', stderr: '' };
    if (args.includes('list-panes')) return { stdout: '', stderr: '' };
    if (args.includes('capture-pane')) return { stdout: '', stderr: '' };
    if (args.includes('split-window')) return { stdout: '%1\n', stderr: '' };
    return { stdout: '', stderr: '' };
  };
  return { execaMock: vi.fn(defaultTmuxResponse), defaultTmuxResponse };
});

vi.mock('execa', () => ({ execa: execaMock }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFactory(root: string, configLoader: ConfigLoader, eventStore: EventStore, observability: Observability): TeammateFactory {
  return new TeammateFactory(observability, configLoader, eventStore, {}, 6, undefined, undefined, undefined, root);
}

// ---------------------------------------------------------------------------
// ANSI stripping
// ---------------------------------------------------------------------------

describe('stripAnsiEscapes', () => {
  it('strips CSI SGR colour codes while preserving text', () => {
    const input = '\x1b[31mHello\x1b[0m world';
    expect(stripAnsiEscapes(input)).toBe('Hello world');
  });

  it('strips CSI cursor-movement sequences', () => {
    const input = '\x1b[2J\x1b[H\x1b[1;1Hfoo';
    expect(stripAnsiEscapes(input)).toBe('foo');
  });

  it('strips OSC sequences with BEL terminator', () => {
    const input = '\x1b]0;Window Title\x07text after';
    expect(stripAnsiEscapes(input)).toBe('text after');
  });

  it('strips bare ESC + single character', () => {
    const input = '\x1bcsome text';
    expect(stripAnsiEscapes(input)).toBe('some text');
  });

  it('leaves plain text unchanged', () => {
    const plain = 'No escape sequences here. Error: something failed.';
    expect(stripAnsiEscapes(plain)).toBe(plain);
  });

  it('strips escape sequences embedded inside a multi-line string', () => {
    const input = 'line1\n\x1b[32mline2\x1b[0m\nline3';
    expect(stripAnsiEscapes(input)).toBe('line1\nline2\nline3');
  });

  it('preserves empty string', () => {
    expect(stripAnsiEscapes('')).toBe('');
  });

  it('regex ANSI_ESCAPE_PATTERN is a global regex (required for replace)', () => {
    expect(ANSI_ESCAPE_PATTERN.flags).toContain('g');
  });
});

// ---------------------------------------------------------------------------
// redactPaneText — ANSI stripped before reasoning redaction
// ---------------------------------------------------------------------------

describe('redactPaneText with ANSI sequences', () => {
  it('strips ANSI before applying reasoning redaction', () => {
    // The <thinking> marker arrives wrapped in colour codes; redaction must
    // still recognise it after ANSI stripping.
    // Use </thinking> as the close marker (matching the close pattern).
    const raw = '\x1b[33m<thinking>\x1b[0m\nThis is a reasoning line\n\x1b[0m\nKeep this line';
    const result = redactPaneText(raw);
    // The reasoning block is open and "This is a reasoning line" is suppressed.
    expect(result).not.toContain('This is a reasoning line');
    // redactPaneText opens a block on <thinking>; since no close marker
    // appears, the block stays open. Verify at minimum that ANSI stripped.
    expect(result).not.toMatch(/\x1b\[/);
  });

  it('returns clean text (no ANSI sequences) after processing', () => {
    const raw = '\x1b[31mError: something failed\x1b[0m';
    const result = redactPaneText(raw);
    expect(result).not.toMatch(/\x1b\[/);
    expect(result).toContain('Error: something failed');
  });
});

// ---------------------------------------------------------------------------
// scanPaneTranscript — category detection
// ---------------------------------------------------------------------------

describe('scanPaneTranscript — PROVIDER_ERROR', () => {
  it('detects rate limit errors', () => {
    const result = scanPaneTranscript('Request failed: rate limit exceeded');
    expect(result[ScanCategory.PROVIDER_ERROR].count).toBeGreaterThan(0);
  });

  it('detects ECONNRESET', () => {
    const result = scanPaneTranscript('Error: ECONNRESET - connection reset by peer');
    expect(result[ScanCategory.PROVIDER_ERROR].count).toBeGreaterThan(0);
  });

  it('detects API key invalid', () => {
    const result = scanPaneTranscript('API key invalid or expired');
    expect(result[ScanCategory.PROVIDER_ERROR].count).toBeGreaterThan(0);
  });

  it('detects provider error explicitly', () => {
    const result = scanPaneTranscript('provider error: service unavailable');
    expect(result[ScanCategory.PROVIDER_ERROR].count).toBeGreaterThan(0);
  });
});

describe('scanPaneTranscript — PROTOCOL_VIOLATION', () => {
  it('detects unexpected event type', () => {
    const result = scanPaneTranscript('Received unexpected event type in current state');
    expect(result[ScanCategory.PROTOCOL_VIOLATION].count).toBeGreaterThan(0);
  });

  it('detects schema validation error', () => {
    const result = scanPaneTranscript('schema validation error: missing required field');
    expect(result[ScanCategory.PROTOCOL_VIOLATION].count).toBeGreaterThan(0);
  });

  it('detects handover failed', () => {
    const result = scanPaneTranscript('handover failed: invalid state transition');
    expect(result[ScanCategory.PROTOCOL_VIOLATION].count).toBeGreaterThan(0);
  });

  it('detects contract violation', () => {
    const result = scanPaneTranscript('contract violation detected in harness');
    expect(result[ScanCategory.PROTOCOL_VIOLATION].count).toBeGreaterThan(0);
  });
});

describe('scanPaneTranscript — ENOENT', () => {
  it('detects ENOENT keyword', () => {
    const result = scanPaneTranscript("Error: ENOENT: no such file or directory, open '/some/path'");
    expect(result[ScanCategory.ENOENT].count).toBeGreaterThan(0);
  });

  it('detects "no such file or directory" phrase', () => {
    const result = scanPaneTranscript("ls: cannot access '/foo/bar': No such file or directory");
    expect(result[ScanCategory.ENOENT].count).toBeGreaterThan(0);
  });

  it('detects "module not found"', () => {
    const result = scanPaneTranscript("Error: Cannot find module './missing-module'");
    expect(result[ScanCategory.ENOENT].count).toBeGreaterThan(0);
  });
});

describe('scanPaneTranscript — STUCK_PROMPT', () => {
  it('detects "Press Enter to continue"', () => {
    const result = scanPaneTranscript('Press Enter to continue...');
    expect(result[ScanCategory.STUCK_PROMPT].count).toBeGreaterThan(0);
  });

  it('detects [y/n] prompt', () => {
    const result = scanPaneTranscript('Do you want to proceed? [y/n]:');
    expect(result[ScanCategory.STUCK_PROMPT].count).toBeGreaterThan(0);
  });

  it('detects password prompt', () => {
    const result = scanPaneTranscript('Enter your password:');
    expect(result[ScanCategory.STUCK_PROMPT].count).toBeGreaterThan(0);
  });

  it('detects "Waiting for user" input', () => {
    const result = scanPaneTranscript('Waiting for user confirmation...');
    expect(result[ScanCategory.STUCK_PROMPT].count).toBeGreaterThan(0);
  });
});

describe('scanPaneTranscript — PANIC_FATAL', () => {
  it('detects "panic" keyword', () => {
    const result = scanPaneTranscript('goroutine 1 [running]: panic: runtime error: index out of range');
    expect(result[ScanCategory.PANIC_FATAL].count).toBeGreaterThan(0);
  });

  it('detects "fatal error"', () => {
    const result = scanPaneTranscript('fatal error: out of memory');
    expect(result[ScanCategory.PANIC_FATAL].count).toBeGreaterThan(0);
  });

  it('detects "segmentation fault"', () => {
    const result = scanPaneTranscript('Segmentation fault (core dumped)');
    expect(result[ScanCategory.PANIC_FATAL].count).toBeGreaterThan(0);
  });

  it('detects UnhandledPromiseRejection', () => {
    const result = scanPaneTranscript('UnhandledPromiseRejectionWarning: Error: something went wrong');
    expect(result[ScanCategory.PANIC_FATAL].count).toBeGreaterThan(0);
  });
});

describe('scanPaneTranscript — clean output', () => {
  it('returns zero counts for clean output', () => {
    const clean = [
      'Starting bead pi-experiment-kwrf in state Planning',
      'Tool call: bd_get_bead',
      '{"beadId": "pi-experiment-kwrf", "status": "open"}',
      'State transition: Planning -> Implementation',
      'Heartbeat recorded at 2026-01-01T00:00:00Z',
    ].join('\n');
    const result = scanPaneTranscript(clean);
    expect(hasScanFindings(result)).toBe(false);
  });

  it('returns zero counts for empty string', () => {
    const result = scanPaneTranscript('');
    expect(hasScanFindings(result)).toBe(false);
  });
});

describe('scanPaneTranscript — representative lines and cap', () => {
  it('collects representative lines up to SCAN_MAX_REPRESENTATIVE_LINES', () => {
    const lines = Array.from(
      { length: SCAN_MAX_REPRESENTATIVE_LINES + 5 },
      (_, i) => `Error: ENOENT: no such file or directory, open '/path${i}'`
    );
    const result = scanPaneTranscript(lines.join('\n'));
    expect(result[ScanCategory.ENOENT].count).toBe(lines.length);
    expect(result[ScanCategory.ENOENT].representativeLines.length).toBe(SCAN_MAX_REPRESENTATIVE_LINES);
  });

  it('truncates very long representative lines', () => {
    const longLine = 'ENOENT: ' + 'x'.repeat(300);
    const result = scanPaneTranscript(longLine);
    const repLine = result[ScanCategory.ENOENT].representativeLines[0];
    expect(repLine).toBeDefined();
    expect(repLine!.length).toBeLessThanOrEqual(200);
  });
});

describe('formatScanSummary', () => {
  it('returns "(no issues detected)" when all counts are zero', () => {
    const result = scanPaneTranscript('nothing wrong here');
    expect(formatScanSummary(result)).toBe('(no issues detected)');
  });

  it('includes category names and counts in output', () => {
    const result = scanPaneTranscript('Error: ENOENT: no such file or directory');
    const summary = formatScanSummary(result);
    expect(summary).toContain('ENOENT');
    expect(summary).toContain('(1)');
  });
});

// ---------------------------------------------------------------------------
// detectFinalBlockedState — final-blocked pane detection
// ---------------------------------------------------------------------------

describe('detectFinalBlockedState — terminal blocked banner as final output', () => {
  it('returns blocked=true when a PANIC_FATAL pattern is the last line', () => {
    const text = [
      'Tool call: bd_get_bead',
      'Output: {"status": "open"}',
      'fatal error: out of memory'
    ].join('\n');
    const result = detectFinalBlockedState(text);
    expect(result.blocked).toBe(true);
    expect(result.category).toBe(ScanCategory.PANIC_FATAL);
    expect(result.evidenceLine).toContain('fatal error');
  });

  it('returns blocked=true when a STUCK_PROMPT pattern is the last line', () => {
    const text = [
      'Running test suite',
      'Press Enter to continue...'
    ].join('\n');
    const result = detectFinalBlockedState(text);
    expect(result.blocked).toBe(true);
    expect(result.category).toBe(ScanCategory.STUCK_PROMPT);
  });

  it('returns blocked=true when a FINAL_BLOCKED_PATTERNS line is the last line', () => {
    const text = [
      'Preparing build...',
      'Compiling sources...',
      'command failed'
    ].join('\n');
    const result = detectFinalBlockedState(text);
    expect(result.blocked).toBe(true);
  });

  it('returns blocked=true for a "process exited with code" terminal banner at end', () => {
    const text = [
      'Starting agent...',
      'Running action: plan',
      'exited with code 1'
    ].join('\n');
    const result = detectFinalBlockedState(text);
    expect(result.blocked).toBe(true);
  });

  it('returns blocked=false when error appears mid-transcript but later lines show progress', () => {
    const text = [
      'Tool call: bash',
      'fatal error: temporary failure',    // error here
      'Retrying...',                         // but progress follows
      'Tool call: bd_get_bead',
      'Output: success'
    ].join('\n');
    const result = detectFinalBlockedState(text);
    // Error is not the final output — agent continued
    expect(result.blocked).toBe(false);
  });

  it('returns blocked=false when the tail is entirely clean output', () => {
    const text = [
      'Starting bead pi-experiment-test in state Planning',
      'Tool call: bd_get_bead',
      'State transition: Planning -> Implementation',
      'Heartbeat recorded at 2026-01-01T00:00:00Z'
    ].join('\n');
    const result = detectFinalBlockedState(text);
    expect(result.blocked).toBe(false);
  });

  it('returns blocked=false for empty string', () => {
    const result = detectFinalBlockedState('');
    expect(result.blocked).toBe(false);
  });

  it('returns blocked=false for whitespace-only string', () => {
    const result = detectFinalBlockedState('   \n  \n  ');
    expect(result.blocked).toBe(false);
  });

  it('respects the tail window: an error before SCAN_FINAL_TAIL_LINES of clean progress is NOT final-blocked', () => {
    // Build a transcript with an error near the beginning, then more than
    // SCAN_FINAL_TAIL_LINES clean lines after it.  The error is outside the
    // tail window, so it must NOT trigger final-blocked detection.
    const cleanLines = Array.from({ length: SCAN_FINAL_TAIL_LINES + 5 }, (_, i) =>
      `Progress line ${i + 1}: tool call succeeded`
    );
    const text = [
      'fatal error: something went wrong',   // far outside tail window
      ...cleanLines
    ].join('\n');
    const result = detectFinalBlockedState(text);
    expect(result.blocked).toBe(false);
  });

  it('detects final-blocked even when error is within the tail window but followed only by more errors', () => {
    // Two consecutive blocked lines — the second is the final line.
    const text = [
      'Tool call: bash',
      'process killed',
      'fatal error: agent terminated'  // final line, also a blocked signal
    ].join('\n');
    const result = detectFinalBlockedState(text);
    expect(result.blocked).toBe(true);
  });

  it('truncates a very long evidence line to <= 200 chars', () => {
    const longLine = 'fatal error: ' + 'x'.repeat(300);
    const result = detectFinalBlockedState(longLine);
    expect(result.blocked).toBe(true);
    expect(result.evidenceLine).toBeDefined();
    expect(result.evidenceLine!.length).toBeLessThanOrEqual(200);
  });
});

// ---------------------------------------------------------------------------
// detectFinalBlockedState — NEGATIVE tests: healthy agent prose must NOT trigger
// ---------------------------------------------------------------------------

describe('detectFinalBlockedState — NEGATIVE: healthy agent prose must NOT be detected as blocked', () => {
  it('returns blocked=false for agent narrating a command failure mid-prose', () => {
    // "I see the command failed" is agent narration, not a terminal banner.
    const text = [
      'Bead: bead-1  State: Planning',
      'Tool call: bash { "command": "npm test" }',
      'I see the command failed, let me investigate the error output.',
      'Tool call: bash { "command": "npm test -- --reporter verbose" }'
    ].join('\n');
    expect(detectFinalBlockedState(text).blocked).toBe(false);
  });

  it('returns blocked=false for inline "error: expected X but got Y" in tool output mid-prose', () => {
    // "error: expected 200 but got 404" is tool output mid-run, not a final banner.
    const text = [
      'Tool call: bash { "command": "curl http://localhost:3000/health" }',
      'error: expected 200 but got 404',
      'The endpoint returned 404; checking the server logs.',
      'Tool call: bash { "command": "cat server.log" }'
    ].join('\n');
    expect(detectFinalBlockedState(text).blocked).toBe(false);
  });

  it('returns blocked=false when "awaiting user feedback" appears in agent narration prose', () => {
    // "awaiting user feedback" is agent prose — not a stuck-prompt banner.
    const text = [
      'I have completed the implementation.',
      'Currently awaiting user feedback on the PR.',
      'Tool call: bd_update_bead { "status": "in_progress" }',
      'Output: {"ok": true}'
    ].join('\n');
    expect(detectFinalBlockedState(text).blocked).toBe(false);
  });

  it('returns blocked=false when "Cannot proceed without the API key" appears in agent prose followed by progress', () => {
    // Agent narrates an obstacle but then continues working.
    const text = [
      'Cannot proceed without the API key, checking env vars.',
      'Tool call: bash { "command": "echo $API_KEY" }',
      'Output: sk-prod-xxx (truncated)'
    ].join('\n');
    expect(detectFinalBlockedState(text).blocked).toBe(false);
  });

  it('returns blocked=false for "process killed" appearing in git log output mid-run', () => {
    // "process killed" embedded in quoted git log context — agent is reading log,
    // not experiencing an OS kill.  The pattern IS in PANIC_FATAL, so this is
    // a real false-positive risk; the tail-window + progress-after-match check
    // must protect against it when progress lines follow.
    const text = [
      'Tool call: bash { "command": "git log --oneline -5" }',
      "a1b2c3 fix: handle 'process killed' edge case in teardown",
      'Tool call: bd_get_bead',
      'Output: {"status": "open"}'
    ].join('\n');
    expect(detectFinalBlockedState(text).blocked).toBe(false);
  });

  it('returns blocked=false for mid-prose "cannot continue" NOT at line start', () => {
    // "cannot continue" was a dropped pattern (prose-prone); confirm it no longer
    // triggers final-blocked detection even when it appears as the last line.
    const text = [
      'Reviewing the options available.',
      'The old approach cannot continue to scale with this data size.'
    ].join('\n');
    expect(detectFinalBlockedState(text).blocked).toBe(false);
  });

  it('returns blocked=false for "build failed" embedded mid-line in agent narration', () => {
    // "build failed" mid-line must not match the now line-anchored pattern.
    const text = [
      'The CI reported that the build failed earlier, but I have fixed it.',
      'Tool call: bash { "command": "npm run build" }',
      'Output: Build succeeded'
    ].join('\n');
    expect(detectFinalBlockedState(text).blocked).toBe(false);
  });

  // FIX 1 — regression tests: process-termination phrases mid-line must NOT match

  it('(FIX-1) returns blocked=false when final line is a git-log entry containing "process killed" mid-line', () => {
    // "process killed" appears inside a commit message, not as a leading OS kill banner.
    // Pre-fix: PANIC_FATAL_PATTERNS used \b which matched mid-line, causing a false positive.
    // Post-fix: FINAL_BLOCKED_PANIC_FATAL_PATTERNS requires the phrase to start the line.
    const text = [
      'Tool call: bash { "command": "git log --oneline -3" }',
      'a1b2c3 fix: handle process killed edge case in teardown',
    ].join('\n');
    expect(detectFinalBlockedState(text).blocked).toBe(false);
  });

  it('(FIX-1) returns blocked=false when final line is a log-reader line containing "exited with code 1" mid-line', () => {
    // "exited with code 1" appears after a timestamp — not a leading exit-banner.
    // Pre-fix: FINAL_BLOCKED_PROCESS_PATTERNS used \b which matched mid-line.
    // Post-fix: the pattern requires the phrase to lead the trimmed line.
    const text = [
      'Tool call: bash { "command": "cat worker.log" }',
      '2026-01-01 worker exited with code 1',
    ].join('\n');
    expect(detectFinalBlockedState(text).blocked).toBe(false);
  });

  // FIX 1 — positive tests: genuine leading banners must still trigger blocked=true

  it('(FIX-1) returns blocked=true when final line is a leading "process killed" OS banner', () => {
    // A genuine OS kill banner that starts the line must still be detected.
    const text = [
      'Starting agent...',
      'process killed',
    ].join('\n');
    const result = detectFinalBlockedState(text);
    expect(result.blocked).toBe(true);
    expect(result.category).toBe(ScanCategory.PANIC_FATAL);
  });

  it('(FIX-1) returns blocked=true when final line is a leading "exited with code 1" banner', () => {
    // A genuine exit banner that starts the line must still be detected.
    const text = [
      'Starting agent...',
      'exited with code 1',
    ].join('\n');
    const result = detectFinalBlockedState(text);
    expect(result.blocked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TeammateFactory.capturePaneText — transcript + pointer writing
// ---------------------------------------------------------------------------

describe('TeammateFactory.capturePaneText transcript write', () => {
  const root = path.join(os.tmpdir(), 'orr-else-transcript-test-' + Date.now());
  const transcriptDir = path.join(root, '.pi', 'logs', 'tmux');
  const configPath = path.join(root, 'harness.yaml');
  const currentExtensionPath = path.join(root, 'ext.ts');
  let configLoader: ConfigLoader;
  let eventStore: EventStore;
  let observability: Observability;
  let previousProjectRoot: string | undefined;

  beforeEach(async () => {
    fs.mkdirSync(path.join(root, 'state', 'logs'), { recursive: true });
    fs.writeFileSync(currentExtensionPath, 'export default {};\n');
    previousProjectRoot = process.env[EnvVars.PROJECT_ROOT];
    process.env[EnvVars.PROJECT_ROOT] = root;
    fs.writeFileSync(configPath, `
settings:
  maxConcurrentSlots: 1
  handoverTemplate: "handover"
  startState: Planning
  defaultModel: "gpt-5.5"
  eventStore:
    enabled: false
  observability:
    enabled: false
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states:
  Planning:
    identity: { role: planner, expertise: planning, constraints: [] }
    baseInstructions: plan
    actions: []
    transitions: { SUCCESS: completed }
`);
    configLoader = new ConfigLoader(undefined, root);
    configLoader.setConfigPath(configPath);
    eventStore = new EventStore(configLoader, undefined, undefined, root);
    observability = new Observability(configLoader, undefined, root);
    await observability.initialize();
    vi.mocked(execa).mockReset();
    vi.mocked(execa).mockImplementation(defaultTmuxResponse);
  });

  afterEach(() => {
    observability.shutdown();
    configLoader.reset();
    if (previousProjectRoot === undefined) {
      delete process.env[EnvVars.PROJECT_ROOT];
    } else {
      process.env[EnvVars.PROJECT_ROOT] = previousProjectRoot;
    }
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('writes transcript to the per-pane log file after capture', async () => {
    const paneContent = 'Tool call: bd_get_bead\nsome output line\n';
    vi.mocked(execa).mockImplementation(async (bin: string, args: string[]) => {
      if (bin !== 'tmux') throw new Error('unexpected');
      if (args.includes('capture-pane')) return { stdout: paneContent, stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const factory = makeFactory(root, configLoader, eventStore, observability);
    const result = await factory.capturePaneText('%42');

    // Give the best-effort write a tick to complete.
    await new Promise(resolve => setImmediate(resolve));

    expect(result).toContain('some output line');
    const transcriptPath = path.join(transcriptDir, '_42.log');
    expect(fs.existsSync(transcriptPath)).toBe(true);
    const written = fs.readFileSync(transcriptPath, 'utf8');
    expect(written).toContain('some output line');
  });

  it('writes the pointer file pointing to the current transcript', async () => {
    vi.mocked(execa).mockImplementation(async (bin: string, args: string[]) => {
      if (bin !== 'tmux') throw new Error('unexpected');
      if (args.includes('capture-pane')) return { stdout: 'hello world\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const factory = makeFactory(root, configLoader, eventStore, observability);
    await factory.capturePaneText('%7');
    await new Promise(resolve => setImmediate(resolve));

    const pointerPath = path.join(transcriptDir, PaneTranscriptDefaults.POINTER_FILENAME);
    expect(fs.existsSync(pointerPath)).toBe(true);
    const pointer = fs.readFileSync(pointerPath, 'utf8');
    expect(pointer).toContain('_7.log');
  });

  it('writes only the capped tail when transcript exceeds MAX_TRANSCRIPT_BYTES', async () => {
    // Build a string slightly over the cap.
    const cap = PaneTranscriptDefaults.MAX_TRANSCRIPT_BYTES;
    const paddingLine = 'a'.repeat(1024) + '\n';
    const overLimitLines = Math.ceil((cap + 2048) / paddingLine.length);
    const overLimitText = Array(overLimitLines).fill(paddingLine).join('');

    vi.mocked(execa).mockImplementation(async (bin: string, args: string[]) => {
      if (bin !== 'tmux') throw new Error('unexpected');
      if (args.includes('capture-pane')) return { stdout: overLimitText, stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const factory = makeFactory(root, configLoader, eventStore, observability);
    await factory.capturePaneText('%99');
    await new Promise(resolve => setImmediate(resolve));

    const transcriptPath = path.join(transcriptDir, '_99.log');
    expect(fs.existsSync(transcriptPath)).toBe(true);
    const stat = fs.statSync(transcriptPath);
    expect(stat.size).toBeLessThanOrEqual(cap);
  });

  it('does not throw when the transcript directory cannot be created', async () => {
    // Point root at a path that cannot be a directory (a file sits there).
    const blockerRoot = path.join(os.tmpdir(), 'orr-else-blocker-' + Date.now());
    fs.mkdirSync(blockerRoot, { recursive: true });
    // Place a FILE where the transcript dir should appear.
    const transcriptDirPath = path.join(blockerRoot, '.pi', 'logs', 'tmux');
    fs.mkdirSync(path.dirname(transcriptDirPath), { recursive: true });
    fs.writeFileSync(transcriptDirPath, 'I am a file, not a dir');

    vi.mocked(execa).mockImplementation(async (bin: string, args: string[]) => {
      if (bin !== 'tmux') throw new Error('unexpected');
      if (args.includes('capture-pane')) return { stdout: 'some output\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const blockerConfigPath = path.join(blockerRoot, 'harness.yaml');
    fs.mkdirSync(path.join(blockerRoot, 'state', 'logs'), { recursive: true });
    fs.writeFileSync(blockerConfigPath, `
settings:
  maxConcurrentSlots: 1
  handoverTemplate: "handover"
  startState: Planning
  defaultModel: "gpt-5.5"
  eventStore:
    enabled: false
  observability:
    enabled: false
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states:
  Planning:
    identity: { role: planner, expertise: planning, constraints: [] }
    baseInstructions: plan
    actions: []
    transitions: { SUCCESS: completed }
`);
    const blockerConfig = new ConfigLoader(undefined, blockerRoot);
    blockerConfig.setConfigPath(blockerConfigPath);
    const blockerStore = new EventStore(blockerConfig, undefined, undefined, blockerRoot);
    const blockerObs = new Observability(blockerConfig, undefined, blockerRoot);
    await blockerObs.initialize();

    const factory = makeFactory(blockerRoot, blockerConfig, blockerStore, blockerObs);

    // Must not throw.
    await expect(factory.capturePaneText('%1')).resolves.toBeDefined();

    blockerObs.shutdown();
    blockerConfig.reset();
    fs.rmSync(blockerRoot, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// TeammateFactory.captureBeadPaneText — scan findings in evidence
// ---------------------------------------------------------------------------

describe('TeammateFactory.captureBeadPaneText scan findings', () => {
  const root = path.join(os.tmpdir(), 'orr-else-scan-bead-test-' + Date.now());
  const configPath = path.join(root, 'harness.yaml');
  const worktreePath = path.join(root, 'worktrees', 'test-bead');
  let configLoader: ConfigLoader;
  let eventStore: EventStore;
  let observability: Observability;
  let previousProjectRoot: string | undefined;

  beforeEach(async () => {
    fs.mkdirSync(path.join(root, 'state', 'logs'), { recursive: true });
    fs.mkdirSync(worktreePath, { recursive: true });
    previousProjectRoot = process.env[EnvVars.PROJECT_ROOT];
    process.env[EnvVars.PROJECT_ROOT] = root;
    fs.writeFileSync(configPath, `
settings:
  maxConcurrentSlots: 1
  handoverTemplate: "handover"
  startState: Planning
  defaultModel: "gpt-5.5"
  eventStore:
    enabled: false
  observability:
    enabled: false
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states:
  Planning:
    identity: { role: planner, expertise: planning, constraints: [] }
    baseInstructions: plan
    actions: []
    transitions: { SUCCESS: completed }
`);
    configLoader = new ConfigLoader(undefined, root);
    configLoader.setConfigPath(configPath);
    eventStore = new EventStore(configLoader, undefined, undefined, root);
    observability = new Observability(configLoader, undefined, root);
    await observability.initialize();
    vi.mocked(execa).mockReset();
    vi.mocked(execa).mockImplementation(defaultTmuxResponse);
  });

  afterEach(() => {
    observability.shutdown();
    configLoader.reset();
    if (previousProjectRoot === undefined) {
      delete process.env[EnvVars.PROJECT_ROOT];
    } else {
      process.env[EnvVars.PROJECT_ROOT] = previousProjectRoot;
    }
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('appends scan findings to evidence when issues are detected', async () => {
    const paneContent = "Error: ENOENT: no such file or directory, open '/missing/path'\n";
    vi.mocked(execa).mockImplementation(async (bin: string, args: string[]) => {
      if (bin !== 'tmux') throw new Error('unexpected');
      if (args.includes('list-panes')) {
        return {
          stdout: `%1\tAgent:test-bead\tnode\tPI_ORR_ELSE_WORKER=true PI_BEAD_ID=test-bead pi\t${worktreePath}\t0`,
          stderr: ''
        };
      }
      if (args.includes('capture-pane')) return { stdout: paneContent, stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const factory = makeFactory(root, configLoader, eventStore, observability);
    const result = await factory.captureBeadPaneText('test-bead');

    expect(result).toContain('ENOENT');
    expect(result).toContain('[Transcript scan findings]');
  });

  it('does not append scan section when output is clean', async () => {
    const paneContent = 'Tool call: bd_get_bead\nAll systems normal\n';
    vi.mocked(execa).mockImplementation(async (bin: string, args: string[]) => {
      if (bin !== 'tmux') throw new Error('unexpected');
      if (args.includes('list-panes')) {
        return {
          stdout: `%1\tAgent:test-bead\tnode\tPI_ORR_ELSE_WORKER=true PI_BEAD_ID=test-bead pi\t${worktreePath}\t0`,
          stderr: ''
        };
      }
      if (args.includes('capture-pane')) return { stdout: paneContent, stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const factory = makeFactory(root, configLoader, eventStore, observability);
    const result = await factory.captureBeadPaneText('test-bead');

    expect(result).not.toContain('[Transcript scan findings]');
    expect(result).toContain('All systems normal');
  });
});
