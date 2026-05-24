#!/usr/bin/env node

const message = `
Orr Else is a pi.dev extension. The current Pi session becomes the coordinator, and teammates run as spawned Pi processes in tmux.

Load it with:
  pi -e .pi/extensions/orr-else.ts

Then start the orchestrator inside that Pi session:
  /orr-else

Useful variants:
  /orr-else --max-slots 6
  /orr-else --bead <id>
  /orr-else status
  /orr-else stop

Observe teammates with:
  tmux attach -t orr-else
`.trim();

console.log(message);
