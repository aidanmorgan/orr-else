/**
 * PathContext — path-aware read and file-discovery helper.
 *
 * Design goals:
 * - Cut wasted retries from non-existent paths (ENOENT) and invalid offsets
 *   (offset-beyond-EOF) before the model issues raw read calls.
 * - Expose existence, canonical relative path, total lines, valid next offsets,
 *   and nearest matches (closest existing paths by name similarity) WITHOUT
 *   forcing the model to guess.
 * - Security: all inputs are canonicalized and SCOPE-CHECKED against allowed
 *   roots (active worktree + project root), mirroring the tvxo/ArtifactQuery
 *   pattern. Out-of-scope paths return a structured rejection — no
 *   content/existence-of-target leak.
 * - Best-effort: never throws. All errors produce structured rejection results.
 *
 * Nearest-match suggestions use a bounded walk of the allowed roots, capped at
 * PATH_CONTEXT_MAX_NEAR_MATCHES, with simple basename/dirname similarity
 * ranking so the model gets actionable hints without a full directory dump.
 */

import * as fs from 'fs';
import * as path from 'path';
import { EnvVars } from '../constants/index.js';

// ─── Caps (named constants — no magic numbers) ────────────────────────────────

/** Maximum number of nearest-match candidates returned per call. */
export const PATH_CONTEXT_MAX_NEAR_MATCHES = 5;

/** Maximum number of files scanned when searching for nearest matches. */
export const PATH_CONTEXT_MAX_SCAN_FILES = 500;

/** Maximum lines that may be requested in a single safe_read_slice call. */
export const PATH_CONTEXT_MAX_SLICE_LINES = 400;

/** Maximum byte length of the skeleton output (body-elided code structure). */
export const SKELETON_MAX_BYTES = 32_000;

// ─── Skeleton mode: source-code extensions (data formats excluded) ────────────

/**
 * File extensions recognized as TypeScript / JavaScript source code.
 * Only these receive the body-elision treatment in skeleton mode.
 */
const TS_JS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);

/**
 * File extensions recognized as Python source code.
 * Only these receive the Python-specific skeleton extraction.
 */
const PYTHON_EXTENSIONS = new Set(['.py', '.pyi']);

/**
 * Data-format extensions that must NEVER be body-stripped in skeleton mode.
 * For these extensions skeleton mode is a no-op (falls back to bounded read).
 */
const DATA_FORMAT_EXTENSIONS = new Set([
  '.json', '.yaml', '.yml', '.toml',
  '.md', '.txt', '.csv', '.xml', '.html', '.htm',
  '.lock', '.env', '.ini', '.cfg', '.conf'
]);

// ─── Skeleton extraction: TypeScript / JavaScript ─────────────────────────────

/**
 * Placeholder inserted in place of elided function/method bodies.
 */
const BODY_ELISION_PLACEHOLDER = '{ ... }';

/**
 * Extract a structural skeleton from TypeScript/JavaScript source code.
 *
 * Kept lines (signature-level structure):
 *   - import / require statements
 *   - export declarations (const, let, function, class, interface, type, enum)
 *   - class / interface / type / enum declarations (top-level and nested)
 *   - function / method SIGNATURES (the signature line, opening brace replaced
 *     by the elision placeholder)
 *   - Blank lines between top-level declarations (for readability)
 *   - Decorator lines (@...)
 *
 * Elided:
 *   - Function/method bodies (everything between { and matching })
 *
 * Strategy: a context stack tracks whether each brace depth is a "transparent"
 * container (class/interface body — signatures within are emitted) or an
 * "opaque" body (function/method body — all content suppressed).
 *
 * Stack entries:
 *   'class'    → inside a class/interface/enum body: emit method signatures
 *   'function' → inside a function/method body: suppress all lines
 *   'other'    → inside another block (if, while, etc.): suppress
 */
