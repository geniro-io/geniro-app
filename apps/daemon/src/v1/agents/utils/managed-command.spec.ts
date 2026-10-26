import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ProcessRegistry } from '../services/process-registry';
import { runManagedCommand } from './managed-command';
import { runTagEnv } from './run-process-scan';

// The daemon's tests run under Electron, whose binary is a node only with this
// variable set.
const NODE_ENV = { ELECTRON_RUN_AS_NODE: '1' };

function node(script: string, processes: ProcessRegistry, timeoutMs = 10_000) {
  return {
    label: 'test:cmd',
    command: process.execPath,
    args: ['-e', script],
    timeoutMs,
    processes,
    env: NODE_ENV,
  };
}

describe('runManagedCommand', () => {
  it('hands stdin to the child and returns its stdout, stderr and exit code', async () => {
    const result = await runManagedCommand({
      ...node(
        "process.stdin.pipe(process.stdout); process.stderr.write('warn'); process.stdin.on('end', () => process.exit(3));",
        new ProcessRegistry(),
      ),
      stdin: 'secret-from-stdin',
    });

    expect(result).toEqual({
      code: 3,
      stdout: 'secret-from-stdin',
      stderr: 'warn',
      timedOut: false,
    });
  });

  it('registers the child with ProcessRegistry while it runs and releases it after', async () => {
    const processes = new ProcessRegistry();
    const run = runManagedCommand(
      node('setTimeout(() => {}, 300);', processes),
    );

    await expect.poll(() => processes.activeCount).toBe(1);
    await run;
    await expect.poll(() => processes.activeCount).toBe(0);
  });

  it('kills the group at the deadline and reports a timeout', async () => {
    const result = await runManagedCommand(
      node('setInterval(() => {}, 1000);', new ProcessRegistry(), 200),
    );

    expect(result.timedOut).toBe(true);
    expect(result.code).toBeNull();
  });

  it('reports a binary that cannot be started instead of throwing', async () => {
    const result = await runManagedCommand({
      label: 'test:missing',
      command: '/nonexistent/geniro-no-such-binary',
      args: [],
      timeoutMs: 5_000,
      processes: new ProcessRegistry(),
    });

    expect(result.code).toBeNull();
    expect(result.spawnError).toMatch(/ENOENT/);
  });

  it('runs argv in cwd with the run tag, kills at timeout, caps output at 64 KB', async () => {
    const folder = await realpath(await mkdtemp(join(tmpdir(), 'geniro-cmd-')));
    try {
      const where = await runManagedCommand({
        ...node(
          "process.stdout.write(process.cwd() + '|' + process.env.GENIRO_RUN_ID + '|' + process.env.GENIRO_RUN_OWNER);",
          new ProcessRegistry(),
        ),
        env: { ...NODE_ENV, ...runTagEnv('run-1', 'owner-1') },
        cwd: folder,
      });
      expect(where.stdout).toBe(`${folder}|run-1|owner-1`);

      const timed = await runManagedCommand(
        node('setInterval(() => {}, 1000);', new ProcessRegistry(), 200),
      );
      expect(timed.timedOut).toBe(true);

      const long = await runManagedCommand({
        ...node(
          "process.stdout.write('a'.repeat(70000)); process.stdout.write('END');",
          new ProcessRegistry(),
        ),
        keepOutput: 'tail',
      });
      expect(long.stdout).toHaveLength(64 * 1024);
      expect(long.stdout.endsWith('aEND')).toBe(true);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('keeps the head of a long output unless asked for the tail', async () => {
    const result = await runManagedCommand({
      ...node(
        "process.stdout.write('START'); process.stdout.write('a'.repeat(70000));",
        new ProcessRegistry(),
      ),
    });

    expect(result.stdout).toHaveLength(64 * 1024);
    expect(result.stdout.startsWith('STARTa')).toBe(true);
  });

  it('kills the group when its signal aborts, without calling it a timeout', async () => {
    const controller = new AbortController();
    const run = runManagedCommand({
      ...node('setInterval(() => {}, 1000);', new ProcessRegistry()),
      signal: controller.signal,
    });
    const started = Date.now();
    setTimeout(() => controller.abort(), 200);

    const result = await run;
    expect(result.timedOut).toBe(false);
    expect(result.code).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('never starts a command whose signal already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const processes = new ProcessRegistry();

    const result = await runManagedCommand({
      ...node('process.exit(0);', processes),
      signal: controller.signal,
    });

    expect(result.code).toBeNull();
    expect(result.spawnError).toBe('aborted before it started');
    expect(processes.activeCount).toBe(0);
  });

  it('settles on the exit and ends what the command left running in its group', async () => {
    const started = Date.now();

    const result = await runManagedCommand({
      label: 'test:held-pipes',
      command: '/bin/sh',
      args: ['-c', 'sleep 30 & echo $!'],
      timeoutMs: 60_000,
      processes: new ProcessRegistry(),
      endGroupOnExit: true,
    });

    expect(result.code).toBe(0);
    expect(Date.now() - started).toBeLessThan(5_000);
    const pid = Number(result.stdout.trim());
    await expect
      .poll(
        () => {
          try {
            process.kill(pid, 0);
            return 'alive';
          } catch {
            return 'gone';
          }
        },
        { timeout: 8_000 },
      )
      .toBe('gone');
  });

  it('interleaves both streams in arrival order in tail mode', async () => {
    const result = await runManagedCommand({
      label: 'test:interleave',
      command: '/bin/sh',
      args: ['-c', 'echo one; sleep 0.1; echo two >&2; sleep 0.1; echo three'],
      timeoutMs: 10_000,
      processes: new ProcessRegistry(),
      keepOutput: 'tail',
    });

    expect(result.output).toBe('one\ntwo\nthree\n');
  });

  it('hands each line to onOutput as it arrives, per stream, with a partial last line at the end', async () => {
    const seen: string[] = [];
    let exited = false;
    const run = runManagedCommand({
      label: 'test:lines',
      command: '/bin/sh',
      args: [
        '-c',
        'printf "open https://x.example/a\\r\\n"; printf "code: AB" >&2; sleep 0.3; printf "CD\\n" >&2; printf "tail"',
      ],
      timeoutMs: 10_000,
      processes: new ProcessRegistry(),
      onOutput: (line, stream) => seen.push(`${stream}:${line}`),
    }).then((result) => {
      exited = true;
      return result;
    });
    await expect.poll(() => seen.length).toBe(1);
    // The first line came while the command was still running.
    expect(exited).toBe(false);
    await run;

    expect(seen).toEqual([
      'stdout:open https://x.example/a',
      'stderr:code: ABCD',
      'stdout:tail',
    ]);
  });

  it('keeps no byte of stdout when told to discard it, and still reports how the command ended', async () => {
    const seen: string[] = [];
    const result = await runManagedCommand({
      label: 'test:discard',
      command: '/bin/sh',
      args: ['-c', 'echo ya29.live-token; echo note >&2; exit 4'],
      timeoutMs: 10_000,
      processes: new ProcessRegistry(),
      keepOutput: 'tail',
      discardStdout: true,
      onOutput: (line) => seen.push(line),
    });

    expect(result).toMatchObject({ code: 4, stdout: '', stderr: 'note\n' });
    expect(result.output).toBe('note\n');
    expect(seen).toEqual(['note']);
  });

  it('ends what the command backgrounded at its exit, even with its output elsewhere', async () => {
    const result = await runManagedCommand({
      label: 'test:end-group',
      command: '/bin/sh',
      args: ['-c', 'sleep 30 >/dev/null 2>&1 & echo $!'],
      timeoutMs: 60_000,
      processes: new ProcessRegistry(),
      endGroupOnExit: true,
    });

    const pid = Number(result.stdout.trim());
    await expect
      .poll(
        () => {
          try {
            process.kill(pid, 0);
            return 'alive';
          } catch {
            return 'gone';
          }
        },
        { timeout: 8_000 },
      )
      .toBe('gone');
  });
});
