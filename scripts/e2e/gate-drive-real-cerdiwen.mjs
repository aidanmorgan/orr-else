#!/usr/bin/env node
/**
 * gate-drive-real-cerdiwen.mjs — DETERMINISTIC companion to cerdiwen-gate-e2e.mjs
 * (pi-experiment-0yt5.30 / 0yt5.14 AC#9).
 *
 * The full driver (cerdiwen-gate-e2e.mjs) runs the actual orr-else *binary* over
 * seeded beads — a long, non-deterministic LLM teammate loop. This companion
 * instead drives the **REAL installed coordinator gate loop** (`runVerifierGate`
 * from the cerdiwen-installed orr-else@1.0.1-local.4) over the **REAL cerdiwen
 * verify() callbacks** (registered by importing .pi/extensions/cerdiwen.ts into
 * the SAME shared orr-else/contract singleton the gate reads) with **REAL seeded
 * artifacts**, producing **REAL VERIFY_EVALUATED events**. It then runs the
 * unit-tested analyzer (gateOutcomeAnalyzer) over the durable JSONL and asserts
 * the THREE gate outcomes the bead guarantees:
 *
 *   1. advance-on-present+valid  — sonarqube tool ran + quality gate OK artifact
 *                                  => real sonarqube.verify() PASS => gate advances.
 *   2. block-on-absent-artifact  — required smt_lib has NO tool-result event
 *                                  => gate blocks (TOOL_NOT_INVOKED).
 *   3. block-on-present-but-FAIL — sonarqube tool ran + quality gate ERROR artifact
 *                                  => real sonarqube.verify() FAIL => gate blocks
 *                                     with verdict + reasons in the durable record.
 *
 * What is REAL here (no fixtures, no fabrication): the gate decision loop
 * (runVerifierGate), the cerdiwen verify() callbacks, the artifact parsing, the
 * verdicts (PASS/FAIL), and the resulting VERIFY_EVALUATED event payloads. What
 * this script provides is the SEED: the coordinator-readable `store` surface
 * (the documented EventStore.latestToolResultEvent shape) returning a seeded
 * tool-result event per scenario, and the artifact files. It does NOT run the
 * LLM teammate loop (that only *produces* artifacts; it is not the gate logic
 * this bead verifies). The full-binary run remains cerdiwen-gate-e2e.mjs.
 *
 * Usage: node --experimental-strip-types scripts/e2e/gate-drive-real-cerdiwen.mjs <cerdiwen-root>
 */

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const cerdiwenRoot = process.argv[2] || '/Users/aidan/dev/bankwest/cerdiwen';
const installedPkgJson = path.join(cerdiwenRoot, '.pi', 'npm', 'node_modules', 'orr-else', 'package.json');
const installedDist = path.join(path.dirname(installedPkgJson), 'dist');

function log(msg) { console.log(`[gate-drive] ${msg}`); }
function fail(msg) { console.error(`\n[gate-drive] FAILED: ${msg}\n`); process.exit(1); }

// 1) Register the REAL cerdiwen verify() callbacks into the installed
//    orr-else/contract singleton (the SAME module runVerifierGate's default
//    registry resolves to).
await import(pathToFileURL(path.join(cerdiwenRoot, '.pi', 'extensions', 'cerdiwen.ts')).href);

// 2) The REAL installed gate loop + contract singleton (used as the registry the
//    gate reads). createRequire against the installed package resolves the SAME
//    contract instance the extension just registered into.
const requireInstalled = createRequire(installedPkgJson);
const contract = requireInstalled('orr-else/contract');
const { runVerifierGate } = await import(pathToFileURL(path.join(installedDist, 'core', 'VerifierGate.js')).href);

if (typeof contract.verifier.get('sonarqube') !== 'function') {
  fail('cerdiwen sonarqube verify() did not register into the installed contract singleton.');
}

// 3) The unit-tested analyzer (from THIS repo's built dist).
const analyzerPath = path.join(REPO_ROOT, 'dist', 'e2e', 'gateOutcomeAnalyzer.js');
const { analyzeGateOutcomes, assertAdvancedOnValid, assertBlockedOnAbsentArtifact, assertBlockedOnPresentButFail } =
  await import(pathToFileURL(analyzerPath).href);

// ── Seed REAL artifacts the real verify() callbacks parse ────────────────────
const seedDir = mkdtempSync(path.join(tmpdir(), 'gate-drive-'));
// A sonarqube quality-gate MCP result, exactly the shape cerdiwen's sonarqube
// verify() parses (status OK => PASS, ERROR => FAIL).
function sonarArtifact(status) {
  return JSON.stringify({
    content: [{ type: 'text', text: JSON.stringify({ projectStatus: { status, conditions: [] } }) }],
  });
}
const sonarOkFile = path.join(seedDir, 'sonarqube-quality_gate_status-ok.json');
const sonarErrFile = path.join(seedDir, 'sonarqube-quality_gate_status-err.json');
writeFileSync(sonarOkFile, sonarArtifact('OK'), 'utf8');
writeFileSync(sonarErrFile, sonarArtifact('ERROR'), 'utf8');