function extractTsJsSkeleton(source: string): string {
  const lines = source.split('\n');
  const result: string[] = [];

  // Patterns matched against the raw line
  const IMPORT_RE = /^\s*(import\b|export\s+(type\s+)?\{|export\s+\*)/;
  const EXPORT_FROM_RE = /^\s*export\s+/;
  const CLASS_DECL_RE =
    /^\s*(export\s+)?(default\s+)?(abstract\s+)?class\s+\w+/;
  const INTERFACE_DECL_RE =
    /^\s*(export\s+)?interface\s+\w+/;
  const TYPE_DECL_RE =
    /^\s*(export\s+)?type\s+\w+\s*[=<]/;
  const ENUM_DECL_RE =
    /^\s*(export\s+)?(const\s+)?enum\s+\w+/;
  const FUNCTION_DECL_RE =
    /^\s*(export\s+)?(default\s+)?(async\s+)?function\s*\*?\s*\w*/;
  const METHOD_RE =
    /^\s*(public|private|protected|static|async|override|abstract|get|set|\*)\s+[\w[\]]/;
  const CONSTRUCTOR_RE = /^\s*(public\s+)?constructor\s*\(/;
  const DECORATOR_RE = /^\s*@\w+/;
  const ARROW_EXPORT_RE =
    /^\s*(export\s+)?(const|let|var)\s+\w+(\s*:\s*[\w<>[\]|&,. ]+)?\s*=/;

  // Context stack: each entry is the type of block we're inside
  type BlockKind = 'class' | 'function' | 'other';
  const stack: BlockKind[] = [];

  // Count { and } on a single line, ignoring those inside strings OR comments.
  //
  // Heuristic for comment detection:
  //   - '//' line comment: once seen (outside a string), ignore everything to EOL.
  //   - '/* */' block comment: track state across the call via `inBlockComment`
  //     (caller passes current state in, receives updated state out).
  //   - String literals (", ', `): skip until the matching closing quote.
  //
  // Error-lean policy: when in doubt, we prefer NOT to count a brace.
  //   - A missed closing brace keeps us *inside* the suppressed body (safe —
  //     no leak; we just suppress one extra line at most).
  //   - A spurious closing brace would pop us *out* of the body early (unsafe
  //     — the remaining body lines would be emitted verbatim, i.e. a leak).
  // Therefore we err toward keeping the counter higher rather than lower.
  function countBraces(s: string, inBlockComment: boolean): [number, number, boolean] {
    let open = 0, close = 0;
    let inStr: string | null = null;
    let blockComment = inBlockComment;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]!;

      if (blockComment) {
        // Inside /* … */ — look for the closing */
        if (ch === '*' && s[i + 1] === '/') {
          blockComment = false;
          i++; // skip '/'
        }
        // Braces inside block comments are ignored
        continue;
      }

      if (inStr) {
        // Inside a string literal — skip until matching unescaped closing quote
        if (ch === inStr && s[i - 1] !== '\\') inStr = null;
        continue;
      }

      // Not in a comment or string
      if (ch === '/' && s[i + 1] === '/') {
        // Line comment — ignore rest of line (braces here are not real)
        break;
      }
      if (ch === '/' && s[i + 1] === '*') {
        // Block comment start
        blockComment = true;
        i++; // skip '*'
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        inStr = ch;
      } else if (ch === '{') {
        open++;
      } else if (ch === '}') {
        close++;
      }
    }
    return [open, close, blockComment];
  }

  // Determine if a line looks like it opens a class-like body
  function isClassLikeLine(line: string): boolean {
    return (
      CLASS_DECL_RE.test(line) ||
      INTERFACE_DECL_RE.test(line) ||
      ENUM_DECL_RE.test(line)
    );
  }

  // Determine if a line looks like a function/method signature
  function isFunctionLike(line: string): boolean {
    return (
      FUNCTION_DECL_RE.test(line) ||
      METHOD_RE.test(line) ||
      CONSTRUCTOR_RE.test(line) ||
      ARROW_EXPORT_RE.test(line)
    );
  }

  // Is this line structural at the level we're currently processing?
  function isStructural(line: string, trimmed: string, currentKind: BlockKind | undefined): boolean {
    if (currentKind === undefined || currentKind === 'class') {
      // At top level or inside a class body: emit signatures and declarations
      return (
        IMPORT_RE.test(line) ||
        EXPORT_FROM_RE.test(line) ||
        CLASS_DECL_RE.test(line) ||
        INTERFACE_DECL_RE.test(line) ||
        TYPE_DECL_RE.test(line) ||
        ENUM_DECL_RE.test(line) ||
        FUNCTION_DECL_RE.test(line) ||
        METHOD_RE.test(line) ||
        CONSTRUCTOR_RE.test(line) ||
        ARROW_EXPORT_RE.test(line) ||
        DECORATOR_RE.test(line) ||
        trimmed === '' ||
        trimmed === '{' ||
        trimmed === '}' ||
        trimmed.startsWith('//') ||
        trimmed.startsWith('*') ||
        trimmed.startsWith('/*') ||
        trimmed.startsWith('*/')
      );
    }
    // Inside a function/other body: suppress everything
    return false;
  }

  // Block-comment state carried across lines (M2 fix: multi-line /* */ tracking)
  let blockCommentState = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const [open, close, nextBlockComment] = countBraces(line, blockCommentState);
    blockCommentState = nextBlockComment;
    const net = open - close;

    const currentKind = stack.length > 0 ? stack[stack.length - 1] : undefined;
    const inFunctionBody = currentKind === 'function' || currentKind === 'other';

    if (inFunctionBody) {
      // Inside a suppressed body — track braces, exit when depth returns
      for (let o = 0; o < open; o++) stack.push('other');
      for (let c = 0; c < close; c++) {
        if (stack.length > 0) stack.pop();
      }
      // When we've exited all suppressed levels back to a class or top-level,
      // emit a closing brace line if we just popped out fully
      const newKind = stack.length > 0 ? stack[stack.length - 1] : undefined;
      if (newKind !== 'function' && newKind !== 'other') {
        // Emit the closing brace only (the `}` that ends the function)
        if (trimmed === '}' || trimmed === '};') {
          result.push(line);
        }
      }
      continue;
    }

    // Not in a suppressed body
    if (!isStructural(line, trimmed, currentKind)) {
      // Non-structural line at class/top level — track braces but skip
      for (let o = 0; o < open; o++) stack.push('other');
      for (let c = 0; c < close; c++) {
        if (stack.length > 0) stack.pop();
      }
      continue;
    }

    // ── M1 fix: single-line body (open == close, net == 0 but open > 0) ──────
    // e.g. `export function f(): number { return 42; }`
    // The old code fell through to the else branch and emitted the line verbatim
    // (body included). Detect this case and elide the body.
    if (open > 0 && net === 0 && isFunctionLike(line)) {
      // Replace everything between the first `{` and its matching `}` with
      // the placeholder. The regex grabs from the first `{` to the LAST `}` on
      // the line (greedy inner), which handles the simple single-block case.
      const sigLine = line.replace(/\{.*\}/, BODY_ELISION_PLACEHOLDER);
      result.push(sigLine);
      // Net brace count is 0 — stack is unchanged; body is fully contained on
      // this one line so no suppression entry is needed.
      continue;
    }

    // Structural line — does it open a block?
    if (open > 0 && net > 0) {
      // Emit the signature with the opening body brace replaced by the placeholder
      const sigLine = line.replace(/\{[^{]*$/, BODY_ELISION_PLACEHOLDER);
      result.push(sigLine);

      // Determine what kind of block opened
      const blockKind: BlockKind = isClassLikeLine(line)
        ? 'class'
        : isFunctionLike(line)
          ? 'function'
          : 'other';

      // Push one entry per net open (net > 0 means opened more than closed on this line)
      // In practice a signature line opens exactly one block
      for (let o = 0; o < open; o++) {
        stack.push(o === 0 ? blockKind : 'other');
      }
      for (let c = 0; c < close; c++) {
        if (stack.length > 0) stack.pop();
      }
    } else if (trimmed === '}' || trimmed === '};') {
      // Closing brace at structural level — pop and emit
      if (stack.length > 0) stack.pop();
      result.push(line);
    } else {
      // Non-opening structural line (import, type alias, blank, comment)
      result.push(line);
      // Track any net braces (e.g. single-line type aliases)
      for (let o = 0; o < open; o++) stack.push('other');
      for (let c = 0; c < close; c++) {
        if (stack.length > 0) stack.pop();
      }
    }
  }

  return result.join('\n');
}

// ─── Skeleton extraction: Python ──────────────────────────────────────────────

/**
 * Extract a structural skeleton from Python source code.
 *
 * Kept lines:
 *   - import / from … import lines
 *   - class signatures (the `class` line itself, body is transparent — nested
 *     defs are emitted)
 *   - def / async def SIGNATURES (the def line itself, body suppressed)
 *   - Decorator lines (@…)
 *   - Top-level assignments (CONSTANT = …, __dunder__ = …)
 *   - Type aliases (TypeAlias, TypeVar)
 *   - Blank lines between declarations
 *
 * Elided:
 *   - Function/method bodies only (not class bodies — class bodies are
 *     "transparent" so nested defs can be emitted)
 *
 * Strategy: a suppression stack.  Each entry records the indent level of a
 * def body that is currently suppressed.  When we see a new line:
 *   - If indented more than the top-of-stack entry, it is suppressed (skip it
 *     but emit a `...` elision once).
 *   - Once we return to or below the entry's indent, pop the stack entry.
 *   - class lines are emitted but do NOT push a suppress entry (body is transparent).
 *   - def lines are emitted AND push a suppress entry for their body.
 */
function extractPythonSkeleton(source: string): string {
  const lines = source.split('\n');
  const result: string[] = [];

  const IMPORT_RE = /^(import |from )/;
  const DEF_RE = /^\s*(async\s+)?def\s+\w+/;
  const CLASS_RE = /^\s*class\s+\w+/;
  const DECORATOR_RE = /^\s*@\w+/;
  const TOP_ASSIGN_RE = /^[A-Z_][A-Z_0-9]*\s*[=:]/; // CONSTANT = …
  const DUNDER_RE = /^__\w+__\s*=/;
  const TYPE_ALIAS_RE = /^\s*(TypeVar|TypeAlias|\w+)\s*=\s*(TypeVar|TypeAlias)/;

  // Stack of {indent, emittedElision} for suppressed def bodies
  const suppressStack: Array<{ indent: number; emittedElision: boolean }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // Blank lines: emit only when not inside a suppressed body
    if (trimmed === '') {
      if (suppressStack.length === 0) {
        result.push(line);
      }
      continue;
    }

    // Measure current indentation
    const indent = line.length - line.trimStart().length;

    // Pop any suppression entries that this line's indent exits
    while (suppressStack.length > 0 && indent <= suppressStack[suppressStack.length - 1]!.indent) {
      suppressStack.pop();
    }

    // If still inside a suppressed def body, emit elision once then skip
    if (suppressStack.length > 0) {
      const top = suppressStack[suppressStack.length - 1]!;
      if (!top.emittedElision) {
        result.push(`${' '.repeat(top.indent + 4)}...`);
        top.emittedElision = true;
      }
      continue;
    }

    // Determine whether this line is structural
    const isDef = DEF_RE.test(line);
    const isClass = CLASS_RE.test(line);
    const isStructural =
      IMPORT_RE.test(trimmed) ||
      isDef ||
      isClass ||
      DECORATOR_RE.test(line) ||
      TOP_ASSIGN_RE.test(trimmed) ||
      DUNDER_RE.test(trimmed) ||
      TYPE_ALIAS_RE.test(trimmed);

    if (isStructural) {
      result.push(line);
      if (isDef) {
        // def bodies are suppressed; class bodies are transparent
        suppressStack.push({ indent, emittedElision: false });
      }
    }
    // Non-structural lines at current level are skipped
  }

  return result.join('\n');
}

