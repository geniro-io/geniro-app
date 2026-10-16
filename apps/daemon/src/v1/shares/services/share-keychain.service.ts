import { Inject, Injectable } from '@nestjs/common';
import { BadRequestException, InternalException } from '@packages/common';

import type { ManagedCommandResult } from '../../agents/utils/managed-command';
import { registerSecret } from '../../diagnostics/utils/redact';
import { SHARE_COMMAND_RUNNER, type ShareCommandRunner } from '../shares.types';

/** The Keychain service every share key is filed under; the account is the share id. */
const SHARE_KEYCHAIN_SERVICE = 'geniro.share';

const SECURITY = '/usr/bin/security';
const KEYCHAIN_TIMEOUT_MS = 10_000;
/** `security`'s exit status for "no such item". */
const ITEM_NOT_FOUND = 44;
const SHARE_KEY = /^[A-Za-z0-9_-]{43}$/;
const SHARE_ID = /^[0-9a-f-]{36}$/;

/**
 * Share keys in the macOS Keychain — the only place a key is kept on the Mac.
 *
 * A write goes through `security -i` with the command on STDIN: `-w <key>` on
 * the argv would put the key in the process table for anyone to read with
 * `ps`. Reads come back on stdout. Every key read or written is registered
 * with the debug log's redaction before anything can log it.
 */
@Injectable()
export class ShareKeychain {
  constructor(
    @Inject(SHARE_COMMAND_RUNNER) private readonly run: ShareCommandRunner,
  ) {}

  async write(shareId: string, key: string): Promise<void> {
    assertShareId(shareId);
    if (!SHARE_KEY.test(key)) {
      throw new InternalException('SHARE_KEYCHAIN_INVALID', 'not a share key');
    }
    registerSecret(key, 'share key');
    const result = await this.run({
      label: 'share:keychain',
      command: SECURITY,
      args: ['-i'],
      stdin: `add-generic-password -U -s ${SHARE_KEYCHAIN_SERVICE} -a ${shareId} -w ${key}\n`,
      timeoutMs: KEYCHAIN_TIMEOUT_MS,
    });
    // `-i` keeps going after a failed line, so its exit status is not the
    // verdict: reading the item back is.
    if (result.code !== 0 || (await this.read(shareId)) !== key) {
      throw new BadRequestException(
        'SHARE_KEYCHAIN_FAILED',
        `the share key could not be saved to the Keychain${detail(result)}`,
      );
    }
  }

  /** The key, or null when the Keychain holds none for this share. */
  async read(shareId: string): Promise<string | null> {
    assertShareId(shareId);
    const result = await this.run({
      label: 'share:keychain',
      command: SECURITY,
      args: [
        'find-generic-password',
        '-s',
        SHARE_KEYCHAIN_SERVICE,
        '-a',
        shareId,
        '-w',
      ],
      timeoutMs: KEYCHAIN_TIMEOUT_MS,
    });
    if (result.code === ITEM_NOT_FOUND) {
      return null;
    }
    const key = result.stdout.trim();
    if (result.code !== 0 || !SHARE_KEY.test(key)) {
      throw new BadRequestException(
        'SHARE_KEYCHAIN_FAILED',
        `the share key could not be read from the Keychain${detail(result)}`,
      );
    }
    registerSecret(key, 'share key');
    return key;
  }

  /** Idempotent: an item already gone is a success. */
  async delete(shareId: string): Promise<void> {
    assertShareId(shareId);
    const result = await this.run({
      label: 'share:keychain',
      command: SECURITY,
      args: [
        'delete-generic-password',
        '-s',
        SHARE_KEYCHAIN_SERVICE,
        '-a',
        shareId,
      ],
      timeoutMs: KEYCHAIN_TIMEOUT_MS,
    });
    if (result.code !== 0 && result.code !== ITEM_NOT_FOUND) {
      throw new BadRequestException(
        'SHARE_KEYCHAIN_FAILED',
        `the share key could not be removed from the Keychain${detail(result)}`,
      );
    }
  }
}

/** The share id is written into a `security -i` command line, so it must be inert there. */
function assertShareId(shareId: string): void {
  if (!SHARE_ID.test(shareId)) {
    throw new InternalException('SHARE_KEYCHAIN_INVALID', 'not a share id');
  }
}

function detail(result: ManagedCommandResult): string {
  const reason =
    result.spawnError ??
    (result.timedOut ? 'timed out' : result.stderr.trim().split('\n')[0]);
  return reason ? `: ${reason}` : '';
}
