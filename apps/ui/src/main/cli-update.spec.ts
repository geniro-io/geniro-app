import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliKind } from '../shared/contracts';
import { DEFAULT_SETTINGS } from '../shared/contracts';

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  /** Every (path, args) pair execFile was invoked with, in order. */
  calls: [] as { path: string; args: string[] }[],
  /** What `resolveBinary` answers — null stands for "not on PATH". */
  binary: null as string | null,
}));

vi.mock('node:child_process', () => ({ execFile: mocks.execFile }));
vi.mock('./resolve-binary', () => ({
  resolveBinary: () => mocks.binary,
}));

import { CHECK_UNAVAILABLE, probeUpdate, runCliUpdate } from './cli-update';

type ExecFileCallback = (
  err: Error | null,
  result?: { stdout: string; stderr: string },
) => void;

/**
 * Drive every promisified `execFile` this module makes, keyed on `args` — the
 * version read and the update run go to the same binary and are told apart the
 * same way `cli-detect.spec.ts` tells its two probes apart.
 */
function stubExec(
  handler: (
    file: string,
    args: string[],
  ) => { stdout: string; stderr?: string } | Error,
): void {
  mocks.execFile.mockImplementation(
    (
      file: string,
      args: string[],
      _opts: unknown,
      cb: ExecFileCallback,
    ): void => {
      mocks.calls.push({ path: file, args });
      const outcome = handler(file, args);
      if (outcome instanceof Error) {
        cb(outcome);
        return;
      }
      cb(null, { stdout: outcome.stdout, stderr: outcome.stderr ?? '' });
    },
  );
}

beforeEach(() => {
  mocks.calls.length = 0;
  mocks.execFile.mockReset();
  mocks.binary = '/bin/cursor-agent';
});

describe('probeUpdate', () => {
  /** cursor's own reply shape, verbatim from `about --format json`. */
  const about = (status: string, latest: string): string =>
    JSON.stringify({
      cliVersion: '2026.08.31-4057e58',
      latestStatus: status,
      latestVersion: latest,
      model: 'Composer 2.5',
    });

  it('reads the CLI’s structured answer, not its prose', async () => {
    stubExec(() => ({
      stdout: about('update_available', '2026.09.02-c22c1a3'),
    }));

    await expect(
      probeUpdate('cursor-agent', '/bin/cursor-agent'),
    ).resolves.toEqual({
      available: true,
      latestVersion: '2026.09.02-c22c1a3',
      checkUnavailableReason: null,
    });
    // `about --format json` and nothing else — the human `about` prints the
    // same two facts inside a parenthetical no parser should be reading.
    expect(mocks.calls).toEqual([
      { path: '/bin/cursor-agent', args: ['about', '--format', 'json'] },
    ]);
  });

  it('reports up-to-date as an ANSWER, not as an absence', async () => {
    // The card draws no button on this, so it has to be distinguishable from
    // "nobody asked" — which is the whole reason `available` is three-state.
    stubExec(() => ({ stdout: about('up_to_date', '2026.08.31-4057e58') }));

    await expect(
      probeUpdate('cursor-agent', '/bin/cursor-agent'),
    ).resolves.toMatchObject({ available: false });
  });

  it('claims nothing on a status word the CLI does not vouch for', async () => {
    // Its bundle switches on exactly two — `case"up_to_date":case"update_available":`
    // — so a third value is a vocabulary this app has not measured. Reading an
    // unknown word as either answer would nag about an update that may not
    // exist, or hide one that does.
    stubExec(() => ({ stdout: about('checking', '2026.09.02-c22c1a3') }));

    await expect(
      probeUpdate('cursor-agent', '/bin/cursor-agent'),
    ).resolves.toMatchObject({ available: null });
  });

  it('survives every shape the reply could take', async () => {
    for (const stdout of ['{ not json', '"a string"', '{}', '[]']) {
      stubExec(() => ({ stdout }));
      await expect(
        probeUpdate('cursor-agent', '/bin/cursor-agent'),
      ).resolves.toEqual({
        available: null,
        latestVersion: null,
        checkUnavailableReason: null,
      });
    }

    stubExec(() => new Error('spawn ETIMEDOUT'));
    await expect(
      probeUpdate('cursor-agent', '/bin/cursor-agent'),
    ).resolves.toMatchObject({ available: null });
  });

  it('spawns NOTHING for a CLI with no check, and says why instead', async () => {
    stubExec(() => ({ stdout: 'never reached' }));

    await expect(probeUpdate('claude', '/bin/claude')).resolves.toEqual({
      available: null,
      latestVersion: null,
      checkUnavailableReason: CHECK_UNAVAILABLE.claude,
    });
    // Not merely "answered null": asking claude for a check would mean running
    // its updater, which installs.
    expect(mocks.calls).toEqual([]);
  });
});