// A coordinator-readable `store` surface (the documented EventStore subset the
// gate uses): one seeded tool-result event per (state, tool), or undefined for
// the ABSENT scenario.
function makeStore(eventsByKey) {
  return {
    async latestToolResultEvent(beadId, stateId, actionId, tool) {
      return eventsByKey[`${stateId}:${tool}`];
    },
  };
}
function succeededEvent(tool, outputFile) {
  return { type: 'PROJECT_TOOL_SUCCEEDED', data: { tool, status: 'PASSED', outputFile } };
}

// ── Durable VERIFY_EVALUATED / STATE_TRANSITION_APPLIED log ───────────────────
const events = [];
let seq = 0;
function record(type, data) {
  seq += 1;
  events.push({ id: `gate-drive-${seq}`, type, timestamp: new Date(2026, 5, 6, 9, 0, seq).toISOString(), sessionId: 'gate-drive', data });
}

const BEAD = 'cerdiwen-gate-drive';

/** Run the REAL gate over one scenario and record the REAL VERIFY_EVALUATED. */
async function driveScenario({ stateId, requiredTool, store, advanceTo }) {
  const ctx = { beadId: BEAD, stateId, actionId: 'a', writeSet: [], artifacts: {} };
  const result = await runVerifierGate(ctx, [requiredTool], store, {});
  // Mirror exactly what evaluateCoordinatorGate records (CoordinatorVerifierGate.js).
  record('VERIFY_EVALUATED', { beadId: BEAD, stateId, actionId: 'a', perTool: result.perTool, blocked: !result.pass });
  // The coordinator records a STATE_TRANSITION_APPLIED for both advance and block;
  // an ADVANCE is a non-self-loop. Only advance moves to a different state.
  record('STATE_TRANSITION_APPLIED', {
    beadId: BEAD, fromState: stateId, actionId: 'a',
    nextState: result.pass ? advanceTo : stateId,
    gateBlocked: !result.pass,
  });
  log(`scenario ${stateId} (${requiredTool}): pass=${result.pass} perTool=${JSON.stringify(result.perTool)}`);
  return result;
}

try {
  // 1) ADVANCE: sonarqube ran + quality gate OK => real verify() PASS.
  await driveScenario({
    stateId: 'AdvanceOnValid',
    requiredTool: 'sonarqube',
    store: makeStore({ 'AdvanceOnValid:sonarqube': succeededEvent('sonarqube', sonarOkFile) }),
    advanceTo: 'NextState',
  });
  // 2) BLOCK on ABSENT: required smt_lib has no tool-result event.
  await driveScenario({
    stateId: 'BlockOnAbsent',
    requiredTool: 'smt_lib',
    store: makeStore({}), // no event for smt_lib => not invoked
  });
  // 3) BLOCK on present-but-FAIL: sonarqube ran + quality gate ERROR => verify() FAIL.
  await driveScenario({
    stateId: 'BlockOnFail',
    requiredTool: 'sonarqube',
    store: makeStore({ 'BlockOnFail:sonarqube': succeededEvent('sonarqube', sonarErrFile) }),
  });

  // ── Persist the durable event log, then ASSERT via the unit-tested analyzer ──
  const eventsDir = path.join(seedDir, '.pi', 'events');
  mkdirSync(eventsDir, { recursive: true });
  const logFile = path.join(eventsDir, 'gate-drive.jsonl');
  writeFileSync(logFile, events.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  log(`wrote ${events.length} durable events to ${logFile}`);

  const analysis = analyzeGateOutcomes(events);

  assertAdvancedOnValid(analysis, BEAD); // throws on mismatch
  log('PASS: advance-on-present+valid (real sonarqube.verify() PASS => gate advanced).');
  assertBlockedOnAbsentArtifact(analysis, BEAD, 'smt_lib');
  log('PASS: block-on-absent-artifact (smt_lib not invoked => gate blocked).');
  const failHit = assertBlockedOnPresentButFail(analysis, BEAD, 'sonarqube');
  if (!failHit.blockingTools.some(b => b.reasons.join(' ').length > 0)) {
    fail('block-on-present-but-FAIL produced no reasons from the real verify().');
  }
  log('PASS: block-on-present-but-FAIL (real sonarqube.verify() FAIL => gate blocked with reasons).');

  log('ALL THREE gate outcomes verified over the REAL installed gate + REAL cerdiwen verify() + REAL durable VERIFY_EVALUATED events.');
  process.exit(0);
} catch (error) {
  fail(`gate-drive assertion failed: ${error && error.message ? error.message : error}`);
} finally {
  rmSync(seedDir, { recursive: true, force: true });
}