// ─── Generic best-effort skeleton extraction ──────────────────────────────────

/**
 * Best-effort skeleton extraction for other code file types (Go, Rust, Java,
 * C/C++, Swift, Kotlin, etc.): extract import/include lines plus lines that
 * look like function/method/class/type declarations.
 *
 * This is intentionally conservative — it will include some non-signature lines
 * rather than accidentally drop real signatures.  Bodies are NOT elided for
 * unknown languages (too risky to get wrong); instead only likely-signature
 * lines are included and everything else is dropped.
 */
function extractGenericSkeleton(source: string): string {
  const lines = source.split('\n');
  const result: string[] = [];

  const IMPORT_RE =
    /^\s*(import|include|use|require|from|package|namespace|using|extern)\s/i;
  const DECL_RE =
    /^\s*(pub|public|private|protected|internal|extern|static|virtual|override|abstract|final|sealed|inline|func|fn|fun|def|class|struct|interface|trait|impl|type|enum|const|let|var|val|typedef|template|auto)\s/i;
  const DECORATOR_RE = /^\s*[@#\[]/; // decorators / attributes

  for (const line of lines) {
    const trimmed = line.trim();
    if (
      trimmed === '' ||
      IMPORT_RE.test(line) ||
      DECL_RE.test(line) ||
      DECORATOR_RE.test(line)
    ) {
      result.push(line);
    }
  }

  return result.join('\n');
}

// ─── Skeleton dispatch ─────────────────────────────────────────────────────────

/**
 * Extract a structural skeleton from source code at `filePath`.
 *
 * Language is determined by file extension:
 *   - TypeScript / JavaScript (.ts, .tsx, .js, .jsx, …): full body elision
 *   - Python (.py, .pyi): indentation-based body elision
 *   - Data formats (.json, .yaml, …): NEVER elided — returns null (caller falls back)
 *   - Everything else (Go, Rust, Java, C/C++, no extension, etc.): returns null
 *     (caller falls back to the normal bounded read path).
 *
 * Rationale for the unknown-language no-op:
 *   The generic extractor matched `const/var/val/let/type/…` lines which ALSO
 *   match in-body variable assignments (e.g. Go `var secret = "x"`), leaking
 *   body content. A skeleton that can leak bodies is worse than no skeleton at
 *   all.  Only languages with full body-elision support (TS/JS and Python)
 *   produce a skeleton; everything else is a safe no-op.
 *
 * Returns:
 *   - null   → caller must use the normal bounded read (data format, unknown
 *              language, or no/unrecognized extension)
 *   - string → the skeleton (may be empty for a trivial file)
 */
function extractSkeleton(filePath: string, source: string): string | null {
  const ext = path.extname(filePath).toLowerCase();

  // Data formats must never be body-stripped
  if (DATA_FORMAT_EXTENSIONS.has(ext)) return null;

  let skeleton: string;
  if (TS_JS_EXTENSIONS.has(ext)) {
    skeleton = extractTsJsSkeleton(source);
  } else if (PYTHON_EXTENSIONS.has(ext)) {
    skeleton = extractPythonSkeleton(source);
  } else {
    // Unknown/unsupported language (includes no-extension files like Dockerfile,
    // Go, Rust, Java, C/C++, etc.).  The old generic extractor could leak body
    // assignments, so we treat these as a safe no-op fallback.
    return null;
  }

  // Enforce byte cap
  const bytes = Buffer.byteLength(skeleton, 'utf8');
  if (bytes > SKELETON_MAX_BYTES) {
    // Trim to cap at a newline boundary
    const buf = Buffer.from(skeleton, 'utf8');
    const trimmed = buf.subarray(0, SKELETON_MAX_BYTES).toString('utf8');
    // Trim to last newline to avoid cutting a line mid-character
    const lastNewline = trimmed.lastIndexOf('\n');
    return (lastNewline > 0 ? trimmed.slice(0, lastNewline) : trimmed) +
      '\n// [skeleton truncated at SKELETON_MAX_BYTES]';
  }

  return skeleton;
}

// ─── Path-safety helpers (mirrors ArtifactQuery / FileAccessPolicy) ───────────

/**
 * Canonicalize a path: resolve symlinks via realpathSync where the file
 * exists; for a non-existent path, canonicalize the deepest existing ancestor
 * and re-join the missing tail segments.
 */
function canonicalPath(value: string): string {
  const resolvedPath = path.resolve(value);
  try {
    return fs.realpathSync(resolvedPath);
  } catch {
    let currentPath = resolvedPath;
    const missingSegments: string[] = [];
    while (!fs.existsSync(currentPath)) {
      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) return resolvedPath;
      missingSegments.unshift(path.basename(currentPath));
      currentPath = parentPath;
    }
    try {
      return path.join(fs.realpathSync(currentPath), ...missingSegments);
    } catch {
      return resolvedPath;
    }
  }
}

