# Runtime Budget Policy (pi-experiment-6q0y.48)

## Overview

The runtime budget policy is an **optional, harness-owned** enforcement mechanism for
per-bead / per-state / per-action cumulative runtime spend limits.

**Inactive by default.** A harness with no `runtimeBudget` configuration behaves
identically to one without this feature — there are no warnings, no rejections, and
no events emitted.

**The LLM is not asked to self-report budget compliance.** Budget tracking and
enforcement is entirely harness-side, driven by the lifecycle event stream
(model calls, provider token usage, wall-clock time, tool failures, retries,
verifier gate rejections, tool-result payload bytes).

## Configuring a runtime budget

Runtime budget policies may be declared at three scopes with the precedence
`action > state > settings` (innermost wins — no merging):

```yaml
# settings-level (global default, lowest precedence)
settings:
  runtimeBudget:
    maxModelCalls: 10
    maxWallClockMs: 300000   # 5 minutes
    route: BUDGET_EXCEEDED   # must be a declared statechart outcome

# state-level (overrides settings)
states:
  Implementation:
    runtimeBudget:
      maxProviderTotalTokens: 500000
      maxRetries: 5
      route: FAILURE

    actions:
      - id: write_code
        # action-level (highest precedence)
        runtimeBudget:
          maxToolFailures: 3
          maxVerifierFailures: 2
          route: FAILURE
```

All dimension fields are optional. Omitting a field means no limit for that
dimension. An entirely absent `runtimeBudget` at all three scopes means zero
configured budgets (full no-op).

## Supported dimensions

| Field | Description | Checked before |
|---|---|---|
| `maxModelCalls` | Total model-request count | Each provider request |
| `maxEstimatedInputTokens` | Cumulative estimated input tokens (ceil(bytes/4)) | Each provider request |
| `maxProviderTotalTokens` | Cumulative provider-reported total tokens | Each provider request |
| `maxWallClockMs` | Wall-clock elapsed ms since worker-run start | Each provider request |
| `maxRetries` | Cumulative retry count across all tool invocations | Each retry admission |
| `maxToolFailures` | Cumulative tool invocation failure count | After each tool failure |
| `maxVerifierFailures` | Cumulative verifier-gate rejection count | After each gate rejection |
| `maxToolPayloadBytes` | Cumulative tool-result payload bytes sent to model | Before each tool result |

## Enforcement

When a hard limit is exceeded, the harness:

1. Emits a `RUNTIME_BUDGET_EXCEEDED` event carrying `budgetId`, `dimension`,
   `currentValue`, `limit`, identity fields, and `nextRoute`. No prompt body or
   raw tool output is included.
2. Routes the bead through the configured `route` (deterministic outcome) via
   `postWorkerSignal` — exactly the same mechanism as prompt-budget enforcement
   (pi-experiment-6q0y.17).
3. Fails before the next model/provider/tool spend.

## Startup lint (AC6)

ConfigLoader rejects configurations that declare:
- Negative limits (any dimension field < 0)
- Unknown routes (absent from the statechart outcome vocabulary)
- Policies on unknown states or actions (AJV schema enforcement)
- Outcomes absent from the declared statechart vocabulary

## No LLM self-reporting

The budget enforcement is fully harness-owned. The harness does **not**:
- Instruct the LLM to track its own token usage
- Ask the model to stop after N calls
- Include budget state in any prompt surface

The LLM receives the normal `route` outcome (e.g. `FAILURE`) through the
standard transition mechanism — it does not see budget-specific messaging.
