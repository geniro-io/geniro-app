import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFile = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ execFile }));

import { runPs } from './run-ps';

type Callback = (error: Error | null, out: string) => void;

describe('runPs', () => {
  beforeEach(() => {
    execFile.mockReset();
  });

  it('reads `ps` under the C locale, whatever the user’s is', async () => {
    // `lstart` and `%cpu` follow the locale (`вторник, 13 октября…`, `1,5`),
    // and every parser of this output reads the C form.
    execFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, done: Callback) =>
        done(null, 'out'),
    );
    process.env.LC_ALL = 'ru_RU.UTF-8';
    try {
      expect(await runPs(['-o', 'lstart='])).toBe('out');
    } finally {
      delete process.env.LC_ALL;
    }
    const options = execFile.mock.calls[0]?.[2] as {
      env: NodeJS.ProcessEnv;
    };
    expect(execFile.mock.calls[0]?.[0]).toBe('ps');
    expect(options.env.LC_ALL).toBe('C');
  });

  it('answers null when `ps` fails, rather than an empty table', async () => {
    execFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, done: Callback) =>
        done(new Error('timed out'), ''),
    );
    expect(await runPs(['-ax'])).toBeNull();
  });
});