/**
 * Returns true iff `childPath` is inside (or equal to) `rootPath`.
 * Uses canonicalized paths and a separator-boundary check so that
 * `/artifacts-evil` does NOT match a root of `/artifacts`.
 */
function isPathInside(childPath: string, rootPath: string): boolean {
  const rel = path.relative(canonicalPath(rootPath), canonicalPath(childPath));
  return !rel || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolve the allowed roots for path-context checks.
 * Mirrors allowedArtifactRoots in ArtifactQuery but without the bead artifact
 * sub-directory — the path-context tool scopes to the whole worktree and
 * project root because it is a general file-discovery helper.
 */
function allowedRoots(projectRoot: string): string[] {
  const worktreePath =
    process.env[EnvVars.WORKTREE_PATH] ||
    process.env[EnvVars.PROJECT_ROOT] ||
    projectRoot;

  // Deduplicate in case worktree and project root coincide.
  const candidates = [
    canonicalPath(worktreePath),
    canonicalPath(projectRoot)
  ];
  const seen = new Set<string>();
  return candidates.filter(root => {
    if (seen.has(root)) return false;
    seen.add(root);
    return true;
  });
}

// ─── Nearest-match search ──────────────────────────────────────────────────────

/**
 * Score how similar `candidateName` is to `targetName` (both basenames).
 * Higher score = more similar. Pure heuristic — enough for actionable hints.
 */
function similarity(targetName: string, candidateName: string): number {
  const t = targetName.toLowerCase();
  const c = candidateName.toLowerCase();
  if (t === c) return 3;
  if (c.startsWith(t) || t.startsWith(c)) return 2;
  // Count shared leading characters
  let shared = 0;
  for (let index = 0; index < Math.min(t.length, c.length); index++) {
    if (t[index] === c[index]) shared++;
    else break;
  }
  return shared / Math.max(t.length, 1);
}

/**
 * Walk `rootDir` up to `maxFiles` entries and collect real files.
 * Returns paths relative to `rootDir` in posix form.
 */
function walkFiles(rootDir: string, maxFiles: number): string[] {
  const results: string[] = [];
  const queue: string[] = [rootDir];

  while (queue.length > 0 && results.length < maxFiles) {
    const current = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        // Skip hidden directories and common noise dirs
        if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
          queue.push(fullPath);
        }
      } else if (entry.isFile()) {
        results.push(path.relative(rootDir, fullPath));
      }
    }
  }

  return results;
}

