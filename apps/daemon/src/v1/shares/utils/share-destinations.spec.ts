import { describe, expect, it } from 'vitest';

import { type ShareDestination, ShareDestinationSchema } from '../shares.types';
import {
  destinationArgv,
  linkFor,
  mintObjectId,
  objectPath,
  probeArgv,
} from './share-destinations';

const GCS: ShareDestination = {
  kind: 'gcs',
  id: 'company',
  name: 'Company',
  linkBase: 'https://artifacts.example.com/',
  bucket: 'company-share',
  prefix: 'geniro',
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

const COMMAND: ShareDestination = {
  kind: 'command',
  id: 'own',
  name: 'Own',
  linkBase: 'https://pages.example.com',
  upload: ['/usr/local/bin/put', '--src={file}', '{object}'],
  remove: ['/usr/local/bin/del', '{object}'],
};

describe('objectPath / linkFor', () => {
  it('puts the page under the prefix and the key in the fragment only', () => {
    expect(objectPath(GCS, 'abc')).toBe('geniro/abc/index.html');
    expect(linkFor(GCS, 'abc', 'KEY')).toBe(
      'https://artifacts.example.com/geniro/abc/index.html#k=KEY',
    );
    expect(linkFor(S3, 'abc', 'KEY')).toBe(
      'https://cdn.example.com/abc/index.html#k=KEY',
    );
  });

  it('mints a 128-bit hex object id', () => {
    expect(mintObjectId()).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('destinationArgv', () => {
  it('uploads to GCS as html that no cache keeps', () => {
    expect(
      destinationArgv(GCS, 'upload', { objectId: 'abc', file: '/tmp/e.html' }),
    ).toEqual({
      command: 'gcloud',
      args: [
        'storage',
        'cp',
        '--content-type=text/html; charset=utf-8',
        '--cache-control=no-store',
        '/tmp/e.html',
        'gs://company-share/geniro/abc/index.html',
      ],
    });
    expect(destinationArgv(GCS, 'remove', { objectId: 'abc' })).toEqual({
      command: 'gcloud',
      args: ['storage', 'rm', 'gs://company-share/geniro/abc/index.html'],
    });
  });

  it('passes the S3 profile and region the user chose', () => {
    const upload = destinationArgv(S3, 'upload', {
      objectId: 'abc',
      file: '/tmp/e.html',
    });
    expect(upload.command).toBe('aws');
    expect(upload.args).toEqual([
      's3',
      'cp',
      '/tmp/e.html',
      's3://pages/abc/index.html',
      '--content-type',
      'text/html; charset=utf-8',
      '--cache-control',
      'no-store',
      '--profile',
      'work',
      '--region',
      'eu-west-1',
    ]);
  });

  it('substitutes {file} and {object} inside the user’s own argv tokens', () => {
    expect(
      destinationArgv(COMMAND, 'upload', {
        objectId: 'abc',
        file: '/tmp/e.html',
      }),
    ).toEqual({
      command: '/usr/local/bin/put',
      args: ['--src=/tmp/e.html', 'abc/index.html'],
    });
    expect(destinationArgv(COMMAND, 'remove', { objectId: 'abc' })).toEqual({
      command: '/usr/local/bin/del',
      args: ['abc/index.html'],
    });
  });

  it('refuses an upload with no file rather than uploading an empty path', () => {
    expect(() => destinationArgv(GCS, 'upload', { objectId: 'abc' })).toThrow(
      /needs the envelope file/,
    );
  });
});

describe('probeArgv', () => {
  it('lists where pages would go, and has nothing to try for a custom command', () => {
    expect(probeArgv(GCS)).toEqual({
      command: 'gcloud',
      args: ['storage', 'ls', 'gs://company-share/geniro/'],
    });
    expect(probeArgv(S3)).toEqual({
      command: 'aws',
      args: [
        's3api',
        'list-objects-v2',
        '--bucket',
        'pages',
        '--max-items',
        '1',
        '--profile',
        'work',
        '--region',
        'eu-west-1',
      ],
    });
    expect(probeArgv({ ...GCS, prefix: undefined })?.args.at(-1)).toBe(
      'gs://company-share/',
    );
    expect(probeArgv({ ...S3, prefix: 'pages' })?.args).toEqual(
      expect.arrayContaining(['--prefix', 'pages/']),
    );
    expect(probeArgv(COMMAND)).toBeNull();
  });
});

describe('ShareDestinationSchema', () => {
  it('refuses a link base that is not https', () => {
    expect(
      ShareDestinationSchema.safeParse({ ...GCS, linkBase: 'http://x.example' })
        .success,
    ).toBe(false);
  });

  it('refuses a prefix that walks out of the bucket', () => {
    expect(
      ShareDestinationSchema.safeParse({ ...GCS, prefix: 'a/../b' }).success,
    ).toBe(false);
  });

  it.each([
    [['/bin/sh', '-c', 'put {file}']],
    [['bash', 'put']],
    [['/usr/local/bin/put', '{file}; rm -rf ~']],
    [['/usr/local/bin/put', '$(whoami)']],
    [['/usr/local/bin/put', 'a|b']],
  ])('refuses a command a shell would be needed to read: %j', (upload) => {
    expect(
      ShareDestinationSchema.safeParse({ ...COMMAND, upload }).success,
    ).toBe(false);
  });

  it('accepts plain argv with placeholders', () => {
    expect(ShareDestinationSchema.safeParse(COMMAND).success).toBe(true);
  });
});
