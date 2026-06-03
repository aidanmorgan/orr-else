# Raw-Output Obsolete-Term Audit

**Produced for**: pi-experiment-s3wp.29 (criterion 4 — before/after grep-count report)
**Audit date**: 2026-06-03
**Scope**: Orr-Else generic harness `.pi/` prompts/skills/docs (this repo) and
Cerdiwen project `.pi/` prompts/skills/rules/project-tools.

---

## Audited Terms

The following terms are the obsolete bounded-preview / byte-budget identifiers
named in the acceptance criteria:

`resultPreview`, `diagnosticPreview`, `outputPreview`, `outputArchive`,
`inlineResultBytes`, `outputLimit`, `bounded preview`, `byte budget`,
`stdoutTruncated`, `stderrTruncated`, `*Truncated` (generic), `*Preview` (generic)

---

## After-State Counts (current production guidance)

### Orr-Else `.pi/skills/` and `.pi/prompts/`

| Term | Count | Category |
|---|---|---|
| `resultPreview` | 4 | Forbidden-list / negative-assertion |
| `diagnosticPreview` | 1 | Forbidden-list / negative-assertion |
| `outputPreview` | 1 | Forbidden-list / negative-assertion |
| `outputArchive` | 4 | Forbidden-list / negative-assertion |
| `inlineResultBytes` | 1 | Forbidden-list / negative-assertion |
| `outputLimit` | 0 | — |
| `bounded preview` | 0 | — |
| `byte budget` | 0 | — |
| `stdoutTruncated` | 1 | Forbidden-list / negative-assertion |
| `stderrTruncated` | 1 | Forbidden-list / negative-assertion |

All occurrences are in the **Forbidden interpretation patterns** sections of
`tool-routing/SKILL.md`, `reviewer/SKILL.md`, and `artifact-evidence/SKILL.md`.
Every occurrence explicitly states the term is **not** present in tool schemas
and must **not** be relied upon. Zero occurrences instruct agents to rely on
these terms as production-guidance tool behavior.

Exact locations:

- `.pi/skills/tool-routing/SKILL.md:10` — `resultPreview`, `outputArchive`
  (negative assertion: "There is no universal…")
- `.pi/skills/tool-routing/SKILL.md:18` — `resultPreview`, `diagnosticPreview`,
  `outputPreview` (forbidden-list bullet)
- `.pi/skills/tool-routing/SKILL.md:20` — `outputArchive` (forbidden-list bullet)
- `.pi/skills/tool-routing/SKILL.md:22` — `stdoutTruncated`, `stderrTruncated`
  (forbidden-list bullet)
- `.pi/skills/tool-routing/SKILL.md:24` — `inlineResultBytes` (forbidden-list bullet)
- `.pi/skills/artifact-evidence/SKILL.md:8` — `resultPreview`, `outputArchive`
  (negative assertion: "There is no…")
- `.pi/skills/reviewer/SKILL.md:9` — `resultPreview`, `outputArchive`
  (negative assertion: "There is no universal…")

### Orr-Else `docs/`

| Term | Count | Category |
|---|---|---|
| `resultPreview` | 1 | Forbidden-list table row |
| `diagnosticPreview` | 1 | Forbidden-list table row |
| `outputPreview` | 1 | Forbidden-list table row |
| `outputArchive` | 1 | Forbidden-list table row |
| `inlineResultBytes` | 1 | Forbidden-list table row |
| `outputLimit` | 1 | Forbidden-list table row |
| `bounded preview` | 0 | — |
| `byte budget` | 0 | — |
| `stdoutTruncated` | 1 | Forbidden-list table row |
| `stderrTruncated` | 1 | Forbidden-list table row |

All occurrences are in `docs/raw-output-contract.md`, the **Forbidden Generic
Output-Control Mechanisms** table. Each row records a forbidden identifier and
its origin — they exist to prohibit the terms, not to instruct their use.

### Cerdiwen `.pi/skills/` and `.pi/prompts/` and `.pi/rules/`

| Term | Count | Category |
|---|---|---|
| `resultPreview` | 0 | — |
| `diagnosticPreview` | 0 | — |
| `outputPreview` | 0 | — |
| `outputArchive` | 0 | — |
| `inlineResultBytes` | 0 | — |
| `outputLimit` | 0 | — |
| `bounded preview` | 0 | — |
| `byte budget` | 0 | — |
| `stdoutTruncated` | 0 | — |
| `stderrTruncated` | 0 | — |

Zero occurrences across all cerdiwen guidance docs (skills, prompts, rules).

### Cerdiwen `.pi/project-tools/` (non-test files)

| Term | Count | Category |
|---|---|---|
| `resultPreview` | 0 | — |
| `diagnosticPreview` | 0 | — |
| `outputPreview` | 0 | — |
| `outputArchive` | 0 | — |
| `inlineResultBytes` | 0 | — |
| `outputLimit` | 0 | — |
| `stdoutTruncated` | 0 | — |
| `stderrTruncated` | 0 | — |
| `excerptTruncated` | 1 | Obsolete-marking comment — `coding_standards.ts:708` |

The single `excerptTruncated` mention in `coding_standards.ts:708` is a source
comment explicitly marking the field as **forbidden** by s3wp.28 raw-output
policy. It is an obsolete-marking comment, not production guidance instructing
reliance on the field.

### Cerdiwen `.pi/project-tools/` (test files)

Test files contain negative-assertion uses of obsolete terms (e.g.
`assert.ok(!("resultPreview" in payload), "…")`) which prove the fields are
**absent** from tool schemas. These are correct guardrail tests and are
categorized as negative assertions. No violations found.

---

## "Before" State

The true "before" state predates this audit. The policy was adopted via
pi-experiment-s3wp.23 (raw-output contract) and implemented in s3wp.24–s3wp.28.
This report captures the **after** state following all those beads, confirming
the policy is fully applied. A representative before-state can be inferred from
the Superseded Framing section of `docs/raw-output-contract.md`, which records
the removed identifiers (`RtkArchiveStrategy`, `byteBudget`, `resultPreview` as
a required-for-all key, etc.) and the beads that removed them.

---

## Conclusion: No Production-Guidance Violations

Every remaining occurrence of an audited term in generic orr-else guidance is
either:

1. **Forbidden-list mention** — explicitly listed as a term agents must NOT use.
2. **Negative assertion** — a statement that the term does NOT appear in tool
   schemas.
3. **Legitimate tool schema field** — `notesPreview` in `bd_list` and
   `*Truncated` companion flags in `bd_get_bead`/`bd_get_state_chart` are
   distinct private schema fields of those specific tools; they are not the
   removed generic-envelope fields.

Zero occurrences instruct any agent to rely on `resultPreview`, `outputArchive`,
`diagnosticPreview`, `outputPreview`, `inlineResultBytes`, `outputLimit`,
`stdoutTruncated`, or `stderrTruncated` as universal production-tool behavior.