/**
 * Find the closest existing files to `candidatePath` within `roots`.
 * Returns an array of relative paths (relative to the first matching root),
 * capped at PATH_CONTEXT_MAX_NEAR_MATCHES.
 */
function nearestMatches(candidatePath: string, roots: string[]): string[] {
  const targetBasename = path.basename(candidatePath);
  const targetDirname = path.dirname(candidatePath);

  const scored: Array<{ relativePath: string; score: number }> = [];
  const remaining = PATH_CONTEXT_MAX_SCAN_FILES;
  let scanned = 0;

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const files = walkFiles(root, remaining - scanned);
    scanned += files.length;

    for (const relFile of files) {
      const fileBasename = path.basename(relFile);
      const baseSim = similarity(targetBasename, fileBasename);

      // Also reward files in the same directory subtree
      const fileDir = path.dirname(relFile);
      const dirSim = similarity(targetDirname, fileDir) * 0.3;

      scored.push({ relativePath: relFile, score: baseSim + dirSim });
    }

    if (scanned >= remaining) break;
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, PATH_CONTEXT_MAX_NEAR_MATCHES)
    .filter(item => item.score > 0)
    .map(item => item.relativePath);
}

// ─── Line-counting helper ─────────────────────────────────────────────────────

/**
 * Count the number of newline-delimited lines in a file.
 * Returns 0 for empty files and throws for unreadable files.
 */
