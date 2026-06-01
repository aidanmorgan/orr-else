import { afterEach, describe, expect, it } from 'vitest';
import { readClaudeCodeAccessToken } from '../src/plugins/claudeCodeAuth.js';

/**
 * Temporarily override process.platform for a single test and restore it
 * afterwards.
 */
function withPlatform(platform: NodeJS.Platform, fn: () => void): void {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  }
}

describe('readClaudeCodeAccessToken', () => {
  afterEach(() => {
    // Ensure platform is reset even if a test throws unexpectedly.
    Object.defineProperty(process, 'platform', { value: process.platform, configurable: true });
  });

  it('throws a clear ENOTSUP error on non-darwin platforms', () => {
    withPlatform('linux', () => {
      expect(() => readClaudeCodeAccessToken()).toThrow(
        'Claude Code keychain access is only available on macOS (ENOTSUP)'
      );
    });
  });

  it('includes the actual platform name in the ENOTSUP error', () => {
    withPlatform('win32', () => {
      let caught: Error | undefined;
      try {
        readClaudeCodeAccessToken();
      } catch (e) {
        caught = e as Error;
      }
      expect(caught).toBeDefined();
      expect(caught!.message).toContain('win32');
    });
  });
});
