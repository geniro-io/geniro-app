import { describe, expect, it } from 'vitest';

import type { ShareDestination } from '../shares.types';
import { authProfileOf, classifyShareFailure } from './share-auth';

const GCS: ShareDestination = {
  kind: 'gcs',
  id: 'company',
  name: 'Company',
  linkBase: 'https://artifacts.example.com',
  bucket: 'company-share',
};

const S3: ShareDestination = {
  kind: 's3',
  id: 's3',
  name: 'S3',
  linkBase: 'https://cdn.example.com',
  bucket: 'pages',
  profile: 'work',
  region: 'eu-west-1',
};

/** The Dev Team's own shape: a custom command that runs gcloud. */
const GCLOUD_COMMAND: ShareDestination = {
  kind: 'command',
  id: 'team',
  name: 'Team bucket',
  linkBase: 'https://pages.example.com',
  upload: [
    '/opt/homebrew/bin/gcloud',
    'storage',
    'cp',
    '--configuration',
    'work',
    '{file}',
    'gs://team/{object}',
  ],
  remove: ['gcloud', 'storage', 'rm', 'gs://team/{object}'],
};

const OWN_COMMAND: ShareDestination = {
  kind: 'command',
  id: 'own',
  name: 'Own',
  linkBase: 'https://pages.example.com',
  upload: ['/usr/local/bin/put', '{file}', '{object}'],
  remove: ['/usr/local/bin/del', '{object}'],
};

function failed(
  stderr: string,
  extra: Partial<{
    stdout: string;
    code: number | null;
    timedOut: boolean;
    spawnError: string;
  }> = {},
) {
  return { code: 1, stdout: '', stderr, timedOut: false, ...extra };
}

/** Lines gcloud 536 printed, captured from a throwaway CLOUDSDK_CONFIG. */
const GCLOUD_REVOKED =
  'ERROR: (gcloud.storage.cp) Your current active account [ghost@example.com] does not have any valid credentials\nPlease run:\n\n  $ gcloud auth login\n';
const GCLOUD_NO_ACCOUNT =
  'ERROR: (gcloud.storage.ls) You do not currently have an active account selected.\nPlease run:\n\n  $ gcloud auth login\n';
const GCLOUD_MISSING_BUCKET =
  'ERROR: (gcloud.storage.ls) gs://geniro-nonexistent-bucket-xyz-4821 not found: 404.\n';

describe('authProfileOf', () => {
  it("gives a gcs destination gcloud's own sign-in and token check", () => {
    expect(authProfileOf(GCS)).toMatchObject({
      cli: 'gcloud',
      label: 'Google Cloud',
      login: { command: 'gcloud', args: ['auth', 'login'] },
      check: { command: 'gcloud', args: ['auth', 'print-access-token'] },
    });
  });

  it("runs an s3 destination's sign-in and check as its profile and region", () => {
    expect(authProfileOf(S3)).toMatchObject({
      cli: 'aws',
      login: {
        command: 'aws',
        args: ['sso', 'login', '--profile', 'work', '--region', 'eu-west-1'],
      },
      check: {
        command: 'aws',
        args: [
          'sts',
          'get-caller-identity',
          '--profile',
          'work',
          '--region',
          'eu-west-1',
        ],
      },
    });
  });

  it("lets a custom command whose program is gcloud borrow gcloud's sign-in, as the same configuration", () => {
    expect(authProfileOf(GCLOUD_COMMAND)).toMatchObject({
      cli: 'gcloud',
      login: {
        command: 'gcloud',
        args: ['auth', 'login', '--configuration', 'work'],
      },
      check: {
        command: 'gcloud',
        args: ['auth', 'print-access-token', '--configuration', 'work'],
      },
    });
  });

  it('gives a custom command of its own no sign-in unless the user set one up', () => {
    expect(authProfileOf(OWN_COMMAND)).toBeNull();
    expect(
      authProfileOf({ ...OWN_COMMAND, signIn: { patterns: ['expired'] } }),
    ).toBeNull();
  });

  it('uses a custom login and patterns, lower-cased, with no check to run', () => {
    expect(
      authProfileOf({
        ...OWN_COMMAND,
        signIn: {
          login: ['/usr/local/bin/put', 'login'],
          patterns: ['Session EXPIRED'],
        },
      }),
    ).toEqual({
      cli: 'put',
      label: 'Own',
      login: { command: '/usr/local/bin/put', args: ['login'] },
      check: null,
      patterns: ['session expired'],
    });
  });
});