function countLines(filePath: string): number {
  const content = fs.readFileSync(filePath, 'utf8');
  if (!content) return 0;
  // Count newlines; a trailing newline means the last line is included in the split
  const lines = content.split('\n');
  // If the file ends with a newline, the last element is an empty string —
  // the conventional line count is lines - 1 in that case.
  if (lines.length > 0 && lines[lines.length - 1] === '') return lines.length - 1;
  return lines.length;
}

/**
 * Extract a bounded line slice from a file.
 * Lines are 1-indexed (line 1 = first line of the file).
 * Returns the lines as a single string with newlines preserved.
 */
function readSlice(filePath: string, startLine: number, endLine: number): string {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  // Clamp to valid range (1-indexed to 0-indexed)
  const from = Math.max(0, startLine - 1);
  const to = Math.min(lines.length, endLine);
  return lines.slice(from, to).join('\n');
}

// ─── Tool input / output types ────────────────────────────────────────────────

export interface PathContextInput {
  /** The candidate file path to inspect. May be absolute or relative to cwd. */
  filePath: string;
  /**
   * Optional 1-based line offset to validate. When provided, the response
   * indicates whether this offset is within the file and what the valid range is.
   */
  offset?: number;
  /**
   * Optional number of lines to request (used together with `offset`).
   * Capped at PATH_CONTEXT_MAX_SLICE_LINES.
   */
  limit?: number;
  /**
   * When true, return a language-aware structural skeleton of the file instead
   * of a bounded line slice.  The skeleton contains:
   *   - import/require statements
   *   - class/interface/type/enum declarations
   *   - function/method SIGNATURES with bodies elided (replaced by `{ ... }`)
   *   - exported symbol names
   *
   * Language detection is extension-based:
   *   - TypeScript/JavaScript: full body elision
   *   - Python: indentation-based body elision
   *   - Data formats (.json/.yaml/.toml/.md/…): skeleton is a NO-OP — the
   *     file is returned via the existing bounded read path
   *   - Other code languages / no-extension files: skeleton is a NO-OP (returns
   *     null / skeletonFallback:true). The old generic extractor leaked in-body
   *     variable assignments; safe no-op is preferable to a leaky skeleton.
   *
   * Output is capped at SKELETON_MAX_BYTES.
   * Mutually exclusive with `offset`/`limit` (skeleton ignores them when set).
   * Scope-check still applies — out-of-scope paths return 'out_of_scope'.
   */
  skeleton?: boolean;
}

