import { describe, expect, it } from 'vitest';

import { ProcessRegistry } from '../services/process-registry';
import { runManagedCommand } from './managed-command';

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
});
