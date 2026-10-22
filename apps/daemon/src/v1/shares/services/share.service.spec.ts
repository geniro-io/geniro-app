import { createDecipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { BadRequestException } from '@packages/common';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

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
const DAY = 24 * 60 * 60 * 1000;
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
  autoRevokeAfterDays: null,
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

  /** A live share row first made at `createdAt`, with its key in the Keychain. */
  const seedShare = async (
    artifactId: string,
    createdAt: number,
  ): Promise<ArtifactShare> => {
    const row = await dao.create({
      runId: RUN,
      artifactId,
      title: artifactId,
      destination: JSON.stringify(GCS),
      objectId: `object-${artifactId}`,
      linkBase: GCS.linkBase,
      sharedVersion: 1,
      sharedBy: 'agent',
      createdAt: new Date(createdAt),
    });
    keys.set(row.id, `key-${artifactId}`);
    return row;
  };

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
          autoRevokeAfterDays: null,
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

  describe('revokeAll', () => {
    it('revokes the pages named and carries on past one that fails', async () => {
      service.setConfig(CONFIG);
      const first = await seedShare('first', DAY);
      const failing = await seedShare('failing', DAY);
      const last = await seedShare('last', DAY);
      nextResult = (args) =>
        args.some((arg) => arg.includes(failing.objectId))
          ? ok({ code: 1, stderr: 'ERROR: permission denied' })
          : ok();

      expect(await service.revokeAll([first.id, failing.id, last.id])).toEqual({
        revoked: 2,
        failed: 1,
        detail: 'ERROR: permission denied',
      });

      expect(keys.has(first.id)).toBe(false);
      expect(keys.has(last.id)).toBe(false);
      expect(keys.has(failing.id)).toBe(true);
      expect(await service.list()).toEqual([
        expect.objectContaining({ id: failing.id, status: 'revoke-failed' }),
      ]);
    });

    it('leaves a page shared after the list was read alone', async () => {
      service.setConfig(CONFIG);
      const listed = await seedShare('listed', DAY);
      const newer = await seedShare('newer', DAY);

      expect(await service.revokeAll([listed.id])).toMatchObject({
        revoked: 1,
      });

      expect((await service.list()).map((s) => s.id)).toEqual([newer.id]);
      expect(keys.has(newer.id)).toBe(true);
    });

    it('counts a page already revoked as neither revoked nor failed', async () => {
      service.setConfig(CONFIG);
      const gone = await seedShare('gone', DAY);
      const live = await seedShare('live', DAY);
      await service.revoke(gone.id);

      expect(await service.revokeAll([gone.id, live.id])).toEqual({
        revoked: 1,
        failed: 0,
        detail: null,
      });
    });

    it('counts a revoke that throws as failed and goes on to the next page', async () => {
      service.setConfig(CONFIG);
      const unreadable = await seedShare('unreadable', DAY);
      await dao.updateById(unreadable.id, { destination: 'not json' });
      const live = await seedShare('live', DAY);

      expect(await service.revokeAll([unreadable.id, live.id])).toEqual({
        revoked: 1,
        failed: 1,
        detail: 'the destination this page was shared to could not be read',
      });
      expect(keys.has(live.id)).toBe(false);
    });
  });

  describe('revokeExpired', () => {
    const NOW = Date.parse('2026-10-22T12:00:00Z');

    const turnOn = (days: number | null): void => {
      service.setConfig({ ...CONFIG, autoRevokeAfterDays: days });
    };

    it('revokes only the pages first shared longer ago than the setting', async () => {
      const old = await seedShare('old', NOW - 31 * DAY);
      const recent = await seedShare('recent', NOW - 29 * DAY);
      turnOn(30);

      expect(await service.revokeExpired(NOW)).toEqual({
        revoked: 1,
        failed: 0,
        detail: null,
      });

      expect((await service.list()).map((s) => s.id)).toEqual([recent.id]);
      expect(keys.has(old.id)).toBe(false);
    });

    it('revokes nothing while the setting is off', async () => {
      await seedShare('old', NOW - 3650 * DAY);
      turnOn(null);

      expect(await service.revokeExpired(NOW)).toEqual({
        revoked: 0,
        failed: 0,
        detail: null,
      });
      expect(commands).toHaveLength(0);
    });

    it('revokes oldest first and stops once the setting is switched off mid-sweep', async () => {
      await seedShare('newer', NOW - 35 * DAY);
      const oldest = await seedShare('oldest', NOW - 40 * DAY);
      turnOn(30);
      nextResult = () => {
        service.setConfig({ ...CONFIG, autoRevokeAfterDays: null });
        return ok();
      };

      expect(await service.revokeExpired(NOW)).toMatchObject({ revoked: 1 });
      expect((await service.list()).map((s) => s.artifactId)).toEqual([
        'newer',
      ]);
      expect(keys.has(oldest.id)).toBe(false);
    });

    it('keeps a page the setting was lengthened to cover mid-sweep', async () => {
      await seedShare('a', NOW - 40 * DAY);
      await seedShare('b', NOW - 35 * DAY);
      turnOn(30);
      nextResult = () => {
        service.setConfig({ ...CONFIG, autoRevokeAfterDays: 38 });
        return ok();
      };

      expect(await service.revokeExpired(NOW)).toMatchObject({ revoked: 1 });
      expect((await service.list()).map((s) => s.artifactId)).toEqual(['b']);
    });

    it('resolves with nothing done when the shares cannot be read', async () => {
      turnOn(30);
      vi.spyOn(dao, 'sharedBefore').mockRejectedValueOnce(
        new Error('SQLITE_BUSY'),
      );

      await expect(service.revokeExpired(NOW)).resolves.toEqual({
        revoked: 0,
        failed: 0,
        detail: null,
      });
    });

    it('never sweeps on a settings push, so a shorter window waits for the timer', async () => {
      const old = await seedShare('old', Date.now() - 400 * DAY);
      // A sweep reads the shares synchronously as it starts.
      const sweeps = vi.spyOn(dao, 'sharedBefore');

      turnOn(30);
      turnOn(7);

      expect(sweeps).not.toHaveBeenCalled();
      expect((await service.list()).map((s) => s.id)).toEqual([old.id]);
    });

    describe('the timer', () => {
      beforeEach(() => {
        vi.useFakeTimers({
          toFake: [
            'setTimeout',
            'clearTimeout',
            'setInterval',
            'clearInterval',
          ],
        });
      });

      afterEach(() => {
        service.onApplicationShutdown();
        vi.useRealTimers();
      });

      it('sweeps a minute after the start, then every six hours until shutdown', async () => {
        turnOn(30);
        const old = await seedShare('old', Date.now() - 400 * DAY);
        const sweeps = vi.spyOn(dao, 'sharedBefore');
        service.onModuleInit();

        vi.advanceTimersByTime(60 * 1000 - 1);
        expect(sweeps).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(sweeps).toHaveBeenCalledTimes(1);
        await service.revokeExpired();
        expect(keys.has(old.id)).toBe(false);

        vi.advanceTimersByTime(6 * 60 * 60 * 1000 - 60 * 1000 - 1);
        expect(sweeps).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(1);
        expect(sweeps).toHaveBeenCalledTimes(2);
        await service.revokeExpired();

        service.onApplicationShutdown();
        const after = await seedShare('after', Date.now() - 400 * DAY);
        vi.advanceTimersByTime(6 * 60 * 60 * 1000);

        expect(sweeps).toHaveBeenCalledTimes(2);
        expect(keys.has(after.id)).toBe(true);
      });
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