/** Returned when the resolved path is outside the allowed scope. */
export interface PathContextOutOfScope {
  status: 'out_of_scope';
  reason: string;
  recovery: string[];
}

/** Returned when the path does not exist. */
export interface PathContextNotFound {
  status: 'not_found';
  exists: false;
  /** Path as provided (not resolved, to avoid leaking canonical system paths). */
  providedPath: string;
  nearestMatches: string[];
  recovery: string[];
}

/** Returned for a successful path resolution (file exists). */
export interface PathContextFound {
  status: 'found';
  exists: true;
  /** Canonical path relative to the matched root (stable reference for the model). */
  canonicalRelativePath: string;
  totalLines: number;
  /** Valid line-number range for native read calls. Always {min:1, max:totalLines}. */
  validOffsetRange: { min: number; max: number };
  /** Whether the requested offset (if any) is within the valid range. */
  requestedOffsetValid: boolean | null;
  /**
   * When a non-null offset was requested and is out of range, provides the
   * corrected first-valid range so the model knows exactly where to start.
   */
  correctedOffset: number | null;
  /**
   * When offset + limit are both provided and valid, contains the bounded text
   * slice (capped at PATH_CONTEXT_MAX_SLICE_LINES). Null otherwise.
   */
  slice: string | null;
  nearestMatches: string[];
  /**
   * When `skeleton:true` was requested AND the file is a recognized code type,
   * contains the structural skeleton (signatures/imports/declarations with
   * bodies elided). Null when skeleton mode was not requested, the file is a
   * data format, or the file is not readable.
   */
  skeletonContent: string | null;
  /**
   * True when `skeleton:true` was requested but no skeleton could be produced:
   * either the file is a data format (.json/.yaml/etc.) or the language is
   * unknown/unsupported (Go, Rust, no extension, etc.).  In both cases skeleton
   * mode is a safe no-op — no body stripping occurs.
   * In this case `slice` may be populated if offset+limit were also provided.
   */
  skeletonFallback: boolean;
}

export type PathContextResult = PathContextFound | PathContextNotFound | PathContextOutOfScope;

// ─── PathContext class ────────────────────────────────────────────────────────

export class PathContext {
  constructor(private readonly projectRoot: string) {}

  /**
   * Resolve a candidate path and validate optional read offsets.
   * Never throws — all errors produce structured results.
   */
  public resolve(input: PathContextInput): PathContextResult {
    try {
      return this.resolveInner(input);
    } catch (error) {
      // Defensive catch — should never be reached given internal try/catch guards.
      return {
        status: 'not_found',
        exists: false,
        providedPath: input.filePath,
        nearestMatches: [],
        recovery: [
          `An unexpected error occurred while resolving "${input.filePath}": ${String(error)}`,
          'Check the path and try again.'
        ]
      };
    }
  }