describe('runCliUpdate', () => {
  const settings = { ...DEFAULT_SETTINGS };

  /** Answer `--version` with `versions.shift()`, and the update run with ok. */
  function stubUpdate(versions: string[], update?: Error): void {
    stubExec((_file, args) => {
      if (args[0] === '--version') {
        return { stdout: `${versions.shift() ?? 'gone'}\n` };
      }
      return update ?? { stdout: 'Updated.' };
    });
  }

  it('reports the two version reads it took itself, around the CLI’s updater', async () => {
    mocks.binary = '/bin/claude';
    stubUpdate(['2.1.251', '2.1.255']);

    await expect(runCliUpdate('claude', settings)).resolves.toEqual({
      kind: 'claude',
      ok: true,
      previousVersion: '2.1.251',
      version: '2.1.255',
      output: null,
    });
    // Read, update, read — in that order. Drop either read and the card can
    // only repeat whatever prose the updater happened to print.
    expect(mocks.calls.map((c) => c.args)).toEqual([
      ['--version'],
      ['update'],
      ['--version'],
    ]);
  });

  it('re-reads the version even when the updater FAILED', async () => {
    // An updater that swapped the binary and then exited non-zero has still
    // changed what the next turn runs, so reporting the pre-run figure would
    // describe a binary that is no longer there.
    mocks.binary = '/bin/claude';
    stubUpdate(
      ['2.1.251', '2.1.255'],
      Object.assign(new Error('boom'), {
        stderr: 'error: permission denied\n',
      }),
    );

    await expect(runCliUpdate('claude', settings)).resolves.toEqual({
      kind: 'claude',
      ok: false,
      previousVersion: '2.1.251',
      version: '2.1.255',
      // The tool's own words, trimmed — the one state this app cannot explain.
      output: 'error: permission denied',
    });
  });

  it('falls back to stdout when a failing updater wrote nothing to stderr', async () => {
    mocks.binary = '/bin/claude';
    stubUpdate(
      ['2.1.251', '2.1.251'],
      Object.assign(new Error('exit 1'), {
        stderr: '   ',
        stdout: 'could not reach the release server',
      }),
    );

    await expect(runCliUpdate('claude', settings)).resolves.toMatchObject({
      ok: false,
      output: 'could not reach the release server',
    });
  });

  it('never runs anything for a binary that is not there', async () => {
    mocks.binary = null;
    stubExec(() => ({ stdout: 'never reached' }));

    await expect(runCliUpdate('claude', settings)).resolves.toEqual({
      kind: 'claude',
      ok: false,
      previousVersion: null,
      version: null,
      output: 'claude was not found on PATH.',
    });
    expect(mocks.calls).toEqual([]);
  });

  it('runs each CLI’s own update argv', async () => {
    for (const kind of ['claude', 'cursor-agent'] as CliKind[]) {
      mocks.calls.length = 0;
      mocks.binary = `/bin/${kind}`;
      stubUpdate(['1', '1']);

      await runCliUpdate(kind, settings);

      expect(mocks.calls.map((c) => c.path)).toEqual([
        `/bin/${kind}`,
        `/bin/${kind}`,
        `/bin/${kind}`,
      ]);
    }
  });
});
