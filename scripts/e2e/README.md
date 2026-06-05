# Dedicated cerdiwen gate e2e (pi-experiment-0yt5.30 / 0yt5.14 AC#9)

This is the **live acceptance run** for the marquee "cerdiwen gate works" guarantee.
It drives the **real** orr-else harness over two seeded cerdiwen beads and asserts
the **three durable coordinator-gate outcomes** against the event log:

1. **advance-on-present+valid** — a transition advances when its declared artifacts
   are present + valid (the *formalizable* bead: `smt_lib` artifact produced + checked).
2. **block-on-absent-artifact** — a transition BLOCKS when a required tool's artifact
   is ABSENT (the tool did-not-run; the `86j3` scenario).
3. **block-on-present-but-FAIL** — a transition BLOCKS when a present artifact FAILs
   validation (injected `sonarqube` quality-gate ERROR, `s3ss`), with the tool's
   `verdict` + `reasons` surfaced in the durable record.

The verifiable core (`analyzeGateOutcomes` + the assertion helpers) is fully
unit-tested in `tests/e2e_gate_outcome_analyzer.test.ts`. The live driver imports
that SAME code from the built `dist/e2e/gateOutcomeAnalyzer.js`, so the live run and
the unit proof share one implementation. **Assertions read the durable event log
(`{cerdiwenRoot}/.pi/events/*.jsonl`), not stdout** (AC3).

## This is a HUMAN step in a provisioned environment

The driver REQUIRES a provisioned environment and **fails fast (non-zero) on any
missing precondition before running anything** (AC2). It does NOT fabricate a green
run. It cannot be executed green in CI / a bare worktree because it needs:

- the **cerdiwen project checkout** (root via `--project-root` / `CERDIWEN_PROJECT_ROOT`)
  containing `harness.yaml`;
- the **SSE MCP backends** `codemap` + `sonarqube` started by cerdiwen's `.claude`
  **SessionStart hooks** (ups4). Their host:port is read from the cerdiwen
  `.pi/mcp/config.json` (`mcpServers.<name>.url`) — **ports are not hard-coded**;
  the run fails if a backend is DOWN or its url is still an un-substituted template;
- **LLM credentials** exported — one of `ANTHROPIC_API_KEY`, `ANTHROPIC_OAUTH_TOKEN`,
  `GEMINI_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `XAI_API_KEY`, `GROQ_API_KEY`;
- **three pre-seeded cerdiwen beads** (the operator provides the IDs — the script does
  NOT fabricate cerdiwen fixtures and fails fast if any ID is missing).

## Seeding contract (operator-provided beads)

Seed three representative cerdiwen beads and pass their IDs:

| Flag / env | What the bead must be |
| --- | --- |
| `--formalizable-bead` / `CERDIWEN_FORMALIZABLE_BEAD` | `formalizable` bead whose `smt_lib` artifact is **produced + valid**, so its gated transition **advances**. |
| `--absent-artifact-bead` / `CERDIWEN_ABSENT_ARTIFACT_BEAD` | bead whose required `smt_lib` artifact is **ABSENT** (the tool did-not-run), so the transition **blocks** (86j3 scenario). |
| `--quality-gate-bead` / `CERDIWEN_QUALITY_GATE_BEAD` | bead whose `sonarqube` quality gate is **ERROR**, so the present artifact **FAILs** validation and the transition **blocks** (s3ss). |

> A `formalizable:false` bead, by contrast, makes `smt_lib` verify() return
> `NOT_APPLICABLE` and must **advance** (it must NOT stall) — that is the corrective
> behaviour 86j3 fixed. Include such a bead in your seed set if you want to assert the
> NA path; the absent-artifact bead above asserts the *blocking* half.

## Build first

```bash
# in the orr-else repo
npx tsc            # emits dist/e2e/gateOutcomeAnalyzer.js (the tested core the driver imports)
```

## Run

```bash
export ANTHROPIC_API_KEY=...            # or another provider key

node scripts/e2e/cerdiwen-gate-e2e.mjs \
  --project-root /path/to/cerdiwen \
  --formalizable-bead   cerdiwen-XXXX \
  --absent-artifact-bead cerdiwen-YYYY \
  --quality-gate-bead   cerdiwen-ZZZZ
```

Equivalent env-var form:

```bash
export CERDIWEN_PROJECT_ROOT=/path/to/cerdiwen
export CERDIWEN_FORMALIZABLE_BEAD=cerdiwen-XXXX
export CERDIWEN_ABSENT_ARTIFACT_BEAD=cerdiwen-YYYY
export CERDIWEN_QUALITY_GATE_BEAD=cerdiwen-ZZZZ
node scripts/e2e/cerdiwen-gate-e2e.mjs
```

## Expected output

- On a missing precondition (no project root, backend DOWN, missing creds, missing seed
  bead): a single precise `PRECONDITION FAILED: ...` line and **exit 1**, with nothing run.
- On a successful provisioned run: per-bead `PASS:` lines for all three outcomes and a
  final `cerdiwen gate e2e GREEN.` with **exit 0**.
- On a provisioned run where an outcome does not hold: `LIVE ASSERTIONS FAILED:` with a
  per-assertion diff and the full durable analysis JSON, **exit 1**.

## Status of the acceptance criteria

- **AC1** (drives the real binary + asserts three event-log outcomes), **AC2** (SSE
  backend + creds + seed precondition fail-fast), **AC3** (assertions read the durable
  event log), **AC4** (this documented, repeatable invocation): authored as code here.
  The PRECONDITION fail-fast path and the tested analyzer core are verified in this repo.
- The actual **green live run** (driving real beads through real SSE backends with real
  LLM credentials) is the human step and must be executed in a provisioned cerdiwen
  environment. It is intentionally NOT run (and NOT faked) in CI / a bare worktree.
