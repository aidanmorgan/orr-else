import { execFileSync } from 'child_process';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { Logger } from '../core/Logger.js';
import { Component, ClaudeCodeAuth, LLMProviderName } from '../constants/index.js';

interface ClaudeCodeKeychainCredential {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}

/**
 * Read the live Claude Code OAuth access token from the macOS keychain. This
 * is the exact credential the Claude Code app uses; reading it on demand keeps
 * Pi in sync with the app's login (including its background token refresh)
 * without ever copying the token into Pi's auth.json.
 */
export function readClaudeCodeAccessToken(): string {
  let raw: string;
  try {
    raw = execFileSync('security', ['find-generic-password', '-s', ClaudeCodeAuth.KEYCHAIN_SERVICE, '-w'], {
      encoding: 'utf8'
    });
  } catch (error) {
    throw new Error(
      `Unable to read the live Claude Code login from the keychain (service "${ClaudeCodeAuth.KEYCHAIN_SERVICE}"). ` +
        `Sign in with the Claude Code app first. Cause: ${String(error)}`
    );
  }

  let credential: ClaudeCodeKeychainCredential | undefined;
  try {
    credential = (JSON.parse(raw) as { claudeAiOauth?: ClaudeCodeKeychainCredential }).claudeAiOauth;
  } catch (error) {
    throw new Error(`Claude Code keychain credential is not valid JSON. Cause: ${String(error)}`);
  }

  const token = credential?.accessToken;
  if (!token) {
    throw new Error('Claude Code keychain credential is missing claudeAiOauth.accessToken.');
  }
  return token;
}

/**
 * Override the Anthropic OAuth provider so Pi authenticates with the live
 * Claude Code login read from the keychain on every request. The returned
 * credentials are markers only — `getApiKey` ignores them and reads the live
 * token — so auth.json never holds a real token and Pi never rotates the
 * app's refresh token.
 */
export function registerClaudeCodeLiveLogin(pi: ExtensionAPI): void {
  if (typeof pi.registerProvider !== 'function') {
    Logger.warn(Component.ORR_ELSE, 'Pi does not expose registerProvider; skipping live Claude Code login override', {
      provider: LLMProviderName.ANTHROPIC
    });
    return;
  }

  const marker = {
    access: ClaudeCodeAuth.CREDENTIAL_MARKER,
    refresh: ClaudeCodeAuth.CREDENTIAL_MARKER,
    expires: ClaudeCodeAuth.MARKER_EXPIRES_MS
  };

  pi.registerProvider(LLMProviderName.ANTHROPIC, {
    oauth: {
      name: 'Claude Code (live login)',
      login: async () => {
        throw new Error(
          'Anthropic auth is delegated to the Claude Code app. Run `claude` to sign in; Orr Else reads that login live.'
        );
      },
      refreshToken: async () => marker,
      getApiKey: () => readClaudeCodeAccessToken()
    }
  });

  Logger.info(Component.ORR_ELSE, 'Registered Anthropic live Claude Code login override', {
    provider: LLMProviderName.ANTHROPIC,
    source: ClaudeCodeAuth.KEYCHAIN_SERVICE
  });
}
