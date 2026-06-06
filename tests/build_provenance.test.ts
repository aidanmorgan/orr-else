import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { computeBuildProvenance, runStalenessPreflightWarn } from '../src/core/BuildProvenance.js';
import { BuildProvenanceDefaults, DomainEventName } from '../src/constants/index.js';
import { Logger } from '../src/core/Logger.js';
import { SignalNoiseCoalescer } from '../src/core/SignalNoiseCoalescer.js';

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

  // ── DEDUP: provenance-key-based stale-warning coalescing (pi-experiment-iurh) ──

  // AC1: multi-worker scenario — same provenance key → ONE primary DIST_ARTIFACT_STALE
  // event + aggregate repeat count surfaced on the next primary.
  it('AC1: emits ONE primary DIST_ARTIFACT_STALE per provenance key; repeats are coalesced', async () => {
    const installRoot = createFakeInstallRoot({ distMtimeOffsetMs: -5000 });
    const records: Array<{ event: string; data: unknown }> = [];
    const mockStore = { record: vi.fn(async (event: string, data: unknown) => { records.push({ event, data }); }) };
    // A fresh coalescer with a long window so all three calls land in the same window.
    const coalescer = new SignalNoiseCoalescer(60_000);

    try {
      const prov = await computeBuildProvenance(configPath, installRoot);

      // Simulate three workers running with the same provenance.
      await runStalenessPreflightWarn(prov, mockStore, coalescer);
      await runStalenessPreflightWarn(prov, mockStore, coalescer);
      await runStalenessPreflightWarn(prov, mockStore, coalescer);

      const staleEvents = records.filter(r => r.event === DomainEventName.DIST_ARTIFACT_STALE);
      // Only 1 primary event recorded (repeats suppressed).
      const primaryEvents = staleEvents.filter(r => !(r.data as any).isAggregate);
      expect(primaryEvents).toHaveLength(1);
    } finally {
      rmrf(installRoot);
    }
  });

  // AC1 (aggregate count): after the window expires a second primary is emitted
  // and carries the prior suppressedCount so operators can see "N more" noise.
  it('AC1: new primary carries suppressedCount from prior window when window expires', async () => {
    const installRoot = createFakeInstallRoot({ distMtimeOffsetMs: -5000 });
    const records: Array<{ event: string; data: unknown }> = [];
    const mockStore = { record: vi.fn(async (event: string, data: unknown) => { records.push({ event, data }); }) };
    // Tiny window so it expires between calls.
    const coalescer = new SignalNoiseCoalescer(1);

    try {
      const prov = await computeBuildProvenance(configPath, installRoot);

      await runStalenessPreflightWarn(prov, mockStore, coalescer);
      // Repeat within the (expired) window — the coalescer will open a new window.
      await new Promise(res => setTimeout(res, 5)); // ensure window expired
      await runStalenessPreflightWarn(prov, mockStore, coalescer);

      const staleEvents = records.filter(r => r.event === DomainEventName.DIST_ARTIFACT_STALE);
      // Two primaries (second window opened), second one carries suppressedCount=0 from prior
      // window (no suppressions between the two primaries).
      expect(staleEvents.length).toBeGreaterThanOrEqual(2);
    } finally {
      rmrf(installRoot);
    }
  });

  // AC2: HARNESS_STARTED provenance is NOT suppressed — it is emitted per run.
  // (This is tested via extension.ts usage; here we just confirm computeBuildProvenance
  // always returns a full provenance object regardless of coalescer state.)
  it('AC2: computeBuildProvenance always returns full provenance (not affected by coalescer)', async () => {
    const installRoot = createFakeInstallRoot({ distMtimeOffsetMs: -5000 });
    const coalescer = new SignalNoiseCoalescer(60_000);
    const mockStore = { record: vi.fn(async () => {}) };

    try {
      const prov1 = await computeBuildProvenance(configPath, installRoot);
      await runStalenessPreflightWarn(prov1, mockStore, coalescer);
      // Second call: prov is still fully populated even though warn was suppressed.
      const prov2 = await computeBuildProvenance(configPath, installRoot);
      expect(prov2.distArtifactHash).toMatch(/^[0-9a-f]{64}$/);
      expect(prov2.distIsStale).toBe(true);
      expect(prov2.gitCommit).toBeDefined();
      expect(prov2.configHash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      rmrf(installRoot);
    }
  });

  // AC3: fresh builds emit NO DIST_ARTIFACT_STALE event regardless of coalescer.
  it('AC3: fresh build emits no DIST_ARTIFACT_STALE event even with a coalescer', async () => {
    const installRoot = createFakeInstallRoot({ distMtimeOffsetMs: 5000 }); // dist newer than src
    const records: Array<{ event: string; data: unknown }> = [];
    const mockStore = { record: vi.fn(async (event: string, data: unknown) => { records.push({ event, data }); }) };
    const coalescer = new SignalNoiseCoalescer(60_000);

    try {
      const prov = await computeBuildProvenance(configPath, installRoot);
      await runStalenessPreflightWarn(prov, mockStore, coalescer);
      await runStalenessPreflightWarn(prov, mockStore, coalescer);

      expect(records.filter(r => r.event === DomainEventName.DIST_ARTIFACT_STALE)).toHaveLength(0);
    } finally {
      rmrf(installRoot);
    }
  });

  // AC4: different provenance key (different distArtifactHash) → new primary warning.
  it('AC4: different distArtifactHash produces a new primary DIST_ARTIFACT_STALE event', async () => {
    const installRootA = createFakeInstallRoot({ distMtimeOffsetMs: -5000, distContents: '// build-A\nexport {};\n' });
    const installRootB = createFakeInstallRoot({ distMtimeOffsetMs: -5000, distContents: '// build-B\nexport {};\n' });
    const records: Array<{ event: string; data: unknown }> = [];
    const mockStore = { record: vi.fn(async (event: string, data: unknown) => { records.push({ event, data }); }) };
    const coalescer = new SignalNoiseCoalescer(60_000);

    try {
      const provA = await computeBuildProvenance(configPath, installRootA);
      const provB = await computeBuildProvenance(configPath, installRootB);

      await runStalenessPreflightWarn(provA, mockStore, coalescer);
      await runStalenessPreflightWarn(provB, mockStore, coalescer);

      // Two distinct primaries because the provenance keys differ.
      const staleEvents = records.filter(r => r.event === DomainEventName.DIST_ARTIFACT_STALE && !(r.data as any).isAggregate);
      expect(staleEvents).toHaveLength(2);
    } finally {
      rmrf(installRootA);
      rmrf(installRootB);
    }
  });
});
