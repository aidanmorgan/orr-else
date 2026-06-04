# Harness Packaging Design

**Bead**: pi-experiment-mynj  
**Status**: Implemented  
**Date**: 2026-06-03

---

## 1. Problem Statement

The orr-else harness cannot currently be consumed by any project without that project maintaining a live, local checkout of the `pi-experiment` repository. Every consuming project today must:

1. Point Pi's `packages` loader at `../../../pi-experiment` (a relative path to the checkout).
2. Export `ORR_ELSE_FRAMEWORK_ROOT=/path/to/pi-experiment` before starting the harness.
3. Resolve `@modelcontextprotocol/sdk` and all other runtime deps from the checkout's `node_modules/` (or separately install them into `.pi/npm`).

The goal is a packaging mechanism where `npm install orr-else` (or `npx orr-else init`) gives a project a fully self-contained harness with all runtime dependencies bundled, no source-dir references required.

---

## 2. Current Source-Dir Coupling Points

The following catalogue describes every place a consuming project currently has a reference that points back into the orr-else source checkout. These are the obstacles to a clean install.

### 2.1 Pi `packages` loader — `.pi/settings.json`

```json
{
  "packages": [
    "../../../pi-experiment",
    "npm:pi-mcp-adapter@2.7.0"
  ]
}
```

Pi's package loader resolves this relative path and discovers the `"pi": { "extensions": ["./dist/extension.js"] }` field in the checkout's `package.json`. It then loads `dist/extension.js` from the checkout. **This is the primary coupling point**: it requires the checkout to exist at a known relative path from the consuming project.

### 2.2 `ORR_ELSE_FRAMEWORK_ROOT` environment variable

`harness.yaml` comment in cerdiwen: _"orrElseFrameworkRoot is intentionally absent: resolved at runtime from the ORR_ELSE_FRAMEWORK_ROOT environment variable (must be exported before starting the harness, e.g. `export ORR_ELSE_FRAMEWORK_ROOT=/path/to/pi-experiment`)."_

`ORR_ELSE_FRAMEWORK_ROOT` is read by:
- `frameworkRootFromConfig()` in `src/plugins/projectTools/contextHelpers.ts` — falls back to this env var when the YAML does not set `artifacts.templates.orrElseFrameworkRoot`.
- `requireFrameworkRoot()` and `optionalFrameworkRoot()` in cerdiwen's `.pi/project-tools/_runtime_paths.ts` — directly consumed by `framework_build`, `framework_regression_tests`, `orr_else_framework_evidence`, and the `framework` repo target in `git_history`.

**Clarification on scope**: `ORR_ELSE_FRAMEWORK_ROOT` and the tools that use it (`framework_build`, `framework_regression_tests`, `orr_else_framework_evidence`) are **framework-development tools** — they exist so that cerdiwen (the dogfooding project) can run the orr-else build and test suite against the framework's own source. A normal consuming project that is *not* developing the harness itself does NOT need these tools and does NOT need `ORR_ELSE_FRAMEWORK_ROOT` to point at anything. The design must clearly separate "consume the harness" from "develop the harness".

### 2.3 Worker extension path: `.pi/extensions/orr-else.ts`

The constant `Defaults.PROJECT_EXTENSION_PATH = '.pi/extensions/orr-else.ts'` in `src/constants/index.ts` is the default path the coordinator looks for when spawning workers. Cerdiwen's `.pi/extensions/orr-else.ts` shim currently reads:

```typescript
import orrElse from '../../dist/extension.js';
export default orrElse;
```

This is a two-hop source-dir coupling: the shim exists in the consuming project, but the import resolves into the checkout's compiled `dist/` rather than an installed package. When Pi resolves this shim's import it traverses `../..` relative to `.pi/extensions/`, landing in the checkout root.

### 2.4 `@modelcontextprotocol/sdk` in `.pi/npm`

