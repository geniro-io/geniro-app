import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { RemoteTunnel, tunnelHostPattern } from './tunnel';

/**
 * A stand-in for a spawned tunnel client: two readable streams and the
 * `exit`/`error` events the supervisor listens for. Deliberately a real
 * `EventEmitter` with real streams rather than an object of spies, so the
 * supervisor's own listener wiring is what is exercised.
 */
function fakeChild(): EventEmitter & {
  stdout: Readable;
  stderr: Readable;
  kill: ReturnType<typeof vi.fn>;
  exitCode: number | null;
  signalCode: string | null;
} {
  const child = new EventEmitter() as ReturnType<typeof fakeChild>;
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn(() => {
    // A real SIGTERM ends the process; without this the supervisor's own
    // escalation timer would be the only thing resolving `stop()`.
    queueMicrotask(() => child.emit('exit', null, 'SIGTERM'));
    return true;
  });
  return child;
}

function harness(options: { bins?: string[] } = {}) {
  const child = fakeChild();
  const installed = new Set(options.bins ?? ['cloudflared', 'ngrok']);
  const spawnProcess = vi.fn(() => child);
  const tunnel = new RemoteTunnel({
    spawnProcess: spawnProcess as never,
    resolveBin: (name) =>
      installed.has(name) ? `/opt/homebrew/bin/${name}` : null,
    urlWaitMs: 50,
  });
  return { tunnel, child, spawnProcess };
}

describe('tunnelHostPattern', () => {
  it('drops the leading label, which is the part that rotates', () => {
    expect(
      tunnelHostPattern('https://keyword-portsmouth.trycloudflare.com'),
    ).toBe('*.trycloudflare.com');
    expect(tunnelHostPattern('https://9b36-37-99-2-231.ngrok-free.app')).toBe(
      '*.ngrok-free.app',
    );
  });

  it('keeps a deeper suffix whole, so a paid domain is not over-widened', () => {
    expect(tunnelHostPattern('https://a.b.example.com')).toBe(
      '*.b.example.com',
    );
  });

  it('answers null rather than a mask the guard would have to refuse', () => {
    // Two labels would produce `*.app` — a whole TLD. Refused HERE as well as
    // in the guard, so a bad mask is never even offered.
    expect(tunnelHostPattern('https://evil.app')).toBeNull();
    expect(tunnelHostPattern('not a url')).toBeNull();
  });
});

describe('RemoteTunnel', () => {
  it('starts cloudflared FIRST when both are installed', async () => {
    const { tunnel, child, spawnProcess } = harness();
    const started = tunnel.start(47616);
    child.stderr.push(
      'INF |  https://keyword-portsmouth-product.trycloudflare.com  |\n',
    );
    const state = await started;

    expect(state.status).toBe('open');
    expect(state.provider).toBe('cloudflared');
    expect(state.url).toBe(
      'https://keyword-portsmouth-product.trycloudflare.com',
    );
    expect(spawnProcess).toHaveBeenCalledWith(
      '/opt/homebrew/bin/cloudflared',
      expect.arrayContaining(['tunnel', '--url', 'http://127.0.0.1:47616']),
      expect.anything(),
    );
  });

  it('falls back to ngrok when cloudflared is not installed', async () => {
    const { tunnel, child, spawnProcess } = harness({ bins: ['ngrok'] });
    const started = tunnel.start(47616);
    child.stdout.push(
      '{"lvl":"info","msg":"started tunnel","url":"https://9b36-1-2-3-4.ngrok-free.app"}\n',
    );
    const state = await started;

    expect(state.provider).toBe('ngrok');
    expect(state.url).toBe('https://9b36-1-2-3-4.ngrok-free.app');
    expect(spawnProcess).toHaveBeenCalledWith(
      '/opt/homebrew/bin/ngrok',
      expect.arrayContaining(['http', '47616']),
      expect.anything(),
    );
  });

  it('names both clients when neither is installed', async () => {
    const { tunnel, spawnProcess } = harness({ bins: [] });
    const state = await tunnel.start(47616);

    expect(state.status).toBe('error');
    expect(state.error).toContain('cloudflared');
    expect(state.error).toContain('ngrok');
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('widens the guard only while the tunnel is OPEN', async () => {
    const { tunnel, child } = harness();
    expect(tunnel.allowedHostPattern()).toBeNull();

    const started = tunnel.start(47616);
    child.stderr.push('https://abc.trycloudflare.com\n');
    await started;
    expect(tunnel.allowedHostPattern()).toBe('*.trycloudflare.com');

    await tunnel.stop();
    // The load-bearing half: a mask left standing after the tunnel closed
    // would admit the provider's whole zone for the rest of the launch.
    expect(tunnel.allowedHostPattern()).toBeNull();
  });

  it('kills the client on stop', async () => {
    const { tunnel, child } = harness();
    const started = tunnel.start(47616);
    child.stderr.push('https://abc.trycloudflare.com\n');
    await started;

    await tunnel.stop();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(tunnel.state().status).toBe('off');
  });

  it('reports a client that dies before producing an address, in its own words', async () => {
    const { tunnel, child } = harness({ bins: ['ngrok'] });
    const started = tunnel.start(47616);
    child.stdout.push('{"err":"authentication failed: token expired"}\n');
    // A stream delivers on the next tick, so an `exit` emitted synchronously
    // after the push would beat the data the failure is reported FROM — the
    // ordering a real dying client has, and the one that makes this assertion
    // about the tail rather than about a race.
    await new Promise((resolve) => setImmediate(resolve));
    child.emit('exit', 1, null);
    const state = await started;

    expect(state.status).toBe('error');
    expect(state.error).toContain('authentication failed');
  });

  it('gives up when the client never reports an address', async () => {
    const { tunnel, child } = harness();
    const state = await tunnel.start(47616);

    expect(state.status).toBe('error');
    expect(state.error).toContain('did not report an address');
    // The wedged client is reaped rather than left running behind a failure
    // the user has already been shown.
    expect(child.kill).toHaveBeenCalled();
  });

  it('follows a URL the client reassigns mid-session', async () => {
    const { tunnel, child } = harness({ bins: ['ngrok'] });
    const started = tunnel.start(47616);
    child.stdout.push('{"url":"https://9b36-1-2-3-4.ngrok-free.app"}\n');
    await started;

    // Measured on a real ngrok session: a reconnect handed out a new
    // subdomain. The mask still admits it; the screen must not go stale.
    child.stdout.push('{"url":"https://5cd3-1-2-3-4.ngrok-free.app"}\n');
    await new Promise((resolve) => setImmediate(resolve));
    expect(tunnel.state().url).toBe('https://5cd3-1-2-3-4.ngrok-free.app');
  });

  it('does not start a second client while one is already open', async () => {
    const { tunnel, child, spawnProcess } = harness();
    const started = tunnel.start(47616);
    child.stderr.push('https://abc.trycloudflare.com\n');
    await started;

    await tunnel.start(47616);
    expect(spawnProcess).toHaveBeenCalledTimes(1);
  });
});