  private resolveInner(input: PathContextInput): PathContextResult {
    const roots = allowedRoots(this.projectRoot);

    // Resolve the candidate: absolute as-is, relative against cwd.
    const resolved = path.isAbsolute(input.filePath)
      ? input.filePath
      : path.resolve(input.filePath);

    // Scope check — must be inside at least one allowed root.
    const inScope = roots.some(root => isPathInside(resolved, root));
    if (!inScope) {
      return {
        status: 'out_of_scope',
        reason:
          'The requested path is outside the allowed roots for this context ' +
          '(active worktree and project root). ' +
          'Provide a path inside the worktree or project root.',
        recovery: [
          'Use a path relative to the active worktree or project root.',
          'Do not use "../" traversals to escape the allowed scope.',
          'Use get_artifact_paths for configured artifact locations.'
        ]
      };
    }

    const exists = fs.existsSync(resolved);

    if (!exists) {
      const candidates = nearestMatches(resolved, roots);
      return {
        status: 'not_found',
        exists: false,
        providedPath: input.filePath,
        nearestMatches: candidates,
        recovery: [
          `File "${input.filePath}" does not exist.`,
          candidates.length > 0
            ? `Nearest existing files: ${candidates.slice(0, 3).map(p => `"${p}"`).join(', ')}.`
            : 'No similar files found within the allowed roots.',
          'Check the path spelling or use the nearestMatches list to identify the correct file.'
        ]
      };
    }

    // Count lines — best-effort; treat directories or unreadable files gracefully.
    let totalLines = 0;
    let isReadableFile = false;
    try {
      const stat = fs.statSync(resolved);
      if (stat.isFile()) {
        totalLines = countLines(resolved);
        isReadableFile = true;
      }
    } catch {
      // Leave totalLines = 0, isReadableFile = false
    }

    // Compute canonical relative path (relative to the first matching root).
    const matchedRoot = roots.find(root => isPathInside(resolved, root)) ?? roots[0]!;
    const canonicalRelativePath = path.relative(matchedRoot, canonicalPath(resolved));

    const validOffsetRange = { min: 1, max: Math.max(1, totalLines) };

    // ── Skeleton mode ────────────────────────────────────────────────────────
    let skeletonContent: string | null = null;
    let skeletonFallback = false;

    if (input.skeleton && isReadableFile) {
      try {
        const source = fs.readFileSync(resolved, 'utf8');
        const result = extractSkeleton(resolved, source);
        if (result === null) {
          // Data format or unknown/unsupported language — skeleton is a no-op
          skeletonFallback = true;
        } else {
          skeletonContent = result;
        }
      } catch {
        // Best-effort — leave skeletonContent null
      }
    }

    // ── Validate optional offset (existing behavior) ──────────────────────────
    const hasOffset = input.offset !== undefined && input.offset !== null;
    let requestedOffsetValid: boolean | null = null;
    let correctedOffset: number | null = null;
    let slice: string | null = null;

    if (hasOffset && isReadableFile) {
      const requestedOffset = input.offset!;
      requestedOffsetValid = requestedOffset >= 1 && requestedOffset <= totalLines;

      if (!requestedOffsetValid) {
        // Suggest a corrected offset — use line 1 if before the start, or the
        // last valid line if beyond EOF.
        correctedOffset = requestedOffset < 1 ? 1 : totalLines;
      } else if (input.limit !== undefined) {
        // Produce a bounded slice when both offset and limit are valid.
        const cappedLimit = Math.min(
          Math.max(1, input.limit),
          PATH_CONTEXT_MAX_SLICE_LINES
        );
        const endLine = Math.min(requestedOffset + cappedLimit - 1, totalLines);
        try {
          slice = readSlice(resolved, requestedOffset, endLine);
        } catch {
          // Best-effort — leave slice null
        }
      }
    }

    return {
      status: 'found',
      exists: true,
      canonicalRelativePath,
      totalLines,
      validOffsetRange,
      requestedOffsetValid,
      correctedOffset,
      slice,
      nearestMatches: [],
      skeletonContent,
      skeletonFallback
    };
  }
}
