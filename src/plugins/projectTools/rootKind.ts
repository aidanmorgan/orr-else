/**
 * Plugin-layer extensions for the project-tool root kind vocabulary.
 *
 * pi-experiment-amq0.19: The authoritative ProjectToolRootKind const and
 * ProjectToolBuiltinRootKind type live in src/constants/domain.ts (shared
 * layer). This module re-exports them for plugin-internal convenience and
 * adds the plugin-only resolved-root kind type and builtin-kind set.
 *
 * Package-internal — do not import from outside src/plugins/.
 */

// Re-export the shared-layer vocabulary so plugin modules can import from here.
export { ProjectToolRootKind, type ProjectToolBuiltinRootKind } from '../../constants/domain.js';

/**
 * Set of all built-in root kind values (for fast membership tests at runtime).
 * Derived from the shared-layer const — not a duplicate definition.
 */
export const BUILTIN_ROOT_KINDS = new Set<string>(['worktree', 'project', 'framework', 'workspace']);

/**
 * The kind value on a resolved path-argument root.
 *
 * For built-in roots (worktree/project/framework/workspace) this is one of the
 * four `ProjectToolBuiltinRootKind` literals. For named roots declared in
 * settings.roots it is the name string supplied by the caller (validated at
 * startup by ConfigValidator.validateNamedRoots to be a declared key).
 *
 * There is NO 'configured' variant — that fallback was removed with no backcompat.
 */
export type ResolvedRootKind = import('../../constants/domain.js').ProjectToolBuiltinRootKind | string;