describe('classifyShareFailure', () => {
  const gcloud = authProfileOf(GCS);
  const aws = authProfileOf(S3);

  it('classifies gcloud reauth as auth', () => {
    expect(classifyShareFailure(gcloud, failed(GCLOUD_REVOKED))).toBe('auth');
    expect(classifyShareFailure(gcloud, failed(GCLOUD_NO_ACCOUNT))).toBe(
      'auth',
    );
    for (const line of [
      'ERROR: (gcloud.storage.cp) There was a problem refreshing your current auth tokens: Reauthentication failed. cannot prompt during non-interactive execution.',
      'google.auth.exceptions.RefreshError: invalid_grant: Bad Request',
      'ERROR: (gcloud.auth.print-access-token) No credentialed accounts.',
    ]) {
      expect(classifyShareFailure(gcloud, failed(line))).toBe('auth');
    }
  });

  it('does not offer sign-in for a missing bucket', () => {
    expect(classifyShareFailure(gcloud, failed(GCLOUD_MISSING_BUCKET))).toBe(
      'other',
    );
  });

  it('never reads a network failure, a missing CLI or a timeout as signed out', () => {
    expect(
      classifyShareFailure(
        gcloud,
        failed(
          'ERROR: (gcloud.storage.cp) HTTPSConnectionPool: Max retries exceeded',
        ),
      ),
    ).toBe('other');
    expect(
      classifyShareFailure(
        gcloud,
        failed('', { code: null, spawnError: 'spawn gcloud ENOENT' }),
      ),
    ).toBe('other');
    expect(
      classifyShareFailure(
        gcloud,
        failed(GCLOUD_REVOKED, { code: null, timedOut: true }),
      ),
    ).toBe('other');
    expect(classifyShareFailure(gcloud, failed('', { code: 127 }))).toBe(
      'other',
    );
  });

  it('does not offer sign-in when gcloud wraps a DNS failure in its token-refresh error', () => {
    expect(
      classifyShareFailure(
        gcloud,
        failed(
          'ERROR: (gcloud.storage.cp) There was a problem refreshing your current auth tokens: Unable to find the server at oauth2.googleapis.com\nPlease run:\n\n  $ gcloud auth login\n',
        ),
      ),
    ).toBe('other');
    expect(
      classifyShareFailure(
        aws,
        failed(
          'Could not connect to the endpoint URL: "https://sts.amazonaws.com/"',
        ),
      ),
    ).toBe('other');
  });

  it('classifies aws expired logins as auth and other aws failures as other', () => {
    for (const line of [
      'An error occurred (ExpiredToken) when calling the PutObject operation: The provided token has expired.',
      'Error when retrieving token from sso: Token has expired and refresh failed',
      'The SSO session associated with this profile has expired or is otherwise invalid.',
      'Unable to locate credentials. You can configure credentials by running "aws configure".',
      'An error occurred (InvalidClientTokenId) when calling the GetCallerIdentity operation',
    ]) {
      expect(classifyShareFailure(aws, failed(line))).toBe('auth');
    }
    expect(
      classifyShareFailure(
        aws,
        failed(
          'An error occurred (NoSuchBucket) when calling the PutObject operation',
        ),
      ),
    ).toBe('other');
  });

  it('reads stdout too, for a CLI that reports there', () => {
    expect(
      classifyShareFailure(gcloud, failed('', { stdout: GCLOUD_REVOKED })),
    ).toBe('auth');
  });

  it('treats every failure of a destination with no sign-in as other', () => {
    expect(classifyShareFailure(null, failed(GCLOUD_REVOKED))).toBe('other');
  });

  it("matches a custom destination's patterns whatever their case", () => {
    const custom = authProfileOf({
      ...OWN_COMMAND,
      signIn: {
        login: ['/usr/local/bin/put', 'login'],
        patterns: ['Session EXPIRED'],
      },
    });
    expect(
      classifyShareFailure(custom, failed('put: session expired, log in')),
    ).toBe('auth');
    expect(classifyShareFailure(custom, failed('put: disk full'))).toBe(
      'other',
    );
  });
});
