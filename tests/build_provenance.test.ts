import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { computeBuildProvenance, runStalenessPreflightWarn } from '../src/core/BuildProvenance.js';
import { BuildProvenanceDefaults, DomainEventName } from '../src/constants/index.js';
import { Logger } from '../src/core/Logger.js';

// ---------------------------------------------------------------------------
// Helper: create a minimal fake install root on disk
// ---------------------------------------------------------------------------

function createFakeInstallRoot(options: {
  withPackageJson?: boolean;
  packageVersion?: string;
  withDistExtension?: boolean;
  distContents?: string;
  withSrc?: boolean;
  srcContent?: string;
  distMtimeOffsetMs?: number;   // positive = dist newer than src; negative = dist older
  withGit?: boolean;
}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-provenance-test-'));

  // package.json
  if (options.withPackageJson !== false) {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'orr-else', version: options.packageVersion ?? '1.2.3' })
    );
  }

  // src/example.ts — creates the src tree
  if (options.withSrc !== false) {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'src', 'example.ts'),
      options.srcContent ?? 'export const x = 1;\n'
    );
  }

  // dist/extension.js
  if (options.withDistExtension !== false) {
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'dist', 'extension.js'),
      options.distContents ?? '// compiled\nexport {};\n'
    );

    // Adjust dist mtime relative to src mtime if requested
    if (options.distMtimeOffsetMs !== undefined) {
      const srcStat = fs.statSync(path.join(root, 'src', 'example.ts'));
      const distMtime = new Date(srcStat.mtimeMs + options.distMtimeOffsetMs);
      fs.utimesSync(path.join(root, 'dist', 'extension.js'), distMtime, distMtime);
    }
  }

  return root;
}

