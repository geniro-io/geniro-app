import { describe, expect, it, vi } from 'vitest';

import { defaultSpawn } from './spawn-cli';

// Mock node's spawn so we can assert the options `defaultSpawn` forwards. The
// other spawn-cli specs inject a fake SpawnFn and never exercise the real
// default, so without this the `detached: true` linchpin is untested.
const spawnMock = vi.hoisted(() => vi.fn(() => ({})));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

describe('defaultSpawn', () => {
  it('spawns the child detached (a process-group leader) with all stdio piped', () => {
    defaultSpawn('claude', ['-p'], { cwd: '/proj', env: { A: '1' } });

    // `detached: true` is the precondition that lets killProcessTree signal the
    // whole group (process.kill(-pid)) and reap tool/MCP grandchildren on cancel.
    expect(spawnMock).toHaveBeenCalledWith('claude', ['-p'], {
      cwd: '/proj',
      env: { A: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
  });
});
