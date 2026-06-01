/**
 * Leaf module for branded primitive ID types.
 * This module intentionally has no imports from within this project,
 * making it safe to import from any layer including core domain modules.
 */

export type BeadId = string & { readonly __brand: unique symbol };
