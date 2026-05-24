# Orr Else Control Plane Tools

The following tools are part of the core harness infrastructure. They manage your state, progress, and communication with the Team Lead.

## 1. Progress Management

- **`tick_item(text, evidence)`**: Marks a checklist item as completed. 
- **`get_outstanding_tasks()`**: Lists all mandatory tasks that haven't been programmatically satisfied yet.
- **`submit_checkpoint(summary, evidence)`**: Saves a formal record of your current progress without transitioning state.

## 2. State Transitions

- **`signal_completion(outcome, summary)`**: Signifies that your work in this phase is done. Triggers a programmatic audit of your turn.
  - **`SUCCESS`**: Triggers a SUCCESS transition in the state machine (checklist must be satisfied).
  - **`FAILURE`**: Signals a terminal implementation failure.
  - **`BLOCKED`**: Signals that you are unable to proceed due to external factors.

## 3. Communication

- **`send_mailbox_message(to, beadId, type, content)`**: Sends an async message to another agent or the coordinator.
- **`check_mailbox()`**: Checks for incoming steering or info messages from the Team Lead.

## 4. Lifecycle

- **`request_context_restart(summary)`**: Use this if the Pi session context is too polluted to continue reliably. 
- **`harness_status()`**: Report the active flow state and your current turn details.
