import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { EventStore } from '../src/core/EventStore.js';
import { createMailboxPlugin } from '../src/plugins/mailbox.js';
import { PluginToolName } from '../src/constants/domain.js';
import { Defaults, EnvVars } from '../src/constants/infra.js';
import type { RuntimeEnvironment } from '../src/core/RuntimeEnvironment.js';
import type { MailboxListResult } from '../src/core/Mailbox.js';

// Test RuntimeEnvironment whose env() returns ONLY the supplied keys.
function fakeEnv(vars: Record<string, string | undefined>): RuntimeEnvironment {
  return { env: (name: string) => vars[name] };
}

function tool(plugin: ReturnType<typeof createMailboxPlugin>, name: string) {
  const t = plugin.tools.find(x => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

describe('mailbox plugin — check_mailbox identity resolution', () => {
  let projectRoot: string;
  let eventStore: EventStore;

  beforeEach(() => {
    projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-mailbox-plugin-')));
    eventStore = new EventStore(new ConfigLoader());
  });

  afterEach(() => {
    if (fs.existsSync(projectRoot)) fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  // AC2: the recipient param is honored — TeamLead's mail is returned, not the
  // Defaults.API_HOST fallback identity.
  it('honors the recipient param and lists that recipient\'s messages', async () => {
    // Inject a WORKER_ID that is DIFFERENT from the recipient we will pass, to
    // prove the param wins over the env var (and over any fallback).
    const env = fakeEnv({ [EnvVars.WORKER_ID]: 'SomeOtherWorker' });
    const plugin = createMailboxPlugin(eventStore, projectRoot, env);

    const send = tool(plugin, PluginToolName.SEND_MAILBOX_MESSAGE);
    await send.execute({ to: 'TeamLead', beadId: 'b1', type: 'INFO', content: 'for the lead' });
    await send.execute({ to: 'SomeOtherWorker', beadId: 'b2', type: 'INFO', content: 'for the worker' });

    const check = tool(plugin, PluginToolName.CHECK_MAILBOX);
    const result = (await check.execute({ recipient: 'TeamLead' })) as MailboxListResult;

    expect(result.count).toBe(1);
    expect(result.messages[0].to).toBe('TeamLead');
    // It must NOT have resolved to the env worker id or to the API_HOST fallback.
    expect(result.messages.every(m => m.to !== Defaults.API_HOST)).toBe(true);
    expect(result.messages.every(m => m.to !== 'SomeOtherWorker')).toBe(true);
  });

  // AC2: with no recipient param, identity falls back to the injected env WORKER_ID
  // (NOT process.env, NOT Defaults.API_HOST).
  it('falls back to the injected RuntimeEnvironment WORKER_ID when no recipient param', async () => {
    const env = fakeEnv({ [EnvVars.WORKER_ID]: 'WorkerSeven' });
    const plugin = createMailboxPlugin(eventStore, projectRoot, env);

    const send = tool(plugin, PluginToolName.SEND_MAILBOX_MESSAGE);
    await send.execute({ to: 'WorkerSeven', beadId: 'b1', type: 'INFO', content: 'hello seven' });

    const check = tool(plugin, PluginToolName.CHECK_MAILBOX);
    const result = (await check.execute({})) as MailboxListResult;

    expect(result.count).toBe(1);
    expect(result.messages[0].to).toBe('WorkerSeven');
  });

  // AC3 (NEGATIVE / fail-closed): WORKER_ID unset AND no recipient — must NOT
  // silently fall back to a wrong identity (Defaults.API_HOST). It must error.
  it('fails closed when neither recipient param nor WORKER_ID is available', async () => {
    const env = fakeEnv({}); // WORKER_ID unset in the injected environment
    const plugin = createMailboxPlugin(eventStore, projectRoot, env);

    // Seed mail addressed to the API_HOST fallback identity. If the old buggy
    // fallback were in place, check_mailbox would leak THIS message.
    const send = tool(plugin, PluginToolName.SEND_MAILBOX_MESSAGE);
    await send.execute({ to: Defaults.API_HOST, beadId: 'b1', type: 'INFO', content: 'fallback leak' });

    const check = tool(plugin, PluginToolName.CHECK_MAILBOX);
    await expect(check.execute({})).rejects.toThrow(/cannot resolve recipient identity/i);
  });
});
