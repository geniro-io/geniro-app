import type { execFile } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { enableGeniroMcpServer } from './cursor-mcp-enable';

type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('enableGeniroMcpServer', () => {
  it('runs in the requested cwd without daemon-only GENIRO_ values', async () => {
    const seen: {
      args?: string[];
      cwd?: string;
      env?: NodeJS.ProcessEnv;
    } = {};
    const child = { pid: 7 };
    const execFileFn = ((
      _cmd: string,
      args: string[],
      opts: { cwd?: string; env?: NodeJS.ProcessEnv },
      cb: ExecCallback,
    ) => {
      seen.args = args;
      seen.cwd = opts.cwd;
      seen.env = opts.env;
      cb(null, '', '');
      return child as ReturnType<typeof execFile>;
    }) as unknown as typeof execFile;
    const onSpawn = vi.fn();
    vi.stubEnv('GENIRO_CURSOR_API_KEY', 'must-not-leak');
    vi.stubEnv('NORMAL_VAR', 'keep-me');

    await enableGeniroMcpServer('/project', { execFileFn, onSpawn });

    expect(seen.args).toEqual(['mcp', 'enable', 'geniro']);
    expect(seen.cwd).toBe('/project');
    expect(seen.env?.NORMAL_VAR).toBe('keep-me');
    expect(seen.env?.GENIRO_CURSOR_API_KEY).toBeUndefined();
    expect(onSpawn).toHaveBeenCalledWith(child);
  });

  it('keeps a synchronous spawn failure best-effort instead of rejecting turn setup', async () => {
    const execFileFn = (() => {
      throw new Error('cursor-agent spawn failed before child creation');
    }) as unknown as typeof execFile;

    await expect(
      enableGeniroMcpServer('/project', { execFileFn }),
    ).resolves.toBeUndefined();
  });
});
