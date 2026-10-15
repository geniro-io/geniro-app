import { createDecipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { BadRequestException } from '@packages/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ArtifactPageService } from '../../agents/services/artifact-page.service';
import type { ArtifactStoreService } from '../../agents/services/artifact-store.service';
import type { ManagedCommandResult } from '../../agents/utils/managed-command';
import { ArtifactShareDao } from '../dao/artifact-share.dao';
import { ArtifactShare } from '../entity/artifact-share.entity';
import type {
  ShareCommandRunner,
  ShareConfig,
  ShareDestination,
} from '../shares.types';
import { ShareService } from './share.service';
import type { ShareKeychain } from './share-keychain.service';

const RUN = '11111111-2222-4333-8444-555555555555';
const GCS: ShareDestination = {
  kind: 'gcs',
  id: 'company',
  name: 'Company',
  linkBase: 'https://artifacts.example.com',
  bucket: 'company-share',
  prefix: 'geniro',
};
const CONFIG: ShareConfig = {
  destinations: [GCS],
  defaultDestinationId: 'company',
  agentsMayShare: true,
};

function ok(partial: Partial<ManagedCommandResult> = {}): ManagedCommandResult {
  return { code: 0, stdout: '', stderr: '', timedOut: false, ...partial };
}

/** The plaintext an uploaded envelope decrypts to under `key`. */
function decryptEnvelope(envelope: string, key: string): string {
  const match =
    /<script id="payload" type="application\/json">([^<]*)<\/script>/.exec(
      envelope,
    );
  const { iv, ct } = JSON.parse(match?.[1] ?? '{}') as {
    iv: string;
    ct: string;
  };
  const data = Buffer.from(ct, 'base64url');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(key, 'base64url'),
    Buffer.from(iv, 'base64url'),
  );
  decipher.setAAD(Buffer.from('geniro-share-v1'));
  decipher.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([
    decipher.update(data.subarray(0, data.length - 16)),
    decipher.final(),
  ]).toString('utf8');
}

function nth<T>(list: readonly T[], index: number): T {
  const item = list[index];
  if (item === undefined) {
    throw new Error(`no item ${index}`);
  }
  return item;
}

