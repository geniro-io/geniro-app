import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';

import type { HostPluginProposal } from '../../agents/chat.types';
import { PluginProposalBroker } from '../../agents/services/plugin-proposal.broker';
import type { PluginRunnerService } from './plugin-runner.service';
import { PluginStoreService } from './plugin-store.service';
import { PluginsService } from './plugins.service';

const TEXT = stringify({
  name: 'Deploys',
  command: 'echo {}',
  view: [{ id: 'root', component: 'Text', text: 'hi' }],
});

function proposal(
  change: Partial<HostPluginProposal> = {},
): HostPluginProposal {
  return {
    slug: 'deploys',
    name: 'Deploys',
    text: TEXT,
    previousText: null,
    baseHash: null,
    command: 'echo {}',
    folders: [],
    refreshMinutes: 5,
    timeoutSeconds: 30,
    buttons: [],
    view: [{ id: 'root', component: 'Text', text: 'hi' }],
    sample: null,
    ...change,
  };
}

describe('PluginsService', () => {
  let root: string;
  let store: PluginStoreService;
  let forget: ReturnType<typeof vi.fn>;
  let broker: PluginProposalBroker;
  let service: PluginsService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'geniro-plugins-service-'));
    store = new PluginStoreService({ pluginsDir: join(root, 'plugins') });
    forget = vi.fn();
    broker = new PluginProposalBroker();
    service = new PluginsService(
      store,
      { forget, lastRunAt: () => null } as unknown as PluginRunnerService,
      broker,
    );
    service.onModuleInit();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes an approved card through the broker: file and approved copy, results forgotten', async () => {
    const outcome = await broker.write(proposal());

    expect(outcome).toEqual({
      status: 'saved',
      slug: 'deploys',
      path: store.pathOf('deploys'),
    });
    expect((await store.get('deploys'))?.state).toBe('approved');
    expect(forget).toHaveBeenCalledWith('deploys');
  });

  it('answers stale, writing nothing, when the file moved on from the hash the card read', async () => {
    await store.write('deploys', TEXT, { approve: false });

    const outcome = await broker.write(proposal({ baseHash: null }));

    expect(outcome).toMatchObject({ status: 'stale' });
    expect((await store.get('deploys'))?.state).toBe('changed');
  });

  it('rethrows a failure that is not a refusal', async () => {
    vi.spyOn(store, 'write').mockRejectedValueOnce(new Error('disk on fire'));

    await expect(service.saveApproved(proposal())).rejects.toThrow(
      'disk on fire',
    );
  });

  it('forgets the results of a plugin it approves, re-folders or deletes', async () => {
    const stored = await store.write('deploys', TEXT, { approve: false });

    const approved = await service.approve('deploys', stored.hash);
    await service.patch('deploys', {
      folders: [root],
      baseHash: approved.hash,
    });
    await service.delete('deploys');

    expect(forget).toHaveBeenCalledTimes(3);
  });

  it('says the daemon cannot write plugins when no writer is installed', async () => {
    await expect(new PluginProposalBroker().write(proposal())).resolves.toEqual(
      {
        status: 'stale',
        reason: 'this daemon cannot write plugins',
      },
    );
  });
});
