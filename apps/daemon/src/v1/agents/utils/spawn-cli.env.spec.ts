import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ClaudeAdapter } from '../adapters/claude/claude.adapter';
import { CursorAdapter } from '../adapters/cursor/cursor.adapter';
import type { SpawnedProcess, SpawnFn } from './spawn-cli';
import { runHeadlessCli } from './spawn-cli';

// ── Child fake that captures the env the spawn was given ──────────────────────
class FakeReadable extends EventEmitter {
  setEncoding(): this {
    return this;
  }
}
class FakeWritable extends EventEmitter {
  write(): boolean {
    return true;
  }
  end(): this {
    return this;
  }
}
class FakeChild extends EventEmitter {
  readonly stdout = new FakeReadable();
  readonly stderr = new FakeReadable();
  readonly stdin = new FakeWritable();
  kill(): boolean {
    return true;
  }
}

function fakeSpawn(): {
  spawn: SpawnFn;
  child: FakeChild;
  captured: { env?: NodeJS.ProcessEnv };
} {
  const child = new FakeChild();
  const captured: { env?: NodeJS.ProcessEnv } = {};
  const spawn: SpawnFn = (_command, _args, options) => {
    captured.env = options.env;
    return child as unknown as SpawnedProcess;
  };
  return { spawn, child, captured };
}

// The credential-isolation boundary is a CLAUDE.md hard rule: a spawned agent
// must never inherit the daemon's GENIRO_-prefixed config/secrets, and the
// Cursor key must reach ONLY the cursor child. These assert that contract so a
// silent regression (dropping the GENIRO_ strip, or a key leaking across agents)
// fails a test rather than leaking a credential in production.
describe('spawned-agent env scoping', () => {
  const KEYS = [
    'GENIRO_SECRET',
    'GENIRO_CURSOR_API_KEY',
    'NORMAL_VAR',
    'CURSOR_API_KEY',
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });

  it('strips every GENIRO_-prefixed key, passes other vars through, merges extra', async () => {
    process.env.GENIRO_SECRET = 'leak-me';
    process.env.NORMAL_VAR = 'keep-me';
    const { spawn, child, captured } = fakeSpawn();

    const handle = runHeadlessCli({
      command: 'claude',
      args: [],
      cwd: '/proj',
      env: { EXTRA: 'injected' },
      mapper: () => [],
      onEvent: () => {},
      spawn,
    });
    child.emit('close', 0, null);
    await handle.done;

    expect(captured.env?.NORMAL_VAR).toBe('keep-me');
    expect(captured.env?.EXTRA).toBe('injected');
    expect('GENIRO_SECRET' in (captured.env ?? {})).toBe(false);
  });

  it('CursorAdapter re-injects GENIRO_CURSOR_API_KEY as CURSOR_API_KEY for its child only', async () => {
    process.env.GENIRO_CURSOR_API_KEY = 'sk-cursor';
    const { spawn, child, captured } = fakeSpawn();

    const handle = new CursorAdapter({ spawn }).start(
      { prompt: 'go', cwd: '/proj' },
      () => {},
    );
    child.emit('close', 0, null);
    await handle.done;

    expect(captured.env?.CURSOR_API_KEY).toBe('sk-cursor');
    // The raw GENIRO_-prefixed var is stripped — only the mapped name survives.
    expect('GENIRO_CURSOR_API_KEY' in (captured.env ?? {})).toBe(false);
  });

  it("ClaudeAdapter's child never receives the Cursor credential", async () => {
    process.env.GENIRO_CURSOR_API_KEY = 'sk-cursor';
    const { spawn, child, captured } = fakeSpawn();

    const handle = new ClaudeAdapter({ spawn }).start(
      { prompt: 'go', cwd: '/proj' },
      () => {},
    );
    child.emit('close', 0, null);
    await handle.done;

    expect(captured.env?.CURSOR_API_KEY).toBeUndefined();
    expect('GENIRO_CURSOR_API_KEY' in (captured.env ?? {})).toBe(false);
  });
});
