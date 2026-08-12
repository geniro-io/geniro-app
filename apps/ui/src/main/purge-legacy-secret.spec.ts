import { describe, expect, it, vi } from 'vitest';

import { purgeLegacySecret } from './purge-legacy-secret';

/** The narrowed seam the module declares — no cast needed to satisfy it. */
type Exec = (
  file: string,
  args: readonly string[],
  options: { timeout: number },
  callback: (error: unknown) => void,
) => void;

describe('purgeLegacySecret', () => {
  it('shells out to `security delete-generic-password` for the exact legacy entry', () => {
    const exec = vi.fn<Exec>();

    purgeLegacySecret(exec);

    expect(exec).toHaveBeenCalledWith(
      // Absolute on purpose — a bare `security` would let PATH order pick the
      // binary that runs with this app's privileges.
      '/usr/bin/security',
      ['delete-generic-password', '-s', 'io.geniro.app', '-a', 'cursor.apiKey'],
      expect.objectContaining({ timeout: expect.any(Number) }),
      expect.any(Function),
    );
  });

  // One case, two codes: the callback is empty, so nothing in the module can
  // tell 44 from any other failure. Two tests naming them separately implied a
  // branch that does not exist — 44 being the steady state is a fact about the
  // TOOL, recorded in the module's doc block, not a behaviour to assert here.
  it.each([44, 1])(
    'swallows a callback-reported failure (exit %i)',
    (code: number) => {
      const exec = vi.fn<Exec>((_file, _args, _opts, cb) => {
        cb(Object.assign(new Error(`exit ${code}`), { code }));
      });

      expect(() => purgeLegacySecret(exec)).not.toThrow();
    },
  );

  it('swallows `exec` throwing synchronously (e.g. a missing `security` binary)', () => {
    const exec = vi.fn<Exec>(() => {
      throw new Error('ENOENT: security not found');
    });

    expect(() => purgeLegacySecret(exec)).not.toThrow();
  });
});
