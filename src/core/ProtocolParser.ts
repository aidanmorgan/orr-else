import { BuiltInToolName, ChecklistItemType } from '../constants/index.js';

export type ChecklistType = ChecklistItemType;

export interface ChecklistItem {
  id?: string;
  text: string;
  mandatory: boolean;
  type?: ChecklistType;
  tool?: string;
  script?: string;
  checked?: boolean;
  evidence?: string;
  [key: string]: unknown;
}

export class ProtocolParser {
  public generatePrompt(requiredItems: ChecklistItem[]): string {
    const items = requiredItems.map(req => {
      let suffix = '(MANDATORY)';
      if (!req.mandatory) suffix = '(OPTIONAL)';
      if (req.type === ChecklistItemType.TOOL) suffix = '(HARNESS TOOL CHECK)';
      if (req.type === ChecklistItemType.SCRIPT) suffix = '(HARNESS SCRIPT CHECK)';
      
      return `- ${req.text} ${suffix}`;
    }).join('\n');

    return `
### MANDATORY PROTOCOL: TICK CHECKLIST ITEMS
To complete this task, you MUST use the \`${BuiltInToolName.TICK_ITEMS}\` tool to record evidence for completed checklist items. Prefer one batched call for all completed items; use \`${BuiltInToolName.TICK_ITEM}\` only for a single-item compatibility update.

${items}

Once all mandatory items are ticked, you MUST call \`${BuiltInToolName.SUBMIT_CHECKPOINT}\` with your final summary to proceed.
    `.trim();
  }
}