function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BuildProvenance', () => {
  let tmpRoot: string;
  let configPath: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-config-'));
    configPath = path.join(tmpRoot, 'harness.yaml');
    fs.writeFileSync(configPath, 'settings:\n  maxConcurrentSlots: 1\n');
  });

  afterEach(() => {
    rmrf(tmpRoot);
    vi.restoreAllMocks();
  });

  // ── package version ────────────────────────────────────────────────────────

  it('reads packageVersion from package.json', async () => {
    const installRoot = createFakeInstallRoot({ withDistExtension: false, withSrc: false });
    try {
      const prov = await computeBuildProvenance(configPath, installRoot);
      expect(prov.packageVersion).toBe('1.2.3');
    } finally {
      rmrf(installRoot);
    }
  });

  it('returns "unknown" packageVersion when package.json is missing', async () => {
    const installRoot = createFakeInstallRoot({ withPackageJson: false, withDistExtension: false, withSrc: false });
    try {
      const prov = await computeBuildProvenance(configPath, installRoot);
      expect(prov.packageVersion).toBe(BuildProvenanceDefaults.UNKNOWN);
    } finally {
      rmrf(installRoot);
    }
  });

  // ── dist artifact ──────────────────────────────────────────────────────────

  it('computes distArtifactHash and distBuildTimestamp when dist/extension.js exists', async () => {
    const installRoot = createFakeInstallRoot({ withSrc: false });
    try {
      const prov = await computeBuildProvenance(configPath, installRoot);
      expect(prov.distArtifactHash).toMatch(/^[0-9a-f]{64}$/);
      expect(prov.distBuildTimestamp).toBeDefined();
      // Must be a parseable ISO timestamp
      expect(Number.isNaN(new Date(prov.distBuildTimestamp!).getTime())).toBe(false);
    } finally {
      rmrf(installRoot);
    }
  });

  it('yields "unknown" distArtifactHash and undefined distBuildTimestamp when dist is missing', async () => {
    const installRoot = createFakeInstallRoot({ withDistExtension: false, withSrc: false });
    try {
      const prov = await computeBuildProvenance(configPath, installRoot);
      expect(prov.distArtifactHash).toBe(BuildProvenanceDefaults.UNKNOWN);
      expect(prov.distBuildTimestamp).toBeUndefined();
    } finally {
      rmrf(installRoot);
    }
  });

  // ── config hash ───────────────────────────────────────────────────────────

  it('hashes the config file', async () => {
    const installRoot = createFakeInstallRoot({ withDistExtension: false, withSrc: false });
    try {
      const prov = await computeBuildProvenance(configPath, installRoot);
      expect(prov.configPath).toBe(configPath);
      expect(prov.configHash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      rmrf(installRoot);
    }
  });

  it('returns "unknown" configHash when config file is missing', async () => {
    const installRoot = createFakeInstallRoot({ withDistExtension: false, withSrc: false });
    try {
      const prov = await computeBuildProvenance('/nonexistent/harness.yaml', installRoot);
      expect(prov.configHash).toBe(BuildProvenanceDefaults.UNKNOWN);
    } finally {
      rmrf(installRoot);
    }
  });

  // ── FRESH: dist newer than src → no stale warning ────────────────────────

  it('reports distIsStale=false when dist is newer than src', async () => {
    const installRoot = createFakeInstallRoot({ distMtimeOffsetMs: 5000 }); // dist 5 s newer
    try {
      const prov = await computeBuildProvenance(configPath, installRoot);
      expect(prov.distIsStale).toBe(false);
    } finally {
      rmrf(installRoot);
    }
  });

  it('does not emit a warn or staleness event when dist is fresh', async () => {
    const installRoot = createFakeInstallRoot({ distMtimeOffsetMs: 5000 });
    const warnSpy = vi.spyOn(Logger, 'warn');
    const records: Array<{ event: string; data: unknown }> = [];
    const mockStore = { record: vi.fn(async (event: string, data: unknown) => { records.push({ event, data }); }) };

    try {
      const prov = await computeBuildProvenance(configPath, installRoot);
      await runStalenessPreflightWarn(prov, mockStore);

      const stalenessWarnCalls = warnSpy.mock.calls.filter(([, msg]) => String(msg).includes('STALE') || String(msg).includes('MISSING'));
      expect(stalenessWarnCalls).toHaveLength(0);
      expect(records.some(r => r.event === DomainEventName.DIST_ARTIFACT_STALE)).toBe(false);
    } finally {
      rmrf(installRoot);
      vi.restoreAllMocks();
    }
  });

  // ── STALE: dist older than src → warning emitted ─────────────────────────

  it('reports distIsStale=true when dist is older than src', async () => {
    const installRoot = createFakeInstallRoot({ distMtimeOffsetMs: -5000 }); // dist 5 s older
    try {
      const prov = await computeBuildProvenance(configPath, installRoot);
      expect(prov.distIsStale).toBe(true);
    } finally {
      rmrf(installRoot);
    }
  });

  it('emits a LOUD Logger.warn and DIST_ARTIFACT_STALE event when dist is stale', async () => {
    const installRoot = createFakeInstallRoot({ distMtimeOffsetMs: -5000 });
    const warnSpy = vi.spyOn(Logger, 'warn');
    const records: Array<{ event: string; data: unknown }> = [];
    const mockStore = { record: vi.fn(async (event: string, data: unknown) => { records.push({ event, data }); }) };

    try {
      const prov = await computeBuildProvenance(configPath, installRoot);
      await runStalenessPreflightWarn(prov, mockStore);

      const stalenessWarnCalls = warnSpy.mock.calls.filter(([, msg]) => String(msg).includes('STALE'));
      expect(stalenessWarnCalls.length).toBeGreaterThan(0);
      expect(records.some(r => r.event === DomainEventName.DIST_ARTIFACT_STALE && (r.data as any).reason === 'dist-older-than-src')).toBe(true);
    } finally {
      rmrf(installRoot);
      vi.restoreAllMocks();
    }
  });

  it('emits a LOUD Logger.warn and DIST_ARTIFACT_STALE event when dist is missing', async () => {
    const installRoot = createFakeInstallRoot({ withDistExtension: false });
    const warnSpy = vi.spyOn(Logger, 'warn');
    const records: Array<{ event: string; data: unknown }> = [];
    const mockStore = { record: vi.fn(async (event: string, data: unknown) => { records.push({ event, data }); }) };

    try {
      const prov = await computeBuildProvenance(configPath, installRoot);
      await runStalenessPreflightWarn(prov, mockStore);

      const stalenessWarnCalls = warnSpy.mock.calls.filter(([, msg]) => String(msg).includes('MISSING'));
      expect(stalenessWarnCalls.length).toBeGreaterThan(0);
      expect(records.some(r => r.event === DomainEventName.DIST_ARTIFACT_STALE && (r.data as any).reason === 'dist-missing')).toBe(true);
    } finally {
      rmrf(installRoot);
      vi.restoreAllMocks();
    }
  });

  // ── best-effort: failures do not throw ────────────────────────────────────

  it('is best-effort: computeBuildProvenance never throws even on a bare directory', async () => {
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-empty-'));
    try {
      // Should resolve (not reject), all fields degrade gracefully
      const prov = await computeBuildProvenance('/no/such/config.yaml', emptyRoot);
      expect(prov.packageVersion).toBe(BuildProvenanceDefaults.UNKNOWN);
      expect(prov.distArtifactHash).toBe(BuildProvenanceDefaults.UNKNOWN);
      expect(prov.distBuildTimestamp).toBeUndefined();
      expect(prov.configHash).toBe(BuildProvenanceDefaults.UNKNOWN);
      expect(prov.gitCommit).toBe(BuildProvenanceDefaults.UNKNOWN);
      // distIsStale should be undefined (can't determine without dist)
      expect(prov.distIsStale).toBeUndefined();
    } finally {
      rmrf(emptyRoot);
    }
  });

  it('is best-effort: runStalenessPreflightWarn never throws when eventStore.record rejects', async () => {
    const installRoot = createFakeInstallRoot({ distMtimeOffsetMs: -5000 });
    const brokenStore = {
      record: vi.fn(async () => { throw new Error('store unavailable'); })
    };
    try {
      const prov = await computeBuildProvenance(configPath, installRoot);
      // Must not throw
      await expect(runStalenessPreflightWarn(prov, brokenStore)).resolves.toBeUndefined();
    } finally {
      rmrf(installRoot);
    }
  });

  it('is best-effort: runStalenessPreflightWarn works without an eventStore', async () => {
    const installRoot = createFakeInstallRoot({ distMtimeOffsetMs: -5000 });
    try {
      const prov = await computeBuildProvenance(configPath, installRoot);
      // Must not throw even with no store
      await expect(runStalenessPreflightWarn(prov)).resolves.toBeUndefined();
    } finally {
      rmrf(installRoot);
    }
  });

  // ── provenance fields populated in startup event ──────────────────────────

  it('provenance fields are all present in a standard fresh build scenario', async () => {
    const installRoot = createFakeInstallRoot({ distMtimeOffsetMs: 5000 });
    try {
      const prov = await computeBuildProvenance(configPath, installRoot);
      // packageVersion
      expect(prov.packageVersion).toBe('1.2.3');
      // distArtifactHash: sha256 hex
      expect(prov.distArtifactHash).toMatch(/^[0-9a-f]{64}$/);
      // distBuildTimestamp: ISO string
      expect(typeof prov.distBuildTimestamp).toBe('string');
      // configPath and configHash
      expect(prov.configPath).toBe(configPath);
      expect(prov.configHash).toMatch(/^[0-9a-f]{64}$/);
      // gitCommit: either a sha or 'unknown' (in CI / bare test dirs it will be unknown)
      expect(typeof prov.gitCommit).toBe('string');
      expect(prov.gitCommit.length).toBeGreaterThan(0);
      // distIsStale: boolean when dist present
      expect(typeof prov.distIsStale).toBe('boolean');
    } finally {
      rmrf(installRoot);
    }
  });
});
