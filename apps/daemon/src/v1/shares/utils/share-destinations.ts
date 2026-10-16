import { randomBytes } from 'node:crypto';

import type { ManagedCommandResult } from '../../agents/utils/managed-command';
import type { DestinationCommand, ShareDestination } from '../shares.types';

/** A fresh, unguessable object id — the path segment a page is stored under. */
export function mintObjectId(): string {
  return randomBytes(16).toString('hex');
}

/** Where one shared page lives inside the destination: `[<prefix>/]<objectId>/index.html`. */
export function objectPath(
  destination: ShareDestination,
  objectId: string,
): string {
  const prefix =
    destination.kind === 'command' ? undefined : destination.prefix;
  return `${prefix === undefined ? '' : `${prefix}/`}${objectId}/index.html`;
}

/** The link a reader opens; the key rides the fragment, which no browser sends. */
export function linkFor(
  destination: ShareDestination,
  objectId: string,
  key: string,
): string {
  const base = destination.linkBase.replace(/\/+$/, '');
  return `${base}/${objectPath(destination, objectId)}#k=${key}`;
}

/**
 * The argv that uploads `file` to, or removes, one object — through the user's
 * own CLI and login. The returned tokens are passed to the runner as argv; no
 * token is ever read by a shell.
 */
export function destinationArgv(
  destination: ShareDestination,
  op: 'upload' | 'remove',
  target: { objectId: string; file?: string },
): DestinationCommand {
  const object = objectPath(destination, target.objectId);
  const file = target.file ?? '';
  if (op === 'upload' && file === '') {
    throw new Error('an upload needs the envelope file');
  }
  switch (destination.kind) {
    case 'gcs': {
      const url = `gs://${destination.bucket}/${object}`;
      return op === 'upload'
        ? {
            command: 'gcloud',
            args: [
              'storage',
              'cp',
              '--content-type=text/html; charset=utf-8',
              '--cache-control=no-store',
              file,
              url,
            ],
          }
        : { command: 'gcloud', args: ['storage', 'rm', url] };
    }
    case 's3': {
      const url = `s3://${destination.bucket}/${object}`;
      const scope = awsScope(destination);
      return op === 'upload'
        ? {
            command: 'aws',
            args: [
              's3',
              'cp',
              file,
              url,
              '--content-type',
              'text/html; charset=utf-8',
              '--cache-control',
              'no-store',
              ...scope,
            ],
          }
        : { command: 'aws', args: ['s3', 'rm', url, ...scope] };
    }
    case 'command': {
      const tokens = op === 'upload' ? destination.upload : destination.remove;
      const [command, ...args] = tokens.map((token) =>
        token.split('{file}').join(file).split('{object}').join(object),
      );
      if (command === undefined) {
        throw new Error('a destination command needs a program');
      }
      return { command, args };
    }
  }
}

/** `--profile` / `--region`, when the user chose them. */
function awsScope(destination: {
  profile?: string;
  region?: string;
}): string[] {
  return [
    ...(destination.profile === undefined
      ? []
      : ['--profile', destination.profile]),
    ...(destination.region === undefined
      ? []
      : ['--region', destination.region]),
  ];
}

/**
 * A read-only check that the CLI is installed, signed in and can list where
 * pages would go — or null for a custom command, which has no read to try.
 *
 * An EMPTY place is a pass: `gcloud storage ls` fails on a prefix with nothing
 * in it yet ({@link PROBE_EMPTY}), and `aws s3api list-objects-v2` answers an
 * empty listing with success where `aws s3 ls` would exit 1.
 */
export function probeArgv(
  destination: ShareDestination,
): DestinationCommand | null {
  switch (destination.kind) {
    case 'gcs':
      return {
        command: 'gcloud',
        args: [
          'storage',
          'ls',
          `gs://${destination.bucket}/${destination.prefix === undefined ? '' : `${destination.prefix}/`}`,
        ],
      };
    case 's3':
      return {
        command: 'aws',
        args: [
          's3api',
          'list-objects-v2',
          '--bucket',
          destination.bucket,
          '--max-items',
          '1',
          ...(destination.prefix === undefined
            ? []
            : ['--prefix', `${destination.prefix}/`]),
          ...awsScope(destination),
        ],
      };
    case 'command':
      return null;
  }
}

/** What `gcloud storage ls` says for a reachable place that holds nothing yet. */
export const PROBE_EMPTY = /matched no objects/i;

/**
 * Whether a failed remove only failed because the object was already gone —
 * a revoke that finds nothing to delete has done its job.
 *
 * Narrow on purpose: a match deletes the key and the row, so a real failure
 * read as "gone" would leave a live link nobody can revoke. Only gcloud says
 * so in words worth trusting; `aws s3 rm` already exits 0 for a missing key,
 * and a custom command is judged by its exit status alone. A timeout is never
 * "gone".
 */
export function removeFoundNothing(
  destination: ShareDestination,
  result: ManagedCommandResult,
): boolean {
  return (
    destination.kind === 'gcs' &&
    !result.timedOut &&
    /No URLs matched|matched no objects/i.test(result.stderr)
  );
}
