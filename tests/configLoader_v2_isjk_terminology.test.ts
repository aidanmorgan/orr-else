/**
 * configLoader_v2_isjk_terminology.test.ts
 *
 * pi-experiment-isjk: v2 public schema generic framework terminology.
 *
 * AC1: v2 public schema and diagnostics use generic framework terminology
 *      (state, worker, action, event, artifact, verifier, gate) — not role names.
 * AC2: Old public field names are rejected without aliasing in v2 configs:
 *      - runtime.teammates → rejected, hint: use runtime.workers
 * AC3: v2 built-in tool descriptions are workflow-neutral (state/action/evidence
 *      language; no planner/implementer/reviewer/teammate as framework defaults).
 * AC5: Static scan — schema file and tool registration strings contain no
 *      banned public-field role names in v2 sections; legacy sections allowlisted.
 *
 * Scenario coverage:
 *   S1: v2 config with runtime.teammates → rejected with hint to use runtime.workers.
 *   S2: v2 config with runtime.workers → admitted (generic replacement accepted).
 *   S3: v1 config with runtime.teammates is NOT rejected (v2-only gate).
 *   S4: Static scan — harness.schema.json runtime.properties has "workers" not "teammates".
 *   S5: Static scan — v2 schema field names contain no banned public-field role names.
 *   S6: Tool descriptions for send_mailbox_message / check_mailbox use generic
 *      framework language, not "Team Lead" / "teammate" as framework defaults.
 *   S7: spawn tool description uses generic "state worker" language.
 *   S8: Comprehensive full-surface scan — ALL harness.schema.json descriptions and
 *      ALL registered v2 tool/param descriptions contain no banned role terms.
 *      Load-bearing: reads real source files; not a hand-list.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { createMailboxPlugin } from '../src/plugins/mailbox.js';
import { EventStore } from '../src/core/EventStore.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_DIR = fs.mkdtempSync(path.join(process.env['TMPDIR'] ?? '/tmp', 'orr-else-isjk-'));

function writeYaml(name: string, content: string): string {
  const p = path.join(TEST_DIR, name);
  fs.writeFileSync(p, content);
  return p;
}

afterEach(() => {
  for (const f of fs.readdirSync(TEST_DIR)) {
    const full = path.join(TEST_DIR, f);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      fs.rmSync(full, { recursive: true, force: true });
    } else {
      fs.unlinkSync(full);
    }
  }
});

// ---------------------------------------------------------------------------
// Shared minimal v2 base fixture.
// ---------------------------------------------------------------------------
const MINIMAL_V2_BASE = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test handover"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: Implement
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
states:
  Implement:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "Implement the task."
    actions:
      run_impl:
        type: prompt
        prompt: "Implement."
    transitions:
      SUCCESS: completed
      FAILURE: Implement
`;

// ---------------------------------------------------------------------------
// S1: runtime.teammates rejected in v2 with hint to use runtime.workers (AC2)
// ---------------------------------------------------------------------------
describe('pi-experiment-isjk AC2: runtime.teammates rejected in v2 — no alias', () => {
  it('S1: v2 config with runtime.teammates → rejected, diagnostic names runtime.workers replacement', () => {
    const yaml = MINIMAL_V2_BASE + `
runtime:
  teammates: 4
`;
    const p = writeYaml('s1_runtime_teammates.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    let err: Error | undefined;
    try { loader.load(p); } catch (e) { err = e as Error; }

    expect(err).toBeDefined();
    // Must name the stale field
    expect(err!.message).toMatch(/runtime\.teammates/);
    // Must name the v2 replacement
    expect(err!.message).toMatch(/runtime\.workers/);
    // Must not alias — config must not load
    // (the throw itself is the proof of no aliasing)
  });
});

// ---------------------------------------------------------------------------
// S2: runtime.workers admitted in v2 (generic replacement accepted) (AC1)
// ---------------------------------------------------------------------------
describe('pi-experiment-isjk AC1: runtime.workers admitted in v2', () => {
  it('S2: v2 config with runtime.workers: 4 loads without error', () => {
    const yaml = MINIMAL_V2_BASE + `
runtime:
  workers: 4
`;
    const p = writeYaml('s2_runtime_workers.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    let config: ReturnType<typeof loader.load> | undefined;
    expect(() => { config = loader.load(p); }).not.toThrow();
    expect(config).toBeDefined();
    expect(config!.version).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// S3: v1 config with runtime.teammates is NOT rejected (v2-only gate) (AC1)
// ---------------------------------------------------------------------------
describe('pi-experiment-isjk VERSION GATE: v1 config with runtime.teammates is unaffected', () => {
  it('S3: v1 config (no version field) with runtime.teammates loads without error', () => {
    // v1 configs must remain fully unaffected by v2 public terminology changes.
    const yaml = `
settings:
  startState: Planning
  worktreePolicy:
    default: always
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
runtime:
  teammates: 3
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan."
    actions:
      - id: plan
        type: prompt
    transitions: { SUCCESS: completed, FAILURE: Planning }
`;
    const p = writeYaml('s3_v1_teammates.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    expect(() => loader.load(p)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// S4 + S5: Static scan — schema file uses generic terminology in v2 sections (AC1 / AC5)
// ---------------------------------------------------------------------------
describe('pi-experiment-isjk AC1/AC5: static scan — harness.schema.json v2 runtime uses generic field names', () => {
  it('S4: harness.schema.json runtime.properties contains "workers" not "teammates"', () => {
    const schemaPath = path.resolve('harness.schema.json');
    const schemaRaw = fs.readFileSync(schemaPath, 'utf8');
    const schema = JSON.parse(schemaRaw) as Record<string, unknown>;

    // The v2 runtime block must expose "workers", not "teammates"
    const runtimeBlock = (schema['properties'] as Record<string, unknown>)['runtime'] as Record<string, unknown>;
    expect(runtimeBlock).toBeDefined();
    const runtimeProps = (runtimeBlock['properties'] as Record<string, unknown>) ?? {};
    expect(Object.keys(runtimeProps)).toContain('workers');
    expect(Object.keys(runtimeProps)).not.toContain('teammates');
  });

  it('S5: harness.schema.json runtime block description does not use "teammates" as a public field name concept', () => {
    const schemaPath = path.resolve('harness.schema.json');
    const schemaRaw = fs.readFileSync(schemaPath, 'utf8');
    const schema = JSON.parse(schemaRaw) as Record<string, unknown>;

    const runtimeBlock = (schema['properties'] as Record<string, unknown>)['runtime'] as Record<string, unknown>;
    const runtimeDesc = (runtimeBlock['description'] as string) ?? '';
    // The description must NOT say "teammates" as the admitted field name concept.
    // It may mention "workers" (generic replacement).
    expect(runtimeDesc).not.toMatch(/Only teammates \(numeric concurrency\)/);
    expect(runtimeDesc).toMatch(/workers/i);
  });
});

// ---------------------------------------------------------------------------
// S6: Tool descriptions for mailbox tools use generic framework language (AC3)
// ---------------------------------------------------------------------------
describe('pi-experiment-isjk AC3: mailbox tool descriptions use generic framework language', () => {
  it('S6a: send_mailbox_message description does not mention "Team Lead" or "teammate" as framework defaults', () => {
    // Create a minimal EventStore stub for plugin instantiation
    const plugin = createMailboxPlugin({ record: async () => {} } as unknown as EventStore, TEST_DIR);
    const sendTool = plugin.tools.find(t => t.name === 'send_mailbox_message');
    expect(sendTool).toBeDefined();
    const desc = sendTool!.description ?? '';
    // Must not hard-code role names as framework defaults in the description
    expect(desc).not.toMatch(/\bteam lead\b/i);
    expect(desc).not.toMatch(/\bteammate\b/i);
    // Must use generic language
    expect(desc).toMatch(/\bworker\b|\bcoordinator\b/i);
  });

  it('S6b: check_mailbox recipient description does not use "TeamLead" as a model-facing example default', () => {
    const plugin = createMailboxPlugin({ record: async () => {} } as unknown as EventStore, TEST_DIR);
    const checkTool = plugin.tools.find(t => t.name === 'check_mailbox');
    expect(checkTool).toBeDefined();
    // Inspect the parameters schema for the recipient field description
    const recipientProp = (checkTool!.parameters as { properties?: Record<string, { description?: string }> })?.properties?.['recipient'];
    const recipientDesc = recipientProp?.description ?? '';
    // Must not expose 'TeamLead' as a hard-coded framework role example
    expect(recipientDesc).not.toMatch(/TeamLead/);
  });
});

// ---------------------------------------------------------------------------
// S7: spawn tool description uses generic "state worker" language (AC3)
// ---------------------------------------------------------------------------
describe('pi-experiment-isjk AC3: spawn_teammate tool description uses generic framework language', () => {
  it('S7: spawn_teammate tool description in src/plugins/teammates.ts contains no banned role terms', () => {
    // Read the actual source file that owns the spawn_teammate registration.
    // This is load-bearing: if a banned term is injected into the description
    // in that file, this assertion will fail.
    const teammatesSource = fs.readFileSync(
      path.resolve('src/plugins/teammates.ts'),
      'utf8'
    );
    // Extract the description string for the spawn_teammate tool block.
    // The tool is registered as: { name: PluginToolName.SPAWN_TEAMMATE, description: '...' }
    // Assert none of the banned role terms appear as description values.
    const bannedPatterns = [
      /\bteammate\b/i,
      /\bteam\s*lead\b/i,
      /\bteamLead\b/,
      /\bplanner\b/i,
      /\bimplementer\b/i,
      /\breviewer\b/i,
      /\bsdlc\b/i,
    ];

    // Extract all description: '...' and description: "..." string literals
    // from the tool registration block in teammates.ts.
    const descMatches = [...teammatesSource.matchAll(/description:\s*['"`]([^'"`]+)['"`]/g)];
    expect(descMatches.length).toBeGreaterThan(0); // sanity: file has descriptions

    const failures: string[] = [];
    for (const match of descMatches) {
      const desc = match[1];
      for (const pattern of bannedPatterns) {
        if (pattern.test(desc)) {
          failures.push(`Banned term matched by ${pattern} in description: "${desc}"`);
        }
      }
    }
    expect(failures, failures.join('\n')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// S8: Comprehensive full-surface scan — ALL v2-admitted schema descriptions
// and ALL registered v2 tool/param descriptions (AC1 / AC3 / AC5)
//
// SURFACE 1: harness.schema.json — walk every "description" field in the
//   parsed JSON. Allowlist only fields that are explicitly rejected in v2
//   (currently none have a description string with a banned term after fixes).
//
// SURFACE 2: plugin source files + extension.ts — extract every description:
//   string literal from the tool/param registration source. This is load-bearing:
//   the files are read at test time, so injecting a banned term into any
//   description: string in these files will cause the test to fail.
//
// NOT scanned: bare `agent` — Pi platform legitimately uses "agent"/"subagent"
//   as platform nouns; banning bare `agent` produces false positives.
// ---------------------------------------------------------------------------
describe('pi-experiment-isjk AC1/AC3/AC5: comprehensive banned-term scan — v2 schema + all registered tool descriptions', () => {
  /**
   * Banned role-term patterns for the v2 public surface.
   * "agent" is intentionally excluded — Pi platform uses it as a platform noun.
   */
  const BANNED_PATTERNS: Array<{ label: string; re: RegExp }> = [
    { label: 'teammate', re: /\bteammate\b/i },
    { label: 'team lead / Team Lead / teamLead / team-lead', re: /\bteam[\s-]?lead\b/i },
    { label: 'teamLead (camelCase)', re: /\bteamLead\b/ },
    { label: 'planner', re: /\bplanner\b/i },
    { label: 'implementer', re: /\bimplementer\b/i },
    { label: 'reviewer', re: /\breviewer\b/i },
    { label: 'sdlc', re: /\bsdlc\b/i },
  ];

  function findBannedInString(text: string): string[] {
    return BANNED_PATTERNS.filter(({ re }) => re.test(text)).map(({ label }) => label);
  }

  // ── SURFACE 1: harness.schema.json description fields ───────────────────

  it('S8a: harness.schema.json — all "description" field values contain no banned role terms', () => {
    const schemaPath = path.resolve('harness.schema.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as unknown;

    /**
     * Walk the JSON tree and collect (jsonPath, descriptionValue) pairs.
     * We scan EVERY description string in the schema rather than trying to
     * enumerate which fields are v2-admitted — it's safer to fix every
     * survivor than to build a complex v2-admission predicate.
     *
     * Allowlist: fields whose description legitimately uses a banned term as
     * a LABEL (not a framework concept). Currently empty — all survivors in
     * the v2-admitted surface must be fixed rather than allowlisted.
     */
    const SCHEMA_ALLOWLIST = new Set<string>([
      // Example (currently unneeded):
      // 'properties.settings.properties.legacyMigrationNote'
    ]);

    const violations: string[] = [];

    function walkSchema(node: unknown, jsonPath: string): void {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach((child, i) => walkSchema(child, `${jsonPath}[${i}]`));
        return;
      }
      const obj = node as Record<string, unknown>;
      if (typeof obj['description'] === 'string') {
        const descPath = jsonPath;
        if (!SCHEMA_ALLOWLIST.has(descPath)) {
          const hits = findBannedInString(obj['description']);
          if (hits.length > 0) {
            violations.push(
              `harness.schema.json @ ${descPath}: banned terms [${hits.join(', ')}] in description: "${obj['description']}"`
            );
          }
        }
      }
      for (const [key, value] of Object.entries(obj)) {
        walkSchema(value, jsonPath ? `${jsonPath}.${key}` : key);
      }
    }

    walkSchema(schema, '');
    expect(violations, `Banned role terms in schema descriptions:\n${violations.join('\n')}`).toHaveLength(0);
  });

  // ── SURFACE 2: registered v2 tool/param description strings ─────────────

  it('S8b: registered v2 tool/param descriptions in plugin source files contain no banned role terms', () => {
    /**
     * Files that own model-facing tool + param description: string literals
     * registered via pi.registerTool or RuntimePlugin.tools[].
     *
     * These are read at test time — not hand-listed tool names — so any
     * injected banned term in a description: value will be caught.
     *
     * projectTools.ts is included for its inline description: literals
     * (commandArgumentDescription, CWD description, MCP parameter descriptions).
     */
    const PLUGIN_SOURCE_FILES = [
      'src/plugins/bd.ts',
      'src/plugins/mailbox.ts',
      'src/plugins/teammates.ts',
      'src/plugins/quality.ts',
      'src/plugins/meta.ts',
      'src/plugins/git.ts',
      'src/plugins/signaling.ts',
      'src/plugins/projectTools.ts',
    ].map(f => path.resolve(f));

    /**
     * extension.ts hosts tool registrations for built-in tools registered
     * directly via pi.registerTool(). It is included in the scan.
     */
    const EXTENSION_SOURCE = path.resolve('src/extension.ts');

    const allSourceFiles = [...PLUGIN_SOURCE_FILES, EXTENSION_SOURCE];

    /**
     * Regex to extract the string literal value from description: '...' or
     * description: "..." or description: `...` patterns.
     * Multi-line template literals are handled by a separate pass.
     * Single/double-quoted strings are extracted with a simple non-greedy match
     * (handles most cases; multi-line strings use template literals).
     */
    const DESC_SINGLE_RE = /description:\s*'([^'\\]|\\.)*'/g;
    const DESC_DOUBLE_RE = /description:\s*"([^"\\]|\\.)*"/g;
    const DESC_TEMPLATE_RE = /description:\s*`([^`\\]|\\.)*`/gs;

    const violations: string[] = [];

    for (const filePath of allSourceFiles) {
      const src = fs.readFileSync(filePath, 'utf8');
      const relPath = path.relative(path.resolve('.'), filePath);

      // Collect all description: string matches from all quote styles
      const allMatches: string[] = [];

      for (const re of [DESC_SINGLE_RE, DESC_DOUBLE_RE, DESC_TEMPLATE_RE]) {
        re.lastIndex = 0;
        for (const match of src.matchAll(re)) {
          // Strip the leading `description:` prefix and quotes
          const raw = match[0];
          const valueStart = raw.indexOf(':') + 1;
          const valueRaw = raw.slice(valueStart).trim();
          // Remove surrounding quote characters (', ", `)
          const inner = valueRaw.slice(1, valueRaw.endsWith('`') ? -1 : -1);
          allMatches.push(inner);
        }
      }

      for (const descValue of allMatches) {
        const hits = findBannedInString(descValue);
        if (hits.length > 0) {
          violations.push(
            `${relPath}: banned terms [${hits.join(', ')}] in description: "${descValue.slice(0, 120)}"`
          );
        }
      }
    }

    /**
     * projectTools/constants.ts owns the harness-side model-facing text constants
     * PROJECT_TOOL_MODEL_CONTRACT (string[]) and PROJECT_TOOL_DESCRIPTION_SUFFIX
     * (string). These are bare `export const` declarations — not description: keys —
     * so they are scanned separately by extracting all string literals from the file.
     *
     * Any future banned term injected into these constants will be caught here.
     */
    const constantsPath = path.resolve('src/plugins/projectTools/constants.ts');
    const constantsSrc = fs.readFileSync(constantsPath, 'utf8');
    const constantsRel = path.relative(path.resolve('.'), constantsPath);

    // Extract every single-quoted, double-quoted, and template string literal from
    // the file. This is intentionally broad for a pure-constants file: every string
    // in this file is either model-facing text or an internal key/pattern, and the
    // banned terms must not appear in any of them.
    const CONST_SINGLE_RE = /'([^'\\]|\\.)*'/g;
    const CONST_DOUBLE_RE = /"([^"\\]|\\.)*"/g;
    const CONST_TEMPLATE_RE = /`([^`\\]|\\.)*`/gs;

    for (const re of [CONST_SINGLE_RE, CONST_DOUBLE_RE, CONST_TEMPLATE_RE]) {
      re.lastIndex = 0;
      for (const match of constantsSrc.matchAll(re)) {
        // Strip surrounding quote characters
        const inner = match[0].slice(1, -1);
        const hits = findBannedInString(inner);
        if (hits.length > 0) {
          violations.push(
            `${constantsRel}: banned terms [${hits.join(', ')}] in string literal: "${inner.slice(0, 120)}"`
          );
        }
      }
    }

    expect(violations, `Banned role terms in registered tool descriptions:\n${violations.join('\n')}`).toHaveLength(0);
  });
});
