/**
 * COMPILE-TIME type tests for orr-else/contract (pi-experiment-0yt5.15).
 *
 * This file is checked by `tsc --noEmit` (it lives under src/, which the build
 * compiles). Each `// @ts-expect-error` asserts that a forbidden shape is a
 * COMPILE ERROR — if the contract ever loosened to allow the shape, the
 * `@ts-expect-error` would itself become an unused-directive error and tsc would
 * fail, flagging the regression.
 *
 * There is no runtime behaviour here; these are pure type assertions. The
 * declarations are intentionally unused at runtime.
 */

import {
  VerifyVerdict,
  type ToolResultBase,
  type VerifyResult,
  type VerifyContext
} from './contract.js';

// ---------------------------------------------------------------------------
// AC2: ToolResultBase has EXACTLY 5 fields and NO verdict.
// ---------------------------------------------------------------------------

// A well-formed ToolResultBase compiles.
export const okResult: ToolResultBase = {
  tool: 't',
  status: 'PASSED',
  outputFile: '/tmp/out.json',
  outputFileBytes: 123
};

// Adding a `verdict` property is a COMPILE ERROR (excess property).
export const resultWithVerdict: ToolResultBase = {
  tool: 't',
  status: 'PASSED',
  // @ts-expect-error — ToolResultBase must NOT carry a verdict field.
  verdict: 'PASS',
  outputFile: '/tmp/out.json',
  outputFileBytes: 123
};

// ---------------------------------------------------------------------------
// AC3: VerifyResult.verdict is the VerifyVerdict enum and is NEVER null.
//      It exposes reasons:string[] + optional failureOutcome.
// ---------------------------------------------------------------------------

export const okVerify: VerifyResult = {
  verdict: VerifyVerdict.PASS,
  reasons: ['looks good'],
  failureOutcome: 'advisory'
};

// reasons + verdict are sufficient; failureOutcome is optional.
export const okVerifyMinimal: VerifyResult = {
  verdict: VerifyVerdict.NOT_APPLICABLE,
  reasons: []
};

// verdict cannot be null.
export const verifyNullVerdict: VerifyResult = {
  // @ts-expect-error — VerifyResult.verdict is NEVER null.
  verdict: null,
  reasons: []
};

// There is NO boolean `pass` field — a literal supplying `pass` is excess.
export const verifyWithPass: VerifyResult = {
  verdict: VerifyVerdict.FAIL,
  reasons: ['nope'],
  // @ts-expect-error — VerifyResult has no boolean `pass` field.
  pass: false
};

// ---------------------------------------------------------------------------
// AC4: VerifyContext is PATHS-ONLY. artifacts/toolOutputs are
//      Record<string,string>; a {path,bytes}/{outputFile,outputFileBytes}
//      shape is a compile error, and there is no bytes/status field.
// ---------------------------------------------------------------------------

export const okContext: VerifyContext = {
  beadId: 'b',
  stateId: 's',
  actionId: 'a',
  writeSet: ['/w/one'],
  artifacts: { plan: '/path/to/plan' },
  toolOutputs: { read_path_context: '/path/to/output.json' }
};

// artifacts values are PATHS (strings), not {path,bytes} objects.
export const ctxArtifactObjectShape: VerifyContext = {
  beadId: 'b',
  stateId: 's',
  actionId: 'a',
  writeSet: [],
  // @ts-expect-error — artifacts is Record<string,string>, NOT {path,bytes}.
  artifacts: { plan: { path: '/path', bytes: 10 } },
  toolOutputs: {}
};

// toolOutputs values are PATHS (strings), not {outputFile,outputFileBytes}.
export const ctxToolOutputObjectShape: VerifyContext = {
  beadId: 'b',
  stateId: 's',
  actionId: 'a',
  writeSet: [],
  artifacts: {},
  // @ts-expect-error — toolOutputs is Record<string,string>, NOT {outputFile,outputFileBytes}.
  toolOutputs: { t: { outputFile: '/o', outputFileBytes: 5 } }
};

// There is NO `bytes` field and NO `status` field on the context itself.
export const ctxWithBytes: VerifyContext = {
  beadId: 'b',
  stateId: 's',
  actionId: 'a',
  writeSet: [],
  artifacts: {},
  toolOutputs: {},
  // @ts-expect-error — VerifyContext has no `bytes` field.
  bytes: 10
};

export const ctxWithStatus: VerifyContext = {
  beadId: 'b',
  stateId: 's',
  actionId: 'a',
  writeSet: [],
  artifacts: {},
  toolOutputs: {},
  // @ts-expect-error — VerifyContext has no `status` field (status is read from the persisted event).
  status: 'PASSED'
};
