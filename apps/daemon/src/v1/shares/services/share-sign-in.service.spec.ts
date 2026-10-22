import { BadRequestException } from '@packages/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ManagedCommandResult } from '../../agents/utils/managed-command';
import type {
  ShareCheckResult,
  ShareCommandRunner,
  ShareDestination,
} from '../shares.types';
import type { ShareService } from './share.service';
import { ShareSignInService } from './share-sign-in.service';

const GCS: ShareDestination = {
  kind: 'gcs',
  id: 'company',
  name: 'Company',
  linkBase: 'https://artifacts.example.com',
  bucket: 'company-share',
};

const OWN: ShareDestination = {
  kind: 'command',
  id: 'own',
  name: 'Own',
  linkBase: 'https://pages.example.com',
  upload: ['/usr/local/bin/put', '{file}', '{object}'],
  remove: ['/usr/local/bin/del', '{object}'],
};

const AUTH_URL =
  'https://accounts.google.com/o/oauth2/auth?response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A8085%2F';

describe('ShareSignInService', () => {
  let logins: {
    args: string[];
    signal: AbortSignal | undefined;
    timeoutMs: number;
    end: (result: Partial<ManagedCommandResult>) => void;
  }[];
  let checked: ShareCheckResult;
  let retryAwaiting: ReturnType<
    typeof vi.fn<(id: string) => Promise<string[]>>
  >;
  let service: ShareSignInService;

  beforeEach(() => {
    logins = [];
    checked = { state: 'signed-in', signIn: null };
    retryAwaiting = vi.fn(() => Promise.resolve(['share-1']));
    const run: ShareCommandRunner = (command) =>
      new Promise((resolve) => {
        const end = (result: Partial<ManagedCommandResult>): void =>
          resolve({
            code: 0,
            stdout: '',
            stderr: '',
            timedOut: false,
            ...result,
          });
        logins.push({
          args: [command.command, ...command.args],
          signal: command.signal,
          timeoutMs: command.timeoutMs,
          end,
        });
        command.signal?.addEventListener('abort', () => end({ code: null }));
        command.onOutput?.('Your browser has been opened to visit:', 'stderr');
        command.onOutput?.(`    ${AUTH_URL}`, 'stderr');
      });
    service = new ShareSignInService(
      {
        destination: (id: string) =>
          [GCS, OWN].find((d) => d.id === id) ?? null,
        check: () => Promise.resolve(checked),
        retryAwaiting,
      } as unknown as ShareService,
      run,
    );
  });

  const settled = async (id: string) => {
    await expect
      .poll(() => service.status(id).status)
      .not.toMatch(/^(waiting|verifying)$/);
    return service.status(id);
  };

  it('runs the CLI’s own login with a 5-minute deadline and shows its link, not as a line', async () => {
    const session = await service.start('company');

    expect(logins.map((l) => l.args)).toEqual([['gcloud', 'auth', 'login']]);
    expect(logins[0]?.timeoutMs).toBe(5 * 60_000);
    expect(session).toMatchObject({
      status: 'waiting',
      label: 'Google Cloud',
      cli: 'gcloud',
      url: AUTH_URL,
      // The line that only introduced the link goes with it.
      lines: [],
    });
  });

  it('joins the sign-in already running for that destination', async () => {
    const first = await service.start('company');
    const second = await service.start('company');

    expect(second.id).toBe(first.id);
    expect(logins).toHaveLength(1);
  });

  it('on success re-checks, then tries the waiting shares exactly once', async () => {
    const { id } = await service.start('company');

    logins[0]?.end({ code: 0 });

    expect(await settled(id)).toMatchObject({
      status: 'succeeded',
      retried: ['share-1'],
    });
    expect(retryAwaiting).toHaveBeenCalledTimes(1);
    expect(retryAwaiting).toHaveBeenCalledWith('company');
  });

  it('fails without retrying when the check still says signed out', async () => {
    checked = {
      state: 'sign-in-required',
      detail: 'does not have any valid credentials',
      signIn: null,
    };
    const { id } = await service.start('company');

    logins[0]?.end({ code: 0 });

    expect(await settled(id)).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('Still signed out'),
    });
    expect(retryAwaiting).not.toHaveBeenCalled();
  });

  it('a cancel stops the CLI and retries nothing', async () => {
    const { id } = await service.start('company');

    service.cancel(id);

    expect(logins[0]?.signal?.aborted).toBe(true);
    expect(await settled(id)).toMatchObject({ status: 'cancelled' });
    expect(retryAwaiting).not.toHaveBeenCalled();
  });

  it('ends timed out at the deadline and retries nothing', async () => {
    const { id } = await service.start('company');

    logins[0]?.end({ code: null, timedOut: true });

    expect(await settled(id)).toMatchObject({ status: 'timed-out' });
    expect(retryAwaiting).not.toHaveBeenCalled();
  });

  it('a failed login says why and retries nothing; a new start runs again', async () => {
    const { id } = await service.start('company');

    logins[0]?.end({ code: 1 });

    expect(await settled(id)).toMatchObject({
      status: 'failed',
      message: 'gcloud exited with status 1',
    });
    expect(retryAwaiting).not.toHaveBeenCalled();
    expect((await service.start('company')).id).not.toBe(id);
  });

  it('refuses a destination with no sign-in, and one not in Settings', async () => {
    await expect(service.start('own')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.start('gone')).rejects.toThrow(/not in Settings/);
    expect(logins).toHaveLength(0);
  });
});
