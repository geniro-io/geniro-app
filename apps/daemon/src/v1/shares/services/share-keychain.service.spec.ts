import { BadRequestException } from '@packages/common';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ManagedCommandResult } from '../../agents/utils/managed-command';
import { clearSecrets, redactSecrets } from '../../diagnostics/utils/redact';
import type { ShareCommandRunner } from '../shares.types';
import { ShareKeychain } from './share-keychain.service';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const KEY = 'wdKPayJY7sDpPDsaILslcl7octD3fJDYmUxrMymlfUk';

function result(partial: Partial<ManagedCommandResult>): ManagedCommandResult {
  return { code: 0, stdout: '', stderr: '', timedOut: false, ...partial };
}

/** A fake `security` over an in-memory keychain, recording every call. */
function fakeSecurity() {
  const items = new Map<string, string>();
  const calls: Parameters<ShareCommandRunner>[0][] = [];
  const run: ShareCommandRunner = (options) => {
    calls.push(options);
    const [verb] = options.args;
    if (verb === '-i') {
      const match = /-a (\S+) -w (\S+)\n$/.exec(options.stdin ?? '');
      if (match?.[1] !== undefined && match[2] !== undefined) {
        items.set(match[1], match[2]);
      }
      return Promise.resolve(result({}));
    }
    const account = options.args[options.args.indexOf('-a') + 1] ?? '';
    if (verb === 'find-generic-password') {
      const key = items.get(account);
      return Promise.resolve(
        key === undefined
          ? result({ code: 44 })
          : result({ stdout: `${key}\n` }),
      );
    }
    if (verb === 'delete-generic-password') {
      return Promise.resolve(
        items.delete(account) ? result({}) : result({ code: 44 }),
      );
    }
    return Promise.resolve(result({ code: 1 }));
  };
  return { run, calls, items };
}

describe('ShareKeychain', () => {
  // The redaction registry is process-wide: each case starts with none, so a
  // mask can only come from the call under test.
  beforeEach(() => clearSecrets());

  it('writes the key through stdin and never puts it on the argv', async () => {
    const security = fakeSecurity();

    await new ShareKeychain(security.run).write(ID, KEY);

    expect(security.items.get(ID)).toBe(KEY);
    for (const call of security.calls) {
      expect(call.command).toBe('/usr/bin/security');
      expect(call.args.join(' ')).not.toContain(KEY);
    }
    expect(security.calls[0]?.stdin).toContain(
      `-s geniro.share -a ${ID} -w ${KEY}`,
    );
  });

  it('fails a write the Keychain did not keep, judged by reading it back', async () => {
    const security = fakeSecurity();
    const dropping: ShareCommandRunner = (options) =>
      options.args[0] === '-i'
        ? Promise.resolve(result({}))
        : security.run(options);

    await expect(new ShareKeychain(dropping).write(ID, KEY)).rejects.toThrow(
      /could not be saved/,
    );
  });

  it('reads the key back, and registers it so the debug log masks it', async () => {
    const security = fakeSecurity();
    security.items.set(ID, KEY);
    expect(redactSecrets(`link #k=${KEY}`)).toContain(KEY);

    expect(await new ShareKeychain(security.run).read(ID)).toBe(KEY);

    expect(redactSecrets(`link #k=${KEY}`)).not.toContain(KEY);
  });

  it('registers a key it writes, before anything can log it', async () => {
    // A Keychain that keeps nothing: the read-back fails before any read could
    // register the key, so only the write's own registration can mask it.
    const forgetful: ShareCommandRunner = () => Promise.resolve(result({}));
    await expect(new ShareKeychain(forgetful).write(ID, KEY)).rejects.toThrow();

    expect(redactSecrets(KEY)).not.toContain(KEY);
  });

  it('fails as a 4xx, so the reason survives the exception filter', async () => {
    const security = fakeSecurity();
    security.items.set(ID, 'not a key');
    await expect(
      new ShareKeychain(security.run).read(ID),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('reads a missing item as null, and garbage as an error', async () => {
    const security = fakeSecurity();
    const keychain = new ShareKeychain(security.run);
    expect(await keychain.read(ID)).toBeNull();

    security.items.set(ID, 'not a key');
    await expect(keychain.read(ID)).rejects.toThrow(/could not be read/);
  });

  it('deletes idempotently: an item already gone is a success', async () => {
    const security = fakeSecurity();
    security.items.set(ID, KEY);
    const keychain = new ShareKeychain(security.run);

    await keychain.delete(ID);
    await keychain.delete(ID);

    expect(security.items.has(ID)).toBe(false);
  });

  it('refuses an id that could inject into the `security -i` line', async () => {
    const security = fakeSecurity();
    await expect(
      new ShareKeychain(security.run).write(`${ID} -w x`, KEY),
    ).rejects.toThrow(/share id/);
    expect(security.calls).toHaveLength(0);
  });
});