The harness's `src/plugins/projectTools/mcpExecutor.ts` imports `@modelcontextprotocol/sdk/client/index.js` and related entry points. The `McpTransportPreflight.ts` remediation hint instructs: _"npm install --prefix .pi/npm @modelcontextprotocol/sdk"_. The SDK lives in `dependencies` in `package.json`. In cerdiwen, it is resolved via `.pi/npm/node_modules/@modelcontextprotocol/sdk` (confirmed present). This is a second dependency that must be separately provisioned today rather than bundled with the package.

### 2.5 Test files with hard-coded local paths

`cerdiwen/.pi/project-tools/orr_else_framework_evidence.test.ts` has:

```typescript
env: { ...process.env, ORR_ELSE_FRAMEWORK_ROOT: "/Users/aidan/dev/pi-experiment", ... }
```

This is a test-only hard-coding of an absolute local path. Not a runtime coupling, but it blocks portability of the test suite. Addressed in the migration note.

### 2.6 Summary table

| Coupling Point | Location | Blocking for clean install? |
|---|---|---|
| `packages: ["../../../pi-experiment"]` | `cerdiwen/.pi/settings.json` | YES — primary |
| `import '../../dist/extension.js'` in shim | `cerdiwen/.pi/extensions/orr-else.ts` | YES — secondary |
| `ORR_ELSE_FRAMEWORK_ROOT` env var (normal use) | shell environment + harness.yaml | NO for normal consumers; YES for framework-dev dogfooding |
| `@modelcontextprotocol/sdk` via `.pi/npm` | install-time manual step | YES — must be bundled |
| Hard-coded `/Users/aidan/dev/pi-experiment` in tests | cerdiwen `.pi/project-tools/*.test.ts` | Test-only, not runtime |

---

## 3. Recommended Packaging Approach

### 3.0 Pi Host SDK: peerDependencies contract

