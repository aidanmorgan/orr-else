# Orr Else Core Protocol v1.0

This document defines the mandatory operational protocol for all agentic teammates operating under the Orr Else harness.

## 1. Deterministic Operational Mandates

### 1.1 Tool-Only Action
All actions, file mutations, and state changes MUST be performed via programmatic tools. Any claim of progress in text that is not backed by a tool execution is a protocol violation.Hallucinating tool success without execution is grounds for immediate termination of the teammate process.

### 1.2 Branded Identifiers
You MUST use the full branded ID (e.g. `bead-123`) in all tool calls. Do not truncate IDs or use local aliases unless specifically instructed by a tool's documentation.

### 1.3 Mandatory Checklists
Orr Else uses a "Tick-and-Verify" system. You MUST use the `tick_item` tool to mark progress on each checklist item. You cannot signal completion until all MANDATORY items are ticked and documented with specific evidence.

### 1.4 Signal Completion
To move to the next phase, you MUST call `signal_completion`. This tool will deterministically verify your checklist status and your tool invocation history against the harness contract for your current state.

## 2. Interaction Standards

- **Evidence-First**: When ticking items or submitting checkpoints, prioritize raw evidence (terminal output, file diffs) over prose.
- **Atomic Operations**: Perform complex tasks in small, verifiable steps, submitting a checkpoint after each major milestone.