describe('ShareService', () => {
  let orm: MikroORM;
  let service: ShareService;
  let dao: ArtifactShareDao;
  let keys: Map<string, string>;
  let version: number;
  /** Every command run, with the uploaded envelope captured at upload time. */
  let commands: { args: string[]; envelope?: string }[];
  let nextResult: (args: string[]) => ManagedCommandResult;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        dbName: ':memory:',
        entities: [ArtifactShare],
        allowGlobalContext: true,
        namingStrategy: UnderscoreNamingStrategy,
      }),
    );
    await orm.schema.create();
  });

  afterAll(async () => {
    await orm.close(true);
  });

  beforeEach(async () => {
    await orm.schema.clear();
    keys = new Map();
    version = 1;
    commands = [];
    nextResult = () => ok();
    dao = new ArtifactShareDao(orm.em.fork());
    const run: ShareCommandRunner = (command) => {
      const upload = command.args.includes('cp');
      commands.push({
        args: [command.command, ...command.args],
        ...(upload
          ? {
              envelope: readFileSync(
                command.args.find((arg) => arg.startsWith('/')) ?? '',
                'utf8',
              ),
            }
          : {}),
      });
      return Promise.resolve(nextResult(command.args));
    };
    service = new ShareService(
      dao,
      {
        latest: (runId: string, artifactId: string) =>
          runId === RUN && artifactId === 'report'
            ? { version, key: 'serving-key' }
            : null,
      } as unknown as ArtifactStoreService,
      {
        document: (_r: string, _a: string, v: number) =>
          `<!DOCTYPE html><html><head></head><body><p>secret-report v${v}</p></body></html>`,
      } as unknown as ArtifactPageService,
      {
        write: (id: string, key: string) => {
          keys.set(id, key);
          return Promise.resolve();
        },
        read: (id: string) => Promise.resolve(keys.get(id) ?? null),
        delete: (id: string) => {
          keys.delete(id);
          return Promise.resolve();
        },
      } as unknown as ShareKeychain,
      run,
    );
  });

  const share = (by: 'user' | 'agent' = 'user') =>
    service.share({ runId: RUN, artifactId: 'report', title: 'Report', by });

  it('shares nothing before Electron main has pushed the settings', async () => {
    await expect(share()).rejects.toThrow(/have not reached the daemon/);
    expect(commands).toHaveLength(0);
  });

  it('uploads only ciphertext, which the link’s own key decrypts back to the page', async () => {
    service.setConfig(CONFIG);

    const { url, share: row } = await share();

    const key = /#k=(.+)$/.exec(url)?.[1] ?? '';
    expect(url).toMatch(
      /^https:\/\/artifacts\.example\.com\/geniro\/[0-9a-f]{32}\/index\.html#k=[A-Za-z0-9_-]{43}$/,
    );
    const upload = nth(commands, 0);
    expect(upload.args.slice(0, 3)).toEqual(['gcloud', 'storage', 'cp']);
    expect(upload.envelope).not.toContain('secret-report');
    expect(decryptEnvelope(upload.envelope ?? '', key)).toContain(
      'secret-report v1',
    );
    expect(keys.get(row.id)).toBe(key);
    expect(row).toMatchObject({
      sharedVersion: 1,
      sharedBy: 'user',
      status: 'live',
    });
  });

  it('re-sharing keeps the link and uploads the newer version to the same object', async () => {
    service.setConfig(CONFIG);
    const first = await share();
    version = 2;

    const second = await share('agent');

    expect(second.url).toBe(first.url);
    expect(nth(commands, 1).args.at(-1)).toBe(nth(commands, 0).args.at(-1));
    const key = /#k=(.+)$/.exec(second.url)?.[1] ?? '';
    expect(decryptEnvelope(nth(commands, 1).envelope ?? '', key)).toContain(
      'v2',
    );
    expect(await service.list(RUN)).toEqual([
      expect.objectContaining({ sharedVersion: 2, sharedBy: 'agent' }),
    ]);
  });

  it('a failed first upload leaves no row and no key behind, and says why', async () => {
    service.setConfig(CONFIG);
    nextResult = () =>
      ok({ code: 1, stderr: 'ERROR: 403 permission denied\n' });

    // A 4xx: the exception filter would replace a 5xx's reason with a generic one.
    await expect(share()).rejects.toBeInstanceOf(BadRequestException);
    await expect(share()).rejects.toThrow(/403 permission denied/);

    expect(await service.list()).toEqual([]);
    expect(keys.size).toBe(0);
  });

  it('two presses at once share once, through the per-page lock', async () => {
    service.setConfig(CONFIG);

    const [a, b] = await Promise.all([share(), share()]);

    expect(a.url).toBe(b.url);
    expect(await service.list()).toHaveLength(1);
  });

  describe('revoke', () => {
    it('deletes the object, then the key, then the row', async () => {
      service.setConfig(CONFIG);
      const { share: row } = await share();

      expect(await service.revoke(row.id)).toEqual({ status: 'revoked' });

      expect(nth(commands, 1).args.slice(0, 3)).toEqual([
        'gcloud',
        'storage',
        'rm',
      ]);
      expect(keys.has(row.id)).toBe(false);
      expect(await service.list()).toEqual([]);
    });

    it('keeps the row and the key when the remote delete fails, so a retry can still delete it', async () => {
      service.setConfig(CONFIG);
      const { share: row } = await share();
      nextResult = () => ok({ code: 1, stderr: 'ERROR: network unreachable' });

      expect(await service.revoke(row.id)).toEqual({
        status: 'revoke-failed',
        detail: 'ERROR: network unreachable',
      });

      expect(keys.has(row.id)).toBe(true);
      expect(await service.list()).toEqual([
        expect.objectContaining({ status: 'revoke-failed' }),
      ]);
    });

    it('treats gcloud’s “matched no objects” as already revoked', async () => {
      service.setConfig(CONFIG);
      const { share: row } = await share();
      nextResult = () =>
        ok({
          code: 1,
          stderr:
            'ERROR: (gcloud.storage.rm) The following URLs matched no objects or files:\n-gs://x',
        });

      expect(await service.revoke(row.id)).toEqual({ status: 'revoked' });
      expect(await service.list()).toEqual([]);
    });

    it('keeps the key when a revoke timed out, whatever its output said', async () => {
      service.setConfig(CONFIG);
      const { share: row } = await share();
      nextResult = () =>
        ok({ code: null, timedOut: true, stderr: 'No URLs matched' });

      expect(await service.revoke(row.id)).toMatchObject({
        status: 'revoke-failed',
      });
      expect(keys.has(row.id)).toBe(true);
    });

    it.each([
      [
        'a custom command',
        {
          kind: 'command',
          id: 'own',
          name: 'Own',
          linkBase: 'https://pages.example.com',
          upload: ['/usr/local/bin/put', '{file}', '{object}'],
          remove: ['/usr/local/bin/del', '{object}'],
        },
      ],
      [
        's3',
        {
          kind: 's3',
          id: 'own',
          name: 'Own',
          linkBase: 'https://pages.example.com',
          bucket: 'pages',
        },
      ],
    ] satisfies [string, ShareDestination][])(
      'judges %s by its exit status, even when its output reads like gcloud’s “gone”',
      async (_kind, own) => {
        service.setConfig({
          destinations: [own],
          defaultDestinationId: 'own',
          agentsMayShare: true,
        });
        const { share: row } = await share();
        nextResult = () => ok({ code: 1, stderr: 'ERROR: No URLs matched' });

        expect(await service.revoke(row.id)).toMatchObject({
          status: 'revoke-failed',
        });
        expect(keys.has(row.id)).toBe(true);
      },
    );

    it('revokes once when two revokes race, the second finding the row gone', async () => {
      service.setConfig(CONFIG);
      const { share: row } = await share();

      const results = await Promise.all([
        service.revoke(row.id),
        service.revoke(row.id),
      ]);

      expect(results).toEqual([{ status: 'revoked' }, { status: 'revoked' }]);
      expect(commands.filter((c) => c.args.includes('rm'))).toHaveLength(1);
    });

    it('treats an object already gone as revoked', async () => {
      service.setConfig(CONFIG);
      const { share: row } = await share();
      nextResult = () => ok({ code: 1, stderr: 'ERROR: No URLs matched' });

      expect(await service.revoke(row.id)).toEqual({ status: 'revoked' });
    });

    it('revokes from where the page was shared even after the destination left Settings', async () => {
      service.setConfig(CONFIG);
      const { share: row } = await share();
      service.setConfig({
        ...CONFIG,
        destinations: [],
        defaultDestinationId: null,
      });

      await service.revoke(row.id);

      expect(nth(commands, 1).args).toContain(
        nth(commands, 0).args.at(-1) ?? 'missing',
      );
    });
  });

  describe('shareForAgent', () => {
    const agent = (remote = false) =>
      service.shareForAgent(
        { runId: RUN, artifactId: 'report', title: 'Report' },
        remote,
      );

    it.each([
      ['a paired device', CONFIG, true, /only available on the Mac/],
      [
        'the switch off',
        { ...CONFIG, agentsMayShare: false },
        false,
        /not allowed agents/,
      ],
      [
        'no default destination',
        { ...CONFIG, defaultDestinationId: null },
        false,
        /no default place/,
      ],
    ])(
      'refuses with %s and uploads nothing',
      async (_name, config, remote, reason) => {
        service.setConfig(config);

        const outcome = await agent(remote);

        expect(outcome).toEqual({
          kind: 'not-shared',
          reason: expect.stringMatching(reason),
        });
        expect(commands).toHaveLength(0);
      },
    );

    it('returns the link when allowed, recorded as shared by the agent', async () => {
      service.setConfig(CONFIG);

      const outcome = await agent();

      expect(outcome).toEqual({
        kind: 'shared',
        url: expect.stringContaining('#k='),
      });
      expect(await service.list()).toEqual([
        expect.objectContaining({ sharedBy: 'agent' }),
      ]);
    });

    it('turns a failed upload into a reason rather than an error', async () => {
      service.setConfig(CONFIG);
      nextResult = () => ok({ code: 1, stderr: 'gcloud: not logged in' });

      expect(await agent()).toEqual({
        kind: 'not-shared',
        reason: expect.stringContaining('not logged in'),
      });
    });

    it('bakes in the theme of the user’s last press', async () => {
      service.setConfig(CONFIG);
      await service.share({
        runId: RUN,
        artifactId: 'report',
        title: 'Report',
        by: 'user',
        themeVars: { '--geniro-bg': '#123456' },
      });
      version = 2;

      const outcome = await agent();

      const key =
        outcome.kind === 'shared'
          ? (/#k=(.+)$/.exec(outcome.url)?.[1] ?? '')
          : '';
      expect(decryptEnvelope(nth(commands, 1).envelope ?? '', key)).toContain(
        '--geniro-bg: #123456;',
      );
    });
  });

  it('still lists a row whose destination cannot be read, and says why it cannot link', async () => {
    const row = await dao.create({
      runId: RUN,
      artifactId: 'broken',
      title: 'Broken',
      destination: '{',
      objectId: 'obj',
      linkBase: 'https://x.example',
      sharedVersion: 1,
      sharedBy: 'user',
    });
    keys.set(row.id, 'k'.repeat(43));

    expect(await service.list()).toEqual([
      expect.objectContaining({ id: row.id, destinationName: '' }),
    ]);
    await expect(service.link(row.id)).rejects.toThrow(/could not be read/);
  });

  describe('link', () => {
    it('reads back the same link the share returned', async () => {
      service.setConfig(CONFIG);
      const { url, share: row } = await share();

      expect(await service.link(row.id)).toEqual({ url });
    });

    it('refuses an unknown share', async () => {
      await expect(service.link('nope')).rejects.toThrow(/no such shared page/);
    });

    it('says the key is gone rather than minting a new one, for the link and a re-share', async () => {
      service.setConfig(CONFIG);
      const { share: row } = await share();
      keys.delete(row.id);

      await expect(service.link(row.id)).rejects.toThrow(
        /no longer in the Keychain/,
      );
      await expect(share()).rejects.toThrow(/no longer in the Keychain/);
      expect(keys.size).toBe(0);
    });
  });

  it('passes a test of an empty place that gcloud reports as matching nothing', async () => {
    nextResult = () =>
      ok({ code: 1, stderr: 'ERROR: One or more URLs matched no objects.' });
    expect(await service.probe(GCS)).toEqual({
      ok: true,
      detail: 'Reached Company.',
    });
  });

  it('tests a destination with a read-only listing', async () => {
    nextResult = () => ok();
    expect(await service.probe(GCS)).toEqual({
      ok: true,
      detail: 'Reached Company.',
    });
    expect(nth(commands, 0).args).toEqual([
      'gcloud',
      'storage',
      'ls',
      'gs://company-share/geniro/',
    ]);

    nextResult = () => ok({ code: null, spawnError: 'spawn gcloud ENOENT' });
    expect(await service.probe(GCS)).toEqual({
      ok: false,
      detail: expect.stringContaining('is its CLI installed'),
    });
  });
});