The orr-else harness is a **Pi plugin** — it runs *inside* the Pi host process. The Pi host platform (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`) is **provided by the host at runtime**, not by the harness package.

These packages must be declared as `peerDependencies`, not bundled:

```json
"peerDependencies": {
  "@earendil-works/pi-ai": "^0.74.0",
  "@earendil-works/pi-coding-agent": "^0.74.0",
  "@earendil-works/pi-agent-core": "^0.74.0"
},
"peerDependenciesMeta": {
  "@earendil-works/pi-coding-agent": { "optional": true },
  "@earendil-works/pi-agent-core": { "optional": true }
}
```

**Why peers, not bundled:**

- `@earendil-works/pi-ai` is directly imported at runtime by `dist/extension.js` and the plugin modules. If this package is not present when the harness loads, Node.js throws `ERR_MODULE_NOT_FOUND`.
- The Pi *host* (the process that loads the extension) already has `@earendil-works/pi-ai` in its own `node_modules`. Bundling a second copy would create a version split — the harness objects would not be instanceof-compatible with the host's objects.
- `pi-coding-agent` and `pi-agent-core` are used only as TypeScript types (`import type`) in source files; the compiled JS does not contain runtime imports for them. They are declared as optional peers to document the host contract and to allow npm to warn consumers of version mismatches.

**How the Pi host provides them:**

When Pi loads the extension via its `packages` loader, it resolves `orr-else/dist/extension.js` from the consumer's `node_modules/orr-else/`. Node.js then resolves the `@earendil-works/pi-ai` import by walking up from `node_modules/orr-else/dist/` through the consumer's `node_modules/` until it finds `@earendil-works/pi-ai` — which the Pi host has already placed there.

**Consumer projects do not need to install `@earendil-works/pi-ai` themselves** — the Pi host installs it. With npm 7+, declaring it as a `peerDependency` also causes npm to auto-install it when a consumer runs `npm install orr-else`.

**Dependency-contract test:** `tests/packaging.test.ts` contains a static analysis test that walks `dist/**/*.js`, extracts all external import specifiers, and asserts each one is satisfied by either `dependencies/bundledDependencies` or `peerDependencies`. This test will fail if any runtime import falls through to `devDependencies` only — the exact bug described in the bead.

### 3.1 Primary recommendation: npm package with `bundledDependencies`

Publish `orr-else` as an npm package where all runtime dependencies are listed in `bundledDependencies`. This means `npm pack` / `npm publish` embeds the complete `node_modules` subtree for every listed dependency inside the tarball. When a consumer runs `npm install orr-else` (or `npx -p orr-else ...`), all transitive deps arrive in one shot under the package's own `node_modules/` — the consumer does not manage them and does not need a separate `npm install --prefix .pi/npm` step.

**Why `bundledDependencies` over alternatives:**

- **esbuild/ncc single-file bundle**: Would produce a compact `dist/extension.bundle.js`. However, the harness extension is loaded dynamically by Pi as an ESM module (TypeScript via tsx, or compiled JS). A bundler cannot fold native Node.js modules cleanly, ESM circular-import semantics are tricky to preserve, and source maps become misleading. The extension is also loaded at Pi's module boundary — Pi expects a default export function, not a single-file blob. More importantly, `@modelcontextprotocol/sdk` uses dynamic imports (`import(mod)` at runtime) in `mcpExecutor.ts` and the preflight check — a static bundle breaks that. `bundledDependencies` avoids touching the module graph.

- **`npm pack` without bundling**: Leaves the consumer responsible for installing transitive deps. Defeats the goal.

- **`bundledDependencies`**: Standard, boring, well-understood. `npm pack` does the right thing. Works with the existing ESM module structure. No changes to import paths. Pi loads the compiled `dist/extension.js` just as it does today, but from the package's own `node_modules/` rather than a checkout.

**The key step**: move all entries currently in `dependencies` into `bundledDependencies` in `package.json`. They stay in `dependencies` too (so `npm install` without `--omit=dev` still works for development); `bundledDependencies` just adds them to the pack tarball.

### 3.2 Package contents after this change

The `files` field in `package.json` already lists `dist`, `harness.schema.json`, `README.md`, and `docs`. The packed tarball will additionally contain:

```
orr-else-<version>.tgz
  package/
    dist/          ← compiled JS (tsc output)
    harness.schema.json
    README.md
    docs/
    node_modules/  ← all bundledDependencies (populated by npm pack)
      @modelcontextprotocol/
      @opentelemetry/
      ajv/
      commander/
      execa/
      express/
      ... (all runtime deps)
```

Pi resolves the extension via the `"pi": { "extensions": ["./dist/extension.js"] }` field in `package.json`. Once installed, Pi's package loader finds this field in `node_modules/orr-else/package.json` and loads `node_modules/orr-else/dist/extension.js`. All imports from that file resolve through `node_modules/orr-else/node_modules/` (or the nearest common ancestor), not through any external checkout.

---

## 4. Install / Scaffold: `orr-else init`

Add a `bin` command (`orr-else` → `dist/main.js`) that supports an `init` subcommand. When run in a project directory it:

1. Creates `.pi/extensions/orr-else.ts` (if it does not exist) with:
   ```typescript
   import orrElse from 'orr-else/dist/extension.js';
   export default orrElse;
   ```
   This import resolves through Node module resolution from the consuming project's `node_modules/orr-else/`, not from any checkout path.

2. Writes a starter `harness.yaml` if none exists (or backs up + patches an existing one), with sane defaults for `settings`, `statechart`, `states`, and `scheduler`.

3. Creates `.pi/prompts/`, `.pi/skills/`, `.pi/rules/` scaffolding with template files copied from `node_modules/orr-else/templates/` (add a `templates/` directory to the package's `files` list).

4. Updates (or creates) `.pi/settings.json` to:
   ```json
   {
     "packages": [
       "npm:orr-else@<installed-version>"
     ]
   }
   ```
   This replaces the relative-path `../../../pi-experiment` entry with a standard npm specifier. Pi's package loader resolves `npm:` specifiers from the project's local `node_modules/`.

5. Prints a brief post-install note explaining that `ORR_ELSE_FRAMEWORK_ROOT` is NOT needed for normal project use (it is only needed when the project is developing the harness itself).

The `bin` entry in `package.json` already exists (`"orr-else": "./dist/main.js"`). The `main.js` entry point just needs the `init` subcommand wired via `commander`.

---

## 5. Eliminating `ORR_ELSE_FRAMEWORK_ROOT` for Normal Consumers

### 5.1 Framework-development tools vs. consumer tools

`framework_build`, `framework_regression_tests`, `orr_else_framework_evidence` in cerdiwen's `.pi/project-tools/` are **framework-development tools**. They exist specifically so that cerdiwen — the dogfooding project — can build and test the `orr-else` framework source code as part of a bead's implementation workflow. They read files from `ORR_ELSE_FRAMEWORK_ROOT` (i.e., the source checkout).

A consumer project that is *not* developing the harness has NO use for these tools and should NOT install them. The `orr-else init` scaffold does not copy these tools. The design doc and init message must state this clearly.

### 5.2 What to do about `ORR_ELSE_FRAMEWORK_ROOT` in the harness core

`frameworkRootFromConfig()` in `contextHelpers.ts` already handles the case gracefully: when `ORR_ELSE_FRAMEWORK_ROOT` is unset and `artifacts.templates.orrElseFrameworkRoot` is absent from `harness.yaml`, the function returns `undefined`. The harness does not fail — it simply has no framework root, which is the correct behaviour for a normal consumer project.

The `{{orrElseFrameworkRoot}}` template token in `TemplateToken` likewise resolves to an empty string when `frameworkRoot` is undefined (see `PiIntegration.ts` line 74: `[TemplateToken.ORR_ELSE_FRAMEWORK_ROOT, context.frameworkRoot]`). Tool env-var injection at line 235 already guards with `context.templateContext.frameworkRoot ?`. No harness core changes are needed.

**Conclusion**: `ORR_ELSE_FRAMEWORK_ROOT` can remain in the harness core as-is. A normal consumer simply does not set it and does not configure tools that require it. The `orr-else init` starter harness.yaml does not reference `{{orrElseFrameworkRoot}}`.

---

## 6. Version / Upgrade Story

- Consumers pin a version in their `node_modules/orr-else` via normal npm versioning: `npm install orr-else@1.2.0`.
- `package.json` records the dependency; `package-lock.json` pins the transitive tree.
- To upgrade: `npm install orr-else@latest`. The `bundledDependencies` inside the new tarball replace the old ones automatically.
- The `.pi/settings.json` `"packages": ["npm:orr-else@^1.0.0"]` entry uses a semver range. Pi resolves it to whatever is installed in `node_modules/`. Version pinning is via the project's own `package.json`/lockfile — the normal npm workflow.
- No `.pi/npm/` subdirectory needed for the harness itself. If the consumer installs other Pi extensions (like `pi-mcp-adapter`) they continue to use `.pi/npm/` for those, which is orthogonal.

### 6.1 Project tools and their TypeScript wrappers

Cerdiwen's `.pi/project-tools/*.ts` wrappers today resolve deps from `.pi/npm/node_modules/`. After packaging:

- Wrappers that are harness-internal (framework-dev tools) remain in `.pi/project-tools/` as project-owned code and continue to resolve deps from `.pi/npm/`.
- For a normal consumer project, project-tool wrappers do not need to import from orr-else's internals. They are project-authored scripts; their deps are in their own package context.
- If a consuming project wants to import utilities from the orr-else package (e.g., shared types), it does so via `import { ... } from 'orr-else/dist/...'` — resolved from `node_modules/orr-else/`, not a checkout path.

---

## 7. Migration Note for Cerdiwen

Cerdiwen currently couples to the checkout via `.pi/settings.json` and the shim. Here is the migration path:

### Step 1: Publish orr-else as an npm package

Run `npm pack` from the `pi-experiment/` checkout (after adding `bundledDependencies`) and install the resulting tarball in cerdiwen:

```bash
# In pi-experiment:
npm pack
# Produces orr-else-1.0.0.tgz

# In cerdiwen:
npm install --save /path/to/orr-else-1.0.0.tgz
# Or, once published:
npm install --save orr-else@1.0.0
```

### Step 2: Update `.pi/settings.json`

Change:

```json
{
  "packages": [
    "../../../pi-experiment",
    "npm:pi-mcp-adapter@2.7.0"
  ]
}
```

To:

```json
{
  "packages": [
    "npm:orr-else@^1.0.0",
    "npm:pi-mcp-adapter@2.7.0"
  ]
}
```

### Step 3: Update `.pi/extensions/orr-else.ts` (if cerdiwen still has one)

Replace the relative import:

```typescript
// OLD:
import orrElse from '../../dist/extension.js';

// NEW:
import orrElse from 'orr-else/dist/extension.js';
export default orrElse;
```

Pi resolves `orr-else/dist/extension.js` from the project's `node_modules/orr-else/dist/extension.js`.

### Step 4: Remove the manual `@modelcontextprotocol/sdk` install

Currently cerdiwen has `@modelcontextprotocol/sdk` in `.pi/npm/node_modules/`. Once it is bundled inside the `orr-else` package (via `bundledDependencies`), the harness resolves it from `node_modules/orr-else/node_modules/@modelcontextprotocol/sdk`. The manual `.pi/npm` entry for it can be removed.

### Step 5: Retain framework-development tools as-is

The framework-dev tools (`framework_build`, `framework_regression_tests`, `orr_else_framework_evidence`) remain in cerdiwen's `.pi/project-tools/` as project-owned code. They still require `ORR_ELSE_FRAMEWORK_ROOT` when cerdiwen is dogfooding changes to the harness itself. This is correct and intentional — cerdiwen is the harness's development project. Normal consumer projects do not have these tools.

### Step 6: Fix test hard-coding

In `.pi/project-tools/orr_else_framework_evidence.test.ts`, replace the hard-coded `/Users/aidan/dev/pi-experiment` with:

```typescript
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const FRAMEWORK_ROOT = resolve(fileURLToPath(import.meta.url), '../../../../../../pi-experiment');
// or, better, use require.resolve / import.meta.resolve to find the installed package:
const FRAMEWORK_ROOT = new URL('../../', import.meta.resolve('orr-else')).pathname;
```

Or simply set `ORR_ELSE_FRAMEWORK_ROOT` from `process.env.ORR_ELSE_FRAMEWORK_ROOT` with a local-dev fallback and skip these tests in CI where no framework checkout is available. This is a test-only concern and does not block the migration.

---

## 8. Phased Implementation Plan

### Phase 1: Package preparation (this repo — `pi-experiment`)

**Goal**: The orr-else package packs correctly and bundles all runtime deps.

Steps:
1. Add `bundledDependencies` to `package.json` listing all current `dependencies` entries.
2. Add a `templates/` directory to `files` containing the starter `harness.yaml` and `.pi/` scaffold templates that `orr-else init` will copy.
3. Implement the `init` subcommand in `src/main.ts` (or a new `src/cli/init.ts`) using `commander`. It should: create `.pi/extensions/orr-else.ts`, write `.pi/settings.json`, write a starter `harness.yaml`, and scaffold `prompts/`, `skills/`, `rules/`.
4. Update `package.json` to export a stable `dist/extension.js` entry via the `"exports"` field (for consumers using `import ... from 'orr-else/dist/extension.js'` as well as Pi's own package-field resolution).
5. Run `npm pack --dry-run` and verify: (a) `node_modules/` entries are present in the tarball, (b) `dist/extension.js` is present, (c) `@modelcontextprotocol/sdk` is bundled.
6. Write/update tests for the `init` command (integration test: run in a temp directory, verify files created).

**Bead**: Create a new bead for "Package preparation — bundledDependencies + init command".

### Phase 2: Pi package-loader contract validation

**Goal**: Confirm Pi's `packages` loader correctly resolves an `npm:` specifier to an installed package and picks up the `"pi": { "extensions": [...] }` field.

Steps:
1. Install the packed tarball locally (`npm install /path/to/orr-else-1.0.0.tgz`) in a scratch project.
2. Set `.pi/settings.json` to `{ "packages": ["npm:orr-else@1.0.0"] }` and verify Pi loads the extension without errors.
3. Confirm that `node_modules/orr-else/node_modules/@modelcontextprotocol/sdk` is present and resolvable from `dist/extension.js`.
4. Smoke-test: launch a minimal harness session to confirm the extension registers tools correctly.

**Bead**: Create a new bead for "Pi package-loader smoke test with local tarball".

### Phase 3: Cerdiwen migration

**Goal**: Cerdiwen switches from the source-dir coupling to the packaged install.

Steps:
1. In cerdiwen, run `npm install --save orr-else@<version>` (tarball or published).
2. Update `.pi/settings.json` as described in §7 Step 2.
3. Update `.pi/extensions/orr-else.ts` as described in §7 Step 3.
4. Remove the standalone `@modelcontextprotocol/sdk` entry from `.pi/npm/package.json` (§7 Step 4).
5. Run cerdiwen's full regression suite to verify the harness starts, spawns a teammate, and completes a bead.
6. Update the `ORR_ELSE_FRAMEWORK_ROOT` documentation in cerdiwen to clarify it is only needed for framework-development beads.

**Bead**: Create a new bead for "Cerdiwen migration to packaged orr-else".

### Phase 4: Publish to npm registry (optional / later)

**Goal**: Any project can `npm install orr-else` without a local tarball.

Steps:
1. Ensure `package.json` has correct `name`, `version`, `publishConfig`, `repository`, and `license` fields.
2. Run `npm publish --dry-run` and review tarball contents.
3. Publish to a private or public registry.
4. Update cerdiwen to reference `npm:orr-else@^1.0.0` (registry specifier rather than file path).

**Bead**: Create a new bead for "npm publish orr-else v1".

---

## 9. What Stays Out of Scope

- **framework-dev tools** (`framework_build`, `framework_regression_tests`, `orr_else_framework_evidence`): These are cerdiwen-owned project tools for dogfooding. They are NOT shipped as part of the orr-else package, are NOT installed by `orr-else init`, and are NOT relevant to any consumer except the framework's own development project.

- **`ORR_ELSE_FRAMEWORK_ROOT` removal from harness core**: The env var and template token are harmless when unset. Removing them is a separate cleanup that can happen independently and is not blocking for packaging.

- **Rewriting `.pi/npm` for cerdiwen's other deps** (e.g. `pi-mcp-adapter`, `vectoriadb`): These are cerdiwen-specific Pi extension deps. They use `.pi/npm` by design and are not affected by orr-else packaging.

---

## 10. Summary

**Recommended approach**: Publish `orr-else` as a standard npm package with `bundledDependencies` covering all runtime dependencies, a `dist/` compiled output, a `templates/` scaffold directory, and an `orr-else init` bin command. Consumers run `npm install orr-else` and `npx orr-else init`, set `.pi/settings.json` to `"packages": ["npm:orr-else@^x.y.z"]`, and never need a path to a source checkout. The `@modelcontextprotocol/sdk` and all other runtime deps arrive inside the tarball. `ORR_ELSE_FRAMEWORK_ROOT` is a framework-development concern only; normal consumers leave it unset and the harness handles that gracefully with no code changes.

**Source-dir coupling points** (obstacles to be eliminated):
1. `.pi/settings.json` `"packages": ["../../../pi-experiment"]` → replace with `"npm:orr-else@^x.y.z"`.
2. `.pi/extensions/orr-else.ts` shim `import '../../dist/extension.js'` → change to `import 'orr-else/dist/extension.js'`.
3. `@modelcontextprotocol/sdk` manually installed in `.pi/npm/` → bundled inside the package via `bundledDependencies`.
4. `ORR_ELSE_FRAMEWORK_ROOT` env var pointing at checkout (framework-dev tools only) → not applicable to normal consumers; framework-dev projects (cerdiwen) continue to set it for dogfooding beads.
5. Hard-coded `/Users/aidan/dev/pi-experiment` in test files → test-only fix, not runtime.

**Phased plan**:
- Phase 1: `bundledDependencies` + `init` command in this repo.
- Phase 2: Pi package-loader contract validation with a local tarball.
- Phase 3: Cerdiwen migration off the source-dir setup.
- Phase 4: npm registry publish (optional follow-on).
