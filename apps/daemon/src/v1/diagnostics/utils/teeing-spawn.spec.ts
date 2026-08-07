import { PassThrough, Writable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SpawnedProcess } from '../../agents/utils/spawn-cli';
import { configureDebugSink, debugSink } from './debug-sink';
import { clearSecrets, registerSecret } from './redact';
import { createTeeingSpawn } from './teeing-spawn';

/** A child whose three streams the test drives directly. */
function fakeChild(): SpawnedProcess & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: Writable & { written: string[] };
  fire: (event: string, ...args: unknown[]) => void;
} {
  const written: string[] = [];
  const stdin = Object.assign(
    new Writable({
      write(chunk: Buffer | string, _enc, cb) {
        written.push(chunk.toString());
        cb();
      },
    }),
    { written },
  );
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  const child = {
    pid: 4242,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin,
    on(event: string, listener: (...args: unknown[]) => void) {
      (listeners[event] ??= []).push(listener);
      return child;
    },
    kill: vi.fn(() => true),
    fire(event: string, ...args: unknown[]) {
      for (const listener of listeners[event] ?? []) {
        listener(...args);
      }
    },
  };
  return child as unknown as ReturnType<typeof fakeChild>;
}

const messages = (): string[] =>
  debugSink.since(-1).entries.map((entry) => entry.message);

beforeEach(() => {
  configureDebugSink({ dir: null });
  debugSink.setChannels(['daemon', 'transcript', 'ui', 'agent-stdio']);
});

afterEach(() => {
  debugSink.close();
  clearSecrets();
});

describe('createTeeingSpawn', () => {
  it('records the spawn, with the command and pid', () => {
    const child = fakeChild();
    const spawn = createTeeingSpawn(() => child);

    spawn('/usr/local/bin/claude', ['-p', '--verbose'], {
      cwd: '/proj',
      env: {},
    });

    const [entry] = debugSink.since(-1).entries;
    expect(entry!.message).toContain('spawn claude');
    expect(entry!.message).toContain('--verbose');
    expect(entry!.context).toMatchObject({ pid: '4242', cwd: '/proj' });
  });

  it('copies stdout WITHOUT consuming it', () => {
    // The real reader attaches its own `data` listener. If teeing consumed the
    // stream the adapter would receive nothing and every turn would hang — so
    // this asserts the pass-through, not just the recording.
    const child = fakeChild();
    const spawn = createTeeingSpawn(() => child);
    const wrapped = spawn('claude', [], { cwd: '/proj', env: {} });
    const seenByReader: string[] = [];
    wrapped.stdout!.on('data', (chunk: Buffer) =>
      seenByReader.push(chunk.toString()),
    );

    child.stdout.write('{"type":"assistant"}\n');

    expect(seenByReader).toEqual(['{"type":"assistant"}\n']);
    expect(messages().some((m) => m.includes('{"type":"assistant"}'))).toBe(
      true,
    );
  });

  it('records what is written to stdin, and still writes it', () => {
    const child = fakeChild();
    const spawn = createTeeingSpawn(() => child);
    const wrapped = spawn('claude', [], { cwd: '/proj', env: {} });

    wrapped.stdin!.write('{"type":"user","text":"hi"}\n');

    // Delivered to the REAL child — a tee that swallowed the prompt would
    // leave every turn waiting on stdin forever.
    expect(child.stdin.written).toEqual(['{"type":"user","text":"hi"}\n']);
    expect(messages().some((m) => m.includes('"text":"hi"'))).toBe(true);
  });

  it('records the exit code', () => {
    const child = fakeChild();
    const spawn = createTeeingSpawn(() => child);
    spawn('claude', [], { cwd: '/proj', env: {} });

    child.fire('exit', 1, null);

    expect(messages().some((m) => m.includes('exit claude code=1'))).toBe(true);
  });

  it('records NOTHING when the agent-stdio channel is off', () => {
    // The channel is off by default, and this is the whole reason it can be:
    // the wrapper is always installed, so it must cost nothing when unwanted.
    debugSink.setChannels(['daemon']);
    const child = fakeChild();
    const spawn = createTeeingSpawn(() => child);
    const wrapped = spawn('claude', [], { cwd: '/proj', env: {} });

    wrapped.stdin!.write('secret prompt\n');
    child.stdout.write('secret reply\n');

    expect(messages()).toEqual([]);
    // …and the data still flows.
    expect(child.stdin.written).toEqual(['secret prompt\n']);
  });

  it('redacts a secret that appears in the raw stream', () => {
    // This channel carries argv and stdin verbatim, which is exactly where a
    // token appears — so the redaction has to hold on the RAW path, not only
    // on the daemon's own prose.
    const secret = 'q'.repeat(40);
    registerSecret(secret, 'launch token');
    const child = fakeChild();
    const spawn = createTeeingSpawn(() => child);
    const wrapped = spawn('claude', [], { cwd: '/proj', env: {} });

    wrapped.stdin!.write(`{"token":"${secret}"}\n`);

    expect(messages().join('\n')).not.toContain(secret);
    expect(messages().join('\n')).toContain('launch token redacted');
  });

  it('keeps `on` chainable and pointed at the real child', () => {
    // `runCliSession` chains off `on`. Returning the raw child there would
    // hand it the UNWRAPPED stdin and silently lose the stdin tee.
    const child = fakeChild();
    const spawn = createTeeingSpawn(() => child);
    const wrapped = spawn('claude', [], { cwd: '/proj', env: {} });

    const chained = wrapped.on('exit', () => undefined);

    expect(chained).toBe(wrapped);
    expect(chained.stdin).toBe(wrapped.stdin);
    expect(chained.stdin).not.toBe(child.stdin);
  });

  it('forwards kill to the real child', () => {
    const child = fakeChild();
    const spawn = createTeeingSpawn(() => child);

    spawn('claude', [], { cwd: '/proj', env: {} }).kill('SIGTERM');

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
